import { ClipboardCheck, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CompactExpandableRow, CompactSection } from '../components/CompactSection';
import { SearchableSelect, type SearchableSelectOption } from '../components/SearchableSelect';
import { useAuth } from '../contexts/AuthContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import {
  computeTopActivityValues,
  queryOwnerCollectionSlice,
} from '../services/recordSearchService';
import { createStockAdjustment } from '../services/shopService';
import type { AdjustmentType, Product } from '../types/shop';
import { formatDateDDMMYYYY, formatNumber, getKarachiDateIso } from '../utils/formatters';

const ADJUSTMENT_LABELS: Record<AdjustmentType, string> = {
  add: 'Add Additional Stock',
  reduce: 'Reduce Stock',
  damaged: 'Damaged Products',
  expired: 'Expired Products',
  missing: 'Missing Products',
};

const ADJUSTMENT_SUBTITLES: Record<AdjustmentType, string> = {
  add: 'Increase stock quantity manually',
  reduce: 'Deduct stock quantity manually',
  damaged: 'Remove damaged or torn items',
  expired: 'Remove expired inventory',
  missing: 'Write off shrinkage or missing units',
};

export function StockAdjustmentsPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { products, stockAdjustments, saleItems } = useShopData();
  const { showToast } = useToast();
  const todayIso = getKarachiDateIso();

  const [productId, setProductId] = useState('');
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>('damaged');
  const [quantity, setQuantity] = useState('1');
  const [adjustmentDate, setAdjustmentDate] = useState(todayIso);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'' | AdjustmentType>('');
  const [expandedAdjId, setExpandedAdjId] = useState<string | null>(null);

  const [dbFallbackProducts, setDbFallbackProducts] = useState<Product[] | null>(null);
  const activeProducts = products.length > 0 ? products : dbFallbackProducts || [];

  const selectedProduct = useMemo(
    () => activeProducts.find((p) => p.id === productId) || null,
    [activeProducts, productId]
  );

  const productOptions = useMemo<SearchableSelectOption[]>(
    () =>
      activeProducts.map((p) => ({
        value: p.id,
        label: p.name,
        subtitle: [p.brandName, p.categoryName].filter(Boolean).join(' · '),
        meta: `Stock: ${formatNumber(p.currentStock)} ${p.unit}`,
        badge: p.currentStock <= 0 ? 'Out of Stock' : p.currentStock <= p.minStockLevel ? 'Low Stock' : 'In Stock',
        badgeTone: p.currentStock <= 0 ? 'danger' : p.currentStock <= p.minStockLevel ? 'warning' : 'success',
        keywords: [p.name, p.brandName, p.categoryName, p.supplierName].filter(Boolean),
      })),
    [activeProducts]
  );

  const adjustmentTypeOptions = useMemo<SearchableSelectOption[]>(
    () =>
      (Object.entries(ADJUSTMENT_LABELS) as Array<[AdjustmentType, string]>).map(([val, label]) => ({
        value: val,
        label,
        subtitle: ADJUSTMENT_SUBTITLES[val],
      })),
    []
  );

  const frequentProductIds = useMemo(
    () =>
      stockAdjustments.length > 0
        ? computeTopActivityValues(stockAdjustments, (a) => a.productId, 5)
        : computeTopActivityValues(saleItems, (i) => i.productId, 5),
    [stockAdjustments, saleItems]
  );

  const frequentAdjustmentTypes = useMemo(
    () => computeTopActivityValues(stockAdjustments, (a) => a.adjustmentType, 3),
    [stockAdjustments]
  );

  const handleRefreshProducts = async () => {
    if (!activeShopId) return;
    const fetched = await queryOwnerCollectionSlice<Omit<Product, 'id'>>(activeShopId, 'products', 1000);
    setDbFallbackProducts(fetched);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId) return;
    setError(null);
    setSuccess(null);

    if (!productId) {
      setError('Please select a product.');
      return;
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Quantity must be greater than zero.');
      return;
    }
    if (!reason.trim()) {
      setError('Please enter a reason for the adjustment.');
      return;
    }

    setSubmitting(true);
    try {
      await createStockAdjustment(activeShopId, {
        productId,
        quantity: qty,
        adjustmentDate,
        adjustmentType,
        reason: reason.trim(),
        notes: notes.trim(),
      });
      setQuantity('1');
      setReason('');
      setNotes('');
      setSuccess('Stock adjustment saved and inventory updated.');
      showToast({
        title: 'Stock adjustment applied',
        message: `${selectedProduct?.name || 'Product'} (${adjustmentType === 'add' ? '+' : '-'}${qty})`,
        tone: 'success',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save adjustment.');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredAdjustments = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stockAdjustments.filter((a) => {
      if (filterType && a.adjustmentType !== filterType) return false;
      if (q && !`${a.productName} ${a.reason} ${a.notes}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [stockAdjustments, search, filterType]);

  return (
    <div className="space-y-4">
      {/* Stock Adjustment Entry Form */}
      <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
        <div>
          <h2 className="text-sm sm:text-base font-semibold text-slate-900">Record Stock Adjustment</h2>
          <p className="text-[11px] sm:text-xs text-slate-500">
            Add/reduce stock or log damaged, expired, and missing items with automatic audit trail.
          </p>
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-700">{error}</div>
        )}
        {success && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs sm:text-sm text-emerald-700">
            {success}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Product Name *</label>
              <SearchableSelect
                required
                size="sm"
                ariaLabel="Select product to adjust"
                suggestionScope="product"
                suggestedValues={frequentProductIds}
                options={productOptions}
                value={productId}
                onChange={setProductId}
                placeholder="Search product..."
                searchPlaceholder="Type product name or brand..."
                noResultsMessage="No products found"
                onRefreshOptions={handleRefreshProducts}
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Adjustment Type *</label>
              <SearchableSelect
                required
                size="sm"
                ariaLabel="Select adjustment type"
                suggestionScope="adjustment-type"
                suggestedValues={frequentAdjustmentTypes}
                options={adjustmentTypeOptions}
                value={adjustmentType}
                onChange={(val) => setAdjustmentType((val || 'damaged') as AdjustmentType)}
                placeholder="Select adjustment type..."
                searchPlaceholder="Search adjustment type..."
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Qty {selectedProduct ? `(${selectedProduct.unit})` : ''} *
                </label>
                <input
                  type="number"
                  required
                  min={1}
                  step={1}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-full min-h-[38px] px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg font-mono-num"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Date *</label>
                <input
                  type="date"
                  required
                  value={adjustmentDate}
                  onChange={(e) => setAdjustmentDate(e.target.value)}
                  className="w-full min-h-[38px] px-2 py-1.5 text-xs sm:text-sm border border-slate-200 rounded-lg font-mono-num"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Reason *</label>
              <input
                type="text"
                required
                maxLength={200}
                placeholder="e.g., Torn packaging during delivery"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Notes (Optional)</label>
              <input
                type="text"
                maxLength={500}
                placeholder="Optional extra details"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-slate-200">
            <div className="text-xs text-slate-500">
              {selectedProduct ? (
                <>
                  Current Stock:{' '}
                  <span className="font-semibold font-mono-num text-slate-900">
                    {selectedProduct.currentStock} {selectedProduct.unit}
                  </span>
                </>
              ) : (
                'Select a product to view current stock.'
              )}
            </div>

            <button
              type="submit"
              disabled={submitting || products.length === 0}
              className="w-full sm:w-auto min-h-[42px] inline-flex items-center justify-center gap-1.5 px-5 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg disabled:opacity-50 cursor-pointer"
            >
              <ClipboardCheck className="w-4 h-4" />
              {submitting ? 'Saving...' : 'Apply Stock Adjustment'}
            </button>
          </div>
        </form>
      </section>

      {/* Adjustment History Table */}
      <CompactSection
        title="Adjustment History"
        summary={`${formatNumber(filteredAdjustments.length)} records`}
        collapsible={true}
        defaultOpen={true}
      >
        <div className="p-3 sm:p-4 border-b border-slate-200 grid grid-cols-1 sm:grid-cols-12 gap-2">
          <div className="relative sm:col-span-7">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search adjustments..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full min-h-[38px] pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg"
            />
          </div>
          <div className="sm:col-span-5">
            <SearchableSelect
              size="sm"
              ariaLabel="Filter by adjustment type"
              options={adjustmentTypeOptions}
              value={filterType}
              onChange={(val) => setFilterType(val as '' | AdjustmentType)}
              emptyOptionLabel="All Types"
              placeholder="All Types"
              searchPlaceholder="Search adjustment type..."
            />
          </div>
        </div>

        {filteredAdjustments.length === 0 ? (
          <div className="p-6 text-center text-xs sm:text-sm text-slate-500">
            No stock adjustments recorded yet.
          </div>
        ) : (
          <>
            <div className="md:hidden divide-y divide-slate-100">
              {filteredAdjustments.map((adj) => {
                const isAdd = adj.adjustmentType === 'add';
                return (
                  <CompactExpandableRow
                    key={adj.id}
                    title={adj.productName}
                    subtitle={`${formatDateDDMMYYYY(adj.adjustmentDate)} · ${ADJUSTMENT_LABELS[adj.adjustmentType]}`}
                    rightPrimary={
                      <span className={isAdd ? 'text-emerald-700' : 'text-red-600'}>
                        {isAdd ? `+${adj.quantity}` : `-${adj.quantity}`}
                      </span>
                    }
                    rightSecondary={`${adj.previousStock} → ${adj.newStock}`}
                    isExpanded={expandedAdjId === adj.id}
                    onToggle={() =>
                      setExpandedAdjId((cur) => (cur === adj.id ? null : adj.id))
                    }
                    expandedContent={
                      <div className="text-xs text-slate-600 space-y-1">
                        <div>Reason: <strong className="text-slate-900">{adj.reason}</strong></div>
                        {adj.notes && <div>Notes: {adj.notes}</div>}
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
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">Product</th>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3 text-right">Qty</th>
                    <th className="py-2.5 px-3 text-right">Prev → New</th>
                    <th className="py-2.5 px-3">Reason</th>
                    <th className="py-2.5 px-3">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {filteredAdjustments.map((adj) => {
                    const isAdd = adj.adjustmentType === 'add';
                    return (
                      <tr key={adj.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-mono-num whitespace-nowrap text-xs">
                          {formatDateDDMMYYYY(adj.adjustmentDate)}
                        </td>
                        <td className="py-2 px-3 font-medium text-slate-900">{adj.productName}</td>
                        <td className="py-2 px-3 text-xs font-semibold">
                          <span className={isAdd ? 'text-emerald-700' : 'text-red-600'}>
                            {ADJUSTMENT_LABELS[adj.adjustmentType]}
                          </span>
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono-num font-semibold ${
                            isAdd ? 'text-emerald-700' : 'text-red-600'
                          }`}
                        >
                          {isAdd ? `+${adj.quantity}` : `-${adj.quantity}`}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num text-xs text-slate-600">
                          {adj.previousStock} → {adj.newStock}
                        </td>
                        <td className="py-2 px-3 text-slate-700">{adj.reason}</td>
                        <td className="py-2 px-3 text-xs text-slate-500">{adj.notes || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CompactSection>
    </div>
  );
}
