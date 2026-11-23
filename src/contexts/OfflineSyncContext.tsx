import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  applyPendingSalesToCatalog,
  createAndEnqueueOfflineSale,
  getQueuedOfflineSales,
  mapQueuedSaleToStaffSale,
  removeQueuedOfflineSale,
  syncQueuedOfflineSales,
  type DisplayStaffSale,
  type OfflineQueuedSale,
} from '../services/offlineSyncService';
import type { PaymentMethod, StaffCatalogItem } from '../types/shop';
import { useAuth } from './AuthContext';
import { useShopData } from './ShopDataContext';

interface OfflineSyncContextValue {
  isOnline: boolean;
  pendingSales: OfflineQueuedSale[];
  pendingCount: number;
  failedCount: number;
  isSyncing: boolean;
  lastSyncedAt: string | null;
  lastSyncNotice: string | null;
  clearSyncNotice: () => void;
  effectiveCatalog: StaffCatalogItem[];
  mergedStaffSales: DisplayStaffSale[];
  queueOfflineSale: (
    catalogMap: Map<string, StaffCatalogItem>,
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
  ) => OfflineQueuedSale;
  syncNow: (includeFailed?: boolean) => Promise<void>;
  retryQueuedSale: (localId: string) => Promise<void>;
  discardQueuedSale: (localId: string) => void;
}

const OfflineSyncContext = createContext<OfflineSyncContextValue | null>(null);

