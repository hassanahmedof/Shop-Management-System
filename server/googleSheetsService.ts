import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CARE_MART_SPREADSHEET_TITLE,
  SHEET_TAB_MAP,
  SHEET_TABS,
  type ColumnFormatType,
  type SheetCellValue,
  type SheetSyncPayload,
  type SheetTabDefinition,
  type SheetTabName,
} from '../shared/googleSheetsSchema.ts';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const VAULT_DIR = path.resolve(process.cwd(), '.caremart-secrets');

interface ParsedServiceAccount {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  projectId: string | null;
}

interface ServiceAccountParseResult {
  account: ParsedServiceAccount | null;
  status: 'active' | 'not_configured' | 'invalid_format';
  diagnostic: string | null;
}

let cachedServiceAccountToken: {
  token: string;
  expiresAtMs: number;
  clientEmail: string;
  ownerKey: string;
} | null = null;

function getVaultEncryptionKey(): Buffer {
  const secretSeed =
    (process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY || '').trim() ||
    (process.env.OWNER_GATE_SECRET || '').trim() ||
    'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301';
  return crypto
    .createHash('sha256')
    .update(`caremart-service-account-vault:v1:${secretSeed}`)
    .digest();
}

function getVaultFilePath(ownerUid: string): string {
  const uidHash = crypto.createHash('sha256').update(ownerUid).digest('hex').slice(0, 24);
  return path.join(VAULT_DIR, `sa_${uidHash}.enc.json`);
}

function parseServiceAccountInput(
  rawInput: string,
  sourceLabel = 'Service Account JSON'
): ServiceAccountParseResult {
  const raw = rawInput.trim();
  if (!raw) {
    return { account: null, status: 'not_configured', diagnostic: null };
  }

  let jsonStr = raw;
  if (!raw.startsWith('{')) {
    try {
      jsonStr = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return {
        account: null,
        status: 'invalid_format',
        diagnostic: `${sourceLabel} is neither valid JSON nor base64-encoded JSON.`,
      };
    }
  }

  let parsed: {
    type?: unknown;
    project_id?: unknown;
    client_email?: unknown;
    private_key?: unknown;
    token_uri?: unknown;
  };
  try {
    parsed = JSON.parse(jsonStr) as typeof parsed;
  } catch {
    return {
      account: null,
      status: 'invalid_format',
      diagnostic: `${sourceLabel} could not be parsed as valid JSON.`,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      account: null,
      status: 'invalid_format',
      diagnostic: `${sourceLabel} must be a JSON object.`,
    };
  }

  if (parsed.type !== undefined && parsed.type !== 'service_account') {
    return {
      account: null,
      status: 'invalid_format',
      diagnostic: `Expected "type": "service_account", received "${String(parsed.type)}". Download a Service Account key (not an OAuth Client ID file).`,
    };
  }

  const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const privateKey =
    typeof parsed.private_key === 'string'
      ? parsed.private_key.replace(/\\n/g, '\n').trim()
      : '';
  const tokenUri =
    typeof parsed.token_uri === 'string' && parsed.token_uri.trim()
      ? parsed.token_uri.trim()
      : 'https://oauth2.googleapis.com/token';
  const projectId =
    typeof parsed.project_id === 'string' && parsed.project_id.trim()
      ? parsed.project_id.trim()
      : null;

  if (!clientEmail || !clientEmail.includes('@')) {
    return {
      account: null,
      status: 'invalid_format',
      diagnostic: `${sourceLabel} is missing a valid "client_email" address.`,
    };
  }

  if (!privateKey || !privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) {
    return {
      account: null,
      status: 'invalid_format',
      diagnostic: `${sourceLabel} is missing a valid PEM "private_key".`,
    };
  }

  try {
    const keyObj = crypto.createPrivateKey(privateKey);
    if (keyObj.type !== 'private') {
      throw new Error('Not a private key');
    }
  } catch {
    return {
      account: null,
      status: 'invalid_format',
      diagnostic: `${sourceLabel} contains an invalid or corrupted RSA private_key.`,
    };
  }

  if (!tokenUri.startsWith('https://')) {
    return {
      account: null,
      status: 'invalid_format',
      diagnostic: `${sourceLabel} has an invalid "token_uri" (must use https://).`,
    };
  }

  return {
    account: { clientEmail, privateKey, tokenUri, projectId },
    status: 'active',
    diagnostic: null,
  };
}

