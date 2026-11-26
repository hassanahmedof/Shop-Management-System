import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryBatch, Product, StaffCatalogItem, StaffMember, StaffSale } from '../types/shop';

const sim = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  versions: new Map<string, number>(),
  autoIdSeq: 1,
  latency: {
    queryMs: 0,
    docMs: 0,
    txReadMs: 0,
    txCommitMs: 0,
  },
  failMode: 'none' as 'none' | 'unavailable' | 'timeout',
  metrics: {
    getDocCalls: 0,
    getDocsCalls: 0,
    docsScanned: 0,
    txAttempts: 0,
    txCommits: 0,
    txConflicts: 0,
    txGetCalls: 0,
    txSetCalls: 0,
    txUpdateCalls: 0,
    txDeleteCalls: 0,
    lastTxWrites: 0,
    maxTxWrites: 0,
  },
  resetMetrics() {
    this.metrics.getDocCalls = 0;
    this.metrics.getDocsCalls = 0;
    this.metrics.docsScanned = 0;
    this.metrics.txAttempts = 0;
    this.metrics.txCommits = 0;
    this.metrics.txConflicts = 0;
    this.metrics.txGetCalls = 0;
    this.metrics.txSetCalls = 0;
    this.metrics.txUpdateCalls = 0;
    this.metrics.txDeleteCalls = 0;
    this.metrics.lastTxWrites = 0;
    this.metrics.maxTxWrites = 0;
  },
}));

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

vi.mock('../lib/firebase', () => ({
  auth: {
    currentUser: {
      uid: 'owner_shop_bench',
      displayName: 'Bench Owner',
      email: 'owner@bench.test',
      getIdToken: async () => 'bench-token',
    },
  },
  db: { __simFirestore: true },
  getStaffProvisionAuth: () => ({}),
  OperationType: {
    CREATE: 'create',
    UPDATE: 'update',
    DELETE: 'delete',
    LIST: 'list',
    GET: 'get',
    WRITE: 'write',
  },
  handleFirestoreError: (err: unknown) => {
    throw err instanceof Error ? err : new Error(String(err));
  },
}));

vi.mock('./upsellCooccurrenceService', () => ({
  enqueueSaleCooccurrenceUpdate: vi.fn(),
  enqueueCooccurrenceMutationReconcile: vi.fn(),
}));

