import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import type {
  OriginType,
  Product,
  ProductPackagingUnit,
  StaffCatalogItem,
  StaffPackagingOption,
} from '../types/shop';
import { getEffectiveBaseUnit } from '../utils/packaging';
import { recordPerfMetric, startPerfTimer } from '../utils/perfMonitor';

export interface ProductSearchIndex {
  nameLower: string;
  brandLower: string;
  categoryLower: string;
  combined: string;
  nameWords: string[];
}

export interface SearchableProductItem {
  id: string;
  name: string;
  brandName: string;
  categoryName: string;
  salePrice: number;
  wholesalePrice?: number;
  purchasePrice?: number;
  currentStock: number;
  unit: string;
  baseUnit: string;
  packagingUnits?: Array<ProductPackagingUnit | StaffPackagingOption>;
  originType?: OriginType;
  bottleSize?: string;
  storageLocation?: string;
  isReturnable?: boolean;
  returnableUnitName?: string;
  depositPerReturnable?: number;
  isActive: boolean;
  _searchIdx?: ProductSearchIndex;
}

export interface ProductSearchResult {
  item: SearchableProductItem;
  score: number;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

const WORD_SPLIT_REGEX = /[\s\-_/]+/;

function buildProductSearchIndex(fields: {
  name: string;
  brandName: string;
  categoryName: string;
  originType?: string;
  bottleSize?: string;
  storageLocation?: string;
}): ProductSearchIndex {
  const nameLower = fields.name.toLowerCase();
  const brandLower = fields.brandName.toLowerCase();
  const categoryLower = fields.categoryName.toLowerCase();
  const sizeLower = (fields.bottleSize || '').toLowerCase();
  const locLower = (fields.storageLocation || '').toLowerCase();
  const originLower = (fields.originType || '').toLowerCase();
  return {
    nameLower,
    brandLower,
    categoryLower,
    combined: `${nameLower} ${brandLower} ${categoryLower} ${originLower} ${sizeLower} ${locLower}`,
    nameWords: nameLower.split(WORD_SPLIT_REGEX).filter(Boolean),
  };
}

export function mapProductsToSearchable(products: Product[]): SearchableProductItem[] {
  return products.map((p) => {
    const baseUnit = getEffectiveBaseUnit(p);
    const brandName = p.brandName || '';
    const categoryName = p.categoryName || '';
    const originType = p.originType || '';
    const bottleSize = p.bottleSize || '';
    const storageLocation = p.storageLocation || '';
    return {
      id: p.id,
      name: p.name,
      brandName,
      categoryName,
      salePrice: p.salePrice,
      wholesalePrice: p.wholesalePrice ?? 0,
      purchasePrice: p.purchasePrice,
      currentStock: p.currentStock,
      unit: baseUnit,
      baseUnit,
      packagingUnits: Array.isArray(p.packagingUnits) ? p.packagingUnits : [],
      originType,
      bottleSize,
      storageLocation,
      isReturnable: Boolean(p.isReturnable),
      returnableUnitName: p.returnableUnitName || '',
      depositPerReturnable: p.depositPerReturnable ?? 0,
      isActive: p.isActive !== false,
      _searchIdx: buildProductSearchIndex({
        name: p.name,
        brandName,
        categoryName,
        originType,
        bottleSize,
        storageLocation,
      }),
    };
  });
}

export function mapStaffCatalogToSearchable(catalog: StaffCatalogItem[]): SearchableProductItem[] {
  return catalog.map((c) => {
    const baseUnit = getEffectiveBaseUnit(c);
    const brandName = c.brandName || '';
    const categoryName = c.categoryName || '';
    const originType = c.originType || '';
    const bottleSize = c.bottleSize || '';
    const storageLocation = c.storageLocation || '';
    return {
      id: c.productId,
      name: c.name,
      brandName,
      categoryName,
      salePrice: c.salePrice,
      wholesalePrice: c.wholesalePrice ?? 0,
      currentStock: c.currentStock,
      unit: baseUnit,
      baseUnit,
      packagingUnits: Array.isArray(c.packagingUnits) ? c.packagingUnits : [],
      originType,
      bottleSize,
      storageLocation,
      isReturnable: Boolean(c.isReturnable),
      returnableUnitName: c.returnableUnitName || '',
      depositPerReturnable: c.depositPerReturnable ?? 0,
      isActive: c.isActive !== false,
      _searchIdx: buildProductSearchIndex({
        name: c.name,
        brandName,
        categoryName,
        originType,
        bottleSize,
        storageLocation,
      }),
    };
  });
}

export function normalizeSearchTokens(rawQuery: string): string[] {
  const normalized = rawQuery.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

/**
 * Direct Firestore query helper for large catalogs when caller needs a fresh
 * paginated slice from the database without composite index dependencies.
 */
export async function queryProductsFromDatabase(params: {
  shopId: string;
  role: 'owner' | 'sales_staff';
  authUid?: string;
  maxDocs?: number;
}): Promise<SearchableProductItem[]> {
  const maxDocs = Math.min(Math.max(params.maxDocs ?? 500, 1), 2000);
  if (params.role === 'owner') {
    const q = query(
      collection(db, 'shops', params.shopId, 'products'),
      where('ownerUid', '==', params.shopId),
      limit(maxDocs)
    );
    const snap = await getDocs(q);
    return mapProductsToSearchable(
      snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Product, 'id'>) }))
    );
  }

  if (!params.authUid) return [];
  const q = query(
    collection(db, 'shops', params.shopId, 'staffCatalog'),
    where('allowedStaffUids', 'array-contains', params.authUid),
    limit(maxDocs)
  );
  const snap = await getDocs(q);
  return mapStaffCatalogToSearchable(
    snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StaffCatalogItem, 'id'>) }))
  );
}

