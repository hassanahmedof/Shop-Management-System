import { ChevronDown, ChevronRight, Grid3X3, Minus, Plus, Trash2 } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { formatNumber, formatPKR, roundMoney } from '../utils/formatters';
import {
  isFractionalUnit,
  pluralizeUnit,
  roundStockQty,
  type SelectableSaleUnit,
} from '../utils/packaging';

export interface CompactSaleRowItem {
  key: string;
  productId: string;
  name: string;
  brandName?: string;
  unit: string; // Base stock unit
  unitName?: string; // Selected selling unit
  conversionFactor?: number;
  allowedUnits?: SelectableSaleUnit[];
  currentStock: number; // In baseUnit
  quantity: string; // In selected selling unit
  salePricePerUnit: string;
  wholesalePrice?: number;
  purchasePrice?: number; // Base unit cost
}

interface CompactSaleItemsListProps {
  items: CompactSaleRowItem[];
  expandedKey: string | null;
  onToggleExpand: (key: string) => void;
  onStepQuantity: (key: string, delta: number) => void;
  onChangeQuantity: (key: string, value: string) => void;
  onChangeUnit?: (key: string, unitName: string) => void;
  onOpenKeypad: (key: string) => void;
  onChangePrice?: (key: string, value: string) => void;
  onRemove: (key: string) => void;
  priceEditable?: boolean;
  allowStockOverride?: boolean;
  showProfit?: boolean;
  lastHighlightedKey?: string | null;
  emptyMessage?: string;
}

const DESKTOP_MEDIA_QUERY = '(min-width: 640px)';

function getInitialIsDesktop(): boolean {
  if (typeof window === 'undefined') return true;
  if (typeof window.matchMedia === 'function') {
    const mql = window.matchMedia(DESKTOP_MEDIA_QUERY);
    if (mql && typeof mql.matches === 'boolean') {
      return mql.matches;
    }
  }
  return window.innerWidth >= 640;
}

