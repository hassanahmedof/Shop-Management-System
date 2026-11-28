import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase', () => ({
  db: {},
  auth: { currentUser: null },
}));

import { resetCatalogIntelligence } from '../services/catalogIntelligenceService';
import type { SearchableProductItem } from '../services/productSearchService';
import {
  ingestCompletedSalesBatchSync,
  resetCooccurrenceStore,
} from '../services/upsellCooccurrenceService';
import { resetUpsellFeedbackStore } from '../services/upsellFeedbackService';
import { areSameProductOrVariant, getProductRelatedSuggestions } from '../utils/salesAssistant';
import { ProductRelatedSuggestions } from './ProductRelatedSuggestions';

const TEST_SHOP_ID = 'vitest_product_details_shop';

function buildCatalog(): SearchableProductItem[] {
  return [
    {
      id: 'pampers_34',
      name: 'Pampers Active Baby 34s',
      brandId: 'b_pampers',
      brandName: 'Pampers',
      categoryId: 'c_diapers',
      categoryName: 'Diapers & Pampers',
      categoryDescription: 'Disposable baby diapers and newborn diaper packs',
      salePrice: 1850,
      currentStock: 10,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '34s',
      isActive: true,
    },
    {
      id: 'pampers_64',
      name: 'Pampers Active Baby 64s',
      brandId: 'b_pampers',
      brandName: 'Pampers',
      categoryId: 'c_diapers',
      categoryName: 'Diapers & Pampers',
      categoryDescription: 'Disposable baby diapers and newborn diaper packs',
      salePrice: 3300,
      currentStock: 12,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '64s',
      isActive: true,
    },
    {
      id: 'pampers_wipes_72',
      name: 'Pampers Baby Wipes 72s',
      brandId: 'b_pampers',
      brandName: 'Pampers',
      categoryId: 'c_wipes',
      categoryName: 'Baby Wipes',
      categoryDescription: 'Sensitive moisturizing baby wet wipes',
      salePrice: 450,
      currentStock: 20,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '72s',
      isActive: true,
    },
    {
      id: 'huggies_wipes_64',
      name: 'Huggies Pure Baby Wipes 64s',
      brandId: 'b_huggies',
      brandName: 'Huggies',
      categoryId: 'c_wipes',
      categoryName: 'Baby Wipes',
      categoryDescription: 'Sensitive moisturizing baby wet wipes',
      salePrice: 420,
      currentStock: 15,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '64s',
      isActive: true,
    },
    {
      id: 'huggies_wipes_128',
      name: 'Huggies Pure Baby Wipes 128s',
      brandId: 'b_huggies',
      brandName: 'Huggies',
      categoryId: 'c_wipes',
      categoryName: 'Baby Wipes',
      categoryDescription: 'Sensitive moisturizing baby wet wipes',
      salePrice: 780,
      currentStock: 8,
      unit: 'Pack',
      baseUnit: 'Pack',
      bottleSize: '128s',
      isActive: true,
    },
    {
      id: 'sudocrem_oos',
      name: 'Sudocrem Rash Cream 60g',
      brandId: 'b_sudocrem',
      brandName: 'Sudocrem',
      categoryId: 'c_baby_care',
      categoryName: 'Baby Care',
      categoryDescription: 'Baby lotions, rash creams, and baby skincare',
      salePrice: 950,
      currentStock: 0,
      unit: 'Jar',
      baseUnit: 'Jar',
      isActive: true,
    },
    {
      id: 'johnsons_lotion_box_low',
      name: 'Johnsons Baby Lotion Master Box',
      brandId: 'b_johnsons',
      brandName: 'Johnsons',
      categoryId: 'c_baby_care',
      categoryName: 'Baby Care',
      categoryDescription: 'Baby lotions, rash creams, and baby skincare',
      salePrice: 600,
      currentStock: 5, // Below default Box conversionQty (12)
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
      id: 'baby_powder_inactive',
      name: 'Johnsons Baby Powder 200g',
      brandId: 'b_johnsons',
      brandName: 'Johnsons',
      categoryId: 'c_baby_care',
      categoryName: 'Baby Care',
      categoryDescription: 'Baby lotions, rash creams, and baby skincare',
      salePrice: 490,
      currentStock: 10,
      unit: 'Bottle',
      baseUnit: 'Bottle',
      isActive: false,
    },
    {
      id: 'tea_450',
      name: 'Tapal Danedar 450g',
      brandId: 'b_tapal',
      brandName: 'Tapal',
      categoryId: 'c_beverages',
      categoryName: 'Tea & Beverages',
      salePrice: 980,
      currentStock: 14,
      unit: 'Pack',
      baseUnit: 'Pack',
      isActive: true,
    },
    {
      id: 'biscuit_sooper',
      name: 'Peek Freans Sooper 100g',
      brandId: 'b_pf',
      brandName: 'Peek Freans',
      categoryId: 'c_snacks',
      categoryName: 'Snacks & Biscuits',
      salePrice: 120,
      currentStock: 30,
      unit: 'Pack',
      baseUnit: 'Pack',
      isActive: true,
    },
  ];
}

