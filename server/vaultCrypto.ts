import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type RequiredServerSecretName =
  | 'OWNER_GATE_SECRET'
  | 'SESSION_SECRET'
  | 'SERVICE_ACCOUNT_ENCRYPTION_KEY';

export const REQUIRED_SERVER_SECRETS: readonly RequiredServerSecretName[] = [
  'OWNER_GATE_SECRET',
  'SESSION_SECRET',
  'SERVICE_ACCOUNT_ENCRYPTION_KEY',
];

export const MIN_SERVER_SECRET_LENGTH = 32;

// SHA-256 digest of the removed legacy fallback literal so we reject it without keeping the literal in code
const BANNED_LEGACY_DEFAULT_SHA256 =
  'f72ffbe951639377a021dd610b522ef69fe4852cec5d03deae238224f9fe0378';

export interface VaultEnvelopeV2 {
  v: 2;
  kdf: 'hkdf-sha256';
  salt: string;
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
}

export type VaultDecryptResult =
  | {
      ok: true;
      plaintext: string;
      formatVersion: 1 | 2;
      usedLegacyKey: boolean;
    }
  | {
      ok: false;
      reason: 'not_found' | 'malformed' | 'decrypt_failed';
      diagnostic: string;
    };

function isBannedLegacyDefault(value: string): boolean {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex') === BANNED_LEGACY_DEFAULT_SHA256;
}

export function getRequiredSecret(name: RequiredServerSecretName): string {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable "${name}". Configure ${name} (at least ${MIN_SERVER_SECRET_LENGTH} random characters) in the AI Studio Secrets panel.`
    );
  }
  if (value.length < MIN_SERVER_SECRET_LENGTH) {
    throw new Error(
      `Invalid environment variable "${name}": must be at least ${MIN_SERVER_SECRET_LENGTH} characters.`
    );
  }
  if (isBannedLegacyDefault(value)) {
    throw new Error(
      `Invalid environment variable "${name}": legacy hardcoded fallback secret is forbidden.`
    );
  }
  return value;
}

export function validateRequiredSecrets(): void {
  const errors: string[] = [];
  for (const name of REQUIRED_SERVER_SECRETS) {
    try {
      getRequiredSecret(name);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `Invalid ${name}.`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Server startup aborted due to secret configuration error(s):\n- ${errors.join('\n- ')}`);
  }
}

