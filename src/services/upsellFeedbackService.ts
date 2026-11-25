import {
  MAX_FEEDBACK_PAIR_KEYS,
  MAX_FEEDBACK_PRODUCTS,
  UPSELL_FEEDBACK_VERSION,
  type UpsellFeedbackCounters,
  type UpsellFeedbackEventInput,
  type UpsellFeedbackEventType,
  type UpsellFeedbackSnapshot,
} from '../../shared/upsellCacheSchema';

const MIRROR_STORAGE_PREFIX = `cm_upsell_feedback_mirror_v${UPSELL_FEEDBACK_VERSION}_`;
const PENDING_QUEUE_PREFIX = `cm_upsell_feedback_pending_v${UPSELL_FEEDBACK_VERSION}_`;
const MAX_PENDING_EVENTS = 300;
const BASE_RETRY_MS = 1500;
const MAX_RETRY_MS = 60_000;

export interface PendingFeedbackItem {
  event: UpsellFeedbackEventInput & { eventId: string };
  attempts: number;
  nextAttemptAt: number;
  queuedAt: number;
}

interface FeedbackRuntimeState {
  snapshot: UpsellFeedbackSnapshot;
  pendingQueue: PendingFeedbackItem[];
  authoritativeLoaded: boolean;
  hydrationInFlight: Promise<void> | null;
  flushInFlight: Promise<void> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const runtimeFeedbackStates = new Map<string, FeedbackRuntimeState>();

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

function createEmptyCounters(now = Date.now()): UpsellFeedbackCounters {
  return {
    shown: 0,
    accepted: 0,
    dismissed: 0,
    removedAfterAdd: 0,
    lastUpdatedAt: now,
  };
}

function generateFeedbackEventId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `fb_${Date.now().toString(36)}_${rand}`;
}

function getMirrorKey(shopId: string): string {
  return `${MIRROR_STORAGE_PREFIX}${shopId}`;
}

function getPendingKey(shopId: string): string {
  return `${PENDING_QUEUE_PREFIX}${shopId}`;
}

function isValidSnapshot(raw: unknown, shopId: string): raw is UpsellFeedbackSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const cand = raw as Partial<UpsellFeedbackSnapshot>;
  return (
    cand.version === UPSELL_FEEDBACK_VERSION &&
    cand.shopId === shopId &&
    typeof cand.productStats === 'object' &&
    cand.productStats !== null &&
    typeof cand.categoryPairStats === 'object' &&
    cand.categoryPairStats !== null
  );
}

function cloneSnapshot(snap: UpsellFeedbackSnapshot): UpsellFeedbackSnapshot {
  return {
    version: snap.version,
    shopId: snap.shopId,
    revision: snap.revision,
    updatedAt: snap.updatedAt,
    productStats: Object.fromEntries(
      Object.entries(snap.productStats).map(([k, v]) => [k, { ...v }])
    ),
    categoryPairStats: Object.fromEntries(
      Object.entries(snap.categoryPairStats).map(([k, v]) => [k, { ...v }])
    ),
  };
}

function loadMirror(shopId: string): UpsellFeedbackSnapshot {
  try {
    if (typeof localStorage === 'undefined') return createEmptySnapshot(shopId);
    const raw = localStorage.getItem(getMirrorKey(shopId));
    if (!raw) return createEmptySnapshot(shopId);
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidSnapshot(parsed, shopId)) {
      localStorage.removeItem(getMirrorKey(shopId));
      return createEmptySnapshot(shopId);
    }
    return parsed;
  } catch {
    return createEmptySnapshot(shopId);
  }
}

function saveMirror(shopId: string, snapshot: UpsellFeedbackSnapshot): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(getMirrorKey(shopId), JSON.stringify(snapshot));
  } catch {
    // Never disrupt POS flows
  }
}

function loadPendingQueue(shopId: string): PendingFeedbackItem[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(getPendingKey(shopId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is PendingFeedbackItem =>
          Boolean(
            item &&
              typeof item === 'object' &&
              item.event &&
              typeof item.event.productId === 'string' &&
              typeof item.event.eventType === 'string' &&
              typeof item.event.eventId === 'string'
          )
      )
      .slice(-MAX_PENDING_EVENTS);
  } catch {
    return [];
  }
}

function savePendingQueue(shopId: string, queue: PendingFeedbackItem[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (queue.length === 0) {
      localStorage.removeItem(getPendingKey(shopId));
      return;
    }
    localStorage.setItem(getPendingKey(shopId), JSON.stringify(queue.slice(-MAX_PENDING_EVENTS)));
  } catch {
    // Never disrupt POS flows
  }
}

