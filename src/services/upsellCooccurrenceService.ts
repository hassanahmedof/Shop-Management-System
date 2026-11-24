import { doc, getDoc, runTransaction, serverTimestamp } from 'firebase/firestore';
import {
  COOCCURRENCE_CACHE_VERSION,
  type CooccurrenceSaleInput,
  type CooccurrenceSnapshot,
  MAX_INDEXED_PRODUCTS,
  MAX_NEIGHBORS_PER_PRODUCT,
  MAX_PROCESSED_SALE_IDS,
} from '../../shared/upsellCacheSchema';
import { db } from '../lib/firebase';
import { roundStockQty } from '../utils/packaging';

const MIRROR_STORAGE_PREFIX = `cm_upsell_cooccurrence_mirror_v${COOCCURRENCE_CACHE_VERSION}_`;
const PENDING_UPDATES_PREFIX = `cm_upsell_pending_updates_v${COOCCURRENCE_CACHE_VERSION}_`;
const DIRTY_REBUILD_PREFIX = `cm_upsell_dirty_v${COOCCURRENCE_CACHE_VERSION}_`;
const LEGACY_V1_PREFIX = 'cm_upsell_cooccurrence_v1_';
const BACKFILL_CHUNK_SIZE = 150;
const SERVER_REBUILD_BATCH_SIZE = 150;
const PERSIST_DEBOUNCE_MS = 450;
const FIRESTORE_PERSIST_DEBOUNCE_MS = 1200;
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [3000, 10_000, 30_000, 90_000];
const UPSELL_CACHE_DOC_ID = `cooccurrence_v${COOCCURRENCE_CACHE_VERSION}`;

export type { CooccurrenceSaleInput, CooccurrenceSnapshot };

export interface CooccurrenceCartItemInput {
  productId: string;
  quantity: number;
  conversionFactor?: number;
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

interface PendingCooccurrenceItem {
  sale: CooccurrenceSaleInput;
  retryCount: number;
  nextAttemptAt: number;
  lastError?: string;
}

interface ShopRuntimeState {
  store: CooccurrenceSnapshot;
  processedSet: Set<string>;
  authoritativeLoaded: boolean;
  dirtyRebuild: boolean;
  persistTimer: ReturnType<typeof setTimeout> | null;
  backfillTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  firestorePersistTimer: ReturnType<typeof setTimeout> | null;
  backfillGeneration: number;
  hydrationInFlight: Promise<void> | null;
  flushInFlight: Promise<void> | null;
  latestGetIdToken?: () => Promise<string | null>;
  latestFetchImpl?: typeof fetch;
  latestIsOwner?: boolean;
  lastFirestoreRevisionSaved: number;
}

const runtimeStates = new Map<string, ShopRuntimeState>();
let onlineListenerBound = false;

function ensureOnlineRecoveryListener(): void {
  if (onlineListenerBound || typeof window === 'undefined') return;
  onlineListenerBound = true;
  window.addEventListener('online', () => {
    for (const [shopId, state] of runtimeStates.entries()) {
      if (readPendingUpdates(shopId).length > 0 && state.latestGetIdToken) {
        void flushPendingCooccurrenceUpdates({
          shopId,
          getIdToken: state.latestGetIdToken,
          fetchImpl: state.latestFetchImpl,
          forceDueNow: true,
        });
      }
    }
  });
}

function createEmptyStore(shopId: string): CooccurrenceSnapshot {
  return {
    version: COOCCURRENCE_CACHE_VERSION,
    shopId,
    revision: 0,
    totalCompletedSales: 0,
    saleCountsByProduct: {},
    pairCounts: {},
    processedSaleIds: [],
    updatedAt: Date.now(),
  };
}

function getMirrorKey(shopId: string): string {
  return `${MIRROR_STORAGE_PREFIX}${shopId}`;
}

function getPendingKey(shopId: string): string {
  return `${PENDING_UPDATES_PREFIX}${shopId}`;
}

function getDirtyKey(shopId: string): string {
  return `${DIRTY_REBUILD_PREFIX}${shopId}`;
}

function safeCleanupLegacyCache(shopId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(`${LEGACY_V1_PREFIX}${shopId}`);
  } catch {
    // Ignore storage errors
  }
}

function readDirtyFlag(shopId: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(getDirtyKey(shopId)) === '1';
  } catch {
    return false;
  }
}

