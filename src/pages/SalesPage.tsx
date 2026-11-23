import { Ban, CheckCircle2, Download, Edit3, Filter, Grid3X3, Search, Trash2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { CompactSaleItemsList, type CompactSaleRowItem } from '../components/CompactSaleItemsList';
import { CompactExpandableRow, CompactSection } from '../components/CompactSection';
import { NumericKeypadOverlay } from '../components/NumericKeypadOverlay';
import { SearchableProductSelector } from '../components/SearchableProductSelector';
import { SearchableSelect, type SearchableSelectOption } from '../components/SearchableSelect';
import { useAuth } from '../contexts/AuthContext';
import { useGoogleSheetsSync } from '../contexts/GoogleSheetsSyncContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import {
  mapProductsToSearchable,
  queryProductsFromDatabase,
  type SearchableProductItem,
} from '../services/productSearchService';
import { computeTopActivityValues } from '../services/recordSearchService';
import { cancelSale, createSale, editSale, type SaleLineDraft } from '../services/shopService';
import type { PaymentMethod, Sale, SaleItem } from '../types/shop';
import {
  csvSafe,
  formatDateDDMMYYYY,
  formatNumber,
  formatPKR,
  getKarachiDateIso,
  getMonthKey,
  roundMoney,
  validateOptionalCustomerWhatsapp,
} from '../utils/formatters';
import {
  formatStockBreakdown,
  getAllowedSaleUnits,
  getDefaultSaleUnit,
  getEffectiveBaseUnit,
  isFractionalUnit,
  pluralizeUnit,
  roundStockQty,
} from '../utils/packaging';
import { recordPerfMetric, startPerfTimer } from '../utils/perfMonitor';
import {
  buildSellerFilterOptions,
  formatSaleSellerLabel,
  getSaleSellerKey,
  matchesSellerFilter,
  resolveCurrentAdminSeller,
} from '../utils/sellerAttribution';

interface LineFormRow {
  key: string;
  productId: string;
  unitName: string;
  conversionFactor: number;
  quantity: string;
  salePricePerUnit: string;
}

