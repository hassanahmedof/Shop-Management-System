import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { DiscordTransactionNotificationPayload } from './shared/discordSchema.ts';
import type { SheetSyncPayload } from './shared/googleSheetsSchema.ts';
import {
  getDiscordCapabilities,
  removeDiscordWebhookForOwner,
  saveDiscordWebhookForOwner,
  sendDiscordTestNotification,
  sendDiscordTransactionNotification,
  verifyDiscordWebhookLive,
} from './server/discordNotifier.ts';
import {
  ensureBusinessSpreadsheet,
  getGoogleSheetsCapabilities,
  GoogleSheetsApiError,
  removeServiceAccountForOwner,
  resolveGoogleSheetsAccessToken,
  saveServiceAccountForOwner,
  syncSpreadsheetTabs,
} from './server/googleSheetsService.ts';
import { getRequiredSecret, validateRequiredSecrets } from './server/vaultCrypto.ts';
import {
  sanitizeUpsellRequestInput,
  suggestUpsellWithGemini,
} from './server/upsellAdvisor.ts';
import {
  getServerCooccurrenceSnapshot,
  hydrateServerCooccurrenceFromExternalSnapshot,
  recordServerCooccurrenceBatch,
} from './server/upsellCooccurrenceStore.ts';
import {
  getServerFeedbackSnapshot,
  recordServerFeedbackEventWithStatus,
} from './server/upsellFeedbackStore.ts';
import {
  COOCCURRENCE_CACHE_VERSION,
  type CooccurrenceSaleInput,
  type UpsellFeedbackEventInput,
  type UpsellFeedbackEventType,
} from './shared/upsellCacheSchema.ts';

interface FirebaseAppletConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId?: string;
}

interface VerifiedFirebaseUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  provider: string;
  name: string;
}

interface SessionPayload {
  uid: string;
  role: 'owner' | 'sales_staff';
  email: string;
  shopId: string;
  exp: number;
}

interface AuthenticatedRequest extends Request {
  firebaseUser?: VerifiedFirebaseUser;
  bearerToken?: string;
  shopId?: string;
  isPrimaryOwner?: boolean;
  staffContext?: {
    shopId: string;
    staffId: string;
    staff: Record<string, unknown>;
  };
}

const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
const fileFirebaseConfig: Partial<FirebaseAppletConfig> = fs.existsSync(configPath)
  ? (JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<FirebaseAppletConfig>)
  : {};

const firebaseConfig: FirebaseAppletConfig = {
  projectId:
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.VITE_FIREBASE_PROJECT_ID?.trim() ||
    fileFirebaseConfig.projectId ||
    '',
  appId:
    process.env.VITE_FIREBASE_APP_ID?.trim() ||
    fileFirebaseConfig.appId ||
    '',
  apiKey:
    process.env.VITE_FIREBASE_API_KEY?.trim() ||
    fileFirebaseConfig.apiKey ||
    '',
  authDomain:
    process.env.VITE_FIREBASE_AUTH_DOMAIN?.trim() ||
    fileFirebaseConfig.authDomain ||
    '',
  firestoreDatabaseId:
    process.env.FIREBASE_DATABASE_ID?.trim() ||
    process.env.VITE_FIREBASE_DATABASE_ID?.trim() ||
    fileFirebaseConfig.firestoreDatabaseId ||
    '(default)',
};

function getFirebaseProjectId(): string {
  if (!firebaseConfig.projectId) {
    throw new Error(
      'Firebase projectId missing. Provide firebase-applet-config.json locally or set FIREBASE_PROJECT_ID / VITE_FIREBASE_PROJECT_ID.'
    );
  }
  return firebaseConfig.projectId;
}

const FIRESTORE_DB_ID = firebaseConfig.firestoreDatabaseId || '(default)';

const SESSION_COOKIE_NAME = 'caremart_session';
const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let cachedJwks: { keys: Array<Record<string, unknown>>; expiresAt: number } | null = null;

function getConfiguredOwnerEmail(): string {
  let raw = (process.env.OWNER_EMAIL || '').trim();
  if (/^owner_email\s*=/i.test(raw)) {
    raw = raw.replace(/^owner_email\s*=/i, '').trim();
  }
  raw = raw.replace(/^['"]+|['"]+$/g, '').trim().toLowerCase();
  if (!raw || !raw.includes('@') || raw.endsWith('@staff.caremart.app')) {
    return '';
  }
  return raw;
}

function computeOwnerProof(uid: string, email: string): string {
  const gateSecret = getRequiredSecret('OWNER_GATE_SECRET');
  return crypto
    .createHash('sha256')
    .update(`${uid}:${email.toLowerCase()}:${gateSecret}`)
    .digest('hex')
    .toLowerCase();
}

async function fetchGoogleSecureTokenJwks(forceRefresh = false): Promise<Array<Record<string, unknown>>> {
  const now = Date.now();
  if (!forceRefresh && cachedJwks && now < cachedJwks.expiresAt) {
    return cachedJwks.keys;
  }

  const res = await fetch(JWKS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Firebase public keys (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
  const cacheControl = res.headers.get('cache-control') || '';
  const maxAgeMatch = /max-age=(\d+)/i.exec(cacheControl);
  const ttlMs = maxAgeMatch ? Number(maxAgeMatch[1]) * 1000 : 300_000;

  cachedJwks = {
    keys: body.keys || [],
    expiresAt: now + Math.max(60_000, ttlMs),
  };
  return cachedJwks.keys;
}

function decodeBase64UrlJson<T>(segment: string): T {
  try {
    const jsonStr = Buffer.from(segment, 'base64url').toString('utf8');
    return JSON.parse(jsonStr) as T;
  } catch {
    throw new Error('Invalid Firebase ID token format.');
  }
}

async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseUser> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase ID token.');
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeBase64UrlJson<{ alg?: string; kid?: string }>(headerB64);
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Invalid Firebase ID token algorithm or key ID.');
  }

  let keys = await fetchGoogleSecureTokenJwks(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await fetchGoogleSecureTokenJwks(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) {
    throw new Error('Firebase ID token signing key not recognized.');
  }

  const publicKey = crypto.createPublicKey({
    key: jwk as crypto.JsonWebKey,
    format: 'jwk',
  });
  const isValidSig = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    publicKey,
    Buffer.from(signatureB64, 'base64url')
  );
  if (!isValidSig) {
    throw new Error('Invalid Firebase ID token signature.');
  }

  const payload = decodeBase64UrlJson<{
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    auth_time?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
    firebase?: { sign_in_provider?: string };
  }>(payloadB64);

  const nowSec = Math.floor(Date.now() / 1000);
  const projectId = getFirebaseProjectId();
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;

  if (payload.aud !== projectId) {
    throw new Error('Token audience mismatch.');
  }
  if (payload.iss !== expectedIssuer) {
    throw new Error('Token issuer mismatch.');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Token subject missing.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('Firebase session expired. Please sign in again.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw new Error('Token issued-at claim is invalid.');
  }
  if (typeof payload.auth_time !== 'number' || payload.auth_time > nowSec + 300) {
    throw new Error('Token auth_time claim is invalid.');
  }

  return {
    uid: payload.sub,
    email: (payload.email || '').trim().toLowerCase(),
    emailVerified: Boolean(payload.email_verified),
    provider: payload.firebase?.sign_in_provider || '',
    name: payload.name || '',
  };
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

function signSessionToken(payload: SessionPayload): string {
  const sessionSecret = getRequiredSecret('SESSION_SECRET');
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const sessionSecret = getRequiredSecret('SESSION_SECRET');
  const expectedSig = crypto.createHmac('sha256', sessionSecret).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as SessionPayload;
    if (!parsed.uid || !parsed.role || parsed.exp <= Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setSessionCookie(req: Request, res: Response, payload: SessionPayload) {
  const token = signSessionToken(payload);
  const isSecure =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.K_SERVICE);

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? 'none' : 'lax',
    path: '/',
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(req: Request, res: Response) {
  const isSecure =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.K_SERVICE);

  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? 'none' : 'lax',
    path: '/',
  });
}

function decodeFirestoreValue(val: Record<string, unknown>): unknown {
  if ('stringValue' in val) return val.stringValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('timestampValue' in val) return val.timestampValue;
  if ('nullValue' in val) return null;
  if ('arrayValue' in val) {
    const arr = (val.arrayValue as { values?: Array<Record<string, unknown>> })?.values || [];
    return arr.map((v) => decodeFirestoreValue(v));
  }
  if ('mapValue' in val) {
    const fields =
      (val.mapValue as { fields?: Record<string, Record<string, unknown>> })?.fields || {};
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      obj[k] = decodeFirestoreValue(v);
    }
    return obj;
  }
  return undefined;
}

function decodeFirestoreDoc(docJson: {
  name?: string;
  fields?: Record<string, Record<string, unknown>>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (docJson.name) {
    const segments = docJson.name.split('/');
    out.id = segments[segments.length - 1];
  }
  if (docJson.fields) {
    for (const [k, v] of Object.entries(docJson.fields)) {
      out[k] = decodeFirestoreValue(v);
    }
  }
  return out;
}

async function firestoreGetDoc(
  docPath: string,
  bearerToken?: string
): Promise<Record<string, unknown> | null> {
  const url = `https://firestore.googleapis.com/v1/projects/${getFirebaseProjectId()}/databases/${FIRESTORE_DB_ID}/documents/${docPath}`;
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Firestore read failed (${res.status}).`);
  }
  const json = (await res.json()) as {
    name?: string;
    fields?: Record<string, Record<string, unknown>>;
  };
  return decodeFirestoreDoc(json);
}

async function firestoreListCollection(
  collectionPath: string,
  bearerToken: string
): Promise<Array<Record<string, unknown>>> {
  const url = `https://firestore.googleapis.com/v1/projects/${getFirebaseProjectId()}/databases/${FIRESTORE_DB_ID}/documents/${collectionPath}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (!res.ok) {
    throw new Error(`Firestore list failed (${res.status}).`);
  }
  const json = (await res.json()) as {
    documents?: Array<{ name?: string; fields?: Record<string, Record<string, unknown>> }>;
  };
  return (json.documents || []).map((d) => decodeFirestoreDoc(d));
}

async function firestoreQuerySaleItemsBySaleId(
  shopId: string,
  saleId: string,
  bearerToken: string
): Promise<Array<Record<string, unknown>>> {
  const url = `https://firestore.googleapis.com/v1/projects/${getFirebaseProjectId()}/databases/${FIRESTORE_DB_ID}/documents/shops/${encodeURIComponent(shopId)}:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'saleItems' }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: 'ownerUid' },
                  op: 'EQUAL',
                  value: { stringValue: shopId },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: 'saleId' },
                  op: 'EQUAL',
                  value: { stringValue: saleId },
                },
              },
            ],
          },
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Firestore query failed (${res.status}).`);
  }
  const rows = (await res.json()) as Array<{
    document?: { name?: string; fields?: Record<string, Record<string, unknown>> };
  }>;
  return rows.filter((r) => Boolean(r.document)).map((r) => decodeFirestoreDoc(r.document!));
}

