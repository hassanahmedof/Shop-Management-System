import { getEffectiveBaseUnit, normalizeCategoryKey, roundStockQty } from '../utils/packaging';
import type { SearchableProductItem } from './productSearchService';

const INDEX_VERSION = 1;
const BACKGROUND_CHUNK_SIZE = 60;

// Generic English structural stopwords & neutral catch-all descriptors (not domain pairings)
const GENERIC_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'etc',
  'general',
  'goods',
  'in',
  'is',
  'item',
  'items',
  'miscellaneous',
  'new',
  'of',
  'on',
  'or',
  'other',
  'pack',
  'packs',
  'product',
  'products',
  'regular',
  'retail',
  'seasonal',
  'size',
  'standard',
  'store',
  'the',
  'to',
  'unit',
  'with',
]);

const GENERIC_BRAND_KEYS = new Set(['', 'unbranded', 'generic', 'other', 'local', 'none', 'n/a']);

const SIZE_MODIFIER_WORDS = new Set([
  'xs',
  'sm',
  'md',
  'lg',
  'xl',
  'xxl',
  'xxxl',
  'mini',
  'small',
  'medium',
  'large',
  'jumbo',
  'mega',
  'economy',
  'value',
  'family',
  'super',
  'big',
  'tiny',
  'regular',
]);

export interface ProductFeatureExtract {
  productId: string;
  fingerprint: string;
  brandId: string;
  brandKey: string;
  hasKnownBrand: boolean;
  categoryId: string;
  categoryKey: string;
  coreTitleKey: string;
  coreTitleTokens: Set<string>;
  variantStrippedTokens: Set<string>;
  rawTermWeights: Map<string, number>;
  unitSalePrice: number;
  packNumericScore: number;
  originType: string;
  storageLocationKey: string;
  isReturnable: boolean;
}

export interface ProductIntelligenceProfile {
  extract: ProductFeatureExtract;
  tfidfVector: Map<string, number>;
}

export interface CatalogIntelligenceIndex {
  version: number;
  shopId: string;
  catalogFingerprint: string;
  productCount: number;
  profilesById: Map<string, ProductIntelligenceProfile>;
  idfByTerm: Map<string, number>;
  categoryAffinities: Map<string, Map<string, number>>;
  categoryProductCounts: Map<string, number>;
  lastRecomputedCount: number;
  lastReusedCount: number;
  updatedAt: number;
}

interface ShopIntelligenceRuntimeState {
  extractsById: Map<string, ProductFeatureExtract>;
  index: CatalogIntelligenceIndex | null;
  buildTimer: ReturnType<typeof setTimeout> | null;
  buildGeneration: number;
}

