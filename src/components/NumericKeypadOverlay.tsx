import { Check, Delete, Minus, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatNumber, formatPKR, roundMoney } from '../utils/formatters';

interface NumericKeypadOverlayProps {
  open: boolean;
  productName: string;
  unit: string;
  availableStock?: number;
  unitPrice: number;
  initialQuantity: number;
  allowStockOverride?: boolean;
  onConfirm: (nextQuantity: number) => void;
  onClose: () => void;
}

const QUICK_PRESETS = [1, 2, 5, 10, 12, 24];

export function NumericKeypadOverlay({
  open,
  productName,
  unit,
  availableStock,
  unitPrice,
  initialQuantity,
  allowStockOverride = false,
  onConfirm,
  onClose,
}: NumericKeypadOverlayProps) {
  const [rawInput, setRawInput] = useState('1');
  const [replaceOnNextDigit, setReplaceOnNextDigit] = useState(true);

  useEffect(() => {
    if (open) {
      const safeInit = Number.isFinite(initialQuantity) && initialQuantity > 0 ? Math.floor(initialQuantity) : 1;
      setRawInput(String(safeInit));
      setReplaceOnNextDigit(true);
    }
  }, [open, initialQuantity]);

  const numericValue = Math.max(0, Math.floor(Number(rawInput) || 0));
  const hasStockCap = typeof availableStock === 'number' && !allowStockOverride;
  const exceedsStock = typeof availableStock === 'number' && numericValue > availableStock;
  const blockedByStock = hasStockCap && exceedsStock;
  const isInvalid = numericValue <= 0 || blockedByStock;

  const appendDigit = (digit: string) => {
    setRawInput((prev) => {
      if (replaceOnNextDigit) {
        setReplaceOnNextDigit(false);
        return digit === '0' ? '0' : digit;
      }
      if (prev === '0') return digit;
      if (prev.length >= 6) return prev;
      return `${prev}${digit}`;
    });
  };

  const handleBackspace = () => {
    setReplaceOnNextDigit(false);
    setRawInput((prev) => (prev.length <= 1 ? '0' : prev.slice(0, -1)));
  };

  const handleClear = () => {
    setReplaceOnNextDigit(false);
    setRawInput('0');
  };

  const handleStep = (delta: number) => {
    setReplaceOnNextDigit(false);
    const next = Math.max(1, numericValue + delta);
    setRawInput(String(next));
  };

  const handlePreset = (val: number) => {
    setReplaceOnNextDigit(false);
    setRawInput(String(val));
  };

  const handleSubmit = () => {
    if (isInvalid) return;
    onConfirm(numericValue);
  };

  // Support physical keyboard entry while overlay is open
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!isInvalid) onConfirm(numericValue);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleBackspace();
      } else if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        appendDigit(e.key);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, isInvalid, numericValue, onClose, onConfirm, replaceOnNextDigit]);

  if (!open) return null;

  const lineTotalPreview = roundMoney(numericValue * unitPrice);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Enter quantity for ${productName}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white border border-slate-200 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-xl overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3.5 border-b border-slate-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900 truncate">
              {productName || 'Enter Quantity'}
            </h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 font-mono-num tabular-nums">
              {typeof availableStock === 'number' && (
                <span>
                  Stock: {formatNumber(availableStock)} {unit}
                </span>
              )}
              <span aria-hidden="true">·</span>
              <span>Rate: {formatPKR(unitPrice)}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close numeric keypad"
            className="min-w-[40px] min-h-[40px] -mr-1 -mt-1 flex items-center justify-center text-slate-400 hover:text-slate-800 rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Display + Stepper */}
        <div className="p-4 space-y-3 bg-slate-50 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleStep(-1)}
              aria-label="Decrease quantity by 1"
              className="min-w-[48px] h-12 flex items-center justify-center bg-white border border-slate-200 hover:bg-slate-100 active:bg-slate-200 rounded-xl text-slate-700 cursor-pointer"
            >
              <Minus className="w-5 h-5" />
            </button>

            <div className="flex-1 bg-white border border-slate-200 rounded-xl px-4 py-2 text-center">
              <div
                className={`text-3xl font-bold font-mono-num tabular-nums tracking-tight ${
                  blockedByStock
                    ? 'text-red-600'
                    : replaceOnNextDigit
                    ? 'text-teal-700'
                    : 'text-slate-900'
                }`}
              >
                {rawInput}
              </div>
              <div className="text-[11px] text-slate-500 font-mono-num tabular-nums">
                {unit} · Total: {formatPKR(lineTotalPreview)}
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleStep(1)}
              aria-label="Increase quantity by 1"
              className="min-w-[48px] h-12 flex items-center justify-center bg-white border border-slate-200 hover:bg-slate-100 active:bg-slate-200 rounded-xl text-slate-700 cursor-pointer"
            >
              <Plus className="w-5 h-5" />
            </button>
          </div>

          {blockedByStock && typeof availableStock === 'number' && (
            <div className="text-xs font-medium text-red-600 text-center">
              Exceeds available stock ({formatNumber(availableStock)} {unit}).
            </div>
          )}
          {!blockedByStock && exceedsStock && allowStockOverride && (
            <div className="text-xs font-medium text-amber-700 text-center">
              Exceeds current stock (Owner Override enabled).
            </div>
          )}
          {numericValue <= 0 && (
            <div className="text-xs font-medium text-red-600 text-center">
              Quantity must be at least 1.
            </div>
          )}

          {/* Quick Quantity Presets */}
          <div className="grid grid-cols-6 gap-1.5">
            {QUICK_PRESETS.map((preset) => {
              const disabled = hasStockCap && typeof availableStock === 'number' && preset > availableStock;
              return (
                <button
                  key={preset}
                  type="button"
                  disabled={disabled}
                  onClick={() => handlePreset(preset)}
                  className={`min-h-[38px] text-xs font-semibold font-mono-num rounded-lg border transition-colors cursor-pointer ${
                    numericValue === preset
                      ? 'bg-teal-50 border-teal-300 text-teal-800'
                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed'
                  }`}
                >
                  {preset}
                </button>
              );
            })}
          </div>
        </div>

        {/* 3x4 Tactile Numeric Keypad */}
        <div className="p-4 space-y-3 bg-white">
          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <button
                key={digit}
                type="button"
                onClick={() => appendDigit(digit)}
                className="h-14 min-h-[48px] text-xl font-semibold font-mono-num text-slate-900 bg-slate-50 hover:bg-slate-100 active:bg-slate-200 border border-slate-200 rounded-xl transition-colors cursor-pointer"
              >
                {digit}
              </button>
            ))}

            <button
              type="button"
              onClick={handleClear}
              className="h-14 min-h-[48px] text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 border border-slate-200 rounded-xl transition-colors cursor-pointer"
            >
              Clear
            </button>

            <button
              type="button"
              onClick={() => appendDigit('0')}
              className="h-14 min-h-[48px] text-xl font-semibold font-mono-num text-slate-900 bg-slate-50 hover:bg-slate-100 active:bg-slate-200 border border-slate-200 rounded-xl transition-colors cursor-pointer"
            >
              0
            </button>

            <button
              type="button"
              onClick={handleBackspace}
              aria-label="Backspace"
              className="h-14 min-h-[48px] flex items-center justify-center text-slate-700 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 border border-slate-200 rounded-xl transition-colors cursor-pointer"
            >
              <Delete className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-12 px-4 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isInvalid}
              onClick={handleSubmit}
              className="h-12 flex-1 inline-flex items-center justify-center gap-1.5 px-4 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors cursor-pointer"
            >
              <Check className="w-4 h-4" />
              Set Quantity ({formatNumber(numericValue)})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
