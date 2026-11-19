import { CheckCircle2, Filter, RefreshCw, Search, ShoppingBag } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CompactSaleItemsList, type CompactSaleRowItem } from '../components/CompactSaleItemsList';
import { CompactExpandableRow } from '../components/CompactSection';
import { NumericKeypadOverlay } from '../components/NumericKeypadOverlay';
import { SearchableProductSelector } from '../components/SearchableProductSelector';
import { SearchableSelect, type SearchableSelectOption } from '../components/SearchableSelect';
import { useAuth } from '../contexts/AuthContext';
import { useOfflineSync } from '../contexts/OfflineSyncContext';
import { useToast } from '../contexts/ToastContext';
import { isNetworkOrOfflineError } from '../services/offlineSyncService';
import {
  mapStaffCatalogToSearchable,
  queryProductsFromDatabase,
  type SearchableProductItem,
} from '../services/productSearchService';
import { createStaffSale } from '../services/staffService';
import type { PaymentMethod, StaffPortalSection } from '../types/shop';
import {
  addDaysToIso,
  formatDateDDMMYYYY,
  formatMonthLabel,
  formatNumber,
  formatPKR,
  getKarachiDateIso,
  getMonthKey,
  roundMoney,
} from '../utils/formatters';

interface StaffPortalViewProps {
  activeSection: StaffPortalSection;
  onNavigate: (section: StaffPortalSection) => void;
}

interface StaffSaleRow {
  key: string;
  productId: string;
  quantity: string;
}