describe('getProductRelatedSuggestions & ProductRelatedSuggestions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetCatalogIntelligence(TEST_SHOP_ID);
    resetCooccurrenceStore(TEST_SHOP_ID);
    resetUpsellFeedbackStore(TEST_SHOP_ID);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('provides cold-start catalog suggestions without claiming purchase history', () => {
    const catalog = buildCatalog();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const results = getProductRelatedSuggestions({
      shopId: TEST_SHOP_ID,
      productId: 'pampers_34',
      catalog,
      limit: 4,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(results.length).toBeGreaterThan(0);

    const ids = results.map((r) => r.product.id);
    // Anchor and its pack-size variant must never appear
    expect(ids).not.toContain('pampers_34');
    expect(ids).not.toContain('pampers_64');
    // Inactive, out-of-stock, and insufficient-packaging-stock must never appear
    expect(ids).not.toContain('baby_powder_inactive');
    expect(ids).not.toContain('sudocrem_oos');
    expect(ids).not.toContain('johnsons_lotion_box_low');
    // Should surface complementary wipes via brand/catalog intelligence
    expect(ids).toContain('pampers_wipes_72');

    // Sibling suggestions must also be deduplicated against each other (no Huggies 64s + 128s together)
    for (let i = 0; i < results.length; i += 1) {
      for (let j = i + 1; j < results.length; j += 1) {
        expect(areSameProductOrVariant(results[i].product, results[j].product)).toBe(false);
      }
    }

    // All cold-start suggestions must be marked strictly as catalog-based evidence
    for (const r of results) {
      expect(r.evidenceType).toBe('catalog');
      expect(r.historicalPairCount).toBe(0);
      expect(r.reasonLabel.toLowerCase()).not.toContain('bought');
    }
  });

  it('surfaces historically co-occurring products with accurate purchase evidence when sales exist', () => {
    const catalog = buildCatalog();
    ingestCompletedSalesBatchSync(TEST_SHOP_ID, [
      { saleId: 's1', status: 'completed', productIds: ['tea_450', 'biscuit_sooper'] },
      { saleId: 's2', status: 'completed', productIds: ['tea_450', 'biscuit_sooper'] },
      { saleId: 's3', status: 'completed', productIds: ['tea_450', 'biscuit_sooper'] },
    ]);

    const results = getProductRelatedSuggestions({
      shopId: TEST_SHOP_ID,
      productId: 'tea_450',
      catalog,
      limit: 4,
    });

    const biscuit = results.find((r) => r.product.id === 'biscuit_sooper');
    expect(biscuit).toBeDefined();
    expect(biscuit?.evidenceType).toBe('history');
    expect(biscuit?.historicalPairCount).toBe(3);
    expect(biscuit?.reasonLabel).toContain('Bought together · 3×');
  });

  it('renders "Suggested with this product" asynchronously on cold start and never "Often bought with"', async () => {
    const catalog = buildCatalog();
    const onSelectProduct = vi.fn();

    render(
      <ProductRelatedSuggestions
        shopId={TEST_SHOP_ID}
        productId="pampers_34"
        catalog={catalog}
        onSelectProduct={onSelectProduct}
      />
    );

    // Non-blocking: nothing synchronously before setTimeout(..., 0)
    expect(screen.queryByRole('region')).toBeNull();

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const region = screen.getByRole('region', { name: 'Suggested with this product' });
    expect(region).toBeDefined();
    expect(screen.queryByText(/Often bought/i)).toBeNull();
    expect(screen.getByText('Based on catalog & category attributes')).toBeDefined();

    const wipesButton = screen.getByRole('button', { name: /Pampers Baby Wipes 72s/i });
    fireEvent.click(wipesButton);
    expect(onSelectProduct).toHaveBeenCalledWith('pampers_wipes_72');
  });

  it('renders "Often bought with" only when completed sales history supports the recommendations', async () => {
    const catalog = buildCatalog();
    ingestCompletedSalesBatchSync(TEST_SHOP_ID, [
      { saleId: 's1', status: 'completed', productIds: ['tea_450', 'biscuit_sooper'] },
      { saleId: 's2', status: 'completed', productIds: ['tea_450', 'biscuit_sooper'] },
      { saleId: 's3', status: 'completed', productIds: ['tea_450', 'biscuit_sooper'] },
    ]);

    render(
      <ProductRelatedSuggestions
        shopId={TEST_SHOP_ID}
        productId="tea_450"
        catalog={catalog}
      />
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByRole('region', { name: 'Often bought with' })).toBeDefined();
    expect(screen.getByText(/Bought together · 3×/i)).toBeDefined();
  });

  it('omits the optional section cleanly when no eligible recommendations exist', async () => {
    const isolatedCatalog: SearchableProductItem[] = [
      {
        id: 'solo_item',
        name: 'Unique Standalone Item',
        brandName: 'SoloBrand',
        categoryName: 'Specialty Tools',
        salePrice: 500,
        currentStock: 5,
        unit: 'Piece',
        baseUnit: 'Piece',
        isActive: true,
      },
      {
        id: 'unrelated_oos',
        name: 'Unrelated Out Of Stock Item',
        brandName: 'OtherBrand',
        categoryName: 'Groceries',
        salePrice: 200,
        currentStock: 0,
        unit: 'Pack',
        baseUnit: 'Pack',
        isActive: true,
      },
    ];

    render(
      <ProductRelatedSuggestions
        shopId={TEST_SHOP_ID}
        productId="solo_item"
        catalog={isolatedCatalog}
      />
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.queryByRole('region')).toBeNull();
  });
});
