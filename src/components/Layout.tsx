import {
  Activity,
  AlertTriangle,
  BarChart3,
  Boxes,
  CheckCircle2,
  ClipboardEdit,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  PlusCircle,
  Receipt,
  RefreshCw,
  Settings,
  ShoppingBag,
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
import type { NavSection, StaffPortalSection } from '../types/shop';
import { formatDateDDMMYYYY, getKarachiDateIso } from '../utils/formatters';
import { QuickActionFab } from './QuickActionFab';

interface LayoutProps {
  activeSection: NavSection | StaffPortalSection;
  onNavigate: (section: NavSection | StaffPortalSection) => void;
  children: ReactNode;
}

const OWNER_NAV_ITEMS: Array<{ id: NavSection; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
  { id: 'sales', label: 'Sales', icon: ShoppingBag },
  { id: 'purchases', label: 'Purchases', icon: Truck },
  { id: 'adjustments', label: 'Stock Adjustments', icon: ClipboardEdit },
  { id: 'expenses', label: 'Expenses', icon: Receipt },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'reports', label: 'Reports', icon: FileSpreadsheet },
  { id: 'staff', label: 'Staff & Admins', icon: Users },
  { id: 'activity', label: 'Activity Logs', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export function Layout({ activeSection, onNavigate, children }: LayoutProps) {
  const { user, sessionRole, staffProfile, logout } = useAuth();
  const { settings, adminMembers } = useShopData();
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
      const items: Array<{ id: StaffPortalSection; label: string; icon: typeof LayoutDashboard }> = [
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
      return items;
    }
    if (sessionRole === 'owner') {
      return OWNER_NAV_ITEMS;
    }
    return [];
  }, [sessionRole, staffProfile]);

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

  const renderFooterIdentity = () => {
    if (sessionRole === 'sales_staff' && staffProfile) {
      return (
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-slate-800 truncate">{staffProfile.name}</div>
          <div className="text-xs text-slate-500 truncate">Sales Staff · @{staffProfile.username}</div>
        </div>
      );
    }
    const matchedAdmin = user
      ? adminMembers.find((m) => m.authUid === user.uid)
      : undefined;
    if (matchedAdmin) {
      return (
        <div className="space-y-0.5">
          <div className="text-xs font-semibold text-slate-800 truncate">{matchedAdmin.name}</div>
          <div className="text-xs text-slate-500 truncate">Admin · @{matchedAdmin.username}</div>
        </div>
      );
    }
    return <div className="text-xs text-slate-500 truncate">{user?.email}</div>;
  };

  const renderNavLinks = () => (
    <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeSection === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => handleNav(item.id)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
              isActive
                ? 'bg-teal-50 text-teal-700'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-teal-600' : 'text-slate-400'}`} />
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );

  const showOfflineBanner =
    !isOnline || (sessionRole === 'sales_staff' && (pendingCount > 0 || isSyncing));

  return (
    <div className="min-h-screen bg-slate-50 flex overflow-x-clip">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-white border-r border-slate-200 z-20">
        <div className="h-14 sm:h-16 px-5 flex items-center border-b border-slate-200">
          <span className="text-base font-bold text-slate-900 truncate font-display">{shopTitle}</span>
        </div>
        {renderNavLinks()}
        <div className="p-3.5 border-t border-slate-200 space-y-2">
          {renderFooterIdentity()}
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
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
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative w-64 max-w-[80vw] bg-white h-full flex flex-col border-r border-slate-200 z-50">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200">
              <span className="text-base font-bold text-slate-900 truncate font-display">{shopTitle}</span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                className="p-2 text-slate-500 hover:text-slate-900 rounded-lg"
                aria-label="Close navigation"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {renderNavLinks()}
            <div className="p-3.5 border-t border-slate-200 space-y-2">
              {renderFooterIdentity()}
              <button
                type="button"
                onClick={() => void logout()}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
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
        <header className="sticky top-0 z-10 h-14 sm:h-16 bg-white border-b border-slate-200 px-3 sm:px-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-lg font-semibold text-slate-900 truncate font-display">
              {activeItem?.label || shopTitle}
            </h1>
          </div>

          <div className="flex items-center gap-4 text-xs text-slate-500 shrink-0 whitespace-nowrap">
            <span className="font-mono-num">{todayDisplay}</span>
            <span aria-hidden="true" className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">PKR · Asia/Karachi</span>
          </div>
        </header>

        <main className={`flex-1 p-3 sm:p-5 max-w-[1440px] w-full mx-auto space-y-4 ${sessionRole === 'owner' ? 'pb-20 sm:pb-24' : ''}`}>
          {showOfflineBanner && (
            <div
              role="status"
              className={`rounded-xl border px-3 py-2 sm:px-4 sm:py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 ${
                !isOnline
                  ? 'bg-amber-50 border-amber-200 text-amber-900'
                  : failedCount > 0
                    ? 'bg-red-50 border-red-200 text-red-900'
                    : 'bg-teal-50 border-teal-200 text-teal-900'
              }`}
            >
              <div className="flex items-start sm:items-center gap-2.5 text-sm">
                {!isOnline ? (
                  <WifiOff className="w-4 h-4 text-amber-700 shrink-0 mt-0.5 sm:mt-0" />
                ) : failedCount > 0 ? (
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5 sm:mt-0" />
                ) : (
                  <RefreshCw className={`w-4 h-4 text-teal-700 shrink-0 mt-0.5 sm:mt-0 ${isSyncing ? 'animate-spin' : ''}`} />
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
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
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
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 flex items-center justify-between gap-3 text-sm text-emerald-800"
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{lastSyncNotice}</span>
              </div>
              <button
                type="button"
                onClick={clearSyncNotice}
                className="p-1 text-emerald-700 hover:text-emerald-900 rounded cursor-pointer"
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
