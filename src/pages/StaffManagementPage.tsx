import {
  Award,
  Check,
  ChevronDown,
  Copy,
  Filter,
  KeyRound,
  Search,
  Settings2,
  ShieldCheck,
  UserCheck,
  UserPlus,
  UserX,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CompactExpandableRow, CompactSection } from '../components/CompactSection';
import { SearchableSelect, type SearchableSelectOption } from '../components/SearchableSelect';
import { useAuth } from '../contexts/AuthContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import {
  createAdminMember,
  resetAdminMemberPassword,
  updateAdminMember,
} from '../services/adminService';
import { computeTopActivityValues } from '../services/recordSearchService';
import {
  createStaffMember,
  getShopCode,
  resetStaffPassword,
  updateStaffMember,
} from '../services/staffService';
import type { AdminMember, PaymentMethod, SaleItem, StaffMember, StaffPermissions } from '../types/shop';
import {
  addDaysToIso,
  formatDateDDMMYYYY,
  formatPKR,
  getKarachiDateIso,
  getMonthKey,
  roundMoney,
} from '../utils/formatters';

type PerformancePeriod = 'daily' | 'weekly' | 'monthly' | 'all';

type ResetPasswordTarget =
  | { kind: 'staff'; member: StaffMember }
  | { kind: 'admin'; member: AdminMember };