function getOrCreateState(shopId: string): FeedbackRuntimeState {
  let state = runtimeFeedbackStates.get(shopId);
  if (!state) {
    state = {
      snapshot: loadMirror(shopId),
      pendingQueue: loadPendingQueue(shopId),
      authoritativeLoaded: false,
      hydrationInFlight: null,
      flushInFlight: null,
      retryTimer: null,
    };
    runtimeFeedbackStates.set(shopId, state);
  }
  return state;
}

function applyEventToSnapshot(
  snapshot: UpsellFeedbackSnapshot,
  event: UpsellFeedbackEventInput,
  now = Date.now()
): void {
  const productId = (event.productId || '').trim();
  if (!productId) return;

  if (!snapshot.productStats[productId]) {
    snapshot.productStats[productId] = createEmptyCounters(now);
  }
  const pStats = snapshot.productStats[productId];
  if (event.eventType === 'shown') pStats.shown += 1;
  else if (event.eventType === 'accepted') pStats.accepted += 1;
  else if (event.eventType === 'dismissed') pStats.dismissed += 1;
  else if (event.eventType === 'removed_after_add') pStats.removedAfterAdd += 1;
  pStats.lastUpdatedAt = now;

  const pKeys = Object.keys(snapshot.productStats);
  if (pKeys.length > MAX_FEEDBACK_PRODUCTS) {
    const keep = new Set(
      pKeys
        .sort(
          (a, b) =>
            (snapshot.productStats[b]?.lastUpdatedAt || 0) -
            (snapshot.productStats[a]?.lastUpdatedAt || 0)
        )
        .slice(0, MAX_FEEDBACK_PRODUCTS)
    );
    for (const k of pKeys) {
      if (!keep.has(k)) delete snapshot.productStats[k];
    }
  }

  const candCat = (event.categoryKey || '').trim().toLowerCase();
  if (candCat && Array.isArray(event.anchorCategoryKeys)) {
    for (const rawAnchor of event.anchorCategoryKeys) {
      const anchorCat = (rawAnchor || '').trim().toLowerCase();
      if (!anchorCat) continue;
      const pairKey = `${anchorCat}::${candCat}`;
      if (!snapshot.categoryPairStats[pairKey]) {
        snapshot.categoryPairStats[pairKey] = createEmptyCounters(now);
      }
      const cStats = snapshot.categoryPairStats[pairKey];
      if (event.eventType === 'shown') cStats.shown += 1;
      else if (event.eventType === 'accepted') cStats.accepted += 1;
      else if (event.eventType === 'dismissed') cStats.dismissed += 1;
      else if (event.eventType === 'removed_after_add') cStats.removedAfterAdd += 1;
      cStats.lastUpdatedAt = now;
    }
    const cKeys = Object.keys(snapshot.categoryPairStats);
    if (cKeys.length > MAX_FEEDBACK_PAIR_KEYS) {
      const keep = new Set(
        cKeys
          .sort(
            (a, b) =>
              (snapshot.categoryPairStats[b]?.lastUpdatedAt || 0) -
              (snapshot.categoryPairStats[a]?.lastUpdatedAt || 0)
          )
          .slice(0, MAX_FEEDBACK_PAIR_KEYS)
      );
      for (const k of cKeys) {
        if (!keep.has(k)) delete snapshot.categoryPairStats[k];
      }
    }
  }

  snapshot.updatedAt = now;
}

function enqueuePendingFeedback(
  shopId: string,
  state: FeedbackRuntimeState,
  event: UpsellFeedbackEventInput & { eventId: string },
  now = Date.now()
): void {
  if (state.pendingQueue.some((item) => item.event.eventId === event.eventId)) {
    return;
  }
  state.pendingQueue.push({
    event,
    attempts: 0,
    nextAttemptAt: 0,
    queuedAt: now,
  });
  if (state.pendingQueue.length > MAX_PENDING_EVENTS) {
    state.pendingQueue.splice(0, state.pendingQueue.length - MAX_PENDING_EVENTS);
  }
  savePendingQueue(shopId, state.pendingQueue);
}

function schedulePendingFlush(params: {
  shopId: string;
  getIdToken?: () => Promise<string | null>;
  fetchImpl: typeof fetch;
  delayMs: number;
}): void {
  const { shopId, getIdToken, fetchImpl, delayMs } = params;
  if (!getIdToken) return;
  const state = getOrCreateState(shopId);
  if (state.retryTimer || state.pendingQueue.length === 0) return;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    void flushPendingFeedbackEvents({ shopId, getIdToken, fetchImpl });
  }, Math.max(50, delayMs));
}

