import type {
  Expense,
  Product,
  Purchase,
  Sale,
  SaleItem,
  ShopSettings,
} from '../types/shop';
import {
  addDaysToIso,
  formatDateDDMMYYYY,
  formatMonthLabel,
  getKarachiDateIso,
  getMonthKey,
  getPreviousMonthKey,
  getProductStockStatus,
  roundMoney,
} from '../utils/formatters';

export interface DashboardSummary {
  todaySales: number;
  todayProfit: number;
  monthlySales: number;
  monthlyCogs: number;
  monthlyGrossProfit: number;
  monthlyExpenses: number;
  monthlyNetProfit: number;
  totalExpenses: number;
  totalProducts: number;
  totalStockQuantity: number;
  totalInventoryValue: number;
  lowStockProducts: Product[];
  outOfStockProducts: Product[];
  nearingExpiryProducts: Product[];
  expiredProducts: Product[];
  monthlyPurchases: number;
  totalPurchases: number;
  overallRevenue: number;
  overallCogs: number;
  overallGrossProfit: number;
  overallNetProfit: number;
}

export function computeDashboardSummary(
  products: Product[],
  sales: Sale[],
  saleItems: SaleItem[],
  purchases: Purchase[],
  expenses: Expense[],
  settings: ShopSettings | null
): DashboardSummary {
  const todayIso = getKarachiDateIso();
  const currentMonth = getMonthKey(todayIso);
  const expiryAlertDays = settings?.expiryAlertDays ?? 30;

  const activeSales = sales.filter((s) => s.status !== 'cancelled');
  const activeItems = saleItems.filter((i) => i.status !== 'cancelled');
  const activePurchases = purchases.filter((p) => p.status !== 'cancelled');

  let todaySales = 0;
  let todayProfit = 0;
  let monthlySales = 0;
  let monthlyCogs = 0;
  let overallRevenue = 0;
  let overallCogs = 0;

  for (const s of activeSales) {
    overallRevenue = roundMoney(overallRevenue + s.totalAmount);
    if (s.saleDate === todayIso) {
      todaySales = roundMoney(todaySales + s.totalAmount);
      todayProfit = roundMoney(todayProfit + s.totalProfit);
    }
    if (getMonthKey(s.saleDate) === currentMonth) {
      monthlySales = roundMoney(monthlySales + s.totalAmount);
    }
  }

  for (const item of activeItems) {
    overallCogs = roundMoney(overallCogs + item.lineCost);
    if (getMonthKey(item.saleDate) === currentMonth) {
      monthlyCogs = roundMoney(monthlyCogs + item.lineCost);
    }
  }

  let monthlyExpenses = 0;
  let totalExpenses = 0;
  for (const e of expenses) {
    totalExpenses = roundMoney(totalExpenses + e.amount);
    if (getMonthKey(e.expenseDate) === currentMonth) {
      monthlyExpenses = roundMoney(monthlyExpenses + e.amount);
    }
  }

  let monthlyPurchases = 0;
  let totalPurchases = 0;
  for (const p of activePurchases) {
    totalPurchases = roundMoney(totalPurchases + p.totalAmount);
    if (getMonthKey(p.purchaseDate) === currentMonth) {
      monthlyPurchases = roundMoney(monthlyPurchases + p.totalAmount);
    }
  }

  const monthlyGrossProfit = roundMoney(monthlySales - monthlyCogs);
  const monthlyNetProfit = roundMoney(monthlyGrossProfit - monthlyExpenses);
  const overallGrossProfit = roundMoney(overallRevenue - overallCogs);
  const overallNetProfit = roundMoney(overallGrossProfit - totalExpenses);

  let totalStockQuantity = 0;
  let totalInventoryValue = 0;
  const lowStockProducts: Product[] = [];
  const outOfStockProducts: Product[] = [];
  const nearingExpiryProducts: Product[] = [];
  const expiredProducts: Product[] = [];

  for (const p of products) {
    totalStockQuantity += p.currentStock;
    totalInventoryValue = roundMoney(totalInventoryValue + p.currentStock * p.purchasePrice);
    const status = getProductStockStatus(p, todayIso, expiryAlertDays);
    if (status.isOutOfStock) outOfStockProducts.push(p);
    else if (status.isLowStock) lowStockProducts.push(p);

    if (status.isExpired) expiredProducts.push(p);
    else if (status.isNearingExpiry) nearingExpiryProducts.push(p);
  }

  return {
    todaySales,
    todayProfit,
    monthlySales,
    monthlyCogs,
    monthlyGrossProfit,
    monthlyExpenses,
    monthlyNetProfit,
    totalExpenses,
    totalProducts: products.length,
    totalStockQuantity,
    totalInventoryValue,
    lowStockProducts,
    outOfStockProducts,
    nearingExpiryProducts,
    expiredProducts,
    monthlyPurchases,
    totalPurchases,
    overallRevenue,
    overallCogs,
    overallGrossProfit,
    overallNetProfit,
  };
}

