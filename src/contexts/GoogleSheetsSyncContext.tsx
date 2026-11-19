import { collection, doc, onSnapshot, query, type Timestamp, where } from 'firebase/firestore';
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
import { SHEET_TABS, type SheetTabName } from '../../shared/googleSheetsSchema';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { buildSheetSyncPayload, type ShopSnapshotData } from '../services/googleSheetsMapper';
import { isNetworkOrOfflineError } from '../services/offlineSyncService';
import {
  deleteSyncJob,
  ensureIntegrationDoc,
  enqueueOrUpdateSyncJob,
} from '../services/sheetsQueueService';
import type { GoogleSheetsIntegration, SheetsSyncJob } from '../types/shop';
import {
  buildPolicyEnforcedResolution,
  classifySheetsSyncError,
  type SheetsErrorResolution,
  SheetsOAuthError,
} from '../utils/sheetsErrorHandling';
import { exportAllTabsWorkbook } from '../utils/sheetsWorkbookExport';
import { useAuth } from './AuthContext';
import { useShopData } from './ShopDataContext';
import { useToast } from './ToastContext';

const ALL_SHEET_NAMES: SheetTabName[] = SHEET_TABS.map((t) => t.name);
const QUEUED_BATCH_JOB_ID = 'pending_auto_batch';

function tsKey(ts?: Timestamp): string {
  if (!ts) return '0';
  return `${ts.seconds || 0}.${ts.nanoseconds || 0}`;
}

interface ModuleSignatures {
  products: string;
  sales: string;
  saleItems: string;
  purchases: string;
  purchaseItems: string;
  expenses: string;
  stockMovements: string;
  stockAdjustments: string;
  suppliers: string;
  categoriesBrands: string;
  staffMembers: string;
}

function computeSignatures(data: ShopSnapshotData): ModuleSignatures {
  return {
    products: data.products
      .map(
        (p) =>
          `${p.id}:${p.name}:${p.currentStock}:${p.purchasePrice}:${p.salePrice}:${p.wholesalePrice}:${p.isActive}:${tsKey(p.updatedAt)}`
      )
      .join('|'),
    sales: data.sales
      .map(
        (s) =>
          `${s.id}:${s.saleDate}:${s.totalAmount}:${s.paymentMethod}:${s.status}:${s.notes}:${tsKey(s.updatedAt)}`
      )
      .join('|'),
    saleItems: data.saleItems
      .map(
        (i) =>
          `${i.id}:${i.saleId}:${i.quantity}:${i.lineTotal}:${i.purchasePriceAtSale}:${i.status}:${tsKey(i.updatedAt)}`
      )
      .join('|'),
    purchases: data.purchases
      .map(
        (p) =>
          `${p.id}:${p.purchaseDate}:${p.totalAmount}:${p.amountPaid}:${p.balanceDue}:${p.status}:${tsKey(p.updatedAt)}`
      )
      .join('|'),
    purchaseItems: data.purchaseItems
      .map(
        (i) =>
          `${i.id}:${i.purchaseId}:${i.quantity}:${i.lineTotal}:${i.status}:${tsKey(i.updatedAt)}`
      )
      .join('|'),
    expenses: data.expenses
      .map(
        (e) =>
          `${e.id}:${e.title}:${e.amount}:${e.expenseDate}:${e.categoryName}:${e.paymentMethod}:${tsKey(e.updatedAt)}`
      )
      .join('|'),
    stockMovements: data.stockMovements
      .map((m) => `${m.id}:${m.productId}:${m.quantityChange}:${m.newStock}`)
      .join('|'),
    stockAdjustments: data.stockAdjustments
      .map((a) => `${a.id}:${a.productId}:${a.adjustmentType}:${a.quantity}`)
      .join('|'),
    suppliers: data.suppliers
      .map(
        (s) =>
          `${s.id}:${s.name}:${s.phone}:${s.totalPurchased}:${s.totalPaid}:${s.outstandingBalance}:${tsKey(s.updatedAt)}`
      )
      .join('|'),
    categoriesBrands: [
      ...data.categories.map((c) => `c:${c.id}:${c.name}:${tsKey(c.updatedAt)}`),
      ...data.brands.map((b) => `b:${b.id}:${b.name}:${tsKey(b.updatedAt)}`),
    ].join('|'),
    staffMembers: data.staffMembers
      .map((st) => `${st.id}:${st.name}:${st.isActive}:${tsKey(st.updatedAt)}`)
      .join('|'),
  };
}

function getDirtyTabsFromSigDiff(prev: ModuleSignatures, next: ModuleSignatures): SheetTabName[] {
  const dirty = new Set<SheetTabName>();
  if (prev.products !== next.products) {
    dirty.add('Products');
    dirty.add('Inventory');
    dirty.add('Daily Summary');
  }
  if (prev.sales !== next.sales || prev.saleItems !== next.saleItems) {
    dirty.add('Sales');
    dirty.add('Sales Details');
    dirty.add('Daily Summary');
    dirty.add('Monthly Summary');
    dirty.add('Staff Performance');
  }
  if (prev.purchases !== next.purchases || prev.purchaseItems !== next.purchaseItems) {
    dirty.add('Purchases');
    dirty.add('Purchase Details');
    dirty.add('Daily Summary');
    dirty.add('Monthly Summary');
  }
  if (prev.expenses !== next.expenses) {
    dirty.add('Expenses');
    dirty.add('Daily Summary');
    dirty.add('Monthly Summary');
  }
  if (prev.stockMovements !== next.stockMovements) {
    dirty.add('Stock Movements');
    dirty.add('Daily Summary');
  }
  if (prev.stockAdjustments !== next.stockAdjustments) {
    dirty.add('Stock Adjustments');
  }
  if (prev.suppliers !== next.suppliers) {
    dirty.add('Suppliers');
  }
  if (prev.categoriesBrands !== next.categoriesBrands) {
    dirty.add('Categories & Brands');
  }
  if (prev.staffMembers !== next.staffMembers) {
    dirty.add('Staff Performance');
  }
  return Array.from(dirty);
}

