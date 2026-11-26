import { cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCatalogIntelligence } from '../services/catalogIntelligenceService';
import type { SearchableProductItem } from '../services/productSearchService';
import { resetCooccurrenceStore } from '../services/upsellCooccurrenceService';
import { clearGeminiFallbackClientState } from '../services/upsellFallbackClient';
import { resetUpsellFeedbackStore } from '../services/upsellFeedbackService';
import { getAllowedSaleUnits, getEffectiveBaseUnit, roundStockQty } from '../utils/packaging';
import { roundMoney } from '../utils/formatters';
import { CompactSaleItemsList, type CompactSaleRowItem } from './CompactSaleItemsList';
import { useSalesAssistant, type SalesAssistantCartEntry } from '../hooks/useSalesAssistant';

const SHOP_ID = 'bench_ui_shop_1';

let mockCatalogFixture: SearchableProductItem[] = [];

vi.mock('../lib/firebase', () => ({
  db: {},
  auth: { currentUser: null },
  OperationType: {},
  handleFirestoreError: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'bench_owner', getIdToken: async () => 'bench-tok' },
    shopId: SHOP_ID,
  }),
}));

vi.mock('../contexts/ShopDataContext', () => ({
  useShopData: () => ({
    products: mockCatalogFixture,
    staffCatalog: [],
    categories: [],
    productTemplates: [],
  }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

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

function buildLargeCatalog(count = 600): SearchableProductItem[] {
  const cats = [
    'Diapers & Pampers',
    'Baby Wipes',
    'Baby Care',
    'Cold Drinks & Beverages',
    'Snacks & Confectionery',
    'Dairy & Milk',
    'Tea & Coffee',
    'Personal Care',
  ];
  const brands = ['Pampers', 'Huggies', 'Johnsons', 'Tapal', 'Olpers', 'Peek Freans', 'Nestle', 'Unilever'];
  return Array.from({ length: count }, (_, idx) => {
    const i = idx + 1;
    const isMulti = i % 3 === 0;
    return {
      id: `ui_prod_${String(i).padStart(4, '0')}`,
      name: `${brands[i % brands.length]} Item ${i} Pack`,
      brandId: `b_${i % brands.length}`,
      brandName: brands[i % brands.length],
      categoryId: `c_${i % cats.length}`,
      categoryName: cats[i % cats.length],
      salePrice: 120 + (i % 20) * 25,
      wholesalePrice: 110 + (i % 20) * 25,
      purchasePrice: 90 + (i % 20) * 20,
      currentStock: 100,
      unit: 'Piece',
      baseUnit: 'Piece',
      packagingUnits: isMulti
        ? [
            {
              unitName: 'Piece',
              conversionQty: 1,
              allowPurchase: true,
              allowSale: true,
              purchasePrice: 90,
              salePrice: 120,
              wholesalePrice: 110,
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
              salePrice: 1400,
              wholesalePrice: 1320,
            },
          ]
        : undefined,
      isActive: true,
    };
  });
}

function buildCompactRows(catalog: SearchableProductItem[], size: number): CompactSaleRowItem[] {
  return catalog.slice(0, size).map((p, idx) => ({
    key: `row_${idx + 1}`,
    productId: p.id,
    name: p.name,
    brandName: p.brandName,
    unit: getEffectiveBaseUnit(p),
    unitName: idx % 3 === 2 ? 'Box' : 'Piece',
    conversionFactor: idx % 3 === 2 ? 12 : 1,
    allowedUnits: getAllowedSaleUnits(p),
    currentStock: p.currentStock,
    quantity: '2',
    salePricePerUnit: String(idx % 3 === 2 ? 1400 : p.salePrice),
    wholesalePrice: p.wholesalePrice,
    purchasePrice: p.purchasePrice,
  }));
}

describe('Sales Entry Frontend UI & Recommendation Load Benchmarks', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCooccurrenceStore(SHOP_ID);
    resetCatalogIntelligence(SHOP_ID);
    resetUpsellFeedbackStore(SHOP_ID);
    clearGeminiFallbackClientState();
    mockCatalogFixture = buildLargeCatalog(600);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, available: false, reason: 'GEMINI_UNAVAILABLE' }), { status: 503 }))
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('benchmarks cart calculation, CompactSaleItemsList mount & qty-step re-render, and useSalesAssistant across sizes 1..200', () => {
    const sizes = [1, 10, 25, 50, 100, 150, 200];
    const uiResults: Array<Record<string, unknown>> = [];
    const prodMap = new Map(mockCatalogFixture.map((p) => [p.id, p]));
    const noop = () => {};

    for (const size of sizes) {
      const calcTimes: number[] = [];
      const mountTimes: number[] = [];
      const qtyUpdateTimes: number[] = [];
      const assistantAddTimes: number[] = [];
      const assistantQtyTimes: number[] = [];
      let domNodesAtSize = 0;

      const runs = size >= 150 ? 3 : 5;

      for (let r = 0; r < runs; r += 1) {
        // 1) Cart row preparation + totals calculation (SalesPage pattern)
        const rawRows = mockCatalogFixture.slice(0, size).map((p, idx) => ({
          key: `row_${idx + 1}`,
          productId: p.id,
          unitName: idx % 3 === 2 ? 'Box' : 'Piece',
          conversionFactor: idx % 3 === 2 ? 12 : 1,
          quantity: '2',
          salePricePerUnit: String(p.salePrice),
        }));

        const tCalcStart = performance.now();
        let totalAmount = 0;
        let totalCost = 0;
        const prepared: CompactSaleRowItem[] = rawRows.map((row) => {
          const prod = prodMap.get(row.productId)!;
          const qty = Math.max(0, roundStockQty(Number(row.quantity) || 0));
          const price = Number(row.salePricePerUnit) || 0;
          const baseQty = roundStockQty(qty * (row.conversionFactor || 1));
          totalAmount = roundMoney(totalAmount + qty * price);
          totalCost = roundMoney(totalCost + baseQty * (prod.purchasePrice || 0));
          return {
            key: row.key,
            productId: row.productId,
            name: prod.name,
            brandName: prod.brandName,
            unit: getEffectiveBaseUnit(prod),
            unitName: row.unitName,
            conversionFactor: row.conversionFactor,
            allowedUnits: getAllowedSaleUnits(prod),
            currentStock: prod.currentStock,
            quantity: row.quantity,
            salePricePerUnit: row.salePricePerUnit,
            wholesalePrice: prod.wholesalePrice,
            purchasePrice: prod.purchasePrice,
          };
        });
        calcTimes.push(performance.now() - tCalcStart);

        // 2) CompactSaleItemsList mount & single-row quantity step re-render
        const tMountStart = performance.now();
        const view = render(
          <CompactSaleItemsList
            items={prepared}
            expandedKey={null}
            onToggleExpand={noop}
            onStepQuantity={noop}
            onChangeQuantity={noop}
            onChangeUnit={noop}
            onOpenKeypad={noop}
            onChangePrice={noop}
            onRemove={noop}
            priceEditable
            showProfit
          />
        );
        mountTimes.push(performance.now() - tMountStart);
        domNodesAtSize = view.container.querySelectorAll('*').length;

        const updatedItems = prepared.map((it, idx) => (idx === 0 ? { ...it, quantity: '3' } : it));
        const tUpdateStart = performance.now();
        view.rerender(
          <CompactSaleItemsList
            items={updatedItems}
            expandedKey={null}
            onToggleExpand={noop}
            onStepQuantity={noop}
            onChangeQuantity={noop}
            onChangeUnit={noop}
            onOpenKeypad={noop}
            onChangePrice={noop}
            onRemove={noop}
            priceEditable
            showProfit
          />
        );
        qtyUpdateTimes.push(performance.now() - tUpdateStart);
        view.unmount();

        // 3) useSalesAssistant with empty co-occurrence cache & 600-product catalog
        resetCatalogIntelligence(SHOP_ID);
        const cartEntries: Array<Exclude<SalesAssistantCartEntry, string>> = mockCatalogFixture
          .slice(0, size)
          .map((p) => ({
            productId: p.id,
            quantity: 1,
            conversionFactor: 1,
            unitName: 'Piece',
          }));

        const tAssistStart = performance.now();
        const hook = renderHook(
          ({ cart }) => useSalesAssistant({ cart, catalog: mockCatalogFixture }),
          { initialProps: { cart: cartEntries } }
        );
        assistantAddTimes.push(performance.now() - tAssistStart);

        const nextQtyCart = cartEntries.map((c, idx) => (idx === 0 ? { ...c, quantity: 2 } : c));
        const tAssistQtyStart = performance.now();
        hook.rerender({ cart: nextQtyCart });
        assistantQtyTimes.push(performance.now() - tAssistQtyStart);
        hook.unmount();
      }

      uiResults.push({
        size,
        domNodes: domNodesAtSize,
        calcAndBuildRows: summarize(calcTimes),
        listMount: summarize(mountTimes),
        listQtyRerender: summarize(qtyUpdateTimes),
        assistantColdAdd: summarize(assistantAddTimes),
        assistantQtyRerender: summarize(assistantQtyTimes),
      });
    }

    console.log('[BENCH_UI]', JSON.stringify(uiResults));
    expect(uiResults).toHaveLength(7);
    expect(buildCompactRows(mockCatalogFixture, 1)).toHaveLength(1);
  }, 30000);
});
