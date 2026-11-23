export const CARE_MART_SPREADSHEET_TITLE = 'CareMart Shop Manager – Business Records';

export type SheetTabName =
  | 'Products'
  | 'Sales'
  | 'Sales Details'
  | 'Purchases'
  | 'Purchase Details'
  | 'Expenses'
  | 'Inventory'
  | 'Stock Movements'
  | 'Stock Adjustments'
  | 'Suppliers'
  | 'Categories & Brands'
  | 'Daily Summary'
  | 'Monthly Summary'
  | 'Staff Performance';

export type SheetSyncMode = 'upsert_by_id' | 'replace_sorted_summary';

export type ColumnFormatType = 'text' | 'date' | 'currency' | 'integer' | 'percent';

export interface SheetTabDefinition {
  name: SheetTabName;
  headers: readonly string[];
  syncMode: SheetSyncMode;
  /** Column index (0-based) for unique ID when syncMode === 'upsert_by_id'. */
  idColumnIndex: number;
  /** Optional status column index (0-based) to mark deleted catalog items instead of dropping history. */
  deletedStatusColumnIndex?: number;
  /** Formatting hint per column index (matches headers.length). */
  columnFormats: readonly ColumnFormatType[];
  /** Suggested column pixel widths (matches headers.length). */
  columnWidths: readonly number[];
}