interface SheetsCapabilities {
  loaded: boolean;
  serviceAccountConfigured: boolean;
  serviceAccountSource: 'vault' | 'env' | 'none';
  serviceAccountEmail: string | null;
  serviceAccountProjectId: string | null;
  serviceAccountStatus: 'active' | 'not_configured' | 'invalid_format';
  serviceAccountDiagnostic: string | null;
  defaultSpreadsheetId: string | null;
}

export interface SaveServiceAccountResult {
  serviceAccountEmail: string | null;
  serviceAccountProjectId: string | null;
  serviceAccountSource: 'vault' | 'env' | 'none';
}

export interface GoogleSheetsSyncContextValue {
  integration: GoogleSheetsIntegration | null;
  queueJobs: SheetsSyncJob[];
  firebaseConnected: boolean;
  sheetsAuthorized: boolean;
  serviceAccountConfigured: boolean;
  serviceAccountSource: 'vault' | 'env' | 'none';
  serviceAccountEmail: string | null;
  serviceAccountProjectId: string | null;
  serviceAccountStatus: 'active' | 'not_configured' | 'invalid_format';
  serviceAccountDiagnostic: string | null;
  isSyncing: boolean;
  pendingCount: number;
  failedCount: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorResolution: SheetsErrorResolution | null;
  connectAndInitializeSheets: () => Promise<void>;
  linkSpreadsheet: (urlOrId: string) => Promise<void>;
  syncNow: (tabs?: SheetTabName[], explicitToken?: string) => Promise<void>;
  retryQueuedJobs: () => Promise<void>;
  refreshCapabilities: () => Promise<void>;
  saveServiceAccountJson: (rawJson: string) => Promise<SaveServiceAccountResult>;
  removeServiceAccount: () => Promise<void>;
  setAutoSyncEnabled: (enabled: boolean) => Promise<void>;
  clearSyncError: () => void;
  markPolicyEnforcedEncountered: () => void;
  exportWorkbook: () => { filename: string; totalRows: number; tabCount: number };
}

const GoogleSheetsSyncContext = createContext<GoogleSheetsSyncContextValue | null>(null);

