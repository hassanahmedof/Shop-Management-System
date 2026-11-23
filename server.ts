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
const firebaseConfig: FirebaseAppletConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const FIRESTORE_DB_ID = firebaseConfig.firestoreDatabaseId || '(default)';

const OWNER_GATE_SECRET =
  (process.env.OWNER_GATE_SECRET || '').trim() || 'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301';
const SESSION_SECRET =
  (process.env.SESSION_SECRET || '').trim() ||
  crypto
    .createHash('sha256')
    .update(`${OWNER_GATE_SECRET}:${firebaseConfig.projectId}:session`)
    .digest('hex');

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
  return crypto
    .createHash('sha256')
    .update(`${uid}:${email.toLowerCase()}:${OWNER_GATE_SECRET}`)
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
  const expectedIssuer = `https://securetoken.google.com/${firebaseConfig.projectId}`;

  if (payload.aud !== firebaseConfig.projectId) {
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
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
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
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${FIRESTORE_DB_ID}/documents/${docPath}`;
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore read failed (${res.status}): ${errText}`);
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
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${FIRESTORE_DB_ID}/documents/${collectionPath}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Firestore list failed (${res.status}): ${errText}`);
  }
  const json = (await res.json()) as {
    documents?: Array<{ name?: string; fields?: Record<string, Record<string, unknown>> }>;
  };
  return (json.documents || []).map((d) => decodeFirestoreDoc(d));
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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

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
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication token required.' });
      return;
    }

    const mode = req.body?.mode === 'setup' ? 'setup' : req.body?.mode === 'signin' ? 'signin' : undefined;

    try {
      const user = await verifyFirebaseIdToken(token);
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
  app.post('/api/auth/verify-staff', requireStaffMiddleware, (req: AuthenticatedRequest, res) => {
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

    try {
      const lookup = await firestoreGetDoc(`staffLookup/${lookupKey}`);
      if (!lookup) {
        res.status(404).json({
          error: 'Invalid username or password. Contact your shop owner if needed.',
        });
        return;
      }
      if (lookup.isActive !== true) {
        res.status(403).json({
          error: 'This staff account has been deactivated by the shop owner.',
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
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to look up staff credentials.',
      });
    }
  });

  // Unauthenticated non-PII lookup for Added Admin login (Username)
  app.post('/api/admin/lookup', async (req, res) => {
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

    try {
      const lookup = await firestoreGetDoc(`adminLookup/${lookupKey}`);
      if (!lookup) {
        res.status(404).json({
          error: 'Invalid admin username or password. Check your credentials and try again.',
        });
        return;
      }
      if (lookup.isActive !== true) {
        res.status(403).json({
          error: 'This admin account has been deactivated.',
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
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to look up admin credentials.',
      });
    }
  });

  // ------------------------------------------------------------------
  // Protected Owner / Admin API Routes (Blocked for Sales Staff & Unauthorized Users)
  // ------------------------------------------------------------------
  app.get('/api/admin/authorize', requireOwnerMiddleware, (req: AuthenticatedRequest, res) => {
    res.json({
      authorized: true,
      role: 'owner',
      uid: req.firebaseUser!.uid,
      shopId: req.shopId!,
      email: req.firebaseUser!.email,
    });
  });

  app.get('/api/admin/staff', requireOwnerMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
      const staff = await firestoreListCollection(
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
    requireOwnerMiddleware,
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

  // Reject any unknown /api/* routes cleanly as JSON 404 before Vite SPA fallback
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

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

void startServer();