export function SalesPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { products, sales, saleItems, staffMembers, adminMembers, settings, inventoryBatches } =
    useShopData();
  const { showToast } = useToast();
  const sheetsSync = useGoogleSheetsSync();
  const todayIso = getKarachiDateIso();

  // New Sale Form State
  const [saleDate, setSaleDate] = useState(todayIso);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');
  const [customerWhatsapp, setCustomerWhatsapp] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<LineFormRow[]>([]);
  const [expandedRowKey, setExpandedRowKey] = useState<string | null>(null);
  const [lastHighlightedKey, setLastHighlightedKey] = useState<string | null>(null);
  const [quickAddFeedback, setQuickAddFeedback] = useState<string | null>(null);
  const quickFeedbackTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const submitLockRef = useRef(false);
  const [allowStockOverride, setAllowStockOverride] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingSaleId, setCancellingSaleId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  // Numeric Keypad Overlay Target (supports both New Sale & Edit Sale rows)
  const [keypadTarget, setKeypadTarget] = useState<{
    scope: 'create' | 'edit';
    rowKey: string;
  } | null>(null);

  // Direct Database Fallback Cache if needed
  const [dbFallbackItems, setDbFallbackItems] = useState<SearchableProductItem[] | null>(null);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterProductId, setFilterProductId] = useState('');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const [filterPayment, setFilterPayment] = useState<'' | PaymentMethod>('');
  const [filterStaffId, setFilterStaffId] = useState('');
  const [filterWhatsappOnly, setFilterWhatsappOnly] = useState(false);

  // Edit Modal State
  const [editingSale, setEditingSale] = useState<Sale | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editPayment, setEditPayment] = useState<PaymentMethod>('Cash');
  const [editWhatsapp, setEditWhatsapp] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editRows, setEditRows] = useState<LineFormRow[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const historyProductOptions = useMemo<SearchableSelectOption[]>(
    () =>
      products.map((p) => {
        const bd = formatStockBreakdown(p.currentStock, p);
        return {
          value: p.id,
          label: p.name,
          subtitle: `${p.brandName || 'Unbranded'} · ${p.categoryName || 'Uncategorized'}`,
          meta: `Stock: ${bd.summaryText}`,
          keywords: [p.name, p.brandName, p.categoryName],
        };
      }),
    [products]
  );

  const historyPaymentOptions = useMemo<SearchableSelectOption[]>(
    () => [
      { value: 'Cash', label: 'Cash', subtitle: 'Cash sales' },
      { value: 'Online', label: 'Online', subtitle: 'Bank / wallet sales' },
    ],
    []
  );

  const historyStaffOptions = useMemo<SearchableSelectOption[]>(
    () =>
      buildSellerFilterOptions({
        sales,
        staffMembers,
        adminMembers,
        settings,
        user,
        shopId: activeShopId,
        includeAllOwnersOption: true,
      }),
    [sales, staffMembers, adminMembers, settings, user, activeShopId]
  );

  const frequentHistoryProductIds = useMemo(
    () => computeTopActivityValues(saleItems, (i) => i.productId, 5),
    [saleItems]
  );
  const frequentHistoryStaffIds = useMemo(
    () => computeTopActivityValues(sales, (s) => getSaleSellerKey(s), 5),
    [sales]
  );

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const searchableItems = useMemo(() => {
    if (products.length > 0) {
      return mapProductsToSearchable(products);
    }
    return dbFallbackItems || [];
  }, [products, dbFallbackItems]);

  const handleRefreshCatalog = async () => {
    if (!activeShopId) return;
    const fetched = await queryProductsFromDatabase({
      shopId: activeShopId,
      role: 'owner',
      maxDocs: 1000,
    });
    setDbFallbackItems(fetched);
  };

  const saleItemsBySaleId = useMemo(() => {
    const map = new Map<string, SaleItem[]>();
    for (const item of saleItems) {
      const list = map.get(item.saleId) || [];
      list.push(item);
      map.set(item.saleId, list);
    }
    return map;
  }, [saleItems]);

  // Daily, Monthly, Yearly totals
  const salesTotals = useMemo(() => {
    const currentMonth = getMonthKey(todayIso);
    const currentYear = todayIso.slice(0, 4);
    let daily = 0;
    let monthly = 0;
    let yearly = 0;
    for (const s of sales) {
      if (s.status === 'cancelled') continue;
      if (s.saleDate === todayIso) daily = roundMoney(daily + s.totalAmount);
      if (getMonthKey(s.saleDate) === currentMonth) monthly = roundMoney(monthly + s.totalAmount);
      if (s.saleDate.slice(0, 4) === currentYear) yearly = roundMoney(yearly + s.totalAmount);
    }
    return { daily, monthly, yearly };
  }, [sales, todayIso]);

  const triggerAddedConfirmation = (
    rowKey: string,
    name: string,
    qty: number,
    unitName: string,
    unitPrice: number
  ) => {
    const label = `${name} (${formatNumber(qty)} ${unitName} · ${formatPKR(qty * unitPrice)})`;
    showToast({
      id: 'sale-product-added',
      title: 'Product added successfully',
      message: label,
      tone: 'success',
      durationMs: 2200,
    });
    setQuickAddFeedback(`Product added successfully · ${label}`);
    setLastHighlightedKey(rowKey);

    if (quickFeedbackTimerRef.current !== null) {
      window.clearTimeout(quickFeedbackTimerRef.current);
    }
    quickFeedbackTimerRef.current = window.setTimeout(() => {
      setQuickAddFeedback(null);
    }, 2600);

    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setLastHighlightedKey(null);
    }, 1600);
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    setExpandedRowKey((cur) => (cur === key ? null : cur));
  };

  const getProductUsedBaseExcludingRow = (
    targetRows: LineFormRow[],
    productId: string,
    excludeKey?: string
  ) => {
    let total = 0;
    for (const r of targetRows) {
      if (r.productId !== productId || (excludeKey && r.key === excludeKey)) continue;
      const qty = Math.max(0, Number(r.quantity) || 0);
      const conv = roundStockQty(r.conversionFactor) || 1;
      total = roundStockQty(total + qty * conv);
    }
    return total;
  };

  const handleQuickAddProduct = (item: SearchableProductItem) => {
    setFormError(null);
    setFormSuccess(null);

    const prod = productMap.get(item.id);
    const source = prod || item;
    const baseUnit = getEffectiveBaseUnit(source);
    const defUnit = getDefaultSaleUnit(source);
    const existing = rows.find(
      (r) =>
        r.productId === item.id &&
        r.unitName.trim().toLowerCase() === defUnit.unitName.trim().toLowerCase()
    );

    if (existing) {
      const fractional = isFractionalUnit(defUnit.unitName);
      const currentQty = Math.max(0, roundStockQty(Number(existing.quantity) || 0));
      const nextQty = fractional ? roundStockQty(currentQty + 1) : Math.max(1, Math.floor(currentQty) + 1);
      const otherBase = getProductUsedBaseExcludingRow(rows, item.id, existing.key);
      const totalBaseRequested = roundStockQty(otherBase + nextQty * existing.conversionFactor);

      if (!allowStockOverride && totalBaseRequested > item.currentStock) {
        setFormError(
          `Cannot exceed available stock for "${item.name}" (${formatNumber(item.currentStock)} ${baseUnit}).`
        );
        return;
      }
      const unitPrice = Number(existing.salePricePerUnit) || defUnit.salePrice;
      setRows((prev) => {
        const updated = { ...existing, quantity: String(nextQty) };
        return [updated, ...prev.filter((r) => r.key !== existing.key)];
      });
      triggerAddedConfirmation(existing.key, item.name, nextQty, defUnit.unitName, unitPrice);
      return;
    }

    const otherBase = getProductUsedBaseExcludingRow(rows, item.id);
    const neededBase = roundStockQty(otherBase + defUnit.conversionQty);
    if (!allowStockOverride && neededBase > item.currentStock) {
      setFormError(
        `Cannot exceed available stock for "${item.name}" (${formatNumber(item.currentStock)} ${baseUnit}).`
      );
      return;
    }

    const newKey = `row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setRows((prev) => [
      {
        key: newKey,
        productId: item.id,
        unitName: defUnit.unitName,
        conversionFactor: defUnit.conversionQty,
        quantity: '1',
        salePricePerUnit: String(defUnit.salePrice),
      },
      ...prev.filter((r) => Boolean(r.productId)),
    ]);
    triggerAddedConfirmation(newKey, item.name, 1, defUnit.unitName, defUnit.salePrice);
  };

  const stepRowQuantity = (scope: 'create' | 'edit', key: string, delta: number) => {
    const setter = scope === 'create' ? setRows : setEditRows;
    const targetRows = scope === 'create' ? rows : editRows;
    const row = targetRows.find((r) => r.key === key);
    if (!row) return;
    const prod = productMap.get(row.productId);
    const fractional = isFractionalUnit(row.unitName);
    const cur = Math.max(0, roundStockQty(Number(row.quantity) || 0));
    const next = fractional
      ? Math.max(0.25, roundStockQty((cur || 1) + delta))
      : Math.max(1, Math.floor(cur || 1) + delta);

    if (scope === 'create' && prod && !allowStockOverride) {
      const otherBase = getProductUsedBaseExcludingRow(rows, prod.id, row.key);
      const totalBaseRequested = roundStockQty(otherBase + next * row.conversionFactor);
      if (totalBaseRequested > prod.currentStock) {
        setFormError(
          `Cannot exceed available stock for "${prod.name}" (${formatNumber(prod.currentStock)} ${getEffectiveBaseUnit(prod)}).`
        );
        return;
      }
    }
    setFormError(null);
    setter((prev) => prev.map((r) => (r.key === key ? { ...r, quantity: String(next) } : r)));
  };

  const updateRowField = (key: string, field: 'quantity' | 'salePricePerUnit', value: string) => {
    setFormError(null);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  };

  const handleChangeRowUnit = (scope: 'create' | 'edit', key: string, nextUnitName: string) => {
    const setter = scope === 'create' ? setRows : setEditRows;
    if (scope === 'create') setFormError(null);
    else setEditError(null);

    setter((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const prod = productMap.get(r.productId);
        if (!prod) return { ...r, unitName: nextUnitName };
        const allowed = getAllowedSaleUnits(prod);
        const matched =
          allowed.find((u) => u.unitName.toLowerCase() === nextUnitName.toLowerCase()) ||
          allowed[0];
        return {
          ...r,
          unitName: matched.unitName,
          conversionFactor: matched.conversionQty,
          salePricePerUnit: String(matched.salePrice),
        };
      })
    );
  };

  const draftTotals = useMemo(() => {
    let totalAmount = 0;
    let totalCost = 0;
    let itemCount = 0;
    let totalBaseUnits = 0;
    for (const r of rows) {
      const prod = productMap.get(r.productId);
      const qty = Math.max(0, roundStockQty(Number(r.quantity) || 0));
      const price = Number(r.salePricePerUnit) || 0;
      const baseQty = roundStockQty(qty * (r.conversionFactor || 1));
      if (prod) {
        itemCount += 1;
        totalBaseUnits = roundStockQty(totalBaseUnits + baseQty);
        if (qty > 0) {
          totalAmount = roundMoney(totalAmount + qty * price);
          totalCost = roundMoney(totalCost + baseQty * prod.purchasePrice);
        }
      }
    }
    return {
      totalAmount,
      totalCost,
      estimatedProfit: roundMoney(totalAmount - totalCost),
      itemCount,
      totalUnits: totalBaseUnits,
    };
  }, [rows, productMap]);

  const compactSaleItems = useMemo<CompactSaleRowItem[]>(() => {
    return rows.reduce<CompactSaleRowItem[]>((acc, r) => {
      const prod = productMap.get(r.productId);
      if (prod) {
        acc.push({
          key: r.key,
          productId: r.productId,
          name: prod.name,
          brandName: prod.brandName,
          unit: getEffectiveBaseUnit(prod),
          unitName: r.unitName || getEffectiveBaseUnit(prod),
          conversionFactor: r.conversionFactor || 1,
          allowedUnits: getAllowedSaleUnits(prod),
          currentStock: prod.currentStock,
          quantity: r.quantity,
          salePricePerUnit: r.salePricePerUnit,
          wholesalePrice: prod.wholesalePrice,
          purchasePrice: prod.purchasePrice,
        });
      }
      return acc;
    }, []);
  }, [rows, productMap]);

  const handleSaveSale = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId || submitLockRef.current) return;
    setFormError(null);
    setFormSuccess(null);

    const activeRows = rows.filter((r) => r.productId);
    if (activeRows.length === 0) {
      setFormError('Search and select at least one product to record a sale.');
      return;
    }

    const phoneError = validateOptionalCustomerWhatsapp(customerWhatsapp);
    if (phoneError) {
      setFormError(phoneError);
      return;
    }

    const baseQtyByProduct = new Map<string, number>();
    const items: SaleLineDraft[] = [];
    for (const r of activeRows) {
      const prod = productMap.get(r.productId);
      if (!prod) {
        setFormError('Selected product was not found.');
        return;
      }
      const baseUnit = getEffectiveBaseUnit(prod);
      const unitLabel = r.unitName || baseUnit;
      const conv = roundStockQty(r.conversionFactor || 1) || 1;
      const rawQty = Number(r.quantity);
      const qty = isFractionalUnit(unitLabel) ? roundStockQty(rawQty) : Math.floor(rawQty);
      const price = Number(r.salePricePerUnit);

      if (!Number.isFinite(qty) || qty <= 0) {
        setFormError(`Quantity for "${prod.name}" must be greater than zero.`);
        return;
      }
      if (!Number.isFinite(price) || price < 0) {
        setFormError(`Selling price for "${prod.name}" cannot be negative.`);
        return;
      }

      const lineBaseQty = roundStockQty(qty * conv);
      const cumulativeBase = roundStockQty((baseQtyByProduct.get(r.productId) || 0) + lineBaseQty);
      baseQtyByProduct.set(r.productId, cumulativeBase);
      if (!allowStockOverride && cumulativeBase > prod.currentStock) {
        setFormError(
          `Insufficient stock for "${prod.name}". Available: ${formatNumber(prod.currentStock)} ${baseUnit}, Requested: ${formatNumber(cumulativeBase)} ${baseUnit}.`
        );
        return;
      }

      items.push({
        productId: r.productId,
        unitName: unitLabel,
        conversionFactor: conv,
        quantity: qty,
        salePricePerUnit: price,
      });
    }

    const activeBatchIds = inventoryBatches
      .filter(
        (b) =>
          b.status === 'active' &&
          Number(b.remainingBaseQty) > 0 &&
          baseQtyByProduct.has(b.productId)
      )
      .map((b) => b.id);

    const currentSeller = resolveCurrentAdminSeller(
      user,
      activeShopId,
      adminMembers,
      settings,
      sales
    );

    submitLockRef.current = true;
    setSubmitting(true);
    const stopSave = startPerfTimer();
    try {
      await createSale(
        activeShopId,
        {
          saleDate,
          paymentMethod,
          customerWhatsapp,
          notes,
          items,
        },
        { allowStockOverride, activeBatchIds, recordedBy: currentSeller }
      );
      recordPerfMetric('sales_save', 'owner_checkout_commit', stopSave(), {
        lines: items.length,
        batches: activeBatchIds.length,
      });
      setCustomerWhatsapp('');
      setNotes('');
      setRows([]);
      setExpandedRowKey(null);
      setQuickAddFeedback(null);
      setFormSuccess('Sale saved and inventory updated.');
      window.requestAnimationFrame(() => {
        const searchEl = document.getElementById('quick-add-product-search') as HTMLInputElement | null;
        if (searchEl && window.innerWidth >= 768) {
          searchEl.focus();
        }
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save sale.');
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  };

  const openEditModal = (sale: Sale) => {
    const items = saleItemsBySaleId.get(sale.id) || [];
    setEditingSale(sale);
    setEditDate(sale.saleDate);
    setEditPayment(sale.paymentMethod);
    setEditWhatsapp(sale.customerWhatsapp || '');
    setEditNotes(sale.notes);
    setEditRows(
      items.map((item) => {
        const prod = productMap.get(item.productId);
        const fallbackUnit = prod ? getEffectiveBaseUnit(prod) : 'Piece';
        return {
          key: item.id,
          productId: item.productId,
          unitName: item.unitName || fallbackUnit,
          conversionFactor: item.conversionFactor || 1,
          quantity: String(item.unitQuantity ?? item.quantity),
          salePricePerUnit: String(item.salePricePerUnit),
        };
      })
    );
    setEditError(null);
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId || !editingSale) return;
    setEditError(null);

    const items: SaleLineDraft[] = [];
    for (const r of editRows) {
      if (!r.productId) {
        setEditError('Please select a product for every row.');
        return;
      }
      const qty = roundStockQty(Number(r.quantity));
      const price = Number(r.salePricePerUnit);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) {
        setEditError('Enter valid positive quantities and non-negative prices.');
        return;
      }
      const prod = productMap.get(r.productId);
      const unitLabel = r.unitName || (prod ? getEffectiveBaseUnit(prod) : 'Piece');
      items.push({
        productId: r.productId,
        unitName: unitLabel,
        conversionFactor: roundStockQty(r.conversionFactor || 1) || 1,
        quantity: qty,
        salePricePerUnit: price,
      });
    }

    const editPhoneError = validateOptionalCustomerWhatsapp(editWhatsapp);
    if (editPhoneError) {
      setEditError(editPhoneError);
      return;
    }

    setSavingEdit(true);
    try {
      const existingItems = saleItemsBySaleId.get(editingSale.id) || [];
      await editSale(
        activeShopId,
        editingSale,
        existingItems,
        {
          saleDate: editDate,
          paymentMethod: editPayment,
          customerWhatsapp: editWhatsapp,
          notes: editNotes,
          items,
        },
        { allowStockOverride }
      );
      setEditingSale(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update sale.');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleCancelSale = async (sale: Sale) => {
    if (!activeShopId || cancellingSaleId) return;
    setFormError(null);
    setCancellingSaleId(sale.id);
    try {
      await cancelSale(activeShopId, sale, 'Cancelled from sales history');
      const autoSyncOn = sheetsSync?.integration?.autoSyncEnabled !== false;
      if (sheetsSync?.sheetsAuthorized && autoSyncOn) {
        showToast({
          title: 'Sale cancelled',
          tone: 'success',
          message: `${sale.saleNumber} cancelled, stock restored, and Google Sheets update queued.`,
        });
      } else if (sheetsSync?.sheetsAuthorized && !autoSyncOn) {
        showToast({
          title: 'Sale cancelled',
          tone: 'success',
          message: `${sale.saleNumber} cancelled and stock restored. Auto-sync is paused.`,
          actionLabel: 'Sync Sheet Now',
          onAction: () => {
            void sheetsSync
              .syncNow([
                'Products',
                'Inventory',
                'Sales',
                'Sales Details',
                'Stock Movements',
                'Daily Summary',
                'Monthly Summary',
                'Staff Performance',
              ])
              .catch(() => undefined);
          },
        });
      } else {
        showToast({
          title: 'Sale cancelled',
          tone: 'success',
          message: `${sale.saleNumber} cancelled and inventory restored.`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to cancel sale.';
      setFormError(msg);
      showToast({
        title: 'Cancel failed',
        tone: 'error',
        message: msg,
      });
    } finally {
      setCancellingSaleId(null);
    }
  };

  const filteredSales = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return sales.filter((s) => {
      if (filterFrom && s.saleDate < filterFrom) return false;
      if (filterTo && s.saleDate > filterTo) return false;
      if (filterPayment && s.paymentMethod !== filterPayment) return false;
      if (filterWhatsappOnly && !s.customerWhatsapp) return false;
      if (!matchesSellerFilter(s, filterStaffId)) return false;
      const items = saleItemsBySaleId.get(s.id) || [];
      if (filterProductId && !items.some((i) => i.productId === filterProductId)) return false;
      if (q) {
        const matchNumber = s.saleNumber.toLowerCase().includes(q);
        const matchNotes = s.notes.toLowerCase().includes(q);
        const matchStaff = formatSaleSellerLabel(s).toLowerCase().includes(q);
        const phone = (s.customerWhatsapp || '').toLowerCase();
        const phoneDigits = phone.replace(/\D/g, '');
        const matchWhatsapp =
          phone.includes(q) || (qDigits.length >= 3 && phoneDigits.includes(qDigits));
        const matchProduct = items.some((i) => i.productName.toLowerCase().includes(q));
        if (!matchNumber && !matchNotes && !matchProduct && !matchStaff && !matchWhatsapp) {
          return false;
        }
      }
      return true;
    });
  }, [
    sales,
    saleItemsBySaleId,
    searchTerm,
    filterFrom,
    filterTo,
    filterPayment,
    filterStaffId,
    filterProductId,
    filterWhatsappOnly,
  ]);

  const handleExportCustomerContactsCsv = () => {
    const contacts = filteredSales.filter((s) => Boolean(s.customerWhatsapp?.trim()));
    if (contacts.length === 0) {
      showToast({
        title: 'No WhatsApp contacts to export',
        tone: 'info',
        message: 'No matching sales contain a customer WhatsApp number.',
      });
      return;
    }

    const csvEscape = (val: string | number) => {
      const safe = csvSafe(String(val ?? ''));
      return `"${safe.replace(/"/g, '""')}"`;
    };

    const headers = [
      'Sale Number',
      'Sale Date',
      'Customer WhatsApp Number',
      'Total Amount (PKR)',
      'Payment Method',
      'Recorded By',
      'Status',
    ];
    const lines = [
      headers.map(csvEscape).join(','),
      ...contacts.map((s) =>
        [
          s.saleNumber,
          s.saleDateTime || formatDateDDMMYYYY(s.saleDate),
          s.customerWhatsapp || '',
          roundMoney(s.totalAmount),
          s.paymentMethod,
          formatSaleSellerLabel(s),
          s.status === 'cancelled' ? 'Cancelled' : 'Completed',
        ]
          .map(csvEscape)
          .join(',')
      ),
    ];

    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `CareMart_Customer_WhatsApp_Contacts_${todayIso}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast({
      title: 'Contacts exported',
      tone: 'success',
      message: `Exported ${formatNumber(contacts.length)} customer WhatsApp contact records.`,
    });
  };

  const formatSaleItemQty = (item: SaleItem) => {
    const qty = item.unitQuantity ?? item.quantity;
    const unit = item.unitName ? ` ${item.unitName}` : '';
    return `${formatNumber(qty)}${unit}`;
  };

  return (
    <div className="space-y-4">
      {/* Daily / Monthly / Yearly Sales Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 sm:gap-3">
        <div className="cm-surface border rounded-xl p-3">
          <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Daily Sales (Today)</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)] truncate">
            {formatPKR(salesTotals.daily)}
          </div>
        </div>
        <div className="cm-surface border rounded-xl p-3">
          <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Monthly Sales</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)] truncate">
            {formatPKR(salesTotals.monthly)}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-1 cm-surface border rounded-xl p-3">
          <div className="text-[11px] font-medium text-[var(--cm-text-muted)]">Yearly Sales</div>
          <div className="mt-0.5 text-base sm:text-lg font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)] truncate">
            {formatPKR(salesTotals.yearly)}
          </div>
        </div>
      </div>

      {/* Compact Manual Sales Entry Form */}
      <section className="cm-surface border rounded-xl p-3.5 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">
              Manual Sales Entry
            </h2>
            <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
              Search or speak product names to add quickly; tap any row to edit unit, quantity or price.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-xs text-[var(--cm-text-secondary)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allowStockOverride}
                onChange={(e) => setAllowStockOverride(e.target.checked)}
                className="rounded border-[var(--cm-border-strong)] accent-[var(--cm-accent)]"
              />
              <span>Stock override</span>
            </label>
            {draftTotals.itemCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setRows([]);
                  setExpandedRowKey(null);
                  setQuickAddFeedback(null);
                  setFormError(null);
                }}
                className="text-xs font-medium text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] cursor-pointer"
              >
                Clear All ({formatNumber(draftTotals.itemCount)})
              </button>
            )}
          </div>
        </div>

        {formError && (
          <div className="p-3 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg text-xs sm:text-sm text-[var(--cm-danger)]">
            {formError}
          </div>
        )}
        {formSuccess && (
          <div className="p-3 bg-[var(--cm-success-soft)] border border-[var(--cm-success-border)] rounded-lg text-xs sm:text-sm text-[var(--cm-success)] flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{formSuccess}</span>
          </div>
        )}

        <form onSubmit={handleSaveSale} className="space-y-4">
          {/* Compact Sale Metadata */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
            <div>
              <label htmlFor="sale-date" className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Sale Date
              </label>
              <input
                id="sale-date"
                type="date"
                required
                value={saleDate}
                onChange={(e) => setSaleDate(e.target.value)}
                className="w-full min-h-[42px] px-2.5 py-1.5 text-xs sm:text-sm border cm-input rounded-lg font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
              />
            </div>

            <div>
              <span className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Payment
              </span>
              <div className="grid grid-cols-2 gap-1 p-1 bg-[var(--cm-bg-subtle)] rounded-lg border border-[var(--cm-border)] min-h-[42px]">
                {(['Cash', 'Online'] as PaymentMethod[]).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setPaymentMethod(method)}
                    className={`text-xs font-semibold rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                      paymentMethod === method
                        ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-accent-text)] border border-[var(--cm-border)] shadow-2xs'
                        : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
                    }`}
                  >
                    {method}
                  </button>
                ))}
              </div>
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label htmlFor="sale-customer-whatsapp" className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Customer WhatsApp (Optional)
              </label>
              <input
                id="sale-customer-whatsapp"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={32}
                placeholder="+92 3XX XXXXXXX"
                value={customerWhatsapp}
                onChange={(e) => {
                  setFormError(null);
                  setCustomerWhatsapp(e.target.value);
                }}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm border cm-input rounded-lg font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
              />
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label htmlFor="sale-notes" className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Notes (Optional)
              </label>
              <input
                id="sale-notes"
                type="text"
                maxLength={500}
                placeholder="Reference note"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full min-h-[42px] px-3 py-1.5 text-sm border cm-input rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
              />
            </div>
          </div>

          {/* Searchable Quick Product Picker (Voice Search EXCLUSIVE to Sales Entry) */}
          <div className="p-3 bg-[var(--cm-accent-soft)] border border-[var(--cm-accent-border)] rounded-xl space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="quick-add-product-search"
                className="block text-xs font-semibold text-[var(--cm-text-primary)]"
              >
                Quick Add Product
              </label>
              <span className="text-[11px] text-[var(--cm-text-muted)]">Auto-clears after adding</span>
            </div>
            <SearchableProductSelector
              inputId="quick-add-product-search"
              mode="quick-add"
              items={searchableItems}
              allowOutOfStock={allowStockOverride}
              enableVoiceSearch={true}
              onSelect={handleQuickAddProduct}
              onRefreshCatalog={handleRefreshCatalog}
            />
            {quickAddFeedback && (
              <div
                role="status"
                className="flex items-center gap-1.5 text-xs font-medium text-[var(--cm-success)] pt-0.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{quickAddFeedback}</span>
              </div>
            )}
          </div>

          {/* Compact Collapsible Products List */}
          <CompactSaleItemsList
            items={compactSaleItems}
            expandedKey={expandedRowKey}
            onToggleExpand={(key) => setExpandedRowKey((cur) => (cur === key ? null : key))}
            onStepQuantity={(key, delta) => stepRowQuantity('create', key, delta)}
            onChangeQuantity={(key, val) => updateRowField(key, 'quantity', val)}
            onChangeUnit={(key, unitName) => handleChangeRowUnit('create', key, unitName)}
            onOpenKeypad={(key) => setKeypadTarget({ scope: 'create', rowKey: key })}
            onChangePrice={(key, val) => updateRowField(key, 'salePricePerUnit', val)}
            onRemove={removeRow}
            priceEditable={true}
            allowStockOverride={allowStockOverride}
            showProfit={true}
            lastHighlightedKey={lastHighlightedKey}
          />

          {/* Sticky Bottom Sale Summary & Save Bar */}
          <div className="sticky bottom-2 z-20 bg-[var(--cm-bg-surface)]/95 backdrop-blur-md border border-[var(--cm-border)] rounded-xl shadow-md px-3.5 py-2.5 sm:px-4 flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-4 sm:gap-6">
              <div className="min-w-0">
                <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums leading-tight">
                  {formatNumber(draftTotals.itemCount)}{' '}
                  {draftTotals.itemCount === 1 ? 'line' : 'lines'}
                  <span className="hidden sm:inline">
                    {' '}· {formatNumber(draftTotals.totalUnits)} base qty
                  </span>
                </div>
                <div className="text-base sm:text-lg font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)] leading-tight truncate">
                  {formatPKR(draftTotals.totalAmount)}
                </div>
              </div>

              <div className="hidden sm:block border-l border-[var(--cm-border)] pl-4">
                <div className="text-[11px] text-[var(--cm-text-muted)] leading-tight">Est. Profit</div>
                <div
                  className={`text-sm font-bold font-mono-num tabular-nums leading-tight ${
                    draftTotals.estimatedProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                  }`}
                >
                  {formatPKR(draftTotals.estimatedProfit)}
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || products.length === 0}
              className="min-h-[44px] px-5 py-2.5 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] active:scale-[0.98] disabled:opacity-50 rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer"
            >
              {submitting ? 'Saving Sale...' : 'Save Sale'}
            </button>
          </div>
        </form>
      </section>

      {/* Complete Sales History */}
      <CompactSection
        title="Sales History"
        summary={`${formatNumber(filteredSales.length)} records`}
        collapsible={true}
        defaultOpen={true}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportCustomerContactsCsv}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[var(--cm-text-secondary)] bg-[var(--cm-bg-subtle)] hover:bg-[var(--cm-bg-hover)] border border-[var(--cm-border)] rounded-md cursor-pointer"
              title="Export customer WhatsApp numbers from filtered sales as CSV"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Export WhatsApp Contacts</span>
              <span className="sm:hidden">Contacts CSV</span>
            </button>
            <button
              type="button"
              onClick={() => setShowMobileFilters((v) => !v)}
              className="lg:hidden inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-[var(--cm-text-secondary)] bg-[var(--cm-bg-subtle)] hover:bg-[var(--cm-bg-hover)] rounded-md cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>{showMobileFilters ? 'Hide Filters' : 'Filters'}</span>
            </button>
          </div>
        }
      >
        <div className="p-3 sm:p-4 border-b border-[var(--cm-border)] space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search sale #, WhatsApp #, staff, or product..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border cm-input rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
              />
            </div>
            <label className="inline-flex items-center gap-2 px-3 min-h-[40px] text-xs font-medium text-[var(--cm-text-secondary)] bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] rounded-lg cursor-pointer select-none shrink-0">
              <input
                type="checkbox"
                checked={filterWhatsappOnly}
                onChange={(e) => setFilterWhatsappOnly(e.target.checked)}
                className="rounded border-[var(--cm-border-strong)] accent-[var(--cm-accent)]"
              />
              <span>Has WhatsApp #</span>
            </label>
          </div>

          <div
            className={`${
              showMobileFilters ? 'grid' : 'hidden lg:grid'
            } grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2`}
          >
            <input
              type="date"
              aria-label="Filter from date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              className="w-full min-h-[38px] px-2.5 py-1.5 text-xs border cm-input rounded-lg font-mono-num"
            />
            <input
              type="date"
              aria-label="Filter to date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              className="w-full min-h-[38px] px-2.5 py-1.5 text-xs border cm-input rounded-lg font-mono-num"
            />
            <div className="col-span-2 sm:col-span-1">
              <SearchableSelect
                options={historyProductOptions}
                value={filterProductId}
                onChange={setFilterProductId}
                emptyOptionLabel="All Products"
                placeholder="All Products"
                searchPlaceholder="Search product..."
                ariaLabel="Filter by product"
                suggestionScope="product"
                suggestedValues={frequentHistoryProductIds}
                size="sm"
              />
            </div>
            <div>
              <SearchableSelect
                options={historyPaymentOptions}
                value={filterPayment}
                onChange={(val) => setFilterPayment(val as '' | PaymentMethod)}
                emptyOptionLabel="All Payments"
                placeholder="All Payments"
                searchPlaceholder="Search payment..."
                ariaLabel="Filter by payment method"
                showFrequentSection={false}
                size="sm"
              />
            </div>
            <div>
              <SearchableSelect
                options={historyStaffOptions}
                value={filterStaffId}
                onChange={setFilterStaffId}
                emptyOptionLabel="All Sellers (Admins & Staff)"
                placeholder="All Sellers (Admins & Staff)"
                searchPlaceholder="Search admin or staff..."
                ariaLabel="Filter by admin or staff member"
                suggestionScope="staff"
                suggestedValues={frequentHistoryStaffIds}
                size="sm"
              />
            </div>
          </div>
        </div>

        {filteredSales.length === 0 ? (
          <div className="p-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
            No sales records match your filters. Use the Manual Sales Entry form above to record your first sale.
          </div>
        ) : (
          <>
            {/* Mobile Compact Expandable List */}
            <div className="md:hidden divide-y divide-[var(--cm-border)]">
              {filteredSales.map((sale) => {
                const items = saleItemsBySaleId.get(sale.id) || [];
                const isCancelled = sale.status === 'cancelled';
                return (
                  <CompactExpandableRow
                    key={sale.id}
                    dimmed={isCancelled}
                    title={
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="font-mono-num">{sale.saleNumber}</span>
                        <span className="text-[var(--cm-text-muted)]">·</span>
                        <span className="truncate font-normal text-[var(--cm-text-secondary)]">
                          {items[0]?.productName || `${sale.itemCount} items`}
                          {items.length > 1 ? ` +${items.length - 1}` : ''}
                        </span>
                      </span>
                    }
                    subtitle={`${sale.saleDateTime || formatDateDDMMYYYY(sale.saleDate)} · ${sale.paymentMethod} · ${formatNumber(sale.totalQuantity)} base qty`}
                    rightPrimary={formatPKR(sale.totalAmount)}
                    rightSecondary={
                      isCancelled ? (
                        <span className="text-[var(--cm-danger)]">Cancelled</span>
                      ) : (
                        <span className={sale.totalProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'}>
                          +{formatPKR(sale.totalProfit)}
                        </span>
                      )
                    }
                    isExpanded={expandedHistoryId === sale.id}
                    onToggle={() =>
                      setExpandedHistoryId((cur) => (cur === sale.id ? null : sale.id))
                    }
                    expandedContent={
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--cm-text-secondary)]">
                          <span>
                            Recorded by: <strong>{formatSaleSellerLabel(sale)}</strong>
                          </span>
                          <span className={isCancelled ? 'text-[var(--cm-danger)] font-semibold' : 'text-[var(--cm-success)] font-semibold'}>
                            {isCancelled ? 'Cancelled' : 'Completed'}
                          </span>
                        </div>
                        <div className="space-y-1 cm-surface border rounded-lg p-2">
                          {items.map((item) => (
                            <div
                              key={item.id}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <span className="truncate text-[var(--cm-text-primary)]">
                                {item.productName}{' '}
                                <span className="text-[var(--cm-text-muted)] font-mono-num">
                                  ×{formatSaleItemQty(item)}
                                </span>
                              </span>
                              <span className="font-mono-num font-semibold text-[var(--cm-text-primary)] shrink-0">
                                {formatPKR(item.lineTotal)}
                              </span>
                            </div>
                          ))}
                        </div>
                        {sale.customerWhatsapp && (
                          <p className="text-[11px] text-[var(--cm-text-secondary)]">
                            WhatsApp: <span className="font-mono-num font-medium">{sale.customerWhatsapp}</span>
                          </p>
                        )}
                        {sale.notes && (
                          <p className="text-[11px] text-[var(--cm-text-muted)]">Note: {sale.notes}</p>
                        )}
                        {!isCancelled && (
                          <div className="flex items-center justify-end gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => openEditModal(sale)}
                              className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-[var(--cm-text-secondary)] cm-surface border hover:bg-[var(--cm-bg-hover)] rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              disabled={cancellingSaleId === sale.id}
                              onClick={() => void handleCancelSale(sale)}
                              className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-[var(--cm-danger)] bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                            >
                              <Ban className="w-3.5 h-3.5" />
                              <span>{cancellingSaleId === sale.id ? 'Cancelling...' : 'Cancel Sale'}</span>
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
                    <th className="py-2.5 px-3">Date & Time</th>
                    <th className="py-2.5 px-3">Sale #</th>
                    <th className="py-2.5 px-3">Customer WhatsApp</th>
                    <th className="py-2.5 px-3">Recorded By</th>
                    <th className="py-2.5 px-3">Products</th>
                    <th className="py-2.5 px-3">Payment</th>
                    <th className="py-2.5 px-3 text-right">Base Qty</th>
                    <th className="py-2.5 px-3 text-right">Total</th>
                    <th className="py-2.5 px-3 text-right">Profit</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                  {filteredSales.map((sale) => {
                    const items = saleItemsBySaleId.get(sale.id) || [];
                    const summaryText = items
                      .map((i) => `${i.productName} ×${formatSaleItemQty(i)}`)
                      .join(', ');
                    const isCancelled = sale.status === 'cancelled';

                    return (
                      <tr key={sale.id} className={`hover:bg-[var(--cm-bg-hover)] ${isCancelled ? 'opacity-60' : ''}`}>
                        <td className="py-2 px-3 font-mono-num text-xs whitespace-nowrap text-[var(--cm-text-secondary)]">
                          {sale.saleDateTime || formatDateDDMMYYYY(sale.saleDate)}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-xs font-medium text-[var(--cm-text-primary)] whitespace-nowrap">
                          {sale.saleNumber}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-xs text-[var(--cm-text-secondary)] whitespace-nowrap">
                          {sale.customerWhatsapp || '—'}
                        </td>
                        <td className="py-2 px-3 text-xs font-medium text-[var(--cm-text-secondary)] whitespace-nowrap">
                          {formatSaleSellerLabel(sale)}
                        </td>
                        <td className="py-2 px-3 text-[var(--cm-text-secondary)] max-w-xs truncate" title={summaryText}>
                          {summaryText || `${sale.itemCount} items`}
                        </td>
                        <td className="py-2 px-3 text-xs text-[var(--cm-text-muted)]">{sale.paymentMethod}</td>
                        <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">
                          {formatNumber(sale.totalQuantity)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num font-semibold text-[var(--cm-text-primary)] whitespace-nowrap">
                          {formatPKR(sale.totalAmount)}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-mono-num font-semibold whitespace-nowrap ${
                            sale.totalProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                          }`}
                        >
                          {formatPKR(sale.totalProfit)}
                        </td>
                        <td className="py-2 px-3 text-xs font-semibold">
                          <span className={isCancelled ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-success)]'}>
                            {isCancelled ? 'Cancelled' : 'Completed'}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          {!isCancelled && (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openEditModal(sale)}
                                className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-accent-text)] rounded cursor-pointer"
                                title="Edit sale"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                disabled={cancellingSaleId === sale.id}
                                onClick={() => void handleCancelSale(sale)}
                                className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] rounded cursor-pointer disabled:opacity-50"
                                title="Cancel sale and restore stock"
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

      {/* Edit Sale Modal */}
      {editingSale && (
        <div className="fixed inset-0 z-50 bg-[var(--cm-bg-overlay)] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="cm-surface border rounded-t-2xl sm:rounded-xl w-full max-w-3xl max-h-[92vh] flex flex-col">
            <div className="px-4 py-3 sm:px-5 border-b border-[var(--cm-border)] flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">
                  Edit Sale {editingSale.saleNumber}
                </h3>
                <p className="text-[11px] text-[var(--cm-text-muted)]">
                  Recorded by: <strong className="text-[var(--cm-text-secondary)]">{formatSaleSellerLabel(editingSale)}</strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingSale(null)}
                className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="flex flex-col min-h-0 flex-1">
              <div className="p-4 sm:p-5 space-y-3.5 overflow-y-auto flex-1">
                {editError && (
                  <div className="p-3 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg text-xs sm:text-sm text-[var(--cm-danger)]">
                    {editError}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                      Sale Date
                    </label>
                    <input
                      type="date"
                      required
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="w-full min-h-[40px] px-2.5 py-1.5 text-xs sm:text-sm border cm-input rounded-lg font-mono-num"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                      Payment Method
                    </label>
                    <select
                      value={editPayment}
                      onChange={(e) => setEditPayment(e.target.value as PaymentMethod)}
                      className="w-full min-h-[40px] px-2.5 py-1.5 text-xs sm:text-sm border cm-input rounded-lg"
                    >
                      <option value="Cash">Cash</option>
                      <option value="Online">Online</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="edit-sale-whatsapp" className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                      Customer WhatsApp (Optional)
                    </label>
                    <input
                      id="edit-sale-whatsapp"
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      maxLength={32}
                      placeholder="+92 3XX XXXXXXX"
                      value={editWhatsapp}
                      onChange={(e) => {
                        setEditError(null);
                        setEditWhatsapp(e.target.value);
                      }}
                      className="w-full min-h-[40px] px-3 py-1.5 text-sm border cm-input rounded-lg font-mono-num"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">Notes</label>
                    <input
                      type="text"
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      className="w-full min-h-[40px] px-3 py-1.5 text-sm border cm-input rounded-lg"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[var(--cm-text-secondary)]">Line Items</span>
                    <button
                      type="button"
                      onClick={() =>
                        setEditRows((prev) => [
                          ...prev,
                          {
                            key: `edit-${Date.now()}`,
                            productId: '',
                            unitName: '',
                            conversionFactor: 1,
                            quantity: '1',
                            salePricePerUnit: '0',
                          },
                        ])
                      }
                      className="text-xs font-semibold text-[var(--cm-accent-text)] cursor-pointer"
                    >
                      + Add Product
                    </button>
                  </div>
                  {editRows.map((row) => {
                    const rowProd = productMap.get(row.productId);
                    const allowedUnits = rowProd ? getAllowedSaleUnits(rowProd) : [];
                    return (
                      <div
                        key={row.key}
                        className="grid grid-cols-12 gap-2 items-center p-2 bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] rounded-lg"
                      >
                        <div className={allowedUnits.length > 1 ? 'col-span-12 sm:col-span-4' : 'col-span-12 sm:col-span-6'}>
                          <SearchableProductSelector
                            mode="inline"
                            items={searchableItems}
                            selectedProductId={row.productId}
                            allowOutOfStock={allowStockOverride}
                            onSelect={(item) => {
                              const picked = productMap.get(item.id);
                              const def = getDefaultSaleUnit(picked || item);
                              setEditRows((prev) =>
                                prev.map((r) =>
                                  r.key === row.key
                                    ? {
                                        ...r,
                                        productId: item.id,
                                        unitName: def.unitName,
                                        conversionFactor: def.conversionQty,
                                        salePricePerUnit: String(def.salePrice),
                                      }
                                    : r
                                )
                              );
                            }}
                            onRefreshCatalog={handleRefreshCatalog}
                          />
                        </div>
                        {allowedUnits.length > 1 && (
                          <div className="col-span-12 sm:col-span-2">
                            <select
                              aria-label="Edit line unit"
                              value={row.unitName}
                              onChange={(e) => handleChangeRowUnit('edit', row.key, e.target.value)}
                              className="w-full min-h-[40px] px-2 text-xs border cm-input rounded-lg"
                            >
                              {allowedUnits.map((u) => (
                                <option key={u.unitName} value={u.unitName}>
                                  {u.unitName}
                                  {u.conversionQty > 1 ? ` (${u.conversionQty})` : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div className="col-span-5 sm:col-span-2">
                          <button
                            type="button"
                            onClick={() => setKeypadTarget({ scope: 'edit', rowKey: row.key })}
                            aria-label="Open numeric keypad for edit quantity"
                            className="w-full min-h-[40px] px-2.5 py-1.5 text-sm border cm-input hover:border-[var(--cm-accent)] rounded-lg font-mono-num tabular-nums flex items-center justify-between gap-1 cursor-pointer"
                          >
                            <span>{row.quantity || '1'}</span>
                            <Grid3X3 className="w-3.5 h-3.5 text-[var(--cm-text-muted)] shrink-0" />
                          </button>
                        </div>
                        <div className="col-span-5 sm:col-span-3">
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={row.salePricePerUnit}
                            onChange={(e) =>
                              setEditRows((prev) =>
                                prev.map((r) =>
                                  r.key === row.key ? { ...r, salePricePerUnit: e.target.value } : r
                                )
                              )
                            }
                            className="w-full min-h-[40px] px-2.5 py-1.5 text-sm cm-input border rounded-lg font-mono-num"
                          />
                        </div>
                        <div className="col-span-2 sm:col-span-1 text-right">
                          <button
                            type="button"
                            disabled={editRows.length === 1}
                            onClick={() => setEditRows((prev) => prev.filter((r) => r.key !== row.key))}
                            className="p-2 text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] disabled:opacity-40 cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="px-4 py-3 sm:px-5 border-t border-[var(--cm-border)] cm-surface flex justify-end gap-2 shrink-0 rounded-b-xl">
                <button
                  type="button"
                  onClick={() => setEditingSale(null)}
                  className="min-h-[42px] px-4 py-2 text-sm font-medium text-[var(--cm-text-secondary)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg disabled:opacity-50 cursor-pointer"
                >
                  {savingEdit ? 'Updating...' : 'Update Sale'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Custom Numeric Keypad Overlay for Quantity Entry */}
      {(() => {
        if (!keypadTarget) return null;
        const targetList = keypadTarget.scope === 'create' ? rows : editRows;
        const targetRow = targetList.find((r) => r.key === keypadTarget.rowKey);
        if (!targetRow) return null;
        const prod = productMap.get(targetRow.productId);
        const baseUnit = prod ? getEffectiveBaseUnit(prod) : 'Unit';
        const selectedUnit = targetRow.unitName || baseUnit;
        const conv = roundStockQty(targetRow.conversionFactor || 1) || 1;
        const otherBaseUsed = prod
          ? getProductUsedBaseExcludingRow(targetList, prod.id, targetRow.key)
          : 0;
        const existingSavedBase =
          keypadTarget.scope === 'edit' && editingSale && prod
            ? (saleItemsBySaleId.get(editingSale.id) || [])
                .filter((i) => i.productId === prod.id)
                .reduce(
                  (sum, i) =>
                    roundStockQty(sum + (i.baseQuantity ?? i.quantity * (i.conversionFactor || 1))),
                  0
                )
            : 0;
        const maxAvailableBase = prod
          ? Math.max(0, roundStockQty(prod.currentStock + existingSavedBase - otherBaseUsed))
          : undefined;

        return (
          <NumericKeypadOverlay
            open={true}
            productName={prod?.name || 'Quantity'}
            unit={selectedUnit}
            baseUnit={baseUnit}
            conversionFactor={conv}
            availableStock={maxAvailableBase}
            unitPrice={Number(targetRow.salePricePerUnit) || 0}
            initialQuantity={Math.max(0.01, Number(targetRow.quantity) || 1)}
            allowStockOverride={allowStockOverride}
            onConfirm={(nextQty) => {
              if (keypadTarget.scope === 'create') {
                updateRowField(keypadTarget.rowKey, 'quantity', String(nextQty));
              } else {
                setEditRows((prev) =>
                  prev.map((r) =>
                    r.key === keypadTarget.rowKey ? { ...r, quantity: String(nextQty) } : r
                  )
                );
              }
              setKeypadTarget(null);
            }}
            onClose={() => setKeypadTarget(null)}
          />
        );
      })()}
    </div>
  );
}
