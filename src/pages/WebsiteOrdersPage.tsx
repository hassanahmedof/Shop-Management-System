import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Globe,
  MapPin,
  PackageCheck,
  Phone,
  Search,
  Truck,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import {
  cancelConfirmedWebsiteOrder,
  confirmWebsiteOrder,
  rejectWebsiteOrder,
  updateWebsiteOrderDeliveryStatus,
} from '../services/websiteOrderService';
import type { WebsiteOrder, WebsiteOrderStatus } from '../types/shop';
import {
  formatDateTimeKarachi,
  formatNumber,
  formatPKR,
  roundMoney,
} from '../utils/formatters';
import { roundStockQty } from '../utils/packaging';

type StatusFilter = 'All' | WebsiteOrderStatus;

const STATUS_TABS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'All', label: 'All Orders' },
  { id: 'Pending Confirmation', label: 'Pending Confirmation' },
  { id: 'Confirmed', label: 'Confirmed' },
  { id: 'Out for Delivery', label: 'Out for Delivery' },
  { id: 'Delivered', label: 'Delivered' },
  { id: 'Cancelled/Rejected', label: 'Cancelled/Rejected' },
];

const QUICK_REJECT_REASONS = [
  'Unable to confirm on phone',
  'Customer requested cancellation',
  'Item out of stock in store',
  'Outside delivery area',
];

function getStatusBadgeClass(status: WebsiteOrderStatus): string {
  switch (status) {
    case 'Pending Confirmation':
      return 'bg-[var(--cm-warning-soft)] text-[var(--cm-warning)] border-[var(--cm-warning-border)]';
    case 'Confirmed':
      return 'bg-[var(--cm-accent-soft)] text-[var(--cm-accent-text)] border-[var(--cm-accent-border)]';
    case 'Out for Delivery':
      return 'bg-[var(--cm-info-soft,rgba(59,130,246,0.12))] text-[var(--cm-info)] border-[var(--cm-info-border,rgba(59,130,246,0.28))]';
    case 'Delivered':
      return 'bg-[var(--cm-success-soft)] text-[var(--cm-success)] border-[var(--cm-success-border)]';
    case 'Cancelled/Rejected':
      return 'bg-[var(--cm-danger-soft)] text-[var(--cm-danger)] border-[var(--cm-danger-border)]';
  }
}

interface WebsiteOrdersViewProps {
  readOnlyFinancialConfirmation?: boolean;
}

