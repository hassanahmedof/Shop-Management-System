import type {
  Brand,
  Category,
  PaymentMethod,
  Product,
  ProductTemplate,
  StaffCatalogItem,
  StaffMember,
  StaffSale,
  StaffSaleLine,
} from '../types/shop';
import { formatDateTimeKarachi, normalizeCustomerWhatsapp, roundMoney } from '../utils/formatters';
import { getAllowedSaleUnits, getEffectiveBaseUnit, roundStockQty } from '../utils/packaging';
import { createStaffSale, toDeterministicStaffSaleId } from './staffService';

const SESSION_CACHE_PREFIX = 'cm_offline_staff_session_';
const CATALOG_CACHE_PREFIX = 'cm_offline_staff_catalog_';
const OWNER_CATALOG_CACHE_PREFIX = 'cm_owner_catalog_v1_';
const SALES_CACHE_PREFIX = 'cm_offline_staff_sales_';
const QUEUE_CACHE_PREFIX = 'cm_offline_sale_queue_';

export type OfflineSaleSyncStatus = 'pending' | 'syncing' | 'failed';

export interface CachedStaffSession {
  uid: string;
  shopId: string;
  staffProfile: StaffMember;
  cachedAtIso: string;
}

export interface OfflineQueuedSaleItem {
  productId: string;
  productName: string;
  unit: string;
  unitName: string;
  unitQuantity: number;
  conversionFactor: number;
  baseQuantity: number;
  quantity: number;
  salePricePerUnit: number;
  lineTotal: number;
}

export interface OfflineQueuedSale {
  localId: string;
  shopId: string;
  staffId: string;
  staffAuthUid: string;
  staffName: string;
  staffUsername: string;
  saleNumber: string;
  saleDate: string; // YYYY-MM-DD
  saleDateTime: string; // DD-MM-YYYY HH:mm
  paymentMethod: PaymentMethod;
  customerWhatsapp?: string;
  notes: string;
  items: OfflineQueuedSaleItem[];
  totalAmount: number;
  totalQuantity: number;
  itemCount: number;
  createdAtIso: string;
  syncStatus: OfflineSaleSyncStatus;
  lastError?: string;
  retryCount: number;
}

export interface DisplayStaffSale extends StaffSale {
  isOfflinePending?: boolean;
  offlineLocalId?: string;
  offlineSyncStatus?: OfflineSaleSyncStatus;
  offlineLastError?: string;
}

export interface SyncRunResult {
  syncedCount: number;
  failedCount: number;
  remainingCount: number;
  stoppedDueToOffline: boolean;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota or restricted browser context errors
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

export function isNetworkOrOfflineError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return true;
  }

  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code || '').toLowerCase()
      : '';
  if (
    code === 'unavailable' ||
    code === 'auth/network-request-failed' ||
    code === 'failed-precondition' ||
    code === 'deadline-exceeded'
  ) {
    return true;
  }

  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('network-request-failed') ||
    msg.includes('load failed') ||
    msg.includes('client is offline') ||
    msg.includes('offline') ||
    msg.includes('unavailable') ||
    msg.includes('could not reach cloud firestore backend') ||
    msg.includes('failed to get document from server') ||
    msg.includes('err_internet_disconnected') ||
    msg.includes('timeout')
  );
}

// ---------------------------------------------------------------------------
// Staff Session Cache (Offline Reload Resilience)
// ---------------------------------------------------------------------------
export function saveCachedStaffSession(
  uid: string,
  shopId: string,
  staffProfile: StaffMember
): void {
  if (!uid || !shopId || !staffProfile?.isActive) return;
  const payload: CachedStaffSession = {
    uid,
    shopId,
    staffProfile,
    cachedAtIso: new Date().toISOString(),
  };
  writeJson(`${SESSION_CACHE_PREFIX}${uid}`, payload);
}

export function loadCachedStaffSession(uid: string): CachedStaffSession | null {
  if (!uid) return null;
  const cached = readJson<CachedStaffSession | null>(`${SESSION_CACHE_PREFIX}${uid}`, null);
  if (
    !cached ||
    cached.uid !== uid ||
    !cached.shopId ||
    !cached.staffProfile ||
    !cached.staffProfile.isActive ||
    cached.staffProfile.authUid !== uid
  ) {
    return null;
  }
  return cached;
}

