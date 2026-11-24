import { roundStockQty } from '../utils/packaging';

const COOCCURRENCE_STORAGE_PREFIX = 'cm_upsell_cooccurrence_v1_';
const MAX_PROCESSED_SALE_IDS = 4000;
const MAX_NEIGHBORS_PER_PRODUCT = 40;
const BACKFILL_CHUNK_SIZE = 150;
const PERSIST_DEBOUNCE_MS = 450;

export interface CooccurrenceSaleInput {
  saleId: string;
  status?: string;
  productIds: string[];
}

export interface CooccurrenceCartItemInput {
  productId: string;
  quantity: number;
  conversionFactor?: number;
}

export interface CooccurrenceStoreData {
  version: 1;
  shopId: string;
  totalCompletedSales: number;
  saleCountsByProduct: Record<string, number>;
  pairCounts: Record<string, Record<string, number>>;
  processedSaleIds: string[];
  updatedAt: number;
}

export interface HistoricalCandidateRank {
  productId: string;
  triggerProductId: string;
  pairCount: number;
  maxSinglePairCount: number;
  distinctAnchorMatches: number;
  confidence: number;
  lift: number;
  score: number;
  preferValuePack: boolean;
}

interface ShopRuntimeState {
  store: CooccurrenceStoreData;
  processedSet: Set<string>;
  persistTimer: ReturnType<typeof setTimeout> | null;
  backfillTimer: ReturnType<typeof setTimeout> | null;
  backfillGeneration: number;
}

const runtimeStates = new Map<string, ShopRuntimeState>();

function createEmptyStore(shopId: string): CooccurrenceStoreData {
  return {
    version: 1,
    shopId,
    totalCompletedSales: 0,
    saleCountsByProduct: {},
    pairCounts: {},
    processedSaleIds: [],
    updatedAt: Date.now(),
  };
}

function getStorageKey(shopId: string): string {
  return `${COOCCURRENCE_STORAGE_PREFIX}${shopId}`;
}

function loadStoreFromStorage(shopId: string): CooccurrenceStoreData {
  try {
    if (typeof localStorage === 'undefined') {
      return createEmptyStore(shopId);
    }
    const raw = localStorage.getItem(getStorageKey(shopId));
    if (!raw) return createEmptyStore(shopId);
    const parsed = JSON.parse(raw) as Partial<CooccurrenceStoreData>;
    if (
      !parsed ||
      parsed.version !== 1 ||
      parsed.shopId !== shopId ||
      typeof parsed.saleCountsByProduct !== 'object' ||
      typeof parsed.pairCounts !== 'object' ||
      !Array.isArray(parsed.processedSaleIds)
    ) {
      return createEmptyStore(shopId);
    }
    return {
      version: 1,
      shopId,
      totalCompletedSales: Math.max(0, Number(parsed.totalCompletedSales) || 0),
      saleCountsByProduct: parsed.saleCountsByProduct || {},
      pairCounts: parsed.pairCounts || {},
      processedSaleIds: parsed.processedSaleIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0
      ),
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    };
  } catch {
    return createEmptyStore(shopId);
  }
}

function getOrCreateRuntimeState(shopId: string): ShopRuntimeState {
  let state = runtimeStates.get(shopId);
  if (!state) {
    const store = loadStoreFromStorage(shopId);
    state = {
      store,
      processedSet: new Set(store.processedSaleIds),
      persistTimer: null,
      backfillTimer: null,
      backfillGeneration: 0,
    };
    runtimeStates.set(shopId, state);
  }
  return state;
}

function flushStorePersistence(shopId: string, state: ShopRuntimeState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    state.store.updatedAt = Date.now();
    localStorage.setItem(getStorageKey(shopId), JSON.stringify(state.store));
  } catch {
    // Never throw from background cache persistence
  }
}

function scheduleStorePersistence(shopId: string, state: ShopRuntimeState): void {
  if (typeof localStorage === 'undefined') return;
  if (state.persistTimer !== null) {
    clearTimeout(state.persistTimer);
  }
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    flushStorePersistence(shopId, state);
  }, PERSIST_DEBOUNCE_MS);
}