vi.mock('firebase/firestore', () => {
  const collection = (_db: unknown, ...segments: string[]) => ({
    __type: 'collection',
    path: segments.join('/'),
  });

  const doc = (parentOrDb: unknown, ...segments: string[]) => {
    if (
      parentOrDb &&
      typeof parentOrDb === 'object' &&
      (parentOrDb as { __type?: string }).__type === 'collection' &&
      segments.length === 0
    ) {
      const id = `auto_${sim.autoIdSeq++}`;
      const base = (parentOrDb as { path: string }).path;
      return { __type: 'doc', id, path: `${base}/${id}` };
    }
    const path = segments.join('/');
    const parts = path.split('/');
    return { __type: 'doc', id: parts[parts.length - 1], path };
  };

  const where = (field: string, op: string, value: unknown) => ({
    __type: 'where',
    field,
    op,
    value,
  });

  const limit = (count: number) => ({ __type: 'limit', count });

  const query = (
    colRef: { __type: string; path: string },
    ...constraints: Array<{ __type: string; field?: string; op?: string; value?: unknown; count?: number }>
  ) => ({
    __type: 'query',
    path: colRef.path,
    constraints,
  });

  const makeSnap = (docPath: string, data: Record<string, unknown> | undefined) => {
    const id = docPath.split('/').pop() || '';
    return {
      id,
      exists: () => Boolean(data),
      data: () => (data ? structuredClone(data) : undefined),
    };
  };

  const maybeFailNetwork = () => {
    if (sim.failMode === 'unavailable') {
      const err = new Error('Firestore backend unavailable') as Error & { code?: string };
      err.code = 'unavailable';
      throw err;
    }
    if (sim.failMode === 'timeout') {
      const err = new Error('Firestore deadline exceeded') as Error & { code?: string };
      err.code = 'deadline-exceeded';
      throw err;
    }
  };

  const getDoc = async (ref: { path: string }) => {
    sim.metrics.getDocCalls += 1;
    await sleep(sim.latency.docMs);
    maybeFailNetwork();
    return makeSnap(ref.path, sim.docs.get(ref.path));
  };

  const getDocs = async (q: {
    __type: string;
    path: string;
    constraints?: Array<{ __type: string; field?: string; op?: string; value?: unknown; count?: number }>;
  }) => {
    sim.metrics.getDocsCalls += 1;
    await sleep(sim.latency.queryMs);
    maybeFailNetwork();

    const prefix = `${q.path}/`;
    const matched: Array<{ id: string; data: () => Record<string, unknown> }> = [];
    let maxCount: number | null = null;

    for (const c of q.constraints || []) {
      if (c.__type === 'limit' && typeof c.count === 'number') {
        maxCount = c.count;
      }
      if (c.__type === 'where' && c.op === 'in' && Array.isArray(c.value) && c.value.length > 30) {
        throw new Error('INVALID_ARGUMENT: IN supports a maximum of 30 values');
      }
    }

    for (const [docPath, raw] of sim.docs.entries()) {
      if (!docPath.startsWith(prefix)) continue;
      const remainder = docPath.slice(prefix.length);
      if (remainder.includes('/')) continue;

      let ok = true;
      for (const c of q.constraints || []) {
        if (c.__type === 'where' && c.field) {
          if (c.op === '==' && raw[c.field] !== c.value) {
            ok = false;
            break;
          }
          if (c.op === 'in' && Array.isArray(c.value) && !c.value.includes(raw[c.field])) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;

      sim.metrics.docsScanned += 1;
      matched.push({
        id: remainder,
        data: () => structuredClone(raw),
      });
      if (maxCount !== null && matched.length >= maxCount) break;
    }

    return {
      empty: matched.length === 0,
      docs: matched,
    };
  };

  const runTransaction = async (
    _db: unknown,
    updateFn: (tx: {
      get: (ref: { path: string }) => Promise<ReturnType<typeof makeSnap>>;
      set: (ref: { path: string }, data: Record<string, unknown>) => void;
      update: (ref: { path: string }, patch: Record<string, unknown>) => void;
      delete: (ref: { path: string }) => void;
    }) => Promise<unknown>
  ) => {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      sim.metrics.txAttempts += 1;
      const readVersions = new Map<string, number>();
      const stagedWrites = new Map<string, { kind: 'set' | 'update' | 'delete'; payload?: Record<string, unknown> }>();
      let hasWritten = false;

      const tx = {
        get: async (ref: { path: string }) => {
          if (hasWritten) {
            throw new Error('Firestore transactions require all reads to be executed before all writes.');
          }
          sim.metrics.txGetCalls += 1;
          await sleep(sim.latency.txReadMs);
          maybeFailNetwork();
          if (!readVersions.has(ref.path)) {
            readVersions.set(ref.path, sim.versions.get(ref.path) || 0);
          }
          return makeSnap(ref.path, sim.docs.get(ref.path));
        },
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          hasWritten = true;
          sim.metrics.txSetCalls += 1;
          stagedWrites.set(ref.path, { kind: 'set', payload: structuredClone(data) });
        },
        update: (ref: { path: string }, patch: Record<string, unknown>) => {
          hasWritten = true;
          sim.metrics.txUpdateCalls += 1;
          const prev = stagedWrites.get(ref.path);
          if (prev && prev.kind !== 'delete' && prev.payload) {
            stagedWrites.set(ref.path, {
              kind: prev.kind,
              payload: { ...prev.payload, ...structuredClone(patch) },
            });
          } else {
            stagedWrites.set(ref.path, { kind: 'update', payload: structuredClone(patch) });
          }
        },
        delete: (ref: { path: string }) => {
          hasWritten = true;
          sim.metrics.txDeleteCalls += 1;
          stagedWrites.set(ref.path, { kind: 'delete' });
        },
      };

      const res = await updateFn(tx);

      // Simulate commit RTT and OCC check
      await sleep(sim.latency.txCommitMs);
      maybeFailNetwork();

      const writeCount = stagedWrites.size;
      sim.metrics.lastTxWrites = writeCount;
      if (writeCount > sim.metrics.maxTxWrites) sim.metrics.maxTxWrites = writeCount;

      if (writeCount > 500) {
        const limitErr = new Error(
          `3 INVALID_ARGUMENT: maximum 500 writes allowed per request (attempted ${writeCount})`
        ) as Error & { code?: string };
        limitErr.code = 'invalid-argument';
        throw limitErr;
      }

      let conflict = false;
      for (const [docPath, expectedVer] of readVersions.entries()) {
        if ((sim.versions.get(docPath) || 0) !== expectedVer) {
          conflict = true;
          break;
        }
      }

      if (conflict) {
        sim.metrics.txConflicts += 1;
        if (attempt === MAX_ATTEMPTS) {
          const abortedErr = new Error('ABORTED: Transaction contention max retries exceeded') as Error & {
            code?: string;
          };
          abortedErr.code = 'aborted';
          throw abortedErr;
        }
        continue;
      }

      for (const [docPath, op] of stagedWrites.entries()) {
        const nextVer = (sim.versions.get(docPath) || 0) + 1;
        sim.versions.set(docPath, nextVer);
        if (op.kind === 'delete') {
          sim.docs.delete(docPath);
        } else if (op.kind === 'set') {
          sim.docs.set(docPath, op.payload || {});
        } else {
          const cur = sim.docs.get(docPath) || {};
          sim.docs.set(docPath, { ...cur, ...(op.payload || {}) });
        }
      }
      sim.metrics.txCommits += 1;
      return res;
    }
    throw new Error('Transaction failed');
  };

  const writeBatch = () => {
    const ops: Array<() => void> = [];
    return {
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        ops.push(() => sim.docs.set(ref.path, structuredClone(data)));
      },
      update: (ref: { path: string }, patch: Record<string, unknown>) => {
        ops.push(() => {
          const cur = sim.docs.get(ref.path) || {};
          sim.docs.set(ref.path, { ...cur, ...structuredClone(patch) });
        });
      },
      delete: (ref: { path: string }) => {
        ops.push(() => sim.docs.delete(ref.path));
      },
      commit: async () => {
        await sleep(sim.latency.txCommitMs);
        for (const op of ops) op();
      },
    };
  };

  return {
    collection,
    doc,
    where,
    limit,
    query,
    getDoc,
    getDocs,
    runTransaction,
    writeBatch,
    deleteDoc: async (ref: { path: string }) => {
      sim.docs.delete(ref.path);
    },
    setDoc: async (ref: { path: string }, data: Record<string, unknown>) => {
      sim.docs.set(ref.path, structuredClone(data));
    },
    updateDoc: async (ref: { path: string }, patch: Record<string, unknown>) => {
      const cur = sim.docs.get(ref.path) || {};
      sim.docs.set(ref.path, { ...cur, ...structuredClone(patch) });
    },
    deleteField: () => ({ __deleteField: true }),
    serverTimestamp: () => 'SERVER_TIMESTAMP',
  };
});

