import type {
  DiscordExpenseNotificationPayload,
  DiscordNotificationItem,
  DiscordPurchaseNotificationPayload,
  DiscordSaleNotificationPayload,
  DiscordTransactionNotificationPayload,
} from '../shared/discordSchema.ts';

const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 5000;
const notifiedKeys = new Map<string, number>();

export interface DiscordNotifyResult {
  sent: boolean;
  deduplicated?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
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

export function getConfiguredDiscordWebhookUrl(): string {
  let raw = (process.env.DISCORD_WEBHOOK_URL || '').trim();
  if (/^discord_webhook_url\s*=/i.test(raw)) {
    raw = raw.replace(/^discord_webhook_url\s*=/i, '').trim();
  }
  raw = raw.replace(/^['"]+|['"]+$/g, '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const isDiscordHost =
      host === 'discord.com' ||
      host === 'discordapp.com' ||
      host.endsWith('.discord.com') ||
      host.endsWith('.discordapp.com');

    if (
      parsed.protocol === 'https:' &&
      isDiscordHost &&
      parsed.pathname.startsWith('/api/webhooks/')
    ) {
      return parsed.toString();
    }
  } catch {
    return '';
  }

  return '';
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

    const name = cleanText(item?.productName || 'Product', 90);
    const unitSuffix = item?.unit ? ` ${cleanText(item.unit, 20)}` : '';
    formattedLines.push(
      `${idx + 1}. **${name}** — ${formatQty(qty)}${unitSuffix} × ${formatPKR(unitPrice)} = **${formatPKR(lineTotal)}**`
    );
  }

  const MAX_DESC_CHARS = 3600;
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
    body = `${body}\n*...and ${remaining} more product${remaining === 1 ? '' : 's'}*`;
  }

  const summaryFooter = `\n\n**Items:** ${safeItems.length} · **Total Qty:** ${formatQty(totalQuantity)}`;
  const description = safeItems.length
    ? `${header}${body}${summaryFooter}`
    : 'No product lines included.';

  return { description, computedTotal, totalQuantity };
}

function buildSaleEmbed(payload: DiscordSaleNotificationPayload) {
  const { description, computedTotal } = formatProductLines(payload.items);
  const totalSale =
    typeof payload.totalAmount === 'number' && Number.isFinite(payload.totalAmount)
      ? roundMoney(payload.totalAmount)
      : computedTotal;

  const dateTimeText =
    cleanText(payload.saleDateTime, 40) || formatDateDDMMYYYY(payload.saleDate);
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
    title: `New Sale • ${saleId}`,
    description,
    color: 0x10b981,
    fields,
    footer: { text: 'CareMart Shop Manager • Sale Recorded' },
    timestamp: new Date().toISOString(),
  };
}

function buildPurchaseEmbed(payload: DiscordPurchaseNotificationPayload) {
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
    { name: 'Date', value: formatDateDDMMYYYY(payload.purchaseDate), inline: true },
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
    title: `New Purchase • ${purchaseId}`,
    description,
    color: 0x3b82f6,
    fields,
    footer: { text: 'CareMart Shop Manager • Purchase Recorded' },
    timestamp: new Date().toISOString(),
  };
}

function buildExpenseEmbed(payload: DiscordExpenseNotificationPayload) {
  const expenseId = cleanText(payload.expenseId, 80) || 'Expense';
  const title = cleanText(payload.title, 150) || 'Business Expense';
  const categoryName = cleanText(payload.categoryName, 100) || 'Uncategorized';
  const amount = Math.max(0, roundMoney(Number(payload.amount) || 0));
  const notes = cleanText(payload.notes, 400) || '—';

  return {
    title: `New Expense • ${title}`,
    color: 0xf59e0b,
    fields: [
      { name: 'Expense ID', value: `\`${expenseId}\``, inline: true },
      { name: 'Date', value: formatDateDDMMYYYY(payload.expenseDate), inline: true },
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

export async function sendDiscordTransactionNotification(
  shopId: string,
  payload: DiscordTransactionNotificationPayload
): Promise<DiscordNotifyResult> {
  const webhookUrl = getConfiguredDiscordWebhookUrl();
  if (!webhookUrl) {
    return {
      sent: false,
      skipped: true,
      reason: 'DISCORD_WEBHOOK_URL is not configured.',
    };
  }

  const dedupeRaw = cleanText(payload.dedupeId, 160);
  if (!dedupeRaw) {
    return { sent: false, skipped: true, reason: 'Missing transaction identifier.' };
  }

  const now = Date.now();
  pruneDedupeCache(now);
  const dedupeKey = `${shopId}:${payload.type}:${dedupeRaw}`;
  if (notifiedKeys.has(dedupeKey)) {
    return { sent: false, deduplicated: true };
  }

  // Reserve key before network dispatch so concurrent retries cannot double-post
  notifiedKeys.set(dedupeKey, now + DEDUPE_TTL_MS);

  let embed: Record<string, unknown>;
  if (payload.type === 'sale') {
    embed = buildSaleEmbed(payload);
  } else if (payload.type === 'purchase') {
    embed = buildPurchaseEmbed(payload);
  } else {
    embed = buildExpenseEmbed(payload);
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'CareMart Shop Manager',
        embeds: [embed],
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(
        `Discord webhook failed (${res.status}) for ${payload.type} ${dedupeRaw}: ${errText.slice(0, 200)}`
      );
      return {
        sent: false,
        error: `Discord webhook returned HTTP ${res.status}`,
      };
    }

    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discord webhook request failed.';
    console.warn(`Discord webhook error for ${payload.type} ${dedupeRaw}: ${message}`);
    return { sent: false, error: message };
  }
}
