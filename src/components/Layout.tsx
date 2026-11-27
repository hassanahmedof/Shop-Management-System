import {
  Activity,
  AlertTriangle,
  BarChart3,
  Boxes,
  CheckCircle2,
  ClipboardEdit,
  FileSpreadsheet,
  Globe,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Package,
  Plus,
  PlusCircle,
  Receipt,
  RefreshCw,
  Settings,
  ShoppingBag,
  Store,
  Sun,
  Truck,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useOfflineSync } from '../contexts/OfflineSyncContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useTheme } from '../contexts/ThemeContext';
import type { NavSection, StaffPortalSection } from '../types/shop';
import { formatDateDDMMYYYY, getKarachiDateIso } from '../utils/formatters';
import { QuickActionFab } from './QuickActionFab';

interface LayoutProps {
  activeSection: NavSection | StaffPortalSection;
  onNavigate: (section: NavSection | StaffPortalSection) => void;
  children: ReactNode;
}

const OWNER_NAV_ITEMS: Array<{
  id: NavSection;
  label: string;
  group: 'Operations' | 'Inventory & Finance' | 'Insights & Admin';
  icon: typeof LayoutDashboard;
}> = [
  { id: 'dashboard', label: 'Dashboard', group: 'Operations', icon: LayoutDashboard },
  { id: 'sales', label: 'Sales', group: 'Operations', icon: ShoppingBag },
  { id: 'website_orders', label: 'Website Orders', group: 'Operations', icon: Globe },
  { id: 'purchases', label: 'Purchases', group: 'Operations', icon: Truck },
  { id: 'products', label: 'Products', group: 'Inventory & Finance', icon: Package },
  { id: 'inventory', label: 'Inventory', group: 'Inventory & Finance', icon: Boxes },
  { id: 'adjustments', label: 'Stock Adjustments', group: 'Inventory & Finance', icon: ClipboardEdit },
  { id: 'expenses', label: 'Expenses', group: 'Inventory & Finance', icon: Receipt },
  { id: 'analytics', label: 'Analytics', group: 'Insights & Admin', icon: BarChart3 },
  { id: 'reports', label: 'Reports', group: 'Insights & Admin', icon: FileSpreadsheet },
  { id: 'staff', label: 'Staff & Admins', group: 'Insights & Admin', icon: Users },
  { id: 'activity', label: 'Activity Logs', group: 'Insights & Admin', icon: Activity },
  { id: 'settings', label: 'Settings', group: 'Insights & Admin', icon: Settings },
];

const OWNER_GROUPS: Array<'Operations' | 'Inventory & Finance' | 'Insights & Admin'> = [
  'Operations',
  'Inventory & Finance',
  'Insights & Admin',
];

