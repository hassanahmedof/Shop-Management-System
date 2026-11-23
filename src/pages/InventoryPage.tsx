import { AlertTriangle, ArrowDown, ArrowUp, Filter, Layers, Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CompactExpandableRow } from '../components/CompactSection';
import { SearchableSelect, type SearchableSelectOption } from '../components/SearchableSelect';
import { useAuth } from '../contexts/AuthContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import { computeTopActivityValues } from '../services/recordSearchService';
import { createStockAdjustment } from '../services/shopService';
import type { Product } from '../types/shop';
import {
  formatDateDDMMYYYY,
  formatNumber,
  formatPKR,
  getKarachiDateIso,
  getProductStockStatus,
  roundMoney,
} from '../utils/formatters';
import {
  formatStockBreakdown,
  getEffectiveBaseUnit,
  isFractionalUnit,
  roundStockQty,
} from '../utils/packaging';

interface AdjustUnitOption {
  unitName: string;
  conversionQty: number;
}

function getAllProductUnits(product: Product): AdjustUnitOption[] {
  const base = getEffectiveBaseUnit(product);
  const out: AdjustUnitOption[] = [{ unitName: base, conversionQty: 1 }];
  for (const pkg of product.packagingUnits || []) {
    if (!pkg.unitName || Number(pkg.conversionQty) <= 0) continue;
    if (pkg.unitName.toLowerCase() === base.toLowerCase()) continue;
    out.push({ unitName: pkg.unitName, conversionQty: roundStockQty(pkg.conversionQty) });
  }
  return out;
}