function readServiceAccountFromVault(ownerUid?: string): ServiceAccountParseResult {
  if (!ownerUid) {
    return { account: null, status: 'not_configured', diagnostic: null };
  }
  const filePath = getVaultFilePath(ownerUid);
  if (!fs.existsSync(filePath)) {
    return { account: null, status: 'not_configured', diagnostic: null };
  }

  try {
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      v?: number;
      iv?: string;
      tag?: string;
      data?: string;
    };
    if (!envelope.iv || !envelope.tag || !envelope.data) {
      return {
        account: null,
        status: 'invalid_format',
        diagnostic: 'Saved server Service Account vault file is incomplete. Please re-save it in Settings.',
      };
    }
    const key = getVaultEncryptionKey();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    const payload = JSON.parse(decrypted) as ParsedServiceAccount;
    if (!payload.clientEmail || !payload.privateKey) {
      return {
        account: null,
        status: 'invalid_format',
        diagnostic: 'Saved server Service Account credentials are incomplete.',
      };
    }
    return {
      account: {
        clientEmail: payload.clientEmail,
        privateKey: payload.privateKey,
        tokenUri: payload.tokenUri || 'https://oauth2.googleapis.com/token',
        projectId: payload.projectId || null,
      },
      status: 'active',
      diagnostic: null,
    };
  } catch {
    return {
      account: null,
      status: 'invalid_format',
      diagnostic: 'Saved server Service Account credentials could not be decrypted. Please re-save in Settings.',
    };
  }
}

function resolveConfiguredServiceAccount(ownerUid?: string): {
  parsed: ServiceAccountParseResult;
  source: 'vault' | 'env' | 'none';
} {
  const vault = readServiceAccountFromVault(ownerUid);
  if (vault.account || vault.status === 'invalid_format') {
    return { parsed: vault, source: 'vault' };
  }

  const envParsed = parseServiceAccountInput(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    'GOOGLE_SERVICE_ACCOUNT_JSON'
  );
  if (envParsed.account || envParsed.status === 'invalid_format') {
    return { parsed: envParsed, source: 'env' };
  }

  return {
    parsed: { account: null, status: 'not_configured', diagnostic: null },
    source: 'none',
  };
}