export type SalesGranularity = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface SalesChartPoint {
  label: string;
  key: string;
  sales: number;
  cogs: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
}

function getIsoWeekKey(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(y, m - 1, d + diffToMonday));
  return monday.toISOString().slice(0, 10);
}

export function buildSalesAndPnLSeries(
  sales: Sale[],
  expenses: Expense[],
  granularity: SalesGranularity,
  fromDate: string,
  toDate: string
): SalesChartPoint[] {
  const activeSales = sales.filter(
    (s) => s.status !== 'cancelled' && (!fromDate || s.saleDate >= fromDate) && (!toDate || s.saleDate <= toDate)
  );
  const filteredExpenses = expenses.filter(
    (e) => (!fromDate || e.expenseDate >= fromDate) && (!toDate || e.expenseDate <= toDate)
  );

  const buckets = new Map<string, SalesChartPoint>();

  const getKeyAndLabel = (isoDate: string): { key: string; label: string } => {
    if (granularity === 'daily') {
      return { key: isoDate, label: formatDateDDMMYYYY(isoDate) };
    }
    if (granularity === 'weekly') {
      const wk = getIsoWeekKey(isoDate);
      return { key: wk, label: `Wk ${formatDateDDMMYYYY(wk)}` };
    }
    if (granularity === 'monthly') {
      const mk = isoDate.slice(0, 7);
      return { key: mk, label: formatMonthLabel(mk) };
    }
    const yr = isoDate.slice(0, 4);
    return { key: yr, label: yr };
  };

  for (const s of activeSales) {
    const { key, label } = getKeyAndLabel(s.saleDate);
    const cur = buckets.get(key) || {
      key,
      label,
      sales: 0,
      cogs: 0,
      grossProfit: 0,
      expenses: 0,
      netProfit: 0,
    };
    cur.sales = roundMoney(cur.sales + s.totalAmount);
    cur.cogs = roundMoney(cur.cogs + s.totalCost);
    cur.grossProfit = roundMoney(cur.sales - cur.cogs);
    cur.netProfit = roundMoney(cur.grossProfit - cur.expenses);
    buckets.set(key, cur);
  }

  for (const e of filteredExpenses) {
    const { key, label } = getKeyAndLabel(e.expenseDate);
    const cur = buckets.get(key) || {
      key,
      label,
      sales: 0,
      cogs: 0,
      grossProfit: 0,
      expenses: 0,
      netProfit: 0,
    };
    cur.expenses = roundMoney(cur.expenses + e.amount);
    cur.netProfit = roundMoney(cur.grossProfit - cur.expenses);
    buckets.set(key, cur);
  }

  return Array.from(buckets.values()).sort((a, b) => a.key.localeCompare(b.key));
}