function writeDirtyFlag(shopId: string, dirty: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (dirty) {
      localStorage.setItem(getDirtyKey(shopId), '1');
    } else {
      localStorage.removeItem(getDirtyKey(shopId));
    }
  } catch {
    // Ignore storage errors
  }
}

function isValidSnapshotShape(parsed: unknown, shopId: string): parsed is CooccurrenceSnapshot {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const candidate = parsed as Partial<CooccurrenceSnapshot>;
  return (
    candidate.version === COOCCURRENCE_CACHE_VERSION &&
    candidate.shopId === shopId &&
    typeof candidate.totalCompletedSales === 'number' &&
    typeof candidate.saleCountsByProduct === 'object' &&
    candidate.saleCountsByProduct !== null &&
    typeof candidate.pairCounts === 'object' &&
    candidate.pairCounts !== null &&
    Array.isArray(candidate.processedSaleIds)
  );
}

/**
 * Loads only the offline read-through mirror (never authoritative when backend is reachable).
 */
function loadOfflineMirror(shopId: string): CooccurrenceSnapshot {
  safeCleanupLegacyCache(shopId);
  try {
    if (typeof localStorage === 'undefined') {
      return createEmptyStore(shopId);
    }
    const raw = localStorage.getItem(getMirrorKey(shopId));
    if (!raw) return createEmptyStore(shopId);
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidSnapshotShape(parsed, shopId)) {
      localStorage.removeItem(getMirrorKey(shopId));
      return createEmptyStore(shopId);
    }
    return {
      version: COOCCURRENCE_CACHE_VERSION,
      shopId,
      revision: Math.max(0, Number(parsed.revision) || 0),
      totalCompletedSales: Math.max(0, Number(parsed.totalCompletedSales) || 0),
      saleCountsByProduct: parsed.saleCountsByProduct || {},
      pairCounts: parsed.pairCounts || {},
      processedSaleIds: parsed.processedSaleIds
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(-MAX_PROCESSED_SALE_IDS),
      updatedAt: Number(parsed.updatedAt) || Date.now(),
    };
  } catch {
    return createEmptyStore(shopId);
  }
}

function getOrCreateRuntimeState(shopId: string): ShopRuntimeState {
  ensureOnlineRecoveryListener();
  let state = runtimeStates.get(shopId);
  if (!state) {
    const store = loadOfflineMirror(shopId);
    state = {
      store,
      processedSet: new Set(store.processedSaleIds),
      authoritativeLoaded: false,
      dirtyRebuild: readDirtyFlag(shopId),
      persistTimer: null,
      backfillTimer: null,
      retryTimer: null,
      firestorePersistTimer: null,
      backfillGeneration: 0,
      hydrationInFlight: null,
      flushInFlight: null,
      lastFirestoreRevisionSaved: -1,
    };
    runtimeStates.set(shopId, state);
  }
  return state;
}

function flushOfflineMirror(shopId: string, state: ShopRuntimeState): void {
  try {
    if (typeof localStorage === 'undefined') return;
    state.store.updatedAt = Date.now();
    localStorage.setItem(getMirrorKey(shopId), JSON.stringify(state.store));
  } catch {
    // Never throw from background cache persistence
  }
}

function scheduleOfflineMirrorPersistence(shopId: string, state: ShopRuntimeState): void {
  if (typeof localStorage === 'undefined') return;
  if (state.persistTimer !== null) {
    clearTimeout(state.persistTimer);
  }
  state.persistTimer = setTimeout(() => {
    state.persistTimer = null;
    flushOfflineMirror(shopId, state);
  }, PERSIST_DEBOUNCE_MS);
}

