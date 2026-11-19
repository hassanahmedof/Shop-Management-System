import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, FileSpreadsheet, Plus, ShoppingCart } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CompactExpandableRow, CompactSection } from '../components/CompactSection';
import { useGoogleSheetsSync } from '../contexts/GoogleSheetsSyncContext';
import { useShopData } from '../contexts/ShopDataContext';
import type { NavSection } from '../types/shop';
import {
  buildSalesAndPnLSeries,
  computeDashboardSummary,
  computeMonthlyComparison,
  computeProductPerformance,
  type SalesGranularity,
} from '../utils/analytics';
import { formatAuditTimestamp, getActivityActionMeta } from '../utils/activityLogs';
import {
  addDaysToIso,
  formatDateDDMMYYYY,
  formatNumber,
  formatPKR,
  getKarachiDateIso,
  roundMoney,
} from '../utils/formatters';

interface DashboardPageProps {
  onNavigate: (section: NavSection) => void;
}

export function DashboardPage({ onNavigate }: DashboardPageProps) {
  const { products, sales, saleItems, purchases, expenses, auditLogs, settings, loading } = useShopData();
  const sheetsSync = useGoogleSheetsSync();

  const todayIso = getKarachiDateIso();
  const [fromDate, setFromDate] = useState(() => addDaysToIso(todayIso, -29));
  const [toDate, setToDate] = useState(() => todayIso);
  const [salesGranularity, setSalesGranularity] = useState<SalesGranularity>('daily');
  const [pnlMode, setPnlMode] = useState<'profit_expenses' | 'revenue_expenses' | 'profit_loss'>('profit_expenses');
  const [inventoryChartMode, setInventoryChartMode] = useState<
    'category' | 'bestselling' | 'lowstock' | 'velocity'
  >('category');
  const [reorderMode, setReorderMode] = useState<'custom' | 'min_level'>('custom');
  const [reorderThresholdInput, setReorderThresholdInput] = useState<string>('10');
  const [expandedReorderId, setExpandedReorderId] = useState<string | null>(null);
  const [expandedAlertKey, setExpandedAlertKey] = useState<string | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const safeThreshold = Math.max(1, Math.floor(Number(reorderThresholdInput) || 10));

  const summary = useMemo(
    () => computeDashboardSummary(products, sales, saleItems, purchases, expenses, settings),
    [products, sales, saleItems, purchases, expenses, settings]
  );

  const timeSeries = useMemo(
    () => buildSalesAndPnLSeries(sales, expenses, salesGranularity, fromDate, toDate),
    [sales, expenses, salesGranularity, fromDate, toDate]
  );

  const monthlyComp = useMemo(
    () => computeMonthlyComparison(sales, purchases, expenses),
    [sales, purchases, expenses]
  );

  const growthChartData = useMemo(
    () => [
      {
        metric: 'Revenue',
        Previous: monthlyComp.previousSales,
        Current: monthlyComp.currentSales,
      },
      {
        metric: 'Net Profit',
        Previous: monthlyComp.previousProfit,
        Current: monthlyComp.currentProfit,
      },
      {
        metric: 'Expenses',
        Previous: monthlyComp.previousExpenses,
        Current: monthlyComp.currentExpenses,
      },
    ],
    [monthlyComp]
  );

  const inventoryChartData = useMemo<
    Array<{
      name: string;
      stock?: number;
      value?: number;
      minLevel?: number;
      qtySold?: number;
      revenue?: number;
    }>
  >(() => {
    if (inventoryChartMode === 'category') {
      const catMap = new Map<string, { name: string; stock: number; value: number }>();
      for (const p of products) {
        const key = p.categoryName || 'Uncategorized';
        const cur = catMap.get(key) || { name: key, stock: 0, value: 0 };
        cur.stock += p.currentStock;
        cur.value += Math.round(p.currentStock * p.purchasePrice);
        catMap.set(key, cur);
      }
      return Array.from(catMap.values()).sort((a, b) => b.stock - a.stock).slice(0, 8);
    }

    if (inventoryChartMode === 'lowstock') {
      return [...products]
        .filter((p) => p.currentStock <= p.minStockLevel)
        .sort((a, b) => a.currentStock - b.currentStock)
        .slice(0, 8)
        .map((p) => ({
          name: p.name.length > 18 ? `${p.name.slice(0, 18)}…` : p.name,
          stock: p.currentStock,
          minLevel: p.minStockLevel,
        }));
    }

    const perf = computeProductPerformance(products, saleItems, { fromDate, toDate });
    if (inventoryChartMode === 'bestselling') {
      return perf.topByQuantity.slice(0, 8).map((r) => ({
        name: r.productName.length > 18 ? `${r.productName.slice(0, 18)}…` : r.productName,
        qtySold: r.quantitySold,
        revenue: r.revenue,
      }));
    }

    // Fast vs slow moving (top 4 fastest + bottom 4 slowest with stock > 0 or sold > 0)
    const sorted = [...perf.rows].sort((a, b) => b.quantitySold - a.quantitySold);
    const fast = sorted.slice(0, 4);
    const slow = sorted.slice(-4).reverse();
    const combined = [...fast, ...slow.filter((s) => !fast.some((f) => f.productId === s.productId))];
    return combined.map((r) => ({
      name: r.productName.length > 16 ? `${r.productName.slice(0, 16)}…` : r.productName,
      qtySold: r.quantitySold,
      stock: r.currentStock,
    }));
  }, [inventoryChartMode, products, saleItems, fromDate, toDate]);

  const reorderCandidates = useMemo(() => {
    const rows = products
      .filter((p) => p.isActive !== false)
      .filter((p) =>
        reorderMode === 'custom' ? p.currentStock < safeThreshold : p.currentStock <= p.minStockLevel
      )
      .map((p) => {
        const threshold = reorderMode === 'custom' ? safeThreshold : p.minStockLevel;
        const targetStock = Math.max(p.maxStockLevel || 0, threshold * 2, threshold + 5);
        const suggestedOrderQty = Math.max(1, targetStock - p.currentStock);
        const estimatedCost = roundMoney(suggestedOrderQty * p.purchasePrice);
        return {
          product: p,
          threshold,
          suggestedOrderQty,
          estimatedCost,
        };
      })
      .sort((a, b) => {
        if (a.product.currentStock !== b.product.currentStock) {
          return a.product.currentStock - b.product.currentStock;
        }
        return (b.threshold - b.product.currentStock) - (a.threshold - a.product.currentStock);
      });

    const totalEstimatedCost = rows.reduce((acc, r) => roundMoney(acc + r.estimatedCost), 0);
    return { rows, totalEstimatedCost };
  }, [products, reorderMode, safeThreshold]);

  const kpiCards = [
    { label: "Today's Sales", value: formatPKR(summary.todaySales), tone: 'neutral' },
    {
      label: "Today's Profit",
      value: formatPKR(summary.todayProfit),
      tone: summary.todayProfit >= 0 ? 'positive' : 'negative',
    },
    { label: 'Monthly Sales', value: formatPKR(summary.monthlySales), tone: 'neutral' },
    {
      label: 'Monthly Gross Profit',
      value: formatPKR(summary.monthlyGrossProfit),
      tone: summary.monthlyGrossProfit >= 0 ? 'positive' : 'negative',
    },
    {
      label: 'Monthly Net Profit',
      value: formatPKR(summary.monthlyNetProfit),
      tone: summary.monthlyNetProfit >= 0 ? 'positive' : 'negative',
    },
    { label: 'Total Expenses', value: formatPKR(summary.totalExpenses), tone: 'neutral' },
    { label: 'Total Products', value: formatNumber(summary.totalProducts), tone: 'neutral' },
    { label: 'Total Stock Quantity', value: formatNumber(summary.totalStockQuantity), tone: 'neutral' },
    { label: 'Total Inventory Value', value: formatPKR(summary.totalInventoryValue), tone: 'neutral' },
    {
      label: 'Low Stock Products',
      value: formatNumber(summary.lowStockProducts.length),
      tone: summary.lowStockProducts.length > 0 ? 'warning' : 'neutral',
    },
    {
      label: 'Out of Stock Products',
      value: formatNumber(summary.outOfStockProducts.length),
      tone: summary.outOfStockProducts.length > 0 ? 'negative' : 'neutral',
    },
    { label: 'Total Purchases', value: formatPKR(summary.totalPurchases), tone: 'neutral' },
  ];

  const formatPct = (pct: number | null) => {
    if (pct === null) return 'New';
    return `${pct >= 0 ? '+' : ''}${pct}%`;
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-xl p-3 h-18 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Top Action & Date Filter Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 sm:p-3.5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2.5">
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2">
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-1.5 text-xs text-slate-600">
            <label htmlFor="dash-from" className="font-medium text-slate-700 text-[11px] sm:text-xs">
              From
            </label>
            <input
              id="dash-from"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full sm:w-auto px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs sm:text-sm border border-slate-200 rounded-lg bg-white font-mono-num focus:outline-none focus:border-teal-600"
            />
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-1.5 text-xs text-slate-600">
            <label htmlFor="dash-to" className="font-medium text-slate-700 text-[11px] sm:text-xs">
              To
            </label>
            <input
              id="dash-to"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full sm:w-auto px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs sm:text-sm border border-slate-200 rounded-lg bg-white font-mono-num focus:outline-none focus:border-teal-600"
            />
          </div>
          <span className="col-span-2 text-[11px] text-slate-500 font-mono-num">
            {formatDateDDMMYYYY(fromDate)} – {formatDateDDMMYYYY(toDate)}
          </span>
        </div>

        <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onNavigate('sales')}
            className="inline-flex items-center justify-center gap-1 px-2.5 sm:px-3.5 py-2 min-h-[40px] sm:min-h-[36px] text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span>New Sale</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('purchases')}
            className="inline-flex items-center justify-center gap-1 px-2.5 sm:px-3.5 py-2 min-h-[40px] sm:min-h-[36px] text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span>Purchase</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('expenses')}
            className="inline-flex items-center justify-center gap-1 px-2.5 sm:px-3.5 py-2 min-h-[40px] sm:min-h-[36px] text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span>Expense</span>
          </button>
        </div>
      </div>

      {/* Sync Failed Alert Banner with Direct Link to Settings */}
      {sheetsSync &&
        (sheetsSync.consecutiveFailures >= 3 ||
          sheetsSync.failedCount > 0 ||
          (sheetsSync.integration?.lastSyncStatus === 'error' && Boolean(sheetsSync.lastError))) && (
          <div
            role="alert"
            className="bg-red-50 border border-red-200 rounded-xl px-3.5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5"
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <div className="text-xs sm:text-sm font-semibold text-red-900">Sync Failed</div>
                <p className="text-xs text-red-800 leading-relaxed">
                  {sheetsSync.consecutiveFailures >= 3
                    ? 'Google Sheets synchronization failed 3 consecutive times. '
                    : 'Google Sheets synchronization encountered an error. '}
                  {sheetsSync.lastError || 'Open Settings to review integration status and resolve issues.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              className="inline-flex items-center justify-center px-3 py-1.5 min-h-[36px] text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors whitespace-nowrap cursor-pointer shrink-0"
            >
              Go to Settings →
            </button>
          </div>
        )}

      {/* 12 Summary KPI Cards */}
      <section aria-label="Business summary">
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {kpiCards.map((card) => {
            const valueColor =
              card.tone === 'positive'
                ? 'text-emerald-700'
                : card.tone === 'negative'
                ? 'text-red-600'
                : card.tone === 'warning'
                ? 'text-amber-600'
                : 'text-slate-900';

            return (
              <div
                key={card.label}
                className="bg-white border border-slate-200 rounded-xl p-3 flex flex-col justify-between gap-1"
              >
                <span className="text-[11px] sm:text-xs font-medium text-slate-500 leading-tight truncate">
                  {card.label}
                </span>
                <span className={`text-base sm:text-lg font-bold font-mono-num tabular-nums tracking-tight truncate ${valueColor}`}>
                  {card.value}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Dashboard Graphs Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* 1. Sales Graph */}
        <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm sm:text-base font-semibold text-slate-900">Sales Trend</h2>
              <p className="text-[11px] sm:text-xs text-slate-500">Revenue across selected date range</p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['daily', 'weekly', 'monthly', 'yearly'] as SalesGranularity[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setSalesGranularity(g)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md capitalize transition-colors cursor-pointer ${
                    salesGranularity === g
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>

          <div className="h-52 sm:h-60">
            {timeSeries.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-slate-500">
                No sales recorded in the selected date range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={timeSeries} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip
                    formatter={(val) => formatPKR(Number(val ?? 0))}
                    contentStyle={{ borderRadius: '8px', borderColor: '#e2e8f0', fontSize: '12px' }}
                  />
                  <Bar dataKey="sales" name="Sales (PKR)" fill="#0d9488" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        {/* 2. Profit & Loss Graph */}
        <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm sm:text-base font-semibold text-slate-900">Profit & Loss</h2>
              <p className="text-[11px] sm:text-xs text-slate-500">Based on historical purchase cost of goods sold</p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setPnlMode('profit_expenses')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  pnlMode === 'profit_expenses'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Profit & Exp
              </button>
              <button
                type="button"
                onClick={() => setPnlMode('revenue_expenses')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  pnlMode === 'revenue_expenses'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Rev vs Exp
              </button>
              <button
                type="button"
                onClick={() => setPnlMode('profit_loss')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  pnlMode === 'profit_loss'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Net P/L
              </button>
            </div>
          </div>

          <div className="h-52 sm:h-60">
            {timeSeries.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-slate-500">
                No profit or expense data in the selected date range.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={timeSeries} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip
                    formatter={(val) => formatPKR(Number(val ?? 0))}
                    contentStyle={{ borderRadius: '8px', borderColor: '#e2e8f0', fontSize: '12px' }}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  {pnlMode === 'profit_expenses' && (
                    <>
                      <Bar dataKey="grossProfit" name="Gross Profit" fill="#0d9488" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="expenses" name="Expenses" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                      <Line type="monotone" dataKey="netProfit" name="Net Profit" stroke="#0f172a" strokeWidth={2} />
                    </>
                  )}
                  {pnlMode === 'revenue_expenses' && (
                    <>
                      <Bar dataKey="sales" name="Revenue" fill="#0d9488" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="expenses" name="Expenses" fill="#dc2626" radius={[4, 4, 0, 0]} />
                    </>
                  )}
                  {pnlMode === 'profit_loss' && (
                    <Bar dataKey="netProfit" name="Net Profit / Loss" radius={[4, 4, 0, 0]}>
                      {timeSeries.map((entry) => (
                        <Cell
                          key={entry.key}
                          fill={entry.netProfit >= 0 ? '#16a34a' : '#dc2626'}
                        />
                      ))}
                    </Bar>
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        {/* 3. Business Growth Graph */}
        <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm sm:text-base font-semibold text-slate-900">Business Growth</h2>
              <p className="text-[11px] sm:text-xs text-slate-500">
                {monthlyComp.currentLabel} vs {monthlyComp.previousLabel}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <div className="flex items-center gap-1">
                <span className="text-slate-500">Rev:</span>
                <span
                  className={`font-semibold font-mono-num inline-flex items-center ${
                    (monthlyComp.revenueGrowthPct ?? 0) >= 0 ? 'text-emerald-700' : 'text-red-600'
                  }`}
                >
                  {(monthlyComp.revenueGrowthPct ?? 0) >= 0 ? (
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  ) : (
                    <ArrowDownRight className="w-3.5 h-3.5" />
                  )}
                  {formatPct(monthlyComp.revenueGrowthPct)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-slate-500">Profit:</span>
                <span
                  className={`font-semibold font-mono-num inline-flex items-center ${
                    (monthlyComp.profitGrowthPct ?? 0) >= 0 ? 'text-emerald-700' : 'text-red-600'
                  }`}
                >
                  {formatPct(monthlyComp.profitGrowthPct)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-slate-500">Exp:</span>
                <span className="font-semibold font-mono-num text-slate-700">
                  {formatPct(monthlyComp.expenseGrowthPct)}
                </span>
              </div>
            </div>
          </div>

          <div className="h-52 sm:h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={growthChartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="metric" tick={{ fontSize: 12, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                <Tooltip
                  formatter={(val) => formatPKR(Number(val ?? 0))}
                  contentStyle={{ borderRadius: '8px', borderColor: '#e2e8f0', fontSize: '12px' }}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar dataKey="Previous" name={monthlyComp.previousLabel} fill="#94a3b8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Current" name={monthlyComp.currentLabel} fill="#0d9488" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* 4. Inventory Graph */}
        <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm sm:text-base font-semibold text-slate-900">Inventory Insights</h2>
              <p className="text-[11px] sm:text-xs text-slate-500">Stock distribution and product movement</p>
            </div>
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  { id: 'category', label: 'Category' },
                  { id: 'bestselling', label: 'Best Selling' },
                  { id: 'lowstock', label: 'Low Stock' },
                  { id: 'velocity', label: 'Velocity' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setInventoryChartMode(tab.id)}
                  className={`px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    inventoryChartMode === tab.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="h-52 sm:h-60">
            {inventoryChartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-slate-500">
                No matching product data to display.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={inventoryChartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip contentStyle={{ borderRadius: '8px', borderColor: '#e2e8f0', fontSize: '12px' }} />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  {inventoryChartMode === 'category' && (
                    <Bar dataKey="stock" name="Units in Stock" fill="#0d9488" radius={[4, 4, 0, 0]} />
                  )}
                  {inventoryChartMode === 'bestselling' && (
                    <Bar dataKey="qtySold" name="Qty Sold" fill="#0d9488" radius={[4, 4, 0, 0]} />
                  )}
                  {inventoryChartMode === 'lowstock' && (
                    <>
                      <Bar dataKey="stock" name="Current Stock" fill="#d97706" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="minLevel" name="Min Stock Level" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                    </>
                  )}
                  {inventoryChartMode === 'velocity' && (
                    <>
                      <Bar dataKey="qtySold" name="Units Sold" fill="#0d9488" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="stock" name="Current Stock" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
                    </>
                  )}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>
      </div>

      {/* Proactive Reorder Watchlist Widget */}
      <CompactSection
        title="Proactive Reorder Watchlist"
        subtitle={
          reorderMode === 'custom'
            ? `Active stock < ${safeThreshold} units · Est. ${formatPKR(reorderCandidates.totalEstimatedCost)}`
            : `At/below min level · Est. ${formatPKR(reorderCandidates.totalEstimatedCost)}`
        }
        icon={<ShoppingCart className="w-4 h-4 text-teal-600" />}
        summary={`${reorderCandidates.rows.length} items`}
        collapsible
        defaultOpen
        actions={
          <button
            type="button"
            onClick={() => onNavigate('purchases')}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Create PO
          </button>
        }
      >
        <div className="px-3.5 py-2.5 border-b border-slate-100 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setReorderMode('custom')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                reorderMode === 'custom'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Custom Threshold
            </button>
            <button
              type="button"
              onClick={() => setReorderMode('min_level')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                reorderMode === 'min_level'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Product Min
            </button>
          </div>

          {reorderMode === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs">
              <label htmlFor="reorder-threshold-input" className="text-slate-600 font-medium whitespace-nowrap">
                Below:
              </label>
              <input
                id="reorder-threshold-input"
                type="number"
                min={1}
                max={9999}
                value={reorderThresholdInput}
                onChange={(e) => setReorderThresholdInput(e.target.value)}
                className="w-16 px-2 py-1 text-xs bg-white border border-slate-200 rounded-lg font-mono-num tabular-nums focus:outline-none focus:border-teal-600"
              />
              <div className="flex items-center gap-1">
                {[5, 10, 20].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setReorderThresholdInput(String(preset))}
                    className={`px-2 py-1 text-xs font-mono-num rounded-md border transition-colors cursor-pointer ${
                      safeThreshold === preset
                        ? 'bg-teal-50 border-teal-200 text-teal-700 font-semibold'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {products.length === 0 ? (
          <div className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm text-slate-500">
            <span>Add products to monitor inventory thresholds and generate reorder suggestions.</span>
            <button
              type="button"
              onClick={() => onNavigate('products')}
              className="px-3 py-1.5 text-xs font-semibold text-teal-700 border border-teal-200 hover:bg-teal-50 rounded-lg cursor-pointer"
            >
              Add First Product
            </button>
          </div>
        ) : reorderCandidates.rows.length === 0 ? (
          <div className="p-4 text-xs sm:text-sm text-slate-500">
            {reorderMode === 'custom'
              ? `All active products have ${safeThreshold} or more units in stock.`
              : 'All active products are currently above their configured minimum stock levels.'}
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-2 px-3">Product</th>
                    <th className="py-2 px-3 text-right">Stock</th>
                    <th className="py-2 px-3 text-right">Threshold</th>
                    <th className="py-2 px-3 text-right">Suggested</th>
                    <th className="py-2 px-3 text-right">Est. Cost</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {reorderCandidates.rows.slice(0, 12).map(({ product, threshold, suggestedOrderQty, estimatedCost }) => {
                    const isOut = product.currentStock <= 0;
                    return (
                      <tr key={product.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3">
                          <div className="font-medium text-slate-900">{product.name}</div>
                          <div className="text-[11px] text-slate-500">
                            {product.categoryName} · {product.brandName}
                            {product.supplierName ? ` · ${product.supplierName}` : ''}
                          </div>
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono-num tabular-nums font-semibold ${
                            isOut ? 'text-red-600' : 'text-amber-600'
                          }`}
                        >
                          {formatNumber(product.currentStock)} {product.unit}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num tabular-nums text-slate-500">
                          {formatNumber(threshold)} {product.unit}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num tabular-nums font-semibold text-slate-900">
                          +{formatNumber(suggestedOrderQty)} {product.unit}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num tabular-nums text-slate-700">
                          {formatPKR(estimatedCost)}
                        </td>
                        <td className={`py-2 px-3 text-xs font-semibold whitespace-nowrap ${isOut ? 'text-red-600' : 'text-amber-700'}`}>
                          {isOut ? 'Out of Stock' : 'Below Threshold'}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => onNavigate('purchases')}
                            className="text-xs font-semibold text-teal-700 hover:text-teal-800 whitespace-nowrap cursor-pointer"
                          >
                            Reorder →
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-slate-100">
              {reorderCandidates.rows.slice(0, 12).map(({ product, threshold, suggestedOrderQty, estimatedCost }) => {
                const isOut = product.currentStock <= 0;
                return (
                  <CompactExpandableRow
                    key={product.id}
                    title={product.name}
                    subtitle={`${product.currentStock} ${product.unit} left · Min ${threshold}`}
                    rightPrimary={<span className={isOut ? 'text-red-600' : 'text-amber-700'}>+{formatNumber(suggestedOrderQty)} {product.unit}</span>}
                    rightSecondary={formatPKR(estimatedCost)}
                    isExpanded={expandedReorderId === product.id}
                    onToggle={() => setExpandedReorderId((prev) => (prev === product.id ? null : product.id))}
                    expandedContent={
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2 text-slate-600">
                          <div>Category: <span className="text-slate-900 font-medium">{product.categoryName}</span></div>
                          <div>Brand: <span className="text-slate-900 font-medium">{product.brandName}</span></div>
                          {product.supplierName && (
                            <div className="col-span-2">Supplier: <span className="text-slate-900 font-medium">{product.supplierName}</span></div>
                          )}
                        </div>
                        <div className="flex items-center justify-between pt-1">
                          <span className={`font-semibold ${isOut ? 'text-red-600' : 'text-amber-700'}`}>
                            {isOut ? 'Out of Stock' : 'Below Threshold'}
                          </span>
                          <button
                            type="button"
                            onClick={() => onNavigate('purchases')}
                            className="px-3 py-1.5 text-xs font-semibold text-teal-700 bg-white border border-teal-200 rounded-lg cursor-pointer"
                          >
                            Reorder →
                          </button>
                        </div>
                      </div>
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </CompactSection>

      {/* Low Stock & Expiry Alerts Section */}
      {(() => {
        const alertItems = [
          ...summary.outOfStockProducts.map((p) => ({ p, alert: 'Out of Stock', tone: 'text-red-700' })),
          ...summary.lowStockProducts.map((p) => ({ p, alert: 'Low Stock', tone: 'text-amber-700' })),
          ...summary.expiredProducts
            .filter((p) => p.currentStock > 0)
            .map((p) => ({ p, alert: 'Expired', tone: 'text-red-700' })),
          ...summary.nearingExpiryProducts
            .filter((p) => p.currentStock > 0)
            .map((p) => ({ p, alert: 'Nearing Expiry', tone: 'text-amber-700' })),
        ].slice(0, 12);

        return (
          <CompactSection
            title="Low Stock & Expiry Alerts"
            icon={<AlertTriangle className="w-4 h-4 text-amber-600" />}
            summary={alertItems.length > 0 ? `${alertItems.length} alerts` : 'Clear'}
            collapsible
            defaultOpen={false}
            actions={
              <button
                type="button"
                onClick={() => onNavigate('inventory')}
                className="text-xs font-semibold text-teal-700 hover:text-teal-800 cursor-pointer"
              >
                Inventory →
              </button>
            }
          >
            {alertItems.length === 0 ? (
              <div className="p-4 text-xs sm:text-sm text-slate-500">
                {products.length === 0
                  ? 'Add products in the Products page to monitor stock levels and expiry dates.'
                  : 'All products are above minimum stock levels with no expiry alerts.'}
              </div>
            ) : (
              <>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-2 px-3">Product</th>
                        <th className="py-2 px-3">Category · Brand</th>
                        <th className="py-2 px-3 text-right">Stock</th>
                        <th className="py-2 px-3 text-right">Min</th>
                        <th className="py-2 px-3">Expiry</th>
                        <th className="py-2 px-3">Alert</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                      {alertItems.map(({ p, alert, tone }, idx) => (
                        <tr key={`${p.id}-${alert}-${idx}`} className="hover:bg-slate-50">
                          <td className="py-2 px-3 font-medium text-slate-900">{p.name}</td>
                          <td className="py-2 px-3 text-xs text-slate-500">
                            {p.categoryName} · {p.brandName}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num text-slate-900">
                            {p.currentStock} {p.unit}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num text-slate-500">
                            {p.minStockLevel} {p.unit}
                          </td>
                          <td className="py-2 px-3 font-mono-num text-slate-600">
                            {p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—'}
                          </td>
                          <td className={`py-2 px-3 text-xs font-semibold ${tone}`}>{alert}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="md:hidden divide-y divide-slate-100">
                  {alertItems.map(({ p, alert, tone }, idx) => {
                    const rowKey = `${p.id}-${alert}-${idx}`;
                    return (
                      <CompactExpandableRow
                        key={rowKey}
                        title={p.name}
                        subtitle={`${p.categoryName} · ${p.brandName}`}
                        rightPrimary={<span className={tone}>{alert}</span>}
                        rightSecondary={`${p.currentStock} / ${p.minStockLevel} ${p.unit}`}
                        isExpanded={expandedAlertKey === rowKey}
                        onToggle={() => setExpandedAlertKey((prev) => (prev === rowKey ? null : rowKey))}
                        expandedContent={
                          <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600">
                            <span>Expiry: <strong className="font-mono-num text-slate-900">{p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—'}</strong></span>
                            <button
                              type="button"
                              onClick={() => onNavigate('inventory')}
                              className="px-2.5 py-1 text-xs font-semibold text-teal-700 bg-white border border-teal-200 rounded-lg cursor-pointer"
                            >
                              Manage Stock →
                            </button>
                          </div>
                        }
                      />
                    );
                  })}
                </div>
              </>
            )}
          </CompactSection>
        );
      })()}

      {/* Activity Logs Section (Owner/Admin Accountability) */}
      <CompactSection
        title="Activity Logs"
        subtitle="Recent sales edits, inventory adjustments, and staff logins"
        icon={<Activity className="w-4 h-4 text-teal-600" />}
        summary={`${Math.min(auditLogs.length, 8)} recent`}
        collapsible
        defaultOpen={false}
        actions={
          <button
            type="button"
            onClick={() => onNavigate('activity')}
            className="text-xs font-semibold text-teal-700 hover:text-teal-800 whitespace-nowrap cursor-pointer"
          >
            View All →
          </button>
        }
      >
        {auditLogs.length === 0 ? (
          <div className="p-4 text-xs sm:text-sm text-slate-500">
            No user activity recorded yet. Edits to sales, stock adjustments, and staff logins will appear here.
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-2 px-3 whitespace-nowrap">Timestamp (PKT)</th>
                    <th className="py-2 px-3 whitespace-nowrap">Module</th>
                    <th className="py-2 px-3 whitespace-nowrap">Action</th>
                    <th className="py-2 px-3">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {auditLogs.slice(0, 8).map((log) => {
                    const meta = getActivityActionMeta(log);
                    return (
                      <tr key={log.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-mono-num tabular-nums text-xs text-slate-500 whitespace-nowrap">
                          {formatAuditTimestamp(log.createdAt)}
                        </td>
                        <td className="py-2 px-3 text-xs font-medium text-slate-600 whitespace-nowrap">
                          {meta.categoryLabel}
                        </td>
                        <td className={`py-2 px-3 text-xs font-semibold whitespace-nowrap ${meta.toneClass}`}>
                          {meta.actionLabel}
                        </td>
                        <td className="py-2 px-3 text-xs text-slate-800">
                          {log.summary}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-slate-100">
              {auditLogs.slice(0, 8).map((log) => {
                const meta = getActivityActionMeta(log);
                return (
                  <CompactExpandableRow
                    key={log.id}
                    title={log.summary}
                    subtitle={`${formatAuditTimestamp(log.createdAt)} · ${meta.categoryLabel}`}
                    rightPrimary={<span className={meta.toneClass}>{meta.actionLabel}</span>}
                    isExpanded={expandedLogId === log.id}
                    onToggle={() => setExpandedLogId((prev) => (prev === log.id ? null : log.id))}
                    expandedContent={
                      <div className="text-slate-600 space-y-1">
                        <div className="text-slate-900">{log.summary}</div>
                        <div className="font-mono-num text-[11px] text-slate-500">
                          {log.entityType} · {log.entityId.slice(0, 8)}
                        </div>
                      </div>
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </CompactSection>

      {/* Google Sheets Backup & Sync Status Strip (Owner-Only) */}
      {sheetsSync && (
        <section className="bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 text-xs sm:text-sm">
            <FileSpreadsheet className="w-4 h-4 text-teal-600 shrink-0" />
            <span className="font-semibold text-slate-900">Google Sheets:</span>
            <span
              className={`font-medium ${
                sheetsSync.isSyncing
                  ? 'text-teal-700'
                  : sheetsSync.consecutiveFailures >= 3 ||
                    sheetsSync.failedCount > 0 ||
                    (sheetsSync.integration?.lastSyncStatus === 'error' && Boolean(sheetsSync.lastError))
                  ? 'text-red-600'
                  : sheetsSync.sheetsAuthorized && sheetsSync.integration?.spreadsheetId
                  ? 'text-emerald-700'
                  : 'text-slate-600'
              }`}
            >
              {sheetsSync.isSyncing
                ? 'Syncing...'
                : sheetsSync.consecutiveFailures >= 3 ||
                  sheetsSync.failedCount > 0 ||
                  (sheetsSync.integration?.lastSyncStatus === 'error' && Boolean(sheetsSync.lastError))
                ? 'Sync Failed'
                : sheetsSync.sheetsAuthorized && sheetsSync.integration?.spreadsheetId
                ? 'Active'
                : 'Inactive'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {sheetsSync.integration?.spreadsheetUrl && (
              <a
                href={sheetsSync.integration.spreadsheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold text-slate-600 hover:text-slate-900"
              >
                Open Sheet
              </a>
            )}
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              className="text-xs font-semibold text-teal-700 hover:text-teal-800 cursor-pointer"
            >
              Go to Settings →
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