export function buildProfitTrendSeries(
  sales: Sale[],
  expenses: Expense[],
  granularity: 'daily' | 'monthly',
  fromDate: string,
  toDate: string
): SalesChartPoint[] {
  const todayIso = getKarachiDateIso();
  let start = fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate) ? fromDate : addDaysToIso(todayIso, -29);
  let end = toDate && /^\d{4}-\d{2}-\d{2}$/.test(toDate) ? toDate : todayIso;
  if (start > end) {
    [start, end] = [end, start];
  }

  if (granularity === 'daily') {
    const minStart = addDaysToIso(end, -365);
    if (start < minStart) start = minStart;

    const activeSales = sales.filter(
      (s) => s.status !== 'cancelled' && s.saleDate >= start && s.saleDate <= end
    );
    const filteredExpenses = expenses.filter(
      (e) => e.expenseDate >= start && e.expenseDate <= end
    );

    if (activeSales.length === 0 && filteredExpenses.length === 0) {
      return [];
    }

    const buckets = new Map<string, SalesChartPoint>();
    let cursor = start;
    while (cursor <= end) {
      buckets.set(cursor, {
        key: cursor,
        label: formatDateDDMMYYYY(cursor),
        sales: 0,
        cogs: 0,
        grossProfit: 0,
        expenses: 0,
        netProfit: 0,
      });
      cursor = addDaysToIso(cursor, 1);
    }

    for (const s of activeSales) {
      const pt = buckets.get(s.saleDate);
      if (!pt) continue;
      pt.sales = roundMoney(pt.sales + s.totalAmount);
      pt.cogs = roundMoney(pt.cogs + s.totalCost);
      pt.grossProfit = roundMoney(pt.sales - pt.cogs);
      pt.netProfit = roundMoney(pt.grossProfit - pt.expenses);
    }

    for (const e of filteredExpenses) {
      const pt = buckets.get(e.expenseDate);
      if (!pt) continue;
      pt.expenses = roundMoney(pt.expenses + e.amount);
      pt.netProfit = roundMoney(pt.grossProfit - pt.expenses);
    }

    return Array.from(buckets.values());
  }

  // Monthly continuous series (covers at least 6 months ending at end's month if selected range is narrower)
  const endMonth = getMonthKey(end);
  const selectedStartMonth = getMonthKey(start);
  let startMonth = selectedStartMonth;
  let sixMonthsBack = endMonth;
  for (let i = 0; i < 5; i += 1) {
    sixMonthsBack = getPreviousMonthKey(sixMonthsBack);
  }
  if (startMonth > sixMonthsBack) {
    startMonth = sixMonthsBack;
  }

  const activeSales = sales.filter((s) => {
    if (s.status === 'cancelled') return false;
    const mk = getMonthKey(s.saleDate);
    return mk >= startMonth && mk <= endMonth;
  });
  const filteredExpenses = expenses.filter((e) => {
    const mk = getMonthKey(e.expenseDate);
    return mk >= startMonth && mk <= endMonth;
  });

  if (activeSales.length === 0 && filteredExpenses.length === 0) {
    return [];
  }

  const monthKeys: string[] = [];
  let mCursor = endMonth;
  while (mCursor >= startMonth && monthKeys.length < 36) {
    monthKeys.push(mCursor);
    mCursor = getPreviousMonthKey(mCursor);
  }
  monthKeys.reverse();

  const buckets = new Map<string, SalesChartPoint>();
  for (const mk of monthKeys) {
    buckets.set(mk, {
      key: mk,
      label: formatMonthLabel(mk),
      sales: 0,
      cogs: 0,
      grossProfit: 0,
      expenses: 0,
      netProfit: 0,
    });
  }

  for (const s of activeSales) {
    const pt = buckets.get(getMonthKey(s.saleDate));
    if (!pt) continue;
    pt.sales = roundMoney(pt.sales + s.totalAmount);
    pt.cogs = roundMoney(pt.cogs + s.totalCost);
    pt.grossProfit = roundMoney(pt.sales - pt.cogs);
    pt.netProfit = roundMoney(pt.grossProfit - pt.expenses);
  }

  for (const e of filteredExpenses) {
    const pt = buckets.get(getMonthKey(e.expenseDate));
    if (!pt) continue;
    pt.expenses = roundMoney(pt.expenses + e.amount);
    pt.netProfit = roundMoney(pt.grossProfit - pt.expenses);
  }

  return Array.from(buckets.values());
}

export interface PeriodComparison {
  currentLabel: string;
  previousLabel: string;
  currentSales: number;
  previousSales: number;
  currentProfit: number;
  previousProfit: number;
  currentGrossProfit: number;
  previousGrossProfit: number;
  currentExpenses: number;
  previousExpenses: number;
  currentPurchases: number;
  previousPurchases: number;
  currentUnitsSold: number;
  previousUnitsSold: number;
  revenueGrowthPct: number | null;
  profitGrowthPct: number | null;
  expenseGrowthPct: number | null;
}

