import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DiscordExpenseNotificationPayload,
  DiscordNotificationItem,
  DiscordPurchaseNotificationPayload,
  DiscordSaleNotificationPayload,
  DiscordTransactionNotificationPayload,
} from '../shared/discordSchema.ts';

const VAULT_DIR = path.resolve(process.cwd(), '.caremart-secrets');
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 5000;
const DISCORD_REQUEST_TIMEOUT_MS = 8500;
const notifiedKeys = new Map<string, number>();
const inFlightKeys = new Set<string>();

export type DiscordConfigStatus = 'active' | 'not_configured' | 'invalid_format';
export type DiscordConfigSource = 'vault' | 'env' | 'none';

export interface DiscordCapabilities {
  configured: boolean;
  status: DiscordConfigStatus;
  source: DiscordConfigSource;
  diagnostic: string | null;
}

export interface DiscordNotifyResult {
  sent: boolean;
  deduplicated?: boolean;
  skipped?: boolean;
  retryable?: boolean;
  code?:
    | 'DISCORD_WEBHOOK_NOT_CONFIGURED'
    | 'DISCORD_WEBHOOK_INVALID'
    | 'DISCORD_RATE_LIMITED'
    | 'DISCORD_WEBHOOK_REJECTED'
    | 'DISCORD_NETWORK_ERROR'
    | 'INVALID_PAYLOAD';
  statusCode?: number;
  messageId?: string;
  retryAfterMs?: number;
  reason?: string;
  error?: string;
}

interface WebhookParseResult {
  url: string | null;
  status: DiscordConfigStatus;
  diagnostic: string | null;
}

function getVaultEncryptionKey(): Buffer {
  const secretSeed =
    (process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY || '').trim() ||
    (process.env.OWNER_GATE_SECRET || '').trim() ||
    'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301';
  return crypto
    .createHash('sha256')
    .update(`caremart-discord-webhook-vault:v1:${secretSeed}`)
    .digest();
}

function getDiscordVaultFilePath(shopId: string): string {
  const uidHash = crypto.createHash('sha256').update(shopId).digest('hex').slice(0, 24);
  return path.join(VAULT_DIR, `discord_${uidHash}.enc.json`);
}

function pruneDedupeCache(now: number) {
  for (const [key, expiresAt] of notifiedKeys.entries()) {
    if (expiresAt <= now) {
      notifiedKeys.delete(key);
    }
  }
  while (notifiedKeys.size >= DEDUPE_MAX_ENTRIES) {
    const oldestKey = notifiedKeys.keys().next().value;
    if (!oldestKey) break;
    notifiedKeys.delete(oldestKey);
  }
}