export function getLegacyEncryptionKeys(): string[] {
  const raw = (process.env.LEGACY_ENCRYPTION_KEYS || '').trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed || isBannedLegacyDefault(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function deriveVaultKeyV2(masterSecret: string, salt: Buffer, domainInfo: string): Buffer {
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(masterSecret, 'utf8'),
    salt,
    Buffer.from(domainInfo, 'utf8'),
    32
  );
  return Buffer.from(derived);
}

function deriveVaultKeyV1(secretSeed: string, legacyV1Prefix: string): Buffer {
  return crypto.createHash('sha256').update(`${legacyV1Prefix}:${secretSeed}`, 'utf8').digest();
}

export function encryptVaultPayload(plaintext: string, domainInfo: string): VaultEnvelopeV2 {
  const masterSecret = getRequiredSecret('SERVICE_ACCOUNT_ENCRYPTION_KEY');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveVaultKeyV2(masterSecret, salt, domainInfo);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(domainInfo, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    v: 2,
    kdf: 'hkdf-sha256',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    data: encrypted.toString('base64'),
    updatedAt: new Date().toISOString(),
  };
}

function tryDecryptV2(
  envelope: { salt?: unknown; iv?: unknown; tag?: unknown; data?: unknown },
  masterSecret: string,
  domainInfo: string
): string | null {
  if (
    typeof envelope.salt !== 'string' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' ||
    typeof envelope.data !== 'string'
  ) {
    return null;
  }

  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  if (salt.length < 16 || iv.length !== 12 || tag.length !== 16 || data.length === 0) {
    return null;
  }

  try {
    const key = deriveVaultKeyV2(masterSecret, salt, domainInfo);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(domainInfo, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function tryDecryptV1(
  envelope: { iv?: unknown; tag?: unknown; data?: unknown },
  secretSeed: string,
  legacyV1Prefix: string
): string | null {
  if (
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' ||
    typeof envelope.data !== 'string'
  ) {
    return null;
  }

  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  if (iv.length !== 12 || tag.length !== 16 || data.length === 0) {
    return null;
  }

  try {
    const key = deriveVaultKeyV1(secretSeed, legacyV1Prefix);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function readAndDecryptVaultFile(
  filePath: string,
  domainInfo: string,
  legacyV1Prefix: string
): VaultDecryptResult {
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      reason: 'not_found',
      diagnostic: 'Vault file does not exist.',
    };
  }

  let rawText = '';
  let envelope: {
    v?: unknown;
    kdf?: unknown;
    salt?: unknown;
    iv?: unknown;
    tag?: unknown;
    data?: unknown;
  };
  try {
    rawText = fs.readFileSync(filePath, 'utf8');
    envelope = JSON.parse(rawText) as typeof envelope;
  } catch {
    return {
      ok: false,
      reason: 'malformed',
      diagnostic:
        'Saved server vault file is not valid JSON. Original file was preserved untouched on disk.',
    };
  }

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return {
      ok: false,
      reason: 'malformed',
      diagnostic:
        'Saved server vault file is malformed. Original file was preserved untouched on disk.',
    };
  }

  let primarySecret = '';
  try {
    primarySecret = getRequiredSecret('SERVICE_ACCOUNT_ENCRYPTION_KEY');
  } catch (err) {
    return {
      ok: false,
      reason: 'decrypt_failed',
      diagnostic:
        err instanceof Error
          ? `${err.message} Original encrypted file was preserved untouched.`
          : 'SERVICE_ACCOUNT_ENCRYPTION_KEY is missing or invalid.',
    };
  }

  const legacyKeys = getLegacyEncryptionKeys();

  if (envelope.v === 2) {
    if (
      typeof envelope.salt !== 'string' ||
      typeof envelope.iv !== 'string' ||
      typeof envelope.tag !== 'string' ||
      typeof envelope.data !== 'string'
    ) {
      return {
        ok: false,
        reason: 'malformed',
        diagnostic:
          'Saved server v2 vault file is incomplete. Original file was preserved untouched on disk.',
      };
    }

    const primaryPlaintext = tryDecryptV2(envelope, primarySecret, domainInfo);
    if (primaryPlaintext !== null) {
      return { ok: true, plaintext: primaryPlaintext, formatVersion: 2, usedLegacyKey: false };
    }

    for (const legacyKey of legacyKeys) {
      const legacyPlaintext = tryDecryptV2(envelope, legacyKey, domainInfo);
      if (legacyPlaintext !== null) {
        return { ok: true, plaintext: legacyPlaintext, formatVersion: 2, usedLegacyKey: true };
      }
    }

    return {
      ok: false,
      reason: 'decrypt_failed',
      diagnostic:
        'Saved server credentials could not be decrypted with the active SERVICE_ACCOUNT_ENCRYPTION_KEY. Original encrypted file was preserved untouched; restore the prior key in LEGACY_ENCRYPTION_KEYS or re-save credentials in Settings.',
    };
  }

  if (envelope.v === undefined || envelope.v === 1) {
    if (
      typeof envelope.iv !== 'string' ||
      typeof envelope.tag !== 'string' ||
      typeof envelope.data !== 'string'
    ) {
      return {
        ok: false,
        reason: 'malformed',
        diagnostic:
          'Saved server vault file is incomplete. Original file was preserved untouched on disk.',
      };
    }

    const v1Primary = tryDecryptV1(envelope, primarySecret, legacyV1Prefix);
    if (v1Primary !== null) {
      return { ok: true, plaintext: v1Primary, formatVersion: 1, usedLegacyKey: false };
    }

    for (const legacyKey of legacyKeys) {
      const v1Legacy = tryDecryptV1(envelope, legacyKey, legacyV1Prefix);
      if (v1Legacy !== null) {
        return { ok: true, plaintext: v1Legacy, formatVersion: 1, usedLegacyKey: true };
      }
    }

    return {
      ok: false,
      reason: 'decrypt_failed',
      diagnostic:
        'Saved v1 server credentials could not be decrypted with the active SERVICE_ACCOUNT_ENCRYPTION_KEY. Original encrypted file was preserved untouched; configure the prior key in LEGACY_ENCRYPTION_KEYS or re-save credentials in Settings.',
    };
  }

  return {
    ok: false,
    reason: 'malformed',
    diagnostic: `Unsupported server vault format version (${String(envelope.v)}). Original file was preserved untouched.`,
  };
}

function writeUniqueBackupCopy(filePath: string, suffixPrefix: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const rawBytes = fs.readFileSync(filePath);
  const ts = Date.now();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = attempt === 0 ? `${ts}` : `${ts}.${crypto.randomBytes(3).toString('hex')}`;
    const backupPath = `${filePath}.${suffixPrefix}.${suffix}`;
    try {
      fs.writeFileSync(backupPath, rawBytes, { flag: 'wx', mode: 0o600 });
      try {
        fs.chmodSync(backupPath, 0o600);
      } catch {
        // Ignore chmod error on platforms without POSIX permissions
      }
      return backupPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'EEXIST') continue;
      return null;
    }
  }
  return null;
}

export function writeVaultFileAtomic(
  filePath: string,
  plaintext: string,
  domainInfo: string,
  options?: { preserveUnreadableBackup?: boolean }
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const envelope = encryptVaultPayload(plaintext, domainInfo);

  if (options?.preserveUnreadableBackup && fs.existsSync(filePath)) {
    writeUniqueBackupCopy(filePath, 'unreadable.bak');
  }

  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Ignore chmod error on platforms without POSIX mode support
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export function backupAndUpgradeVaultFileToV2(
  filePath: string,
  plaintext: string,
  domainInfo: string
): boolean {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const hasExistingBackup = fs
      .readdirSync(dir)
      .some((entry) => entry.startsWith(`${base}.v1.bak.`));
    if (!hasExistingBackup) {
      const backupPath = writeUniqueBackupCopy(filePath, 'v1.bak');
      if (!backupPath) return false;
    }
    writeVaultFileAtomic(filePath, plaintext, domainInfo);
    return true;
  } catch {
    return false;
  }
}
