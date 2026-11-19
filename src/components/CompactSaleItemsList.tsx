import { ChevronDown, ChevronRight, Grid3X3, Minus, Plus, Trash2 } from 'lucide-react';
import { formatNumber, formatPKR, roundMoney } from '../utils/formatters';

export interface CompactSaleRowItem {
  key: string;
  productId: string;
  name: string;
  brandName?: string;
  unit: string;
  currentStock: number;
  quantity: string;
  salePricePerUnit: string;
  purchasePrice?: number;
}

interface CompactSaleItemsListProps {
  items: CompactSaleRowItem[];
  expandedKey: string | null;
  onToggleExpand: (key: string) => void;
  onStepQuantity: (key: string, delta: number) => void;
  onChangeQuantity: (key: string, value: string) => void;
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
      <div className="border border-dashed border-slate-200 rounded-xl bg-slate-50/60 px-4 py-6 text-center text-xs sm:text-sm text-slate-500">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
      {/* Sticky Compact Column Header (Desktop) */}
      <div className="hidden sm:grid sm:grid-cols-12 items-center gap-2 px-3.5 py-2 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-500">
        <div className="col-span-6">Product ({formatNumber(items.length)})</div>
        <div className="col-span-2 text-right">Qty</div>
        <div className="col-span-2 text-right">Price</div>
        <div className="col-span-2 text-right pr-8">Line Total</div>
      </div>

      {/* Mobile Compact Count Header */}
      <div className="sm:hidden flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
        <span>Added Products ({formatNumber(items.length)})</span>
        <span className="text-[11px] font-normal text-slate-500">Tap row to edit</span>
      </div>

