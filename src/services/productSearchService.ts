import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import type { Product, StaffCatalogItem } from '../types/shop';

export interface SearchableProductItem {
  id: string;
  name: string;
  brandName: string;
  categoryName: string;
  salePrice: number;
  purchasePrice?: number;
  currentStock: number;
  unit: string;
  isActive: boolean;
}

export interface ProductSearchResult {
  item: SearchableProductItem;
  score: number;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export function mapProductsToSearchable(products: Product[]): SearchableProductItem[] {
  return products.map((p) => ({
    id: p.id,
    name: p.name,
    brandName: p.brandName || '',
    categoryName: p.categoryName || '',
    salePrice: p.salePrice,
    purchasePrice: p.purchasePrice,
    currentStock: p.currentStock,
    unit: p.unit || 'Unit',
    isActive: p.isActive !== false,
  }));
}

export function mapStaffCatalogToSearchable(catalog: StaffCatalogItem[]): SearchableProductItem[] {
  return catalog.map((c) => ({
    id: c.productId,
    name: c.name,
    brandName: c.brandName || '',
    categoryName: c.categoryName || '',
    salePrice: c.salePrice,
    currentStock: c.currentStock,
    unit: c.unit || 'Unit',
    isActive: c.isActive !== false,
  }));
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
  const normalizedQuery = tokens.join(' ');
  const activeItems = items.filter((item) => item.isActive);

  if (tokens.length === 0) {
    return [];
  }

  const results: ProductSearchResult[] = [];

  for (const item of activeItems) {
    const nameLower = item.name.toLowerCase();
    const brandLower = item.brandName.toLowerCase();
    const categoryLower = item.categoryName.toLowerCase();
    const combined = `${nameLower} ${brandLower} ${categoryLower}`;

    let allMatched = true;
    let score = 0;

    for (const token of tokens) {
      if (!combined.includes(token)) {
        allMatched = false;
        break;
      }

      if (nameLower === token) {
        score += 80;
      } else if (nameLower.startsWith(token)) {
        score += 55;
      } else if (nameLower.split(/[\s\-_/]+/).some((word) => word.startsWith(token))) {
        score += 42;
      } else if (nameLower.includes(token)) {
        score += 28;
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
