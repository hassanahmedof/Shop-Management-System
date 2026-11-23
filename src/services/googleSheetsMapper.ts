import type { Timestamp } from 'firebase/firestore';
import type { SheetCellValue, SheetSyncPayload, SheetTabName } from '../../shared/googleSheetsSchema';
import type {
  Brand,
  Category,
  Expense,
  Product,
  Purchase,
  PurchaseItem,
  Sale,
  SaleItem,
  StaffMember,
  StockAdjustment,
  StockMovement,
  Supplier,
} from '../types/shop';
import { calcGrowthPct } from '../utils/analytics';
import {
  formatDateDDMMYYYY,
  formatDateTimeKarachi,
  getKarachiDateIso,
  getMonthKey,
  getPreviousMonthKey,
  roundMoney,
} from '../utils/formatters';
import { formatSaleSellerLabel, getSaleSellerKey } from '../utils/sellerAttribution';
import { getEffectiveBaseUnit } from '../utils/packaging';

export interface ShopSnapshotData {
  products: Product[];
  sales: Sale[];
  saleItems: SaleItem[];
  purchases: Purchase[];
  purchaseItems: PurchaseItem[];
  expenses: Expense[];
  stockMovements: StockMovement[];
  stockAdjustments: StockAdjustment[];
  suppliers: Supplier[];
  categories: Category[];
  brands: Brand[];
  staffMembers: StaffMember[];
}

function formatTsDate(ts?: Timestamp): string {
  if (!ts) return '';
  try {
    const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts.seconds * 1000);
    return formatDateDDMMYYYY(getKarachiDateIso(d));
  } catch {
    return '';
  }
}

function formatTsDateTime(ts?: Timestamp): string {
  if (!ts) return '';
  try {
    return formatDateTimeKarachi(ts);
  } catch {
    return '';
  }
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function formatMovementTypeLabel(type: StockMovement['movementType']): string {
  switch (type) {
    case 'sale':
      return 'Sale';
    case 'sale_edit':
      return 'Sale Edit';
    case 'sale_cancel':
      return 'Sale Cancelled';
    case 'purchase':
      return 'Purchase';
    case 'purchase_cancel':
      return 'Purchase Cancelled';
    case 'adjustment_add':
      return 'Adjustment (Add)';
    case 'adjustment_reduce':
      return 'Adjustment (Reduce)';
    case 'adjustment_damaged':
      return 'Adjustment (Damaged)';
    case 'adjustment_expired':
      return 'Adjustment (Expired)';
    case 'adjustment_missing':
      return 'Adjustment (Missing)';
    case 'initial_stock':
      return 'Initial Stock';
    default:
      return type;
  }
}

export function mapProductsRows(products: Product[]): SheetCellValue[][] {
  return [...products]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => [
      p.id,
      p.name,
      p.categoryName || '',
      p.brandName || '',
      roundMoney(p.purchasePrice),
      roundMoney(p.salePrice),
      roundMoney(p.wholesalePrice),
      p.currentStock,
      p.minStockLevel,
      p.maxStockLevel,
      getEffectiveBaseUnit(p),
      p.supplierName || '',
      p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '',
      roundMoney(p.profitMarginPct),
      formatTsDate(p.createdAt),
      formatTsDateTime(p.updatedAt),
    ]);
}

export function mapInventoryRows(products: Product[]): SheetCellValue[][] {
  return [...products]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => [
      p.id,
      p.name,
      p.categoryName || '',
      p.brandName || '',
      p.currentStock,
      p.minStockLevel,
      p.maxStockLevel,
      roundMoney(p.purchasePrice),
      roundMoney(p.currentStock * p.purchasePrice),
      formatTsDateTime(p.updatedAt),
    ]);
}

export function mapSalesRows(sales: Sale[]): SheetCellValue[][] {
  return [...sales]
    .sort((a, b) => a.saleDate.localeCompare(b.saleDate) || a.saleNumber.localeCompare(b.saleNumber))
    .map((s) => [
      s.id,
      formatDateDDMMYYYY(s.saleDate),
      formatSaleSellerLabel(s),
      roundMoney(s.totalAmount),
      s.paymentMethod,
      s.totalQuantity,
      s.notes || '',
      s.status === 'cancelled' ? 'Cancelled' : 'Completed',
      formatTsDateTime(s.createdAt) || s.saleDateTime || formatDateDDMMYYYY(s.saleDate),
      s.customerWhatsapp || '',
    ]);
}

