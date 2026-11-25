import { ChevronDown, Download, FileSpreadsheet, FileText, Filter, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CompactExpandableRow, CompactSection } from '../components/CompactSection';
import { SearchableSelect, type SearchableSelectOption } from '../components/SearchableSelect';
import { useAuth } from '../contexts/AuthContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import { computeTopActivityValues } from '../services/recordSearchService';
import type { PaymentMethod } from '../types/shop';
import { addDaysToIso, getKarachiDateIso } from '../utils/formatters';
import { formatStockBreakdown } from '../utils/packaging';
import {
  buildReportData,
  exportReportExcel,
  exportReportPDF,
  type ReportType,
} from '../utils/reports';
import {
  buildSellerFilterOptions,
  getSaleSellerKey,
  matchesSellerFilter,
} from '../utils/sellerAttribution';

const REPORT_TYPES: Array<{ id: ReportType; label: string; description: string }> = [
  { id: 'sales', label: 'Sales Report', description: 'All completed and cancelled sales with seller, COGS, and profit' },
  { id: 'seller_performance', label: 'Admin & Staff Sales Report', description: 'Compare sales revenue, bills, and profit by each Admin and Staff member' },
  { id: 'purchases', label: 'Purchase Report', description: 'Supplier purchases, paid amounts, and balances due' },
  { id: 'expenses', label: 'Expense Report', description: 'Operating expenses by category and payment method' },
  { id: 'inventory', label: 'Inventory Report', description: 'Current stock quantities, valuation, margins, and expiry' },
  { id: 'stock_movements', label: 'Stock Movement Report', description: 'Full audit trail of stock increases and deductions' },
  { id: 'profit_loss', label: 'Profit & Loss Report', description: 'Revenue, COGS, gross profit, expenses, and net profit' },
  { id: 'product_performance', label: 'Product Performance Report', description: 'Product-wise quantity sold, revenue, cost, and margin' },
  { id: 'monthly_business', label: 'Monthly Business Report', description: 'Month-by-month sales, profit, expenses, and purchases' },
  { id: 'yearly_business', label: 'Yearly Business Report', description: 'Annual fiscal summary across all recorded years' },
];

