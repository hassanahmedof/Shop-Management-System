import { Ban, CheckCircle2, ChevronDown, ChevronRight, Filter, Plus, Search, Trash2, Wallet, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CompactExpandableRow, CompactSection } from '../components/CompactSection';
import { SearchableSelect, type SearchableSelectOption } from '../components/SearchableSelect';
import { useAuth } from '../contexts/AuthContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import {
  computeTopActivityValues,
  queryOwnerCollectionSlice,
} from '../services/recordSearchService';
import {
  cancelPurchase,
  createPurchase,
  createSupplier,
  settlePurchaseBalance,
  type PurchaseLineDraft,
} from '../services/shopService';
import type { PaymentMethod, Product, Purchase, PurchaseItem, Supplier } from '../types/shop';
import {
  formatDateDDMMYYYY,
  formatNumber,
  formatPKR,
  getKarachiDateIso,
  roundMoney,
} from '../utils/formatters';

interface PurchaseRowDraft {
  key: string;
  productId: string;
  quantity: string;
  purchasePricePerUnit: string;
}

export function PurchasesPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { products, suppliers, purchases, purchaseItems } = useShopData();
  const { showToast } = useToast();
  const todayIso = getKarachiDateIso();

  const [purchaseDate, setPurchaseDate] = useState(todayIso);
  const [supplierId, setSupplierId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [amountPaid, setAmountPaid] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<PurchaseRowDraft[]>([]);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Quick Add Supplier
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [newSupName, setNewSupName] = useState('');
  const [newSupPhone, setNewSupPhone] = useState('');
  const [newSupAddress, setNewSupAddress] = useState('');

  // Filters & Mobile Expandable State
  const [search, setSearch] = useState('');
  const [filterSupplierId, setFilterSupplierId] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [expandedSupplierId, setExpandedSupplierId] = useState<string | null>(null);
  const [expandedPurchaseId, setExpandedPurchaseId] = useState<string | null>(null);

  // Settle Balance Modal
  const [settlingPurchase, setSettlingPurchase] = useState<Purchase | null>(null);
  const [settleAmount, setSettleAmount] = useState('');
  const [settleMethod, setSettleMethod] = useState<PaymentMethod>('Cash');
  const [settleErr, setSettleErr] = useState<string | null>(null);

  const [dbFallbackProducts, setDbFallbackProducts] = useState<Product[] | null>(null);
  const [dbFallbackSuppliers, setDbFallbackSuppliers] = useState<Supplier[] | null>(null);

  const activeProductsList = products.length > 0 ? products : dbFallbackProducts || [];
  const activeSuppliersList = suppliers.length > 0 ? suppliers : dbFallbackSuppliers || [];

  const productMap = useMemo(
    () => new Map(activeProductsList.map((p) => [p.id, p])),
    [activeProductsList]
  );

  const productOptions = useMemo<SearchableSelectOption[]>(
    () =>
      activeProductsList
        .filter((p) => p.isActive !== false)
        .map((p) => ({
          value: p.id,
          label: p.name,
          subtitle: [p.brandName, p.categoryName].filter(Boolean).join(' · '),
          meta: `Stock: ${formatNumber(p.currentStock)} ${p.unit} | Buy Cost: ${formatPKR(p.purchasePrice)}`,
          badge: p.currentStock <= 0 ? 'Out of Stock' : p.currentStock <= p.minStockLevel ? 'Low Stock' : 'In Stock',
          badgeTone: p.currentStock <= 0 ? 'danger' : p.currentStock <= p.minStockLevel ? 'warning' : 'success',
          keywords: [p.name, p.brandName, p.categoryName, p.supplierName, p.unit].filter(Boolean),
        })),
    [activeProductsList]
  );

  const supplierOptions = useMemo<SearchableSelectOption[]>(
    () =>
      activeSuppliersList.map((s) => ({
        value: s.id,
        label: s.name,
        subtitle: s.phone ? `Phone: ${s.phone}` : s.address || 'No phone on file',
        meta: s.outstandingBalance > 0 ? `Balance Due: ${formatPKR(s.outstandingBalance)}` : 'Settled',
        badge: s.outstandingBalance > 0 ? 'Balance Due' : 'Settled',
        badgeTone: s.outstandingBalance > 0 ? 'warning' : 'success',
        keywords: [s.name, s.phone, s.address].filter(Boolean),
      })),
    [activeSuppliersList]
  );

  const paymentMethodOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: 'Cash', label: 'Cash', subtitle: 'Drawer / physical cash payment' },
      { value: 'Online', label: 'Online', subtitle: 'Bank transfer / mobile wallet' },
    ],
    []
  );

  const frequentProductIds = useMemo(
    () => computeTopActivityValues(purchaseItems, (item) => item.productId, 5),
    [purchaseItems]
  );

  const frequentSupplierIds = useMemo(
    () =>
      computeTopActivityValues(
        purchases.filter((p) => p.status !== 'cancelled'),
        (p) => p.supplierId,
        5
      ),
    [purchases]
  );

  const handleRefreshProducts = async () => {
    if (!activeShopId) return;
    const fetched = await queryOwnerCollectionSlice<Omit<Product, 'id'>>(activeShopId, 'products', 1000);
    setDbFallbackProducts(fetched);
  };

  const handleRefreshSuppliers = async () => {
    if (!activeShopId) return;
    const fetched = await queryOwnerCollectionSlice<Omit<Supplier, 'id'>>(activeShopId, 'suppliers', 1000);
    setDbFallbackSuppliers(fetched);
  };

  const purchaseItemsByPo = useMemo(() => {
    const map = new Map<string, PurchaseItem[]>();
    for (const item of purchaseItems) {
      const arr = map.get(item.purchaseId) || [];
      arr.push(item);
      map.set(item.purchaseId, arr);
    }
    return map;
  }, [purchaseItems]);

  const totalPurchaseAmount = useMemo(() => {
    let total = 0;
    for (const r of rows) {
      const qty = Number(r.quantity) || 0;
      const cost = Number(r.purchasePricePerUnit) || 0;
      if (r.productId && qty > 0) {
        total = roundMoney(total + qty * cost);
      }
    }
    return total;
  }, [rows]);

  const parsedPaid = amountPaid === '' ? totalPurchaseAmount : Math.max(0, Number(amountPaid) || 0);
  const balanceDue = Math.max(0, roundMoney(totalPurchaseAmount - parsedPaid));

  const updateRowProduct = (key: string, productId: string) => {
    const prod = productMap.get(productId);
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? { ...r, productId, purchasePricePerUnit: prod ? String(prod.purchasePrice) : '0' }
          : r
      )
    );
  };

  const handleQuickAddPurchaseProduct = (productId: string) => {
    const prod = productMap.get(productId);
    if (!prod) return;
    setError(null);
    setSuccess(null);

    const existing = rows.find((r) => r.productId === productId);
    if (existing) {
      const curQty = Math.max(1, Math.floor(Number(existing.quantity) || 1));
      const nextQty = curQty + 1;
      setRows((prev) => {
        const updated = { ...existing, quantity: String(nextQty) };
        return [updated, ...prev.filter((r) => r.key !== existing.key)];
      });
      showToast({
        id: 'purchase-product-added',
        title: 'Product updated in purchase',
        message: `${prod.name} (×${formatNumber(nextQty)})`,
        tone: 'success',
        durationMs: 2000,
      });
      return;
    }

    const newKey = `po-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setRows((prev) => [
      {
        key: newKey,
        productId,
        quantity: '1',
        purchasePricePerUnit: String(prod.purchasePrice),
      },
      ...prev.filter((r) => Boolean(r.productId)),
    ]);
    showToast({
      id: 'purchase-product-added',
      title: 'Product added to purchase',
      message: `${prod.name} (${formatPKR(prod.purchasePrice)})`,
      tone: 'success',
      durationMs: 2000,
    });
  };

  const handleSavePurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId) return;
    setError(null);
    setSuccess(null);

    if (!supplierId) {
      setError('Please select or create a supplier.');
      return;
    }

    const activeRows = rows.filter((r) => r.productId);
    if (activeRows.length === 0) {
      setError('Search and add at least one product to record a purchase.');
      return;
    }

    const items: PurchaseLineDraft[] = [];
    for (const r of activeRows) {
      const qty = Number(r.quantity);
      const unitCost = Number(r.purchasePricePerUnit);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
        setError('Enter valid quantities and unit purchase prices.');
        return;
      }
      items.push({ productId: r.productId, quantity: qty, purchasePricePerUnit: unitCost });
    }

    setSubmitting(true);
    try {
      await createPurchase(activeShopId, {
        purchaseDate,
        supplierId,
        paymentMethod,
        amountPaid: parsedPaid,
        notes,
        items,
      });
      setRows([]);
      setExpandedRowKey(null);
      setAmountPaid('');
      setNotes('');
      setSuccess('Purchase recorded, inventory increased, and supplier balance updated.');
      showToast({
        title: 'Purchase saved',
        message: 'Inventory and supplier balance updated.',
        tone: 'success',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save purchase.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateSupplier = async () => {
    if (!activeShopId || !newSupName.trim()) return;
    const id = await createSupplier(activeShopId, {
      name: newSupName.trim(),
      phone: newSupPhone.trim(),
      address: newSupAddress.trim(),
      notes: '',
    });
    setSupplierId(id);
    setNewSupName('');
    setNewSupPhone('');
    setNewSupAddress('');
    setShowNewSupplier(false);
  };

  const handleSettle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId || !settlingPurchase) return;
    setSettleErr(null);
    try {
      await settlePurchaseBalance(activeShopId, settlingPurchase, Number(settleAmount) || 0, settleMethod);
      setSettlingPurchase(null);
    } catch (err) {
      setSettleErr(err instanceof Error ? err.message : 'Failed to record payment.');
    }
  };

  const filteredPurchases = useMemo(() => {
    const q = search.trim().toLowerCase();
    return purchases.filter((p) => {
      if (filterSupplierId && p.supplierId !== filterSupplierId) return false;
      if (filterFrom && p.purchaseDate < filterFrom) return false;
      if (filterTo && p.purchaseDate > filterTo) return false;
      if (q) {
        const items = purchaseItemsByPo.get(p.id) || [];
        const hay = `${p.purchaseNumber} ${p.supplierName} ${items.map((i) => i.productName).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [purchases, purchaseItemsByPo, search, filterSupplierId, filterFrom, filterTo]);

  const supplierStats = useMemo(() => {
    const totalPurchased = suppliers.reduce((acc, s) => roundMoney(acc + (s.totalPurchased || 0)), 0);
    const totalPaid = suppliers.reduce((acc, s) => roundMoney(acc + (s.totalPaid || 0)), 0);
    const totalOwed = suppliers.reduce((acc, s) => roundMoney(acc + (s.outstandingBalance || 0)), 0);
    const withBalanceCount = suppliers.filter((s) => (s.outstandingBalance || 0) > 0).length;

    const openUnpaidBySupplier = new Map<string, Purchase>();
    let openUnpaidCount = 0;
    for (const p of purchases) {
      if (p.status !== 'cancelled' && p.balanceDue > 0) {
        openUnpaidCount += 1;
        if (!openUnpaidBySupplier.has(p.supplierId)) {
          openUnpaidBySupplier.set(p.supplierId, p);
        }
      }
    }

    const sortedSuppliers = [...suppliers].sort((a, b) => {
      const balDiff = (b.outstandingBalance || 0) - (a.outstandingBalance || 0);
      if (balDiff !== 0) return balDiff;
      return a.name.localeCompare(b.name);
    });

    return {
      totalPurchased,
      totalPaid,
      totalOwed,
      withBalanceCount,
      openUnpaidCount,
      openUnpaidBySupplier,
      sortedSuppliers,
    };
  }, [suppliers, purchases]);

  const [showUnpaidOnly, setShowUnpaidOnly] = useState(false);

  const visiblePurchases = useMemo(
    () =>
      showUnpaidOnly
        ? filteredPurchases.filter((p) => p.status !== 'cancelled' && p.balanceDue > 0)
        : filteredPurchases,
    [filteredPurchases, showUnpaidOnly]
  );

  return (
    <div className="space-y-4">
      {/* Supplier Balances Summary Card */}
      <CompactSection
        title="Supplier Balances"
        subtitle="Payables across registered suppliers"
        icon={<Wallet className="w-4 h-4 text-teal-600" />}
        collapsible={true}
        defaultOpen={true}
        summary={
          <span className={supplierStats.totalOwed > 0 ? 'text-amber-700 font-semibold' : 'text-emerald-700 font-semibold'}>
            Owed: {formatPKR(supplierStats.totalOwed)}
          </span>
        }
        actions={
          supplierStats.openUnpaidCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowUnpaidOnly((v) => !v)}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap cursor-pointer ${
                showUnpaidOnly
                  ? 'bg-amber-50 border-amber-200 text-amber-800'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              {showUnpaidOnly ? 'Pending Only' : `Pending (${supplierStats.openUnpaidCount})`}
            </button>
          ) : undefined
        }
        bodyClassName="p-3.5 sm:p-4"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <div className="text-[11px] font-medium text-slate-500">Total Owed</div>
            <div
              className={`text-base sm:text-xl font-bold font-mono-num tabular-nums truncate ${
                supplierStats.totalOwed > 0 ? 'text-amber-700' : 'text-emerald-700'
              }`}
            >
              {formatPKR(supplierStats.totalOwed)}
            </div>
            <div className="text-[11px] text-slate-500">
              {supplierStats.totalOwed > 0 ? 'Upcoming dues' : 'All settled'}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-medium text-slate-500">With Balance</div>
            <div className="text-base sm:text-xl font-bold font-mono-num tabular-nums text-slate-900">
              {supplierStats.withBalanceCount} / {suppliers.length}
            </div>
            <div className="text-[11px] text-slate-500">
              {supplierStats.openUnpaidCount} unpaid POs
            </div>
          </div>

          <div>
            <div className="text-[11px] font-medium text-slate-500">Total Purchased</div>
            <div className="text-base sm:text-xl font-bold font-mono-num tabular-nums text-slate-900 truncate">
              {formatPKR(supplierStats.totalPurchased)}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-medium text-slate-500">Total Paid</div>
            <div className="text-base sm:text-xl font-bold font-mono-num tabular-nums text-emerald-700 truncate">
              {formatPKR(supplierStats.totalPaid)}
            </div>
          </div>
        </div>
      </CompactSection>

      {/* Purchase Entry Form */}
      <section className="bg-white border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm sm:text-base font-semibold text-slate-900">Purchase &amp; Stock Entry</h2>
            <p className="text-[11px] sm:text-xs text-slate-500">
              Add products quickly, tap any row to edit qty or cost. Stock &amp; supplier balances update automatically.
            </p>
          </div>
          {rows.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setRows([]);
                setExpandedRowKey(null);
              }}
              className="text-xs font-medium text-slate-500 hover:text-red-600 cursor-pointer"
            >
              Clear ({formatNumber(rows.length)})
            </button>
          )}
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-700">{error}</div>
        )}
        {success && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs sm:text-sm text-emerald-700 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        <form onSubmit={handleSavePurchase} className="space-y-3.5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Purchase Date *</label>
              <input
                type="date"
                required
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                className="w-full min-h-[40px] px-2.5 py-1.5 text-xs sm:text-sm border border-slate-200 rounded-lg font-mono-num"
              />
            </div>

            <div>
              <span className="block text-[11px] font-medium text-slate-600 mb-1">Payment</span>
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200 min-h-[40px]">
                {(['Cash', 'Online'] as PaymentMethod[]).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setPaymentMethod(method)}
                    className={`text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
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

            <div className="col-span-2 lg:col-span-1">
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-slate-600">Supplier *</label>
                <button
                  type="button"
                  onClick={() => setShowNewSupplier((v) => !v)}
                  className="text-[11px] font-semibold text-teal-700 hover:underline cursor-pointer"
                >
                  + New Supplier
                </button>
              </div>
              <SearchableSelect
                required
                size="sm"
                ariaLabel="Select supplier"
                suggestionScope="supplier"
                suggestedValues={frequentSupplierIds}
                options={supplierOptions}
                value={supplierId}
                onChange={(val) => setSupplierId(val)}
                placeholder="Search supplier..."
                searchPlaceholder="Type supplier name or phone..."
                noResultsMessage="No matching suppliers found"
                onRefreshOptions={handleRefreshSuppliers}
              />
            </div>

            <div className="col-span-2 lg:col-span-1">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Amount Paid (PKR)
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder={`Full (${totalPurchaseAmount})`}
                value={amountPaid}
                onChange={(e) => setAmountPaid(e.target.value)}
                className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg font-mono-num"
              />
            </div>
          </div>

          {showNewSupplier && (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
              <div>
                <label className="block text-xs text-slate-600 mb-1">Supplier Name *</label>
                <input
                  type="text"
                  value={newSupName}
                  onChange={(e) => setNewSupName(e.target.value)}
                  placeholder="e.g., Metro Distributors"
                  className="w-full min-h-[38px] px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">Phone</label>
                <input
                  type="text"
                  value={newSupPhone}
                  onChange={(e) => setNewSupPhone(e.target.value)}
                  placeholder="0300-1234567"
                  className="w-full min-h-[38px] px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg bg-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">Address</label>
                <input
                  type="text"
                  value={newSupAddress}
                  onChange={(e) => setNewSupAddress(e.target.value)}
                  placeholder="City / Market"
                  className="w-full min-h-[38px] px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg bg-white"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleCreateSupplier()}
                  className="min-h-[38px] px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 rounded-lg cursor-pointer"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setShowNewSupplier(false)}
                  className="min-h-[38px] px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg bg-white cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Quick Add Purchase Product Bar */}
          <div className="p-3 bg-teal-50/40 border border-teal-200/80 rounded-xl space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="quick-add-purchase-product"
                className="block text-xs font-semibold text-slate-800"
              >
                Quick Add Product
              </label>
              <button
                type="button"
                onClick={() => {
                  const key = `po-${Date.now()}`;
                  setRows((prev) => [
                    { key, productId: '', quantity: '1', purchasePricePerUnit: '0' },
                    ...prev,
                  ]);
                  setExpandedRowKey(key);
                }}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-700 cursor-pointer"
              >
                <Plus className="w-3 h-3" /> Blank Row
              </button>
            </div>
            <SearchableSelect
              inputId="quick-add-purchase-product"
              ariaLabel="Quick add purchase product"
              suggestionScope="product"
              suggestedValues={frequentProductIds}
              options={productOptions}
              value=""
              onChange={(val) => {
                if (val) handleQuickAddPurchaseProduct(val);
              }}
              placeholder="Search products by name, brand or category..."
              searchPlaceholder="Search products by name, brand or category..."
              noResultsMessage="No products found"
              onRefreshOptions={handleRefreshProducts}
            />
          </div>

          {/* Compact Collapsible Purchased Products List */}
          {rows.length === 0 ? (
            <div className="border border-dashed border-slate-200 rounded-xl py-4 px-3 text-center text-xs text-slate-500">
              No products added yet. Search above to add products to this purchase.
            </div>
          ) : (
            <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-[11px] font-semibold text-slate-600">
                <span>Purchased Items ({formatNumber(rows.length)})</span>
                <span>Tap row to edit</span>
              </div>
              <div className="divide-y divide-slate-100 max-h-[340px] overflow-y-auto overscroll-contain">
                {rows.map((row) => {
                  const selectedProd = productMap.get(row.productId);
                  const qty = Number(row.quantity) || 0;
                  const cost = Number(row.purchasePricePerUnit) || 0;
                  const lineTotal = roundMoney(qty * cost);
                  const isExpanded = expandedRowKey === row.key || !row.productId;

                  return (
                    <div key={row.key}>
                      <div className="flex items-center gap-2 px-3 py-2 min-h-[48px] hover:bg-slate-50/70">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedRowKey((cur) => (cur === row.key ? null : row.key))
                          }
                          aria-expanded={isExpanded}
                          className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left cursor-pointer"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-slate-400 shrink-0">
                              {isExpanded ? (
                                <ChevronDown className="w-4 h-4 text-teal-600" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )}
                            </span>
                            <div className="min-w-0">
                              <div className="text-xs sm:text-sm font-medium text-slate-900 truncate">
                                {selectedProd ? selectedProd.name : 'Select product...'}
                              </div>
                              <div className="text-[11px] text-slate-500 font-mono-num tabular-nums truncate">
                                {formatNumber(qty)} × {formatPKR(cost)}
                                {selectedProd ? ` · Stock: ${formatNumber(selectedProd.currentStock)}` : ''}
                              </div>
                            </div>
                          </div>
                          <div className="text-xs sm:text-sm font-bold font-mono-num tabular-nums text-slate-900 whitespace-nowrap shrink-0">
                            {formatPKR(lineTotal)}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRows((prev) => prev.filter((r) => r.key !== row.key));
                            setExpandedRowKey((cur) => (cur === row.key ? null : cur));
                          }}
                          aria-label="Remove product row"
                          className="p-2 text-slate-400 hover:text-red-600 rounded-lg cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="px-3 py-2.5 bg-slate-50 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                          <div className="sm:col-span-6">
                            <label className="block text-[11px] font-medium text-slate-600 mb-1">Product</label>
                            <SearchableSelect
                              size="sm"
                              ariaLabel="Select purchased product"
                              suggestionScope="product"
                              suggestedValues={frequentProductIds}
                              options={productOptions}
                              value={row.productId}
                              onChange={(val) => updateRowProduct(row.key, val)}
                              placeholder="Search product..."
                              searchPlaceholder="Type product name or brand..."
                              noResultsMessage="No products found"
                              onRefreshOptions={handleRefreshProducts}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2 sm:col-span-6">
                            <div>
                              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                                Qty {selectedProd ? `(${selectedProd.unit})` : ''}
                              </label>
                              <input
                                type="number"
                                min={1}
                                value={row.quantity}
                                onChange={(e) =>
                                  setRows((prev) =>
                                    prev.map((r) => (r.key === row.key ? { ...r, quantity: e.target.value } : r))
                                  )
                                }
                                className="w-full min-h-[38px] px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg bg-white font-mono-num"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                                Unit Cost (PKR)
                              </label>
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                value={row.purchasePricePerUnit}
                                onChange={(e) =>
                                  setRows((prev) =>
                                    prev.map((r) =>
                                      r.key === row.key ? { ...r, purchasePricePerUnit: e.target.value } : r
                                    )
                                  )
                                }
                                className="w-full min-h-[38px] px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg bg-white font-mono-num"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">Notes (Optional)</label>
            <input
              type="text"
              maxLength={500}
              placeholder="Invoice reference or delivery details"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full min-h-[40px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
            />
          </div>

          {/* Sticky Bottom Purchase Summary & Save Bar */}
          <div className="sticky bottom-2 z-20 bg-white/95 backdrop-blur-md border border-slate-200 rounded-xl shadow-md px-3.5 py-2.5 sm:px-4 flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-4 sm:gap-6">
              <div className="min-w-0">
                <div className="text-[11px] text-slate-500 font-mono-num tabular-nums leading-tight">
                  {formatNumber(rows.filter((r) => Boolean(r.productId)).length)} items · Total
                </div>
                <div className="text-base sm:text-lg font-bold font-mono-num tabular-nums text-slate-900 leading-tight truncate">
                  {formatPKR(totalPurchaseAmount)}
                </div>
              </div>
              <div className="border-l border-slate-200 pl-3 sm:pl-4">
                <div className="text-[11px] text-slate-500 leading-tight">Balance Due</div>
                <div
                  className={`text-xs sm:text-sm font-bold font-mono-num tabular-nums leading-tight ${
                    balanceDue > 0 ? 'text-amber-600' : 'text-emerald-700'
                  }`}
                >
                  {formatPKR(balanceDue)}
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || products.length === 0}
              className="min-h-[44px] px-4 sm:px-5 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 active:scale-[0.98] disabled:opacity-50 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
            >
              {submitting ? 'Saving...' : 'Save Purchase'}
            </button>
          </div>
        </form>
      </section>

      {/* Supplier Balances Breakdown */}
      {suppliers.length > 0 && (
        <CompactSection
          title="Supplier-Wise Balances"
          summary={`Owed: ${formatPKR(supplierStats.totalOwed)}`}
          collapsible={true}
          defaultOpen={true}
        >
          {/* Mobile Expandable Supplier List */}
          <div className="md:hidden divide-y divide-slate-100">
            {supplierStats.sortedSuppliers.map((s) => {
              const firstUnpaidPo = supplierStats.openUnpaidBySupplier.get(s.id);
              const hasDue = (s.outstandingBalance || 0) > 0;
              return (
                <CompactExpandableRow
                  key={s.id}
                  title={s.name}
                  subtitle={s.phone || s.address || 'No phone on file'}
                  rightPrimary={
                    <span className={hasDue ? 'text-amber-700' : 'text-emerald-700'}>
                      {formatPKR(s.outstandingBalance)}
                    </span>
                  }
                  rightSecondary={hasDue ? 'Payment Due' : 'Settled'}
                  isExpanded={expandedSupplierId === s.id}
                  onToggle={() =>
                    setExpandedSupplierId((cur) => (cur === s.id ? null : s.id))
                  }
                  expandedContent={
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div>
                          <span className="text-slate-500">Purchased:</span>{' '}
                          <span className="font-mono-num font-semibold text-slate-900">
                            {formatPKR(s.totalPurchased)}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500">Paid:</span>{' '}
                          <span className="font-mono-num font-semibold text-emerald-700">
                            {formatPKR(s.totalPaid)}
                          </span>
                        </div>
                      </div>
                      <div className="flex justify-end">
                        {firstUnpaidPo ? (
                          <button
                            type="button"
                            onClick={() => {
                              setSettlingPurchase(firstUnpaidPo);
                              setSettleAmount(String(firstUnpaidPo.balanceDue));
                              setSettleMethod('Cash');
                              setSettleErr(null);
                            }}
                            className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-teal-700 bg-white border border-teal-200 rounded-lg cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> Pay Due
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setFilterSupplierId(s.id)}
                            className="min-h-[36px] px-3 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg cursor-pointer"
                          >
                            Filter POs
                          </button>
                        )}
                      </div>
                    </div>
                  }
                />
              );
            })}
          </div>

          {/* Desktop Dense Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-2.5 px-3">Supplier</th>
                  <th className="py-2.5 px-3">Phone</th>
                  <th className="py-2.5 px-3 text-right">Total Purchased</th>
                  <th className="py-2.5 px-3 text-right">Total Paid</th>
                  <th className="py-2.5 px-3 text-right">Outstanding</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                {supplierStats.sortedSuppliers.map((s) => {
                  const firstUnpaidPo = supplierStats.openUnpaidBySupplier.get(s.id);
                  const hasDue = (s.outstandingBalance || 0) > 0;
                  return (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="py-2 px-3 font-medium text-slate-900">{s.name}</td>
                      <td className="py-2 px-3 font-mono-num tabular-nums text-xs text-slate-600">
                        {s.phone || '—'}
                      </td>
                      <td className="py-2 px-3 text-right font-mono-num tabular-nums">
                        {formatPKR(s.totalPurchased)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono-num tabular-nums text-emerald-700">
                        {formatPKR(s.totalPaid)}
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-mono-num tabular-nums font-semibold ${
                          hasDue ? 'text-amber-700' : 'text-slate-600'
                        }`}
                      >
                        {formatPKR(s.outstandingBalance)}
                      </td>
                      <td
                        className={`py-2 px-3 text-xs font-semibold whitespace-nowrap ${
                          hasDue ? 'text-amber-700' : 'text-emerald-700'
                        }`}
                      >
                        {hasDue ? 'Payment Due' : 'Settled'}
                      </td>
                      <td className="py-2 px-3 text-right whitespace-nowrap">
                        {firstUnpaidPo ? (
                          <button
                            type="button"
                            onClick={() => {
                              setSettlingPurchase(firstUnpaidPo);
                              setSettleAmount(String(firstUnpaidPo.balanceDue));
                              setSettleMethod('Cash');
                              setSettleErr(null);
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-700 border border-slate-200 hover:bg-teal-50 rounded cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> Pay Due
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setFilterSupplierId(s.id)}
                            className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                          >
                            View POs
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CompactSection>
      )}

      {/* Purchase History */}
      <CompactSection
        title="Purchase History"
        summary={`${formatNumber(visiblePurchases.length)} orders`}
        collapsible={true}
        defaultOpen={true}
        actions={
          <button
            type="button"
            onClick={() => setShowMobileFilters((v) => !v)}
            className="lg:hidden inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
          >
            <Filter className="w-3.5 h-3.5" />
            <span>{showMobileFilters ? 'Hide' : 'Filters'}</span>
          </button>
        }
      >
        <div className="p-3 sm:p-4 border-b border-slate-200 space-y-2">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-2">
            <div className="relative lg:col-span-4">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search PO #, supplier, product..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full min-h-[38px] pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div
              className={`${
                showMobileFilters ? 'grid' : 'hidden lg:grid'
              } lg:col-span-8 grid-cols-2 sm:grid-cols-3 gap-2`}
            >
              <div className="col-span-2 sm:col-span-1">
                <SearchableSelect
                  size="sm"
                  ariaLabel="Filter by supplier"
                  suggestionScope="supplier"
                  suggestedValues={frequentSupplierIds}
                  options={supplierOptions}
                  value={filterSupplierId}
                  onChange={(val) => setFilterSupplierId(val)}
                  emptyOptionLabel="All Suppliers"
                  placeholder="All Suppliers"
                  searchPlaceholder="Search supplier..."
                  onRefreshOptions={handleRefreshSuppliers}
                />
              </div>
              <input
                type="date"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
                className="w-full min-h-[38px] px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg font-mono-num"
              />
              <input
                type="date"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
                className="w-full min-h-[38px] px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg font-mono-num"
              />
            </div>
          </div>
        </div>

        {visiblePurchases.length === 0 ? (
          <div className="p-6 text-center text-xs sm:text-sm text-slate-500">
            {showUnpaidOnly ? 'No pending unpaid purchase orders match your filters.' : 'No purchases recorded yet.'}
          </div>
        ) : (
          <>
            {/* Mobile Compact Expandable List */}
            <div className="md:hidden divide-y divide-slate-100">
              {visiblePurchases.map((p) => {
                const items = purchaseItemsByPo.get(p.id) || [];
                const isCancelled = p.status === 'cancelled';
                return (
                  <CompactExpandableRow
                    key={p.id}
                    dimmed={isCancelled}
                    title={
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="font-mono-num">{p.purchaseNumber}</span>
                        <span className="text-slate-400">·</span>
                        <span className="truncate font-normal text-slate-600">{p.supplierName}</span>
                      </span>
                    }
                    subtitle={`${formatDateDDMMYYYY(p.purchaseDate)} · ${items.length} items`}
                    rightPrimary={formatPKR(p.totalAmount)}
                    rightSecondary={
                      isCancelled ? (
                        <span className="text-red-600">Cancelled</span>
                      ) : p.balanceDue > 0 ? (
                        <span className="text-amber-700 font-semibold">Due: {formatPKR(p.balanceDue)}</span>
                      ) : (
                        <span className="text-emerald-700">Paid</span>
                      )
                    }
                    isExpanded={expandedPurchaseId === p.id}
                    onToggle={() =>
                      setExpandedPurchaseId((cur) => (cur === p.id ? null : p.id))
                    }
                    expandedContent={
                      <div className="space-y-2">
                        <div className="space-y-1 bg-white border border-slate-200 rounded-lg p-2">
                          {items.map((item) => (
                            <div key={item.id} className="flex items-center justify-between gap-2 text-xs">
                              <span className="truncate text-slate-800">
                                {item.productName}{' '}
                                <span className="text-slate-500 font-mono-num">×{item.quantity}</span>
                              </span>
                              <span className="font-mono-num font-semibold text-slate-900 shrink-0">
                                {formatPKR(item.lineTotal)}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-between text-xs text-slate-600">
                          <span>Paid: <strong className="font-mono-num text-emerald-700">{formatPKR(p.amountPaid)}</strong></span>
                          <span>Due: <strong className="font-mono-num text-amber-700">{formatPKR(p.balanceDue)}</strong></span>
                        </div>
                        {!isCancelled && (
                          <div className="flex items-center justify-end gap-2">
                            {p.balanceDue > 0 && (
                              <button
                                type="button"
                                onClick={() => {
                                  setSettlingPurchase(p);
                                  setSettleAmount(String(p.balanceDue));
                                  setSettleMethod('Cash');
                                  setSettleErr(null);
                                }}
                                className="min-h-[36px] inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold text-teal-700 bg-white border border-teal-200 rounded-lg cursor-pointer"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" /> Pay Due
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => activeShopId && void cancelPurchase(activeShopId, p)}
                              className="min-h-[36px] inline-flex items-center gap-1 px-3 py-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg cursor-pointer"
                            >
                              <Ban className="w-3.5 h-3.5" /> Cancel PO
                            </button>
                          </div>
                        )}
                      </div>
                    }
                  />
                );
              })}
            </div>

            {/* Desktop Dense Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">PO #</th>
                    <th className="py-2.5 px-3">Supplier</th>
                    <th className="py-2.5 px-3">Products</th>
                    <th className="py-2.5 px-3 text-right">Total</th>
                    <th className="py-2.5 px-3 text-right">Paid</th>
                    <th className="py-2.5 px-3 text-right">Due</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {visiblePurchases.map((p) => {
                    const items = purchaseItemsByPo.get(p.id) || [];
                    const summary = items.map((i) => `${i.productName} ×${i.quantity}`).join(', ');
                    const isCancelled = p.status === 'cancelled';

                    return (
                      <tr key={p.id} className={`hover:bg-slate-50 ${isCancelled ? 'opacity-60' : ''}`}>
                        <td className="py-2 px-3 font-mono-num whitespace-nowrap text-xs">
                          {formatDateDDMMYYYY(p.purchaseDate)}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-xs font-medium">{p.purchaseNumber}</td>
                        <td className="py-2 px-3 text-slate-800">{p.supplierName}</td>
                        <td className="py-2 px-3 text-slate-600 max-w-xs truncate" title={summary}>
                          {summary}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num font-semibold">
                          {formatPKR(p.totalAmount)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num text-emerald-700">
                          {formatPKR(p.amountPaid)}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono-num font-semibold ${
                            p.balanceDue > 0 ? 'text-amber-700' : 'text-slate-500'
                          }`}
                        >
                          {formatPKR(p.balanceDue)}
                        </td>
                        <td className="py-2 px-3 text-xs font-semibold">
                          <span className={isCancelled ? 'text-red-600' : 'text-emerald-700'}>
                            {isCancelled ? 'Cancelled' : 'Completed'}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          {!isCancelled && (
                            <div className="inline-flex items-center gap-1">
                              {p.balanceDue > 0 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSettlingPurchase(p);
                                    setSettleAmount(String(p.balanceDue));
                                    setSettleMethod('Cash');
                                    setSettleErr(null);
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-teal-700 border border-slate-200 hover:bg-teal-50 rounded cursor-pointer"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" /> Pay Due
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => activeShopId && void cancelPurchase(activeShopId, p)}
                                className="p-1.5 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                                title="Cancel purchase"
                              >
                                <Ban className="w-4 h-4" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CompactSection>

      {/* Settle Supplier Balance Modal */}
      {settlingPurchase && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-semibold text-slate-900">
                Pay Balance — {settlingPurchase.purchaseNumber}
              </h3>
              <button
                type="button"
                onClick={() => setSettlingPurchase(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {settleErr && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {settleErr}
              </div>
            )}
            <form onSubmit={handleSettle} className="space-y-4">
              <div className="text-xs text-slate-500">
                Supplier: <span className="font-semibold text-slate-900">{settlingPurchase.supplierName}</span> ·
                Due: <span className="font-semibold font-mono-num text-amber-700">{formatPKR(settlingPurchase.balanceDue)}</span>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Payment Amount (PKR)</label>
                <input
                  type="number"
                  min={1}
                  max={settlingPurchase.balanceDue}
                  step="0.01"
                  required
                  value={settleAmount}
                  onChange={(e) => setSettleAmount(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Payment Method</label>
                <SearchableSelect
                  ariaLabel="Payment method for settlement"
                  showFrequentSection={false}
                  options={paymentMethodOptions}
                  value={settleMethod}
                  onChange={(val) => setSettleMethod((val || 'Cash') as PaymentMethod)}
                  placeholder="Select payment method..."
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSettlingPurchase(null)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg"
                >
                  Record Payment
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