export function mapSalesDetailsRows(saleItems: SaleItem[], sales: Sale[]): SheetCellValue[][] {
  const saleStaffMap = new Map<string, string>();
  const saleRoleMap = new Map<string, Sale['recordedByRole']>();
  const saleStatusMap = new Map<string, Sale['status']>();
  for (const s of sales) {
    saleStaffMap.set(s.id, formatSaleSellerLabel(s));
    saleRoleMap.set(s.id, s.recordedByRole);
    saleStatusMap.set(s.id, s.status);
  }

  return [...saleItems]
    .sort((a, b) => a.saleDate.localeCompare(b.saleDate) || a.saleId.localeCompare(b.saleId))
    .map((item) => {
      const isCancelled =
        item.status === 'cancelled' || saleStatusMap.get(item.saleId) === 'cancelled';
      const parentLabel = saleStaffMap.get(item.saleId);
      const sellerLabel =
        parentLabel ||
        formatSaleSellerLabel({
          staffId: item.staffId,
          staffName: item.staffName,
          recordedByRole: saleRoleMap.get(item.saleId),
        });
      return [
        item.id,
        item.saleId,
        formatDateDDMMYYYY(item.saleDate),
        item.unitName ? `${item.productName} (${item.unitName})` : item.productName,
        item.productId,
        item.unitQuantity ?? item.quantity,
        roundMoney(item.salePricePerUnit),
        roundMoney(item.purchasePriceAtSale),
        roundMoney(item.lineTotal),
        roundMoney(item.lineProfit),
        sellerLabel,
        isCancelled ? 'Cancelled' : 'Completed',
      ];
    });
}

export function mapPurchasesRows(purchases: Purchase[]): SheetCellValue[][] {
  return [...purchases]
    .sort(
      (a, b) =>
        a.purchaseDate.localeCompare(b.purchaseDate) ||
        a.purchaseNumber.localeCompare(b.purchaseNumber)
    )
    .map((p) => [
      p.id,
      formatDateDDMMYYYY(p.purchaseDate),
      p.supplierName || '',
      roundMoney(p.totalAmount),
      roundMoney(p.amountPaid),
      roundMoney(p.balanceDue),
      p.paymentMethod,
      p.notes || '',
      p.status === 'cancelled' ? 'Cancelled' : 'Completed',
    ]);
}

export function mapPurchaseDetailsRows(purchaseItems: PurchaseItem[]): SheetCellValue[][] {
  return [...purchaseItems]
    .sort(
      (a, b) =>
        a.purchaseDate.localeCompare(b.purchaseDate) || a.purchaseId.localeCompare(b.purchaseId)
    )
    .map((item) => [
      item.id,
      item.purchaseId,
      formatDateDDMMYYYY(item.purchaseDate),
      item.unitName ? `${item.productName} (${item.unitName})` : item.productName,
      item.productId,
      item.unitQuantity ?? item.quantity,
      roundMoney(item.purchasePricePerUnit),
      roundMoney(item.lineTotal),
    ]);
}

export function mapExpensesRows(expenses: Expense[]): SheetCellValue[][] {
  return [...expenses]
    .sort((a, b) => a.expenseDate.localeCompare(b.expenseDate))
    .map((e) => [
      e.id,
      formatDateDDMMYYYY(e.expenseDate),
      e.title,
      e.categoryName || '',
      roundMoney(e.amount),
      e.paymentMethod,
      e.notes || '',
      formatTsDateTime(e.createdAt) || formatDateDDMMYYYY(e.expenseDate),
    ]);
}

export function mapStockMovementsRows(stockMovements: StockMovement[]): SheetCellValue[][] {
  return [...stockMovements]
    .sort((a, b) => a.movementDate.localeCompare(b.movementDate))
    .map((m) => [
      m.id,
      formatDateDDMMYYYY(m.movementDate),
      m.productId,
      m.productName,
      formatMovementTypeLabel(m.movementType),
      m.quantityChange > 0 ? m.quantityChange : 0,
      m.quantityChange < 0 ? Math.abs(m.quantityChange) : 0,
      m.previousStock,
      m.newStock,
      m.notes || '',
      m.referenceId || '',
    ]);
}

