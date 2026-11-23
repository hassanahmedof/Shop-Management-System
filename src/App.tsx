import { useEffect, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { LoginScreen } from './components/LoginScreen';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { GoogleSheetsSyncProvider } from './contexts/GoogleSheetsSyncContext';
import { OfflineSyncProvider } from './contexts/OfflineSyncContext';
import { ShopDataProvider, useShopData } from './contexts/ShopDataContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { ActivityLogsPage } from './pages/ActivityLogsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { DashboardPage } from './pages/DashboardPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { InventoryPage } from './pages/InventoryPage';
import { ProductsPage } from './pages/ProductsPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { ReportsPage } from './pages/ReportsPage';
import { SalesPage } from './pages/SalesPage';
import { SettingsPage } from './pages/SettingsPage';
import { StaffManagementPage } from './pages/StaffManagementPage';
import { StaffPortalView } from './pages/StaffPortalView';
import { StockAdjustmentsPage } from './pages/StockAdjustmentsPage';
import { initializeDiscordQueueWorker } from './services/discordNotificationService';
import type { NavSection, StaffPortalSection } from './types/shop';

const RESTRICTED_STAFF_PREFIXES = [
  '/admin',
  '/staff',
  '/products',
  '/inventory',
  '/purchases',
  '/expenses',
  '/adjustments',
  '/analytics',
  '/reports',
  '/activity',
  '/settings',
];

function isRestrictedPathForStaff(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return RESTRICTED_STAFF_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}/`)
  );
}

function OwnerLowStockLoginNotifier({ onNavigate }: { onNavigate: (section: NavSection) => void }) {
  const { user, sessionRole, shopReady } = useAuth();
  const { products, loading } = useShopData();
  const { showToast, clearToasts } = useToast();

  useEffect(() => {
    if (!user || sessionRole !== 'owner') {
      clearToasts();
      return;
    }
    if (!shopReady || loading) return;

    const sessionKey = `cm_low_stock_notified_${user.uid}`;
    try {
      if (sessionStorage.getItem(sessionKey) === '1') {
        return;
      }
      sessionStorage.setItem(sessionKey, '1');
    } catch {
      // Proceed if sessionStorage is unavailable
    }

    const activeProducts = products.filter((p) => p.isActive !== false);
    const outOfStockCount = activeProducts.filter((p) => p.currentStock <= 0).length;
    const lowStockCount = activeProducts.filter(
      (p) => p.currentStock > 0 && p.currentStock <= p.minStockLevel
    ).length;
    const totalAlerts = outOfStockCount + lowStockCount;

    if (totalAlerts <= 0) return;

    const summaryParts: string[] = [];
    if (outOfStockCount > 0) {
      summaryParts.push(`${outOfStockCount} out of stock`);
    }
    if (lowStockCount > 0) {
      summaryParts.push(`${lowStockCount} at or below min stock level`);
    }

    showToast({
      id: `low-stock-login-${user.uid}`,
      title: 'Low Stock Alert',
      tone: outOfStockCount > 0 ? 'error' : 'warning',
      message: `${totalAlerts} ${totalAlerts === 1 ? 'product requires' : 'products require'} immediate inventory review (${summaryParts.join(', ')}).`,
      actionLabel: 'Review Inventory',
      onAction: () => onNavigate('inventory'),
      durationMs: 15000,
    });
  }, [user, sessionRole, shopReady, loading, products, showToast, clearToasts, onNavigate]);

  useEffect(() => {
    return () => {
      clearToasts();
    };
  }, [clearToasts]);

  return null;
}

function MainApp() {
  const { user, sessionRole, loading, initializingShop, shopReady, authError, retryInitialization, logout } = useAuth();
  const [activeSection, setActiveSection] = useState<NavSection>('dashboard');
  const [staffSection, setStaffSection] = useState<StaffPortalSection>('dashboard');
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!user) return;
    return initializeDiscordQueueWorker();
  }, [user]);

  if (loading || initializingShop) {
    return (
      <div className="min-h-screen bg-[var(--cm-bg-app)] flex items-center justify-center p-6">
        <div className="text-sm text-[var(--cm-text-secondary)] font-medium">Loading shop workspace...</div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  if (!shopReady) {
    return (
      <div className="min-h-screen bg-[var(--cm-bg-app)] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-[var(--cm-text-primary)]">Unable to open shop workspace</h2>
          <p className="text-sm text-[var(--cm-text-secondary)] break-words">
            {authError || 'Please retry initializing your shop database.'}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void retryInitialization()}
              className="px-4 py-2 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => void logout()}
              className="px-4 py-2 text-sm font-medium text-[var(--cm-text-secondary)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-subtle)] rounded-lg cursor-pointer"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Strict Role-Based Portal Routing: Sales Staff can ONLY render StaffPortalView and are blocked from Admin URLs
  if (sessionRole === 'sales_staff') {
    if (isRestrictedPathForStaff(currentPath)) {
      return (
        <div className="min-h-screen bg-[var(--cm-bg-app)] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] rounded-xl p-6 space-y-4">
            <h2 className="text-base font-semibold text-[var(--cm-danger)]">Access Denied</h2>
            <p className="text-sm text-[var(--cm-text-secondary)]">
              Sales Staff accounts are not authorized to access Owner/Admin pages, business analytics, or system settings.
            </p>
            <button
              type="button"
              onClick={() => {
                window.history.replaceState(null, '', '/');
                setCurrentPath('/');
              }}
              className="px-4 py-2 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer"
            >
              Return to Sales Staff Portal
            </button>
          </div>
        </div>
      );
    }

    return (
      <ShopDataProvider>
        <OfflineSyncProvider>
          <Layout
            activeSection={staffSection}
            onNavigate={(s) => setStaffSection(s as StaffPortalSection)}
          >
            <StaffPortalView activeSection={staffSection} onNavigate={setStaffSection} />
          </Layout>
        </OfflineSyncProvider>
      </ShopDataProvider>
    );
  }

  if (sessionRole !== 'owner') {
    return (
      <div className="min-h-screen bg-[var(--cm-bg-app)] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-[var(--cm-danger)]">Access Denied</h2>
          <p className="text-sm text-[var(--cm-text-secondary)] break-words">
            {authError ||
              'Access Denied. This account is not authorized to access the Owner/Admin panel.'}
          </p>
          <button
            type="button"
            onClick={() => void logout()}
            className="px-4 py-2 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  const renderOwnerPage = () => {
    switch (activeSection) {
      case 'dashboard':
        return <DashboardPage onNavigate={setActiveSection} />;
      case 'sales':
        return <SalesPage />;
      case 'staff':
        return <StaffManagementPage />;
      case 'products':
        return <ProductsPage onOpenCatalogSettings={() => setActiveSection('settings')} />;
      case 'inventory':
        return <InventoryPage />;
      case 'purchases':
        return <PurchasesPage />;
      case 'expenses':
        return <ExpensesPage />;
      case 'adjustments':
        return <StockAdjustmentsPage />;
      case 'analytics':
        return <AnalyticsPage />;
      case 'reports':
        return <ReportsPage />;
      case 'activity':
        return <ActivityLogsPage />;
      case 'settings':
        return <SettingsPage />;
    }
  };

  return (
    <ShopDataProvider>
      <OfflineSyncProvider>
        <GoogleSheetsSyncProvider onNavigateToSettings={() => setActiveSection('settings')}>
          <OwnerLowStockLoginNotifier onNavigate={setActiveSection} />
          <Layout
            activeSection={activeSection}
            onNavigate={(s) => setActiveSection(s as NavSection)}
          >
            {renderOwnerPage()}
          </Layout>
        </GoogleSheetsSyncProvider>
      </OfflineSyncProvider>
    </ShopDataProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <MainApp />
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