export function Layout({ activeSection, onNavigate, children }: LayoutProps) {
  const { user, sessionRole, staffProfile, logout } = useAuth();
  const { settings, adminMembers, websiteOrders } = useShopData();
  const { isDark, toggleTheme } = useTheme();
  const {
    isOnline,
    pendingCount,
    failedCount,
    isSyncing,
    lastSyncNotice,
    clearSyncNotice,
    syncNow,
  } = useOfflineSync();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = useMemo(() => {
    if (sessionRole === 'sales_staff') {
      const items: Array<{ id: StaffPortalSection; label: string; group?: string; icon: typeof LayoutDashboard }> = [
        { id: 'dashboard', label: 'My Dashboard', icon: LayoutDashboard },
      ];
      if (staffProfile?.permissions?.canViewStock) {
        items.push({ id: 'stock', label: 'Products & Stock', icon: Package });
      }
      if (staffProfile?.permissions?.canAddSales) {
        items.push({ id: 'new_sale', label: 'New Sale', icon: PlusCircle });
      }
      if (staffProfile?.permissions?.canViewOwnSales) {
        items.push({ id: 'my_sales', label: 'My Sales', icon: History });
      }
      if (staffProfile?.permissions?.canAddSales) {
        items.push({ id: 'website_orders', label: 'Website Orders', icon: Globe });
      }
      return items;
    }
    if (sessionRole === 'owner') {
      return OWNER_NAV_ITEMS;
    }
    return [];
  }, [sessionRole, staffProfile]);

  const pendingWebsiteOrders = useMemo(
    () => websiteOrders.filter((o) => o.status === 'Pending Confirmation').length,
    [websiteOrders]
  );

  const shopTitle =
    sessionRole === 'sales_staff'
      ? 'CareMart Staff Portal'
      : settings?.shopName || 'CareMart Shop Manager';
  const todayDisplay = formatDateDDMMYYYY(getKarachiDateIso());
  const activeItem = navItems.find((n) => n.id === activeSection) || navItems[0];

  const handleNav = (id: NavSection | StaffPortalSection) => {
    onNavigate(id);
    setMobileOpen(false);
  };

  const renderBrandLockup = () => (
    <div className="flex items-center gap-2.5 min-w-0">
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border border-[var(--cm-accent-border)] shadow-xs"
        style={{
          background: 'linear-gradient(135deg, var(--cm-lime) 0%, var(--cm-accent) 100%)',
        }}
      >
        <Store className="w-4 h-4 text-white" />
      </div>
      <div className="min-w-0">
        <div className="text-sm sm:text-base font-bold text-[var(--cm-text-primary)] truncate font-display leading-tight">
          {shopTitle}
        </div>
        <div className="text-[11px] text-[var(--cm-text-muted)] truncate">
          {sessionRole === 'sales_staff' ? 'Sales Counter' : 'Retail POS & Inventory'}
        </div>
      </div>
    </div>
  );

  const renderFooterIdentity = () => {
    if (sessionRole === 'sales_staff' && staffProfile) {
      return (
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-[var(--cm-text-primary)] truncate">{staffProfile.name}</div>
          <div className="text-xs text-[var(--cm-text-muted)] truncate">Sales Staff · @{staffProfile.username}</div>
        </div>
      );
    }
    const matchedAdmin = user
      ? adminMembers.find((m) => m.authUid === user.uid)
      : undefined;
    if (matchedAdmin) {
      return (
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-[var(--cm-text-primary)] truncate">{matchedAdmin.name}</div>
          <div className="text-xs text-[var(--cm-text-muted)] truncate">Admin · @{matchedAdmin.username}</div>
        </div>
      );
    }
    return <div className="text-xs text-[var(--cm-text-muted)] truncate">{user?.email}</div>;
  };

  const renderNavButton = (item: { id: NavSection | StaffPortalSection; label: string; icon: typeof LayoutDashboard }) => {
    const Icon = item.icon;
    const isActive = activeSection === item.id;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => handleNav(item.id)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-xl transition-colors whitespace-nowrap cursor-pointer border ${
          isActive
            ? 'bg-[var(--cm-accent-soft)] text-[var(--cm-accent-text)] border-[var(--cm-accent-border)] font-semibold'
            : 'border-transparent text-[var(--cm-text-secondary)] hover:bg-[var(--cm-bg-hover)] hover:text-[var(--cm-text-primary)]'
        }`}
      >
        <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-[var(--cm-accent-text)]' : 'text-[var(--cm-text-muted)]'}`} />
        <span className="truncate">{item.label}</span>
        {item.id === 'website_orders' && pendingWebsiteOrders > 0 && (
          <span className="ml-auto px-1.5 py-0.5 text-[11px] font-mono-num font-bold rounded-md bg-[var(--cm-warning-soft)] text-[var(--cm-warning)] border border-[var(--cm-warning-border)]">
            {pendingWebsiteOrders}
          </span>
        )}
      </button>
    );
  };

  const renderNavLinks = () => {
    if (sessionRole === 'owner') {
      return (
        <nav className="flex-1 px-3 py-3 space-y-4 overflow-y-auto" aria-label="Main navigation">
          {OWNER_GROUPS.map((group) => {
            const groupItems = OWNER_NAV_ITEMS.filter((i) => i.group === group);
            return (
              <div key={group} className="space-y-1">
                <div className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-[var(--cm-text-muted)]">
                  {group}
                </div>
                {groupItems.map((item) => renderNavButton(item))}
              </div>
            );
          })}
        </nav>
      );
    }

    return (
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Staff navigation">
        {navItems.map((item) => renderNavButton(item))}
      </nav>
    );
  };

  const showOfflineBanner =
    !isOnline || (sessionRole === 'sales_staff' && (pendingCount > 0 || isSyncing));

  const showHeaderNewSale =
    (sessionRole === 'owner' && activeSection !== 'sales') ||
    (sessionRole === 'sales_staff' &&
      Boolean(staffProfile?.permissions?.canAddSales) &&
      activeSection !== 'new_sale');

  return (
    <div className="min-h-screen bg-[var(--cm-bg-app)] text-[var(--cm-text-primary)] flex overflow-x-clip">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-[var(--cm-bg-sidebar)] border-r border-[var(--cm-border)] z-20">
        <div className="h-16 px-4 flex items-center border-b border-[var(--cm-border)]">
          {renderBrandLockup()}
        </div>
        {renderNavLinks()}
        <div className="p-3.5 border-t border-[var(--cm-border)] space-y-2.5">
          {renderFooterIdentity()}
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--cm-text-secondary)] hover:text-[var(--cm-danger)] hover:bg-[var(--cm-danger-soft)] rounded-xl transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5 shrink-0" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-[var(--cm-bg-overlay)]"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative w-68 max-w-[82vw] bg-[var(--cm-bg-sidebar)] h-full flex flex-col border-r border-[var(--cm-border)] z-50">
            <div className="h-14 px-4 flex items-center justify-between gap-2 border-b border-[var(--cm-border)]">
              {renderBrandLockup()}
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="p-2 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] rounded-lg cursor-pointer shrink-0"
                aria-label="Close navigation"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {renderNavLinks()}
            <div className="p-3.5 border-t border-[var(--cm-border)] space-y-2">
              {renderFooterIdentity()}
              <button
                type="button"
                onClick={() => void logout()}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--cm-text-secondary)] hover:text-[var(--cm-danger)] hover:bg-[var(--cm-danger-soft)] rounded-xl transition-colors cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0 overflow-x-clip">
        <header className="sticky top-0 z-10 h-14 sm:h-16 bg-[var(--cm-bg-surface)]/95 backdrop-blur-xs border-b border-[var(--cm-border)] px-3 sm:px-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 -ml-1.5 text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)] hover:bg-[var(--cm-bg-subtle)] rounded-lg cursor-pointer"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-base sm:text-lg font-bold text-[var(--cm-text-primary)] truncate font-display tracking-tight">
              {activeItem?.label || shopTitle}
            </h1>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="hidden md:flex items-center gap-2 text-xs text-[var(--cm-text-muted)] whitespace-nowrap">
              <span className="font-mono-num">{todayDisplay}</span>
              <span aria-hidden="true">·</span>
              <span>PKR</span>
            </div>

            <button
              type="button"
              onClick={toggleTheme}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              className="w-9 h-9 inline-flex items-center justify-center rounded-xl border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] hover:bg-[var(--cm-bg-hover)] text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)] transition-colors cursor-pointer shrink-0"
            >
              {isDark ? (
                <Sun className="w-4 h-4 text-[var(--cm-yellow-text)]" />
              ) : (
                <Moon className="w-4 h-4 text-[var(--cm-accent-text)]" />
              )}
            </button>

            {showHeaderNewSale && (
              <button
                type="button"
                onClick={() => onNavigate(sessionRole === 'sales_staff' ? 'new_sale' : 'sales')}
                className="inline-flex items-center gap-1.5 px-3 sm:px-3.5 py-2 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span>New Sale</span>
              </button>
            )}
          </div>
        </header>

        <main className={`flex-1 p-3 sm:p-5 max-w-[1440px] w-full mx-auto space-y-4 ${sessionRole === 'owner' ? 'pb-20 sm:pb-24' : ''}`}>
          {showOfflineBanner && (
            <div
              role="status"
              className={`rounded-xl border px-3 py-2 sm:px-4 sm:py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 ${
                !isOnline
                  ? 'bg-[var(--cm-warning-soft)] border-[var(--cm-warning-border)] text-[var(--cm-warning)]'
                  : failedCount > 0
                    ? 'bg-[var(--cm-danger-soft)] border-[var(--cm-danger-border)] text-[var(--cm-danger)]'
                    : 'bg-[var(--cm-accent-soft)] border-[var(--cm-accent-border)] text-[var(--cm-accent-text)]'
              }`}
            >
              <div className="flex items-start sm:items-center gap-2.5 text-sm">
                {!isOnline ? (
                  <WifiOff className="w-4 h-4 text-[var(--cm-warning)] shrink-0 mt-0.5 sm:mt-0" />
                ) : failedCount > 0 ? (
                  <AlertTriangle className="w-4 h-4 text-[var(--cm-danger)] shrink-0 mt-0.5 sm:mt-0" />
                ) : (
                  <RefreshCw className={`w-4 h-4 text-[var(--cm-accent-text)] shrink-0 mt-0.5 sm:mt-0 ${isSyncing ? 'animate-spin' : ''}`} />
                )}
                <div>
                  {!isOnline ? (
                    <span>
                      <strong className="font-semibold">Offline Mode</strong>
                      {sessionRole === 'sales_staff' ? (
                        <>
                          {' '}· You can keep recording sales and checking cached stock.
                          {pendingCount > 0 && (
                            <span className="font-mono-num font-semibold">
                              {' '}({pendingCount} pending sync)
                            </span>
                          )}
                        </>
                      ) : (
                        ' · Reconnect to sync latest updates with the shop server.'
                      )}
                    </span>
                  ) : isSyncing ? (
                    <span>
                      <strong className="font-semibold">Syncing offline sales...</strong>{' '}
                      <span className="font-mono-num">({pendingCount} remaining)</span>
                    </span>
                  ) : failedCount > 0 ? (
                    <span>
                      <strong className="font-semibold font-mono-num">{failedCount}</strong>{' '}
                      queued {failedCount === 1 ? 'sale needs' : 'sales need'} attention in My Sales.
                    </span>
                  ) : (
                    <span>
                      <strong className="font-semibold font-mono-num">{pendingCount}</strong>{' '}
                      offline {pendingCount === 1 ? 'sale' : 'sales'} waiting to sync.
                    </span>
                  )}
                </div>
              </div>

              {sessionRole === 'sales_staff' && isOnline && pendingCount > 0 && (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={isSyncing}
                    onClick={() => void syncNow(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span>{isSyncing ? 'Syncing...' : 'Sync Now'}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {sessionRole === 'sales_staff' && lastSyncNotice && (
            <div
              role="status"
              className="rounded-xl border border-[var(--cm-success-border)] bg-[var(--cm-success-soft)] px-4 py-2.5 flex items-center justify-between gap-3 text-sm text-[var(--cm-success)]"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{lastSyncNotice}</span>
              </div>
              <button
                type="button"
                onClick={clearSyncNotice}
                className="p-1 opacity-80 hover:opacity-100 rounded cursor-pointer"
                aria-label="Dismiss sync notification"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {children}
        </main>
      </div>

      {sessionRole === 'owner' && (
        <QuickActionFab
          activeSection={activeSection as NavSection}
          onNavigate={(section) => onNavigate(section)}
        />
      )}
    </div>
  );
}