export function mapStockAdjustmentsRows(stockAdjustments: StockAdjustment[]): SheetCellValue[][] {
  return [...stockAdjustments]
    .sort((a, b) => a.adjustmentDate.localeCompare(b.adjustmentDate))
    .map((a) => [
      a.id,
      formatDateDDMMYYYY(a.adjustmentDate),
      a.productName,
      a.adjustmentType,
      a.quantity,
      a.reason || '',
      a.notes || '',
    ]);
}

export function mapSuppliersRows(suppliers: Supplier[]): SheetCellValue[][] {
  return [...suppliers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => [
      s.id,
      s.name,
      '',
      s.phone || '',
      s.address || '',
      roundMoney(s.totalPurchased),
      roundMoney(s.totalPaid),
      roundMoney(s.outstandingBalance),
    ]);
}

export function mapCategoriesAndBrandsRows(
  categories: Category[],
  brands: Brand[]
): SheetCellValue[][] {
  const catRows: SheetCellValue[][] = [...categories]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => [`cat_${c.id}`, 'Category', c.name, formatTsDate(c.createdAt), 'Active']);

  const brandRows: SheetCellValue[][] = [...brands]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((b) => [`brand_${b.id}`, 'Brand', b.name, formatTsDate(b.createdAt), 'Active']);

  return [...catRows, ...brandRows];
}

export function mapDailySummaryRows(data: ShopSnapshotData): SheetCellValue[][] {
  const activeSales = data.sales.filter((s) => s.status !== 'cancelled');
  const activePurchases = data.purchases.filter((p) => p.status !== 'cancelled');

  const dateSet = new Set<string>();
  const todayIso = getKarachiDateIso();
  if (
    activeSales.length > 0 ||
    activePurchases.length > 0 ||
    data.expenses.length > 0 ||
    data.products.length > 0
  ) {
    dateSet.add(todayIso);
  }
  for (const s of activeSales) dateSet.add(s.saleDate);
  for (const p of activePurchases) dateSet.add(p.purchaseDate);
  for (const e of data.expenses) dateSet.add(e.expenseDate);

  if (dateSet.size === 0) return [];

  const productCostMap = new Map<string, number>();
  let currentTotalInventoryValue = 0;
  for (const p of data.products) {
    productCostMap.set(p.id, p.purchasePrice);
    currentTotalInventoryValue = roundMoney(
      currentTotalInventoryValue + p.currentStock * p.purchasePrice
    );
  }

  // Compute daily net stock value deltas from stockMovements to reconstruct historical closing stock value
  const dailyStockValueDelta = new Map<string, number>();
  for (const m of data.stockMovements) {
    const unitCost = productCostMap.get(m.productId) ?? 0;
    const prev = dailyStockValueDelta.get(m.movementDate) ?? 0;
    dailyStockValueDelta.set(m.movementDate, roundMoney(prev + m.quantityChange * unitCost));
  }

  const datesAsc = Array.from(dateSet).sort((a, b) => a.localeCompare(b));

  // Walk backwards from latest date using known currentTotalInventoryValue
  const closingStockByDate = new Map<string, number>();
  let runningClosingValue = currentTotalInventoryValue;
  for (let i = datesAsc.length - 1; i >= 0; i -= 1) {
    const dt = datesAsc[i];
    closingStockByDate.set(dt, Math.max(0, roundMoney(runningClosingValue)));
    const delta = dailyStockValueDelta.get(dt) ?? 0;
    runningClosingValue = roundMoney(runningClosingValue - delta);
  }

  const dailyBuckets = new Map<
    string,
    {
      totalSales: number;
      cashSales: number;
      onlineSales: number;
      totalPurchases: number;
      totalExpenses: number;
      totalCost: number;
      productsSold: number;
    }
  >();

  for (const dt of datesAsc) {
    dailyBuckets.set(dt, {
      totalSales: 0,
      cashSales: 0,
      onlineSales: 0,
      totalPurchases: 0,
      totalExpenses: 0,
      totalCost: 0,
      productsSold: 0,
    });
  }

  for (const s of activeSales) {
    const b = dailyBuckets.get(s.saleDate);
    if (!b) continue;
    b.totalSales = roundMoney(b.totalSales + s.totalAmount);
    if (s.paymentMethod === 'Cash') {
      b.cashSales = roundMoney(b.cashSales + s.totalAmount);
    } else {
      b.onlineSales = roundMoney(b.onlineSales + s.totalAmount);
    }
    b.totalCost = roundMoney(b.totalCost + s.totalCost);
    b.productsSold += s.totalQuantity;
  }

  for (const p of activePurchases) {
    const b = dailyBuckets.get(p.purchaseDate);
    if (!b) continue;
    b.totalPurchases = roundMoney(b.totalPurchases + p.totalAmount);
  }

  for (const e of data.expenses) {
    const b = dailyBuckets.get(e.expenseDate);
    if (!b) continue;
    b.totalExpenses = roundMoney(b.totalExpenses + e.amount);
  }

  return datesAsc.map((dt) => {
    const b = dailyBuckets.get(dt)!;
    const grossProfit = roundMoney(b.totalSales - b.totalCost);
    const netProfit = roundMoney(grossProfit - b.totalExpenses);
    return [
      formatDateDDMMYYYY(dt),
      b.totalSales,
      b.cashSales,
      b.onlineSales,
      b.totalPurchases,
      b.totalExpenses,
      grossProfit,
      netProfit,
      b.productsSold,
      closingStockByDate.get(dt) ?? currentTotalInventoryValue,
    ];
  });
}

