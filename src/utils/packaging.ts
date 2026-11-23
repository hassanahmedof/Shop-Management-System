import type { Timestamp } from 'firebase/firestore';
import type {
  BatchAllocation,
  InventoryBatch,
  Product,
  ProductPackagingUnit,
  StaffCatalogItem,
  StaffPackagingOption,
} from '../types/shop';
import { formatNumber, roundMoney } from './formatters';

export const DEFAULT_PRODUCT_CATEGORIES: Array<{
  id: string;
  name: string;
  description: string;
}> = [
  {
    id: 'cat_baby_care',
    name: 'Baby Care',
    description:
      'Baby oils, lotions, shampoos, powders, rash creams, bath products and baby skincare.',
  },
  {
    id: 'cat_diapers',
    name: 'Diapers & Pampers',
    description: 'Disposable diapers, pull-up pants, and newborn diaper packs',
  },
  {
    id: 'cat_wipes',
    name: 'Baby Wipes',
    description: 'Sensitive, unscented, and moisturizing baby wet wipes',
  },
  {
    id: 'cat_personal_care',
    name: 'Personal Care & Toiletries',
    description:
      'Shampoo, conditioners, hair oils, lotions, creams, soaps, body washes, deodorants, toothpaste, toothbrushes, face wash, shaving products and grooming products.',
  },
  {
    id: 'cat_tissues',
    name: 'Tissue & Paper Products',
    description: 'Facial tissue boxes, pocket packs, toilet rolls, and kitchen towels',
  },
  {
    id: 'cat_hygiene',
    name: 'Hygiene & Sanitary',
    description:
      'Sanitary pads, panty liners, adult diapers, hand sanitizers, cotton buds, cotton pads, antiseptics and personal hygiene products.',
  },
  {
    id: 'cat_sexual_wellness',
    name: 'Sexual Wellness',
    description:
      'Condoms, lubricants, personal intimacy gels and other commonly stocked intimate wellness products.',
  },
  {
    id: 'cat_household_cleaning',
    name: 'Household Cleaning',
    description: 'Detergents, dishwashing liquids, floor cleaners, and disinfectants',
  },
  {
    id: 'cat_cold_drinks',
    name: 'Cold Drinks & Beverages',
    description: 'Carbonated soft drinks, energy drinks, cans, and pet bottles',
  },
  {
    id: 'cat_water_juices',
    name: 'Bottled Water & Juices',
    description: 'Mineral water bottles, fruit juices, flavored milk, and tetra packs',
  },
  {
    id: 'cat_snacks',
    name: 'Snacks & Confectionery',
    description: 'Biscuits, chips, chocolates, candies, and packaged snacks',
  },
  {
    id: 'cat_other',
    name: 'Other Products',
    description: 'General retail, seasonal items, and miscellaneous store goods',
  },
];

export const CATEGORY_MERGE_RULES: ReadonlyArray<{
  canonicalId: string;
  canonicalName: string;
  description: string;
  aliases: readonly string[];
  legacyIds?: readonly string[];
}> = [
  {
    canonicalId: 'cat_baby_care',
    canonicalName: 'Baby Care',
    description:
      'Baby oils, lotions, shampoos, powders, rash creams, bath products and baby skincare.',
    aliases: ['baby care', 'baby bath & skincare', 'baby bath and skincare'],
  },
  {
    canonicalId: 'cat_personal_care',
    canonicalName: 'Personal Care & Toiletries',
    description:
      'Shampoo, conditioners, hair oils, lotions, creams, soaps, body washes, deodorants, toothpaste, toothbrushes, face wash, shaving products and grooming products.',
    aliases: [
      'personal care & toiletries',
      'personal care and toiletries',
      'personal care',
      'shampoo & lotion',
      'shampoo and lotion',
    ],
    legacyIds: ['cat_shampoo_lotion'],
  },
  {
    canonicalId: 'cat_hygiene',
    canonicalName: 'Hygiene & Sanitary',
    description:
      'Sanitary pads, panty liners, adult diapers, hand sanitizers, cotton buds, cotton pads, antiseptics and personal hygiene products.',
    aliases: ['hygiene & sanitary', 'hygiene and sanitary', 'hygiene products'],
  },
];

