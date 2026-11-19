import { Edit3, Plus, Search, Trash2, X } from 'lucide-react';
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
import { computeTopActivityValues } from '../services/recordSearchService';
import {
  createExpense,
  createExpenseCategory,
  deleteExpense,
  updateExpense,
} from '../services/shopService';
import type { Expense, PaymentMethod } from '../types/shop';
import {
  formatDateDDMMYYYY,
  formatMonthLabel,
  formatPKR,
  getKarachiDateIso,
  getMonthKey,
  roundMoney,
} from '../utils/formatters';

export function ExpensesPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { expenses, expenseCategories } = useShopData();
  const { showToast } = useToast();
  const todayIso = getKarachiDateIso();

  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [expenseDate, setExpenseDate] = useState(todayIso);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Custom Category inline
  const [showCustomCat, setShowCustomCat] = useState(false);
  const [customCatName, setCustomCatName] = useState('');

  // Filters & Mobile Expandable State
  const [search, setSearch] = useState('');
  const [filterCatId, setFilterCatId] = useState('');
  const [expandedExpenseId, setExpandedExpenseId] = useState<string | null>(null);

  // Edit Modal
  const [editing, setEditing] = useState<Expense | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editCatId, setEditCatId] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editPayment, setEditPayment] = useState<PaymentMethod>('Cash');
  const [editNotes, setEditNotes] = useState('');

  const expenseCategoryOptions = useMemo<SearchableSelectOption[]>(() => {
    const countMap = new Map<string, number>();
    for (const e of expenses) {
      countMap.set(e.categoryId, (countMap.get(e.categoryId) || 0) + 1);
    }
    return expenseCategories.map((c) => {
      const count = countMap.get(c.id) || 0;
      return {
        value: c.id,
        label: c.name,
        subtitle: c.isDefault ? 'Default category' : 'Custom category',
        meta: count > 0 ? `${count} recorded` : undefined,
      };
    });
  }, [expenseCategories, expenses]);

  const paymentMethodOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: 'Cash', label: 'Cash', subtitle: 'Cash expense payment' },
      { value: 'Online', label: 'Online', subtitle: 'Bank / wallet transfer' },
    ],
    []
  );

  const frequentExpenseCategoryIds = useMemo(
    () => computeTopActivityValues(expenses, (e) => e.categoryId, 5),
    [expenses]
  );

  const totals = useMemo(() => {
    const curMonth = getMonthKey(todayIso);
    const curYear = todayIso.slice(0, 4);
    let daily = 0;
    let monthly = 0;
    let yearly = 0;
    for (const e of expenses) {
      if (e.expenseDate === todayIso) daily = roundMoney(daily + e.amount);
      if (getMonthKey(e.expenseDate) === curMonth) monthly = roundMoney(monthly + e.amount);
      if (e.expenseDate.slice(0, 4) === curYear) yearly = roundMoney(yearly + e.amount);
    }
    return { daily, monthly, yearly };
  }, [expenses, todayIso]);

  const categoryBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of expenses) {
      map.set(e.categoryName, roundMoney((map.get(e.categoryName) || 0) + e.amount));
    }
    return Array.from(map.entries())
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total);
  }, [expenses]);

  const monthlyComparisonSeries = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of expenses) {
      const mk = getMonthKey(e.expenseDate);
      map.set(mk, roundMoney((map.get(mk) || 0) + e.amount));
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6)
      .map(([mk, total]) => ({ month: formatMonthLabel(mk), total }));
  }, [expenses]);

  const handleSaveExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId) return;
    setError(null);

    const cat = expenseCategories.find((c) => c.id === (categoryId || expenseCategories[0]?.id));
    if (!cat) {
      setError('Please select an expense category.');
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Amount must be greater than zero.');
      return;
    }

    setSubmitting(true);
    try {
      await createExpense(activeShopId, {
        title: title.trim(),
        categoryId: cat.id,
        categoryName: cat.name,
        amount: amt,
        expenseDate,
        paymentMethod,
        notes,
      });
      showToast({
        title: 'Expense saved',
        message: `${title.trim()} (${formatPKR(amt)})`,
        tone: 'success',
      });
      setTitle('');
      setAmount('');
      setNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save expense.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddCustomCategory = async () => {
    if (!activeShopId || !customCatName.trim()) return;
    const id = await createExpenseCategory(activeShopId, customCatName.trim());
    setCategoryId(id);
    setCustomCatName('');
    setShowCustomCat(false);
  };

  const openEdit = (exp: Expense) => {
    setEditing(exp);
    setEditTitle(exp.title);
    setEditCatId(exp.categoryId);
    setEditAmount(String(exp.amount));
    setEditDate(exp.expenseDate);
    setEditPayment(exp.paymentMethod);
    setEditNotes(exp.notes);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId || !editing) return;
    const cat = expenseCategories.find((c) => c.id === editCatId);
    await updateExpense(activeShopId, editing.id, {
      title: editTitle.trim(),
      categoryId: cat?.id || editing.categoryId,
      categoryName: cat?.name || editing.categoryName,
      amount: Number(editAmount) || 0,
      expenseDate: editDate,
      paymentMethod: editPayment,
      notes: editNotes,
    });
    showToast({ title: 'Expense updated', message: editTitle.trim(), tone: 'success' });
    setEditing(null);
  };

  const filteredExpenses = useMemo(() => {
    const q = search.trim().toLowerCase();
    return expenses.filter((e) => {
      if (filterCatId && e.categoryId !== filterCatId) return false;
      if (q && !`${e.title} ${e.categoryName} ${e.notes}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [expenses, search, filterCatId]);

  return (
    <div className="space-y-4">
      {/* Daily, Monthly, Yearly Expense Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 sm:gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Daily Expenses (Today)</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
            {formatPKR(totals.daily)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Monthly Expenses</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
            {formatPKR(totals.monthly)}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1 bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[11px] font-medium text-slate-500">Yearly Expenses</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 truncate">
            {formatPKR(totals.yearly)}
          </div>
        </div>
      </div>

      {/* Simple Expense Entry Form */}
      <CompactSection
        title="Add Business Expense"
        subtitle="Automatically updates net profit & loss"
        collapsible={true}
        defaultOpen={true}
        bodyClassName="p-3.5 sm:p-4 space-y-3"
      >
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-700">{error}</div>
        )}

        <form onSubmit={handleSaveExpense} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Expense Title *</label>
              <input
                type="text"
                required
                maxLength={150}
                placeholder="e.g., November Shop Rent"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-slate-600">Category *</label>
                <button
                  type="button"
                  onClick={() => setShowCustomCat((v) => !v)}
                  className="text-[11px] font-semibold text-teal-700 hover:underline cursor-pointer"
                >
                  + Custom
                </button>
              </div>
              <SearchableSelect
                size="sm"
                ariaLabel="Select expense category"
                suggestionScope="expense-category"
                suggestedValues={frequentExpenseCategoryIds}
                options={expenseCategoryOptions}
                value={categoryId || expenseCategories[0]?.id || ''}
                onChange={setCategoryId}
                placeholder="Search category..."
                searchPlaceholder="Type category name..."
                noResultsMessage="No expense categories found"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Amount (PKR) *</label>
                <input
                  type="number"
                  required
                  min={1}
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full min-h-[38px] px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg font-mono-num"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Date *</label>
                <input
                  type="date"
                  required
                  value={expenseDate}
                  onChange={(e) => setExpenseDate(e.target.value)}
                  className="w-full min-h-[38px] px-2 py-1.5 text-xs sm:text-sm border border-slate-200 rounded-lg font-mono-num"
                />
              </div>
            </div>

            <div>
              <span className="block text-[11px] font-medium text-slate-600 mb-1">Payment Method</span>
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 min-h-[38px]">
                {(['Cash', 'Online'] as PaymentMethod[]).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setPaymentMethod(method)}
                    className={`text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      paymentMethod === method
                        ? 'bg-white text-teal-700 border border-slate-200 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {method}
                  </button>
                ))}
              </div>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Notes (Optional)</label>
              <input
                type="text"
                maxLength={500}
                placeholder="Optional note"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full min-h-[38px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          {showCustomCat && (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap gap-2 items-center">
              <input
                type="text"
                placeholder="New custom category name..."
                value={customCatName}
                onChange={(e) => setCustomCatName(e.target.value)}
                className="min-h-[38px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white flex-1 min-w-[180px]"
              />
              <button
                type="button"
                onClick={() => void handleAddCustomCategory()}
                className="min-h-[38px] px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 rounded-lg cursor-pointer"
              >
                Add Category
              </button>
              <button
                type="button"
                onClick={() => setShowCustomCat(false)}
                className="min-h-[38px] px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg bg-white cursor-pointer"
              >
                Cancel
              </button>
            </div>
          )}

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="w-full sm:w-auto min-h-[42px] inline-flex items-center justify-center gap-1.5 px-5 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg disabled:opacity-50 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              {submitting ? 'Saving...' : 'Save Expense'}
            </button>
          </div>
        </form>
      </CompactSection>

      {/* Expense Analytics Charts (Collapsible) */}
      <CompactSection
        title="Expense Analytics Charts"
        subtitle="Category breakdown & 6-month trend"
        collapsible={true}
        defaultOpen={true}
        bodyClassName="p-3.5 sm:p-4"
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-2">
            <h3 className="text-xs sm:text-sm font-semibold text-slate-800">Category-Wise Breakdown</h3>
            <div className="h-52 sm:h-60">
              {categoryBreakdown.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-slate-500">
                  No expenses recorded yet.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={categoryBreakdown} margin={{ top: 6, right: 8, left: -12, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} />
                    <YAxis tick={{ fontSize: 10, fill: '#64748b' }} />
                    <Tooltip formatter={(v) => formatPKR(Number(v ?? 0))} />
                    <Bar dataKey="total" name="Amount (PKR)" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-xs sm:text-sm font-semibold text-slate-800">Monthly Expense Comparison</h3>
            <div className="h-52 sm:h-60">
              {monthlyComparisonSeries.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-slate-500">
                  No monthly comparison data yet.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyComparisonSeries} margin={{ top: 6, right: 8, left: -12, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#64748b' }} />
                    <YAxis tick={{ fontSize: 10, fill: '#64748b' }} />
                    <Tooltip formatter={(v) => formatPKR(Number(v ?? 0))} />
                    <Bar dataKey="total" name="Monthly Expense (PKR)" fill="#0f172a" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      </CompactSection>

      {/* Expense Ledger */}
      <CompactSection
        title="Expense History"
        summary={`${filteredExpenses.length} records`}
        collapsible={true}
        defaultOpen={true}
      >
        <div className="p-3 sm:p-4 border-b border-slate-200 grid grid-cols-1 sm:grid-cols-12 gap-2">
          <div className="relative sm:col-span-7">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search expenses..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full min-h-[38px] pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg"
            />
          </div>
          <div className="sm:col-span-5">
            <SearchableSelect
              size="sm"
              ariaLabel="Filter by expense category"
              suggestionScope="expense-category"
              suggestedValues={frequentExpenseCategoryIds}
              options={expenseCategoryOptions}
              value={filterCatId}
              onChange={setFilterCatId}
              emptyOptionLabel="All Categories"
              placeholder="All Categories"
              searchPlaceholder="Search category..."
            />
          </div>
        </div>

        {filteredExpenses.length === 0 ? (
          <div className="p-6 text-center text-xs sm:text-sm text-slate-500">No expenses found.</div>
        ) : (
          <>
            {/* Mobile Compact Expandable List */}
            <div className="md:hidden divide-y divide-slate-100">
              {filteredExpenses.map((exp) => (
                <CompactExpandableRow
                  key={exp.id}
                  title={exp.title}
                  subtitle={`${formatDateDDMMYYYY(exp.expenseDate)} · ${exp.categoryName} · ${exp.paymentMethod}`}
                  rightPrimary={formatPKR(exp.amount)}
                  isExpanded={expandedExpenseId === exp.id}
                  onToggle={() =>
                    setExpandedExpenseId((cur) => (cur === exp.id ? null : exp.id))
                  }
                  expandedContent={
                    <div className="space-y-2">
                      {exp.notes && (
                        <p className="text-xs text-slate-600">Notes: {exp.notes}</p>
                      )}
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openEdit(exp)}
                          className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (activeShopId) {
                              void deleteExpense(activeShopId, exp);
                              showToast({ title: 'Expense deleted', message: exp.title, tone: 'info' });
                            }
                          }}
                          className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Delete</span>
                        </button>
                      </div>
                    </div>
                  }
                />
              ))}
            </div>

            {/* Desktop Dense Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">Title</th>
                    <th className="py-2.5 px-3">Category</th>
                    <th className="py-2.5 px-3">Payment</th>
                    <th className="py-2.5 px-3 text-right">Amount</th>
                    <th className="py-2.5 px-3">Notes</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {filteredExpenses.map((exp) => (
                    <tr key={exp.id} className="hover:bg-slate-50">
                      <td className="py-2 px-3 font-mono-num whitespace-nowrap text-xs">
                        {formatDateDDMMYYYY(exp.expenseDate)}
                      </td>
                      <td className="py-2 px-3 font-medium text-slate-900">{exp.title}</td>
                      <td className="py-2 px-3 text-xs text-slate-600">{exp.categoryName}</td>
                      <td className="py-2 px-3 text-xs text-slate-600">{exp.paymentMethod}</td>
                      <td className="py-2 px-3 text-right font-mono-num font-semibold text-slate-900">
                        {formatPKR(exp.amount)}
                      </td>
                      <td className="py-2 px-3 text-xs text-slate-500">{exp.notes || '—'}</td>
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEdit(exp)}
                            className="p-1.5 text-slate-500 hover:text-teal-700 rounded cursor-pointer"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => activeShopId && void deleteExpense(activeShopId, exp)}
                            className="p-1.5 text-slate-500 hover:text-red-600 rounded cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CompactSection>

      {/* Edit Expense Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-semibold text-slate-900">Edit Expense</h3>
              <button type="button" onClick={() => setEditing(null)} className="p-1 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Title</label>
                <input
                  type="text"
                  required
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
                <SearchableSelect
                  ariaLabel="Edit expense category"
                  suggestionScope="expense-category"
                  suggestedValues={frequentExpenseCategoryIds}
                  options={expenseCategoryOptions}
                  value={editCatId}
                  onChange={setEditCatId}
                  placeholder="Search category..."
                  searchPlaceholder="Type category name..."
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Amount (PKR)</label>
                  <input
                    type="number"
                    required
                    min={1}
                    step="0.01"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Date</label>
                  <input
                    type="date"
                    required
                    value={editDate}
                    onChange={(e) => setEditDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Payment Method</label>
                <SearchableSelect
                  ariaLabel="Edit expense payment method"
                  showFrequentSection={false}
                  options={paymentMethodOptions}
                  value={editPayment}
                  onChange={(val) => setEditPayment((val || 'Cash') as PaymentMethod)}
                  placeholder="Select payment method..."
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
                <input
                  type="text"
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg"
                >
                  Update Expense
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
