import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  COOCCURRENCE_CACHE_VERSION,
  type CooccurrenceSaleInput,
  type CooccurrenceSnapshot,
  MAX_INDEXED_PRODUCTS,
  MAX_NEIGHBORS_PER_PRODUCT,
  MAX_PROCESSED_SALE_IDS,
} from '../shared/upsellCacheSchema.ts';

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), '.caremart-cache');

interface ServerShopRuntimeState {
  snapshot: CooccurrenceSnapshot;
  processedSet: Set<string>;
  recovered: boolean;
}

const shopMemoryCaches = new Map<string, ServerShopRuntimeState>();

function getCacheFilePath(shopId: string, cacheDir = DEFAULT_CACHE_DIR): string {
  const shopHash = crypto.createHash('sha256').update(shopId).digest('hex').slice(0, 24);
  return path.join(cacheDir, `cooccurrence_v${COOCCURRENCE_CACHE_VERSION}_${shopHash}.json`);
}

function createEmptySnapshot(shopId: string): CooccurrenceSnapshot {
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

function isPlainNumberMap(obj: unknown): obj is Record<string, number> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  for (const val of Object.values(obj as Record<string, unknown>)) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return false;
  }
  return true;
}

function isValidPairCounts(obj: unknown): obj is Record<string, Record<string, number>> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  for (const neighbors of Object.values(obj as Record<string, unknown>)) {
    if (!isPlainNumberMap(neighbors)) return false;
  }
  return true;
}

function validateSnapshot(raw: unknown, expectedShopId: string): CooccurrenceSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<CooccurrenceSnapshot>;
  if (candidate.version !== COOCCURRENCE_CACHE_VERSION) return null;
  if (candidate.shopId !== expectedShopId) return null;
  if (
    typeof candidate.revision !== 'number' ||
    !Number.isFinite(candidate.revision) ||
    candidate.revision < 0
  ) {
    return null;
  }
  if (
    typeof candidate.totalCompletedSales !== 'number' ||
    !Number.isFinite(candidate.totalCompletedSales) ||
    candidate.totalCompletedSales < 0
  ) {
    return null;
  }
  if (!isPlainNumberMap(candidate.saleCountsByProduct)) return null;
  if (!isValidPairCounts(candidate.pairCounts)) return null;
  if (!Array.isArray(candidate.processedSaleIds)) return null;

  const cleanProcessed = candidate.processedSaleIds.filter(
    (id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 128
  );

  return {
    version: COOCCURRENCE_CACHE_VERSION,
    shopId: expectedShopId,
    revision: Math.floor(candidate.revision),
    totalCompletedSales: Math.floor(candidate.totalCompletedSales),
    saleCountsByProduct: { ...candidate.saleCountsByProduct },
    pairCounts: Object.fromEntries(
      Object.entries(candidate.pairCounts).map(([k, v]) => [k, { ...v }])
    ),
    processedSaleIds: cleanProcessed,
    updatedAt: Number(candidate.updatedAt) || Date.now(),
  };
}