export function clearCachedStaffSession(uid?: string): void {
  try {
    if (uid) {
      removeKey(`${SESSION_CACHE_PREFIX}${uid}`);
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (
          (key.startsWith(CATALOG_CACHE_PREFIX) || key.startsWith(SALES_CACHE_PREFIX)) &&
          key.endsWith(`_${uid}`)
        ) {
          localStorage.removeItem(key);
        }
      }
      return;
    }

    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (
        key.startsWith(SESSION_CACHE_PREFIX) ||
        key.startsWith(CATALOG_CACHE_PREFIX) ||
        key.startsWith(SALES_CACHE_PREFIX)
      ) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Sanitized Staff Catalog & Own Sales Cache
// ---------------------------------------------------------------------------
function catalogCacheKey(shopId: string, staffAuthUid: string): string {
  return `${CATALOG_CACHE_PREFIX}${shopId}_${staffAuthUid}`;
}

function salesCacheKey(shopId: string, staffAuthUid: string): string {
  return `${SALES_CACHE_PREFIX}${shopId}_${staffAuthUid}`;
}

function queueCacheKey(shopId: string, staffAuthUid: string): string {
  return `${QUEUE_CACHE_PREFIX}${shopId}_${staffAuthUid}`;
}

export function saveCachedStaffCatalog(
  shopId: string,
  staffAuthUid: string,
  items: StaffCatalogItem[]
): void {
  if (!shopId || !staffAuthUid) return;
  const sanitized: StaffCatalogItem[] = items.map((item) => ({
    id: item.id,
    ownerUid: item.ownerUid,
    productId: item.productId,
    name: item.name,
    categoryName: item.categoryName,
    brandName: item.brandName,
    salePrice: item.salePrice,
    wholesalePrice: item.wholesalePrice ?? 0,
    currentStock: item.currentStock,
    unit: item.unit,
    baseUnit: item.baseUnit || item.unit,
    packagingUnits: Array.isArray(item.packagingUnits) ? item.packagingUnits : [],
    originType: item.originType || '',
    bottleSize: item.bottleSize || '',
    storageLocation: item.storageLocation || '',
    isReturnable: Boolean(item.isReturnable),
    returnableUnitName: item.returnableUnitName || '',
    depositPerReturnable: item.depositPerReturnable ?? 0,
    isActive: item.isActive,
    allowedStaffUids: Array.isArray(item.allowedStaffUids) ? item.allowedStaffUids : [],
  }));
  writeJson(catalogCacheKey(shopId, staffAuthUid), sanitized);
}

export function loadCachedStaffCatalog(
  shopId: string,
  staffAuthUid: string
): StaffCatalogItem[] {
  if (!shopId || !staffAuthUid) return [];
  const data = readJson<StaffCatalogItem[]>(catalogCacheKey(shopId, staffAuthUid), []);
  return Array.isArray(data) ? data : [];
}

export function saveCachedStaffSales(
  shopId: string,
  staffAuthUid: string,
  sales: StaffSale[]
): void {
  if (!shopId || !staffAuthUid) return;
  const trimmed = sales.slice(0, 500).map((s) => ({
    id: s.id,
    ownerUid: s.ownerUid,
    shopId: s.shopId,
    saleNumber: s.saleNumber,
    saleDate: s.saleDate,
    saleDateTime: s.saleDateTime,
    paymentMethod: s.paymentMethod,
    totalAmount: s.totalAmount,
    totalQuantity: s.totalQuantity,
    itemCount: s.itemCount,
    items: Array.isArray(s.items) ? s.items : [],
    staffId: s.staffId,
    staffAuthUid: s.staffAuthUid,
    staffName: s.staffName,
    staffUsername: s.staffUsername,
    ...(s.customerWhatsapp ? { customerWhatsapp: s.customerWhatsapp } : {}),
    notes: s.notes,
    status: s.status,
    syncedToLedger: Boolean(s.syncedToLedger),
  }));
  writeJson(salesCacheKey(shopId, staffAuthUid), trimmed);
}

export function loadCachedStaffSales(shopId: string, staffAuthUid: string): StaffSale[] {
  if (!shopId || !staffAuthUid) return [];
  const data = readJson<StaffSale[]>(salesCacheKey(shopId, staffAuthUid), []);
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------------
// Owner Permanent Catalog Cache (Offline-First Instant Startup & Search)
// ---------------------------------------------------------------------------
export interface CachedOwnerCatalogSnapshot {
  shopId: string;
  cachedAtIso: string;
  categories: Category[];
  brands: Brand[];
  products: Product[];
  productTemplates: ProductTemplate[];
}

function ownerCatalogCacheKey(shopId: string): string {
  return `${OWNER_CATALOG_CACHE_PREFIX}${shopId}`;
}

export function saveCachedOwnerCatalog(
  shopId: string,
  snapshot: {
    categories: Category[];
    brands: Brand[];
    products: Product[];
    productTemplates: ProductTemplate[];
  }
): void {
  if (!shopId) return;
  const payload: CachedOwnerCatalogSnapshot = {
    shopId,
    cachedAtIso: new Date().toISOString(),
    categories: snapshot.categories.map((c) => ({
      id: c.id,
      ownerUid: c.ownerUid,
      name: c.name,
      description: c.description || '',
    })),
    brands: snapshot.brands.map((b) => ({
      id: b.id,
      ownerUid: b.ownerUid,
      name: b.name,
      categoryIds: Array.isArray(b.categoryIds) ? b.categoryIds : [],
      isActive: b.isActive !== false,
    })),
    products: snapshot.products.map((p) => ({
      id: p.id,
      ownerUid: p.ownerUid,
      name: p.name,
      categoryId: p.categoryId,
      categoryName: p.categoryName,
      brandId: p.brandId,
      brandName: p.brandName,
      purchasePrice: p.purchasePrice,
      salePrice: p.salePrice,
      wholesalePrice: p.wholesalePrice ?? 0,
      currentStock: p.currentStock,
      minStockLevel: p.minStockLevel,
      maxStockLevel: p.maxStockLevel,
      unit: p.unit,
      baseUnit: p.baseUnit || p.unit,
      packagingUnits: Array.isArray(p.packagingUnits) ? p.packagingUnits : [],
      originType: p.originType || '',
      bottleSize: p.bottleSize || '',
      storageLocation: p.storageLocation || '',
      isReturnable: Boolean(p.isReturnable),
      returnableUnitName: p.returnableUnitName || '',
      depositPerReturnable: p.depositPerReturnable ?? 0,
      emptyContainersOnHand: p.emptyContainersOnHand ?? 0,
      supplierId: p.supplierId,
      supplierName: p.supplierName,
      expiryDate: p.expiryDate || '',
      profitMarginPct: p.profitMarginPct,
      isActive: p.isActive !== false,
    })),
    productTemplates: snapshot.productTemplates.map((t) => ({
      id: t.id,
      ownerUid: t.ownerUid,
      name: t.name,
      categoryId: t.categoryId,
      categoryName: t.categoryName,
      brandId: t.brandId,
      brandName: t.brandName,
      variant: t.variant || '',
      originType: t.originType || '',
      baseUnit: t.baseUnit,
      defaultPurchaseUnit: t.defaultPurchaseUnit,
      defaultSaleUnit: t.defaultSaleUnit,
      packagingUnits: Array.isArray(t.packagingUnits) ? t.packagingUnits : [],
      hasUnconfirmedPackaging: Boolean(t.hasUnconfirmedPackaging),
      suggestedPurchasePrice: t.suggestedPurchasePrice,
      suggestedSalePrice: t.suggestedSalePrice,
      suggestedWholesalePrice: t.suggestedWholesalePrice,
      priceSource: t.priceSource,
      priceUpdatedAt: t.priceUpdatedAt,
      trackExpiry: Boolean(t.trackExpiry),
      bottleSize: t.bottleSize,
      storageLocation: t.storageLocation,
      isReturnable: Boolean(t.isReturnable),
      returnableUnitName: t.returnableUnitName,
      searchKeywords: Array.isArray(t.searchKeywords) ? t.searchKeywords : [],
      isActive: t.isActive !== false,
      isCustom: Boolean(t.isCustom),
    })),
  };
  writeJson(ownerCatalogCacheKey(shopId), payload);
}

export function loadCachedOwnerCatalog(shopId: string): CachedOwnerCatalogSnapshot | null {
  if (!shopId) return null;
  const data = readJson<CachedOwnerCatalogSnapshot | null>(ownerCatalogCacheKey(shopId), null);
  if (!data || data.shopId !== shopId) return null;
  return {
    shopId: data.shopId,
    cachedAtIso: data.cachedAtIso || '',
    categories: Array.isArray(data.categories) ? data.categories : [],
    brands: Array.isArray(data.brands) ? data.brands : [],
    products: Array.isArray(data.products) ? data.products : [],
    productTemplates: Array.isArray(data.productTemplates) ? data.productTemplates : [],
  };
}

export function clearCachedOwnerCatalog(shopId: string): void {
  if (!shopId) return;
  removeKey(ownerCatalogCacheKey(shopId));
}

// ---------------------------------------------------------------------------
// Offline Pending Sales Queue
// ---------------------------------------------------------------------------
export function generateOfflineSaleNumber(): string {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');
  return `SL-${y}${m}${d}-${suffix}`;
}

export function getQueuedOfflineSales(
  shopId: string,
  staffAuthUid: string
): OfflineQueuedSale[] {
  if (!shopId || !staffAuthUid) return [];
  const list = readJson<OfflineQueuedSale[]>(queueCacheKey(shopId, staffAuthUid), []);
  if (!Array.isArray(list)) return [];
  return list.sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
}

function saveQueuedOfflineSales(
  shopId: string,
  staffAuthUid: string,
  queue: OfflineQueuedSale[]
): void {
  writeJson(queueCacheKey(shopId, staffAuthUid), queue);
}

export function createAndEnqueueOfflineSale(
  shopId: string,
  staff: StaffMember,
  effectiveCatalogMap: Map<string, StaffCatalogItem>,
  input: {
    saleDate: string;
    paymentMethod: PaymentMethod;
    customerWhatsapp?: string;
    notes: string;
    items: Array<{
      productId: string;
      quantity: number;
      unitName?: string;
      conversionFactor?: number;
    }>;
  }
): OfflineQueuedSale {
  if (!staff.isActive || !staff.permissions.canAddSales) {
    throw new Error('You do not have permission to record sales.');
  }
  if (!input.items.length) {
    throw new Error('Add at least one product to record a sale.');
  }

  const merged = new Map<
    string,
    { productId: string; unitName: string; conversionFactor: number; unitQuantity: number }
  >();
  for (const row of input.items) {
    if (!row.productId) {
      throw new Error('Select a product for every row.');
    }
    const qty = roundStockQty(Number(row.quantity) || 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error('Quantity must be greater than zero.');
    }
    const unitKey = (row.unitName || '').trim();
    const conv = roundStockQty(Number(row.conversionFactor) || 1) || 1;
    const key = `${row.productId}::${unitKey}`;
    const prev = merged.get(key);
    if (prev) {
      prev.unitQuantity = roundStockQty(prev.unitQuantity + qty);
    } else {
      merged.set(key, {
        productId: row.productId,
        unitName: unitKey,
        conversionFactor: conv,
        unitQuantity: qty,
      });
    }
  }

  const lines: OfflineQueuedSaleItem[] = [];
  const totalBaseByProduct = new Map<string, number>();
  let totalAmount = 0;
  let totalQuantity = 0;

  for (const row of merged.values()) {
    const prod = effectiveCatalogMap.get(row.productId);
    if (!prod || !prod.isActive) {
      throw new Error('Selected product is not available in the catalog.');
    }
    const allowedUnits = getAllowedSaleUnits(prod);
    const matchedUnit =
      (row.unitName
        ? allowedUnits.find((u) => u.unitName.toLowerCase() === row.unitName.toLowerCase())
        : undefined) || allowedUnits[0];
    if (!matchedUnit) {
      throw new Error(`Invalid unit selected for "${prod.name}".`);
    }

    const conv = roundStockQty(matchedUnit.conversionQty || row.conversionFactor || 1);
    const baseQty = roundStockQty(row.unitQuantity * conv);
    const cumulativeBase = roundStockQty((totalBaseByProduct.get(prod.productId) || 0) + baseQty);
    totalBaseByProduct.set(prod.productId, cumulativeBase);

    const baseUnit = getEffectiveBaseUnit(prod);
    if (cumulativeBase > prod.currentStock) {
      throw new Error(
        `Insufficient stock for "${prod.name}". Available: ${prod.currentStock} ${baseUnit}, Requested: ${cumulativeBase} ${baseUnit}.`
      );
    }

    const lineTotal = roundMoney(row.unitQuantity * matchedUnit.salePrice);
    totalAmount = roundMoney(totalAmount + lineTotal);
    totalQuantity = roundStockQty(totalQuantity + baseQty);

    lines.push({
      productId: prod.productId,
      productName: prod.name.trim().slice(0, 180),
      unit: matchedUnit.unitName,
      unitName: matchedUnit.unitName,
      unitQuantity: row.unitQuantity,
      conversionFactor: conv,
      baseQuantity: baseQty,
      quantity: row.unitQuantity,
      salePricePerUnit: matchedUnit.salePrice,
      lineTotal,
    });
  }

  const now = new Date();
  const cleanWhatsapp = normalizeCustomerWhatsapp(input.customerWhatsapp);
  const queued: OfflineQueuedSale = {
    localId: `off_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    shopId,
    staffId: staff.id,
    staffAuthUid: staff.authUid,
    staffName: staff.name.trim().slice(0, 120),
    staffUsername: staff.username.trim().slice(0, 40),
    saleNumber: generateOfflineSaleNumber(),
    saleDate: input.saleDate,
    saleDateTime: formatDateTimeKarachi(now),
    paymentMethod: input.paymentMethod,
    ...(cleanWhatsapp ? { customerWhatsapp: cleanWhatsapp } : {}),
    notes: (input.notes || '').trim().slice(0, 500),
    items: lines,
    totalAmount,
    totalQuantity,
    itemCount: lines.length,
    createdAtIso: now.toISOString(),
    syncStatus: 'pending',
    retryCount: 0,
  };

  const existing = getQueuedOfflineSales(shopId, staff.authUid);
  saveQueuedOfflineSales(shopId, staff.authUid, [...existing, queued]);
  return queued;
}

export function updateQueuedOfflineSale(
  shopId: string,
  staffAuthUid: string,
  localId: string,
  patch: Partial<OfflineQueuedSale>
): OfflineQueuedSale[] {
  const queue = getQueuedOfflineSales(shopId, staffAuthUid);
  const next = queue.map((q) => (q.localId === localId ? { ...q, ...patch } : q));
  saveQueuedOfflineSales(shopId, staffAuthUid, next);
  return next;
}

export function removeQueuedOfflineSale(
  shopId: string,
  staffAuthUid: string,
  localId: string
): OfflineQueuedSale[] {
  const queue = getQueuedOfflineSales(shopId, staffAuthUid);
  const next = queue.filter((q) => q.localId !== localId);
  saveQueuedOfflineSales(shopId, staffAuthUid, next);
  return next;
}

// ---------------------------------------------------------------------------
// Catalog & Sales Merging for Seamless Offline UX
// ---------------------------------------------------------------------------
export function applyPendingSalesToCatalog(
  catalog: StaffCatalogItem[],
  pendingSales: OfflineQueuedSale[]
): StaffCatalogItem[] {
  if (!pendingSales.length) return catalog;
  const reservedQty = new Map<string, number>();
  for (const sale of pendingSales) {
    for (const line of sale.items) {
      const baseQty = roundStockQty(
        line.baseQuantity ?? line.quantity * (line.conversionFactor || 1)
      );
      reservedQty.set(
        line.productId,
        roundStockQty((reservedQty.get(line.productId) || 0) + baseQty)
      );
    }
  }
  if (reservedQty.size === 0) return catalog;

  return catalog.map((item) => {
    const reserved = reservedQty.get(item.productId) || 0;
    if (!reserved) return item;
    return {
      ...item,
      currentStock: roundStockQty(Math.max(0, item.currentStock - reserved)),
    };
  });
}

export function mapQueuedSaleToStaffSale(queued: OfflineQueuedSale): DisplayStaffSale {
  const lines: StaffSaleLine[] = queued.items.map((i) => ({
    productId: i.productId,
    productName: i.productName,
    quantity: i.quantity,
    unitName: i.unitName || i.unit,
    unitQuantity: i.unitQuantity ?? i.quantity,
    conversionFactor: i.conversionFactor ?? 1,
    baseQuantity: i.baseQuantity ?? i.quantity,
    salePricePerUnit: i.salePricePerUnit,
    lineTotal: i.lineTotal,
  }));

  return {
    id: queued.localId,
    ownerUid: queued.shopId,
    shopId: queued.shopId,
    saleNumber: queued.saleNumber,
    saleDate: queued.saleDate,
    saleDateTime: queued.saleDateTime,
    paymentMethod: queued.paymentMethod,
    totalAmount: queued.totalAmount,
    totalQuantity: queued.totalQuantity,
    itemCount: queued.itemCount,
    items: lines,
    staffId: queued.staffId,
    staffAuthUid: queued.staffAuthUid,
    staffName: queued.staffName,
    staffUsername: queued.staffUsername,
    ...(queued.customerWhatsapp ? { customerWhatsapp: queued.customerWhatsapp } : {}),
    notes: queued.notes,
    status: 'completed',
    syncedToLedger: false,
    isOfflinePending: true,
    offlineLocalId: queued.localId,
    offlineSyncStatus: queued.syncStatus,
    offlineLastError: queued.lastError,
  };
}

// ---------------------------------------------------------------------------
// Sequential Mutex-Guarded Sync Runner
// ---------------------------------------------------------------------------
const activeSyncLocks = new Map<string, Promise<SyncRunResult>>();

export async function syncQueuedOfflineSales(
  shopId: string,
  staff: StaffMember,
  existingRemoteSales: StaffSale[],
  options?: {
    includeFailed?: boolean;
    onlyLocalId?: string;
    onQueueUpdated?: (nextQueue: OfflineQueuedSale[]) => void;
  }
): Promise<SyncRunResult> {
  const lockKey = `${shopId}_${staff.authUid}`;
  const inFlight = activeSyncLocks.get(lockKey);
  if (inFlight) {
    return inFlight;
  }

  const runPromise = (async (): Promise<SyncRunResult> => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const current = getQueuedOfflineSales(shopId, staff.authUid);
      return {
        syncedCount: 0,
        failedCount: current.filter((q) => q.syncStatus === 'failed').length,
        remainingCount: current.length,
        stoppedDueToOffline: true,
      };
    }

    const remoteSaleIds = new Set(existingRemoteSales.map((s) => s.id));
    let queue = getQueuedOfflineSales(shopId, staff.authUid);
    const targets = queue.filter((q) => {
      if (options?.onlyLocalId) return q.localId === options.onlyLocalId;
      if (options?.includeFailed) return true;
      return q.syncStatus !== 'failed';
    });

    let syncedCount = 0;
    let failedCount = 0;
    let stoppedDueToOffline = false;

    for (const item of targets) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        stoppedDueToOffline = true;
        break;
      }

      const deterministicId = toDeterministicStaffSaleId(item.localId);
      // Deduplication check: ONLY skip if this exact clientRequestId document already exists in Firestore
      if (deterministicId && remoteSaleIds.has(deterministicId)) {
        queue = removeQueuedOfflineSale(shopId, staff.authUid, item.localId);
        options?.onQueueUpdated?.(queue);
        syncedCount += 1;
        continue;
      }

      queue = updateQueuedOfflineSale(shopId, staff.authUid, item.localId, {
        syncStatus: 'syncing',
        lastError: undefined,
      });
      options?.onQueueUpdated?.(queue);

      try {
        const committedId = await createStaffSale(shopId, staff, {
          saleDate: item.saleDate,
          paymentMethod: item.paymentMethod,
          customerWhatsapp: item.customerWhatsapp,
          notes: item.notes,
          saleNumber: item.saleNumber,
          saleDateTime: item.saleDateTime,
          clientRequestId: item.localId,
          items: item.items.map((l) => ({
            productId: l.productId,
            quantity: l.unitQuantity ?? l.quantity,
            unitName: l.unitName || l.unit,
            conversionFactor: l.conversionFactor ?? 1,
          })),
        });

        remoteSaleIds.add(committedId);
        queue = removeQueuedOfflineSale(shopId, staff.authUid, item.localId);
        options?.onQueueUpdated?.(queue);
        syncedCount += 1;
      } catch (err) {
        if (isNetworkOrOfflineError(err)) {
          queue = updateQueuedOfflineSale(shopId, staff.authUid, item.localId, {
            syncStatus: 'pending',
            lastError: 'Waiting for internet connection to finish syncing.',
          });
          options?.onQueueUpdated?.(queue);
          stoppedDueToOffline = true;
          break;
        }

        const msg = err instanceof Error ? err.message : 'Failed to sync sale.';
        queue = updateQueuedOfflineSale(shopId, staff.authUid, item.localId, {
          syncStatus: 'failed',
          lastError: msg,
          retryCount: item.retryCount + 1,
        });
        options?.onQueueUpdated?.(queue);
        failedCount += 1;
      }
    }

    const finalQueue = getQueuedOfflineSales(shopId, staff.authUid);
    return {
      syncedCount,
      failedCount,
      remainingCount: finalQueue.length,
      stoppedDueToOffline,
    };
  })().finally(() => {
    activeSyncLocks.delete(lockKey);
  });

  activeSyncLocks.set(lockKey, runPromise);
  return runPromise;
}