export function InventoryPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const {
    products,
    categories,
    brands,
    suppliers,
    stockMovements,
    stockAdjustments,
    inventoryBatches,
    settings,
  } = useShopData();
  const { showToast } = useToast();
  const todayIso = getKarachiDateIso();
  const alertDays = settings?.expiryAlertDays ?? 30;

  const [activeTab, setActiveTab] = useState<
    'stock' | 'batches' | 'alerts' | 'movements' | 'damaged'
  >('stock');
  const [search, setSearch] = useState('');
  const [filterProductId, setFilterProductId] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterSupplierId, setFilterSupplierId] = useState('');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  const productOptions = useMemo<SearchableSelectOption[]>(
    () =>
      products.map((p) => {
        const bd = formatStockBreakdown(p.currentStock, p);
        return {
          value: p.id,
          label: p.name,
          subtitle: [p.brandName, p.categoryName].filter(Boolean).join(' · '),
          meta: `Stock: ${bd.summaryText}`,
          badge: p.currentStock <= 0 ? 'Out of Stock' : p.currentStock <= p.minStockLevel ? 'Low Stock' : 'Healthy',
          badgeTone: p.currentStock <= 0 ? 'danger' : p.currentStock <= p.minStockLevel ? 'warning' : 'success',
          keywords: [p.name, p.brandName, p.categoryName, p.supplierName, p.originType, p.storageLocation].filter(
            Boolean
          ) as string[],
        };
      }),
    [products]
  );

  const categoryOptions = useMemo<SearchableSelectOption[]>(
    () => categories.map((c) => ({ value: c.id, label: c.name })),
    [categories]
  );

  const brandOptions = useMemo<SearchableSelectOption[]>(
    () => brands.map((b) => ({ value: b.id, label: b.name })),
    [brands]
  );

  const supplierOptions = useMemo<SearchableSelectOption[]>(
    () =>
      suppliers.map((s) => ({
        value: s.id,
        label: s.name,
        subtitle: s.phone ? `Phone: ${s.phone}` : undefined,
        keywords: [s.name, s.phone].filter(Boolean),
      })),
    [suppliers]
  );

  const frequentProductIds = useMemo(
    () => computeTopActivityValues(stockMovements, (m) => m.productId, 5),
    [stockMovements]
  );
  const frequentCategoryIds = useMemo(
    () => computeTopActivityValues(products, (p) => p.categoryId, 5),
    [products]
  );
  const frequentBrandIds = useMemo(
    () => computeTopActivityValues(products, (p) => p.brandId, 5),
    [products]
  );
  const frequentSupplierIds = useMemo(
    () => computeTopActivityValues(products, (p) => p.supplierId, 5),
    [products]
  );

  // Quick manual add/reduce stock modal
  const [adjustProduct, setAdjustProduct] = useState<Product | null>(null);
  const [adjustMode, setAdjustMode] = useState<'add' | 'reduce'>('add');
  const [adjustUnitName, setAdjustUnitName] = useState('');
  const [adjustConversion, setAdjustConversion] = useState(1);
  const [adjustQty, setAdjustQty] = useState('1');
  const [adjustEmptyDelta, setAdjustEmptyDelta] = useState('0');
  const [adjustReason, setAdjustReason] = useState('Manual inventory update');
  const [adjustErr, setAdjustErr] = useState<string | null>(null);
  const [savingAdjust, setSavingAdjust] = useState(false);

  const inventoryMetrics = useMemo(() => {
    let totalUnits = 0;
    let totalCostValue = 0;
    let totalRetailValue = 0;
    let lowCount = 0;
    let outCount = 0;
    let expiryCount = 0;

    for (const p of products) {
      totalUnits = roundStockQty(totalUnits + p.currentStock);
      totalCostValue = roundMoney(totalCostValue + p.currentStock * p.purchasePrice);
      totalRetailValue = roundMoney(totalRetailValue + p.currentStock * p.salePrice);
      const st = getProductStockStatus(p, todayIso, alertDays);
      if (st.isOutOfStock) outCount += 1;
      else if (st.isLowStock) lowCount += 1;
      if (st.isExpired || st.isNearingExpiry) expiryCount += 1;
    }

    return { totalUnits, totalCostValue, totalRetailValue, lowCount, outCount, expiryCount };
  }, [products, todayIso, alertDays]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (filterProductId && p.id !== filterProductId) return false;
      if (filterCat && p.categoryId !== filterCat) return false;
      if (filterBrand && p.brandId !== filterBrand) return false;
      if (filterSupplierId && p.supplierId !== filterSupplierId) return false;
      if (
        q &&
        !`${p.name} ${p.categoryName} ${p.brandName} ${p.supplierName} ${p.originType || ''} ${p.storageLocation || ''}`
          .toLowerCase()
          .includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [products, search, filterProductId, filterCat, filterBrand, filterSupplierId]);

  const filteredBatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inventoryBatches.filter((b) => {
      if (filterProductId && b.productId !== filterProductId) return false;
      if (filterSupplierId && b.supplierId !== filterSupplierId) return false;
      if (
        q &&
        !`${b.productName} ${b.purchaseNumber} ${b.supplierName} ${b.status}`.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [inventoryBatches, search, filterProductId, filterSupplierId]);

  const activeBatchesCount = useMemo(
    () => inventoryBatches.filter((b) => b.status === 'active' && b.remainingBaseQty > 0).length,
    [inventoryBatches]
  );

  const alertRows = useMemo(() => {
    const list: Array<{ product: Product; label: string; severity: 'red' | 'amber' }> = [];
    for (const p of filteredProducts) {
      const st = getProductStockStatus(p, todayIso, alertDays);
      if (st.isOutOfStock) list.push({ product: p, label: 'Out of Stock', severity: 'red' });
      else if (st.isLowStock) list.push({ product: p, label: 'Below Minimum Level', severity: 'amber' });

      if (st.isExpired) list.push({ product: p, label: 'Expired', severity: 'red' });
      else if (st.isNearingExpiry) {
        list.push({
          product: p,
          label: `Expiring in ${st.daysUntilExpiry} days`,
          severity: 'amber',
        });
      }
    }
    return list;
  }, [filteredProducts, todayIso, alertDays]);

  const damagedAndExpiredAdjustments = useMemo(
    () =>
      stockAdjustments.filter(
        (a) => a.adjustmentType === 'damaged' || a.adjustmentType === 'expired'
      ),
    [stockAdjustments]
  );

  const openQuickAdjust = (product: Product, mode: 'add' | 'reduce') => {
    const baseUnit = getEffectiveBaseUnit(product);
    setAdjustProduct(product);
    setAdjustMode(mode);
    setAdjustUnitName(baseUnit);
    setAdjustConversion(1);
    setAdjustQty('1');
    setAdjustEmptyDelta('0');
    setAdjustReason(mode === 'add' ? 'Manual stock addition' : 'Manual stock reduction');
    setAdjustErr(null);
  };

  const handleQuickAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId || !adjustProduct) return;
    setAdjustErr(null);
    const qty = roundStockQty(Number(adjustQty));
    if (!Number.isFinite(qty) || qty <= 0) {
      setAdjustErr('Enter a valid positive quantity.');
      return;
    }
    const emptyDelta = adjustProduct.isReturnable
      ? roundStockQty(Number(adjustEmptyDelta) || 0)
      : 0;

    setSavingAdjust(true);
    try {
      await createStockAdjustment(activeShopId, {
        productId: adjustProduct.id,
        quantity: qty,
        unitName: adjustUnitName || getEffectiveBaseUnit(adjustProduct),
        conversionFactor: adjustConversion || 1,
        adjustmentDate: todayIso,
        adjustmentType: adjustMode,
        reason: adjustReason.trim() || 'Manual inventory update',
        notes: 'Quick stock adjustment from Inventory page',
        emptyContainerDelta: emptyDelta,
      });
      showToast({
        title: 'Stock updated',
        message: `${adjustProduct.name} (${adjustMode === 'add' ? '+' : '-'}${formatNumber(qty)} ${adjustUnitName})`,
        tone: 'success',
      });
      setAdjustProduct(null);
    } catch (err) {
      setAdjustErr(err instanceof Error ? err.message : 'Failed to update stock.');
    } finally {
      setSavingAdjust(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Valuation & Alert KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-3">
        <div className="cm-surface border rounded-xl p-3">
          <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Total Base Units</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)]">
            {formatNumber(inventoryMetrics.totalUnits)}
          </div>
        </div>
        <div className="cm-surface border rounded-xl p-3">
          <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Inventory Cost</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)] truncate">
            {formatPKR(inventoryMetrics.totalCostValue)}
          </div>
        </div>
        <div className="cm-surface border rounded-xl p-3">
          <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Retail Value</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-[var(--cm-success)] truncate">
            {formatPKR(inventoryMetrics.totalRetailValue)}
          </div>
        </div>
        <div className="cm-surface border rounded-xl p-3">
          <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Low / Out</div>
          <div className="mt-0.5 text-sm sm:text-base font-bold font-mono-num tabular-nums text-[var(--cm-warning)]">
            {inventoryMetrics.lowCount} low · {inventoryMetrics.outCount} out
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1 cm-surface border rounded-xl p-3">
          <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Expiry Alerts</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-[var(--cm-danger)]">
            {formatNumber(inventoryMetrics.expiryCount)}
          </div>
        </div>
      </div>

      {/* Tabs & Filters */}
      <div className="cm-surface border rounded-xl p-3 sm:p-4 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-[var(--cm-bg-subtle)] rounded-lg border border-[var(--cm-border)]">
            {(
              [
                { id: 'stock', label: 'Current Stock' },
                { id: 'batches', label: `FIFO Batches (${activeBatchesCount})` },
                { id: 'alerts', label: `Alerts (${alertRows.length})` },
                { id: 'movements', label: 'Movements' },
                { id: 'damaged', label: 'Damaged / Exp.' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  setExpandedRowId(null);
                }}
                className={`px-2.5 sm:px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] border border-[var(--cm-border)] shadow-xs'
                    : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {(activeTab === 'stock' || activeTab === 'alerts' || activeTab === 'batches') && (
            <button
              type="button"
              onClick={() => setShowMobileFilters((v) => !v)}
              className="lg:hidden inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[var(--cm-text-secondary)] bg-[var(--cm-bg-subtle)] hover:bg-[var(--cm-bg-hover)] rounded-md cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>{showMobileFilters ? 'Hide Filters' : 'Filters'}</span>
            </button>
          )}
        </div>

        {(activeTab === 'stock' || activeTab === 'alerts' || activeTab === 'batches') && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-2">
            <div className="relative lg:col-span-4">
              <Search className="w-4 h-4 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder={
                  activeTab === 'batches'
                    ? 'Search batch, product, PO # or supplier...'
                    : 'Search inventory or location...'
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full min-h-[38px] pl-9 pr-3 py-1.5 text-sm border cm-input rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
              />
            </div>
            <div
              className={`${
                showMobileFilters ? 'grid' : 'hidden lg:grid'
              } lg:col-span-8 grid-cols-2 sm:grid-cols-4 gap-2`}
            >
              <SearchableSelect
                size="sm"
                ariaLabel="Filter by product"
                suggestionScope="product"
                suggestedValues={frequentProductIds}
                options={productOptions}
                value={filterProductId}
                onChange={setFilterProductId}
                emptyOptionLabel="All Products"
                placeholder="All Products"
                searchPlaceholder="Search product..."
              />
              {activeTab !== 'batches' && (
                <>
                  <SearchableSelect
                    size="sm"
                    ariaLabel="Filter by category"
                    suggestionScope="category"
                    suggestedValues={frequentCategoryIds}
                    options={categoryOptions}
                    value={filterCat}
                    onChange={setFilterCat}
                    emptyOptionLabel="All Categories"
                    placeholder="All Categories"
                    searchPlaceholder="Search category..."
                  />
                  <SearchableSelect
                    size="sm"
                    ariaLabel="Filter by brand"
                    suggestionScope="brand"
                    suggestedValues={frequentBrandIds}
                    options={brandOptions}
                    value={filterBrand}
                    onChange={setFilterBrand}
                    emptyOptionLabel="All Brands"
                    placeholder="All Brands"
                    searchPlaceholder="Search brand..."
                  />
                </>
              )}
              <SearchableSelect
                size="sm"
                ariaLabel="Filter by supplier"
                suggestionScope="supplier"
                suggestedValues={frequentSupplierIds}
                options={supplierOptions}
                value={filterSupplierId}
                onChange={setFilterSupplierId}
                emptyOptionLabel="All Suppliers"
                placeholder="All Suppliers"
                searchPlaceholder="Search supplier..."
              />
            </div>
          </div>
        )}
      </div>

      {/* Tab Content */}
      <section className="cm-surface border rounded-xl overflow-hidden">
        {activeTab === 'stock' && (
          <>
            {filteredProducts.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
                No products found in inventory.
              </div>
            ) : (
              <>
                <div className="md:hidden divide-y divide-[var(--cm-border)]">
                  {filteredProducts.map((p) => {
                    const st = getProductStockStatus(p, todayIso, alertDays);
                    const breakdown = formatStockBreakdown(p.currentStock, p);
                    const statusText = st.isOutOfStock
                      ? 'Out of Stock'
                      : st.isLowStock
                      ? 'Low Stock'
                      : st.isExpired
                      ? 'Expired'
                      : st.isNearingExpiry
                      ? 'Nearing Expiry'
                      : 'Healthy';
                    const statusTone =
                      st.isOutOfStock || st.isExpired
                        ? 'text-[var(--cm-danger)]'
                        : st.isLowStock || st.isNearingExpiry
                        ? 'text-[var(--cm-warning)]'
                        : 'text-[var(--cm-success)]';

                    return (
                      <CompactExpandableRow
                        key={p.id}
                        title={
                          <span>
                            {p.name}
                            {p.bottleSize && (
                              <span className="ml-1 text-[11px] font-mono-num text-[var(--cm-text-muted)]">
                                ({p.bottleSize})
                              </span>
                            )}
                          </span>
                        }
                        subtitle={[
                          p.categoryName,
                          p.brandName,
                          p.originType === 'imported' ? 'Imported' : p.originType === 'local' ? 'Local' : '',
                          p.storageLocation || '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        rightPrimary={breakdown.totalLabel}
                        rightSecondary={
                          <span className={statusTone}>
                            {breakdown.packageBreakdownText || statusText}
                          </span>
                        }
                        isExpanded={expandedRowId === `stock-${p.id}`}
                        onToggle={() =>
                          setExpandedRowId((cur) => (cur === `stock-${p.id}` ? null : `stock-${p.id}`))
                        }
                        expandedContent={
                          <div className="space-y-2">
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <div>
                                <span className="text-[var(--cm-text-muted)]">Breakdown:</span>{' '}
                                <span className="font-mono-num font-semibold text-[var(--cm-text-primary)]">
                                  {breakdown.summaryText}
                                </span>
                              </div>
                              <div>
                                <span className="text-[var(--cm-text-muted)]">Cost Value:</span>{' '}
                                <span className="font-mono-num font-semibold text-[var(--cm-text-primary)]">
                                  {formatPKR(roundMoney(p.currentStock * p.purchasePrice))}
                                </span>
                              </div>
                              <div>
                                <span className="text-[var(--cm-text-muted)]">Min / Max:</span>{' '}
                                <span className="font-mono-num text-[var(--cm-text-secondary)]">
                                  {formatNumber(p.minStockLevel)} / {formatNumber(p.maxStockLevel)}
                                </span>
                              </div>
                              <div>
                                <span className="text-[var(--cm-text-muted)]">Expiry:</span>{' '}
                                <span className="font-mono-num text-[var(--cm-text-secondary)]">
                                  {p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—'}
                                </span>
                              </div>
                              {p.isReturnable && (
                                <div className="col-span-2 text-[var(--cm-info)]">
                                  Empty {p.returnableUnitName || 'Containers'} on hand:{' '}
                                  <strong className="font-mono-num">
                                    {formatNumber(p.emptyContainersOnHand || 0)}
                                  </strong>
                                </div>
                              )}
                            </div>
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => openQuickAdjust(p, 'add')}
                                className="min-h-[36px] inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold text-[var(--cm-success)] cm-surface border border-[var(--cm-success-border)] rounded-lg cursor-pointer"
                              >
                                <Plus className="w-3.5 h-3.5" /> Add Stock
                              </button>
                              <button
                                type="button"
                                disabled={p.currentStock <= 0}
                                onClick={() => openQuickAdjust(p, 'reduce')}
                                className="min-h-[36px] inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold text-[var(--cm-text-secondary)] cm-surface border disabled:opacity-40 rounded-lg cursor-pointer"
                              >
                                Reduce Stock
                              </button>
                            </div>
                          </div>
                        }
                      />
                    );
                  })}
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                        <th className="py-2.5 px-3">Product</th>
                        <th className="py-2.5 px-3">Category · Brand</th>
                        <th className="py-2.5 px-3 text-right">Stock Breakdown</th>
                        <th className="py-2.5 px-3 text-right">Min / Max</th>
                        <th className="py-2.5 px-3 text-right">Cost Value</th>
                        <th className="py-2.5 px-3">Expiry</th>
                        <th className="py-2.5 px-3">Status</th>
                        <th className="py-2.5 px-3 text-right">Quick Stock</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                      {filteredProducts.map((p) => {
                        const st = getProductStockStatus(p, todayIso, alertDays);
                        const breakdown = formatStockBreakdown(p.currentStock, p);
                        const statusText = st.isOutOfStock
                          ? 'Out of Stock'
                          : st.isLowStock
                          ? 'Low Stock'
                          : st.isExpired
                          ? 'Expired'
                          : st.isNearingExpiry
                          ? 'Nearing Expiry'
                          : 'Healthy';
                        const statusTone =
                          st.isOutOfStock || st.isExpired
                            ? 'text-[var(--cm-danger)]'
                            : st.isLowStock || st.isNearingExpiry
                            ? 'text-[var(--cm-warning)]'
                            : 'text-[var(--cm-success)]';

                        return (
                          <tr key={p.id} className="hover:bg-[var(--cm-bg-hover)]">
                            <td className="py-2 px-3">
                              <div className="font-medium text-[var(--cm-text-primary)]">
                                {p.name}
                                {p.bottleSize && (
                                  <span className="ml-1.5 text-[11px] font-mono-num text-[var(--cm-text-muted)]">
                                    ({p.bottleSize})
                                  </span>
                                )}
                              </div>
                              {(p.storageLocation || p.isReturnable) && (
                                <div className="text-[11px] text-[var(--cm-text-muted)] flex flex-wrap gap-2 mt-0.5">
                                  {p.storageLocation && <span className="text-[var(--cm-info)]">{p.storageLocation}</span>}
                                  {p.isReturnable && (
                                    <span>
                                      Empty {p.returnableUnitName || 'Crates'}: {formatNumber(p.emptyContainersOnHand || 0)}
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="py-2 px-3 text-xs text-[var(--cm-text-muted)]">
                              {p.categoryName} · {p.brandName}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num">
                              <div className="font-semibold text-[var(--cm-text-primary)]">
                                {breakdown.totalLabel}
                              </div>
                              {breakdown.packageBreakdownText && (
                                <div className="text-[11px] text-[var(--cm-accent-text)]">
                                  ({breakdown.packageBreakdownText})
                                </div>
                              )}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num text-xs text-[var(--cm-text-muted)]">
                              {formatNumber(p.minStockLevel)} / {formatNumber(p.maxStockLevel)}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-secondary)] whitespace-nowrap">
                              {formatPKR(roundMoney(p.currentStock * p.purchasePrice))}
                            </td>
                            <td className="py-2 px-3 font-mono-num text-xs text-[var(--cm-text-secondary)]">
                              {p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—'}
                            </td>
                            <td className={`py-2 px-3 text-xs font-semibold ${statusTone}`}>{statusText}</td>
                            <td className="py-2 px-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => openQuickAdjust(p, 'add')}
                                  className="inline-flex items-center gap-0.5 px-2 py-1 text-xs font-medium text-[var(--cm-success)] border border-[var(--cm-border)] hover:bg-[var(--cm-success-soft)] rounded cursor-pointer"
                                >
                                  <Plus className="w-3 h-3" /> Add
                                </button>
                                <button
                                  type="button"
                                  disabled={p.currentStock <= 0}
                                  onClick={() => openQuickAdjust(p, 'reduce')}
                                  className="inline-flex items-center gap-0.5 px-2 py-1 text-xs font-medium text-[var(--cm-text-secondary)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] disabled:opacity-40 rounded cursor-pointer"
                                >
                                  Reduce
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {activeTab === 'batches' && (
          <>
            {filteredBatches.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
                No FIFO inventory batches recorded yet. New purchases and opening stock create cost batches automatically.
              </div>
            ) : (
              <>
                <div className="md:hidden divide-y divide-[var(--cm-border)]">
                  {filteredBatches.map((b) => {
                    const statusTone =
                      b.status === 'active'
                        ? 'text-[var(--cm-success)]'
                        : b.status === 'exhausted'
                          ? 'text-[var(--cm-text-muted)]'
                          : 'text-[var(--cm-danger)]';
                    return (
                      <CompactExpandableRow
                        key={b.id}
                        dimmed={b.status !== 'active'}
                        title={
                          <span className="flex items-center gap-1.5 truncate">
                            <Layers className="w-3.5 h-3.5 text-[var(--cm-accent-text)] shrink-0" />
                            <span className="truncate">{b.productName}</span>
                          </span>
                        }
                        subtitle={`${formatDateDDMMYYYY(b.purchaseDate)} · ${b.purchaseNumber} · ${b.supplierName}`}
                        rightPrimary={`${formatNumber(b.remainingBaseQty)} / ${formatNumber(b.initialBaseQty)}`}
                        rightSecondary={
                          <span className={statusTone}>
                            {formatPKR(b.unitCostInBase)}/base · {b.status}
                          </span>
                        }
                        isExpanded={expandedRowId === `batch-${b.id}`}
                        onToggle={() =>
                          setExpandedRowId((cur) => (cur === `batch-${b.id}` ? null : `batch-${b.id}`))
                        }
                        expandedContent={
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <span className="text-[var(--cm-text-muted)]">Batch Cost:</span>{' '}
                              <span className="font-mono-num font-semibold text-[var(--cm-text-primary)]">
                                {formatPKR(b.unitCostInBase)} / base unit
                              </span>
                            </div>
                            <div>
                              <span className="text-[var(--cm-text-muted)]">Expiry:</span>{' '}
                              <span className="font-mono-num text-[var(--cm-text-secondary)]">
                                {b.expiryDate ? formatDateDDMMYYYY(b.expiryDate) : '—'}
                              </span>
                            </div>
                          </div>
                        }
                      />
                    );
                  })}
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                        <th className="py-2.5 px-3">Batch Date</th>
                        <th className="py-2.5 px-3">Ref / PO #</th>
                        <th className="py-2.5 px-3">Product</th>
                        <th className="py-2.5 px-3">Supplier</th>
                        <th className="py-2.5 px-3 text-right">Remaining / Initial</th>
                        <th className="py-2.5 px-3 text-right">Unit Cost (Base)</th>
                        <th className="py-2.5 px-3">Expiry</th>
                        <th className="py-2.5 px-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                      {filteredBatches.map((b) => (
                        <tr
                          key={b.id}
                          className={`hover:bg-[var(--cm-bg-hover)] ${b.status !== 'active' ? 'opacity-60' : ''}`}
                        >
                          <td className="py-2 px-3 font-mono-num text-xs text-[var(--cm-text-secondary)] whitespace-nowrap">
                            {formatDateDDMMYYYY(b.purchaseDate)}
                          </td>
                          <td className="py-2 px-3 font-mono-num text-xs font-medium text-[var(--cm-text-primary)] whitespace-nowrap">
                            {b.purchaseNumber}
                          </td>
                          <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">{b.productName}</td>
                          <td className="py-2 px-3 text-xs text-[var(--cm-text-secondary)]">{b.supplierName || '—'}</td>
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">
                            <span className="font-semibold">{formatNumber(b.remainingBaseQty)}</span>
                            <span className="text-[var(--cm-text-muted)]"> / {formatNumber(b.initialBaseQty)}</span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num font-semibold text-[var(--cm-text-primary)] whitespace-nowrap">
                            {formatPKR(b.unitCostInBase)}
                          </td>
                          <td className="py-2 px-3 font-mono-num text-xs text-[var(--cm-text-secondary)]">
                            {b.expiryDate ? formatDateDDMMYYYY(b.expiryDate) : '—'}
                          </td>
                          <td className="py-2 px-3 text-xs font-semibold capitalize">
                            <span
                              className={
                                b.status === 'active'
                                  ? 'text-[var(--cm-success)]'
                                  : b.status === 'cancelled'
                                    ? 'text-[var(--cm-danger)]'
                                    : 'text-[var(--cm-text-muted)]'
                              }
                            >
                              {b.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {activeTab === 'alerts' && (
          <>
            {alertRows.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
                No low stock, out of stock, or expiry alerts right now.
              </div>
            ) : (
              <>
                <div className="md:hidden divide-y divide-[var(--cm-border)]">
                  {alertRows.map((row, idx) => {
                    const bd = formatStockBreakdown(row.product.currentStock, row.product);
                    return (
                      <CompactExpandableRow
                        key={`${row.product.id}-${idx}`}
                        title={row.product.name}
                        subtitle={`Stock: ${bd.summaryText} · Min: ${formatNumber(row.product.minStockLevel)}`}
                        rightPrimary={
                          <span className={row.severity === 'red' ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-warning)]'}>
                            {row.label}
                          </span>
                        }
                        rightSecondary={
                          row.product.expiryDate ? formatDateDDMMYYYY(row.product.expiryDate) : undefined
                        }
                        isExpanded={expandedRowId === `alert-${row.product.id}-${idx}`}
                        onToggle={() =>
                          setExpandedRowId((cur) =>
                            cur === `alert-${row.product.id}-${idx}`
                              ? null
                              : `alert-${row.product.id}-${idx}`
                          )
                        }
                        expandedContent={
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="text-[var(--cm-text-secondary)]">
                              Supplier: <strong>{row.product.supplierName || '—'}</strong>
                            </span>
                            <button
                              type="button"
                              onClick={() => openQuickAdjust(row.product, 'add')}
                              className="min-h-[34px] px-3 py-1 text-xs font-semibold text-[var(--cm-accent-text)] cm-surface border border-[var(--cm-accent-border)] rounded-lg cursor-pointer"
                            >
                              + Add Stock
                            </button>
                          </div>
                        }
                      />
                    );
                  })}
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                        <th className="py-2.5 px-3">Product</th>
                        <th className="py-2.5 px-3">Stock</th>
                        <th className="py-2.5 px-3">Min Level</th>
                        <th className="py-2.5 px-3">Expiry</th>
                        <th className="py-2.5 px-3">Alert</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                      {alertRows.map((row, idx) => {
                        const bd = formatStockBreakdown(row.product.currentStock, row.product);
                        return (
                          <tr key={`${row.product.id}-${idx}`} className="hover:bg-[var(--cm-bg-hover)]">
                            <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">{row.product.name}</td>
                            <td className="py-2 px-3 font-mono-num text-[var(--cm-text-primary)]">
                              {bd.summaryText}
                            </td>
                            <td className="py-2 px-3 font-mono-num text-[var(--cm-text-muted)]">
                              {formatNumber(row.product.minStockLevel)} {bd.baseUnit}
                            </td>
                            <td className="py-2 px-3 font-mono-num text-[var(--cm-text-secondary)]">
                              {row.product.expiryDate ? formatDateDDMMYYYY(row.product.expiryDate) : '—'}
                            </td>
                            <td
                              className={`py-2 px-3 text-xs font-semibold inline-flex items-center gap-1.5 ${
                                row.severity === 'red' ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-warning)]'
                              }`}
                            >
                              <AlertTriangle className="w-3.5 h-3.5" />
                              {row.label}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {activeTab === 'movements' && (
          <>
            {stockMovements.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
                No stock movements logged yet.
              </div>
            ) : (
              <>
                <div className="md:hidden divide-y divide-[var(--cm-border)]">
                  {stockMovements.map((m) => (
                    <CompactExpandableRow
                      key={m.id}
                      title={m.productName}
                      subtitle={`${formatDateDDMMYYYY(m.movementDate)} · ${m.movementType.replace(/_/g, ' ')}`}
                      rightPrimary={
                        <span className={m.quantityChange >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'}>
                          {m.quantityChange > 0 ? `+${formatNumber(m.quantityChange)}` : formatNumber(m.quantityChange)}
                        </span>
                      }
                      rightSecondary={`${formatNumber(m.previousStock)} → ${formatNumber(m.newStock)}`}
                      isExpanded={expandedRowId === `mov-${m.id}`}
                      onToggle={() =>
                        setExpandedRowId((cur) => (cur === `mov-${m.id}` ? null : `mov-${m.id}`))
                      }
                      expandedContent={
                        <p className="text-xs text-[var(--cm-text-secondary)]">{m.notes || 'No notes recorded.'}</p>
                      }
                    />
                  ))}
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                        <th className="py-2.5 px-3">Date</th>
                        <th className="py-2.5 px-3">Product</th>
                        <th className="py-2.5 px-3">Movement Type</th>
                        <th className="py-2.5 px-3 text-right">Base Change</th>
                        <th className="py-2.5 px-3 text-right">Previous</th>
                        <th className="py-2.5 px-3 text-right">New Stock</th>
                        <th className="py-2.5 px-3">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                      {stockMovements.map((m) => (
                        <tr key={m.id} className="hover:bg-[var(--cm-bg-hover)]">
                          <td className="py-2 px-3 font-mono-num text-[var(--cm-text-secondary)] whitespace-nowrap">
                            {formatDateDDMMYYYY(m.movementDate)}
                          </td>
                          <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">{m.productName}</td>
                          <td className="py-2 px-3 text-xs capitalize text-[var(--cm-text-secondary)]">
                            {m.movementType.replace(/_/g, ' ')}
                          </td>
                          <td
                            className={`py-2 px-3 text-right font-mono-num font-semibold ${
                              m.quantityChange >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                            }`}
                          >
                            <span className="inline-flex items-center gap-0.5">
                              {m.quantityChange >= 0 ? (
                                <ArrowUp className="w-3 h-3" />
                              ) : (
                                <ArrowDown className="w-3 h-3" />
                              )}
                              {m.quantityChange > 0 ? `+${formatNumber(m.quantityChange)}` : formatNumber(m.quantityChange)}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-muted)]">
                            {formatNumber(m.previousStock)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num font-medium text-[var(--cm-text-primary)]">
                            {formatNumber(m.newStock)}
                          </td>
                          <td className="py-2 px-3 text-xs text-[var(--cm-text-muted)]">{m.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {activeTab === 'damaged' && (
          <>
            {damagedAndExpiredAdjustments.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
                No damaged or expired stock adjustments recorded.
              </div>
            ) : (
              <>
                <div className="md:hidden divide-y divide-[var(--cm-border)]">
                  {damagedAndExpiredAdjustments.map((adj) => (
                    <CompactExpandableRow
                      key={adj.id}
                      title={adj.productName}
                      subtitle={`${formatDateDDMMYYYY(adj.adjustmentDate)} · ${adj.adjustmentType}`}
                      rightPrimary={
                        <span className="text-[var(--cm-danger)]">
                          -{formatNumber(adj.unitQuantity ?? adj.quantity)} {adj.unitName || ''}
                        </span>
                      }
                      rightSecondary={adj.reason}
                      isExpanded={expandedRowId === `dmg-${adj.id}`}
                      onToggle={() =>
                        setExpandedRowId((cur) => (cur === `dmg-${adj.id}` ? null : `dmg-${adj.id}`))
                      }
                      expandedContent={
                        <div className="text-xs text-[var(--cm-text-secondary)] space-y-1">
                          <div>
                            Reason: <strong className="text-[var(--cm-text-primary)]">{adj.reason}</strong>
                          </div>
                          {adj.notes && <div>Notes: {adj.notes}</div>}
                        </div>
                      }
                    />
                  ))}
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                        <th className="py-2.5 px-3">Date</th>
                        <th className="py-2.5 px-3">Product</th>
                        <th className="py-2.5 px-3">Type</th>
                        <th className="py-2.5 px-3 text-right">Quantity</th>
                        <th className="py-2.5 px-3">Reason</th>
                        <th className="py-2.5 px-3">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                      {damagedAndExpiredAdjustments.map((adj) => (
                        <tr key={adj.id} className="hover:bg-[var(--cm-bg-hover)]">
                          <td className="py-2 px-3 font-mono-num text-[var(--cm-text-secondary)]">
                            {formatDateDDMMYYYY(adj.adjustmentDate)}
                          </td>
                          <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">{adj.productName}</td>
                          <td className="py-2 px-3 text-xs font-semibold capitalize text-[var(--cm-danger)]">
                            {adj.adjustmentType}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-danger)]">
                            -{formatNumber(adj.unitQuantity ?? adj.quantity)} {adj.unitName || ''}
                          </td>
                          <td className="py-2 px-3 text-[var(--cm-text-secondary)]">{adj.reason}</td>
                          <td className="py-2 px-3 text-xs text-[var(--cm-text-muted)]">{adj.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>

      {/* Quick Manual Add/Reduce Stock Modal */}
      {adjustProduct && (() => {
        const units = getAllProductUnits(adjustProduct);
        const baseUnit = getEffectiveBaseUnit(adjustProduct);
        const breakdown = formatStockBreakdown(adjustProduct.currentStock, adjustProduct);
        const fractional = isFractionalUnit(adjustUnitName || baseUnit);
        const baseDelta = roundStockQty((Number(adjustQty) || 0) * (adjustConversion || 1));

        return (
          <div className="fixed inset-0 z-50 bg-[var(--cm-bg-overlay)] flex items-center justify-center p-4">
            <div className="cm-surface border rounded-xl w-full max-w-md p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-[var(--cm-border)] pb-3">
                <h3 className="text-base font-semibold text-[var(--cm-text-primary)]">
                  {adjustMode === 'add' ? 'Add Stock' : 'Reduce Stock'} — {adjustProduct.name}
                </h3>
                <button
                  type="button"
                  onClick={() => setAdjustProduct(null)}
                  className="p-1 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {adjustErr && (
                <div className="p-3 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg text-sm text-[var(--cm-danger)]">
                  {adjustErr}
                </div>
              )}

              <form onSubmit={handleQuickAdjust} className="space-y-4">
                <div className="text-xs text-[var(--cm-text-muted)]">
                  Current stock:{' '}
                  <span className="font-semibold font-mono-num text-[var(--cm-text-primary)]">
                    {breakdown.summaryText}
                  </span>
                </div>

                {units.length > 1 && (
                  <div>
                    <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                      Adjustment Unit
                    </label>
                    <select
                      value={adjustUnitName}
                      onChange={(e) => {
                        const matched = units.find((u) => u.unitName === e.target.value) || units[0];
                        setAdjustUnitName(matched.unitName);
                        setAdjustConversion(matched.conversionQty);
                      }}
                      className="w-full min-h-[40px] px-3 py-2 text-sm border cm-input rounded-lg"
                    >
                      {units.map((u) => (
                        <option key={u.unitName} value={u.unitName}>
                          {u.unitName}
                          {u.conversionQty > 1 ? ` (${formatNumber(u.conversionQty)} ${baseUnit})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                    Quantity to {adjustMode} ({adjustUnitName || baseUnit})
                  </label>
                  <input
                    type="number"
                    min={fractional ? '0.01' : 1}
                    step={fractional ? '0.01' : 1}
                    required
                    value={adjustQty}
                    onChange={(e) => setAdjustQty(e.target.value)}
                    className="w-full px-3 py-2 text-sm border cm-input rounded-lg font-mono-num"
                  />
                  {adjustConversion > 1 && (
                    <div className="mt-1 text-[11px] font-mono-num text-[var(--cm-accent-text)]">
                      {adjustMode === 'add' ? '+' : '-'}{formatNumber(baseDelta)} {baseUnit} in base stock
                    </div>
                  )}
                </div>

                {adjustProduct.isReturnable && (
                  <div>
                    <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                      Empty {adjustProduct.returnableUnitName || 'Container'} Change (+/- optional)
                    </label>
                    <input
                      type="number"
                      step={1}
                      value={adjustEmptyDelta}
                      onChange={(e) => setAdjustEmptyDelta(e.target.value)}
                      className="w-full px-3 py-2 text-sm border cm-input rounded-lg font-mono-num"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                    Reason
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={200}
                    value={adjustReason}
                    onChange={(e) => setAdjustReason(e.target.value)}
                    className="w-full px-3 py-2 text-sm border cm-input rounded-lg"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setAdjustProduct(null)}
                    className="px-4 py-2 text-sm font-medium text-[var(--cm-text-secondary)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingAdjust}
                    className="px-4 py-2 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg disabled:opacity-50 cursor-pointer"
                  >
                    {savingAdjust ? 'Saving...' : 'Confirm'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