export function StaffPortalView({ activeSection, onNavigate }: StaffPortalViewProps) {
  const { user, shopId, staffProfile } = useAuth();
  const {
    isOnline,
    pendingSales,
    pendingCount,
    isSyncing,
    effectiveCatalog,
    mergedStaffSales,
    queueOfflineSale,
    syncNow,
    retryQueuedSale,
    discardQueuedSale,
  } = useOfflineSync();
  const { showToast } = useToast();

  const todayIso = getKarachiDateIso();
  const currentMonth = getMonthKey(todayIso);

  // New Sale Form State
  const [saleDate, setSaleDate] = useState(todayIso);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<StaffSaleRow[]>([]);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [lastHighlightedKey, setLastHighlightedKey] = useState<string | null>(null);
  const [quickAddFeedback, setQuickAddFeedback] = useState<string | null>(null);
  const quickFeedbackTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [saleSuccess, setSaleSuccess] = useState<string | null>(null);
  const [keypadRowKey, setKeypadRowKey] = useState<string | null>(null);
  const [dbFallbackCatalog, setDbFallbackCatalog] = useState<SearchableProductItem[] | null>(null);

  // Own Sales Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterPayment, setFilterPayment] = useState<'' | PaymentMethod>('');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null);

  // Stock Search
  const [stockSearch, setStockSearch] = useState('');
  const [expandedStockId, setExpandedStockId] = useState<string | null>(null);

  const catalogMap = useMemo(
    () => new Map(effectiveCatalog.map((c) => [c.productId, c])),
    [effectiveCatalog]
  );

  const activeCatalog = useMemo(
    () => effectiveCatalog.filter((c) => c.isActive),
    [effectiveCatalog]
  );

  const searchableStaffItems = useMemo(() => {
    if (activeCatalog.length > 0) {
      return mapStaffCatalogToSearchable(activeCatalog);
    }
    return dbFallbackCatalog || [];
  }, [activeCatalog, dbFallbackCatalog]);

  const handleRefreshStaffCatalog = async () => {
    if (!shopId || !user || !isOnline) return;
    try {
      const fetched = await queryProductsFromDatabase({
        shopId,
        role: 'sales_staff',
        authUid: user.uid,
        maxDocs: 1000,
      });
      setDbFallbackCatalog(fetched);
    } catch {
      // Keep cached catalog on transient offline error
    }
  };

  const completedOwnSales = useMemo(
    () => mergedStaffSales.filter((s) => s.status !== 'cancelled'),
    [mergedStaffSales]
  );

  // Own Sales KPIs (zero profit/cost/business expense numbers)
  const ownStats = useMemo(() => {
    let todayTotal = 0;
    let todayCount = 0;
    let monthTotal = 0;
    let monthCount = 0;
    let allTotal = 0;
    let cashTotal = 0;
    let onlineTotal = 0;

    for (const s of completedOwnSales) {
      allTotal = roundMoney(allTotal + s.totalAmount);
      if (s.paymentMethod === 'Cash') cashTotal = roundMoney(cashTotal + s.totalAmount);
      if (s.paymentMethod === 'Online') onlineTotal = roundMoney(onlineTotal + s.totalAmount);

      if (s.saleDate === todayIso) {
        todayTotal = roundMoney(todayTotal + s.totalAmount);
        todayCount += 1;
      }
      if (getMonthKey(s.saleDate) === currentMonth) {
        monthTotal = roundMoney(monthTotal + s.totalAmount);
        monthCount += 1;
      }
    }

    return {
      todayTotal,
      todayCount,
      monthTotal,
      monthCount,
      allTotal,
      allCount: completedOwnSales.length,
      cashTotal,
      onlineTotal,
    };
  }, [completedOwnSales, todayIso, currentMonth]);

  // Last 14 Days Own Sales Chart
  const dailyChartData = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 13; i >= 0; i -= 1) {
      map.set(addDaysToIso(todayIso, -i), 0);
    }
    for (const s of completedOwnSales) {
      if (map.has(s.saleDate)) {
        map.set(s.saleDate, roundMoney((map.get(s.saleDate) || 0) + s.totalAmount));
      }
    }
    return Array.from(map.entries()).map(([iso, total]) => ({
      date: formatDateDDMMYYYY(iso).slice(0, 5),
      fullDate: formatDateDDMMYYYY(iso),
      total,
    }));
  }, [completedOwnSales, todayIso]);

  // Last 6 Months Own Sales Chart
  const monthlyChartData = useMemo(() => {
    const [yearStr, monthStr] = currentMonth.split('-');
    const y = Number(yearStr);
    const m = Number(monthStr);
    const months: string[] = [];
    for (let offset = 5; offset >= 0; offset -= 1) {
      const dt = new Date(Date.UTC(y, m - 1 - offset, 1));
      const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
      months.push(key);
    }
    const map = new Map<string, number>(months.map((k) => [k, 0]));
    for (const s of completedOwnSales) {
      const mk = getMonthKey(s.saleDate);
      if (map.has(mk)) {
        map.set(mk, roundMoney((map.get(mk) || 0) + s.totalAmount));
      }
    }
    return months.map((mk) => ({
      month: formatMonthLabel(mk),
      total: map.get(mk) || 0,
    }));
  }, [completedOwnSales, currentMonth]);

  const draftSummary = useMemo(() => {
    let totalAmount = 0;
    let totalUnits = 0;
    let itemCount = 0;
    for (const r of rows) {
      const prod = catalogMap.get(r.productId);
      const qty = Math.max(0, Number(r.quantity) || 0);
      if (prod) {
        itemCount += 1;
        totalUnits += qty;
        if (qty > 0) {
          totalAmount = roundMoney(totalAmount + qty * prod.salePrice);
        }
      }
    }
    return { totalAmount, totalUnits, itemCount };
  }, [rows, catalogMap]);

  const compactSaleItems = useMemo<CompactSaleRowItem[]>(() => {
    return rows.reduce<CompactSaleRowItem[]>((acc, r) => {
      const prod = catalogMap.get(r.productId);
      if (prod) {
        acc.push({
          key: r.key,
          productId: r.productId,
          name: prod.name,
          brandName: prod.brandName,
          unit: prod.unit,
          currentStock: prod.currentStock,
          quantity: r.quantity,
          salePricePerUnit: String(prod.salePrice),
        });
      }
      return acc;
    }, []);
  }, [rows, catalogMap]);

  const filteredOwnSales = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return mergedStaffSales.filter((s) => {
      if (filterFrom && s.saleDate < filterFrom) return false;
      if (filterTo && s.saleDate > filterTo) return false;
      if (filterPayment && s.paymentMethod !== filterPayment) return false;
      if (q) {
        const matchNum = s.saleNumber.toLowerCase().includes(q);
        const matchNotes = s.notes.toLowerCase().includes(q);
        const matchProd = s.items.some((i) => i.productName.toLowerCase().includes(q));
        if (!matchNum && !matchNotes && !matchProd) return false;
      }
      return true;
    });
  }, [mergedStaffSales, searchTerm, filterFrom, filterTo, filterPayment]);

  const filteredCatalog = useMemo(() => {
    const q = stockSearch.trim().toLowerCase();
    return activeCatalog.filter((c) => {
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.categoryName.toLowerCase().includes(q) ||
        c.brandName.toLowerCase().includes(q)
      );
    });
  }, [activeCatalog, stockSearch]);

  const triggerAddedConfirmation = (rowKey: string, item: SearchableProductItem, qty: number) => {
    const label = `${item.name} (×${formatNumber(qty)} · ${formatPKR(qty * item.salePrice)})`;
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

  const handleQuickAddStaffProduct = (item: SearchableProductItem) => {
    setSaleError(null);
    setSaleSuccess(null);

    const existing = rows.find((r) => r.productId === item.id);
    if (existing) {
      const currentQty = Math.max(1, Math.floor(Number(existing.quantity) || 1));
      const nextQty = currentQty + 1;
      if (nextQty > item.currentStock) {
        setSaleError(
          `Cannot exceed available stock for "${item.name}" (${formatNumber(item.currentStock)} ${item.unit}).`
        );
        return;
      }
      setRows((prev) => {
        const updated = { ...existing, quantity: String(nextQty) };
        return [updated, ...prev.filter((r) => r.key !== existing.key)];
      });
      triggerAddedConfirmation(existing.key, item, nextQty);
      return;
    }

    const newKey = `staff-row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setRows((prev) => [
      { key: newKey, productId: item.id, quantity: '1' },
      ...prev.filter((r) => Boolean(r.productId)),
    ]);
    triggerAddedConfirmation(newKey, item, 1);
  };

  const stepStaffRowQuantity = (key: string, delta: number) => {
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    const prod = catalogMap.get(row.productId);
    const cur = Math.max(1, Math.floor(Number(row.quantity) || 1));
    const next = Math.max(1, cur + delta);
    if (prod && next > prod.currentStock) {
      setSaleError(
        `Cannot exceed available stock for "${prod.name}" (${formatNumber(prod.currentStock)} ${prod.unit}).`
      );
      return;
    }
    setSaleError(null);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, quantity: String(next) } : r)));
  };

  const changeStaffRowQuantity = (key: string, value: string) => {
    setSaleError(null);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, quantity: value } : r)));
  };

  const handleSaveStaffSale = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shopId || !staffProfile) return;
    setSaleError(null);
    setSaleSuccess(null);

    const activeRows = rows.filter((r) => r.productId);
    if (activeRows.length === 0) {
      setSaleError('Search and select at least one product to record a sale.');
      return;
    }

    const qtyByProduct = new Map<string, number>();
    const items: Array<{ productId: string; quantity: number }> = [];
    for (const r of activeRows) {
      const prod = catalogMap.get(r.productId);
      if (!prod) {
        setSaleError('Selected product was not found in the catalog.');
        return;
      }
      const qty = Math.floor(Number(r.quantity));
      if (!Number.isFinite(qty) || qty <= 0) {
        setSaleError(`Quantity for "${prod.name}" must be greater than zero.`);
        return;
      }
      const cumulativeQty = (qtyByProduct.get(r.productId) || 0) + qty;
      qtyByProduct.set(r.productId, cumulativeQty);
      if (cumulativeQty > prod.currentStock) {
        setSaleError(
          `Insufficient stock for "${prod.name}". Available: ${formatNumber(prod.currentStock)} ${prod.unit}, Requested: ${formatNumber(cumulativeQty)}.`
        );
        return;
      }
      items.push({ productId: r.productId, quantity: qty });
    }

    setSubmitting(true);
    try {
      if (!isOnline) {
        const queued = queueOfflineSale(catalogMap, {
          saleDate,
          paymentMethod,
          notes,
          items,
        });
        setNotes('');
        setRows([]);
        setExpandedRowKey(null);
        setQuickAddFeedback(null);
        setSaleSuccess(
          `Saved offline (${queued.saleNumber}) and updated local stock. Will sync automatically when internet returns.`
        );
        return;
      }

      try {
        await createStaffSale(shopId, staffProfile, {
          saleDate,
          paymentMethod,
          notes,
          items,
        });
        setNotes('');
        setRows([]);
        setExpandedRowKey(null);
        setQuickAddFeedback(null);
        setSaleSuccess('Sale recorded and stock updated.');
      } catch (onlineErr) {
        if (isNetworkOrOfflineError(onlineErr)) {
          const queued = queueOfflineSale(catalogMap, {
            saleDate,
            paymentMethod,
            notes,
            items,
          });
          setNotes('');
          setRows([]);
          setExpandedRowKey(null);
          setQuickAddFeedback(null);
          setSaleSuccess(
            `Connection dropped — sale saved locally (${queued.saleNumber}) and will auto-sync when back online.`
          );
          return;
        }
        throw onlineErr;
      }
    } catch (err) {
      setSaleError(err instanceof Error ? err.message : 'Failed to save sale.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!staffProfile) return null;

  // 1. Staff Dashboard (Own Sales Statistics Only)
  if (activeSection === 'dashboard') {
    return (
      <div className="space-y-4">
        <div className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-sm sm:text-base font-semibold text-slate-900">
              Welcome, {staffProfile.name}
            </h2>
            <p className="text-[11px] sm:text-xs text-slate-500">
              Personal sales summary for @{staffProfile.username} · Today ({formatDateDDMMYYYY(todayIso)})
            </p>
          </div>
          {staffProfile.permissions.canAddSales && (
            <button
              type="button"
              onClick={() => onNavigate('new_sale')}
              className="w-full sm:w-auto min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors cursor-pointer"
            >
              <ShoppingBag className="w-4 h-4" />
              <span>Add New Sale</span>
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="text-[11px] font-medium text-slate-500">My Today&apos;s Sales</div>
            <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
              {formatPKR(ownStats.todayTotal)}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500 font-mono-num">
              {ownStats.todayCount} bills today
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="text-[11px] font-medium text-slate-500">My Monthly Sales</div>
            <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
              {formatPKR(ownStats.monthTotal)}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500 font-mono-num">
              {ownStats.monthCount} bills this month
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="text-[11px] font-medium text-slate-500">My Total Sales</div>
            <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
              {formatPKR(ownStats.allTotal)}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500 font-mono-num">
              {ownStats.allCount} completed
              {pendingCount > 0 ? ` (${pendingCount} sync)` : ''}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="text-[11px] font-medium text-slate-500">Cash vs Online</div>
            <div className="mt-0.5 text-xs sm:text-sm font-bold font-mono-num tabular-nums text-slate-900 truncate">
              Cash: {formatPKR(ownStats.cashTotal)}
            </div>
            <div className="mt-0.5 text-xs sm:text-sm font-semibold font-mono-num tabular-nums text-teal-700 truncate">
              Online: {formatPKR(ownStats.onlineTotal)}
            </div>
          </div>
        </div>

        {staffProfile.permissions.canViewOwnSales && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  My Daily Sales (Last 14 Days)
                </h3>
                <p className="text-[11px] text-slate-500">Daily sales total in PKR</p>
              </div>
              <div className="h-52 sm:h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyChartData} margin={{ top: 6, right: 6, left: -12, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748B' }} />
                    <YAxis tick={{ fontSize: 10, fill: '#64748B' }} />
                    <Tooltip
                      formatter={(val) => [formatPKR(Number(val ?? 0)), 'Sales']}
                      labelFormatter={(_, payload) =>
                        payload?.[0]?.payload?.fullDate ? String(payload[0].payload.fullDate) : ''
                      }
                    />
                    <Bar dataKey="total" fill="#0D9488" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  My Monthly Sales (Last 6 Months)
                </h3>
                <p className="text-[11px] text-slate-500">Monthly revenue in PKR</p>
              </div>
              <div className="h-52 sm:h-60">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyChartData} margin={{ top: 6, right: 6, left: -12, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#64748B' }} />
                    <YAxis tick={{ fontSize: 10, fill: '#64748B' }} />
                    <Tooltip formatter={(val) => [formatPKR(Number(val ?? 0)), 'Monthly Sales']} />
                    <Bar dataKey="total" fill="#0F766E" radius={[4, 4, 0, 0]} maxBarSize={38} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>
        )}
      </div>
    );
  }

  // 2. Add New Sale (Selling prices read-only from catalog, no cost/profit)
  if (activeSection === 'new_sale') {
    if (!staffProfile.permissions.canAddSales) {
      return (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
          <h2 className="text-base font-semibold text-slate-900">Sales Entry Restricted</h2>
          <p className="text-sm text-slate-600">
            Your account does not currently have permission to add new sales. Contact your shop owner.
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-4 pb-24">
        <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900">New Sales Entry</h2>
              <p className="text-xs text-slate-500">
                Staff: {staffProfile.name} · Selling prices fixed by owner
              </p>
            </div>
            {draftSummary.itemCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setRows([]);
                  setExpandedRowKey(null);
                  setQuickAddFeedback(null);
                  setSaleError(null);
                }}
                className="text-xs font-medium text-slate-500 hover:text-red-600 cursor-pointer"
              >
                Clear All ({formatNumber(draftSummary.itemCount)})
              </button>
            )}
          </div>

          {saleError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-700">
              {saleError}
            </div>
          )}
          {saleSuccess && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs sm:text-sm text-emerald-700 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{saleSuccess}</span>
            </div>
          )}

          <form id="staff-new-sale-form" onSubmit={handleSaveStaffSale} className="space-y-4">
            {/* Compact Sale Metadata */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 sm:gap-3">
              <div>
                <label htmlFor="staff-sale-date" className="block text-[11px] font-medium text-slate-600 mb-1">
                  Sale Date
                </label>
                <input
                  id="staff-sale-date"
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
                <label htmlFor="staff-sale-notes" className="block text-[11px] font-medium text-slate-600 mb-1">
                  Notes (Optional)
                </label>
                <input
                  id="staff-sale-notes"
                  type="text"
                  maxLength={500}
                  placeholder="Customer or reference note"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
                />
              </div>
            </div>

            {/* Fast Search & Quick Add Box */}
            <div className="p-3 bg-teal-50/40 border border-teal-200/80 rounded-xl space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="staff-quick-add-product-search"
                  className="block text-xs font-semibold text-slate-800"
                >
                  Quick Add Product
                </label>
                <span className="text-[11px] text-slate-500">
                  Auto-clears after adding
                </span>
              </div>
              <SearchableProductSelector
                inputId="staff-quick-add-product-search"
                mode="quick-add"
                items={searchableStaffItems}
                allowOutOfStock={false}
                enableVoiceSearch={true}
                onSelect={handleQuickAddStaffProduct}
                onRefreshCatalog={handleRefreshStaffCatalog}
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
              onStepQuantity={stepStaffRowQuantity}
              onChangeQuantity={changeStaffRowQuantity}
              onOpenKeypad={(key) => setKeypadRowKey(key)}
              onRemove={removeRow}
              priceEditable={false}
              allowStockOverride={false}
              showProfit={false}
              lastHighlightedKey={lastHighlightedKey}
            />
          </form>
        </section>

        {/* Sticky Bottom Sale Summary & Save Bar */}
        <div className="fixed bottom-0 left-0 right-0 lg:left-64 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200 shadow-[0_-4px_16px_rgba(15,23,42,0.06)] px-4 py-2.5 sm:px-6">
          <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-3 sm:gap-5">
              <div className="min-w-0">
                <div className="text-[11px] text-slate-500 font-mono-num tabular-nums leading-tight">
                  {formatNumber(draftSummary.itemCount)}{' '}
                  {draftSummary.itemCount === 1 ? 'product' : 'products'}
                  <span className="hidden sm:inline">
                    {' '}· {formatNumber(draftSummary.totalUnits)} qty
                  </span>
                </div>
                <div className="text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 leading-tight truncate">
                  {formatPKR(draftSummary.totalAmount)}
                </div>
              </div>
            </div>

            <button
              type="submit"
              form="staff-new-sale-form"
              disabled={submitting || activeCatalog.length === 0}
              className="min-h-[44px] px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 active:scale-[0.98] disabled:opacity-50 rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer"
            >
              {submitting ? 'Saving...' : isOnline ? 'Save Sale' : 'Save Offline'}
            </button>
          </div>
        </div>

        {/* Custom Numeric Keypad Overlay for Staff Quantity Entry */}
        {(() => {
          if (!keypadRowKey) return null;
          const targetRow = rows.find((r) => r.key === keypadRowKey);
          if (!targetRow) return null;
          const selected = catalogMap.get(targetRow.productId);
          return (
            <NumericKeypadOverlay
              open={true}
              productName={selected?.name || 'Quantity'}
              unit={selected?.unit || 'Unit'}
              availableStock={selected?.currentStock}
              unitPrice={selected?.salePrice ?? 0}
              initialQuantity={Math.max(1, Math.floor(Number(targetRow.quantity) || 1))}
              allowStockOverride={false}
              onConfirm={(nextQty) => {
                setRows((prev) =>
                  prev.map((r) =>
                    r.key === keypadRowKey ? { ...r, quantity: String(nextQty) } : r
                  )
                );
                setKeypadRowKey(null);
              }}
              onClose={() => setKeypadRowKey(null)}
            />
          );
        })()}
      </div>
    );
  }

  // 3. My Sales History (Read-only; cannot edit or delete completed sales)
  if (activeSection === 'my_sales') {
    if (!staffProfile.permissions.canViewOwnSales) {
      return (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
          <h2 className="text-base font-semibold text-slate-900">Sales History Restricted</h2>
          <p className="text-sm text-slate-600">
            Your account does not currently have permission to view sales history. Contact your shop owner.
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 sm:gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="text-[11px] font-medium text-slate-500">My Daily Sales</div>
            <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
              {formatPKR(ownStats.todayTotal)}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-3">
            <div className="text-[11px] font-medium text-slate-500">My Monthly Sales</div>
            <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
              {formatPKR(ownStats.monthTotal)}
            </div>
          </div>
          <div className="col-span-2 sm:col-span-1 bg-white border border-slate-200 rounded-xl p-3">
            <div className="text-[11px] font-medium text-slate-500">My All-Time Sales</div>
            <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
              {formatPKR(ownStats.allTotal)}
            </div>
          </div>
        </div>

        {pendingSales.length > 0 && (
          <section className="bg-amber-50/70 border border-amber-200 rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
            <div className="space-y-0.5">
              <div className="text-xs sm:text-sm font-semibold text-amber-900">
                Offline Sync Queue ({pendingSales.length}{' '}
                {pendingSales.length === 1 ? 'sale' : 'sales'})
              </div>
              <p className="text-[11px] sm:text-xs text-amber-800">
                {isOnline
                  ? 'Pending sales are ready to sync to the shop ledger.'
                  : 'Waiting for internet connection. Your queued sales are safely stored on this device.'}
              </p>
            </div>
            {isOnline && (
              <button
                type="button"
                disabled={isSyncing}
                onClick={() => void syncNow(true)}
                className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 rounded-lg transition-colors cursor-pointer shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                <span>{isSyncing ? 'Syncing...' : 'Sync All Now'}</span>
              </button>
            )}
          </section>
        )}

        <section className="bg-white border border-slate-200 rounded-xl">
          <div className="p-3 sm:p-4 border-b border-slate-200 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm sm:text-base font-semibold text-slate-900">My Sales History</h2>
                <p className="text-[11px] sm:text-xs text-slate-500">
                  Sales recorded by you ({formatNumber(filteredOwnSales.length)})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowMobileFilters((v) => !v)}
                className="lg:hidden inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
              >
                <Filter className="w-3.5 h-3.5" />
                <span>{showMobileFilters ? 'Hide Filters' : 'Filters'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-2">
              <div className="relative lg:col-span-5">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search sale # or product..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
                />
              </div>
              <div
                className={`${
                  showMobileFilters ? 'grid' : 'hidden lg:grid'
                } lg:col-span-7 grid-cols-2 sm:grid-cols-3 gap-2`}
              >
                <input
                  type="date"
                  aria-label="Filter from date"
                  value={filterFrom}
                  onChange={(e) => setFilterFrom(e.target.value)}
                  className="w-full min-h-[40px] px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg font-mono-num"
                />
                <input
                  type="date"
                  aria-label="Filter to date"
                  value={filterTo}
                  onChange={(e) => setFilterTo(e.target.value)}
                  className="w-full min-h-[40px] px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg font-mono-num"
                />
                <div className="col-span-2 sm:col-span-1">
                  <SearchableSelect
                    options={
                      [
                        { value: 'Cash', label: 'Cash', subtitle: 'Cash sales' },
                        { value: 'Online', label: 'Online', subtitle: 'Bank / wallet sales' },
                      ] as SearchableSelectOption[]
                    }
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
              </div>
            </div>
          </div>

          {filteredOwnSales.length === 0 ? (
            <div className="p-6 text-center text-xs sm:text-sm text-slate-500">
              No sales records found.
            </div>
          ) : (
            <>
              {/* Mobile Compact Expandable List */}
              <div className="md:hidden divide-y divide-slate-100">
                {filteredOwnSales.map((sale) => {
                  const isCancelled = sale.status === 'cancelled';
                  const isOffline = Boolean(sale.isOfflinePending);
                  return (
                    <CompactExpandableRow
                      key={sale.id}
                      dimmed={isCancelled}
                      rowToneClass={isOffline ? 'bg-amber-50/40' : ''}
                      title={
                        <span className="flex items-center gap-1.5 truncate">
                          <span className="font-mono-num">{sale.saleNumber}</span>
                          <span className="text-slate-400">·</span>
                          <span className="truncate font-normal text-slate-600">
                            {sale.items[0]?.productName || `${sale.itemCount} items`}
                            {sale.items.length > 1 ? ` +${sale.items.length - 1}` : ''}
                          </span>
                        </span>
                      }
                      subtitle={`${sale.saleDateTime || formatDateDDMMYYYY(sale.saleDate)} · ${sale.paymentMethod} · ${sale.totalQuantity} qty`}
                      rightPrimary={formatPKR(sale.totalAmount)}
                      rightSecondary={
                        isOffline ? (
                          <span
                            className={
                              sale.offlineSyncStatus === 'failed'
                                ? 'text-red-600 font-semibold'
                                : 'text-amber-700 font-semibold'
                            }
                          >
                            {sale.offlineSyncStatus === 'failed'
                              ? 'Sync Failed'
                              : sale.offlineSyncStatus === 'syncing'
                                ? 'Syncing...'
                                : 'Pending Sync'}
                          </span>
                        ) : (
                          <span className={isCancelled ? 'text-red-600' : 'text-emerald-700'}>
                            {isCancelled ? 'Cancelled' : 'Completed'}
                          </span>
                        )
                      }
                      isExpanded={expandedSaleId === sale.id}
                      onToggle={() =>
                        setExpandedSaleId((cur) => (cur === sale.id ? null : sale.id))
                      }
                      expandedContent={
                        <div className="space-y-2">
                          <div className="space-y-1 bg-white border border-slate-200 rounded-lg p-2">
                            {sale.items.map((item, idx) => (
                              <div
                                key={`${sale.id}-item-${idx}`}
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
                          {isOffline && sale.offlineLastError && (
                            <p className="text-[11px] text-red-600">{sale.offlineLastError}</p>
                          )}
                          {isOffline && sale.offlineLocalId && (
                            <div className="flex items-center justify-end gap-2">
                              {isOnline && (
                                <button
                                  type="button"
                                  disabled={isSyncing}
                                  onClick={() => void retryQueuedSale(sale.offlineLocalId!)}
                                  className="min-h-[36px] px-3 py-1 text-xs font-semibold text-teal-700 bg-white border border-teal-200 rounded-lg cursor-pointer disabled:opacity-50"
                                >
                                  Retry Sync
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={isSyncing}
                                onClick={() => discardQueuedSale(sale.offlineLocalId!)}
                                className="min-h-[36px] px-3 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg cursor-pointer disabled:opacity-50"
                              >
                                Remove
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
                      <th className="py-2.5 px-3">Products Sold</th>
                      <th className="py-2.5 px-3">Payment</th>
                      <th className="py-2.5 px-3 text-right">Qty</th>
                      <th className="py-2.5 px-3 text-right">Total</th>
                      <th className="py-2.5 px-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                    {filteredOwnSales.map((sale) => {
                      const summaryText = sale.items
                        .map((i) => `${i.productName} ×${i.quantity}`)
                        .join(', ');
                      const isCancelled = sale.status === 'cancelled';
                      const isOffline = Boolean(sale.isOfflinePending);

                      return (
                        <tr
                          key={sale.id}
                          className={`hover:bg-slate-50 ${isCancelled ? 'opacity-60' : ''} ${
                            isOffline ? 'bg-amber-50/30' : ''
                          }`}
                        >
                          <td className="py-2 px-3 font-mono-num text-xs whitespace-nowrap text-slate-700">
                            {sale.saleDateTime || formatDateDDMMYYYY(sale.saleDate)}
                          </td>
                          <td className="py-2 px-3 font-mono-num text-xs font-medium text-slate-900 whitespace-nowrap">
                            {sale.saleNumber}
                          </td>
                          <td className="py-2 px-3 text-slate-700 max-w-xs truncate" title={summaryText}>
                            {summaryText}
                          </td>
                          <td className="py-2 px-3 text-xs text-slate-600">{sale.paymentMethod}</td>
                          <td className="py-2 px-3 text-right font-mono-num">{sale.totalQuantity}</td>
                          <td className="py-2 px-3 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                            {formatPKR(sale.totalAmount)}
                          </td>
                          <td className="py-2 px-3 text-xs font-semibold">
                            {isOffline ? (
                              <div className="space-y-1">
                                <span
                                  className={
                                    sale.offlineSyncStatus === 'failed'
                                      ? 'text-red-600'
                                      : sale.offlineSyncStatus === 'syncing'
                                        ? 'text-teal-700'
                                        : 'text-amber-700'
                                  }
                                >
                                  {sale.offlineSyncStatus === 'failed'
                                    ? 'Sync Failed'
                                    : sale.offlineSyncStatus === 'syncing'
                                      ? 'Syncing...'
                                      : 'Pending Sync'}
                                </span>
                                {sale.offlineLastError && (
                                  <div className="text-[11px] font-normal text-red-600 max-w-[220px] leading-snug">
                                    {sale.offlineLastError}
                                  </div>
                                )}
                                {sale.offlineLocalId && (
                                  <div className="flex items-center gap-2 pt-0.5">
                                    {isOnline && (
                                      <button
                                        type="button"
                                        disabled={isSyncing}
                                        onClick={() => void retryQueuedSale(sale.offlineLocalId!)}
                                        className="text-[11px] font-semibold text-teal-700 hover:underline cursor-pointer disabled:opacity-50"
                                      >
                                        Retry
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      disabled={isSyncing}
                                      onClick={() => discardQueuedSale(sale.offlineLocalId!)}
                                      className="text-[11px] font-medium text-slate-500 hover:text-red-600 cursor-pointer disabled:opacity-50"
                                    >
                                      Remove
                                    </button>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className={isCancelled ? 'text-red-600' : 'text-emerald-700'}>
                                {isCancelled ? 'Cancelled' : 'Completed'}
                              </span>
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
        </section>
      </div>
    );
  }

  // 4. Products & Stock (Read-only: Names, Selling Prices, Available Stock ONLY)
  if (!staffProfile.permissions.canViewStock) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 text-center space-y-2">
        <h2 className="text-base font-semibold text-slate-900">Stock View Restricted</h2>
        <p className="text-sm text-slate-600">
          Your account does not currently have permission to view product stock. Contact your shop owner.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-3 sm:p-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
          <div>
            <h2 className="text-sm sm:text-base font-semibold text-slate-900">
              Product Prices &amp; Stock ({formatNumber(filteredCatalog.length)})
            </h2>
            <p className="text-[11px] sm:text-xs text-slate-500">
              Selling prices in PKR and current stock counts.
            </p>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search product, category or brand..."
              value={stockSearch}
              onChange={(e) => setStockSearch(e.target.value)}
              className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
            />
          </div>
        </div>

        {filteredCatalog.length === 0 ? (
          <div className="p-6 text-center text-xs sm:text-sm text-slate-500">
            No products match your search.
          </div>
        ) : (
          <>
            {/* Mobile Compact List */}
            <div className="md:hidden divide-y divide-slate-100">
              {filteredCatalog.map((item) => (
                <CompactExpandableRow
                  key={item.productId}
                  title={item.name}
                  subtitle={`${item.categoryName}${item.brandName ? ` · ${item.brandName}` : ''}`}
                  rightPrimary={formatPKR(item.salePrice)}
                  rightSecondary={
                    <span className={item.currentStock > 0 ? 'text-emerald-700' : 'text-red-600'}>
                      {item.currentStock} {item.unit}
                    </span>
                  }
                  isExpanded={expandedStockId === item.productId}
                  onToggle={() =>
                    setExpandedStockId((cur) => (cur === item.productId ? null : item.productId))
                  }
                  expandedContent={
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-slate-500">Category:</span>{' '}
                        <span className="font-medium text-slate-800">{item.categoryName}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Brand:</span>{' '}
                        <span className="font-medium text-slate-800">{item.brandName || '—'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Selling Price:</span>{' '}
                        <span className="font-mono-num font-semibold text-slate-900">
                          {formatPKR(item.salePrice)}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-500">Status:</span>{' '}
                        <span
                          className={`font-semibold ${
                            item.currentStock > 0 ? 'text-emerald-700' : 'text-red-600'
                          }`}
                        >
                          {item.currentStock > 0 ? 'In Stock' : 'Out of Stock'}
                        </span>
                      </div>
                    </div>
                  }
                />
              ))}
            </div>

            {/* Desktop Dense Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-3">Product Name</th>
                    <th className="py-2.5 px-3">Category</th>
                    <th className="py-2.5 px-3">Brand</th>
                    <th className="py-2.5 px-3 text-right">Selling Price</th>
                    <th className="py-2.5 px-3 text-right">Available Stock</th>
                    <th className="py-2.5 px-3">Availability</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {filteredCatalog.map((item) => (
                    <tr key={item.productId} className="hover:bg-slate-50">
                      <td className="py-2 px-3 font-medium text-slate-900">{item.name}</td>
                      <td className="py-2 px-3 text-xs text-slate-600">{item.categoryName}</td>
                      <td className="py-2 px-3 text-xs text-slate-600">{item.brandName || '—'}</td>
                      <td className="py-2 px-3 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                        {formatPKR(item.salePrice)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono-num text-slate-800 whitespace-nowrap">
                        {item.currentStock} {item.unit}
                      </td>
                      <td className="py-2 px-3 text-xs font-semibold">
                        <span className={item.currentStock > 0 ? 'text-emerald-700' : 'text-red-600'}>
                          {item.currentStock > 0 ? 'In Stock' : 'Out of Stock'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
