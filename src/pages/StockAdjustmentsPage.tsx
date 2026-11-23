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
import {
  formatStockBreakdown,
  getEffectiveBaseUnit,
  isFractionalUnit,
  pluralizeUnit,
  roundStockQty,
} from '../utils/packaging';

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

interface AdjustableUnitOption {
  unitName: string;
  conversionQty: number;
}

function getAdjustableUnits(product: Product | null): AdjustableUnitOption[] {
  if (!product) return [];
  const baseUnit = getEffectiveBaseUnit(product);
  const options: AdjustableUnitOption[] = [{ unitName: baseUnit, conversionQty: 1 }];
  const seen = new Set<string>([baseUnit.toLowerCase()]);
  for (const pkg of product.packagingUnits || []) {
    const u = (pkg.unitName || '').trim();
    const conv = roundStockQty(Number(pkg.conversionQty) || 0);
    if (!u || conv <= 0 || seen.has(u.toLowerCase())) continue;
    seen.add(u.toLowerCase());
    options.push({ unitName: u, conversionQty: conv });
  }
  return options;
}

export function StockAdjustmentsPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { products, stockAdjustments, saleItems } = useShopData();
  const { showToast } = useToast();
  const todayIso = getKarachiDateIso();

  const [productId, setProductId] = useState('');
  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>('damaged');
  const [unitName, setUnitName] = useState('');
  const [conversionFactor, setConversionFactor] = useState(1);
  const [quantity, setQuantity] = useState('1');
  const [emptyContainerDelta, setEmptyContainerDelta] = useState('');
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

  const adjustableUnits = useMemo(
    () => getAdjustableUnits(selectedProduct),
    [selectedProduct]
  );

  const baseUnit = getEffectiveBaseUnit(selectedProduct);
  const selectedUnitLabel = unitName || baseUnit;
  const allowFractional = isFractionalUnit(selectedUnitLabel);

  const handleSelectProduct = (pid: string) => {
    setProductId(pid);
    const prod = activeProducts.find((p) => p.id === pid) || null;
    if (prod) {
      const base = getEffectiveBaseUnit(prod);
      setUnitName(base);
      setConversionFactor(1);
    } else {
      setUnitName('');
      setConversionFactor(1);
    }
    setEmptyContainerDelta('');
  };

  const handleUnitChange = (newUnit: string) => {
    const matched = adjustableUnits.find((u) => u.unitName === newUnit);
    if (matched) {
      setUnitName(matched.unitName);
      setConversionFactor(matched.conversionQty);
    }
  };

  const productOptions = useMemo<SearchableSelectOption[]>(
    () =>
      activeProducts.map((p) => {
        const bd = formatStockBreakdown(p.currentStock, p);
        return {
          value: p.id,
          label: p.name,
          subtitle: [p.brandName, p.categoryName, p.bottleSize].filter(Boolean).join(' · '),
          meta: `Stock: ${bd.summaryText}`,
          badge: p.currentStock <= 0 ? 'Out of Stock' : p.currentStock <= p.minStockLevel ? 'Low Stock' : 'In Stock',
          badgeTone: p.currentStock <= 0 ? 'danger' : p.currentStock <= p.minStockLevel ? 'warning' : 'success',
          keywords: [p.name, p.brandName, p.categoryName, p.supplierName, p.bottleSize || ''].filter(Boolean),
        };
      }),
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

  const baseEquivalentQty = roundStockQty((Number(quantity) || 0) * (conversionFactor || 1));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId) return;
    setError(null);
    setSuccess(null);

    if (!productId || !selectedProduct) {
      setError('Please select a product.');
      return;
    }
    const qty = roundStockQty(Number(quantity));
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Quantity must be greater than zero.');
      return;
    }
    if (!reason.trim()) {
      setError('Please enter a reason for the adjustment.');
      return;
    }

    const parsedEmptyDelta = emptyContainerDelta.trim() === '' ? undefined : Number(emptyContainerDelta);
    if (parsedEmptyDelta !== undefined && !Number.isFinite(parsedEmptyDelta)) {
      setError('Enter a valid number for empty container change.');
      return;
    }

    setSubmitting(true);
    try {
      await createStockAdjustment(activeShopId, {
        productId,
        quantity: qty,
        unitName: selectedUnitLabel,
        conversionFactor,
        adjustmentDate,
        adjustmentType,
        reason: reason.trim(),
        notes: notes.trim(),
        emptyContainerDelta: parsedEmptyDelta,
      });
      setQuantity('1');
      setEmptyContainerDelta('');
      setReason('');
      setNotes('');
      setSuccess('Stock adjustment saved and inventory updated.');
      showToast({
        title: 'Stock adjustment applied',
        message: `${selectedProduct.name} (${adjustmentType === 'add' ? '+' : '-'}${formatNumber(qty)} ${selectedUnitLabel})`,
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

  const selectedStockBreakdown = selectedProduct
    ? formatStockBreakdown(selectedProduct.currentStock, selectedProduct)
    : null;

  return (
    <div className="space-y-4">
      {/* Stock Adjustment Entry Form */}
      <section className="cm-surface border rounded-xl p-3.5 sm:p-4 space-y-3">
        <div>
          <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">
            Record Stock Adjustment
          </h2>
          <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
            Add or deduct stock in base units or configured packages, reconcile FIFO batches, and log damaged/expired inventory.
          </p>
        </div>

        {error && (
          <div className="p-3 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg text-xs sm:text-sm text-[var(--cm-danger)]">
            {error}
          </div>
        )}
        {success && (
          <div className="p-3 bg-[var(--cm-success-soft)] border border-[var(--cm-success-border)] rounded-lg text-xs sm:text-sm text-[var(--cm-success)]">
            {success}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Product Name *
              </label>
              <SearchableSelect
                required
                size="sm"
                ariaLabel="Select product to adjust"
                suggestionScope="product"
                suggestedValues={frequentProductIds}
                options={productOptions}
                value={productId}
                onChange={handleSelectProduct}
                placeholder="Search product..."
                searchPlaceholder="Type product name or brand..."
                noResultsMessage="No products found"
                onRefreshOptions={handleRefreshProducts}
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Adjustment Type *
              </label>
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

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                  Unit
                </label>
                <select
                  value={selectedUnitLabel}
                  disabled={!selectedProduct}
                  onChange={(e) => handleUnitChange(e.target.value)}
                  className="cm-input w-full min-h-[38px] px-2 py-1.5 text-xs sm:text-sm border rounded-lg disabled:opacity-60"
                >
                  {adjustableUnits.length === 0 ? (
                    <option value="">Unit</option>
                  ) : (
                    adjustableUnits.map((u) => (
                      <option key={u.unitName} value={u.unitName}>
                        {u.unitName}
                        {u.conversionQty > 1
                          ? ` (${formatNumber(u.conversionQty)} ${pluralizeUnit(selectedProduct ? getEffectiveBaseUnit(selectedProduct) : 'Piece', u.conversionQty)})`
                          : ''}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                  Qty *
                </label>
                <input
                  type="number"
                  required
                  min={allowFractional ? '0.001' : '1'}
                  step={allowFractional ? '0.001' : '1'}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="cm-input w-full min-h-[38px] px-2.5 py-1.5 text-sm border rounded-lg font-mono-num"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                  Date *
                </label>
                <input
                  type="date"
                  required
                  value={adjustmentDate}
                  onChange={(e) => setAdjustmentDate(e.target.value)}
                  className="cm-input w-full min-h-[38px] px-2 py-1.5 text-xs border rounded-lg font-mono-num"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Reason *
              </label>
              <input
                type="text"
                required
                maxLength={200}
                placeholder="e.g., Torn packaging during delivery"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="cm-input w-full min-h-[38px] px-3 py-1.5 text-sm border rounded-lg"
              />
            </div>

            <div className={selectedProduct?.isReturnable ? '' : 'sm:col-span-2'}>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Notes (Optional)
              </label>
              <input
                type="text"
                maxLength={500}
                placeholder="Optional extra details"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="cm-input w-full min-h-[38px] px-3 py-1.5 text-sm border rounded-lg"
              />
            </div>

            {selectedProduct?.isReturnable && (
              <div>
                <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                  Empty {selectedProduct.returnableUnitName || 'Crate/Bottle'} Change (+/-)
                </label>
                <input
                  type="number"
                  step="1"
                  placeholder={`Current empties: ${formatNumber(selectedProduct.emptyContainersOnHand || 0)}`}
                  value={emptyContainerDelta}
                  onChange={(e) => setEmptyContainerDelta(e.target.value)}
                  className="cm-input w-full min-h-[38px] px-3 py-1.5 text-sm border rounded-lg font-mono-num"
                />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-[var(--cm-border)]">
            <div className="text-xs text-[var(--cm-text-muted)] space-y-0.5">
              {selectedProduct && selectedStockBreakdown ? (
                <>
                  <div>
                    Current Stock:{' '}
                    <span className="font-semibold font-mono-num text-[var(--cm-text-primary)]">
                      {selectedStockBreakdown.summaryText}
                    </span>
                  </div>
                  {baseEquivalentQty > 0 && (
                    <div className="text-[11px] text-[var(--cm-accent-text)] font-mono-num">
                      Adjustment impact: {adjustmentType === 'add' ? '+' : '-'}
                      {formatNumber(baseEquivalentQty)} {baseUnit}
                    </div>
                  )}
                </>
              ) : (
                'Select a product to view current stock & packaging units.'
              )}
            </div>

            <button
              type="submit"
              disabled={submitting || activeProducts.length === 0}
              className="w-full sm:w-auto min-h-[42px] inline-flex items-center justify-center gap-1.5 px-5 py-2 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg disabled:opacity-50 cursor-pointer"
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
        <div className="p-3 sm:p-4 border-b border-[var(--cm-border)] grid grid-cols-1 sm:grid-cols-12 gap-2">
          <div className="relative sm:col-span-7">
            <Search className="w-4 h-4 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search adjustments..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="cm-input w-full min-h-[38px] pl-9 pr-3 py-1.5 text-sm border rounded-lg"
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
          <div className="p-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
            No stock adjustments recorded yet.
          </div>
        ) : (
          <>
            <div className="md:hidden divide-y divide-[var(--cm-border)]">
              {filteredAdjustments.map((adj) => {
                const isAdd = adj.adjustmentType === 'add';
                const qtyLabel = adj.unitName
                  ? `${formatNumber(adj.unitQuantity ?? adj.quantity)} ${adj.unitName}`
                  : formatNumber(adj.quantity);
                return (
                  <CompactExpandableRow
                    key={adj.id}
                    title={adj.productName}
                    subtitle={`${formatDateDDMMYYYY(adj.adjustmentDate)} · ${ADJUSTMENT_LABELS[adj.adjustmentType]}`}
                    rightPrimary={
                      <span className={isAdd ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'}>
                        {isAdd ? `+${qtyLabel}` : `-${qtyLabel}`}
                      </span>
                    }
                    rightSecondary={`${formatNumber(adj.previousStock)} → ${formatNumber(adj.newStock)}`}
                    isExpanded={expandedAdjId === adj.id}
                    onToggle={() =>
                      setExpandedAdjId((cur) => (cur === adj.id ? null : adj.id))
                    }
                    expandedContent={
                      <div className="text-xs text-[var(--cm-text-secondary)] space-y-1">
                        <div>
                          Reason: <strong className="text-[var(--cm-text-primary)]">{adj.reason}</strong>
                        </div>
                        {adj.conversionFactor && adj.conversionFactor > 1 && (
                          <div className="font-mono-num text-[var(--cm-text-muted)]">
                            Base impact: {isAdd ? '+' : '-'}
                            {formatNumber(adj.baseQuantity ?? adj.quantity * adj.conversionFactor)}
                          </div>
                        )}
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
                  <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">Product</th>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3 text-right">Qty</th>
                    <th className="py-2.5 px-3 text-right">Prev → New</th>
                    <th className="py-2.5 px-3">Reason</th>
                    <th className="py-2.5 px-3">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                  {filteredAdjustments.map((adj) => {
                    const isAdd = adj.adjustmentType === 'add';
                    const qtyText = adj.unitName
                      ? `${formatNumber(adj.unitQuantity ?? adj.quantity)} ${adj.unitName}`
                      : formatNumber(adj.quantity);
                    return (
                      <tr key={adj.id} className="hover:bg-[var(--cm-bg-hover)]">
                        <td className="py-2 px-3 font-mono-num whitespace-nowrap text-xs text-[var(--cm-text-secondary)]">
                          {formatDateDDMMYYYY(adj.adjustmentDate)}
                        </td>
                        <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">
                          {adj.productName}
                        </td>
                        <td className="py-2 px-3 text-xs font-semibold">
                          <span className={isAdd ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'}>
                            {ADJUSTMENT_LABELS[adj.adjustmentType]}
                          </span>
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono-num font-semibold whitespace-nowrap ${
                            isAdd ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                          }`}
                        >
                          {isAdd ? `+${qtyText}` : `-${qtyText}`}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num text-xs text-[var(--cm-text-secondary)] whitespace-nowrap">
                          {formatNumber(adj.previousStock)} → {formatNumber(adj.newStock)}
                        </td>
                        <td className="py-2 px-3 text-[var(--cm-text-secondary)]">{adj.reason}</td>
                        <td className="py-2 px-3 text-xs text-[var(--cm-text-muted)]">{adj.notes || '—'}</td>
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
