// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Product, StaffCatalogItem, StaffMember, StaffSale } from '../types/shop';

const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  autoIdSeq: 1,
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
  enqueueSaleCooccurrenceUpdate: vi.fn(),
  enqueueCooccurrenceMutationReconcile: vi.fn(),
  getCooccurrenceStatsSnapshot: () => ({
    pairCounts: {},
    productCounts: {},
    totalProcessedSales: 0,
  }),
  getHistoricalCooccurrenceCandidates: () => [],
}));

vi.mock('./upsellFeedbackService', () => ({
  getUpsellFeedbackAdjustment: () => 0,
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
          if (c.op === 'array-contains' && (!Array.isArray(raw[c.field]) || !(raw[c.field] as unknown[]).includes(c.value))) {
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

import { createAndEnqueueOfflineSale } from './offlineSyncService';
import {
  mapProductsToSearchable,
  queryProductsFromDatabase,
  searchProductsCatalog,
} from './productSearchService';
import { createProduct, createSale, editSale, updateProduct } from './shopService';
import { createStaffSale, reconcileStaffSaleToOwnerLedger } from './staffService';
import {
  getHybridUpsellSuggestion,
  getProductRelatedSuggestions,
  validateGeminiUpsellResponse,
} from '../utils/salesAssistant';

const UID = 'shop_1';

function seedProduct(id: string, overrides: Partial<Product> = {}): Product {
  const prod: Product = {
    id,
    ownerUid: UID,
    name: `Product ${id}`,
    categoryId: 'cat_care',
    categoryName: 'Baby Care',
    brandId: 'br_1',
    brandName: 'CareBrand',
    purchasePrice: 100,
    salePrice: 150,
    wholesalePrice: 130,
    currentStock: 20,
    minStockLevel: 5,
    maxStockLevel: 100,
    unit: 'Piece',
    baseUnit: 'Piece',
    supplierId: 'sup_1',
    supplierName: 'Main Supplier',
    expiryDate: '',
    profitMarginPct: 33.33,
    isActive: true,
    ...overrides,
  };
  state.docs.set(`shops/${UID}/products/${id}`, { ...prod });
  return prod;
}

function seedStaffCatalog(id: string, overrides: Partial<StaffCatalogItem> = {}): StaffCatalogItem {
  const item: StaffCatalogItem = {
    id,
    ownerUid: UID,
    productId: id,
    name: `Product ${id}`,
    categoryName: 'Baby Care',
    brandName: 'CareBrand',
    salePrice: 150,
    wholesalePrice: 130,
    currentStock: 20,
    unit: 'Piece',
    baseUnit: 'Piece',
    isActive: true,
    allowedStaffUids: ['staff_auth_1'],
    ...overrides,
  };
  state.docs.set(`shops/${UID}/staffCatalog/${id}`, { ...item });
  return item;
}

function makeStaffMember(): StaffMember {
  return {
    id: 'staff_1',
    ownerUid: UID,
    shopId: UID,
    shopCode: 'SHOP1',
    name: 'Ali Cashier',
    phone: '03001234567',
    username: 'ali_pos',
    usernameLower: 'ali_pos',
    authUid: 'staff_auth_1',
    loginVersion: 1,
    role: 'sales_staff',
    isActive: true,
    permissions: {
      canAddSales: true,
      canViewStock: true,
      canViewOwnSales: true,
    },
  };
}

describe('Active / Inactive product enforcement across search, upsells, and Firebase sales validation', () => {
  beforeEach(() => {
    state.docs.clear();
    state.autoIdSeq = 1;
  });

  it('toggles Active/Inactive cleanly while preserving stock and syncing catalog copies', async () => {
    const prod = seedProduct('p_toggle', { name: 'Leo Baby Wipes 72s', currentStock: 35, isActive: true });
    seedStaffCatalog('p_toggle', { name: 'Leo Baby Wipes 72s', currentStock: 35, isActive: true });
    state.docs.set(`shops/${UID}/storefrontCatalog/p_toggle`, {
      ownerUid: UID,
      productId: 'p_toggle',
      name: 'Leo Baby Wipes 72s',
      category: 'Baby Wipes',
      brand: 'LEO',
      salePrice: 150,
      currentStock: 35,
      unit: 'Piece',
      isActive: true,
    });

    const newId = await createProduct(UID, {
      name: 'Shan Biryani Masala 50g',
      categoryId: 'cat_spices',
      categoryName: 'Spices & Seasonings',
      brandId: 'br_shan',
      brandName: 'Shan Foods',
      purchasePrice: 80,
      salePrice: 120,
      wholesalePrice: 110,
      currentStock: 10,
      minStockLevel: 2,
      maxStockLevel: 50,
      unit: 'Piece',
      supplierId: 'sup_1',
      supplierName: 'Main Supplier',
      expiryDate: '',
      isActive: true,
    });
    expect(state.docs.get(`shops/${UID}/products/${newId}`)?.isActive).toBe(true);

    // Mark product Inactive
    await updateProduct(UID, prod.id, {
      name: prod.name,
      categoryId: prod.categoryId,
      categoryName: prod.categoryName,
      brandId: prod.brandId,
      brandName: prod.brandName,
      purchasePrice: prod.purchasePrice,
      salePrice: prod.salePrice,
      wholesalePrice: prod.wholesalePrice,
      minStockLevel: prod.minStockLevel,
      maxStockLevel: prod.maxStockLevel,
      unit: prod.unit,
      supplierId: prod.supplierId,
      supplierName: prod.supplierName,
      expiryDate: prod.expiryDate,
      isActive: false,
    });

    expect(state.docs.get(`shops/${UID}/products/p_toggle`)?.isActive).toBe(false);
    expect(state.docs.get(`shops/${UID}/products/p_toggle`)?.currentStock).toBe(35);
    expect(state.docs.get(`shops/${UID}/staffCatalog/p_toggle`)?.isActive).toBe(false);
    expect(state.docs.get(`shops/${UID}/storefrontCatalog/p_toggle`)?.isActive).toBe(false);

    // Reactivate product
    await updateProduct(UID, prod.id, {
      name: prod.name,
      categoryId: prod.categoryId,
      categoryName: prod.categoryName,
      brandId: prod.brandId,
      brandName: prod.brandName,
      purchasePrice: prod.purchasePrice,
      salePrice: prod.salePrice,
      wholesalePrice: prod.wholesalePrice,
      minStockLevel: prod.minStockLevel,
      maxStockLevel: prod.maxStockLevel,
      unit: prod.unit,
      supplierId: prod.supplierId,
      supplierName: prod.supplierName,
      expiryDate: prod.expiryDate,
      isActive: true,
    });

    expect(state.docs.get(`shops/${UID}/products/p_toggle`)?.isActive).toBe(true);
    expect(state.docs.get(`shops/${UID}/products/p_toggle`)?.currentStock).toBe(35);
    expect(state.docs.get(`shops/${UID}/staffCatalog/p_toggle`)?.isActive).toBe(true);
    expect(state.docs.get(`shops/${UID}/storefrontCatalog/p_toggle`)?.isActive).toBe(true);
  });

  it('rejects inactive products in createSale and allows reactivation + legacy omitted isActive', async () => {
    const inactiveProd = seedProduct('p_inactive', {
      name: 'Discontinued Lotion',
      currentStock: 12,
      isActive: false,
    });
    const legacyProd = seedProduct('p_legacy', {
      name: 'Legacy Baby Oil',
      currentStock: 8,
    });
    const rawLegacy = state.docs.get(`shops/${UID}/products/p_legacy`)!;
    delete rawLegacy.isActive;

    await expect(
      createSale(UID, {
        saleDate: '2026-11-28',
        paymentMethod: 'Cash',
        notes: '',
        items: [{ productId: inactiveProd.id, unitName: 'Piece', conversionFactor: 1, quantity: 2, salePricePerUnit: 150 }],
      })
    ).rejects.toThrow(/inactive and cannot be sold/i);

    // Stock and sales ledger must remain completely untouched
    expect(state.docs.get(`shops/${UID}/products/p_inactive`)?.currentStock).toBe(12);
    const salesCreated = Array.from(state.docs.keys()).filter((k) => k.startsWith(`shops/${UID}/sales/`));
    expect(salesCreated).toHaveLength(0);

    // Legacy product missing isActive remains active by default and sellable
    const legacySaleId = await createSale(UID, {
      saleDate: '2026-11-28',
      paymentMethod: 'Cash',
      notes: '',
      items: [{ productId: legacyProd.id, unitName: 'Piece', conversionFactor: 1, quantity: 2, salePricePerUnit: 150 }],
    });
    expect(legacySaleId).toBeTruthy();
    expect(state.docs.get(`shops/${UID}/products/p_legacy`)?.currentStock).toBe(6);

    // Reactivate inactive product -> now sellable again
    await updateProduct(UID, inactiveProd.id, {
      ...inactiveProd,
      isActive: true,
    });
    const reactivatedSaleId = await createSale(UID, {
      saleDate: '2026-11-28',
      paymentMethod: 'Cash',
      notes: '',
      items: [{ productId: inactiveProd.id, unitName: 'Piece', conversionFactor: 1, quantity: 2, salePricePerUnit: 150 }],
    });
    expect(reactivatedSaleId).toBeTruthy();
    expect(state.docs.get(`shops/${UID}/products/p_inactive`)?.currentStock).toBe(10);
  });

  it('blocks adding inactive products via editSale while allowing metadata edits on historical sales', async () => {
    const active = seedProduct('p_act', { name: 'Pampers Active 40s', currentStock: 20, isActive: true });
    const laterInactive = seedProduct('p_old', { name: 'Old Balm', currentStock: 10, isActive: false });

    const saleId = await createSale(UID, {
      saleDate: '2026-11-20',
      paymentMethod: 'Cash',
      notes: 'Original sale',
      items: [{ productId: active.id, unitName: 'Piece', conversionFactor: 1, quantity: 1, salePricePerUnit: 150 }],
    });
    const saleDoc = state.docs.get(`shops/${UID}/sales/${saleId}`)!;
    const saleItemEntry = Array.from(state.docs.entries()).find(
      ([k, v]) => k.startsWith(`shops/${UID}/saleItems/`) && v.saleId === saleId
    )!;
    const saleItemObj = { id: saleItemEntry[0].split('/').pop()!, ...(saleItemEntry[1] as Record<string, unknown>) };

    // Adding an inactive product while editing an existing sale must fail
    await expect(
      editSale(
        UID,
        { id: saleId, ...(saleDoc as Record<string, unknown>) } as never,
        [saleItemObj as never],
        {
          saleDate: '2026-11-20',
          paymentMethod: 'Cash',
          notes: 'Tried adding inactive',
          items: [
            { productId: active.id, unitName: 'Piece', conversionFactor: 1, quantity: 1, salePricePerUnit: 150 },
            { productId: laterInactive.id, unitName: 'Piece', conversionFactor: 1, quantity: 1, salePricePerUnit: 150 },
          ],
        }
      )
    ).rejects.toThrow(/inactive and cannot be added/i);

    // Updating notes/payment on a historical sale that ALREADY had a now-inactive product must still succeed
    state.docs.set(`shops/${UID}/products/${active.id}`, {
      ...state.docs.get(`shops/${UID}/products/${active.id}`)!,
      isActive: false,
    });
    await expect(
      editSale(
        UID,
        { id: saleId, ...(saleDoc as Record<string, unknown>) } as never,
        [saleItemObj as never],
        {
          saleDate: '2026-11-20',
          paymentMethod: 'Online',
          notes: 'Updated payment method',
          items: [{ productId: active.id, unitName: 'Piece', conversionFactor: 1, quantity: 1, salePricePerUnit: 150 }],
        }
      )
    ).resolves.toBeUndefined();
    expect(state.docs.get(`shops/${UID}/sales/${saleId}`)?.paymentMethod).toBe('Online');
  });

  it('rejects inactive products in createStaffSale and queueOfflineSale while preserving prior staff reconciliation', async () => {
    const staff = makeStaffMember();
    const inactiveStaffItem = seedStaffCatalog('p_staff_off', {
      name: 'Archived Soap',
      currentStock: 15,
      isActive: false,
    });
    seedProduct('p_staff_off', { name: 'Archived Soap', currentStock: 15, isActive: false });

    await expect(
      createStaffSale(UID, staff, {
        saleDate: '2026-11-28',
        paymentMethod: 'Cash',
        notes: '',
        items: [{ productId: inactiveStaffItem.productId, quantity: 1, unitName: 'Piece', conversionFactor: 1 }],
      })
    ).rejects.toThrow(/inactive and cannot be sold/i);
    expect(state.docs.get(`shops/${UID}/staffCatalog/p_staff_off`)?.currentStock).toBe(15);

    const catalogMap = new Map([[inactiveStaffItem.productId, inactiveStaffItem]]);
    expect(() =>
      createAndEnqueueOfflineSale(UID, staff, catalogMap, {
        saleDate: '2026-11-28',
        paymentMethod: 'Cash',
        notes: '',
        items: [{ productId: inactiveStaffItem.productId, quantity: 1, unitName: 'Piece', conversionFactor: 1 }],
      })
    ).toThrow(/inactive and cannot be sold/i);

    // A previously recorded staffSale made BEFORE deactivation still reconciles cleanly into owner ledger
    const oldStaffSale: StaffSale = {
      id: 'ss_old_1',
      ownerUid: UID,
      shopId: UID,
      saleNumber: 'STF-100',
      saleDate: '2026-11-27',
      saleDateTime: '2026-11-27 10:00 AM',
      paymentMethod: 'Cash',
      totalAmount: 150,
      totalQuantity: 1,
      itemCount: 1,
      items: [
        {
          productId: 'p_staff_off',
          productName: 'Archived Soap',
          quantity: 1,
          unitName: 'Piece',
          unitQuantity: 1,
          conversionFactor: 1,
          baseQuantity: 1,
          salePricePerUnit: 150,
          lineTotal: 150,
        },
      ],
      staffId: staff.id,
      staffAuthUid: staff.authUid,
      staffName: staff.name,
      staffUsername: staff.username,
      notes: '',
      status: 'completed',
      syncedToLedger: false,
    };
    state.docs.set(`shops/${UID}/staffSales/ss_old_1`, { ...oldStaffSale });
    await expect(reconcileStaffSaleToOwnerLedger(UID, oldStaffSale)).resolves.toBeUndefined();
    expect(state.docs.get(`shops/${UID}/staffSales/ss_old_1`)?.syncedToLedger).toBe(true);
    expect(state.docs.get(`shops/${UID}/products/p_staff_off`)?.currentStock).toBe(14);
  });

  it('excludes inactive products from database search queries and all upsell/related suggestions', async () => {
    const p1 = seedProduct('p_diaper', {
      name: 'Pampers Active Baby Medium',
      categoryId: 'cat_diapers',
      categoryName: 'Diapers',
      brandId: 'br_pampers',
      brandName: 'Pampers',
      currentStock: 25,
      isActive: true,
    });
    const p2 = seedProduct('p_wipes_off', {
      name: 'Pampers Baby Wipes Fresh',
      categoryId: 'cat_wipes',
      categoryName: 'Baby Wipes',
      brandId: 'br_pampers',
      brandName: 'Pampers',
      currentStock: 40,
      isActive: false,
    });
    const p3 = seedProduct('p_lotion_on', {
      name: 'Johnsons Baby Lotion',
      categoryId: 'cat_care',
      categoryName: 'Baby Care',
      brandId: 'br_johnsons',
      brandName: 'Johnsons',
      currentStock: 30,
      isActive: true,
    });

    const dbActive = await queryProductsFromDatabase({ shopId: UID, role: 'owner' });
    expect(dbActive.map((i) => i.id)).toEqual(['p_diaper', 'p_lotion_on']);

    const fullCatalog = mapProductsToSearchable([p1, p2, p3]);
    expect(searchProductsCatalog(fullCatalog, 'pampers').map((r) => r.item.id)).toEqual(['p_diaper']);
    expect(searchProductsCatalog(fullCatalog, 'wipes')).toHaveLength(0);

    const related = getProductRelatedSuggestions({
      shopId: UID,
      productId: p1.id,
      catalog: fullCatalog,
    });
    expect(related.some((r) => r.product.id === p2.id)).toBe(false);

    const upsell = getHybridUpsellSuggestion({
      shopId: UID,
      cartItems: [{ productId: p1.id, quantity: 1 }],
      catalog: fullCatalog,
    });
    expect(upsell.suggestion?.product.id).not.toBe(p2.id);

    const geminiCheck = validateGeminiUpsellResponse({
      candidateId: p2.id,
      romanUrduPrompt: 'Wipes bhi rakh lain?',
      cartItems: [{ productId: p1.id, quantity: 1 }],
      catalog: fullCatalog,
    });
    expect(geminiCheck).toBeNull();
  });
});