function useIsDesktopViewport(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(getInitialIsDesktop);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (typeof window.matchMedia === 'function') {
      const mql = window.matchMedia(DESKTOP_MEDIA_QUERY);
      if (mql && typeof mql.matches === 'boolean') {
        setIsDesktop(mql.matches);
        const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
        if (typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', onChange);
          return () => mql.removeEventListener('change', onChange);
        }
        mql.addListener(onChange);
        return () => mql.removeListener(onChange);
      }
    }
    const onResize = () => setIsDesktop(window.innerWidth >= 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return isDesktop;
}

interface CompactSaleRowProps {
  item: CompactSaleRowItem;
  rowNumber: number;
  isDesktop: boolean;
  isExpanded: boolean;
  isHighlighted: boolean;
  cumulativeProductBase: number;
  exceedsStock: boolean;
  atMaxStock: boolean;
  priceEditable: boolean;
  showProfit: boolean;
  onToggleExpand: (key: string) => void;
  onStepQuantity: (key: string, delta: number) => void;
  onChangeQuantity: (key: string, value: string) => void;
  onChangeUnit?: (key: string, unitName: string) => void;
  onOpenKeypad: (key: string) => void;
  onChangePrice?: (key: string, value: string) => void;
  onRemove: (key: string) => void;
}

function areCompactSaleRowPropsEqual(prev: CompactSaleRowProps, next: CompactSaleRowProps): boolean {
  if (
    prev.rowNumber !== next.rowNumber ||
    prev.isDesktop !== next.isDesktop ||
    prev.isExpanded !== next.isExpanded ||
    prev.isHighlighted !== next.isHighlighted ||
    prev.cumulativeProductBase !== next.cumulativeProductBase ||
    prev.exceedsStock !== next.exceedsStock ||
    prev.atMaxStock !== next.atMaxStock ||
    prev.priceEditable !== next.priceEditable ||
    prev.showProfit !== next.showProfit ||
    prev.onToggleExpand !== next.onToggleExpand ||
    prev.onStepQuantity !== next.onStepQuantity ||
    prev.onChangeQuantity !== next.onChangeQuantity ||
    prev.onChangeUnit !== next.onChangeUnit ||
    prev.onOpenKeypad !== next.onOpenKeypad ||
    prev.onChangePrice !== next.onChangePrice ||
    prev.onRemove !== next.onRemove
  ) {
    return false;
  }

  const a = prev.item;
  const b = next.item;
  if (a === b) return true;

  return (
    a.key === b.key &&
    a.productId === b.productId &&
    a.name === b.name &&
    a.brandName === b.brandName &&
    a.unit === b.unit &&
    a.unitName === b.unitName &&
    a.conversionFactor === b.conversionFactor &&
    a.allowedUnits === b.allowedUnits &&
    a.currentStock === b.currentStock &&
    a.quantity === b.quantity &&
    a.salePricePerUnit === b.salePricePerUnit &&
    a.wholesalePrice === b.wholesalePrice &&
    a.purchasePrice === b.purchasePrice
  );
}

const CompactSaleRow = memo(function CompactSaleRow({
  item,
  rowNumber,
  isDesktop,
  isExpanded,
  isHighlighted,
  cumulativeProductBase,
  exceedsStock,
  atMaxStock,
  priceEditable,
  showProfit,
  onToggleExpand,
  onStepQuantity,
  onChangeQuantity,
  onChangeUnit,
  onOpenKeypad,
  onChangePrice,
  onRemove,
}: CompactSaleRowProps) {
  const qtyNum = Math.max(0, roundStockQty(Number(item.quantity) || 0));
  const priceNum = Math.max(0, Number(item.salePricePerUnit) || 0);
  const conv = roundStockQty(item.conversionFactor ?? 1) || 1;
  const selectedUnitLabel = item.unitName || item.unit;
  const baseUsed = roundStockQty(qtyNum * conv);
  const lineTotal = roundMoney(qtyNum * priceNum);
  const lineProfit =
    showProfit && typeof item.purchasePrice === 'number'
      ? roundMoney(lineTotal - baseUsed * item.purchasePrice)
      : 0;
  const allowedUnits = Array.isArray(item.allowedUnits) ? item.allowedUnits : [];
  const decimalAllowed = isFractionalUnit(selectedUnitLabel);
  const minQty = decimalAllowed ? 0.25 : 1;
  const atMinQty = qtyNum <= minQty;

  const selectedUnitMeta = isExpanded
    ? allowedUnits.find((u) => u.unitName.toLowerCase() === selectedUnitLabel.toLowerCase())
    : undefined;
  const activeWholesale = selectedUnitMeta?.wholesalePrice ?? item.wholesalePrice ?? 0;

  return (
    <div
      className={`transition-colors ${
        exceedsStock
          ? 'bg-[var(--cm-danger-soft)]'
          : isHighlighted
            ? 'bg-[var(--cm-accent-soft)]'
            : isExpanded
              ? 'bg-[var(--cm-bg-subtle)]'
              : 'bg-[var(--cm-bg-surface)]'
      }`}
    >
      {isDesktop ? (
        /* Desktop Collapsed / Summary Row */
        <div className="grid grid-cols-12 items-center gap-2 px-3.5 py-2 min-h-[48px] hover:bg-[var(--cm-bg-hover)]">
          <button
            type="button"
            onClick={() => onToggleExpand(item.key)}
            aria-expanded={isExpanded}
            className="col-span-5 min-w-0 flex items-center gap-2 text-left cursor-pointer py-0.5"
          >
            <span className="text-[var(--cm-text-muted)] shrink-0">
              {isExpanded ? (
                <ChevronDown className="w-4 h-4 text-[var(--cm-accent-text)]" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </span>
            <span className="text-[11px] font-mono-num text-[var(--cm-text-muted)] shrink-0 w-5 text-right">
              {rowNumber}.
            </span>
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <span className="text-sm font-medium text-[var(--cm-text-primary)] truncate">
                {item.name}
              </span>
              {exceedsStock && (
                <span className="text-[11px] font-semibold text-[var(--cm-danger)] whitespace-nowrap shrink-0">
                  · Low ({formatNumber(item.currentStock)} {item.unit})
                </span>
              )}
            </div>
          </button>

          {/* Desktop Inline Quick Stepper + Unit */}
          <div className="col-span-3 flex items-center justify-center gap-1.5">
            <div className="inline-flex items-center rounded-lg border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] p-0.5 shrink-0">
              <button
                type="button"
                onClick={() => onStepQuantity(item.key, -1)}
                disabled={atMinQty}
                aria-label={`Decrease quantity of ${item.name}`}
                className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--cm-text-primary)] hover:bg-[var(--cm-bg-surface)] active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors touch-manipulation"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onOpenKeypad(item.key)}
                aria-label={`Edit quantity of ${item.name}`}
                title="Tap to enter exact quantity"
                className={`min-w-[28px] px-1.5 h-7 flex items-center justify-center text-xs font-bold font-mono-num tabular-nums cursor-pointer ${
                  exceedsStock ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-text-primary)]'
                }`}
              >
                {item.quantity || '1'}
              </button>
              <button
                type="button"
                onClick={() => onStepQuantity(item.key, 1)}
                disabled={atMaxStock}
                aria-label={`Increase quantity of ${item.name}`}
                className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--cm-text-primary)] hover:bg-[var(--cm-bg-surface)] active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors touch-manipulation"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            {allowedUnits.length > 1 && onChangeUnit ? (
              <select
                aria-label={`Quick unit for ${item.name}`}
                value={selectedUnitLabel}
                onChange={(e) => onChangeUnit(item.key, e.target.value)}
                className="cm-input px-1.5 py-1 text-[11px] font-sans border rounded-md cursor-pointer max-w-[84px]"
              >
                {allowedUnits.map((u) => (
                  <option key={u.unitName} value={u.unitName}>
                    {u.unitName}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[11px] text-[var(--cm-text-muted)] truncate max-w-[64px]">
                {selectedUnitLabel}
              </span>
            )}
          </div>

          {/* Desktop Selling Price */}
          <button
            type="button"
            onClick={() => onToggleExpand(item.key)}
            className="col-span-2 text-right font-mono-num tabular-nums text-xs text-[var(--cm-text-secondary)] cursor-pointer py-1"
          >
            {formatPKR(priceNum)}
          </button>

          {/* Desktop Line Total + Remove */}
          <div className="col-span-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => onToggleExpand(item.key)}
              className="text-right font-mono-num tabular-nums text-sm font-semibold text-[var(--cm-text-primary)] whitespace-nowrap cursor-pointer py-1"
            >
              {formatPKR(lineTotal)}
            </button>
            <button
              type="button"
              onClick={() => onRemove(item.key)}
              aria-label={`Remove ${item.name}`}
              title="Remove item"
              className="min-w-[32px] min-h-[32px] flex items-center justify-center text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] hover:bg-[var(--cm-danger-soft)] rounded-lg transition-colors shrink-0 cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ) : (
        /* Mobile Compact Collapsed Cart Card (Inline - / + Stepper) */
        <div className="px-2.5 py-2 space-y-1.5">
          <div className="flex items-center justify-between gap-1.5">
            <button
              type="button"
              onClick={() => onToggleExpand(item.key)}
              aria-expanded={isExpanded}
              className="flex-1 min-w-0 flex items-center gap-1.5 text-left cursor-pointer py-0.5"
            >
              <span className="text-[var(--cm-text-muted)] shrink-0">
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-[var(--cm-accent-text)]" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </span>
              <span className="text-[11px] font-mono-num text-[var(--cm-text-muted)] shrink-0">
                {rowNumber}.
              </span>
              <span className="text-xs font-semibold text-[var(--cm-text-primary)] truncate">
                {item.name}
              </span>
              {exceedsStock && (
                <span className="text-[10px] font-semibold text-[var(--cm-danger)] whitespace-nowrap shrink-0">
                  · Low ({formatNumber(item.currentStock)})
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => onRemove(item.key)}
              aria-label={`Remove ${item.name}`}
              title="Remove item"
              className="w-8 h-8 flex items-center justify-center text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] hover:bg-[var(--cm-danger-soft)] rounded-lg transition-colors shrink-0 cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 pl-5">
            <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => onToggleExpand(item.key)}
                className="text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums text-left cursor-pointer"
              >
                {formatPKR(priceNum)}/{selectedUnitLabel}
                {conv > 1 ? ` (=${formatNumber(baseUsed)} ${item.unit})` : ''}
              </button>
              {allowedUnits.length > 1 && onChangeUnit && (
                <select
                  aria-label={`Mobile quick unit for ${item.name}`}
                  value={selectedUnitLabel}
                  onChange={(e) => onChangeUnit(item.key, e.target.value)}
                  className="cm-input min-h-[30px] px-1.5 py-0.5 text-[11px] font-medium border rounded-md max-w-[78px]"
                >
                  {allowedUnits.map((u) => (
                    <option key={u.unitName} value={u.unitName}>
                      {u.unitName}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <div className="inline-flex items-center rounded-lg border border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] p-0.5">
                <button
                  type="button"
                  onClick={() => onStepQuantity(item.key, -1)}
                  disabled={atMinQty}
                  aria-label={`Decrease quantity of ${item.name}`}
                  className="w-9 h-9 flex items-center justify-center rounded-md text-[var(--cm-text-primary)] hover:bg-[var(--cm-bg-surface)] active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors touch-manipulation"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onOpenKeypad(item.key)}
                  aria-label={`Edit quantity of ${item.name}`}
                  className={`min-w-[30px] px-1.5 h-9 flex items-center justify-center text-xs font-bold font-mono-num tabular-nums cursor-pointer ${
                    exceedsStock ? 'text-[var(--cm-danger)]' : 'text-[var(--cm-text-primary)]'
                  }`}
                >
                  {item.quantity || '1'}
                </button>
                <button
                  type="button"
                  onClick={() => onStepQuantity(item.key, 1)}
                  disabled={atMaxStock}
                  aria-label={`Increase quantity of ${item.name}`}
                  className="w-9 h-9 flex items-center justify-center rounded-md text-[var(--cm-text-primary)] hover:bg-[var(--cm-bg-surface)] active:scale-95 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors touch-manipulation"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              <button
                type="button"
                onClick={() => onToggleExpand(item.key)}
                className="min-w-[64px] text-right font-mono-num tabular-nums text-xs font-bold text-[var(--cm-text-primary)] whitespace-nowrap cursor-pointer"
              >
                {formatPKR(lineTotal)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Expanded Inline Editor Drawer */}
      {isExpanded && (
        <div className="px-3 py-3 sm:px-4 bg-[var(--cm-bg-subtle)] border-t border-[var(--cm-border)] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums">
            <div className="flex flex-wrap items-center gap-x-2">
              {item.brandName && (
                <>
                  <span className="font-sans font-medium text-[var(--cm-text-secondary)]">
                    {item.brandName}
                  </span>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <span className={exceedsStock ? 'text-[var(--cm-danger)] font-semibold' : 'text-[var(--cm-text-secondary)]'}>
                Available: {formatNumber(item.currentStock)} {pluralizeUnit(item.unit, item.currentStock)}
              </span>
              {conv > 1 && (
                <span className="text-[var(--cm-accent-text)]">
                  · Line deducts {formatNumber(baseUsed)} {pluralizeUnit(item.unit, baseUsed)}
                </span>
              )}
              {exceedsStock && (
                <span className="font-sans text-[var(--cm-danger)] font-semibold">
                  (Exceeds available stock; total {formatNumber(cumulativeProductBase)} {item.unit})
                </span>
              )}
            </div>
            {showProfit && (
              <span
                className={`font-semibold ${
                  lineProfit >= 0 ? 'text-[var(--cm-success)]' : 'text-[var(--cm-danger)]'
                }`}
              >
                Est. Profit: {formatPKR(lineProfit)}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
            {/* Selling Unit Selector (only when >1 unit configured) */}
            {allowedUnits.length > 1 && onChangeUnit && (
              <div className="sm:col-span-3">
                <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                  Selling Unit
                </label>
                <select
                  aria-label={`Selling unit for ${item.name}`}
                  value={selectedUnitLabel}
                  onChange={(e) => onChangeUnit(item.key, e.target.value)}
                  className="w-full min-h-[44px] px-2.5 text-sm border cm-input rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
                >
                  {allowedUnits.map((u) => (
                    <option key={u.unitName} value={u.unitName}>
                      {u.unitName}
                      {u.conversionQty > 1
                        ? ` (${formatNumber(u.conversionQty)} ${pluralizeUnit(item.unit, u.conversionQty)})`
                        : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Quantity Controls */}
            <div
              className={
                allowedUnits.length > 1
                  ? priceEditable
                    ? 'sm:col-span-4'
                    : 'sm:col-span-5'
                  : priceEditable
                    ? 'sm:col-span-5'
                    : 'sm:col-span-6'
              }
            >
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Quantity ({selectedUnitLabel})
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onStepQuantity(item.key, -1)}
                  disabled={atMinQty}
                  aria-label="Decrease quantity"
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] disabled:opacity-35 disabled:cursor-not-allowed rounded-lg text-[var(--cm-text-primary)] cursor-pointer touch-manipulation"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <input
                  type="number"
                  min={decimalAllowed ? '0.01' : 1}
                  step={decimalAllowed ? '0.01' : 1}
                  aria-label={`Quantity for ${item.name}`}
                  value={item.quantity}
                  onChange={(e) => onChangeQuantity(item.key, e.target.value)}
                  className={`flex-1 min-w-0 min-h-[44px] px-2.5 text-center text-sm font-semibold font-mono-num tabular-nums cm-input border rounded-lg focus:outline-none focus:border-[var(--cm-accent)] ${
                    exceedsStock
                      ? 'border-[var(--cm-danger)] text-[var(--cm-danger)]'
                      : ''
                  }`}
                />
                <button
                  type="button"
                  onClick={() => onStepQuantity(item.key, 1)}
                  disabled={atMaxStock}
                  aria-label="Increase quantity"
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] disabled:opacity-35 disabled:cursor-not-allowed rounded-lg text-[var(--cm-text-primary)] cursor-pointer touch-manipulation"
                >
                  <Plus className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => onOpenKeypad(item.key)}
                  aria-label={`Open numeric keypad for ${item.name}`}
                  title="Numeric keypad"
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:border-[var(--cm-accent)] hover:bg-[var(--cm-accent-soft)] rounded-lg text-[var(--cm-text-secondary)] cursor-pointer"
                >
                  <Grid3X3 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Selling Price */}
            <div className={allowedUnits.length > 1 ? 'sm:col-span-3' : priceEditable ? 'sm:col-span-4' : 'sm:col-span-3'}>
              <div className="flex items-center justify-between gap-1 mb-1">
                <label className="text-[11px] font-medium text-[var(--cm-text-secondary)]">
                  Price/{selectedUnitLabel}
                </label>
                {priceEditable && onChangePrice && activeWholesale > 0 && (
                  <button
                    type="button"
                    onClick={() => onChangePrice(item.key, String(activeWholesale))}
                    className="text-[10px] font-semibold text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                  >
                    Use Wholesale ({formatPKR(activeWholesale)})
                  </button>
                )}
              </div>
              {priceEditable && onChangePrice ? (
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  aria-label={`Selling price for ${item.name}`}
                  value={item.salePricePerUnit}
                  onChange={(e) => onChangePrice(item.key, e.target.value)}
                  className="w-full min-h-[44px] px-3 py-2 text-sm border rounded-lg cm-input font-mono-num tabular-nums focus:outline-none focus:border-[var(--cm-accent)]"
                />
              ) : (
                <div className="w-full min-h-[44px] px-3 py-2 text-sm border border-[var(--cm-border)] rounded-lg bg-[var(--cm-bg-surface)] text-[var(--cm-text-secondary)] font-mono-num tabular-nums flex items-center">
                  {formatPKR(priceNum)}
                </div>
              )}
            </div>

            {/* Collapse Button */}
            <div className="sm:col-span-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => onToggleExpand(item.key)}
                className="w-full sm:w-auto min-h-[44px] px-4 py-2 text-xs font-semibold text-[var(--cm-accent-text)] bg-[var(--cm-bg-surface)] border border-[var(--cm-accent-border)] hover:bg-[var(--cm-accent-soft)] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}, areCompactSaleRowPropsEqual);

export function CompactSaleItemsList({
  items,
  expandedKey,
  onToggleExpand,
  onStepQuantity,
  onChangeQuantity,
  onChangeUnit,
  onOpenKeypad,
  onChangePrice,
  onRemove,
  priceEditable = false,
  allowStockOverride = false,
  showProfit = false,
  lastHighlightedKey = null,
  emptyMessage = 'No products added yet. Search above to quickly add items.',
}: CompactSaleItemsListProps) {
  const isDesktop = useIsDesktopViewport();

  // Sum base stock usage per product across all unit lines
  const totalBaseByProduct = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of items) {
      const qtyNum = Math.max(0, roundStockQty(Number(row.quantity) || 0));
      const conv = roundStockQty(row.conversionFactor ?? 1) || 1;
      map.set(row.productId, roundStockQty((map.get(row.productId) || 0) + qtyNum * conv));
    }
    return map;
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="border border-dashed border-[var(--cm-border-strong)] rounded-xl bg-[var(--cm-bg-subtle)] px-4 py-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="border border-[var(--cm-border)] rounded-xl bg-[var(--cm-bg-surface)] overflow-x-clip touch-pan-y">
      {isDesktop ? (
        <div className="grid grid-cols-12 items-center gap-2 px-3.5 py-2 bg-[var(--cm-bg-subtle)] border-b border-[var(--cm-border)] text-[11px] font-semibold text-[var(--cm-text-muted)]">
          <div className="col-span-5">Product ({formatNumber(items.length)})</div>
          <div className="col-span-3 text-center">Qty / Unit</div>
          <div className="col-span-2 text-right">Price</div>
          <div className="col-span-2 text-right pr-9">Line Total</div>
        </div>
      ) : (
        <div className="flex items-center justify-between px-3 py-2 bg-[var(--cm-bg-subtle)] border-b border-[var(--cm-border)] text-xs font-semibold text-[var(--cm-text-secondary)]">
          <span>Added Products ({formatNumber(items.length)})</span>
          <span className="text-[11px] font-normal text-[var(--cm-text-muted)]">Tap item for details</span>
        </div>
      )}

      <div className="divide-y divide-[var(--cm-border)]">
        {items.map((item, idx) => {
          const qtyNum = Math.max(0, roundStockQty(Number(item.quantity) || 0));
          const conv = roundStockQty(item.conversionFactor ?? 1) || 1;
          const baseUsed = roundStockQty(qtyNum * conv);
          const cumulativeProductBase = totalBaseByProduct.get(item.productId) || baseUsed;
          const exceedsStock = !allowStockOverride && cumulativeProductBase > item.currentStock;
          const atMaxStock =
            !allowStockOverride && roundStockQty(cumulativeProductBase + conv) > item.currentStock;

          return (
            <CompactSaleRow
              key={item.key}
              item={item}
              rowNumber={idx + 1}
              isDesktop={isDesktop}
              isExpanded={expandedKey === item.key}
              isHighlighted={lastHighlightedKey === item.key}
              cumulativeProductBase={cumulativeProductBase}
              exceedsStock={exceedsStock}
              atMaxStock={atMaxStock}
              priceEditable={priceEditable}
              showProfit={showProfit}
              onToggleExpand={onToggleExpand}
              onStepQuantity={onStepQuantity}
              onChangeQuantity={onChangeQuantity}
              onChangeUnit={onChangeUnit}
              onOpenKeypad={onOpenKeypad}
              onChangePrice={onChangePrice}
              onRemove={onRemove}
            />
          );
        })}
      </div>
    </div>
  );
}
