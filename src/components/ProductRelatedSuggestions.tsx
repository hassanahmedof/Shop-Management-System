import { useEffect, useState } from 'react';
import type { SearchableProductItem } from '../services/productSearchService';
import { formatPKR } from '../utils/formatters';
import {
  getProductRelatedSuggestions,
  type ProductRelatedSuggestion,
} from '../utils/salesAssistant';

interface ProductRelatedSuggestionsProps {
  shopId: string;
  productId: string;
  catalog: SearchableProductItem[];
  limit?: number;
  onSelectProduct?: (productId: string) => void;
}

export function ProductRelatedSuggestions({
  shopId,
  productId,
  catalog,
  limit = 4,
  onSelectProduct,
}: ProductRelatedSuggestionsProps) {
  const [suggestions, setSuggestions] = useState<ProductRelatedSuggestion[]>([]);

  useEffect(() => {
    setSuggestions([]);
    if (!shopId || !productId || !Array.isArray(catalog) || catalog.length === 0) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const results = getProductRelatedSuggestions({
        shopId,
        productId,
        catalog,
        limit,
      });
      if (!cancelled) {
        setSuggestions(results);
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [shopId, productId, catalog, limit]);

  if (suggestions.length === 0) {
    return null;
  }

  const hasHistorical = suggestions.some((item) => item.evidenceType === 'history');
  const hasCatalog = suggestions.some((item) => item.evidenceType === 'catalog');

  const heading = hasHistorical ? 'Often bought with' : 'Suggested with this product';
  const subtitle =
    hasHistorical && hasCatalog
      ? 'Completed sales & catalog matches'
      : hasHistorical
        ? 'Based on completed sales'
        : 'Based on catalog & category attributes';

  return (
    <div
      role="region"
      aria-label={heading}
      className="pt-2 border-t border-[var(--cm-border)] space-y-1.5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h4 className="text-xs font-semibold text-[var(--cm-text-primary)]">{heading}</h4>
        <span className="text-[11px] text-[var(--cm-text-muted)]">{subtitle}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {suggestions.map((item) => {
          const metaParts = [
            item.product.categoryName,
            `Stock: ${item.stockSummary}`,
            item.reasonLabel,
          ].filter(Boolean);

          const priceText = `${formatPKR(item.unitPrice)}/${item.unitName}`;

          if (onSelectProduct) {
            return (
              <button
                key={item.product.id}
                type="button"
                onClick={() => onSelectProduct(item.product.id)}
                className="w-full text-left px-2.5 py-2 rounded-lg cm-surface border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] transition-colors flex items-center justify-between gap-2 cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-[var(--cm-text-primary)] truncate">
                    {item.product.name}
                    {item.product.bottleSize ? ` (${item.product.bottleSize})` : ''}
                  </div>
                  <div className="text-[11px] text-[var(--cm-text-muted)] truncate">
                    {metaParts.join(' · ')}
                  </div>
                </div>
                <span className="text-xs font-semibold font-mono-num tabular-nums text-[var(--cm-text-primary)] whitespace-nowrap shrink-0">
                  {priceText}
                </span>
              </button>
            );
          }

          return (
            <div
              key={item.product.id}
              className="px-2.5 py-2 rounded-lg cm-surface border border-[var(--cm-border)] flex items-center justify-between gap-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[var(--cm-text-primary)] truncate">
                  {item.product.name}
                  {item.product.bottleSize ? ` (${item.product.bottleSize})` : ''}
                </div>
                <div className="text-[11px] text-[var(--cm-text-muted)] truncate">
                  {metaParts.join(' · ')}
                </div>
              </div>
              <span className="text-xs font-semibold font-mono-num tabular-nums text-[var(--cm-text-primary)] whitespace-nowrap shrink-0">
                {priceText}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
