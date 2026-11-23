import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import type {
  AdminMember,
  Expense,
  Product,
  Purchase,
  Sale,
  SaleItem,
  ShopSettings,
  StaffMember,
  StockMovement,
} from '../types/shop';
import { computeProductPerformance } from './analytics';
import {
  formatDateDDMMYYYY,
  formatMonthLabel,
  formatPKR,
  getKarachiDateIso,
  getMonthKey,
  roundMoney,
} from './formatters';
import { formatStockBreakdown, getEffectiveBaseUnit, roundStockQty } from './packaging';
import {
  type AuthUserSummary,
  computeSellerPerformanceBreakdown,
  formatSaleSellerLabel,
} from './sellerAttribution';

export type ReportType =
  | 'sales'
  | 'seller_performance'
  | 'purchases'
  | 'expenses'
  | 'inventory'
  | 'stock_movements'
  | 'profit_loss'
  | 'product_performance'
  | 'monthly_business'
  | 'yearly_business';

export interface ReportTableData {
  title: string;
  subtitle: string;
  columns: string[];
  rows: (string | number)[][];
  summaryLines: Array<{ label: string; value: string }>;
}

export function buildReportData(
  type: ReportType,
  params: {
    fromDate: string;
    toDate: string;
    settings: ShopSettings | null;
    products: Product[];
    sales: Sale[];
    saleItems: SaleItem[];
    purchases: Purchase[];
    expenses: Expense[];
    stockMovements: StockMovement[];
    staffMembers?: StaffMember[];
    adminMembers?: AdminMember[];
    user?: AuthUserSummary | null;
    shopId?: string | null;
  }
): ReportTableData {
  const {
    fromDate,
    toDate,
    settings,
    products,
    sales,
    saleItems,
    purchases,
    expenses,
    stockMovements,
    staffMembers = [],
    adminMembers = [],
    user = null,
    shopId = null,
  } = params;
  const rangeLabel = `${formatDateDDMMYYYY(fromDate)} to ${formatDateDDMMYYYY(toDate)}`;
  const inRange = (d: string) => (!fromDate || d >= fromDate) && (!toDate || d <= toDate);

  switch (type) {
    case 'sales': {
      const filtered = sales
        .filter((s) => inRange(s.saleDate))
        .sort((a, b) => b.saleDate.localeCompare(a.saleDate));
      const active = filtered.filter((s) => s.status !== 'cancelled');
      const totalRev = active.reduce((acc, s) => roundMoney(acc + s.totalAmount), 0);
      const totalCogs = active.reduce((acc, s) => roundMoney(acc + s.totalCost), 0);
      const totalProfit = active.reduce((acc, s) => roundMoney(acc + s.totalProfit), 0);
      return {
        title: 'Sales Report',
        subtitle: `Period: ${rangeLabel}`,
        columns: [
          'Date',
          'Sale #',
          'Recorded By',
          'Payment',
          'Items',
          'Qty',
          'Total (PKR)',
          'Cost (PKR)',
          'Profit (PKR)',
          'Status',
        ],
        rows: filtered.map((s) => [
          formatDateDDMMYYYY(s.saleDate),
          s.saleNumber,
          formatSaleSellerLabel(s),
          s.paymentMethod,
          s.itemCount,
          s.totalQuantity,
          roundMoney(s.totalAmount),
          roundMoney(s.totalCost),
          roundMoney(s.totalProfit),
          s.status === 'cancelled' ? 'Cancelled' : 'Completed',
        ]),
        summaryLines: [
          { label: 'Active Sales Count', value: String(active.length) },
          { label: 'Total Revenue', value: formatPKR(totalRev) },
          { label: 'Cost of Goods Sold', value: formatPKR(totalCogs) },
          { label: 'Gross Profit', value: formatPKR(totalProfit) },
        ],
      };
    }

    case 'seller_performance': {
      const breakdown = computeSellerPerformanceBreakdown({
        sales,
        staffMembers,
        adminMembers,
        settings,
        user,
        shopId,
        fromDate,
        toDate,
      });
      const totalBills = breakdown.reduce((acc, r) => acc + r.orders, 0);
      const totalRev = breakdown.reduce((acc, r) => roundMoney(acc + r.revenue), 0);
      const totalProfit = breakdown.reduce((acc, r) => roundMoney(acc + r.grossProfit), 0);
      return {
        title: 'Admin & Staff Sales Performance Report',
        subtitle: `Period: ${rangeLabel}`,
        columns: [
          'Seller / Admin',
          'Bills',
          'Base Units',
          'Cash (PKR)',
          'Online (PKR)',
          'Total Sales (PKR)',
          'Gross Profit (PKR)',
          'Avg Bill (PKR)',
        ],
        rows: breakdown.map((r) => [
          r.sellerLabel,
          r.orders,
          r.unitsSold,
          roundMoney(r.cashTotal),
          roundMoney(r.onlineTotal),
          roundMoney(r.revenue),
          roundMoney(r.grossProfit),
          roundMoney(r.avgBill),
        ]),
        summaryLines: [
          { label: 'Sellers Tracked', value: String(breakdown.length) },
          { label: 'Total Bills', value: String(totalBills) },
          { label: 'Total Sales', value: formatPKR(totalRev) },
          { label: 'Total Gross Profit', value: formatPKR(totalProfit) },
        ],
      };
    }

    case 'purchases': {
      const filtered = purchases
        .filter((p) => inRange(p.purchaseDate))
        .sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate));
      const active = filtered.filter((p) => p.status !== 'cancelled');
      const totalAmt = active.reduce((acc, p) => roundMoney(acc + p.totalAmount), 0);
      const totalPaid = active.reduce((acc, p) => roundMoney(acc + p.amountPaid), 0);
      const totalDue = active.reduce((acc, p) => roundMoney(acc + p.balanceDue), 0);
      return {
        title: 'Purchase Report',
        subtitle: `Period: ${rangeLabel}`,
        columns: ['Date', 'PO #', 'Supplier', 'Payment', 'Qty', 'Total (PKR)', 'Paid (PKR)', 'Balance Due (PKR)', 'Status'],
        rows: filtered.map((p) => [
          formatDateDDMMYYYY(p.purchaseDate),
          p.purchaseNumber,
          p.supplierName,
          p.paymentMethod,
          p.totalQuantity,
          roundMoney(p.totalAmount),
          roundMoney(p.amountPaid),
          roundMoney(p.balanceDue),
          p.status === 'cancelled' ? 'Cancelled' : 'Completed',
        ]),
        summaryLines: [
          { label: 'Active Purchases', value: String(active.length) },
          { label: 'Total Purchased', value: formatPKR(totalAmt) },
          { label: 'Total Paid', value: formatPKR(totalPaid) },
          { label: 'Total Balance Due', value: formatPKR(totalDue) },
        ],
      };
    }

    case 'expenses': {
      const filtered = expenses
        .filter((e) => inRange(e.expenseDate))
        .sort((a, b) => b.expenseDate.localeCompare(a.expenseDate));
      const totalExp = filtered.reduce((acc, e) => roundMoney(acc + e.amount), 0);
      return {
        title: 'Expense Report',
        subtitle: `Period: ${rangeLabel}`,
        columns: ['Date', 'Title', 'Category', 'Payment', 'Amount (PKR)', 'Notes'],
        rows: filtered.map((e) => [
          formatDateDDMMYYYY(e.expenseDate),
          e.title,
          e.categoryName,
          e.paymentMethod,
          roundMoney(e.amount),
          e.notes || '—',
        ]),
        summaryLines: [
          { label: 'Expense Entries', value: String(filtered.length) },
          { label: 'Total Expenses', value: formatPKR(totalExp) },
        ],
      };
    }

    case 'inventory': {
      const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name));
      const totalUnits = roundStockQty(sorted.reduce((acc, p) => acc + p.currentStock, 0));
      const totalVal = sorted.reduce((acc, p) => roundMoney(acc + p.currentStock * p.purchasePrice), 0);
      const retailVal = sorted.reduce((acc, p) => roundMoney(acc + p.currentStock * p.salePrice), 0);
      return {
        title: 'Inventory Valuation Report',
        subtitle: `As of ${formatDateDDMMYYYY(getKarachiDateIso())}`,
        columns: ['Product', 'Category', 'Brand', 'Stock', 'Base Unit', 'Packaging Breakdown', 'Buy Price', 'Sale Price', 'Stock Value (PKR)', 'Margin %', 'Expiry'],
        rows: sorted.map((p) => {
          const breakdown = formatStockBreakdown(p.currentStock, p);
          return [
            p.name,
            p.categoryName,
            p.brandName,
            p.currentStock,
            getEffectiveBaseUnit(p),
            breakdown.packageBreakdownText || '—',
            roundMoney(p.purchasePrice),
            roundMoney(p.salePrice),
            roundMoney(p.currentStock * p.purchasePrice),
            `${p.profitMarginPct}%`,
            p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—',
          ];
        }),
        summaryLines: [
          { label: 'Total SKUs', value: String(sorted.length) },
          { label: 'Total Base Units in Stock', value: String(totalUnits) },
          { label: 'Inventory Value (Cost)', value: formatPKR(totalVal) },
          { label: 'Potential Retail Value', value: formatPKR(retailVal) },
        ],
      };
    }

    case 'stock_movements': {
      const filtered = stockMovements
        .filter((m) => inRange(m.movementDate))
        .sort((a, b) => b.movementDate.localeCompare(a.movementDate));
      return {
        title: 'Stock Movement Report',
        subtitle: `Period: ${rangeLabel}`,
        columns: ['Date', 'Product', 'Type', 'Unit Qty', 'Base Change', 'Prev Stock', 'New Stock', 'Notes'],
        rows: filtered.map((m) => [
          formatDateDDMMYYYY(m.movementDate),
          m.productName,
          m.movementType.replace(/_/g, ' '),
          m.unitName && m.unitQuantity ? `${m.unitQuantity} ${m.unitName}` : '—',
          m.quantityChange > 0 ? `+${m.quantityChange}` : String(m.quantityChange),
          m.previousStock,
          m.newStock,
          m.notes || '—',
        ]),
        summaryLines: [{ label: 'Total Movements Logged', value: String(filtered.length) }],
      };
    }

    case 'profit_loss': {
      const activeSales = sales.filter((s) => s.status !== 'cancelled' && inRange(s.saleDate));
      const activeItems = saleItems.filter((i) => i.status !== 'cancelled' && inRange(i.saleDate));
      const periodExpenses = expenses.filter((e) => inRange(e.expenseDate));

      const revenue = activeSales.reduce((acc, s) => roundMoney(acc + s.totalAmount), 0);
      const cogs = activeItems.reduce((acc, i) => roundMoney(acc + i.lineCost), 0);
      const grossProfit = roundMoney(revenue - cogs);
      const totalExp = periodExpenses.reduce((acc, e) => roundMoney(acc + e.amount), 0);
      const netProfit = roundMoney(grossProfit - totalExp);

      const expByCat = new Map<string, number>();
      for (const e of periodExpenses) {
        expByCat.set(e.categoryName, roundMoney((expByCat.get(e.categoryName) || 0) + e.amount));
      }

      const rows: (string | number)[][] = [
        ['Total Sales Revenue', formatPKR(revenue)],
        ['Less: Cost of Goods Sold (Historical Purchase Cost)', formatPKR(cogs)],
        ['Gross Profit', formatPKR(grossProfit)],
        ['Gross Profit Margin', revenue > 0 ? `${((grossProfit / revenue) * 100).toFixed(2)}%` : '0.00%'],
        ['--- Operating Expenses Breakdown ---', ''],
        ...Array.from(expByCat.entries()).map(([cat, amt]) => [`Expense: ${cat}`, formatPKR(amt)]),
        ['Total Business Expenses', formatPKR(totalExp)],
        ['Net Profit / (Loss)', formatPKR(netProfit)],
        ['Net Profit Margin', revenue > 0 ? `${((netProfit / revenue) * 100).toFixed(2)}%` : '0.00%'],
      ];

      return {
        title: 'Profit & Loss Statement',
        subtitle: `Period: ${rangeLabel}`,
        columns: ['Line Item', 'Amount / Value'],
        rows,
        summaryLines: [
          { label: 'Revenue', value: formatPKR(revenue) },
          { label: 'COGS', value: formatPKR(cogs) },
          { label: 'Gross Profit', value: formatPKR(grossProfit) },
          { label: 'Net Profit', value: formatPKR(netProfit) },
        ],
      };
    }

    case 'product_performance': {
      const perf = computeProductPerformance(products, saleItems, { fromDate, toDate });
      return {
        title: 'Product Performance Report',
        subtitle: `Period: ${rangeLabel}`,
        columns: ['Product Name', 'Category', 'Brand', 'Qty Sold', 'Revenue (PKR)', 'Cost (PKR)', 'Gross Profit (PKR)', 'Margin %'],
        rows: perf.rows.map((r) => [
          r.productName,
          r.categoryName,
          r.brandName,
          r.quantitySold,
          roundMoney(r.revenue),
          roundMoney(r.cost),
          roundMoney(r.grossProfit),
          `${r.profitMarginPct}%`,
        ]),
        summaryLines: [
          { label: 'Products Evaluated', value: String(perf.rows.length) },
          {
            label: 'Total Units Sold',
            value: String(perf.rows.reduce((a, b) => a + b.quantitySold, 0)),
          },
          {
            label: 'Total Gross Profit',
            value: formatPKR(perf.rows.reduce((a, b) => roundMoney(a + b.grossProfit), 0)),
          },
        ],
      };
    }

    case 'monthly_business': {
      const monthBuckets = new Map<
        string,
        { sales: number; cogs: number; expenses: number; purchases: number; units: number }
      >();
      const ensure = (mk: string) => {
        if (!monthBuckets.has(mk)) {
          monthBuckets.set(mk, { sales: 0, cogs: 0, expenses: 0, purchases: 0, units: 0 });
        }
        return monthBuckets.get(mk)!;
      };

      for (const s of sales) {
        if (s.status === 'cancelled' || !inRange(s.saleDate)) continue;
        const b = ensure(getMonthKey(s.saleDate));
        b.sales = roundMoney(b.sales + s.totalAmount);
        b.cogs = roundMoney(b.cogs + s.totalCost);
        b.units += s.totalQuantity;
      }
      for (const e of expenses) {
        if (!inRange(e.expenseDate)) continue;
        const b = ensure(getMonthKey(e.expenseDate));
        b.expenses = roundMoney(b.expenses + e.amount);
      }
      for (const p of purchases) {
        if (p.status === 'cancelled' || !inRange(p.purchaseDate)) continue;
        const b = ensure(getMonthKey(p.purchaseDate));
        b.purchases = roundMoney(b.purchases + p.totalAmount);
      }

      const sortedKeys = Array.from(monthBuckets.keys()).sort();
      return {
        title: 'Monthly Business Summary Report',
        subtitle: `Period: ${rangeLabel}`,
        columns: ['Month', 'Units Sold', 'Sales (PKR)', 'COGS (PKR)', 'Gross Profit (PKR)', 'Expenses (PKR)', 'Net Profit (PKR)', 'Purchases (PKR)'],
        rows: sortedKeys.map((mk) => {
          const b = monthBuckets.get(mk)!;
          const gp = roundMoney(b.sales - b.cogs);
          const np = roundMoney(gp - b.expenses);
          return [
            formatMonthLabel(mk),
            b.units,
            b.sales,
            b.cogs,
            gp,
            b.expenses,
            np,
            b.purchases,
          ];
        }),
        summaryLines: [{ label: 'Months Included', value: String(sortedKeys.length) }],
      };
    }

    case 'yearly_business': {
      const yearBuckets = new Map<
        string,
        { sales: number; cogs: number; expenses: number; purchases: number; units: number }
      >();
      const ensure = (yr: string) => {
        if (!yearBuckets.has(yr)) {
          yearBuckets.set(yr, { sales: 0, cogs: 0, expenses: 0, purchases: 0, units: 0 });
        }
        return yearBuckets.get(yr)!;
      };

      for (const s of sales) {
        if (s.status === 'cancelled') continue;
        const b = ensure(s.saleDate.slice(0, 4));
        b.sales = roundMoney(b.sales + s.totalAmount);
        b.cogs = roundMoney(b.cogs + s.totalCost);
        b.units += s.totalQuantity;
      }
      for (const e of expenses) {
        const b = ensure(e.expenseDate.slice(0, 4));
        b.expenses = roundMoney(b.expenses + e.amount);
      }
      for (const p of purchases) {
        if (p.status === 'cancelled') continue;
        const b = ensure(p.purchaseDate.slice(0, 4));
        b.purchases = roundMoney(b.purchases + p.totalAmount);
      }

      const sortedYears = Array.from(yearBuckets.keys()).sort();
      return {
        title: 'Yearly Business Summary Report',
        subtitle: 'All Recorded Fiscal Years',
        columns: ['Year', 'Units Sold', 'Sales (PKR)', 'COGS (PKR)', 'Gross Profit (PKR)', 'Expenses (PKR)', 'Net Profit (PKR)', 'Purchases (PKR)'],
        rows: sortedYears.map((yr) => {
          const b = yearBuckets.get(yr)!;
          const gp = roundMoney(b.sales - b.cogs);
          const np = roundMoney(gp - b.expenses);
          return [yr, b.units, b.sales, b.cogs, gp, b.expenses, np, b.purchases];
        }),
        summaryLines: [{ label: 'Years Included', value: String(sortedYears.length) }],
      };
    }
  }
}

