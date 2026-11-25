import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_FEEDBACK_PAIR_KEYS,
  MAX_FEEDBACK_PRODUCTS,
  UPSELL_FEEDBACK_VERSION,
  type UpsellFeedbackCounters,
  type UpsellFeedbackEventInput,
  type UpsellFeedbackSnapshot,
} from '../shared/upsellCacheSchema.ts';

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), '.caremart-cache');

const MAX_FEEDBACK_EVENT_IDS = 2000;

interface ServerFeedbackRuntimeState {
  snapshot: UpsellFeedbackSnapshot;
  processedEventIds: string[];
  processedEventSet: Set<string>;
  recovered: boolean;
}

const feedbackMemoryCaches = new Map<string, ServerFeedbackRuntimeState>();

function getFeedbackFilePath(shopId: string, cacheDir = DEFAULT_CACHE_DIR): string {
  const shopHash = crypto.createHash('sha256').update(shopId).digest('hex').slice(0, 24);
  return path.join(cacheDir, `feedback_v${UPSELL_FEEDBACK_VERSION}_${shopHash}.json`);
}

function createEmptyCounters(now = Date.now()): UpsellFeedbackCounters {
  return {
    shown: 0,
    accepted: 0,
    dismissed: 0,
    removedAfterAdd: 0,
    lastUpdatedAt: now,
  };
}

function createEmptySnapshot(shopId: string): UpsellFeedbackSnapshot {
  return {
    version: UPSELL_FEEDBACK_VERSION,
    shopId,
    revision: 0,
    productStats: {},
    categoryPairStats: {},
    updatedAt: Date.now(),
  };
}

function isValidCounters(val: unknown): val is UpsellFeedbackCounters {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const c = val as Partial<UpsellFeedbackCounters>;
  return (
    typeof c.shown === 'number' &&
    Number.isFinite(c.shown) &&
    c.shown >= 0 &&
    typeof c.accepted === 'number' &&
    Number.isFinite(c.accepted) &&
    c.accepted >= 0 &&
    typeof c.dismissed === 'number' &&
    Number.isFinite(c.dismissed) &&
    c.dismissed >= 0 &&
    typeof c.removedAfterAdd === 'number' &&
    Number.isFinite(c.removedAfterAdd) &&
    c.removedAfterAdd >= 0
  );
}

function isValidCountersMap(obj: unknown): obj is Record<string, UpsellFeedbackCounters> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  for (const val of Object.values(obj as Record<string, unknown>)) {
    if (!isValidCounters(val)) return false;
  }
  return true;
}

interface ParsedFeedbackDiskState {
  snapshot: UpsellFeedbackSnapshot;
  processedEventIds: string[];
}

function validateFeedbackSnapshot(
  raw: unknown,
  expectedShopId: string
): ParsedFeedbackDiskState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cand = raw as Partial<UpsellFeedbackSnapshot> & { processedEventIds?: unknown };
  if (cand.version !== UPSELL_FEEDBACK_VERSION) return null;
  if (cand.shopId !== expectedShopId) return null;
  if (typeof cand.revision !== 'number' || !Number.isFinite(cand.revision) || cand.revision < 0) {
    return null;
  }
  if (!isValidCountersMap(cand.productStats)) return null;
  if (!isValidCountersMap(cand.categoryPairStats)) return null;

  const processedEventIds = Array.isArray(cand.processedEventIds)
    ? cand.processedEventIds
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .slice(-MAX_FEEDBACK_EVENT_IDS)
    : [];

  return {
    snapshot: {
      version: UPSELL_FEEDBACK_VERSION,
      shopId: expectedShopId,
      revision: Math.floor(cand.revision),
      productStats: Object.fromEntries(
        Object.entries(cand.productStats).map(([k, v]) => [k, { ...v }])
      ),
      categoryPairStats: Object.fromEntries(
        Object.entries(cand.categoryPairStats).map(([k, v]) => [k, { ...v }])
      ),
      updatedAt: Number(cand.updatedAt) || Date.now(),
    },
    processedEventIds,
  };
}

function writeFeedbackAtomic(
  shopId: string,
  state: Pick<ServerFeedbackRuntimeState, 'snapshot' | 'processedEventIds'>,
  cacheDir = DEFAULT_CACHE_DIR
): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const targetPath = getFeedbackFilePath(shopId, cacheDir);
    const tmpPath = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    const payload = {
      ...state.snapshot,
      processedEventIds: state.processedEventIds.slice(-MAX_FEEDBACK_EVENT_IDS),
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch {
    // Feedback persistence must never disrupt POS routes
  }
}

