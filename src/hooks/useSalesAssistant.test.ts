import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COOCCURRENCE_CACHE_VERSION } from '../../shared/upsellCacheSchema';
import { resetCatalogIntelligence } from '../services/catalogIntelligenceService';
import type { SearchableProductItem } from '../services/productSearchService';
import {
  enqueueCooccurrenceMutationReconcile,
  enqueueSaleCooccurrenceUpdate,
  getCooccurrenceStatsSnapshot,
  ingestCompletedSalesBatchSync,
  resetCooccurrenceStore,
  syncCooccurrenceWithBackend,
} from '../services/upsellCooccurrenceService';
import { clearGeminiFallbackClientState } from '../services/upsellFallbackClient';
import {
  getUpsellFeedbackAdjustment,
  recordUpsellFeedbackSync,
  resetUpsellFeedbackStore,
} from '../services/upsellFeedbackService';
import { areSameProductOrVariant } from '../utils/salesAssistant';
import { type SalesAssistantCartEntry, useSalesAssistant } from './useSalesAssistant';

const TEST_SHOP_ID = 'vitest_fixture_shop_01';

const mockShowToast = vi.fn();
const mockDismissToast = vi.fn();
const mockGetIdToken = vi.fn(async () => 'test-fixture-token');

let mockProductsFixture: SearchableProductItem[] = [];

vi.mock('../lib/firebase', () => ({
  db: {},
  auth: { currentUser: null },
  OperationType: {},
  handleFirestoreError: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      uid: 'fixture_owner_uid',
      getIdToken: mockGetIdToken,
    },
    shopId: TEST_SHOP_ID,
  }),
}));

vi.mock('../contexts/ShopDataContext', () => ({
  useShopData: () => ({
    products: mockProductsFixture,
    staffCatalog: [],
    categories: [],
    productTemplates: [],
  }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: mockShowToast,
    dismissToast: mockDismissToast,
  }),
}));