export function OfflineSyncProvider({ children }: { children: ReactNode }) {
  const { user, sessionRole, shopId, staffProfile } = useAuth();
  const { staffCatalog, staffSales } = useShopData();

  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [pendingSales, setPendingSales] = useState<OfflineQueuedSale[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastSyncNotice, setLastSyncNotice] = useState<string | null>(null);

  const staffSalesRef = useRef(staffSales);
  staffSalesRef.current = staffSales;
  const noticeTimerRef = useRef<number | null>(null);

  const showTimedNotice = useCallback((message: string) => {
    setLastSyncNotice(message);
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setLastSyncNotice(null);
      noticeTimerRef.current = null;
    }, 8000);
  }, []);

  const clearSyncNotice = useCallback(() => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setLastSyncNotice(null);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  // Track browser online / offline connectivity
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Load persisted pending queue for the signed-in sales staff member
  useEffect(() => {
    if (sessionRole !== 'sales_staff' || !shopId || !user?.uid) {
      setPendingSales([]);
      return;
    }
    setPendingSales(getQueuedOfflineSales(shopId, user.uid));
  }, [sessionRole, shopId, user?.uid]);

  const syncNow = useCallback(
    async (includeFailed = false) => {
      if (
        sessionRole !== 'sales_staff' ||
        !shopId ||
        !staffProfile ||
        !user?.uid ||
        !navigator.onLine
      ) {
        return;
      }

      const currentQueue = getQueuedOfflineSales(shopId, user.uid);
      const hasTargets = currentQueue.some((q) =>
        includeFailed ? true : q.syncStatus !== 'failed'
      );
      if (!hasTargets) {
        setPendingSales(currentQueue);
        return;
      }

      setIsSyncing(true);
      try {
        const result = await syncQueuedOfflineSales(
          shopId,
          staffProfile,
          staffSalesRef.current,
          {
            includeFailed,
            onQueueUpdated: (nextQueue) => {
              setPendingSales(nextQueue);
            },
          }
        );

        setPendingSales(getQueuedOfflineSales(shopId, user.uid));

        if (result.syncedCount > 0) {
          setLastSyncedAt(new Date().toISOString());
          const label = result.syncedCount === 1 ? 'offline sale' : 'offline sales';
          showTimedNotice(`Synced ${result.syncedCount} ${label} to the shop ledger.`);
        }
      } finally {
        setIsSyncing(false);
      }
    },
    [sessionRole, shopId, staffProfile, user?.uid, showTimedNotice]
  );

  // Auto-sync queued sales whenever connectivity is online and pending items exist
  useEffect(() => {
    if (sessionRole !== 'sales_staff' || !isOnline || !shopId || !staffProfile) {
      return;
    }
    const hasPending = pendingSales.some((q) => q.syncStatus === 'pending');
    if (!hasPending) return;

    const timer = window.setTimeout(() => {
      void syncNow(false);
    }, 600);

    return () => window.clearTimeout(timer);
  }, [sessionRole, isOnline, shopId, staffProfile, pendingSales, syncNow]);

  // Periodic background retry every 30s if online and non-failed pending items remain
  useEffect(() => {
    if (sessionRole !== 'sales_staff' || !isOnline || !shopId || !staffProfile) {
      return;
    }
    const hasPending = pendingSales.some((q) => q.syncStatus === 'pending');
    if (!hasPending) return;

    const interval = window.setInterval(() => {
      void syncNow(false);
    }, 30000);

    return () => window.clearInterval(interval);
  }, [sessionRole, isOnline, shopId, staffProfile, pendingSales, syncNow]);

  const queueOfflineSale = useCallback(
    (
      catalogMap: Map<string, StaffCatalogItem>,
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
    ) => {
      if (!shopId || !staffProfile) {
        throw new Error('Staff session is not ready.');
      }
      const queued = createAndEnqueueOfflineSale(shopId, staffProfile, catalogMap, input);
      setPendingSales(getQueuedOfflineSales(shopId, staffProfile.authUid));
      return queued;
    },
    [shopId, staffProfile]
  );

  const retryQueuedSale = useCallback(
    async (localId: string) => {
      if (sessionRole !== 'sales_staff' || !shopId || !staffProfile || !user?.uid) return;
      if (!navigator.onLine) return;
      setIsSyncing(true);
      try {
        const result = await syncQueuedOfflineSales(
          shopId,
          staffProfile,
          staffSalesRef.current,
          {
            onlyLocalId: localId,
            includeFailed: true,
            onQueueUpdated: (nextQueue) => setPendingSales(nextQueue),
          }
        );
        setPendingSales(getQueuedOfflineSales(shopId, user.uid));
        if (result.syncedCount > 0) {
          setLastSyncedAt(new Date().toISOString());
          showTimedNotice('Pending sale synced successfully.');
        }
      } finally {
        setIsSyncing(false);
      }
    },
    [sessionRole, shopId, staffProfile, user?.uid, showTimedNotice]
  );

  const discardQueuedSale = useCallback(
    (localId: string) => {
      if (!shopId || !user?.uid) return;
      const next = removeQueuedOfflineSale(shopId, user.uid, localId);
      setPendingSales(next);
    },
    [shopId, user?.uid]
  );

  const effectiveCatalog = useMemo(
    () => applyPendingSalesToCatalog(staffCatalog, pendingSales),
    [staffCatalog, pendingSales]
  );

  const mergedStaffSales = useMemo<DisplayStaffSale[]>(() => {
    if (!pendingSales.length) return staffSales;
    const remoteSaleNumbers = new Set(staffSales.map((s) => s.saleNumber));
    const pendingDisplay = pendingSales
      .filter((q) => !remoteSaleNumbers.has(q.saleNumber))
      .map(mapQueuedSaleToStaffSale);

    const combined: DisplayStaffSale[] = [...pendingDisplay, ...staffSales];
    return combined.sort((a, b) => {
      const dateCmp = b.saleDate.localeCompare(a.saleDate);
      if (dateCmp !== 0) return dateCmp;
      return (b.saleDateTime || '').localeCompare(a.saleDateTime || '');
    });
  }, [pendingSales, staffSales]);

  const pendingCount = pendingSales.length;
  const failedCount = useMemo(
    () => pendingSales.filter((q) => q.syncStatus === 'failed').length,
    [pendingSales]
  );

  const value = useMemo<OfflineSyncContextValue>(
    () => ({
      isOnline,
      pendingSales,
      pendingCount,
      failedCount,
      isSyncing,
      lastSyncedAt,
      lastSyncNotice,
      clearSyncNotice,
      effectiveCatalog,
      mergedStaffSales,
      queueOfflineSale,
      syncNow,
      retryQueuedSale,
      discardQueuedSale,
    }),
    [
      isOnline,
      pendingSales,
      pendingCount,
      failedCount,
      isSyncing,
      lastSyncedAt,
      lastSyncNotice,
      clearSyncNotice,
      effectiveCatalog,
      mergedStaffSales,
      queueOfflineSale,
      syncNow,
      retryQueuedSale,
      discardQueuedSale,
    ]
  );

  return <OfflineSyncContext.Provider value={value}>{children}</OfflineSyncContext.Provider>;
}

export function useOfflineSync() {
  const ctx = useContext(OfflineSyncContext);
  if (!ctx) throw new Error('useOfflineSync must be used inside OfflineSyncProvider');
  return ctx;
}