export function WebsiteOrdersView({
  readOnlyFinancialConfirmation = false,
}: WebsiteOrdersViewProps) {
  const { user, shopId, staffProfile } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { websiteOrders, products, inventoryBatches, adminMembers, loading } = useShopData();
  const { showToast } = useToast();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Custom modal state (confirm / reject / cancel)
  const [modalState, setModalState] = useState<{
    mode: 'confirm' | 'reject' | 'cancel';
    order: WebsiteOrder;
    reason: string;
  } | null>(null);

  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const activeBatchIds = useMemo(
    () =>
      inventoryBatches
        .filter((b) => b.status === 'active' && roundStockQty(b.remainingBaseQty) > 0)
        .map((b) => b.id),
    [inventoryBatches]
  );

  const currentActorName = useMemo(() => {
    if (staffProfile) return staffProfile.name;
    if (user) {
      const matchedAdmin = adminMembers.find((m) => m.authUid === user.uid);
      if (matchedAdmin) return matchedAdmin.name;
      return user.displayName || user.email?.split('@')[0] || 'Shop Owner';
    }
    return 'Shop Owner';
  }, [staffProfile, user, adminMembers]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = {
      All: websiteOrders.length,
      'Pending Confirmation': 0,
      Confirmed: 0,
      'Out for Delivery': 0,
      Delivered: 0,
      'Cancelled/Rejected': 0,
    };
    let pendingValue = 0;
    let activeFulfillmentValue = 0;
    let deliveredValue = 0;

    for (const order of websiteOrders) {
      counts[order.status] = (counts[order.status] || 0) + 1;
      if (order.status === 'Pending Confirmation') {
        pendingValue = roundMoney(pendingValue + (order.totalAmount || 0));
      } else if (order.status === 'Confirmed' || order.status === 'Out for Delivery') {
        activeFulfillmentValue = roundMoney(activeFulfillmentValue + (order.totalAmount || 0));
      } else if (order.status === 'Delivered') {
        deliveredValue = roundMoney(deliveredValue + (order.totalAmount || 0));
      }
    }

    return {
      counts,
      pendingValue,
      activeFulfillmentValue,
      deliveredValue,
    };
  }, [websiteOrders]);

  const filteredOrders = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return websiteOrders.filter((order) => {
      if (statusFilter !== 'All' && order.status !== statusFilter) return false;
      if (!q) return true;
      const phone = (order.customerPhone || '').toLowerCase();
      const phoneDigits = phone.replace(/\D/g, '');
      return (
        (order.orderNumber || '').toLowerCase().includes(q) ||
        (order.customerName || '').toLowerCase().includes(q) ||
        phone.includes(q) ||
        (qDigits.length >= 3 && phoneDigits.includes(qDigits)) ||
        (order.customerAddress || '').toLowerCase().includes(q) ||
        (order.linkedSaleNumber || '').toLowerCase().includes(q) ||
        (order.items || []).some((item) => item.productName.toLowerCase().includes(q))
      );
    });
  }, [websiteOrders, statusFilter, searchTerm]);

  const getOrderStockIssues = (order: WebsiteOrder): string[] => {
    if (readOnlyFinancialConfirmation) return [];
    const requiredByProduct = new Map<string, { name: string; req: number; unit: string }>();
    for (const item of order.items || []) {
      const prev = requiredByProduct.get(item.productId);
      const baseQty = roundStockQty(
        Math.max(
          0,
          Number(item.baseQuantity) ||
            (Number(item.quantity) || 0) * (Number(item.conversionFactor) || 1)
        )
      );
      if (prev) {
        prev.req = roundStockQty(prev.req + baseQty);
      } else {
        requiredByProduct.set(item.productId, {
          name: item.productName,
          req: baseQty,
          unit: item.unitName || 'Unit',
        });
      }
    }
    const issues: string[] = [];
    for (const [pid, info] of requiredByProduct.entries()) {
      const prod = productMap.get(pid);
      if (!prod) {
        issues.push(`${info.name}: product deleted or missing`);
      } else if (roundStockQty(prod.currentStock) < info.req) {
        issues.push(
          `${prod.name}: need ${formatNumber(info.req)} base qty, only ${formatNumber(prod.currentStock)} in store`
        );
      }
    }
    return issues;
  };

  const getOrderPriceWarnings = (order: WebsiteOrder): string[] => {
    if (readOnlyFinancialConfirmation || !order.itemsLoaded || !order.items?.length) return [];
    const warnings: string[] = [];
    let computedSubtotal = 0;

    if (order.itemCount !== order.items.length) {
      warnings.push(
        `Header reports ${formatNumber(order.itemCount)} items, but ${formatNumber(order.items.length)} item documents exist.`
      );
    }

    for (const item of order.items) {
      computedSubtotal = roundMoney(computedSubtotal + (Number(item.lineTotal) || 0));
      const prod = productMap.get(item.productId);
      if (!prod) continue;
      const baseUnit = (prod.baseUnit || prod.unit || '').trim().toLowerCase();
      const unitLower = (item.unitName || '').trim().toLowerCase();
      let expectedPrice = roundMoney(prod.salePrice);
      if (unitLower && unitLower !== baseUnit) {
        const pkg = (prod.packagingUnits || []).find(
          (p) => (p.unitName || '').trim().toLowerCase() === unitLower
        );
        if (pkg) {
          expectedPrice = roundMoney(pkg.salePrice);
        }
      }
      if (Math.abs(roundMoney(item.unitPrice) - expectedPrice) > 0.01) {
        warnings.push(
          `${item.productName} (${item.unitName}): submitted ${formatPKR(item.unitPrice)} vs catalog ${formatPKR(expectedPrice)}.`
        );
      }
    }

    if (Math.abs(roundMoney(order.subtotal) - computedSubtotal) > 0.05) {
      warnings.push(
        `Order subtotal (${formatPKR(order.subtotal)}) differs from sum of line items (${formatPKR(computedSubtotal)}).`
      );
    }

    return warnings;
  };

  const handleConfirmOrder = async (order: WebsiteOrder) => {
    if (!activeShopId || readOnlyFinancialConfirmation || busyOrderId) return;
    setActionError(null);
    setBusyOrderId(order.id);
    try {
      const result = await confirmWebsiteOrder(activeShopId, order, {
        activeBatchIds,
        confirmedByUid: user?.uid || activeShopId,
        confirmedByName: currentActorName,
      });
      setModalState(null);
      showToast({
        id: `confirm-order-${order.id}`,
        title: 'Website Order Confirmed',
        message: `${order.orderNumber} converted to Sale ${result.saleNumber} and stock deducted.`,
        tone: 'success',
        durationMs: 4500,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to confirm website order.';
      setActionError(msg);
      showToast({
        id: `confirm-order-err-${order.id}`,
        title: 'Confirmation Failed',
        message: msg,
        tone: 'error',
        durationMs: 6000,
      });
    } finally {
      setBusyOrderId(null);
    }
  };

  const handleRejectPendingOrder = async (order: WebsiteOrder, reason: string) => {
    if (!activeShopId || readOnlyFinancialConfirmation || busyOrderId) return;
    setActionError(null);
    setBusyOrderId(order.id);
    try {
      await rejectWebsiteOrder(activeShopId, order, reason);
      setModalState(null);
      showToast({
        id: `reject-order-${order.id}`,
        title: 'Order Rejected',
        message: `${order.orderNumber} rejected. Storefront reservation restored; POS ledger unchanged.`,
        tone: 'warning',
        durationMs: 4500,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to reject website order.';
      setActionError(msg);
      showToast({
        id: `reject-order-err-${order.id}`,
        title: 'Reject Failed',
        message: msg,
        tone: 'error',
        durationMs: 6000,
      });
    } finally {
      setBusyOrderId(null);
    }
  };

  const handleCancelConfirmedOrder = async (order: WebsiteOrder, reason: string) => {
    if (!activeShopId || readOnlyFinancialConfirmation || busyOrderId) return;
    setActionError(null);
    setBusyOrderId(order.id);
    try {
      await cancelConfirmedWebsiteOrder(activeShopId, order, reason);
      setModalState(null);
      showToast({
        id: `cancel-order-${order.id}`,
        title: 'Order Cancelled & Stock Restored',
        message: `${order.orderNumber} cancelled and linked POS sale reversed.`,
        tone: 'warning',
        durationMs: 5000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to cancel confirmed order.';
      setActionError(msg);
      showToast({
        id: `cancel-order-err-${order.id}`,
        title: 'Cancellation Failed',
        message: msg,
        tone: 'error',
        durationMs: 6000,
      });
    } finally {
      setBusyOrderId(null);
    }
  };

  const handleDeliveryUpdate = async (
    order: WebsiteOrder,
    nextStatus: 'Out for Delivery' | 'Delivered'
  ) => {
    if (!activeShopId || busyOrderId) return;
    setActionError(null);
    setBusyOrderId(order.id);
    try {
      await updateWebsiteOrderDeliveryStatus(activeShopId, order, nextStatus);
      showToast({
        id: `delivery-order-${order.id}`,
        title: nextStatus === 'Delivered' ? 'Order Delivered' : 'Out for Delivery',
        message: `${order.orderNumber} marked as "${nextStatus}".`,
        tone: 'success',
        durationMs: 3500,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update delivery status.';
      setActionError(msg);
      showToast({
        id: `delivery-order-err-${order.id}`,
        title: 'Update Failed',
        message: msg,
        tone: 'error',
        durationMs: 5500,
      });
    } finally {
      setBusyOrderId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <button
          type="button"
          onClick={() => setStatusFilter('Pending Confirmation')}
          className="text-left cm-surface border rounded-xl p-3 sm:p-3.5 hover:border-[var(--cm-warning-border)] transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-[var(--cm-text-muted)]">
            <span>Pending Confirmation</span>
            <Clock className="w-3.5 h-3.5 text-[var(--cm-warning)] shrink-0" />
          </div>
          <div className="mt-1 text-lg sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)]">
            {formatNumber(statusCounts.counts['Pending Confirmation'])}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--cm-warning)] font-mono-num truncate">
            {formatPKR(statusCounts.pendingValue)} COD
          </div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter('Confirmed')}
          className="text-left cm-surface border rounded-xl p-3 sm:p-3.5 hover:border-[var(--cm-accent-border)] transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-[var(--cm-text-muted)]">
            <span>Confirmed</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-[var(--cm-accent-text)] shrink-0" />
          </div>
          <div className="mt-1 text-lg sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)]">
            {formatNumber(statusCounts.counts.Confirmed)}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--cm-text-muted)] truncate">
            Ready to dispatch
          </div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter('Out for Delivery')}
          className="text-left cm-surface border rounded-xl p-3 sm:p-3.5 hover:border-[var(--cm-accent-border)] transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-[var(--cm-text-muted)]">
            <span>Out for Delivery</span>
            <Truck className="w-3.5 h-3.5 text-[var(--cm-info)] shrink-0" />
          </div>
          <div className="mt-1 text-lg sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)]">
            {formatNumber(statusCounts.counts['Out for Delivery'])}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--cm-info)] font-mono-num truncate">
            {formatPKR(statusCounts.activeFulfillmentValue)} active
          </div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter('Delivered')}
          className="text-left cm-surface border rounded-xl p-3 sm:p-3.5 hover:border-[var(--cm-success-border)] transition-colors cursor-pointer"
        >
          <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-[var(--cm-text-muted)]">
            <span>Delivered</span>
            <PackageCheck className="w-3.5 h-3.5 text-[var(--cm-success)] shrink-0" />
          </div>
          <div className="mt-1 text-lg sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)]">
            {formatNumber(statusCounts.counts.Delivered)}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--cm-success)] font-mono-num truncate">
            {formatPKR(statusCounts.deliveredValue)} collected
          </div>
        </button>
      </div>

      {/* Main Orders Section */}
      <section className="cm-surface border rounded-xl overflow-hidden">
        <div className="p-3.5 sm:p-4 border-b border-[var(--cm-border)] space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
            <div>
              <div className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-[var(--cm-accent-text)] shrink-0" />
                <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">
                  Website Orders (Cash on Delivery)
                </h2>
              </div>
              <p className="text-xs text-[var(--cm-text-muted)] mt-0.5">
                {readOnlyFinancialConfirmation
                  ? 'View customer COD orders and update dispatch / delivery status for confirmed orders.'
                  : 'Review incoming storefront orders, confirm to deduct real FIFO stock & record sale, or reject to release online stock.'}
              </p>
            </div>

            <div className="relative w-full sm:w-72 shrink-0">
              <Search className="w-4 h-4 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search order #, name, phone, item..."
                className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border cm-input rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
              />
            </div>
          </div>

          {/* Status Filter Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
            {STATUS_TABS.map((tab) => {
              const active = statusFilter === tab.id;
              const count = statusCounts.counts[tab.id] || 0;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-[var(--cm-accent-soft)] text-[var(--cm-accent-text)] border-[var(--cm-accent-border)] font-semibold'
                      : 'bg-[var(--cm-bg-subtle)] text-[var(--cm-text-secondary)] border-[var(--cm-border)] hover:text-[var(--cm-text-primary)]'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span className="font-mono-num tabular-nums opacity-80">({count})</span>
                </button>
              );
            })}
          </div>

          {actionError && (
            <div className="p-3 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg text-xs sm:text-sm text-[var(--cm-danger)] flex items-start justify-between gap-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{actionError}</span>
              </div>
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="p-0.5 opacity-80 hover:opacity-100 cursor-pointer"
                aria-label="Dismiss error"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {loading && websiteOrders.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--cm-text-muted)]">
            Loading website orders...
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="p-8 text-center space-y-1.5">
            <div className="text-sm font-medium text-[var(--cm-text-primary)]">
              No website orders match the current view
            </div>
            <p className="text-xs text-[var(--cm-text-muted)]">
              {websiteOrders.length === 0
                ? 'Incoming Cash-on-Delivery orders placed from the customer storefront will appear here automatically.'
                : 'Try switching status tabs or clearing your search query.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--cm-border)]">
            {filteredOrders.map((order) => {
              const isExpanded =
                expandedOrderId === order.id || order.status === 'Pending Confirmation';
              const isBusy = busyOrderId === order.id;
              const stockIssues =
                order.status === 'Pending Confirmation' ? getOrderStockIssues(order) : [];
              const priceWarnings =
                order.status === 'Pending Confirmation' ? getOrderPriceWarnings(order) : [];
              const badgeClass = getStatusBadgeClass(order.status);

              return (
                <article
                  key={order.id}
                  className={`p-3.5 sm:p-4 transition-colors ${
                    order.status === 'Pending Confirmation'
                      ? 'bg-[var(--cm-warning-soft)]/35'
                      : order.status === 'Cancelled/Rejected'
                        ? 'opacity-75'
                        : 'hover:bg-[var(--cm-bg-hover)]/40'
                  }`}
                >
                  {/* Order Header Row */}
                  <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedOrderId((cur) => (cur === order.id ? null : order.id))
                        }
                        aria-expanded={isExpanded}
                        aria-label={isExpanded ? 'Collapse order details' : 'Expand order details'}
                        className="mt-0.5 p-1 rounded-md text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] hover:bg-[var(--cm-bg-subtle)] cursor-pointer shrink-0"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </button>

                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono-num text-sm font-bold text-[var(--cm-text-primary)]">
                            {order.orderNumber}
                          </span>
                          <span
                            className={`inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-md border ${badgeClass}`}
                          >
                            {order.status}
                          </span>
                          <span className="text-[11px] font-medium text-[var(--cm-text-muted)]">
                            {order.paymentMethod}
                          </span>
                          {order.linkedSaleNumber && (
                            <span className="text-[11px] font-mono-num text-[var(--cm-accent-text)]">
                              Sale #{order.linkedSaleNumber}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--cm-text-secondary)]">
                          <span className="font-semibold text-[var(--cm-text-primary)]">
                            {order.customerName}
                          </span>
                          <a
                            href={`tel:${order.customerPhone}`}
                            className="inline-flex items-center gap-1 font-mono-num text-[var(--cm-accent-text)] hover:underline"
                          >
                            <Phone className="w-3 h-3 shrink-0" />
                            <span>{order.customerPhone}</span>
                          </a>
                          <span className="text-[var(--cm-text-muted)] font-mono-num">
                            {formatDateTimeKarachi(order.createdAt)}
                          </span>
                        </div>

                        <div className="flex items-start gap-1.5 text-xs text-[var(--cm-text-secondary)]">
                          <MapPin className="w-3.5 h-3.5 text-[var(--cm-text-muted)] shrink-0 mt-0.5" />
                          <span className="break-words">{order.customerAddress}</span>
                        </div>
                      </div>
                    </div>

                    {/* Right Totals + Primary Actions */}
                    <div className="flex flex-col sm:flex-row sm:items-center lg:flex-col lg:items-end justify-between gap-2.5 pl-7 lg:pl-0 shrink-0">
                      <div className="sm:text-left lg:text-right">
                        <div className="text-base sm:text-lg font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)]">
                          {formatPKR(order.totalAmount)}
                        </div>
                        <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num">
                          {formatNumber(order.itemCount)}{' '}
                          {order.itemCount === 1 ? 'item' : 'items'}
                          {(order.deliveryFee || 0) > 0
                            ? ` · incl. ${formatPKR(order.deliveryFee)} delivery`
                            : ' · free delivery'}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {order.status === 'Pending Confirmation' && (
                          readOnlyFinancialConfirmation ? (
                            <span className="text-[11px] font-medium text-[var(--cm-warning)]">
                              Owner/Admin confirmation required
                            </span>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  setModalState({ mode: 'confirm', order, reason: '' })
                                }
                                className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                <span>{isBusy ? 'Processing...' : 'Confirm Order'}</span>
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  setModalState({
                                    mode: 'reject',
                                    order,
                                    reason: 'Unable to confirm on phone',
                                  })
                                }
                                className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[var(--cm-danger)] bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] hover:opacity-90 disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                              >
                                <Ban className="w-3.5 h-3.5 shrink-0" />
                                <span>Reject</span>
                              </button>
                            </>
                          )
                        )}

                        {order.status === 'Confirmed' && (
                          <>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDeliveryUpdate(order, 'Out for Delivery')}
                              className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                            >
                              <Truck className="w-3.5 h-3.5 shrink-0" />
                              <span>Out for Delivery</span>
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDeliveryUpdate(order, 'Delivered')}
                              className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[var(--cm-success)] bg-[var(--cm-success-soft)] border border-[var(--cm-success-border)] hover:opacity-90 disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                            >
                              <PackageCheck className="w-3.5 h-3.5 shrink-0" />
                              <span>Mark Delivered</span>
                            </button>
                            {!readOnlyFinancialConfirmation && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  setModalState({
                                    mode: 'cancel',
                                    order,
                                    reason: 'Cancelled before dispatch',
                                  })
                                }
                                className="min-h-[36px] inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[var(--cm-danger)] border border-[var(--cm-danger-border)] hover:bg-[var(--cm-danger-soft)] disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                              >
                                <Ban className="w-3.5 h-3.5 shrink-0" />
                                <span>Cancel</span>
                              </button>
                            )}
                          </>
                        )}

                        {order.status === 'Out for Delivery' && (
                          <>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleDeliveryUpdate(order, 'Delivered')}
                              className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[var(--cm-success)] hover:opacity-90 disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                            >
                              <PackageCheck className="w-3.5 h-3.5 shrink-0" />
                              <span>Mark Delivered</span>
                            </button>
                            {!readOnlyFinancialConfirmation && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  setModalState({
                                    mode: 'cancel',
                                    order,
                                    reason: 'Delivery failed / customer refused COD',
                                  })
                                }
                                className="min-h-[36px] inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-[var(--cm-danger)] border border-[var(--cm-danger-border)] hover:bg-[var(--cm-danger-soft)] disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                              >
                                <Ban className="w-3.5 h-3.5 shrink-0" />
                                <span>Cancel</span>
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Details: Notes, Stock Warnings, Line Items */}
                  {isExpanded && (
                    <div className="mt-3 pl-7 space-y-2.5">
                      {stockIssues.length > 0 && (
                        <div className="p-2.5 rounded-lg bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] text-xs text-[var(--cm-danger)] space-y-1">
                          <div className="font-semibold flex items-center gap-1.5">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>Real Store Stock Warning</span>
                          </div>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {stockIssues.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {priceWarnings.length > 0 && (
                        <div className="p-2.5 rounded-lg bg-[var(--cm-warning-soft)] border border-[var(--cm-warning-border)] text-xs text-[var(--cm-warning)] space-y-1">
                          <div className="font-semibold flex items-center gap-1.5">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span>Price / Total Verification Notice</span>
                          </div>
                          <ul className="list-disc pl-4 space-y-0.5">
                            {priceWarnings.map((warn) => (
                              <li key={warn}>{warn}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {order.customerNotes && (
                        <div className="text-xs text-[var(--cm-text-secondary)] bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] rounded-lg px-3 py-2">
                          <span className="font-semibold text-[var(--cm-text-primary)]">
                            Customer Note:
                          </span>{' '}
                          {order.customerNotes}
                        </div>
                      )}

                      {order.rejectionReason && (
                        <div className="text-xs text-[var(--cm-danger)] bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg px-3 py-2">
                          <span className="font-semibold">Cancellation / Rejection Reason:</span>{' '}
                          {order.rejectionReason}
                        </div>
                      )}

                      <div className="border border-[var(--cm-border)] rounded-lg overflow-hidden bg-[var(--cm-bg-surface)]">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="bg-[var(--cm-bg-subtle)] border-b border-[var(--cm-border)] text-[var(--cm-text-secondary)] font-semibold">
                                <th className="py-2 px-3">Product</th>
                                <th className="py-2 px-3">Unit</th>
                                <th className="py-2 px-3 text-right">Qty</th>
                                <th className="py-2 px-3 text-right">Unit Price</th>
                                <th className="py-2 px-3 text-right">Line Total</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--cm-border)]">
                              {(!order.items || order.items.length === 0) ? (
                                <tr>
                                  <td
                                    colSpan={5}
                                    className="py-3 px-3 text-center text-[var(--cm-text-muted)]"
                                  >
                                    {order.itemsLoaded === false
                                      ? 'Loading order items...'
                                      : 'No line items found for this order.'}
                                  </td>
                                </tr>
                              ) : (
                                order.items.map((item, idx) => (
                                  <tr key={item.id || `${order.id}-${item.productId}-${idx}`}>
                                    <td className="py-2 px-3 font-medium text-[var(--cm-text-primary)]">
                                      {item.productName}
                                    </td>
                                    <td className="py-2 px-3 text-[var(--cm-text-secondary)]">
                                      {item.unitName}
                                      {item.conversionFactor > 1 && (
                                        <span className="text-[11px] text-[var(--cm-text-muted)] ml-1 font-mono-num">
                                          (×{formatNumber(item.conversionFactor)})
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-primary)]">
                                      {formatNumber(item.quantity)}
                                    </td>
                                    <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-secondary)]">
                                      {formatPKR(item.unitPrice)}
                                    </td>
                                    <td className="py-2 px-3 text-right font-mono-num font-semibold text-[var(--cm-text-primary)]">
                                      {formatPKR(item.lineTotal)}
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                            <tfoot className="bg-[var(--cm-bg-subtle)] border-t border-[var(--cm-border)] font-mono-num">
                              <tr>
                                <td colSpan={4} className="py-1.5 px-3 text-right text-[var(--cm-text-secondary)]">
                                  Subtotal
                                </td>
                                <td className="py-1.5 px-3 text-right font-semibold text-[var(--cm-text-primary)]">
                                  {formatPKR(order.subtotal)}
                                </td>
                              </tr>
                              {(order.deliveryFee || 0) > 0 && (
                                <tr>
                                  <td colSpan={4} className="py-1.5 px-3 text-right text-[var(--cm-text-secondary)]">
                                    Delivery Fee
                                  </td>
                                  <td className="py-1.5 px-3 text-right font-semibold text-[var(--cm-text-primary)]">
                                    {formatPKR(order.deliveryFee)}
                                  </td>
                                </tr>
                              )}
                              <tr>
                                <td colSpan={4} className="py-1.5 px-3 text-right font-semibold text-[var(--cm-text-primary)]">
                                  Total Cash on Delivery
                                </td>
                                <td className="py-1.5 px-3 text-right font-bold text-[var(--cm-accent-text)]">
                                  {formatPKR(order.totalAmount)}
                                </td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      </div>

                      {(order.confirmedByName || order.confirmedAt || order.deliveredAt) && (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--cm-text-muted)]">
                          {order.confirmedByName && (
                            <span>Confirmed by {order.confirmedByName}</span>
                          )}
                          {order.confirmedAt && (
                            <span className="font-mono-num">
                              Confirmed: {formatDateTimeKarachi(order.confirmedAt)}
                            </span>
                          )}
                          {order.outForDeliveryAt && (
                            <span className="font-mono-num">
                              Dispatched: {formatDateTimeKarachi(order.outForDeliveryAt)}
                            </span>
                          )}
                          {order.deliveredAt && (
                            <span className="font-mono-num">
                              Delivered: {formatDateTimeKarachi(order.deliveredAt)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Confirm / Reject / Cancel Modal */}
      {modalState && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--cm-bg-overlay)]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="website-order-modal-title"
        >
          <div className="w-full max-w-md bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] rounded-xl shadow-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3
                  id="website-order-modal-title"
                  className="text-base font-semibold text-[var(--cm-text-primary)]"
                >
                  {modalState.mode === 'confirm'
                    ? `Confirm Order ${modalState.order.orderNumber}`
                    : modalState.mode === 'reject'
                      ? `Reject Order ${modalState.order.orderNumber}`
                      : `Cancel Confirmed Order ${modalState.order.orderNumber}`}
                </h3>
                <p className="text-xs text-[var(--cm-text-muted)] mt-0.5">
                  {modalState.order.customerName} · {modalState.order.customerPhone} ·{' '}
                  {formatPKR(modalState.order.totalAmount)}
                </p>
              </div>
              <button
                type="button"
                disabled={busyOrderId === modalState.order.id}
                onClick={() => setModalState(null)}
                className="p-1 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] rounded cursor-pointer"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {modalState.mode === 'confirm' ? (
              <div className="space-y-3 text-xs text-[var(--cm-text-secondary)]">
                <p>
                  Confirming this order will atomically create a POS sale (attributed to{' '}
                  <strong className="text-[var(--cm-text-primary)]">Website Storefront</strong>),
                  deduct store product stock using FIFO inventory batches, and record stock
                  movements.
                </p>
                {getOrderStockIssues(modalState.order).length > 0 && (
                  <div className="p-2.5 rounded-lg bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] text-[var(--cm-danger)] space-y-1">
                    <div className="font-semibold">Insufficient real stock detected:</div>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {getOrderStockIssues(modalState.order).map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {getOrderPriceWarnings(modalState.order).length > 0 && (
                  <div className="p-2.5 rounded-lg bg-[var(--cm-warning-soft)] border border-[var(--cm-warning-border)] text-[var(--cm-warning)] space-y-1">
                    <div className="font-semibold">Price / total mismatch detected:</div>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {getOrderPriceWarnings(modalState.order).map((warn) => (
                        <li key={warn}>{warn}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-[var(--cm-text-secondary)]">
                  {modalState.mode === 'reject'
                    ? 'Rejecting restores reserved stock in the public storefront catalog only. Real store stock, FIFO batches, and POS sales remain untouched.'
                    : `Cancelling reverses the linked POS sale (${modalState.order.linkedSaleNumber || 'if present'}), restores real inventory batches, and updates stock movements.`}
                </p>

                {modalState.mode === 'reject' && (
                  <div className="flex flex-wrap gap-1.5">
                    {QUICK_REJECT_REASONS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setModalState({ ...modalState, reason: preset })}
                        className={`px-2 py-1 text-[11px] rounded-md border cursor-pointer transition-colors ${
                          modalState.reason === preset
                            ? 'bg-[var(--cm-accent-soft)] text-[var(--cm-accent-text)] border-[var(--cm-accent-border)]'
                            : 'bg-[var(--cm-bg-subtle)] text-[var(--cm-text-secondary)] border-[var(--cm-border)]'
                        }`}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                )}

                <div>
                  <label
                    htmlFor="website-order-reason-input"
                    className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1"
                  >
                    Reason
                  </label>
                  <input
                    id="website-order-reason-input"
                    type="text"
                    maxLength={300}
                    value={modalState.reason}
                    onChange={(e) => setModalState({ ...modalState, reason: e.target.value })}
                    placeholder="Enter reason..."
                    className="w-full min-h-[40px] px-3 py-1.5 text-sm border cm-input rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
                  />
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--cm-border)]">
              <button
                type="button"
                disabled={busyOrderId === modalState.order.id}
                onClick={() => setModalState(null)}
                className="min-h-[38px] px-3.5 py-1.5 text-xs font-medium text-[var(--cm-text-secondary)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-subtle)] rounded-lg cursor-pointer"
              >
                Close
              </button>
              {modalState.mode === 'confirm' && (
                <button
                  type="button"
                  disabled={busyOrderId === modalState.order.id}
                  onClick={() => void handleConfirmOrder(modalState.order)}
                  className="min-h-[38px] px-4 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] disabled:opacity-50 rounded-lg cursor-pointer"
                >
                  {busyOrderId === modalState.order.id
                    ? 'Confirming...'
                    : 'Confirm & Deduct Stock'}
                </button>
              )}
              {modalState.mode === 'reject' && (
                <button
                  type="button"
                  disabled={busyOrderId === modalState.order.id}
                  onClick={() =>
                    void handleRejectPendingOrder(modalState.order, modalState.reason)
                  }
                  className="min-h-[38px] px-4 py-1.5 text-xs font-semibold text-white bg-[var(--cm-danger)] hover:opacity-90 disabled:opacity-50 rounded-lg cursor-pointer"
                >
                  {busyOrderId === modalState.order.id ? 'Rejecting...' : 'Reject Order'}
                </button>
              )}
              {modalState.mode === 'cancel' && (
                <button
                  type="button"
                  disabled={busyOrderId === modalState.order.id}
                  onClick={() =>
                    void handleCancelConfirmedOrder(modalState.order, modalState.reason)
                  }
                  className="min-h-[38px] px-4 py-1.5 text-xs font-semibold text-white bg-[var(--cm-danger)] hover:opacity-90 disabled:opacity-50 rounded-lg cursor-pointer"
                >
                  {busyOrderId === modalState.order.id ? 'Cancelling...' : 'Cancel Order & Reverse Sale'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function WebsiteOrdersPage() {
  return <WebsiteOrdersView readOnlyFinancialConfirmation={false} />;
}
