import { collection, doc, onSnapshot, query, type Timestamp, where } from 'firebase/firestore';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  isNetworkOrOfflineError,
  loadCachedStaffCatalog,
  loadCachedStaffSales,
  saveCachedStaffCatalog,
  saveCachedStaffSales,
} from '../services/offlineSyncService';
import { recordBackupSnapshot } from '../services/shopService';
import {
  ensureUsernameStaffLookupIndexes,
  getCatalogAllowedUids,
  reconcileStaffSaleToOwnerLedger,
  syncStaffCatalogDocuments,
} from '../services/staffService';
import type {
  AdminMember,
  AuditLog,
  BackupRecord,
  Brand,
  Category,
  Expense,
  ExpenseCategory,
  Product,
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
import { useAuth } from './AuthContext';

interface ShopDataContextValue {
  settings: ShopSettings | null;
  categories: Category[];
  brands: Brand[];
  suppliers: Supplier[];
  products: Product[];
  sales: Sale[];
  saleItems: SaleItem[];
  purchases: Purchase[];
  purchaseItems: PurchaseItem[];
  expenseCategories: ExpenseCategory[];
  expenses: Expense[];
  stockMovements: StockMovement[];
  stockAdjustments: StockAdjustment[];
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
  const [sales, setSales] = useState<Sale[]>([]);
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchaseItems, setPurchaseItems] = useState<PurchaseItem[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ExpenseCategory[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [stockAdjustments, setStockAdjustments] = useState<StockAdjustment[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([]);
  const [adminMembers, setAdminMembers] = useState<AdminMember[]>([]);
  const [staffCatalog, setStaffCatalog] = useState<StaffCatalogItem[]>([]);
  const [staffSales, setStaffSales] = useState<StaffSale[]>([]);
  const [loading, setLoading] = useState(true);

  const autoBackupAttemptedRef = useRef<string>('');
  const catalogSyncSigRef = useRef<string>('');
  const lookupBackfillSigRef = useRef<string>('');
  const reconcilingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user || !shopId || !sessionRole || initializingShop || !shopReady) {
      setLoading(true);
      return;
    }

    // Strict RBAC Data Isolation: Sales Staff NEVER subscribe to business financial/product/supplier collections
    if (sessionRole === 'sales_staff') {
      setSettings(null);
      setCategories([]);
      setBrands([]);
      setSuppliers([]);
      setProducts([]);
      setSales([]);
      setSaleItems([]);
      setPurchases([]);
      setPurchaseItems([]);
      setExpenseCategories([]);
      setExpenses([]);
      setStockMovements([]);
      setStockAdjustments([]);
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
        if (expected === 0) return;
      }

      let settled = 0;
      const markStaffSettled = () => {
        settled += 1;
        if (settled >= expected) {
          setLoading(false);
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
      return;
    }

    // Owner Workspace Subscriptions
    const uid = shopId;
    let settledCount = 0;
    const totalListeners = 19;
    const markSettled = () => {
      settledCount += 1;
      if (settledCount >= totalListeners) {
        setLoading(false);
      }
    };

    const listenList = <T extends { id: string }>(
      colName: string,
      setter: (items: T[]) => void
    ) => {
      const path = `shops/${uid}/${colName}`;
      const q = query(collection(db, 'shops', uid, colName), where('ownerUid', '==', uid));
      let first = true;
      return onSnapshot(
        q,
        (snap) => {
          setter(
            snap.docs.map((d) => ({ ...(d.data() as Omit<T, 'id'>), id: d.id }) as T)
          );
          if (first) {
            first = false;
            markSettled();
          }
        },
        (error) => {
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
        handleFirestoreError(error, OperationType.GET, settingsPath);
      }
    );

    const unsubs = [
      unsubSettings,
      listenList<Category>('categories', setCategories),
      listenList<Brand>('brands', setBrands),
      listenList<Supplier>('suppliers', setSuppliers),
      listenList<Product>('products', setProducts),
      listenList<Sale>('sales', setSales),
      listenList<SaleItem>('saleItems', setSaleItems),
      listenList<Purchase>('purchases', setPurchases),
      listenList<PurchaseItem>('purchaseItems', setPurchaseItems),
      listenList<ExpenseCategory>('expenseCategories', setExpenseCategories),
      listenList<Expense>('expenses', setExpenses),
      listenList<StockMovement>('stockMovements', setStockMovements),
      listenList<StockAdjustment>('stockAdjustments', setStockAdjustments),
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

  // Owner: keep sanitized staffCatalog synchronized with owner products & active staff permissions
  useEffect(() => {
    if (sessionRole !== 'owner' || !shopId || loading) return;
    const allowedUidsKey = getCatalogAllowedUids(staffMembers).sort().join(',');
    const prodSig = products
      .map((p) => `${p.id}:${p.name}:${p.categoryName}:${p.brandName}:${p.salePrice}:${p.currentStock}:${p.unit}:${p.isActive}`)
      .join('|');
    const catSig = staffCatalog
      .map((c) => `${c.productId}:${c.name}:${c.categoryName}:${c.brandName}:${c.salePrice}:${c.currentStock}:${c.unit}:${c.isActive}:${(c.allowedStaffUids || []).slice().sort().join(',')}`)
      .join('|');
    const combinedSig = `${allowedUidsKey}::${prodSig}::${catSig}`;

    if (catalogSyncSigRef.current === combinedSig) return;
    catalogSyncSigRef.current = combinedSig;

    void syncStaffCatalogDocuments(shopId, products, staffMembers, staffCatalog).catch((err) => {
      console.error('Staff catalog sync error:', err);
    });
  }, [sessionRole, shopId, loading, products, staffMembers, staffCatalog]);

  // Owner: backfill username-only staffLookup documents (u_<username>) for any pre-existing staff
  useEffect(() => {
    if (sessionRole !== 'owner' || !shopId || loading || staffMembers.length === 0) return;
    const sig = staffMembers
      .map((s) => `${s.id}:${s.usernameLower}:${s.loginVersion}:${s.isActive}`)
      .join('|');
    if (lookupBackfillSigRef.current === sig) return;
    lookupBackfillSigRef.current = sig;

    void ensureUsernameStaffLookupIndexes(shopId, staffMembers).catch((err) => {
      console.error('Staff username index sync error:', err);
    });
  }, [sessionRole, shopId, loading, staffMembers]);

  // Owner: automatically reconcile any new staffSales into the full P&L ledger and product stock
  useEffect(() => {
    if (sessionRole !== 'owner' || !shopId || loading) return;
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
  }, [sessionRole, shopId, loading, staffSales]);

  // Automatic daily backup snapshot metadata check (Owner only)
  useEffect(() => {
    if (sessionRole !== 'owner' || !shopId || loading || !settings || !settings.autoBackupEnabled) return;
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
    loading,
    settings,
    products.length,
    sales.length,
    purchases.length,
    expenses.length,
    stockAdjustments.length,
  ]);

  const value = useMemo<ShopDataContextValue>(
    () => ({
      settings,
      categories: [...categories].sort((a, b) => a.name.localeCompare(b.name)),
      brands: [...brands].sort((a, b) => a.name.localeCompare(b.name)),
      suppliers: [...suppliers].sort((a, b) => a.name.localeCompare(b.name)),
      products: [...products].sort((a, b) => a.name.localeCompare(b.name)),
      sales: [...sales].sort((a, b) => {
        const dateCmp = b.saleDate.localeCompare(a.saleDate);
        if (dateCmp !== 0) return dateCmp;
        return (b.saleDateTime || '').localeCompare(a.saleDateTime || '');
      }),
      saleItems,
      purchases: [...purchases].sort((a, b) => b.purchaseDate.localeCompare(a.purchaseDate)),
      purchaseItems,
      expenseCategories: [...expenseCategories].sort((a, b) => a.name.localeCompare(b.name)),
      expenses: [...expenses].sort((a, b) => b.expenseDate.localeCompare(a.expenseDate)),
      stockMovements: [...stockMovements].sort((a, b) => b.movementDate.localeCompare(a.movementDate)),
      stockAdjustments: [...stockAdjustments].sort((a, b) => b.adjustmentDate.localeCompare(a.adjustmentDate)),
      auditLogs: [...auditLogs].sort(
        (a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt)
      ),
      backups: [...backups].sort(
        (a, b) => timestampToMillis(b.createdAt) - timestampToMillis(a.createdAt)
      ),
      staffMembers: [...staffMembers].sort((a, b) => a.name.localeCompare(b.name)),
      adminMembers: [...adminMembers].sort((a, b) => a.name.localeCompare(b.name)),
      staffCatalog: [...staffCatalog].sort((a, b) => a.name.localeCompare(b.name)),
      staffSales: [...staffSales].sort((a, b) => {
        const dateCmp = b.saleDate.localeCompare(a.saleDate);
        if (dateCmp !== 0) return dateCmp;
        return (b.saleDateTime || '').localeCompare(a.saleDateTime || '');
      }),
      loading,
    }),
    [
      settings,
      categories,
      brands,
      suppliers,
      products,
      sales,
      saleItems,
      purchases,
      purchaseItems,
      expenseCategories,
      expenses,
      stockMovements,
      stockAdjustments,
      auditLogs,
      backups,
      staffMembers,
      adminMembers,
      staffCatalog,
      staffSales,
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