      {/* Bounded Scrollable Compact Rows */}
      <div className="max-h-[46vh] sm:max-h-[380px] overflow-y-auto divide-y divide-slate-100">
        {items.map((item, idx) => {
          const isExpanded = expandedKey === item.key;
          const qtyNum = Math.max(0, Number(item.quantity) || 0);
          const priceNum = Math.max(0, Number(item.salePricePerUnit) || 0);
          const lineTotal = roundMoney(qtyNum * priceNum);
          const lineProfit =
            showProfit && typeof item.purchasePrice === 'number'
              ? roundMoney(lineTotal - qtyNum * item.purchasePrice)
              : 0;
          const exceedsStock = !allowStockOverride && qtyNum > item.currentStock;
          const isHighlighted = lastHighlightedKey === item.key;
          const rowNumber = idx + 1;

          return (
            <div
              key={item.key}
              className={`transition-colors ${
                exceedsStock
                  ? 'bg-red-50/40'
                  : isHighlighted
                    ? 'bg-teal-50/60'
                    : isExpanded
                      ? 'bg-slate-50/50'
                      : 'bg-white'
              }`}
            >
              {/* Collapsed / Summary Header Row */}
              <div className="flex items-center justify-between gap-2 px-2.5 sm:px-3.5 py-2 min-h-[48px] hover:bg-slate-50/80">
                <button
                  type="button"
                  onClick={() => onToggleExpand(item.key)}
                  aria-expanded={isExpanded}
                  className="flex-1 min-w-0 flex items-center justify-between gap-2 text-left cursor-pointer py-0.5"
                >
                  {/* Left: Chevron + Index + Product Name (and Mobile metadata) */}
                  <div className="flex items-center gap-2 min-w-0 flex-1 sm:grid sm:grid-cols-12 sm:items-center sm:gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1 sm:col-span-6">
                      <span className="text-slate-400 shrink-0">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-teal-600" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </span>
                      <span className="text-[11px] font-mono-num text-slate-400 shrink-0 w-5 text-right">
                        {rowNumber}.
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs sm:text-sm font-medium text-slate-900 truncate">
                            {item.name}
                          </span>
                          {exceedsStock && (
                            <span className="text-[11px] font-semibold text-red-600 whitespace-nowrap shrink-0">
                              · Low stock ({formatNumber(item.currentStock)})
                            </span>
                          )}
                        </div>
                        {/* Mobile compact sub-line */}
                        <div className="sm:hidden flex items-center gap-1.5 text-[11px] text-slate-500 font-mono-num tabular-nums">
                          <span>Qty: {item.quantity || '1'}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatPKR(priceNum)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Desktop Qty */}
                    <div
                      className={`hidden sm:block sm:col-span-2 text-right font-mono-num tabular-nums text-xs ${
                        exceedsStock ? 'text-red-600 font-semibold' : 'text-slate-700'
                      }`}
                    >
                      ×{item.quantity || '1'}
                    </div>

                    {/* Desktop Selling Price */}
                    <div className="hidden sm:block sm:col-span-2 text-right font-mono-num tabular-nums text-xs text-slate-600">
                      {formatPKR(priceNum)}
                    </div>

                    {/* Desktop & Mobile Line Total */}
                    <div className="sm:col-span-2 text-right font-mono-num tabular-nums text-xs sm:text-sm font-semibold text-slate-900 whitespace-nowrap shrink-0">
                      {formatPKR(lineTotal)}
                    </div>
                  </div>
                </button>

                {/* Quick Remove Button */}
                <button
                  type="button"
                  onClick={() => onRemove(item.key)}
                  aria-label={`Remove ${item.name}`}
                  title="Remove item"
                  className="min-w-[38px] min-h-[38px] sm:min-w-[32px] sm:min-h-[32px] flex items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors shrink-0 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Expanded Inline Editor Drawer */}
              {isExpanded && (
                <div className="px-3 py-3 sm:px-4 bg-slate-50 border-t border-slate-100 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 font-mono-num tabular-nums">
                    <div className="flex flex-wrap items-center gap-x-2">
                      {item.brandName && (
                        <>
                          <span className="font-sans font-medium text-slate-700">
                            {item.brandName}
                          </span>
                          <span aria-hidden="true">·</span>
                        </>
                      )}
                      <span className={exceedsStock ? 'text-red-600 font-semibold' : 'text-slate-600'}>
                        Available: {formatNumber(item.currentStock)} {item.unit}
                      </span>
                      {exceedsStock && (
                        <span className="font-sans text-red-600 font-semibold">
                          (Exceeds available stock)
                        </span>
                      )}
                    </div>
                    {showProfit && (
                      <span
                        className={`font-semibold ${
                          lineProfit >= 0 ? 'text-emerald-700' : 'text-red-600'
                        }`}
                      >
                        Profit: {formatPKR(lineProfit)}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                    {/* Quantity Controls */}
                    <div className={priceEditable ? 'sm:col-span-5' : 'sm:col-span-6'}>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        Quantity ({item.unit})
                      </label>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onStepQuantity(item.key, -1)}
                          aria-label="Decrease quantity"
                          className="min-w-[44px] min-h-[44px] flex items-center justify-center bg-white border border-slate-200 hover:bg-slate-100 active:bg-slate-200 rounded-lg text-slate-700 cursor-pointer"
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          aria-label={`Quantity for ${item.name}`}
                          value={item.quantity}
                          onChange={(e) => onChangeQuantity(item.key, e.target.value)}
                          className={`flex-1 min-w-0 min-h-[44px] px-2.5 text-center text-sm font-semibold font-mono-num tabular-nums bg-white border rounded-lg focus:outline-none focus:border-teal-600 ${
                            exceedsStock
                              ? 'border-red-300 text-red-700'
                              : 'border-slate-200 text-slate-900'
                          }`}
                        />
                        <button
                          type="button"
                          onClick={() => onStepQuantity(item.key, 1)}
                          aria-label="Increase quantity"
                          className="min-w-[44px] min-h-[44px] flex items-center justify-center bg-white border border-slate-200 hover:bg-slate-100 active:bg-slate-200 rounded-lg text-slate-700 cursor-pointer"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenKeypad(item.key)}
                          aria-label={`Open numeric keypad for ${item.name}`}
                          title="Numeric keypad"
                          className="min-w-[44px] min-h-[44px] flex items-center justify-center bg-white border border-slate-200 hover:border-teal-500 hover:bg-teal-50 rounded-lg text-slate-600 cursor-pointer"
                        >
                          <Grid3X3 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Selling Price */}
                    <div className={priceEditable ? 'sm:col-span-4' : 'sm:col-span-3'}>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        Selling Price (PKR)
                      </label>
                      {priceEditable && onChangePrice ? (
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          aria-label={`Selling price for ${item.name}`}
                          value={item.salePricePerUnit}
                          onChange={(e) => onChangePrice(item.key, e.target.value)}
                          className="w-full min-h-[44px] px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white font-mono-num tabular-nums focus:outline-none focus:border-teal-600"
                        />
                      ) : (
                        <div className="w-full min-h-[44px] px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-100 text-slate-700 font-mono-num tabular-nums flex items-center">
                          {formatPKR(priceNum)}
                        </div>
                      )}
                    </div>

                    {/* Collapse Button */}
                    <div className="sm:col-span-3 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onToggleExpand(item.key)}
                        className="w-full sm:w-auto min-h-[44px] px-4 py-2 text-xs font-semibold text-teal-700 bg-white border border-teal-200 hover:bg-teal-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
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