async function mintServiceAccountAccessToken(
  sa: ParsedServiceAccount,
  ownerKey: string,
  bypassCache = false
): Promise<string> {
  const nowMs = Date.now();
  if (
    !bypassCache &&
    cachedServiceAccountToken &&
    cachedServiceAccountToken.clientEmail === sa.clientEmail &&
    cachedServiceAccountToken.ownerKey === ownerKey &&
    nowMs < cachedServiceAccountToken.expiresAtMs
  ) {
    return cachedServiceAccountToken.token;
  }

  const nowSec = Math.floor(nowMs / 1000);
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claimB64 = Buffer.from(
    JSON.stringify({
      iss: sa.clientEmail,
      scope: SHEETS_SCOPE,
      aud: sa.tokenUri,
      exp: nowSec + 3600,
      iat: nowSec,
    })
  ).toString('base64url');

  const unsignedJwt = `${headerB64}.${claimB64}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  const signature = signer.sign(sa.privateKey).toString('base64url');
  const assertion = `${unsignedJwt}.${signature}`;

  const tokenRes = await fetch(sa.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => '');
    throw new GoogleSheetsApiError(
      `Google Service Account authorization failed (${tokenRes.status}): ${errText.slice(0, 220)}`,
      tokenRes.status,
      'GOOGLE_PERMISSION_DENIED'
    );
  }

  const tokenData = (await tokenRes.json()) as { access_token?: string; expires_in?: number };
  if (!tokenData.access_token) {
    throw new GoogleSheetsApiError(
      'Google Service Account token response did not contain access_token.',
      500,
      'GOOGLE_API_ERROR'
    );
  }

  const ttlMs = Math.max(60_000, ((tokenData.expires_in || 3600) - 180) * 1000);
  cachedServiceAccountToken = {
    token: tokenData.access_token,
    expiresAtMs: nowMs + ttlMs,
    clientEmail: sa.clientEmail,
    ownerKey,
  };
  return tokenData.access_token;
}

export async function saveServiceAccountForOwner(
  ownerUid: string,
  rawJsonInput: string
): Promise<{
  serviceAccountConfigured: true;
  serviceAccountSource: 'vault';
  serviceAccountEmail: string;
  serviceAccountProjectId: string | null;
}> {
  if (!ownerUid) {
    throw new GoogleSheetsApiError('Owner UID is required.', 401, 'GOOGLE_PERMISSION_DENIED');
  }
  const parsed = parseServiceAccountInput(rawJsonInput, 'Google Service Account JSON');
  if (!parsed.account) {
    throw new GoogleSheetsApiError(
      parsed.diagnostic || 'Invalid Google Service Account JSON.',
      400,
      'GOOGLE_API_ERROR'
    );
  }

  // Verify credentials live against Google OAuth token endpoint before encrypting and saving
  await mintServiceAccountAccessToken(parsed.account, ownerUid, true);

  fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  const key = getVaultEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify({
    clientEmail: parsed.account.clientEmail,
    privateKey: parsed.account.privateKey,
    tokenUri: parsed.account.tokenUri,
    projectId: parsed.account.projectId,
  });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const filePath = getVaultFilePath(ownerUid);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: authTag.toString('base64'),
      data: encrypted.toString('base64'),
      updatedAt: new Date().toISOString(),
    }),
    { encoding: 'utf8', mode: 0o600 }
  );
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Ignore chmod error on platforms without POSIX mode support
  }

  return {
    serviceAccountConfigured: true,
    serviceAccountSource: 'vault',
    serviceAccountEmail: parsed.account.clientEmail,
    serviceAccountProjectId: parsed.account.projectId,
  };
}

export function removeServiceAccountForOwner(ownerUid: string): void {
  if (!ownerUid) return;
  const filePath = getVaultFilePath(ownerUid);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  if (cachedServiceAccountToken?.ownerKey === ownerUid) {
    cachedServiceAccountToken = null;
  }
}

export function parseSpreadsheetId(input?: string): string {
  const raw = (input || '').trim();
  if (!raw) return '';
  const match = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/i.exec(raw);
  if (match?.[1]) return match[1];
  return raw;
}

export function getGoogleSheetsCapabilities(ownerUid?: string): {
  serviceAccountConfigured: boolean;
  serviceAccountSource: 'vault' | 'env' | 'none';
  serviceAccountEmail: string | null;
  serviceAccountProjectId: string | null;
  serviceAccountStatus: 'active' | 'not_configured' | 'invalid_format';
  serviceAccountDiagnostic: string | null;
  defaultSpreadsheetId: string | null;
} {
  const { parsed, source } = resolveConfiguredServiceAccount(ownerUid);
  const defaultId = parseSpreadsheetId(process.env.GOOGLE_SPREADSHEET_ID) || null;
  return {
    serviceAccountConfigured: Boolean(parsed.account),
    serviceAccountSource: source,
    serviceAccountEmail: parsed.account ? parsed.account.clientEmail : null,
    serviceAccountProjectId: parsed.account ? parsed.account.projectId : null,
    serviceAccountStatus: parsed.status,
    serviceAccountDiagnostic: parsed.diagnostic,
    defaultSpreadsheetId: defaultId,
  };
}

export async function resolveGoogleSheetsAccessToken(
  userOAuthToken?: string,
  ownerUid?: string
): Promise<string | null> {
  const cleanedUserToken = (userOAuthToken || '').trim();
  if (cleanedUserToken) {
    return cleanedUserToken;
  }

  const { parsed } = resolveConfiguredServiceAccount(ownerUid);
  if (parsed.status === 'invalid_format') {
    throw new GoogleSheetsApiError(
      parsed.diagnostic || 'Server Google Service Account configuration is invalid.',
      500,
      'GOOGLE_API_ERROR'
    );
  }
  const sa = parsed.account;
  if (!sa) return null;

  return mintServiceAccountAccessToken(sa, ownerUid || 'env', false);
}

export class GoogleSheetsApiError extends Error {
  status: number;
  code: 'GOOGLE_TOKEN_EXPIRED' | 'GOOGLE_PERMISSION_DENIED' | 'GOOGLE_NOT_FOUND' | 'GOOGLE_RATE_LIMIT' | 'GOOGLE_API_ERROR';

  constructor(
    message: string,
    status: number,
    code: GoogleSheetsApiError['code']
  ) {
    super(message);
    this.name = 'GoogleSheetsApiError';
    this.status = status;
    this.code = code;
  }
}

interface SheetPropertiesMeta {
  sheetId: number;
  title: string;
  index?: number;
  gridProperties?: {
    rowCount?: number;
    columnCount?: number;
    frozenRowCount?: number;
  };
}

interface SpreadsheetMetaResponse {
  spreadsheetId: string;
  spreadsheetUrl: string;
  properties?: {
    title?: string;
  };
  sheets?: Array<{
    properties?: SheetPropertiesMeta;
  }>;
}

function columnIndexToA1Letter(index: number): string {
  let num = index + 1;
  let col = '';
  while (num > 0) {
    const rem = (num - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    num = Math.floor((num - 1) / 26);
  }
  return col;
}

function escapeSheetTitleForA1(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function sanitizeCellValue(value: SheetCellValue): SheetCellValue {
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if (
      trimmed.startsWith('=') ||
      trimmed.startsWith('+') ||
      trimmed.startsWith('@') ||
      (trimmed.startsWith('-') && Number.isNaN(Number(trimmed)))
    ) {
      return `'${value}`;
    }
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  return Boolean(value);
}

