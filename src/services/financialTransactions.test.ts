// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product, Purchase } from '../types/shop';

const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  autoIdSeq: 1,
  lastRecordedSaleCooccurrencePids: [] as string[],
}));

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { uid: 'shop_1', getIdToken: async () => 'tok' } },
  db: { __mockDb: true },
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

vi.mock('./backgroundTaskQueue', () => ({
  enqueueSheetsBackgroundTask: vi.fn(),
}));

vi.mock('./discordNotificationService', () => ({
  notifyDiscordTransaction: vi.fn(),
}));

vi.mock('./upsellCooccurrenceService', () => ({
  enqueueSaleCooccurrenceUpdate: vi.fn((_uid: string, _saleId: string, pids: string[]) => {
    state.lastRecordedSaleCooccurrencePids = pids;
  }),
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
      const id = `auto_${state.autoIdSeq++}`;
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

  const getDoc = async (ref: { path: string }) => {
    return makeSnap(ref.path, state.docs.get(ref.path));
  };

  const getDocs = async (q: {
    __type: string;
    path: string;
    constraints?: Array<{ __type: string; field?: string; op?: string; value?: unknown; count?: number }>;
  }) => {
    const prefix = `${q.path}/`;
    const matched: Array<{ id: string; data: () => Record<string, unknown> }> = [];
    let maxCount: number | null = null;

    for (const c of q.constraints || []) {
      if (c.__type === 'limit' && typeof c.count === 'number') {
        maxCount = c.count;
      }
    }

    for (const [docPath, raw] of state.docs.entries()) {
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
    const staged = new Map(state.docs);
    const tx = {
      get: async (ref: { path: string }) => makeSnap(ref.path, staged.get(ref.path)),
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        staged.set(ref.path, structuredClone(data));
      },
      update: (ref: { path: string }, patch: Record<string, unknown>) => {
        const cur = staged.get(ref.path) || {};
        staged.set(ref.path, { ...cur, ...structuredClone(patch) });
      },
      delete: (ref: { path: string }) => {
        staged.delete(ref.path);
      },
    };
    const res = await updateFn(tx);
    state.docs = staged;
    return res;
  };

  const writeBatch = () => {
    const ops: Array<() => void> = [];
    return {
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        ops.push(() => state.docs.set(ref.path, structuredClone(data)));
      },
      update: (ref: { path: string }, patch: Record<string, unknown>) => {
        ops.push(() => {
          const cur = state.docs.get(ref.path) || {};
          state.docs.set(ref.path, { ...cur, ...structuredClone(patch) });
        });
      },
      delete: (ref: { path: string }) => {
        ops.push(() => state.docs.delete(ref.path));
      },
      commit: async () => {
        for (const op of ops) op();
      },
    };
  };

  const deleteDoc = async (ref: { path: string }) => {
    state.docs.delete(ref.path);
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
    deleteDoc,
    setDoc: async (ref: { path: string }, data: Record<string, unknown>) => {
      state.docs.set(ref.path, structuredClone(data));
    },
    updateDoc: async (ref: { path: string }, patch: Record<string, unknown>) => {
      const cur = state.docs.get(ref.path) || {};
      state.docs.set(ref.path, { ...cur, ...structuredClone(patch) });
    },
    deleteField: () => ({ __deleteField: true }),
    serverTimestamp: () => 'SERVER_TIMESTAMP',
  };
});

import {
  cancelPurchase,
  createSale,
  deleteProduct,
  deleteSupplier,
  settlePurchaseBalance,
} from './shopService';

const UID = 'shop_1';

function makePurchaseDoc(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: 'pur_1',
    ownerUid: UID,
    purchaseNumber: 'PR-260101-1001',
    purchaseDate: '2026-01-01',
    supplierId: 'sup_1',
    supplierName: 'ABC Traders',
    totalAmount: 1000,
    amountPaid: 200,
    balanceDue: 800,
    paymentMethod: 'Cash',
    totalQuantity: 10,
    itemCount: 1,
    notes: '',
    status: 'completed',
    ...overrides,
  };
}

function makeProductDoc(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod_1',
    ownerUid: UID,
    name: 'Test Shampoo',
    categoryId: 'cat_1',
    categoryName: 'Hair Care',
    brandId: 'brand_1',
    brandName: 'Brand',
    purchasePrice: 100,
    salePrice: 150,
    wholesalePrice: 130,
    currentStock: 10,
    minStockLevel: 2,
    maxStockLevel: 50,
    unit: 'Piece',
    supplierId: 'sup_1',
    supplierName: 'ABC Traders',
    expiryDate: '',
    profitMarginPct: 33.3,
    isActive: true,
    ...overrides,
  };
}

