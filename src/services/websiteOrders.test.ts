// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InventoryBatch,
  Product,
  ShopSettings,
  StorefrontCatalogItem,
  WebsiteOrder,
} from '../types/shop';

const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  autoIdSeq: 1,
}));

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { uid: 'shop_1', email: 'owner@caremart.pk', getIdToken: async () => 'tok' } },
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
    let hasWritten = false;
    const tx = {
      get: async (ref: { path: string }) => {
        if (hasWritten) {
          throw new Error('Firestore transaction invariant violated: read attempted after write.');
        }
        return makeSnap(ref.path, staged.get(ref.path));
      },
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        hasWritten = true;
        staged.set(ref.path, structuredClone(data));
      },
      update: (ref: { path: string }, patch: Record<string, unknown>) => {
        hasWritten = true;
        const cur = staged.get(ref.path) || {};
        staged.set(ref.path, { ...cur, ...structuredClone(patch) });
      },
      delete: (ref: { path: string }) => {
        hasWritten = true;
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
      state.docs.delete(ref.path);
    },
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
  buildStorefrontCatalogPayload,
  cancelConfirmedWebsiteOrder,
  confirmWebsiteOrder,
  rejectWebsiteOrder,
  syncStorefrontCatalogDocuments,
  syncStorefrontMeta,
  updateWebsiteOrderDeliveryStatus,
} from './websiteOrderService';

const UID = 'shop_1';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod_1',
    ownerUid: UID,
    name: 'Pampers Active Baby Medium',
    categoryId: 'cat_1',
    categoryName: 'Diapers',
    brandId: 'brand_1',
    brandName: 'Pampers',
    purchasePrice: 1200,
    salePrice: 1500,
    wholesalePrice: 1350,
    currentStock: 10,
    minStockLevel: 2,
    maxStockLevel: 50,
    unit: 'Pack',
    baseUnit: 'Pack',
    packagingUnits: [
      {
        unitName: 'Pack',
        conversionQty: 1,
        allowPurchase: true,
        allowSale: true,
        purchasePrice: 1200,
        salePrice: 1500,
        wholesalePrice: 1350,
        isDefaultPurchase: true,
        isDefaultSale: true,
      },
      {
        unitName: 'Carton',
        conversionQty: 4,
        containsQty: 4,
        parentUnitName: 'Pack',
        allowPurchase: true,
        allowSale: true,
        purchasePrice: 4600,
        salePrice: 5800,
        wholesalePrice: 5200,
      },
    ],
    supplierId: 'sup_secret',
    supplierName: 'Secret Wholesale Distributor',
    expiryDate: '2027-06-01',
    profitMarginPct: 20,
    image: 'https://cdn.example.com/pampers.webp',
    isActive: true,
    ...overrides,
  };
}

function makeBatch(overrides: Partial<InventoryBatch> = {}): InventoryBatch {
  return {
    id: 'batch_1',
    ownerUid: UID,
    productId: 'prod_1',
    productName: 'Pampers Active Baby Medium',
    purchaseId: 'pur_1',
    purchaseNumber: 'PR-1001',
    purchaseDate: '2026-01-01',
    supplierId: 'sup_secret',
    supplierName: 'Secret Wholesale Distributor',
    initialBaseQty: 4,
    remainingBaseQty: 4,
    unitCostInBase: 1100,
    expiryDate: '',
    status: 'active',
    ...overrides,
  };
}

function makeWebsiteOrder(overrides: Partial<WebsiteOrder> = {}): WebsiteOrder {
  return {
    id: 'wo_1',
    ownerUid: UID,
    shopId: UID,
    orderNumber: 'WEB-261127-1001',
    customerName: 'Ayesha Khan',
    customerPhone: '+92 300 1234567',
    customerAddress: 'House 14, Street 5, Gulberg III, Lahore',
    customerNotes: 'Call before delivery',
    paymentMethod: 'Cash on Delivery',
    status: 'Pending Confirmation',
    items: [
      {
        productId: 'prod_1',
        productName: 'Pampers Active Baby Medium',
        unitName: 'Carton',
        conversionFactor: 4,
        quantity: 1,
        baseQuantity: 4,
        unitPrice: 5800,
        lineTotal: 5800,
      },
      {
        productId: 'prod_1',
        productName: 'Pampers Active Baby Medium',
        unitName: 'Pack',
        conversionFactor: 1,
        quantity: 2,
        baseQuantity: 2,
        unitPrice: 1500,
        lineTotal: 3000,
      },
    ],
    itemCount: 2,
    totalQuantity: 6,
    subtotal: 8800,
    deliveryFee: 150,
    totalAmount: 8950,
    ...overrides,
  };
}

