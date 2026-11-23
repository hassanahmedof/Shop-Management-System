import { ArrowDownRight, ArrowUpRight, ChevronDown, Filter, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CompactExpandableRow, CompactSection } from '../components/CompactSection';
import { SearchableSelect, type SearchableSelectOption } from '../components/SearchableSelect';
import { useAuth } from '../contexts/AuthContext';
import { useShopData } from '../contexts/ShopDataContext';
import { computeTopActivityValues } from '../services/recordSearchService';
import type { PaymentMethod } from '../types/shop';
import {
  buildProfitTrendSeries,
  computeMonthlyComparison,
  computeProductPerformance,
  computeYearlyComparison,
} from '../utils/analytics';
import {
  addDaysToIso,
  formatDateDDMMYYYY,
  formatNumber,
  formatPKR,
  getKarachiDateIso,
  getMonthKey,
  roundMoney,
} from '../utils/formatters';
import { formatStockBreakdown } from '../utils/packaging';
import {
  buildSellerFilterOptions,
  computeSellerPerformanceBreakdown,
  getSaleSellerKey,
  matchesSellerFilter,
} from '../utils/sellerAttribution';

export function AnalyticsPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const {
    products,
    categories,
    brands,
    suppliers,
    staffMembers,
    adminMembers,
    sales,
    saleItems,
    purchases,
    expenses,
    settings,
  } = useShopData();
  const todayIso = getKarachiDateIso();

  const [tab, setTab] = useState<'products' | 'comparison' | 'pnl'>('products');
  const [profitGranularity, setProfitGranularity] = useState<'daily' | 'monthly'>('daily');

  // Product & Business Analytics Filters
  const [fromDate, setFromDate] = useState(() => addDaysToIso(todayIso, -29));
  const [toDate, setToDate] = useState(() => todayIso);
  const [productId, setProductId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [brandId, setBrandId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'' | PaymentMethod>('');
  const [search, setSearch] = useState('');
  const [insightView, setInsightView] = useState<
    'topQty' | 'topRev' | 'topProfit' | 'highMargin' | 'slow' | 'noSales' | 'declining'
  >('topQty');

  // Monthly / Yearly Comparison Controls
  const [selectedMonth, setSelectedMonth] = useState(() => getMonthKey(todayIso));
  const [selectedYear, setSelectedYear] = useState(() => todayIso.slice(0, 4));
  const [showFilters, setShowFilters] = useState(false);
  const [expandedRankingId, setExpandedRankingId] = useState<string | null>(null);
  const [expandedCatId, setExpandedCatId] = useState<string | null>(null);
  const [expandedBrandId, setExpandedBrandId] = useState<string | null>(null);
  const [expandedAllProductId, setExpandedAllProductId] = useState<string | null>(null);
  const [expandedSellerKey, setExpandedSellerKey] = useState<string | null>(null);

  const productOptions = useMemo<SearchableSelectOption[]>(
    () =>
      products.map((p) => ({
        value: p.id,
        label: p.name,
        subtitle: `${p.brandName || 'Unbranded'} · ${p.categoryName || 'Uncategorized'}`,
        meta: `Stock: ${formatStockBreakdown(p.currentStock, p).summaryText}`,
        keywords: [p.name, p.brandName, p.categoryName, p.supplierName],
      })),
    [products]
  );

  const categoryOptions = useMemo<SearchableSelectOption[]>(
    () =>
      categories.map((c) => ({
        value: c.id,
        label: c.name,
        subtitle: c.description || 'Product category',
      })),
    [categories]
  );

  const brandOptions = useMemo<SearchableSelectOption[]>(
    () =>
      brands.map((b) => ({
        value: b.id,
        label: b.name,
        subtitle: 'Product brand',
      })),
    [brands]
  );

  const supplierOptions = useMemo<SearchableSelectOption[]>(
    () =>
      suppliers.map((s) => ({
        value: s.id,
        label: s.name,
        subtitle: s.phone ? `Phone: ${s.phone}` : s.address || 'Supplier',
        keywords: [s.name, s.phone, s.address].filter(Boolean),
      })),
    [suppliers]
  );

  const staffOptions = useMemo<SearchableSelectOption[]>(
    () =>
      buildSellerFilterOptions({
        sales,
        staffMembers,
        adminMembers,
        settings,
        user,
        shopId: activeShopId,
        includeAllOwnersOption: true,
      }),
    [sales, staffMembers, adminMembers, settings, user, activeShopId]
  );

  const paymentOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: 'Cash', label: 'Cash', subtitle: 'Cash sales & expenses' },
      { value: 'Online', label: 'Online', subtitle: 'Bank / mobile wallet transfers' },
    ],
    []
  );

  const frequentProductIds = useMemo(
    () => computeTopActivityValues(saleItems, (i) => i.productId, 5),
    [saleItems]
  );
  const frequentCategoryIds = useMemo(
    () => computeTopActivityValues(saleItems, (i) => i.categoryId, 5),
    [saleItems]
  );
  const frequentBrandIds = useMemo(
    () => computeTopActivityValues(saleItems, (i) => i.brandId, 5),
    [saleItems]
  );
  const frequentSupplierIds = useMemo(
    () => computeTopActivityValues(purchases, (p) => p.supplierId, 5),
    [purchases]
  );
  const frequentStaffIds = useMemo(
    () => computeTopActivityValues(sales, (s) => getSaleSellerKey(s), 5),
    [sales]
  );

  const filteredSales = useMemo(() => {
    if (!staffId && !paymentMethod) return sales;
    return sales.filter((s) => {
      if (!matchesSellerFilter(s, staffId)) return false;
      if (paymentMethod && s.paymentMethod !== paymentMethod) return false;
      return true;
    });
  }, [sales, staffId, paymentMethod]);

  const filteredSaleItems = useMemo(() => {
    if (!staffId && !paymentMethod) return saleItems;
    const validSaleIds = new Set(filteredSales.map((s) => s.id));
    return saleItems.filter((item) => validSaleIds.has(item.saleId));
  }, [saleItems, filteredSales, staffId, paymentMethod]);

  const filteredExpenses = useMemo(() => {
    if (!paymentMethod) return expenses;
    return expenses.filter((e) => e.paymentMethod === paymentMethod);
  }, [expenses, paymentMethod]);

  const filteredPurchases = useMemo(() => {
    if (!supplierId && !paymentMethod) return purchases;
    return purchases.filter((p) => {
      if (supplierId && p.supplierId !== supplierId) return false;
      if (paymentMethod && p.paymentMethod !== paymentMethod) return false;
      return true;
    });
  }, [purchases, supplierId, paymentMethod]);

  const perf = useMemo(
    () =>
      computeProductPerformance(products, filteredSaleItems, {
        fromDate,
        toDate,
        categoryId,
        brandId,
        productId,
        supplierId,
      }),
    [products, filteredSaleItems, fromDate, toDate, categoryId, brandId, productId, supplierId]
  );

  const filteredTableRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return perf.rows.filter((r) =>
      q ? `${r.productName} ${r.categoryName} ${r.brandName}`.toLowerCase().includes(q) : true
    );
  }, [perf.rows, search]);

  const activeRankingRows = useMemo(() => {
    switch (insightView) {
      case 'topQty':
        return perf.topByQuantity;
      case 'topRev':
        return perf.topByRevenue;
      case 'topProfit':
        return perf.topByProfit;
      case 'highMargin':
        return perf.highestMargin;
      case 'slow':
        return perf.slowMoving;
      case 'noSales':
        return perf.noSales;
      case 'declining':
        return perf.decliningSales;
    }
  }, [insightView, perf]);

  const monthlyComp = useMemo(
    () => computeMonthlyComparison(filteredSales, filteredPurchases, filteredExpenses, selectedMonth),
    [filteredSales, filteredPurchases, filteredExpenses, selectedMonth]
  );

  const yearlyComp = useMemo(
    () => computeYearlyComparison(filteredSales, filteredPurchases, filteredExpenses, selectedYear),
    [filteredSales, filteredPurchases, filteredExpenses, selectedYear]
  );

  const pnlBreakdown = useMemo(() => {
    const activeSales = filteredSales.filter(
      (s) => s.status !== 'cancelled' && s.saleDate >= fromDate && s.saleDate <= toDate
    );
    const activeItems = filteredSaleItems.filter(
      (i) => i.status !== 'cancelled' && i.saleDate >= fromDate && i.saleDate <= toDate
    );
    const periodExp = filteredExpenses.filter(
      (e) => e.expenseDate >= fromDate && e.expenseDate <= toDate
    );

    const revenue = activeSales.reduce((acc, s) => roundMoney(acc + s.totalAmount), 0);
    const cogs = activeItems.reduce((acc, i) => roundMoney(acc + i.lineCost), 0);
    const grossProfit = roundMoney(revenue - cogs);
    const totalExpenses = periodExp.reduce((acc, e) => roundMoney(acc + e.amount), 0);
    const netProfit = roundMoney(grossProfit - totalExpenses);
    const grossMargin = revenue > 0 ? Math.round((grossProfit / revenue) * 10000) / 100 : 0;
    const netMargin = revenue > 0 ? Math.round((netProfit / revenue) * 10000) / 100 : 0;

    return { revenue, cogs, grossProfit, totalExpenses, netProfit, grossMargin, netMargin };
  }, [filteredSales, filteredSaleItems, filteredExpenses, fromDate, toDate]);

  const profitTrendSeries = useMemo(
    () => buildProfitTrendSeries(filteredSales, filteredExpenses, profitGranularity, fromDate, toDate),
    [filteredSales, filteredExpenses, profitGranularity, fromDate, toDate]
  );

  const profitTrendSummary = useMemo(() => {
    const totalGross = profitTrendSeries.reduce((acc, p) => roundMoney(acc + p.grossProfit), 0);
    const totalNet = profitTrendSeries.reduce((acc, p) => roundMoney(acc + p.netProfit), 0);
    const totalExpenses = profitTrendSeries.reduce((acc, p) => roundMoney(acc + p.expenses), 0);
    const bestPoint = profitTrendSeries.reduce<(typeof profitTrendSeries)[number] | null>(
      (best, cur) => (!best || cur.netProfit > best.netProfit ? cur : best),
      null
    );
    return { totalGross, totalNet, totalExpenses, bestPoint };
  }, [profitTrendSeries]);

  const sellerPerformanceRows = useMemo(
    () =>
      computeSellerPerformanceBreakdown({
        sales: filteredSales,
        staffMembers,
        adminMembers,
        settings,
        user,
        shopId: activeShopId,
        fromDate,
        toDate,
      }),
    [filteredSales, staffMembers, adminMembers, settings, user, activeShopId, fromDate, toDate]
  );

  const sellerChartData = useMemo(
    () =>
      sellerPerformanceRows.map((row) => ({
        name: row.sellerLabel.length > 18 ? `${row.sellerLabel.slice(0, 18)}…` : row.sellerLabel,
        fullName: row.sellerLabel,
        Revenue: row.revenue,
        Profit: row.grossProfit,
        orders: row.orders,
      })),
    [sellerPerformanceRows]
  );

  const hasActiveFilters = Boolean(
    productId || categoryId || brandId || supplierId || staffId || paymentMethod
  );

  const clearAllFilters = () => {
    setProductId('');
    setCategoryId('');
    setBrandId('');
    setSupplierId('');
    setStaffId('');
    setPaymentMethod('');
  };

  const formatGrowth = (pct: number | null) => {
    if (pct === null) return 'New';
    return `${pct >= 0 ? '+' : ''}${pct}%`;
  };

  const activeFilterCount = [
    productId,
    categoryId,
    brandId,
    supplierId,
    staffId,
    paymentMethod,
  ].filter(Boolean).length;

  const tooltipContentStyle = {
    backgroundColor: 'var(--cm-chart-tooltip-bg)',
    borderColor: 'var(--cm-chart-tooltip-border)',
    color: 'var(--cm-text-primary)',
    borderRadius: '8px',
    fontSize: '12px',
  };

  return (
    <div className="space-y-4">
      {/* Top Section Tabs & Searchable Filters */}
      <div className="cm-surface border rounded-xl p-3 sm:p-4 space-y-2.5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2.5">
          <div className="flex items-center gap-1 p-1 bg-[var(--cm-bg-subtle)] rounded-lg overflow-x-auto max-w-full">
            <button
              type="button"
              onClick={() => setTab('products')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tab === 'products'
                  ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] shadow-xs'
                  : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
              }`}
            >
              Product Performance
            </button>
            <button
              type="button"
              onClick={() => setTab('comparison')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tab === 'comparison'
                  ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] shadow-xs'
                  : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
              }`}
            >
              Monthly & Yearly
            </button>
            <button
              type="button"
              onClick={() => setTab('pnl')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                tab === 'pnl'
                  ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] shadow-xs'
                  : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
              }`}
            >
              Profit & Loss
            </button>
          </div>

          <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 text-xs">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              aria-label="From date"
              className="w-full sm:w-auto px-2.5 py-1.5 min-h-[38px] sm:min-h-0 cm-input border rounded-lg font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
            />
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              aria-label="To date"
              className="w-full sm:w-auto px-2.5 py-1.5 min-h-[38px] sm:min-h-0 cm-input border rounded-lg font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
            />
            <div className="col-span-2 sm:col-span-1 flex items-center justify-between sm:justify-start gap-2">
              <button
                type="button"
                onClick={() => setShowFilters((v) => !v)}
                className="md:hidden inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-semibold text-[var(--cm-text-secondary)] bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] rounded-lg cursor-pointer"
              >
                <Filter className="w-3.5 h-3.5 text-[var(--cm-accent)]" />
                Filters {activeFilterCount > 0 ? `(${activeFilterCount})` : ''}
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
              </button>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={clearAllFilters}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[36px] sm:min-h-0 text-xs font-medium text-[var(--cm-accent-text)] border border-[var(--cm-accent-border)] bg-[var(--cm-accent-soft)] rounded-lg cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  Reset
                </button>
              )}
            </div>
          </div>
        </div>

        <div
          className={`${
            showFilters ? 'grid' : 'hidden md:grid'
          } grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2 pt-2 border-t border-[var(--cm-border)]`}
        >
          <SearchableSelect
            options={productOptions}
            value={productId}
            onChange={setProductId}
            emptyOptionLabel="All Products"
            placeholder="All Products"
            searchPlaceholder="Search product..."
            ariaLabel="Filter by product"
            suggestionScope="product"
            suggestedValues={frequentProductIds}
            size="sm"
          />
          <SearchableSelect
            options={categoryOptions}
            value={categoryId}
            onChange={setCategoryId}
            emptyOptionLabel="All Categories"
            placeholder="All Categories"
            searchPlaceholder="Search category..."
            ariaLabel="Filter by category"
            suggestionScope="category"
            suggestedValues={frequentCategoryIds}
            size="sm"
          />
          <SearchableSelect
            options={brandOptions}
            value={brandId}
            onChange={setBrandId}
            emptyOptionLabel="All Brands"
            placeholder="All Brands"
            searchPlaceholder="Search brand..."
            ariaLabel="Filter by brand"
            suggestionScope="brand"
            suggestedValues={frequentBrandIds}
            size="sm"
          />
          <SearchableSelect
            options={supplierOptions}
            value={supplierId}
            onChange={setSupplierId}
            emptyOptionLabel="All Suppliers"
            placeholder="All Suppliers"
            searchPlaceholder="Search supplier..."
            ariaLabel="Filter by supplier"
            suggestionScope="supplier"
            suggestedValues={frequentSupplierIds}
            size="sm"
          />
          <SearchableSelect
            options={staffOptions}
            value={staffId}
            onChange={setStaffId}
            emptyOptionLabel="All Sellers (Admins & Staff)"
            placeholder="All Sellers (Admins & Staff)"
            searchPlaceholder="Search admin or staff..."
            ariaLabel="Filter by admin or staff member"
            suggestionScope="staff"
            suggestedValues={frequentStaffIds}
            size="sm"
          />
          <SearchableSelect
            options={paymentOptions}
            value={paymentMethod}
            onChange={(val) => setPaymentMethod(val as '' | PaymentMethod)}
            emptyOptionLabel="All Payments"
            placeholder="All Payments"
            searchPlaceholder="Search payment..."
            ariaLabel="Filter by payment method"
            showFrequentSection={false}
            size="sm"
          />
        </div>
      </div>

      {/* Profit Trends Line Chart (Daily or Monthly) */}
      <section className="cm-surface border rounded-xl p-3.5 sm:p-4 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2.5">
          <div className="space-y-1">
            <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">Profit Trends</h2>
            <div className="flex flex-wrap items-center gap-2 text-[11px] sm:text-xs text-[var(--cm-text-muted)] font-mono-num tabular-nums">
              <span>{profitGranularity === 'daily' ? 'Daily' : 'Monthly'}</span>
              <span aria-hidden="true">·</span>
              <span>
                Gross: <strong className="text-[var(--cm-accent-text)]">{formatPKR(profitTrendSummary.totalGross)}</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Net:{' '}
                <strong className={profitTrendSummary.totalNet >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'}>
                  {formatPKR(profitTrendSummary.totalNet)}
                </strong>
              </span>
              {profitTrendSummary.bestPoint && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    Peak: {profitTrendSummary.bestPoint.label} ({formatPKR(profitTrendSummary.bestPoint.netProfit)})
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 p-1 bg-[var(--cm-bg-subtle)] rounded-lg self-start md:self-auto shrink-0">
            <button
              type="button"
              onClick={() => setProfitGranularity('daily')}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                profitGranularity === 'daily'
                  ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] shadow-xs'
                  : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
              }`}
            >
              Daily
            </button>
            <button
              type="button"
              onClick={() => setProfitGranularity('monthly')}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                profitGranularity === 'monthly'
                  ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] shadow-xs'
                  : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
              }`}
            >
              Monthly
            </button>
          </div>
        </div>

        <div className="h-52 sm:h-60">
          {profitTrendSeries.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-[var(--cm-text-muted)]">
              No sales or expense entries recorded for this period yet. Record sales or expenses to view profit trends.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={profitTrendSeries} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--cm-chart-grid)" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }}
                  minTickGap={20}
                />
                <YAxis tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }} />
                <Tooltip formatter={(val) => formatPKR(Number(val ?? 0))} contentStyle={tooltipContentStyle} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <ReferenceLine y={0} stroke="var(--cm-border-strong)" strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="grossProfit"
                  name="Gross Profit"
                  stroke="#65a30d"
                  strokeWidth={2.2}
                  dot={{ r: 2.5, fill: '#65a30d' }}
                  activeDot={{ r: 5 }}
                />
                <Line
                  type="monotone"
                  dataKey="netProfit"
                  name="Net Profit"
                  stroke="#16a34a"
                  strokeWidth={2.5}
                  dot={{ r: 2.5, fill: '#16a34a' }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Admin & Seller Sales Performance Comparison */}
      <CompactSection
        title="Admin & Seller Sales Comparison"
        subtitle={`${formatDateDDMMYYYY(fromDate)} to ${formatDateDDMMYYYY(toDate)}`}
        summary={`${sellerPerformanceRows.length} sellers`}
        collapsible
        defaultOpen
      >
        {sellerPerformanceRows.length === 0 ? (
          <div className="p-5 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
            No sales recorded for this period yet.
          </div>
        ) : (
          <div className="space-y-3 p-3.5 sm:p-4">
            <div className="h-48 sm:h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sellerChartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--cm-chart-grid)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }} />
                  <Tooltip
                    formatter={(val) => formatPKR(Number(val ?? 0))}
                    labelFormatter={(_, payload) =>
                      payload?.[0]?.payload?.fullName ? String(payload[0].payload.fullName) : ''
                    }
                    contentStyle={tooltipContentStyle}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Bar dataKey="Revenue" name="Sales Revenue" fill="#65a30d" radius={[4, 4, 0, 0]} maxBarSize={44} />
                  <Bar dataKey="Profit" name="Gross Profit" fill="#16a34a" radius={[4, 4, 0, 0]} maxBarSize={44} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="hidden md:block overflow-x-auto border border-[var(--cm-border)] rounded-lg">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                    <th className="py-2 px-3">Seller</th>
                    <th className="py-2 px-3">Role</th>
                    <th className="py-2 px-3 text-right">Bills</th>
                    <th className="py-2 px-3 text-right">Units</th>
                    <th className="py-2 px-3 text-right">Cash</th>
                    <th className="py-2 px-3 text-right">Online</th>
                    <th className="py-2 px-3 text-right">Total Sales</th>
                    <th className="py-2 px-3 text-right">Gross Profit</th>
                    <th className="py-2 px-3 text-right">Avg Bill</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                  {sellerPerformanceRows.map((row) => (
                    <tr key={row.sellerKey} className="hover:bg-[var(--cm-bg-hover)]">
                      <td className="py-2 px-3 font-semibold text-[var(--cm-text-primary)]">{row.sellerLabel}</td>
                      <td className="py-2 px-3 text-xs text-[var(--cm-text-secondary)]">
                        {row.roleType === 'owner_admin'
                          ? 'Owner / Admin'
                          : row.roleType === 'unassigned'
                            ? 'Legacy Unassigned'
                            : 'Sales Staff'}
                      </td>
                      <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">{row.orders}</td>
                      <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-secondary)]">{row.unitsSold}</td>
                      <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-secondary)]">{formatPKR(row.cashTotal)}</td>
                      <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-secondary)]">{formatPKR(row.onlineTotal)}</td>
                      <td className="py-2 px-3 text-right font-mono-num font-semibold text-[var(--cm-text-primary)]">{formatPKR(row.revenue)}</td>
                      <td
                        className={`py-2 px-3 text-right font-mono-num font-semibold ${
                          row.grossProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                        }`}
                      >
                        {formatPKR(row.grossProfit)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-secondary)]">{formatPKR(row.avgBill)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-[var(--cm-border)] border border-[var(--cm-border)] rounded-lg overflow-hidden">
              {sellerPerformanceRows.map((row) => (
                <CompactExpandableRow
                  key={row.sellerKey}
                  title={row.sellerLabel}
                  subtitle={`${row.orders} bills · Avg ${formatPKR(row.avgBill)}`}
                  rightPrimary={formatPKR(row.revenue)}
                  rightSecondary={
                    <span className={row.grossProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'}>
                      +{formatPKR(row.grossProfit)}
                    </span>
                  }
                  isExpanded={expandedSellerKey === row.sellerKey}
                  onToggle={() =>
                    setExpandedSellerKey((prev) => (prev === row.sellerKey ? null : row.sellerKey))
                  }
                  expandedContent={
                    <div className="grid grid-cols-2 gap-2 text-[var(--cm-text-secondary)] font-mono-num">
                      <div>
                        Role:{' '}
                        <span className="font-sans text-[var(--cm-text-primary)] font-medium">
                          {row.roleType === 'owner_admin'
                            ? 'Owner / Admin'
                            : row.roleType === 'unassigned'
                              ? 'Legacy Unassigned'
                              : 'Sales Staff'}
                        </span>
                      </div>
                      <div>Units: <span className="text-[var(--cm-text-primary)]">{row.unitsSold}</span></div>
                      <div>Cash: <span className="text-[var(--cm-text-primary)]">{formatPKR(row.cashTotal)}</span></div>
                      <div>Online: <span className="text-[var(--cm-text-primary)]">{formatPKR(row.onlineTotal)}</span></div>
                    </div>
                  }
                />
              ))}
            </div>
          </div>
        )}
      </CompactSection>

      {/* TAB 1: Product Performance Analytics */}
      {tab === 'products' && (
        <div className="space-y-4">
          {/* Performance Rankings Selector */}
          <CompactSection
            title="Product Rankings & Movement"
            subtitle={`${formatDateDDMMYYYY(fromDate)} to ${formatDateDDMMYYYY(toDate)}`}
            summary={`${activeRankingRows.slice(0, 10).length} ranked`}
            collapsible
            defaultOpen
          >
            <div className="px-3.5 py-2.5 border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)]">
              <div className="flex items-center gap-1 p-1 bg-[var(--cm-bg-app)] border border-[var(--cm-border)] rounded-lg overflow-x-auto max-w-full">
                {(
                  [
                    { id: 'topQty', label: 'Top Qty' },
                    { id: 'topRev', label: 'Top Revenue' },
                    { id: 'topProfit', label: 'Top Profit' },
                    { id: 'highMargin', label: 'High Margin' },
                    { id: 'slow', label: 'Slow' },
                    { id: 'noSales', label: 'No Sales' },
                    { id: 'declining', label: 'Declining' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setInsightView(item.id);
                      setExpandedRankingId(null);
                    }}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                      insightView === item.id
                        ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] shadow-xs'
                        : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {activeRankingRows.length === 0 ? (
              <div className="p-5 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
                No products fall into this segment for the selected date range.
              </div>
            ) : (
              <>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                        <th className="py-2 px-3">Product</th>
                        <th className="py-2 px-3">Category · Brand</th>
                        <th className="py-2 px-3 text-right">Qty Sold</th>
                        {insightView === 'declining' && (
                          <th className="py-2 px-3 text-right">Prev Period</th>
                        )}
                        <th className="py-2 px-3 text-right">Revenue</th>
                        <th className="py-2 px-3 text-right">Gross Profit</th>
                        <th className="py-2 px-3 text-right">Margin %</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                      {activeRankingRows.slice(0, 10).map((r) => (
                        <tr key={r.productId} className="hover:bg-[var(--cm-bg-hover)]">
                          <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">{r.productName}</td>
                          <td className="py-2 px-3 text-xs text-[var(--cm-text-muted)]">
                            {r.categoryName} · {r.brandName}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">{r.quantitySold}</td>
                          {insightView === 'declining' && (
                            <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-danger)]">
                              {r.previousPeriodQty} ({r.qtyChange})
                            </td>
                          )}
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">{formatPKR(r.revenue)}</td>
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-success)]">
                            {formatPKR(r.grossProfit)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-secondary)]">{r.profitMarginPct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="md:hidden divide-y divide-[var(--cm-border)]">
                  {activeRankingRows.slice(0, 10).map((r) => (
                    <CompactExpandableRow
                      key={r.productId}
                      title={r.productName}
                      subtitle={`Sold: ${r.quantitySold} · Margin ${r.profitMarginPct}%`}
                      rightPrimary={formatPKR(r.revenue)}
                      rightSecondary={
                        <span className={r.grossProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'}>
                          +{formatPKR(r.grossProfit)}
                        </span>
                      }
                      isExpanded={expandedRankingId === r.productId}
                      onToggle={() =>
                        setExpandedRankingId((prev) => (prev === r.productId ? null : r.productId))
                      }
                      expandedContent={
                        <div className="grid grid-cols-2 gap-2 text-[var(--cm-text-secondary)]">
                          <div>Category: <span className="text-[var(--cm-text-primary)] font-medium">{r.categoryName}</span></div>
                          <div>Brand: <span className="text-[var(--cm-text-primary)] font-medium">{r.brandName}</span></div>
                          <div>Cost: <span className="font-mono-num text-[var(--cm-text-primary)]">{formatPKR(r.cost)}</span></div>
                          <div>Stock Left: <span className="font-mono-num text-[var(--cm-text-primary)]">{r.currentStock}</span></div>
                          {insightView === 'declining' && (
                            <div className="col-span-2 text-[var(--cm-danger)] font-mono-num">
                              Prev Qty: {r.previousPeriodQty} ({r.qtyChange})
                            </div>
                          )}
                        </div>
                      }
                    />
                  ))}
                </div>
              </>
            )}
          </CompactSection>

          {/* Best-Performing Categories & Brands */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CompactSection
              title="Best-Performing Categories"
              summary={`${perf.bestCategories.length} categories`}
              collapsible
              defaultOpen={false}
            >
              {perf.bestCategories.length === 0 ? (
                <div className="p-4 text-xs sm:text-sm text-[var(--cm-text-muted)]">No category sales in this period.</div>
              ) : (
                <>
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                          <th className="py-2 px-3">Category</th>
                          <th className="py-2 px-3 text-right">Qty</th>
                          <th className="py-2 px-3 text-right">Revenue</th>
                          <th className="py-2 px-3 text-right">Profit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                        {perf.bestCategories.map((c) => (
                          <tr key={c.id} className="hover:bg-[var(--cm-bg-hover)]">
                            <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">{c.name}</td>
                            <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">{c.quantitySold}</td>
                            <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">{formatPKR(c.revenue)}</td>
                            <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-success)]">
                              {formatPKR(c.grossProfit)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="md:hidden divide-y divide-[var(--cm-border)]">
                    {perf.bestCategories.map((c) => (
                      <CompactExpandableRow
                        key={c.id}
                        title={c.name}
                        subtitle={`Qty Sold: ${c.quantitySold}`}
                        rightPrimary={formatPKR(c.revenue)}
                        rightSecondary={<span className="text-[var(--cm-success)]">+{formatPKR(c.grossProfit)}</span>}
                        isExpanded={expandedCatId === c.id}
                        onToggle={() => setExpandedCatId((prev) => (prev === c.id ? null : c.id))}
                        expandedContent={
                          <div className="flex justify-between text-[var(--cm-text-secondary)]">
                            <span>Quantity Sold: <strong className="font-mono-num text-[var(--cm-text-primary)]">{c.quantitySold}</strong></span>
                            <span>Profit: <strong className="font-mono-num text-[var(--cm-success)]">{formatPKR(c.grossProfit)}</strong></span>
                          </div>
                        }
                      />
                    ))}
                  </div>
                </>
              )}
            </CompactSection>

            <CompactSection
              title="Best-Performing Brands"
              summary={`${perf.bestBrands.length} brands`}
              collapsible
              defaultOpen={false}
            >
              {perf.bestBrands.length === 0 ? (
                <div className="p-4 text-xs sm:text-sm text-[var(--cm-text-muted)]">No brand sales in this period.</div>
              ) : (
                <>
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                          <th className="py-2 px-3">Brand</th>
                          <th className="py-2 px-3 text-right">Qty</th>
                          <th className="py-2 px-3 text-right">Revenue</th>
                          <th className="py-2 px-3 text-right">Profit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                        {perf.bestBrands.map((b) => (
                          <tr key={b.id} className="hover:bg-[var(--cm-bg-hover)]">
                            <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">{b.name}</td>
                            <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">{b.quantitySold}</td>
                            <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">{formatPKR(b.revenue)}</td>
                            <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-success)]">
                              {formatPKR(b.grossProfit)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="md:hidden divide-y divide-[var(--cm-border)]">
                    {perf.bestBrands.map((b) => (
                      <CompactExpandableRow
                        key={b.id}
                        title={b.name}
                        subtitle={`Qty Sold: ${b.quantitySold}`}
                        rightPrimary={formatPKR(b.revenue)}
                        rightSecondary={<span className="text-[var(--cm-success)]">+{formatPKR(b.grossProfit)}</span>}
                        isExpanded={expandedBrandId === b.id}
                        onToggle={() => setExpandedBrandId((prev) => (prev === b.id ? null : b.id))}
                        expandedContent={
                          <div className="flex justify-between text-[var(--cm-text-secondary)]">
                            <span>Quantity Sold: <strong className="font-mono-num text-[var(--cm-text-primary)]">{b.quantitySold}</strong></span>
                            <span>Profit: <strong className="font-mono-num text-[var(--cm-success)]">{formatPKR(b.grossProfit)}</strong></span>
                          </div>
                        }
                      />
                    ))}
                  </div>
                </>
              )}
            </CompactSection>
          </div>

          {/* Complete Product Performance Table */}
          <CompactSection
            title="All Products Performance"
            summary={`${filteredTableRows.length} products`}
            collapsible
            defaultOpen
            actions={
              <div className="relative w-full sm:w-52">
                <Search className="w-3.5 h-3.5 text-[var(--cm-text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search product..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs cm-input border rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
                />
              </div>
            }
          >
            {filteredTableRows.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
                No products match your filter.
              </div>
            ) : (
              <>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                        <th className="py-2 px-3">Product Name</th>
                        <th className="py-2 px-3 text-right">Qty Sold</th>
                        <th className="py-2 px-3 text-right">Revenue</th>
                        <th className="py-2 px-3 text-right">Cost</th>
                        <th className="py-2 px-3 text-right">Gross Profit</th>
                        <th className="py-2 px-3 text-right">Margin</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                      {filteredTableRows.map((r) => (
                        <tr key={r.productId} className="hover:bg-[var(--cm-bg-hover)]">
                          <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">
                            <div>{r.productName}</div>
                            <div className="text-[11px] text-[var(--cm-text-muted)]">
                              {r.categoryName} · {r.brandName}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">{r.quantitySold}</td>
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">{formatPKR(r.revenue)}</td>
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-secondary)]">
                            {formatPKR(r.cost)}
                          </td>
                          <td
                            className={`py-2 px-3 text-right font-mono-num font-semibold ${
                              r.grossProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                            }`}
                          >
                            {formatPKR(r.grossProfit)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-secondary)]">{r.profitMarginPct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="md:hidden divide-y divide-[var(--cm-border)]">
                  {filteredTableRows.map((r) => (
                    <CompactExpandableRow
                      key={r.productId}
                      title={r.productName}
                      subtitle={`Qty: ${r.quantitySold} · Margin ${r.profitMarginPct}%`}
                      rightPrimary={formatPKR(r.revenue)}
                      rightSecondary={
                        <span className={r.grossProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'}>
                          {formatPKR(r.grossProfit)}
                        </span>
                      }
                      isExpanded={expandedAllProductId === r.productId}
                      onToggle={() =>
                        setExpandedAllProductId((prev) => (prev === r.productId ? null : r.productId))
                      }
                      expandedContent={
                        <div className="grid grid-cols-2 gap-2 text-[var(--cm-text-secondary)]">
                          <div>Category: <span className="text-[var(--cm-text-primary)] font-medium">{r.categoryName}</span></div>
                          <div>Brand: <span className="text-[var(--cm-text-primary)] font-medium">{r.brandName}</span></div>
                          <div>Cost: <span className="font-mono-num text-[var(--cm-text-primary)]">{formatPKR(r.cost)}</span></div>
                          <div>Stock: <span className="font-mono-num text-[var(--cm-text-primary)]">{r.currentStock}</span></div>
                        </div>
                      }
                    />
                  ))}
                </div>
              </>
            )}
          </CompactSection>
        </div>
      )}

      {/* TAB 2: Monthly & Yearly Business Comparison */}
      {tab === 'comparison' && (
        <div className="space-y-4">
          {/* Monthly Comparison */}
          <section className="cm-surface border rounded-xl p-3.5 sm:p-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div>
                <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">
                  Monthly Comparison ({monthlyComp.currentLabel} vs {monthlyComp.previousLabel})
                </h2>
                <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
                  Sales, net profit, expenses, purchases, and units sold
                </p>
              </div>
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="px-2.5 py-1.5 text-xs sm:text-sm cm-input border rounded-lg font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
              />
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
              <div className="border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] rounded-lg p-3 space-y-1">
                <div className="text-[11px] text-[var(--cm-text-muted)]">Total Sales</div>
                <div className="text-base sm:text-lg font-bold font-mono-num text-[var(--cm-text-primary)] truncate">
                  {formatPKR(monthlyComp.currentSales)}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
                  <span className="text-[var(--cm-text-muted)]">Prev: {formatPKR(monthlyComp.previousSales)}</span>
                  <span
                    className={`font-semibold font-mono-num inline-flex items-center ${
                      (monthlyComp.revenueGrowthPct ?? 0) >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                    }`}
                  >
                    {(monthlyComp.revenueGrowthPct ?? 0) >= 0 ? (
                      <ArrowUpRight className="w-3 h-3" />
                    ) : (
                      <ArrowDownRight className="w-3 h-3" />
                    )}
                    {formatGrowth(monthlyComp.revenueGrowthPct)}
                  </span>
                </div>
              </div>

              <div className="border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] rounded-lg p-3 space-y-1">
                <div className="text-[11px] text-[var(--cm-text-muted)]">Net Profit</div>
                <div className="text-base sm:text-lg font-bold font-mono-num text-[var(--cm-text-primary)] truncate">
                  {formatPKR(monthlyComp.currentProfit)}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
                  <span className="text-[var(--cm-text-muted)]">Prev: {formatPKR(monthlyComp.previousProfit)}</span>
                  <span
                    className={`font-semibold font-mono-num ${
                      (monthlyComp.profitGrowthPct ?? 0) >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                    }`}
                  >
                    {formatGrowth(monthlyComp.profitGrowthPct)}
                  </span>
                </div>
              </div>

              <div className="border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] rounded-lg p-3 space-y-1">
                <div className="text-[11px] text-[var(--cm-text-muted)]">Total Expenses</div>
                <div className="text-base sm:text-lg font-bold font-mono-num text-[var(--cm-text-primary)] truncate">
                  {formatPKR(monthlyComp.currentExpenses)}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
                  <span className="text-[var(--cm-text-muted)]">Prev: {formatPKR(monthlyComp.previousExpenses)}</span>
                  <span className="font-semibold font-mono-num text-[var(--cm-text-secondary)]">
                    {formatGrowth(monthlyComp.expenseGrowthPct)}
                  </span>
                </div>
              </div>

              <div className="border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] rounded-lg p-3 space-y-1">
                <div className="text-[11px] text-[var(--cm-text-muted)]">Purchases & Units</div>
                <div className="text-base sm:text-lg font-bold font-mono-num text-[var(--cm-text-primary)] truncate">
                  {formatPKR(monthlyComp.currentPurchases)}
                </div>
                <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num">
                  Sold: {formatNumber(monthlyComp.currentUnitsSold)} (Prev:{' '}
                  {formatNumber(monthlyComp.previousUnitsSold)})
                </div>
              </div>
            </div>

            <div className="h-52 sm:h-60">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={[
                    { name: 'Sales', Previous: monthlyComp.previousSales, Current: monthlyComp.currentSales },
                    { name: 'Gross', Previous: monthlyComp.previousGrossProfit, Current: monthlyComp.currentGrossProfit },
                    { name: 'Net', Previous: monthlyComp.previousProfit, Current: monthlyComp.currentProfit },
                    { name: 'Expenses', Previous: monthlyComp.previousExpenses, Current: monthlyComp.currentExpenses },
                    { name: 'Purchases', Previous: monthlyComp.previousPurchases, Current: monthlyComp.currentPurchases },
                  ]}
                  margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--cm-chart-grid)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }} />
                  <Tooltip formatter={(v) => formatPKR(Number(v ?? 0))} contentStyle={tooltipContentStyle} />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Bar dataKey="Previous" name={monthlyComp.previousLabel} fill="#94a3b8" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Current" name={monthlyComp.currentLabel} fill="#65a30d" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Yearly Comparison */}
          <section className="cm-surface border rounded-xl p-3.5 sm:p-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div>
                <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">
                  Yearly Comparison ({yearlyComp.currentLabel} vs {yearlyComp.previousLabel})
                </h2>
                <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">Annual sales, profit, expenses, and purchases</p>
              </div>
              <input
                type="number"
                min={2020}
                max={2040}
                value={selectedYear}
                onChange={(e) => setSelectedYear(e.target.value)}
                className="w-24 px-2.5 py-1.5 text-xs sm:text-sm cm-input border rounded-lg font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
              />
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
              <div className="border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] rounded-lg p-3">
                <div className="text-[11px] text-[var(--cm-text-muted)]">Annual Sales</div>
                <div className="text-base sm:text-lg font-bold font-mono-num text-[var(--cm-text-primary)] truncate">{formatPKR(yearlyComp.currentSales)}</div>
                <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num">
                  Prev: {formatPKR(yearlyComp.previousSales)} · {formatGrowth(yearlyComp.revenueGrowthPct)}
                </div>
              </div>
              <div className="border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] rounded-lg p-3">
                <div className="text-[11px] text-[var(--cm-text-muted)]">Annual Net Profit</div>
                <div className="text-base sm:text-lg font-bold font-mono-num text-[var(--cm-text-primary)] truncate">{formatPKR(yearlyComp.currentProfit)}</div>
                <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num">
                  Prev: {formatPKR(yearlyComp.previousProfit)} · {formatGrowth(yearlyComp.profitGrowthPct)}
                </div>
              </div>
              <div className="border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] rounded-lg p-3">
                <div className="text-[11px] text-[var(--cm-text-muted)]">Annual Expenses</div>
                <div className="text-base sm:text-lg font-bold font-mono-num text-[var(--cm-text-primary)] truncate">{formatPKR(yearlyComp.currentExpenses)}</div>
                <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num">
                  Prev: {formatPKR(yearlyComp.previousExpenses)} · {formatGrowth(yearlyComp.expenseGrowthPct)}
                </div>
              </div>
              <div className="border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] rounded-lg p-3">
                <div className="text-[11px] text-[var(--cm-text-muted)]">Annual Purchases</div>
                <div className="text-base sm:text-lg font-bold font-mono-num text-[var(--cm-text-primary)] truncate">{formatPKR(yearlyComp.currentPurchases)}</div>
                <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num">
                  Units Sold: {formatNumber(yearlyComp.currentUnitsSold)}
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* TAB 3: Profit & Loss Statement */}
      {tab === 'pnl' && (
        <section className="cm-surface border rounded-xl p-3.5 sm:p-5 space-y-3.5">
          <div>
            <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">
              Profit & Loss Statement ({formatDateDDMMYYYY(fromDate)} – {formatDateDDMMYYYY(toDate)})
            </h2>
            <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
              Calculated from historical purchase cost of goods sold minus operating expenses.
            </p>
          </div>

          <div className="divide-y divide-[var(--cm-border)] border border-[var(--cm-border)] rounded-lg overflow-hidden">
            <div className="p-3 sm:p-3.5 flex items-center justify-between gap-2 text-xs sm:text-sm">
              <span className="font-medium text-[var(--cm-text-secondary)]">Total Revenue (Sales − Returns)</span>
              <span className="font-bold font-mono-num text-[var(--cm-text-primary)] whitespace-nowrap">{formatPKR(pnlBreakdown.revenue)}</span>
            </div>
            <div className="p-3 sm:p-3.5 flex items-center justify-between gap-2 text-xs sm:text-sm">
              <span className="font-medium text-[var(--cm-text-secondary)]">Cost of Goods Sold</span>
              <span className="font-mono-num text-[var(--cm-text-secondary)] whitespace-nowrap">− {formatPKR(pnlBreakdown.cogs)}</span>
            </div>
            <div className="p-3 sm:p-3.5 flex items-center justify-between gap-2 text-xs sm:text-sm bg-[var(--cm-bg-subtle)]">
              <span className="font-semibold text-[var(--cm-text-primary)]">
                Gross Profit ({pnlBreakdown.grossMargin}%)
              </span>
              <span
                className={`font-bold font-mono-num whitespace-nowrap ${
                  pnlBreakdown.grossProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                }`}
              >
                {formatPKR(pnlBreakdown.grossProfit)}
              </span>
            </div>
            <div className="p-3 sm:p-3.5 flex items-center justify-between gap-2 text-xs sm:text-sm">
              <span className="font-medium text-[var(--cm-text-secondary)]">Total Business Expenses</span>
              <span className="font-mono-num text-[var(--cm-danger)] whitespace-nowrap">− {formatPKR(pnlBreakdown.totalExpenses)}</span>
            </div>
            <div className="p-3 sm:p-3.5 flex items-center justify-between gap-2 text-sm sm:text-base bg-[var(--cm-bg-subtle)]">
              <span className="font-bold text-[var(--cm-text-primary)]">
                Net Profit ({pnlBreakdown.netMargin}% net)
              </span>
              <span
                className={`font-bold font-mono-num whitespace-nowrap ${
                  pnlBreakdown.netProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                }`}
              >
                {formatPKR(pnlBreakdown.netProfit)}
              </span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