describe('financialTransactions safety regressions', () => {
  beforeEach(() => {
    state.docs.clear();
    state.autoIdSeq = 1;
    state.lastRecordedSaleCooccurrencePids = [];
  });

  it('validates balanceDue and cancelled status INSIDE settlePurchaseBalance transaction', async () => {
    const stalePurchase = makePurchaseDoc({ amountPaid: 200, balanceDue: 800 });
    // Authoritative server document already had PKR 600 settled concurrently (remaining balance = 200)
    state.docs.set(
      `shops/${UID}/purchases/pur_1`,
      makePurchaseDoc({ amountPaid: 800, balanceDue: 200 }) as unknown as Record<string, unknown>
    );
    state.docs.set(`shops/${UID}/suppliers/sup_1`, {
      ownerUid: UID,
      name: 'ABC Traders',
      totalPurchased: 1000,
      totalPaid: 800,
      outstandingBalance: 200,
    });

    await expect(settlePurchaseBalance(UID, stalePurchase, 500, 'Cash')).rejects.toThrow(
      /remaining balance due \(PKR 200\)/i
    );

    // Valid payment within remaining authoritative balance succeeds
    await settlePurchaseBalance(UID, stalePurchase, 200, 'Cash');
    const updatedPurchase = state.docs.get(`shops/${UID}/purchases/pur_1`) as unknown as Purchase;
    expect(updatedPurchase.amountPaid).toBe(1000);
    expect(updatedPurchase.balanceDue).toBe(0);

    // Next attempt sees 0 due and rejects inside transaction
    await expect(settlePurchaseBalance(UID, stalePurchase, 100, 'Cash')).rejects.toThrow(
      /already fully paid/i
    );

    // Cancelled authoritative state blocks payment even if stale client snapshot says completed
    state.docs.set(
      `shops/${UID}/purchases/pur_2`,
      makePurchaseDoc({ id: 'pur_2', status: 'cancelled' }) as unknown as Record<string, unknown>
    );
    await expect(
      settlePurchaseBalance(UID, makePurchaseDoc({ id: 'pur_2', status: 'completed' }), 100, 'Cash')
    ).rejects.toThrow(/Cannot pay a cancelled purchase/i);
  });

  it('uses authoritative Firestore purchase totals during cancelPurchase when concurrent settlement occurred', async () => {
    const stalePurchase = makePurchaseDoc({ amountPaid: 200, balanceDue: 800 });
    // Authoritative Firestore purchase already settled another 300 -> amountPaid: 500, balanceDue: 500
    state.docs.set(
      `shops/${UID}/purchases/pur_1`,
      makePurchaseDoc({ amountPaid: 500, balanceDue: 500 }) as unknown as Record<string, unknown>
    );
    state.docs.set(`shops/${UID}/suppliers/sup_1`, {
      ownerUid: UID,
      name: 'ABC Traders',
      totalPurchased: 1000,
      totalPaid: 500,
      outstandingBalance: 500,
    });
    state.docs.set(`shops/${UID}/products/prod_1`, makeProductDoc({ currentStock: 10 }) as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/purchaseItems/pi_1`, {
      ownerUid: UID,
      purchaseId: 'pur_1',
      productId: 'prod_1',
      productName: 'Test Shampoo',
      quantity: 10,
      baseQuantity: 10,
      status: 'completed',
    });
    state.docs.set(`shops/${UID}/inventoryBatches/batch_1`, {
      ownerUid: UID,
      purchaseId: 'pur_1',
      productId: 'prod_1',
      productName: 'Test Shampoo',
      initialBaseQty: 10,
      remainingBaseQty: 10,
      status: 'active',
    });

    await cancelPurchase(UID, stalePurchase);

    const sup = state.docs.get(`shops/${UID}/suppliers/sup_1`) as {
      totalPurchased: number;
      totalPaid: number;
      outstandingBalance: number;
    };
    expect(sup.totalPurchased).toBe(0);
    expect(sup.totalPaid).toBe(0);
    expect(sup.outstandingBalance).toBe(0);

    const prod = state.docs.get(`shops/${UID}/products/prod_1`) as unknown as Product;
    expect(prod.currentStock).toBe(0);
  });

  it('queries fresh active inventoryBatches in createSale even when caller passes empty activeBatchIds', async () => {
    state.docs.set(`shops/${UID}/products/prod_1`, makeProductDoc({ currentStock: 10, purchasePrice: 999 }) as unknown as Record<string, unknown>);
    // Concurrent purchase added batch_new with unitCostInBase: 85 (not in stale activeBatchIds: [])
    state.docs.set(`shops/${UID}/inventoryBatches/batch_new`, {
      ownerUid: UID,
      productId: 'prod_1',
      purchaseDate: '2026-01-02',
      initialBaseQty: 10,
      remainingBaseQty: 10,
      unitCostInBase: 85,
      status: 'active',
    });

    const saleId = await createSale(
      UID,
      {
        saleDate: '2026-01-03',
        paymentMethod: 'Cash',
        notes: '',
        items: [
          {
            productId: 'prod_1',
            unitName: 'Piece',
            conversionFactor: 1,
            quantity: 2,
            salePricePerUnit: 150,
          },
        ],
      },
      { activeBatchIds: [] }
    );

    const savedSale = state.docs.get(`shops/${UID}/sales/${saleId}`) as { totalCost: number };
    expect(savedSale.totalCost).toBe(170); // 2 * 85 from fresh batch, NOT stale 999 fallback
    const updatedBatch = state.docs.get(`shops/${UID}/inventoryBatches/batch_new`) as {
      remainingBaseQty: number;
    };
    expect(updatedBatch.remainingBaseQty).toBe(8);
    // Clean productId (not merged composite key "prod_1::piece") passed to co-occurrence updater
    expect(state.lastRecordedSaleCooccurrencePids).toEqual(['prod_1']);
  });

  it('blocks deleteProduct when stock, batches, or history exist and cleans up unused products safely', async () => {
    const stocked = makeProductDoc({ id: 'p_stock', currentStock: 5 });
    state.docs.set(`shops/${UID}/products/p_stock`, stocked as unknown as Record<string, unknown>);
    await expect(deleteProduct(UID, stocked)).rejects.toThrow(/while stock remains/i);

    const batched = makeProductDoc({ id: 'p_batch', currentStock: 0 });
    state.docs.set(`shops/${UID}/products/p_batch`, batched as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/inventoryBatches/b_x`, {
      ownerUid: UID,
      productId: 'p_batch',
      status: 'exhausted',
      remainingBaseQty: 0,
    });
    await expect(deleteProduct(UID, batched)).rejects.toThrow(/linked inventory batches/i);

    const historical = makeProductDoc({ id: 'p_hist', currentStock: 0 });
    state.docs.set(`shops/${UID}/products/p_hist`, historical as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/saleItems/si_1`, {
      ownerUid: UID,
      productId: 'p_hist',
    });
    await expect(deleteProduct(UID, historical)).rejects.toThrow(/historical sales or purchases/i);

    const unused = makeProductDoc({ id: 'p_unused', currentStock: 0 });
    state.docs.set(`shops/${UID}/products/p_unused`, unused as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/staffCatalog/p_unused`, { ownerUid: UID, productId: 'p_unused' });
    await deleteProduct(UID, unused, { hasHistoricalTransactions: false });
    expect(state.docs.has(`shops/${UID}/products/p_unused`)).toBe(false);
    expect(state.docs.has(`shops/${UID}/staffCatalog/p_unused`)).toBe(false);
  });

  it('blocks deleteSupplier when outstanding balance or linked purchases exist', async () => {
    state.docs.set(`shops/${UID}/suppliers/sup_due`, {
      ownerUid: UID,
      name: 'Creditor',
      totalPurchased: 500,
      totalPaid: 0,
      outstandingBalance: 500,
    });
    await expect(deleteSupplier(UID, 'sup_due')).rejects.toThrow(/Cannot delete supplier/i);

    state.docs.set(`shops/${UID}/suppliers/sup_linked`, {
      ownerUid: UID,
      name: 'Linked Sup',
      totalPurchased: 0,
      totalPaid: 0,
      outstandingBalance: 0,
    });
    state.docs.set(`shops/${UID}/products/p_ref`, { ownerUid: UID, supplierId: 'sup_linked' });
    await expect(deleteSupplier(UID, 'sup_linked')).rejects.toThrow(/existing products or purchases/i);

    state.docs.set(`shops/${UID}/suppliers/sup_clean`, {
      ownerUid: UID,
      name: 'Clean Sup',
      totalPurchased: 0,
      totalPaid: 0,
      outstandingBalance: 0,
    });
    await deleteSupplier(UID, 'sup_clean', { hasLinkedRecords: false });
    expect(state.docs.has(`shops/${UID}/suppliers/sup_clean`)).toBe(false);
  });
});