export function StaffManagementPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { staffMembers, adminMembers, products, staffCatalog, sales, saleItems } = useShopData();
  const { showToast } = useToast();

  const todayIso = getKarachiDateIso();
  const weekStartIso = addDaysToIso(todayIso, -6);
  const currentMonthKey = getMonthKey(todayIso);
  const shopCode = activeShopId ? getShopCode(activeShopId) : '';

  const [copiedCode, setCopiedCode] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showHistoryFilters, setShowHistoryFilters] = useState(false);
  const [expandedAdminId, setExpandedAdminId] = useState<string | null>(null);
  const [expandedStaffId, setExpandedStaffId] = useState<string | null>(null);
  const [expandedPerfId, setExpandedPerfId] = useState<string | null>(null);
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null);

  // Add Staff / Admin Form
  const [accountRole, setAccountRole] = useState<'sales_staff' | 'admin'>('sales_staff');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [canAddSales, setCanAddSales] = useState(true);
  const [canViewOwnSales, setCanViewOwnSales] = useState(true);
  const [canViewStock, setCanViewStock] = useState(true);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  // Edit Permissions / Details Modal
  const [editingStaff, setEditingStaff] = useState<StaffMember | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editPerms, setEditPerms] = useState<StaffPermissions>({
    canAddSales: true,
    canViewOwnSales: true,
    canViewStock: true,
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Reset Password Modal (shared for Staff & Admins)
  const [resetTarget, setResetTarget] = useState<ResetPasswordTarget | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resettingPwd, setResettingPwd] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  // Performance Period & History Filters
  const [perfPeriod, setPerfPeriod] = useState<PerformancePeriod>('monthly');
  const [historyStaffId, setHistoryStaffId] = useState<string>('all_staff');
  const [historyPayment, setHistoryPayment] = useState<'' | PaymentMethod>('');
  const [historyFrom, setHistoryFrom] = useState('');
  const [historyTo, setHistoryTo] = useState('');
  const [historySearch, setHistorySearch] = useState('');

  const historyStaffOptions = useMemo<SearchableSelectOption[]>(
    () => [
      {
        value: 'all_staff',
        label: 'All Sales Staff',
        subtitle: 'Only staff-recorded sales',
      },
      {
        value: 'all',
        label: 'All (Staff + Owner)',
        subtitle: 'Include owner-recorded sales',
      },
      ...staffMembers.map((m) => ({
        value: m.id,
        label: m.name,
        subtitle: `@${m.username}${m.phone ? ` · ${m.phone}` : ''}`,
        keywords: [m.name, m.username, m.phone].filter(Boolean),
      })),
    ],
    [staffMembers]
  );

  const historyPaymentOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: 'Cash', label: 'Cash', subtitle: 'Cash payments' },
      { value: 'Online', label: 'Online', subtitle: 'Bank / wallet payments' },
    ],
    []
  );

  const frequentHistoryStaffIds = useMemo(
    () => computeTopActivityValues(sales, (s) => s.staffId, 5),
    [sales]
  );

  const saleItemsBySaleId = useMemo(() => {
    const map = new Map<string, SaleItem[]>();
    for (const item of saleItems) {
      const list = map.get(item.saleId) || [];
      list.push(item);
      map.set(item.saleId, list);
    }
    return map;
  }, [saleItems]);

  const completedSales = useMemo(
    () => sales.filter((s) => s.status !== 'cancelled'),
    [sales]
  );

  // Compute per-staff performance metrics
  const staffPerformance = useMemo(() => {
    return staffMembers.map((member) => {
      const memberSales = completedSales.filter((s) => s.staffId === member.id);
      let dailyRevenue = 0;
      let weeklyRevenue = 0;
      let monthlyRevenue = 0;
      let allTimeRevenue = 0;
      let allTimeProfit = 0;
      let cashTotal = 0;
      let onlineTotal = 0;
      let periodRevenue = 0;
      let periodOrders = 0;

      for (const s of memberSales) {
        allTimeRevenue = roundMoney(allTimeRevenue + s.totalAmount);
        allTimeProfit = roundMoney(allTimeProfit + s.totalProfit);
        if (s.paymentMethod === 'Cash') cashTotal = roundMoney(cashTotal + s.totalAmount);
        if (s.paymentMethod === 'Online') onlineTotal = roundMoney(onlineTotal + s.totalAmount);

        if (s.saleDate === todayIso) {
          dailyRevenue = roundMoney(dailyRevenue + s.totalAmount);
        }
        if (s.saleDate >= weekStartIso && s.saleDate <= todayIso) {
          weeklyRevenue = roundMoney(weeklyRevenue + s.totalAmount);
        }
        if (getMonthKey(s.saleDate) === currentMonthKey) {
          monthlyRevenue = roundMoney(monthlyRevenue + s.totalAmount);
        }

        const inSelectedPeriod =
          perfPeriod === 'daily'
            ? s.saleDate === todayIso
            : perfPeriod === 'weekly'
              ? s.saleDate >= weekStartIso && s.saleDate <= todayIso
              : perfPeriod === 'monthly'
                ? getMonthKey(s.saleDate) === currentMonthKey
                : true;

        if (inSelectedPeriod) {
          periodRevenue = roundMoney(periodRevenue + s.totalAmount);
          periodOrders += 1;
        }
      }

      return {
        member,
        dailyRevenue,
        weeklyRevenue,
        monthlyRevenue,
        allTimeRevenue,
        allTimeProfit,
        cashTotal,
        onlineTotal,
        totalOrders: memberSales.length,
        periodRevenue,
        periodOrders,
      };
    });
  }, [staffMembers, completedSales, todayIso, weekStartIso, currentMonthKey, perfPeriod]);

  const sortedPerformance = useMemo(
    () => [...staffPerformance].sort((a, b) => b.periodRevenue - a.periodRevenue),
    [staffPerformance]
  );

  const bestPerformer = useMemo(() => {
    const withSales = sortedPerformance.filter((p) => p.periodRevenue > 0);
    return withSales.length > 0 ? withSales[0] : null;
  }, [sortedPerformance]);

  const totalStaffRevenue = useMemo(
    () =>
      roundMoney(
        staffPerformance.reduce((sum, item) => sum + item.periodRevenue, 0)
      ),
    [staffPerformance]
  );

  const totalStaffOrders = useMemo(
    () => staffPerformance.reduce((sum, item) => sum + item.periodOrders, 0),
    [staffPerformance]
  );

  const activeStaffCount = useMemo(
    () => staffMembers.filter((s) => s.isActive).length,
    [staffMembers]
  );

  const comparisonChartData = useMemo(() => {
    return sortedPerformance.map((p) => ({
      name: p.member.name.length > 14 ? `${p.member.name.slice(0, 14)}…` : p.member.name,
      fullName: p.member.name,
      revenue: p.periodRevenue,
      orders: p.periodOrders,
    }));
  }, [sortedPerformance]);

  // Employee sales history filter
  const filteredStaffSalesHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    return sales.filter((s) => {
      if (historyStaffId === 'all_staff') {
        if (!s.staffId || s.staffId === 'owner') return false;
      } else if (historyStaffId !== 'all') {
        if (s.staffId !== historyStaffId) return false;
      }
      if (historyPayment && s.paymentMethod !== historyPayment) return false;
      if (historyFrom && s.saleDate < historyFrom) return false;
      if (historyTo && s.saleDate > historyTo) return false;
      if (q) {
        const items = saleItemsBySaleId.get(s.id) || [];
        const matchSale = s.saleNumber.toLowerCase().includes(q);
        const matchStaff = (s.staffName || '').toLowerCase().includes(q);
        const matchProd = items.some((i) => i.productName.toLowerCase().includes(q));
        if (!matchSale && !matchStaff && !matchProd) return false;
      }
      return true;
    });
  }, [sales, saleItemsBySaleId, historyStaffId, historyPayment, historyFrom, historyTo, historySearch]);

  const handleCopyShopCode = () => {
    if (!shopCode) return;
    void navigator.clipboard.writeText(shopCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId) return;
    setFormError(null);
    setFormSuccess(null);
    setCreating(true);
    try {
      if (accountRole === 'admin') {
        await createAdminMember(activeShopId, {
          name,
          phone,
          username,
          password,
        });
        setFormSuccess(
          `Registered Admin "${name.trim()}" (@${username.trim()}). Share their username and password so they can sign in on the Owner / Admin tab.`
        );
        showToast({
          title: 'Admin Registered',
          message: `${name.trim()} (@${username.trim()}) added successfully.`,
          tone: 'success',
          durationMs: 4000,
        });
      } else {
        await createStaffMember(
          activeShopId,
          {
            name,
            phone,
            username,
            password,
            permissions: { canAddSales, canViewOwnSales, canViewStock },
          },
          products,
          staffMembers,
          staffCatalog
        );
        setFormSuccess(
          `Registered Sales Staff "${name.trim()}" (@${username.trim()}). Share their username and password so they can log in on the Sales Staff tab.`
        );
        showToast({
          title: 'Staff Registered',
          message: `${name.trim()} (@${username.trim()}) added successfully.`,
          tone: 'success',
          durationMs: 4000,
        });
      }
      setName('');
      setPhone('');
      setUsername('');
      setPassword('');
      setCanAddSales(true);
      setCanViewOwnSales(true);
      setCanViewStock(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create account.');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (member: StaffMember) => {
    if (!activeShopId) return;
    setFormError(null);
    setFormSuccess(null);
    try {
      await updateStaffMember(
        activeShopId,
        member,
        {
          name: member.name,
          phone: member.phone,
          isActive: !member.isActive,
          permissions: member.permissions,
        },
        products,
        staffMembers,
        staffCatalog
      );
      setFormSuccess(
        `${member.name} has been ${!member.isActive ? 'activated' : 'deactivated'}.`
      );
      showToast({
        title: 'Status Updated',
        message: `${member.name} is now ${!member.isActive ? 'Active' : 'Inactive'}.`,
        tone: 'success',
        durationMs: 3500,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update staff status.');
    }
  };

  const handleToggleAdminActive = async (member: AdminMember) => {
    if (!activeShopId) return;
    setFormError(null);
    setFormSuccess(null);
    if (member.isActive && user?.uid && member.authUid === user.uid) {
      setFormError('You cannot deactivate your own currently signed-in Admin account.');
      return;
    }
    try {
      await updateAdminMember(activeShopId, member, {
        name: member.name,
        phone: member.phone,
        isActive: !member.isActive,
      });
      setFormSuccess(
        `Admin "${member.name}" has been ${!member.isActive ? 'activated' : 'deactivated'}.`
      );
      showToast({
        title: 'Admin Updated',
        message: `${member.name} is now ${!member.isActive ? 'Active' : 'Inactive'}.`,
        tone: 'success',
        durationMs: 3500,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to update admin status.');
    }
  };

  const openEditModal = (member: StaffMember) => {
    setEditingStaff(member);
    setEditName(member.name);
    setEditPhone(member.phone);
    setEditActive(member.isActive);
    setEditPerms({ ...member.permissions });
    setEditError(null);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId || !editingStaff) return;
    setEditError(null);
    setSavingEdit(true);
    try {
      await updateStaffMember(
        activeShopId,
        editingStaff,
        {
          name: editName,
          phone: editPhone,
          isActive: editActive,
          permissions: editPerms,
        },
        products,
        staffMembers,
        staffCatalog
      );
      setEditingStaff(null);
      setFormSuccess(`Updated settings and permissions for ${editName.trim()}.`);
      showToast({
        title: 'Permissions Updated',
        message: `Saved changes for ${editName.trim()}.`,
        tone: 'success',
        durationMs: 3500,
      });
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to save staff updates.');
    } finally {
      setSavingEdit(false);
    }
  };

  const openResetModal = (target: ResetPasswordTarget) => {
    setResetTarget(target);
    setNewPassword('');
    setResetError(null);
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId || !resetTarget) return;
    setResetError(null);
    setResettingPwd(true);
    try {
      if (resetTarget.kind === 'admin') {
        await resetAdminMemberPassword(activeShopId, resetTarget.member, newPassword);
      } else {
        await resetStaffPassword(
          activeShopId,
          resetTarget.member,
          newPassword,
          products,
          staffMembers,
          staffCatalog
        );
      }
      setFormSuccess(
        `Password reset for ${resetTarget.kind === 'admin' ? 'Admin' : 'Sales Staff'} "${resetTarget.member.name}" (@${resetTarget.member.username}). Previous session has been revoked.`
      );
      showToast({
        title: 'Password Reset',
        message: `Updated password for @${resetTarget.member.username}.`,
        tone: 'success',
        durationMs: 4000,
      });
      setResetTarget(null);
      setNewPassword('');
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Failed to reset password.');
    } finally {
      setResettingPwd(false);
    }
  };

  const periodLabel =
    perfPeriod === 'daily'
      ? 'Today'
      : perfPeriod === 'weekly'
        ? 'Last 7 Days'
        : perfPeriod === 'monthly'
          ? 'This Month'
          : 'All Time';

  return (
    <div className="space-y-4">
      {/* Shop Access Code Banner */}
      <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
        <div className="space-y-0.5">
          <h2 className="text-sm sm:text-base font-semibold text-slate-900">Sales Staff Portal Access</h2>
          <p className="text-[11px] sm:text-xs text-slate-500">
            Staff sign in using Username & Password. Shop Reference Code:
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg font-mono-num text-sm sm:text-base font-bold text-slate-900 tracking-wider">
            {shopCode}
          </div>
          <button
            type="button"
            onClick={handleCopyShopCode}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] text-xs font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 rounded-lg transition-colors cursor-pointer"
          >
            {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedCode ? 'Copied' : 'Copy'}
          </button>
        </div>
      </section>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] sm:text-xs font-medium text-slate-500">Registered Staff</div>
          <div className="mt-1 text-base sm:text-xl font-bold font-mono-num text-slate-900">
            {activeStaffCount} Active <span className="text-xs font-normal text-slate-500">/ {staffMembers.length}</span>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] sm:text-xs font-medium text-slate-500">Staff Sales ({periodLabel})</div>
          <div className="mt-1 text-base sm:text-xl font-bold font-mono-num text-slate-900 truncate">
            {formatPKR(totalStaffRevenue)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] sm:text-xs font-medium text-slate-500">Staff Bills ({periodLabel})</div>
          <div className="mt-1 text-base sm:text-xl font-bold font-mono-num text-slate-900">
            {totalStaffOrders}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="flex items-center justify-between gap-1">
            <span className="text-[11px] sm:text-xs font-medium text-slate-500 truncate">Top ({periodLabel})</span>
            <Award className="w-3.5 h-3.5 text-teal-600 shrink-0" />
          </div>
          <div className="mt-1 text-sm sm:text-base font-bold text-slate-900 truncate">
            {bestPerformer ? bestPerformer.member.name : 'No sales yet'}
          </div>
          {bestPerformer && (
            <div className="text-[11px] font-mono-num text-teal-700 font-semibold truncate">
              {formatPKR(bestPerformer.periodRevenue)} ({bestPerformer.periodOrders})
            </div>
          )}
        </div>
      </div>

      {/* Add New Staff or Admin Form (Collapsible) */}
      <CompactSection
        title={accountRole === 'admin' ? 'Add New Admin' : 'Add New Sales Staff'}
        subtitle="Create a Sales Staff or Admin login account"
        icon={<UserPlus className="w-4 h-4 text-teal-600" />}
        collapsible
        open={showAddAccount}
        onToggle={() => setShowAddAccount((v) => !v)}
        actions={
          <button
            type="button"
            onClick={() => setShowAddAccount((v) => !v)}
            className="px-2.5 py-1 text-xs font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 rounded-lg cursor-pointer"
          >
            {showAddAccount ? 'Hide Form' : '+ New Account'}
          </button>
        }
        bodyClassName="p-3.5 sm:p-4 space-y-3.5"
      >
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => {
              setAccountRole('sales_staff');
              setFormError(null);
            }}
            className={`px-3 py-1.5 rounded-md font-semibold transition-colors cursor-pointer ${
              accountRole === 'sales_staff'
                ? 'bg-white text-teal-700 border border-slate-200 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Sales Staff
          </button>
          <button
            type="button"
            onClick={() => {
              setAccountRole('admin');
              setFormError(null);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold transition-colors cursor-pointer ${
              accountRole === 'admin'
                ? 'bg-white text-teal-700 border border-slate-200 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            Admin
          </button>
        </div>

        {formError && (
          <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-700">
            {formError}
          </div>
        )}
        {formSuccess && (
          <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs sm:text-sm text-emerald-700">
            {formSuccess}
          </div>
        )}

        <form onSubmit={handleCreateAccount} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            <div>
              <label htmlFor="new-staff-name" className="block text-[11px] font-medium text-slate-700 mb-1">
                Full Name *
              </label>
              <input
                id="new-staff-name"
                type="text"
                required
                maxLength={120}
                placeholder="e.g. Muhammad Ali"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 min-h-[40px] sm:min-h-0 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
              />
            </div>

            <div>
              <label htmlFor="new-staff-phone" className="block text-[11px] font-medium text-slate-700 mb-1">
                Phone Number
              </label>
              <input
                id="new-staff-phone"
                type="text"
                maxLength={40}
                placeholder="03XX-XXXXXXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 min-h-[40px] sm:min-h-0 text-sm border border-slate-200 rounded-lg font-mono-num focus:outline-none focus:border-teal-600"
              />
            </div>

            <div>
              <label htmlFor="new-staff-username" className="block text-[11px] font-medium text-slate-700 mb-1">
                Username *
              </label>
              <input
                id="new-staff-username"
                type="text"
                required
                maxLength={40}
                placeholder={accountRole === 'admin' ? 'e.g. hassan_admin' : 'e.g. ali_sales'}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 min-h-[40px] sm:min-h-0 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
              />
            </div>

            <div>
              <label htmlFor="new-staff-password" className="block text-[11px] font-medium text-slate-700 mb-1">
                Password * (min 6 chars)
              </label>
              <input
                id="new-staff-password"
                type="password"
                required
                minLength={6}
                placeholder="Set login password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 min-h-[40px] sm:min-h-0 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
              />
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-slate-100">
            {accountRole === 'sales_staff' ? (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-700">
                <span className="font-semibold text-slate-500">Permissions:</span>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canAddSales}
                    onChange={(e) => setCanAddSales(e.target.checked)}
                    className="rounded border-slate-300 text-teal-600 focus:ring-teal-600"
                  />
                  <span>Add Sales</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canViewOwnSales}
                    onChange={(e) => setCanViewOwnSales(e.target.checked)}
                    className="rounded border-slate-300 text-teal-600 focus:ring-teal-600"
                  />
                  <span>View Own Sales</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={canViewStock}
                    onChange={(e) => setCanViewStock(e.target.checked)}
                    className="rounded border-slate-300 text-teal-600 focus:ring-teal-600"
                  />
                  <span>Prices & Stock</span>
                </label>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <ShieldCheck className="w-4 h-4 text-teal-600 shrink-0" />
                <span>
                  Admins receive full shop management access on the <strong>Owner / Admin</strong> tab.
                </span>
              </div>
            )}

            <button
              type="submit"
              disabled={creating}
              className="w-full sm:w-auto px-4 py-2 min-h-[42px] sm:min-h-[38px] text-xs sm:text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
            >
              {creating
                ? accountRole === 'admin'
                  ? 'Registering Admin...'
                  : 'Registering Staff...'
                : accountRole === 'admin'
                  ? 'Register Admin'
                  : 'Register Sales Staff'}
            </button>
          </div>
        </form>
      </CompactSection>

      {/* Registered Shop Admins Table */}
      <CompactSection
        title="Registered Shop Admins"
        subtitle="Sign in on Owner / Admin tab"
        summary={`${adminMembers.length} admins`}
        collapsible
        defaultOpen
      >
        {adminMembers.length === 0 ? (
          <div className="p-4 text-center text-xs sm:text-sm text-slate-500">
            No additional admins registered yet. Open <strong>+ New Account</strong> above and switch to <strong>Admin</strong>.
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-2 px-3">Name</th>
                    <th className="py-2 px-3">Username</th>
                    <th className="py-2 px-3">Phone</th>
                    <th className="py-2 px-3">Access</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {adminMembers.map((admin) => {
                    const isCurrentSelf = Boolean(user?.uid && admin.authUid === user.uid);
                    return (
                      <tr key={admin.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-semibold text-slate-900">
                          {admin.name}
                          {isCurrentSelf && (
                            <span className="ml-2 text-xs font-medium text-teal-700">(You)</span>
                          )}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-xs text-slate-700">
                          @{admin.username}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-xs text-slate-600">
                          {admin.phone || '—'}
                        </td>
                        <td className="py-2 px-3 text-xs text-slate-700 font-medium">
                          Full Admin
                        </td>
                        <td className="py-2 px-3 text-xs font-semibold">
                          <span className={admin.isActive ? 'text-emerald-700' : 'text-red-600'}>
                            {admin.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openResetModal({ kind: 'admin', member: admin })}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 hover:text-amber-700 hover:bg-amber-50 rounded-lg cursor-pointer"
                            >
                              <KeyRound className="w-3.5 h-3.5" />
                              <span>Reset Password</span>
                            </button>
                            <button
                              type="button"
                              disabled={isCurrentSelf && admin.isActive}
                              onClick={() => void handleToggleAdminActive(admin)}
                              className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                                admin.isActive
                                  ? 'text-red-700 hover:bg-red-50'
                                  : 'text-emerald-700 hover:bg-emerald-50'
                              }`}
                            >
                              {admin.isActive ? (
                                <>
                                  <UserX className="w-3.5 h-3.5" />
                                  <span>Deactivate</span>
                                </>
                              ) : (
                                <>
                                  <UserCheck className="w-3.5 h-3.5" />
                                  <span>Activate</span>
                                </>
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-slate-100">
              {adminMembers.map((admin) => {
                const isCurrentSelf = Boolean(user?.uid && admin.authUid === user.uid);
                return (
                  <CompactExpandableRow
                    key={admin.id}
                    title={
                      <span>
                        {admin.name}
                        {isCurrentSelf && <span className="ml-1.5 text-[11px] font-medium text-teal-700">(You)</span>}
                      </span>
                    }
                    subtitle={`@${admin.username}${admin.phone ? ` · ${admin.phone}` : ''}`}
                    rightPrimary={
                      <span className={admin.isActive ? 'text-emerald-700' : 'text-red-600'}>
                        {admin.isActive ? 'Active' : 'Inactive'}
                      </span>
                    }
                    rightSecondary="Full Admin"
                    isExpanded={expandedAdminId === admin.id}
                    onToggle={() => setExpandedAdminId((prev) => (prev === admin.id ? null : admin.id))}
                    expandedContent={
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => openResetModal({ kind: 'admin', member: admin })}
                          className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:text-amber-700 rounded-lg cursor-pointer"
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                          Reset Password
                        </button>
                        <button
                          type="button"
                          disabled={isCurrentSelf && admin.isActive}
                          onClick={() => void handleToggleAdminActive(admin)}
                          className={`inline-flex items-center gap-1 px-3 py-1.5 min-h-[36px] text-xs font-medium rounded-lg border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                            admin.isActive
                              ? 'text-red-700 bg-white border-red-200'
                              : 'text-emerald-700 bg-white border-emerald-200'
                          }`}
                        >
                          {admin.isActive ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                          {admin.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </CompactSection>

      {/* Registered Sales Staff Accounts Table */}
      <CompactSection
        title="Registered Sales Staff"
        subtitle="Manage permissions, status, or reset passwords"
        summary={`${staffMembers.length} staff`}
        collapsible
        defaultOpen
      >
        {staffMembers.length === 0 ? (
          <div className="p-5 text-center text-xs sm:text-sm text-slate-500">
            No sales staff registered yet. Open <strong>+ New Account</strong> above to add staff.
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-2 px-3">Name</th>
                    <th className="py-2 px-3">Username</th>
                    <th className="py-2 px-3">Phone</th>
                    <th className="py-2 px-3">Permissions</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {staffMembers.map((member) => {
                    const permsText = [
                      member.permissions.canAddSales ? 'Add Sales' : null,
                      member.permissions.canViewOwnSales ? 'Own History' : null,
                      member.permissions.canViewStock ? 'Prices & Stock' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Restricted';

                    return (
                      <tr key={member.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-semibold text-slate-900">{member.name}</td>
                        <td className="py-2 px-3 font-mono-num text-xs text-slate-700">
                          @{member.username}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-xs text-slate-600">
                          {member.phone || '—'}
                        </td>
                        <td className="py-2 px-3 text-xs text-slate-600">{permsText}</td>
                        <td className="py-2 px-3 text-xs font-semibold">
                          <span className={member.isActive ? 'text-emerald-700' : 'text-red-600'}>
                            {member.isActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openEditModal(member)}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 hover:text-teal-700 hover:bg-slate-100 rounded-lg cursor-pointer"
                            >
                              <Settings2 className="w-3.5 h-3.5" />
                              <span>Permissions</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => openResetModal({ kind: 'staff', member })}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 hover:text-amber-700 hover:bg-amber-50 rounded-lg cursor-pointer"
                            >
                              <KeyRound className="w-3.5 h-3.5" />
                              <span>Reset</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleToggleActive(member)}
                              className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg cursor-pointer ${
                                member.isActive
                                  ? 'text-red-700 hover:bg-red-50'
                                  : 'text-emerald-700 hover:bg-emerald-50'
                              }`}
                            >
                              {member.isActive ? (
                                <>
                                  <UserX className="w-3.5 h-3.5" />
                                  <span>Deactivate</span>
                                </>
                              ) : (
                                <>
                                  <UserCheck className="w-3.5 h-3.5" />
                                  <span>Activate</span>
                                </>
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-slate-100">
              {staffMembers.map((member) => {
                const permsText = [
                  member.permissions.canAddSales ? 'Add Sales' : null,
                  member.permissions.canViewOwnSales ? 'Own History' : null,
                  member.permissions.canViewStock ? 'Prices & Stock' : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Restricted';

                return (
                  <CompactExpandableRow
                    key={member.id}
                    title={member.name}
                    subtitle={`@${member.username}${member.phone ? ` · ${member.phone}` : ''}`}
                    rightPrimary={
                      <span className={member.isActive ? 'text-emerald-700' : 'text-red-600'}>
                        {member.isActive ? 'Active' : 'Inactive'}
                      </span>
                    }
                    isExpanded={expandedStaffId === member.id}
                    onToggle={() => setExpandedStaffId((prev) => (prev === member.id ? null : member.id))}
                    expandedContent={
                      <div className="space-y-2">
                        <div className="text-slate-600">
                          Permissions: <span className="font-medium text-slate-900">{permsText}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => openEditModal(member)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg cursor-pointer"
                          >
                            <Settings2 className="w-3.5 h-3.5" />
                            Permissions
                          </button>
                          <button
                            type="button"
                            onClick={() => openResetModal({ kind: 'staff', member })}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[36px] text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg cursor-pointer"
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                            Reset Password
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleToggleActive(member)}
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[36px] text-xs font-medium rounded-lg border cursor-pointer ${
                              member.isActive
                                ? 'text-red-700 bg-white border-red-200'
                                : 'text-emerald-700 bg-white border-emerald-200'
                            }`}
                          >
                            {member.isActive ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                            {member.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        </div>
                      </div>
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </CompactSection>

      {/* Staff Sales Performance & Employee Comparison */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm sm:text-base font-semibold text-slate-900">Employee Comparison</h2>
              <p className="text-[11px] sm:text-xs text-slate-500">Revenue ({periodLabel})</p>
            </div>
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs">
              {(['daily', 'weekly', 'monthly', 'all'] as PerformancePeriod[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPerfPeriod(p)}
                  className={`px-2 py-1 rounded-md font-medium capitalize cursor-pointer ${
                    perfPeriod === p ? 'bg-white text-teal-700 border border-slate-200' : 'text-slate-600'
                  }`}
                >
                  {p === 'all' ? 'All' : p}
                </button>
              ))}
            </div>
          </div>

          {comparisonChartData.length === 0 ? (
            <div className="h-52 flex items-center justify-center text-xs sm:text-sm text-slate-500">
              Add staff members to compare employee sales performance.
            </div>
          ) : (
            <div className="h-52 sm:h-60">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={comparisonChartData} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#64748B' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#64748B' }} />
                  <Tooltip
                    formatter={(value) => [formatPKR(Number(value ?? 0)), 'Sales Revenue']}
                    labelFormatter={(_, payload) =>
                      payload?.[0]?.payload?.fullName ? String(payload[0].payload.fullName) : ''
                    }
                  />
                  <Bar dataKey="revenue" fill="#0D9488" radius={[6, 6, 0, 0]} maxBarSize={48} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="lg:col-span-7">
          <CompactSection
            title="Staff Performance"
            subtitle="Daily, 7-day, monthly & all-time totals"
            summary={`${sortedPerformance.length} staff`}
            collapsible
            defaultOpen
          >
            {sortedPerformance.length === 0 ? (
              <div className="p-6 text-center text-xs sm:text-sm text-slate-500">No staff performance data yet.</div>
            ) : (
              <>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                        <th className="py-2 px-3">Staff Member</th>
                        <th className="py-2 px-3 text-right">Today</th>
                        <th className="py-2 px-3 text-right">7 Days</th>
                        <th className="py-2 px-3 text-right">Month</th>
                        <th className="py-2 px-3 text-right">All Time</th>
                        <th className="py-2 px-3 text-right">Profit</th>
                        <th className="py-2 px-3 text-right">Bills</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                      {sortedPerformance.map((row) => (
                        <tr key={row.member.id} className="hover:bg-slate-50">
                          <td className="py-2 px-3">
                            <div className="font-semibold text-slate-900">{row.member.name}</div>
                            <div className="text-[11px] text-slate-500 font-mono-num">
                              Cash: {formatPKR(row.cashTotal)} · Online: {formatPKR(row.onlineTotal)}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num whitespace-nowrap">
                            {formatPKR(row.dailyRevenue)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num whitespace-nowrap">
                            {formatPKR(row.weeklyRevenue)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                            {formatPKR(row.monthlyRevenue)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num whitespace-nowrap">
                            {formatPKR(row.allTimeRevenue)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num font-semibold text-emerald-700 whitespace-nowrap">
                            {formatPKR(row.allTimeProfit)}
                          </td>
                          <td className="py-2 px-3 text-right font-mono-num">{row.totalOrders}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="md:hidden divide-y divide-slate-100">
                  {sortedPerformance.map((row) => (
                    <CompactExpandableRow
                      key={row.member.id}
                      title={row.member.name}
                      subtitle={`Month: ${formatPKR(row.monthlyRevenue)} · ${row.totalOrders} bills`}
                      rightPrimary={formatPKR(row.allTimeRevenue)}
                      rightSecondary={<span className="text-emerald-700">+{formatPKR(row.allTimeProfit)}</span>}
                      isExpanded={expandedPerfId === row.member.id}
                      onToggle={() =>
                        setExpandedPerfId((prev) => (prev === row.member.id ? null : row.member.id))
                      }
                      expandedContent={
                        <div className="grid grid-cols-2 gap-2 text-slate-600 font-mono-num">
                          <div>Today: <span className="text-slate-900 font-semibold">{formatPKR(row.dailyRevenue)}</span></div>
                          <div>7 Days: <span className="text-slate-900 font-semibold">{formatPKR(row.weeklyRevenue)}</span></div>
                          <div>Cash: <span className="text-slate-900">{formatPKR(row.cashTotal)}</span></div>
                          <div>Online: <span className="text-slate-900">{formatPKR(row.onlineTotal)}</span></div>
                        </div>
                      }
                    />
                  ))}
                </div>
              </>
            )}
          </CompactSection>
        </div>
      </section>

      {/* Complete Employee Sales History */}
      <CompactSection
        title="Employee Sales History"
        subtitle="Audit sales recorded by each staff member"
        summary={`${filteredStaffSalesHistory.length} sales`}
        collapsible
        defaultOpen={false}
      >
        <div className="p-3 sm:p-3.5 border-b border-slate-200 space-y-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search staff, sale # or product..."
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 min-h-[38px] sm:min-h-0 text-xs sm:text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowHistoryFilters((v) => !v)}
              className="md:hidden inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[38px] text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer shrink-0"
            >
              <Filter className="w-3.5 h-3.5 text-teal-600" />
              Filters
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showHistoryFilters ? 'rotate-180' : ''}`} />
            </button>
          </div>

          <div
            className={`${
              showHistoryFilters ? 'grid' : 'hidden md:grid'
            } grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2`}
          >
            <SearchableSelect
              options={historyStaffOptions}
              value={historyStaffId}
              onChange={(val) => setHistoryStaffId(val || 'all_staff')}
              placeholder="All Sales Staff"
              searchPlaceholder="Search staff member..."
              ariaLabel="Filter by staff member"
              suggestionScope="staff"
              suggestedValues={frequentHistoryStaffIds}
              size="sm"
            />
            <input
              type="date"
              aria-label="From date"
              value={historyFrom}
              onChange={(e) => setHistoryFrom(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg font-mono-num"
            />
            <input
              type="date"
              aria-label="To date"
              value={historyTo}
              onChange={(e) => setHistoryTo(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg font-mono-num"
            />
            <SearchableSelect
              options={historyPaymentOptions}
              value={historyPayment}
              onChange={(val) => setHistoryPayment(val as '' | PaymentMethod)}
              emptyOptionLabel="All Payments"
              placeholder="All Payments"
              searchPlaceholder="Search payment..."
              ariaLabel="Filter by payment method"
              showFrequentSection={false}
              size="sm"
            />
          </div>
        </div>

        {filteredStaffSalesHistory.length === 0 ? (
          <div className="p-6 text-center text-xs sm:text-sm text-slate-500">
            No employee sales match the selected filters.
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-2 px-3">Date & Time</th>
                    <th className="py-2 px-3">Sale #</th>
                    <th className="py-2 px-3">Staff</th>
                    <th className="py-2 px-3">Products Sold</th>
                    <th className="py-2 px-3">Payment</th>
                    <th className="py-2 px-3 text-right">Qty</th>
                    <th className="py-2 px-3 text-right">Total</th>
                    <th className="py-2 px-3 text-right">Profit</th>
                    <th className="py-2 px-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {filteredStaffSalesHistory.map((sale) => {
                    const items = saleItemsBySaleId.get(sale.id) || [];
                    const summaryText = items.map((i) => `${i.productName} ×${i.quantity}`).join(', ');
                    const isCancelled = sale.status === 'cancelled';

                    return (
                      <tr key={sale.id} className={`hover:bg-slate-50 ${isCancelled ? 'opacity-60' : ''}`}>
                        <td className="py-2 px-3 font-mono-num text-xs whitespace-nowrap text-slate-700">
                          {sale.saleDateTime || formatDateDDMMYYYY(sale.saleDate)}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-xs font-medium text-slate-900 whitespace-nowrap">
                          {sale.saleNumber}
                        </td>
                        <td className="py-2 px-3 font-medium text-slate-900 whitespace-nowrap">
                          {sale.staffName || 'Owner'}
                        </td>
                        <td className="py-2 px-3 text-slate-700 max-w-xs truncate" title={summaryText}>
                          {summaryText || `${sale.itemCount} items`}
                        </td>
                        <td className="py-2 px-3 text-xs text-slate-600">{sale.paymentMethod}</td>
                        <td className="py-2 px-3 text-right font-mono-num">{sale.totalQuantity}</td>
                        <td className="py-2 px-3 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                          {formatPKR(sale.totalAmount)}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono-num font-semibold whitespace-nowrap ${
                            sale.totalProfit >= 0 ? 'text-emerald-700' : 'text-red-600'
                          }`}
                        >
                          {formatPKR(sale.totalProfit)}
                        </td>
                        <td className="py-2 px-3 text-xs font-semibold">
                          <span className={isCancelled ? 'text-red-600' : 'text-emerald-700'}>
                            {isCancelled ? 'Cancelled' : 'Completed'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-slate-100">
              {filteredStaffSalesHistory.map((sale) => {
                const items = saleItemsBySaleId.get(sale.id) || [];
                const summaryText = items.map((i) => `${i.productName} ×${i.quantity}`).join(', ');
                const isCancelled = sale.status === 'cancelled';

                return (
                  <CompactExpandableRow
                    key={sale.id}
                    dimmed={isCancelled}
                    title={`${sale.saleNumber} · ${sale.staffName || 'Owner'}`}
                    subtitle={`${sale.saleDateTime || formatDateDDMMYYYY(sale.saleDate)} · ${sale.paymentMethod}`}
                    rightPrimary={formatPKR(sale.totalAmount)}
                    rightSecondary={
                      <span className={isCancelled ? 'text-red-600' : 'text-emerald-700'}>
                        {isCancelled ? 'Cancelled' : `+${formatPKR(sale.totalProfit)}`}
                      </span>
                    }
                    isExpanded={expandedSaleId === sale.id}
                    onToggle={() => setExpandedSaleId((prev) => (prev === sale.id ? null : sale.id))}
                    expandedContent={
                      <div className="space-y-1.5 text-slate-600">
                        <div className="text-slate-900">{summaryText || `${sale.itemCount} items`}</div>
                        <div className="flex justify-between font-mono-num text-[11px]">
                          <span>Qty: {sale.totalQuantity}</span>
                          <span>Status: {isCancelled ? 'Cancelled' : 'Completed'}</span>
                        </div>
                      </div>
                    }
                  />
                );
              })}
            </div>
          </>
        )}
      </CompactSection>

      {/* Edit Staff Details & Permissions Modal */}
      {editingStaff && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-t-2xl sm:rounded-xl w-full max-w-md max-h-[92vh] overflow-y-auto p-4 sm:p-5 space-y-3.5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
              <h3 className="text-sm sm:text-base font-semibold text-slate-900">
                Edit Staff · @{editingStaff.username}
              </h3>
              <button
                type="button"
                onClick={() => setEditingStaff(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {editError && (
              <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-700">
                {editError}
              </div>
            )}

            <form onSubmit={handleSaveEdit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Phone</label>
                <input
                  type="text"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                />
              </div>
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <div className="text-xs font-semibold text-slate-700">Account & Permissions</div>
                <label className="flex items-center gap-2 text-xs sm:text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editActive}
                    onChange={(e) => setEditActive(e.target.checked)}
                    className="rounded border-slate-300 text-teal-600"
                  />
                  <span>Account Active (can log in)</span>
                </label>
                <label className="flex items-center gap-2 text-xs sm:text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editPerms.canAddSales}
                    onChange={(e) =>
                      setEditPerms((p) => ({ ...p, canAddSales: e.target.checked }))
                    }
                    className="rounded border-slate-300 text-teal-600"
                  />
                  <span>Can Add New Sales</span>
                </label>
                <label className="flex items-center gap-2 text-xs sm:text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editPerms.canViewOwnSales}
                    onChange={(e) =>
                      setEditPerms((p) => ({ ...p, canViewOwnSales: e.target.checked }))
                    }
                    className="rounded border-slate-300 text-teal-600"
                  />
                  <span>Can View Own Sales History & Totals</span>
                </label>
                <label className="flex items-center gap-2 text-xs sm:text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={editPerms.canViewStock}
                    onChange={(e) =>
                      setEditPerms((p) => ({ ...p, canViewStock: e.target.checked }))
                    }
                    className="rounded border-slate-300 text-teal-600"
                  />
                  <span>Can View Product Selling Prices & Stock</span>
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setEditingStaff(null)}
                  className="px-4 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="px-4 py-2 min-h-[40px] text-xs sm:text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg disabled:opacity-50 cursor-pointer"
                >
                  {savingEdit ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Staff / Admin Password Modal */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-t-2xl sm:rounded-xl w-full max-w-md max-h-[92vh] overflow-y-auto p-4 sm:p-5 space-y-3.5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
              <h3 className="text-sm sm:text-base font-semibold text-slate-900">
                Reset Password · {resetTarget.member.name}
              </h3>
              <button
                type="button"
                onClick={() => setResetTarget(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {resetError && (
              <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-700">
                {resetError}
              </div>
            )}

            <p className="text-xs text-slate-600">
              Setting a new password immediately revokes any active login session for @{resetTarget.member.username}.
            </p>

            <form onSubmit={handleResetPassword} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  New Password (minimum 6 characters)
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  placeholder="Enter new password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setResetTarget(null)}
                  className="px-4 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resettingPwd}
                  className="px-4 py-2 min-h-[40px] text-xs sm:text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg disabled:opacity-50 cursor-pointer"
                >
                  {resettingPwd ? 'Resetting...' : 'Reset Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
