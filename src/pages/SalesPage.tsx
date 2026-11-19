import { Ban, CheckCircle2, Edit3, Filter, Grid3X3, Search, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { CompactSaleItemsList, type CompactSaleRowItem } from '../components/CompactSaleItemsList';
import { CompactExpandableRow, CompactSection } from '../components/CompactSection';
import { NumericKeypadOverlay } from '../components/NumericKeypadOverlay';
import { SearchableProductSelector } from '../components/SearchableProductSelector';
import { SearchableSelect, type SearchableSelectOption } from '../components/SearchableSelect';
import { useAuth } from '../contexts/AuthContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import {
  mapProductsToSearchable,
  queryProductsFromDatabase,
  type SearchableProductItem,
} from '../services/productSearchService';
import { computeTopActivityValues } from '../services/recordSearchService';
import { cancelSale, createSale, editSale, type SaleLineDraft } from '../services/shopService';
import type { PaymentMethod, Sale, SaleItem } from '../types/shop';
import {
  formatDateDDMMYYYY,
  formatNumber,
  formatPKR,
  getKarachiDateIso,
  getMonthKey,
  roundMoney,
} from '../utils/formatters';

interface LineFormRow {
  key: string;
  productId: string;
  quantity: string;
  salePricePerUnit: string;
}