export async function flushPendingFeedbackEvents(params: {
  shopId: string;
  getIdToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  ignoreBackoff?: boolean;
}): Promise<{ flushedCount: number; remainingCount: number }> {
  const { shopId, getIdToken, fetchImpl = fetch, ignoreBackoff = false } = params;
  if (!shopId || !getIdToken) {
    return { flushedCount: 0, remainingCount: 0 };
  }

  const state = getOrCreateState(shopId);
  if (state.flushInFlight) {
    await state.flushInFlight;
    return { flushedCount: 0, remainingCount: state.pendingQueue.length };
  }

  if (state.pendingQueue.length === 0) {
    return { flushedCount: 0, remainingCount: 0 };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { flushedCount: 0, remainingCount: state.pendingQueue.length };
  }
  if (typeof fetchImpl !== 'function') {
    return { flushedCount: 0, remainingCount: state.pendingQueue.length };
  }

  let flushedCount = 0;

  const run = (async () => {
    let token: string | null = null;
    try {
      token = await getIdToken();
    } catch {
      token = null;
    }
    if (!token) return;

    let earliestNextDelayMs = 0;

    while (state.pendingQueue.length > 0) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        break;
      }
      const head = state.pendingQueue[0];
      const now = Date.now();
      if (!ignoreBackoff && head.nextAttemptAt > now) {
        earliestNextDelayMs = Math.max(100, head.nextAttemptAt - now);
        break;
      }

      try {
        const res = await fetchImpl('/api/upsell/feedback', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(head.event),
        });

        // Remove on 2xx success or permanent payload/authorization rejection
        if (res.ok || res.status === 400 || res.status === 403 || res.status === 404) {
          state.pendingQueue.shift();
          savePendingQueue(shopId, state.pendingQueue);
          if (res.ok) flushedCount += 1;
          continue;
        }

        // Transient error (401, 429, 5xx) -> keep in queue with backoff
        head.attempts += 1;
        const backoff = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * Math.pow(2, head.attempts - 1));
        head.nextAttemptAt = Date.now() + backoff;
        savePendingQueue(shopId, state.pendingQueue);
        earliestNextDelayMs = backoff;
        break;
      } catch {
        head.attempts += 1;
        const backoff = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * Math.pow(2, head.attempts - 1));
        head.nextAttemptAt = Date.now() + backoff;
        savePendingQueue(shopId, state.pendingQueue);
        earliestNextDelayMs = backoff;
        break;
      }
    }

    if (earliestNextDelayMs > 0 && state.pendingQueue.length > 0) {
      schedulePendingFlush({
        shopId,
        getIdToken,
        fetchImpl,
        delayMs: earliestNextDelayMs,
      });
    }
  })();

  state.flushInFlight = run;
  try {
    await run;
  } finally {
    if (state.flushInFlight === run) {
      state.flushInFlight = null;
    }
  }

  return { flushedCount, remainingCount: state.pendingQueue.length };
}

export function getPendingFeedbackQueueCount(shopId: string): number {
  if (!shopId) return 0;
  return getOrCreateState(shopId).pendingQueue.length;
}

/**
 * Records POS upsell feedback signals asynchronously (never blocking Sales Entry or checkout),
 * persisting unsent events in a durable retry queue so offline/failed requests are never lost.
 */
