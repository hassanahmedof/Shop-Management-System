import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getOrUpdateCatalogIntelligenceSync,
  resetCatalogIntelligence,
  scheduleCatalogIntelligenceBuild,
} from './catalogIntelligenceService';
import type { SearchableProductItem } from './productSearchService';

const TEST_SHOP = 'vitest_catalog_intel_shop';

function makeProduct(overrides: Partial<SearchableProductItem> & { id: string; name: string }): SearchableProductItem {
  return {
    brandId: '',
    brandName: '',
    categoryId: '',
    categoryName: '',
    salePrice: 100,
    currentStock: 10,
    unit: 'Pack',
    baseUnit: 'Pack',
    isActive: true,
    ...overrides,
  };
}

describe('catalogIntelligenceService', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetCatalogIntelligence(TEST_SHOP);
  });

  it('discovers dynamic brand bridges and semantic category affinities without hardcoded pairings', () => {
    const items: SearchableProductItem[] = [
      makeProduct({
        id: 'p1',
        name: 'AlphaBaby Ultra Dry 34s',
        brandId: 'b_alpha',
        brandName: 'AlphaBaby',
        categoryId: 'c_diaper',
        categoryName: 'Diapers & Pants',
        categoryDescription: 'Disposable baby diapers and newborn pants',
        bottleSize: '34s',
      }),
      makeProduct({
        id: 'p2',
        name: 'AlphaBaby Gentle Wet Wipes 72s',
        brandId: 'b_alpha',
        brandName: 'AlphaBaby',
        categoryId: 'c_wipes',
        categoryName: 'Baby Wipes',
        categoryDescription: 'Sensitive moisturizing baby cleansing wipes',
        bottleSize: '72s',
      }),
      makeProduct({
        id: 'p3',
        name: 'Omega Hardware Wrench 10mm',
        brandId: 'b_omega',
        brandName: 'Omega',
        categoryId: 'c_tools',
        categoryName: 'Tools & Hardware',
        categoryDescription: 'Steel hand tools and repair equipment',
      }),
    ];

    const index = getOrUpdateCatalogIntelligenceSync(TEST_SHOP, items);
    expect(index.productCount).toBe(3);
    expect(index.lastRecomputedCount).toBe(3);

    // Discovered dynamically from brand bridge (AlphaBaby spans c_diaper & c_wipes) + "baby" tokens
    const diaperToWipes = index.categoryAffinities.get('diapers & pants')?.get('baby wipes') ?? 0;
    const diaperToTools =
      index.categoryAffinities.get('diapers & pants')?.get('tools & hardware') ?? 0;

    expect(diaperToWipes).toBeGreaterThan(0.4);
    expect(diaperToTools).toBe(0);
  });

  it('incrementally updates only new or edited products without recomputing unchanged items', () => {
    const initial: SearchableProductItem[] = [
      makeProduct({ id: 'p1', name: 'SoftWash Baby Shampoo 200ml', categoryName: 'Baby Care' }),
      makeProduct({ id: 'p2', name: 'SoftWash Baby Lotion 200ml', categoryName: 'Baby Care' }),
    ];

    const idx1 = getOrUpdateCatalogIntelligenceSync(TEST_SHOP, initial);
    expect(idx1.lastRecomputedCount).toBe(2);
    expect(idx1.lastReusedCount).toBe(0);

    // Add 1 new product -> 2 existing must be reused, only 1 computed
    const withNew = [
      ...initial,
      makeProduct({ id: 'p3', name: 'SoftWash Baby Powder 150g', categoryName: 'Baby Care' }),
    ];
    const idx2 = getOrUpdateCatalogIntelligenceSync(TEST_SHOP, withNew);
    expect(idx2.productCount).toBe(3);
    expect(idx2.lastReusedCount).toBe(2);
    expect(idx2.lastRecomputedCount).toBe(1);

    // Update 1 existing product details -> only that 1 product recomputed, 2 reused
    const withEdited = withNew.map((item) =>
      item.id === 'p2'
        ? { ...item, name: 'SoftWash Baby Oil & Lotion 250ml', bottleSize: '250ml' }
        : item
    );
    const idx3 = getOrUpdateCatalogIntelligenceSync(TEST_SHOP, withEdited);
    expect(idx3.lastReusedCount).toBe(2);
    expect(idx3.lastRecomputedCount).toBe(1);
    expect(idx3.profilesById.get('p2')?.extract.coreTitleTokens.has('oil')).toBe(true);
  });

  it('builds catalog intelligence asynchronously in background chunks without blocking', async () => {
    vi.useFakeTimers();
    const batch: SearchableProductItem[] = Array.from({ length: 130 }, (_, i) =>
      makeProduct({
        id: `bulk_${i}`,
        name: `Sample Item ${i}`,
        categoryName: i % 2 === 0 ? 'Personal Care' : 'Snacks',
      })
    );

    scheduleCatalogIntelligenceBuild(TEST_SHOP, batch);
    await vi.advanceTimersByTimeAsync(120);

    // Cache hit returns prebuilt index immediately without recomputing
    const idx = getOrUpdateCatalogIntelligenceSync(TEST_SHOP, batch);
    expect(idx.productCount).toBe(130);
    expect(idx.lastRecomputedCount).toBe(130);

    // Adding 1 more product reuses all 130 background-indexed products incrementally
    const idxPlusOne = getOrUpdateCatalogIntelligenceSync(TEST_SHOP, [
      ...batch,
      makeProduct({ id: 'bulk_new', name: 'New Item', categoryName: 'Snacks' }),
    ]);
    expect(idxPlusOne.productCount).toBe(131);
    expect(idxPlusOne.lastReusedCount).toBe(130);
    expect(idxPlusOne.lastRecomputedCount).toBe(1);
  });
});