import {
  __resetDiscordQueueMemoryForTest,
  getDiscordQueueJobs,
} from './discordNotificationService';
import {
  __resetSheetsQueueMemoryForTest,
  getSheetsQueueTasks,
} from './backgroundTaskQueue';
import {
  createAndEnqueueOfflineSale,
  getQueuedOfflineSales,
  syncQueuedOfflineSales,
} from './offlineSyncService';
import { cancelSale, createSale, editSale, type SaleLineDraft } from './shopService';
import { createStaffSale, reconcileStaffSaleToOwnerLedger } from './staffService';

const UID = 'owner_shop_bench';

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function summarize(times: number[]) {
  return {
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: Number(Math.max(...times).toFixed(2)),
  };
}

function seedShopCatalog(productCount = 220, batchesPerProduct = 3, exhaustedBatchesPerProduct = 2) {
  sim.docs.clear();
  sim.versions.clear();
  sim.autoIdSeq = 1;

  for (let i = 1; i <= productCount; i += 1) {
    const pid = `prod_${String(i).padStart(3, '0')}`;
    const isMultiUnit = i % 3 === 0;
    const isFractional = i % 10 === 0;
    const unit = isFractional ? 'kg' : 'Piece';
    const currentStock = 240;

    const prod: Product = {
      id: pid,
      ownerUid: UID,
      name: `Bench Product ${i}`,
      categoryId: `cat_${(i % 8) + 1}`,
      categoryName: `Category ${(i % 8) + 1}`,
      brandId: `brand_${(i % 12) + 1}`,
      brandName: `Brand ${(i % 12) + 1}`,
      purchasePrice: 90,
      salePrice: 140,
      wholesalePrice: 125,
      currentStock,
      minStockLevel: 5,
      maxStockLevel: 500,
      unit,
      baseUnit: unit,
      packagingUnits: isMultiUnit
        ? [
            {
              unitName: 'Piece',
              conversionQty: 1,
              allowPurchase: true,
              allowSale: true,
              purchasePrice: 90,
              salePrice: 140,
              wholesalePrice: 125,
              isDefaultSale: true,
            },
            {
              unitName: 'Box',
              conversionQty: 12,
              containsQty: 12,
              parentUnitName: 'Piece',
              allowPurchase: true,
              allowSale: true,
              purchasePrice: 1080,
              salePrice: 1620,
              wholesalePrice: 1500,
            },
          ]
        : undefined,
      supplierId: 'sup_1',
      supplierName: 'Bench Traders',
      expiryDate: '',
      profitMarginPct: 35.7,
      isActive: true,
    };

    const staffItem: StaffCatalogItem = {
      id: pid,
      ownerUid: UID,
      productId: pid,
      name: prod.name,
      categoryName: prod.categoryName,
      brandName: prod.brandName,
      salePrice: prod.salePrice,
      wholesalePrice: prod.wholesalePrice,
      currentStock: prod.currentStock,
      unit: prod.unit,
      baseUnit: prod.baseUnit,
      packagingUnits: prod.packagingUnits?.map((u) => ({
        unitName: u.unitName,
        conversionQty: u.conversionQty,
        allowSale: u.allowSale,
        salePrice: u.salePrice,
        wholesalePrice: u.wholesalePrice,
        isDefaultSale: u.isDefaultSale,
      })),
      isActive: true,
      allowedStaffUids: ['staff_auth_1'],
    };

    sim.docs.set(`shops/${UID}/products/${pid}`, prod as unknown as Record<string, unknown>);
    sim.docs.set(`shops/${UID}/staffCatalog/${pid}`, staffItem as unknown as Record<string, unknown>);

    // Active FIFO batches (each 80 base units -> 3 * 80 = 240 stock, varying costs 80, 90, 100)
    for (let b = 1; b <= batchesPerProduct; b += 1) {
      const bid = `${pid}_batch_${b}`;
      const batch: Omit<InventoryBatch, 'id'> = {
        ownerUid: UID,
        purchaseId: `pur_${b}`,
        purchaseNumber: `PR-00${b}`,
        purchaseDate: `2026-01-0${b}`,
        productId: pid,
        productName: prod.name,
        supplierId: 'sup_1',
        supplierName: 'Bench Traders',
        initialBaseQty: 80,
        remainingBaseQty: 80,
        unitCostInBase: 70 + b * 10,
        expiryDate: '',
        status: 'active',
      };
      sim.docs.set(`shops/${UID}/inventoryBatches/${bid}`, batch as unknown as Record<string, unknown>);
    }

    // Historical exhausted batches (realistic mature-shop noise)
    for (let e = 1; e <= exhaustedBatchesPerProduct; e += 1) {
      const bid = `${pid}_exh_${e}`;
      sim.docs.set(`shops/${UID}/inventoryBatches/${bid}`, {
        ownerUid: UID,
        purchaseId: `pur_old_${e}`,
        purchaseDate: `2025-12-0${e}`,
        productId: pid,
        productName: prod.name,
        initialBaseQty: 50,
        remainingBaseQty: 0,
        unitCostInBase: 75,
        status: 'exhausted',
      });
    }
  }
}

