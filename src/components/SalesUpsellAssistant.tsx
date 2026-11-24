import { Plus, Sparkles, X } from 'lucide-react';
import { useRef } from 'react';
import type { SearchableProductItem } from '../services/productSearchService';
import { formatPKR } from '../utils/formatters';
import { getDefaultSaleUnit } from '../utils/packaging';
import type { UpsellSuggestion } from '../utils/salesAssistant';

interface SalesUpsellAssistantProps {
  suggestion: UpsellSuggestion | null;
  onAddProduct: (item: SearchableProductItem) => void;
  onDismiss: (suggestedProductId: string) => void;
  onAccepted?: (suggestedProductId: string) => void;
}

export function SalesUpsellAssistant({
  suggestion,
  onAddProduct,
  onDismiss,
  onAccepted,
}: SalesUpsellAssistantProps) {
  const lastAddClickRef = useRef<{ productId: string; timestamp: number } | null>(null);

  if (!suggestion) return null;

  const { product, romanUrduPrompt, stockSummary } = suggestion;
  const defUnit = getDefaultSaleUnit(product);

  const handleAddClick = () => {
    const now = Date.now();
    const last = lastAddClickRef.current;
    if (last && last.productId === product.id && now - last.timestamp < 650) {
      return;
    }
    lastAddClickRef.current = { productId: product.id, timestamp: now };
    onAccepted?.(product.id);
    onAddProduct(product);
  };

  return (
    <div
      role="region"
      aria-label="Smart sales upsell suggestion"
      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2 rounded-xl border border-[var(--cm-warning-border)] bg-[var(--cm-warning-soft)] text-xs transition-all"
    >
      <div className="min-w-0 flex items-start sm:items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-[var(--cm-warning)] shrink-0 mt-0.5 sm:mt-0" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span className="font-semibold text-[var(--cm-warning)]">Suggestion:</span>
            <span className="font-medium text-[var(--cm-text-primary)]">{romanUrduPrompt}</span>
          </div>
          <div className="text-[11px] text-[var(--cm-text-muted)] font-mono-num truncate">
            {product.name} · {formatPKR(defUnit.salePrice)}/{defUnit.unitName} · Stock: {stockSummary}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-1.5 shrink-0">
        <button
          type="button"
          onClick={handleAddClick}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[32px] text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] active:scale-95 rounded-lg transition-colors cursor-pointer whitespace-nowrap touch-manipulation"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add</span>
        </button>
        <button
          type="button"
          onClick={() => onDismiss(product.id)}
          aria-label="Dismiss suggestion"
          title="Dismiss"
          className="inline-flex items-center justify-center w-8 h-8 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] hover:bg-[var(--cm-bg-surface)] rounded-lg transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
