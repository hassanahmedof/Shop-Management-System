import {
  cosineSimilaritySparse,
  getOrUpdateCatalogIntelligenceSync,
  type ProductFeatureExtract,
} from '../services/catalogIntelligenceService';
import type { SearchableProductItem } from '../services/productSearchService';
import {
  getCooccurrenceStatsSnapshot,
  getHistoricalCooccurrenceCandidates,
} from '../services/upsellCooccurrenceService';
import { getUpsellFeedbackAdjustment } from '../services/upsellFeedbackService';
import {
  formatStockBreakdown,
  getDefaultSaleUnit,
  normalizeCategoryKey,
  roundStockQty,
} from './packaging';

export interface CartAssistantItem {
  productId: string;
  quantity: number;
  conversionFactor?: number;
  unitName?: string;
  salePricePerUnit?: number;
}

export interface UpsellSuggestion {
  product: SearchableProductItem;
  triggerProductId: string;
  romanUrduPrompt: string;
  stockSummary: string;
  ruleId: string;
  score: number;
  confidence?: number;
  source?: 'history' | 'hybrid' | 'gemini';
}

export interface HybridUpsellEvaluationResult {
  suggestion: UpsellSuggestion | null;
  confidence: number;
  needsAiRefinement: boolean;
  eligibleCandidateCount: number;
}

export interface StructuredProductIdentity {
  productId: string;
  brandId: string;
  brandKey: string;
  categoryId: string;
  categoryKey: string;
  coreTitleKey: string;
  coreTitleTokens: Set<string>;
  variantStrippedTokens: Set<string>;
  packNumericScore: number;
}

export const MIN_RECOMMENDATION_CONFIDENCE = 0.33;
export const GEMINI_CONFIDENT_SKIP_THRESHOLD = 0.42;