function readPendingUpdates(shopId: string): PendingCooccurrenceItem[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(getPendingKey(shopId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PendingCooccurrenceItem[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      // Backward compatibility for legacy raw CooccurrenceSaleInput entries
      if ('saleId' in item && Array.isArray((item as CooccurrenceSaleInput).productIds)) {
        const legacy = item as CooccurrenceSaleInput;
        if (typeof legacy.saleId === 'string' && legacy.saleId.trim()) {
          out.push({
            sale: legacy,
            retryCount: 0,
            nextAttemptAt: 0,
          });
        }
        continue;
      }
      const wrapped = item as Partial<PendingCooccurrenceItem>;
      if (
        wrapped.sale &&
        typeof wrapped.sale === 'object' &&
        typeof wrapped.sale.saleId === 'string' &&
        Array.isArray(wrapped.sale.productIds)
      ) {
        out.push({
          sale: wrapped.sale,
          retryCount: Math.max(0, Number(wrapped.retryCount) || 0),
          nextAttemptAt: Math.max(0, Number(wrapped.nextAttemptAt) || 0),
          lastError: typeof wrapped.lastError === 'string' ? wrapped.lastError : undefined,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writePendingUpdates(shopId: string, items: PendingCooccurrenceItem[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (items.length === 0) {
      localStorage.removeItem(getPendingKey(shopId));
      return;
    }
    localStorage.setItem(getPendingKey(shopId), JSON.stringify(items.slice(-300)));
  } catch {
    // Ignore storage errors
  }
}

function queuePendingServerUpdate(
  shopId: string,
  sale: CooccurrenceSaleInput,
  options?: { error?: string; incrementRetry?: boolean }
): PendingCooccurrenceItem[] {
  const existing = readPendingUpdates(shopId);
  const now = Date.now();
  const idx = existing.findIndex((x) => x.sale.saleId === sale.saleId);

  if (idx === -1) {
    const nextRetry = options?.incrementRetry ? 1 : 0;
    const delayMs =
      nextRetry > 0
        ? RETRY_BACKOFF_MS[Math.min(nextRetry - 1, RETRY_BACKOFF_MS.length - 1)] || 30_000
        : RETRY_BACKOFF_MS[0];
    const next = [
      ...existing,
      {
        sale,
        retryCount: nextRetry,
        nextAttemptAt: now + delayMs,
        lastError: options?.error,
      },
    ];
    writePendingUpdates(shopId, next);
    return next;
  }

  const cur = existing[idx];
  const nextRetry = options?.incrementRetry ? cur.retryCount + 1 : cur.retryCount;
  if (nextRetry > MAX_RETRY_ATTEMPTS) {
    // Exceeded bounded retry budget: drop item safely (Owner reconciliation still catches it cleanly)
    const filtered = existing.filter((x) => x.sale.saleId !== sale.saleId);
    writePendingUpdates(shopId, filtered);
    return filtered;
  }

  const delayMs =
    RETRY_BACKOFF_MS[Math.min(Math.max(0, nextRetry - 1), RETRY_BACKOFF_MS.length - 1)] || 30_000;
  const updated = existing.map((x, i) =>
    i === idx
      ? {
          ...x,
          sale,
          retryCount: nextRetry,
          nextAttemptAt: now + delayMs,
          lastError: options?.error ?? x.lastError,
        }
      : x
  );
  writePendingUpdates(shopId, updated);
  return updated;
}

function removePendingServerUpdate(shopId: string, saleId: string): void {
  const existing = readPendingUpdates(shopId);
  if (existing.length === 0) return;
  writePendingUpdates(
    shopId,
    existing.filter((x) => x.sale.saleId !== saleId)
  );
}

function schedulePendingRetryTimer(shopId: string, items?: PendingCooccurrenceItem[]): void {
  const state = getOrCreateRuntimeState(shopId);
  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  const list = items ?? readPendingUpdates(shopId);
  if (list.length === 0 || !state.latestGetIdToken) return;

  const now = Date.now();
  const earliest = list.reduce(
    (min, item) => (item.nextAttemptAt < min ? item.nextAttemptAt : min),
    list[0].nextAttemptAt
  );
  const delayMs = Math.max(250, earliest - now);

  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (state.latestGetIdToken) {
      void flushPendingCooccurrenceUpdates({
        shopId,
        getIdToken: state.latestGetIdToken,
        fetchImpl: state.latestFetchImpl,
      });
    }
  }, delayMs);
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

function pruneIndexedProductsIfNeeded(snapshot: CooccurrenceSnapshot): void {
  const keys = Object.keys(snapshot.saleCountsByProduct);
  if (keys.length <= MAX_INDEXED_PRODUCTS) return;
  const keepSet = new Set(
    keys
      .sort((a, b) => (snapshot.saleCountsByProduct[b] || 0) - (snapshot.saleCountsByProduct[a] || 0))
      .slice(0, MAX_INDEXED_PRODUCTS)
  );
  for (const key of keys) {
    if (!keepSet.has(key)) {
      delete snapshot.saleCountsByProduct[key];
      delete snapshot.pairCounts[key];
    }
  }
  for (const neighbors of Object.values(snapshot.pairCounts)) {
    for (const neighborId of Object.keys(neighbors)) {
      if (!keepSet.has(neighborId)) {
        delete neighbors[neighborId];
      }
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

  // Mark sale processed even if single-item so we never rescan it during reconciliation
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

  pruneIndexedProductsIfNeeded(state.store);
  return true;
}

function applyAuthoritativeSnapshot(
  shopId: string,
  state: ShopRuntimeState,
  serverSnapshot: CooccurrenceSnapshot
): void {
  if (!isValidSnapshotShape(serverSnapshot, shopId)) return;
  state.store = {
    version: COOCCURRENCE_CACHE_VERSION,
    shopId,
    revision: serverSnapshot.revision,
    totalCompletedSales: serverSnapshot.totalCompletedSales,
    saleCountsByProduct: { ...serverSnapshot.saleCountsByProduct },
    pairCounts: Object.fromEntries(
      Object.entries(serverSnapshot.pairCounts).map(([k, v]) => [k, { ...v }])
    ),
    processedSaleIds: serverSnapshot.processedSaleIds.slice(-MAX_PROCESSED_SALE_IDS),
    updatedAt: serverSnapshot.updatedAt || Date.now(),
  };
  pruneIndexedProductsIfNeeded(state.store);
  state.processedSet = new Set(state.store.processedSaleIds);
  state.authoritativeLoaded = true;
  flushOfflineMirror(shopId, state);
}

function canUseFirestoreInstance(): boolean {
  return Boolean(db && typeof (db as { type?: unknown }).type === 'string');
}

async function loadCooccurrenceFromFirestore(shopId: string): Promise<CooccurrenceSnapshot | null> {
  if (!shopId || !canUseFirestoreInstance()) return null;
  try {
    const snap = await getDoc(doc(db, 'shops', shopId, 'upsellCache', UPSELL_CACHE_DOC_ID));
    if (!snap.exists()) return null;
    const raw = snap.data() as Record<string, unknown>;
    if (Number(raw.version) !== COOCCURRENCE_CACHE_VERSION) return null;
    const candidate: CooccurrenceSnapshot = {
      version: COOCCURRENCE_CACHE_VERSION,
      shopId,
      revision: Math.max(0, Number(raw.revision) || 0),
      totalCompletedSales: Math.max(0, Number(raw.totalCompletedSales) || 0),
      saleCountsByProduct:
        raw.saleCountsByProduct && typeof raw.saleCountsByProduct === 'object'
          ? (raw.saleCountsByProduct as Record<string, number>)
          : {},
      pairCounts:
        raw.pairCounts && typeof raw.pairCounts === 'object'
          ? (raw.pairCounts as Record<string, Record<string, number>>)
          : {},
      processedSaleIds: Array.isArray(raw.processedSaleIds)
        ? raw.processedSaleIds
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
            .slice(-MAX_PROCESSED_SALE_IDS)
        : [],
      updatedAt: Date.now(),
    };
    return isValidSnapshotShape(candidate, shopId) ? candidate : null;
  } catch {
    return null;
  }
}

async function persistCooccurrenceToFirestore(shopId: string, state: ShopRuntimeState): Promise<void> {
  if (!shopId || !canUseFirestoreInstance()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const snapshot = state.store;
  if (state.lastFirestoreRevisionSaved === snapshot.revision) return;

  const boundedCopy: CooccurrenceSnapshot = {
    version: COOCCURRENCE_CACHE_VERSION,
    shopId,
    revision: Math.max(0, Math.floor(snapshot.revision)),
    totalCompletedSales: Math.max(0, Math.floor(snapshot.totalCompletedSales)),
    saleCountsByProduct: { ...snapshot.saleCountsByProduct },
    pairCounts: Object.fromEntries(
      Object.entries(snapshot.pairCounts).map(([k, v]) => [k, { ...v }])
    ),
    processedSaleIds: snapshot.processedSaleIds.slice(-MAX_PROCESSED_SALE_IDS),
    updatedAt: snapshot.updatedAt,
  };
  pruneIndexedProductsIfNeeded(boundedCopy);

  try {
    const cacheRef = doc(db, 'shops', shopId, 'upsellCache', UPSELL_CACHE_DOC_ID);
    await runTransaction(db, async (tx) => {
      const existingSnap = await tx.get(cacheRef);
      if (existingSnap.exists()) {
        tx.update(cacheRef, {
          version: COOCCURRENCE_CACHE_VERSION,
          revision: boundedCopy.revision,
          totalCompletedSales: boundedCopy.totalCompletedSales,
          saleCountsByProduct: boundedCopy.saleCountsByProduct,
          pairCounts: boundedCopy.pairCounts,
          processedSaleIds: boundedCopy.processedSaleIds,
          updatedAt: serverTimestamp(),
        });
      } else {
        tx.set(cacheRef, {
          ownerUid: shopId,
          version: COOCCURRENCE_CACHE_VERSION,
          revision: boundedCopy.revision,
          totalCompletedSales: boundedCopy.totalCompletedSales,
          saleCountsByProduct: boundedCopy.saleCountsByProduct,
          pairCounts: boundedCopy.pairCounts,
          processedSaleIds: boundedCopy.processedSaleIds,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    });
    state.lastFirestoreRevisionSaved = boundedCopy.revision;
  } catch {
    // Firestore persistence failure must never disrupt POS or sales entry
  }
}

function scheduleFirestorePersistence(shopId: string, state: ShopRuntimeState): void {
  if (!state.latestIsOwner || !canUseFirestoreInstance()) return;
  if (state.firestorePersistTimer !== null) {
    clearTimeout(state.firestorePersistTimer);
  }
  state.firestorePersistTimer = setTimeout(() => {
    state.firestorePersistTimer = null;
    void persistCooccurrenceToFirestore(shopId, state);
  }, FIRESTORE_PERSIST_DEBOUNCE_MS);
}

interface PostSaleUpdateResult {
  ok: boolean;
  retryable: boolean;
  status?: number;
  error?: string;
}

async function postSingleSaleUpdateToBackend(params: {
  shopId: string;
  sale: CooccurrenceSaleInput;
  getIdToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): Promise<PostSaleUpdateResult> {
  const { shopId, sale, getIdToken, fetchImpl = fetch } = params;
  if (!getIdToken) return { ok: false, retryable: false, error: 'Missing token provider' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, retryable: true, error: 'Browser offline' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, retryable: false, error: 'Fetch unavailable' };
  }

  try {
    const token = await getIdToken();
    if (!token) {
      return { ok: false, retryable: true, status: 401, error: 'Empty auth token' };
    }
    const res = await fetchImpl('/api/upsell/cooccurrence/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(sale),
    });
    if (!res.ok) {
      // Permanent validation/permission errors (400/403/404) do not loop endlessly
      const isPermanentClientErr = res.status === 400 || res.status === 403 || res.status === 404;
      return {
        ok: false,
        retryable: !isPermanentClientErr,
        status: res.status,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { revision?: number };
    const state = getOrCreateRuntimeState(shopId);
    if (typeof body?.revision === 'number' && body.revision > state.store.revision) {
      state.store.revision = body.revision;
      scheduleOfflineMirrorPersistence(shopId, state);
    }
    scheduleFirestorePersistence(shopId, state);
    return { ok: true, retryable: false, status: res.status };
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

/**
 * Flushes any queued incremental co-occurrence updates due now with bounded exponential backoff.
 */
export async function flushPendingCooccurrenceUpdates(params: {
  shopId: string;
  getIdToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  forceDueNow?: boolean;
}): Promise<{ flushedCount: number; remainingCount: number }> {
  const { shopId, getIdToken, fetchImpl = fetch, forceDueNow = false } = params;
  if (!shopId || !getIdToken) return { flushedCount: 0, remainingCount: 0 };

  const state = getOrCreateRuntimeState(shopId);
  state.latestGetIdToken = getIdToken;
  state.latestFetchImpl = fetchImpl;

  if (state.flushInFlight) {
    await state.flushInFlight;
    return { flushedCount: 0, remainingCount: readPendingUpdates(shopId).length };
  }

  let flushedCount = 0;
  const run = (async () => {
    const pendingList = readPendingUpdates(shopId);
    if (pendingList.length === 0) return;

    const now = Date.now();
    for (const item of pendingList) {
      if (!forceDueNow && item.nextAttemptAt > now) continue;

      const result = await postSingleSaleUpdateToBackend({
        shopId,
        sale: item.sale,
        getIdToken,
        fetchImpl,
      });

      if (result.ok) {
        removePendingServerUpdate(shopId, item.sale.saleId);
        ingestSaleSync(state, item.sale);
        flushedCount += 1;
      } else if (!result.retryable) {
        removePendingServerUpdate(shopId, item.sale.saleId);
      } else {
        queuePendingServerUpdate(shopId, item.sale, {
          error: result.error,
          incrementRetry: true,
        });
      }
    }

    const remaining = readPendingUpdates(shopId);
    if (flushedCount > 0) {
      flushOfflineMirror(shopId, state);
    }
    if (remaining.length > 0) {
      schedulePendingRetryTimer(shopId, remaining);
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

  return { flushedCount, remainingCount: readPendingUpdates(shopId).length };
}

/**
 * Asynchronously updates both the in-memory O(1) index and the persistent shared
 * backend cache after a sale completes. Never blocks checkout or stock deductions.
 */
export function enqueueSaleCooccurrenceUpdate(
  shopId: string,
  saleId: string,
  productIds: string[],
  getIdToken?: () => Promise<string | null>,
  options?: { fetchImpl?: typeof fetch; isOwner?: boolean }
): void {
  if (!shopId || !saleId || !Array.isArray(productIds) || productIds.length === 0) return;

  const uniqueSnapshot = Array.from(new Set(productIds.filter(Boolean)));
  if (uniqueSnapshot.length === 0) return;

  const saleInput: CooccurrenceSaleInput = {
    saleId,
    status: 'completed',
    productIds: uniqueSnapshot,
  };

  setTimeout(() => {
    try {
      const state = getOrCreateRuntimeState(shopId);
      if (getIdToken) state.latestGetIdToken = getIdToken;
      if (options?.fetchImpl) state.latestFetchImpl = options.fetchImpl;
      if (options?.isOwner !== undefined) state.latestIsOwner = options.isOwner;

      const changed = ingestSaleSync(state, saleInput);
      if (changed) {
        scheduleOfflineMirrorPersistence(shopId, state);
      }

      if (getIdToken) {
        void postSingleSaleUpdateToBackend({
          shopId,
          sale: saleInput,
          getIdToken,
          fetchImpl: options?.fetchImpl,
        }).then((result) => {
          if (result.ok) {
            removePendingServerUpdate(shopId, saleId);
          } else if (result.retryable) {
            const nextQueue = queuePendingServerUpdate(shopId, saleInput, {
              error: result.error,
              incrementRetry: true,
            });
            schedulePendingRetryTimer(shopId, nextQueue);
          }
        });
      }
    } catch {
      // Background enhancement must never surface errors to POS checkout
    }
  }, 0);
}

/**
 * Marks the shop's co-occurrence cache for clean background reconciliation after an
 * existing sale is edited or cancelled so cancelled/removed products are excluded.
 * Never blocks sale mutation or scans history during Sales Entry.
 */
export function enqueueCooccurrenceMutationReconcile(shopId: string, saleId: string): void {
  if (!shopId) return;
  setTimeout(() => {
    try {
      const state = getOrCreateRuntimeState(shopId);
      state.dirtyRebuild = true;
      writeDirtyFlag(shopId, true);

      if (saleId) {
        removePendingServerUpdate(shopId, saleId);
        if (state.processedSet.has(saleId)) {
          state.processedSet.delete(saleId);
          state.store.processedSaleIds = state.store.processedSaleIds.filter((id) => id !== saleId);
          scheduleOfflineMirrorPersistence(shopId, state);
        }
      }
    } catch {
      // Never throw during background cleanup
    }
  }, 0);
}

export function isCooccurrenceRebuildDirty(shopId: string): boolean {
  if (!shopId) return false;
  return getOrCreateRuntimeState(shopId).dirtyRebuild;
}

/**
 * Hydrates the in-memory O(1) index from the persistent shared backend cache
 * (and Firestore durable backup if backend disk is cold or offline), flushes
 * any queued offline updates, and (for Owner/Admin) reconciles completed sales.
 */
export async function syncCooccurrenceWithBackend(params: {
  shopId: string;
  isOwner: boolean;
  getIdToken: () => Promise<string | null>;
  completedSales?: CooccurrenceSaleInput[];
  forceResetRebuild?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const {
    shopId,
    isOwner,
    getIdToken,
    completedSales = [],
    forceResetRebuild = false,
    fetchImpl = fetch,
  } = params;
  if (!shopId || !getIdToken) return;

  const state = getOrCreateRuntimeState(shopId);
  state.latestGetIdToken = getIdToken;
  state.latestFetchImpl = fetchImpl;
  state.latestIsOwner = isOwner;

  if (state.hydrationInFlight) {
    return state.hydrationInFlight;
  }

  const run = (async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (state.store.totalCompletedSales === 0) {
        const fsSnapshot = await loadCooccurrenceFromFirestore(shopId);
        if (fsSnapshot) {
          applyAuthoritativeSnapshot(shopId, state, fsSnapshot);
        }
      }
      if (completedSales.length > 0 && state.store.totalCompletedSales === 0) {
        scheduleCooccurrenceBackfill(shopId, completedSales);
      }
      return;
    }

    let token: string | null = null;
    try {
      token = await getIdToken();
    } catch {
      return;
    }
    if (!token) return;

    let backendReachable = false;
    try {
      const sinceQuery =
        state.authoritativeLoaded && state.store.revision > 0
          ? `?sinceRevision=${encodeURIComponent(String(state.store.revision))}`
          : '';

      const res = await fetchImpl(`/api/upsell/cooccurrence${sinceQuery}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        backendReachable = true;
        const body = (await res.json()) as {
          ok?: boolean;
          unchanged?: boolean;
          recovered?: boolean;
          snapshot?: CooccurrenceSnapshot;
        };

        if (body?.ok && !body.unchanged && body.snapshot) {
          applyAuthoritativeSnapshot(shopId, state, body.snapshot);
        } else if (body?.ok && body.unchanged) {
          state.authoritativeLoaded = true;
        }
      }
    } catch {
      backendReachable = false;
    }

    // If backend unreachable or returned cold empty cache, hydrate from Firestore durable doc
    if (!backendReachable || state.store.totalCompletedSales === 0) {
      const fsSnapshot = await loadCooccurrenceFromFirestore(shopId);
      if (
        fsSnapshot &&
        (fsSnapshot.totalCompletedSales > state.store.totalCompletedSales ||
          fsSnapshot.revision > state.store.revision)
      ) {
        applyAuthoritativeSnapshot(shopId, state, fsSnapshot);
      }
    }

    if (!backendReachable) {
      if (completedSales.length > 0) {
        scheduleCooccurrenceBackfill(shopId, completedSales);
      }
      return;
    }

    // Flush any queued incremental updates that are due (including reconnection recovery)
    await flushPendingCooccurrenceUpdates({
      shopId,
      getIdToken,
      fetchImpl,
      forceDueNow: true,
    });

    const shouldFullReset = Boolean(forceResetRebuild || state.dirtyRebuild);

    // Owner reconciliation: clean rebuild on edit/cancel OR incremental backfill of missing completed sales
    if (isOwner) {
      const validCompletedSales = completedSales.filter(
        (sale) => sale && sale.status !== 'cancelled' && sale.saleId && sale.productIds.length > 0
      );

      if (shouldFullReset) {
        // Send resetFirst on the first chunk (or an empty chunk if all sales were cancelled)
        const chunks: CooccurrenceSaleInput[][] = [];
        for (let i = 0; i < validCompletedSales.length; i += SERVER_REBUILD_BATCH_SIZE) {
          chunks.push(validCompletedSales.slice(i, i + SERVER_REBUILD_BATCH_SIZE));
        }
        if (chunks.length === 0) {
          chunks.push([]);
        }

        let rebuildSucceeded = true;
        const freshLocal = createEmptyStore(shopId);
        let latestRevision = state.store.revision;

        for (let idx = 0; idx < chunks.length; idx += 1) {
          const chunk = chunks[idx];
          try {
            const rebuildRes = await fetchImpl('/api/upsell/cooccurrence/rebuild', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                version: COOCCURRENCE_CACHE_VERSION,
                resetFirst: idx === 0,
                sales: chunk,
              }),
            });
            if (!rebuildRes.ok) {
              rebuildSucceeded = false;
              break;
            }
            const rebuildBody = (await rebuildRes.json()) as { revision?: number };
            if (typeof rebuildBody?.revision === 'number') {
              latestRevision = rebuildBody.revision;
            }
          } catch {
            rebuildSucceeded = false;
            break;
          }

          if (idx + 1 < chunks.length) {
            await new Promise((r) => setTimeout(r, 40));
          }
        }

        if (rebuildSucceeded) {
          state.store = freshLocal;
          state.processedSet = new Set();
          for (const s of validCompletedSales) {
            ingestSaleSync(state, s);
          }
          state.store.revision = Math.max(latestRevision, state.store.revision + 1);
          state.dirtyRebuild = false;
          writeDirtyFlag(shopId, false);
          flushOfflineMirror(shopId, state);
          scheduleFirestorePersistence(shopId, state);
        }
      } else if (validCompletedSales.length > 0) {
        const missingSales = validCompletedSales.filter((sale) => !state.processedSet.has(sale.saleId));
        if (missingSales.length > 0) {
          for (let i = 0; i < missingSales.length; i += SERVER_REBUILD_BATCH_SIZE) {
            const chunk = missingSales.slice(i, i + SERVER_REBUILD_BATCH_SIZE);
            try {
              const rebuildRes = await fetchImpl('/api/upsell/cooccurrence/rebuild', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                  version: COOCCURRENCE_CACHE_VERSION,
                  sales: chunk,
                }),
              });
              if (rebuildRes.ok) {
                for (const s of chunk) {
                  ingestSaleSync(state, s);
                }
                const rebuildBody = (await rebuildRes.json()) as { revision?: number };
                if (typeof rebuildBody?.revision === 'number') {
                  state.store.revision = rebuildBody.revision;
                }
              }
            } catch {
              break;
            }

            if (i + SERVER_REBUILD_BATCH_SIZE < missingSales.length) {
              await new Promise((r) => setTimeout(r, 40));
            }
          }
          flushOfflineMirror(shopId, state);
          scheduleFirestorePersistence(shopId, state);
        } else if (state.store.totalCompletedSales > 0 && state.lastFirestoreRevisionSaved < 0) {
          scheduleFirestorePersistence(shopId, state);
        }
      }
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

/**
 * Incrementally backfills historical completed sales into the local in-memory index
 * in small non-blocking chunks when offline or in local fallback mode.
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
        scheduleOfflineMirrorPersistence(shopId, state);
      }
    } catch {
      // Never block app execution
    }
  };

  state.backfillTimer = setTimeout(processNextChunk, 24);
}

/**
 * Synchronous helper for unit tests or explicit local ingestion.
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
    flushOfflineMirror(shopId, state);
  }
  return ingested;
}

export function resetCooccurrenceStore(shopId: string): void {
  const existing = runtimeStates.get(shopId);
  if (existing) {
    if (existing.persistTimer !== null) clearTimeout(existing.persistTimer);
    if (existing.backfillTimer !== null) clearTimeout(existing.backfillTimer);
    if (existing.retryTimer !== null) clearTimeout(existing.retryTimer);
    if (existing.firestorePersistTimer !== null) clearTimeout(existing.firestorePersistTimer);
  }
  runtimeStates.delete(shopId);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(getMirrorKey(shopId));
      localStorage.removeItem(getPendingKey(shopId));
      localStorage.removeItem(getDirtyKey(shopId));
      localStorage.removeItem(`${LEGACY_V1_PREFIX}${shopId}`);
    }
  } catch {
    // Ignore storage errors
  }
}

export function getCooccurrenceStatsSnapshot(shopId: string): {
  version: number;
  revision: number;
  authoritativeLoaded: boolean;
  dirtyRebuild: boolean;
  pendingRetryCount: number;
  totalCompletedSales: number;
  indexedProducts: number;
  processedSaleCount: number;
} {
  if (!shopId) {
    return {
      version: COOCCURRENCE_CACHE_VERSION,
      revision: 0,
      authoritativeLoaded: false,
      dirtyRebuild: false,
      pendingRetryCount: 0,
      totalCompletedSales: 0,
      indexedProducts: 0,
      processedSaleCount: 0,
    };
  }
  const state = getOrCreateRuntimeState(shopId);
  return {
    version: state.store.version,
    revision: state.store.revision,
    authoritativeLoaded: state.authoritativeLoaded,
    dirtyRebuild: state.dirtyRebuild,
    pendingRetryCount: readPendingUpdates(shopId).length,
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
    const qtyWeight = Math.min(2.4, 1 + Math.log1p(Math.max(0, anchorEffQty - 1)) * 0.45);

    for (const [targetId, pairCount] of Object.entries(neighbors)) {
      if (!pairCount || pairCount <= 0) continue;
      if (cartEffectiveQtyById.has(targetId)) continue;

      const targetSalesCount = Math.max(1, saleCountsByProduct[targetId] || pairCount);
      const confidence = Math.min(1, pairCount / anchorSalesCount);
      const targetBaselineProb = targetSalesCount / globalSalesDenominator;
      const rawLift = targetBaselineProb > 0 ? confidence / targetBaselineProb : 1;
      const boundedLift = Math.min(4, Math.max(0.5, rawLift));

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