function buildSaleDraftItems(
  size: number,
  options?: { repeated?: boolean; multiUnit?: boolean; discount?: boolean; qtyOverride?: number }
): SaleLineDraft[] {
  const items: SaleLineDraft[] = [];
  for (let i = 0; i < size; i += 1) {
    const idx = options?.repeated ? (i % 15) + 1 : i + 1;
    const pid = `prod_${String(idx).padStart(3, '0')}`;
    const useBox = options?.multiUnit && idx % 3 === 0;
    const isFrac = idx % 10 === 0;
    const baseQty = options?.qtyOverride ?? (isFrac ? 1.5 : 2);
    items.push({
      productId: pid,
      unitName: useBox ? 'Box' : isFrac ? 'kg' : 'Piece',
      conversionFactor: useBox ? 12 : 1,
      quantity: baseQty,
      salePricePerUnit: options?.discount ? (useBox ? 1500 : 125) : useBox ? 1620 : 140,
    });
  }
  return items;
}

const OWNER_SELLER = {
  staffId: 'owner_primary',
  staffName: 'Bench Owner (Admin)',
};

const STAFF_1: StaffMember = {
  id: 'staff_1',
  ownerUid: UID,
  shopId: UID,
  shopCode: 'bench_s',
  name: 'Ali Staff',
  phone: '03001234567',
  username: 'ali',
  usernameLower: 'ali',
  authUid: 'staff_auth_1',
  loginVersion: 1,
  role: 'sales_staff',
  permissions: {
    canAddSales: true,
    canViewOwnSales: true,
    canViewStock: true,
  },
  isActive: true,
};