export function GoogleSheetsSyncProvider({
  children,
  onNavigateToSettings,
}: {
  children: ReactNode;
  onNavigateToSettings?: () => void;
}) {
  const {
    user,
    sessionRole,
    shopId,
    shopReady,
    googleSheetsAccessToken,
    authorizeGoogleSheets,
    clearGoogleSheetsToken,
  } = useAuth();
  const shopData = useShopData();
  const { showToast } = useToast();

  const [integration, setIntegration] = useState<GoogleSheetsIntegration | null>(null);
  const [queueJobs, setQueueJobs] = useState<SheetsSyncJob[]>([]);
  const [integrationLoaded, setIntegrationLoaded] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [localErrorResolution, setLocalErrorResolution] =
    useState<SheetsErrorResolution | null>(null);
  const [capabilities, setCapabilities] = useState<SheetsCapabilities>({
    loaded: false,
    serviceAccountConfigured: false,
    serviceAccountSource: 'none',
    serviceAccountEmail: null,
    serviceAccountProjectId: null,
    serviceAccountStatus: 'not_configured',
    serviceAccountDiagnostic: null,
    defaultSpreadsheetId: null,
  });

  const latestDataRef = useRef<ShopSnapshotData>({
    products: [],
    sales: [],
    saleItems: [],
    purchases: [],
    purchaseItems: [],
    expenses: [],
    stockMovements: [],
    stockAdjustments: [],
    suppliers: [],
    categories: [],
    brands: [],
    staffMembers: [],
  });
  latestDataRef.current = {
    products: shopData.products,
    sales: shopData.sales,
    saleItems: shopData.saleItems,
    purchases: shopData.purchases,
    purchaseItems: shopData.purchaseItems,
    expenses: shopData.expenses,
    stockMovements: shopData.stockMovements,
    stockAdjustments: shopData.stockAdjustments,
    suppliers: shopData.suppliers,
    categories: shopData.categories,
    brands: shopData.brands,
    staffMembers: shopData.staffMembers,
  };

  const integrationRef = useRef<GoogleSheetsIntegration | null>(null);
  integrationRef.current = integration;

  const queueJobsRef = useRef<SheetsSyncJob[]>([]);
  queueJobsRef.current = queueJobs;

  const tokenRef = useRef<string | null>(null);
  tokenRef.current = googleSheetsAccessToken;

  const capabilitiesRef = useRef<SheetsCapabilities>(capabilities);
  capabilitiesRef.current = capabilities;

  const userRef = useRef(user);
  userRef.current = user;

  const prevSigRef = useRef<ModuleSignatures | null>(null);
  const dirtyTabsRef = useRef<Set<SheetTabName>>(new Set());
  const debounceTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const syncInFlightRef = useRef(false);
  const initialEnsureTriggeredRef = useRef<string>('');
  const consecutiveFailuresRef = useRef(0);
  const threeFailureToastFiredRef = useRef(false);

  const recordSyncFailure = useCallback(() => {
    const next = consecutiveFailuresRef.current + 1;
    consecutiveFailuresRef.current = next;
    setConsecutiveFailures(next);
  }, []);

  const resetSyncFailures = useCallback(() => {
    consecutiveFailuresRef.current = 0;
    threeFailureToastFiredRef.current = false;
    setConsecutiveFailures(0);
  }, []);

  useEffect(() => {
    if (sessionRole !== 'owner') return;
    if (consecutiveFailures >= 3 && !threeFailureToastFiredRef.current) {
      threeFailureToastFiredRef.current = true;
      showToast({
        id: 'sheets-consecutive-fail',
        title: 'Sync Failed',
        tone: 'error',
        message:
          'Google Sheets synchronization failed 3 consecutive times. Check your integration status in Settings.',
        actionLabel: onNavigateToSettings ? 'Go to Settings' : undefined,
        onAction: onNavigateToSettings,
        durationMs: 16000,
      });
    }
  }, [sessionRole, consecutiveFailures, showToast, onNavigateToSettings]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Subscribe to Owner-only Firestore integration metadata & sync queue
  useEffect(() => {
    if (!user || sessionRole !== 'owner' || !shopId || !shopReady) {
      setIntegration(null);
      setQueueJobs([]);
      setIntegrationLoaded(false);
      prevSigRef.current = null;
      return;
    }

    const intPath = `shops/${shopId}/integrations/googleSheets`;
    const intRef = doc(db, 'shops', shopId, 'integrations', 'googleSheets');
    const unsubInt = onSnapshot(
      intRef,
      (snap) => {
        if (snap.exists()) {
          setIntegration({
            id: snap.id,
            ...(snap.data() as Omit<GoogleSheetsIntegration, 'id'>),
          });
        } else {
          setIntegration(null);
        }
        setIntegrationLoaded(true);
      },
      (err) => {
        setIntegrationLoaded(true);
        if (isNetworkOrOfflineError(err)) return;
        handleFirestoreError(err, OperationType.GET, intPath);
      }
    );

    const queuePath = `shops/${shopId}/sheetsSyncQueue`;
    const queueQ = query(
      collection(db, 'shops', shopId, 'sheetsSyncQueue'),
      where('ownerUid', '==', shopId)
    );
    const unsubQueue = onSnapshot(
      queueQ,
      (snap) => {
        setQueueJobs(
          snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<SheetsSyncJob, 'id'>),
          }))
        );
      },
      (err) => {
        if (isNetworkOrOfflineError(err)) return;
        handleFirestoreError(err, OperationType.LIST, queuePath);
      }
    );

    return () => {
      unsubInt();
      unsubQueue();
    };
  }, [user, sessionRole, shopId, shopReady]);

  const fetchCapabilities = useCallback(async () => {
    const currentUser = userRef.current;
    if (!currentUser || sessionRole !== 'owner' || !shopId || !shopReady) {
      setCapabilities({
        loaded: false,
        serviceAccountConfigured: false,
        serviceAccountSource: 'none',
        serviceAccountEmail: null,
        serviceAccountProjectId: null,
        serviceAccountStatus: 'not_configured',
        serviceAccountDiagnostic: null,
        defaultSpreadsheetId: null,
      });
      return;
    }

    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch('/api/admin/sheets/capabilities', {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        serviceAccountConfigured?: boolean;
        serviceAccountSource?: 'vault' | 'env' | 'none';
        serviceAccountEmail?: string | null;
        serviceAccountProjectId?: string | null;
        serviceAccountStatus?: 'active' | 'not_configured' | 'invalid_format';
        serviceAccountDiagnostic?: string | null;
        defaultSpreadsheetId?: string | null;
      };
      setCapabilities({
        loaded: true,
        serviceAccountConfigured: Boolean(data.serviceAccountConfigured),
        serviceAccountSource:
          data.serviceAccountSource || (data.serviceAccountConfigured ? 'env' : 'none'),
        serviceAccountEmail: data.serviceAccountEmail || null,
        serviceAccountProjectId: data.serviceAccountProjectId || null,
        serviceAccountStatus:
          data.serviceAccountStatus ||
          (data.serviceAccountConfigured ? 'active' : 'not_configured'),
        serviceAccountDiagnostic: data.serviceAccountDiagnostic || null,
        defaultSpreadsheetId: data.defaultSpreadsheetId || null,
      });
    } catch {
      setCapabilities((prev) => ({ ...prev, loaded: true }));
    }
  }, [sessionRole, shopId, shopReady]);

  // Query server-side Google Sheets capabilities (Service Account / default Spreadsheet ID)
  useEffect(() => {
    if (!user || sessionRole !== 'owner' || !shopId || !shopReady) {
      setCapabilities({
        loaded: false,
        serviceAccountConfigured: false,
        serviceAccountSource: 'none',
        serviceAccountEmail: null,
        serviceAccountProjectId: null,
        serviceAccountStatus: 'not_configured',
        serviceAccountDiagnostic: null,
        defaultSpreadsheetId: null,
      });
      return;
    }

    void fetchCapabilities();
  }, [user, sessionRole, shopId, shopReady, fetchCapabilities]);

  const clearScheduledRetry = () => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  };

  const countRecordsForTabs = (tabs: SheetTabName[], data: ShopSnapshotData): number => {
    const payload = buildSheetSyncPayload(data, tabs);
    return Object.values(payload).reduce((sum, rows) => sum + (rows?.length ?? 0), 0);
  };

  const persistPendingJob = useCallback(
    async (
      tabs: SheetTabName[],
      status: 'pending' | 'failed',
      errorMessage: string,
      retryCount: number
    ) => {
      if (!shopId || sessionRole !== 'owner') return;
      const existing = queueJobsRef.current.find((j) => j.id === QUEUED_BATCH_JOB_ID);
      const mergedTabs = Array.from(
        new Set<SheetTabName>([
          ...((existing?.targetSheets || []) as SheetTabName[]),
          ...tabs,
        ])
      );
      const recordCount = countRecordsForTabs(mergedTabs, latestDataRef.current);
      await enqueueOrUpdateSyncJob(shopId, {
        id: QUEUED_BATCH_JOB_ID,
        jobType: mergedTabs.length >= ALL_SHEET_NAMES.length ? 'full' : 'incremental',
        targetSheets: mergedTabs,
        recordCount,
        status,
        retryCount,
        lastError: errorMessage,
        summary: `${mergedTabs.length} worksheet(s) queued for synchronization`,
      }).catch((err) => {
        console.error('Failed to persist sync queue job:', err);
      });
    },
    [shopId, sessionRole]
  );

  const executeSync = useCallback(
    async (
      tabsToSync: SheetTabName[],
      options?: { explicitToken?: string; throwOnError?: boolean; retryAttempt?: number }
    ) => {
      const currentUser = userRef.current;
      if (!currentUser || !shopId || sessionRole !== 'owner') return;
      if (tabsToSync.length === 0) return;

      const accessToken = options?.explicitToken || tokenRef.current;
      const hasServerServiceAccount = capabilitiesRef.current.serviceAccountConfigured;
      const attempt = options?.retryAttempt ?? 0;

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const resolution = classifySheetsSyncError({
          message: 'Device is offline.',
          serviceAccountConfigured: capabilitiesRef.current.serviceAccountConfigured,
          serviceAccountEmail: capabilitiesRef.current.serviceAccountEmail,
          serviceAccountStatus: capabilitiesRef.current.serviceAccountStatus,
          serviceAccountDiagnostic: capabilitiesRef.current.serviceAccountDiagnostic,
        });
        setLocalError(resolution.summary);
        setLocalErrorResolution(resolution);
        await persistPendingJob(tabsToSync, 'pending', resolution.summary, attempt);
        if (options?.throwOnError) throw new SheetsOAuthError(resolution);
        return;
      }

      if (!accessToken && !hasServerServiceAccount) {
        const resolution = classifySheetsSyncError({
          code: 'GOOGLE_TOKEN_MISSING',
          status: 401,
          message:
            capabilitiesRef.current.serviceAccountDiagnostic ||
            'Google Sheets authorization needed.',
          serviceAccountConfigured: false,
          serviceAccountEmail: null,
          serviceAccountStatus: capabilitiesRef.current.serviceAccountStatus,
          serviceAccountDiagnostic: capabilitiesRef.current.serviceAccountDiagnostic,
        });
        setLocalError(resolution.summary);
        setLocalErrorResolution(resolution);
        recordSyncFailure();
        await persistPendingJob(tabsToSync, 'pending', resolution.summary, attempt);
        await ensureIntegrationDoc(shopId, {
          connectionState: integrationRef.current?.spreadsheetId ? 'error' : 'disconnected',
          lastSyncStatus: 'error',
          lastError: resolution.summary,
        }).catch(() => undefined);
        if (options?.throwOnError) throw new SheetsOAuthError(resolution);
        return;
      }

      if (syncInFlightRef.current) {
        tabsToSync.forEach((t) => dirtyTabsRef.current.add(t));
        return;
      }

      syncInFlightRef.current = true;
      setIsSyncing(true);
      setLocalError(null);
      setLocalErrorResolution(null);
      clearScheduledRetry();

      try {
        await ensureIntegrationDoc(shopId, {
          lastSyncStatus: 'syncing',
        }).catch(() => undefined);

        const idToken = await currentUser.getIdToken();
        const snapshot = latestDataRef.current;
        const sheetsPayload = buildSheetSyncPayload(snapshot, tabsToSync);
        const totalRowsInSync = Object.values(sheetsPayload).reduce(
          (sum, rows) => sum + (rows?.length ?? 0),
          0
        );

        const reqHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        };
        if (accessToken) {
          reqHeaders['X-Google-Access-Token'] = accessToken;
        }

        const res = await fetch('/api/admin/sheets/sync', {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify({
            spreadsheetId:
              integrationRef.current?.spreadsheetId ||
              capabilitiesRef.current.defaultSpreadsheetId ||
              undefined,
            sheets: sheetsPayload,
          }),
        });

        const body = (await res.json().catch(() => ({}))) as {
          spreadsheetId?: string;
          spreadsheetUrl?: string;
          syncedTabs?: SheetTabName[];
          updatedRowCount?: number;
          appendedRowCount?: number;
          code?: string;
          error?: string;
        };

        if (!res.ok) {
          if (body.code === 'GOOGLE_TOKEN_EXPIRED' || res.status === 401) {
            clearGoogleSheetsToken();
          }
          const errMsg = body.error || `Google Sheets sync failed (HTTP ${res.status}).`;
          const resolution = classifySheetsSyncError({
            code: body.code,
            status: res.status,
            message: errMsg,
            serviceAccountConfigured: capabilitiesRef.current.serviceAccountConfigured,
            serviceAccountEmail: capabilitiesRef.current.serviceAccountEmail,
            serviceAccountStatus: capabilitiesRef.current.serviceAccountStatus,
            serviceAccountDiagnostic: capabilitiesRef.current.serviceAccountDiagnostic,
          });
          const isRetryable =
            res.status === 429 || res.status >= 500 || body.code === 'GOOGLE_RATE_LIMIT';

          await persistPendingJob(
            tabsToSync,
            body.code === 'GOOGLE_TOKEN_EXPIRED' || body.code === 'GOOGLE_TOKEN_MISSING'
              ? 'pending'
              : 'failed',
            resolution.summary,
            attempt + 1
          );
          await ensureIntegrationDoc(shopId, {
            connectionState: 'error',
            lastSyncStatus: 'error',
            lastError: resolution.summary,
          }).catch(() => undefined);
          setLocalError(resolution.summary);
          setLocalErrorResolution(resolution);
          recordSyncFailure();

          if (isRetryable && attempt < 3) {
            const delayMs = [5000, 15000, 45000][attempt] || 45000;
            retryTimerRef.current = window.setTimeout(() => {
              void executeSync(tabsToSync, { retryAttempt: attempt + 1 });
            }, delayMs);
          }

          if (options?.throwOnError) {
            throw new SheetsOAuthError(resolution);
          }
          return;
        }

        // Sync succeeded — clear pending queue jobs and update integration metadata
        const syncedAtIso = new Date().toISOString();
        const existingQueued = queueJobsRef.current;
        for (const job of existingQueued) {
          await deleteSyncJob(shopId, job.id).catch(() => undefined);
        }

        setLocalError(null);
        setLocalErrorResolution(null);
        resetSyncFailures();

        await ensureIntegrationDoc(shopId, {
          spreadsheetId: body.spreadsheetId || integrationRef.current?.spreadsheetId || '',
          spreadsheetUrl: body.spreadsheetUrl || integrationRef.current?.spreadsheetUrl || '',
          spreadsheetTitle: 'CareMart Shop Manager – Business Records',
          connectionState: 'connected',
          lastSyncAt: syncedAtIso,
          lastSyncStatus: 'synced',
          lastError: '',
          syncedRecordCount: totalRowsInSync,
        }).catch(() => undefined);
      } catch (err) {
        if (err instanceof SheetsOAuthError) {
          recordSyncFailure();
          if (options?.throwOnError) throw err;
          return;
        }
        const msg = err instanceof Error ? err.message : 'Google Sheets background sync failed.';
        const resolution = classifySheetsSyncError({
          message: msg,
          serviceAccountConfigured: capabilitiesRef.current.serviceAccountConfigured,
          serviceAccountEmail: capabilitiesRef.current.serviceAccountEmail,
          serviceAccountStatus: capabilitiesRef.current.serviceAccountStatus,
          serviceAccountDiagnostic: capabilitiesRef.current.serviceAccountDiagnostic,
        });
        const isAuthErr =
          resolution.code === 'token_expired' ||
          resolution.code === 'token_missing' ||
          resolution.code === 'policy_enforced' ||
          resolution.code === 'permission_denied';

        await persistPendingJob(
          tabsToSync,
          isAuthErr ? 'pending' : 'failed',
          resolution.summary,
          attempt + 1
        );
        await ensureIntegrationDoc(shopId, {
          connectionState: 'error',
          lastSyncStatus: 'error',
          lastError: resolution.summary,
        }).catch(() => undefined);
        setLocalError(resolution.summary);
        setLocalErrorResolution(resolution);
        recordSyncFailure();

        if (!isAuthErr && attempt < 3) {
          const delayMs = [5000, 15000, 45000][attempt] || 45000;
          retryTimerRef.current = window.setTimeout(() => {
            void executeSync(tabsToSync, { retryAttempt: attempt + 1 });
          }, delayMs);
        }

        if (options?.throwOnError) {
          throw new SheetsOAuthError(resolution);
        }
      } finally {
        syncInFlightRef.current = false;
        setIsSyncing(false);

        // Drain any changes that accumulated while this sync was in flight
        if (
          dirtyTabsRef.current.size > 0 &&
          (tokenRef.current || capabilitiesRef.current.serviceAccountConfigured) &&
          navigator.onLine
        ) {
          const nextDirty = Array.from(dirtyTabsRef.current);
          dirtyTabsRef.current.clear();
          if (integrationRef.current?.autoSyncEnabled !== false) {
            void executeSync(nextDirty);
          }
        }
      }
    },
    [shopId, sessionRole, clearGoogleSheetsToken, persistPendingJob, recordSyncFailure, resetSyncFailures]
  );

  const ensureAndSaveSpreadsheet = useCallback(
    async (
      targetSpreadsheetId: string | undefined,
      oauthToken: string | null,
      requireExisting = false
    ) => {
      if (!user || !shopId || sessionRole !== 'owner') {
        throw new Error('Only the Owner/Admin account can authorize Google Sheets.');
      }

      const idToken = await user.getIdToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      };
      if (oauthToken) {
        headers['X-Google-Access-Token'] = oauthToken;
      }

      const res = await fetch('/api/admin/sheets/ensure', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          spreadsheetId: targetSpreadsheetId || undefined,
          requireExisting,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        spreadsheetId?: string;
        spreadsheetUrl?: string;
        spreadsheetTitle?: string;
        created?: boolean;
        code?: string;
        error?: string;
      };

      if (!res.ok || !data.spreadsheetId) {
        const resolution = classifySheetsSyncError({
          code: data.code,
          status: res.status,
          message: data.error || 'Could not initialize Google Spreadsheet.',
          serviceAccountConfigured: capabilitiesRef.current.serviceAccountConfigured,
          serviceAccountEmail: capabilitiesRef.current.serviceAccountEmail,
          serviceAccountStatus: capabilitiesRef.current.serviceAccountStatus,
          serviceAccountDiagnostic: capabilitiesRef.current.serviceAccountDiagnostic,
        });
        setLocalError(resolution.summary);
        setLocalErrorResolution(resolution);
        throw new SheetsOAuthError(resolution);
      }

      setLocalError(null);
      setLocalErrorResolution(null);

      await ensureIntegrationDoc(shopId, {
        spreadsheetId: data.spreadsheetId,
        spreadsheetUrl: data.spreadsheetUrl || '',
        spreadsheetTitle: data.spreadsheetTitle || 'CareMart Shop Manager – Business Records',
        connectionState: 'connected',
        lastError: '',
      });

      await executeSync(ALL_SHEET_NAMES, {
        explicitToken: oauthToken || undefined,
        throwOnError: true,
      });
    },
    [user, shopId, sessionRole, executeSync]
  );

  const connectAndInitializeSheets = useCallback(async () => {
    if (!user || !shopId || sessionRole !== 'owner') {
      throw new Error('Only the Owner/Admin account can authorize Google Sheets.');
    }

    let token: string | null = tokenRef.current;
    if (!token && !capabilitiesRef.current.serviceAccountConfigured) {
      try {
        token = await authorizeGoogleSheets();
      } catch (err) {
        if (err instanceof SheetsOAuthError) {
          setLocalError(err.resolution.summary);
          setLocalErrorResolution(err.resolution);
          await ensureIntegrationDoc(shopId, {
            connectionState: 'error',
            lastSyncStatus: 'error',
            lastError: err.resolution.summary,
          }).catch(() => undefined);
        }
        throw err;
      }
      if (!token) {
        throw new Error('Failed to acquire Google Sheets authorization.');
      }
    }

    const targetId =
      integrationRef.current?.spreadsheetId ||
      capabilitiesRef.current.defaultSpreadsheetId ||
      undefined;
    await ensureAndSaveSpreadsheet(targetId, token, false);
  }, [user, shopId, sessionRole, authorizeGoogleSheets, ensureAndSaveSpreadsheet]);

  const linkSpreadsheet = useCallback(
    async (urlOrId: string) => {
      if (!user || !shopId || sessionRole !== 'owner') {
        throw new Error('Only the Owner/Admin account can link a Google Spreadsheet.');
      }
      const trimmed = urlOrId.trim();
      if (!trimmed) {
        throw new Error('Enter a Google Spreadsheet URL or Spreadsheet ID.');
      }

      let token: string | null = tokenRef.current;
      if (!token && !capabilitiesRef.current.serviceAccountConfigured) {
        try {
          token = await authorizeGoogleSheets();
        } catch (err) {
          if (err instanceof SheetsOAuthError) {
            setLocalError(err.resolution.summary);
            setLocalErrorResolution(err.resolution);
            await ensureIntegrationDoc(shopId, {
              connectionState: 'error',
              lastSyncStatus: 'error',
              lastError: err.resolution.summary,
            }).catch(() => undefined);
          }
          throw err;
        }
      }

      await ensureAndSaveSpreadsheet(trimmed, token, true);
    },
    [user, shopId, sessionRole, authorizeGoogleSheets, ensureAndSaveSpreadsheet]
  );

  const syncNow = useCallback(
    async (tabs?: SheetTabName[], explicitToken?: string) => {
      const targetTabs = tabs && tabs.length > 0 ? tabs : ALL_SHEET_NAMES;
      await executeSync(targetTabs, { explicitToken, throwOnError: true });
    },
    [executeSync]
  );

  const retryQueuedJobs = useCallback(async () => {
    const queuedTabs = Array.from(
      new Set<SheetTabName>(
        queueJobsRef.current.flatMap((j) => j.targetSheets as SheetTabName[])
      )
    );
    const tabsToRun = queuedTabs.length > 0 ? queuedTabs : ALL_SHEET_NAMES;
    await executeSync(tabsToRun, { throwOnError: true });
  }, [executeSync]);

  const saveServiceAccountJson = useCallback(
    async (rawJson: string): Promise<SaveServiceAccountResult> => {
      const currentUser = userRef.current;
      if (!currentUser || !shopId || sessionRole !== 'owner') {
        throw new Error('Only the Owner/Admin account can configure a Google Service Account.');
      }

      const idToken = await currentUser.getIdToken();
      const res = await fetch('/api/admin/sheets/service-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ serviceAccountJson: rawJson }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        serviceAccountConfigured?: boolean;
        serviceAccountSource?: 'vault' | 'env' | 'none';
        serviceAccountEmail?: string | null;
        serviceAccountProjectId?: string | null;
        serviceAccountStatus?: 'active' | 'not_configured' | 'invalid_format';
        serviceAccountDiagnostic?: string | null;
        defaultSpreadsheetId?: string | null;
      };

      if (!res.ok || !data.serviceAccountConfigured) {
        throw new Error(
          data.error ||
            'Failed to verify and store Google Service Account JSON. Ensure the JSON key is valid and unrevoked.'
        );
      }

      setCapabilities({
        loaded: true,
        serviceAccountConfigured: Boolean(data.serviceAccountConfigured),
        serviceAccountSource: data.serviceAccountSource || 'vault',
        serviceAccountEmail: data.serviceAccountEmail || null,
        serviceAccountProjectId: data.serviceAccountProjectId || null,
        serviceAccountStatus: data.serviceAccountStatus || 'active',
        serviceAccountDiagnostic: data.serviceAccountDiagnostic || null,
        defaultSpreadsheetId: data.defaultSpreadsheetId ?? capabilitiesRef.current.defaultSpreadsheetId,
      });

      // Clear previous OAuth/policy errors so sync immediately switches over cleanly
      setLocalError(null);
      setLocalErrorResolution(null);
      resetSyncFailures();
      initialEnsureTriggeredRef.current = '';

      await ensureIntegrationDoc(shopId, {
        connectionState: integrationRef.current?.spreadsheetId ? 'connected' : 'disconnected',
        lastError: '',
      }).catch(() => undefined);

      return {
        serviceAccountEmail: data.serviceAccountEmail || null,
        serviceAccountProjectId: data.serviceAccountProjectId || null,
        serviceAccountSource: data.serviceAccountSource || 'vault',
      };
    },
    [shopId, sessionRole]
  );

  const removeServiceAccount = useCallback(async () => {
    const currentUser = userRef.current;
    if (!currentUser || !shopId || sessionRole !== 'owner') {
      throw new Error('Only the Owner/Admin account can manage Google Service Account credentials.');
    }

    const idToken = await currentUser.getIdToken();
    const res = await fetch('/api/admin/sheets/service-account', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    });

    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      serviceAccountConfigured?: boolean;
      serviceAccountSource?: 'vault' | 'env' | 'none';
      serviceAccountEmail?: string | null;
      serviceAccountProjectId?: string | null;
      serviceAccountStatus?: 'active' | 'not_configured' | 'invalid_format';
      serviceAccountDiagnostic?: string | null;
      defaultSpreadsheetId?: string | null;
    };

    if (!res.ok) {
      throw new Error(data.error || 'Failed to remove saved Google Service Account credentials.');
    }

    const configured = Boolean(data.serviceAccountConfigured);
    setCapabilities({
      loaded: true,
      serviceAccountConfigured: configured,
      serviceAccountSource: data.serviceAccountSource || (configured ? 'env' : 'none'),
      serviceAccountEmail: data.serviceAccountEmail || null,
      serviceAccountProjectId: data.serviceAccountProjectId || null,
      serviceAccountStatus:
        data.serviceAccountStatus || (configured ? 'active' : 'not_configured'),
      serviceAccountDiagnostic: data.serviceAccountDiagnostic || null,
      defaultSpreadsheetId: data.defaultSpreadsheetId ?? capabilitiesRef.current.defaultSpreadsheetId,
    });

    if (!configured && !tokenRef.current) {
      setLocalError(null);
      setLocalErrorResolution(null);
      await ensureIntegrationDoc(shopId, {
        connectionState: 'disconnected',
        lastError: '',
      }).catch(() => undefined);
    }
  }, [shopId, sessionRole]);

  const setAutoSyncEnabled = useCallback(
    async (enabled: boolean) => {
      if (!shopId || sessionRole !== 'owner') return;
      await ensureIntegrationDoc(shopId, { autoSyncEnabled: enabled });
    },
    [shopId, sessionRole]
  );

  const clearSyncError = useCallback(() => {
    setLocalError(null);
    setLocalErrorResolution(null);
  }, []);

  const markPolicyEnforcedEncountered = useCallback(() => {
    const resolution = buildPolicyEnforcedResolution('sheets_oauth');
    setLocalError(resolution.summary);
    setLocalErrorResolution(resolution);
    if (shopId && sessionRole === 'owner') {
      void ensureIntegrationDoc(shopId, {
        connectionState: 'error',
        lastSyncStatus: 'error',
        lastError: resolution.summary,
      }).catch(() => undefined);
    }
  }, [shopId, sessionRole]);

  const exportWorkbook = useCallback(() => {
    return exportAllTabsWorkbook(latestDataRef.current);
  }, []);

  // Automatic initial spreadsheet creation & sync right after Owner signs in (Service Account or OAuth)
  useEffect(() => {
    const hasAuth = Boolean(googleSheetsAccessToken || capabilities.serviceAccountConfigured);
    if (
      sessionRole !== 'owner' ||
      !user ||
      !shopId ||
      !shopReady ||
      shopData.loading ||
      !integrationLoaded ||
      !capabilities.loaded ||
      !hasAuth ||
      !isOnline
    ) {
      return;
    }

    if (integration?.autoSyncEnabled === false) return;

    const alreadyInitializedSpreadsheet = Boolean(integration?.spreadsheetId);
    const hasPendingQueue = queueJobs.length > 0;
    const neverSynced = !integration?.lastSyncAt;
    const authSuffix = googleSheetsAccessToken
      ? googleSheetsAccessToken.slice(-8)
      : 'sa';

    if (!alreadyInitializedSpreadsheet || neverSynced) {
      const runKey = `${shopId}:${integration?.spreadsheetId || 'new'}:${authSuffix}`;
      if (initialEnsureTriggeredRef.current === runKey) return;
      initialEnsureTriggeredRef.current = runKey;
      void executeSync(ALL_SHEET_NAMES, {
        explicitToken: googleSheetsAccessToken || undefined,
      });
      return;
    }

    if (hasPendingQueue && !syncInFlightRef.current) {
      const queuedTabs = Array.from(
        new Set<SheetTabName>(queueJobs.flatMap((j) => j.targetSheets as SheetTabName[]))
      );
      if (queuedTabs.length > 0) {
        void executeSync(queuedTabs, {
          explicitToken: googleSheetsAccessToken || undefined,
        });
      }
    }
  }, [
    sessionRole,
    user,
    shopId,
    shopReady,
    shopData.loading,
    integrationLoaded,
    integration?.spreadsheetId,
    integration?.lastSyncAt,
    integration?.autoSyncEnabled,
    capabilities.loaded,
    capabilities.serviceAccountConfigured,
    googleSheetsAccessToken,
    isOnline,
    queueJobs,
    executeSync,
  ]);

  // Real-time background change detection across all Firebase collections
  useEffect(() => {
    if (sessionRole !== 'owner' || !user || !shopId || !shopReady || shopData.loading) {
      return;
    }

    const nextSigs = computeSignatures(latestDataRef.current);

    if (!prevSigRef.current) {
      prevSigRef.current = nextSigs;
      return;
    }

    const dirtyTabs = getDirtyTabsFromSigDiff(prevSigRef.current, nextSigs);
    prevSigRef.current = nextSigs;

    if (dirtyTabs.length === 0) return;
    if (integration?.autoSyncEnabled === false) return;

    dirtyTabs.forEach((t) => dirtyTabsRef.current.add(t));

    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      const batchTabs = Array.from(dirtyTabsRef.current);
      dirtyTabsRef.current.clear();
      if (batchTabs.length > 0) {
        void executeSync(batchTabs);
      }
    }, 1200);
  }, [
    sessionRole,
    user,
    shopId,
    shopReady,
    shopData.loading,
    shopData.products,
    shopData.sales,
    shopData.saleItems,
    shopData.purchases,
    shopData.purchaseItems,
    shopData.expenses,
    shopData.stockMovements,
    shopData.stockAdjustments,
    shopData.suppliers,
    shopData.categories,
    shopData.brands,
    shopData.staffMembers,
    integration?.autoSyncEnabled,
    executeSync,
  ]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  const pendingCount = useMemo(
    () =>
      queueJobs
        .filter((j) => j.status === 'pending')
        .reduce((sum, j) => sum + (j.recordCount || j.targetSheets.length), 0),
    [queueJobs]
  );

  const failedCount = useMemo(
    () =>
      queueJobs
        .filter((j) => j.status === 'failed')
        .reduce((sum, j) => sum + (j.recordCount || j.targetSheets.length), 0),
    [queueJobs]
  );

  const derivedErrorResolution = useMemo<SheetsErrorResolution | null>(() => {
    if (localErrorResolution) return localErrorResolution;
    if (capabilities.serviceAccountStatus === 'invalid_format') {
      return classifySheetsSyncError({
        message: capabilities.serviceAccountDiagnostic || 'Invalid Service Account JSON.',
        serviceAccountConfigured: capabilities.serviceAccountConfigured,
        serviceAccountEmail: capabilities.serviceAccountEmail,
        serviceAccountStatus: capabilities.serviceAccountStatus,
        serviceAccountDiagnostic: capabilities.serviceAccountDiagnostic,
      });
    }
    const persistedErr = localError || integration?.lastError;
    if (!persistedErr) return null;
    return classifySheetsSyncError({
      message: persistedErr,
      serviceAccountConfigured: capabilities.serviceAccountConfigured,
      serviceAccountEmail: capabilities.serviceAccountEmail,
      serviceAccountStatus: capabilities.serviceAccountStatus,
      serviceAccountDiagnostic: capabilities.serviceAccountDiagnostic,
    });
  }, [
    localErrorResolution,
    localError,
    integration?.lastError,
    capabilities.serviceAccountConfigured,
    capabilities.serviceAccountEmail,
    capabilities.serviceAccountStatus,
    capabilities.serviceAccountDiagnostic,
  ]);

  const value = useMemo<GoogleSheetsSyncContextValue>(
    () => ({
      integration,
      queueJobs,
      firebaseConnected: isOnline && shopReady,
      sheetsAuthorized: Boolean(googleSheetsAccessToken || capabilities.serviceAccountConfigured),
      serviceAccountConfigured: capabilities.serviceAccountConfigured,
      serviceAccountSource: capabilities.serviceAccountSource,
      serviceAccountEmail: capabilities.serviceAccountEmail,
      serviceAccountProjectId: capabilities.serviceAccountProjectId,
      serviceAccountStatus: capabilities.serviceAccountStatus,
      serviceAccountDiagnostic: capabilities.serviceAccountDiagnostic,
      isSyncing,
      pendingCount,
      failedCount,
      consecutiveFailures,
      lastError: localError || integration?.lastError || capabilities.serviceAccountDiagnostic || null,
      lastErrorResolution: derivedErrorResolution,
      connectAndInitializeSheets,
      linkSpreadsheet,
      syncNow,
      retryQueuedJobs,
      refreshCapabilities: fetchCapabilities,
      saveServiceAccountJson,
      removeServiceAccount,
      setAutoSyncEnabled,
      clearSyncError,
      markPolicyEnforcedEncountered,
      exportWorkbook,
    }),
    [
      integration,
      queueJobs,
      isOnline,
      shopReady,
      googleSheetsAccessToken,
      capabilities.serviceAccountConfigured,
      capabilities.serviceAccountSource,
      capabilities.serviceAccountEmail,
      capabilities.serviceAccountProjectId,
      capabilities.serviceAccountStatus,
      capabilities.serviceAccountDiagnostic,
      isSyncing,
      pendingCount,
      failedCount,
      consecutiveFailures,
      localError,
      derivedErrorResolution,
      connectAndInitializeSheets,
      linkSpreadsheet,
      syncNow,
      retryQueuedJobs,
      fetchCapabilities,
      saveServiceAccountJson,
      removeServiceAccount,
      setAutoSyncEnabled,
      clearSyncError,
      markPolicyEnforcedEncountered,
      exportWorkbook,
    ]
  );

  return (
    <GoogleSheetsSyncContext.Provider value={value}>
      {children}
    </GoogleSheetsSyncContext.Provider>
  );
}

export function useGoogleSheetsSync() {
  return useContext(GoogleSheetsSyncContext);
}