function pruneWeakNeighborsIfNeeded(neighbors: Record<string, number>): void {
  const keys = Object.keys(neighbors);
  if (keys.length <= MAX_NEIGHBORS_PER_PRODUCT * 2) return;
  const top = keys
    .sort((a, b) => (neighbors[b] || 0) - (neighbors[a] || 0))
    .slice(0, MAX_NEIGHBORS_PER_PRODUCT);
  const keepSet = new Set(top);
  for (const k of keys) {
    if (!keepSet.has(k)) {
      delete neighbors[k];
    }
  }
}

function ingestSaleSync(state: ShopRuntimeState, sale: CooccurrenceSaleInput): boolean {
  const saleId = typeof sale.saleId === 'string' ? sale.saleId.trim() : '';
  if (!saleId || sale.status === 'cancelled') return false;
  if (state.processedSet.has(saleId)) return false;

  const uniqueProductIds = Array.from(
    new Set(
      (sale.productIds || [])
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter((id) => id.length > 0)
    )
  );

  // Mark sale processed even if single-item so we never rescan it during backfill
  state.processedSet.add(saleId);
  state.store.processedSaleIds.push(saleId);
  if (state.store.processedSaleIds.length > MAX_PROCESSED_SALE_IDS) {
    const excess = state.store.processedSaleIds.length - MAX_PROCESSED_SALE_IDS;
    const removed = state.store.processedSaleIds.splice(0, excess);
    for (const oldId of removed) {
      state.processedSet.delete(oldId);
    }
  }

  if (uniqueProductIds.length === 0) return true;

  state.store.totalCompletedSales += 1;
  for (const pid of uniqueProductIds) {
    state.store.saleCountsByProduct[pid] = (state.store.saleCountsByProduct[pid] || 0) + 1;
  }

  if (uniqueProductIds.length >= 2) {
    // Cap absurdly large single receipts only at pair-matrix edge to guarantee bounded O(k^2)
    const boundedIds = uniqueProductIds.slice(0, 40);
    for (let i = 0; i < boundedIds.length; i += 1) {
      const a = boundedIds[i];
      if (!state.store.pairCounts[a]) {
        state.store.pairCounts[a] = {};
      }
      const neighborsA = state.store.pairCounts[a];
      for (let j = i + 1; j < boundedIds.length; j += 1) {
        const b = boundedIds[j];
        if (!state.store.pairCounts[b]) {
          state.store.pairCounts[b] = {};
        }
        neighborsA[b] = (neighborsA[b] || 0) + 1;
        state.store.pairCounts[b][a] = (state.store.pairCounts[b][a] || 0) + 1;
      }
      pruneWeakNeighborsIfNeeded(neighborsA);
    }
  }

  return true;
}

/**
 * Incrementally records one newly completed sale into the co-occurrence graph asynchronously.
 * Never throws and never delays checkout or stock transactions.
 */
export function enqueueSaleCooccurrenceUpdate(
  shopId: string,
  saleId: string,
  productIds: string[]
): void {
  if (!shopId || !saleId || !Array.isArray(productIds) || productIds.length === 0) return;

  const uniqueSnapshot = Array.from(new Set(productIds.filter(Boolean)));
  if (uniqueSnapshot.length === 0) return;

  setTimeout(() => {
    try {
      const state = getOrCreateRuntimeState(shopId);
      const changed = ingestSaleSync(state, {
        saleId,
        status: 'completed',
        productIds: uniqueSnapshot,
      });
      if (changed) {
        scheduleStorePersistence(shopId, state);
      }
    } catch {
      // Background enhancement must never surface errors to POS checkout
    }
  }, 0);
}

/**
 * Incrementally backfills historical completed sales in small non-blocking chunks.
 * Already-processed sale IDs are skipped in O(1).
 */