function listDocsInCollection(colName: string): Array<{ id: string; data: Record<string, unknown> }> {
  const prefix = `shops/${UID}/${colName}/`;
  const out: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (const [k, v] of state.docs.entries()) {
    if (k.startsWith(prefix)) {
      out.push({ id: k.slice(prefix.length), data: v });
    }
  }
  return out;
}

describe('Website Orders & Public Storefront Projection', () => {
  beforeEach(() => {
    state.docs.clear();
    state.autoIdSeq = 1;
  });

  it('strips all sensitive cost/wholesale/margin/supplier fields from storefrontCatalog payloads', () => {
    const product = makeProduct();
    const payload = buildStorefrontCatalogPayload(UID, product, 7);

    expect(payload).toEqual({
      ownerUid: UID,
      productId: 'prod_1',
      name: 'Pampers Active Baby Medium',
      category: 'Diapers',
      brand: 'Pampers',
      salePrice: 1500,
      currentStock: 7,
      unit: 'Pack',
      baseUnit: 'Pack',
      packagingUnits: [
        {
          unitName: 'Carton',
          conversionQty: 4,
          containsQty: 4,
          parentUnitName: 'Pack',
          allowSale: true,
          salePrice: 5800,
          isDefaultSale: false,
        },
      ],
      image: 'https://cdn.example.com/pampers.webp',
      isActive: true,
    });

    const json = JSON.stringify(payload);
    expect(json).not.toContain('purchasePrice');
    expect(json).not.toContain('wholesalePrice');
    expect(json).not.toContain('profitMarginPct');
    expect(json).not.toContain('supplier');
    expect(json).not.toContain('allowPurchase');
    expect(json).not.toContain('1200');
    expect(json).not.toContain('1350');
  });

  it('syncs storefront/meta and storefrontCatalog subtracting pending COD reservations and deleting orphans', async () => {
    const settings: ShopSettings = {
      id: 'general',
      ownerUid: UID,
      shopName: 'CareMart Lahore',
      ownerName: 'Owner',
      phone: '+92 321 0000000',
      address: 'Main Market, Lahore',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      dateFormat: 'DD-MM-YYYY',
      language: 'English',
      expiryAlertDays: 30,
      autoBackupEnabled: true,
      lastBackupAt: '',
    };

    await syncStorefrontMeta(UID, settings);
    const meta = state.docs.get(`shops/${UID}/storefront/meta`);
    expect(meta).toMatchObject({
      ownerUid: UID,
      shopName: 'CareMart Lahore',
      phone: '+92 321 0000000',
      address: 'Main Market, Lahore',
      currency: 'PKR',
    });

    const prod = makeProduct({ currentStock: 10 });
    const pendingOrder = makeWebsiteOrder({ status: 'Pending Confirmation' }); // 6 base qty reserved
    const confirmedOrder = makeWebsiteOrder({ id: 'wo_2', status: 'Confirmed' }); // already deducted in real stock
    const orphanItem: StorefrontCatalogItem = {
      id: 'prod_deleted',
      ownerUid: UID,
      productId: 'prod_deleted',
      name: 'Old Item',
      category: 'Diapers',
      brand: 'Test',
      salePrice: 100,
      currentStock: 5,
      unit: 'Piece',
      baseUnit: 'Piece',
      packagingUnits: [],
      image: '',
      isActive: false,
    };
    state.docs.set(`shops/${UID}/storefrontCatalog/prod_deleted`, orphanItem as unknown as Record<string, unknown>);

    await syncStorefrontCatalogDocuments(UID, [prod], [pendingOrder, confirmedOrder], [orphanItem]);

    const syncedProd = state.docs.get(`shops/${UID}/storefrontCatalog/prod_1`);
    expect(syncedProd?.currentStock).toBe(4); // 10 real stock - 6 pending reserved
    expect(state.docs.has(`shops/${UID}/storefrontCatalog/prod_deleted`)).toBe(false);
  });

  it('atomically confirms a Pending Confirmation order using FIFO ledger allocation and links POS sale', async () => {
    const prod = makeProduct({ currentStock: 10, purchasePrice: 1250 });
    const batch1 = makeBatch({ id: 'batch_1', purchaseDate: '2026-01-01', initialBaseQty: 4, remainingBaseQty: 4, unitCostInBase: 1100 });
    const batch2 = makeBatch({ id: 'batch_2', purchaseDate: '2026-01-10', initialBaseQty: 6, remainingBaseQty: 6, unitCostInBase: 1250 });
    const order = makeWebsiteOrder();

    state.docs.set(`shops/${UID}/products/prod_1`, prod as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/inventoryBatches/batch_1`, batch1 as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/inventoryBatches/batch_2`, batch2 as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/websiteOrders/wo_1`, order as unknown as Record<string, unknown>);

    const result = await confirmWebsiteOrder(UID, order, {
      activeBatchIds: ['batch_1', 'batch_2'],
      confirmedByUid: UID,
      confirmedByName: 'Main Owner',
    });

    const updatedOrder = state.docs.get(`shops/${UID}/websiteOrders/wo_1`);
    expect(updatedOrder?.status).toBe('Confirmed');
    expect(updatedOrder?.linkedSaleId).toBe(result.saleId);
    expect(updatedOrder?.linkedSaleNumber).toBe(result.saleNumber);
    expect(updatedOrder?.confirmedByName).toBe('Main Owner');

    const createdSale = state.docs.get(`shops/${UID}/sales/${result.saleId}`);
    expect(createdSale).toMatchObject({
      ownerUid: UID,
      paymentMethod: 'Cash',
      recordedByRole: 'website',
      staffId: 'website_storefront',
      staffName: 'Website Storefront',
      totalAmount: 8800,
      totalQuantity: 6,
      status: 'completed',
    });
    // FIFO cost: 4 * 1100 + 2 * 1250 = 4400 + 2500 = 6900
    expect(createdSale?.totalCost).toBe(6900);
    expect(createdSale?.totalProfit).toBe(1900);

    // Real product stock deducted 10 -> 4
    expect(state.docs.get(`shops/${UID}/products/prod_1`)?.currentStock).toBe(4);
    expect(state.docs.get(`shops/${UID}/inventoryBatches/batch_1`)).toMatchObject({
      remainingBaseQty: 0,
      status: 'exhausted',
    });
    expect(state.docs.get(`shops/${UID}/inventoryBatches/batch_2`)).toMatchObject({
      remainingBaseQty: 4,
      status: 'active',
    });

    expect(listDocsInCollection('saleItems')).toHaveLength(2);
    expect(listDocsInCollection('stockMovements')).toHaveLength(2);
    expect(listDocsInCollection('auditLogs')).toHaveLength(1);
  });

  it('aborts confirmation cleanly with zero ledger writes if real store stock is insufficient', async () => {
    const prod = makeProduct({ currentStock: 3 }); // order needs 6
    const batch1 = makeBatch({ remainingBaseQty: 3 });
    const order = makeWebsiteOrder();

    state.docs.set(`shops/${UID}/products/prod_1`, prod as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/inventoryBatches/batch_1`, batch1 as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/websiteOrders/wo_1`, order as unknown as Record<string, unknown>);

    await expect(
      confirmWebsiteOrder(UID, order, { activeBatchIds: ['batch_1'] })
    ).rejects.toThrow(/Insufficient stock/i);

    expect(state.docs.get(`shops/${UID}/websiteOrders/wo_1`)?.status).toBe('Pending Confirmation');
    expect(state.docs.get(`shops/${UID}/products/prod_1`)?.currentStock).toBe(3);
    expect(listDocsInCollection('sales')).toHaveLength(0);
    expect(listDocsInCollection('saleItems')).toHaveLength(0);
    expect(listDocsInCollection('stockMovements')).toHaveLength(0);
  });

  it('rejects a Pending Confirmation order by restoring storefrontCatalog stock ONLY and never touching real ledger', async () => {
    const prod = makeProduct({ currentStock: 10 });
    const sfItem = buildStorefrontCatalogPayload(UID, prod, 4); // 10 - 6 reserved at checkout
    const order = makeWebsiteOrder();

    state.docs.set(`shops/${UID}/products/prod_1`, prod as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/storefrontCatalog/prod_1`, sfItem as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/websiteOrders/wo_1`, order as unknown as Record<string, unknown>);

    await rejectWebsiteOrder(UID, order, 'Unable to confirm on phone');

    const updatedOrder = state.docs.get(`shops/${UID}/websiteOrders/wo_1`);
    expect(updatedOrder?.status).toBe('Cancelled/Rejected');
    expect(updatedOrder?.rejectionReason).toBe('Unable to confirm on phone');

    // storefrontCatalog restored 4 + 6 = 10
    expect(state.docs.get(`shops/${UID}/storefrontCatalog/prod_1`)?.currentStock).toBe(10);

    // Real products & ledger untouched
    expect(state.docs.get(`shops/${UID}/products/prod_1`)?.currentStock).toBe(10);
    expect(listDocsInCollection('sales')).toHaveLength(0);
    expect(listDocsInCollection('saleItems')).toHaveLength(0);
    expect(listDocsInCollection('stockMovements')).toHaveLength(0);
    expect(listDocsInCollection('auditLogs')).toHaveLength(1);
  });

  it('enforces valid delivery status transitions and reverses linked sale + FIFO batches on confirmed order cancel', async () => {
    const prod = makeProduct({ currentStock: 10, purchasePrice: 1250 });
    const batch1 = makeBatch({ id: 'batch_1', purchaseDate: '2026-01-01', initialBaseQty: 4, remainingBaseQty: 4, unitCostInBase: 1100 });
    const batch2 = makeBatch({ id: 'batch_2', purchaseDate: '2026-01-10', initialBaseQty: 6, remainingBaseQty: 6, unitCostInBase: 1250 });
    const order = makeWebsiteOrder();

    state.docs.set(`shops/${UID}/products/prod_1`, prod as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/inventoryBatches/batch_1`, batch1 as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/inventoryBatches/batch_2`, batch2 as unknown as Record<string, unknown>);
    state.docs.set(`shops/${UID}/websiteOrders/wo_1`, order as unknown as Record<string, unknown>);

    const { saleId } = await confirmWebsiteOrder(UID, order, {
      activeBatchIds: ['batch_1', 'batch_2'],
    });
    const confirmedOrder = {
      ...(state.docs.get(`shops/${UID}/websiteOrders/wo_1`) as unknown as WebsiteOrder),
      id: 'wo_1',
    };

    await updateWebsiteOrderDeliveryStatus(UID, confirmedOrder, 'Out for Delivery');
    expect(state.docs.get(`shops/${UID}/websiteOrders/wo_1`)?.status).toBe('Out for Delivery');

    const dispatchedOrder = {
      ...(state.docs.get(`shops/${UID}/websiteOrders/wo_1`) as unknown as WebsiteOrder),
      id: 'wo_1',
    };

    // Cancel while Out for Delivery (customer refused COD) -> reverses sale and restores FIFO lots
    await cancelConfirmedWebsiteOrder(UID, dispatchedOrder, 'Customer refused at door');

    expect(state.docs.get(`shops/${UID}/websiteOrders/wo_1`)?.status).toBe('Cancelled/Rejected');
    expect(state.docs.get(`shops/${UID}/sales/${saleId}`)?.status).toBe('cancelled');
    expect(state.docs.get(`shops/${UID}/products/prod_1`)?.currentStock).toBe(10);
    expect(state.docs.get(`shops/${UID}/inventoryBatches/batch_1`)).toMatchObject({
      remainingBaseQty: 4,
      status: 'active',
    });
    expect(state.docs.get(`shops/${UID}/inventoryBatches/batch_2`)).toMatchObject({
      remainingBaseQty: 6,
      status: 'active',
    });
  });
});
