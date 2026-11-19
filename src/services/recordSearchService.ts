import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { getHighlightSegments, normalizeSearchTokens } from './productSearchService';

export { getHighlightSegments, normalizeSearchTokens };

export interface SearchableSelectOption {
  value: string;
  label: string;
  subtitle?: string;
  meta?: string;
  badge?: string;
  badgeTone?: 'success' | 'warning' | 'danger' | 'neutral';
  keywords?: string[];
  disabled?: boolean;
  disabledReason?: string;
}

export interface ScoredSelectOption {
  option: SearchableSelectOption;
  score: number;
}

/**
 * Ranks and filters SearchableSelectOption items using tokenized, partial-word,
 * case-insensitive matching across label, subtitle, meta, and hidden keywords.
 */
export function filterAndRankSelectOptions(
  options: SearchableSelectOption[],
  rawQuery: string
): SearchableSelectOption[] {
  const tokens = normalizeSearchTokens(rawQuery);
  if (tokens.length === 0) {
    return options;
  }

  const normalizedQuery = tokens.join(' ');
  const scored: ScoredSelectOption[] = [];

  for (const opt of options) {
    const labelLower = opt.label.toLowerCase();
    const subtitleLower = (opt.subtitle || '').toLowerCase();
    const metaLower = (opt.meta || '').toLowerCase();
    const keywordsLower = (opt.keywords || []).join(' ').toLowerCase();
    const combined = `${labelLower} ${subtitleLower} ${metaLower} ${keywordsLower}`;

    let allMatched = true;
    let score = 0;

    for (const token of tokens) {
      if (!combined.includes(token)) {
        allMatched = false;
        break;
      }

      if (labelLower === token) {
        score += 90;
      } else if (labelLower.startsWith(token)) {
        score += 60;
      } else if (labelLower.split(/[\s\-_/]+/).some((w) => w.startsWith(token))) {
        score += 45;
      } else if (labelLower.includes(token)) {
        score += 30;
      } else if (subtitleLower.startsWith(token)) {
        score += 22;
      } else if (subtitleLower.includes(token)) {
        score += 15;
      } else if (keywordsLower.includes(token)) {
        score += 14;
      } else {
        score += 8;
      }
    }

    if (!allMatched) continue;

    if (labelLower === normalizedQuery) score += 120;
    else if (labelLower.startsWith(normalizedQuery)) score += 70;
    else if (labelLower.includes(normalizedQuery)) score += 35;

    if (!opt.disabled) score += 3;

    scored.push({ option: opt, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.option.label.localeCompare(b.option.label);
  });

  return scored.map((s) => s.option);
}

/**
 * Direct Firestore query helper for refreshing large owner-scoped collections
 * (products, suppliers, categories, brands, expenseCategories, staff) using a
 * single-field equality constraint + limit without composite index requirements.
 */
export async function queryOwnerCollectionSlice<T extends Record<string, unknown>>(
  shopId: string,
  collectionName:
    | 'products'
    | 'suppliers'
    | 'categories'
    | 'brands'
    | 'expenseCategories'
    | 'staff',
  maxDocs = 1000
): Promise<Array<T & { id: string }>> {
  const safeLimit = Math.min(Math.max(maxDocs, 1), 2000);
  const q = query(
    collection(db, 'shops', shopId, collectionName),
    where('ownerUid', '==', shopId),
    limit(safeLimit)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
}

const SELECT_ACTIVITY_STORAGE_KEY = 'cm_select_activity_v1';
const MAX_STORED_ITEMS_PER_SCOPE = 80;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

interface SelectUsageRecord {
  count: number;
  lastUsedAt: number;
}

type SelectUsageStore = Record<string, Record<string, SelectUsageRecord>>;

function readSelectUsageStore(): SelectUsageStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SELECT_ACTIVITY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as SelectUsageStore;
  } catch {
    return {};
  }
}

function writeSelectUsageStore(store: SelectUsageStore): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SELECT_ACTIVITY_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

function scoreUsageRecord(rec: SelectUsageRecord, now: number): number {
  const ageMs = Math.max(0, now - (rec.lastUsedAt || 0));
  const recencyRatio = Math.max(0, 1 - ageMs / FOURTEEN_DAYS_MS);
  return rec.count * 12 + recencyRatio * 24;
}

/**
 * Infers a clean semantic scope key from ariaLabel or placeholder so related
 * SearchableSelect pickers share recent & frequent user selections automatically.
 */