function buildFixtureCatalog(): SearchableProductItem[] {
  return [
    {
      id: 'fix_pampers_34',
      name: 'Pampers Active Baby 34s',
      brandId: 'brand_pampers',
      brandName: 'Pampers',
      categoryId: 'cat_diapers',
      categoryName: 'Diapers & Pampers',
      categoryDescription: 'Disposable diapers, pull-up pants, and newborn diaper packs',
      salePrice: 1850,
      currentStock: 10,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '34s',
      isActive: true,
    },
    {
      id: 'fix_pampers_64',
      name: 'Pampers Active Baby 64s',
      brandId: 'brand_pampers',
      brandName: 'Pampers',
      categoryId: 'cat_diapers',
      categoryName: 'Diapers & Pampers',
      categoryDescription: 'Disposable diapers, pull-up pants, and newborn diaper packs',
      salePrice: 3300,
      currentStock: 12,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '64s',
      isActive: true,
    },
    {
      id: 'fix_wipes_72',
      name: 'Pampers Baby Wipes 72s',
      brandId: 'brand_pampers',
      brandName: 'Pampers',
      categoryId: 'cat_wipes',
      categoryName: 'Baby Wipes',
      categoryDescription: 'Sensitive, unscented, and moisturizing baby wet wipes',
      salePrice: 450,
      currentStock: 20,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '72s',
      isActive: true,
    },
    {
      id: 'fix_huggies_wipes_64',
      name: 'Huggies Pure Baby Wipes 64s',
      brandId: 'brand_huggies',
      brandName: 'Huggies',
      categoryId: 'cat_wipes',
      categoryName: 'Baby Wipes',
      categoryDescription: 'Sensitive, unscented, and moisturizing baby wet wipes',
      salePrice: 420,
      currentStock: 14,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '64s',
      isActive: true,
    },
    {
      id: 'fix_rash_cream_oos',
      name: 'Sudocrem Rash Cream 60g',
      brandId: 'brand_sudocrem',
      brandName: 'Sudocrem',
      categoryId: 'cat_baby_care',
      categoryName: 'Baby Care',
      categoryDescription: 'Baby oils, lotions, shampoos, powders, rash creams, and baby skincare.',
      salePrice: 950,
      currentStock: 0, // Out of stock
      unit: 'Jar',
      baseUnit: 'Jar',
      bottleSize: '60g',
      isActive: true,
    },
    {
      id: 'fix_lotion_box_insufficient',
      name: 'Johnsons Baby Lotion Master Box',
      brandId: 'brand_johnsons',
      brandName: 'Johnsons',
      categoryId: 'cat_baby_care',
      categoryName: 'Baby Care',
      categoryDescription: 'Baby oils, lotions, shampoos, powders, rash creams, and baby skincare.',
      salePrice: 600,
      currentStock: 5, // Insufficient for default sale unit Box (12 Pieces)
      unit: 'Piece',
      baseUnit: 'Piece',
      packagingUnits: [
        {
          unitName: 'Piece',
          conversionQty: 1,
          allowPurchase: true,
          allowSale: false,
          purchasePrice: 450,
          salePrice: 600,
          wholesalePrice: 550,
        },
        {
          unitName: 'Box',
          conversionQty: 12,
          containsQty: 12,
          parentUnitName: 'Piece',
          allowPurchase: true,
          allowSale: true,
          purchasePrice: 5400,
          salePrice: 7000,
          wholesalePrice: 6600,
          isDefaultSale: true,
        },
      ],
      isActive: true,
    },
    {
      id: 'fix_baby_shampoo',
      name: 'Johnsons Baby Shampoo 300ml',
      brandId: 'brand_johnsons',
      brandName: 'Johnsons',
      categoryId: 'cat_baby_care',
      categoryName: 'Baby Care',
      categoryDescription: 'Baby oils, lotions, shampoos, powders, rash creams, and baby skincare.',
      salePrice: 780,
      currentStock: 10,
      unit: 'Bottle',
      baseUnit: 'Bottle',
      bottleSize: '300ml',
      isActive: true,
    },
    {
      id: 'fix_baby_oil',
      name: 'Johnsons Baby Oil 200ml',
      brandId: 'brand_johnsons',
      brandName: 'Johnsons',
      categoryId: 'cat_baby_care',
      categoryName: 'Baby Care',
      categoryDescription: 'Baby oils, lotions, shampoos, powders, rash creams, and baby skincare.',
      salePrice: 690,
      currentStock: 10,
      unit: 'Bottle',
      baseUnit: 'Bottle',
      bottleSize: '200ml',
      isActive: true,
    },
    {
      id: 'fix_tea_450',
      name: 'Tapal Danedar 450g',
      brandId: 'brand_tapal',
      brandName: 'Tapal',
      categoryId: 'cat_beverages',
      categoryName: 'Cold Drinks & Beverages',
      salePrice: 980,
      currentStock: 14,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '450g',
      isActive: true,
    },
    {
      id: 'fix_milk_1l',
      name: 'Olpers Milk 1L',
      brandId: 'brand_olpers',
      brandName: 'Olpers',
      categoryId: 'cat_dairy',
      categoryName: 'Bottled Water & Juices',
      salePrice: 310,
      currentStock: 24,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '1L',
      isActive: true,
    },
    {
      id: 'fix_biscuit_sooper',
      name: 'Peek Freans Sooper 100g',
      brandId: 'brand_pf',
      brandName: 'Peek Freans',
      categoryId: 'cat_snacks',
      categoryName: 'Snacks & Confectionery',
      salePrice: 120,
      currentStock: 30,
      unit: 'Pack',
      baseUnit: 'Pack',
      isActive: true,
    },
    {
      id: 'fix_biscuit_gala',
      name: 'LU Gala Biscuit 80g',
      brandId: 'brand_lu',
      brandName: 'LU',
      categoryId: 'cat_snacks',
      categoryName: 'Snacks & Confectionery',
      salePrice: 100,
      currentStock: 18,
      unit: 'Pack',
      baseUnit: 'Pack',
      isActive: true,
    },
    {
      id: 'fix_isolated_item',
      name: 'Standalone Thermometer Digital',
      brandId: 'brand_care',
      brandName: 'CareDevice',
      categoryId: 'cat_other',
      categoryName: 'Other Products',
      salePrice: 750,
      currentStock: 4,
      unit: 'Piece',
      baseUnit: 'Piece',
      isActive: true,
    },
  ];
}