export function recordUpsellFeedbackEvent(params: {
  shopId: string;
  productId: string;
  eventType: UpsellFeedbackEventType;
  eventId?: string;
  categoryKey?: string;
  anchorCategoryKeys?: string[];
  getIdToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): void {
  const {
    shopId,
    productId,
    eventType,
    eventId,
    categoryKey,
    anchorCategoryKeys,
    getIdToken,
    fetchImpl = fetch,
  } = params;
  if (!shopId || !productId) return;

  const resolvedEventId =
    typeof eventId === 'string' && eventId.trim().length >= 8
      ? eventId.trim()
      : generateFeedbackEventId();

  const event: UpsellFeedbackEventInput & { eventId: string } = {
    eventId: resolvedEventId,
    productId,
    eventType,
    categoryKey,
    anchorCategoryKeys,
  };

  setTimeout(() => {
    try {
      const state = getOrCreateState(shopId);
      applyEventToSnapshot(state.snapshot, event);
      saveMirror(shopId, state.snapshot);
      enqueuePendingFeedback(shopId, state, event);

      if (!getIdToken) return;
      void flushPendingFeedbackEvents({
        shopId,
        getIdToken,
        fetchImpl,
      });
    } catch {
      // Never block POS UI
    }
  }, 0);
}

/**
 * Synchronous feedback recording helper for unit tests or immediate local updates.
 */
export function recordUpsellFeedbackSync(
  shopId: string,
  event: UpsellFeedbackEventInput
): void {
  if (!shopId || !event.productId) return;
  const state = getOrCreateState(shopId);
  applyEventToSnapshot(state.snapshot, event);
  saveMirror(shopId, state.snapshot);
}

export async function syncFeedbackWithBackend(params: {
  shopId: string;
  getIdToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { shopId, getIdToken, fetchImpl = fetch } = params;
  if (!shopId || !getIdToken) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const state = getOrCreateState(shopId);
  if (state.hydrationInFlight) return state.hydrationInFlight;

  const run = (async () => {
    try {
      // Attempt to flush any queued offline/retry events first
      await flushPendingFeedbackEvents({
        shopId,
        getIdToken,
        fetchImpl,
        ignoreBackoff: true,
      });

      const token = await getIdToken();
      if (!token) return;
      const sinceQuery =
        state.authoritativeLoaded && state.snapshot.revision > 0
          ? `?sinceRevision=${encodeURIComponent(String(state.snapshot.revision))}`
          : '';
      const res = await fetchImpl(`/api/upsell/feedback${sinceQuery}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        ok?: boolean;
        unchanged?: boolean;
        snapshot?: UpsellFeedbackSnapshot;
      };
      if (body?.ok && !body.unchanged && body.snapshot && isValidSnapshot(body.snapshot, shopId)) {
        const merged = cloneSnapshot(body.snapshot);
        // Preserve any still-unflushed local events on top of backend snapshot
        for (const pending of state.pendingQueue) {
          applyEventToSnapshot(merged, pending.event, pending.queuedAt);
        }
        state.snapshot = merged;
        state.authoritativeLoaded = true;
        saveMirror(shopId, state.snapshot);
      } else if (body?.ok && body.unchanged) {
        state.authoritativeLoaded = true;
      }
    } catch {
      // Safe fallback to local mirror
    }
  })();

  state.hydrationInFlight = run;
  try {
    await run;
  } finally {
    if (state.hydrationInFlight === run) {
      state.hydrationInFlight = null;
    }
  }
}

function computeDampenedCounterAdjustment(stats?: UpsellFeedbackCounters): number {
  if (!stats) return 0;
  const positive = stats.accepted;
  const negative = stats.dismissed + stats.removedAfterAdd * 1.25;
  const totalInteractions = positive + negative;
  if (totalInteractions <= 0) return 0;

  // Bayesian smoothed acceptance rate with neutral prior around 0.40 & sample dampening
  const priorPositive = 2;
  const priorTotal = 5;
  const posteriorRate = (positive + priorPositive) / (totalInteractions + priorTotal);
  const neutralRate = priorPositive / priorTotal; // 0.40
  const confidenceRamp = totalInteractions / (totalInteractions + 4);
  const rawShift = (posteriorRate - neutralRate) * 0.45 * confidenceRamp;
  return Math.max(-0.18, Math.min(0.22, rawShift));
}

/**
 * Returns a gentle, bounded Bayesian feedback adjustment in [-0.18, +0.22]
 * that softly rewards accepted items/pairs and gently dampens repeatedly dismissed ones
 * without ever overfitting or permanently banning any product or category.
 */
export function getUpsellFeedbackAdjustment(params: {
  shopId: string;
  candidateProductId: string;
  candidateCategoryKey?: string;
  anchorCategoryKeys?: string[];
}): number {
  const { shopId, candidateProductId, candidateCategoryKey, anchorCategoryKeys = [] } = params;
  if (!shopId || !candidateProductId) return 0;

  const state = getOrCreateState(shopId);
  const prodAdj = computeDampenedCounterAdjustment(
    state.snapshot.productStats[candidateProductId]
  );

  let catAdjSum = 0;
  let catMatches = 0;
  if (candidateCategoryKey && anchorCategoryKeys.length > 0) {
    for (const anchorCat of anchorCategoryKeys) {
      if (!anchorCat) continue;
      const pairStats = state.snapshot.categoryPairStats[`${anchorCat}::${candidateCategoryKey}`];
      if (pairStats) {
        catAdjSum += computeDampenedCounterAdjustment(pairStats);
        catMatches += 1;
      }
    }
  }

  const catAdj = catMatches > 0 ? (catAdjSum / catMatches) * 0.5 : 0;
  return Math.max(-0.18, Math.min(0.22, Math.round((prodAdj + catAdj) * 1000) / 1000));
}

export function resetUpsellFeedbackStore(shopId?: string): void {
  if (shopId) {
    const existing = runtimeFeedbackStates.get(shopId);
    if (existing?.retryTimer) {
      clearTimeout(existing.retryTimer);
    }
    runtimeFeedbackStates.delete(shopId);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(getMirrorKey(shopId));
        localStorage.removeItem(getPendingKey(shopId));
      }
    } catch {
      // Ignore storage errors
    }
    return;
  }
  for (const existing of runtimeFeedbackStates.values()) {
    if (existing.retryTimer) {
      clearTimeout(existing.retryTimer);
    }
  }
  runtimeFeedbackStates.clear();
}