export const SHEET_TABS: readonly SheetTabDefinition[] = [
  {
    name: 'Products',
    headers: [
      'Product ID',
      'Product Name',
      'Category',
      'Brand',
      'Purchase Price',
      'Selling Price',
      'Wholesale Price',
      'Current Stock',
      'Minimum Stock',
      'Maximum Stock',
      'Unit',
      'Supplier',
      'Expiry Date',
      'Profit Margin',
      'Created Date',
      'Last Updated',
    ],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    columnFormats: [
      'text',
      'text',
      'text',
      'text',
      'currency',
      'currency',
      'currency',
      'integer',
      'integer',
      'integer',
      'text',
      'text',
      'date',
      'percent',
      'date',
      'date',
    ],
    columnWidths: [170, 220, 140, 130, 125, 125, 125, 110, 115, 115, 90, 150, 115, 115, 120, 145],
  },
  {
    name: 'Sales',
    headers: [
      'Sale ID',
      'Sale Date',
      'Sales Staff Name',
      'Total Sale Amount',
      'Payment Method (Cash/Online)',
      'Total Items',
      'Notes',
      'Transaction Status',
      'Created Date',
      'Customer WhatsApp Number',
    ],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    columnFormats: ['text', 'date', 'text', 'currency', 'text', 'integer', 'text', 'text', 'date', 'text'],
    columnWidths: [170, 115, 155, 140, 185, 100, 240, 140, 145, 175],
  },
  {
    name: 'Sales Details',
    headers: [
      'Sale Item ID',
      'Sale ID',
      'Sale Date',
      'Product Name',
      'Product ID',
      'Quantity Sold',
      'Selling Price',
      'Purchase Cost at Time of Sale',
      'Line Total',
      'Gross Profit',
      'Sales Staff Name',
      'Transaction Status',
    ],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    columnFormats: [
      'text',
      'text',
      'date',
      'text',
      'text',
      'integer',
      'currency',
      'currency',
      'currency',
      'currency',
      'text',
      'text',
    ],
    columnWidths: [170, 170, 115, 220, 170, 110, 120, 185, 125, 125, 155, 135],
  },
  {
    name: 'Purchases',
    headers: [
      'Purchase ID',
      'Purchase Date',
      'Supplier',
      'Total Purchase Amount',
      'Amount Paid',
      'Remaining Balance',
      'Payment Method',
      'Notes',
      'Transaction Status',
    ],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    columnFormats: ['text', 'date', 'text', 'currency', 'currency', 'currency', 'text', 'text', 'text'],
    columnWidths: [170, 120, 170, 165, 130, 145, 135, 240, 140],
  },
  {
    name: 'Purchase Details',
    headers: [
      'Purchase Item ID',
      'Purchase ID',
      'Purchase Date',
      'Product Name',
      'Product ID',
      'Quantity Purchased',
      'Purchase Price',
      'Total Amount',
    ],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    columnFormats: ['text', 'text', 'date', 'text', 'text', 'integer', 'currency', 'currency'],
    columnWidths: [170, 170, 120, 220, 170, 145, 130, 130],
  },
  {
    name: 'Expenses',
    headers: [
      'Expense ID',
      'Expense Date',
      'Expense Title',
      'Expense Category',
      'Amount',
      'Payment Method (Cash/Online)',
      'Notes',
      'Created Date',
    ],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    columnFormats: ['text', 'date', 'text', 'text', 'currency', 'text', 'text', 'date'],
    columnWidths: [170, 120, 210, 155, 130, 185, 240, 145],
  },
  {
    name: 'Inventory',
    headers: [
      'Product ID',
      'Product Name',
      'Category',
      'Brand',
      'Current Stock',
      'Minimum Stock',
      'Maximum Stock',
      'Purchase Price',
      'Stock Value',
      'Last Updated',
    ],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    columnFormats: [
      'text',
      'text',
      'text',
      'text',
      'integer',
      'integer',
      'integer',
      'currency',
      'currency',
      'date',
    ],
    columnWidths: [170, 220, 140, 130, 115, 115, 115, 130, 140, 145],
  },
  {
    name: 'Stock Movements',
    headers: [
      'Movement ID',
      'Date',
      'Product ID',
      'Product Name',
      'Movement Type',
      'Quantity Added',
      'Quantity Removed',
      'Previous Stock',
      'New Stock',
      'Reason',
      'Reference ID',
    ],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    columnFormats: [
      'text',
      'date',
      'text',
      'text',
      'text',
      'integer',
      'integer',
      'integer',
      'integer',
      'text',
      'text',
    ],
    columnWidths: [170, 115, 170, 210, 145, 120, 130, 120, 110, 230, 170],
  },
  {
    name: 'Stock Adjustments',
    headers: [
      'Adjustment ID',
      'Date',
      'Product Name',
      'Adjustment Type',
      'Quantity',
      'Reason',
      'Notes',
    ],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    columnFormats: ['text', 'date', 'text', 'text', 'integer', 'text', 'text'],
    columnWidths: [170, 115, 220, 135, 100, 200, 240],
  },
  {
    name: 'Suppliers',
    headers: [
      'Supplier ID',
      'Supplier Name',
      'Contact Person',
      'Phone',
      'Address',
      'Total Purchases',
      'Total Payments',
      'Outstanding Balance',
    ],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    columnFormats: ['text', 'text', 'text', 'text', 'text', 'currency', 'currency', 'currency'],
    columnWidths: [170, 190, 150, 135, 230, 140, 140, 155],
  },
  {
    name: 'Categories & Brands',
    headers: ['Record ID', 'Record Type', 'Name', 'Created Date', 'Status'],
    syncMode: 'upsert_by_id',
    idColumnIndex: 0,
    deletedStatusColumnIndex: 4,
    columnFormats: ['text', 'text', 'text', 'date', 'text'],
    columnWidths: [185, 120, 220, 140, 110],
  },
  {
    name: 'Daily Summary',
    headers: [
      'Date',
      'Total Sales',
      'Cash Sales',
      'Online Sales',
      'Total Purchases',
      'Total Expenses',
      'Gross Profit',
      'Net Profit',
      'Products Sold',
      'Closing Stock Value',
    ],
    syncMode: 'replace_sorted_summary',
    idColumnIndex: 0,
    columnFormats: [
      'date',
      'currency',
      'currency',
      'currency',
      'currency',
      'currency',
      'currency',
      'currency',
      'integer',
      'currency',
    ],
    columnWidths: [120, 130, 125, 125, 140, 135, 130, 130, 120, 155],
  },
  {
    name: 'Monthly Summary',
    headers: [
      'Month',
      'Year',
      'Total Sales',
      'Total Purchases',
      'Total Expenses',
      'Gross Profit',
      'Net Profit',
      'Revenue Growth %',
      'Profit Growth %',
      'Units Sold',
    ],
    syncMode: 'replace_sorted_summary',
    idColumnIndex: 0,
    columnFormats: [
      'text',
      'integer',
      'currency',
      'currency',
      'currency',
      'currency',
      'currency',
      'percent',
      'percent',
      'integer',
    ],
    columnWidths: [120, 90, 130, 140, 135, 130, 130, 145, 140, 110],
  },
  {
    name: 'Staff Performance',
    headers: [
      'Staff ID',
      'Staff Name',
      'Date',
      'Total Sales',
      'Cash Sales',
      'Online Sales',
      'Products Sold',
      'Number of Transactions',
    ],
    syncMode: 'replace_sorted_summary',
    idColumnIndex: 0,
    columnFormats: ['text', 'text', 'date', 'currency', 'currency', 'currency', 'integer', 'integer'],
    columnWidths: [170, 170, 115, 130, 125, 125, 120, 165],
  },
] as const;

export const SHEET_TAB_MAP: Record<SheetTabName, SheetTabDefinition> = SHEET_TABS.reduce(
  (acc, tab) => {
    acc[tab.name] = tab;
    return acc;
  },
  {} as Record<SheetTabName, SheetTabDefinition>
);

export type SheetCellValue = string | number | boolean;

export type SheetSyncPayload = Partial<Record<SheetTabName, SheetCellValue[][]>>;