export function normalizeCategoryKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isImportedCategoryName(name: string): boolean {
  return normalizeCategoryKey(name) === 'imported products';
}

export function resolveCanonicalCategoryName(name: string): string {
  const key = normalizeCategoryKey(name);
  for (const rule of CATEGORY_MERGE_RULES) {
    if (rule.aliases.includes(key)) {
      return rule.canonicalName;
    }
  }
  const defMatch = DEFAULT_PRODUCT_CATEGORIES.find((d) => normalizeCategoryKey(d.name) === key);
  return defMatch ? defMatch.name : name.trim().replace(/\s+/g, ' ');
}

const DEFAULT_CATEGORY_ORDER = new Map<string, number>(
  DEFAULT_PRODUCT_CATEGORIES.map((c, idx) => [normalizeCategoryKey(c.name), idx])
);

export function sortCategoriesForDisplay<T extends { id: string; name: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const idxA = DEFAULT_CATEGORY_ORDER.get(normalizeCategoryKey(a.name));
    const idxB = DEFAULT_CATEGORY_ORDER.get(normalizeCategoryKey(b.name));
    if (idxA !== undefined && idxB !== undefined) return idxA - idxB;
    if (idxA !== undefined) return -1;
    if (idxB !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

export const STANDARD_UNITS = [
  'Piece',
  'Packet',
  'Sachet',
  'Bottle',
  'Can',
  'Tube',
  'Jar',
  'Box',
  'Pack',
  'Bundle',
  'Dozen',
  'Strip',
  'Roll',
  'Pair',
  'Set',
  'Carton',
  'Crate',
  'Kilogram',
  'Gram',
  'Litre',
  'Millilitre',
] as const;

export type StandardUnit = (typeof STANDARD_UNITS)[number];

const FRACTIONAL_UNIT_SET = new Set([
  'kilogram',
  'kg',
  'gram',
  'g',
  'litre',
  'l',
  'millilitre',
  'ml',
]);

export const MAX_PACKAGING_LEVELS = 25;

const UNCHANGED_PLURAL_UNITS = new Set([
  'dozen',
  'kilogram',
  'kg',
  'gram',
  'g',
  'litre',
  'l',
  'millilitre',
  'ml',
]);

const CUSTOM_PLURALS: Record<string, string> = {
  box: 'Boxes',
  sachet: 'Sachets',
};

export function pluralizeUnit(unit: string, count: number): string {
  const clean = (unit || 'Piece').trim() || 'Piece';
  if (Math.abs(count) === 1) return clean;
  const lower = clean.toLowerCase();
  if (UNCHANGED_PLURAL_UNITS.has(lower)) return clean;
  if (CUSTOM_PLURALS[lower]) return CUSTOM_PLURALS[lower];
  if (/(?:s|sh|ch|x|z)$/i.test(clean)) return `${clean}es`;
  return `${clean}s`;
}

export function roundStockQty(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 1000) / 1000;
}

export function isFractionalUnit(unit?: string): boolean {
  return FRACTIONAL_UNIT_SET.has((unit || '').trim().toLowerCase());
}

export function getEffectiveBaseUnit(
  item?: { baseUnit?: string; unit?: string } | null
): string {
  const candidate = (item?.baseUnit || item?.unit || 'Piece').trim();
  return candidate || 'Piece';
}

export interface HierarchyLevelInput {
  unitName: string;
  containsQty?: number;
  parentUnitName?: string;
  conversionQty?: number;
}

/**
 * Resolves cumulative conversionQty (smallest stock units per 1 package) across sequential hierarchy links.
 * Safe against cycles or out-of-order entries; falls back cleanly to baseUnit if parent is missing.
 */
export function resolveCumulativeConversion(
  levels: HierarchyLevelInput[],
  baseUnit: string
): Map<string, { conversionQty: number; containsQty: number; parentUnitName: string }> {
  const cleanBase = baseUnit.trim() || 'Piece';
  const baseLower = cleanBase.toLowerCase();
  const byLower = new Map<string, HierarchyLevelInput>();

  for (const lvl of levels) {
    const name = (lvl.unitName || '').trim();
    if (!name || name.toLowerCase() === baseLower) continue;
    if (!byLower.has(name.toLowerCase())) {
      byLower.set(name.toLowerCase(), lvl);
    }
  }

  const memo = new Map<string, number>();
  const resolved = new Map<
    string,
    { conversionQty: number; containsQty: number; parentUnitName: string }
  >();

  const computeBaseFactor = (unitLower: string, visiting: Set<string>): number => {
    if (unitLower === baseLower) return 1;
    if (memo.has(unitLower)) return memo.get(unitLower)!;
    if (visiting.has(unitLower)) return 0; // Cycle guard

    const node = byLower.get(unitLower);
    if (!node) return 0;

    visiting.add(unitLower);
    const contains = roundStockQty(Number(node.containsQty) || 0);
    const parentName = (node.parentUnitName || cleanBase).trim() || cleanBase;
    const parentLower = parentName.toLowerCase();

    let factor = 0;
    if (contains > 0) {
      if (parentLower === baseLower) {
        factor = contains;
      } else {
        const parentFactor = computeBaseFactor(parentLower, visiting);
        factor = parentFactor > 0 ? roundStockQty(contains * parentFactor) : contains;
      }
    } else {
      factor = roundStockQty(Number(node.conversionQty) || 0);
    }

    visiting.delete(unitLower);
    if (factor > 0) memo.set(unitLower, factor);
    return factor;
  };

  for (const lvl of levels) {
    const name = (lvl.unitName || '').trim();
    const lower = name.toLowerCase();
    if (!name || lower === baseLower || resolved.has(lower)) continue;

    const factor = computeBaseFactor(lower, new Set());
    if (factor <= 0) continue;

    const rawContains = roundStockQty(Number(lvl.containsQty) || 0);
    const rawParent = (lvl.parentUnitName || cleanBase).trim() || cleanBase;
    const validParent =
      rawParent.toLowerCase() === baseLower || byLower.has(rawParent.toLowerCase())
        ? rawParent
        : cleanBase;

    resolved.set(lower, {
      conversionQty: factor,
      containsQty: rawContains > 0 ? rawContains : factor,
      parentUnitName: rawContains > 0 ? validParent : cleanBase,
    });
  }

  return resolved;
}

/**
 * Hydrates legacy packaging units (which may only store cumulative conversionQty) into
 * ordered, human-friendly sequential hierarchy rows without altering cumulative conversionQty.
 */
export function hydrateHierarchicalPackaging(
  units: ProductPackagingUnit[] | undefined | null,
  baseUnit: string
): ProductPackagingUnit[] {
  if (!Array.isArray(units) || units.length === 0) return [];
  const cleanBase = baseUnit.trim() || 'Piece';

  const valid = units
    .filter((u) => u && (u.unitName || '').trim() && Number(u.conversionQty) > 0)
    .map((u) => ({ ...u }))
    .sort((a, b) => Number(a.conversionQty) - Number(b.conversionQty));

  const out: ProductPackagingUnit[] = [];
  for (let i = 0; i < valid.length; i += 1) {
    const u = valid[i];
    const conv = roundStockQty(Number(u.conversionQty) || 0);
    let containsQty = roundStockQty(Number(u.containsQty) || 0);
    let parentUnitName = (u.parentUnitName || '').trim();

    if (!(containsQty > 0 && parentUnitName)) {
      // Infer clean parent relationship from smaller levels if exact integer ratio (> 1)
      let inferredParent = cleanBase;
      let inferredContains = conv;
      for (let j = out.length - 1; j >= 0; j -= 1) {
        const smaller = out[j];
        if (smaller.conversionQty > 1 && conv > smaller.conversionQty) {
          const ratio = conv / smaller.conversionQty;
          if (Math.abs(ratio - Math.round(ratio)) < 0.0005 && Math.round(ratio) > 1) {
            inferredParent = smaller.unitName;
            inferredContains = Math.round(ratio);
            break;
          }
        }
      }
      containsQty = inferredContains;
      parentUnitName = inferredParent;
    }

    out.push({
      ...u,
      conversionQty: conv,
      containsQty,
      parentUnitName,
    });
  }

  return out;
}

export function normalizePackagingUnits(
  units: ProductPackagingUnit[] | undefined | null,
  baseUnit: string
): ProductPackagingUnit[] {
  if (!Array.isArray(units)) return [];
  const cleanBase = baseUnit.trim() || 'Piece';
  const baseLower = cleanBase.toLowerCase();
  const seen = new Set<string>();
  const hierarchyResolved = resolveCumulativeConversion(units, cleanBase);
  const cleaned: ProductPackagingUnit[] = [];

  for (const raw of units) {
    const unitName = (raw?.unitName || '').trim().slice(0, 40);
    if (!unitName) continue;
    const lower = unitName.toLowerCase();
    if (lower === baseLower || seen.has(lower)) continue;

    const resolvedInfo = hierarchyResolved.get(lower);
    const conversionQty = resolvedInfo
      ? resolvedInfo.conversionQty
      : roundStockQty(Number(raw?.conversionQty) || 0);
    if (conversionQty <= 0) continue;

    seen.add(lower);
    const entry: ProductPackagingUnit = {
      unitName,
      conversionQty,
      allowPurchase: raw?.allowPurchase !== false,
      allowSale: raw?.allowSale !== false,
      purchasePrice: Math.max(0, roundMoney(Number(raw?.purchasePrice) || 0)),
      salePrice: Math.max(0, roundMoney(Number(raw?.salePrice) || 0)),
      wholesalePrice: Math.max(0, roundMoney(Number(raw?.wholesalePrice) || 0)),
      isDefaultPurchase: Boolean(raw?.isDefaultPurchase),
      isDefaultSale: Boolean(raw?.isDefaultSale),
    };

    const containsQty = resolvedInfo?.containsQty ?? roundStockQty(Number(raw?.containsQty) || 0);
    const parentName = (resolvedInfo?.parentUnitName || raw?.parentUnitName || cleanBase).trim();
    if (containsQty > 0) {
      entry.containsQty = containsQty;
      entry.parentUnitName = parentName.slice(0, 40);
    }

    cleaned.push(entry);
    if (cleaned.length >= MAX_PACKAGING_LEVELS) break;
  }

  return cleaned;
}

export function toStaffPackagingUnits(
  units: ProductPackagingUnit[] | undefined | null,
  baseUnit?: string
): StaffPackagingOption[] {
  if (!Array.isArray(units)) return [];
  const baseLower = (baseUnit || '').trim().toLowerCase();
  const seen = new Set<string>();
  const out: StaffPackagingOption[] = [];

  for (const u of units) {
    const unitName = (u?.unitName || '').trim().slice(0, 40);
    if (!unitName) continue;
    const lower = unitName.toLowerCase();
    if ((baseLower && lower === baseLower) || seen.has(lower)) continue;
    const conversionQty = roundStockQty(Number(u?.conversionQty) || 0);
    if (conversionQty <= 0 || u?.allowSale === false) continue;

    seen.add(lower);
    const opt: StaffPackagingOption = {
      unitName,
      conversionQty,
      allowSale: true,
      salePrice: Math.max(0, roundMoney(Number(u.salePrice) || 0)),
      wholesalePrice: Math.max(0, roundMoney(Number(u.wholesalePrice) || 0)),
      isDefaultSale: Boolean(u.isDefaultSale),
    };
    const containsQty = roundStockQty(Number(u.containsQty) || 0);
    if (containsQty > 0 && u.parentUnitName) {
      opt.containsQty = containsQty;
      opt.parentUnitName = u.parentUnitName.trim().slice(0, 40);
    }
    out.push(opt);
    if (out.length >= MAX_PACKAGING_LEVELS) break;
  }

  return out;
}

export interface SelectableSaleUnit {
  unitName: string;
  conversionQty: number;
  salePrice: number;
  wholesalePrice: number;
  purchasePrice?: number;
  isBase: boolean;
  isDefaultSale: boolean;
}

export function getAllowedSaleUnits(
  item: Pick<
    Product | StaffCatalogItem,
    'unit' | 'baseUnit' | 'salePrice' | 'packagingUnits'
  > & {
    wholesalePrice?: number;
    purchasePrice?: number;
  }
): SelectableSaleUnit[] {
  const baseUnit = getEffectiveBaseUnit(item);
  const baseLower = baseUnit.toLowerCase();
  const baseOption: SelectableSaleUnit = {
    unitName: baseUnit,
    conversionQty: 1,
    salePrice: Math.max(0, roundMoney(Number(item.salePrice) || 0)),
    wholesalePrice: Math.max(0, roundMoney(Number(item.wholesalePrice) || 0)),
    purchasePrice:
      typeof item.purchasePrice === 'number'
        ? Math.max(0, roundMoney(item.purchasePrice))
        : undefined,
    isBase: true,
    isDefaultSale: true,
  };

  const options: SelectableSaleUnit[] = [baseOption];
  const rawList = Array.isArray(item.packagingUnits) ? item.packagingUnits : [];

  for (const pkg of rawList) {
    const unitName = (pkg?.unitName || '').trim();
    const conv = roundStockQty(Number(pkg?.conversionQty) || 0);
    if (!unitName || conv <= 0 || pkg?.allowSale === false) continue;
    if (unitName.toLowerCase() === baseLower) continue;

    if (pkg.isDefaultSale) {
      baseOption.isDefaultSale = false;
    }

    options.push({
      unitName,
      conversionQty: conv,
      salePrice: Math.max(0, roundMoney(Number(pkg.salePrice) || 0)),
      wholesalePrice: Math.max(0, roundMoney(Number(pkg.wholesalePrice) || 0)),
      purchasePrice:
        'purchasePrice' in pkg && typeof pkg.purchasePrice === 'number'
          ? Math.max(0, roundMoney(pkg.purchasePrice))
          : undefined,
      isBase: false,
      isDefaultSale: Boolean(pkg.isDefaultSale),
    });
  }

  return options;
}

export interface SelectablePurchaseUnit {
  unitName: string;
  conversionQty: number;
  purchasePrice: number;
  isBase: boolean;
  isDefaultPurchase: boolean;
}

export function getAllowedPurchaseUnits(
  product: Pick<Product, 'unit' | 'baseUnit' | 'purchasePrice' | 'packagingUnits'>
): SelectablePurchaseUnit[] {
  const baseUnit = getEffectiveBaseUnit(product);
  const baseLower = baseUnit.toLowerCase();
  const baseOption: SelectablePurchaseUnit = {
    unitName: baseUnit,
    conversionQty: 1,
    purchasePrice: Math.max(0, roundMoney(Number(product.purchasePrice) || 0)),
    isBase: true,
    isDefaultPurchase: true,
  };

  const options: SelectablePurchaseUnit[] = [baseOption];
  const rawList = Array.isArray(product.packagingUnits) ? product.packagingUnits : [];

  for (const pkg of rawList) {
    const unitName = (pkg?.unitName || '').trim();
    const conv = roundStockQty(Number(pkg?.conversionQty) || 0);
    if (!unitName || conv <= 0 || pkg?.allowPurchase === false) continue;
    if (unitName.toLowerCase() === baseLower) continue;

    if (pkg.isDefaultPurchase) {
      baseOption.isDefaultPurchase = false;
    }

    options.push({
      unitName,
      conversionQty: conv,
      purchasePrice: Math.max(0, roundMoney(Number(pkg.purchasePrice) || 0)),
      isBase: false,
      isDefaultPurchase: Boolean(pkg.isDefaultPurchase),
    });
  }

  return options;
}

export function getDefaultSaleUnit(
  item: Parameters<typeof getAllowedSaleUnits>[0]
): SelectableSaleUnit {
  const allowed = getAllowedSaleUnits(item);
  return allowed.find((u) => u.isDefaultSale) || allowed[0];
}

export function getDefaultPurchaseUnit(
  product: Parameters<typeof getAllowedPurchaseUnits>[0]
): SelectablePurchaseUnit {
  const allowed = getAllowedPurchaseUnits(product);
  const preferredPkg = allowed.find((u) => u.isDefaultPurchase);
  if (preferredPkg) return preferredPkg;
  return allowed[0];
}

export interface StockBreakdown {
  totalBase: number;
  baseUnit: string;
  totalLabel: string;
  fullPackages: number;
  packageUnit: string | null;
  packageConversionQty: number;
  remainderLoose: number;
  summaryText: string;
  packageBreakdownText: string;
}

export function formatStockBreakdown(
  currentStock: number,
  item: {
    unit?: string;
    baseUnit?: string;
    packagingUnits?: Array<{ unitName: string; conversionQty: number }>;
  }
): StockBreakdown {
  const totalBase = roundStockQty(Math.max(0, Number(currentStock) || 0));
  const baseUnit = getEffectiveBaseUnit(item);
  const totalLabel = `${formatNumber(totalBase)} ${pluralizeUnit(baseUnit, totalBase)}`;

  const rawPkgs = Array.isArray(item.packagingUnits) ? item.packagingUnits : [];
  const multiPkgs = rawPkgs
    .filter((p) => p && p.unitName && Number(p.conversionQty) > 1)
    .sort((a, b) => Number(b.conversionQty) - Number(a.conversionQty));

  if (multiPkgs.length === 0) {
    return {
      totalBase,
      baseUnit,
      totalLabel,
      fullPackages: 0,
      packageUnit: null,
      packageConversionQty: 1,
      remainderLoose: totalBase,
      summaryText: totalLabel,
      packageBreakdownText: '',
    };
  }

  // Primary matching package (highest level that fits at least once, else smallest package > 1)
  const primaryPkg =
    multiPkgs.find((p) => totalBase >= Number(p.conversionQty)) || multiPkgs[multiPkgs.length - 1];
  const primaryConv = roundStockQty(Number(primaryPkg.conversionQty));
  const fullPackages = Math.floor(totalBase / primaryConv);
  const primaryRemainder = roundStockQty(Math.max(0, totalBase - fullPackages * primaryConv));

  // Greedy multi-level breakdown across configured hierarchy
  let rem = totalBase;
  const fullParts: string[] = [];
  for (const pkg of multiPkgs) {
    const conv = roundStockQty(Number(pkg.conversionQty));
    if (conv <= 1) continue;
    const count = Math.floor((rem + 1e-9) / conv);
    if (count > 0) {
      fullParts.push(`${formatNumber(count)} Full ${pluralizeUnit(pkg.unitName, count)}`);
      rem = roundStockQty(Math.max(0, rem - count * conv));
    }
  }

  let packageBreakdownText = '';
  if (fullParts.length > 0 && rem > 0) {
    packageBreakdownText = `${fullParts.join(', ')} + ${formatNumber(rem)} ${pluralizeUnit(baseUnit, rem)}`;
  } else if (fullParts.length > 0) {
    packageBreakdownText = fullParts.join(', ');
  } else if (totalBase > 0) {
    const smallestPkg = multiPkgs[multiPkgs.length - 1];
    packageBreakdownText = `${formatNumber(totalBase)} loose (< 1 ${smallestPkg.unitName})`;
  }

  return {
    totalBase,
    baseUnit,
    totalLabel,
    fullPackages,
    packageUnit: primaryPkg.unitName,
    packageConversionQty: primaryConv,
    remainderLoose: primaryRemainder,
    summaryText: packageBreakdownText ? `${totalLabel} (${packageBreakdownText})` : totalLabel,
    packageBreakdownText,
  };
}

function tsMillis(ts?: Timestamp): number {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return 0;
}

export interface FifoBatchMutation {
  batchId: string;
  nextRemainingBaseQty: number;
  nextStatus: 'active' | 'exhausted';
}

export interface FifoAllocationResult {
  totalCost: number;
  weightedBaseUnitCost: number;
  allocations: BatchAllocation[];
  updatedBatches: FifoBatchMutation[];
}

/**
 * Allocates `baseQtyNeeded` across active batches in FIFO order (oldest purchaseDate, then createdAt).
 * Any unbatched legacy stock gap falls back cleanly to `fallbackBaseCost`.
 */
export function allocateFifoFromBatches(
  batches: InventoryBatch[],
  baseQtyNeeded: number,
  fallbackBaseCost: number
): FifoAllocationResult {
  const needed = roundStockQty(Math.max(0, Number(baseQtyNeeded) || 0));
  const safeFallback = Math.max(0, roundMoney(Number(fallbackBaseCost) || 0));
  if (needed <= 0) {
    return {
      totalCost: 0,
      weightedBaseUnitCost: safeFallback,
      allocations: [],
      updatedBatches: [],
    };
  }

  const ordered = batches
    .filter((b) => b.status === 'active' && roundStockQty(b.remainingBaseQty) > 0)
    .sort((a, b) => {
      const dateCmp = (a.purchaseDate || '').localeCompare(b.purchaseDate || '');
      if (dateCmp !== 0) return dateCmp;
      return tsMillis(a.createdAt) - tsMillis(b.createdAt);
    });

  let remainingToConsume = needed;
  let totalCost = 0;
  const allocations: BatchAllocation[] = [];
  const updatedBatches: FifoBatchMutation[] = [];

  for (const batch of ordered) {
    if (remainingToConsume <= 0) break;
    const avail = roundStockQty(batch.remainingBaseQty);
    if (avail <= 0) continue;

    const take = roundStockQty(Math.min(avail, remainingToConsume));
    const unitCost = Math.max(0, roundMoney(batch.unitCostInBase));
    const costSlice = roundMoney(take * unitCost);

    totalCost = roundMoney(totalCost + costSlice);
    remainingToConsume = roundStockQty(remainingToConsume - take);

    const nextRem = roundStockQty(Math.max(0, avail - take));
    batch.remainingBaseQty = nextRem;
    batch.status = nextRem <= 0 ? 'exhausted' : 'active';

    allocations.push({
      batchId: batch.id,
      consumedBaseQty: take,
      unitCostInBase: unitCost,
    });
    updatedBatches.push({
      batchId: batch.id,
      nextRemainingBaseQty: nextRem,
      nextStatus: nextRem <= 0 ? 'exhausted' : 'active',
    });
  }

  // Legacy unbatched stock or stock-override shortfall uses current base cost
  if (remainingToConsume > 0) {
    totalCost = roundMoney(totalCost + remainingToConsume * safeFallback);
  }

  const weightedBaseUnitCost = needed > 0 ? roundMoney(totalCost / needed) : safeFallback;

  return {
    totalCost,
    weightedBaseUnitCost,
    allocations,
    updatedBatches,
  };
}
