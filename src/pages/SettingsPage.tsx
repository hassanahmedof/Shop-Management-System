import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileSpreadsheet,
  KeyRound,
  Link2,
  Lock,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CompactSection } from '../components/CompactSection';
import { useAuth } from '../contexts/AuthContext';
import { useGoogleSheetsSync } from '../contexts/GoogleSheetsSyncContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import {
  createBrand,
  createCategory,
  createExpenseCategory,
  createSupplier,
  deleteBrand,
  deleteCategory,
  deleteExpenseCategory,
  deleteSupplier,
  recordBackupSnapshot,
  updateShopSettings,
} from '../services/shopService';
import { formatDateDDMMYYYY, formatDateTimeKarachi, getKarachiDateIso } from '../utils/formatters';

export function SettingsPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { showToast } = useToast();
  const {
    settings,
    categories,
    brands,
    suppliers,
    expenseCategories,
    products,
    sales,
    saleItems,
    purchases,
    purchaseItems,
    expenses,
    stockMovements,
    stockAdjustments,
    auditLogs,
    backups,
  } = useShopData();

  const [shopName, setShopName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [expiryAlertDays, setExpiryAlertDays] = useState('30');
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // Catalog Manager states
  const [newCategory, setNewCategory] = useState('');
  const [newBrand, setNewBrand] = useState('');
  const [newSupplierName, setNewSupplierName] = useState('');
  const [newSupplierPhone, setNewSupplierPhone] = useState('');
  const [newExpCategory, setNewExpCategory] = useState('');

  // Google Sheets sync controls state
  const sheetsSync = useGoogleSheetsSync();
  const [showResolveModal, setShowResolveModal] = useState(false);
  const [sheetsActionBusy, setSheetsActionBusy] = useState(false);
  const [sheetsActionFeedback, setSheetsActionFeedback] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    'full_sync' | 'retry_failed' | 'link_sheet' | 'remove_sa' | null
  >(null);
  const [spreadsheetInput, setSpreadsheetInput] = useState('');
  const [copiedServiceEmail, setCopiedServiceEmail] = useState(false);
  const [checkingServerConfig, setCheckingServerConfig] = useState(false);

  // Admin Service Account (Write-Only Server-Encrypted Vault) inside Resolve Issues modal
  const [serviceAccountJsonInput, setServiceAccountJsonInput] = useState('');
  const [maskServiceAccountInput, setMaskServiceAccountInput] = useState(true);
  const [savingServiceAccount, setSavingServiceAccount] = useState(false);
  const [removingServiceAccount, setRemovingServiceAccount] = useState(false);
  const [serviceAccountFeedback, setServiceAccountFeedback] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const saFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (settings) {
      setShopName(settings.shopName);
      setOwnerName(settings.ownerName);
      setPhone(settings.phone);
      setAddress(settings.address);
      setExpiryAlertDays(String(settings.expiryAlertDays));
      setAutoBackupEnabled(settings.autoBackupEnabled);
    }
  }, [settings]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId) return;
    setSaving(true);
    setSavedMsg(null);
    try {
      await updateShopSettings(activeShopId, {
        shopName: shopName.trim() || 'CareMart Shop Manager',
        ownerName: ownerName.trim(),
        phone: phone.trim(),
        address: address.trim(),
        expiryAlertDays: Number(expiryAlertDays) || 30,
        autoBackupEnabled,
      });
      setSavedMsg('Shop settings updated.');
      showToast({
        title: 'Settings Saved',
        message: 'General shop settings updated.',
        tone: 'success',
        durationMs: 3500,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleManualBackupExport = async () => {
    if (!activeShopId) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      timezone: 'Asia/Karachi',
      currency: 'PKR',
      dateFormat: 'DD-MM-YYYY',
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
    };

    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shop_backup_${getKarachiDateIso()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    const totalCount =
      products.length + sales.length + purchases.length + expenses.length + stockAdjustments.length;
    await recordBackupSnapshot(activeShopId, 'manual', totalCount, 'Manual JSON backup downloaded');
    showToast({
      title: 'Backup Exported',
      message: 'Downloaded JSON snapshot for all shop records.',
      tone: 'success',
      durationMs: 3500,
    });
  };

  const handleConnectSheets = async () => {
    if (!sheetsSync) return;
    setSheetsActionBusy(true);
    setSheetsActionFeedback(null);
    try {
      await sheetsSync.connectAndInitializeSheets();
      setSheetsActionFeedback({
        tone: 'success',
        message:
          'Google Sheets synchronized with "CareMart Shop Manager – Business Records" (14 worksheets).',
      });
    } catch (err) {
      setSheetsActionFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to initialize Google Sheets.',
      });
    } finally {
      setSheetsActionBusy(false);
    }
  };

  const handleConfirmedSheetsAction = async () => {
    if (!sheetsSync || !confirmAction) return;
    const action = confirmAction;
    setConfirmAction(null);
    setSheetsActionBusy(true);
    setSheetsActionFeedback(null);
    try {
      if (action === 'retry_failed') {
        await sheetsSync.retryQueuedJobs();
        setSheetsActionFeedback({
          tone: 'success',
          message: 'Queued records successfully synchronized to Google Sheets.',
        });
      } else if (action === 'link_sheet') {
        await sheetsSync.linkSpreadsheet(spreadsheetInput);
        setSpreadsheetInput('');
        setSheetsActionFeedback({
          tone: 'success',
          message:
            'Linked Google Spreadsheet initialized with all 14 tabs and synchronized with Firebase records.',
        });
      } else if (action === 'remove_sa') {
        setRemovingServiceAccount(true);
        setServiceAccountFeedback(null);
        try {
          await sheetsSync.removeServiceAccount();
          setServiceAccountFeedback({
            tone: 'success',
            message:
              'Saved Google Service Account credentials have been permanently removed from the server vault.',
          });
        } finally {
          setRemovingServiceAccount(false);
        }
      } else {
        await sheetsSync.syncNow();
        setSheetsActionFeedback({
          tone: 'success',
          message: 'All 14 worksheets in Google Sheets synchronized with Firebase records.',
        });
      }
    } catch (err) {
      if (action === 'remove_sa') {
        setServiceAccountFeedback({
          tone: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to remove saved Google Service Account credentials.',
        });
      } else {
        setSheetsActionFeedback({
          tone: 'error',
          message: err instanceof Error ? err.message : 'Google Sheets synchronization failed.',
        });
      }
    } finally {
      setSheetsActionBusy(false);
    }
  };

  const handleRefreshServerCapabilities = async () => {
    if (!sheetsSync) return;
    setCheckingServerConfig(true);
    try {
      await sheetsSync.refreshCapabilities();
      setSheetsActionFeedback({
        tone: 'success',
        message: 'Checked server Google Sheets configuration.',
      });
    } finally {
      setCheckingServerConfig(false);
    }
  };

  const handleExportAllTabsWorkbook = () => {
    if (!sheetsSync) return;
    const { filename, totalRows, tabCount } = sheetsSync.exportWorkbook();
    setSheetsActionFeedback({
      tone: 'success',
      message: `Exported ${totalRows} business record rows across ${tabCount} worksheets to ${filename}.`,
    });
  };

  const handleCopyServiceEmail = async () => {
    const email = sheetsSync?.serviceAccountEmail;
    if (!email || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(email);
      setCopiedServiceEmail(true);
      window.setTimeout(() => setCopiedServiceEmail(false), 2000);
    } catch {
      // Clipboard write may be restricted in some contexts; input remains selectable
    }
  };

  const validateServiceAccountClientInput = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return 'Paste a Google Service Account JSON string or upload a .json key file.';
    }
    if (trimmed.length > 32_768) {
      return 'Service Account JSON payload exceeds the 32 KB size limit.';
    }
    let parsed: {
      type?: unknown;
      client_email?: unknown;
      private_key?: unknown;
    };
    try {
      parsed = JSON.parse(trimmed) as typeof parsed;
    } catch {
      return 'Invalid JSON syntax. Paste the complete JSON object downloaded from Google Cloud IAM & Admin.';
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'Service Account JSON must be a valid JSON object.';
    }
    if (parsed.type !== undefined && parsed.type !== 'service_account') {
      return `Expected "type": "service_account", received "${String(parsed.type)}". Make sure you downloaded a Service Account key (not an OAuth Client ID file).`;
    }
    if (typeof parsed.client_email !== 'string' || !parsed.client_email.includes('@')) {
      return 'Missing valid "client_email" field in Service Account JSON.';
    }
    if (
      typeof parsed.private_key !== 'string' ||
      !parsed.private_key.includes('BEGIN') ||
      !parsed.private_key.includes('PRIVATE KEY')
    ) {
      return 'Missing valid PEM "private_key" field in Service Account JSON.';
    }
    return null;
  };

  const handleSaveServiceAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sheetsSync) return;
    const validationErr = validateServiceAccountClientInput(serviceAccountJsonInput);
    if (validationErr) {
      setServiceAccountFeedback({ tone: 'error', message: validationErr });
      return;
    }

    setSavingServiceAccount(true);
    setServiceAccountFeedback(null);
    setSheetsActionFeedback(null);
    try {
      const result = await sheetsSync.saveServiceAccountJson(serviceAccountJsonInput);
      // Immediately purge secret JSON from component state after encrypted server storage
      setServiceAccountJsonInput('');
      if (saFileInputRef.current) {
        saFileInputRef.current.value = '';
      }
      setServiceAccountFeedback({
        tone: 'success',
        message: `Verified with Google & encrypted on server (${result.serviceAccountEmail || 'Service Account active'}). Share your target Google Sheet as Editor with that email and click Sync or Link Spreadsheet above.`,
      });
    } catch (err) {
      setServiceAccountFeedback({
        tone: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Unable to verify or store Google Service Account JSON.',
      });
    } finally {
      setSavingServiceAccount(false);
    }
  };

  const handleServiceAccountFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 32_768) {
      setServiceAccountFeedback({
        tone: 'error',
        message: 'Selected file exceeds the 32 KB limit for a Service Account JSON key.',
      });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      setServiceAccountJsonInput(text);
      const validationErr = validateServiceAccountClientInput(text);
      if (validationErr) {
        setServiceAccountFeedback({ tone: 'error', message: validationErr });
      } else {
        setServiceAccountFeedback({
          tone: 'success',
          message: `Loaded "${file.name}" into secure write-only input. Click "Verify & Save Service Account" to encrypt and activate on the server.`,
        });
      }
    };
    reader.onerror = () => {
      setServiceAccountFeedback({
        tone: 'error',
        message: 'Could not read the selected JSON file.',
      });
    };
    reader.readAsText(file);
  };

  const formatLastSync = (isoStr?: string) => {
    if (!isoStr) return 'Not synced yet';
    try {
      const dt = new Date(isoStr);
      if (Number.isNaN(dt.getTime())) return isoStr;
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Karachi',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .format(dt)
        .replace(/\//g, '-');
    } catch {
      return isoStr;
    }
  };

  return (
    <div className="space-y-4">
      {/* General Settings */}
      <CompactSection
        title="General Settings"
        subtitle="Regional defaults configured for Pakistan retail operations"
        collapsible
        defaultOpen
        bodyClassName="p-3.5 sm:p-4 space-y-3.5"
      >
        {savedMsg && (
          <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs sm:text-sm text-emerald-700">
            {savedMsg}
          </div>
        )}

        <form onSubmit={handleSaveSettings} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-medium text-slate-700 mb-1">Shop Name</label>
              <input
                type="text"
                required
                value={shopName}
                onChange={(e) => setShopName(e.target.value)}
                className="w-full px-3 py-2 min-h-[40px] sm:min-h-0 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">Owner Name</label>
              <input
                type="text"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                className="w-full px-3 py-2 min-h-[40px] sm:min-h-0 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">Phone</label>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 min-h-[40px] sm:min-h-0 text-sm border border-slate-200 rounded-lg font-mono-num"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-[11px] font-medium text-slate-700 mb-1">Shop Address</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full px-3 py-2 min-h-[40px] sm:min-h-0 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                Expiry Alert (Days)
              </label>
              <input
                type="number"
                min={1}
                max={365}
                value={expiryAlertDays}
                onChange={(e) => setExpiryAlertDays(e.target.value)}
                className="w-full px-3 py-2 min-h-[40px] sm:min-h-0 text-sm border border-slate-200 rounded-lg font-mono-num"
              />
            </div>

            <div className="flex items-end pb-1">
              <label className="inline-flex items-center gap-2 text-xs sm:text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoBackupEnabled}
                  onChange={(e) => setAutoBackupEnabled(e.target.checked)}
                  className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                <span>Auto Daily Backup</span>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2.5 border-t border-slate-100 text-xs">
            <div>
              <span className="text-slate-500 block">Currency</span>
              <span className="font-semibold text-slate-900">PKR</span>
            </div>
            <div>
              <span className="text-slate-500 block">Timezone</span>
              <span className="font-semibold text-slate-900">Asia/Karachi</span>
            </div>
            <div>
              <span className="text-slate-500 block">Date Format</span>
              <span className="font-semibold font-mono-num text-slate-900">DD-MM-YYYY</span>
            </div>
            <div>
              <span className="text-slate-500 block">Language</span>
              <span className="font-semibold text-slate-900">English</span>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 min-h-[40px] sm:min-h-[36px] text-xs sm:text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg disabled:opacity-50 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </form>
      </CompactSection>

      {/* Consolidated Google Sheets Integration Card */}
      {sheetsSync && (() => {
        const isActive = Boolean(
          sheetsSync.sheetsAuthorized && sheetsSync.integration?.spreadsheetId
        );
        const hasSyncFailure = Boolean(
          sheetsSync.consecutiveFailures >= 3 ||
            sheetsSync.failedCount > 0 ||
            (sheetsSync.integration?.lastSyncStatus === 'error' && Boolean(sheetsSync.lastError))
        );

        return (
          <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
              <div className="flex items-start gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-teal-50 border border-teal-200 text-teal-700 flex items-center justify-center shrink-0">
                  <FileSpreadsheet className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm sm:text-base font-semibold text-slate-900">
                    Google Sheets Integration
                  </h2>
                  <p className="text-[11px] sm:text-xs text-slate-500">
                    Automatic secondary backup across 14 structured tabs.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setSheetsActionFeedback(null);
                  setServiceAccountFeedback(null);
                  setShowResolveModal(true);
                }}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[38px] text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg transition-colors cursor-pointer shrink-0"
              >
                <Wrench className="w-3.5 h-3.5 text-teal-700" />
                Resolve / Manage
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div className="p-2.5 sm:p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500">Sync Status</span>
                <span
                  className={`inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold ${
                    sheetsSync.isSyncing
                      ? 'text-teal-700'
                      : isActive
                      ? 'text-emerald-700'
                      : 'text-slate-600'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      sheetsSync.isSyncing
                        ? 'bg-teal-600 animate-pulse'
                        : isActive
                        ? 'bg-emerald-600'
                        : 'bg-slate-400'
                    }`}
                  />
                  {sheetsSync.isSyncing ? 'Syncing...' : isActive ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="p-2.5 sm:p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500">Last Sync</span>
                <span className="text-xs sm:text-sm font-semibold font-mono-num tabular-nums text-slate-900">
                  {formatLastSync(sheetsSync.integration?.lastSyncAt)}
                </span>
              </div>
            </div>

            {hasSyncFailure && (
              <div
                role="alert"
                className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900 flex items-start justify-between gap-2.5"
              >
                <div className="flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <div className="font-semibold text-xs sm:text-sm text-red-900">Sync Failed</div>
                    <p className="leading-relaxed text-red-800">
                      {sheetsSync.lastError ||
                        'Google Sheets synchronization failed. Click "Resolve / Manage" to review setup instructions.'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </section>
        );
      })()}

      {/* Admin Troubleshooting Guide & Integration Management Modal */}
      {showResolveModal && sheetsSync && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sheets-resolve-title"
        >
          <div className="w-full max-w-2xl max-h-[92vh] overflow-y-auto bg-white border border-slate-200 rounded-t-2xl sm:rounded-xl p-4 sm:p-5 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
              <div>
                <h3 id="sheets-resolve-title" className="text-base font-semibold text-slate-900">
                  Google Sheets Integration — Admin Troubleshooting Guide
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Configure Google Service Account credentials via AI Studio Secrets or link a shared spreadsheet.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowResolveModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {sheetsActionFeedback && (
              <div
                className={`p-3 rounded-lg text-xs sm:text-sm border flex items-start gap-2 ${
                  sheetsActionFeedback.tone === 'success'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >
                {sheetsActionFeedback.tone === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                )}
                <span>{sheetsActionFeedback.message}</span>
              </div>
            )}

            {/* Step-by-Step AI Studio Secrets Guide */}
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3 text-xs text-slate-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-sm text-slate-900">
                  How to Activate Sync (AI Studio Secrets)
                </span>
                <button
                  type="button"
                  disabled={checkingServerConfig}
                  onClick={() => void handleRefreshServerCapabilities()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 font-semibold rounded-lg text-xs cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${checkingServerConfig ? 'animate-spin' : ''}`} />
                  Re-check Server Secrets
                </button>
              </div>

              <ol className="list-decimal pl-4 space-y-2 leading-relaxed">
                <li>
                  In Google Cloud Console, enable the <span className="font-semibold">Google Sheets API</span> and create a{' '}
                  <span className="font-semibold">Service Account</span> JSON key (IAM &amp; Admin → Service Accounts → Keys → Create JSON Key).
                </li>
                <li>
                  Open <span className="font-semibold">AI Studio → Settings → Secrets</span> and add:
                  <ul className="list-disc pl-4 mt-1 space-y-1">
                    <li>
                      <code className="px-1.5 py-0.5 bg-white border border-slate-200 rounded font-mono-num text-slate-900">
                        GOOGLE_SERVICE_ACCOUNT_JSON
                      </code>{' '}
                      — paste the entire JSON key contents.
                    </li>
                    <li>
                      <code className="px-1.5 py-0.5 bg-white border border-slate-200 rounded font-mono-num text-slate-900">
                        GOOGLE_SPREADSHEET_ID
                      </code>{' '}
                      — (recommended) paste the ID from your Google Sheet URL.
                    </li>
                  </ul>
                </li>
                <li>
                  Open your target Google Spreadsheet in Google Drive and share it as{' '}
                  <span className="font-semibold">Editor</span> with your Service Account&apos;s{' '}
                  <code className="px-1 py-0.5 bg-white border border-slate-200 rounded font-mono-num">
                    client_email
                  </code>
                  .
                </li>
              </ol>

              {sheetsSync.serviceAccountConfigured && sheetsSync.serviceAccountEmail && (
                <div className="pt-2 border-t border-slate-200 space-y-1.5">
                  <div className="flex items-center gap-1.5 font-semibold text-emerald-800">
                    <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                    Service Account Active ({sheetsSync.serviceAccountSource === 'vault' ? 'Server Vault' : 'AI Studio Secret'})
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="px-2.5 py-1 bg-white border border-slate-200 rounded text-xs font-mono-num text-slate-800 select-all">
                      {sheetsSync.serviceAccountEmail}
                    </code>
                    <button
                      type="button"
                      onClick={() => void handleCopyServiceEmail()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 font-semibold rounded text-xs cursor-pointer"
                    >
                      <Copy className="w-3 h-3" />
                      {copiedServiceEmail ? 'Copied' : 'Copy Email'}
                    </button>
                  </div>
                </div>
              )}

              {sheetsSync.serviceAccountStatus === 'invalid_format' && sheetsSync.serviceAccountDiagnostic && (
                <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-800">
                  {sheetsSync.serviceAccountDiagnostic}
                </div>
              )}
            </div>

            {/* Link Spreadsheet & Sync Controls */}
            <div className="p-4 bg-white border border-slate-200 rounded-xl space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="link-spreadsheet-input" className="text-xs font-semibold text-slate-800">
                  Target Google Spreadsheet URL or ID
                </label>
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sheetsSync.integration?.autoSyncEnabled ?? true}
                    onChange={(e) => void sheetsSync.setAutoSyncEnabled(e.target.checked)}
                    className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  <span>Automatic Background Sync</span>
                </label>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  id="link-spreadsheet-input"
                  type="text"
                  value={spreadsheetInput}
                  onChange={(e) => setSpreadsheetInput(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/... or Spreadsheet ID"
                  className="flex-1 px-3 py-2 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-teal-600 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={!spreadsheetInput.trim() || sheetsActionBusy || sheetsSync.isSyncing}
                  onClick={() => setConfirmAction('link_sheet')}
                  className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 rounded-lg cursor-pointer shrink-0"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  Link &amp; Sync
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                {sheetsSync.serviceAccountConfigured && !sheetsSync.integration?.spreadsheetId && (
                  <button
                    type="button"
                    disabled={sheetsActionBusy || sheetsSync.isSyncing}
                    onClick={() => void handleConnectSheets()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    Initialize Business Spreadsheet
                  </button>
                )}

                {sheetsSync.integration?.spreadsheetId && (
                  <button
                    type="button"
                    disabled={sheetsActionBusy || sheetsSync.isSyncing || !sheetsSync.sheetsAuthorized}
                    onClick={() => setConfirmAction('full_sync')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${sheetsSync.isSyncing ? 'animate-spin' : ''}`} />
                    Sync Now
                  </button>
                )}

                {(sheetsSync.pendingCount > 0 || sheetsSync.failedCount > 0) && (
                  <button
                    type="button"
                    disabled={sheetsActionBusy || sheetsSync.isSyncing || !sheetsSync.sheetsAuthorized}
                    onClick={() => setConfirmAction('retry_failed')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry Failed Sync
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleExportAllTabsWorkbook()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export 14-Tab Excel (.xlsx)
                </button>

                {sheetsSync.integration?.spreadsheetUrl && (
                  <a
                    href={sheetsSync.integration.spreadsheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-teal-700 hover:text-teal-800"
                  >
                    Open Sheet
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </div>

            {/* Optional Direct Service Account Key Vault (Admin-Only Fallback to Env Secrets) */}
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-900">
                  <KeyRound className="w-4 h-4 text-slate-700" />
                  <span>Direct Service Account Key Upload (Optional Vault)</span>
                </div>
                {sheetsSync.serviceAccountSource === 'vault' && (
                  <button
                    type="button"
                    disabled={removingServiceAccount || savingServiceAccount}
                    onClick={() => setConfirmAction('remove_sa')}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded-lg cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 className="w-3 h-3" />
                    Remove Vault Key
                  </button>
                )}
              </div>

              {serviceAccountFeedback && (
                <div
                  className={`p-2.5 rounded-lg text-xs border flex items-start gap-2 ${
                    serviceAccountFeedback.tone === 'success'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-red-50 border-red-200 text-red-700'
                  }`}
                >
                  {serviceAccountFeedback.tone === 'success' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  )}
                  <span>{serviceAccountFeedback.message}</span>
                </div>
              )}

              <form onSubmit={(e) => void handleSaveServiceAccount(e)} className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="service-account-json-input" className="text-[11px] font-medium text-slate-600">
                    If you cannot access AI Studio Secrets, paste or upload your Service Account JSON key here (encrypted on server).
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      ref={saFileInputRef}
                      type="file"
                      accept=".json,application/json"
                      onChange={handleServiceAccountFileUpload}
                      className="hidden"
                      aria-label="Upload Service Account JSON key file"
                    />
                    <button
                      type="button"
                      disabled={savingServiceAccount}
                      onClick={() => saFileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer"
                    >
                      <Upload className="w-3 h-3" />
                      Upload .json
                    </button>
                    <button
                      type="button"
                      onClick={() => setMaskServiceAccountInput((prev) => !prev)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer"
                    >
                      {maskServiceAccountInput ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                      {maskServiceAccountInput ? 'Show' : 'Mask'}
                    </button>
                  </div>
                </div>

                {maskServiceAccountInput ? (
                  <input
                    id="service-account-json-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={serviceAccountJsonInput}
                    onChange={(e) => setServiceAccountJsonInput(e.target.value)}
                    placeholder='Paste Service Account JSON: {"type":"service_account",...}'
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg font-mono-num focus:border-teal-500 focus:outline-none"
                  />
                ) : (
                  <textarea
                    id="service-account-json-input"
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                    value={serviceAccountJsonInput}
                    onChange={(e) => setServiceAccountJsonInput(e.target.value)}
                    placeholder='{"type":"service_account","project_id":...}'
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg font-mono-num focus:border-teal-500 focus:outline-none"
                  />
                )}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={savingServiceAccount || !serviceAccountJsonInput.trim()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-lg cursor-pointer"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    {savingServiceAccount ? 'Verifying & Encrypting...' : 'Verify & Save Key'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Dialog for Manual Google Sheets Sync & Vault Actions */}
      {confirmAction && (
        <div
          className="fixed inset-0 z-[60] bg-slate-900/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sheets-confirm-title"
        >
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-lg">
            <h3 id="sheets-confirm-title" className="text-base font-semibold text-slate-900">
              {confirmAction === 'retry_failed'
                ? 'Confirm Retry of Queued Sync'
                : confirmAction === 'link_sheet'
                ? 'Confirm Linking Google Spreadsheet'
                : confirmAction === 'remove_sa'
                ? 'Remove Saved Google Service Account'
                : 'Confirm Full Google Sheets Synchronization'}
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              {confirmAction === 'retry_failed'
                ? 'This will push pending and failed Firebase business records into your Google Spreadsheet.'
                : confirmAction === 'link_sheet'
                ? 'This will verify access to your Google Spreadsheet, ensure all 14 required tabs exist, and synchronize all live Firebase records.'
                : confirmAction === 'remove_sa'
                ? 'This will permanently delete your encrypted Google Service Account credentials from the server vault.'
                : 'This will synchronize all 14 worksheets with your live Firebase records.'}
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmedSheetsAction()}
                className={`px-3.5 py-2 text-xs font-semibold text-white rounded-lg cursor-pointer ${
                  confirmAction === 'remove_sa'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-teal-600 hover:bg-teal-700'
                }`}
              >
                {confirmAction === 'remove_sa' ? 'Remove Credentials' : 'Confirm & Sync'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Catalog & Reference Managers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Product Categories */}
        <CompactSection
          title="Product Categories"
          summary={`${categories.length} items`}
          collapsible
          defaultOpen={false}
          bodyClassName="p-3.5 sm:p-4 space-y-2.5"
        >
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="New category..."
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="flex-1 min-w-0 px-3 py-1.5 min-h-[38px] sm:min-h-0 text-sm border border-slate-200 rounded-lg"
            />
            <button
              type="button"
              onClick={async () => {
                if (!activeShopId || !newCategory.trim()) return;
                const val = newCategory.trim();
                await createCategory(activeShopId, val, '');
                setNewCategory('');
                showToast({ title: 'Category Added', message: `"${val}" saved.`, tone: 'success', durationMs: 3000 });
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[38px] sm:min-h-0 text-xs font-semibold text-white bg-teal-600 rounded-lg cursor-pointer shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
          <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
            {categories.map((c) => (
              <div key={c.id} className="py-1.5 flex items-center justify-between text-xs sm:text-sm">
                <span className="text-slate-800 truncate">{c.name}</span>
                <button
                  type="button"
                  onClick={async () => {
                    if (!activeShopId) return;
                    await deleteCategory(activeShopId, c.id);
                    showToast({ title: 'Category Deleted', message: `"${c.name}" removed.`, tone: 'info', durationMs: 3000 });
                  }}
                  className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </CompactSection>

        {/* Brands */}
        <CompactSection
          title="Product Brands"
          summary={`${brands.length} items`}
          collapsible
          defaultOpen={false}
          bodyClassName="p-3.5 sm:p-4 space-y-2.5"
        >
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="New brand..."
              value={newBrand}
              onChange={(e) => setNewBrand(e.target.value)}
              className="flex-1 min-w-0 px-3 py-1.5 min-h-[38px] sm:min-h-0 text-sm border border-slate-200 rounded-lg"
            />
            <button
              type="button"
              onClick={async () => {
                if (!activeShopId || !newBrand.trim()) return;
                const val = newBrand.trim();
                await createBrand(activeShopId, val);
                setNewBrand('');
                showToast({ title: 'Brand Added', message: `"${val}" saved.`, tone: 'success', durationMs: 3000 });
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[38px] sm:min-h-0 text-xs font-semibold text-white bg-teal-600 rounded-lg cursor-pointer shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
          <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
            {brands.map((b) => (
              <div key={b.id} className="py-1.5 flex items-center justify-between text-xs sm:text-sm">
                <span className="text-slate-800 truncate">{b.name}</span>
                <button
                  type="button"
                  onClick={async () => {
                    if (!activeShopId) return;
                    await deleteBrand(activeShopId, b.id);
                    showToast({ title: 'Brand Deleted', message: `"${b.name}" removed.`, tone: 'info', durationMs: 3000 });
                  }}
                  className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </CompactSection>

        {/* Suppliers */}
        <CompactSection
          title="Suppliers"
          summary={`${suppliers.length} suppliers`}
          collapsible
          defaultOpen={false}
          bodyClassName="p-3.5 sm:p-4 space-y-2.5"
        >
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_130px_auto] gap-2">
            <input
              type="text"
              placeholder="Supplier name..."
              value={newSupplierName}
              onChange={(e) => setNewSupplierName(e.target.value)}
              className="w-full px-3 py-1.5 min-h-[38px] sm:min-h-0 text-sm border border-slate-200 rounded-lg"
            />
            <input
              type="text"
              placeholder="Phone"
              value={newSupplierPhone}
              onChange={(e) => setNewSupplierPhone(e.target.value)}
              className="w-full px-3 py-1.5 min-h-[38px] sm:min-h-0 text-sm border border-slate-200 rounded-lg font-mono-num"
            />
            <button
              type="button"
              onClick={async () => {
                if (!activeShopId || !newSupplierName.trim()) return;
                const val = newSupplierName.trim();
                await createSupplier(activeShopId, {
                  name: val,
                  phone: newSupplierPhone.trim(),
                  address: '',
                  notes: '',
                });
                setNewSupplierName('');
                setNewSupplierPhone('');
                showToast({ title: 'Supplier Added', message: `"${val}" saved.`, tone: 'success', durationMs: 3000 });
              }}
              className="inline-flex items-center justify-center gap-1 px-3 py-1.5 min-h-[38px] sm:min-h-0 text-xs font-semibold text-white bg-teal-600 rounded-lg cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
          <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
            {suppliers.length === 0 ? (
              <div className="py-3 text-xs text-slate-500">No suppliers added yet.</div>
            ) : (
              suppliers.map((s) => (
                <div key={s.id} className="py-1.5 flex items-center justify-between gap-2 text-xs sm:text-sm">
                  <div className="min-w-0 truncate">
                    <span className="text-slate-800 font-medium">{s.name}</span>
                    {s.phone && <span className="ml-2 text-xs text-slate-500 font-mono-num">{s.phone}</span>}
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!activeShopId) return;
                      await deleteSupplier(activeShopId, s.id);
                      showToast({ title: 'Supplier Deleted', message: `"${s.name}" removed.`, tone: 'info', durationMs: 3000 });
                    }}
                    className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </CompactSection>

        {/* Expense Categories */}
        <CompactSection
          title="Expense Categories"
          summary={`${expenseCategories.length} items`}
          collapsible
          defaultOpen={false}
          bodyClassName="p-3.5 sm:p-4 space-y-2.5"
        >
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Custom expense category..."
              value={newExpCategory}
              onChange={(e) => setNewExpCategory(e.target.value)}
              className="flex-1 min-w-0 px-3 py-1.5 min-h-[38px] sm:min-h-0 text-sm border border-slate-200 rounded-lg"
            />
            <button
              type="button"
              onClick={async () => {
                if (!activeShopId || !newExpCategory.trim()) return;
                const val = newExpCategory.trim();
                await createExpenseCategory(activeShopId, val);
                setNewExpCategory('');
                showToast({ title: 'Expense Category Added', message: `"${val}" saved.`, tone: 'success', durationMs: 3000 });
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[38px] sm:min-h-0 text-xs font-semibold text-white bg-teal-600 rounded-lg cursor-pointer shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
          <div className="divide-y divide-slate-100 max-h-48 overflow-y-auto">
            {expenseCategories.map((ec) => (
              <div key={ec.id} className="py-1.5 flex items-center justify-between text-xs sm:text-sm">
                <span className="text-slate-800 truncate">{ec.name}</span>
                {!ec.isDefault ? (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!activeShopId) return;
                      await deleteExpenseCategory(activeShopId, ec.id);
                      showToast({ title: 'Expense Category Deleted', message: `"${ec.name}" removed.`, tone: 'info', durationMs: 3000 });
                    }}
                    className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <span className="text-xs text-slate-400">Default</span>
                )}
              </div>
            ))}
          </div>
        </CompactSection>
      </div>

      {/* Backups & Audit Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CompactSection
          title="Data Backups"
          subtitle={`Last: ${settings?.lastBackupAt ? formatDateDDMMYYYY(settings.lastBackupAt) : 'Not recorded'}`}
          summary={`${backups.length} snapshots`}
          collapsible
          defaultOpen={false}
          actions={
            <button
              type="button"
              onClick={() => void handleManualBackupExport()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Export JSON
            </button>
          }
          bodyClassName="p-3.5 sm:p-4"
        >
          <div className="divide-y divide-slate-100 max-h-52 overflow-y-auto">
            {backups.length === 0 ? (
              <div className="py-3 text-xs text-slate-500">No backup snapshots recorded yet.</div>
            ) : (
              backups.slice(0, 15).map((b) => (
                <div key={b.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0 truncate">
                    <span className="font-semibold capitalize text-slate-800">{b.backupType}</span>
                    <span className="text-slate-500"> · {b.notes}</span>
                  </div>
                  <span className="font-mono-num text-slate-500 whitespace-nowrap shrink-0">
                    {formatDateTimeKarachi(b.createdAt)}
                  </span>
                </div>
              ))
            )}
          </div>
        </CompactSection>

        <CompactSection
          title="Audit Logs"
          subtitle="Recent transaction & catalog changes"
          summary={`${Math.min(auditLogs.length, 30)} recent`}
          collapsible
          defaultOpen={false}
          bodyClassName="p-3.5 sm:p-4"
        >
          <div className="divide-y divide-slate-100 max-h-52 overflow-y-auto">
            {auditLogs.length === 0 ? (
              <div className="py-3 text-xs text-slate-500">No audit entries yet.</div>
            ) : (
              auditLogs.slice(0, 30).map((log) => (
                <div key={log.id} className="py-2 space-y-0.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800 truncate">{log.action}</span>
                    <span className="font-mono-num text-slate-400 whitespace-nowrap shrink-0">
                      {formatDateTimeKarachi(log.createdAt)}
                    </span>
                  </div>
                  <div className="text-slate-600">{log.summary}</div>
                </div>
              ))
            )}
          </div>
        </CompactSection>
      </div>
    </div>
  );
}