export function calcGrowthPct(current: number, previous: number): number | null {
  if (previous === 0) {
    return current === 0 ? 0 : null;
  }
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

export function computeMonthlyComparison(
  sales: Sale[],
  purchases: Purchase[],
  expenses: Expense[],
  monthKey?: string
): PeriodComparison {
  const curMonth = monthKey || getMonthKey(getKarachiDateIso());
  const prevMonth = getPreviousMonthKey(curMonth);

  const activeSales = sales.filter((s) => s.status !== 'cancelled');
  const activePurchases = purchases.filter((p) => p.status !== 'cancelled');

  const sumForMonth = (mk: string) => {
    let totalSales = 0;
    let totalCogs = 0;
    let unitsSold = 0;
    for (const s of activeSales) {
      if (getMonthKey(s.saleDate) === mk) {
        totalSales = roundMoney(totalSales + s.totalAmount);
        totalCogs = roundMoney(totalCogs + s.totalCost);
        unitsSold += s.totalQuantity;
      }
    }
    let totalExpenses = 0;
    for (const e of expenses) {
      if (getMonthKey(e.expenseDate) === mk) {
        totalExpenses = roundMoney(totalExpenses + e.amount);
      }
    }
    let totalPurchases = 0;
    for (const p of activePurchases) {
      if (getMonthKey(p.purchaseDate) === mk) {
        totalPurchases = roundMoney(totalPurchases + p.totalAmount);
      }
    }
    const grossProfit = roundMoney(totalSales - totalCogs);
    const netProfit = roundMoney(grossProfit - totalExpenses);
    return { totalSales, grossProfit, netProfit, totalExpenses, totalPurchases, unitsSold };
  };

  const cur = sumForMonth(curMonth);
  const prev = sumForMonth(prevMonth);

  return {
    currentLabel: formatMonthLabel(curMonth),
    previousLabel: formatMonthLabel(prevMonth),
    currentSales: cur.totalSales,
    previousSales: prev.totalSales,
    currentGrossProfit: cur.grossProfit,
    previousGrossProfit: prev.grossProfit,
    currentProfit: cur.netProfit,
    previousProfit: prev.netProfit,
    currentExpenses: cur.totalExpenses,
    previousExpenses: prev.totalExpenses,
    currentPurchases: cur.totalPurchases,
    previousPurchases: prev.totalPurchases,
    currentUnitsSold: cur.unitsSold,
    previousUnitsSold: prev.unitsSold,
    revenueGrowthPct: calcGrowthPct(cur.totalSales, prev.totalSales),
    profitGrowthPct: calcGrowthPct(cur.netProfit, prev.netProfit),
    expenseGrowthPct: calcGrowthPct(cur.totalExpenses, prev.totalExpenses),
  };
}

export function computeYearlyComparison(
  sales: Sale[],
  purchases: Purchase[],
  expenses: Expense[],
  yearStr?: string
): PeriodComparison {
  const curYear = yearStr || getKarachiDateIso().slice(0, 4);
  const prevYear = String(Number(curYear) - 1);

  const activeSales = sales.filter((s) => s.status !== 'cancelled');
  const activePurchases = purchases.filter((p) => p.status !== 'cancelled');

  const sumForYear = (yr: string) => {
    let totalSales = 0;
    let totalCogs = 0;
    let unitsSold = 0;
    for (const s of activeSales) {
      if (s.saleDate.slice(0, 4) === yr) {
        totalSales = roundMoney(totalSales + s.totalAmount);
        totalCogs = roundMoney(totalCogs + s.totalCost);
        unitsSold += s.totalQuantity;
      }
    }
    let totalExpenses = 0;
    for (const e of expenses) {
      if (e.expenseDate.slice(0, 4) === yr) {
        totalExpenses = roundMoney(totalExpenses + e.amount);
      }
    }
    let totalPurchases = 0;
    for (const p of activePurchases) {
      if (p.purchaseDate.slice(0, 4) === yr) {
        totalPurchases = roundMoney(totalPurchases + p.totalAmount);
      }
    }
    const grossProfit = roundMoney(totalSales - totalCogs);
    const netProfit = roundMoney(grossProfit - totalExpenses);
    return { totalSales, grossProfit, netProfit, totalExpenses, totalPurchases, unitsSold };
  };

  const cur = sumForYear(curYear);
  const prev = sumForYear(prevYear);

  return {
    currentLabel: curYear,
    previousLabel: prevYear,
    currentSales: cur.totalSales,
    previousSales: prev.totalSales,
    currentGrossProfit: cur.grossProfit,
    previousGrossProfit: prev.grossProfit,
    currentProfit: cur.netProfit,
    previousProfit: prev.netProfit,
    currentExpenses: cur.totalExpenses,
    previousExpenses: prev.totalExpenses,
    currentPurchases: cur.totalPurchases,
    previousPurchases: prev.totalPurchases,
    currentUnitsSold: cur.unitsSold,
    previousUnitsSold: prev.unitsSold,
    revenueGrowthPct: calcGrowthPct(cur.totalSales, prev.totalSales),
    profitGrowthPct: calcGrowthPct(cur.netProfit, prev.netProfit),
    expenseGrowthPct: calcGrowthPct(cur.totalExpenses, prev.totalExpenses),
  };
}

export interface ProductPerformanceRow {
  productId: string;
  productName: string;
  categoryId: string;
  categoryName: string;
  brandId: string;
  brandName: string;
  currentStock: number;
  unit: string;
  quantitySold: number;
  revenue: number;
  cost: number;
  grossProfit: number;
  profitMarginPct: number;
  catalogMarginPct: number;
  previousPeriodQty: number;
  qtyChange: number;
}

export interface CategoryOrBrandPerformance {
  id: string;
  name: string;
  quantitySold: number;
  revenue: number;
  cost: number;
  grossProfit: number;
  profitMarginPct: number;
}

export function computeProductPerformance(
  products: Product[],
  saleItems: SaleItem[],
  filters: {
    fromDate?: string;
    toDate?: string;
    categoryId?: string;
    brandId?: string;
    productId?: string;
    supplierId?: string;
  }
): {
  rows: ProductPerformanceRow[];
  topByQuantity: ProductPerformanceRow[];
  topByRevenue: ProductPerformanceRow[];
  topByProfit: ProductPerformanceRow[];
  highestMargin: ProductPerformanceRow[];
  slowMoving: ProductPerformanceRow[];
  noSales: ProductPerformanceRow[];
  decliningSales: ProductPerformanceRow[];
  bestCategories: CategoryOrBrandPerformance[];
  bestBrands: CategoryOrBrandPerformance[];
} {
  const todayIso = getKarachiDateIso();
  const toDate = filters.toDate || todayIso;
  const fromDate = filters.fromDate || addDaysToIso(toDate, -29);

  // Calculate equal-length prior period for declining sales comparison
  const spanDays = Math.max(
    1,
    Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000) + 1
  );
  const prevToDate = addDaysToIso(fromDate, -1);
  const prevFromDate = addDaysToIso(prevToDate, -(spanDays - 1));

  const filteredProducts = products.filter((p) => {
    if (filters.productId && p.id !== filters.productId) return false;
    if (filters.categoryId && p.categoryId !== filters.categoryId) return false;
    if (filters.brandId && p.brandId !== filters.brandId) return false;
    if (filters.supplierId && p.supplierId !== filters.supplierId) return false;
    return true;
  });

  const hasSupplierFilter = Boolean(filters.supplierId);
  const supplierProductIds = hasSupplierFilter
    ? new Set(filteredProducts.map((p) => p.id))
    : null;

  const activeItems = saleItems.filter((i) => i.status !== 'cancelled');

  const aggMap = new Map<string, ProductPerformanceRow>();
  for (const p of filteredProducts) {
    aggMap.set(p.id, {
      productId: p.id,
      productName: p.name,
      categoryId: p.categoryId,
      categoryName: p.categoryName,
      brandId: p.brandId,
      brandName: p.brandName,
      currentStock: p.currentStock,
      unit: p.unit,
      quantitySold: 0,
      revenue: 0,
      cost: 0,
      grossProfit: 0,
      profitMarginPct: 0,
      catalogMarginPct: p.profitMarginPct,
      previousPeriodQty: 0,
      qtyChange: 0,
    });
  }

  for (const item of activeItems) {
    if (filters.productId && item.productId !== filters.productId) continue;
    if (filters.categoryId && item.categoryId !== filters.categoryId) continue;
    if (filters.brandId && item.brandId !== filters.brandId) continue;
    if (supplierProductIds && !supplierProductIds.has(item.productId)) continue;

    let row = aggMap.get(item.productId);
    if (!row) {
      row = {
        productId: item.productId,
        productName: item.productName,
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        brandId: item.brandId,
        brandName: item.brandName,
        currentStock: 0,
        unit: 'Unit',
        quantitySold: 0,
        revenue: 0,
        cost: 0,
        grossProfit: 0,
        profitMarginPct: 0,
        catalogMarginPct: 0,
        previousPeriodQty: 0,
        qtyChange: 0,
      };
      aggMap.set(item.productId, row);
    }

    if (item.saleDate >= fromDate && item.saleDate <= toDate) {
      row.quantitySold += item.quantity;
      row.revenue = roundMoney(row.revenue + item.lineTotal);
      row.cost = roundMoney(row.cost + item.lineCost);
      row.grossProfit = roundMoney(row.revenue - row.cost);
      row.profitMarginPct = row.revenue > 0 ? Math.round((row.grossProfit / row.revenue) * 10000) / 100 : 0;
    } else if (item.saleDate >= prevFromDate && item.saleDate <= prevToDate) {
      row.previousPeriodQty += item.quantity;
    }
  }

  const rows = Array.from(aggMap.values()).map((r) => ({
    ...r,
    qtyChange: r.quantitySold - r.previousPeriodQty,
    profitMarginPct:
      r.revenue > 0 ? Math.round((r.grossProfit / r.revenue) * 10000) / 100 : r.catalogMarginPct,
  }));

  const soldRows = rows.filter((r) => r.quantitySold > 0);
  const topByQuantity = [...soldRows].sort((a, b) => b.quantitySold - a.quantitySold).slice(0, 10);
  const topByRevenue = [...soldRows].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const topByProfit = [...soldRows].sort((a, b) => b.grossProfit - a.grossProfit).slice(0, 10);
  const highestMargin = [...rows]
    .filter((r) => r.revenue > 0 || r.catalogMarginPct > 0)
    .sort((a, b) => b.profitMarginPct - a.profitMarginPct)
    .slice(0, 10);

  const slowMoving = [...soldRows]
    .sort((a, b) => a.quantitySold - b.quantitySold)
    .slice(0, 10);
  const noSales = rows.filter((r) => r.quantitySold === 0);
  const decliningSales = rows
    .filter((r) => r.previousPeriodQty > 0 && r.quantitySold < r.previousPeriodQty)
    .sort((a, b) => a.qtyChange - b.qtyChange);

  const catMap = new Map<string, CategoryOrBrandPerformance>();
  const brandMap = new Map<string, CategoryOrBrandPerformance>();

  for (const r of soldRows) {
    const cKey = r.categoryId || r.categoryName || 'uncategorized';
    const cCur = catMap.get(cKey) || {
      id: cKey,
      name: r.categoryName || 'Uncategorized',
      quantitySold: 0,
      revenue: 0,
      cost: 0,
      grossProfit: 0,
      profitMarginPct: 0,
    };
    cCur.quantitySold += r.quantitySold;
    cCur.revenue = roundMoney(cCur.revenue + r.revenue);
    cCur.cost = roundMoney(cCur.cost + r.cost);
    cCur.grossProfit = roundMoney(cCur.revenue - cCur.cost);
    cCur.profitMarginPct = cCur.revenue > 0 ? Math.round((cCur.grossProfit / cCur.revenue) * 10000) / 100 : 0;
    catMap.set(cKey, cCur);

    const bKey = r.brandId || r.brandName || 'unbranded';
    const bCur = brandMap.get(bKey) || {
      id: bKey,
      name: r.brandName || 'Unbranded',
      quantitySold: 0,
      revenue: 0,
      cost: 0,
      grossProfit: 0,
      profitMarginPct: 0,
    };
    bCur.quantitySold += r.quantitySold;
    bCur.revenue = roundMoney(bCur.revenue + r.revenue);
    bCur.cost = roundMoney(bCur.cost + r.cost);
    bCur.grossProfit = roundMoney(bCur.revenue - bCur.cost);
    bCur.profitMarginPct = bCur.revenue > 0 ? Math.round((bCur.grossProfit / bCur.revenue) * 10000) / 100 : 0;
    brandMap.set(bKey, bCur);
  }

  return {
    rows: rows.sort((a, b) => b.revenue - a.revenue),
    topByQuantity,
    topByRevenue,
    topByProfit,
    highestMargin,
    slowMoving,
    noSales,
    decliningSales,
    bestCategories: Array.from(catMap.values()).sort((a, b) => b.revenue - a.revenue),
    bestBrands: Array.from(brandMap.values()).sort((a, b) => b.revenue - a.revenue),
  };
}
