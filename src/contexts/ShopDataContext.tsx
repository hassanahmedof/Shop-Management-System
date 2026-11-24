import { collection, doc, onSnapshot, query, type Timestamp, where } from 'firebase/firestore';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  isNetworkOrOfflineError,
  loadCachedOwnerCatalog,
  loadCachedStaffCatalog,
  loadCachedStaffSales,
  saveCachedOwnerCatalog,
  saveCachedStaffCatalog,
  saveCachedStaffSales,
} from '../services/offlineSyncService';
import {
  ensureDefaultBrands,
  ensureDefaultCategories,
  ensureDefaultProductTemplates,
  recordBackupSnapshot,
} from '../services/shopService';
import {
  ensureUsernameStaffLookupIndexes,
  getCatalogAllowedUids,
  reconcileStaffSaleToOwnerLedger,
  syncStaffCatalogDocuments,
} from '../services/staffService';
import { scheduleCatalogIntelligenceBuild } from '../services/catalogIntelligenceService';
import {
  mapProductsToSearchable,
  mapStaffCatalogToSearchable,
} from '../services/productSearchService';
import {
  type CooccurrenceSaleInput,
  syncCooccurrenceWithBackend,
} from '../services/upsellCooccurrenceService';
import { syncFeedbackWithBackend } from '../services/upsellFeedbackService';
import type {
  AdminMember,
  AuditLog,
  BackupRecord,
  Brand,
  Category,
  Expense,
  ExpenseCategory,
  InventoryBatch,
  Product,
  ProductTemplate,
  Purchase,
  PurchaseItem,
  Sale,
  SaleItem,
  ShopSettings,
  StaffCatalogItem,
  StaffMember,
  StaffSale,
  StockAdjustment,
  StockMovement,
  Supplier,
} from '../types/shop';
import { getKarachiDateIso } from '../utils/formatters';
import { sortCategoriesForDisplay } from '../utils/packaging';
import { useAuth } from './AuthContext';

interface ShopDataContextValue {
  settings: ShopSettings | null;
  categories: Category[];
  brands: Brand[];
  suppliers: Supplier[];
  products: Product[];
  productTemplates: ProductTemplate[];
  sales: Sale[];
  saleItems: SaleItem[];
  purchases: Purchase[];
  purchaseItems: PurchaseItem[];
  expenseCategories: ExpenseCategory[];
  expenses: Expense[];
  stockMovements: StockMovement[];
  stockAdjustments: StockAdjustment[];
  inventoryBatches: InventoryBatch[];
  auditLogs: AuditLog[];
  backups: BackupRecord[];
  staffMembers: StaffMember[];
  adminMembers: AdminMember[];
  staffCatalog: StaffCatalogItem[];
  staffSales: StaffSale[];
  loading: boolean;
}

const ShopDataContext = createContext<ShopDataContextValue | null>(null);

function timestampToMillis(ts?: Timestamp): number {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return 0;
}

