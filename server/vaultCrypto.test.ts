// @vitest-environment node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backupAndUpgradeVaultFileToV2,
  encryptVaultPayload,
  readAndDecryptVaultFile,
  validateRequiredSecrets,
  writeVaultFileAtomic,
} from './vaultCrypto';

const TEST_OWNER_SECRET =
  'owner-gate-secret-0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET =
  'session-hmac-secret-0123456789abcdef0123456789abcdef0123456789abcd';
const TEST_ENC_KEY_A =
  'vault-master-key-A-0123456789abcdef0123456789abcdef0123456789abcd';
const TEST_ENC_KEY_B =
  'vault-master-key-B-fedcba9876543210fedcba9876543210fedcba9876543210';

const SA_INFO = 'caremart:service-account-vault:v2';
const SA_V1_PREFIX = 'caremart-service-account-vault:v1';
const DISCORD_INFO = 'caremart:discord-webhook-vault:v2';
const DISCORD_V1_PREFIX = 'caremart-discord-webhook-vault:v1';

function createLegacyV1Envelope(plaintext: string, seed: string, prefix: string): string {
  const key = crypto.createHash('sha256').update(`${prefix}:${seed}`, 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('vaultCrypto & §4.3 encryption enforcement', () => {
  let tempDir = '';
  let originalCwd = '';
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caremart-vault-test-'));
    savedEnv = {
      OWNER_GATE_SECRET: process.env.OWNER_GATE_SECRET,
      SESSION_SECRET: process.env.SESSION_SECRET,
      SERVICE_ACCOUNT_ENCRYPTION_KEY: process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY,
      LEGACY_ENCRYPTION_KEYS: process.env.LEGACY_ENCRYPTION_KEYS,
    };
    process.env.OWNER_GATE_SECRET = TEST_OWNER_SECRET;
    process.env.SESSION_SECRET = TEST_SESSION_SECRET;
    process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY = TEST_ENC_KEY_A;
    delete process.env.LEGACY_ENCRYPTION_KEYS;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    vi.resetModules();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates explicit required secrets and rejects missing, short, or legacy hardcoded values', () => {
    expect(() => validateRequiredSecrets()).not.toThrow();

    delete process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY;
    expect(() => validateRequiredSecrets()).toThrow(/SERVICE_ACCOUNT_ENCRYPTION_KEY/);

    process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY = 'too-short';
    expect(() => validateRequiredSecrets()).toThrow(/at least 32 characters/);

    process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY = ['cm_gate', '7d3e9a2c4f1b8e6092c4a1d7f5b8e301'].join('_');
    expect(() => validateRequiredSecrets()).toThrow(/legacy hardcoded fallback secret is forbidden/);
  });

  it('encrypts v2 vaults with HKDF-SHA256 domain separation across service account and discord domains', () => {
    const filePath = path.join(tempDir, 'sa_test.enc.json');
    const payload = JSON.stringify({ clientEmail: 'bot@example.iam.gserviceaccount.com', privateKey: 'PEM' });
    writeVaultFileAtomic(filePath, payload, SA_INFO);

    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { v: number; kdf: string; salt: string };
    expect(stored.v).toBe(2);
    expect(stored.kdf).toBe('hkdf-sha256');
    expect(Buffer.from(stored.salt, 'base64').length).toBeGreaterThanOrEqual(16);

    // Same domain decrypts cleanly
    const okRes = readAndDecryptVaultFile(filePath, SA_INFO, SA_V1_PREFIX);
    expect(okRes).toEqual({
      ok: true,
      plaintext: payload,
      formatVersion: 2,
      usedLegacyKey: false,
    });

    // Cross-domain decryption using Discord domain info must fail cleanly without touching the file
    const rawBefore = fs.readFileSync(filePath, 'utf8');
    const crossDomain = readAndDecryptVaultFile(filePath, DISCORD_INFO, DISCORD_V1_PREFIX);
    expect(crossDomain.ok).toBe(false);
    if (!crossDomain.ok) {
      expect(crossDomain.reason).toBe('decrypt_failed');
    }
    expect(fs.readFileSync(filePath, 'utf8')).toBe(rawBefore);
  });

  it('decrypts v1 envelopes and safely creates a .v1.bak backup before atomic v2 upgrade', () => {
    const filePath = path.join(tempDir, 'discord_shop1.enc.json');
    const payload = JSON.stringify({ webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345' });
    const legacyRaw = createLegacyV1Envelope(payload, TEST_ENC_KEY_A, DISCORD_V1_PREFIX);
    fs.writeFileSync(filePath, legacyRaw, 'utf8');

    const firstRead = readAndDecryptVaultFile(filePath, DISCORD_INFO, DISCORD_V1_PREFIX);
    expect(firstRead).toEqual({
      ok: true,
      plaintext: payload,
      formatVersion: 1,
      usedLegacyKey: false,
    });

    const upgraded = backupAndUpgradeVaultFileToV2(filePath, payload, DISCORD_INFO);
    expect(upgraded).toBe(true);

    const files = fs.readdirSync(tempDir);
    const backupName = files.find((f) => f.startsWith('discord_shop1.enc.json.v1.bak.'));
    expect(backupName).toBeDefined();
    expect(fs.readFileSync(path.join(tempDir, backupName!), 'utf8')).toBe(legacyRaw);

    const secondRead = readAndDecryptVaultFile(filePath, DISCORD_INFO, DISCORD_V1_PREFIX);
    expect(secondRead).toEqual({
      ok: true,
      plaintext: payload,
      formatVersion: 2,
      usedLegacyKey: false,
    });
  });

  it('never overwrites, deletes, or truncates vault ciphertext when decryption fails under a wrong key or corruption', () => {
    const filePath = path.join(tempDir, 'protected.enc.json');
    const payload = JSON.stringify({ webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345' });
    writeVaultFileAtomic(filePath, payload, DISCORD_INFO);
    const originalBytes = fs.readFileSync(filePath, 'utf8');

    // Wrong key
    process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY = TEST_ENC_KEY_B;
    const wrongKeyRes = readAndDecryptVaultFile(filePath, DISCORD_INFO, DISCORD_V1_PREFIX);
    expect(wrongKeyRes.ok).toBe(false);
    if (!wrongKeyRes.ok) {
      expect(wrongKeyRes.reason).toBe('decrypt_failed');
      expect(wrongKeyRes.diagnostic).toContain('preserved untouched');
    }
    expect(fs.readFileSync(filePath, 'utf8')).toBe(originalBytes);

    // Restoring old key via LEGACY_ENCRYPTION_KEYS recovers the file cleanly
    process.env.LEGACY_ENCRYPTION_KEYS = TEST_ENC_KEY_A;
    const recoveredRes = readAndDecryptVaultFile(filePath, DISCORD_INFO, DISCORD_V1_PREFIX);
    expect(recoveredRes).toEqual({
      ok: true,
      plaintext: payload,
      formatVersion: 2,
      usedLegacyKey: true,
    });

    // Corrupted ciphertext must also leave file untouched on disk
    delete process.env.LEGACY_ENCRYPTION_KEYS;
    process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY = TEST_ENC_KEY_A;
    const tampered = JSON.parse(originalBytes) as Record<string, string>;
    tampered.data = Buffer.from('corrupted-cipher-bytes').toString('base64');
    const tamperedStr = JSON.stringify(tampered);
    fs.writeFileSync(filePath, tamperedStr, 'utf8');

    const corruptRes = readAndDecryptVaultFile(filePath, DISCORD_INFO, DISCORD_V1_PREFIX);
    expect(corruptRes.ok).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(tamperedStr);
  });

  it('upgrades v1 Google Service Account & Discord vaults end-to-end inside googleSheetsService and discordNotifier without losing data', async () => {
    process.chdir(tempDir);
    vi.resetModules();

    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const shopId = 'owner_vault_e2e_shop';
    const uidHash = crypto.createHash('sha256').update(shopId).digest('hex').slice(0, 24);
    const secretsDir = path.join(tempDir, '.caremart-secrets');
    fs.mkdirSync(secretsDir, { recursive: true });

    const saPath = path.join(secretsDir, `sa_${uidHash}.enc.json`);
    const saPlain = JSON.stringify({
      clientEmail: 'sync-worker@caremart-test.iam.gserviceaccount.com',
      privateKey,
      tokenUri: 'https://oauth2.googleapis.com/token',
      projectId: 'caremart-test',
    });
    fs.writeFileSync(saPath, createLegacyV1Envelope(saPlain, TEST_ENC_KEY_A, SA_V1_PREFIX), 'utf8');

    const discordPath = path.join(secretsDir, `discord_${uidHash}.enc.json`);
    const webhookUrl =
      'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz012345';
    fs.writeFileSync(
      discordPath,
      createLegacyV1Envelope(JSON.stringify({ webhookUrl }), TEST_ENC_KEY_A, DISCORD_V1_PREFIX),
      'utf8'
    );

    const { getGoogleSheetsCapabilities, saveServiceAccountForOwner } = await import('./googleSheetsService');
    const { getDiscordCapabilities } = await import('./discordNotifier');

    // Reading existing v1 vaults decrypts cleanly and upgrades both files to v2 with .v1.bak backups
    const sheetsCaps = getGoogleSheetsCapabilities(shopId);
    expect(sheetsCaps.serviceAccountConfigured).toBe(true);
    expect(sheetsCaps.serviceAccountSource).toBe('vault');
    expect(sheetsCaps.serviceAccountEmail).toBe('sync-worker@caremart-test.iam.gserviceaccount.com');

    const discordCaps = getDiscordCapabilities(shopId);
    expect(discordCaps.configured).toBe(true);
    expect(discordCaps.source).toBe('vault');
    expect(discordCaps.status).toBe('active');

    const upgradedSa = JSON.parse(fs.readFileSync(saPath, 'utf8')) as { v: number; kdf: string };
    const upgradedDiscord = JSON.parse(fs.readFileSync(discordPath, 'utf8')) as { v: number; kdf: string };
    expect(upgradedSa.v).toBe(2);
    expect(upgradedSa.kdf).toBe('hkdf-sha256');
    expect(upgradedDiscord.v).toBe(2);
    expect(upgradedDiscord.kdf).toBe('hkdf-sha256');

    const dirEntries = fs.readdirSync(secretsDir);
    expect(dirEntries.some((f) => f.startsWith(`sa_${uidHash}.enc.json.v1.bak.`))).toBe(true);
    expect(dirEntries.some((f) => f.startsWith(`discord_${uidHash}.enc.json.v1.bak.`))).toBe(true);

    // Under a mismatched key, existing v2 vault files remain intact and capabilities report invalid_format cleanly
    process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY = TEST_ENC_KEY_B;
    const saBytesBeforeFail = fs.readFileSync(saPath, 'utf8');
    const failedCaps = getGoogleSheetsCapabilities(shopId);
    expect(failedCaps.serviceAccountConfigured).toBe(false);
    expect(failedCaps.serviceAccountStatus).toBe('invalid_format');
    expect(failedCaps.serviceAccountDiagnostic).toContain('preserved untouched');
    expect(fs.readFileSync(saPath, 'utf8')).toBe(saBytesBeforeFail);

    // If owner explicitly saves a new Service Account while old file is unreadable, preserve .unreadable.bak backup
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'mock-access-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const savedRes = await saveServiceAccountForOwner(
      shopId,
      JSON.stringify({
        type: 'service_account',
        project_id: 'caremart-test',
        client_email: 'new-worker@caremart-test.iam.gserviceaccount.com',
        private_key: privateKey,
        token_uri: 'https://oauth2.googleapis.com/token',
      })
    );
    expect(savedRes.serviceAccountEmail).toBe('new-worker@caremart-test.iam.gserviceaccount.com');
    const afterEntries = fs.readdirSync(secretsDir);
    expect(afterEntries.some((f) => f.startsWith(`sa_${uidHash}.enc.json.unreadable.bak.`))).toBe(
      true
    );

    // Check encryptVaultPayload helper produces distinct ciphertexts for identical plaintexts
    const e1 = encryptVaultPayload('same', SA_INFO);
    const e2 = encryptVaultPayload('same', SA_INFO);
    expect(e1.salt).not.toBe(e2.salt);
    expect(e1.iv).not.toBe(e2.iv);
  });
});