export function ReportsPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { showToast } = useToast();
  const [exportingFormat, setExportingFormat] = useState<'pdf' | 'excel' | null>(null);
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
    stockMovements,
    settings,
  } = useShopData();
  const todayIso = getKarachiDateIso();

  const [reportType, setReportType] = useState<ReportType>('sales');
  const [fromDate, setFromDate] = useState(() => addDaysToIso(todayIso, -29));
  const [toDate, setToDate] = useState(() => todayIso);

  const [filterProductId, setFilterProductId] = useState('');
  const [filterCategoryId, setFilterCategoryId] = useState('');
  const [filterBrandId, setFilterBrandId] = useState('');
  const [filterSupplierId, setFilterSupplierId] = useState('');
  const [filterStaffId, setFilterStaffId] = useState('');
  const [filterPaymentMethod, setFilterPaymentMethod] = useState<'' | PaymentMethod>('');
  const [showFilters, setShowFilters] = useState(false);
  const [showQuickCards, setShowQuickCards] = useState(false);
  const [expandedRowIdx, setExpandedRowIdx] = useState<number | null>(null);

  const reportTypeOptions = useMemo<SearchableSelectOption[]>(
    () =>
      REPORT_TYPES.map((rt) => ({
        value: rt.id,
        label: rt.label,
        subtitle: rt.description,
      })),
    []
  );

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
      { value: 'Cash', label: 'Cash', subtitle: 'Cash transactions' },
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

  const hasProductDimensionFilter = Boolean(
    filterProductId || filterCategoryId || filterBrandId || filterSupplierId
  );

  const hasAnyFilter = Boolean(
    hasProductDimensionFilter || filterStaffId || filterPaymentMethod
  );

  const filteredProducts = useMemo(() => {
    if (!hasProductDimensionFilter) return products;
    return products.filter((p) => {
      if (filterProductId && p.id !== filterProductId) return false;
      if (filterCategoryId && p.categoryId !== filterCategoryId) return false;
      if (filterBrandId && p.brandId !== filterBrandId) return false;
      if (filterSupplierId && p.supplierId !== filterSupplierId) return false;
      return true;
    });
  }, [
    products,
    hasProductDimensionFilter,
    filterProductId,
    filterCategoryId,
    filterBrandId,
    filterSupplierId,
  ]);

  const matchingProductIds = useMemo(
    () => new Set(filteredProducts.map((p) => p.id)),
    [filteredProducts]
  );

  const filteredSaleItems = useMemo(() => {
    if (!hasAnyFilter) return saleItems;
    const validSaleIdsByHeader =
      filterStaffId || filterPaymentMethod
        ? new Set(
            sales
              .filter((s) => {
                if (!matchesSellerFilter(s, filterStaffId)) return false;
                if (filterPaymentMethod && s.paymentMethod !== filterPaymentMethod) return false;
                return true;
              })
              .map((s) => s.id)
          )
        : null;

    return saleItems.filter((item) => {
      if (validSaleIdsByHeader && !validSaleIdsByHeader.has(item.saleId)) return false;
      if (hasProductDimensionFilter && !matchingProductIds.has(item.productId)) return false;
      return true;
    });
  }, [
    saleItems,
    sales,
    hasAnyFilter,
    filterStaffId,
    filterPaymentMethod,
    hasProductDimensionFilter,
    matchingProductIds,
  ]);

  const filteredSales = useMemo(() => {
    if (!hasAnyFilter) return sales;
    const saleIdsWithMatchingItems = hasProductDimensionFilter
      ? new Set(
          saleItems
            .filter((item) => matchingProductIds.has(item.productId))
            .map((item) => item.saleId)
        )
      : null;

    return sales.filter((s) => {
      if (!matchesSellerFilter(s, filterStaffId)) return false;
      if (filterPaymentMethod && s.paymentMethod !== filterPaymentMethod) return false;
      if (saleIdsWithMatchingItems && !saleIdsWithMatchingItems.has(s.id)) return false;
      return true;
    });
  }, [
    sales,
    saleItems,
    hasAnyFilter,
    filterStaffId,
    filterPaymentMethod,
    hasProductDimensionFilter,
    matchingProductIds,
  ]);

  const filteredPurchases = useMemo(() => {
    if (!filterSupplierId && !filterPaymentMethod) return purchases;
    return purchases.filter((p) => {
      if (filterSupplierId && p.supplierId !== filterSupplierId) return false;
      if (filterPaymentMethod && p.paymentMethod !== filterPaymentMethod) return false;
      return true;
    });
  }, [purchases, filterSupplierId, filterPaymentMethod]);

  const filteredExpenses = useMemo(() => {
    if (!filterPaymentMethod) return expenses;
    return expenses.filter((e) => e.paymentMethod === filterPaymentMethod);
  }, [expenses, filterPaymentMethod]);

  const filteredStockMovements = useMemo(() => {
    if (!hasProductDimensionFilter) return stockMovements;
    return stockMovements.filter((m) => matchingProductIds.has(m.productId));
  }, [stockMovements, hasProductDimensionFilter, matchingProductIds]);

  const report = useMemo(
    () =>
      buildReportData(reportType, {
        fromDate,
        toDate,
        settings,
        products: filteredProducts,
        sales: filteredSales,
        saleItems: filteredSaleItems,
        purchases: filteredPurchases,
        expenses: filteredExpenses,
        stockMovements: filteredStockMovements,
        staffMembers,
        adminMembers,
        user,
        shopId: activeShopId,
      }),
    [
      reportType,
      fromDate,
      toDate,
      settings,
      filteredProducts,
      filteredSales,
      filteredSaleItems,
      filteredPurchases,
      filteredExpenses,
      filteredStockMovements,
      staffMembers,
      adminMembers,
      user,
      activeShopId,
    ]
  );

  const shopName = settings?.shopName || 'CareMart Shop Manager';

  const clearReportFilters = () => {
    setFilterProductId('');
    setFilterCategoryId('');
    setFilterBrandId('');
    setFilterSupplierId('');
    setFilterStaffId('');
    setFilterPaymentMethod('');
  };

  const activeFilterCount = [
    filterProductId,
    filterCategoryId,
    filterBrandId,
    filterSupplierId,
    filterStaffId,
    filterPaymentMethod,
  ].filter(Boolean).length;

  return (
    <div className="space-y-4">
      {/* Report Selection & Export Controls */}
      <section className="cm-surface border rounded-xl p-3.5 sm:p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2.5">
          <div>
            <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">Business Reports</h2>
            <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
              Preview and export in PDF or Excel format.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {hasAnyFilter && (
              <button
                type="button"
                onClick={clearReportFilters}
                className="inline-flex items-center gap-1 px-2.5 py-2 min-h-[40px] sm:min-h-[36px] text-xs font-medium text-[var(--cm-accent-text)] border border-[var(--cm-accent-border)] bg-[var(--cm-accent-soft)] rounded-lg cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                Reset
              </button>
            )}
            <button
              type="button"
              disabled={exportingFormat !== null}
              onClick={() => {
                setExportingFormat('pdf');
                void exportReportPDF(report, shopName)
                  .catch((err) => {
                    showToast({
                      title: 'PDF export failed',
                      message: err instanceof Error ? err.message : 'Unable to generate PDF report.',
                      tone: 'error',
                    });
                  })
                  .finally(() => setExportingFormat(null));
              }}
              className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[40px] sm:min-h-[36px] text-xs sm:text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
            >
              <FileText className="w-4 h-4" />
              {exportingFormat === 'pdf' ? 'Exporting...' : 'PDF'}
            </button>
            <button
              type="button"
              disabled={exportingFormat !== null}
              onClick={() => {
                setExportingFormat('excel');
                void exportReportExcel(report, shopName)
                  .catch((err) => {
                    showToast({
                      title: 'Excel export failed',
                      message: err instanceof Error ? err.message : 'Unable to generate Excel report.',
                      tone: 'error',
                    });
                  })
                  .finally(() => setExportingFormat(null));
              }}
              className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[40px] sm:min-h-[36px] text-xs sm:text-sm font-semibold text-[var(--cm-text-secondary)] bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
            >
              <FileSpreadsheet className="w-4 h-4 text-[var(--cm-success)]" />
              {exportingFormat === 'excel' ? 'Exporting...' : 'Excel'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 pt-2 border-t border-[var(--cm-border)]">
          <div className="col-span-2 md:col-span-1">
            <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">Report Type</label>
            <SearchableSelect
              options={reportTypeOptions}
              value={reportType}
              onChange={(val) => {
                if (val) {
                  setReportType(val as ReportType);
                  setExpandedRowIdx(null);
                }
              }}
              placeholder="Select report type..."
              searchPlaceholder="Search report type..."
              ariaLabel="Report type"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">From Date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full px-2.5 py-1.5 min-h-[40px] sm:min-h-0 text-xs sm:text-sm cm-input border rounded-lg font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">To Date</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full px-2.5 py-1.5 min-h-[40px] sm:min-h-0 text-xs sm:text-sm cm-input border rounded-lg font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className="md:hidden inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-semibold text-[var(--cm-text-secondary)] bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] rounded-lg cursor-pointer"
          >
            <Filter className="w-3.5 h-3.5 text-[var(--cm-accent)]" />
            Filters {activeFilterCount > 0 ? `(${activeFilterCount})` : ''}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => setShowQuickCards((v) => !v)}
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--cm-accent-text)] hover:underline cursor-pointer"
          >
            <span>{showQuickCards ? 'Hide Report Directory' : 'All 10 Report Types'}</span>
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showQuickCards ? 'rotate-180' : ''}`} />
          </button>
        </div>

        <div
          className={`${
            showFilters ? 'grid' : 'hidden md:grid'
          } grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2 pt-2 border-t border-[var(--cm-border)]`}
        >
          <SearchableSelect
            options={productOptions}
            value={filterProductId}
            onChange={setFilterProductId}
            emptyOptionLabel="All Products"
            placeholder="All Products"
            searchPlaceholder="Search product..."
            ariaLabel="Filter report by product"
            suggestionScope="product"
            suggestedValues={frequentProductIds}
            size="sm"
          />
          <SearchableSelect
            options={categoryOptions}
            value={filterCategoryId}
            onChange={setFilterCategoryId}
            emptyOptionLabel="All Categories"
            placeholder="All Categories"
            searchPlaceholder="Search category..."
            ariaLabel="Filter report by category"
            suggestionScope="category"
            suggestedValues={frequentCategoryIds}
            size="sm"
          />
          <SearchableSelect
            options={brandOptions}
            value={filterBrandId}
            onChange={setFilterBrandId}
            emptyOptionLabel="All Brands"
            placeholder="All Brands"
            searchPlaceholder="Search brand..."
            ariaLabel="Filter report by brand"
            suggestionScope="brand"
            suggestedValues={frequentBrandIds}
            size="sm"
          />
          <SearchableSelect
            options={supplierOptions}
            value={filterSupplierId}
            onChange={setFilterSupplierId}
            emptyOptionLabel="All Suppliers"
            placeholder="All Suppliers"
            searchPlaceholder="Search supplier..."
            ariaLabel="Filter report by supplier"
            suggestionScope="supplier"
            suggestedValues={frequentSupplierIds}
            size="sm"
          />
          <SearchableSelect
            options={staffOptions}
            value={filterStaffId}
            onChange={setFilterStaffId}
            emptyOptionLabel="All Sellers (Admins & Staff)"
            placeholder="All Sellers (Admins & Staff)"
            searchPlaceholder="Search admin or staff..."
            ariaLabel="Filter report by admin or staff member"
            suggestionScope="staff"
            suggestedValues={frequentStaffIds}
            size="sm"
          />
          <SearchableSelect
            options={paymentOptions}
            value={filterPaymentMethod}
            onChange={(val) => setFilterPaymentMethod(val as '' | PaymentMethod)}
            emptyOptionLabel="All Payments"
            placeholder="All Payments"
            searchPlaceholder="Search payment..."
            ariaLabel="Filter report by payment method"
            showFrequentSection={false}
            size="sm"
          />
        </div>

        {showQuickCards && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2 border-t border-[var(--cm-border)]">
            {REPORT_TYPES.map((rt) => (
              <button
                key={rt.id}
                type="button"
                onClick={() => {
                  setReportType(rt.id);
                  setExpandedRowIdx(null);
                }}
                className={`text-left p-2.5 border rounded-lg transition-colors cursor-pointer ${
                  reportType === rt.id
                    ? 'border-[var(--cm-accent-border)] bg-[var(--cm-accent-soft)]'
                    : 'border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[var(--cm-text-primary)]">{rt.label}</span>
                  <Download className="w-3.5 h-3.5 text-[var(--cm-text-muted)]" />
                </div>
                <p className="mt-0.5 text-[11px] text-[var(--cm-text-muted)]">{rt.description}</p>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Live Preview */}
      <CompactSection
        title={report.title}
        subtitle={report.subtitle}
        summary={`${report.rows.length} rows`}
      >
        {report.summaryLines.length > 0 && (
          <div className="px-3.5 py-2.5 border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] grid grid-cols-2 sm:flex sm:flex-wrap gap-x-5 gap-y-1.5 text-xs">
            {report.summaryLines.map((s) => (
              <div key={s.label}>
                <span className="text-[var(--cm-text-muted)]">{s.label}: </span>
                <span className="font-semibold font-mono-num tabular-nums text-[var(--cm-text-primary)]">{s.value}</span>
              </div>
            ))}
          </div>
        )}

        {report.rows.length === 0 ? (
          <div className="p-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
            No records found for this report in the selected date range.
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                    {report.columns.map((col) => (
                      <th key={col} className="py-2 px-3 whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                  {report.rows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-[var(--cm-bg-hover)]">
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="py-2 px-3 font-mono-num text-[var(--cm-text-secondary)] whitespace-nowrap">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-[var(--cm-border)]">
              {report.rows.map((row, idx) => {
                const primaryLabel = row[0] ?? `Row ${idx + 1}`;
                const secondaryLabel = row.length > 2 ? `${report.columns[1]}: ${row[1]}` : undefined;
                const rightValue = row[row.length - 1] ?? '';
                const rightSub = row.length > 3 ? `${report.columns[row.length - 2]}: ${row[row.length - 2]}` : undefined;

                return (
                  <CompactExpandableRow
                    key={idx}
                    title={primaryLabel}
                    subtitle={secondaryLabel}
                    rightPrimary={rightValue}
                    rightSecondary={rightSub}
                    isExpanded={expandedRowIdx === idx}
                    onToggle={() => setExpandedRowIdx((prev) => (prev === idx ? null : idx))}
                    expandedContent={
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[var(--cm-text-secondary)]">
                        {report.columns.map((col, cIdx) => (
                          <div key={col} className="min-w-0">
                            <div className="text-[10px] text-[var(--cm-text-muted)] uppercase tracking-wide">{col}</div>
                            <div className="font-mono-num text-[var(--cm-text-primary)] font-medium break-words">
                              {row[cIdx] ?? '—'}
                            </div>
                          </div>
                        ))}
                      </div>
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </CompactSection>
    </div>
  );
}
