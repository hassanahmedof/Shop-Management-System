import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  FileSpreadsheet,
  Package,
  Plus,
  Receipt,
  ShoppingBag,
  ShoppingCart,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
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
import { formatAuditTimestamp, getActivityActionMeta } from '../utils/activityLogs';
import {
  buildSalesAndPnLSeries,
  computeDashboardSummary,
  computeMonthlyComparison,
  computeProductPerformance,
  type SalesGranularity,
} from '../utils/analytics';
import {
  addDaysToIso,
  formatDateDDMMYYYY,
  formatNumber,
  formatPKR,
  getKarachiDateIso,
  roundMoney,
} from '../utils/formatters';
import { formatStockBreakdown, getEffectiveBaseUnit } from '../utils/packaging';
import { formatSaleSellerLabel } from '../utils/sellerAttribution';

interface DashboardPageProps {
  onNavigate: (section: NavSection) => void;
}

const CATEGORY_BAR_COLORS = [
  '#65a30d',
  '#84cc16',
  '#16a34a',
  '#eab308',
  '#4d7c0f',
  '#22c55e',
];

export function DashboardPage({ onNavigate }: DashboardPageProps) {
  const { products, sales, saleItems, purchases, expenses, auditLogs, settings, loading } =
    useShopData();
  const sheetsSync = useGoogleSheetsSync();

  const todayIso = getKarachiDateIso();
  const [fromDate, setFromDate] = useState(() => addDaysToIso(todayIso, -29));
  const [toDate, setToDate] = useState(() => todayIso);
  const [salesGranularity, setSalesGranularity] = useState<SalesGranularity>('daily');
  const [overviewChartMode, setOverviewChartMode] = useState<
    'sales' | 'profit_expenses' | 'revenue_expenses' | 'profit_loss'
  >('sales');
  const [bestSellerSort, setBestSellerSort] = useState<'revenue' | 'quantity'>('revenue');
  const [inventoryChartMode, setInventoryChartMode] = useState<
    'category' | 'bestselling' | 'lowstock' | 'velocity'
  >('category');
  const [reorderMode, setReorderMode] = useState<'custom' | 'min_level'>('custom');
  const [reorderThresholdInput, setReorderThresholdInput] = useState<string>('10');
  const [expandedReorderId, setExpandedReorderId] = useState<string | null>(null);
  const [expandedAlertKey, setExpandedAlertKey] = useState<string | null>(null);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null);

  const safeThreshold = Math.max(1, Math.floor(Number(reorderThresholdInput) || 10));

  const summary = useMemo(
    () => computeDashboardSummary(products, sales, saleItems, purchases, expenses, settings),
    [products, sales, saleItems, purchases, expenses, settings]
  );

  const timeSeries = useMemo(
    () => buildSalesAndPnLSeries(sales, expenses, salesGranularity, fromDate, toDate),
    [sales, expenses, salesGranularity, fromDate, toDate]
  );

  const productPerf = useMemo(
    () => computeProductPerformance(products, saleItems, { fromDate, toDate }),
    [products, saleItems, fromDate, toDate]
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

  const categoryChartData = useMemo(() => {
    const totalCatRev = productPerf.bestCategories.reduce((sum, c) => sum + c.revenue, 0);
    return productPerf.bestCategories.slice(0, 6).map((cat) => ({
      id: cat.id,
      name: cat.name.length > 18 ? `${cat.name.slice(0, 18)}…` : cat.name,
      fullName: cat.name,
      revenue: cat.revenue,
      grossProfit: cat.grossProfit,
      qty: cat.quantitySold,
      sharePct: totalCatRev > 0 ? Math.round((cat.revenue / totalCatRev) * 1000) / 10 : 0,
    }));
  }, [productPerf.bestCategories]);

  const bestSellingRows = useMemo(() => {
    const list =
      bestSellerSort === 'revenue' ? productPerf.topByRevenue : productPerf.topByQuantity;
    return list.slice(0, 6);
  }, [bestSellerSort, productPerf.topByRevenue, productPerf.topByQuantity]);

  const inventoryHealth = useMemo(() => {
    const outCount = summary.outOfStockProducts.length;
    const lowCount = summary.lowStockProducts.length;
    const healthyCount = Math.max(0, summary.totalProducts - outCount - lowCount);
    const expiryAlertCount =
      summary.expiredProducts.filter((p) => p.currentStock > 0).length +
      summary.nearingExpiryProducts.filter((p) => p.currentStock > 0).length;
    const total = Math.max(1, summary.totalProducts);
    return {
      outCount,
      lowCount,
      healthyCount,
      expiryAlertCount,
      healthyPct: Math.round((healthyCount / total) * 100),
      lowPct: Math.round((lowCount / total) * 100),
      outPct: Math.round((outCount / total) * 100),
    };
  }, [summary]);

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
      return Array.from(catMap.values())
        .sort((a, b) => b.stock - a.stock)
        .slice(0, 8);
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

    if (inventoryChartMode === 'bestselling') {
      return productPerf.topByQuantity.slice(0, 8).map((r) => ({
        name: r.productName.length > 18 ? `${r.productName.slice(0, 18)}…` : r.productName,
        qtySold: r.quantitySold,
        revenue: r.revenue,
      }));
    }

    const sorted = [...productPerf.rows].sort((a, b) => b.quantitySold - a.quantitySold);
    const fast = sorted.slice(0, 4);
    const slow = sorted.slice(-4).reverse();
    const combined = [
      ...fast,
      ...slow.filter((s) => !fast.some((f) => f.productId === s.productId)),
    ];
    return combined.map((r) => ({
      name: r.productName.length > 16 ? `${r.productName.slice(0, 16)}…` : r.productName,
      qtySold: r.quantitySold,
      stock: r.currentStock,
    }));
  }, [inventoryChartMode, products, productPerf]);

  const recentSales = useMemo(() => sales.slice(0, 8), [sales]);

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
        return b.threshold - b.product.currentStock - (a.threshold - a.product.currentStock);
      });

    const totalEstimatedCost = rows.reduce((acc, r) => roundMoney(acc + r.estimatedCost), 0);
    return { rows, totalEstimatedCost };
  }, [products, reorderMode, safeThreshold]);

  const totalLowStockAlerts = summary.lowStockProducts.length + summary.outOfStockProducts.length;

  const secondaryMetrics = [
    {
      label: "Today's Profit",
      value: formatPKR(summary.todayProfit),
      tone: summary.todayProfit >= 0 ? 'positive' : 'negative',
    },
    { label: 'Monthly Sales', value: formatPKR(summary.monthlySales), tone: 'neutral' },
    {
      label: 'Monthly Net Profit',
      value: formatPKR(summary.monthlyNetProfit),
      tone: summary.monthlyNetProfit >= 0 ? 'positive' : 'negative',
    },
    { label: 'Total Expenses', value: formatPKR(summary.totalExpenses), tone: 'neutral' },
    { label: 'Total Purchases', value: formatPKR(summary.totalPurchases), tone: 'neutral' },
    { label: 'Inventory Value', value: formatPKR(summary.totalInventoryValue), tone: 'neutral' },
  ];

  const formatPct = (pct: number | null) => {
    if (pct === null) return 'New';
    return `${pct >= 0 ? '+' : ''}${pct}%`;
  };

  const tooltipContentStyle = {
    backgroundColor: 'var(--cm-chart-tooltip-bg)',
    borderColor: 'var(--cm-chart-tooltip-border)',
    color: 'var(--cm-text-primary)',
    borderRadius: '10px',
    fontSize: '12px',
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="cm-hero-gradient border rounded-2xl p-4 h-20 animate-pulse" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="cm-surface border rounded-2xl p-4 h-28 animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
          <div className="xl:col-span-7 cm-surface border rounded-2xl h-72 animate-pulse" />
          <div className="xl:col-span-5 cm-surface border rounded-2xl h-72 animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Top Mint-Gradient Overview Strip: Date Range & Quick Actions */}
      <section className="cm-hero-gradient border rounded-2xl p-3.5 sm:p-4 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 sm:gap-4 min-w-0">
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-bold text-[var(--cm-text-primary)] font-display truncate">
              {settings?.shopName || 'CareMart Shop Overview'}
            </h2>
            <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)] font-mono-num">
              Active period: {formatDateDDMMYYYY(fromDate)} – {formatDateDDMMYYYY(toDate)}
            </p>
          </div>

          <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs">
              <label
                htmlFor="dash-from"
                className="font-medium text-[var(--cm-text-secondary)] text-[11px] sm:text-xs shrink-0"
              >
                From
              </label>
              <input
                id="dash-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-full sm:w-auto px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs sm:text-sm cm-input border rounded-xl font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
              />
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <label
                htmlFor="dash-to"
                className="font-medium text-[var(--cm-text-secondary)] text-[11px] sm:text-xs shrink-0"
              >
                To
              </label>
              <input
                id="dash-to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-full sm:w-auto px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs sm:text-sm cm-input border rounded-xl font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onNavigate('sales')}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[40px] sm:min-h-[36px] text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-xl transition-colors whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 shrink-0" />
            <span>New Sale</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('purchases')}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[40px] sm:min-h-[36px] text-xs font-semibold text-[var(--cm-text-primary)] bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] rounded-xl transition-colors whitespace-nowrap cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 shrink-0 text-[var(--cm-accent-text)]" />
            <span>Purchase</span>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('expenses')}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[40px] sm:min-h-[36px] text-xs font-semibold text-[var(--cm-text-primary)] bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] rounded-xl transition-colors whitespace-nowrap cursor-pointer"
          >
            <Receipt className="w-3.5 h-3.5 shrink-0 text-[var(--cm-accent-text)]" />
            <span>Expense</span>
          </button>
        </div>
      </section>

      {/* Sync Failed Alert Banner with Direct Link to Settings */}
      {sheetsSync &&
        (sheetsSync.consecutiveFailures >= 3 ||
          sheetsSync.failedCount > 0 ||
          (sheetsSync.integration?.lastSyncStatus === 'error' && Boolean(sheetsSync.lastError))) && (
          <div
            role="alert"
            className="bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-2xl px-3.5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5"
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-[var(--cm-danger)] shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <div className="text-xs sm:text-sm font-semibold text-[var(--cm-danger)]">Sync Failed</div>
                <p className="text-xs text-[var(--cm-text-primary)] leading-relaxed">
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
              className="inline-flex items-center justify-center px-3 py-1.5 min-h-[36px] text-xs font-semibold text-white bg-[var(--cm-danger)] hover:opacity-90 rounded-xl transition-opacity whitespace-nowrap cursor-pointer shrink-0"
            >
              Go to Settings →
            </button>
          </div>
        )}

      {/* Supershop Primary 5 KPI Summary Cards */}
      <section aria-label="Key store metrics" className="space-y-2.5">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {/* 1. Today's Sales */}
          <div className="cm-hero-gradient border rounded-2xl p-3.5 sm:p-4 flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--cm-text-secondary)]">
                Today&apos;s Sales
              </span>
              <span className="w-8 h-8 rounded-xl bg-[var(--cm-accent-soft)] border border-[var(--cm-accent-border)] text-[var(--cm-accent-text)] flex items-center justify-center shrink-0">
                <ShoppingBag className="w-4 h-4" />
              </span>
            </div>
            <div>
              <div className="text-lg sm:text-xl font-bold font-mono-num tabular-nums tracking-tight text-[var(--cm-text-primary)] truncate">
                {formatPKR(summary.todaySales)}
              </div>
              <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums truncate mt-0.5">
                Profit: {formatPKR(summary.todayProfit)}
              </div>
            </div>
          </div>

          {/* 2. Total Sales */}
          <div className="cm-surface border rounded-2xl p-3.5 sm:p-4 flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--cm-text-secondary)]">Total Sales</span>
              <span className="w-8 h-8 rounded-xl bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] text-[var(--cm-accent-text)] flex items-center justify-center shrink-0">
                <TrendingUp className="w-4 h-4" />
              </span>
            </div>
            <div>
              <div className="text-lg sm:text-xl font-bold font-mono-num tabular-nums tracking-tight text-[var(--cm-text-primary)] truncate">
                {formatPKR(summary.overallRevenue)}
              </div>
              <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums truncate mt-0.5">
                This month: {formatPKR(summary.monthlySales)}
              </div>
            </div>
          </div>

          {/* 3. Gross Profit */}
          <div className="cm-surface border rounded-2xl p-3.5 sm:p-4 flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--cm-text-secondary)]">
                Gross Profit
              </span>
              <span className="w-8 h-8 rounded-xl bg-[var(--cm-success-soft)] border border-[var(--cm-success-border)] text-[var(--cm-success)] flex items-center justify-center shrink-0">
                <Wallet className="w-4 h-4" />
              </span>
            </div>
            <div>
              <div
                className={`text-lg sm:text-xl font-bold font-mono-num tabular-nums tracking-tight truncate ${
                  summary.overallGrossProfit >= 0
                    ? 'text-[var(--cm-success)]'
                    : 'text-[var(--cm-danger)]'
                }`}
              >
                {formatPKR(summary.overallGrossProfit)}
              </div>
              <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums truncate mt-0.5">
                Monthly: {formatPKR(summary.monthlyGrossProfit)}
              </div>
            </div>
          </div>

          {/* 4. Total Products */}
          <div className="cm-surface border rounded-2xl p-3.5 sm:p-4 flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-[var(--cm-text-secondary)]">
                Total Products
              </span>
              <span className="w-8 h-8 rounded-xl bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] text-[var(--cm-text-secondary)] flex items-center justify-center shrink-0">
                <Package className="w-4 h-4" />
              </span>
            </div>
            <div>
              <div className="text-lg sm:text-xl font-bold font-mono-num tabular-nums tracking-tight text-[var(--cm-text-primary)] truncate">
                {formatNumber(summary.totalProducts)}
              </div>
              <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums truncate mt-0.5">
                {formatNumber(summary.totalStockQuantity)} units in stock
              </div>
            </div>
          </div>

          {/* 5. Low-Stock Alerts (Subtle Pastel Yellow Highlight when alerts exist) */}
          <button
            type="button"
            onClick={() => onNavigate('inventory')}
            className={`col-span-2 sm:col-span-1 border rounded-2xl p-3.5 sm:p-4 flex flex-col justify-between gap-2 text-left transition-colors cursor-pointer ${
              totalLowStockAlerts > 0
                ? 'cm-yellow-highlight'
                : 'cm-surface hover:bg-[var(--cm-bg-hover)]'
            }`}
          >
            <div className="flex items-center justify-between gap-2 w-full">
              <span
                className={`text-xs font-medium ${
                  totalLowStockAlerts > 0
                    ? 'text-[var(--cm-yellow-text)]'
                    : 'text-[var(--cm-text-secondary)]'
                }`}
              >
                Low-Stock Alerts
              </span>
              <span
                className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border ${
                  totalLowStockAlerts > 0
                    ? 'bg-[var(--cm-bg-surface)]/80 border-[var(--cm-yellow-border)] text-[var(--cm-yellow-text)]'
                    : 'bg-[var(--cm-success-soft)] border-[var(--cm-success-border)] text-[var(--cm-success)]'
                }`}
              >
                <AlertTriangle className="w-4 h-4" />
              </span>
            </div>
            <div>
              <div
                className={`text-lg sm:text-xl font-bold font-mono-num tabular-nums tracking-tight truncate ${
                  totalLowStockAlerts > 0
                    ? 'text-[var(--cm-yellow-text)]'
                    : 'text-[var(--cm-success)]'
                }`}
              >
                {formatNumber(totalLowStockAlerts)}
              </div>
              <div
                className={`text-[11px] font-mono-num tabular-nums truncate mt-0.5 ${
                  totalLowStockAlerts > 0
                    ? 'text-[var(--cm-yellow-text)] opacity-90'
                    : 'text-[var(--cm-text-muted)]'
                }`}
              >
                {summary.lowStockProducts.length} low · {summary.outOfStockProducts.length} out of stock
              </div>
            </div>
          </button>
        </div>

        {/* Secondary Financial & Stock Metrics Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {secondaryMetrics.map((m) => {
            const valClass =
              m.tone === 'positive'
                ? 'text-[var(--cm-success)]'
                : m.tone === 'negative'
                  ? 'text-[var(--cm-danger)]'
                  : 'text-[var(--cm-text-primary)]';
            return (
              <div
                key={m.label}
                className="cm-surface border rounded-xl px-3 py-2 flex flex-col justify-between gap-0.5"
              >
                <span className="text-[11px] text-[var(--cm-text-muted)] truncate">{m.label}</span>
                <span className={`text-xs sm:text-sm font-bold font-mono-num tabular-nums truncate ${valClass}`}>
                  {m.value}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Primary Charts Split: Main Sales Overview (7 cols) + Sales by Category (5 cols) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* Main Sales Overview Chart */}
        <section className="xl:col-span-7 cm-surface border rounded-2xl p-3.5 sm:p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
            <div>
              <h2 className="text-sm sm:text-base font-bold text-[var(--cm-text-primary)] font-display">
                Sales Overview
              </h2>
              <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
                Revenue, gross profit, and expense trajectory across selected dates
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex items-center gap-0.5 p-1 bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] rounded-xl">
                {(
                  [
                    { id: 'sales', label: 'Sales' },
                    { id: 'profit_expenses', label: 'Profit & Exp' },
                    { id: 'revenue_expenses', label: 'Rev vs Exp' },
                    { id: 'profit_loss', label: 'Net P/L' },
                  ] as const
                ).map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => setOverviewChartMode(mode.id)}
                    className={`px-2 py-1 text-[11px] font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                      overviewChartMode === mode.id
                        ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-accent-text)] shadow-xs font-semibold'
                        : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-0.5 p-1 bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] rounded-xl">
                {(['daily', 'weekly', 'monthly', 'yearly'] as SalesGranularity[]).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setSalesGranularity(g)}
                    className={`px-2 py-1 text-[11px] font-medium rounded-lg capitalize transition-colors whitespace-nowrap cursor-pointer ${
                      salesGranularity === g
                        ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] shadow-xs font-semibold'
                        : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="h-60 sm:h-64">
            {timeSeries.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-xs sm:text-sm text-[var(--cm-text-muted)]">
                <span>No sales or expense records in the selected date range.</span>
                <button
                  type="button"
                  onClick={() => onNavigate('sales')}
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-xl cursor-pointer"
                >
                  Record First Sale
                </button>
              </div>
            ) : overviewChartMode === 'sales' ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeSeries} margin={{ top: 10, right: 12, left: 0, bottom: 4 }}>
                  <defs>
                    <linearGradient id="cmSalesMintFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#84cc16" stopOpacity={0.36} />
                      <stop offset="95%" stopColor="#84cc16" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--cm-chart-grid)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }} />
                  <Tooltip
                    formatter={(val) => formatPKR(Number(val ?? 0))}
                    contentStyle={tooltipContentStyle}
                  />
                  <Area
                    type="monotone"
                    dataKey="sales"
                    name="Sales (PKR)"
                    stroke="#65a30d"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#cmSalesMintFill)"
                    activeDot={{ r: 5, fill: '#84cc16' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={timeSeries} margin={{ top: 10, right: 12, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--cm-chart-grid)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }} />
                  <Tooltip
                    formatter={(val) => formatPKR(Number(val ?? 0))}
                    contentStyle={tooltipContentStyle}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  {overviewChartMode === 'profit_expenses' && (
                    <>
                      <Bar dataKey="grossProfit" name="Gross Profit" fill="#65a30d" radius={[5, 5, 0, 0]} />
                      <Bar dataKey="expenses" name="Expenses" fill="#eab308" radius={[5, 5, 0, 0]} />
                      <Line
                        type="monotone"
                        dataKey="netProfit"
                        name="Net Profit"
                        stroke="#16a34a"
                        strokeWidth={2.5}
                      />
                    </>
                  )}
                  {overviewChartMode === 'revenue_expenses' && (
                    <>
                      <Bar dataKey="sales" name="Revenue" fill="#65a30d" radius={[5, 5, 0, 0]} />
                      <Bar dataKey="expenses" name="Expenses" fill="#ef4444" radius={[5, 5, 0, 0]} />
                    </>
                  )}
                  {overviewChartMode === 'profit_loss' && (
                    <Bar dataKey="netProfit" name="Net Profit / Loss" radius={[5, 5, 0, 0]}>
                      {timeSeries.map((entry) => (
                        <Cell
                          key={entry.key}
                          fill={entry.netProfit >= 0 ? '#65a30d' : '#ef4444'}
                        />
                      ))}
                    </Bar>
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        {/* Sales by Category Chart */}
        <section className="xl:col-span-5 cm-surface border rounded-2xl p-3.5 sm:p-4 flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm sm:text-base font-bold text-[var(--cm-text-primary)] font-display">
                Sales by Category
              </h2>
              <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
                Top revenue categories in selected range
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('analytics')}
              className="text-xs font-semibold text-[var(--cm-accent-text)] hover:underline whitespace-nowrap cursor-pointer"
            >
              Analytics →
            </button>
          </div>

          {categoryChartData.length === 0 ? (
            <div className="flex-1 min-h-56 flex items-center justify-center text-xs sm:text-sm text-[var(--cm-text-muted)] text-center px-4">
              Record sales with categorized products to view revenue share by category.
            </div>
          ) : (
            <div className="space-y-3 flex-1 flex flex-col justify-between">
              <div className="h-44 sm:h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={categoryChartData}
                    layout="vertical"
                    margin={{ top: 4, right: 12, left: 4, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--cm-chart-grid)"
                      horizontal={false}
                    />
                    <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--cm-chart-tick)' }} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={110}
                      tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }}
                    />
                    <Tooltip
                      formatter={(val) => [formatPKR(Number(val ?? 0)), 'Revenue']}
                      labelFormatter={(_, payload) =>
                        payload?.[0]?.payload?.fullName ? String(payload[0].payload.fullName) : ''
                      }
                      contentStyle={tooltipContentStyle}
                    />
                    <Bar dataKey="revenue" name="Revenue (PKR)" radius={[0, 6, 6, 0]} maxBarSize={20}>
                      {categoryChartData.map((entry, idx) => (
                        <Cell
                          key={entry.id}
                          fill={CATEGORY_BAR_COLORS[idx % CATEGORY_BAR_COLORS.length]}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pt-2 border-t border-[var(--cm-border)] text-xs">
                {categoryChartData.map((cat, idx) => (
                  <div key={cat.id} className="flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-xs shrink-0"
                        style={{
                          backgroundColor: CATEGORY_BAR_COLORS[idx % CATEGORY_BAR_COLORS.length],
                        }}
                      />
                      <span className="truncate text-[var(--cm-text-secondary)]">{cat.fullName}</span>
                    </div>
                    <span className="font-mono-num tabular-nums font-semibold text-[var(--cm-text-primary)] shrink-0">
                      {cat.sharePct}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Operational Split: Best-Selling Products (6 cols) + Inventory Summary & Insights (6 cols) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* Best-Selling Products Section */}
        <section className="xl:col-span-6 cm-surface border rounded-2xl p-3.5 sm:p-4 space-y-3 flex flex-col justify-between">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm sm:text-base font-bold text-[var(--cm-text-primary)] font-display">
                Best-Selling Products
              </h2>
              <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
                Top movers in selected period
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] rounded-xl">
              <button
                type="button"
                onClick={() => setBestSellerSort('revenue')}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-lg transition-colors cursor-pointer ${
                  bestSellerSort === 'revenue'
                    ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-accent-text)] shadow-xs font-semibold'
                    : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
                }`}
              >
                By Revenue
              </button>
              <button
                type="button"
                onClick={() => setBestSellerSort('quantity')}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-lg transition-colors cursor-pointer ${
                  bestSellerSort === 'quantity'
                    ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-accent-text)] shadow-xs font-semibold'
                    : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
                }`}
              >
                By Qty
              </button>
            </div>
          </div>

          {bestSellingRows.length === 0 ? (
            <div className="py-10 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
              No product sales recorded for the selected date range yet.
            </div>
          ) : (
            <div className="divide-y divide-[var(--cm-border)]">
              {bestSellingRows.map((item, idx) => (
                <div
                  key={item.productId}
                  className="py-2.5 flex items-center justify-between gap-3 text-xs sm:text-sm"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span className="w-6 h-6 rounded-lg bg-[var(--cm-accent-soft)] border border-[var(--cm-accent-border)] text-[var(--cm-accent-text)] font-mono-num text-[11px] font-bold flex items-center justify-center shrink-0">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium text-[var(--cm-text-primary)] truncate">
                        {item.productName}
                      </div>
                      <div className="text-[11px] text-[var(--cm-text-muted)] truncate">
                        {item.categoryName} · {item.brandName} ·{' '}
                        <span className="font-mono-num">
                          {formatNumber(item.quantitySold)} {item.unit} sold
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)]">
                      {formatPKR(item.revenue)}
                    </div>
                    <div className="text-[11px] font-mono-num tabular-nums text-[var(--cm-success)]">
                      Profit {formatPKR(item.grossProfit)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="pt-2 border-t border-[var(--cm-border)] flex items-center justify-between text-xs">
            <span className="text-[var(--cm-text-muted)]">
              Showing top {bestSellingRows.length} products
            </span>
            <button
              type="button"
              onClick={() => onNavigate('analytics')}
              className="font-semibold text-[var(--cm-accent-text)] hover:underline cursor-pointer"
            >
              View Product Rankings →
            </button>
          </div>
        </section>

        {/* Inventory Summary & Insights Section */}
        <section className="xl:col-span-6 cm-surface border rounded-2xl p-3.5 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Boxes className="w-4 h-4 text-[var(--cm-accent-text)] shrink-0" />
              <div>
                <h2 className="text-sm sm:text-base font-bold text-[var(--cm-text-primary)] font-display">
                  Inventory Summary
                </h2>
                <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
                  Stock health indicators &amp; product movement
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('inventory')}
              className="text-xs font-semibold text-[var(--cm-accent-text)] hover:underline whitespace-nowrap cursor-pointer"
            >
              Manage Stock →
            </button>
          </div>

          {/* 4 Stock Health Indicators */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="p-2.5 rounded-xl bg-[var(--cm-success-soft)] border border-[var(--cm-success-border)]">
              <div className="text-[11px] text-[var(--cm-success)] font-medium">In Stock</div>
              <div className="text-base font-bold font-mono-num tabular-nums text-[var(--cm-success)]">
                {formatNumber(inventoryHealth.healthyCount)}
              </div>
            </div>
            <div className="p-2.5 rounded-xl cm-yellow-highlight border">
              <div className="text-[11px] font-medium">Low Stock</div>
              <div className="text-base font-bold font-mono-num tabular-nums">
                {formatNumber(inventoryHealth.lowCount)}
              </div>
            </div>
            <div className="p-2.5 rounded-xl bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)]">
              <div className="text-[11px] text-[var(--cm-danger)] font-medium">Out of Stock</div>
              <div className="text-base font-bold font-mono-num tabular-nums text-[var(--cm-danger)]">
                {formatNumber(inventoryHealth.outCount)}
              </div>
            </div>
            <div className="p-2.5 rounded-xl cm-subtle border">
              <div className="text-[11px] text-[var(--cm-text-secondary)] font-medium">
                Expiry Alerts
              </div>
              <div className="text-base font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)]">
                {formatNumber(inventoryHealth.expiryAlertCount)}
              </div>
            </div>
          </div>

          {/* Multi-segment Stock Health Bar */}
          {summary.totalProducts > 0 && (
            <div className="space-y-1">
              <div className="h-2 w-full rounded-full overflow-hidden bg-[var(--cm-bg-subtle)] flex">
                {inventoryHealth.healthyPct > 0 && (
                  <div
                    style={{ width: `${inventoryHealth.healthyPct}%` }}
                    className="h-full bg-[#65a30d]"
                    title={`Healthy: ${inventoryHealth.healthyCount}`}
                  />
                )}
                {inventoryHealth.lowPct > 0 && (
                  <div
                    style={{ width: `${inventoryHealth.lowPct}%` }}
                    className="h-full bg-[#eab308]"
                    title={`Low Stock: ${inventoryHealth.lowCount}`}
                  />
                )}
                {inventoryHealth.outPct > 0 && (
                  <div
                    style={{ width: `${inventoryHealth.outPct}%` }}
                    className="h-full bg-[#ef4444]"
                    title={`Out of Stock: ${inventoryHealth.outCount}`}
                  />
                )}
              </div>
              <div className="flex items-center justify-between text-[11px] text-[var(--cm-text-muted)] font-mono-num">
                <span>Healthy {inventoryHealth.healthyPct}%</span>
                <span>Low {inventoryHealth.lowPct}% · Out {inventoryHealth.outPct}%</span>
              </div>
            </div>
          )}

          {/* Inventory Insights Chart Tabs */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="text-xs font-semibold text-[var(--cm-text-secondary)]">
              Stock Distribution
            </span>
            <div className="flex flex-wrap items-center gap-0.5 p-1 bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] rounded-xl">
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
                  className={`px-2 py-1 text-[11px] font-medium rounded-lg transition-colors cursor-pointer ${
                    inventoryChartMode === tab.id
                      ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-accent-text)] shadow-xs font-semibold'
                      : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="h-44 sm:h-48">
            {inventoryChartData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
                No matching product data to display.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={inventoryChartData}
                  margin={{ top: 6, right: 10, left: 0, bottom: 2 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--cm-chart-grid)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: 'var(--cm-chart-tick)' }} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--cm-chart-tick)' }} />
                  <Tooltip contentStyle={tooltipContentStyle} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  {inventoryChartMode === 'category' && (
                    <Bar dataKey="stock" name="Units in Stock" fill="#65a30d" radius={[5, 5, 0, 0]} />
                  )}
                  {inventoryChartMode === 'bestselling' && (
                    <Bar dataKey="qtySold" name="Qty Sold" fill="#84cc16" radius={[5, 5, 0, 0]} />
                  )}
                  {inventoryChartMode === 'lowstock' && (
                    <>
                      <Bar dataKey="stock" name="Current Stock" fill="#eab308" radius={[5, 5, 0, 0]} />
                      <Bar dataKey="minLevel" name="Min Level" fill="#94a3b8" radius={[5, 5, 0, 0]} />
                    </>
                  )}
                  {inventoryChartMode === 'velocity' && (
                    <>
                      <Bar dataKey="qtySold" name="Units Sold" fill="#65a30d" radius={[5, 5, 0, 0]} />
                      <Bar dataKey="stock" name="Current Stock" fill="#64748b" radius={[5, 5, 0, 0]} />
                    </>
                  )}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>
      </div>

      {/* Recent Sales / Transactions Table */}
      <CompactSection
        title="Recent Sales & Transactions"
        subtitle="Latest customer bills recorded in CareMart"
        icon={<ShoppingBag className="w-4 h-4 text-[var(--cm-accent-text)]" />}
        summary={`${recentSales.length} shown`}
        collapsible
        defaultOpen
        actions={
          <button
            type="button"
            onClick={() => onNavigate('sales')}
            className="text-xs font-semibold text-[var(--cm-accent-text)] hover:underline whitespace-nowrap cursor-pointer"
          >
            Open Sales →
          </button>
        }
      >
        {recentSales.length === 0 ? (
          <div className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm text-[var(--cm-text-muted)]">
            <span>No sales recorded yet. Start by recording your first customer sale.</span>
            <button
              type="button"
              onClick={() => onNavigate('sales')}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-xl cursor-pointer"
            >
              Record Sale
            </button>
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                    <th className="py-2.5 px-3.5">Sale #</th>
                    <th className="py-2.5 px-3">Date &amp; Time</th>
                    <th className="py-2.5 px-3">Recorded By</th>
                    <th className="py-2.5 px-3 text-right">Qty</th>
                    <th className="py-2.5 px-3">Payment</th>
                    <th className="py-2.5 px-3">Customer WhatsApp</th>
                    <th className="py-2.5 px-3 text-right">Total</th>
                    <th className="py-2.5 px-3 text-right">Profit</th>
                    <th className="py-2.5 px-3.5">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                  {recentSales.map((sale) => {
                    const isCancelled = sale.status === 'cancelled';
                    return (
                      <tr
                        key={sale.id}
                        className={`hover:bg-[var(--cm-bg-hover)] ${isCancelled ? 'opacity-60' : ''}`}
                      >
                        <td className="py-2.5 px-3.5 font-mono-num font-semibold text-[var(--cm-text-primary)] whitespace-nowrap">
                          {sale.saleNumber}
                        </td>
                        <td className="py-2.5 px-3 font-mono-num text-xs text-[var(--cm-text-muted)] whitespace-nowrap">
                          {sale.saleDateTime || formatDateDDMMYYYY(sale.saleDate)}
                        </td>
                        <td className="py-2.5 px-3 text-xs font-medium text-[var(--cm-text-secondary)] whitespace-nowrap">
                          {formatSaleSellerLabel(sale)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono-num tabular-nums text-[var(--cm-text-primary)]">
                          {formatNumber(sale.totalQuantity)}
                        </td>
                        <td className="py-2.5 px-3 text-xs capitalize text-[var(--cm-text-secondary)]">
                          {sale.paymentMethod}
                        </td>
                        <td className="py-2.5 px-3 text-xs font-mono-num text-[var(--cm-text-muted)]">
                          {sale.customerWhatsapp || '—'}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono-num tabular-nums font-semibold text-[var(--cm-text-primary)] whitespace-nowrap">
                          {formatPKR(sale.totalAmount)}
                        </td>
                        <td
                          className={`py-2.5 px-3 text-right font-mono-num tabular-nums font-semibold whitespace-nowrap ${
                            isCancelled
                              ? 'text-[var(--cm-text-muted)]'
                              : sale.totalProfit >= 0
                                ? 'text-[var(--cm-success)]'
                                : 'text-[var(--cm-danger)]'
                          }`}
                        >
                          {formatPKR(sale.totalProfit)}
                        </td>
                        <td
                          className={`py-2.5 px-3.5 text-xs font-semibold capitalize whitespace-nowrap ${
                            isCancelled ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-success)]'
                          }`}
                        >
                          {isCancelled ? 'Cancelled' : 'Completed'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-[var(--cm-border)]">
              {recentSales.map((sale) => {
                const isCancelled = sale.status === 'cancelled';
                return (
                  <CompactExpandableRow
                    key={sale.id}
                    dimmed={isCancelled}
                    title={sale.saleNumber}
                    subtitle={`${sale.saleDateTime || formatDateDDMMYYYY(sale.saleDate)} · ${sale.paymentMethod}`}
                    rightPrimary={formatPKR(sale.totalAmount)}
                    rightSecondary={
                      isCancelled ? 'Cancelled' : `Profit ${formatPKR(sale.totalProfit)}`
                    }
                    isExpanded={expandedSaleId === sale.id}
                    onToggle={() =>
                      setExpandedSaleId((prev) => (prev === sale.id ? null : sale.id))
                    }
                    expandedContent={
                      <div className="grid grid-cols-2 gap-2 text-[var(--cm-text-secondary)]">
                        <div className="col-span-2">
                          Recorded By:{' '}
                          <strong className="text-[var(--cm-text-primary)]">
                            {formatSaleSellerLabel(sale)}
                          </strong>
                        </div>
                        <div>
                          Quantity:{' '}
                          <strong className="font-mono-num text-[var(--cm-text-primary)]">
                            {formatNumber(sale.totalQuantity)}
                          </strong>
                        </div>
                        <div>
                          Status:{' '}
                          <strong
                            className={
                              isCancelled ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-success)]'
                            }
                          >
                            {isCancelled ? 'Cancelled' : 'Completed'}
                          </strong>
                        </div>
                        {sale.customerWhatsapp && (
                          <div className="col-span-2">
                            WhatsApp:{' '}
                            <strong className="font-mono-num text-[var(--cm-text-primary)]">
                              {sale.customerWhatsapp}
                            </strong>
                          </div>
                        )}
                      </div>
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </CompactSection>

      {/* Month-over-Month Business Growth Chart */}
      <section className="cm-surface border rounded-2xl p-3.5 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm sm:text-base font-bold text-[var(--cm-text-primary)] font-display">
              Business Growth (Month-over-Month)
            </h2>
            <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
              {monthlyComp.currentLabel} vs {monthlyComp.previousLabel}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-1">
              <span className="text-[var(--cm-text-muted)]">Rev:</span>
              <span
                className={`font-semibold font-mono-num inline-flex items-center ${
                  (monthlyComp.revenueGrowthPct ?? 0) >= 0
                    ? 'text-[var(--cm-success)]'
                    : 'text-[var(--cm-danger)]'
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
              <span className="text-[var(--cm-text-muted)]">Profit:</span>
              <span
                className={`font-semibold font-mono-num inline-flex items-center ${
                  (monthlyComp.profitGrowthPct ?? 0) >= 0
                    ? 'text-[var(--cm-success)]'
                    : 'text-[var(--cm-danger)]'
                }`}
              >
                {formatPct(monthlyComp.profitGrowthPct)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[var(--cm-text-muted)]">Exp:</span>
              <span className="font-semibold font-mono-num text-[var(--cm-text-secondary)]">
                {formatPct(monthlyComp.expenseGrowthPct)}
              </span>
            </div>
          </div>
        </div>

        <div className="h-52 sm:h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={growthChartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--cm-chart-grid)" vertical={false} />
              <XAxis dataKey="metric" tick={{ fontSize: 12, fill: 'var(--cm-chart-tick)' }} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--cm-chart-tick)' }} />
              <Tooltip
                formatter={(val) => formatPKR(Number(val ?? 0))}
                contentStyle={tooltipContentStyle}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar
                dataKey="Previous"
                name={monthlyComp.previousLabel}
                fill="#94a3b8"
                radius={[5, 5, 0, 0]}
              />
              <Bar
                dataKey="Current"
                name={monthlyComp.currentLabel}
                fill="#65a30d"
                radius={[5, 5, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Proactive Reorder Watchlist Widget */}
      <CompactSection
        title="Proactive Reorder Watchlist"
        subtitle={
          reorderMode === 'custom'
            ? `Active stock < ${safeThreshold} units · Est. ${formatPKR(reorderCandidates.totalEstimatedCost)}`
            : `At/below min level · Est. ${formatPKR(reorderCandidates.totalEstimatedCost)}`
        }
        icon={<ShoppingCart className="w-4 h-4 text-[var(--cm-accent-text)]" />}
        summary={`${reorderCandidates.rows.length} items`}
        collapsible
        defaultOpen
        actions={
          <button
            type="button"
            onClick={() => onNavigate('purchases')}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Create PO
          </button>
        }
      >
        <div className="px-3.5 py-2.5 border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 p-1 bg-[var(--cm-bg-app)] border border-[var(--cm-border)] rounded-xl">
            <button
              type="button"
              onClick={() => setReorderMode('custom')}
              className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                reorderMode === 'custom'
                  ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] shadow-xs font-semibold'
                  : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
              }`}
            >
              Custom Threshold
            </button>
            <button
              type="button"
              onClick={() => setReorderMode('min_level')}
              className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                reorderMode === 'min_level'
                  ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] shadow-xs font-semibold'
                  : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
              }`}
            >
              Product Min
            </button>
          </div>

          {reorderMode === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs">
              <label
                htmlFor="reorder-threshold-input"
                className="text-[var(--cm-text-secondary)] font-medium whitespace-nowrap"
              >
                Below:
              </label>
              <input
                id="reorder-threshold-input"
                type="number"
                min={1}
                max={9999}
                value={reorderThresholdInput}
                onChange={(e) => setReorderThresholdInput(e.target.value)}
                className="w-16 px-2 py-1 text-xs cm-input border rounded-lg font-mono-num tabular-nums focus:outline-none focus:border-[var(--cm-accent)]"
              />
              <div className="flex items-center gap-1">
                {[5, 10, 20].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setReorderThresholdInput(String(preset))}
                    className={`px-2 py-1 text-xs font-mono-num rounded-lg border transition-colors cursor-pointer ${
                      safeThreshold === preset
                        ? 'bg-[var(--cm-accent-soft)] border-[var(--cm-accent-border)] text-[var(--cm-accent-text)] font-semibold'
                        : 'bg-[var(--cm-bg-surface)] border-[var(--cm-border)] text-[var(--cm-text-secondary)] hover:bg-[var(--cm-bg-hover)]'
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
          <div className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs sm:text-sm text-[var(--cm-text-muted)]">
            <span>Add products to monitor inventory thresholds and generate reorder suggestions.</span>
            <button
              type="button"
              onClick={() => onNavigate('products')}
              className="px-3 py-1.5 text-xs font-semibold text-[var(--cm-accent-text)] border border-[var(--cm-accent-border)] hover:bg-[var(--cm-accent-soft)] rounded-xl cursor-pointer"
            >
              Add First Product
            </button>
          </div>
        ) : reorderCandidates.rows.length === 0 ? (
          <div className="p-4 text-xs sm:text-sm text-[var(--cm-text-muted)]">
            {reorderMode === 'custom'
              ? `All active products have ${safeThreshold} or more units in stock.`
              : 'All active products are currently above their configured minimum stock levels.'}
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                    <th className="py-2 px-3">Product</th>
                    <th className="py-2 px-3 text-right">Stock</th>
                    <th className="py-2 px-3 text-right">Threshold</th>
                    <th className="py-2 px-3 text-right">Suggested</th>
                    <th className="py-2 px-3 text-right">Est. Cost</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                  {reorderCandidates.rows
                    .slice(0, 12)
                    .map(({ product, threshold, suggestedOrderQty, estimatedCost }) => {
                      const isOut = product.currentStock <= 0;
                      const baseUnit = getEffectiveBaseUnit(product);
                      const breakdown = formatStockBreakdown(product.currentStock, product);
                      return (
                        <tr key={product.id} className="hover:bg-[var(--cm-bg-hover)]">
                          <td className="py-2 px-3">
                            <div className="font-medium text-[var(--cm-text-primary)]">
                              {product.name}
                            </div>
                            <div className="text-[11px] text-[var(--cm-text-muted)]">
                              {product.categoryName} · {product.brandName}
                              {product.supplierName ? ` · ${product.supplierName}` : ''}
                            </div>
                          </td>
                          <td
                            className={`py-2 px-3 text-right font-mono-num tabular-nums font-semibold ${
                              isOut ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-warning)]'
                            }`}
                          >
                            <div>{breakdown.totalLabel}</div>
                            {breakdown.packageBreakdownText && (
                              <div className="text-[10px] font-normal text-[var(--cm-text-muted)]">
                                ({breakdown.packageBreakdownText})
                              </div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num tabular-nums text-[var(--cm-text-muted)]">
                            {formatNumber(threshold)} {baseUnit}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num tabular-nums font-semibold text-[var(--cm-text-primary)]">
                            +{formatNumber(suggestedOrderQty)} {baseUnit}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num tabular-nums text-[var(--cm-text-secondary)]">
                            {formatPKR(estimatedCost)}
                          </td>
                          <td
                            className={`py-2 px-3 text-xs font-semibold whitespace-nowrap ${
                              isOut ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-warning)]'
                            }`}
                          >
                            {isOut ? 'Out of Stock' : 'Below Threshold'}
                          </td>
                          <td className="py-2 px-3 text-right">
                            <button
                              type="button"
                              onClick={() => onNavigate('purchases')}
                              className="text-xs font-semibold text-[var(--cm-accent-text)] hover:underline whitespace-nowrap cursor-pointer"
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

            <div className="md:hidden divide-y divide-[var(--cm-border)]">
              {reorderCandidates.rows
                .slice(0, 12)
                .map(({ product, threshold, suggestedOrderQty, estimatedCost }) => {
                  const isOut = product.currentStock <= 0;
                  const baseUnit = getEffectiveBaseUnit(product);
                  const breakdown = formatStockBreakdown(product.currentStock, product);
                  return (
                    <CompactExpandableRow
                      key={product.id}
                      title={product.name}
                      subtitle={`${breakdown.summaryText} left · Min ${threshold}`}
                      rightPrimary={
                        <span
                          className={
                            isOut ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-warning)]'
                          }
                        >
                          +{formatNumber(suggestedOrderQty)} {baseUnit}
                        </span>
                      }
                      rightSecondary={formatPKR(estimatedCost)}
                      isExpanded={expandedReorderId === product.id}
                      onToggle={() =>
                        setExpandedReorderId((prev) => (prev === product.id ? null : product.id))
                      }
                      expandedContent={
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-2 text-[var(--cm-text-secondary)]">
                            <div>
                              Category:{' '}
                              <span className="text-[var(--cm-text-primary)] font-medium">
                                {product.categoryName}
                              </span>
                            </div>
                            <div>
                              Brand:{' '}
                              <span className="text-[var(--cm-text-primary)] font-medium">
                                {product.brandName}
                              </span>
                            </div>
                            {product.supplierName && (
                              <div className="col-span-2">
                                Supplier:{' '}
                                <span className="text-[var(--cm-text-primary)] font-medium">
                                  {product.supplierName}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="flex items-center justify-between pt-1">
                            <span
                              className={`font-semibold ${
                                isOut ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-warning)]'
                              }`}
                            >
                              {isOut ? 'Out of Stock' : 'Below Threshold'}
                            </span>
                            <button
                              type="button"
                              onClick={() => onNavigate('purchases')}
                              className="px-3 py-1.5 text-xs font-semibold text-[var(--cm-accent-text)] bg-[var(--cm-bg-surface)] border border-[var(--cm-accent-border)] rounded-xl cursor-pointer"
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
          ...summary.outOfStockProducts.map((p) => ({
            p,
            alert: 'Out of Stock',
            tone: 'text-[var(--cm-danger)]',
          })),
          ...summary.lowStockProducts.map((p) => ({
            p,
            alert: 'Low Stock',
            tone: 'text-[var(--cm-warning)]',
          })),
          ...summary.expiredProducts
            .filter((p) => p.currentStock > 0)
            .map((p) => ({ p, alert: 'Expired', tone: 'text-[var(--cm-danger)]' })),
          ...summary.nearingExpiryProducts
            .filter((p) => p.currentStock > 0)
            .map((p) => ({ p, alert: 'Nearing Expiry', tone: 'text-[var(--cm-warning)]' })),
        ].slice(0, 12);

        return (
          <CompactSection
            title="Low Stock & Expiry Alerts"
            icon={<AlertTriangle className="w-4 h-4 text-[var(--cm-warning)]" />}
            summary={alertItems.length > 0 ? `${alertItems.length} alerts` : 'Clear'}
            collapsible
            defaultOpen={false}
            actions={
              <button
                type="button"
                onClick={() => onNavigate('inventory')}
                className="text-xs font-semibold text-[var(--cm-accent-text)] hover:underline cursor-pointer"
              >
                Inventory →
              </button>
            }
          >
            {alertItems.length === 0 ? (
              <div className="p-4 text-xs sm:text-sm text-[var(--cm-text-muted)]">
                {products.length === 0
                  ? 'Add products in the Products page to monitor stock levels and expiry dates.'
                  : 'All products are above minimum stock levels with no expiry alerts.'}
              </div>
            ) : (
              <>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                        <th className="py-2 px-3">Product</th>
                        <th className="py-2 px-3">Category · Brand</th>
                        <th className="py-2 px-3 text-right">Stock</th>
                        <th className="py-2 px-3 text-right">Min</th>
                        <th className="py-2 px-3">Expiry</th>
                        <th className="py-2 px-3">Alert</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                      {alertItems.map(({ p, alert, tone }, idx) => {
                        const baseUnit = getEffectiveBaseUnit(p);
                        return (
                          <tr key={`${p.id}-${alert}-${idx}`} className="hover:bg-[var(--cm-bg-hover)]">
                            <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">
                              {p.name}
                            </td>
                            <td className="py-2 px-3 text-xs text-[var(--cm-text-muted)]">
                              {p.categoryName} · {p.brandName}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">
                              {formatStockBreakdown(p.currentStock, p).summaryText}
                            </td>
                            <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-muted)]">
                              {p.minStockLevel} {baseUnit}
                            </td>
                            <td className="py-2 px-3 font-mono-num text-[var(--cm-text-secondary)]">
                              {p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—'}
                            </td>
                            <td className={`py-2 px-3 text-xs font-semibold ${tone}`}>{alert}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="md:hidden divide-y divide-[var(--cm-border)]">
                  {alertItems.map(({ p, alert, tone }, idx) => {
                    const rowKey = `${p.id}-${alert}-${idx}`;
                    const baseUnit = getEffectiveBaseUnit(p);
                    return (
                      <CompactExpandableRow
                        key={rowKey}
                        title={p.name}
                        subtitle={`${p.categoryName} · ${p.brandName}`}
                        rightPrimary={<span className={tone}>{alert}</span>}
                        rightSecondary={`${p.currentStock} / ${p.minStockLevel} ${baseUnit}`}
                        isExpanded={expandedAlertKey === rowKey}
                        onToggle={() =>
                          setExpandedAlertKey((prev) => (prev === rowKey ? null : rowKey))
                        }
                        expandedContent={
                          <div className="flex flex-wrap items-center justify-between gap-2 text-[var(--cm-text-secondary)]">
                            <span>
                              Expiry:{' '}
                              <strong className="font-mono-num text-[var(--cm-text-primary)]">
                                {p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—'}
                              </strong>
                            </span>
                            <button
                              type="button"
                              onClick={() => onNavigate('inventory')}
                              className="px-2.5 py-1 text-xs font-semibold text-[var(--cm-accent-text)] bg-[var(--cm-bg-surface)] border border-[var(--cm-accent-border)] rounded-xl cursor-pointer"
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
        icon={<Activity className="w-4 h-4 text-[var(--cm-accent-text)]" />}
        summary={`${Math.min(auditLogs.length, 8)} recent`}
        collapsible
        defaultOpen={false}
        actions={
          <button
            type="button"
            onClick={() => onNavigate('activity')}
            className="text-xs font-semibold text-[var(--cm-accent-text)] hover:underline whitespace-nowrap cursor-pointer"
          >
            View All →
          </button>
        }
      >
        {auditLogs.length === 0 ? (
          <div className="p-4 text-xs sm:text-sm text-[var(--cm-text-muted)]">
            No user activity recorded yet. Edits to sales, stock adjustments, and staff logins will
            appear here.
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                    <th className="py-2 px-3 whitespace-nowrap">Timestamp (PKT)</th>
                    <th className="py-2 px-3 whitespace-nowrap">Module</th>
                    <th className="py-2 px-3 whitespace-nowrap">Action</th>
                    <th className="py-2 px-3">Summary</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                  {auditLogs.slice(0, 8).map((log) => {
                    const meta = getActivityActionMeta(log);
                    return (
                      <tr key={log.id} className="hover:bg-[var(--cm-bg-hover)]">
                        <td className="py-2 px-3 font-mono-num tabular-nums text-xs text-[var(--cm-text-muted)] whitespace-nowrap">
                          {formatAuditTimestamp(log.createdAt)}
                        </td>
                        <td className="py-2 px-3 text-xs font-medium text-[var(--cm-text-secondary)] whitespace-nowrap">
                          {meta.categoryLabel}
                        </td>
                        <td
                          className={`py-2 px-3 text-xs font-semibold whitespace-nowrap ${meta.toneClass}`}
                        >
                          {meta.actionLabel}
                        </td>
                        <td className="py-2 px-3 text-xs text-[var(--cm-text-primary)]">
                          {log.summary}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-[var(--cm-border)]">
              {auditLogs.slice(0, 8).map((log) => {
                const meta = getActivityActionMeta(log);
                return (
                  <CompactExpandableRow
                    key={log.id}
                    title={log.summary}
                    subtitle={`${formatAuditTimestamp(log.createdAt)} · ${meta.categoryLabel}`}
                    rightPrimary={<span className={meta.toneClass}>{meta.actionLabel}</span>}
                    isExpanded={expandedLogId === log.id}
                    onToggle={() =>
                      setExpandedLogId((prev) => (prev === log.id ? null : log.id))
                    }
                    expandedContent={
                      <div className="text-[var(--cm-text-secondary)] space-y-1">
                        <div className="text-[var(--cm-text-primary)]">{log.summary}</div>
                        <div className="font-mono-num text-[11px] text-[var(--cm-text-muted)]">
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
        <section className="cm-surface border rounded-2xl px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 text-xs sm:text-sm">
            <FileSpreadsheet className="w-4 h-4 text-[var(--cm-accent-text)] shrink-0" />
            <span className="font-semibold text-[var(--cm-text-primary)]">Google Sheets:</span>
            <span
              className={`font-medium ${
                sheetsSync.isSyncing
                  ? 'text-[var(--cm-accent-text)]'
                  : sheetsSync.consecutiveFailures >= 3 ||
                      sheetsSync.failedCount > 0 ||
                      (sheetsSync.integration?.lastSyncStatus === 'error' &&
                        Boolean(sheetsSync.lastError))
                    ? 'text-[var(--cm-danger)]'
                    : sheetsSync.sheetsAuthorized && sheetsSync.integration?.spreadsheetId
                      ? 'text-[var(--cm-success)]'
                      : 'text-[var(--cm-text-secondary)]'
              }`}
            >
              {sheetsSync.isSyncing
                ? 'Syncing...'
                : sheetsSync.consecutiveFailures >= 3 ||
                    sheetsSync.failedCount > 0 ||
                    (sheetsSync.integration?.lastSyncStatus === 'error' &&
                      Boolean(sheetsSync.lastError))
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
                className="text-xs font-semibold text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]"
              >
                Open Sheet
              </a>
            )}
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              className="text-xs font-semibold text-[var(--cm-accent-text)] hover:underline cursor-pointer"
            >
              Go to Settings →
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