export function scheduleCooccurrenceBackfill(
  shopId: string,
  completedSales: CooccurrenceSaleInput[]
): void {
  if (!shopId || !Array.isArray(completedSales) || completedSales.length === 0) return;

  const state = getOrCreateRuntimeState(shopId);
  if (state.backfillTimer !== null) {
    clearTimeout(state.backfillTimer);
    state.backfillTimer = null;
  }
  state.backfillGeneration += 1;
  const generation = state.backfillGeneration;

  // Snapshot pending completed sales that are not yet processed
  const pending: CooccurrenceSaleInput[] = [];
  for (let i = 0; i < completedSales.length; i += 1) {
    const sale = completedSales[i];
    if (!sale || sale.status === 'cancelled' || !sale.saleId) continue;
    if (!state.processedSet.has(sale.saleId)) {
      pending.push({
        saleId: sale.saleId,
        status: sale.status,
        productIds: sale.productIds,
      });
    }
  }

  if (pending.length === 0) return;

  let cursor = 0;
  let anyChanged = false;

  const processNextChunk = () => {
    state.backfillTimer = null;
    if (state.backfillGeneration !== generation) return;

    try {
      const end = Math.min(cursor + BACKFILL_CHUNK_SIZE, pending.length);
      for (; cursor < end; cursor += 1) {
        if (ingestSaleSync(state, pending[cursor])) {
          anyChanged = true;
        }
      }

      if (cursor < pending.length) {
        state.backfillTimer = setTimeout(processNextChunk, 16);
      } else if (anyChanged) {
        scheduleStorePersistence(shopId, state);
      }
    } catch {
      // Never block app execution
    }
  };

  state.backfillTimer = setTimeout(processNextChunk, 24);
}

/**
 * Synchronous helper for tests or explicit maintenance.
 */
export function ingestCompletedSalesBatchSync(
  shopId: string,
  sales: CooccurrenceSaleInput[]
): number {
  if (!shopId || !Array.isArray(sales)) return 0;
  const state = getOrCreateRuntimeState(shopId);
  let ingested = 0;
  for (const sale of sales) {
    if (ingestSaleSync(state, sale)) {
      ingested += 1;
    }
  }
  if (ingested > 0) {
    flushStorePersistence(shopId, state);
  }
  return ingested;
}

export function resetCooccurrenceStore(shopId: string): void {
  const existing = runtimeStates.get(shopId);
  if (existing) {
    if (existing.persistTimer !== null) clearTimeout(existing.persistTimer);
    if (existing.backfillTimer !== null) clearTimeout(existing.backfillTimer);
  }
  runtimeStates.delete(shopId);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(getStorageKey(shopId));
    }
  } catch {
    // Ignore storage errors
  }
}

export function getCooccurrenceStatsSnapshot(shopId: string): {
  totalCompletedSales: number;
  indexedProducts: number;
  processedSaleCount: number;
} {
  if (!shopId) {
    return { totalCompletedSales: 0, indexedProducts: 0, processedSaleCount: 0 };
  }
  const state = getOrCreateRuntimeState(shopId);
  return {
    totalCompletedSales: state.store.totalCompletedSales,
    indexedProducts: Object.keys(state.store.pairCounts).length,
    processedSaleCount: state.store.processedSaleIds.length,
  };
}

/**
 * O(1)-per-cart-item lookup returning historical co-occurrence candidates
 * aggregated across ALL items and quantities in the active cart.
 */