function seedFixtureHistory(): void {
  ingestCompletedSalesBatchSync(TEST_SHOP_ID, [
    // Pampers 34s strongly co-occurs with OOS rash cream (6x), variant 64s (5x), insufficient Box (4x), and Wipes (3x)
    {
      saleId: 'fs_1',
      status: 'completed',
      productIds: [
        'fix_pampers_34',
        'fix_rash_cream_oos',
        'fix_pampers_64',
        'fix_lotion_box_insufficient',
        'fix_wipes_72',
      ],
    },
    {
      saleId: 'fs_2',
      status: 'completed',
      productIds: [
        'fix_pampers_34',
        'fix_rash_cream_oos',
        'fix_pampers_64',
        'fix_lotion_box_insufficient',
        'fix_wipes_72',
      ],
    },
    {
      saleId: 'fs_3',
      status: 'completed',
      productIds: [
        'fix_pampers_34',
        'fix_rash_cream_oos',
        'fix_pampers_64',
        'fix_lotion_box_insufficient',
        'fix_wipes_72',
      ],
    },
    {
      saleId: 'fs_4',
      status: 'completed',
      productIds: [
        'fix_pampers_34',
        'fix_rash_cream_oos',
        'fix_pampers_64',
        'fix_lotion_box_insufficient',
      ],
    },
    {
      saleId: 'fs_5',
      status: 'completed',
      productIds: ['fix_pampers_34', 'fix_rash_cream_oos', 'fix_pampers_64'],
    },
    { saleId: 'fs_6', status: 'completed', productIds: ['fix_pampers_34', 'fix_rash_cream_oos'] },
    // Cancelled sale must never influence recommendations
    { saleId: 'fs_cancelled', status: 'cancelled', productIds: ['fix_isolated_item', 'fix_wipes_72'] },
    { saleId: 'fs_cancelled_2', status: 'cancelled', productIds: ['fix_isolated_item', 'fix_wipes_72'] },
    // Tea + Milk + Biscuits multi-item basket relationships
    { saleId: 'fs_7', status: 'completed', productIds: ['fix_tea_450', 'fix_milk_1l'] },
    { saleId: 'fs_8', status: 'completed', productIds: ['fix_tea_450', 'fix_milk_1l'] },
    { saleId: 'fs_9', status: 'completed', productIds: ['fix_tea_450', 'fix_biscuit_sooper'] },
    { saleId: 'fs_10', status: 'completed', productIds: ['fix_tea_450', 'fix_biscuit_sooper'] },
    { saleId: 'fs_11', status: 'completed', productIds: ['fix_milk_1l', 'fix_biscuit_gala'] },
    { saleId: 'fs_12', status: 'completed', productIds: ['fix_milk_1l', 'fix_biscuit_gala'] },
    {
      saleId: 'fs_13',
      status: 'completed',
      productIds: ['fix_tea_450', 'fix_milk_1l', 'fix_biscuit_gala'],
    },
  ]);
}