async function firestoreBatchGetDocs(
  docPaths: string[],
  bearerToken: string
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (docPaths.length === 0) return out;
  const projectId = getFirebaseProjectId();
  const docPrefix = `projects/${projectId}/databases/${FIRESTORE_DB_ID}/documents/`;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${FIRESTORE_DB_ID}/documents:batchGet`;

  for (let i = 0; i < docPaths.length; i += 100) {
    const chunk = docPaths.slice(i, i + 100);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        documents: chunk.map((p) => `${docPrefix}${p}`),
      }),
    });
    if (!res.ok) {
      throw new Error(`Firestore batch read failed (${res.status}).`);
    }
    const items = (await res.json()) as Array<{
      found?: { name?: string; fields?: Record<string, Record<string, unknown>> };
    }>;
    for (const entry of items) {
      if (entry.found?.name && entry.found.name.startsWith(docPrefix)) {
        const relPath = entry.found.name.slice(docPrefix.length);
        out.set(relPath, decodeFirestoreDoc(entry.found));
      }
    }
  }
  return out;
}

const VALID_DOC_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_FEEDBACK_EVENT_ID_RE = /^[a-zA-Z0-9_.:-]{8,128}$/;

function isValidDocId(id: string): boolean {
  return VALID_DOC_ID_RE.test(id);
}

class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;

  constructor(maxRequests: number, windowMs: number, maxKeys = 5000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  consume(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    const cutoff = now - this.windowMs;
    const prev = this.buckets.get(key);
    const recent = prev ? prev.filter((ts) => ts > cutoff) : [];

    if (recent.length >= this.maxRequests) {
      this.buckets.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSec };
    }

    recent.push(now);
    this.buckets.set(key, recent);

    if (this.buckets.size > this.maxKeys) {
      for (const [k, list] of this.buckets.entries()) {
        if (list.length === 0 || list[list.length - 1] <= cutoff) {
          this.buckets.delete(k);
        }
        if (this.buckets.size <= this.maxKeys) break;
      }
    }

    return { allowed: true, retryAfterSec: 0 };
  }
}

export interface ServerDependencies {
  verifyFirebaseIdToken: (idToken: string) => Promise<VerifiedFirebaseUser>;
  firestoreGetDoc: (docPath: string, bearerToken?: string) => Promise<Record<string, unknown> | null>;
  firestoreListCollection: (
    collectionPath: string,
    bearerToken: string
  ) => Promise<Array<Record<string, unknown>>>;
  firestoreQuerySaleItemsBySaleId: (
    shopId: string,
    saleId: string,
    bearerToken: string
  ) => Promise<Array<Record<string, unknown>>>;
  firestoreBatchGetDocs: (
    docPaths: string[],
    bearerToken: string
  ) => Promise<Map<string, Record<string, unknown>>>;
  suggestUpsellWithGemini: typeof suggestUpsellWithGemini;
  cooccurrenceCacheDir?: string;
  feedbackCacheDir?: string;
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

let cachedPrimaryOwnerUid: string | null = null;

async function getPrimaryOwnerUidCached(): Promise<string | null> {
  if (cachedPrimaryOwnerUid) return cachedPrimaryOwnerUid;
  const ownerSetup = await firestoreGetDoc('appState/ownerSetup');
  if (ownerSetup && ownerSetup.ownerUid && ownerSetup.initialized === true) {
    cachedPrimaryOwnerUid = String(ownerSetup.ownerUid);
    return cachedPrimaryOwnerUid;
  }
  return ownerSetup && ownerSetup.ownerUid ? String(ownerSetup.ownerUid) : null;
}

async function authorizeOwnerUser(
  user: VerifiedFirebaseUser,
  token: string,
  options?: { requireExistingAdminOrSetup?: boolean; mode?: 'setup' | 'signin' }
): Promise<
  | { ok: true; shopId: string; isPrimaryOwner: boolean }
  | { ok: false; status: number; error: string }
> {
  if (user.provider !== 'password' && user.provider !== 'google.com') {
    return {
      ok: false,
      status: 403,
      error: 'Access Denied. Owner/Admin login requires Email & Password or Google authentication.',
    };
  }

  const emailLower = (user.email || '').trim().toLowerCase();
  if (!emailLower || !emailLower.includes('@') || emailLower.endsWith('@staff.caremart.app')) {
    return {
      ok: false,
      status: 403,
      error: 'Sales Staff accounts are not authorized to access the Owner/Admin portal.',
    };
  }

  const staffMap = await firestoreGetDoc(`staffAuthMap/${user.uid}`, token);
  if (staffMap) {
    return {
      ok: false,
      status: 403,
      error: 'Sales Staff accounts cannot register or sign in as Owner/Admin.',
    };
  }

  const primaryOwnerUid = await getPrimaryOwnerUidCached();
  if (primaryOwnerUid) {
    if (primaryOwnerUid === user.uid) {
      if (options?.mode === 'setup') {
        return {
          ok: false,
          status: 409,
          error: 'Initial Admin setup is already completed. Please sign in with your Owner email/username and password.',
        };
      }
      return { ok: true, shopId: primaryOwnerUid, isPrimaryOwner: true };
    }

    // Check if this user is an active added Admin created by the shop Owner/Admin
    const adminMap = await firestoreGetDoc(`adminAuthMap/${user.uid}`, token);
    if (
      adminMap &&
      adminMap.isActive === true &&
      String(adminMap.shopId || '') === primaryOwnerUid &&
      typeof adminMap.adminMemberId === 'string' &&
      adminMap.adminMemberId
    ) {
      const adminMember = await firestoreGetDoc(
        `shops/${primaryOwnerUid}/adminMembers/${adminMap.adminMemberId}`,
        token
      );
      if (
        adminMember &&
        adminMember.isActive === true &&
        adminMember.authUid === user.uid &&
        adminMember.role === 'admin'
      ) {
        if (options?.mode === 'setup') {
          return {
            ok: false,
            status: 409,
            error: 'Initial Admin setup is already completed. Please sign in on the Sign In screen.',
          };
        }
        return { ok: true, shopId: primaryOwnerUid, isPrimaryOwner: false };
      }
      return {
        ok: false,
        status: 403,
        error: 'This Admin account is inactive or its credentials were reset.',
      };
    }

    return {
      ok: false,
      status: 403,
      error:
        'An Owner/Admin account is already configured for this shop. Sign in with an authorized Admin username/email and password.',
    };
  }

  if (options?.requireExistingAdminOrSetup) {
    const existingAdmin = await firestoreGetDoc(`admins/${user.uid}`, token);
    if (!existingAdmin || existingAdmin.role !== 'owner') {
      return {
        ok: false,
        status: 403,
        error: 'Owner/Admin workspace is not initialized yet.',
      };
    }
  }

  return { ok: true, shopId: user.uid, isPrimaryOwner: true };
}

async function requireOwnerMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication token required.' });
    return;
  }

  try {
    const user = await verifyFirebaseIdToken(token);
    const authCheck = await authorizeOwnerUser(user, token, {
      requireExistingAdminOrSetup: true,
    });
    if (!authCheck.ok) {
      res.status(authCheck.status).json({ error: authCheck.error });
      return;
    }

    req.firebaseUser = user;
    req.bearerToken = token;
    req.shopId = authCheck.shopId;
    req.isPrimaryOwner = authCheck.isPrimaryOwner;
    next();
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Invalid or expired authentication token.',
    });
  }
}

async function requireStaffMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication token required.' });
    return;
  }

  try {
    const user = await verifyFirebaseIdToken(token);
    if (user.provider !== 'password') {
      res.status(403).json({
        error: 'Sales staff must authenticate with username and password (Google OAuth is not allowed).',
      });
      return;
    }

    const authMap = await firestoreGetDoc(`staffAuthMap/${user.uid}`, token);
    if (!authMap || authMap.isActive !== true) {
      res.status(403).json({
        error: 'Your staff account is inactive or revoked. Contact the shop owner.',
      });
      return;
    }

    const shopId = String(authMap.shopId || '');
    const staffId = String(authMap.staffId || '');
    if (!shopId || !staffId) {
      res.status(403).json({ error: 'Invalid staff account mapping.' });
      return;
    }

    const staff = await firestoreGetDoc(`shops/${shopId}/staff/${staffId}`, token);
    if (
      !staff ||
      staff.isActive !== true ||
      staff.authUid !== user.uid ||
      (staff.role !== 'sales_staff' && staff.role !== 'staff')
    ) {
      res.status(403).json({
        error: 'Staff session is inactive or credentials were reset by the shop owner.',
      });
      return;
    }

    req.firebaseUser = user;
    req.bearerToken = token;
    req.staffContext = { shopId, staffId, staff };
    next();
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'Invalid staff authentication token.',
    });
  }
}

export function createCaremartApp(overrides: Partial<ServerDependencies> = {}) {
  validateRequiredSecrets();
  const deps: ServerDependencies = {
    verifyFirebaseIdToken,
    firestoreGetDoc,
    firestoreListCollection,
    firestoreQuerySaleItemsBySaleId,
    firestoreBatchGetDocs,
    suggestUpsellWithGemini,
    ...overrides,
  };

  const app = express();
  app.disable('x-powered-by');

  const lookupIpLimiter = new SlidingWindowRateLimiter(20, 60_000);
  const lookupTargetLimiter = new SlidingWindowRateLimiter(8, 60_000);
  const authVerifyLimiter = new SlidingWindowRateLimiter(30, 60_000);
  const upsellWriteLimiter = new SlidingWindowRateLimiter(90, 60_000);
  const geminiUserLimiter = new SlidingWindowRateLimiter(15, 60_000);
  const geminiShopLimiter = new SlidingWindowRateLimiter(45, 60_000);

  function getClientIp(req: Request): string {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) {
      return fwd.split(',')[0].trim().slice(0, 64);
    }
    return (req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 64);
  }

  function applyRateLimit(
    limiter: SlidingWindowRateLimiter,
    key: string,
    res: Response,
    message = 'Too many requests. Please wait a moment and try again.'
  ): boolean {
    const check = limiter.consume(key);
    if (!check.allowed) {
      res.setHeader('Retry-After', String(check.retryAfterSec));
      res.status(429).json({ ok: false, error: message });
      return false;
    }
    return true;
  }

  // Security headers (preserve iframe embedding compatibility for AI Studio preview)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    next();
  });

  // Route-scoped JSON body size limits (10mb reserved strictly for Sheets workbook sync)
  app.use('/api/admin/sheets/sync', express.json({ limit: '10mb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const bodyErr = err as { type?: string; status?: number } | null;
    if (bodyErr && (bodyErr.type === 'entity.too.large' || bodyErr.status === 413)) {
      res.status(413).json({ ok: false, error: 'Request payload exceeds allowed size limit.' });
      return;
    }
    if (bodyErr && bodyErr.type === 'entity.parse.failed') {
      res.status(400).json({ ok: false, error: 'Malformed JSON request body.' });
      return;
    }
    next(err);
  });

  // Scoped auth wrappers using injectable dependencies
  async function verifyIdTokenDep(idToken: string): Promise<VerifiedFirebaseUser> {
    return deps.verifyFirebaseIdToken(idToken);
  }

  async function requireOwner(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (deps.verifyFirebaseIdToken === verifyFirebaseIdToken && deps.firestoreGetDoc === firestoreGetDoc) {
      await requireOwnerMiddleware(req, res, next);
      return;
    }
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication token required.' });
      return;
    }
    try {
      const user = await verifyIdTokenDep(token);
      if (user.provider !== 'password' && user.provider !== 'google.com') {
        res.status(403).json({ error: 'Owner/Admin authentication required.' });
        return;
      }
      const ownerSetup = await deps.firestoreGetDoc('appState/ownerSetup', token);
      const primaryOwnerUid = ownerSetup?.ownerUid ? String(ownerSetup.ownerUid) : '';
      if (primaryOwnerUid && primaryOwnerUid === user.uid) {
        req.firebaseUser = user;
        req.bearerToken = token;
        req.shopId = primaryOwnerUid;
        req.isPrimaryOwner = true;
        next();
        return;
      }
      const adminMap = await deps.firestoreGetDoc(`adminAuthMap/${user.uid}`, token);
      if (adminMap && adminMap.isActive === true && adminMap.shopId) {
        req.firebaseUser = user;
        req.bearerToken = token;
        req.shopId = String(adminMap.shopId);
        req.isPrimaryOwner = false;
        next();
        return;
      }
      res.status(403).json({ error: 'Not authorized as Owner/Admin.' });
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Invalid or expired authentication token.',
      });
    }
  }

  async function requireStaff(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    if (deps.verifyFirebaseIdToken === verifyFirebaseIdToken && deps.firestoreGetDoc === firestoreGetDoc) {
      await requireStaffMiddleware(req, res, next);
      return;
    }
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication token required.' });
      return;
    }
    try {
      const user = await verifyIdTokenDep(token);
      if (user.provider !== 'password') {
        res.status(403).json({ error: 'Sales staff must authenticate with password.' });
        return;
      }
      const authMap = await deps.firestoreGetDoc(`staffAuthMap/${user.uid}`, token);
      const shopId = String(authMap?.shopId || '');
      const staffId = String(authMap?.staffId || '');
      if (!authMap || authMap.isActive !== true || !shopId || !staffId) {
        res.status(403).json({ error: 'Staff account is inactive or revoked.' });
        return;
      }
      const staff = await deps.firestoreGetDoc(`shops/${shopId}/staff/${staffId}`, token);
      if (!staff || staff.isActive !== true || staff.authUid !== user.uid) {
        res.status(403).json({ error: 'Staff session is inactive or revoked.' });
        return;
      }
      req.firebaseUser = user;
      req.bearerToken = token;
      req.staffContext = { shopId, staffId, staff };
      next();
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Invalid staff authentication token.',
      });
    }
  }

  // Health & config status (never exposes OWNER_EMAIL or DISCORD_WEBHOOK_URL values)
  app.get('/api/health', async (req, res) => {
    const discordCaps = getDiscordCapabilities();
    if (req.query.probe === 'discord') {
      const live = await verifyDiscordWebhookLive();
      res.json({
        ok: true,
        ownerConfigured: Boolean(getConfiguredOwnerEmail()),
        discordConfigured: live.configured,
        discordStatus: live.status,
        discordLiveOk: live.liveOk,
        discordLiveStatusCode: live.liveStatusCode,
      });
      return;
    }
    res.json({
      ok: true,
      ownerConfigured: Boolean(getConfiguredOwnerEmail()),
      discordConfigured: discordCaps.configured,
      discordStatus: discordCaps.status,
    });
  });

  // Check whether single-owner initial admin setup has already been completed (zero PII)
  app.get('/api/auth/owner-setup-status', async (_req, res) => {
    try {
      const ownerSetup = await firestoreGetDoc('appState/ownerSetup');
      res.json({
        setupCompleted: Boolean(ownerSetup && ownerSetup.ownerUid && ownerSetup.initialized === true),
        ownerEmailConfigured: Boolean(getConfiguredOwnerEmail()),
      });
    } catch {
      res.json({
        setupCompleted: false,
        ownerEmailConfigured: Boolean(getConfiguredOwnerEmail()),
      });
    }
  });

  // Verify Owner/Admin Sign-In or Initial Admin Setup
  app.post('/api/auth/verify-owner', async (req, res) => {
    if (!applyRateLimit(authVerifyLimiter, `verify-owner:${getClientIp(req)}`, res)) return;
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication token required.' });
      return;
    }

    const mode = req.body?.mode === 'setup' ? 'setup' : req.body?.mode === 'signin' ? 'signin' : undefined;

    try {
      const user = await verifyIdTokenDep(token);
      const authCheck = await authorizeOwnerUser(user, token, { mode });
      if (!authCheck.ok) {
        clearSessionCookie(req, res);
        res.status(authCheck.status).json({ error: authCheck.error });
        return;
      }

      const ownerProof = computeOwnerProof(user.uid, user.email);
      setSessionCookie(req, res, {
        uid: user.uid,
        role: 'owner',
        email: user.email,
        shopId: authCheck.shopId,
        exp: Date.now() + 12 * 60 * 60 * 1000,
      });

      res.json({
        authorized: true,
        role: 'owner',
        uid: user.uid,
        shopId: authCheck.shopId,
        isPrimaryOwner: authCheck.isPrimaryOwner,
        email: user.email,
        ownerProof,
      });
    } catch (err) {
      clearSessionCookie(req, res);
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Failed to verify authentication.',
      });
    }
  });

  // Verify Sales Staff Sign-In (Password provider only; Google OAuth forbidden)
  app.post(
    '/api/auth/verify-staff',
    (req, res, next) => {
      if (!applyRateLimit(authVerifyLimiter, `verify-staff:${getClientIp(req)}`, res)) return;
      next();
    },
    requireStaff,
    (req: AuthenticatedRequest, res) => {
    const user = req.firebaseUser!;
    const ctx = req.staffContext!;
    setSessionCookie(req, res, {
      uid: user.uid,
      role: 'sales_staff',
      email: user.email,
      shopId: ctx.shopId,
      exp: Date.now() + 12 * 60 * 60 * 1000,
    });

    res.json({
      authorized: true,
      role: 'sales_staff',
      shopId: ctx.shopId,
      staff: { ...ctx.staff, role: 'sales_staff' },
    });
  });

  app.get('/api/auth/session', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const session = verifySessionToken(cookies[SESSION_COOKIE_NAME]);
    if (!session) {
      res.status(401).json({ authenticated: false });
      return;
    }
    res.json({
      authenticated: true,
      uid: session.uid,
      role: session.role,
      shopId: session.shopId,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  // Unauthenticated non-PII lookup for Sales Staff login (Username + optional Shop Code)
  app.post('/api/staff/lookup', async (req, res) => {
    const clientIp = getClientIp(req);
    if (!applyRateLimit(lookupIpLimiter, `staff-lookup-ip:${clientIp}`, res)) return;

    const usernameRaw = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const shopCodeRaw = typeof req.body?.shopCode === 'string' ? req.body.shopCode.trim() : '';

    if (!usernameRaw || !/^[a-zA-Z0-9_-]{2,40}$/.test(usernameRaw)) {
      res.status(400).json({ error: 'Enter a valid username (letters, numbers, _ or -).' });
      return;
    }
    if (shopCodeRaw && !/^[a-zA-Z0-9_-]{2,20}$/.test(shopCodeRaw)) {
      res.status(400).json({ error: 'Invalid shop code format.' });
      return;
    }

    const unameLower = usernameRaw.toLowerCase();
    const lookupKey = shopCodeRaw
      ? `${shopCodeRaw.toLowerCase()}_${unameLower}`
      : `u_${unameLower}`;
    if (!applyRateLimit(lookupTargetLimiter, `staff-lookup-target:${clientIp}:${lookupKey}`, res)) {
      return;
    }

    try {
      const lookup = await deps.firestoreGetDoc(`staffLookup/${lookupKey}`);
      // Uniform response for missing or inactive accounts prevents unauthenticated status enumeration
      if (!lookup || lookup.isActive !== true) {
        res.status(404).json({
          error: 'Invalid username or password. Contact your shop owner if needed.',
        });
        return;
      }

      const shopId = String(lookup.shopId || '');
      const loginVersion = Number(lookup.loginVersion || 1);
      const derivedShopCode = shopId.slice(0, 6).toLowerCase();
      const syntheticEmail = `${unameLower}.v${loginVersion}.${derivedShopCode}@staff.caremart.app`;

      res.json({
        shopId,
        loginVersion,
        isActive: true,
        syntheticEmail,
      });
    } catch {
      res.status(500).json({
        error: 'Unable to look up staff credentials.',
      });
    }
  });

  // Unauthenticated non-PII lookup for Added Admin login (Username)
  app.post('/api/admin/lookup', async (req, res) => {
    const clientIp = getClientIp(req);
    if (!applyRateLimit(lookupIpLimiter, `admin-lookup-ip:${clientIp}`, res)) return;

    const usernameRaw = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const shopCodeRaw = typeof req.body?.shopCode === 'string' ? req.body.shopCode.trim() : '';

    if (!usernameRaw || !/^[a-zA-Z0-9_-]{2,40}$/.test(usernameRaw)) {
      res.status(400).json({ error: 'Enter a valid admin username (letters, numbers, _ or -).' });
      return;
    }
    if (shopCodeRaw && !/^[a-zA-Z0-9_-]{2,20}$/.test(shopCodeRaw)) {
      res.status(400).json({ error: 'Invalid shop code format.' });
      return;
    }

    const unameLower = usernameRaw.toLowerCase();
    const lookupKey = shopCodeRaw
      ? `${shopCodeRaw.toLowerCase()}_${unameLower}`
      : `u_${unameLower}`;
    if (!applyRateLimit(lookupTargetLimiter, `admin-lookup-target:${clientIp}:${lookupKey}`, res)) {
      return;
    }

    try {
      const lookup = await deps.firestoreGetDoc(`adminLookup/${lookupKey}`);
      // Uniform response for missing or inactive accounts prevents unauthenticated status enumeration
      if (!lookup || lookup.isActive !== true) {
        res.status(404).json({
          error: 'Invalid admin username or password. Check your credentials and try again.',
        });
        return;
      }

      const shopId = String(lookup.shopId || '');
      const loginVersion = Number(lookup.loginVersion || 1);
      const derivedShopCode = shopId.slice(0, 6).toLowerCase();
      const syntheticEmail = `${unameLower}.v${loginVersion}.${derivedShopCode}@admin.caremart.app`;

      res.json({
        shopId,
        loginVersion,
        isActive: true,
        syntheticEmail,
      });
    } catch {
      res.status(500).json({
        error: 'Unable to look up admin credentials.',
      });
    }
  });

  // ------------------------------------------------------------------
  // Protected Owner / Admin API Routes (Blocked for Sales Staff & Unauthorized Users)
  // ------------------------------------------------------------------
  app.get('/api/admin/authorize', requireOwner, (req: AuthenticatedRequest, res) => {
    res.json({
      authorized: true,
      role: 'owner',
      uid: req.firebaseUser!.uid,
      shopId: req.shopId!,
      email: req.firebaseUser!.email,
    });
  });

  app.get('/api/admin/staff', requireOwner, async (req: AuthenticatedRequest, res) => {
    try {
      const staff = await deps.firestoreListCollection(
        `shops/${req.shopId!}/staff`,
        req.bearerToken!
      );
      res.json({ staff });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to load staff list.',
      });
    }
  });

  app.post(
    '/api/admin/staff/authorize',
    requireOwner,
    async (req: AuthenticatedRequest, res) => {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

      if (!name) {
        res.status(400).json({ error: 'Staff full name is required.' });
        return;
      }
      if (!/^[a-zA-Z0-9_-]{2,40}$/.test(username)) {
        res.status(400).json({
          error: 'Username must be 2–40 characters using letters, numbers, _ or -.',
        });
        return;
      }

      const unameLower = username.toLowerCase();
      const [existingStaff, existingAdmin] = await Promise.all([
        firestoreGetDoc(`staffLookup/u_${unameLower}`),
        firestoreGetDoc(`adminLookup/u_${unameLower}`),
      ]);
      if (existingStaff || existingAdmin) {
        res.status(409).json({
          error: `Username "${username}" is already registered. Choose a different username.`,
        });
        return;
      }

      res.json({
        authorized: true,
        enforcedRole: 'sales_staff',
        ownerUid: req.shopId!,
      });
    }
  );

  app.patch(
    '/api/admin/staff/:staffId/authorize',
    requireOwnerMiddleware,
    (req: AuthenticatedRequest, res) => {
      res.json({
        authorized: true,
        ownerUid: req.shopId!,
        staffId: req.params.staffId,
      });
    }
  );

  app.post(
    '/api/admin/staff/:staffId/reset-password/authorize',
    requireOwnerMiddleware,
    (req: AuthenticatedRequest, res) => {
      res.json({
        authorized: true,
        ownerUid: req.shopId!,
        staffId: req.params.staffId,
      });
    }
  );

  app.post(
    '/api/admin/admins/authorize',
    requireOwnerMiddleware,
    async (req: AuthenticatedRequest, res) => {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

      if (!name) {
        res.status(400).json({ error: 'Admin full name is required.' });
        return;
      }
      if (!/^[a-zA-Z0-9_-]{2,40}$/.test(username)) {
        res.status(400).json({
          error: 'Username must be 2–40 characters using letters, numbers, _ or -.',
        });
        return;
      }

      const unameLower = username.toLowerCase();
      const [existingAdmin, existingStaff] = await Promise.all([
        firestoreGetDoc(`adminLookup/u_${unameLower}`),
        firestoreGetDoc(`staffLookup/u_${unameLower}`),
      ]);
      if (existingAdmin || existingStaff) {
        res.status(409).json({
          error: `Username "${username}" is already registered. Choose a different username.`,
        });
        return;
      }

      res.json({
        authorized: true,
        enforcedRole: 'admin',
        shopId: req.shopId!,
      });
    }
  );

  app.patch(
    '/api/admin/admins/:adminMemberId/authorize',
    requireOwnerMiddleware,
    (req: AuthenticatedRequest, res) => {
      res.json({
        authorized: true,
        shopId: req.shopId!,
        adminMemberId: req.params.adminMemberId,
      });
    }
  );

  app.post(
    '/api/admin/admins/:adminMemberId/reset-password/authorize',
    requireOwnerMiddleware,
    (req: AuthenticatedRequest, res) => {
      res.json({
        authorized: true,
        shopId: req.shopId!,
        adminMemberId: req.params.adminMemberId,
      });
    }
  );

  app.get('/api/admin/reports/authorize', requireOwnerMiddleware, (req: AuthenticatedRequest, res) => {
    res.json({
      authorized: true,
      role: 'owner',
      uid: req.firebaseUser!.uid,
      shopId: req.shopId!,
    });
  });

  app.get('/api/admin/sheets/capabilities', requireOwnerMiddleware, (req: AuthenticatedRequest, res) => {
    res.json(getGoogleSheetsCapabilities(req.shopId!));
  });

  app.post(
    '/api/admin/sheets/service-account',
    requireOwnerMiddleware,
    async (req: AuthenticatedRequest, res) => {
      const rawJson =
        typeof req.body?.serviceAccountJson === 'string' ? req.body.serviceAccountJson : '';
      if (!rawJson.trim()) {
        res.status(400).json({
          code: 'GOOGLE_API_ERROR',
          error: 'Google Service Account JSON string is required.',
        });
        return;
      }
      if (rawJson.length > 32_768) {
        res.status(400).json({
          code: 'GOOGLE_API_ERROR',
          error: 'Service Account JSON payload exceeds the 32 KB size limit.',
        });
        return;
      }

      try {
        await saveServiceAccountForOwner(req.shopId!, rawJson);
        res.json({
          ok: true,
          ...getGoogleSheetsCapabilities(req.shopId!),
        });
      } catch (err) {
        if (err instanceof GoogleSheetsApiError) {
          res.status(err.status).json({ code: err.code, error: err.message });
          return;
        }
        res.status(500).json({
          code: 'GOOGLE_API_ERROR',
          error:
            err instanceof Error
              ? err.message
              : 'Failed to verify and save Google Service Account credentials.',
        });
      }
    }
  );

  app.delete(
    '/api/admin/sheets/service-account',
    requireOwnerMiddleware,
    (req: AuthenticatedRequest, res) => {
      try {
        removeServiceAccountForOwner(req.shopId!);
        res.json({
          ok: true,
          ...getGoogleSheetsCapabilities(req.shopId!),
        });
      } catch (err) {
        res.status(500).json({
          code: 'GOOGLE_API_ERROR',
          error:
            err instanceof Error
              ? err.message
              : 'Failed to remove saved Google Service Account credentials.',
        });
      }
    }
  );

  app.post('/api/admin/sheets/ensure', requireOwnerMiddleware, async (req: AuthenticatedRequest, res) => {
    const userOAuthToken = String(req.headers['x-google-access-token'] || '').trim();
    const existingSpreadsheetId =
      typeof req.body?.spreadsheetId === 'string' ? req.body.spreadsheetId.trim() : undefined;
    const requireExisting = Boolean(req.body?.requireExisting);

    try {
      const accessToken = await resolveGoogleSheetsAccessToken(
        userOAuthToken,
        req.shopId!
      );
      if (!accessToken) {
        res.status(401).json({
          code: 'GOOGLE_TOKEN_MISSING',
          error:
            'Google Sheets authorization is required. Authorize Google Sheets in Settings, or configure a Google Service Account in Advanced Integration if using Google Advanced Protection.',
        });
        return;
      }

      const result = await ensureBusinessSpreadsheet(
        accessToken,
        existingSpreadsheetId,
        requireExisting
      );
      res.json(result);
    } catch (err) {
      if (err instanceof GoogleSheetsApiError) {
        res.status(err.status).json({ code: err.code, error: err.message });
        return;
      }
      res.status(500).json({
        code: 'GOOGLE_API_ERROR',
        error: err instanceof Error ? err.message : 'Failed to initialize Google Spreadsheet.',
      });
    }
  });

  app.post('/api/admin/sheets/sync', requireOwnerMiddleware, async (req: AuthenticatedRequest, res) => {
    const userOAuthToken = String(req.headers['x-google-access-token'] || '').trim();
    const spreadsheetId =
      typeof req.body?.spreadsheetId === 'string' ? req.body.spreadsheetId.trim() : undefined;
    const sheets = (req.body?.sheets || {}) as SheetSyncPayload;

    if (!sheets || typeof sheets !== 'object' || Array.isArray(sheets)) {
      res.status(400).json({ error: 'Invalid Google Sheets sync payload.' });
      return;
    }

    try {
      const accessToken = await resolveGoogleSheetsAccessToken(
        userOAuthToken,
        req.shopId!
      );
      if (!accessToken) {
        res.status(401).json({
          code: 'GOOGLE_TOKEN_MISSING',
          error:
            'Google Sheets authorization is required. Authorize Google Sheets in Settings, or configure a Google Service Account in Advanced Integration if using Google Advanced Protection.',
        });
        return;
      }

      const result = await syncSpreadsheetTabs(accessToken, spreadsheetId, sheets);
      res.json(result);
    } catch (err) {
      if (err instanceof GoogleSheetsApiError) {
        res.status(err.status).json({ code: err.code, error: err.message });
        return;
      }
      res.status(500).json({
        code: 'GOOGLE_API_ERROR',
        error: err instanceof Error ? err.message : 'Failed to synchronize Google Sheets.',
      });
    }
  });

  // ------------------------------------------------------------------
  // Protected Sales Staff API Route
  // ------------------------------------------------------------------
  app.post(
    '/api/staff/sales/authorize',
    requireStaffMiddleware,
    (req: AuthenticatedRequest, res) => {
      const staff = req.staffContext!.staff as {
        permissions?: { canAddSales?: boolean };
      };
      if (staff.permissions?.canAddSales !== true) {
        res.status(403).json({ error: 'You do not have permission to add new sales.' });
        return;
      }
      res.json({
        authorized: true,
        role: 'sales_staff',
        shopId: req.staffContext!.shopId,
        staffId: req.staffContext!.staffId,
      });
    }
  );

  // ------------------------------------------------------------------
  // Admin Discord Notification Diagnostics, Encrypted Webhook Vault & Test Routes
  // ------------------------------------------------------------------
  app.get('/api/admin/discord/capabilities', requireOwnerMiddleware, async (req: AuthenticatedRequest, res) => {
    if (req.query.verify === '1') {
      res.json(await verifyDiscordWebhookLive(req.shopId!));
      return;
    }
    res.json(getDiscordCapabilities(req.shopId!));
  });

  app.post('/api/admin/discord/webhook', requireOwnerMiddleware, async (req: AuthenticatedRequest, res) => {
    const rawWebhookUrl =
      typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl.trim() : '';
    if (!rawWebhookUrl) {
      res.status(400).json({ error: 'Discord webhook URL is required.' });
      return;
    }
    if (rawWebhookUrl.length > 512) {
      res.status(400).json({ error: 'Discord webhook URL exceeds maximum length.' });
      return;
    }

    try {
      const caps = await saveDiscordWebhookForOwner(req.shopId!, rawWebhookUrl);
      res.json({ ok: true, ...caps });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to verify and save Discord webhook URL.',
      });
    }
  });

  app.delete('/api/admin/discord/webhook', requireOwnerMiddleware, (req: AuthenticatedRequest, res) => {
    try {
      const caps = removeDiscordWebhookForOwner(req.shopId!);
      res.json({ ok: true, ...caps });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to remove saved Discord webhook URL.',
      });
    }
  });

  app.post('/api/admin/discord/test', requireOwnerMiddleware, async (req: AuthenticatedRequest, res) => {
    const actor = req.firebaseUser?.name || req.firebaseUser?.email || 'Admin';
    const result = await sendDiscordTestNotification(req.shopId!, actor);
    if (result.sent) {
      res.json({ ok: true, ...result });
      return;
    }
    if (result.skipped) {
      res.status(503).json({ ok: false, ...result });
      return;
    }
    if (result.statusCode === 429) {
      if (result.retryAfterMs) {
        res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      }
      res.status(429).json({ ok: false, ...result });
      return;
    }
    const status = result.retryable === false ? 422 : 502;
    res.status(status).json({ ok: false, ...result });
  });

  // ------------------------------------------------------------------
  // Independent Discord Webhook Notification Route (Owner/Admin or Active Sales Staff)
  // ------------------------------------------------------------------
  app.post('/api/notifications/discord', async (req, res) => {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication token required.' });
      return;
    }

    const payload = req.body as Partial<DiscordTransactionNotificationPayload> | undefined;
    if (
      !payload ||
      typeof payload !== 'object' ||
      (payload.type !== 'sale' && payload.type !== 'purchase' && payload.type !== 'expense')
    ) {
      res.status(400).json({ error: 'Invalid Discord notification payload.' });
      return;
    }

    let user: VerifiedFirebaseUser;
    try {
      user = await verifyFirebaseIdToken(token);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid or expired authentication token.';
      console.warn(`[Discord] Auth verification failed (${payload.type}:${payload.dedupeId || 'unknown'}): ${message}`);
      res.status(401).json({ ok: false, sent: false, error: message });
      return;
    }

    try {
      let resolvedShopId = '';

      const ownerCheck = await authorizeOwnerUser(user, token, {
        requireExistingAdminOrSetup: true,
      });

      if (ownerCheck.ok) {
        resolvedShopId = ownerCheck.shopId;
      } else if (payload.type === 'sale' && user.provider === 'password') {
        const authMap = await firestoreGetDoc(`staffAuthMap/${user.uid}`, token);
        const shopId = String(authMap?.shopId || '');
        const staffId = String(authMap?.staffId || '');
        if (!authMap || authMap.isActive !== true || !shopId || !staffId) {
          console.warn(`[Discord] Staff unauthorized (${payload.type}:${payload.dedupeId || 'unknown'})`);
          res.status(403).json({ error: 'Staff account is inactive or unauthorized.' });
          return;
        }
        const staff = await firestoreGetDoc(`shops/${shopId}/staff/${staffId}`, token);
        const permissions = (staff?.permissions || {}) as { canAddSales?: boolean };
        if (
          !staff ||
          staff.isActive !== true ||
          staff.authUid !== user.uid ||
          permissions.canAddSales !== true
        ) {
          console.warn(`[Discord] Staff permission denied (${payload.type}:${payload.dedupeId || 'unknown'})`);
          res.status(403).json({ error: 'You do not have permission to send sale notifications.' });
          return;
        }
        resolvedShopId = shopId;
      } else {
        console.warn(`[Discord] Authorization rejected (${ownerCheck.status}, ${payload.type}:${payload.dedupeId || 'unknown'}): ${ownerCheck.error}`);
        res.status(ownerCheck.status).json({ error: ownerCheck.error });
        return;
      }

      const result = await sendDiscordTransactionNotification(
        resolvedShopId,
        payload as DiscordTransactionNotificationPayload
      );
      if (result.sent || result.deduplicated) {
        res.json({ ok: true, ...result });
        return;
      }
      if (result.skipped) {
        console.warn(`[Discord] Delivery skipped (${payload.type}:${payload.dedupeId || 'unknown'}): ${result.reason || result.error}`);
        res.status(503).json({ ok: false, ...result });
        return;
      }
      if (result.statusCode === 429) {
        if (result.retryAfterMs) {
          res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
        }
        res.status(429).json({ ok: false, ...result });
        return;
      }
      const httpStatus = result.retryable === false ? 422 : 502;
      console.warn(`[Discord] Delivery failed (${httpStatus}, ${payload.type}:${payload.dedupeId || 'unknown'}): ${result.error || 'Unknown error'}`);
      res.status(httpStatus).json({ ok: false, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to process Discord notification.';
      console.warn(`[Discord] Transient server error (${payload.type}:${payload.dedupeId || 'unknown'}): ${message}`);
      res.status(502).json({
        ok: false,
        sent: false,
        retryable: true,
        error: message,
      });
    }
  });

  // ------------------------------------------------------------------
  // Hybrid Upsell & Persistent Shared Co-Occurrence Cache Routes
  // ------------------------------------------------------------------
  const cooccurrenceFirestoreCheckedShops = new Set<string>();

  async function resolveShopIdForUpsellRoute(
    req: Request,
    res: Response,
    options: { allowStaff: boolean }
  ): Promise<{
    shopId: string;
    role: 'owner' | 'sales_staff';
    uid: string;
    staffId?: string;
    token: string;
  } | null> {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ ok: false, error: 'Authentication token required.' });
      return null;
    }

    let user: VerifiedFirebaseUser;
    try {
      user = await verifyIdTokenDep(token);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid or expired authentication token.';
      res.status(401).json({ ok: false, error: message });
      return null;
    }

    let ownerCheck:
      | { ok: true; shopId: string; isPrimaryOwner: boolean }
      | { ok: false; status: number; error: string };

    if (deps.firestoreGetDoc === firestoreGetDoc) {
      ownerCheck = await authorizeOwnerUser(user, token, {
        requireExistingAdminOrSetup: true,
      });
    } else if (user.provider === 'password' || user.provider === 'google.com') {
      const staffMap = await deps.firestoreGetDoc(`staffAuthMap/${user.uid}`, token);
      if (staffMap) {
        ownerCheck = { ok: false, status: 403, error: 'Sales staff cannot access owner routes.' };
      } else {
        const ownerSetup = await deps.firestoreGetDoc('appState/ownerSetup', token);
        const primaryUid = ownerSetup?.ownerUid ? String(ownerSetup.ownerUid) : '';
        if (primaryUid && primaryUid === user.uid) {
          ownerCheck = { ok: true, shopId: primaryUid, isPrimaryOwner: true };
        } else {
          const adminMap = await deps.firestoreGetDoc(`adminAuthMap/${user.uid}`, token);
          if (adminMap && adminMap.isActive === true && adminMap.shopId) {
            ownerCheck = { ok: true, shopId: String(adminMap.shopId), isPrimaryOwner: false };
          } else {
            ownerCheck = { ok: false, status: 403, error: 'Unauthorized user.' };
          }
        }
      }
    } else {
      ownerCheck = { ok: false, status: 403, error: 'Unsupported provider.' };
    }

    if (ownerCheck.ok) {
      return { shopId: ownerCheck.shopId, role: 'owner', uid: user.uid, token };
    }

    if (options.allowStaff && user.provider === 'password') {
      const authMap = await deps.firestoreGetDoc(`staffAuthMap/${user.uid}`, token);
      const shopId = String(authMap?.shopId || '');
      const staffId = String(authMap?.staffId || '');
      if (!authMap || authMap.isActive !== true || !shopId || !staffId) {
        res.status(403).json({ ok: false, error: 'Staff account is inactive or unauthorized.' });
        return null;
      }
      const staff = await deps.firestoreGetDoc(`shops/${shopId}/staff/${staffId}`, token);
      const permissions = (staff?.permissions || {}) as { canAddSales?: boolean };
      if (
        !staff ||
        staff.isActive !== true ||
        staff.authUid !== user.uid ||
        permissions.canAddSales !== true
      ) {
        res.status(403).json({
          ok: false,
          error: 'You do not have permission to access sales recommendations.',
        });
        return null;
      }
      return { shopId, role: 'sales_staff', uid: user.uid, staffId, token };
    }

    res.status(ownerCheck.status).json({ ok: false, error: ownerCheck.error });
    return null;
  }

  function sanitizeCooccurrenceSaleInput(raw: unknown): CooccurrenceSaleInput | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = raw as Record<string, unknown>;
    const saleId = typeof rec.saleId === 'string' ? rec.saleId.trim() : '';
    const status = typeof rec.status === 'string' ? rec.status.trim().toLowerCase() : 'completed';
    if (!saleId || !isValidDocId(saleId) || status === 'cancelled' || status !== 'completed') {
      return null;
    }
    if (!Array.isArray(rec.productIds) || rec.productIds.length === 0 || rec.productIds.length > 80) {
      return null;
    }
    const productIds: string[] = [];
    for (const id of rec.productIds) {
      if (typeof id !== 'string') return null;
      const trimmed = id.trim();
      if (!trimmed || !isValidDocId(trimmed)) return null;
      productIds.push(trimmed);
    }
    if (productIds.length === 0) return null;
    return { saleId, status: 'completed', productIds };
  }

  function extractStaffSaleProductIds(staffSale: Record<string, unknown>): string[] {
    const items = Array.isArray(staffSale.items) ? staffSale.items : [];
    const ids = new Set<string>();
    for (const item of items) {
      if (item && typeof item === 'object') {
        const pid = typeof (item as Record<string, unknown>).productId === 'string'
          ? String((item as Record<string, unknown>).productId).trim()
          : '';
        if (pid && isValidDocId(pid)) ids.add(pid);
      }
    }
    return Array.from(ids);
  }

  async function verifyCooccurrenceSaleAgainstFirestore(
    authCtx: {
      shopId: string;
      role: 'owner' | 'sales_staff';
      uid: string;
      staffId?: string;
      token: string;
    },
    submitted: CooccurrenceSaleInput
  ): Promise<{ ok: true; verifiedSale: CooccurrenceSaleInput } | { ok: false; status: number; error: string }> {
    if (authCtx.role === 'sales_staff') {
      const staffSale = await deps.firestoreGetDoc(
        `shops/${authCtx.shopId}/staffSales/${submitted.saleId}`,
        authCtx.token
      );
      if (
        !staffSale ||
        String(staffSale.ownerUid || '') !== authCtx.shopId ||
        String(staffSale.staffAuthUid || '') !== authCtx.uid ||
        (authCtx.staffId && String(staffSale.staffId || '') !== authCtx.staffId)
      ) {
        return {
          ok: false,
          status: 403,
          error: 'Submitted sale does not exist or does not belong to this staff account.',
        };
      }
      if (String(staffSale.status || '') !== 'completed') {
        return {
          ok: false,
          status: 409,
          error: 'Only completed sales are eligible for recommendation learning.',
        };
      }
      const authoritativeIds = extractStaffSaleProductIds(staffSale);
      const authSet = new Set(authoritativeIds);
      if (authoritativeIds.length === 0 || submitted.productIds.some((pid) => !authSet.has(pid))) {
        return {
          ok: false,
          status: 403,
          error: 'Submitted product IDs do not match the verified sale.',
        };
      }
      return {
        ok: true,
        verifiedSale: {
          saleId: submitted.saleId,
          status: 'completed',
          productIds: authoritativeIds,
        },
      };
    }

    // Owner/admin: verify against shops/{shopId}/sales/{saleId} or unsynced staffSales/{saleId}
    const ownerSale = await deps.firestoreGetDoc(
      `shops/${authCtx.shopId}/sales/${submitted.saleId}`,
      authCtx.token
    );
    if (ownerSale) {
      if (String(ownerSale.ownerUid || '') !== authCtx.shopId) {
        return { ok: false, status: 403, error: 'Sale does not belong to this shop.' };
      }
      if (String(ownerSale.status || '') !== 'completed') {
        return {
          ok: false,
          status: 409,
          error: 'Only completed sales are eligible for recommendation learning.',
        };
      }
      const saleItems = await deps.firestoreQuerySaleItemsBySaleId(
        authCtx.shopId,
        submitted.saleId,
        authCtx.token
      );
      const authIds = new Set<string>();
      for (const item of saleItems) {
        if (String(item.status || 'completed') === 'cancelled') continue;
        const pid = typeof item.productId === 'string' ? item.productId.trim() : '';
        if (pid && isValidDocId(pid)) authIds.add(pid);
      }
      if (authIds.size === 0 || submitted.productIds.some((pid) => !authIds.has(pid))) {
        return {
          ok: false,
          status: 403,
          error: 'Submitted product IDs do not match verified sale line items.',
        };
      }
      return {
        ok: true,
        verifiedSale: {
          saleId: submitted.saleId,
          status: 'completed',
          productIds: Array.from(authIds),
        },
      };
    }

    const staffSale = await deps.firestoreGetDoc(
      `shops/${authCtx.shopId}/staffSales/${submitted.saleId}`,
      authCtx.token
    );
    if (!staffSale || String(staffSale.ownerUid || '') !== authCtx.shopId) {
      return { ok: false, status: 404, error: 'Completed sale record not found for this shop.' };
    }
    if (String(staffSale.status || '') !== 'completed') {
      return {
        ok: false,
        status: 409,
        error: 'Only completed sales are eligible for recommendation learning.',
      };
    }
    const staffProdIds = extractStaffSaleProductIds(staffSale);
    const staffProdSet = new Set(staffProdIds);
    if (staffProdIds.length === 0 || submitted.productIds.some((pid) => !staffProdSet.has(pid))) {
      return {
        ok: false,
        status: 403,
        error: 'Submitted product IDs do not match verified sale line items.',
      };
    }
    return {
      ok: true,
      verifiedSale: {
        saleId: submitted.saleId,
        status: 'completed',
        productIds: staffProdIds,
      },
    };
  }

  app.get('/api/upsell/cooccurrence', async (req, res) => {
    try {
      const authCtx = await resolveShopIdForUpsellRoute(req, res, { allowStaff: true });
      if (!authCtx) return;

      let { snapshot, recovered } = getServerCooccurrenceSnapshot(
        authCtx.shopId,
        deps.cooccurrenceCacheDir
      );
      if (
        snapshot.totalCompletedSales === 0 &&
        snapshot.revision === 0 &&
        !cooccurrenceFirestoreCheckedShops.has(authCtx.shopId)
      ) {
        cooccurrenceFirestoreCheckedShops.add(authCtx.shopId);
        try {
          const fsDoc = await deps.firestoreGetDoc(
            `shops/${authCtx.shopId}/upsellCache/cooccurrence_v${COOCCURRENCE_CACHE_VERSION}`,
            authCtx.token
          );
          if (fsDoc && Number(fsDoc.version) === COOCCURRENCE_CACHE_VERSION) {
            const hydrated = hydrateServerCooccurrenceFromExternalSnapshot(
              authCtx.shopId,
              {
                version: Number(fsDoc.version),
                shopId: authCtx.shopId,
                revision: Number(fsDoc.revision) || 0,
                totalCompletedSales: Number(fsDoc.totalCompletedSales) || 0,
                saleCountsByProduct: fsDoc.saleCountsByProduct,
                pairCounts: fsDoc.pairCounts,
                processedSaleIds: fsDoc.processedSaleIds,
                updatedAt: Date.now(),
              },
              deps.cooccurrenceCacheDir
            );
            if (hydrated) {
              snapshot = hydrated;
              recovered = false;
            }
          }
        } catch {
          // Cold Firestore hydration is best-effort only
        }
      }

      const sinceRevision = Number(req.query?.sinceRevision);
      if (
        !recovered &&
        Number.isFinite(sinceRevision) &&
        sinceRevision >= 0 &&
        sinceRevision === snapshot.revision
      ) {
        res.json({
          ok: true,
          unchanged: true,
          version: snapshot.version,
          revision: snapshot.revision,
        });
        return;
      }

      res.json({
        ok: true,
        unchanged: false,
        recovered,
        snapshot,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to load co-occurrence cache.';
      res.status(502).json({ ok: false, error: message });
    }
  });

  app.post('/api/upsell/cooccurrence/update', async (req, res) => {
    const sale = sanitizeCooccurrenceSaleInput(req.body);
    if (!sale) {
      res.status(400).json({ ok: false, error: 'Valid completed sale payload is required.' });
      return;
    }

    try {
      const authCtx = await resolveShopIdForUpsellRoute(req, res, { allowStaff: true });
      if (!authCtx) return;

      if (!applyRateLimit(upsellWriteLimiter, `upsell-write:${authCtx.shopId}:${authCtx.uid}`, res)) {
        return;
      }

      const verified = await verifyCooccurrenceSaleAgainstFirestore(authCtx, sale);
      if (!verified.ok) {
        res.status(verified.status).json({ ok: false, error: verified.error });
        return;
      }

      const result = recordServerCooccurrenceBatch(
        authCtx.shopId,
        [verified.verifiedSale],
        { cacheDir: deps.cooccurrenceCacheDir }
      );
      res.json({
        ok: true,
        version: result.snapshot.version,
        revision: result.snapshot.revision,
        totalCompletedSales: result.snapshot.totalCompletedSales,
        ingestedCount: result.ingestedCount,
        skippedDuplicateCount: result.skippedDuplicateCount,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to update co-occurrence cache.';
      res.status(502).json({ ok: false, error: message });
    }
  });

  app.post('/api/upsell/cooccurrence/rebuild', async (req, res) => {
    const body = req.body as {
      version?: unknown;
      resetFirst?: unknown;
      sales?: unknown;
    } | null;

    if (!body || typeof body !== 'object' || !Array.isArray(body.sales) || body.sales.length > 300) {
      res.status(400).json({ ok: false, error: 'Sales batch (max 300 entries) is required.' });
      return;
    }

    const clientVersion = Number(body.version);
    if (Number.isFinite(clientVersion) && clientVersion !== COOCCURRENCE_CACHE_VERSION) {
      res.status(409).json({
        ok: false,
        error: 'Co-occurrence cache version mismatch.',
        expectedVersion: COOCCURRENCE_CACHE_VERSION,
      });
      return;
    }

    const sanitizedSales: CooccurrenceSaleInput[] = [];
    for (const rawSale of body.sales) {
      const clean = sanitizeCooccurrenceSaleInput(rawSale);
      if (!clean) {
        res.status(400).json({ ok: false, error: 'Invalid sale entry in rebuild payload.' });
        return;
      }
      sanitizedSales.push(clean);
    }

    try {
      const authCtx = await resolveShopIdForUpsellRoute(req, res, { allowStaff: false });
      if (!authCtx) return;

      if (!applyRateLimit(upsellWriteLimiter, `upsell-write:${authCtx.shopId}:${authCtx.uid}`, res)) {
        return;
      }

      if (sanitizedSales.length > 0) {
        const docPaths = sanitizedSales.flatMap((s) => [
          `shops/${authCtx.shopId}/sales/${s.saleId}`,
          `shops/${authCtx.shopId}/staffSales/${s.saleId}`,
        ]);
        const foundDocs = await deps.firestoreBatchGetDocs(docPaths, authCtx.token);
        for (const s of sanitizedSales) {
          const ownerDoc = foundDocs.get(`shops/${authCtx.shopId}/sales/${s.saleId}`);
          const staffDoc = foundDocs.get(`shops/${authCtx.shopId}/staffSales/${s.saleId}`);
          const matchedDoc = ownerDoc || staffDoc;
          if (
            !matchedDoc ||
            String(matchedDoc.ownerUid || '') !== authCtx.shopId ||
            String(matchedDoc.status || '') !== 'completed'
          ) {
            res.status(403).json({
              ok: false,
              error: 'One or more submitted sales are not verified completed sales for this shop.',
            });
            return;
          }
          if (staffDoc && !ownerDoc) {
            const staffAuthIds = new Set(extractStaffSaleProductIds(staffDoc));
            if (staffAuthIds.size === 0 || s.productIds.some((pid) => !staffAuthIds.has(pid))) {
              res.status(403).json({
                ok: false,
                error: 'Submitted product IDs do not match verified staff sale.',
              });
              return;
            }
          }
        }
      }

      const result = recordServerCooccurrenceBatch(authCtx.shopId, sanitizedSales, {
        resetFirst: body.resetFirst === true,
        cacheDir: deps.cooccurrenceCacheDir,
      });
      res.json({
        ok: true,
        version: result.snapshot.version,
        revision: result.snapshot.revision,
        totalCompletedSales: result.snapshot.totalCompletedSales,
        ingestedCount: result.ingestedCount,
        skippedDuplicateCount: result.skippedDuplicateCount,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to reconcile co-occurrence cache.';
      res.status(502).json({ ok: false, error: message });
    }
  });

  app.post('/api/upsell/suggest', async (req, res) => {
    const sanitized = sanitizeUpsellRequestInput(req.body);
    if (!sanitized) {
      res.status(400).json({ ok: false, error: 'Invalid upsell suggestion payload.' });
      return;
    }

    try {
      const authCtx = await resolveShopIdForUpsellRoute(req, res, { allowStaff: true });
      if (!authCtx) return;

      const userLimit = geminiUserLimiter.consume(`${authCtx.shopId}:${authCtx.uid}`);
      const shopLimit = geminiShopLimiter.consume(authCtx.shopId);
      if (!userLimit.allowed || !shopLimit.allowed) {
        const retryAfter = Math.max(userLimit.retryAfterSec, shopLimit.retryAfterSec, 1);
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          ok: false,
          available: false,
          reason: 'GEMINI_RATE_LIMITED',
          suggestion: null,
          error: 'Upsell AI quota exceeded. Please try again shortly.',
        });
        return;
      }

      const result = await deps.suggestUpsellWithGemini(authCtx.shopId, sanitized);
      if (!result.available) {
        res.json({
          ok: true,
          available: false,
          reason: result.reason || 'GEMINI_NOT_CONFIGURED',
          suggestion: null,
        });
        return;
      }

      res.json({
        ok: true,
        available: true,
        cached: Boolean(result.cached),
        suggestion: result.suggested,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to compute upsell suggestion.';
      res.status(502).json({
        ok: false,
        available: false,
        reason: 'UPSELL_INTERNAL_ERROR',
        suggestion: null,
        error: message,
      });
    }
  });

  app.get('/api/upsell/feedback', async (req, res) => {
    try {
      const authCtx = await resolveShopIdForUpsellRoute(req, res, { allowStaff: true });
      if (!authCtx) return;

      const { snapshot, recovered } = getServerFeedbackSnapshot(
        authCtx.shopId,
        deps.feedbackCacheDir
      );
      const sinceRevision = Number(req.query?.sinceRevision);
      if (
        !recovered &&
        Number.isFinite(sinceRevision) &&
        sinceRevision >= 0 &&
        sinceRevision === snapshot.revision
      ) {
        res.json({
          ok: true,
          unchanged: true,
          version: snapshot.version,
          revision: snapshot.revision,
        });
        return;
      }

      res.json({
        ok: true,
        unchanged: false,
        recovered,
        snapshot,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load upsell feedback.';
      res.status(502).json({ ok: false, error: message });
    }
  });

  app.post('/api/upsell/feedback', async (req, res) => {
    const body = req.body as Record<string, unknown> | null;
    const validEventTypes = new Set<UpsellFeedbackEventType>([
      'shown',
      'accepted',
      'dismissed',
      'removed_after_add',
    ]);
    const productId =
      body && typeof body.productId === 'string' ? body.productId.trim() : '';
    const eventType =
      body && typeof body.eventType === 'string'
        ? (body.eventType.trim() as UpsellFeedbackEventType)
        : null;
    const rawEventId =
      body && typeof body.eventId === 'string' ? body.eventId.trim() : '';
    if (!productId || !isValidDocId(productId) || !eventType || !validEventTypes.has(eventType)) {
      res.status(400).json({ ok: false, error: 'Valid upsell feedback event payload is required.' });
      return;
    }
    if (rawEventId && !VALID_FEEDBACK_EVENT_ID_RE.test(rawEventId)) {
      res.status(400).json({ ok: false, error: 'Invalid feedback eventId format.' });
      return;
    }

    const sanitized: UpsellFeedbackEventInput = {
      ...(rawEventId ? { eventId: rawEventId } : {}),
      productId,
      eventType,
      categoryKey:
        typeof body?.categoryKey === 'string' ? body.categoryKey.trim().slice(0, 80) : undefined,
      anchorCategoryKeys: Array.isArray(body?.anchorCategoryKeys)
        ? body.anchorCategoryKeys
            .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
            .slice(0, 10)
            .map((k) => k.trim().slice(0, 80))
        : undefined,
    };

    try {
      const authCtx = await resolveShopIdForUpsellRoute(req, res, { allowStaff: true });
      if (!authCtx) return;

      if (!applyRateLimit(upsellWriteLimiter, `upsell-write:${authCtx.shopId}:${authCtx.uid}`, res)) {
        return;
      }

      // Verify product belongs to this shop before mutating feedback counters
      let productDoc: Record<string, unknown> | null = null;
      if (authCtx.role === 'owner') {
        productDoc = await deps.firestoreGetDoc(
          `shops/${authCtx.shopId}/products/${productId}`,
          authCtx.token
        );
        if (!productDoc) {
          productDoc = await deps.firestoreGetDoc(
            `shops/${authCtx.shopId}/staffCatalog/${productId}`,
            authCtx.token
          );
        }
      } else {
        productDoc = await deps.firestoreGetDoc(
          `shops/${authCtx.shopId}/staffCatalog/${productId}`,
          authCtx.token
        );
      }
      if (!productDoc || String(productDoc.ownerUid || '') !== authCtx.shopId) {
        res.status(403).json({
          ok: false,
          error: 'Product does not belong to the authorized shop catalog.',
        });
        return;
      }

      const { snapshot, duplicate } = recordServerFeedbackEventWithStatus(
        authCtx.shopId,
        sanitized,
        deps.feedbackCacheDir
      );
      res.json({
        ok: true,
        duplicate,
        version: snapshot.version,
        revision: snapshot.revision,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to record upsell feedback.';
      res.status(502).json({ ok: false, error: message });
    }
  });

  // Reject any unknown /api/* routes cleanly as JSON 404 before Vite SPA fallback
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  return app;
}

async function startServer() {
  getFirebaseProjectId();
  validateRequiredSecrets();
  const app = createCaremartApp();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`CareMart server listening on http://0.0.0.0:${port}`);
  });
}

if (!process.env.VITEST) {
  void startServer().catch((err) => {
    console.error('[Startup Error]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