export function mapMonthlySummaryRows(data: ShopSnapshotData): SheetCellValue[][] {
  const activeSales = data.sales.filter((s) => s.status !== 'cancelled');
  const activePurchases = data.purchases.filter((p) => p.status !== 'cancelled');

  const monthSet = new Set<string>();
  for (const s of activeSales) monthSet.add(getMonthKey(s.saleDate));
  for (const p of activePurchases) monthSet.add(getMonthKey(p.purchaseDate));
  for (const e of data.expenses) monthSet.add(getMonthKey(e.expenseDate));

  if (monthSet.size === 0) {
    monthSet.add(getMonthKey(getKarachiDateIso()));
  }

  const monthsAsc = Array.from(monthSet).sort((a, b) => a.localeCompare(b));

  const totalsByMonth = new Map<
    string,
    {
      totalSales: number;
      totalPurchases: number;
      totalExpenses: number;
      totalCost: number;
      grossProfit: number;
      netProfit: number;
      unitsSold: number;
    }
  >();

  for (const mk of monthsAsc) {
    totalsByMonth.set(mk, {
      totalSales: 0,
      totalPurchases: 0,
      totalExpenses: 0,
      totalCost: 0,
      grossProfit: 0,
      netProfit: 0,
      unitsSold: 0,
    });
  }

  for (const s of activeSales) {
    const b = totalsByMonth.get(getMonthKey(s.saleDate));
    if (!b) continue;
    b.totalSales = roundMoney(b.totalSales + s.totalAmount);
    b.totalCost = roundMoney(b.totalCost + s.totalCost);
    b.unitsSold += s.totalQuantity;
  }

  for (const p of activePurchases) {
    const b = totalsByMonth.get(getMonthKey(p.purchaseDate));
    if (!b) continue;
    b.totalPurchases = roundMoney(b.totalPurchases + p.totalAmount);
  }

  for (const e of data.expenses) {
    const b = totalsByMonth.get(getMonthKey(e.expenseDate));
    if (!b) continue;
    b.totalExpenses = roundMoney(b.totalExpenses + e.amount);
  }

  for (const b of totalsByMonth.values()) {
    b.grossProfit = roundMoney(b.totalSales - b.totalCost);
    b.netProfit = roundMoney(b.grossProfit - b.totalExpenses);
  }

  return monthsAsc.map((mk) => {
    const cur = totalsByMonth.get(mk)!;
    const prevKey = getPreviousMonthKey(mk);
    const prev = totalsByMonth.get(prevKey) || {
      totalSales: 0,
      netProfit: 0,
    };

    const revGrowth = calcGrowthPct(cur.totalSales, prev.totalSales);
    const profitGrowth = calcGrowthPct(cur.netProfit, prev.netProfit);

    const [yearStr, monthStr] = mk.split('-');
    const monthNum = Number(monthStr);
    const monthName = MONTH_NAMES[monthNum - 1] || monthStr;

    return [
      monthName,
      Number(yearStr) || 0,
      cur.totalSales,
      cur.totalPurchases,
      cur.totalExpenses,
      cur.grossProfit,
      cur.netProfit,
      revGrowth === null ? 'N/A' : revGrowth,
      profitGrowth === null ? 'N/A' : profitGrowth,
      cur.unitsSold,
    ];
  });
}