function sanitizeRow(row: SheetCellValue[], width: number): SheetCellValue[] {
  const out: SheetCellValue[] = [];
  for (let i = 0; i < width; i += 1) {
    const val = i < row.length ? row[i] : '';
    out.push(val === undefined || val === null ? '' : sanitizeCellValue(val));
  }
  return out;
}

async function sheetsFetch<T>(
  url: string,
  accessToken: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (res.ok) {
    return (await res.json()) as T;
  }

  let errorMessage = `Google Sheets API error (${res.status})`;
  try {
    const errBody = (await res.json()) as {
      error?: { message?: string; status?: string };
    };
    if (errBody?.error?.message) {
      errorMessage = errBody.error.message;
    }
  } catch {
    const text = await res.text().catch(() => '');
    if (text) errorMessage = text.slice(0, 300);
  }

  if (res.status === 401) {
    throw new GoogleSheetsApiError(
      'Google Sheets authorization expired. Click "Authorize Google Sheets" in Settings to reconnect.',
      401,
      'GOOGLE_TOKEN_EXPIRED'
    );
  }
  if (res.status === 403) {
    throw new GoogleSheetsApiError(
      errorMessage.includes('insufficient') || errorMessage.includes('scope')
        ? 'Missing Google Sheets permission. Re-authorize Google Sheets access in Settings.'
        : errorMessage,
      403,
      'GOOGLE_PERMISSION_DENIED'
    );
  }
  if (res.status === 404) {
    throw new GoogleSheetsApiError(
      'Connected Google Spreadsheet was not found or was moved to trash.',
      404,
      'GOOGLE_NOT_FOUND'
    );
  }
  if (res.status === 429) {
    throw new GoogleSheetsApiError(
      'Google Sheets API rate limit reached. Pending records will automatically retry shortly.',
      429,
      'GOOGLE_RATE_LIMIT'
    );
  }

  throw new GoogleSheetsApiError(errorMessage, res.status, 'GOOGLE_API_ERROR');
}

function buildNumberFormatRequest(
  sheetId: number,
  colIndex: number,
  formatType: ColumnFormatType
): Record<string, unknown> | null {
  let numberFormat: { type: string; pattern: string } | null = null;
  if (formatType === 'currency') {
    numberFormat = { type: 'CURRENCY', pattern: '"PKR "#,##0.00' };
  } else if (formatType === 'integer') {
    numberFormat = { type: 'NUMBER', pattern: '#,##0' };
  } else if (formatType === 'percent') {
    numberFormat = { type: 'NUMBER', pattern: '0.00"%"' };
  } else {
    return null;
  }

  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 1,
        startColumnIndex: colIndex,
        endColumnIndex: colIndex + 1,
      },
      cell: {
        userEnteredFormat: {
          numberFormat,
          horizontalAlignment: 'RIGHT',
        },
      },
      fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
    },
  };
}