export function ShopDataProvider({ children }: { children: ReactNode }) {
  const { user, sessionRole, shopId, staffProfile, initializingShop, shopReady } = useAuth();
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productTemplates, setProductTemplates] = useState<ProductTemplate[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchaseItems, setPurchaseItems] = useState<PurchaseItem[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ExpenseCategory[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [stockAdjustments, setStockAdjustments] = useState<StockAdjustment[]>([]);
  const [inventoryBatches, setInventoryBatches] = useState<InventoryBatch[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([]);
  const [adminMembers, setAdminMembers] = useState<AdminMember[]>([]);
  const [staffCatalog, setStaffCatalog] = useState<StaffCatalogItem[]>([]);
  const [staffSales, setStaffSales] = useState<StaffSale[]>([]);
  const [loading, setLoading] = useState(true);
  const [liveListenersSettled, setLiveListenersSettled] = useState(false);

  const autoBackupAttemptedRef = useRef<string>('');
  const defaultCatsCheckedRef = useRef<string>('');
  const catalogSyncSigRef = useRef<string>('');
  const lookupBackfillSigRef = useRef<string>('');
  const reconcilingIdsRef = useRef<Set<string>>(new Set());
  const cooccurrenceBackfillSigRef = useRef<string>('');
  const prevCompletedSaleMapRef = useRef<{ shopId: string; map: Map<string, string> }>({
    shopId: '',
    map: new Map(),
  });
  const ownerCacheSaveTimerRef = useRef<number | null>(null);
  const cachedOwnerCatalogRef = useRef<{
    shopId: string;
    hasCategories: boolean;
    hasBrands: boolean;
    hasProducts: boolean;
    hasTemplates: boolean;
  } | null>(null);

  useEffect(() => {
    if (!user || !shopId || !sessionRole || initializingShop || !shopReady) {
      setLoading(true);
      setLiveListenersSettled(false);
      return;
    }

    // Strict RBAC Data Isolation: Sales Staff NEVER subscribe to business financial/product/supplier collections
    if (sessionRole === 'sales_staff') {
      setSettings(null);
      setCategories([]);
      setBrands([]);
      setSuppliers([]);
      setProducts([]);
      setProductTemplates([]);
      setSales([]);
      setSaleItems([]);
      setPurchases([]);
      setPurchaseItems([]);
      setExpenseCategories([]);
      setExpenses([]);
      setStockMovements([]);
      setStockAdjustments([]);
      setInventoryBatches([]);
      setAuditLogs([]);
      setBackups([]);
      setStaffMembers([]);
      setAdminMembers([]);

      const canReadCatalog =
        Boolean(staffProfile?.isActive) &&
        Boolean(staffProfile?.permissions?.canViewStock || staffProfile?.permissions?.canAddSales);
      const canReadOwnSales =
        Boolean(staffProfile?.isActive) &&
        Boolean(staffProfile?.permissions?.canViewOwnSales || staffProfile?.permissions?.canAddSales);

      const cachedCatalog = canReadCatalog ? loadCachedStaffCatalog(shopId, user.uid) : [];
      const cachedSales = canReadOwnSales ? loadCachedStaffSales(shopId, user.uid) : [];

      if (canReadCatalog && cachedCatalog.length > 0) {
        setStaffCatalog(cachedCatalog);
      } else if (!canReadCatalog) {
        setStaffCatalog([]);
      }

      if (canReadOwnSales && cachedSales.length > 0) {
        setStaffSales(cachedSales);
      } else if (!canReadOwnSales) {
        setStaffSales([]);
      }

      const expected = (canReadCatalog ? 1 : 0) + (canReadOwnSales ? 1 : 0);
      if (
        expected === 0 ||
        (typeof navigator !== 'undefined' && !navigator.onLine) ||
        cachedCatalog.length > 0 ||
        cachedSales.length > 0
      ) {
        setLoading(false);
        if (expected === 0) {
          setLiveListenersSettled(true);
          return;
        }
      }

      let settled = 0;
      const markStaffSettled = () => {
        settled += 1;
        if (settled >= expected) {
          setLoading(false);
          setLiveListenersSettled(true);
        }
      };

      const unsubs: Array<() => void> = [];

      if (canReadCatalog) {
        const catPath = `shops/${shopId}/staffCatalog`;
        const catQ = query(
          collection(db, 'shops', shopId, 'staffCatalog'),
          where('allowedStaffUids', 'array-contains', user.uid)
        );
        let first = true;
        unsubs.push(
          onSnapshot(
            catQ,
            (snap) => {
              const list = snap.docs.map((d) => ({
                ...(d.data() as Omit<StaffCatalogItem, 'id'>),
                id: d.id,
              }));
              const isEmptyOfflineCache =
                snap.empty &&
                snap.metadata.fromCache &&
                typeof navigator !== 'undefined' &&
                !navigator.onLine &&
                cachedCatalog.length > 0;
              if (!isEmptyOfflineCache) {
                setStaffCatalog(list);
                saveCachedStaffCatalog(shopId, user.uid, list);
              }
              if (first) {
                first = false;
                markStaffSettled();
              }
            },
            (error) => {
              if (isNetworkOrOfflineError(error)) {
                setLoading(false);
                return;
              }
              handleFirestoreError(error, OperationType.LIST, catPath);
            }
          )
        );
      }

      if (canReadOwnSales) {
        const salesPath = `shops/${shopId}/staffSales`;
        const salesQ = query(
          collection(db, 'shops', shopId, 'staffSales'),
          where('staffAuthUid', '==', user.uid)
        );
        let first = true;
        unsubs.push(
          onSnapshot(
            salesQ,
            (snap) => {
              const list = snap.docs.map((d) => ({
                ...(d.data() as Omit<StaffSale, 'id'>),
                id: d.id,
              }));
              const isEmptyOfflineCache =
                snap.empty &&
                snap.metadata.fromCache &&
                typeof navigator !== 'undefined' &&
                !navigator.onLine &&
                cachedSales.length > 0;
              if (!isEmptyOfflineCache) {
                setStaffSales(list);
                saveCachedStaffSales(shopId, user.uid, list);
              }
              if (first) {
                first = false;
                markStaffSettled();
              }
            },
            (error) => {
              if (isNetworkOrOfflineError(error)) {
                setLoading(false);
                return;
              }
              handleFirestoreError(error, OperationType.LIST, salesPath);
            }
          )
        );
      }

      return () => {
        unsubs.forEach((u) => u());
      };
    }

    if (sessionRole !== 'owner') {
      setLoading(false);
      setLiveListenersSettled(true);
      return;
    }

    // Owner Workspace Subscriptions + Offline-First Permanent Catalog Warm-Start
    const uid = shopId;
    setLiveListenersSettled(false);

    const cachedCatalog = loadCachedOwnerCatalog(uid);
    cachedOwnerCatalogRef.current = cachedCatalog
      ? {
          shopId: uid,
          hasCategories: cachedCatalog.categories.length > 0,
          hasBrands: cachedCatalog.brands.length > 0,
          hasProducts: cachedCatalog.products.length > 0,
          hasTemplates: cachedCatalog.productTemplates.length > 0,
        }
      : null;

    if (cachedCatalog) {
      if (cachedCatalog.categories.length > 0) {
        setCategories(sortCategoriesForDisplay(cachedCatalog.categories));
      }
      if (cachedCatalog.brands.length > 0) {
        setBrands(cachedCatalog.brands);
      }
      if (cachedCatalog.products.length > 0) {
        setProducts(cachedCatalog.products);
      }
      if (cachedCatalog.productTemplates.length > 0) {
        setProductTemplates(cachedCatalog.productTemplates);
      }
      // Instant UI readiness when permanent catalog cache exists (live listeners keep syncing)
      if (
        cachedCatalog.categories.length > 0 ||
        cachedCatalog.brands.length > 0 ||
        cachedCatalog.products.length > 0
      ) {
        setLoading(false);
      }
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setLoading(false);
    }

    let settledCount = 0;
    const totalListeners = 20;
    const markSettled = () => {
      settledCount += 1;
      if (settledCount >= totalListeners) {
        setLoading(false);
        setLiveListenersSettled(true);
      }
    };

    const listenList = <T extends { id: string }>(
      colName: string,
      setter: (items: T[]) => void,
      options?: { protectEmptyOfflineCache?: boolean }
    ) => {
      const path = `shops/${uid}/${colName}`;
      const q = query(collection(db, 'shops', uid, colName), where('ownerUid', '==', uid));
      let first = true;
      return onSnapshot(
        q,
        (snap) => {
          const isEmptyOfflineCache =
            options?.protectEmptyOfflineCache &&
            snap.empty &&
            snap.metadata.fromCache &&
            typeof navigator !== 'undefined' &&
            !navigator.onLine;
          if (!isEmptyOfflineCache) {
            setter(
              snap.docs.map((d) => ({ ...(d.data() as Omit<T, 'id'>), id: d.id }) as T)
            );
          }
          if (first) {
            first = false;
            markSettled();
          }
        },
        (error) => {
          if (isNetworkOrOfflineError(error)) {
            setLoading(false);
            return;
          }
          handleFirestoreError(error, OperationType.LIST, path);
        }
      );
    };

    const settingsPath = `shops/${uid}/settings/general`;
    let firstSettings = true;
    const unsubSettings = onSnapshot(
      doc(db, 'shops', uid, 'settings', 'general'),
      (snap) => {
        if (snap.exists()) {
          setSettings({ id: snap.id, ...(snap.data() as Omit<ShopSettings, 'id'>) });
        }
        if (firstSettings) {
          firstSettings = false;
          markSettled();
        }
      },
      (error) => {
        if (isNetworkOrOfflineError(error)) {
          setLoading(false);
          return;
        }
        handleFirestoreError(error, OperationType.GET, settingsPath);
      }
    );

    const unsubs = [
      unsubSettings,
      listenList<Category>(
        'categories',
        (cats) => setCategories(sortCategoriesForDisplay(cats)),
        { protectEmptyOfflineCache: Boolean(cachedOwnerCatalogRef.current?.hasCategories) }
      ),
      listenList<Brand>('brands', setBrands, {
        protectEmptyOfflineCache: Boolean(cachedOwnerCatalogRef.current?.hasBrands),
      }),
      listenList<Supplier>('suppliers', setSuppliers),
      listenList<Product>('products', setProducts, {
        protectEmptyOfflineCache: Boolean(cachedOwnerCatalogRef.current?.hasProducts),
      }),
      listenList<ProductTemplate>('productTemplates', setProductTemplates, {
        protectEmptyOfflineCache: Boolean(cachedOwnerCatalogRef.current?.hasTemplates),
      }),
      listenList<Sale>('sales', setSales),
      listenList<SaleItem>('saleItems', setSaleItems),
      listenList<Purchase>('purchases', setPurchases),
      listenList<PurchaseItem>('purchaseItems', setPurchaseItems),
      listenList<ExpenseCategory>('expenseCategories', setExpenseCategories),
      listenList<Expense>('expenses', setExpenses),
      listenList<StockMovement>('stockMovements', setStockMovements),
      listenList<StockAdjustment>('stockAdjustments', setStockAdjustments),
      listenList<InventoryBatch>('inventoryBatches', setInventoryBatches),
      listenList<AuditLog>('auditLogs', setAuditLogs),
      listenList<BackupRecord>('backups', setBackups),
      listenList<StaffMember>('staff', setStaffMembers),
      listenList<AdminMember>('adminMembers', setAdminMembers),
      listenList<StaffCatalogItem>('staffCatalog', setStaffCatalog),
      listenList<StaffSale>('staffSales', setStaffSales),
    ];

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [
    user,
    sessionRole,
    shopId,
    initializingShop,
    shopReady,
    staffProfile?.isActive,
    staffProfile?.permissions?.canViewStock,
    staffProfile?.permissions?.canAddSales,
    staffProfile?.permissions?.canViewOwnSales,
  ]);

  // Persist permanent Owner catalog locally whenever categories, brands, products, or templates update
  useEffect(() => {
    if (sessionRole !== 'owner' || !shopId || !liveListenersSettled) return;
    if (ownerCacheSaveTimerRef.current !== null) {
      window.clearTimeout(ownerCacheSaveTimerRef.current);
    }
    ownerCacheSaveTimerRef.current = window.setTimeout(() => {
      ownerCacheSaveTimerRef.current = null;
      saveCachedOwnerCatalog(shopId, {
        categories,
        brands,
        products,
        productTemplates,
      });
    }, 350);
    return () => {
      if (ownerCacheSaveTimerRef.current !== null) {
        window.clearTimeout(ownerCacheSaveTimerRef.current);
        ownerCacheSaveTimerRef.current = null;
      }
    };
  }, [sessionRole, shopId, liveListenersSettled, categories, brands, products, productTemplates]);

  // Owner: consolidate legacy/overlapping categories, backfill preloaded brand library & product templates
  useEffect(() => {
    if (sessionRole !== 'owner' || !shopId || !liveListenersSettled) return;
    if (defaultCatsCheckedRef.current === shopId) return;
    defaultCatsCheckedRef.current = shopId;
    void ensureDefaultCategories(shopId, categories, products)
      .then(() => ensureDefaultBrands(shopId, brands, categories))
      .then(() => ensureDefaultProductTemplates(shopId, productTemplates, categories, brands))
      .catch((err) => {
        console.warn('Category/brand/template backfill skipped:', err);
      });
  }, [sessionRole, shopId, liveListenersSettled, categories, brands, products, productTemplates]);

  // Owner: keep sanitized staffCatalog synchronized with owner products & active staff permissions
  useEffect(() => {
    if (sessionRole !== 'owner' || !shopId || !liveListenersSettled) return;
    if (staffMembers.length === 0 && staffCatalog.length === 0) return;

    const allowedUidsKey = getCatalogAllowedUids(staffMembers).sort().join(',');
    const prodSig = products
      .map(
        (p) =>
          `${p.id}:${p.name}:${p.categoryName}:${p.brandName}:${p.salePrice}:${p.wholesalePrice}:${p.currentStock}:${p.baseUnit || p.unit}:${JSON.stringify(p.packagingUnits || [])}:${p.originType || ''}:${p.bottleSize || ''}:${p.storageLocation || ''}:${Boolean(p.isReturnable)}:${p.returnableUnitName || ''}:${p.depositPerReturnable ?? 0}:${p.isActive}`
      )
      .join('|');
    const catSig = staffCatalog
      .map(
        (c) =>
          `${c.productId}:${c.name}:${c.categoryName}:${c.brandName}:${c.salePrice}:${c.wholesalePrice ?? 0}:${c.currentStock}:${c.baseUnit || c.unit}:${JSON.stringify(c.packagingUnits || [])}:${c.originType || ''}:${c.bottleSize || ''}:${c.storageLocation || ''}:${Boolean(c.isReturnable)}:${c.returnableUnitName || ''}:${c.depositPerReturnable ?? 0}:${c.isActive}:${(c.allowedStaffUids || []).slice().sort().join(',')}`
      )
      .join('|');
    const combinedSig = `${allowedUidsKey}::${prodSig}::${catSig}`;

    if (catalogSyncSigRef.current === combinedSig) return;
    catalogSyncSigRef.current = combinedSig;

    void syncStaffCatalogDocuments(shopId, products, staffMembers, staffCatalog).catch((err) => {
      console.error('Staff catalog sync error:', err);
    });
  }, [sessionRole, shopId, liveListenersSettled, products, staffMembers, staffCatalog]);

  // Owner: backfill username-only staffLookup documents (u_<username>) for any pre-existing staff
  useEffect(() => {
    if (sessionRole !== 'owner' || !shopId || !liveListenersSettled || staffMembers.length === 0) return;
    const sig = staffMembers
      .map((s) => `${s.id}:${s.usernameLower}:${s.loginVersion}:${s.isActive}`)
      .join('|');
    if (lookupBackfillSigRef.current === sig) return;
    lookupBackfillSigRef.current = sig;

    void ensureUsernameStaffLookupIndexes(shopId, staffMembers).catch((err) => {
      console.error('Staff username index sync error:', err);
    });
  }, [sessionRole, shopId, liveListenersSettled, staffMembers]);

  // Owner: automatically reconcile any new staffSales into the full P&L ledger and product stock
  useEffect(() => {
    if (sessionRole !== 'owner' || !shopId || !liveListenersSettled) return;
    const pending = staffSales.filter((s) => !s.syncedToLedger && !reconcilingIdsRef.current.has(s.id));
    if (pending.length === 0) return;

    for (const ss of pending) {
      reconcilingIdsRef.current.add(ss.id);
      void reconcileStaffSaleToOwnerLedger(shopId, ss)
        .catch((err) => {
          console.error('Staff sale reconciliation failed:', err);
        })
        .finally(() => {
          reconcilingIdsRef.current.delete(ss.id);
        });
    }
  }, [sessionRole, shopId, liveListenersSettled, staffSales]);

  // Automatic daily backup snapshot metadata check (Owner only)
  useEffect(() => {
    if (sessionRole !== 'owner' || !shopId || !liveListenersSettled || !settings || !settings.autoBackupEnabled) return;
    const todayIso = getKarachiDateIso();
    if (settings.lastBackupAt === todayIso) return;
    if (autoBackupAttemptedRef.current === `${shopId}_${todayIso}`) return;

    autoBackupAttemptedRef.current = `${shopId}_${todayIso}`;
    const totalRecords =
      products.length +
      sales.length +
      purchases.length +
      expenses.length +
      stockAdjustments.length;

    void recordBackupSnapshot(
      shopId,
      'automatic',
      totalRecords,
      `Automatic daily snapshot (${todayIso})`
    ).catch((err) => {
      console.error('Automatic backup snapshot failed:', err);
    });
  }, [
    sessionRole,
    shopId,
    liveListenersSettled,
    settings,
    products.length,
    sales.length,
    purchases.length,
    expenses.length,
    stockAdjustments.length,
  ]);

  // Background precompute / catch-up shared backend co-occurrence cache from already-loaded completed sales (zero extra Firestore reads)
  useEffect(() => {
    if (!user || !shopId || !sessionRole || !liveListenersSettled) return;

    const completedSales: CooccurrenceSaleInput[] = [];
    let sig = '';
    let forceResetRebuild = false;

    if (sessionRole === 'owner') {
      const productIdsBySaleId = new Map<string, string[]>();
      for (const item of saleItems) {
        if (item.status === 'cancelled' || !item.saleId || !item.productId) continue;
        const arr = productIdsBySaleId.get(item.saleId);
        if (arr) {
          arr.push(item.productId);
        } else {
          productIdsBySaleId.set(item.saleId, [item.productId]);
        }
      }

      const nextCompletedMap = new Map<string, string>();
      let cancelledCount = 0;
      let rollingHash = 2166136261;

      for (const sale of sales) {
        if (!sale.id) continue;
        if (sale.status === 'cancelled') {
          cancelledCount += 1;
          continue;
        }
        const pids = productIdsBySaleId.get(sale.id);
        if (pids && pids.length > 0) {
          completedSales.push({
            saleId: sale.id,
            status: sale.status,
            productIds: pids,
          });
          const itemFingerprint = pids.slice().sort().join(',');
          nextCompletedMap.set(sale.id, itemFingerprint);
          const entryStr = `${sale.id}=${itemFingerprint}`;
          for (let i = 0; i < entryStr.length; i += 1) {
            rollingHash ^= entryStr.charCodeAt(i);
            rollingHash = Math.imul(rollingHash, 16777619);
          }
        }
      }

      for (const ss of staffSales) {
        if (ss.status === 'cancelled' || !ss.id || ss.syncedToLedger) continue;
        const staffPids = (ss.items || []).map((i) => i.productId).filter(Boolean);
        completedSales.push({
          saleId: ss.id,
          status: ss.status,
          productIds: staffPids,
        });
      }

      if (prevCompletedSaleMapRef.current.shopId === shopId) {
        for (const [prevSaleId, prevFingerprint] of prevCompletedSaleMapRef.current.map.entries()) {
          const nextFingerprint = nextCompletedMap.get(prevSaleId);
          if (nextFingerprint !== prevFingerprint) {
            forceResetRebuild = true;
            break;
          }
        }
      }
      prevCompletedSaleMapRef.current = { shopId, map: nextCompletedMap };

      sig = `owner:${shopId}:${completedSales.length}:${cancelledCount}:${rollingHash >>> 0}:${staffSales.length}`;
    } else {
      sig = `staff:${shopId}:${staffSales.length}`;
    }

    if (cooccurrenceBackfillSigRef.current === sig && !forceResetRebuild) return;
    cooccurrenceBackfillSigRef.current = sig;

    const timer = window.setTimeout(() => {
      void syncCooccurrenceWithBackend({
        shopId,
        isOwner: sessionRole === 'owner',
        getIdToken: () => user.getIdToken(),
        completedSales,
        forceResetRebuild,
      });
      void syncFeedbackWithBackend({
        shopId,
        getIdToken: () => user.getIdToken(),
      });
    }, 80);

    return () => {
      window.clearTimeout(timer);
    };
  }, [user, sessionRole, shopId, liveListenersSettled, sales, saleItems, staffSales]);

  // Background incremental semantic & cross-category index builder (non-blocking, zero Firestore reads)
  useEffect(() => {
    if (!shopId || !sessionRole || !liveListenersSettled) return;
    if (sessionRole === 'owner') {
      if (products.length === 0) return;
      scheduleCatalogIntelligenceBuild(
        shopId,
        mapProductsToSearchable(products, { categories, productTemplates })
      );
      return;
    }
    if (staffCatalog.length === 0) return;
    scheduleCatalogIntelligenceBuild(
      shopId,
      mapStaffCatalogToSearchable(staffCatalog.filter((c) => c.isActive))
    );
  }, [shopId, sessionRole, liveListenersSettled, products, categories, productTemplates, staffCatalog]);

  // Independent per-collection memoization preserves referential identity across pages
  // (e.g. recording a sale updates `sales`/`products` without re-sorting categories/brands/templates)
  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.name.localeCompare(b.name)),
    [categories]
  );
  const sortedBrands = useMemo(
    () => [...brands].sort((a, b) => a.name.localeCompare(b.name)),
    [brands]
  );
  const sortedSuppliers = useMemo(
    () => [...suppliers].sort((a, b) => a.name.localeCompare(b.name)),
    [suppliers]
  );
  const sortedProducts = useMemo(
    () => [...products].sort((a, b) => a.name.localeCompare(b.name)),
    [products]
  );
  const sortedProductTemplates = useMemo(
    () => [...productTemplates].sort((a, b) => a.name.localeCompare(b.name)),
    [productTemplates]
  );
  const sortedSales = useMemo(
    () =>
      [...sales].sort((a, b) => {
        const dateCmp = b.saleDate.localeCompare(a.saleDate);
        if (dateCmp !== 0) return dateCmp;
        return (b.saleDateTime || '').localeCompare(a.saleDateTime || '');
      }),
    [sales]
  );
  const sortedPurchases = useMemo(
    () => [...purchases].sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate)),
    [purchases]
  );
  const sortedExpenseCategories = useMemo(
    () => [...expenseCategories].sort((a, b) => a.name.localeCompare(b.name)),
    [expenseCategories]
  );
  const sortedExpenses = useMemo(
    () => [...expenses].sort((a, b) => b.expenseDate.localeCompare(a.expenseDate)),
    [expenses]
  );
  const sortedStockMovements = useMemo(
    () => [...stockMovements].sort((a, b) => b.movementDate.localeCompare(a.movementDate)),
    [stockMovements]
  );
  const sortedStockAdjustments = useMemo(
    () => [...stockAdjustments].sort((a, b) => b.adjustmentDate.localeCompare(a.adjustmentDate)),
    [stockAdjustments]
  );
  const sortedInventoryBatches = useMemo(
    () => [...inventoryBatches].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate)),
    [inventoryBatches]
  );
  const sortedAuditLogs = useMemo(
    () => [...auditLogs].sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt)),
    [auditLogs]
  );
  const sortedBackups = useMemo(
    () => [...backups].sort((a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt)),
    [backups]
  );
  const sortedStaffMembers = useMemo(
    () => [...staffMembers].sort((a, b) => a.name.localeCompare(b.name)),
    [staffMembers]
  );
  const sortedAdminMembers = useMemo(
    () => [...adminMembers].sort((a, b) => a.name.localeCompare(b.name)),
    [adminMembers]
  );
  const sortedStaffCatalog = useMemo(
    () => [...staffCatalog].sort((a, b) => a.name.localeCompare(b.name)),
    [staffCatalog]
  );
  const sortedStaffSales = useMemo(
    () =>
      [...staffSales].sort((a, b) => {
        const dateCmp = b.saleDate.localeCompare(a.saleDate);
        if (dateCmp !== 0) return dateCmp;
        return (b.saleDateTime || '').localeCompare(a.saleDateTime || '');
      }),
    [staffSales]
  );

  const value = useMemo<ShopDataContextValue>(
    () => ({
      settings,
      categories: sortedCategories,
      brands: sortedBrands,
      suppliers: sortedSuppliers,
      products: sortedProducts,
      productTemplates: sortedProductTemplates,
      sales: sortedSales,
      saleItems,
      purchases: sortedPurchases,
      purchaseItems,
      expenseCategories: sortedExpenseCategories,
      expenses: sortedExpenses,
      stockMovements: sortedStockMovements,
      stockAdjustments: sortedStockAdjustments,
      inventoryBatches: sortedInventoryBatches,
      auditLogs: sortedAuditLogs,
      backups: sortedBackups,
      staffMembers: sortedStaffMembers,
      adminMembers: sortedAdminMembers,
      staffCatalog: sortedStaffCatalog,
      staffSales: sortedStaffSales,
      loading,
    }),
    [
      settings,
      sortedCategories,
      sortedBrands,
      sortedSuppliers,
      sortedProducts,
      sortedProductTemplates,
      sortedSales,
      saleItems,
      sortedPurchases,
      purchaseItems,
      sortedExpenseCategories,
      sortedExpenses,
      sortedStockMovements,
      sortedStockAdjustments,
      sortedInventoryBatches,
      sortedAuditLogs,
      sortedBackups,
      sortedStaffMembers,
      sortedAdminMembers,
      sortedStaffCatalog,
      sortedStaffSales,
      loading,
    ]
  );

  return <ShopDataContext.Provider value={value}>{children}</ShopDataContext.Provider>;
}

export function useShopData() {
  const ctx = useContext(ShopDataContext);
  if (!ctx) throw new Error('useShopData must be used inside ShopDataProvider');
  return ctx;
}
