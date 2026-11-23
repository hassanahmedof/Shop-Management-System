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
import {
  formatStockBreakdown,
  getAllowedPurchaseUnits,
  getDefaultPurchaseUnit,
  getEffectiveBaseUnit,
  isFractionalUnit,
  pluralizeUnit,
  roundStockQty,
} from '../utils/packaging';

interface PurchaseRowDraft {
  key: string;
  productId: string;
  unitName: string;
  conversionFactor: number;
  quantity: string;
  purchasePricePerUnit: string;
  expiryDate: string;
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
        .map((p) => {
          const defUnit = getDefaultPurchaseUnit(p);
          const bd = formatStockBreakdown(p.currentStock, p);
          return {
            value: p.id,
            label: p.name,
            subtitle: [p.brandName, p.categoryName, p.bottleSize].filter(Boolean).join(' · '),
            meta: `Stock: ${bd.summaryText} · ${defUnit.unitName}: ${formatPKR(defUnit.purchasePrice)}`,
            badge: p.currentStock <= 0 ? 'Out of Stock' : p.currentStock <= p.minStockLevel ? 'Low Stock' : 'In Stock',
            badgeTone: p.currentStock <= 0 ? 'danger' : p.currentStock <= p.minStockLevel ? 'warning' : 'success',
            keywords: [p.name, p.brandName, p.categoryName, p.supplierName, p.unit, defUnit.unitName].filter(Boolean),
          };
        }),
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
    const defUnit = prod ? getDefaultPurchaseUnit(prod) : null;
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? {
              ...r,
              productId,
              unitName: defUnit ? defUnit.unitName : '',
              conversionFactor: defUnit ? defUnit.conversionQty : 1,
              purchasePricePerUnit: defUnit ? String(defUnit.purchasePrice) : '0',
            }
          : r
      )
    );
  };

  const updateRowUnit = (key: string, newUnitName: string) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const prod = productMap.get(r.productId);
        if (!prod) return r;
        const allowed = getAllowedPurchaseUnits(prod);
        const picked = allowed.find((u) => u.unitName === newUnitName);
        if (!picked) return r;
        return {
          ...r,
          unitName: picked.unitName,
          conversionFactor: picked.conversionQty,
          purchasePricePerUnit: String(picked.purchasePrice),
        };
      })
    );
  };

  const handleQuickAddPurchaseProduct = (productId: string) => {
    const prod = productMap.get(productId);
    if (!prod) return;
    setError(null);
    setSuccess(null);

    const defUnit = getDefaultPurchaseUnit(prod);
    const existing = rows.find(
      (r) => r.productId === productId && r.unitName === defUnit.unitName
    );
    if (existing) {
      const curQty = Math.max(1, Number(existing.quantity) || 1);
      const nextQty = roundStockQty(curQty + 1);
      setRows((prev) => {
        const updated = { ...existing, quantity: String(nextQty) };
        return [updated, ...prev.filter((r) => r.key !== existing.key)];
      });
      showToast({
        id: 'purchase-product-added',
        title: 'Product updated in purchase',
        message: `${prod.name} (×${formatNumber(nextQty)} ${defUnit.unitName})`,
        tone: 'success',
        durationMs: 2000,
      });
      return;
    }

    const newKey = `po-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const hasMultipleUnits = getAllowedPurchaseUnits(prod).length > 1;
    setRows((prev) => [
      {
        key: newKey,
        productId,
        unitName: defUnit.unitName,
        conversionFactor: defUnit.conversionQty,
        quantity: '1',
        purchasePricePerUnit: String(defUnit.purchasePrice),
        expiryDate: prod.expiryDate || '',
      },
      ...prev.filter((r) => Boolean(r.productId)),
    ]);
    if (hasMultipleUnits) {
      setExpandedRowKey(newKey);
    }
    showToast({
      id: 'purchase-product-added',
      title: 'Product added to purchase',
      message: `${prod.name} (${defUnit.unitName} · ${formatPKR(defUnit.purchasePrice)})`,
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
      const qty = roundStockQty(Number(r.quantity));
      const unitCost = Number(r.purchasePricePerUnit);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
        setError('Enter valid quantities and unit purchase prices.');
        return;
      }
      items.push({
        productId: r.productId,
        unitName: r.unitName || undefined,
        conversionFactor: r.conversionFactor || 1,
        expiryDate: r.expiryDate || '',
        quantity: qty,
        purchasePricePerUnit: unitCost,
      });
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
      setSuccess('Purchase recorded, FIFO batch & inventory increased, and supplier balance updated.');
      showToast({
        title: 'Purchase saved',
        message: 'FIFO inventory batch & supplier balance updated.',
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

  const handleCancelPurchase = async (purchase: Purchase) => {
    if (!activeShopId) return;
    setError(null);
    try {
      await cancelPurchase(activeShopId, purchase, 'Cancelled from purchase history');
      showToast({
        title: 'Purchase cancelled',
        message: `${purchase.purchaseNumber} cancelled and stock reversed.`,
        tone: 'success',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to cancel purchase.';
      setError(msg);
      showToast({
        title: 'Cannot cancel purchase',
        message: msg,
        tone: 'error',
      });
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
        icon={<Wallet className="w-4 h-4 text-[var(--cm-accent-text)]" />}
        collapsible={true}
        defaultOpen={true}
        summary={
          <span
            className={
              supplierStats.totalOwed > 0
                ? 'text-[var(--cm-warning)] font-semibold'
                : 'text-[var(--cm-success)] font-semibold'
            }
          >
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
                  ? 'bg-[var(--cm-warning-soft)] border-[var(--cm-warning-border)] text-[var(--cm-warning)]'
                  : 'cm-surface border hover:bg-[var(--cm-bg-hover)] text-[var(--cm-text-secondary)]'
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
            <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Total Owed</div>
            <div
              className={`text-base sm:text-xl font-bold font-mono-num tabular-nums truncate ${
                supplierStats.totalOwed > 0 ? 'text-[var(--cm-warning)]' : 'text-[var(--cm-success)]'
              }`}
            >
              {formatPKR(supplierStats.totalOwed)}
            </div>
            <div className="text-[11px] text-[var(--cm-text-muted)]">
              {supplierStats.totalOwed > 0 ? 'Upcoming dues' : 'All settled'}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">With Balance</div>
            <div className="text-base sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)]">
              {supplierStats.withBalanceCount} / {suppliers.length}
            </div>
            <div className="text-[11px] text-[var(--cm-text-muted)]">
              {supplierStats.openUnpaidCount} unpaid POs
            </div>
          </div>

          <div>
            <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Total Purchased</div>
            <div className="text-base sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)] truncate">
              {formatPKR(supplierStats.totalPurchased)}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Total Paid</div>
            <div className="text-base sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-success)] truncate">
              {formatPKR(supplierStats.totalPaid)}
            </div>
          </div>
        </div>
      </CompactSection>

      {/* Purchase Entry Form */}
      <section className="cm-surface border rounded-xl p-3.5 sm:p-4 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">
              Purchase &amp; Stock Entry
            </h2>
            <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
              Purchase in Pack, Carton, Crate, or Base Unit. Stock auto-converts and creates a FIFO cost lot.
            </p>
          </div>
          {rows.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setRows([]);
                setExpandedRowKey(null);
              }}
              className="text-xs font-medium text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] cursor-pointer"
            >
              Clear ({formatNumber(rows.length)})
            </button>
          )}
        </div>

        {error && (
          <div className="p-3 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg text-xs sm:text-sm text-[var(--cm-danger)]">
            {error}
          </div>
        )}
        {success && (
          <div className="p-3 bg-[var(--cm-success-soft)] border border-[var(--cm-success-border)] rounded-lg text-xs sm:text-sm text-[var(--cm-success)] flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        <form onSubmit={handleSavePurchase} className="space-y-3.5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Purchase Date *
              </label>
              <input
                type="date"
                required
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                className="cm-input w-full min-h-[40px] px-2.5 py-1.5 text-xs sm:text-sm border rounded-lg font-mono-num"
              />
            </div>

            <div>
              <span className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Payment
              </span>
              <div className="grid grid-cols-2 gap-1 p-1 bg-[var(--cm-bg-subtle)] rounded-lg border border-[var(--cm-border)] min-h-[40px]">
                {(['Cash', 'Online'] as PaymentMethod[]).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setPaymentMethod(method)}
                    className={`text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      paymentMethod === method
                        ? 'cm-surface border text-[var(--cm-accent-text)] shadow-2xs'
                        : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
                    }`}
                  >
                    {method}
                  </button>
                ))}
              </div>
            </div>

            <div className="col-span-2 lg:col-span-1">
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-[var(--cm-text-secondary)]">Supplier *</label>
                <button
                  type="button"
                  onClick={() => setShowNewSupplier((v) => !v)}
                  className="text-[11px] font-semibold text-[var(--cm-accent-text)] hover:underline cursor-pointer"
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
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Amount Paid (PKR)
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder={`Full (${totalPurchaseAmount})`}
                value={amountPaid}
                onChange={(e) => setAmountPaid(e.target.value)}
                className="cm-input w-full min-h-[40px] px-3 py-1.5 text-sm border rounded-lg font-mono-num"
              />
            </div>
          </div>

          {showNewSupplier && (
            <div className="p-3 cm-subtle border rounded-lg grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
              <div>
                <label className="block text-xs text-[var(--cm-text-secondary)] mb-1">Supplier Name *</label>
                <input
                  type="text"
                  value={newSupName}
                  onChange={(e) => setNewSupName(e.target.value)}
                  placeholder="e.g., Metro Distributors"
                  className="cm-input w-full min-h-[38px] px-2.5 py-1.5 text-sm border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--cm-text-secondary)] mb-1">Phone</label>
                <input
                  type="text"
                  value={newSupPhone}
                  onChange={(e) => setNewSupPhone(e.target.value)}
                  placeholder="0300-1234567"
                  className="cm-input w-full min-h-[38px] px-2.5 py-1.5 text-sm border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--cm-text-secondary)] mb-1">Address</label>
                <input
                  type="text"
                  value={newSupAddress}
                  onChange={(e) => setNewSupAddress(e.target.value)}
                  placeholder="City / Market"
                  className="cm-input w-full min-h-[38px] px-2.5 py-1.5 text-sm border rounded-lg"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleCreateSupplier()}
                  className="min-h-[38px] px-3 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setShowNewSupplier(false)}
                  className="min-h-[38px] px-3 py-1.5 text-xs font-medium text-[var(--cm-text-secondary)] cm-surface border rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Quick Add Purchase Product Bar */}
          <div className="p-3 bg-[var(--cm-accent-soft)] border border-[var(--cm-accent-border)] rounded-xl space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="quick-add-purchase-product"
                className="block text-xs font-semibold text-[var(--cm-text-primary)]"
              >
                Quick Add Product
              </label>
              <button
                type="button"
                onClick={() => {
                  const key = `po-${Date.now()}`;
                  setRows((prev) => [
                    {
                      key,
                      productId: '',
                      unitName: '',
                      conversionFactor: 1,
                      quantity: '1',
                      purchasePricePerUnit: '0',
                      expiryDate: '',
                    },
                    ...prev,
                  ]);
                  setExpandedRowKey(key);
                }}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--cm-accent-text)] cursor-pointer"
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
            <div className="border border-dashed border-[var(--cm-border-strong)] rounded-xl py-4 px-3 text-center text-xs text-[var(--cm-text-muted)]">
              No products added yet. Search above to add products to this purchase.
            </div>
          ) : (
            <div className="border border-[var(--cm-border)] rounded-xl cm-surface">
              <div className="px-3 py-2 bg-[var(--cm-bg-subtle)] border-b border-[var(--cm-border)] rounded-t-[11px] flex items-center justify-between text-[11px] font-semibold text-[var(--cm-text-secondary)]">
                <span>Purchased Items ({formatNumber(rows.length)})</span>
                <span>Tap row to edit unit, cost or expiry</span>
              </div>
              <div className="divide-y divide-[var(--cm-border)]">
                {rows.map((row) => {
                  const selectedProd = productMap.get(row.productId);
                  const allowedUnits = selectedProd ? getAllowedPurchaseUnits(selectedProd) : [];
                  const baseUnit = getEffectiveBaseUnit(selectedProd);
                  const displayUnit = row.unitName || baseUnit;
                  const qty = Number(row.quantity) || 0;
                  const cost = Number(row.purchasePricePerUnit) || 0;
                  const lineTotal = roundMoney(qty * cost);
                  const baseDelta = roundStockQty(qty * (row.conversionFactor || 1));
                  const isExpanded = expandedRowKey === row.key || !row.productId;
                  const allowFractional = isFractionalUnit(displayUnit);

                  return (
                    <div key={row.key} className="group last:rounded-b-[11px]">
                      <div className="flex items-center gap-2 px-3 py-2 min-h-[48px] hover:bg-[var(--cm-bg-hover)]">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedRowKey((cur) => (cur === row.key ? null : row.key))
                          }
                          aria-expanded={isExpanded}
                          className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left cursor-pointer"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[var(--cm-text-muted)] shrink-0">
                              {isExpanded ? (
                                <ChevronDown className="w-4 h-4 text-[var(--cm-accent-text)]" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )}
                            </span>
                            <div className="min-w-0">
                              <div className="text-xs sm:text-sm font-medium text-[var(--cm-text-primary)] truncate">
                                {selectedProd ? selectedProd.name : 'Select product...'}
                              </div>
                              <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums truncate">
                                {formatNumber(qty)} {displayUnit} × {formatPKR(cost)}
                                {selectedProd && row.conversionFactor > 1
                                  ? ` (= +${formatNumber(baseDelta)} ${pluralizeUnit(baseUnit, baseDelta)})`
                                  : ''}
                                {row.expiryDate ? ` · Exp ${formatDateDDMMYYYY(row.expiryDate)}` : ''}
                              </div>
                            </div>
                          </div>
                          <div className="text-xs sm:text-sm font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)] whitespace-nowrap shrink-0">
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
                          className="p-2 text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] rounded-lg cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      {isExpanded && (
                        <div className="px-3 py-2.5 cm-subtle border-t border-[var(--cm-border)] group-last:rounded-b-[11px] grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                          <div className="sm:col-span-4">
                            <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                              Product
                            </label>
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

                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:col-span-8">
                            <div>
                              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                                Purchase Unit
                              </label>
                              <select
                                value={displayUnit}
                                disabled={!selectedProd || allowedUnits.length <= 1}
                                onChange={(e) => updateRowUnit(row.key, e.target.value)}
                                className="cm-input w-full min-h-[38px] px-2 py-1.5 text-xs border rounded-lg disabled:opacity-70"
                              >
                                {allowedUnits.length === 0 ? (
                                  <option value="">Unit</option>
                                ) : (
                                  allowedUnits.map((u) => (
                                    <option key={u.unitName} value={u.unitName}>
                                      {u.unitName}
                                      {u.conversionQty > 1
                                        ? ` (${formatNumber(u.conversionQty)} ${pluralizeUnit(baseUnit, u.conversionQty)})`
                                        : ''}
                                    </option>
                                  ))
                                )}
                              </select>
                            </div>

                            <div>
                              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                                Qty ({displayUnit})
                              </label>
                              <input
                                type="number"
                                min={allowFractional ? '0.001' : '1'}
                                step={allowFractional ? '0.001' : '1'}
                                value={row.quantity}
                                onChange={(e) =>
                                  setRows((prev) =>
                                    prev.map((r) => (r.key === row.key ? { ...r, quantity: e.target.value } : r))
                                  )
                                }
                                className="cm-input w-full min-h-[38px] px-2.5 py-1.5 text-sm border rounded-lg font-mono-num"
                              />
                            </div>

                            <div>
                              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                                Cost / {displayUnit} (PKR)
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
                                className="cm-input w-full min-h-[38px] px-2.5 py-1.5 text-sm border rounded-lg font-mono-num"
                              />
                            </div>

                            <div>
                              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                                Batch Expiry
                              </label>
                              <input
                                type="date"
                                value={row.expiryDate}
                                onChange={(e) =>
                                  setRows((prev) =>
                                    prev.map((r) => (r.key === row.key ? { ...r, expiryDate: e.target.value } : r))
                                  )
                                }
                                className="cm-input w-full min-h-[38px] px-2 py-1.5 text-xs border rounded-lg font-mono-num"
                              />
                            </div>
                          </div>

                          {selectedProd && qty > 0 && (
                            <div className="sm:col-span-12 flex flex-wrap items-center justify-between gap-2 pt-1.5 border-t border-[var(--cm-border)] text-[11px] font-mono-num tabular-nums text-[var(--cm-text-secondary)]">
                              <span>
                                Stock increase:{' '}
                                <strong className="text-[var(--cm-success)]">
                                  +{formatNumber(baseDelta)} {pluralizeUnit(baseUnit, baseDelta)}
                                </strong>
                                {baseDelta > 0 && (
                                  <span className="ml-2 text-[var(--cm-text-muted)]">
                                    · Unit cost: {formatPKR(roundMoney(lineTotal / baseDelta))} / {baseUnit}
                                  </span>
                                )}
                              </span>
                              <span>
                                Line Total: <strong className="text-[var(--cm-text-primary)]">{formatPKR(lineTotal)}</strong>
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
              Notes (Optional)
            </label>
            <input
              type="text"
              maxLength={500}
              placeholder="Invoice reference or delivery details"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="cm-input w-full min-h-[40px] px-3 py-1.5 text-sm border rounded-lg"
            />
          </div>

          {/* Sticky Bottom Purchase Summary & Save Bar */}
          <div className="sticky bottom-2 z-20 cm-surface backdrop-blur-md border rounded-xl shadow-md px-3.5 py-2.5 sm:px-4 flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-4 sm:gap-6">
              <div className="min-w-0">
                <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums leading-tight">
                  {formatNumber(rows.filter((r) => Boolean(r.productId)).length)} items · Total
                </div>
                <div className="text-base sm:text-lg font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)] leading-tight truncate">
                  {formatPKR(totalPurchaseAmount)}
                </div>
              </div>
              <div className="border-l border-[var(--cm-border)] pl-3 sm:pl-4">
                <div className="text-[11px] text-[var(--cm-text-muted)] leading-tight">Balance Due</div>
                <div
                  className={`text-xs sm:text-sm font-bold font-mono-num tabular-nums leading-tight ${
                    balanceDue > 0 ? 'text-[var(--cm-warning)]' : 'text-[var(--cm-success)]'
                  }`}
                >
                  {formatPKR(balanceDue)}
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || activeProductsList.length === 0}
              className="min-h-[44px] px-4 sm:px-5 py-2 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] active:scale-[0.98] disabled:opacity-50 rounded-lg cursor-pointer whitespace-nowrap shrink-0"
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
          <div className="md:hidden divide-y divide-[var(--cm-border)]">
            {supplierStats.sortedSuppliers.map((s) => {
              const firstUnpaidPo = supplierStats.openUnpaidBySupplier.get(s.id);
              const hasDue = (s.outstandingBalance || 0) > 0;
              return (
                <CompactExpandableRow
                  key={s.id}
                  title={s.name}
                  subtitle={s.phone || s.address || 'No phone on file'}
                  rightPrimary={
                    <span className={hasDue ? 'text-[var(--cm-warning)]' : 'text-[var(--cm-success)]'}>
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
                          <span className="text-[var(--cm-text-muted)]">Purchased:</span>{' '}
                          <span className="font-mono-num font-semibold text-[var(--cm-text-primary)]">
                            {formatPKR(s.totalPurchased)}
                          </span>
                        </div>
                        <div>
                          <span className="text-[var(--cm-text-muted)]">Paid:</span>{' '}
                          <span className="font-mono-num font-semibold text-[var(--cm-success)]">
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
                            className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold text-[var(--cm-accent-text)] cm-surface border border-[var(--cm-accent-border)] rounded-lg cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> Pay Due
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setFilterSupplierId(s.id)}
                            className="min-h-[36px] px-3 py-1 text-xs font-medium text-[var(--cm-text-secondary)] cm-surface border rounded-lg cursor-pointer"
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
                <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                  <th className="py-2.5 px-3">Supplier</th>
                  <th className="py-2.5 px-3">Phone</th>
                  <th className="py-2.5 px-3 text-right">Total Purchased</th>
                  <th className="py-2.5 px-3 text-right">Total Paid</th>
                  <th className="py-2.5 px-3 text-right">Outstanding</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                {supplierStats.sortedSuppliers.map((s) => {
                  const firstUnpaidPo = supplierStats.openUnpaidBySupplier.get(s.id);
                  const hasDue = (s.outstandingBalance || 0) > 0;
                  return (
                    <tr key={s.id} className="hover:bg-[var(--cm-bg-hover)]">
                      <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">{s.name}</td>
                      <td className="py-2 px-3 font-mono-num tabular-nums text-xs text-[var(--cm-text-muted)]">
                        {s.phone || '—'}
                      </td>
                      <td className="py-2 px-3 text-right font-mono-num tabular-nums text-[var(--cm-text-primary)]">
                        {formatPKR(s.totalPurchased)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono-num tabular-nums text-[var(--cm-success)]">
                        {formatPKR(s.totalPaid)}
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-mono-num tabular-nums font-semibold ${
                          hasDue ? 'text-[var(--cm-warning)]' : 'text-[var(--cm-text-muted)]'
                        }`}
                      >
                        {formatPKR(s.outstandingBalance)}
                      </td>
                      <td
                        className={`py-2 px-3 text-xs font-semibold whitespace-nowrap ${
                          hasDue ? 'text-[var(--cm-warning)]' : 'text-[var(--cm-success)]'
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
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[var(--cm-accent-text)] border border-[var(--cm-border)] hover:bg-[var(--cm-accent-soft)] rounded cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> Pay Due
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setFilterSupplierId(s.id)}
                            className="text-xs font-medium text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
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
            className="lg:hidden inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[var(--cm-text-secondary)] bg-[var(--cm-bg-subtle)] hover:bg-[var(--cm-bg-hover)] border border-[var(--cm-border)] rounded-md cursor-pointer"
          >
            <Filter className="w-3.5 h-3.5" />
            <span>{showMobileFilters ? 'Hide' : 'Filters'}</span>
          </button>
        }
      >
        <div className="p-3 sm:p-4 border-b border-[var(--cm-border)] space-y-2">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-2">
            <div className="relative lg:col-span-4">
              <Search className="w-4 h-4 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search PO #, supplier, product..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="cm-input w-full min-h-[38px] pl-9 pr-3 py-1.5 text-sm border rounded-lg"
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
                className="cm-input w-full min-h-[38px] px-2.5 py-1.5 text-xs border rounded-lg font-mono-num"
              />
              <input
                type="date"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
                className="cm-input w-full min-h-[38px] px-2.5 py-1.5 text-xs border rounded-lg font-mono-num"
              />
            </div>
          </div>
        </div>

        {visiblePurchases.length === 0 ? (
          <div className="p-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
            {showUnpaidOnly ? 'No pending unpaid purchase orders match your filters.' : 'No purchases recorded yet.'}
          </div>
        ) : (
          <>
            {/* Mobile Compact Expandable List */}
            <div className="md:hidden divide-y divide-[var(--cm-border)]">
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
                        <span className="text-[var(--cm-text-muted)]">·</span>
                        <span className="truncate font-normal text-[var(--cm-text-secondary)]">
                          {p.supplierName}
                        </span>
                      </span>
                    }
                    subtitle={`${formatDateDDMMYYYY(p.purchaseDate)} · ${items.length} items`}
                    rightPrimary={formatPKR(p.totalAmount)}
                    rightSecondary={
                      isCancelled ? (
                        <span className="text-[var(--cm-danger)]">Cancelled</span>
                      ) : p.balanceDue > 0 ? (
                        <span className="text-[var(--cm-warning)] font-semibold">
                          Due: {formatPKR(p.balanceDue)}
                        </span>
                      ) : (
                        <span className="text-[var(--cm-success)]">Paid</span>
                      )
                    }
                    isExpanded={expandedPurchaseId === p.id}
                    onToggle={() =>
                      setExpandedPurchaseId((cur) => (cur === p.id ? null : p.id))
                    }
                    expandedContent={
                      <div className="space-y-2">
                        <div className="space-y-1 cm-surface border rounded-lg p-2">
                          {items.map((item) => {
                            const qtyDisp = item.unitName
                              ? `${formatNumber(item.unitQuantity ?? item.quantity)} ${item.unitName}`
                              : `×${formatNumber(item.quantity)}`;
                            return (
                              <div key={item.id} className="flex items-center justify-between gap-2 text-xs">
                                <span className="truncate text-[var(--cm-text-primary)]">
                                  {item.productName}{' '}
                                  <span className="text-[var(--cm-text-muted)] font-mono-num">
                                    ({qtyDisp})
                                  </span>
                                  {item.expiryDate && (
                                    <span className="ml-1 text-[10px] text-[var(--cm-warning)] font-mono-num">
                                      Exp {formatDateDDMMYYYY(item.expiryDate)}
                                    </span>
                                  )}
                                </span>
                                <span className="font-mono-num font-semibold text-[var(--cm-text-primary)] shrink-0">
                                  {formatPKR(item.lineTotal)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="flex items-center justify-between text-xs text-[var(--cm-text-secondary)]">
                          <span>
                            Paid: <strong className="font-mono-num text-[var(--cm-success)]">{formatPKR(p.amountPaid)}</strong>
                          </span>
                          <span>
                            Due: <strong className="font-mono-num text-[var(--cm-warning)]">{formatPKR(p.balanceDue)}</strong>
                          </span>
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
                                className="min-h-[36px] inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold text-[var(--cm-accent-text)] cm-surface border border-[var(--cm-accent-border)] rounded-lg cursor-pointer"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" /> Pay Due
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleCancelPurchase(p)}
                              className="min-h-[36px] inline-flex items-center gap-1 px-3 py-1 text-xs font-medium text-[var(--cm-danger)] bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg cursor-pointer"
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
                  <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
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
                <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                  {visiblePurchases.map((p) => {
                    const items = purchaseItemsByPo.get(p.id) || [];
                    const summary = items
                      .map((i) =>
                        i.unitName
                          ? `${i.productName} (${formatNumber(i.unitQuantity ?? i.quantity)} ${i.unitName})`
                          : `${i.productName} ×${formatNumber(i.quantity)}`
                      )
                      .join(', ');
                    const isCancelled = p.status === 'cancelled';

                    return (
                      <tr key={p.id} className={`hover:bg-[var(--cm-bg-hover)] ${isCancelled ? 'opacity-60' : ''}`}>
                        <td className="py-2 px-3 font-mono-num whitespace-nowrap text-xs text-[var(--cm-text-secondary)]">
                          {formatDateDDMMYYYY(p.purchaseDate)}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-xs font-medium text-[var(--cm-text-primary)]">
                          {p.purchaseNumber}
                        </td>
                        <td className="py-2 px-3 text-[var(--cm-text-primary)]">{p.supplierName}</td>
                        <td className="py-2 px-3 text-[var(--cm-text-secondary)] max-w-xs truncate" title={summary}>
                          {summary}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num font-semibold text-[var(--cm-text-primary)]">
                          {formatPKR(p.totalAmount)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-success)]">
                          {formatPKR(p.amountPaid)}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono-num font-semibold ${
                            p.balanceDue > 0 ? 'text-[var(--cm-warning)]' : 'text-[var(--cm-text-muted)]'
                          }`}
                        >
                          {formatPKR(p.balanceDue)}
                        </td>
                        <td className="py-2 px-3 text-xs font-semibold">
                          <span className={isCancelled ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-success)]'}>
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
                                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-[var(--cm-accent-text)] border border-[var(--cm-border)] hover:bg-[var(--cm-accent-soft)] rounded cursor-pointer"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" /> Pay Due
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void handleCancelPurchase(p)}
                                className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] rounded cursor-pointer"
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
        <div className="fixed inset-0 z-50 bg-[var(--cm-bg-overlay)] flex items-center justify-center p-4">
          <div className="cm-surface border rounded-xl w-full max-w-md p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between border-b border-[var(--cm-border)] pb-3">
              <h3 className="text-base font-semibold text-[var(--cm-text-primary)]">
                Pay Balance — {settlingPurchase.purchaseNumber}
              </h3>
              <button
                type="button"
                onClick={() => setSettlingPurchase(null)}
                className="p-1 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            {settleErr && (
              <div className="p-3 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg text-sm text-[var(--cm-danger)]">
                {settleErr}
              </div>
            )}
            <form onSubmit={handleSettle} className="space-y-4">
              <div className="text-xs text-[var(--cm-text-muted)]">
                Supplier: <span className="font-semibold text-[var(--cm-text-primary)]">{settlingPurchase.supplierName}</span> ·
                Due: <span className="font-semibold font-mono-num text-[var(--cm-warning)]">{formatPKR(settlingPurchase.balanceDue)}</span>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                  Payment Amount (PKR)
                </label>
                <input
                  type="number"
                  min={1}
                  max={settlingPurchase.balanceDue}
                  step="0.01"
                  required
                  value={settleAmount}
                  onChange={(e) => setSettleAmount(e.target.value)}
                  className="cm-input w-full px-3 py-2 text-sm border rounded-lg font-mono-num"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                  Payment Method
                </label>
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
                  className="px-4 py-2 text-sm font-medium text-[var(--cm-text-secondary)] cm-surface border hover:bg-[var(--cm-bg-hover)] rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer"
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