describe('Sales Entry Service & Firebase Load Benchmarks', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetDiscordQueueMemoryForTest();
    __resetSheetsQueueMemoryForTest();
    sim.failMode = 'none';
    sim.latency = { queryMs: 0, docMs: 0, txReadMs: 0, txCommitMs: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, sent: true }), { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('benchmarks createSale across cart sizes 1, 10, 25, 50, 100, 150, 200 under normal & slow Firestore RTT', async () => {
    const sizes = [1, 10, 25, 50, 100, 150, 200];
    const results: Array<Record<string, unknown>> = [];

    for (const size of sizes) {
      const cpuTimes: number[] = [];
      const normalRttTimes: number[] = [];
      const slowRttTimes: number[] = [];
      let status = 'OK';
      let lastError = '';
      let opsSummary = { getDocs: 0, docsScanned: 0, txGet: 0, txWrites: 0 };

      for (const mode of ['cpu', 'normal', 'slow'] as const) {
        const runs = mode === 'slow' ? 2 : 5;
        sim.latency =
          mode === 'cpu'
            ? { queryMs: 0, docMs: 0, txReadMs: 0, txCommitMs: 0 }
            : mode === 'normal'
              ? { queryMs: 12, docMs: 8, txReadMs: 8, txCommitMs: 20 }
              : { queryMs: 120, docMs: 80, txReadMs: 80, txCommitMs: 180 };

        for (let r = 0; r < runs; r += 1) {
          seedShopCatalog(220, 1, 2); // 1 active batch + 2 exhausted per SKU
          sim.resetMetrics();
          const items = buildSaleDraftItems(size, { multiUnit: true, discount: r % 2 === 1 });
          const start = performance.now();
          try {
            await createSale(
              UID,
              {
                saleDate: '2026-02-01',
                paymentMethod: r % 2 === 0 ? 'Cash' : 'Online',
                notes: 'Load benchmark',
                items,
              },
              { recordedBy: OWNER_SELLER }
            );
            const elapsed = performance.now() - start;
            if (mode === 'cpu') cpuTimes.push(elapsed);
            else if (mode === 'normal') normalRttTimes.push(elapsed);
            else slowRttTimes.push(elapsed);
          } catch (err) {
            const elapsed = performance.now() - start;
            status = 'FAILED_500_WRITE_LIMIT';
            lastError = err instanceof Error ? err.message : String(err);
            if (mode === 'cpu') cpuTimes.push(elapsed);
            else if (mode === 'normal') normalRttTimes.push(elapsed);
            else slowRttTimes.push(elapsed);
          }
          opsSummary = {
            getDocs: sim.metrics.getDocsCalls,
            docsScanned: sim.metrics.docsScanned,
            txGet: sim.metrics.txGetCalls,
            txWrites: sim.metrics.maxTxWrites || sim.metrics.lastTxWrites,
          };
        }
      }

      results.push({
        size,
        status,
        lastError,
        ops: opsSummary,
        cpu: summarize(cpuTimes),
        normalRtt: summarize(normalRttTimes),
        slowRtt: summarize(slowRttTimes),
      });
    }

    console.log('[BENCH_CREATE_SALE]', JSON.stringify(results));
    // Verify 1..100 succeed and 150/200 hit Firestore's 500-write ceiling (unless split/blocked)
    expect(results.find((r) => r.size === 100)?.status).toBe('OK');
    expect(results.find((r) => r.size === 150)?.status).toBe('FAILED_500_WRITE_LIMIT');
    expect(results.find((r) => r.size === 200)?.status).toBe('FAILED_500_WRITE_LIMIT');
  }, 30000);

  it('benchmarks repeated-product 200-row cart, multi-batch FIFO costing, editSale & reconcileStaffSaleToOwnerLedger', async () => {
    seedShopCatalog(220, 3, 2); // 3 active + 2 exhausted per SKU = 1,100 batches in shop
    sim.latency = { queryMs: 12, docMs: 8, txReadMs: 8, txCommitMs: 20 };

    // 1) Repeated products: 200 cart items across 15 products (coalesces cleanly!)
    sim.resetMetrics();
    const repeatedItems = buildSaleDraftItems(200, { repeated: true, multiUnit: true, discount: true, qtyOverride: 1 });
    const tRepStart = performance.now();
    const repSaleId = await createSale(
      UID,
      { saleDate: '2026-02-01', paymentMethod: 'Online', notes: 'Repeated 200', items: repeatedItems },
      { recordedBy: OWNER_SELLER }
    );
    const repeatedMs = Number((performance.now() - tRepStart).toFixed(2));
    const repeatedOps = { ...sim.metrics };

    // 2) Multi-batch FIFO costing verification (consume across 2 batches: 80 @ 80 + 20 @ 90 = 8200)
    sim.resetMetrics();
    const fifoSaleId = await createSale(
      UID,
      {
        saleDate: '2026-02-01',
        paymentMethod: 'Cash',
        notes: 'Multi-batch FIFO',
        items: [{ productId: 'prod_020', unitName: 'Piece', conversionFactor: 1, quantity: 100, salePricePerUnit: 140 }],
      },
      { recordedBy: OWNER_SELLER }
    );
    const savedFifoSale = sim.docs.get(`shops/${UID}/sales/${fifoSaleId}`) as { totalCost: number; totalAmount: number };
    expect(savedFifoSale.totalCost).toBe(8200);
    expect(savedFifoSale.totalAmount).toBe(14000);

    // Cancel multi-batch FIFO sale restores exact batch quantities
    await cancelSale(UID, {
      id: fifoSaleId,
      ownerUid: UID,
      saleNumber: 'SL-1',
      saleDate: '2026-02-01',
      saleDateTime: '01-02-2026 10:00',
      paymentMethod: 'Cash',
      totalAmount: 14000,
      totalCost: 8200,
      totalProfit: 5800,
      totalQuantity: 100,
      itemCount: 1,
      notes: '',
      status: 'completed',
    });
    const b1 = sim.docs.get(`shops/${UID}/inventoryBatches/prod_020_batch_1`) as { remainingBaseQty: number; status: string };
    const b2 = sim.docs.get(`shops/${UID}/inventoryBatches/prod_020_batch_2`) as { remainingBaseQty: number; status: string };
    expect(b1.remainingBaseQty).toBe(80);
    expect(b1.status).toBe('active');
    expect(b2.remainingBaseQty).toBe(80);

    // 3) editSale scan measurement (10-item sale in a 1,100-batch shop)
    const sale10Id = await createSale(
      UID,
      { saleDate: '2026-02-01', paymentMethod: 'Cash', notes: '', items: buildSaleDraftItems(10) },
      { recordedBy: OWNER_SELLER }
    );
    const sale10Doc = { id: sale10Id, ...(sim.docs.get(`shops/${UID}/sales/${sale10Id}`) as Record<string, unknown>) };
    const existingSale10Items = Array.from(sim.docs.entries())
      .filter(([path, val]) => path.startsWith(`shops/${UID}/saleItems/`) && val.saleId === sale10Id)
      .map(([path, val]) => ({ id: path.split('/').pop()!, ...val }));
    sim.resetMetrics();
    const tEditStart = performance.now();
    await editSale(UID, sale10Doc as never, existingSale10Items as never, {
      saleDate: '2026-02-01',
      paymentMethod: 'Online',
      notes: 'Edited',
      items: buildSaleDraftItems(10, { discount: true }),
    });
    const editMs = Number((performance.now() - tEditStart).toFixed(2));
    const editOps = { ...sim.metrics };

    // 4) Staff sale + reconcileStaffSaleToOwnerLedger scan measurement (25 items)
    sim.resetMetrics();
    const tStaffStart = performance.now();
    const staffSaleId = await createStaffSale(
      UID,
      STAFF_1,
      { saleDate: '2026-02-01', paymentMethod: 'Cash', notes: '', items: buildSaleDraftItems(25) }
    );
    const staffCreateMs = Number((performance.now() - tStaffStart).toFixed(2));
    const staffCreateOps = { ...sim.metrics };

    const ssDoc = { id: staffSaleId, ...(sim.docs.get(`shops/${UID}/staffSales/${staffSaleId}`) as Record<string, unknown>) } as StaffSale;
    sim.resetMetrics();
    const tReconcileStart = performance.now();
    await reconcileStaffSaleToOwnerLedger(UID, ssDoc);
    const reconcileMs = Number((performance.now() - tReconcileStart).toFixed(2));
    const reconcileOps = { ...sim.metrics };

    // 5) Staff sale sizes 1..200 + reconcile limit check
    const staffSizes = [1, 10, 25, 50, 100, 150, 200];
    const staffResults: Array<Record<string, unknown>> = [];
    for (const sSize of staffSizes) {
      seedShopCatalog(220, 1, 0);
      sim.latency = { queryMs: 12, docMs: 8, txReadMs: 8, txCommitMs: 20 };
      sim.resetMetrics();
      const tStart = performance.now();
      const sid = await createStaffSale(
        UID,
        STAFF_1,
        { saleDate: '2026-02-01', paymentMethod: 'Cash', notes: '', items: buildSaleDraftItems(sSize) }
      );
      const staffMs = Number((performance.now() - tStart).toFixed(2));
      const staffTxWrites = sim.metrics.lastTxWrites;
      const staffTxGets = sim.metrics.txGetCalls;

      const sDoc = { id: sid, ...(sim.docs.get(`shops/${UID}/staffSales/${sid}`) as Record<string, unknown>) } as StaffSale;
      sim.resetMetrics();
      let reconcileStatus = 'OK';
      const tRecStart = performance.now();
      try {
        await reconcileStaffSaleToOwnerLedger(UID, sDoc);
      } catch (err) {
        reconcileStatus = err instanceof Error && err.message.includes('500') ? 'FAILED_500_WRITE_LIMIT' : 'FAILED';
      }
      const recMs = Number((performance.now() - tRecStart).toFixed(2));
      staffResults.push({
        size: sSize,
        staffCreateMs: staffMs,
        staffTxGets,
        staffTxWrites,
        reconcileStatus,
        reconcileMs: recMs,
        reconcileTxWrites: sim.metrics.maxTxWrites || sim.metrics.lastTxWrites,
      });
    }

    console.log(
      '[BENCH_WORKLOADS]',
      JSON.stringify({
        repeated200: { ms: repeatedMs, getDocs: repeatedOps.getDocsCalls, docsScanned: repeatedOps.docsScanned, txWrites: repeatedOps.lastTxWrites, saleId: repSaleId },
        edit10: { ms: editMs, getDocs: editOps.getDocsCalls, docsScanned: editOps.docsScanned, txWrites: editOps.lastTxWrites },
        staff25Create: { ms: staffCreateMs, txGets: staffCreateOps.txGetCalls, txWrites: staffCreateOps.lastTxWrites },
        staff25Reconcile: { ms: reconcileMs, getDocs: reconcileOps.getDocsCalls, docsScanned: reconcileOps.docsScanned, txWrites: reconcileOps.lastTxWrites },
        staffSizes: staffResults,
      })
    );

    expect(repeatedOps.lastTxWrites).toBeLessThan(500);
    expect(staffResults.find((r) => r.size === 200)?.staffTxWrites).toBe(201);
    expect(staffResults.find((r) => r.size === 150)?.reconcileStatus).toBe('FAILED_500_WRITE_LIMIT');
  }, 20000);

  it('verifies concurrency safety, insufficient stock, timeout/offline reconnect queue, and Discord/Sheets non-blocking failures', async () => {
    seedShopCatalog(20, 1, 0);
    // Low stock on prod_001: only 5 Pieces remaining
    const lowProd = sim.docs.get(`shops/${UID}/products/prod_001`) as unknown as Product;
    lowProd.currentStock = 5;
    const lowStaff = sim.docs.get(`shops/${UID}/staffCatalog/prod_001`) as unknown as StaffCatalogItem;
    lowStaff.currentStock = 5;
    const lowBatch = sim.docs.get(`shops/${UID}/inventoryBatches/prod_001_batch_1`) as unknown as InventoryBatch;
    lowBatch.remainingBaseQty = 5;

    sim.latency = { queryMs: 5, docMs: 5, txReadMs: 5, txCommitMs: 15 };
    sim.resetMetrics();

    // 5 concurrent staff attempting to buy 2 units each of a product with 5 in stock -> max 2 succeed, 3 fail insufficient stock!
    const concurrentAttempts = await Promise.allSettled(
      Array.from({ length: 5 }, (_, idx) =>
        createStaffSale(
          UID,
          { ...STAFF_1, id: `staff_${idx + 1}`, authUid: `staff_auth_${idx + 1}`, name: `Staff ${idx + 1}` },
          {
            saleDate: '2026-02-01',
            paymentMethod: 'Cash',
            notes: `Concurrent #${idx + 1}`,
            items: [{ productId: 'prod_001', unitName: 'Piece', conversionFactor: 1, quantity: 2 }],
          }
        )
      )
    );
    const fulfilled = concurrentAttempts.filter((r) => r.status === 'fulfilled');
    const rejected = concurrentAttempts.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(3);
    expect((sim.docs.get(`shops/${UID}/staffCatalog/prod_001`) as unknown as StaffCatalogItem).currentStock).toBe(1);

    // Timeout / offline error -> queued offline sale -> reconnect syncs cleanly
    sim.failMode = 'unavailable';
    const prod2Staff = sim.docs.get(`shops/${UID}/staffCatalog/prod_002`) as unknown as StaffCatalogItem;
    const staffCatalogMap = new Map<string, StaffCatalogItem>([['prod_002', prod2Staff]]);
    const queued = createAndEnqueueOfflineSale(UID, STAFF_1, staffCatalogMap, {
      saleDate: '2026-02-01',
      paymentMethod: 'Cash',
      notes: 'Offline fallback test',
      items: [{ productId: 'prod_002', quantity: 3, unitName: 'Piece', conversionFactor: 1 }],
    });
    expect(getQueuedOfflineSales(UID, STAFF_1.authUid)).toHaveLength(1);

    // Reconnect and sync!
    sim.failMode = 'none';
    const syncRes = await syncQueuedOfflineSales(UID, STAFF_1, []);
    expect(syncRes.syncedCount).toBe(1);
    expect(syncRes.remainingCount).toBe(0);
    expect((sim.docs.get(`shops/${UID}/staffCatalog/prod_002`) as unknown as StaffCatalogItem).currentStock).toBe(237);
    expect(queued.localId).toBeTruthy();

    // Discord + Sheets failure isolation: 503 / network error NEVER delays or fails createSale!
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Upstream 503' }), { status: 503 }))
    );
    sim.latency = { queryMs: 0, docMs: 0, txReadMs: 0, txCommitMs: 0 };
    const tFailHookStart = performance.now();
    const saleWithDownstreamFail = await createSale(
      UID,
      {
        saleDate: '2026-02-01',
        paymentMethod: 'Cash',
        notes: 'Downstream down',
        items: buildSaleDraftItems(10),
      },
      { recordedBy: OWNER_SELLER }
    );
    const saveWithDownstreamFailMs = Number((performance.now() - tFailHookStart).toFixed(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(saleWithDownstreamFail).toBeTruthy();
    expect(getSheetsQueueTasks(UID).some((t) => t.dedupeId === saleWithDownstreamFail)).toBe(true);
    expect(getDiscordQueueJobs(UID).some((j) => j.payload.dedupeId === saleWithDownstreamFail)).toBe(true);
    console.log(
      '[BENCH_RESILIENCE]',
      JSON.stringify({
        concurrentStaff5Attempts: { succeeded: fulfilled.length, rejectedInsufficient: rejected.length, txConflicts: sim.metrics.txConflicts },
        saveWithDownstreamFailMs,
      })
    );
  }, 20000);
});