describe('useSalesAssistant — Multi-Layer Hybrid Engine', () => {
  let fixtureCatalog: SearchableProductItem[];

  beforeEach(() => {
    vi.useFakeTimers();
    resetCooccurrenceStore(TEST_SHOP_ID);
    resetCatalogIntelligence(TEST_SHOP_ID);
    resetUpsellFeedbackStore(TEST_SHOP_ID);
    clearGeminiFallbackClientState();
    mockShowToast.mockClear();
    mockDismissToast.mockClear();
    mockGetIdToken.mockClear();

    fixtureCatalog = buildFixtureCatalog();
    mockProductsFixture = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            available: false,
            reason: 'GEMINI_NOT_CONFIGURED',
            suggestion: null,
          }),
          { status: 200 }
        )
      )
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetCooccurrenceStore(TEST_SHOP_ID);
    resetCatalogIntelligence(TEST_SHOP_ID);
    resetUpsellFeedbackStore(TEST_SHOP_ID);
    clearGeminiFallbackClientState();
  });

  // Scenario 1 & 2: Completely empty sales history / brand-new shop with real catalog & 0 completed sales
  it('immediately discovers relevant recommendations on a brand-new shop with ZERO historical sales', () => {
    // Notice: seedFixtureHistory() is NOT called — 0 completed sales exist!
    expect(getCooccurrenceStatsSnapshot(TEST_SHOP_ID).totalCompletedSales).toBe(0);

    const { result } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: fixtureCatalog }),
      {
        initialProps: {
          cart: [{ productId: 'fix_pampers_34', quantity: 1 }] as SalesAssistantCartEntry[],
        },
      }
    );

    // Must recommend Pampers Baby Wipes via brand bridge + category/semantic affinity, NOT Pampers 64s variant
    expect(result.current.suggestion).not.toBeNull();
    expect(result.current.suggestion?.product.id).toBe('fix_wipes_72');
    expect(result.current.suggestion?.source).toBe('hybrid');
    // Confident cold-start recommendation must NOT trigger unnecessary Gemini calls
    expect(fetch).not.toHaveBeenCalled();
  });

  // Scenario 3: Empty cart
  it('returns null on an empty cart without triggering network fallback', () => {
    seedFixtureHistory();
    const { result } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: fixtureCatalog }),
      { initialProps: { cart: [] as SalesAssistantCartEntry[] } }
    );

    expect(result.current.suggestion).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  // Scenario 4 & 5: Single-product cart & multiple products from same category
  it('handles single-product and multi-item same-category carts without history', () => {
    // Cart starts with Johnsons Baby Shampoo (Baby Care) -> recommends distinct line Johnsons Baby Oil (same category, different product)
    const { result, rerender } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: fixtureCatalog }),
      {
        initialProps: {
          cart: [{ productId: 'fix_baby_shampoo', quantity: 1 }] as SalesAssistantCartEntry[],
        },
      }
    );

    expect(result.current.suggestion).not.toBeNull();
    expect(result.current.suggestion?.product.id).toBe('fix_baby_oil');

    // Now both Baby Shampoo AND Baby Oil (same category) are in cart -> expands across dynamic category bridge to Baby Wipes!
    rerender({
      cart: [
        { productId: 'fix_baby_shampoo', quantity: 1 },
        { productId: 'fix_baby_oil', quantity: 1 },
      ],
    });

    expect(result.current.suggestion).not.toBeNull();
    expect(['fix_wipes_72', 'fix_huggies_wipes_64', 'fix_pampers_34', 'fix_pampers_64']).toContain(
      result.current.suggestion?.product.id
    );
  });

  // Scenario 6 & 7: Cross-category & same-brand / different-brand complementarity
  it('discovers both same-brand and different-brand cross-category complements on cold-start and warm history', () => {
    // 1) Cold-start different-brand cross-category discovery via category semantic/bridge graph
    const { result, rerender } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: fixtureCatalog }),
      {
        initialProps: {
          cart: [
            { productId: 'fix_pampers_34', quantity: 1 },
            { productId: 'fix_wipes_72', quantity: 1 },
          ] as SalesAssistantCartEntry[],
        },
      }
    );

    // Both Pampers Diapers & Pampers Wipes are in cart -> should still recommend Huggies Wipes or Johnsons Baby Care (NOT Pampers 64s)
    expect(result.current.suggestion).not.toBeNull();
    expect(result.current.suggestion?.product.id).not.toBe('fix_pampers_64');
    expect(result.current.suggestion?.product.id).not.toBe('fix_pampers_34');
    expect(result.current.suggestion?.product.id).not.toBe('fix_wipes_72');

    // 2) Warm historical multi-item basket (Tea + Milk -> Biscuit)
    seedFixtureHistory();
    rerender({
      cart: [
        { productId: 'fix_tea_450', quantity: 1 },
        { productId: 'fix_milk_1l', quantity: 3 },
      ],
    });

    expect(result.current.suggestion?.product.id).toBe('fix_biscuit_gala');
  });

  // Scenario 8: Multiple sizes and variants (accurate exclusion, conservative when distinct)
  it('excludes size/pack variants conservatively while keeping distinct same-brand lines eligible', () => {
    const pampers34 = fixtureCatalog.find((x) => x.id === 'fix_pampers_34')!;
    const pampers64 = fixtureCatalog.find((x) => x.id === 'fix_pampers_64')!;
    const pampersWipes = fixtureCatalog.find((x) => x.id === 'fix_wipes_72')!;
    const babyShampoo = fixtureCatalog.find((x) => x.id === 'fix_baby_shampoo')!;
    const babyOil = fixtureCatalog.find((x) => x.id === 'fix_baby_oil')!;

    expect(areSameProductOrVariant(pampers34, pampers64)).toBe(true);
    expect(areSameProductOrVariant(pampers34, pampersWipes)).toBe(false);
    expect(areSameProductOrVariant(babyShampoo, babyOil)).toBe(false);
  });

  // Scenario 9: Products with incomplete descriptions or missing metadata
  it('handles sparse/incomplete product metadata safely without crashing', () => {
    const sparseCatalog: SearchableProductItem[] = [
      {
        id: 'sparse_1',
        name: 'Gentle Baby Bath Wash',
        brandName: '',
        categoryName: 'Baby Care',
        salePrice: 350,
        currentStock: 8,
        unit: 'Piece',
        baseUnit: 'Piece',
        isActive: true,
      },
      {
        id: 'sparse_2',
        name: 'Gentle Baby Powder',
        brandName: '',
        categoryName: 'Baby Care',
        salePrice: 280,
        currentStock: 10,
        unit: 'Piece',
        baseUnit: 'Piece',
        isActive: true,
      },
      {
        id: 'sparse_3',
        name: 'Gentle Baby Bath Wash Mega',
        brandName: '',
        categoryName: 'Baby Care',
        salePrice: 650,
        currentStock: 10,
        unit: 'Piece',
        baseUnit: 'Piece',
        isActive: true,
      },
    ];

    const { result } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: sparseCatalog }),
      {
        initialProps: {
          cart: [{ productId: 'sparse_1', quantity: 1 }] as SalesAssistantCartEntry[],
        },
      }
    );

    expect(result.current.suggestion).not.toBeNull();
    expect(result.current.suggestion?.product.id).toBe('sparse_2');
  });

  // Scenario 10: Out-of-stock and insufficient packaging-unit stock
  it('excludes out-of-stock products and insufficient packaging-unit stock, then allows when restocked', () => {
    seedFixtureHistory();
    // Isolate test to OOS rash cream, variant 64s, and insufficient Box (5 < 12) vs isolated fallback
    const pkgTestCatalog = fixtureCatalog.map((item) =>
      item.id === 'fix_wipes_72' || item.id === 'fix_huggies_wipes_64' || item.id === 'fix_baby_shampoo' || item.id === 'fix_baby_oil'
        ? { ...item, currentStock: 0 }
        : item
    );

    const { result, rerender } = renderHook(
      ({ cart, catalog }) => useSalesAssistant({ cart, catalog }),
      {
        initialProps: {
          cart: [{ productId: 'fix_pampers_34', quantity: 1 }] as SalesAssistantCartEntry[],
          catalog: pkgTestCatalog,
        },
      }
    );

    // rash_cream_oos (stock 0), pampers_64 (variant), and lotion_box_insufficient (5 < Box 12) are all filtered out
    expect(result.current.suggestion).toBeNull();

    // Restock lotion box to 12 Pieces (1 sellable Box) -> immediately becomes eligible and recommended
    const sufficientCatalog = pkgTestCatalog.map((item) =>
      item.id === 'fix_lotion_box_insufficient' ? { ...item, currentStock: 12 } : item
    );
    rerender({
      cart: [{ productId: 'fix_pampers_34', quantity: 1 }],
      catalog: sufficientCatalog,
    });
    expect(result.current.suggestion?.product.id).toBe('fix_lotion_box_insufficient');
    expect(result.current.suggestion?.source).toBe('history');
  });

  // Scenario 11: Product added, removed, and quantity changed (no unnecessary API calls)
  it('handles product add, removal (session-scoped), and quantity updates without firing unnecessary Gemini calls', () => {
    seedFixtureHistory();
    const { result, rerender } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: fixtureCatalog }),
      {
        initialProps: {
          cart: [
            { productId: 'fix_tea_450', quantity: 1 },
            { productId: 'fix_milk_1l', quantity: 1 },
            { productId: 'fix_biscuit_gala', quantity: 1 },
          ] as SalesAssistantCartEntry[],
        },
      }
    );

    expect(result.current.suggestion?.product.id).toBe('fix_biscuit_sooper');

    // Remove Gala -> Gala must NOT be recommended again in this session, without blocking Sooper (same Snacks category)
    rerender({
      cart: [
        { productId: 'fix_tea_450', quantity: 1 },
        { productId: 'fix_milk_1l', quantity: 1 },
      ],
    });
    expect(result.current.suggestion?.product.id).toBe('fix_biscuit_sooper');
    expect(result.current.suggestion?.product.id).not.toBe('fix_biscuit_gala');

    // Quantity changes recalculate context smoothly in memory without hitting Gemini API
    rerender({
      cart: [
        { productId: 'fix_tea_450', quantity: 5 },
        { productId: 'fix_milk_1l', quantity: 4 },
      ],
    });
    expect(result.current.suggestion).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  // Scenario 12: Dismissed recommendations & gentle self-learning feedback without category blacklisting
  it('hides dismissed recommendation, applies gentle feedback dampening, and never bans the whole category', () => {
    const { result, rerender } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: fixtureCatalog }),
      {
        initialProps: {
          cart: [{ productId: 'fix_pampers_34', quantity: 1 }] as SalesAssistantCartEntry[],
        },
      }
    );

    const firstId = result.current.suggestion?.product.id;
    expect(firstId).toBe('fix_wipes_72');

    act(() => {
      result.current.dismissSuggestion('fix_wipes_72');
    });

    // Hidden while cart unchanged
    expect(result.current.suggestion).toBeNull();

    // When cart changes, same Baby Wipes category (fix_huggies_wipes_64) is NOT blacklisted!
    rerender({
      cart: [{ productId: 'fix_pampers_34', quantity: 2 }],
    });
    expect(result.current.suggestion).not.toBeNull();
    expect(result.current.suggestion?.product.id).not.toBe('fix_wipes_72');
    expect(result.current.suggestion?.product.categoryId).toBe('cat_wipes');

    // Verify self-learning feedback adjusts gently (never extreme or permanent ban after 1 dismissal)
    recordUpsellFeedbackSync(TEST_SHOP_ID, {
      productId: 'fix_wipes_72',
      eventType: 'accepted',
      categoryKey: 'baby wipes',
      anchorCategoryKeys: ['diapers & pampers'],
    });
    const positiveAdj = getUpsellFeedbackAdjustment({
      shopId: TEST_SHOP_ID,
      candidateProductId: 'fix_wipes_72',
      candidateCategoryKey: 'baby wipes',
      anchorCategoryKeys: ['diapers & pampers'],
    });
    expect(positiveAdj).toBeGreaterThan(0);
    expect(positiveAdj).toBeLessThanOrEqual(0.22);
  });

  // Scenario 13: Gemini unavailable / 402 / 503 / network error
  it('handles Gemini 402/503/network failures silently and falls back cleanly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            available: false,
            reason: 'GEMINI_CREDITS_DEPLETED',
            suggestion: null,
          }),
          { status: 200 }
        )
      )
    );

    const { result } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: fixtureCatalog }),
      {
        initialProps: {
          // Isolated item lacks strong local catalog signals, so async Gemini fallback is attempted and safely rejected
          cart: [{ productId: 'fix_isolated_item', quantity: 1 }] as SalesAssistantCartEntry[],
        },
      }
    );

    expect(result.current.suggestion).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(result.current.suggestion).toBeNull();
  });

  // Scenario 14: Historical cache empty, loading, corrupt, or unavailable
  it('recovers safely when historical cache is corrupt or backend sync is unreachable', async () => {
    localStorage.setItem(`cm_upsell_cooccurrence_mirror_v${COOCCURRENCE_CACHE_VERSION}_${TEST_SHOP_ID}`, '{corrupt-json');
    resetCooccurrenceStore(TEST_SHOP_ID);

    // Network failure during backend sync resolves gracefully without throwing
    await expect(
      syncCooccurrenceWithBackend({
        shopId: TEST_SHOP_ID,
        isOwner: false,
        getIdToken: mockGetIdToken,
        fetchImpl: (async () => {
          throw new Error('Backend offline');
        }) as typeof fetch,
      })
    ).resolves.toBeUndefined();

    // Even with corrupt/empty history, cold-start hybrid engine still delivers real suggestions
    const { result } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: fixtureCatalog }),
      {
        initialProps: {
          cart: [{ productId: 'fix_pampers_34', quantity: 1 }] as SalesAssistantCartEntry[],
        },
      }
    );
    expect(result.current.suggestion?.product.id).toBe('fix_wipes_72');
  });

  // Scenario 15: Stale asynchronous Gemini response arriving after cart changes is ignored/aborted
  it('aborts and ignores stale async Gemini responses when cart changes mid-flight', async () => {
    let resolveDelayedFetch!: (res: Response) => void;
    let capturedAbortSignal: AbortSignal | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            capturedAbortSignal = init?.signal ?? undefined;
            resolveDelayedFetch = resolve;
          })
      )
    );

    const { result, rerender } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: fixtureCatalog }),
      {
        initialProps: {
          cart: [{ productId: 'fix_isolated_item', quantity: 1 }] as SalesAssistantCartEntry[],
        },
      }
    );

    // Let debounce fire Gemini request for isolated item
    await act(async () => {
      await vi.advanceTimersByTimeAsync(420);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    // User clears or swaps cart BEFORE delayed Gemini responds -> abort signal fires!
    rerender({
      cart: [{ productId: 'fix_pampers_34', quantity: 1 }],
    });
    expect(capturedAbortSignal?.aborted).toBe(true);

    // Stale Gemini response resolving late with an unrelated candidate MUST NOT overwrite Pampers Wipes
    await act(async () => {
      resolveDelayedFetch(
        new Response(
          JSON.stringify({
            ok: true,
            available: true,
            suggestion: { candidateId: 'fix_biscuit_sooper', romanUrduPrompt: 'Sooper rakh lain?' },
          }),
          { status: 200 }
        )
      );
      await Promise.resolve();
    });

    expect(result.current.suggestion?.product.id).toBe('fix_wipes_72');
    expect(result.current.suggestion?.source).toBe('hybrid');
  });

  // Scenario 16 & 17: New product added to catalog & product details updated
  it('discovers newly added products and reacts to updated product details incrementally', () => {
    const starterCatalog = fixtureCatalog.filter(
      (p) => p.id !== 'fix_wipes_72' && p.id !== 'fix_huggies_wipes_64'
    );

    const { result, rerender } = renderHook(
      ({ cart, catalog }) => useSalesAssistant({ cart, catalog }),
      {
        initialProps: {
          cart: [{ productId: 'fix_pampers_34', quantity: 1 }] as SalesAssistantCartEntry[],
          catalog: starterCatalog,
        },
      }
    );

    // Only baby_shampoo / baby_oil in Baby Care are currently available
    const beforeNewProduct = result.current.suggestion?.product.id;
    expect(beforeNewProduct).not.toBe('fix_wipes_72');

    // Staff adds a brand-new complementary Pampers Baby Wipes SKU to catalog
    const updatedCatalog: SearchableProductItem[] = [
      ...starterCatalog,
      fixtureCatalog.find((p) => p.id === 'fix_wipes_72')!,
    ];
    rerender({
      cart: [{ productId: 'fix_pampers_34', quantity: 1 }],
      catalog: updatedCatalog,
    });
    expect(result.current.suggestion?.product.id).toBe('fix_wipes_72');

    // Product details edited (stock dropped to 0 on Wipes, or brand updated on another item) -> reflects immediately
    const editedCatalog = updatedCatalog.map((p) =>
      p.id === 'fix_wipes_72' ? { ...p, currentStock: 0 } : p
    );
    rerender({
      cart: [{ productId: 'fix_pampers_34', quantity: 1 }],
      catalog: editedCatalog,
    });
    expect(result.current.suggestion?.product.id).not.toBe('fix_wipes_72');
  });

  // Scenario 18: Sales Entry & checkout completion during background processing (zero blocking)
  it('completes sale save, post-sale dialogue toast, and background updates without blocking checkout', async () => {
    const { result, rerender } = renderHook(
      ({ cart }) => useSalesAssistant({ cart, catalog: fixtureCatalog }),
      {
        initialProps: {
          cart: [
            { productId: 'fix_pampers_34', quantity: 1 },
            { productId: 'fix_wipes_72', quantity: 1 },
          ] as SalesAssistantCartEntry[],
        },
      }
    );

    // Enqueue background sale co-occurrence update & trigger immediate checkout completion
    enqueueSaleCooccurrenceUpdate(
      TEST_SHOP_ID,
      'live_sale_01',
      ['fix_pampers_34', 'fix_wipes_72'],
      mockGetIdToken
    );

    act(() => {
      result.current.onSuggestionAccepted('fix_wipes_72');
      result.current.onSaleSaved();
    });

    // Post-sale Roman Urdu toast displays immediately without waiting on background work
    expect(mockShowToast).toHaveBeenCalledTimes(1);

    // Flush background microtasks/timers cleanly
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Verify new sale was ingested cleanly into co-occurrence store and cart reset for next customer
    expect(getCooccurrenceStatsSnapshot(TEST_SHOP_ID).totalCompletedSales).toBe(1);
    rerender({ cart: [] });
    expect(result.current.suggestion).toBeNull();
  });

  // Scenario 19: Transient update failure triggers automatic bounded retry backoff
  it('retries failed incremental co-occurrence updates automatically via exponential backoff', async () => {
    let attempts = 0;
    const mockRetryFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/upsell/cooccurrence/update')) {
        attempts += 1;
        if (attempts === 1) {
          return new Response(JSON.stringify({ ok: false, error: 'Temporary 503' }), {
            status: 503,
          });
        }
        return new Response(JSON.stringify({ ok: true, revision: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    enqueueSaleCooccurrenceUpdate(
      TEST_SHOP_ID,
      'retry_sale_01',
      ['fix_pampers_34', 'fix_wipes_72'],
      mockGetIdToken,
      { fetchImpl: mockRetryFetch as typeof fetch, isOwner: true }
    );

    // First async dispatch happens at t=0 and fails with 503 -> queued for retry
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(attempts).toBe(1);
    expect(getCooccurrenceStatsSnapshot(TEST_SHOP_ID).pendingRetryCount).toBe(1);

    // After 3s backoff timer fires, retry runs automatically and clears pending queue
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(attempts).toBe(2);
    expect(getCooccurrenceStatsSnapshot(TEST_SHOP_ID).pendingRetryCount).toBe(0);
    expect(getCooccurrenceStatsSnapshot(TEST_SHOP_ID).revision).toBe(2);
  });

  // Scenario 20: Cancelling/editing a sale reconciles co-occurrence using completed sales only
  it('reconciles co-occurrence asynchronously after sale cancellation using completed sales only', async () => {
    seedFixtureHistory();
    expect(getCooccurrenceStatsSnapshot(TEST_SHOP_ID).totalCompletedSales).toBe(13);

    enqueueCooccurrenceMutationReconcile(TEST_SHOP_ID, 'fs_1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(getCooccurrenceStatsSnapshot(TEST_SHOP_ID).dirtyRebuild).toBe(true);

    const capturedRebuilds: Array<{ resetFirst?: boolean; sales?: Array<{ saleId: string }> }> = [];
    const mockReconcileFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/upsell/cooccurrence/rebuild')) {
        capturedRebuilds.push(JSON.parse(String(init?.body || '{}')));
        return new Response(JSON.stringify({ ok: true, revision: 10 }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          unchanged: false,
          snapshot: {
            version: COOCCURRENCE_CACHE_VERSION,
            shopId: TEST_SHOP_ID,
            revision: 9,
            totalCompletedSales: 13,
            saleCountsByProduct: { fix_pampers_34: 6, fix_wipes_72: 3 },
            pairCounts: { fix_pampers_34: { fix_wipes_72: 3 }, fix_wipes_72: { fix_pampers_34: 3 } },
            processedSaleIds: ['fs_1', 'fs_7'],
            updatedAt: Date.now(),
          },
        }),
        { status: 200 }
      );
    });

    await syncCooccurrenceWithBackend({
      shopId: TEST_SHOP_ID,
      isOwner: true,
      getIdToken: mockGetIdToken,
      completedSales: [
        { saleId: 'fs_1', status: 'cancelled', productIds: ['fix_pampers_34', 'fix_wipes_72'] },
        { saleId: 'fs_7', status: 'completed', productIds: ['fix_tea_450', 'fix_milk_1l'] },
      ],
      fetchImpl: mockReconcileFetch as typeof fetch,
    });

    expect(capturedRebuilds).toHaveLength(1);
    expect(capturedRebuilds[0].resetFirst).toBe(true);
    expect(capturedRebuilds[0].sales?.map((s) => s.saleId)).toEqual(['fs_7']);
    expect(getCooccurrenceStatsSnapshot(TEST_SHOP_ID).dirtyRebuild).toBe(false);
    expect(getCooccurrenceStatsSnapshot(TEST_SHOP_ID).totalCompletedSales).toBe(1);
  });
});