const runtimeStates = new Map<string, ShopIntelligenceRuntimeState>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeAlnumWords(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Purely linguistic English inflection normalizer (plurals -> singular form)
 * so catalog words like "diapers"/"diaper" and "wipes"/"wipe" align generically.
 */
export function singularizeWord(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (
    token.length > 4 &&
    (token.endsWith('ches') ||
      token.endsWith('shes') ||
      token.endsWith('xes') ||
      token.endsWith('zes'))
  ) {
    return token.slice(0, -2);
  }
  if (
    token.length > 3 &&
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('us') &&
    !token.endsWith('is')
  ) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenizeNormalizedText(raw: string): string[] {
  const cleaned = normalizeAlnumWords(raw);
  if (!cleaned) return [];
  const words = cleaned.split(' ');
  const out: string[] = [];
  for (const w of words) {
    if (!w || w.length < 2) continue;
    if (/^\d+(?:\.\d+)?$/.test(w)) continue;
    if (/^\d+(?:ml|l|ltr|g|gm|kg|mg|pcs?|oz|s)$/.test(w)) continue;
    const norm = singularizeWord(w);
    if (norm.length < 2 || GENERIC_STOPWORDS.has(norm) || GENERIC_STOPWORDS.has(w)) {
      continue;
    }
    out.push(norm);
  }
  return out;
}

function addWeightedTerms(
  target: Map<string, number>,
  tokens: string[],
  weight: number,
  options?: { includeCharTrigrams?: boolean; trigramWeight?: number; prefix?: string }
): void {
  const prefix = options?.prefix || '';
  const includeTrigrams = Boolean(options?.includeCharTrigrams);
  const triWeight = options?.trigramWeight ?? 0.3;

  for (const tok of tokens) {
    const key = prefix ? `${prefix}${tok}` : tok;
    target.set(key, (target.get(key) || 0) + weight);

    if (includeTrigrams && !prefix && tok.length >= 4) {
      for (let i = 0; i <= tok.length - 3; i += 1) {
        const tri = `tri:${tok.slice(i, i + 3)}`;
        target.set(tri, (target.get(tri) || 0) + triWeight);
      }
    }
  }
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

export function stripSizeAndUnitTokensFromTitle(
  item: Pick<
    SearchableProductItem,
    'name' | 'brandName' | 'bottleSize' | 'unit' | 'baseUnit' | 'packagingUnits'
  >
): { coreTitleKey: string; coreTitleTokens: Set<string>; variantStrippedTokens: Set<string> } {
  const brandKey = normalizeAlnumWords(item.brandName || '');
  let title = (item.name || '').toLowerCase();

  if (item.bottleSize && item.bottleSize.trim()) {
    const cleanSize = escapeRegExp(item.bottleSize.trim().toLowerCase()).replace(/\s+/g, '\\s*');
    title = title.replace(new RegExp(`\\b${cleanSize}\\b`, 'gi'), ' ');
  }

  const unitNames = new Set<string>();
  if (item.unit) unitNames.add(item.unit.trim().toLowerCase());
  if (item.baseUnit) unitNames.add(item.baseUnit.trim().toLowerCase());
  if (Array.isArray(item.packagingUnits)) {
    for (const pu of item.packagingUnits) {
      if (pu?.unitName) unitNames.add(pu.unitName.trim().toLowerCase());
    }
  }

  title = title
    .replace(/\bpack\s+of\s+\d+\b/gi, ' ')
    .replace(/\b(?:size|no\.?|stage)\s*\d+\b/gi, ' ')
    .replace(
      /\b\d+(?:\.\d+)?\s*(?:ml|l|ltr|liters?|litres?|g|gm|grams?|kg|kgs?|mg|pcs?|pieces?|s|sheets?|pulls?|tabs?|tablets?|caps?|capsules?|oz)\b/gi,
      ' '
    )
    .replace(
      /\b(?:xl|xxl|xxxl|xs|mini|small|medium|large|jumbo|mega|economy|value|family)\s+(?:pack|size|box|bottle|pouch)\b/gi,
      ' '
    )
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

  let coreTitleKey = normalizeAlnumWords(title);
  if (brandKey && !GENERIC_BRAND_KEYS.has(brandKey) && coreTitleKey.startsWith(`${brandKey} `)) {
    coreTitleKey = coreTitleKey.slice(brandKey.length).trim();
  }

  const coreTokensList = tokenizeNormalizedText(coreTitleKey);
  const coreTitleTokens = new Set(coreTokensList);
  const variantStrippedTokens = new Set(
    coreTokensList.filter((t) => !SIZE_MODIFIER_WORDS.has(t))
  );

  return { coreTitleKey, coreTitleTokens, variantStrippedTokens };
}

export function computeProductFingerprint(item: SearchableProductItem): string {
  const pkgSig = Array.isArray(item.packagingUnits)
    ? item.packagingUnits
        .map((u) => `${u.unitName}:${u.conversionQty}:${u.allowSale}:${u.salePrice}`)
        .join(',')
    : '';
  const kwSig = Array.isArray(item.searchKeywords) ? item.searchKeywords.join(',') : '';
  return [
    item.id,
    item.name || '',
    item.brandId || '',
    item.brandName || '',
    item.categoryId || '',
    item.categoryName || '',
    item.categoryDescription || '',
    item.variant || '',
    kwSig,
    item.bottleSize || '',
    item.originType || '',
    item.storageLocation || '',
    getEffectiveBaseUnit(item),
    item.isReturnable ? item.returnableUnitName || '1' : '0',
    Number(item.salePrice) || 0,
    pkgSig,
  ].join('|');
}

export function extractProductFeatures(
  item: SearchableProductItem,
  fingerprint = computeProductFingerprint(item)
): ProductFeatureExtract {
  const brandId = (item.brandId || '').trim().toLowerCase();
  const brandKey = normalizeAlnumWords(item.brandName || '');
  const hasKnownBrand = Boolean(brandId || (brandKey && !GENERIC_BRAND_KEYS.has(brandKey)));

  const categoryId = (item.categoryId || '').trim().toLowerCase();
  const categoryKey = normalizeCategoryKey(item.categoryName || '');

  const { coreTitleKey, coreTitleTokens, variantStrippedTokens } =
    stripSizeAndUnitTokensFromTitle(item);

  const rawTermWeights = new Map<string, number>();

  // Name & variant/keyword semantic signals
  addWeightedTerms(rawTermWeights, tokenizeNormalizedText(item.name || ''), 1.45, {
    includeCharTrigrams: true,
    trigramWeight: 0.28,
  });
  if (item.variant) {
    addWeightedTerms(rawTermWeights, tokenizeNormalizedText(item.variant), 1.2, {
      includeCharTrigrams: true,
      trigramWeight: 0.22,
    });
  }
  if (Array.isArray(item.searchKeywords) && item.searchKeywords.length > 0) {
    addWeightedTerms(rawTermWeights, tokenizeNormalizedText(item.searchKeywords.join(' ')), 1.25, {
      includeCharTrigrams: true,
      trigramWeight: 0.22,
    });
  }

  // Category name & dynamic Firestore category description (when present)
  if (item.categoryName) {
    addWeightedTerms(rawTermWeights, tokenizeNormalizedText(item.categoryName), 0.9, {
      includeCharTrigrams: true,
      trigramWeight: 0.18,
    });
  }
  if (item.categoryDescription) {
    addWeightedTerms(rawTermWeights, tokenizeNormalizedText(item.categoryDescription), 0.78, {
      includeCharTrigrams: false,
    });
  }

  // Store-context metadata
  if (item.storageLocation) {
    const locTokens = tokenizeNormalizedText(item.storageLocation);
    addWeightedTerms(rawTermWeights, locTokens, 0.55);
    addWeightedTerms(rawTermWeights, locTokens, 0.75, { prefix: 'loc:' });
  }
  if (item.originType) {
    rawTermWeights.set(`origin:${item.originType.toLowerCase()}`, 0.5);
  }
  if (item.isReturnable && item.returnableUnitName) {
    addWeightedTerms(rawTermWeights, tokenizeNormalizedText(item.returnableUnitName), 0.65);
  }

  return {
    productId: item.id,
    fingerprint,
    brandId,
    brandKey,
    hasKnownBrand,
    categoryId,
    categoryKey,
    coreTitleKey,
    coreTitleTokens,
    variantStrippedTokens,
    rawTermWeights,
    unitSalePrice: Math.max(0, roundStockQty(Number(item.salePrice) || 0)),
    packNumericScore: extractPackNumericScore(`${item.bottleSize || ''} ${item.name || ''}`),
    originType: (item.originType || '').trim().toLowerCase(),
    storageLocationKey: normalizeAlnumWords(item.storageLocation || ''),
    isReturnable: Boolean(item.isReturnable),
  };
}

function normalizeL2Vector(vec: Map<string, number>): Map<string, number> {
  let normSq = 0;
  for (const w of vec.values()) {
    normSq += w * w;
  }
  if (normSq <= 0) return new Map();
  const invNorm = 1 / Math.sqrt(normSq);
  const out = new Map<string, number>();
  for (const [k, w] of vec.entries()) {
    out.set(k, w * invNorm);
  }
  return out;
}

export function cosineSimilaritySparse(
  vecA: Map<string, number>,
  vecB: Map<string, number>
): number {
  if (vecA.size === 0 || vecB.size === 0) return 0;
  const [smaller, larger] = vecA.size <= vecB.size ? [vecA, vecB] : [vecB, vecA];
  let dot = 0;
  for (const [term, wA] of smaller.entries()) {
    const wB = larger.get(term);
    if (wB !== undefined) {
      dot += wA * wB;
    }
  }
  return Math.max(0, Math.min(1, dot));
}

function finalizeCatalogIntelligenceIndex(params: {
  shopId: string;
  extracts: ProductFeatureExtract[];
  catalogFingerprint: string;
  recomputedCount: number;
  reusedCount: number;
}): CatalogIntelligenceIndex {
  const { shopId, extracts, catalogFingerprint, recomputedCount, reusedCount } = params;
  const N = Math.max(1, extracts.length);

  // 1) Dynamic corpus-wide IDF
  const docFreq = new Map<string, number>();
  for (const ext of extracts) {
    for (const term of ext.rawTermWeights.keys()) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
  }

  const idfByTerm = new Map<string, number>();
  for (const [term, df] of docFreq.entries()) {
    const idf = Math.log(1 + (N + 1) / (df + 1));
    idfByTerm.set(term, idf);
  }

  // 2) Per-product L2-normalized TF-IDF vectors & brand/category bipartite structures
  const profilesById = new Map<string, ProductIntelligenceProfile>();
  const categoryProductCounts = new Map<string, number>();
  const categoryRawCentroids = new Map<string, Map<string, number>>();
  const brandToCategoryCounts = new Map<string, Map<string, number>>();

  for (const ext of extracts) {
    const weighted = new Map<string, number>();
    for (const [term, tf] of ext.rawTermWeights.entries()) {
      const idf = idfByTerm.get(term) ?? 1;
      weighted.set(term, tf * idf);
    }
    const tfidfVector = normalizeL2Vector(weighted);
    profilesById.set(ext.productId, { extract: ext, tfidfVector });

    if (ext.categoryKey) {
      categoryProductCounts.set(
        ext.categoryKey,
        (categoryProductCounts.get(ext.categoryKey) || 0) + 1
      );

      let catCentroid = categoryRawCentroids.get(ext.categoryKey);
      if (!catCentroid) {
        catCentroid = new Map<string, number>();
        categoryRawCentroids.set(ext.categoryKey, catCentroid);
      }
      for (const [term, val] of tfidfVector.entries()) {
        catCentroid.set(term, (catCentroid.get(term) || 0) + val);
      }

      if (ext.hasKnownBrand) {
        const brandIdentity = ext.brandId || ext.brandKey;
        let catMap = brandToCategoryCounts.get(brandIdentity);
        if (!catMap) {
          catMap = new Map<string, number>();
          brandToCategoryCounts.set(brandIdentity, catMap);
        }
        catMap.set(ext.categoryKey, (catMap.get(ext.categoryKey) || 0) + 1);
      }
    }
  }

  // 3) Normalize category centroids & discover dynamic cross-category affinity graph
  const categoryCentroids = new Map<string, Map<string, number>>();
  for (const [catKey, rawCentroid] of categoryRawCentroids.entries()) {
    categoryCentroids.set(catKey, normalizeL2Vector(rawCentroid));
  }

  const categoryAffinities = new Map<string, Map<string, number>>();
  const addAffinityEdge = (catA: string, catB: string, score: number) => {
    if (!catA || !catB || catA === catB || score <= 0) return;
    let mapA = categoryAffinities.get(catA);
    if (!mapA) {
      mapA = new Map<string, number>();
      categoryAffinities.set(catA, mapA);
    }
    mapA.set(catB, Math.min(1, (mapA.get(catB) || 0) + score));
  };

  // 3a) Multi-category brand bridges discovered directly from shop catalog
  for (const catCounts of brandToCategoryCounts.values()) {
    const bridgedCats = Array.from(catCounts.keys());
    if (bridgedCats.length < 2) continue;
    for (let i = 0; i < bridgedCats.length; i += 1) {
      for (let j = i + 1; j < bridgedCats.length; j += 1) {
        const c1 = bridgedCats[i];
        const c2 = bridgedCats[j];
        const count1 = categoryProductCounts.get(c1) || 1;
        const count2 = categoryProductCounts.get(c2) || 1;
        const sizeBalance = 1 / Math.sqrt(Math.max(1, count1 * count2));
        const bridgeWeight = Math.min(0.65, 0.42 + 0.35 * sizeBalance);
        addAffinityEdge(c1, c2, bridgeWeight);
        addAffinityEdge(c2, c1, bridgeWeight);
      }
    }
  }

  // 3b) Category conceptual semantic overlap (name + description + member product distributions)
  const categoryKeys = Array.from(categoryCentroids.keys());
  for (let i = 0; i < categoryKeys.length; i += 1) {
    const c1 = categoryKeys[i];
    const v1 = categoryCentroids.get(c1)!;
    for (let j = i + 1; j < categoryKeys.length; j += 1) {
      const c2 = categoryKeys[j];
      const v2 = categoryCentroids.get(c2)!;
      const semSim = cosineSimilaritySparse(v1, v2);
      if (semSim >= 0.08) {
        const edgeWeight = Math.min(0.6, semSim * 0.95);
        addAffinityEdge(c1, c2, edgeWeight);
        addAffinityEdge(c2, c1, edgeWeight);
      }
    }
  }

  return {
    version: INDEX_VERSION,
    shopId,
    catalogFingerprint,
    productCount: extracts.length,
    profilesById,
    idfByTerm,
    categoryAffinities,
    categoryProductCounts,
    lastRecomputedCount: recomputedCount,
    lastReusedCount: reusedCount,
    updatedAt: Date.now(),
  };
}

function getOrCreateShopState(shopId: string): ShopIntelligenceRuntimeState {
  let state = runtimeStates.get(shopId);
  if (!state) {
    state = {
      extractsById: new Map(),
      index: null,
      buildTimer: null,
      buildGeneration: 0,
    };
    runtimeStates.set(shopId, state);
  }
  return state;
}

/**
 * Incrementally updates only new/modified products and returns the live semantic
 * index synchronously in sub-millisecond time for immediate POS responsiveness.
 */
export function getOrUpdateCatalogIntelligenceSync(
  shopId: string,
  items: SearchableProductItem[]
): CatalogIntelligenceIndex {
  const effectiveShopId = shopId || 'default_shop';
  const state = getOrCreateShopState(effectiveShopId);

  const fingerprints: Array<{ item: SearchableProductItem; fp: string }> = [];
  const nextIds = new Set<string>();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item?.id) continue;
    nextIds.add(item.id);
    fingerprints.push({ item, fp: computeProductFingerprint(item) });
  }

  const catalogFingerprint = fingerprints.map((f) => f.fp).sort().join('||');
  if (state.index && state.index.catalogFingerprint === catalogFingerprint) {
    return state.index;
  }

  // Prune deleted products
  for (const existingId of Array.from(state.extractsById.keys())) {
    if (!nextIds.has(existingId)) {
      state.extractsById.delete(existingId);
    }
  }

  let recomputedCount = 0;
  let reusedCount = 0;
  const extracts: ProductFeatureExtract[] = [];

  for (const { item, fp } of fingerprints) {
    const existing = state.extractsById.get(item.id);
    if (existing && existing.fingerprint === fp) {
      extracts.push(existing);
      reusedCount += 1;
    } else {
      const fresh = extractProductFeatures(item, fp);
      state.extractsById.set(item.id, fresh);
      extracts.push(fresh);
      recomputedCount += 1;
    }
  }

  const index = finalizeCatalogIntelligenceIndex({
    shopId: effectiveShopId,
    extracts,
    catalogFingerprint,
    recomputedCount,
    reusedCount,
  });
  state.index = index;
  return index;
}

/**
 * Non-blocking chunked background indexer triggered when catalog/categories load or change,
 * keeping Sales Entry & checkout 100% responsive even on very large catalogs.
 */
export function scheduleCatalogIntelligenceBuild(
  shopId: string,
  items: SearchableProductItem[]
): void {
  if (!shopId || !Array.isArray(items) || items.length === 0) return;
  const state = getOrCreateShopState(shopId);

  if (state.buildTimer !== null) {
    clearTimeout(state.buildTimer);
    state.buildTimer = null;
  }
  state.buildGeneration += 1;
  const generation = state.buildGeneration;

  const snapshotItems = [...items];
  let cursor = 0;
  let recomputedCount = 0;
  let reusedCount = 0;
  const pendingExtracts: ProductFeatureExtract[] = [];
  const nextIds = new Set<string>();

  const stepChunk = () => {
    state.buildTimer = null;
    if (state.buildGeneration !== generation) return;

    try {
      const end = Math.min(cursor + BACKGROUND_CHUNK_SIZE, snapshotItems.length);
      for (; cursor < end; cursor += 1) {
        const item = snapshotItems[cursor];
        if (!item?.id) continue;
        nextIds.add(item.id);
        const fp = computeProductFingerprint(item);
        const existing = state.extractsById.get(item.id);
        if (existing && existing.fingerprint === fp) {
          pendingExtracts.push(existing);
          reusedCount += 1;
        } else {
          const fresh = extractProductFeatures(item, fp);
          state.extractsById.set(item.id, fresh);
          pendingExtracts.push(fresh);
          recomputedCount += 1;
        }
      }

      if (cursor < snapshotItems.length) {
        state.buildTimer = setTimeout(stepChunk, 12);
      } else {
        for (const existingId of Array.from(state.extractsById.keys())) {
          if (!nextIds.has(existingId)) {
            state.extractsById.delete(existingId);
          }
        }
        const catalogFingerprint = pendingExtracts
          .map((e) => e.fingerprint)
          .sort()
          .join('||');
        state.index = finalizeCatalogIntelligenceIndex({
          shopId,
          extracts: pendingExtracts,
          catalogFingerprint,
          recomputedCount,
          reusedCount,
        });
      }
    } catch {
      // Background index must never throw into UI event loop
    }
  };

  state.buildTimer = setTimeout(stepChunk, 16);
}

export function resetCatalogIntelligence(shopId?: string): void {
  if (shopId) {
    const existing = runtimeStates.get(shopId);
    if (existing?.buildTimer !== null && existing?.buildTimer !== undefined) {
      clearTimeout(existing.buildTimer);
    }
    runtimeStates.delete(shopId);
    return;
  }
  for (const state of runtimeStates.values()) {
    if (state.buildTimer !== null) {
      clearTimeout(state.buildTimer);
    }
  }
  runtimeStates.clear();
}
