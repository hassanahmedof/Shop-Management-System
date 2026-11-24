import type { SearchableProductItem } from '../services/productSearchService';
import { getHistoricalCooccurrenceCandidates } from '../services/upsellCooccurrenceService';
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
  source?: 'history' | 'gemini';
}

export interface StructuredProductIdentity {
  productId: string;
  brandId: string;
  brandKey: string;
  categoryId: string;
  categoryKey: string;
  coreTitleKey: string;
  packNumericScore: number;
}

const GENERIC_BRAND_KEYS = new Set(['', 'unbranded', 'generic', 'other', 'local', 'none', 'n/a']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAlnumWords(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPackNumericScore(text: string): number {
  const matches = text.toLowerCase().match(/\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return 0;
  let maxVal = 0;
  for (const m of matches) {
    const n = Number(m);
    if (Number.isFinite(n) && n > maxVal) {
      maxVal = n;
    }
  }
  return maxVal;
}

/**
 * Computes a deterministic structured identity for a product using ONLY its existing
 * catalog metadata (`brandId`/`brandName`, `categoryId`/`categoryName`, `bottleSize`,
 * `baseUnit`/`unit`, `packagingUnits`) and explicit numeric/unit suffix stripping.
 * Never invents product families or merges unrelated products.
 */
export function getStructuredProductIdentity(
  item: Pick<
    SearchableProductItem,
    'id' | 'name' | 'brandId' | 'brandName' | 'categoryId' | 'categoryName' | 'bottleSize' | 'unit' | 'baseUnit' | 'packagingUnits'
  >
): StructuredProductIdentity {
  const brandId = (item.brandId || '').trim().toLowerCase();
  const brandKey = normalizeAlnumWords(item.brandName || '');
  const categoryId = (item.categoryId || '').trim().toLowerCase();
  const categoryKey = normalizeCategoryKey(item.categoryName || '');

  let title = (item.name || '').toLowerCase();

  // Strip exact structured bottleSize / size label if present in title
  if (item.bottleSize && item.bottleSize.trim()) {
    const cleanSize = escapeRegExp(item.bottleSize.trim().toLowerCase()).replace(/\s+/g, '\\s*');
    title = title.replace(new RegExp(`\\b${cleanSize}\\b`, 'gi'), ' ');
  }

  // Strip explicit packaging unit names configured on this product
  const unitNames = new Set<string>();
  if (item.unit) unitNames.add(item.unit.trim().toLowerCase());
  if (item.baseUnit) unitNames.add(item.baseUnit.trim().toLowerCase());
  if (Array.isArray(item.packagingUnits)) {
    for (const pu of item.packagingUnits) {
      if (pu?.unitName) unitNames.add(pu.unitName.trim().toLowerCase());
    }
  }

  // Strip explicit quantity/measurement + unit tokens (e.g., 500ml, 1.5L, 34s, 64 pcs, Size 4, Pack of 12)
  title = title
    .replace(/\bpack\s+of\s+\d+\b/gi, ' ')
    .replace(/\b(?:size|no\.?|stage)\s*\d+\b/gi, ' ')
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:ml|l|ltr|liters?|litres?|g|gm|grams?|kg|kgs?|mg|pcs?|pieces?|s|sheets?|pulls?|tabs?|tablets?|caps?|capsules?|oz)\b/gi,
      ' '
    )
    .replace(/\b(?:xl|xxl|xxxl|xs|mini|small|medium|large|jumbo|mega|economy|value|family)\s+(?:pack|size|box|bottle|pouch)\b/gi, ' ')
    .replace(/\b(?:xl|xxl|xxxl)\b/gi, ' ');

  if (unitNames.size > 0) {
    const unitPattern = Array.from(unitNames)
      .filter((u) => u.length >= 2)
      .map((u) => escapeRegExp(u))
      .join('|');
    if (unitPattern) {
      title = title
        .replace(new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*(?:${unitPattern})s?\\b`, 'gi'), ' ')
        .replace(new RegExp(`\\b(?:${unitPattern})\\b`, 'gi'), ' ');
    }
  }

  // Strip leading brand prefix when duplicated inside name so "Pampers Active 34s" & "Active 64s" normalize cleanly
  let coreTitleKey = normalizeAlnumWords(title);
  if (brandKey && !GENERIC_BRAND_KEYS.has(brandKey) && coreTitleKey.startsWith(`${brandKey} `)) {
    coreTitleKey = coreTitleKey.slice(brandKey.length).trim();
  }

  return {
    productId: item.id,
    brandId,
    brandKey,
    categoryId,
    categoryKey,
    coreTitleKey,
    packNumericScore: extractPackNumericScore(`${item.bottleSize || ''} ${item.name || ''}`),
  };
}

function sameCategory(a: StructuredProductIdentity, b: StructuredProductIdentity): boolean {
  if (a.categoryId && b.categoryId) {
    return a.categoryId === b.categoryId;
  }
  if (a.categoryKey && b.categoryKey) {
    return a.categoryKey === b.categoryKey;
  }
  return false;
}

function sameBrand(a: StructuredProductIdentity, b: StructuredProductIdentity): boolean {
  if (a.brandId && b.brandId) {
    return a.brandId === b.brandId;
  }
  if (
    a.brandKey &&
    b.brandKey &&
    !GENERIC_BRAND_KEYS.has(a.brandKey) &&
    !GENERIC_BRAND_KEYS.has(b.brandKey)
  ) {
    return a.brandKey === b.brandKey;
  }
  return false;
}

/**
 * Strict structured variant check: returns true ONLY when two products are the exact
 * same ID OR share structured category + brand + normalized size-stripped core title.
 */
export function areSameProductOrVariant(
  a: SearchableProductItem,
  b: SearchableProductItem
): boolean {
  if (a.id === b.id) return true;

  const idA = getStructuredProductIdentity(a);
  const idB = getStructuredProductIdentity(b);

  if (!idA.coreTitleKey || !idB.coreTitleKey) return false;
  if (!sameCategory(idA, idB)) return false;

  const brandsMatch = sameBrand(idA, idB);
  if (brandsMatch) {
    return idA.coreTitleKey === idB.coreTitleKey;
  }

  // If brand metadata is missing on either record, only match exact identical multi-word core title
  const missingBrand =
    (!idA.brandId && GENERIC_BRAND_KEYS.has(idA.brandKey)) ||
    (!idB.brandId && GENERIC_BRAND_KEYS.has(idB.brandKey));
  if (missingBrand && idA.coreTitleKey.includes(' ') && idA.coreTitleKey.length >= 8) {
    return idA.coreTitleKey === idB.coreTitleKey;
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
}): EligibleCandidatesFilterResult {
  const {
    cartItems,
    cartProductIds,
    catalog,
    dismissedProductIds = [],
    removedProductIds = [],
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
    if (cartCatalogItems.some((cartProd) => areSameProductOrVariant(cartProd, candidate))) {
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

function buildHistoricalPrompt(params: {
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
 * Primary recommendation engine: uses O(1) lookup against the background-maintained
 * completed-sales co-occurrence matrix. Never scans historical sales arrays here.
 */
export function getHistoricalUpsellSuggestion(params: {
  shopId: string;
  cartItems?: CartAssistantItem[];
  cartProductIds?: string[];
  catalog: SearchableProductItem[];
  dismissedProductIds?: string[];
  removedProductIds?: string[];
}): UpsellSuggestion | null {
  try {
    const { shopId, cartItems, cartProductIds, catalog, dismissedProductIds, removedProductIds } =
      params;
    if (!shopId) return null;

    const { normalizedCart, eligibleCandidates, catalogById } = filterEligibleUpsellCandidates({
      cartItems,
      cartProductIds,
      catalog,
      dismissedProductIds,
      removedProductIds,
    });

    if (normalizedCart.length === 0 || eligibleCandidates.length === 0) {
      return null;
    }

    const rankedPairs = getHistoricalCooccurrenceCandidates(shopId, normalizedCart);
    if (rankedPairs.length === 0) {
      return null;
    }

    const eligibleById = new Map<string, SearchableProductItem>();
    for (const c of eligibleCandidates) {
      eligibleById.set(c.id, c);
    }

    let bestSuggestion: UpsellSuggestion | null = null;

    for (const rank of rankedPairs) {
      const candidate = eligibleById.get(rank.productId);
      if (!candidate) continue;

      const availableBaseStock = roundStockQty(Math.max(0, Number(candidate.currentStock) || 0));
      const defaultSaleUnit = getDefaultSaleUnit(candidate);
      const sellableUnits = Math.floor(
        availableBaseStock / Math.max(1, defaultSaleUnit.conversionQty)
      );

      let totalScore = rank.score + Math.min(8, Math.max(1, sellableUnits));

      // Gentle pack alignment when high basket quantities suggest a larger pack
      const candIdentity = getStructuredProductIdentity(candidate);
      if (rank.preferValuePack && candIdentity.packNumericScore >= 2) {
        totalScore += 6;
      }

      if (!bestSuggestion || totalScore > bestSuggestion.score) {
        const triggerProd = catalogById.get(rank.triggerProductId);
        const stockBreakdown = formatStockBreakdown(availableBaseStock, candidate);
        bestSuggestion = {
          product: candidate,
          triggerProductId: rank.triggerProductId,
          romanUrduPrompt: buildHistoricalPrompt({
            candidateName: candidate.name,
            anchorName: triggerProd?.name,
            distinctAnchorMatches: rank.distinctAnchorMatches,
          }),
          stockSummary: stockBreakdown.summaryText,
          ruleId: `history_cooccur_${rank.maxSinglePairCount}x`,
          score: Math.round(totalScore * 100) / 100,
          source: 'history',
        };
      }
    }

    return bestSuggestion;
  } catch {
    return null;
  }
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

  // Prioritize diverse categories with healthy sellable stock
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

  // Round-robin pick across categories first so Gemini sees broad store coverage
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
