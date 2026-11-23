import { ChevronDown, ChevronRight, Grid3X3, Minus, Plus, Trash2 } from 'lucide-react';
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
  if (items.length === 0) {
    return (
      <div className="border border-dashed border-[var(--cm-border-strong)] rounded-xl bg-[var(--cm-bg-subtle)] px-4 py-6 text-center text-xs sm:text-sm text-[var(--cm-text-muted)]">
        {emptyMessage}
      </div>
    );
  }

  // Sum base stock usage per product across all unit lines
  const totalBaseByProduct = new Map<string, number>();
  for (const row of items) {
    const qtyNum = Math.max(0, roundStockQty(Number(row.quantity) || 0));
    const conv = roundStockQty(row.conversionFactor ?? 1) || 1;
    totalBaseByProduct.set(
      row.productId,
      roundStockQty((totalBaseByProduct.get(row.productId) || 0) + qtyNum * conv)
    );
  }

  return (
    <div className="border border-[var(--cm-border)] rounded-xl bg-[var(--cm-bg-surface)] overflow-hidden">
      {/* Sticky Compact Column Header (Desktop) */}
      <div className="hidden sm:grid sm:grid-cols-12 items-center gap-2 px-3.5 py-2 bg-[var(--cm-bg-subtle)] border-b border-[var(--cm-border)] text-[11px] font-semibold text-[var(--cm-text-muted)]">
        <div className="col-span-6">Product ({formatNumber(items.length)})</div>
        <div className="col-span-2 text-right">Qty / Unit</div>
        <div className="col-span-2 text-right">Price</div>
        <div className="col-span-2 text-right pr-8">Line Total</div>
      </div>

      {/* Mobile Compact Count Header */}
      <div className="sm:hidden flex items-center justify-between px-3 py-2 bg-[var(--cm-bg-subtle)] border-b border-[var(--cm-border)] text-xs font-semibold text-[var(--cm-text-secondary)]">
        <span>Added Products ({formatNumber(items.length)})</span>
        <span className="text-[11px] font-normal text-[var(--cm-text-muted)]">Tap row to edit</span>
      </div>

      {/* Expandable Compact Rows (flows naturally with main page scroll) */}
      <div className="divide-y divide-[var(--cm-border)]">
        {items.map((item, idx) => {
          const isExpanded = expandedKey === item.key;
          const qtyNum = Math.max(0, roundStockQty(Number(item.quantity) || 0));
          const priceNum = Math.max(0, Number(item.salePricePerUnit) || 0);
          const conv = roundStockQty(item.conversionFactor ?? 1) || 1;
          const selectedUnitLabel = item.unitName || item.unit;
          const baseUsed = roundStockQty(qtyNum * conv);
          const cumulativeProductBase = totalBaseByProduct.get(item.productId) || baseUsed;
          const lineTotal = roundMoney(qtyNum * priceNum);
          const lineProfit =
            showProfit && typeof item.purchasePrice === 'number'
              ? roundMoney(lineTotal - baseUsed * item.purchasePrice)
              : 0;
          const exceedsStock = !allowStockOverride && cumulativeProductBase > item.currentStock;
          const isHighlighted = lastHighlightedKey === item.key;
          const rowNumber = idx + 1;
          const allowedUnits = Array.isArray(item.allowedUnits) ? item.allowedUnits : [];
          const selectedUnitMeta = allowedUnits.find(
            (u) => u.unitName.toLowerCase() === selectedUnitLabel.toLowerCase()
          );
          const activeWholesale = selectedUnitMeta?.wholesalePrice ?? item.wholesalePrice ?? 0;
          const decimalAllowed = isFractionalUnit(selectedUnitLabel);

          return (
            <div
              key={item.key}
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
              {/* Collapsed / Summary Header Row */}
              <div className="flex items-center justify-between gap-2 px-2.5 sm:px-3.5 py-2 min-h-[48px] hover:bg-[var(--cm-bg-hover)]">
                <button
                  type="button"
                  onClick={() => onToggleExpand(item.key)}
                  aria-expanded={isExpanded}
                  className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left cursor-pointer py-0.5"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1 sm:grid sm:grid-cols-12 sm:items-center sm:gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1 sm:col-span-6">
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
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs sm:text-sm font-medium text-[var(--cm-text-primary)] truncate">
                            {item.name}
                          </span>
                          {exceedsStock && (
                            <span className="text-[11px] font-semibold text-[var(--cm-danger)] whitespace-nowrap shrink-0">
                              · Low ({formatNumber(item.currentStock)} {item.unit})
                            </span>
                          )}
                        </div>
                        {/* Mobile compact sub-line */}
                        <div className="sm:hidden flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums">
                          <span>
                            {item.quantity || '1'} {selectedUnitLabel}
                            {conv > 1 ? ` (=${formatNumber(baseUsed)} ${item.unit})` : ''}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{formatPKR(priceNum)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Desktop Qty + Unit */}
                    <div
                      className={`hidden sm:flex sm:col-span-2 items-center justify-end gap-1.5 font-mono-num tabular-nums text-xs ${
                        exceedsStock ? 'text-[var(--cm-danger)] font-semibold' : 'text-[var(--cm-text-secondary)]'
                      }`}
                    >
                      <span>×{item.quantity || '1'}</span>
                      {allowedUnits.length > 1 && onChangeUnit ? (
                        <select
                          aria-label={`Quick unit for ${item.name}`}
                          value={selectedUnitLabel}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            e.stopPropagation();
                            onChangeUnit(item.key, e.target.value);
                          }}
                          className="cm-input px-1.5 py-0.5 text-[11px] font-sans border rounded-md cursor-pointer max-w-[92px]"
                        >
                          {allowedUnits.map((u) => (
                            <option key={u.unitName} value={u.unitName}>
                              {u.unitName}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span>{selectedUnitLabel}</span>
                      )}
                    </div>

                    {/* Desktop Selling Price */}
                    <div className="hidden sm:block sm:col-span-2 text-right font-mono-num tabular-nums text-xs text-[var(--cm-text-secondary)]">
                      {formatPKR(priceNum)}
                    </div>

                    {/* Desktop & Mobile Line Total */}
                    <div className="sm:col-span-2 text-right font-mono-num tabular-nums text-xs sm:text-sm font-semibold text-[var(--cm-text-primary)] whitespace-nowrap shrink-0">
                      {formatPKR(lineTotal)}
                    </div>
                  </div>
                </button>

                {/* Mobile 1-tap unit switcher (when multiple units enabled) */}
                {allowedUnits.length > 1 && onChangeUnit && (
                  <select
                    aria-label={`Mobile quick unit for ${item.name}`}
                    value={selectedUnitLabel}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onChangeUnit(item.key, e.target.value)}
                    className="sm:hidden cm-input min-h-[34px] px-1.5 py-1 text-[11px] font-medium border rounded-lg max-w-[82px] shrink-0"
                  >
                    {allowedUnits.map((u) => (
                      <option key={u.unitName} value={u.unitName}>
                        {u.unitName}
                      </option>
                    ))}
                  </select>
                )}

                {/* Quick Remove Button */}
                <button
                  type="button"
                  onClick={() => onRemove(item.key)}
                  aria-label={`Remove ${item.name}`}
                  title="Remove item"
                  className="min-w-[38px] min-h-[38px] sm:min-w-[32px] sm:min-h-[32px] flex items-center justify-center text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] hover:bg-[var(--cm-danger-soft)] rounded-lg transition-colors shrink-0 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

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
                          (Exceeds available stock)
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
                          aria-label="Decrease quantity"
                          className="min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] rounded-lg text-[var(--cm-text-primary)] cursor-pointer"
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
                          aria-label="Increase quantity"
                          className="min-w-[44px] min-h-[44px] flex items-center justify-center bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] rounded-lg text-[var(--cm-text-primary)] cursor-pointer"
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
        })}
      </div>
    </div>
  );
}