function buildTabFormattingRequests(
  sheetId: number,
  tab: SheetTabDefinition,
  applyFilter = true
): Array<Record<string, unknown>> {
  const requests: Array<Record<string, unknown>> = [];

  // Header row styling (teal background, white bold text)
  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 0,
        endRowIndex: 1,
        startColumnIndex: 0,
        endColumnIndex: tab.headers.length,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.059, green: 0.463, blue: 0.431 }, // #0F766E
          horizontalAlignment: 'LEFT',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'CLIP',
          textFormat: {
            foregroundColor: { red: 1, green: 1, blue: 1 },
            fontSize: 10,
            bold: true,
          },
        },
      },
      fields:
        'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    },
  });

  // Freeze header row
  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId,
        gridProperties: {
          frozenRowCount: 1,
        },
      },
      fields: 'gridProperties.frozenRowCount',
    },
  });

  // Column widths
  tab.columnWidths.forEach((pixelSize, colIdx) => {
    requests.push({
      updateDimensionProperties: {
        range: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: colIdx,
          endIndex: colIdx + 1,
        },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    });
  });

  // Number / Currency / Percent formats on columns
  tab.columnFormats.forEach((fmt, colIdx) => {
    const req = buildNumberFormatRequest(sheetId, colIdx, fmt);
    if (req) requests.push(req);
  });

  if (applyFilter) {
    requests.push({
      setBasicFilter: {
        filter: {
          range: {
            sheetId,
            startRowIndex: 0,
            startColumnIndex: 0,
            endColumnIndex: tab.headers.length,
          },
        },
      },
    });
  }

  return requests;
}

export interface EnsureSpreadsheetResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
  created: boolean;
  addedTabs: string[];
}