export function getHistoricalCooccurrenceCandidates(
  shopId: string,
  cartItems: CooccurrenceCartItemInput[]
): HistoricalCandidateRank[] {
  if (!shopId || !Array.isArray(cartItems) || cartItems.length === 0) return [];

  const state = getOrCreateRuntimeState(shopId);
  const { pairCounts, saleCountsByProduct, totalCompletedSales } = state.store;
  if (totalCompletedSales <= 0) return [];

  const cartEffectiveQtyById = new Map<string, number>();
  for (const line of cartItems) {
    if (!line.productId) continue;
    const qty = Math.max(0.25, Number(line.quantity) || 1);
    const conv = Math.max(1, Number(line.conversionFactor) || 1);
    const eff = roundStockQty(qty * conv);
    cartEffectiveQtyById.set(
      line.productId,
      roundStockQty((cartEffectiveQtyById.get(line.productId) || 0) + eff)
    );
  }

  if (cartEffectiveQtyById.size === 0) return [];

  interface AggregatedTarget {
    productId: string;
    totalPairCount: number;
    maxSinglePairCount: number;
    bestTriggerProductId: string;
    bestTriggerScore: number;
    bestConfidence: number;
    bestLift: number;
    distinctAnchorMatches: number;
    totalScore: number;
    maxAnchorEffectiveQty: number;
  }

  const aggregated = new Map<string, AggregatedTarget>();
  const globalSalesDenominator = Math.max(1, totalCompletedSales);

  for (const [anchorId, anchorEffQty] of cartEffectiveQtyById.entries()) {
    const neighbors = pairCounts[anchorId];
    if (!neighbors) continue;

    const anchorSalesCount = Math.max(1, saleCountsByProduct[anchorId] || 1);
    // Quantity scaling: buying more units of anchor strengthens basket affinity smoothly
    const qtyWeight = Math.min(2.4, 1 + Math.log1p(Math.max(0, anchorEffQty - 1)) * 0.45);

    for (const [targetId, pairCount] of Object.entries(neighbors)) {
      if (!pairCount || pairCount <= 0) continue;
      if (cartEffectiveQtyById.has(targetId)) continue;

      const targetSalesCount = Math.max(1, saleCountsByProduct[targetId] || pairCount);
      const confidence = Math.min(1, pairCount / anchorSalesCount);
      const targetBaselineProb = targetSalesCount / globalSalesDenominator;
      const rawLift = targetBaselineProb > 0 ? confidence / targetBaselineProb : 1;
      const boundedLift = Math.min(4, Math.max(0.5, rawLift));

      // Smoothed score combining repeated co-purchase count, conditional probability & lift
      const supportFactor = Math.log1p(pairCount) * 28;
      const confidenceScore = confidence * 55;
      const liftBonus = Math.max(0, boundedLift - 1) * 14;
      const contribution = (supportFactor + confidenceScore + liftBonus) * qtyWeight;

      const existing = aggregated.get(targetId);
      if (existing) {
        existing.totalPairCount += pairCount;
        existing.distinctAnchorMatches += 1;
        existing.totalScore += contribution * 0.85;
        existing.maxAnchorEffectiveQty = Math.max(existing.maxAnchorEffectiveQty, anchorEffQty);
        if (
          pairCount > existing.maxSinglePairCount ||
          (pairCount === existing.maxSinglePairCount && contribution > existing.bestTriggerScore)
        ) {
          existing.maxSinglePairCount = pairCount;
          existing.bestTriggerProductId = anchorId;
          existing.bestTriggerScore = contribution;
          existing.bestConfidence = confidence;
          existing.bestLift = boundedLift;
        }
      } else {
        aggregated.set(targetId, {
          productId: targetId,
          totalPairCount: pairCount,
          maxSinglePairCount: pairCount,
          bestTriggerProductId: anchorId,
          bestTriggerScore: contribution,
          bestConfidence: confidence,
          bestLift: boundedLift,
          distinctAnchorMatches: 1,
          totalScore: contribution,
          maxAnchorEffectiveQty: anchorEffQty,
        });
      }
    }
  }

  const ranked: HistoricalCandidateRank[] = [];
  for (const agg of aggregated.values()) {
    // Require real repeated historical evidence (>= 2 completed sales together)
    // so accidental one-off receipts don't create noisy recommendations.
    if (agg.maxSinglePairCount < 2 && agg.totalPairCount < 3) {
      continue;
    }

    const multiAnchorBonus = agg.distinctAnchorMatches > 1 ? (agg.distinctAnchorMatches - 1) * 18 : 0;
    ranked.push({
      productId: agg.productId,
      triggerProductId: agg.bestTriggerProductId,
      pairCount: agg.totalPairCount,
      maxSinglePairCount: agg.maxSinglePairCount,
      distinctAnchorMatches: agg.distinctAnchorMatches,
      confidence: Math.round(agg.bestConfidence * 1000) / 1000,
      lift: Math.round(agg.bestLift * 100) / 100,
      score: Math.round((agg.totalScore + multiAnchorBonus) * 100) / 100,
      preferValuePack: agg.maxAnchorEffectiveQty >= 2 || agg.distinctAnchorMatches >= 2,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.maxSinglePairCount !== a.maxSinglePairCount) {
      return b.maxSinglePairCount - a.maxSinglePairCount;
    }
    return a.productId.localeCompare(b.productId);
  });

  return ranked;
}
