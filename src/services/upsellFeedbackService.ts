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

interface FeedbackRuntimeState {
  snapshot: UpsellFeedbackSnapshot;
  authoritativeLoaded: boolean;
  hydrationInFlight: Promise<void> | null;
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

function getMirrorKey(shopId: string): string {
  return `${MIRROR_STORAGE_PREFIX}${shopId}`;
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

function getOrCreateState(shopId: string): FeedbackRuntimeState {
  let state = runtimeFeedbackStates.get(shopId);
  if (!state) {
    state = {
      snapshot: loadMirror(shopId),
      authoritativeLoaded: false,
      hydrationInFlight: null,
    };
    runtimeFeedbackStates.set(shopId, state);
  }
  return state;
}

function applyEventLocally(
  state: FeedbackRuntimeState,
  event: UpsellFeedbackEventInput
): void {
  const now = Date.now();
  const productId = (event.productId || '').trim();
  if (!productId) return;

  if (!state.snapshot.productStats[productId]) {
    state.snapshot.productStats[productId] = createEmptyCounters(now);
  }
  const pStats = state.snapshot.productStats[productId];
  if (event.eventType === 'shown') pStats.shown += 1;
  else if (event.eventType === 'accepted') pStats.accepted += 1;
  else if (event.eventType === 'dismissed') pStats.dismissed += 1;
  else if (event.eventType === 'removed_after_add') pStats.removedAfterAdd += 1;
  pStats.lastUpdatedAt = now;

  const pKeys = Object.keys(state.snapshot.productStats);
  if (pKeys.length > MAX_FEEDBACK_PRODUCTS) {
    const keep = new Set(
      pKeys
        .sort(
          (a, b) =>
            (state.snapshot.productStats[b]?.lastUpdatedAt || 0) -
            (state.snapshot.productStats[a]?.lastUpdatedAt || 0)
        )
        .slice(0, MAX_FEEDBACK_PRODUCTS)
    );
    for (const k of pKeys) {
      if (!keep.has(k)) delete state.snapshot.productStats[k];
    }
  }

  const candCat = (event.categoryKey || '').trim().toLowerCase();
  if (candCat && Array.isArray(event.anchorCategoryKeys)) {
    for (const rawAnchor of event.anchorCategoryKeys) {
      const anchorCat = (rawAnchor || '').trim().toLowerCase();
      if (!anchorCat) continue;
      const pairKey = `${anchorCat}::${candCat}`;
      if (!state.snapshot.categoryPairStats[pairKey]) {
        state.snapshot.categoryPairStats[pairKey] = createEmptyCounters(now);
      }
      const cStats = state.snapshot.categoryPairStats[pairKey];
      if (event.eventType === 'shown') cStats.shown += 1;
      else if (event.eventType === 'accepted') cStats.accepted += 1;
      else if (event.eventType === 'dismissed') cStats.dismissed += 1;
      else if (event.eventType === 'removed_after_add') cStats.removedAfterAdd += 1;
      cStats.lastUpdatedAt = now;
    }
    const cKeys = Object.keys(state.snapshot.categoryPairStats);
    if (cKeys.length > MAX_FEEDBACK_PAIR_KEYS) {
      const keep = new Set(
        cKeys
          .sort(
            (a, b) =>
              (state.snapshot.categoryPairStats[b]?.lastUpdatedAt || 0) -
              (state.snapshot.categoryPairStats[a]?.lastUpdatedAt || 0)
          )
          .slice(0, MAX_FEEDBACK_PAIR_KEYS)
      );
      for (const k of cKeys) {
        if (!keep.has(k)) delete state.snapshot.categoryPairStats[k];
      }
    }
  }

  state.snapshot.updatedAt = now;
}

/**
 * Records POS upsell feedback signals asynchronously (never blocking Sales Entry or checkout).
 */
export function recordUpsellFeedbackEvent(params: {
  shopId: string;
  productId: string;
  eventType: UpsellFeedbackEventType;
  categoryKey?: string;
  anchorCategoryKeys?: string[];
  getIdToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): void {
  const {
    shopId,
    productId,
    eventType,
    categoryKey,
    anchorCategoryKeys,
    getIdToken,
    fetchImpl = fetch,
  } = params;
  if (!shopId || !productId) return;

  const event: UpsellFeedbackEventInput = {
    productId,
    eventType,
    categoryKey,
    anchorCategoryKeys,
  };

  setTimeout(() => {
    try {
      const state = getOrCreateState(shopId);
      applyEventLocally(state, event);
      saveMirror(shopId, state.snapshot);

      if (!getIdToken) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (typeof fetchImpl !== 'function') return;

      void getIdToken()
        .then((token) => {
          if (!token) return;
          return fetchImpl('/api/upsell/feedback', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(event),
          });
        })
        .catch(() => {
          // Non-blocking best-effort background telemetry
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
  applyEventLocally(state, event);
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
        state.snapshot = body.snapshot;
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
    runtimeFeedbackStates.delete(shopId);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(getMirrorKey(shopId));
      }
    } catch {
      // Ignore storage errors
    }
    return;
  }
  runtimeFeedbackStates.clear();
}