export function exportReportPDF(report: ReportTableData, shopName: string): void {
  const doc = new jsPDF({ orientation: report.columns.length > 7 ? 'landscape' : 'portrait' });
  doc.setFontSize(16);
  doc.text(shopName || 'CareMart Shop Manager', 14, 16);
  doc.setFontSize(12);
  doc.text(report.title, 14, 24);
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(
    `${report.subtitle}  |  Generated: ${formatDateDDMMYYYY(getKarachiDateIso())} (Asia/Karachi)  |  Currency: PKR`,
    14,
    30
  );

  let startY = 36;
  if (report.summaryLines.length > 0) {
    doc.setTextColor(30);
    doc.setFontSize(9);
    const summaryText = report.summaryLines.map((s) => `${s.label}: ${s.value}`).join('   |   ');
    doc.text(summaryText, 14, 36);
    startY = 42;
  }

  autoTable(doc, {
    head: [report.columns],
    body: report.rows,
    startY,
    styles: { fontSize: 8, cellPadding: 2.5 },
    headStyles: { fillColor: [13, 148, 136], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });

  const slug = report.title.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  doc.save(`${slug}_${getKarachiDateIso()}.pdf`);
}

export function exportReportExcel(report: ReportTableData, shopName: string): void {
  const headerRows: (string | number)[][] = [
    [shopName || 'CareMart Shop Manager'],
    [report.title],
    [report.subtitle],
    [`Generated: ${formatDateDDMMYYYY(getKarachiDateIso())} (Asia/Karachi)`, 'Currency: PKR'],
    [],
    ...report.summaryLines.map((s) => [s.label, s.value]),
    [],
    report.columns,
    ...report.rows,
  ];

  const ws = XLSX.utils.aoa_to_sheet(headerRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, report.title.slice(0, 31));
  const slug = report.title.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  XLSX.writeFile(wb, `${slug}_${getKarachiDateIso()}.xlsx`);
}