export function inferSelectScope(ariaLabel?: string, placeholder?: string): string {
  const raw = `${ariaLabel || ''} ${placeholder || ''}`.toLowerCase();
  if (raw.includes('expense') && raw.includes('categor')) return 'expense-category';
  if (raw.includes('categor')) return 'category';
  if (raw.includes('brand')) return 'brand';
  if (raw.includes('supplier')) return 'supplier';
  if (raw.includes('product')) return 'product';
  if (raw.includes('staff') || raw.includes('employee')) return 'staff';
  if (raw.includes('payment')) return 'payment-method';
  if (raw.includes('adjustment')) return 'adjustment-type';
  if (raw.includes('unit')) return 'unit';
  if (raw.includes('report')) return 'report-type';

  const slug = (ariaLabel || placeholder || 'general')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'general';
}

/**
 * Records a user selection in localStorage to power frequent/recent suggestions.
 */
export function recordSelectActivity(scope: string, value: string): void {
  if (!scope || !value) return;
  const store = readSelectUsageStore();
  const now = Date.now();
  const bucket = { ...(store[scope] || {}) };
  const existing = bucket[value];

  bucket[value] = {
    count: (existing?.count || 0) + 1,
    lastUsedAt: now,
  };

  // Prune older/rare entries so storage stays small
  const entries = Object.entries(bucket);
  if (entries.length > MAX_STORED_ITEMS_PER_SCOPE) {
    entries.sort((a, b) => scoreUsageRecord(b[1], now) - scoreUsageRecord(a[1], now));
    store[scope] = Object.fromEntries(entries.slice(0, MAX_STORED_ITEMS_PER_SCOPE));
  } else {
    store[scope] = bucket;
  }

  writeSelectUsageStore(store);
}

/**
 * Computes the top frequent/recent IDs from any list of domain records
 * (e.g., purchase items, stock adjustments, expenses, sales).
 * Assumes records are ordered newest-first or have arbitrary order; recency weight
 * favors earlier elements when counts are tied.
 */
export function computeTopActivityValues<T>(
  records: T[],
  getValue: (item: T) => string | undefined | null,
  maxItems = 5
): string[] {
  const scores = new Map<string, number>();
  const len = records.length;
  for (let i = 0; i < len; i += 1) {
    const val = getValue(records[i]);
    if (!val) continue;
    // Earlier items (typically newest in descending streams) get a gentle recency boost
    const recencyWeight = 1 + Math.max(0, (len - i) / Math.max(len, 1)) * 0.5;
    scores.set(val, (scores.get(val) || 0) + recencyWeight);
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxItems)
    .map(([val]) => val);
}

/**
 * Splits available options into prioritized `frequentOptions` (based on recorded user
 * selections + optional real domain activity `suggestedValues`) and `remainingOptions`.
 */
export function partitionFrequentSelectOptions(
  options: SearchableSelectOption[],
  scope: string,
  suggestedValues?: string[],
  maxItems = 5
): {
  frequentOptions: SearchableSelectOption[];
  remainingOptions: SearchableSelectOption[];
} {
  if (maxItems <= 0 || options.length === 0) {
    return { frequentOptions: [], remainingOptions: options };
  }

  const store = readSelectUsageStore();
  const bucket = store[scope] || {};
  const now = Date.now();

  const suggestedScores = new Map<string, number>();
  if (suggestedValues && suggestedValues.length > 0) {
    suggestedValues.forEach((val, idx) => {
      if (!val || suggestedScores.has(val)) return;
      // Rank earlier suggested items slightly higher while letting repeated manual selections win naturally
      const rankScore = Math.max(4, 18 - idx * 3);
      suggestedScores.set(val, rankScore);
    });
  }

  const candidates: Array<{ option: SearchableSelectOption; score: number }> = [];

  for (const opt of options) {
    if (!opt.value || opt.disabled) continue;
    const usage = bucket[opt.value];
    const usageScore = usage ? scoreUsageRecord(usage, now) : 0;
    const activityScore = suggestedScores.get(opt.value) || 0;
    const totalScore = usageScore + activityScore;
    if (totalScore > 0) {
      candidates.push({ option: opt, score: totalScore });
    }
  }

  if (candidates.length === 0) {
    return { frequentOptions: [], remainingOptions: options };
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.option.label.localeCompare(b.option.label);
  });

  const frequentOptions = candidates.slice(0, maxItems).map((c) => c.option);
  const frequentSet = new Set(frequentOptions.map((o) => o.value));
  const remainingOptions = options.filter((o) => !frequentSet.has(o.value));

  return { frequentOptions, remainingOptions };
}

