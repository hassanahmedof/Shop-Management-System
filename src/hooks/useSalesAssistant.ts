import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import {
  mapProductsToSearchable,
  mapStaffCatalogToSearchable,
  type SearchableProductItem,
} from '../services/productSearchService';
import {
  type CartAssistantItem,
  getUpsellSuggestion,
  type UpsellSuggestion,
} from '../utils/salesAssistant';
import { pickNextSalesDialogue } from '../utils/salesDialogue';

export type SalesAssistantCartEntry =
  | string
  | {
      productId?: string | null;
      quantity?: string | number;
      conversionFactor?: number;
      unitName?: string;
      salePricePerUnit?: string | number;
    };

export interface UseSalesAssistantOptions {
  cart: SalesAssistantCartEntry[];
  catalog?: SearchableProductItem[];
}

export interface UseSalesAssistantResult {
  suggestion: UpsellSuggestion | null;
  dismissSuggestion: (suggestedProductId?: string) => void;
  onProductAdded: () => void;
  onCartCleared: () => void;
  onSaleSaved: () => void;
}

const POST_SALE_DIALOGUE_TOAST_ID = 'post-sale-dialogue';

export function useSalesAssistant({
  cart,
  catalog,
}: UseSalesAssistantOptions): UseSalesAssistantResult {
  const { products, staffCatalog } = useShopData();
  const { showToast, dismissToast } = useToast();

  const [dismissedUpsellIds, setDismissedUpsellIds] = useState<string[]>([]);
  const [removedProductIds, setRemovedProductIds] = useState<string[]>([]);
  const [hiddenAtSignature, setHiddenAtSignature] = useState<string | null>(null);
  const lastDialogueIdxRef = useRef<number | null>(null);
  const prevCartProductIdsRef = useRef<Set<string>>(new Set());
  const currentCartProductIdsRef = useRef<Set<string>>(new Set());
  const sessionResetPendingRef = useRef<boolean>(false);

  const effectiveCatalog = useMemo<SearchableProductItem[]>(() => {
    if (catalog && catalog.length > 0) {
      return catalog;
    }
    if (products.length > 0) {
      return mapProductsToSearchable(products);
    }
    if (staffCatalog.length > 0) {
      return mapStaffCatalogToSearchable(staffCatalog.filter((item) => item.isActive));
    }
    return [];
  }, [catalog, products, staffCatalog]);

  const normalizedCartItems = useMemo<CartAssistantItem[]>(() => {
    return cart
      .map((entry): CartAssistantItem | null => {
        if (typeof entry === 'string') {
          return entry ? { productId: entry, quantity: 1, conversionFactor: 1 } : null;
        }
        const prodId = entry?.productId || '';
        if (!prodId) return null;
        const parsedQty = Number(entry.quantity);
        const safeQty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;
        const parsedConv = Number(entry.conversionFactor);
        const safeConv = Number.isFinite(parsedConv) && parsedConv > 0 ? parsedConv : 1;
        const parsedPrice = Number(entry.salePricePerUnit);
        return {
          productId: prodId,
          quantity: safeQty,
          conversionFactor: safeConv,
          unitName: entry.unitName,
          salePricePerUnit: Number.isFinite(parsedPrice) ? parsedPrice : undefined,
        };
      })
      .filter((item): item is CartAssistantItem => item !== null);
  }, [cart]);

  const currentCartProductIds = useMemo(
    () => new Set(normalizedCartItems.map((item) => item.productId)),
    [normalizedCartItems]
  );

  // Fingerprint captures product IDs, quantities, units and conversions so every cart mutation recalculates
  const cartSignature = useMemo(
    () =>
      normalizedCartItems
        .map(
          (item) =>
            `${item.productId}:${item.quantity}:${item.conversionFactor ?? 1}:${item.unitName || ''}`
        )
        .join('|'),
    [normalizedCartItems]
  );

  // Synchronously detect products removed in this render so they are never recommended for even 1 frame
  const effectiveRemovedProductIds = useMemo(() => {
    if (sessionResetPendingRef.current) {
      return removedProductIds;
    }
    const merged = new Set(removedProductIds);
    for (const prevId of prevCartProductIdsRef.current) {
      if (!currentCartProductIds.has(prevId)) {
        merged.add(prevId);
      }
    }
    return Array.from(merged);
  }, [removedProductIds, currentCartProductIds]);

  useEffect(() => {
    currentCartProductIdsRef.current = currentCartProductIds;

    if (sessionResetPendingRef.current) {
      prevCartProductIdsRef.current = new Set(currentCartProductIds);
      sessionResetPendingRef.current = false;
      return;
    }

    const prevIds = prevCartProductIdsRef.current;
    const newlyRemoved: string[] = [];
    for (const prevId of prevIds) {
      if (!currentCartProductIds.has(prevId)) {
        newlyRemoved.push(prevId);
      }
    }
    prevCartProductIdsRef.current = new Set(currentCartProductIds);

    if (newlyRemoved.length > 0) {
      setRemovedProductIds((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const id of newlyRemoved) {
          if (!next.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        return changed ? Array.from(next) : prev;
      });
    }
  }, [currentCartProductIds]);

  useEffect(() => {
    if (cartSignature === '') {
      setHiddenAtSignature(null);
    }
  }, [cartSignature]);

  const isHiddenForUnchangedCart =
    hiddenAtSignature !== null && hiddenAtSignature === cartSignature;

  const suggestion = useMemo<UpsellSuggestion | null>(() => {
    if (isHiddenForUnchangedCart || normalizedCartItems.length === 0) return null;
    return getUpsellSuggestion({
      cartItems: normalizedCartItems,
      catalog: effectiveCatalog,
      dismissedProductIds: dismissedUpsellIds,
      removedProductIds: effectiveRemovedProductIds,
    });
  }, [
    isHiddenForUnchangedCart,
    normalizedCartItems,
    effectiveCatalog,
    dismissedUpsellIds,
    effectiveRemovedProductIds,
  ]);

  const dismissSuggestion = useCallback(
    (suggestedProductId?: string) => {
      if (suggestedProductId) {
        setDismissedUpsellIds((prev) =>
          prev.includes(suggestedProductId) ? prev : [...prev, suggestedProductId]
        );
      }
      setHiddenAtSignature(cartSignature);
    },
    [cartSignature]
  );

  const onProductAdded = useCallback(() => {
    try {
      dismissToast(POST_SALE_DIALOGUE_TOAST_ID);
    } catch {
      // Never block product entry
    }
    setHiddenAtSignature(null);
  }, [dismissToast]);

  const resetSessionTracking = useCallback(() => {
    setDismissedUpsellIds([]);
    setRemovedProductIds([]);
    setHiddenAtSignature(null);
    if (currentCartProductIdsRef.current.size > 0) {
      sessionResetPendingRef.current = true;
    } else {
      prevCartProductIdsRef.current = new Set();
      sessionResetPendingRef.current = false;
    }
  }, []);

  const onCartCleared = useCallback(() => {
    resetSessionTracking();
  }, [resetSessionTracking]);

  const onSaleSaved = useCallback(() => {
    resetSessionTracking();
    try {
      const nextDialogue = pickNextSalesDialogue(lastDialogueIdxRef.current);
      lastDialogueIdxRef.current = nextDialogue.index;
      showToast({
        id: POST_SALE_DIALOGUE_TOAST_ID,
        title: 'Customer se kahein',
        message: `"${nextDialogue.text}"`,
        tone: 'info',
        durationMs: 7500,
      });
    } catch {
      // Never interfere with post-sale completion
    }
  }, [resetSessionTracking, showToast]);

  return {
    suggestion,
    dismissSuggestion,
    onProductAdded,
    onCartCleared,
    onSaleSaved,
  };
}