export function parseDiscordWebhookUrl(
  rawInput: string,
  sourceLabel = 'DISCORD_WEBHOOK_URL'
): WebhookParseResult {
  let raw = (rawInput || '').trim();
  if (/^discord_webhook_url\s*=/i.test(raw)) {
    raw = raw.replace(/^discord_webhook_url\s*=/i, '').trim();
  }
  raw = raw.replace(/^['"]+|['"]+$/g, '').trim();
  if (!raw) {
    return { url: null, status: 'not_configured', diagnostic: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      url: null,
      status: 'invalid_format',
      diagnostic: `${sourceLabel} is not a valid URL. Expected https://discord.com/api/webhooks/<id>/<token>.`,
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      url: null,
      status: 'invalid_format',
      diagnostic: `${sourceLabel} must use https://.`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  const isAllowedHost =
    host === 'discord.com' ||
    host === 'discordapp.com' ||
    host === 'ptb.discord.com' ||
    host === 'canary.discord.com';

  if (!isAllowedHost) {
    return {
      url: null,
      status: 'invalid_format',
      diagnostic: `${sourceLabel} must point to discord.com or discordapp.com.`,
    };
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  const match = /^\/api(?:\/v\d+)?\/webhooks\/(\d{15,25})\/([A-Za-z0-9._-]{20,})$/.exec(
    normalizedPath
  );
  if (!match) {
    return {
      url: null,
      status: 'invalid_format',
      diagnostic: `${sourceLabel} does not match Discord's webhook format (/api/webhooks/<webhook_id>/<token>).`,
    };
  }

  // Canonicalize without leaking extra path fragments; preserve thread_id if present
  const canonical = new URL(`https://${host}/api/webhooks/${match[1]}/${match[2]}`);
  const threadId = parsed.searchParams.get('thread_id');
  if (threadId && /^\d{15,25}$/.test(threadId.trim())) {
    canonical.searchParams.set('thread_id', threadId.trim());
  }

  return {
    url: canonical.toString(),
    status: 'active',
    diagnostic: null,
  };
}

function readWebhookFromVault(shopId?: string): WebhookParseResult {
  if (!shopId) {
    return { url: null, status: 'not_configured', diagnostic: null };
  }
  const filePath = getDiscordVaultFilePath(shopId);
  if (!fs.existsSync(filePath)) {
    return { url: null, status: 'not_configured', diagnostic: null };
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
        url: null,
        status: 'invalid_format',
        diagnostic: 'Saved Discord webhook vault file is incomplete. Please re-save it in Settings.',
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

    const payload = JSON.parse(decrypted) as { webhookUrl?: unknown };
    const urlStr = typeof payload?.webhookUrl === 'string' ? payload.webhookUrl : '';
    return parseDiscordWebhookUrl(urlStr, 'Saved Discord Webhook');
  } catch {
    return {
      url: null,
      status: 'invalid_format',
      diagnostic: 'Saved Discord webhook could not be decrypted. Please re-save it in Settings.',
    };
  }
}

function resolveDiscordWebhook(shopId?: string): {
  parsed: WebhookParseResult;
  source: DiscordConfigSource;
} {
  const vault = readWebhookFromVault(shopId);
  if (vault.url || vault.status === 'invalid_format') {
    return { parsed: vault, source: 'vault' };
  }

  const envParsed = parseDiscordWebhookUrl(
    process.env.DISCORD_WEBHOOK_URL || '',
    'DISCORD_WEBHOOK_URL'
  );
  if (envParsed.url || envParsed.status === 'invalid_format') {
    return { parsed: envParsed, source: 'env' };
  }

  return {
    parsed: {
      url: null,
      status: 'not_configured',
      diagnostic: 'DISCORD_WEBHOOK_URL is not configured on the server.',
    },
    source: 'none',
  };
}

export function getConfiguredDiscordWebhookUrl(shopId?: string): string {
  return resolveDiscordWebhook(shopId).parsed.url || '';
}

export function getDiscordCapabilities(shopId?: string): DiscordCapabilities {
  const { parsed, source } = resolveDiscordWebhook(shopId);
  return {
    configured: Boolean(parsed.url),
    status: parsed.status,
    source,
    diagnostic: parsed.diagnostic,
  };
}

let cachedLiveProbe: { checkedAt: number; source: string; ok: boolean; statusCode: number | null; error: string | null } | null = null;

export async function verifyDiscordWebhookLive(shopId?: string): Promise<
  DiscordCapabilities & {
    liveChecked: boolean;
    liveOk: boolean | null;
    liveStatusCode: number | null;
  }
> {
  const base = getDiscordCapabilities(shopId);
  const { parsed, source } = resolveDiscordWebhook(shopId);
  if (!parsed.url) {
    return {
      ...base,
      liveChecked: false,
      liveOk: false,
      liveStatusCode: null,
    };
  }

  const now = Date.now();
  const cacheKey = `${shopId || 'env'}:${source}`;
  if (cachedLiveProbe && cachedLiveProbe.source === cacheKey && now - cachedLiveProbe.checkedAt < 15_000) {
    return {
      ...base,
      diagnostic: cachedLiveProbe.ok ? base.diagnostic : cachedLiveProbe.error,
      liveChecked: true,
      liveOk: cachedLiveProbe.ok,
      liveStatusCode: cachedLiveProbe.statusCode,
    };
  }

  try {
    const res = await fetch(parsed.url, {
      method: 'GET',
      signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      cachedLiveProbe = { checkedAt: now, source: cacheKey, ok: true, statusCode: res.status, error: null };
      return {
        ...base,
        liveChecked: true,
        liveOk: true,
        liveStatusCode: res.status,
      };
    }
    const text = await res.text().catch(() => '');
    const { detail } = extractDiscordErrorDetail(text);
    const errMsg = `Discord rejected the configured webhook (HTTP ${res.status}${detail ? `: ${detail}` : ''}). Please generate a fresh webhook URL in Discord Server Settings -> Integrations -> Webhooks.`;
    cachedLiveProbe = { checkedAt: now, source: cacheKey, ok: false, statusCode: res.status, error: errMsg };
    return {
      ...base,
      status: 'invalid_format',
      diagnostic: errMsg,
      liveChecked: true,
      liveOk: false,
      liveStatusCode: res.status,
    };
  } catch (err) {
    const msg = err instanceof Error ? `Unable to reach Discord API: ${err.message}` : 'Unable to reach Discord API.';
    cachedLiveProbe = { checkedAt: now, source: cacheKey, ok: false, statusCode: null, error: msg };
    return {
      ...base,
      diagnostic: msg,
      liveChecked: true,
      liveOk: false,
      liveStatusCode: null,
    };
  }
}

function withWaitTrue(webhookUrl: string): string {
  const url = new URL(webhookUrl);
  url.searchParams.set('wait', 'true');
  return url.toString();
}

function parseRetryAfterMs(res: Response, bodyJson?: Record<string, unknown> | null): number | undefined {
  if (bodyJson && typeof bodyJson.retry_after === 'number' && Number.isFinite(bodyJson.retry_after)) {
    // Discord JSON retry_after is in seconds (float)
    return Math.min(120_000, Math.max(1000, Math.ceil(bodyJson.retry_after * 1000)));
  }

  const header = (res.headers.get('retry-after') || '').trim();
  if (!header) return undefined;

  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return Math.min(120_000, Math.max(1000, Math.ceil(asSeconds * 1000)));
  }

  const asDateMs = Date.parse(header);
  if (Number.isFinite(asDateMs)) {
    const delta = asDateMs - Date.now();
    if (delta > 0) {
      return Math.min(120_000, Math.max(1000, delta));
    }
  }

  return undefined;
}

function extractDiscordErrorDetail(rawText: string): {
  json: Record<string, unknown> | null;
  detail: string;
} {
  if (!rawText) return { json: null, detail: '' };
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const msg = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    const code =
      typeof parsed.code === 'number' || typeof parsed.code === 'string' ? String(parsed.code) : '';
    const detail = msg ? (code ? `${msg} (Discord code ${code})` : msg) : rawText.slice(0, 180);
    return { json: parsed, detail };
  } catch {
    return { json: null, detail: rawText.slice(0, 180) };
  }
}

export async function saveDiscordWebhookForOwner(
  shopId: string,
  rawWebhookUrl: string
): Promise<DiscordCapabilities> {
  if (!shopId) {
    throw new Error('Shop ID is required.');
  }

  const parsed = parseDiscordWebhookUrl(rawWebhookUrl, 'Discord Webhook URL');
  if (!parsed.url) {
    throw new Error(parsed.diagnostic || 'Invalid Discord webhook URL.');
  }

  // Verify live against Discord GET webhook endpoint before storing
  let verifyRes: Response;
  try {
    verifyRes = await fetch(parsed.url, {
      method: 'GET',
      signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? `Could not reach Discord to verify webhook: ${err.message}`
        : 'Could not reach Discord to verify webhook.'
    );
  }

  if (!verifyRes.ok) {
    const text = await verifyRes.text().catch(() => '');
    const { detail } = extractDiscordErrorDetail(text);
    throw new Error(
      `Discord rejected this webhook (HTTP ${verifyRes.status})${detail ? `: ${detail}` : '.'}`
    );
  }

  fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  const key = getVaultEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify({ webhookUrl: parsed.url });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const filePath = getDiscordVaultFilePath(shopId);
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

  return getDiscordCapabilities(shopId);
}

export function removeDiscordWebhookForOwner(shopId: string): DiscordCapabilities {
  if (!shopId) return getDiscordCapabilities();
  const filePath = getDiscordVaultFilePath(shopId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  return getDiscordCapabilities(shopId);
}

function roundMoney(val: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function formatPKR(amount: number): string {
  const safe = roundMoney(amount);
  const hasDecimals = Math.round(safe * 100) % 100 !== 0;
  const formatted = new Intl.NumberFormat('en-PK', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: hasDecimals ? 2 : 0,
  }).format(safe);
  return `PKR ${formatted}`;
}

function formatQty(val: number): string {
  const safe = Number.isFinite(val) ? val : 0;
  return new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 }).format(safe);
}

function formatDateDDMMYYYY(isoDate: string): string {
  const trimmed = (isoDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed || '—';
  }
  const [y, m, d] = trimmed.split('-');
  return `${d}-${m}-${y}`;
}

function cleanText(val: string | undefined | null, maxLen = 200): string {
  const str = String(val || '')
    .replace(/\r/g, '')
    .trim();
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return `${str.slice(0, Math.max(1, maxLen - 3))}...`;
}

function formatProductLines(items: DiscordNotificationItem[]): {
  description: string;
  computedTotal: number;
  totalQuantity: number;
} {
  const safeItems = Array.isArray(items) ? items : [];
  let computedTotal = 0;
  let totalQuantity = 0;
  const formattedLines: string[] = [];

  for (let idx = 0; idx < safeItems.length; idx += 1) {
    const item = safeItems[idx];
    const qty = Math.max(0, Number(item?.quantity) || 0);
    const unitPrice = Math.max(0, roundMoney(Number(item?.unitPrice) || 0));
    const lineTotal =
      typeof item?.lineTotal === 'number' && Number.isFinite(item.lineTotal)
        ? roundMoney(item.lineTotal)
        : roundMoney(qty * unitPrice);

    computedTotal = roundMoney(computedTotal + lineTotal);
    totalQuantity += qty;

    const name = cleanText(item?.productName || 'Product', 90) || 'Product';
    const unitSuffix = item?.unit ? ` ${cleanText(item.unit, 20)}` : '';
    formattedLines.push(
      `${idx + 1}. **${name}** — ${formatQty(qty)}${unitSuffix} × ${formatPKR(unitPrice)} = **${formatPKR(lineTotal)}**`
    );
  }

  const MAX_DESC_CHARS = 3500;
  const header = '**Products:**\n';
  let body = '';
  let includedCount = 0;

  for (const line of formattedLines) {
    const candidate = body ? `${body}\n${line}` : line;
    if (header.length + candidate.length > MAX_DESC_CHARS) {
      break;
    }
    body = candidate;
    includedCount += 1;
  }

  if (includedCount < formattedLines.length) {
    const remaining = formattedLines.length - includedCount;
    body = `${body ? `${body}\n` : ''}*...and ${remaining} more product${remaining === 1 ? '' : 's'}*`;
  }

  const summaryFooter = `\n\n**Items:** ${safeItems.length} · **Total Qty:** ${formatQty(totalQuantity)}`;
  const description = safeItems.length
    ? `${header}${body}${summaryFooter}`
    : 'No product lines included.';

  return { description, computedTotal, totalQuantity };
}

export function buildSaleEmbed(payload: DiscordSaleNotificationPayload) {
  const { description, computedTotal } = formatProductLines(payload.items);
  const totalSale =
    typeof payload.totalAmount === 'number' && Number.isFinite(payload.totalAmount)
      ? roundMoney(payload.totalAmount)
      : computedTotal;

  const dateTimeText =
    cleanText(payload.saleDateTime, 40) || formatDateDDMMYYYY(payload.saleDate) || '—';
  const staffName = cleanText(payload.staffName, 120) || 'Owner';
  const saleId = cleanText(payload.saleId, 80) || 'Sale';
  const notes = cleanText(payload.notes, 300);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Sale ID', value: `\`${saleId}\``, inline: true },
    { name: 'Date & Time', value: dateTimeText, inline: true },
    { name: 'Staff Name', value: staffName, inline: true },
    { name: 'Payment Method', value: payload.paymentMethod === 'Online' ? 'Online' : 'Cash', inline: true },
    { name: 'Total Sale', value: `**${formatPKR(totalSale)}**`, inline: true },
  ];

  if (typeof payload.totalProfit === 'number' && Number.isFinite(payload.totalProfit)) {
    fields.push({
      name: 'Total Profit',
      value: `**${formatPKR(payload.totalProfit)}**`,
      inline: true,
    });
  }

  if (notes) {
    fields.push({ name: 'Notes', value: notes, inline: false });
  }

  return {
    title: cleanText(`New Sale • ${saleId}`, 250),
    description,
    color: 0x10b981,
    fields,
    footer: { text: 'CareMart Shop Manager • Sale Recorded' },
    timestamp: new Date().toISOString(),
  };
}

export function buildPurchaseEmbed(payload: DiscordPurchaseNotificationPayload) {
  const { description, computedTotal } = formatProductLines(payload.items);
  const totalPurchase =
    typeof payload.totalAmount === 'number' && Number.isFinite(payload.totalAmount)
      ? roundMoney(payload.totalAmount)
      : computedTotal;
  const amountPaid = Math.max(0, roundMoney(Number(payload.amountPaid) || 0));
  const remainingBalance =
    typeof payload.balanceDue === 'number' && Number.isFinite(payload.balanceDue)
      ? Math.max(0, roundMoney(payload.balanceDue))
      : Math.max(0, roundMoney(totalPurchase - amountPaid));

  const purchaseId = cleanText(payload.purchaseId, 80) || 'Purchase';
  const supplierName = cleanText(payload.supplierName, 150) || 'Supplier';
  const notes = cleanText(payload.notes, 300);

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Purchase ID', value: `\`${purchaseId}\``, inline: true },
    { name: 'Date', value: formatDateDDMMYYYY(payload.purchaseDate) || '—', inline: true },
    { name: 'Supplier', value: supplierName, inline: true },
    { name: 'Total Purchase Amount', value: `**${formatPKR(totalPurchase)}**`, inline: true },
    { name: 'Amount Paid', value: formatPKR(amountPaid), inline: true },
    { name: 'Remaining Balance', value: `**${formatPKR(remainingBalance)}**`, inline: true },
    { name: 'Payment Method', value: payload.paymentMethod === 'Online' ? 'Online' : 'Cash', inline: true },
  ];

  if (notes) {
    fields.push({ name: 'Notes', value: notes, inline: false });
  }

  return {
    title: cleanText(`New Purchase • ${purchaseId}`, 250),
    description,
    color: 0x3b82f6,
    fields,
    footer: { text: 'CareMart Shop Manager • Purchase Recorded' },
    timestamp: new Date().toISOString(),
  };
}

export function buildExpenseEmbed(payload: DiscordExpenseNotificationPayload) {
  const expenseId = cleanText(payload.expenseId, 80) || 'Expense';
  const title = cleanText(payload.title, 150) || 'Business Expense';
  const categoryName = cleanText(payload.categoryName, 100) || 'Uncategorized';
  const amount = Math.max(0, roundMoney(Number(payload.amount) || 0));
  const notes = cleanText(payload.notes, 400) || '—';

  return {
    title: cleanText(`New Expense • ${title}`, 250),
    color: 0xf59e0b,
    fields: [
      { name: 'Expense ID', value: `\`${expenseId}\``, inline: true },
      { name: 'Date', value: formatDateDDMMYYYY(payload.expenseDate) || '—', inline: true },
      { name: 'Category', value: categoryName, inline: true },
      { name: 'Expense Title', value: title, inline: true },
      { name: 'Amount', value: `**${formatPKR(amount)}**`, inline: true },
      { name: 'Payment Method', value: payload.paymentMethod === 'Online' ? 'Online' : 'Cash', inline: true },
      { name: 'Notes', value: notes, inline: false },
    ],
    footer: { text: 'CareMart Shop Manager • Expense Recorded' },
    timestamp: new Date().toISOString(),
  };
}

async function postEmbedToDiscordWebhook(
  webhookUrl: string,
  embed: Record<string, unknown>,
  logContext: string
): Promise<DiscordNotifyResult> {
  try {
    const res = await fetch(withWaitTrue(webhookUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'CareMart Shop Manager',
        embeds: [embed],
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(DISCORD_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const { json, detail } = extractDiscordErrorDetail(errText);
      const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res, json) : undefined;
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      console.warn(
        `Discord webhook failed (${res.status}) for ${logContext}: ${detail.slice(0, 180)}`
      );
      return {
        sent: false,
        code: res.status === 429 ? 'DISCORD_RATE_LIMITED' : 'DISCORD_WEBHOOK_REJECTED',
        statusCode: res.status,
        retryable,
        retryAfterMs,
        error: `Discord webhook returned HTTP ${res.status}${detail ? ` (${detail})` : ''}.`,
      };
    }

    let messageId: string | undefined;
    if (res.status !== 204) {
      const okJson = (await res.json().catch(() => null)) as { id?: unknown } | null;
      if (okJson && typeof okJson.id === 'string' && okJson.id) {
        messageId = okJson.id;
      }
    }

    return {
      sent: true,
      statusCode: res.status,
      messageId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discord webhook request failed.';
    console.warn(`Discord webhook network error for ${logContext}: ${message}`);
    return {
      sent: false,
      code: 'DISCORD_NETWORK_ERROR',
      retryable: true,
      error: message,
    };
  }
}

export async function sendDiscordTestNotification(
  shopId: string,
  actorLabel = 'Owner'
): Promise<DiscordNotifyResult> {
  const { parsed, source } = resolveDiscordWebhook(shopId);
  if (!parsed.url) {
    return {
      sent: false,
      skipped: true,
      retryable: false,
      code:
        parsed.status === 'invalid_format'
          ? 'DISCORD_WEBHOOK_INVALID'
          : 'DISCORD_WEBHOOK_NOT_CONFIGURED',
      reason:
        parsed.diagnostic ||
        'DISCORD_WEBHOOK_URL is not configured on the server.',
      error:
        parsed.diagnostic ||
        'DISCORD_WEBHOOK_URL is not configured on the server.',
    };
  }

  const embed = {
    title: 'CareMart Discord Test Alert',
    description:
      'Discord webhook delivery is verified and active for automatic Sales, Purchases, and Expenses notifications.',
    color: 0x10b981,
    fields: [
      { name: 'Status', value: 'Connected', inline: true },
      {
        name: 'Source',
        value: source === 'vault' ? 'Encrypted Server Vault' : 'Server Environment Secret',
        inline: true,
      },
      { name: 'Triggered By', value: cleanText(actorLabel, 80) || 'Admin', inline: true },
      { name: 'Currency Format', value: formatPKR(1250), inline: true },
    ],
    footer: { text: 'CareMart Shop Manager • Diagnostic Check' },
    timestamp: new Date().toISOString(),
  };

  return postEmbedToDiscordWebhook(parsed.url, embed, `test:${shopId}`);
}

export async function sendDiscordTransactionNotification(
  shopId: string,
  payload: DiscordTransactionNotificationPayload
): Promise<DiscordNotifyResult> {
  const { parsed } = resolveDiscordWebhook(shopId);
  if (!parsed.url) {
    const isInvalid = parsed.status === 'invalid_format';
    return {
      sent: false,
      skipped: true,
      retryable: false,
      code: isInvalid ? 'DISCORD_WEBHOOK_INVALID' : 'DISCORD_WEBHOOK_NOT_CONFIGURED',
      reason:
        parsed.diagnostic ||
        'DISCORD_WEBHOOK_URL is not configured on the server.',
      error:
        parsed.diagnostic ||
        'DISCORD_WEBHOOK_URL is not configured on the server.',
    };
  }

  const dedupeRaw = cleanText(payload.dedupeId, 160);
  if (!dedupeRaw) {
    return {
      sent: false,
      skipped: false,
      retryable: false,
      code: 'INVALID_PAYLOAD',
      reason: 'Missing transaction identifier.',
      error: 'Missing transaction identifier.',
    };
  }

  const now = Date.now();
  pruneDedupeCache(now);
  const dedupeKey = `${shopId}:${payload.type}:${dedupeRaw}`;
  if (notifiedKeys.has(dedupeKey)) {
    return { sent: false, deduplicated: true, retryable: false };
  }

  // Prevent concurrent in-flight webhook requests from double-posting, without poisoning cache on failure
  if (inFlightKeys.has(dedupeKey)) {
    return { sent: false, deduplicated: true, retryable: false };
  }
  inFlightKeys.add(dedupeKey);

  let embed: Record<string, unknown>;
  if (payload.type === 'sale') {
    embed = buildSaleEmbed(payload);
  } else if (payload.type === 'purchase') {
    embed = buildPurchaseEmbed(payload);
  } else {
    embed = buildExpenseEmbed(payload);
  }

  try {
    const result = await postEmbedToDiscordWebhook(parsed.url, embed, `${payload.type}:${dedupeRaw}`);
    if (result.sent) {
      notifiedKeys.set(dedupeKey, Date.now() + DEDUPE_TTL_MS);
    }
    return result;
  } finally {
    inFlightKeys.delete(dedupeKey);
  }
}