const GENERIC_BRAND_KEYS = new Set(['', 'unbranded', 'generic', 'other', 'local', 'none', 'n/a']);
const CATCHALL_CATEGORY_KEYS = new Set(['', 'other products', 'other', 'general', 'miscellaneous']);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function jaccardSet(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) {
    if (b.has(tok)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function countSetIntersection(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const tok of a) {
    if (b.has(tok)) count += 1;
  }
  return count;
}

// Temporary local extract helper keeps getStructuredProductIdentity pure and stateless
import { extractProductFeatures } from '../services/catalogIntelligenceService';

/**
 * Computes deterministic structured identity for a product from its existing
 * catalog metadata (`brandId`/`brandName`, `categoryId`/`categoryName`, `bottleSize`,
 * `baseUnit`/`unit`, `packagingUnits`) without any hardcoded product dictionaries.
 */
export function getStructuredProductIdentity(
  item: SearchableProductItem
): StructuredProductIdentity {
  const ext = extractProductFeatures(item);
  return {
    productId: ext.productId,
    brandId: ext.brandId,
    brandKey: ext.brandKey,
    categoryId: ext.categoryId,
    categoryKey: ext.categoryKey,
    coreTitleKey: ext.coreTitleKey,
    coreTitleTokens: ext.coreTitleTokens,
    variantStrippedTokens: ext.variantStrippedTokens,
    packNumericScore: ext.packNumericScore,
  };
}

function fromExtractToCategoryMatch(
  a: Pick<ProductFeatureExtract, 'categoryId' | 'categoryKey'>,
  b: Pick<ProductFeatureExtract, 'categoryId' | 'categoryKey'>
): { same: boolean; bothKnown: boolean } {
  const aHas = Boolean(a.categoryId || a.categoryKey);
  const bHas = Boolean(b.categoryId || b.categoryKey);
  if (!aHas || !bHas) return { same: false, bothKnown: false };
  if (a.categoryId && b.categoryId) {
    return { same: a.categoryId === b.categoryId, bothKnown: true };
  }
  if (a.categoryKey && b.categoryKey) {
    return { same: a.categoryKey === b.categoryKey, bothKnown: true };
  }
  return { same: false, bothKnown: true };
}

function fromExtractToBrandMatch(
  a: Pick<ProductFeatureExtract, 'brandId' | 'brandKey'>,
  b: Pick<ProductFeatureExtract, 'brandId' | 'brandKey'>
): { same: boolean; bothKnown: boolean } {
  const aHas = Boolean(a.brandId || (a.brandKey && !GENERIC_BRAND_KEYS.has(a.brandKey)));
  const bHas = Boolean(b.brandId || (b.brandKey && !GENERIC_BRAND_KEYS.has(b.brandKey)));
  if (!aHas || !bHas) return { same: false, bothKnown: false };

  if (a.brandId && b.brandId) {
    return { same: a.brandId === b.brandId, bothKnown: true };
  }
  if (
    a.brandKey &&
    b.brandKey &&
    !GENERIC_BRAND_KEYS.has(a.brandKey) &&
    !GENERIC_BRAND_KEYS.has(b.brandKey)
  ) {
    return { same: a.brandKey === b.brandKey, bothKnown: true };
  }
  return { same: false, bothKnown: true };
}

/**
 * Conservative variant detection:
 * 1) Structured identity match (same category + same brand + same size-stripped core title).
 * 2) Conservative attribute inference when size modifiers or missing brand metadata differ,
 *    requiring category compatibility + high non-size core token overlap (>= 0.78 with >= 2 shared core tokens).
 * Never treats distinct same-brand lines or single shared generic words as variants.
 */
export function areSameProductOrVariant(
  a: SearchableProductItem,
  b: SearchableProductItem,
  extractA?: ProductFeatureExtract,
  extractB?: ProductFeatureExtract
): boolean {
  if (a.id === b.id) return true;

  const idA = extractA || extractProductFeatures(a);
  const idB = extractB || extractProductFeatures(b);

  if (!idA.coreTitleKey || !idB.coreTitleKey) return false;

  const catInfo = fromExtractToCategoryMatch(idA, idB);
  // Different explicitly known categories (e.g. Diapers vs Baby Wipes) are distinct lines, never variants
  if (catInfo.bothKnown && !catInfo.same) return false;

  const brandInfo = fromExtractToBrandMatch(idA, idB);
  // Different explicitly known brands are competing/complementary brands, not variants of the same SKU
  if (brandInfo.bothKnown && !brandInfo.same) return false;

  if (brandInfo.same && catInfo.same) {
    if (idA.coreTitleKey === idB.coreTitleKey) return true;
    const shared = countSetIntersection(idA.variantStrippedTokens, idB.variantStrippedTokens);
    const sim = jaccardSet(idA.variantStrippedTokens, idB.variantStrippedTokens);
    if (shared >= 2 && sim >= 0.78) return true;
    return false;
  }

  // Fallback when category or brand metadata is missing on either/both records: conservative match only
  if (idA.coreTitleKey === idB.coreTitleKey && idA.coreTitleKey.includes(' ') && idA.coreTitleKey.length >= 8) {
    return true;
  }

  const shared = countSetIntersection(idA.variantStrippedTokens, idB.variantStrippedTokens);
  const sim = jaccardSet(idA.variantStrippedTokens, idB.variantStrippedTokens);
  if (shared >= 2 && sim >= 0.85) {
    return true;
  }

  return false;
}

export function normalizeCartItemsForAssistant(params: {
  cartItems?: CartAssistantItem[];
  cartProductIds?: string[];
}): CartAssistantItem[] {
  const { cartItems, cartProductIds } = params;
  if (Array.isArray(cartItems) && cartItems.length > 0) {
    return cartItems.filter((c) => Boolean(c && c.productId));
  }
  if (Array.isArray(cartProductIds) && cartProductIds.length > 0) {
    return cartProductIds
      .filter(Boolean)
      .map((productId) => ({ productId, quantity: 1, conversionFactor: 1 }));
  }
  return [];
}

export function isCandidateInLiveStock(candidate: SearchableProductItem): boolean {
  if (candidate.isActive === false) return false;
  const availableBaseStock = roundStockQty(Math.max(0, Number(candidate.currentStock) || 0));
  if (availableBaseStock <= 0) return false;
  const defaultSaleUnit = getDefaultSaleUnit(candidate);
  return availableBaseStock >= defaultSaleUnit.conversionQty;
}

export interface EligibleCandidatesFilterResult {
  normalizedCart: CartAssistantItem[];
  cartCatalogItems: SearchableProductItem[];
  eligibleCandidates: SearchableProductItem[];
  catalogById: Map<string, SearchableProductItem>;
}

/**
 * Applies ALL mandatory hard filters against live catalog & cart state:
 * - active product
 * - not already in cart
 * - not dismissed or removed in current session
 * - not an alternate pack/size variant of any product already in cart
 * - live stock >= default sellable unit conversionQty
 */
export function filterEligibleUpsellCandidates(params: {
  cartItems?: CartAssistantItem[];
  cartProductIds?: string[];
  catalog: SearchableProductItem[];
  dismissedProductIds?: string[];
  removedProductIds?: string[];
  extractsById?: Map<string, ProductFeatureExtract>;
}): EligibleCandidatesFilterResult {
  const {
    cartItems,
    cartProductIds,
    catalog,
    dismissedProductIds = [],
    removedProductIds = [],
    extractsById,
  } = params;

  const normalizedCart = normalizeCartItemsForAssistant({ cartItems, cartProductIds });
  const catalogById = new Map<string, SearchableProductItem>();

  if (!Array.isArray(catalog) || catalog.length === 0 || normalizedCart.length === 0) {
    return {
      normalizedCart,
      cartCatalogItems: [],
      eligibleCandidates: [],
      catalogById,
    };
  }

  for (const item of catalog) {
    catalogById.set(item.id, item);
  }

  const cartIdSet = new Set<string>();
  const cartCatalogItems: SearchableProductItem[] = [];
  for (const line of normalizedCart) {
    if (!line.productId) continue;
    cartIdSet.add(line.productId);
    const matched = catalogById.get(line.productId);
    if (matched) {
      cartCatalogItems.push(matched);
    }
  }

  const excludedSet = new Set(
    [...dismissedProductIds, ...removedProductIds].filter(Boolean)
  );

  const eligibleCandidates: SearchableProductItem[] = [];
  for (const candidate of catalog) {
    if (cartIdSet.has(candidate.id)) continue;
    if (excludedSet.has(candidate.id)) continue;
    if (!isCandidateInLiveStock(candidate)) continue;
    const candExt = extractsById?.get(candidate.id);
    if (
      cartCatalogItems.some((cartProd) =>
        areSameProductOrVariant(
          cartProd,
          candidate,
          extractsById?.get(cartProd.id),
          candExt
        )
      )
    ) {
      continue;
    }
    eligibleCandidates.push(candidate);
  }

  return {
    normalizedCart,
    cartCatalogItems,
    eligibleCandidates,
    catalogById,
  };
}

function buildShortProductLabel(name: string): string {
  const trimmed = (name || '').trim();
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 26).trim()}…`;
}

function buildRomanUrduPrompt(params: {
  candidateName: string;
  anchorName?: string;
  distinctAnchorMatches: number;
}): string {
  const { candidateName, anchorName, distinctAnchorMatches } = params;
  if (distinctAnchorMatches > 1 || !anchorName) {
    return `Basket ke saath ${candidateName} bhi rakh lain?`;
  }
  return `${buildShortProductLabel(anchorName)} ke saath ${candidateName} bhi rakh lain?`;
}

/**
 * Multi-Layer Adaptive Hybrid Recommendation Engine:
 * Evaluates the ENTIRE current cart across:
 *   1. Completed-sales historical co-occurrence (confidence + lift + support)
 *   2. Dynamic category & cross-category affinity (brand-bridge + category semantic overlap + non-variant sibling diversity)
 *   3. Dynamic TF-IDF attribute & semantic similarity (cosine similarity over background-indexed vectors)
 *   4. Brand portfolio & store context (cross-category same-brand lines, storageLocation, originType, price/pack/stock sanity)
 *   5. Self-learning Bayesian feedback signals (accepted/dismissed/removed adjustments)
 *
 * Dynamically redistributes weights across active layers so cold-start shops with
 * zero sales history immediately produce relevant recommendations when catalog signals exist,
 * while returning null cleanly when no candidate clears minimum confidence.
 */
export function getHybridUpsellSuggestion(params: {
  shopId: string;
  cartItems?: CartAssistantItem[];
  cartProductIds?: string[];
  catalog: SearchableProductItem[];
  dismissedProductIds?: string[];
  removedProductIds?: string[];
}): HybridUpsellEvaluationResult {
  try {
    const {
      shopId,
      cartItems,
      cartProductIds,
      catalog,
      dismissedProductIds,
      removedProductIds,
    } = params;

    if (!shopId || !Array.isArray(catalog) || catalog.length === 0) {
      return {
        suggestion: null,
        confidence: 0,
        needsAiRefinement: false,
        eligibleCandidateCount: 0,
      };
    }

    const intel = getOrUpdateCatalogIntelligenceSync(shopId, catalog);
    const extractsById = new Map<string, ProductFeatureExtract>();
    for (const [pid, prof] of intel.profilesById.entries()) {
      extractsById.set(pid, prof.extract);
    }

    const { normalizedCart, cartCatalogItems, eligibleCandidates, catalogById } =
      filterEligibleUpsellCandidates({
        cartItems,
        cartProductIds,
        catalog,
        dismissedProductIds,
        removedProductIds,
        extractsById,
      });

    if (normalizedCart.length === 0 || cartCatalogItems.length === 0 || eligibleCandidates.length === 0) {
      return {
        suggestion: null,
        confidence: 0,
        needsAiRefinement: false,
        eligibleCandidateCount: eligibleCandidates.length,
      };
    }

    // Aggregate per-cart-item effective quantities
    const cartEffectiveQtyById = new Map<string, number>();
    let totalEffectiveBasketQty = 0;
    let totalBasketValue = 0;
    let totalPriceWeight = 0;

    for (const line of normalizedCart) {
      const prod = catalogById.get(line.productId);
      if (!prod) continue;
      const qty = Math.max(0.25, Number(line.quantity) || 1);
      const conv = Math.max(1, Number(line.conversionFactor) || 1);
      const effQty = roundStockQty(qty * conv);
      cartEffectiveQtyById.set(
        line.productId,
        roundStockQty((cartEffectiveQtyById.get(line.productId) || 0) + effQty)
      );
      totalEffectiveBasketQty = roundStockQty(totalEffectiveBasketQty + effQty);

      const linePrice =
        Number.isFinite(Number(line.salePricePerUnit)) && Number(line.salePricePerUnit) > 0
          ? Number(line.salePricePerUnit)
          : getDefaultSaleUnit(prod).salePrice;
      if (linePrice > 0) {
        totalBasketValue += linePrice * qty;
        totalPriceWeight += qty;
      }
    }

    const avgCartUnitPrice = totalPriceWeight > 0 ? totalBasketValue / totalPriceWeight : 0;

    // Build weighted cart semantic centroid across ALL items in cart
    const rawCartCentroid = new Map<string, number>();
    const anchorWeightById = new Map<string, number>();
    const anchorCategoryKeysSet = new Set<string>();

    for (const cartProd of cartCatalogItems) {
      const effQty = cartEffectiveQtyById.get(cartProd.id) || 1;
      const qtyWeight = 1 + Math.log1p(Math.max(0, effQty - 1)) * 0.35;
      anchorWeightById.set(cartProd.id, qtyWeight);

      const prof = intel.profilesById.get(cartProd.id);
      if (prof) {
        if (prof.extract.categoryKey && !CATCHALL_CATEGORY_KEYS.has(prof.extract.categoryKey)) {
          anchorCategoryKeysSet.add(prof.extract.categoryKey);
        }
        for (const [term, w] of prof.tfidfVector.entries()) {
          rawCartCentroid.set(term, (rawCartCentroid.get(term) || 0) + w * qtyWeight);
        }
      }
    }

    let centroidNormSq = 0;
    for (const val of rawCartCentroid.values()) centroidNormSq += val * val;
    const cartCentroid = new Map<string, number>();
    if (centroidNormSq > 0) {
      const invNorm = 1 / Math.sqrt(centroidNormSq);
      for (const [term, val] of rawCartCentroid.entries()) {
        cartCentroid.set(term, val * invNorm);
      }
    }

    const anchorCategoryKeys = Array.from(anchorCategoryKeysSet);

    // Layer 1 data: Historical co-occurrence
    const histStats = getCooccurrenceStatsSnapshot(shopId);
    const histRanks =
      histStats.totalCompletedSales > 0
        ? getHistoricalCooccurrenceCandidates(shopId, normalizedCart)
        : [];
    const histByProductId = new Map(histRanks.map((r) => [r.productId, r]));
    const historyActiveForCart = histRanks.length > 0;

    let bestCandidate: {
      candidate: SearchableProductItem;
      confidence: number;
      score100: number;
      triggerProductId: string;
      distinctAnchorMatches: number;
      ruleId: string;
      source: 'history' | 'hybrid';
    } | null = null;

    for (const candidate of eligibleCandidates) {
      const candProf = intel.profilesById.get(candidate.id);
      const candExt = candProf?.extract || extractProductFeatures(candidate);

      // 1) Historical Co-Occurrence signal [0..1]
      const hist = histByProductId.get(candidate.id);
      let H = 0;
      if (hist) {
        const supportNorm = Math.min(1, Math.log1p(hist.pairCount) / Math.log1p(6));
        const confNorm = clamp01(hist.confidence);
        const liftNorm = clamp01((hist.lift - 0.75) / 2.25);
        const multiHistBonus = Math.min(0.18, Math.max(0, hist.distinctAnchorMatches - 1) * 0.12);
        H = clamp01(0.36 * supportNorm + 0.34 * confNorm + 0.30 * liftNorm + multiHistBonus);
      }

      // 2) Dynamic Category & Cross-Category Complementarity [0..1]
      let catWeightedSum = 0;
      let catWeightDenom = 0;
      let catMatches = 0;
      let bestAnchorCatScore = 0;
      let bestAnchorId = cartCatalogItems[0]?.id || '';

      // 3) & 4) Per-anchor semantic + brand/context evaluation across ENTIRE cart
      let semanticMatchAnchors = 0;
      let maxCoreTokenOverlap = 0;
      let bestSameBrandCrossScore = 0;
      let sharedStorageMatch = false;
      let sharedOriginMatch = false;
      let sharedReturnableMatch = false;
      let bestSemanticAnchorScore = 0;

      const candCatValid =
        Boolean(candExt.categoryKey) && !CATCHALL_CATEGORY_KEYS.has(candExt.categoryKey);

      for (const cartProd of cartCatalogItems) {
        const anchorProf = intel.profilesById.get(cartProd.id);
        const anchorExt = anchorProf?.extract || extractProductFeatures(cartProd);
        const qtyWeight = anchorWeightById.get(cartProd.id) || 1;

        const coreOverlap = jaccardSet(anchorExt.coreTitleTokens, candExt.coreTitleTokens);
        if (coreOverlap > maxCoreTokenOverlap) {
          maxCoreTokenOverlap = coreOverlap;
        }

        // Pairwise semantic similarity
        if (anchorProf && candProf) {
          const pairSem = cosineSimilaritySparse(anchorProf.tfidfVector, candProf.tfidfVector);
          if (pairSem >= 0.16) {
            semanticMatchAnchors += 1;
          }
          if (pairSem * qtyWeight > bestSemanticAnchorScore) {
            bestSemanticAnchorScore = pairSem * qtyWeight;
            if (!hist) {
              bestAnchorId = cartProd.id;
            }
          }
        }

        // Category complementarity
        const anchorCatValid =
          Boolean(anchorExt.categoryKey) && !CATCHALL_CATEGORY_KEYS.has(anchorExt.categoryKey);
        if (candCatValid && anchorCatValid) {
          catWeightDenom += qtyWeight;
          let pairCatScore = 0;

          if (anchorExt.categoryKey === candExt.categoryKey) {
            // Same category: reward clearly distinct complementary lines; reject near-duplicate titles
            if (coreOverlap < 0.35) {
              pairCatScore = 0.56 * (1 - coreOverlap);
              catMatches += 1;
            } else if (coreOverlap < 0.60) {
              pairCatScore = 0.24 * (1 - coreOverlap);
            }
          } else {
            const aff =
              intel.categoryAffinities.get(anchorExt.categoryKey)?.get(candExt.categoryKey) || 0;
            if (aff >= 0.10) {
              pairCatScore = Math.min(1, aff * 1.25 + 0.08);
              catMatches += 1;
            }
          }

          catWeightedSum += pairCatScore * qtyWeight;
          if (pairCatScore > bestAnchorCatScore) {
            bestAnchorCatScore = pairCatScore;
            if (!hist && pairCatScore >= 0.25) {
              bestAnchorId = cartProd.id;
            }
          }
        }

        // Brand portfolio affinity: same known brand, distinct line / cross-category
        const brandInfo = fromExtractToBrandMatch(anchorExt, candExt);
        const catInfo = fromExtractToCategoryMatch(anchorExt, candExt);
        if (brandInfo.same && (!catInfo.same || coreOverlap < 0.35)) {
          const lineStrength = !catInfo.same ? 0.78 : 0.62;
          const boosted = clamp01(lineStrength * Math.min(1.2, qtyWeight * 0.95));
          if (boosted > bestSameBrandCrossScore) {
            bestSameBrandCrossScore = boosted;
            if (!hist) {
              bestAnchorId = cartProd.id;
            }
          }
        }

        if (
          anchorExt.storageLocationKey &&
          candExt.storageLocationKey &&
          anchorExt.storageLocationKey === candExt.storageLocationKey
        ) {
          sharedStorageMatch = true;
        }
        if (
          anchorExt.originType &&
          candExt.originType &&
          anchorExt.originType === candExt.originType
        ) {
          sharedOriginMatch = true;
        }
        if (anchorExt.isReturnable && candExt.isReturnable && !catInfo.same) {
          sharedReturnableMatch = true;
        }
      }

      const Cat =
        catWeightDenom > 0
          ? clamp01(
              catWeightedSum / catWeightDenom +
                (catMatches > 1 ? Math.min(0.16, (catMatches - 1) * 0.09) : 0)
            )
          : 0;

      // 3) Semantic similarity to whole basket [0..1]
      const rawCartCosine = candProf
        ? cosineSimilaritySparse(cartCentroid, candProf.tfidfVector)
        : 0;
      const substituteDampen = maxCoreTokenOverlap >= 0.65 ? 0.45 : 1;
      const multiSemBonus =
        semanticMatchAnchors > 1 ? Math.min(0.22, (semanticMatchAnchors - 1) * 0.12) : 0;
      const Sem = clamp01((rawCartCosine * 1.65 + multiSemBonus) * substituteDampen);

      // 4) Brand portfolio & POS context [0..1]
      const defUnit = getDefaultSaleUnit(candidate);
      const candPrice = defUnit.salePrice || candExt.unitSalePrice || 0;
      let priceAdjust = 0;
      if (avgCartUnitPrice > 0 && candPrice > 0) {
        const priceRatio = candPrice / avgCartUnitPrice;
        if (priceRatio >= 0.08 && priceRatio <= 2.2) {
          priceAdjust = 0.08;
        } else if (priceRatio > 4.5) {
          priceAdjust = -0.10;
        }
      }

      const availableBaseStock = roundStockQty(Math.max(0, Number(candidate.currentStock) || 0));
      const sellableUnits = Math.floor(
        availableBaseStock / Math.max(1, defUnit.conversionQty)
      );
      const stockTiebreak = 0.04 * Math.min(1, sellableUnits / 10);
      const packAlignBonus =
        (totalEffectiveBasketQty >= 2 || normalizedCart.length >= 2) &&
        candExt.packNumericScore >= 2
          ? 0.07
          : 0;

      const BrandCtx = clamp01(
        bestSameBrandCrossScore * 0.78 +
          (sharedStorageMatch ? 0.24 : 0) +
          (sharedOriginMatch ? 0.08 : 0) +
          (sharedReturnableMatch ? 0.08 : 0) +
          packAlignBonus +
          priceAdjust +
          stockTiebreak
      );

      // 5) Self-learning Bayesian feedback adjustment [-0.18..+0.22]
      const feedbackDelta = getUpsellFeedbackAdjustment({
        shopId,
        candidateProductId: candidate.id,
        candidateCategoryKey: candExt.categoryKey,
        anchorCategoryKeys,
      });

      // Dynamic weight allocation across currently available catalog layers + non-diluting history fusion
      const wCat = catWeightDenom > 0 ? 0.24 : 0;
      const wSem = candProf && cartCentroid.size > 0 ? 0.20 : 0;
      const wCtx = 0.12;
      const catalogWeightSum = wCat + wSem + wCtx;

      const catalogConfidence =
        catalogWeightSum > 0
          ? (wCat * Cat + wSem * Sem + wCtx * BrandCtx) / catalogWeightSum
          : 0;

      // When history has co-occurrence evidence for this cart+candidate, fuse behavioral history
      // with catalog signals so valid non-lexical cross-category pairs (e.g. Tea -> Biscuit)
      // are never diluted below threshold by zero lexical overlap.
      const baseConfidence =
        historyActiveForCart && H > 0
          ? clamp01(0.58 * H + 0.42 * catalogConfidence + 0.22 * Math.max(H, catalogConfidence))
          : catalogConfidence;

      const finalConfidence = clamp01(baseConfidence + feedbackDelta);

      // Core signal gate prevents pure price/stock noise from triggering unrelated upsells
      const strongestCoreSignal = Math.max(
        H,
        Cat,
        rawCartCosine * 1.45,
        bestSameBrandCrossScore,
        sharedStorageMatch ? 0.24 : 0
      );

      if (strongestCoreSignal < 0.22 || finalConfidence < MIN_RECOMMENDATION_CONFIDENCE) {
        continue;
      }

      // Tie-breaker uses sellable stock slightly only when confidence is nearly identical
      const totalSortScore = finalConfidence + stockTiebreak * 0.05;
      const existingBestSort = bestCandidate ? bestCandidate.confidence : -1;

      if (
        !bestCandidate ||
        totalSortScore > existingBestSort + 1e-6 ||
        (Math.abs(totalSortScore - existingBestSort) <= 1e-6 &&
          candidate.name.localeCompare(bestCandidate.candidate.name) < 0)
      ) {
        const distinctAnchors = hist
          ? hist.distinctAnchorMatches
          : Math.max(catMatches, semanticMatchAnchors, 1);
        const triggerId = hist ? hist.triggerProductId : bestAnchorId;
        const usedHistoryPrimary = Boolean(hist && H >= catalogConfidence * 0.85);

        bestCandidate = {
          candidate,
          confidence: Math.round(finalConfidence * 1000) / 1000,
          score100: Math.round(finalConfidence * 10000) / 100,
          triggerProductId: triggerId,
          distinctAnchorMatches: distinctAnchors,
          ruleId: usedHistoryPrimary
            ? `history_cooccur_${hist!.maxSinglePairCount}x`
            : bestSameBrandCrossScore >= 0.5
              ? 'hybrid_brand_complement'
              : Cat >= Sem
                ? 'hybrid_category_affinity'
                : 'hybrid_semantic_match',
          source: usedHistoryPrimary ? 'history' : 'hybrid',
        };
      }
    }

    if (!bestCandidate) {
      return {
        suggestion: null,
        confidence: 0,
        needsAiRefinement: eligibleCandidates.length > 0,
        eligibleCandidateCount: eligibleCandidates.length,
      };
    }

    const chosen = bestCandidate.candidate;
    const availableBaseStock = roundStockQty(Math.max(0, Number(chosen.currentStock) || 0));
    const stockBreakdown = formatStockBreakdown(availableBaseStock, chosen);
    const triggerProd = catalogById.get(bestCandidate.triggerProductId);

    return {
      suggestion: {
        product: chosen,
        triggerProductId: bestCandidate.triggerProductId,
        romanUrduPrompt: buildRomanUrduPrompt({
          candidateName: chosen.name,
          anchorName: triggerProd?.name,
          distinctAnchorMatches: bestCandidate.distinctAnchorMatches,
        }),
        stockSummary: stockBreakdown.summaryText,
        ruleId: bestCandidate.ruleId,
        score: bestCandidate.score100,
        confidence: bestCandidate.confidence,
        source: bestCandidate.source,
      },
      confidence: bestCandidate.confidence,
      needsAiRefinement: bestCandidate.confidence < GEMINI_CONFIDENT_SKIP_THRESHOLD,
      eligibleCandidateCount: eligibleCandidates.length,
    };
  } catch {
    return {
      suggestion: null,
      confidence: 0,
      needsAiRefinement: false,
      eligibleCandidateCount: 0,
    };
  }
}

/**
 * Legacy helper alias retained for backwards compatibility with any callers/tests.
 * Delegates to the multi-layer hybrid engine.
 */
export function getHistoricalUpsellSuggestion(params: {
  shopId: string;
  cartItems?: CartAssistantItem[];
  cartProductIds?: string[];
  catalog: SearchableProductItem[];
  dismissedProductIds?: string[];
  removedProductIds?: string[];
}): UpsellSuggestion | null {
  return getHybridUpsellSuggestion(params).suggestion;
}

/**
 * Selects a compact, category-diverse, in-stock subset of eligible candidates
 * to send to the server-side Gemini fallback without exceeding token budgets.
 */
export function buildGeminiFallbackPayload(params: {
  cartItems: CartAssistantItem[];
  catalogById: Map<string, SearchableProductItem>;
  eligibleCandidates: SearchableProductItem[];
  maxCandidates?: number;
}) {
  const { cartItems, catalogById, eligibleCandidates, maxCandidates = 20 } = params;

  const cartPayload = cartItems
    .map((line) => {
      const prod = catalogById.get(line.productId);
      if (!prod) return null;
      return {
        id: prod.id,
        name: prod.name,
        categoryName: prod.categoryName || '',
        brandName: prod.brandName || '',
        bottleSize: prod.bottleSize || '',
        quantity: roundStockQty(Math.max(0.25, Number(line.quantity) || 1)),
        unitName: line.unitName || getDefaultSaleUnit(prod).unitName,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (cartPayload.length === 0 || eligibleCandidates.length === 0) {
    return null;
  }

  const cartCategoryKeys = new Set(
    cartPayload.map((c) => normalizeCategoryKey(c.categoryName)).filter(Boolean)
  );

  const sorted = [...eligibleCandidates].sort((a, b) => {
    const aCat = normalizeCategoryKey(a.categoryName || '');
    const bCat = normalizeCategoryKey(b.categoryName || '');
    const aCrossCat = aCat && !cartCategoryKeys.has(aCat) ? 1 : 0;
    const bCrossCat = bCat && !cartCategoryKeys.has(bCat) ? 1 : 0;
    if (bCrossCat !== aCrossCat) return bCrossCat - aCrossCat;

    const aUnits = Math.floor(
      roundStockQty(a.currentStock) / Math.max(1, getDefaultSaleUnit(a).conversionQty)
    );
    const bUnits = Math.floor(
      roundStockQty(b.currentStock) / Math.max(1, getDefaultSaleUnit(b).conversionQty)
    );
    if (bUnits !== aUnits) return bUnits - aUnits;
    return a.name.localeCompare(b.name);
  });

  const byCategory = new Map<string, SearchableProductItem[]>();
  for (const cand of sorted) {
    const key = normalizeCategoryKey(cand.categoryName || '') || '__other__';
    const list = byCategory.get(key) || [];
    list.push(cand);
    byCategory.set(key, list);
  }

  const selected: SearchableProductItem[] = [];
  const selectedIds = new Set<string>();
  let roundIdx = 0;
  while (selected.length < maxCandidates) {
    let addedInRound = false;
    for (const group of byCategory.values()) {
      if (roundIdx < group.length) {
        const item = group[roundIdx];
        if (!selectedIds.has(item.id)) {
          selected.push(item);
          selectedIds.add(item.id);
          addedInRound = true;
          if (selected.length >= maxCandidates) break;
        }
      }
    }
    if (!addedInRound) break;
    roundIdx += 1;
  }

  const candidatePayload = selected.map((cand) => {
    const defUnit = getDefaultSaleUnit(cand);
    const stockBreakdown = formatStockBreakdown(roundStockQty(cand.currentStock), cand);
    return {
      id: cand.id,
      name: cand.name,
      categoryName: cand.categoryName || '',
      brandName: cand.brandName || '',
      bottleSize: cand.bottleSize || '',
      salePrice: defUnit.salePrice,
      unitName: defUnit.unitName,
      stockSummary: stockBreakdown.summaryText,
    };
  });

  return {
    cart: cartPayload,
    candidates: candidatePayload,
  };
}

/**
 * Re-validates a Gemini response candidate against the latest live cart, stock,
 * variant exclusions, and dismissed/removed session state before rendering.
 */
export function validateGeminiUpsellResponse(params: {
  candidateId: string;
  romanUrduPrompt?: string;
  cartItems: CartAssistantItem[];
  catalog: SearchableProductItem[];
  dismissedProductIds?: string[];
  removedProductIds?: string[];
}): UpsellSuggestion | null {
  const {
    candidateId,
    romanUrduPrompt,
    cartItems,
    catalog,
    dismissedProductIds,
    removedProductIds,
  } = params;

  if (!candidateId) return null;

  const { normalizedCart, eligibleCandidates } = filterEligibleUpsellCandidates({
    cartItems,
    catalog,
    dismissedProductIds,
    removedProductIds,
  });

  if (normalizedCart.length === 0) return null;

  const matched = eligibleCandidates.find((c) => c.id === candidateId);
  if (!matched) return null;

  const availableBaseStock = roundStockQty(Math.max(0, Number(matched.currentStock) || 0));
  const stockBreakdown = formatStockBreakdown(availableBaseStock, matched);
  const cleanPrompt =
    typeof romanUrduPrompt === 'string' && romanUrduPrompt.trim().length > 0
      ? romanUrduPrompt.trim()
      : `Saath ${matched.name} bhi rakh lain?`;

  return {
    product: matched,
    triggerProductId: normalizedCart[0]?.productId || '',
    romanUrduPrompt: cleanPrompt,
    stockSummary: stockBreakdown.summaryText,
    ruleId: 'gemini_fallback',
    score: 1,
    source: 'gemini',
  };
}