export function searchProductsCatalog(
  items: SearchableProductItem[],
  rawQuery: string
): ProductSearchResult[] {
  const tokens = normalizeSearchTokens(rawQuery);
  if (tokens.length === 0) {
    return [];
  }

  const stopTimer = startPerfTimer();
  const normalizedQuery = tokens.join(' ');
  const results: ProductSearchResult[] = [];
  const tokenCount = tokens.length;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item.isActive) continue;

    const idx =
      item._searchIdx ||
      buildProductSearchIndex({
        name: item.name,
        brandName: item.brandName,
        categoryName: item.categoryName,
        originType: item.originType,
        bottleSize: item.bottleSize,
        storageLocation: item.storageLocation,
      });

    const { nameLower, brandLower, categoryLower, combined, nameWords } = idx;

    let allMatched = true;
    let score = 0;

    for (let t = 0; t < tokenCount; t += 1) {
      const token = tokens[t];
      if (!combined.includes(token)) {
        allMatched = false;
        break;
      }

      if (nameLower === token) {
        score += 80;
      } else if (nameLower.startsWith(token)) {
        score += 55;
      } else if (nameLower.includes(token)) {
        let wordStarts = false;
        for (let w = 0; w < nameWords.length; w += 1) {
          if (nameWords[w].startsWith(token)) {
            wordStarts = true;
            break;
          }
        }
        score += wordStarts ? 42 : 28;
      } else if (brandLower.startsWith(token)) {
        score += 20;
      } else if (brandLower.includes(token)) {
        score += 14;
      } else if (categoryLower.startsWith(token)) {
        score += 12;
      } else {
        score += 8;
      }
    }

    if (!allMatched) continue;

    if (nameLower === normalizedQuery) score += 120;
    else if (nameLower.startsWith(normalizedQuery)) score += 70;
    else if (nameLower.includes(normalizedQuery)) score += 35;

    // Slightly favor in-stock products at equal relevance so sellable items rank first
    if (item.currentStock > 0) score += 5;

    results.push({ item, score });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.item.currentStock > 0) !== (a.item.currentStock > 0)) {
      return b.item.currentStock > 0 ? 1 : -1;
    }
    return a.item.name.localeCompare(b.item.name);
  });

  if (items.length >= 25) {
    recordPerfMetric('catalog_search', 'search_products', stopTimer(), {
      catalogSize: items.length,
      matchCount: results.length,
    });
  }

  return results;
}

export function getHighlightSegments(text: string, rawQuery: string): HighlightSegment[] {
  if (!text) return [{ text: '', match: false }];
  const tokens = Array.from(new Set(normalizeSearchTokens(rawQuery))).sort(
    (a, b) => b.length - a.length
  );
  if (tokens.length === 0) return [{ text, match: false }];

  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = text.split(regex);

  return parts
    .filter((p) => p.length > 0)
    .map((part) => {
      const lower = part.toLowerCase();
      return {
        text: part,
        match: tokens.some((t) => t === lower),
      };
    });
}
