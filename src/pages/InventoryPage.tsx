import { AlertTriangle, ArrowDown, ArrowUp, Filter, Plus, Search, X } from 'lucide-react';
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

export function InventoryPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { products, categories, brands, suppliers, stockMovements, stockAdjustments, settings } = useShopData();
  const { showToast } = useToast();
  const todayIso = getKarachiDateIso();
  const alertDays = settings?.expiryAlertDays ?? 30;

  const [activeTab, setActiveTab] = useState<'stock' | 'alerts' | 'movements' | 'damaged'>('stock');
  const [search, setSearch] = useState('');
  const [filterProductId, setFilterProductId] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterSupplierId, setFilterSupplierId] = useState('');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  const productOptions = useMemo<SearchableSelectOption[]>(
    () =>
      products.map((p) => ({
        value: p.id,
        label: p.name,
        subtitle: [p.brandName, p.categoryName].filter(Boolean).join(' · '),
        meta: `Stock: ${formatNumber(p.currentStock)} ${p.unit}`,
        badge: p.currentStock <= 0 ? 'Out of Stock' : p.currentStock <= p.minStockLevel ? 'Low Stock' : 'Healthy',
        badgeTone: p.currentStock <= 0 ? 'danger' : p.currentStock <= p.minStockLevel ? 'warning' : 'success',
        keywords: [p.name, p.brandName, p.categoryName, p.supplierName].filter(Boolean),
      })),
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
  const [adjustQty, setAdjustQty] = useState('1');
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
      totalUnits += p.currentStock;
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
      if (q && !`${p.name} ${p.categoryName} ${p.brandName} ${p.supplierName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [products, search, filterProductId, filterCat, filterBrand, filterSupplierId]);

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
    () => stockAdjustments.filter((a) => a.adjustmentType === 'damaged' || a.adjustmentType === 'expired'),
    [stockAdjustments]
  );

  const openQuickAdjust = (product: Product, mode: 'add' | 'reduce') => {
    setAdjustProduct(product);
    setAdjustMode(mode);
    setAdjustQty('1');
    setAdjustReason(mode === 'add' ? 'Manual stock addition' : 'Manual stock reduction');
    setAdjustErr(null);
  };

  const handleQuickAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId || !adjustProduct) return;
    setAdjustErr(null);
    const qty = Number(adjustQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      setAdjustErr('Enter a valid positive quantity.');
      return;
    }

    setSavingAdjust(true);
    try {
      await createStockAdjustment(activeShopId, {
        productId: adjustProduct.id,
        quantity: qty,
        adjustmentDate: todayIso,
        adjustmentType: adjustMode,
        reason: adjustReason.trim() || 'Manual inventory update',
        notes: 'Quick stock adjustment from Inventory page',
      });
      showToast({
        title: 'Stock updated',
        message: `${adjustProduct.name} (${adjustMode === 'add' ? '+' : '-'}${qty})`,
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
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Total Units</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900">
            {formatNumber(inventoryMetrics.totalUnits)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Inventory Cost</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
            {formatPKR(inventoryMetrics.totalCostValue)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Retail Value</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-emerald-700 truncate">
            {formatPKR(inventoryMetrics.totalRetailValue)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Low / Out</div>
          <div className="mt-0.5 text-sm sm:text-base font-bold font-mono-num tabular-nums text-amber-600">
            {inventoryMetrics.lowCount} low · {inventoryMetrics.outCount} out
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1 bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Expiry Alerts</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-red-600">
            {formatNumber(inventoryMetrics.expiryCount)}
          </div>
        </div>
      </div>

      {/* Tabs & Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 sm:p-4 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                { id: 'stock', label: 'Current Stock' },
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
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {(activeTab === 'stock' || activeTab === 'alerts') && (
            <button
              type="button"
              onClick={() => setShowMobileFilters((v) => !v)}
              className="lg:hidden inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>{showMobileFilters ? 'Hide Filters' : 'Filters'}</span>
            </button>
          )}
        </div>

        {(activeTab === 'stock' || activeTab === 'alerts') && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-2">
            <div className="relative lg:col-span-4">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search inventory..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full min-h-[38px] pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
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
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {activeTab === 'stock' && (
          <>
            {filteredProducts.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-slate-500">
                No products found in inventory.
              </div>
            ) : (
              <>
                <div className="md:hidden divide-y divide-slate-100">
                  {filteredProducts.map((p) => {
                    const st = getProductStockStatus(p, todayIso, alertDays);
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
                        ? 'text-red-600'
                        : st.isLowStock || st.isNearingExpiry
                        ? 'text-amber-600'
                        : 'text-emerald-700';

                    return (
                      <CompactExpandableRow
                        key={p.id}
                        title={p.name}
                        subtitle={`${p.categoryName} · ${p.brandName}`}
                        rightPrimary={`${p.currentStock} ${p.unit}`}
                        rightSecondary={<span className={statusTone}>{statusText}</span>}
                        isExpanded={expandedRowId === `stock-${p.id}`}
                        onToggle={() =>
                          setExpandedRowId((cur) => (cur === `stock-${p.id}` ? null : `stock-${p.id}`))
                        }
                        expandedContent={
                          <div className="space-y-2">
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <div>
                                <span className="text-slate-500">Cost Value:</span>{' '}
                                <span className="font-mono-num font-semibold text-slate-900">
                                  {formatPKR(roundMoney(p.currentStock * p.purchasePrice))}
                                </span>
                              </div>
                              <div>
                                <span className="text-slate-500">Min / Max:</span>{' '}
                                <span className="font-mono-num text-slate-800">
                                  {p.minStockLevel} / {p.maxStockLevel}
                                </span>
                              </div>
                              <div className="col-span-2">
                                <span className="text-slate-500">Expiry:</span>{' '}
                                <span className="font-mono-num text-slate-800">
                                  {p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—'}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => openQuickAdjust(p, 'add')}
                                className="min-h-[36px] inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold text-emerald-700 bg-white border border-emerald-200 rounded-lg cursor-pointer"
                              >
                                <Plus className="w-3.5 h-3.5" /> Add Stock
                              </button>
                              <button
                                type="button"
                                disabled={p.currentStock <= 0}
                                onClick={() => openQuickAdjust(p, 'reduce')}
                                className="min-h-[36px] inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold text-slate-700 bg-white border border-slate-200 disabled:opacity-40 rounded-lg cursor-pointer"
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
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-2.5 px-3">Product</th>
                        <th className="py-2.5 px-3">Category · Brand</th>
                        <th className="py-2.5 px-3 text-right">Stock</th>
                        <th className="py-2.5 px-3 text-right">Min / Max</th>
                        <th className="py-2.5 px-3 text-right">Cost Value</th>
                        <th className="py-2.5 px-3">Expiry</th>
                        <th className="py-2.5 px-3">Status</th>
                        <th className="py-2.5 px-3 text-right">Quick Stock</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                      {filteredProducts.map((p) => {
                        const st = getProductStockStatus(p, todayIso, alertDays);
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
                            ? 'text-red-600'
                            : st.isLowStock || st.isNearingExpiry
                            ? 'text-amber-600'
                            : 'text-emerald-700';

                        return (
                          <tr key={p.id} className="hover:bg-slate-50">
                            <td className="py-2 px-3 font-medium text-slate-900">{p.name}</td>
                            <td className="py-2 px-3 text-xs text-slate-500">
                              {p.categoryName} · {p.brandName}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num font-semibold text-slate-900">
                              {p.currentStock} {p.unit}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num text-xs text-slate-500">
                              {p.minStockLevel} / {p.maxStockLevel}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num text-slate-800 whitespace-nowrap">
                              {formatPKR(roundMoney(p.currentStock * p.purchasePrice))}
                            </td>
                            <td className="py-2 px-3 font-mono-num text-xs text-slate-600">
                              {p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—'}
                            </td>
                            <td className={`py-2 px-3 text-xs font-semibold ${statusTone}`}>{statusText}</td>
                            <td className="py-2 px-3 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => openQuickAdjust(p, 'add')}
                                  className="inline-flex items-center gap-0.5 px-2 py-1 text-xs font-medium text-emerald-700 border border-slate-200 hover:bg-emerald-50 rounded cursor-pointer"
                                >
                                  <Plus className="w-3 h-3" /> Add
                                </button>
                                <button
                                  type="button"
                                  disabled={p.currentStock <= 0}
                                  onClick={() => openQuickAdjust(p, 'reduce')}
                                  className="inline-flex items-center gap-0.5 px-2 py-1 text-xs font-medium text-slate-700 border border-slate-200 hover:bg-slate-100 disabled:opacity-40 rounded cursor-pointer"
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

        {activeTab === 'alerts' && (
          <>
            {alertRows.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-slate-500">
                No low stock, out of stock, or expiry alerts right now.
              </div>
            ) : (
              <>
                <div className="md:hidden divide-y divide-slate-100">
                  {alertRows.map((row, idx) => (
                    <CompactExpandableRow
                      key={`${row.product.id}-${idx}`}
                      title={row.product.name}
                      subtitle={`Stock: ${row.product.currentStock} ${row.product.unit} · Min: ${row.product.minStockLevel}`}
                      rightPrimary={
                        <span className={row.severity === 'red' ? 'text-red-600' : 'text-amber-600'}>
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
                          <span className="text-slate-600">
                            Supplier: <strong>{row.product.supplierName || '—'}</strong>
                          </span>
                          <button
                            type="button"
                            onClick={() => openQuickAdjust(row.product, 'add')}
                            className="min-h-[34px] px-3 py-1 text-xs font-semibold text-teal-700 bg-white border border-teal-200 rounded-lg cursor-pointer"
                          >
                            + Add Stock
                          </button>
                        </div>
                      }
                    />
                  ))}
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-2.5 px-3">Product</th>
                        <th className="py-2.5 px-3">Stock</th>
                        <th className="py-2.5 px-3">Min Level</th>
                        <th className="py-2.5 px-3">Expiry</th>
                        <th className="py-2.5 px-3">Alert</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                      {alertRows.map((row, idx) => (
                        <tr key={`${row.product.id}-${idx}`} className="hover:bg-slate-50">
                          <td className="py-2 px-3 font-medium text-slate-900">{row.product.name}</td>
                          <td className="py-2 px-3 font-mono-num">
                            {row.product.currentStock} {row.product.unit}
                          </td>
                          <td className="py-2 px-3 font-mono-num text-slate-500">
                            {row.product.minStockLevel} {row.product.unit}
                          </td>
                          <td className="py-2 px-3 font-mono-num text-slate-600">
                            {row.product.expiryDate ? formatDateDDMMYYYY(row.product.expiryDate) : '—'}
                          </td>
                          <td
                            className={`py-2 px-3 text-xs font-semibold inline-flex items-center gap-1.5 ${
                              row.severity === 'red' ? 'text-red-600' : 'text-amber-600'
                            }`}
                          >
                            <AlertTriangle className="w-3.5 h-3.5" />
                            {row.label}
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

        {activeTab === 'movements' && (
          <>
            {stockMovements.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-slate-500">
                No stock movements logged yet.
              </div>
            ) : (
              <>
                <div className="md:hidden divide-y divide-slate-100">
                  {stockMovements.map((m) => (
                    <CompactExpandableRow
                      key={m.id}
                      title={m.productName}
                      subtitle={`${formatDateDDMMYYYY(m.movementDate)} · ${m.movementType.replace(/_/g, ' ')}`}
                      rightPrimary={
                        <span className={m.quantityChange >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                          {m.quantityChange > 0 ? `+${m.quantityChange}` : m.quantityChange}
                        </span>
                      }
                      rightSecondary={`${m.previousStock} → ${m.newStock}`}
                      isExpanded={expandedRowId === `mov-${m.id}`}
                      onToggle={() =>
                        setExpandedRowId((cur) => (cur === `mov-${m.id}` ? null : `mov-${m.id}`))
                      }
                      expandedContent={
                        <p className="text-xs text-slate-600">{m.notes || 'No notes recorded.'}</p>
                      }
                    />
                  ))}
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-2.5 px-3">Date</th>
                        <th className="py-2.5 px-3">Product</th>
                        <th className="py-2.5 px-3">Movement Type</th>
                        <th className="py-2.5 px-3 text-right">Change</th>
                        <th className="py-2.5 px-3 text-right">Previous</th>
                        <th className="py-2.5 px-3 text-right">New Stock</th>
                        <th className="py-2.5 px-3">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                      {stockMovements.map((m) => (
                        <tr key={m.id} className="hover:bg-slate-50">
                          <td className="py-2 px-3 font-mono-num text-slate-700 whitespace-nowrap">
                            {formatDateDDMMYYYY(m.movementDate)}
                          </td>
                          <td className="py-2 px-3 font-medium text-slate-900">{m.productName}</td>
                          <td className="py-2 px-3 text-xs capitalize text-slate-600">
                            {m.movementType.replace(/_/g, ' ')}
                          </td>
                          <td
                            className={`py-2 px-3 text-right font-mono-num font-semibold ${
                              m.quantityChange >= 0 ? 'text-emerald-700' : 'text-red-600'
                            }`}
                          >
                            <span className="inline-flex items-center gap-0.5">
                              {m.quantityChange >= 0 ? (
                                <ArrowUp className="w-3 h-3" />
                              ) : (
                                <ArrowDown className="w-3 h-3" />
                              )}
                              {m.quantityChange > 0 ? `+${m.quantityChange}` : m.quantityChange}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num text-slate-500">{m.previousStock}</td>
                          <td className="py-2 px-3 text-right font-mono-num font-medium text-slate-900">
                            {m.newStock}
                          </td>
                          <td className="py-2 px-3 text-xs text-slate-500">{m.notes}</td>
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
              <div className="p-6 text-center text-xs sm:text-sm text-slate-500">
                No damaged or expired stock adjustments recorded.
              </div>
            ) : (
              <>
                <div className="md:hidden divide-y divide-slate-100">
                  {damagedAndExpiredAdjustments.map((adj) => (
                    <CompactExpandableRow
                      key={adj.id}
                      title={adj.productName}
                      subtitle={`${formatDateDDMMYYYY(adj.adjustmentDate)} · ${adj.adjustmentType}`}
                      rightPrimary={<span className="text-red-600">-{adj.quantity}</span>}
                      rightSecondary={adj.reason}
                      isExpanded={expandedRowId === `dmg-${adj.id}`}
                      onToggle={() =>
                        setExpandedRowId((cur) => (cur === `dmg-${adj.id}` ? null : `dmg-${adj.id}`))
                      }
                      expandedContent={
                        <div className="text-xs text-slate-600 space-y-1">
                          <div>Reason: <strong className="text-slate-900">{adj.reason}</strong></div>
                          {adj.notes && <div>Notes: {adj.notes}</div>}
                        </div>
                      }
                    />
                  ))}
                </div>

                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-2.5 px-3">Date</th>
                        <th className="py-2.5 px-3">Product</th>
                        <th className="py-2.5 px-3">Type</th>
                        <th className="py-2.5 px-3 text-right">Quantity</th>
                        <th className="py-2.5 px-3">Reason</th>
                        <th className="py-2.5 px-3">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                      {damagedAndExpiredAdjustments.map((adj) => (
                        <tr key={adj.id} className="hover:bg-slate-50">
                          <td className="py-2 px-3 font-mono-num text-slate-700">
                            {formatDateDDMMYYYY(adj.adjustmentDate)}
                          </td>
                          <td className="py-2 px-3 font-medium text-slate-900">{adj.productName}</td>
                          <td className="py-2 px-3 text-xs font-semibold capitalize text-red-600">
                            {adj.adjustmentType}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num text-red-600">-{adj.quantity}</td>
                          <td className="py-2 px-3 text-slate-700">{adj.reason}</td>
                          <td className="py-2 px-3 text-xs text-slate-500">{adj.notes || '—'}</td>
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
      {adjustProduct && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-semibold text-slate-900">
                {adjustMode === 'add' ? 'Add Stock' : 'Reduce Stock'} — {adjustProduct.name}
              </h3>
              <button
                type="button"
                onClick={() => setAdjustProduct(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {adjustErr && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {adjustErr}
              </div>
            )}

            <form onSubmit={handleQuickAdjust} className="space-y-4">
              <div className="text-xs text-slate-500">
                Current stock: <span className="font-semibold font-mono-num text-slate-900">{adjustProduct.currentStock} {adjustProduct.unit}</span>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Quantity to {adjustMode} ({adjustProduct.unit})
                </label>
                <input
                  type="number"
                  min={1}
                  required
                  value={adjustQty}
                  onChange={(e) => setAdjustQty(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Reason</label>
                <input
                  type="text"
                  required
                  maxLength={200}
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAdjustProduct(null)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAdjust}
                  className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg disabled:opacity-50"
                >
                  {savingAdjust ? 'Saving...' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