function writeSnapshotAtomic(
  shopId: string,
  snapshot: CooccurrenceSnapshot,
  cacheDir = DEFAULT_CACHE_DIR
): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const targetPath = getCacheFilePath(shopId, cacheDir);
    const tmpPath = `${targetPath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch {
    // Cache persistence failures must never disrupt POS routes
  }
}

function loadOrCreateState(
  shopId: string,
  cacheDir = DEFAULT_CACHE_DIR
): ServerShopRuntimeState {
  const memKey = `${cacheDir}::${shopId}`;
  const existing = shopMemoryCaches.get(memKey);
  if (existing) return existing;

  let snapshot: CooccurrenceSnapshot | null = null;
  let recovered = false;
  const targetPath = getCacheFilePath(shopId, cacheDir);

  try {
    if (fs.existsSync(targetPath)) {
      const rawText = fs.readFileSync(targetPath, 'utf8');
      const parsed = JSON.parse(rawText) as unknown;
      snapshot = validateSnapshot(parsed, shopId);
      if (!snapshot) {
        // Corrupt or mismatched schema version: safely recover fresh v2 store
        recovered = true;
      }
    }
  } catch {
    recovered = true;
    snapshot = null;
  }

  if (!snapshot) {
    snapshot = createEmptySnapshot(shopId);
    if (recovered) {
      writeSnapshotAtomic(shopId, snapshot, cacheDir);
    }
  }

  const state: ServerShopRuntimeState = {
    snapshot,
    processedSet: new Set(snapshot.processedSaleIds),
    recovered,
  };
  shopMemoryCaches.set(memKey, state);
  return state;
}

function pruneWeakNeighborsIfNeeded(neighbors: Record<string, number>): void {
  const keys = Object.keys(neighbors);
  if (keys.length <= MAX_NEIGHBORS_PER_PRODUCT * 2) return;
  const keep = new Set(
    keys
      .sort((a, b) => (neighbors[b] || 0) - (neighbors[a] || 0))
      .slice(0, MAX_NEIGHBORS_PER_PRODUCT)
  );
  for (const key of keys) {
    if (!keep.has(key)) {
      delete neighbors[key];
    }
  }
}

function pruneIndexedProductsIfNeeded(snapshot: CooccurrenceSnapshot): void {
  const productKeys = Object.keys(snapshot.saleCountsByProduct);
  if (productKeys.length <= MAX_INDEXED_PRODUCTS) return;
  const keep = new Set(
    productKeys
      .sort((a, b) => (snapshot.saleCountsByProduct[b] || 0) - (snapshot.saleCountsByProduct[a] || 0))
      .slice(0, MAX_INDEXED_PRODUCTS)
  );
  for (const key of productKeys) {
    if (!keep.has(key)) {
      delete snapshot.saleCountsByProduct[key];
      delete snapshot.pairCounts[key];
    }
  }
  for (const neighbors of Object.values(snapshot.pairCounts)) {
    for (const neighborId of Object.keys(neighbors)) {
      if (!keep.has(neighborId)) {
        delete neighbors[neighborId];
      }
    }
  }
}

function applyCompletedSaleSync(
  state: ServerShopRuntimeState,
  sale: CooccurrenceSaleInput
): boolean {
  const saleId = typeof sale.saleId === 'string' ? sale.saleId.trim().slice(0, 128) : '';
  if (!saleId || sale.status === 'cancelled') return false;
  if (state.processedSet.has(saleId)) return false;

  const uniqueProductIds = Array.from(
    new Set(
      (Array.isArray(sale.productIds) ? sale.productIds : [])
        .map((id) => (typeof id === 'string' ? id.trim().slice(0, 128) : ''))
        .filter((id) => id.length > 0)
    )
  );

  state.processedSet.add(saleId);
  state.snapshot.processedSaleIds.push(saleId);
  if (state.snapshot.processedSaleIds.length > MAX_PROCESSED_SALE_IDS) {
    const excess = state.snapshot.processedSaleIds.length - MAX_PROCESSED_SALE_IDS;
    const removed = state.snapshot.processedSaleIds.splice(0, excess);
    for (const oldId of removed) {
      state.processedSet.delete(oldId);
    }
  }

  if (uniqueProductIds.length === 0) return true;

  state.snapshot.totalCompletedSales += 1;
  for (const pid of uniqueProductIds) {
    state.snapshot.saleCountsByProduct[pid] =
      (state.snapshot.saleCountsByProduct[pid] || 0) + 1;
  }

  if (uniqueProductIds.length >= 2) {
    const boundedIds = uniqueProductIds.slice(0, 40);
    for (let i = 0; i < boundedIds.length; i += 1) {
      const a = boundedIds[i];
      if (!state.snapshot.pairCounts[a]) {
        state.snapshot.pairCounts[a] = {};
      }
      const neighborsA = state.snapshot.pairCounts[a];
      for (let j = i + 1; j < boundedIds.length; j += 1) {
        const b = boundedIds[j];
        if (!state.snapshot.pairCounts[b]) {
          state.snapshot.pairCounts[b] = {};
        }
        neighborsA[b] = (neighborsA[b] || 0) + 1;
        state.snapshot.pairCounts[b][a] = (state.snapshot.pairCounts[b][a] || 0) + 1;
      }
      pruneWeakNeighborsIfNeeded(neighborsA);
    }
  }

  pruneIndexedProductsIfNeeded(state.snapshot);
  return true;
}

export function getServerCooccurrenceSnapshot(
  shopId: string,
  cacheDir = DEFAULT_CACHE_DIR
): { snapshot: CooccurrenceSnapshot; recovered: boolean } {
  const state = loadOrCreateState(shopId, cacheDir);
  return {
    snapshot: state.snapshot,
    recovered: state.recovered,
  };
}

export function hydrateServerCooccurrenceFromExternalSnapshot(
  shopId: string,
  externalRaw: unknown,
  cacheDir = DEFAULT_CACHE_DIR
): CooccurrenceSnapshot | null {
  const validated = validateSnapshot(externalRaw, shopId);
  if (!validated) return null;

  pruneIndexedProductsIfNeeded(validated);
  if (validated.processedSaleIds.length > MAX_PROCESSED_SALE_IDS) {
    validated.processedSaleIds = validated.processedSaleIds.slice(-MAX_PROCESSED_SALE_IDS);
  }

  const current = loadOrCreateState(shopId, cacheDir);
  if (
    current.snapshot.totalCompletedSales > 0 &&
    current.snapshot.revision >= validated.revision
  ) {
    return current.snapshot;
  }

  const nextState: ServerShopRuntimeState = {
    snapshot: validated,
    processedSet: new Set(validated.processedSaleIds),
    recovered: false,
  };
  shopMemoryCaches.set(`${cacheDir}::${shopId}`, nextState);
  writeSnapshotAtomic(shopId, validated, cacheDir);
  return nextState.snapshot;
}

export function recordServerCooccurrenceBatch(
  shopId: string,
  sales: CooccurrenceSaleInput[],
  options?: { resetFirst?: boolean; cacheDir?: string }
): {
  snapshot: CooccurrenceSnapshot;
  ingestedCount: number;
  skippedDuplicateCount: number;
} {
  const cacheDir = options?.cacheDir || DEFAULT_CACHE_DIR;
  let state = loadOrCreateState(shopId, cacheDir);

  if (options?.resetFirst) {
    const fresh = createEmptySnapshot(shopId);
    fresh.revision = state.snapshot.revision + 1;
    state = {
      snapshot: fresh,
      processedSet: new Set(),
      recovered: false,
    };
    shopMemoryCaches.set(`${cacheDir}::${shopId}`, state);
  }

  let ingestedCount = 0;
  let skippedDuplicateCount = 0;

  for (const sale of sales) {
    if (!sale || typeof sale.saleId !== 'string') continue;
    const saleId = sale.saleId.trim().slice(0, 128);
    if (saleId && state.processedSet.has(saleId)) {
      skippedDuplicateCount += 1;
      continue;
    }
    if (applyCompletedSaleSync(state, sale)) {
      ingestedCount += 1;
    }
  }

  if (ingestedCount > 0 || options?.resetFirst) {
    state.snapshot.revision += 1;
    state.snapshot.updatedAt = Date.now();
    writeSnapshotAtomic(shopId, state.snapshot, cacheDir);
  }

  return {
    snapshot: state.snapshot,
    ingestedCount,
    skippedDuplicateCount,
  };
}

export function evictServerMemoryCache(
  shopId: string,
  cacheDir = DEFAULT_CACHE_DIR
): void {
  shopMemoryCaches.delete(`${cacheDir}::${shopId}`);
}

export function resetServerCooccurrenceStore(
  shopId: string,
  cacheDir = DEFAULT_CACHE_DIR
): void {
  shopMemoryCaches.delete(`${cacheDir}::${shopId}`);
  try {
    const filePath = getCacheFilePath(shopId, cacheDir);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}
