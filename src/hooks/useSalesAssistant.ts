import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import {
  mapProductsToSearchable,
  mapStaffCatalogToSearchable,
  type SearchableProductItem,
} from '../services/productSearchService';
import { recordUpsellFeedbackEvent } from '../services/upsellFeedbackService';
import {
  buildUpsellCacheKey,
  fetchGeminiUpsellFallback,
  getCachedGeminiSuggestion,
  isGeminiFallbackTemporarilyDisabled,
} from '../services/upsellFallbackClient';
import { normalizeCategoryKey } from '../utils/packaging';
import {
  type CartAssistantItem,
  filterEligibleUpsellCandidates,
  getHybridUpsellSuggestion,
  type UpsellSuggestion,
  validateGeminiUpsellResponse,
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
  onSuggestionAccepted: (suggestedProductId: string) => void;
  onProductAdded: () => void;
  onCartCleared: () => void;
  onSaleSaved: () => void;
}

const POST_SALE_DIALOGUE_TOAST_ID = 'post-sale-dialogue';
const GEMINI_DEBOUNCE_MS = 400;

export function useSalesAssistant({
  cart,
  catalog,
}: UseSalesAssistantOptions): UseSalesAssistantResult {
  const { user, shopId } = useAuth();
  const shopData = useShopData();
  const products = shopData?.products ?? [];
  const staffCatalog = shopData?.staffCatalog ?? [];
  const categories = shopData?.categories ?? [];
  const productTemplates = shopData?.productTemplates ?? [];
  const { showToast, dismissToast } = useToast();

  const [dismissedUpsellIds, setDismissedUpsellIds] = useState<string[]>([]);
  const [removedProductIds, setRemovedProductIds] = useState<string[]>([]);
  const [hiddenAtSignature, setHiddenAtSignature] = useState<string | null>(null);
  const [aiSuggestionState, setAiSuggestionState] = useState<{
    signature: string;
    suggestion: UpsellSuggestion;
  } | null>(null);

  const lastDialogueIdxRef = useRef<number | null>(null);
  const prevCartProductIdsRef = useRef<Set<string>>(new Set());
  const currentCartProductIdsRef = useRef<Set<string>>(new Set());
  const sessionResetPendingRef = useRef<boolean>(false);
  const acceptedFromUpsellIdsRef = useRef<Set<string>>(new Set());
  const lastShownEventKeyRef = useRef<string>('');

  const latestCartSignatureRef = useRef<string>('');
  const requestSeqRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const effectiveShopId = shopId || 'default_shop';

  const effectiveCatalog = useMemo<SearchableProductItem[]>(() => {
    if (catalog && catalog.length > 0) {
      if (categories.length === 0) return catalog;
      const descById = new Map<string, string>();
      const descByName = new Map<string, string>();
      for (const cat of categories) {
        const desc = (cat.description || '').trim();
        if (!desc) continue;
        if (cat.id) descById.set(cat.id, desc);
        if (cat.name) descByName.set(cat.name.trim().toLowerCase(), desc);
      }
      if (descById.size === 0 && descByName.size === 0) return catalog;
      return catalog.map((item) => {
        if (item.categoryDescription) return item;
        const catDesc =
          descById.get(item.categoryId || '') ||
          descByName.get((item.categoryName || '').trim().toLowerCase());
        return catDesc ? { ...item, categoryDescription: catDesc } : item;
      });
    }
    if (products.length > 0) {
      return mapProductsToSearchable(products, { categories, productTemplates });
    }
    if (staffCatalog.length > 0) {
      return mapStaffCatalogToSearchable(staffCatalog.filter((item) => item.isActive));
    }
    return [];
  }, [catalog, products, staffCatalog, categories, productTemplates]);

  const catalogById = useMemo(
    () => new Map(effectiveCatalog.map((item) => [item.id, item])),
    [effectiveCatalog]
  );

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

  const anchorCategoryKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const pid of currentCartProductIds) {
      const cat = catalogById.get(pid)?.categoryName;
      if (cat) keys.add(normalizeCategoryKey(cat));
    }
    return Array.from(keys);
  }, [currentCartProductIds, catalogById]);

  // Order-independent fingerprint captures product IDs, quantities, units and conversions
  const cartSignature = useMemo(
    () =>
      normalizedCartItems
        .map(
          (item) =>
            `${item.productId}:${item.quantity}:${item.conversionFactor ?? 1}:${item.unitName || ''}`
        )
        .sort()
        .join('|'),
    [normalizedCartItems]
  );

  latestCartSignatureRef.current = cartSignature;

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
      for (const removedId of newlyRemoved) {
        if (acceptedFromUpsellIdsRef.current.has(removedId)) {
          acceptedFromUpsellIdsRef.current.delete(removedId);
          const candCat = catalogById.get(removedId)?.categoryName;
          recordUpsellFeedbackEvent({
            shopId: effectiveShopId,
            productId: removedId,
            eventType: 'removed_after_add',
            categoryKey: candCat ? normalizeCategoryKey(candCat) : undefined,
            anchorCategoryKeys,
            getIdToken: user ? () => user.getIdToken() : undefined,
          });
        }
      }

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
  }, [currentCartProductIds, catalogById, effectiveShopId, anchorCategoryKeys, user]);

  useEffect(() => {
    if (cartSignature === '') {
      setHiddenAtSignature(null);
      setAiSuggestionState(null);
      lastShownEventKeyRef.current = '';
    }
  }, [cartSignature]);

  const cancelInFlightAi = useCallback(() => {
    requestSeqRef.current += 1;
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelInFlightAi();
    };
  }, [cancelInFlightAi]);

  const isHiddenForUnchangedCart =
    hiddenAtSignature !== null && hiddenAtSignature === cartSignature;

  // 1) Primary multi-layer hybrid engine: synchronous sub-ms evaluation using
  //    co-occurrence history + dynamic category/cross-category affinity + TF-IDF semantic vectors
  //    + brand/context portfolio + Bayesian self-learning feedback.
  const hybridResult = useMemo(() => {
    if (isHiddenForUnchangedCart || normalizedCartItems.length === 0) {
      return { suggestion: null as UpsellSuggestion | null, eligibleCandidateCount: 0 };
    }
    const res = getHybridUpsellSuggestion({
      shopId: effectiveShopId,
      cartItems: normalizedCartItems,
      catalog: effectiveCatalog,
      dismissedProductIds: dismissedUpsellIds,
      removedProductIds: effectiveRemovedProductIds,
    });
    return { suggestion: res.suggestion, eligibleCandidateCount: res.eligibleCandidateCount };
  }, [
    isHiddenForUnchangedCart,
    effectiveShopId,
    normalizedCartItems,
    effectiveCatalog,
    dismissedUpsellIds,
    effectiveRemovedProductIds,
  ]);
  const hybridSuggestion = hybridResult.suggestion;

  // 2) Async Gemini intelligence layer: debounced & cached fallback ONLY when local hybrid yields nothing
  useEffect(() => {
    cancelInFlightAi();

    if (
      hybridSuggestion ||
      isHiddenForUnchangedCart ||
      normalizedCartItems.length === 0 ||
      effectiveCatalog.length === 0
    ) {
      setAiSuggestionState(null);
      return;
    }

    if (hybridResult.eligibleCandidateCount === 0) {
      setAiSuggestionState(null);
      return;
    }

    // Immediate client cache hit (zero network latency)
    const cacheKey = buildUpsellCacheKey({
      shopId: effectiveShopId,
      cartSignature,
      dismissedProductIds: dismissedUpsellIds,
      removedProductIds: effectiveRemovedProductIds,
    });
    const cached = getCachedGeminiSuggestion({
      cacheKey,
      cartItems: normalizedCartItems,
      catalog: effectiveCatalog,
      dismissedProductIds: dismissedUpsellIds,
      removedProductIds: effectiveRemovedProductIds,
    });
    if (cached.hit) {
      if (cached.suggestion) {
        setAiSuggestionState({ signature: cartSignature, suggestion: cached.suggestion });
      } else {
        setAiSuggestionState(null);
      }
      return;
    }

    if (
      !user ||
      (typeof navigator !== 'undefined' && navigator.onLine === false) ||
      isGeminiFallbackTemporarilyDisabled()
    ) {
      setAiSuggestionState(null);
      return;
    }

    setAiSuggestionState((prev) => (prev && prev.signature === cartSignature ? prev : null));

    const mySeq = requestSeqRef.current + 1;
    requestSeqRef.current = mySeq;
    const expectedSignature = cartSignature;
    const cartSnapshot = normalizedCartItems;
    const catalogSnapshot = effectiveCatalog;
    const dismissedSnapshot = dismissedUpsellIds;
    const removedSnapshot = effectiveRemovedProductIds;

    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      if (
        requestSeqRef.current !== mySeq ||
        latestCartSignatureRef.current !== expectedSignature
      ) {
        return;
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      void fetchGeminiUpsellFallback({
        shopId: effectiveShopId,
        cartSignature: expectedSignature,
        cartItems: cartSnapshot,
        catalog: catalogSnapshot,
        dismissedProductIds: dismissedSnapshot,
        removedProductIds: removedSnapshot,
        getIdToken: () => user.getIdToken(),
        signal: controller.signal,
      }).then(({ suggestion: aiSuggestion, aborted }) => {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (
          aborted ||
          requestSeqRef.current !== mySeq ||
          latestCartSignatureRef.current !== expectedSignature
        ) {
          return;
        }
        if (aiSuggestion) {
          setAiSuggestionState({
            signature: expectedSignature,
            suggestion: aiSuggestion,
          });
        } else {
          setAiSuggestionState(null);
        }
      });
    }, GEMINI_DEBOUNCE_MS);

    return cancelInFlightAi;
  }, [
    cancelInFlightAi,
    hybridSuggestion,
    isHiddenForUnchangedCart,
    effectiveShopId,
    cartSignature,
    normalizedCartItems,
    effectiveCatalog,
    dismissedUpsellIds,
    effectiveRemovedProductIds,
    user,
  ]);

  // Live re-validation of any AI suggestion against latest stock & exclusions
  const validatedAiSuggestion = useMemo<UpsellSuggestion | null>(() => {
    if (
      hybridSuggestion ||
      isHiddenForUnchangedCart ||
      !aiSuggestionState ||
      aiSuggestionState.signature !== cartSignature
    ) {
      return null;
    }
    return validateGeminiUpsellResponse({
      candidateId: aiSuggestionState.suggestion.product.id,
      romanUrduPrompt: aiSuggestionState.suggestion.romanUrduPrompt,
      cartItems: normalizedCartItems,
      catalog: effectiveCatalog,
      dismissedProductIds: dismissedUpsellIds,
      removedProductIds: effectiveRemovedProductIds,
    });
  }, [
    hybridSuggestion,
    isHiddenForUnchangedCart,
    aiSuggestionState,
    cartSignature,
    normalizedCartItems,
    effectiveCatalog,
    dismissedUpsellIds,
    effectiveRemovedProductIds,
  ]);

  const suggestion = hybridSuggestion ?? validatedAiSuggestion;

  // Track displayed suggestion cleanly once per (cartSignature, product.id) in background
  useEffect(() => {
    if (!suggestion || !cartSignature) return;
    const eventKey = `${cartSignature}::${suggestion.product.id}`;
    if (lastShownEventKeyRef.current === eventKey) return;
    lastShownEventKeyRef.current = eventKey;

    recordUpsellFeedbackEvent({
      shopId: effectiveShopId,
      productId: suggestion.product.id,
      eventType: 'shown',
      categoryKey: suggestion.product.categoryName
        ? normalizeCategoryKey(suggestion.product.categoryName)
        : undefined,
      anchorCategoryKeys,
      getIdToken: user ? () => user.getIdToken() : undefined,
    });
  }, [suggestion, cartSignature, effectiveShopId, anchorCategoryKeys, user]);

  const dismissSuggestion = useCallback(
    (suggestedProductId?: string) => {
      cancelInFlightAi();
      setAiSuggestionState(null);
      if (suggestedProductId) {
        setDismissedUpsellIds((prev) =>
          prev.includes(suggestedProductId) ? prev : [...prev, suggestedProductId]
        );
        const candCat = catalogById.get(suggestedProductId)?.categoryName;
        recordUpsellFeedbackEvent({
          shopId: effectiveShopId,
          productId: suggestedProductId,
          eventType: 'dismissed',
          categoryKey: candCat ? normalizeCategoryKey(candCat) : undefined,
          anchorCategoryKeys,
          getIdToken: user ? () => user.getIdToken() : undefined,
        });
      }
      setHiddenAtSignature(cartSignature);
    },
    [cancelInFlightAi, cartSignature, catalogById, effectiveShopId, anchorCategoryKeys, user]
  );

  const onSuggestionAccepted = useCallback(
    (suggestedProductId: string) => {
      if (!suggestedProductId) return;
      acceptedFromUpsellIdsRef.current.add(suggestedProductId);
      const candCat = catalogById.get(suggestedProductId)?.categoryName;
      recordUpsellFeedbackEvent({
        shopId: effectiveShopId,
        productId: suggestedProductId,
        eventType: 'accepted',
        categoryKey: candCat ? normalizeCategoryKey(candCat) : undefined,
        anchorCategoryKeys,
        getIdToken: user ? () => user.getIdToken() : undefined,
      });
    },
    [catalogById, effectiveShopId, anchorCategoryKeys, user]
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
    cancelInFlightAi();
    setDismissedUpsellIds([]);
    setRemovedProductIds([]);
    setHiddenAtSignature(null);
    setAiSuggestionState(null);
    acceptedFromUpsellIdsRef.current.clear();
    lastShownEventKeyRef.current = '';
    if (currentCartProductIdsRef.current.size > 0) {
      sessionResetPendingRef.current = true;
    } else {
      prevCartProductIdsRef.current = new Set();
      sessionResetPendingRef.current = false;
    }
  }, [cancelInFlightAi]);

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
    onSuggestionAccepted,
    onProductAdded,
    onCartCleared,
    onSaleSaved,
  };
}