function loadOrCreateState(
  shopId: string,
  cacheDir = DEFAULT_CACHE_DIR
): ServerFeedbackRuntimeState {
  const memKey = `${cacheDir}::${shopId}`;
  const existing = feedbackMemoryCaches.get(memKey);
  if (existing) return existing;

  let parsed: ParsedFeedbackDiskState | null = null;
  let recovered = false;
  const targetPath = getFeedbackFilePath(shopId, cacheDir);

  try {
    if (fs.existsSync(targetPath)) {
      const raw = fs.readFileSync(targetPath, 'utf8');
      parsed = validateFeedbackSnapshot(JSON.parse(raw), shopId);
      if (!parsed) recovered = true;
    }
  } catch {
    recovered = true;
    parsed = null;
  }

  const snapshot = parsed ? parsed.snapshot : createEmptySnapshot(shopId);
  const processedEventIds = parsed ? parsed.processedEventIds : [];
  const state: ServerFeedbackRuntimeState = {
    snapshot,
    processedEventIds,
    processedEventSet: new Set(processedEventIds),
    recovered,
  };

  if (recovered) {
    writeFeedbackAtomic(shopId, state, cacheDir);
  }

  feedbackMemoryCaches.set(memKey, state);
  return state;
}

function pruneCountersMap(map: Record<string, UpsellFeedbackCounters>, maxKeys: number): void {
  const keys = Object.keys(map);
  if (keys.length <= maxKeys) return;
  const keep = new Set(
    keys
      .sort((a, b) => (map[b]?.lastUpdatedAt || 0) - (map[a]?.lastUpdatedAt || 0))
      .slice(0, maxKeys)
  );
  for (const key of keys) {
    if (!keep.has(key)) {
      delete map[key];
    }
  }
}

function incrementCounter(
  entry: UpsellFeedbackCounters,
  eventType: UpsellFeedbackEventInput['eventType'],
  now: number
): void {
  if (eventType === 'shown') entry.shown += 1;
  else if (eventType === 'accepted') entry.accepted += 1;
  else if (eventType === 'dismissed') entry.dismissed += 1;
  else if (eventType === 'removed_after_add') entry.removedAfterAdd += 1;
  entry.lastUpdatedAt = now;
}

export function getServerFeedbackSnapshot(
  shopId: string,
  cacheDir = DEFAULT_CACHE_DIR
): { snapshot: UpsellFeedbackSnapshot; recovered: boolean } {
  const state = loadOrCreateState(shopId, cacheDir);
  return { snapshot: state.snapshot, recovered: state.recovered };
}

export function recordServerFeedbackEventWithStatus(
  shopId: string,
  event: UpsellFeedbackEventInput,
  cacheDir = DEFAULT_CACHE_DIR
): { snapshot: UpsellFeedbackSnapshot; duplicate: boolean } {
  const state = loadOrCreateState(shopId, cacheDir);
  const now = Date.now();
  const productId = (event.productId || '').trim().slice(0, 128);
  if (!productId) return { snapshot: state.snapshot, duplicate: false };

  const eventId =
    typeof event.eventId === 'string' ? event.eventId.trim().slice(0, 128) : '';
  if (eventId && state.processedEventSet.has(eventId)) {
    return { snapshot: state.snapshot, duplicate: true };
  }

  if (!state.snapshot.productStats[productId]) {
    state.snapshot.productStats[productId] = createEmptyCounters(now);
  }
  incrementCounter(state.snapshot.productStats[productId], event.eventType, now);
  pruneCountersMap(state.snapshot.productStats, MAX_FEEDBACK_PRODUCTS);

  const candCat = (event.categoryKey || '').trim().toLowerCase().slice(0, 80);
  if (candCat && Array.isArray(event.anchorCategoryKeys)) {
    for (const rawAnchor of event.anchorCategoryKeys.slice(0, 10)) {
      const anchorCat = (rawAnchor || '').trim().toLowerCase().slice(0, 80);
      if (!anchorCat) continue;
      const pairKey = `${anchorCat}::${candCat}`;
      if (!state.snapshot.categoryPairStats[pairKey]) {
        state.snapshot.categoryPairStats[pairKey] = createEmptyCounters(now);
      }
      incrementCounter(state.snapshot.categoryPairStats[pairKey], event.eventType, now);
    }
    pruneCountersMap(state.snapshot.categoryPairStats, MAX_FEEDBACK_PAIR_KEYS);
  }

  if (eventId) {
    state.processedEventIds.push(eventId);
    state.processedEventSet.add(eventId);
    if (state.processedEventIds.length > MAX_FEEDBACK_EVENT_IDS) {
      const overflow = state.processedEventIds.splice(
        0,
        state.processedEventIds.length - MAX_FEEDBACK_EVENT_IDS
      );
      for (const oldId of overflow) {
        state.processedEventSet.delete(oldId);
      }
    }
  }

  state.snapshot.revision += 1;
  state.snapshot.updatedAt = now;
  writeFeedbackAtomic(shopId, state, cacheDir);
  return { snapshot: state.snapshot, duplicate: false };
}

export function recordServerFeedbackEvent(
  shopId: string,
  event: UpsellFeedbackEventInput,
  cacheDir = DEFAULT_CACHE_DIR
): UpsellFeedbackSnapshot {
  return recordServerFeedbackEventWithStatus(shopId, event, cacheDir).snapshot;
}

export function resetServerFeedbackStore(
  shopId: string,
  cacheDir = DEFAULT_CACHE_DIR
): void {
  feedbackMemoryCaches.delete(`${cacheDir}::${shopId}`);
  try {
    const filePath = getFeedbackFilePath(shopId, cacheDir);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}