export function SalesPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { products, sales, saleItems, staffMembers } = useShopData();
  const { showToast } = useToast();
  const todayIso = getKarachiDateIso();

  // New Sale Form State
  const [saleDate, setSaleDate] = useState(todayIso);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<LineFormRow[]>([]);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [lastHighlightedKey, setLastHighlightedKey] = useState<string | null>(null);
  const [quickAddFeedback, setQuickAddFeedback] = useState<string | null>(null);
  const quickFeedbackTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const [allowStockOverride, setAllowStockOverride] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  // Numeric Keypad Overlay Target (supports both New Sale & Edit Sale rows)
  const [keypadTarget, setKeypadTarget] = useState<{
    scope: 'create' | 'edit';
    rowKey: string;
  } | null>(null);

  // Direct Database Fallback Cache if needed
  const [dbFallbackItems, setDbFallbackItems] = useState<SearchableProductItem[] | null>(null);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterProductId, setFilterProductId] = useState('');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);

  const historyProductOptions = useMemo<SearchableSelectOption[]>(
    () =>
      products.map((p) => ({
        value: p.id,
        label: p.name,
        subtitle: `${p.brandName || 'Unbranded'} · ${p.categoryName || 'Uncategorized'}`,
        meta: `Stock: ${p.currentStock} ${p.unit}`,
        keywords: [p.name, p.brandName, p.categoryName],
      })),
    [products]
  );

  const historyPaymentOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: 'Cash', label: 'Cash', subtitle: 'Cash sales' },
      { value: 'Online', label: 'Online', subtitle: 'Bank / wallet sales' },
    ],
    []
  );

  const historyStaffOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: 'owner', label: 'Owner', subtitle: 'Owner-recorded sales' },
      ...staffMembers.map((m) => ({
        value: m.id,
        label: m.name,
        subtitle: `@${m.username}${m.phone ? ` · ${m.phone}` : ''}`,
        keywords: [m.name, m.username, m.phone].filter(Boolean),
      })),
    ],
    [staffMembers]
  );

  const frequentHistoryProductIds = useMemo(
    () => computeTopActivityValues(saleItems, (i) => i.productId, 5),
    [saleItems]
  );
  const frequentHistoryStaffIds = useMemo(
    () => computeTopActivityValues(sales, (s) => s.staffId || 'owner', 5),
    [sales]
  );
  const [filterPayment, setFilterPayment] = useState<'' | PaymentMethod>('');
  const [filterStaffId, setFilterStaffId] = useState('');

  // Edit Modal State
  const [editingSale, setEditingSale] = useState<Sale | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editPayment, setEditPayment] = useState<PaymentMethod>('Cash');
  const [editNotes, setEditNotes] = useState('');
  const [editRows, setEditRows] = useState<LineFormRow[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const productMap = useMemo(() => {
    const map = new Map(products.map((p) => [p.id, p]));
    return map;
  }, [products]);

  const searchableItems = useMemo(() => {
    if (products.length > 0) {
      return mapProductsToSearchable(products);
    }
    return dbFallbackItems || [];
  }, [products, dbFallbackItems]);

  const handleRefreshCatalog = async () => {
    if (!activeShopId) return;
    const fetched = await queryProductsFromDatabase({
      shopId: activeShopId,
      role: 'owner',
      maxDocs: 1000,
    });
    setDbFallbackItems(fetched);
  };

  const saleItemsBySaleId = useMemo(() => {
    const map = new Map<string, SaleItem[]>();
    for (const item of saleItems) {
      const list = map.get(item.saleId) || [];
      list.push(item);
      map.set(item.saleId, list);
    }
    return map;
  }, [saleItems]);

  // Daily, Monthly, Yearly totals
  const salesTotals = useMemo(() => {
    const currentMonth = getMonthKey(todayIso);
    const currentYear = todayIso.slice(0, 4);
    let daily = 0;
    let monthly = 0;
    let yearly = 0;
    for (const s of sales) {
      if (s.status === 'cancelled') continue;
      if (s.saleDate === todayIso) daily = roundMoney(daily + s.totalAmount);
      if (getMonthKey(s.saleDate) === currentMonth) monthly = roundMoney(monthly + s.totalAmount);
      if (s.saleDate.slice(0, 4) === currentYear) yearly = roundMoney(yearly + s.totalAmount);
    }
    return { daily, monthly, yearly };
  }, [sales, todayIso]);

  const triggerAddedConfirmation = (
    rowKey: string,
    name: string,
    qty: number,
    unitPrice: number
  ) => {
    const label = `${name} (×${formatNumber(qty)} · ${formatPKR(qty * unitPrice)})`;
    showToast({
      id: 'sale-product-added',
      title: 'Product added successfully',
      message: label,
      tone: 'success',
      durationMs: 2200,
    });
    setQuickAddFeedback(`Product added successfully · ${label}`);
    setLastHighlightedKey(rowKey);

    if (quickFeedbackTimerRef.current !== null) {
      window.clearTimeout(quickFeedbackTimerRef.current);
    }
    quickFeedbackTimerRef.current = window.setTimeout(() => {
      setQuickAddFeedback(null);
    }, 2600);

    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setLastHighlightedKey(null);
    }, 1600);
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    setExpandedRowKey((cur) => (cur === key ? null : cur));
  };

  const handleQuickAddProduct = (item: SearchableProductItem) => {
    setFormError(null);
    setFormSuccess(null);

    const existing = rows.find((r) => r.productId === item.id);
    if (existing) {
      const currentQty = Math.max(1, Math.floor(Number(existing.quantity) || 1));
      const nextQty = currentQty + 1;
      if (!allowStockOverride && nextQty > item.currentStock) {
        setFormError(
          `Cannot exceed available stock for "${item.name}" (${formatNumber(item.currentStock)} ${item.unit}).`
        );
        return;
      }
      const unitPrice = Number(existing.salePricePerUnit) || item.salePrice;
      setRows((prev) => {
        const updated = { ...existing, quantity: String(nextQty) };
        return [updated, ...prev.filter((r) => r.key !== existing.key)];
      });
      triggerAddedConfirmation(existing.key, item.name, nextQty, unitPrice);
      return;
    }

    const newKey = `row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setRows((prev) => [
      {
        key: newKey,
        productId: item.id,
        quantity: '1',
        salePricePerUnit: String(item.salePrice),
      },
      ...prev.filter((r) => Boolean(r.productId)),
    ]);
    triggerAddedConfirmation(newKey, item.name, 1, item.salePrice);
  };

  const stepRowQuantity = (scope: 'create' | 'edit', key: string, delta: number) => {
    const setter = scope === 'create' ? setRows : setEditRows;
    const targetRows = scope === 'create' ? rows : editRows;
    const row = targetRows.find((r) => r.key === key);
    if (!row) return;
    const prod = productMap.get(row.productId);
    const cur = Math.max(1, Math.floor(Number(row.quantity) || 1));
    const next = Math.max(1, cur + delta);

    if (scope === 'create' && prod && !allowStockOverride && next > prod.currentStock) {
      setFormError(
        `Cannot exceed available stock for "${prod.name}" (${formatNumber(prod.currentStock)} ${prod.unit}).`
      );
      return;
    }
    setFormError(null);
    setter((prev) => prev.map((r) => (r.key === key ? { ...r, quantity: String(next) } : r)));
  };

  const updateRowField = (key: string, field: 'quantity' | 'salePricePerUnit', value: string) => {
    setFormError(null);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  };

  const draftTotals = useMemo(() => {
    let totalAmount = 0;
    let totalCost = 0;
    let itemCount = 0;
    let totalUnits = 0;
    for (const r of rows) {
      const prod = productMap.get(r.productId);
      const qty = Math.max(0, Number(r.quantity) || 0);
      const price = Number(r.salePricePerUnit) || 0;
      if (prod) {
        itemCount += 1;
        totalUnits += qty;
        if (qty > 0) {
          totalAmount = roundMoney(totalAmount + qty * price);
          totalCost = roundMoney(totalCost + qty * prod.purchasePrice);
        }
      }
    }
    return {
      totalAmount,
      totalCost,
      estimatedProfit: roundMoney(totalAmount - totalCost),
      itemCount,
      totalUnits,
    };
  }, [rows, productMap]);

  const compactSaleItems = useMemo<CompactSaleRowItem[]>(() => {
    return rows.reduce<CompactSaleRowItem[]>((acc, r) => {
      const prod = productMap.get(r.productId);
      if (prod) {
        acc.push({
          key: r.key,
          productId: r.productId,
          name: prod.name,
          brandName: prod.brandName,
          unit: prod.unit,
          currentStock: prod.currentStock,
          quantity: r.quantity,
          salePricePerUnit: r.salePricePerUnit,
          purchasePrice: prod.purchasePrice,
        });
      }
      return acc;
    }, []);
  }, [rows, productMap]);

  const handleSaveSale = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId) return;
    setFormError(null);
    setFormSuccess(null);

    const activeRows = rows.filter((r) => r.productId);
    if (activeRows.length === 0) {
      setFormError('Search and select at least one product to record a sale.');
      return;
    }

    const qtyByProduct = new Map<string, number>();
    const items: SaleLineDraft[] = [];
    for (const r of activeRows) {
      const prod = productMap.get(r.productId);
      if (!prod) {
        setFormError('Selected product was not found.');
        return;
      }
      const qty = Math.floor(Number(r.quantity));
      const price = Number(r.salePricePerUnit);
      if (!Number.isFinite(qty) || qty <= 0) {
        setFormError(`Quantity for "${prod.name}" must be greater than zero.`);
        return;
      }
      if (!Number.isFinite(price) || price < 0) {
        setFormError(`Selling price for "${prod.name}" cannot be negative.`);
        return;
      }

      const cumulativeQty = (qtyByProduct.get(r.productId) || 0) + qty;
      qtyByProduct.set(r.productId, cumulativeQty);
      if (!allowStockOverride && cumulativeQty > prod.currentStock) {
        setFormError(
          `Insufficient stock for "${prod.name}". Available: ${formatNumber(prod.currentStock)} ${prod.unit}, Requested: ${formatNumber(cumulativeQty)}.`
        );
        return;
      }

      items.push({ productId: r.productId, quantity: qty, salePricePerUnit: price });
    }

    setSubmitting(true);
    try {
      await createSale(
        activeShopId,
        {
          saleDate,
          paymentMethod,
          notes,
          items,
        },
        { allowStockOverride }
      );
      setNotes('');
      setRows([]);
      setExpandedRowKey(null);
      setQuickAddFeedback(null);
      setFormSuccess('Sale saved and inventory updated.');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save sale.');
    } finally {
      setSubmitting(false);
    }
  };

  const openEditModal = (sale: Sale) => {
    const items = saleItemsBySaleId.get(sale.id) || [];
    setEditingSale(sale);
    setEditDate(sale.saleDate);
    setEditPayment(sale.paymentMethod);
    setEditNotes(sale.notes);
    setEditRows(
      items.map((item) => ({
        key: item.id,
        productId: item.productId,
        quantity: String(item.quantity),
        salePricePerUnit: String(item.salePricePerUnit),
      }))
    );
    setEditError(null);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId || !editingSale) return;
    setEditError(null);

    const items: SaleLineDraft[] = [];
    for (const r of editRows) {
      if (!r.productId) {
        setEditError('Please select a product for every row.');
        return;
      }
      const qty = Number(r.quantity);
      const price = Number(r.salePricePerUnit);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) {
        setEditError('Enter valid positive quantities and non-negative prices.');
        return;
      }
      items.push({ productId: r.productId, quantity: qty, salePricePerUnit: price });
    }

    setSavingEdit(true);
    try {
      const existingItems = saleItemsBySaleId.get(editingSale.id) || [];
      await editSale(
        activeShopId,
        editingSale,
        existingItems,
        {
          saleDate: editDate,
          paymentMethod: editPayment,
          notes: editNotes,
          items,
        },
        { allowStockOverride }
      );
      setEditingSale(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update sale.');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleCancelSale = async (sale: Sale) => {
    if (!activeShopId) return;
    try {
      await cancelSale(activeShopId, sale, 'Cancelled from sales history');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to cancel sale.');
    }
  };

  const filteredSales = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return sales.filter((s) => {
      if (filterFrom && s.saleDate < filterFrom) return false;
      if (filterTo && s.saleDate > filterTo) return false;
      if (filterPayment && s.paymentMethod !== filterPayment) return false;
      if (filterStaffId === 'owner') {
        if (s.staffId && s.staffId !== 'owner') return false;
      } else if (filterStaffId) {
        if (s.staffId !== filterStaffId) return false;
      }
      const items = saleItemsBySaleId.get(s.id) || [];
      if (filterProductId && !items.some((i) => i.productId === filterProductId)) return false;
      if (q) {
        const matchNumber = s.saleNumber.toLowerCase().includes(q);
        const matchNotes = s.notes.toLowerCase().includes(q);
        const matchStaff = (s.staffName || '').toLowerCase().includes(q);
        const matchProduct = items.some((i) => i.productName.toLowerCase().includes(q));
        if (!matchNumber && !matchNotes && !matchProduct && !matchStaff) return false;
      }
      return true;
    });
  }, [sales, saleItemsBySaleId, searchTerm, filterFrom, filterTo, filterPayment, filterStaffId, filterProductId]);

  return (
    <div className="space-y-4">
      {/* Daily / Monthly / Yearly Sales Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 sm:gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Daily Sales (Today)</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
            {formatPKR(salesTotals.daily)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Monthly Sales</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
            {formatPKR(salesTotals.monthly)}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1 bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Yearly Sales</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
            {formatPKR(salesTotals.yearly)}
          </div>
        </div>
      </div>

      {/* Compact Manual Sales Entry Form */}
      <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm sm:text-base font-semibold text-slate-900">Manual Sales Entry</h2>
            <p className="text-[11px] sm:text-xs text-slate-500">
              Search or speak product names to add quickly; tap any row to edit quantity or price.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allowStockOverride}
                onChange={(e) => setAllowStockOverride(e.target.checked)}
                className="rounded border-slate-300 text-teal-600 focus:ring-teal-600"
              />
              <span>Stock override</span>
            </label>
            {draftTotals.itemCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setRows([]);
                  setExpandedRowKey(null);
                  setQuickAddFeedback(null);
                  setFormError(null);
                }}
                className="text-xs font-medium text-slate-500 hover:text-red-600 cursor-pointer"
              >
                Clear All ({formatNumber(draftTotals.itemCount)})
              </button>
            )}
          </div>
        </div>

        {formError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-700">
            {formError}
          </div>
        )}
        {formSuccess && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs sm:text-sm text-emerald-700 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{formSuccess}</span>
          </div>
        )}

        <form onSubmit={handleSaveSale} className="space-y-4">
          {/* Compact Sale Metadata */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 sm:gap-3">
            <div>
              <label htmlFor="sale-date" className="block text-[11px] font-medium text-slate-600 mb-1">
                Sale Date
              </label>
              <input
                id="sale-date"
                type="date"
                required
                value={saleDate}
                onChange={(e) => setSaleDate(e.target.value)}
                className="w-full min-h-[42px] px-2.5 py-1.5 text-xs sm:text-sm border border-slate-200 rounded-lg font-mono-num focus:outline-none focus:border-teal-600"
              />
            </div>

            <div>
              <span className="block text-[11px] font-medium text-slate-600 mb-1">
                Payment
              </span>
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 min-h-[42px]">
                {(['Cash', 'Online'] as PaymentMethod[]).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setPaymentMethod(method)}
                    className={`text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      paymentMethod === method
                        ? 'bg-white text-teal-700 border border-slate-200 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {method}
                  </button>
                ))}
              </div>
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label htmlFor="sale-notes" className="block text-[11px] font-medium text-slate-600 mb-1">
                Notes (Optional)
              </label>
              <input
                id="sale-notes"
                type="text"
                maxLength={500}
                placeholder="Customer or reference note"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
              />
            </div>
          </div>

          {/* Searchable Quick Product Picker */}
          <div className="p-3 bg-teal-50/40 border border-teal-200/80 rounded-xl space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="quick-add-product-search"
                className="block text-xs font-semibold text-slate-800"
              >
                Quick Add Product
              </label>
              <span className="text-[11px] text-slate-500">Auto-clears after adding</span>
            </div>
            <SearchableProductSelector
              inputId="quick-add-product-search"
              mode="quick-add"
              items={searchableItems}
              allowOutOfStock={allowStockOverride}
              enableVoiceSearch={true}
              onSelect={handleQuickAddProduct}
              onRefreshCatalog={handleRefreshCatalog}
            />
            {quickAddFeedback && (
              <div
                role="status"
                className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 pt-0.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="truncate">{quickAddFeedback}</span>
              </div>
            )}
          </div>

          {/* Compact Collapsible Products List */}
          <CompactSaleItemsList
            items={compactSaleItems}
            expandedKey={expandedRowKey}
            onToggleExpand={(key) => setExpandedRowKey((cur) => (cur === key ? null : key))}
            onStepQuantity={(key, delta) => stepRowQuantity('create', key, delta)}
            onChangeQuantity={(key, val) => updateRowField(key, 'quantity', val)}
            onOpenKeypad={(key) => setKeypadTarget({ scope: 'create', rowKey: key })}
            onChangePrice={(key, val) => updateRowField(key, 'salePricePerUnit', val)}
            onRemove={removeRow}
            priceEditable={true}
            allowStockOverride={allowStockOverride}
            showProfit={true}
            lastHighlightedKey={lastHighlightedKey}
          />

          {/* Sticky Bottom Sale Summary & Save Bar */}
          <div className="sticky bottom-2 z-20 bg-white/95 backdrop-blur-md border border-slate-200 rounded-xl shadow-md px-3.5 py-2.5 sm:px-4 flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-4 sm:gap-6">
              <div className="min-w-0">
                <div className="text-[11px] text-slate-500 font-mono-num tabular-nums leading-tight">
                  {formatNumber(draftTotals.itemCount)}{' '}
                  {draftTotals.itemCount === 1 ? 'product' : 'products'}
                  <span className="hidden sm:inline">
                    {' '}· {formatNumber(draftTotals.totalUnits)} qty
                  </span>
                </div>
                <div className="text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 leading-tight truncate">
                  {formatPKR(draftTotals.totalAmount)}
                </div>
              </div>

              <div className="hidden sm:block border-l border-slate-200 pl-4">
                <div className="text-[11px] text-slate-500 leading-tight">Est. Profit</div>
                <div
                  className={`text-sm font-bold font-mono-num tabular-nums leading-tight ${
                    draftTotals.estimatedProfit >= 0 ? 'text-emerald-700' : 'text-red-600'
                  }`}
                >
                  {formatPKR(draftTotals.estimatedProfit)}
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || products.length === 0}
              className="min-h-[44px] px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 active:scale-[0.98] disabled:opacity-50 rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer"
            >
              {submitting ? 'Saving Sale...' : 'Save Sale'}
            </button>
          </div>
        </form>
      </section>

      {/* Complete Sales History */}
      <CompactSection
        title="Sales History"
        summary={`${formatNumber(filteredSales.length)} records`}
        collapsible={true}
        defaultOpen={true}
        actions={
          <button
            type="button"
            onClick={() => setShowMobileFilters((v) => !v)}
            className="lg:hidden inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
          >
            <Filter className="w-3.5 h-3.5" />
            <span>{showMobileFilters ? 'Hide Filters' : 'Filters'}</span>
          </button>
        }
      >
        <div className="p-3 sm:p-4 border-b border-slate-200 space-y-2.5">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search sale #, staff, or product..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
            />
          </div>

          <div
            className={`${
              showMobileFilters ? 'grid' : 'hidden lg:grid'
            } grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2`}
          >
            <input
              type="date"
              aria-label="Filter from date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              className="w-full min-h-[38px] px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg font-mono-num"
            />
            <input
              type="date"
              aria-label="Filter to date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              className="w-full min-h-[38px] px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg font-mono-num"
            />
            <div className="col-span-2 sm:col-span-1">
              <SearchableSelect
                options={historyProductOptions}
                value={filterProductId}
                onChange={setFilterProductId}
                emptyOptionLabel="All Products"
                placeholder="All Products"
                searchPlaceholder="Search product..."
                ariaLabel="Filter by product"
                suggestionScope="product"
                suggestedValues={frequentHistoryProductIds}
                size="sm"
              />
            </div>
            <div>
              <SearchableSelect
                options={historyPaymentOptions}
                value={filterPayment}
                onChange={(val) => setFilterPayment(val as '' | PaymentMethod)}
                emptyOptionLabel="All Payments"
                placeholder="All Payments"
                searchPlaceholder="Search payment..."
                ariaLabel="Filter by payment method"
                showFrequentSection={false}
                size="sm"
              />
            </div>
            <div>
              <SearchableSelect
                options={historyStaffOptions}
                value={filterStaffId}
                onChange={setFilterStaffId}
                emptyOptionLabel="All Staff / Owner"
                placeholder="All Staff / Owner"
                searchPlaceholder="Search staff..."
                ariaLabel="Filter by staff member"
                suggestionScope="staff"
                suggestedValues={frequentHistoryStaffIds}
                size="sm"
              />
            </div>
          </div>
        </div>

        {filteredSales.length === 0 ? (
          <div className="p-6 text-center text-xs sm:text-sm text-slate-500">
            No sales records match your filters. Use the Manual Sales Entry form above to record your first sale.
          </div>
        ) : (
          <>
            {/* Mobile Compact Expandable List */}
            <div className="md:hidden divide-y divide-slate-100">
              {filteredSales.map((sale) => {
                const items = saleItemsBySaleId.get(sale.id) || [];
                const isCancelled = sale.status === 'cancelled';
                return (
                  <CompactExpandableRow
                    key={sale.id}
                    dimmed={isCancelled}
                    title={
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="font-mono-num">{sale.saleNumber}</span>
                        <span className="text-slate-400">·</span>
                        <span className="truncate font-normal text-slate-600">
                          {items[0]?.productName || `${sale.itemCount} items`}
                          {items.length > 1 ? ` +${items.length - 1}` : ''}
                        </span>
                      </span>
                    }
                    subtitle={`${sale.saleDateTime || formatDateDDMMYYYY(sale.saleDate)} · ${sale.paymentMethod} · ${sale.totalQuantity} qty`}
                    rightPrimary={formatPKR(sale.totalAmount)}
                    rightSecondary={
                      isCancelled ? (
                        <span className="text-red-600">Cancelled</span>
                      ) : (
                        <span className={sale.totalProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                          +{formatPKR(sale.totalProfit)}
                        </span>
                      )
                    }
                    isExpanded={expandedHistoryId === sale.id}
                    onToggle={() =>
                      setExpandedHistoryId((cur) => (cur === sale.id ? null : sale.id))
                    }
                    expandedContent={
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
                          <span>Recorded by: <strong>{sale.staffName || 'Owner'}</strong></span>
                          <span className={isCancelled ? 'text-red-600 font-semibold' : 'text-emerald-700 font-semibold'}>
                            {isCancelled ? 'Cancelled' : 'Completed'}
                          </span>
                        </div>
                        <div className="space-y-1 bg-white border border-slate-200 rounded-lg p-2">
                          {items.map((item) => (
                            <div
                              key={item.id}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <span className="truncate text-slate-800">
                                {item.productName}{' '}
                                <span className="text-slate-500 font-mono-num">×{item.quantity}</span>
                              </span>
                              <span className="font-mono-num font-semibold text-slate-900 shrink-0">
                                {formatPKR(item.lineTotal)}
                              </span>
                            </div>
                          ))}
                        </div>
                        {sale.notes && (
                          <p className="text-[11px] text-slate-500">Note: {sale.notes}</p>
                        )}
                        {!isCancelled && (
                          <div className="flex items-center justify-end gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => openEditModal(sale)}
                              className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleCancelSale(sale)}
                              className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              <Ban className="w-3.5 h-3.5" />
                              <span>Cancel Sale</span>
                            </button>
                          </div>
                        )}
                      </div>
                    }
                  />
                );
              })}
            </div>

            {/* Desktop Dense Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-3">Date & Time</th>
                    <th className="py-2.5 px-3">Sale #</th>
                    <th className="py-2.5 px-3">Recorded By</th>
                    <th className="py-2.5 px-3">Products</th>
                    <th className="py-2.5 px-3">Payment</th>
                    <th className="py-2.5 px-3 text-right">Qty</th>
                    <th className="py-2.5 px-3 text-right">Total</th>
                    <th className="py-2.5 px-3 text-right">Profit</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {filteredSales.map((sale) => {
                    const items = saleItemsBySaleId.get(sale.id) || [];
                    const summaryText = items.map((i) => `${i.productName} ×${i.quantity}`).join(', ');
                    const isCancelled = sale.status === 'cancelled';

                    return (
                      <tr key={sale.id} className={`hover:bg-slate-50 ${isCancelled ? 'opacity-60' : ''}`}>
                        <td className="py-2 px-3 font-mono-num text-xs whitespace-nowrap text-slate-700">
                          {sale.saleDateTime || formatDateDDMMYYYY(sale.saleDate)}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-xs font-medium text-slate-900 whitespace-nowrap">
                          {sale.saleNumber}
                        </td>
                        <td className="py-2 px-3 text-xs font-medium text-slate-700 whitespace-nowrap">
                          {sale.staffName || 'Owner'}
                        </td>
                        <td className="py-2 px-3 text-slate-700 max-w-xs truncate" title={summaryText}>
                          {summaryText || `${sale.itemCount} items`}
                        </td>
                        <td className="py-2 px-3 text-xs text-slate-600">{sale.paymentMethod}</td>
                        <td className="py-2 px-3 text-right font-mono-num">{sale.totalQuantity}</td>
                        <td className="py-2 px-3 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                          {formatPKR(sale.totalAmount)}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono-num font-semibold whitespace-nowrap ${
                            sale.totalProfit >= 0 ? 'text-emerald-700' : 'text-red-600'
                          }`}
                        >
                          {formatPKR(sale.totalProfit)}
                        </td>
                        <td className="py-2 px-3 text-xs font-semibold">
                          <span className={isCancelled ? 'text-red-600' : 'text-emerald-700'}>
                            {isCancelled ? 'Cancelled' : 'Completed'}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          {!isCancelled && (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openEditModal(sale)}
                                className="p-1.5 text-slate-500 hover:text-teal-700 rounded cursor-pointer"
                                title="Edit sale"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleCancelSale(sale)}
                                className="p-1.5 text-slate-500 hover:text-red-600 rounded cursor-pointer"
                                title="Cancel sale and restore stock"
                              >
                                <Ban className="w-4 h-4" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CompactSection>

      {/* Edit Sale Modal */}
      {editingSale && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-t-2xl sm:rounded-xl w-full max-w-2xl max-h-[92vh] flex flex-col">
            <div className="px-4 py-3 sm:px-5 border-b border-slate-200 flex items-center justify-between shrink-0">
              <h3 className="text-sm sm:text-base font-semibold text-slate-900">
                Edit Sale {editingSale.saleNumber}
              </h3>
              <button
                type="button"
                onClick={() => setEditingSale(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="flex flex-col min-h-0 flex-1">
              <div className="p-4 sm:p-5 space-y-3.5 overflow-y-auto flex-1">
                {editError && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-700">
                    {editError}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Sale Date</label>
                    <input
                      type="date"
                      required
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="w-full min-h-[40px] px-2.5 py-1.5 text-xs sm:text-sm border border-slate-200 rounded-lg font-mono-num"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Payment Method</label>
                    <select
                      value={editPayment}
                      onChange={(e) => setEditPayment(e.target.value as PaymentMethod)}
                      className="w-full min-h-[40px] px-2.5 py-1.5 text-xs sm:text-sm border border-slate-200 rounded-lg bg-white"
                    >
                      <option value="Cash">Cash</option>
                      <option value="Online">Online</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
                  <input
                    type="text"
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-700">Line Items</span>
                    <button
                      type="button"
                      onClick={() =>
                        setEditRows((prev) => [
                          ...prev,
                          { key: `edit-${Date.now()}`, productId: '', quantity: '1', salePricePerUnit: '0' },
                        ])
                      }
                      className="text-xs font-semibold text-teal-700 cursor-pointer"
                    >
                      + Add Product
                    </button>
                  </div>
                  {editRows.map((row) => (
                    <div
                      key={row.key}
                      className="grid grid-cols-12 gap-2 items-center p-2 bg-slate-50 border border-slate-200 rounded-lg"
                    >
                      <div className="col-span-12 sm:col-span-6">
                        <SearchableProductSelector
                          mode="inline"
                          items={searchableItems}
                          selectedProductId={row.productId}
                          allowOutOfStock={allowStockOverride}
                          onSelect={(item) => {
                            setEditRows((prev) =>
                              prev.map((r) =>
                                r.key === row.key
                                  ? {
                                      ...r,
                                      productId: item.id,
                                      salePricePerUnit: String(item.salePrice),
                                    }
                                  : r
                              )
                            );
                          }}
                          onRefreshCatalog={handleRefreshCatalog}
                        />
                      </div>
                      <div className="col-span-5 sm:col-span-2">
                        <button
                          type="button"
                          onClick={() => setKeypadTarget({ scope: 'edit', rowKey: row.key })}
                          aria-label="Open numeric keypad for edit quantity"
                          className="w-full min-h-[40px] px-2.5 py-1.5 text-sm border border-slate-200 hover:border-teal-500 rounded-lg bg-white font-mono-num tabular-nums flex items-center justify-between gap-1 cursor-pointer"
                        >
                          <span>{row.quantity || '1'}</span>
                          <Grid3X3 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        </button>
                      </div>
                      <div className="col-span-5 sm:col-span-3">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={row.salePricePerUnit}
                          onChange={(e) =>
                            setEditRows((prev) =>
                              prev.map((r) =>
                                r.key === row.key ? { ...r, salePricePerUnit: e.target.value } : r
                              )
                            )
                          }
                          className="w-full min-h-[40px] px-2.5 py-1.5 text-sm bg-white border border-slate-200 rounded-lg font-mono-num"
                        />
                      </div>
                      <div className="col-span-2 sm:col-span-1 text-right">
                        <button
                          type="button"
                          disabled={editRows.length === 1}
                          onClick={() => setEditRows((prev) => prev.filter((r) => r.key !== row.key))}
                          className="p-2 text-slate-400 hover:text-red-600 disabled:opacity-40 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="px-4 py-3 sm:px-5 border-t border-slate-200 bg-white flex justify-end gap-2 shrink-0 rounded-b-xl">
                <button
                  type="button"
                  onClick={() => setEditingSale(null)}
                  className="min-h-[42px] px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg disabled:opacity-50 cursor-pointer"
                >
                  {savingEdit ? 'Updating...' : 'Update Sale'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Custom Numeric Keypad Overlay for Quantity Entry */}
      {(() => {
        if (!keypadTarget) return null;
        const targetList = keypadTarget.scope === 'create' ? rows : editRows;
        const targetRow = targetList.find((r) => r.key === keypadTarget.rowKey);
        if (!targetRow) return null;
        const prod = productMap.get(targetRow.productId);
        const existingSavedQty =
          keypadTarget.scope === 'edit' && editingSale
            ? (saleItemsBySaleId.get(editingSale.id) || []).find(
                (i) => i.productId === targetRow.productId
              )?.quantity ?? 0
            : 0;
        const maxAvailable = prod
          ? prod.currentStock + existingSavedQty
          : undefined;

        return (
          <NumericKeypadOverlay
            open={true}
            productName={prod?.name || 'Quantity'}
            unit={prod?.unit || 'Unit'}
            availableStock={maxAvailable}
            unitPrice={Number(targetRow.salePricePerUnit) || 0}
            initialQuantity={Math.max(1, Math.floor(Number(targetRow.quantity) || 1))}
            allowStockOverride={allowStockOverride}
            onConfirm={(nextQty) => {
              if (keypadTarget.scope === 'create') {
                updateRowField(keypadTarget.rowKey, 'quantity', String(nextQty));
              } else {
                setEditRows((prev) =>
                  prev.map((r) =>
                    r.key === keypadTarget.rowKey ? { ...r, quantity: String(nextQty) } : r
                  )
                );
              }
              setKeypadTarget(null);
            }}
            onClose={() => setKeypadTarget(null)}
          />
        );
      })()}
    </div>
  );
}