export async function ensureBusinessSpreadsheet(
  accessToken: string,
  existingSpreadsheetId?: string,
  requireExisting = false
): Promise<EnsureSpreadsheetResult> {
  const trimmedId =
    parseSpreadsheetId(existingSpreadsheetId) ||
    parseSpreadsheetId(process.env.GOOGLE_SPREADSHEET_ID);

  if (trimmedId) {
    try {
      const meta = await sheetsFetch<SpreadsheetMetaResponse>(
        `${SHEETS_API_BASE}/${encodeURIComponent(
          trimmedId
        )}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets(properties(sheetId,title,index,gridProperties))`,
        accessToken
      );

      const existingMap = new Map<string, SheetPropertiesMeta>();
      for (const s of meta.sheets || []) {
        if (s.properties?.title) {
          existingMap.set(s.properties.title, s.properties);
        }
      }

      const missingTabs = SHEET_TABS.filter((t) => !existingMap.has(t.name));
      const addedTabs: string[] = [];

      if (missingTabs.length > 0) {
        const addRequests = missingTabs.map((t) => ({
          addSheet: {
            properties: {
              title: t.name,
              gridProperties: {
                rowCount: 1000,
                columnCount: Math.max(t.headers.length, 10),
                frozenRowCount: 1,
              },
            },
          },
        }));

        const batchAddRes = await sheetsFetch<{
          replies?: Array<{ addSheet?: { properties?: SheetPropertiesMeta } }>;
        }>(`${SHEETS_API_BASE}/${encodeURIComponent(meta.spreadsheetId)}:batchUpdate`, accessToken, {
          method: 'POST',
          body: JSON.stringify({ requests: addRequests }),
        });

        const formatRequests: Array<Record<string, unknown>> = [];
        const headerUpdates: Array<{ range: string; values: SheetCellValue[][] }> = [];

        (batchAddRes.replies || []).forEach((reply, idx) => {
          const props = reply.addSheet?.properties;
          const tab = missingTabs[idx];
          if (props && tab) {
            addedTabs.push(tab.name);
            headerUpdates.push({
              range: `${escapeSheetTitleForA1(tab.name)}!A1:${columnIndexToA1Letter(
                tab.headers.length - 1
              )}1`,
              values: [[...tab.headers]],
            });
            formatRequests.push(...buildTabFormattingRequests(props.sheetId, tab, true));
          }
        });

        if (headerUpdates.length > 0) {
          await sheetsFetch(
            `${SHEETS_API_BASE}/${encodeURIComponent(meta.spreadsheetId)}/values:batchUpdate`,
            accessToken,
            {
              method: 'POST',
              body: JSON.stringify({
                valueInputOption: 'USER_ENTERED',
                data: headerUpdates,
              }),
            }
          );
        }

        if (formatRequests.length > 0) {
          await sheetsFetch(
            `${SHEETS_API_BASE}/${encodeURIComponent(meta.spreadsheetId)}:batchUpdate`,
            accessToken,
            {
              method: 'POST',
              body: JSON.stringify({ requests: formatRequests }),
            }
          );
        }
      }

      // Expand grid columnCount on pre-existing tabs whenever new schema columns are added
      const resizeRequests: Array<Record<string, unknown>> = [];
      const expandedFormatRequests: Array<Record<string, unknown>> = [];
      for (const tab of SHEET_TABS) {
        const existingProps = existingMap.get(tab.name);
        if (!existingProps) continue;
        const currentColCount = existingProps.gridProperties?.columnCount ?? 0;
        if (currentColCount < tab.headers.length) {
          resizeRequests.push({
            updateSheetProperties: {
              properties: {
                sheetId: existingProps.sheetId,
                gridProperties: {
                  columnCount: Math.max(tab.headers.length, 10),
                },
              },
              fields: 'gridProperties.columnCount',
            },
          });
          expandedFormatRequests.push(
            ...buildTabFormattingRequests(existingProps.sheetId, tab, false)
          );
        }
      }

      if (resizeRequests.length > 0) {
        await sheetsFetch(
          `${SHEETS_API_BASE}/${encodeURIComponent(meta.spreadsheetId)}:batchUpdate`,
          accessToken,
          {
            method: 'POST',
            body: JSON.stringify({
              requests: [...resizeRequests, ...expandedFormatRequests],
            }),
          }
        );
      }

      return {
        spreadsheetId: meta.spreadsheetId,
        spreadsheetUrl:
          meta.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${meta.spreadsheetId}/edit`,
        spreadsheetTitle: meta.properties?.title || CARE_MART_SPREADSHEET_TITLE,
        created: false,
        addedTabs,
      };
    } catch (err) {
      if (requireExisting && err instanceof GoogleSheetsApiError && err.code === 'GOOGLE_NOT_FOUND') {
        throw new GoogleSheetsApiError(
          'Google Spreadsheet not found. Verify the URL/ID and make sure the sheet is shared as Editor with your service account or Google account.',
          404,
          'GOOGLE_NOT_FOUND'
        );
      }
      // If auto-managed spreadsheet ID no longer exists (404), recreate cleanly below
      if (!(err instanceof GoogleSheetsApiError) || err.code !== 'GOOGLE_NOT_FOUND') {
        throw err;
      }
    }
  }

  // Create fresh dedicated spreadsheet with all 14 tabs
  const createBody = {
    properties: {
      title: CARE_MART_SPREADSHEET_TITLE,
      locale: 'en_US',
      timeZone: 'Asia/Karachi',
    },
    sheets: SHEET_TABS.map((tab, index) => ({
      properties: {
        sheetId: index + 1,
        title: tab.name,
        index,
        gridProperties: {
          rowCount: 1000,
          columnCount: Math.max(tab.headers.length, 10),
          frozenRowCount: 1,
        },
      },
    })),
  };

  const created = await sheetsFetch<SpreadsheetMetaResponse>(SHEETS_API_BASE, accessToken, {
    method: 'POST',
    body: JSON.stringify(createBody),
  });

  const headerUpdates = SHEET_TABS.map((tab) => ({
    range: `${escapeSheetTitleForA1(tab.name)}!A1:${columnIndexToA1Letter(tab.headers.length - 1)}1`,
    values: [[...tab.headers]],
  }));

  await sheetsFetch(
    `${SHEETS_API_BASE}/${encodeURIComponent(created.spreadsheetId)}/values:batchUpdate`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: headerUpdates,
      }),
    }
  );

  const formatRequests: Array<Record<string, unknown>> = [];
  for (const s of created.sheets || []) {
    const title = s.properties?.title as SheetTabName | undefined;
    const sheetId = s.properties?.sheetId;
    if (title && sheetId !== undefined && SHEET_TAB_MAP[title]) {
      formatRequests.push(...buildTabFormattingRequests(sheetId, SHEET_TAB_MAP[title], true));
    }
  }

  if (formatRequests.length > 0) {
    await sheetsFetch(
      `${SHEETS_API_BASE}/${encodeURIComponent(created.spreadsheetId)}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ requests: formatRequests }),
      }
    );
  }

  return {
    spreadsheetId: created.spreadsheetId,
    spreadsheetUrl:
      created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`,
    spreadsheetTitle: created.properties?.title || CARE_MART_SPREADSHEET_TITLE,
    created: true,
    addedTabs: SHEET_TABS.map((t) => t.name),
  };
}

export interface SyncSpreadsheetResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  syncedTabs: SheetTabName[];
  updatedRowCount: number;
  appendedRowCount: number;
}

const spreadsheetLocks = new Map<string, Promise<unknown>>();

async function withSpreadsheetLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = spreadsheetLocks.get(key) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(fn);
  spreadsheetLocks.set(key, next);
  try {
    return await next;
  } finally {
    if (spreadsheetLocks.get(key) === next) {
      spreadsheetLocks.delete(key);
    }
  }
}

export async function syncSpreadsheetTabs(
  accessToken: string,
  requestedSpreadsheetId: string | undefined,
  payload: SheetSyncPayload
): Promise<SyncSpreadsheetResult> {
  const ensured = await ensureBusinessSpreadsheet(accessToken, requestedSpreadsheetId);
  const spreadsheetId = ensured.spreadsheetId;

  return withSpreadsheetLock(spreadsheetId, async () => {
    const targetTabs = (Object.keys(payload) as SheetTabName[]).filter(
      (tabName) => Boolean(SHEET_TAB_MAP[tabName]) && Array.isArray(payload[tabName])
    );

    if (targetTabs.length === 0) {
      return {
        spreadsheetId,
        spreadsheetUrl: ensured.spreadsheetUrl,
        syncedTabs: [],
        updatedRowCount: 0,
        appendedRowCount: 0,
      };
    }

    // Ensure headers row 1 exist and inspect current ID column / row counts in one batchGet
    const upsertTabs = targetTabs.filter((t) => SHEET_TAB_MAP[t].syncMode === 'upsert_by_id');
    const summaryTabs = targetTabs.filter((t) => SHEET_TAB_MAP[t].syncMode === 'replace_sorted_summary');

    const rangesToRead: string[] = [];
    for (const tabName of upsertTabs) {
      const tab = SHEET_TAB_MAP[tabName];
      if (tab.deletedStatusColumnIndex !== undefined) {
        const endCol = columnIndexToA1Letter(tab.headers.length - 1);
        rangesToRead.push(`${escapeSheetTitleForA1(tabName)}!A1:${endCol}`);
      } else {
        rangesToRead.push(`${escapeSheetTitleForA1(tabName)}!A1:A`);
      }
    }
    for (const tabName of summaryTabs) {
      rangesToRead.push(`${escapeSheetTitleForA1(tabName)}!A1:A`);
    }

    const batchGetQuery = rangesToRead
      .map((r) => `ranges=${encodeURIComponent(r)}`)
      .join('&');

    const batchGetRes = await sheetsFetch<{
      valueRanges?: Array<{ range?: string; values?: SheetCellValue[][] }>;
    }>(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${batchGetQuery}`,
      accessToken
    );

    const valueRanges = batchGetRes.valueRanges || [];
    let rangeCursor = 0;

    const batchDataUpdates: Array<{ range: string; values: SheetCellValue[][] }> = [];
    const rangesToClear: string[] = [];

    let updatedRowCount = 0;
    let appendedRowCount = 0;

    // 1. Handle upsert_by_id tabs (never duplicate existing document IDs)
    for (const tabName of upsertTabs) {
      const tab = SHEET_TAB_MAP[tabName];
      const existingGrid = valueRanges[rangeCursor]?.values || [];
      rangeCursor += 1;

      const endColLetter = columnIndexToA1Letter(tab.headers.length - 1);

      // Ensure header row is always up-to-date
      const firstRow = existingGrid[0] || [];
      const headerMatches =
        firstRow.length >= tab.headers.length &&
        tab.headers.every((h, idx) => String(firstRow[idx] ?? '').trim() === h);

      if (!headerMatches) {
        batchDataUpdates.push({
          range: `${escapeSheetTitleForA1(tabName)}!A1:${endColLetter}1`,
          values: [[...tab.headers]],
        });
      }

      // Build existing ID -> 1-based sheet row number map
      const existingIdToRowNum = new Map<string, number>();
      for (let r = 1; r < existingGrid.length; r += 1) {
        const idVal = String(existingGrid[r]?.[tab.idColumnIndex] ?? '').trim();
        if (idVal && !existingIdToRowNum.has(idVal)) {
          existingIdToRowNum.set(idVal, r + 1); // 1-based Sheets row index
        }
      }

      const incomingRows = payload[tabName] || [];
      const seenIncomingIds = new Set<string>();
      const rowsToAppend: SheetCellValue[][] = [];

      for (const rawRow of incomingRows) {
        const cleanRow = sanitizeRow(rawRow, tab.headers.length);
        const recordId = String(cleanRow[tab.idColumnIndex] ?? '').trim();
        if (!recordId) continue;
        if (seenIncomingIds.has(recordId)) continue;

        seenIncomingIds.add(recordId);
        const existingRowNum = existingIdToRowNum.get(recordId);

        if (existingRowNum) {
          batchDataUpdates.push({
            range: `${escapeSheetTitleForA1(tabName)}!A${existingRowNum}:${endColLetter}${existingRowNum}`,
            values: [cleanRow],
          });
          updatedRowCount += 1;
        } else {
          rowsToAppend.push(cleanRow);
          appendedRowCount += 1;
        }
      }

    // Preserve deleted entries in Categories & Brands by marking Status = 'Deleted'
    if (tab.deletedStatusColumnIndex !== undefined) {
      const statusColLetter = columnIndexToA1Letter(tab.deletedStatusColumnIndex);
      for (const [existingId, rowNum] of existingIdToRowNum.entries()) {
        if (!seenIncomingIds.has(existingId)) {
          const currentStatus = String(
            existingGrid[rowNum - 1]?.[tab.deletedStatusColumnIndex] ?? ''
          ).trim();
          if (currentStatus !== 'Deleted') {
            batchDataUpdates.push({
              range: `${escapeSheetTitleForA1(tabName)}!${statusColLetter}${rowNum}`,
              values: [['Deleted']],
            });
            updatedRowCount += 1;
          }
        }
      }
    }

    if (rowsToAppend.length > 0) {
      const nextStartRow = Math.max(2, existingGrid.length + 1);
      const nextEndRow = nextStartRow + rowsToAppend.length - 1;
      batchDataUpdates.push({
        range: `${escapeSheetTitleForA1(tabName)}!A${nextStartRow}:${endColLetter}${nextEndRow}`,
        values: rowsToAppend,
      });
    }
  }

  // 2. Handle replace_sorted_summary tabs (Daily Summary, Monthly Summary, Staff Performance)
  for (const tabName of summaryTabs) {
    const tab = SHEET_TAB_MAP[tabName];
    const existingGrid = valueRanges[rangeCursor]?.values || [];
    rangeCursor += 1;

    const endColLetter = columnIndexToA1Letter(tab.headers.length - 1);
    const incomingRows = (payload[tabName] || []).map((r) => sanitizeRow(r, tab.headers.length));

    batchDataUpdates.push({
      range: `${escapeSheetTitleForA1(tabName)}!A1:${endColLetter}1`,
      values: [[...tab.headers]],
    });

    if (incomingRows.length > 0) {
      batchDataUpdates.push({
        range: `${escapeSheetTitleForA1(tabName)}!A2:${endColLetter}${incomingRows.length + 1}`,
        values: incomingRows,
      });
      updatedRowCount += incomingRows.length;
    }

    // Clear any stale excess rows below the updated summary rows
    const previousDataRows = Math.max(0, existingGrid.length - 1);
    if (previousDataRows > incomingRows.length) {
      const clearStart = incomingRows.length + 2;
      const clearEnd = existingGrid.length + 1;
      rangesToClear.push(`${escapeSheetTitleForA1(tabName)}!A${clearStart}:${endColLetter}${clearEnd}`);
    }
  }

  if (rangesToClear.length > 0) {
    await sheetsFetch(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchClear`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ ranges: rangesToClear }),
      }
    );
  }

  // Send batch updates in chunks of 400 ranges to remain well under request size limits
  const CHUNK_SIZE = 400;
  for (let i = 0; i < batchDataUpdates.length; i += CHUNK_SIZE) {
    const chunk = batchDataUpdates.slice(i, i + CHUNK_SIZE);
    await sheetsFetch(
      `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: chunk,
        }),
      }
    );
  }

    return {
      spreadsheetId,
      spreadsheetUrl: ensured.spreadsheetUrl,
      syncedTabs: targetTabs,
      updatedRowCount,
      appendedRowCount,
    };
  });
}
