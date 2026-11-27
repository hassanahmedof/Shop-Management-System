import type { Timestamp } from 'firebase/firestore';

export type PaymentMethod = 'Cash' | 'Online';
export type TransactionStatus = 'completed' | 'cancelled';
export type AdjustmentType = 'add' | 'reduce' | 'damaged' | 'expired' | 'missing';
export type MovementType =
  | 'sale'
  | 'sale_edit'
  | 'sale_cancel'
  | 'purchase'
  | 'purchase_cancel'
  | 'adjustment_add'
  | 'adjustment_reduce'
  | 'adjustment_damaged'
  | 'adjustment_expired'
  | 'adjustment_missing'
  | 'initial_stock';

export interface UserProfile {
  id: string;
  uid: string;
  displayName: string;
  email: string;
  role: 'owner' | 'admin';
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ShopSettings {
  id: string;
  ownerUid: string;
  shopName: string;
  ownerName: string;
  phone: string;
  address: string;
  currency: 'PKR';
  timezone: 'Asia/Karachi';
  dateFormat: 'DD-MM-YYYY';
  language: 'English';
  expiryAlertDays: number;
  autoBackupEnabled: boolean;
  lastBackupAt: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Category {
  id: string;
  ownerUid: string;
  name: string;
  description: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Brand {
  id: string;
  ownerUid: string;
  name: string;
  categoryIds?: string[];
  isActive?: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Supplier {
  id: string;
  ownerUid: string;
  name: string;
  phone: string;
  address: string;
  totalPurchased: number;
  totalPaid: number;
  outstandingBalance: number;
  notes: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type OriginType = '' | 'local' | 'imported';

export interface ProductPackagingUnit {
  unitName: string;
  conversionQty: number; // Cumulative number of smallest base stock units in 1 of this unit
  containsQty?: number; // Quantity of parentUnitName contained in 1 of this package
  parentUnitName?: string; // Immediately smaller unit name (baseUnit or another level)
  allowPurchase: boolean;
  allowSale: boolean;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice: number;
  isDefaultPurchase?: boolean;
  isDefaultSale?: boolean;
}

export interface StaffPackagingOption {
  unitName: string;
  conversionQty: number;
  containsQty?: number;
  parentUnitName?: string;
  allowSale: boolean;
  salePrice: number;
  wholesalePrice: number;
  isDefaultSale?: boolean;
}

export interface StorefrontPackagingOption {
  unitName: string;
  conversionQty: number;
  containsQty?: number;
  parentUnitName?: string;
  allowSale: boolean;
  salePrice: number;
  isDefaultSale?: boolean;
}

export interface BatchAllocation {
  batchId: string;
  consumedBaseQty: number;
  unitCostInBase: number;
}

export interface InventoryBatch {
  id: string;
  ownerUid: string;
  productId: string;
  productName: string;
  purchaseId: string;
  purchaseNumber: string;
  purchaseDate: string; // YYYY-MM-DD
  supplierId: string;
  supplierName: string;
  initialBaseQty: number;
  remainingBaseQty: number;
  unitCostInBase: number;
  expiryDate: string; // YYYY-MM-DD or ''
  status: 'active' | 'exhausted' | 'cancelled';
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Product {
  id: string;
  ownerUid: string;
  name: string;
  categoryId: string;
  categoryName: string;
  brandId: string;
  brandName: string;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice: number;
  currentStock: number;
  minStockLevel: number;
  maxStockLevel: number;
  unit: string;
  baseUnit?: string;
  packagingUnits?: ProductPackagingUnit[];
  originType?: OriginType;
  bottleSize?: string;
  storageLocation?: string;
  isReturnable?: boolean;
  returnableUnitName?: string;
  depositPerReturnable?: number;
  emptyContainersOnHand?: number;
  supplierId: string;
  supplierName: string;
  expiryDate: string; // YYYY-MM-DD or ''
  profitMarginPct: number;
  image?: string;
  isActive: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ProductTemplatePackaging {
  unitName: string;
  containsQty: number;
  parentUnitName: string;
  conversionQty: number;
  allowPurchase: boolean;
  allowSale: boolean;
  isDefaultPurchase?: boolean;
  isDefaultSale?: boolean;
  needsConfirmation?: boolean;
}

export interface ProductTemplate {
  id: string;
  ownerUid: string;
  name: string;
  categoryId: string;
  categoryName: string;
  brandId: string;
  brandName: string;
  variant: string;
  originType?: OriginType;
  baseUnit: string;
  defaultPurchaseUnit?: string;
  defaultSaleUnit?: string;
  packagingUnits?: ProductTemplatePackaging[];
  hasUnconfirmedPackaging?: boolean;
  suggestedPurchasePrice?: number;
  suggestedSalePrice?: number;
  suggestedWholesalePrice?: number;
  priceSource?: string;
  priceUpdatedAt?: string;
  trackExpiry?: boolean;
  bottleSize?: string;
  storageLocation?: string;
  isReturnable?: boolean;
  returnableUnitName?: string;
  searchKeywords?: string[];
  isActive: boolean;
  isCustom?: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Sale {
  id: string;
  ownerUid: string;
  saleNumber: string;
  saleDate: string; // YYYY-MM-DD
  saleDateTime?: string; // DD-MM-YYYY HH:mm (Asia/Karachi)
  paymentMethod: PaymentMethod;
  totalAmount: number;
  totalCost: number;
  totalProfit: number;
  totalQuantity: number;
  itemCount: number;
  staffId?: string;
  staffName?: string;
  recordedByRole?: 'owner' | 'staff' | 'website';
  customerWhatsapp?: string;
  notes: string;
  status: TransactionStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface SaleItem {
  id: string;
  ownerUid: string;
  saleId: string;
  saleDate: string; // YYYY-MM-DD
  productId: string;
  productName: string;
  categoryId: string;
  categoryName: string;
  brandId: string;
  brandName: string;
  quantity: number;
  unitName?: string;
  unitQuantity?: number;
  conversionFactor?: number;
  baseQuantity?: number;
  salePricePerUnit: number;
  purchasePriceAtSale: number;
  lineTotal: number;
  lineCost: number;
  lineProfit: number;
  batchAllocations?: BatchAllocation[];
  staffId?: string;
  staffName?: string;
  status: TransactionStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Purchase {
  id: string;
  ownerUid: string;
  purchaseNumber: string;
  purchaseDate: string; // YYYY-MM-DD
  supplierId: string;
  supplierName: string;
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  paymentMethod: PaymentMethod;
  totalQuantity: number;
  itemCount: number;
  notes: string;
  status: TransactionStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface PurchaseItem {
  id: string;
  ownerUid: string;
  purchaseId: string;
  purchaseDate: string; // YYYY-MM-DD
  supplierId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitName?: string;
  unitQuantity?: number;
  conversionFactor?: number;
  baseQuantity?: number;
  expiryDate?: string;
  purchasePricePerUnit: number;
  lineTotal: number;
  status: TransactionStatus;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ExpenseCategory {
  id: string;
  ownerUid: string;
  name: string;
  isDefault: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Expense {
  id: string;
  ownerUid: string;
  title: string;
  categoryId: string;
  categoryName: string;
  amount: number;
  expenseDate: string; // YYYY-MM-DD
  paymentMethod: PaymentMethod;
  notes: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface StockMovement {
  id: string;
  ownerUid: string;
  productId: string;
  productName: string;
  movementDate: string; // YYYY-MM-DD
  movementType: MovementType;
  quantityChange: number;
  previousStock: number;
  newStock: number;
  unitName?: string;
  unitQuantity?: number;
  conversionFactor?: number;
  baseQuantity?: number;
  referenceId: string;
  notes: string;
  createdAt?: Timestamp;
}

export interface StockAdjustment {
  id: string;
  ownerUid: string;
  productId: string;
  productName: string;
  adjustmentDate: string; // YYYY-MM-DD
  adjustmentType: AdjustmentType;
  quantity: number;
  unitName?: string;
  unitQuantity?: number;
  conversionFactor?: number;
  baseQuantity?: number;
  reason: string;
  notes: string;
  previousStock: number;
  newStock: number;
  createdAt?: Timestamp;
}

export interface AuditLog {
  id: string;
  ownerUid: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  createdAt?: Timestamp;
}

export interface BackupRecord {
  id: string;
  ownerUid: string;
  backupType: 'automatic' | 'manual';
  recordCount: number;
  notes: string;
  createdAt?: Timestamp;
}

export type SessionRole = 'owner' | 'sales_staff';

export interface StaffPermissions {
  canAddSales: boolean;
  canViewOwnSales: boolean;
  canViewStock: boolean;
}

export interface StaffMember {
  id: string;
  ownerUid: string;
  shopId: string;
  shopCode: string;
  name: string;
  phone: string;
  username: string;
  usernameLower: string;
  authUid: string;
  loginVersion: number;
  role: 'sales_staff' | 'staff';
  isActive: boolean;
  permissions: StaffPermissions;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface StaffLookup {
  ownerUid: string;
  shopId: string;
  staffId: string;
  loginVersion: number;
  isActive: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface StaffAuthMap {
  ownerUid: string;
  shopId: string;
  staffId: string;
  isActive: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface AdminMember {
  id: string;
  ownerUid: string;
  shopId: string;
  shopCode: string;
  name: string;
  phone: string;
  username: string;
  usernameLower: string;
  authUid: string;
  loginVersion: number;
  role: 'admin';
  isActive: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface AdminLookup {
  ownerUid: string;
  shopId: string;
  adminMemberId: string;
  loginVersion: number;
  isActive: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface AdminAuthMap {
  ownerUid: string;
  shopId: string;
  adminMemberId: string;
  isActive: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface StaffCatalogItem {
  id: string;
  ownerUid: string;
  productId: string;
  name: string;
  categoryName: string;
  brandName: string;
  salePrice: number;
  wholesalePrice?: number;
  currentStock: number;
  unit: string;
  baseUnit?: string;
  packagingUnits?: StaffPackagingOption[];
  originType?: OriginType;
  bottleSize?: string;
  storageLocation?: string;
  isReturnable?: boolean;
  returnableUnitName?: string;
  depositPerReturnable?: number;
  isActive: boolean;
  allowedStaffUids: string[];
  updatedAt?: Timestamp;
}

export interface StaffSaleLine {
  productId: string;
  productName: string;
  quantity: number;
  unitName?: string;
  unitQuantity?: number;
  conversionFactor?: number;
  baseQuantity?: number;
  salePricePerUnit: number;
  lineTotal: number;
}

export interface StaffSale {
  id: string;
  ownerUid: string;
  shopId: string;
  saleNumber: string;
  saleDate: string; // YYYY-MM-DD
  saleDateTime: string; // DD-MM-YYYY HH:mm
  paymentMethod: PaymentMethod;
  totalAmount: number;
  totalQuantity: number;
  itemCount: number;
  items: StaffSaleLine[];
  staffId: string;
  staffAuthUid: string;
  staffName: string;
  staffUsername: string;
  customerWhatsapp?: string;
  notes: string;
  status: TransactionStatus;
  syncedToLedger: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface StorefrontMeta {
  id: string;
  ownerUid: string;
  shopName: string;
  phone: string;
  address: string;
  currency: 'PKR';
  updatedAt?: Timestamp;
}

export interface StorefrontCatalogItem {
  id: string;
  ownerUid: string;
  productId: string;
  name: string;
  category: string;
  brand: string;
  salePrice: number;
  currentStock: number;
  unit: string;
  baseUnit: string;
  packagingUnits: StorefrontPackagingOption[];
  image: string;
  isActive: boolean;
  updatedAt?: Timestamp;
}

export type WebsiteOrderStatus =
  | 'Pending Confirmation'
  | 'Confirmed'
  | 'Out for Delivery'
  | 'Delivered'
  | 'Cancelled/Rejected';

export interface WebsiteOrderItem {
  productId: string;
  productName: string;
  unitName: string;
  conversionFactor: number;
  quantity: number;
  baseQuantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface WebsiteOrder {
  id: string;
  ownerUid: string;
  shopId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  customerNotes: string;
  paymentMethod: 'Cash on Delivery';
  status: WebsiteOrderStatus;
  items: WebsiteOrderItem[];
  itemCount: number;
  totalQuantity: number;
  subtotal: number;
  deliveryFee: number;
  totalAmount: number;
  linkedSaleId?: string;
  linkedSaleNumber?: string;
  rejectionReason?: string;
  confirmedBy?: string;
  confirmedByName?: string;
  confirmedAt?: Timestamp;
  outForDeliveryAt?: Timestamp;
  deliveredAt?: Timestamp;
  cancelledAt?: Timestamp;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type NavSection =
  | 'dashboard'
  | 'sales'
  | 'website_orders'
  | 'staff'
  | 'products'
  | 'inventory'
  | 'purchases'
  | 'expenses'
  | 'adjustments'
  | 'analytics'
  | 'reports'
  | 'activity'
  | 'settings';

export type StaffPortalSection =
  | 'dashboard'
  | 'new_sale'
  | 'my_sales'
  | 'stock'
  | 'website_orders';

export interface GoogleSheetsIntegration {
  id: string;
  ownerUid: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
  autoSyncEnabled: boolean;
  connectionState: 'connected' | 'disconnected' | 'error';
  lastSyncAt: string;
  lastSyncStatus: 'idle' | 'syncing' | 'synced' | 'error';
  lastError: string;
  syncedRecordCount: number;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface SheetsSyncJob {
  id: string;
  ownerUid: string;
  jobType: 'incremental' | 'full';
  targetSheets: string[];
  recordCount: number;
  status: 'pending' | 'failed';
  retryCount: number;
  lastError: string;
  summary: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