export function mapStaffPerformanceRows(data: ShopSnapshotData): SheetCellValue[][] {
  const activeSales = data.sales.filter((s) => s.status !== 'cancelled');
  const staffNameLookup = new Map<string, string>();
  for (const st of data.staffMembers) {
    staffNameLookup.set(st.id, st.name);
  }

  const buckets = new Map<
    string,
    {
      staffId: string;
      staffName: string;
      isoDate: string;
      totalSales: number;
      cashSales: number;
      onlineSales: number;
      productsSold: number;
      txCount: number;
    }
  >();

  for (const s of activeSales) {
    const staffId = getSaleSellerKey(s);
    const formatted = formatSaleSellerLabel(s);
    const staffName =
      formatted !== 'Sales Staff' ? formatted : staffNameLookup.get(staffId) || 'Sales Staff';
    const key = `${s.saleDate}__${staffId}`;

    const cur = buckets.get(key) || {
      staffId,
      staffName,
      isoDate: s.saleDate,
      totalSales: 0,
      cashSales: 0,
      onlineSales: 0,
      productsSold: 0,
      txCount: 0,
    };

    cur.totalSales = roundMoney(cur.totalSales + s.totalAmount);
    if (s.paymentMethod === 'Cash') {
      cur.cashSales = roundMoney(cur.cashSales + s.totalAmount);
    } else {
      cur.onlineSales = roundMoney(cur.onlineSales + s.totalAmount);
    }
    cur.productsSold += s.totalQuantity;
    cur.txCount += 1;
    buckets.set(key, cur);
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.isoDate.localeCompare(b.isoDate) || a.staffName.localeCompare(b.staffName))
    .map((r) => [
      r.staffId,
      r.staffName,
      formatDateDDMMYYYY(r.isoDate),
      r.totalSales,
      r.cashSales,
      r.onlineSales,
      r.productsSold,
      r.txCount,
    ]);
}

export function buildSheetSyncPayload(
  data: ShopSnapshotData,
  targetTabs?: SheetTabName[]
): SheetSyncPayload {
  const tabSet = targetTabs ? new Set<SheetTabName>(targetTabs) : null;
  const include = (tab: SheetTabName) => !tabSet || tabSet.has(tab);

  const payload: SheetSyncPayload = {};

  if (include('Products')) payload['Products'] = mapProductsRows(data.products);
  if (include('Sales')) payload['Sales'] = mapSalesRows(data.sales);
  if (include('Sales Details')) {
    payload['Sales Details'] = mapSalesDetailsRows(data.saleItems, data.sales);
  }
  if (include('Purchases')) payload['Purchases'] = mapPurchasesRows(data.purchases);
  if (include('Purchase Details')) {
    payload['Purchase Details'] = mapPurchaseDetailsRows(data.purchaseItems);
  }
  if (include('Expenses')) payload['Expenses'] = mapExpensesRows(data.expenses);
  if (include('Inventory')) payload['Inventory'] = mapInventoryRows(data.products);
  if (include('Stock Movements')) {
    payload['Stock Movements'] = mapStockMovementsRows(data.stockMovements);
  }
  if (include('Stock Adjustments')) {
    payload['Stock Adjustments'] = mapStockAdjustmentsRows(data.stockAdjustments);
  }
  if (include('Suppliers')) payload['Suppliers'] = mapSuppliersRows(data.suppliers);
  if (include('Categories & Brands')) {
    payload['Categories & Brands'] = mapCategoriesAndBrandsRows(data.categories, data.brands);
  }
  if (include('Daily Summary')) payload['Daily Summary'] = mapDailySummaryRows(data);
  if (include('Monthly Summary')) payload['Monthly Summary'] = mapMonthlySummaryRows(data);
  if (include('Staff Performance')) {
    payload['Staff Performance'] = mapStaffPerformanceRows(data);
  }

  return payload;
}
