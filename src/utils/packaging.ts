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
    description: 'Baby bath, oils, powders, feeding accessories, and skincare',
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
    name: 'Personal Care',
    description: 'Soaps, body washes, deodorants, oral care, and grooming',
  },
  {
    id: 'cat_shampoo_lotion',
    name: 'Shampoo & Lotion',
    description: 'Hair shampoos, conditioners, body lotions, and creams',
  },
  {
    id: 'cat_tissues',
    name: 'Tissue & Paper Products',
    description: 'Facial tissue boxes, pocket packs, toilet rolls, and kitchen towels',
  },
  {
    id: 'cat_hygiene',
    name: 'Hygiene Products',
    description: 'Sanitary pads, adult diapers, sanitizers, cotton buds, and antiseptics',
  },
  {
    id: 'cat_household_cleaning',
    name: 'Household Cleaning',
    description: 'Detergents, dishwashing liquids, floor cleaners, and disinfectants',
  },
  {
    id: 'cat_snacks',
    name: 'Snacks & Confectionery',
    description: 'Biscuits, chips, chocolates, candies, and packaged snacks',
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
    id: 'cat_imported',
    name: 'Imported Products',
    description: 'Imported baby care, toiletries, cosmetics, snacks, and beverages',
  },
  {
    id: 'cat_other',
    name: 'Other Products',
    description: 'General retail, seasonal items, and miscellaneous store goods',
  },
];

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

export function normalizePackagingUnits(
  units: ProductPackagingUnit[] | undefined | null,
  baseUnit: string
): ProductPackagingUnit[] {
  if (!Array.isArray(units)) return [];
  const baseLower = baseUnit.trim().toLowerCase();
  const seen = new Set<string>();
  const cleaned: ProductPackagingUnit[] = [];

  for (const raw of units) {
    const unitName = (raw?.unitName || '').trim().slice(0, 40);
    if (!unitName) continue;
    const lower = unitName.toLowerCase();
    if (lower === baseLower || seen.has(lower)) continue;

    const conversionQty = roundStockQty(Number(raw?.conversionQty) || 0);
    if (conversionQty <= 0) continue;

    seen.add(lower);
    cleaned.push({
      unitName,
      conversionQty,
      allowPurchase: raw?.allowPurchase !== false,
      allowSale: raw?.allowSale !== false,
      purchasePrice: Math.max(0, roundMoney(Number(raw?.purchasePrice) || 0)),
      salePrice: Math.max(0, roundMoney(Number(raw?.salePrice) || 0)),
      wholesalePrice: Math.max(0, roundMoney(Number(raw?.wholesalePrice) || 0)),
      isDefaultPurchase: Boolean(raw?.isDefaultPurchase),
      isDefaultSale: Boolean(raw?.isDefaultSale),
    });
    if (cleaned.length >= 10) break;
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
    out.push({
      unitName,
      conversionQty,
      allowSale: true,
      salePrice: Math.max(0, roundMoney(Number(u.salePrice) || 0)),
      wholesalePrice: Math.max(0, roundMoney(Number(u.wholesalePrice) || 0)),
      isDefaultSale: Boolean(u.isDefaultSale),
    });
    if (out.length >= 10) break;
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
  const totalLabel = `${formatNumber(totalBase)} ${baseUnit}`;

  const rawPkgs = Array.isArray(item.packagingUnits) ? item.packagingUnits : [];
  const multiPkgs = rawPkgs
    .filter((p) => p && p.unitName && Number(p.conversionQty) > 1)
    .sort((a, b) => Number(b.conversionQty) - Number(a.conversionQty));

  if (multiPkgs.length === 0) {
    return {
      totalBase,
      baseUnit,
      fullPackages: 0,
      packageUnit: null,
      packageConversionQty: 1,
      remainderLoose: totalBase,
      summaryText: totalLabel,
      packageBreakdownText: '',
    };
  }

  // Pick the highest conversion package that yields >= 1 full pack, else the primary largest pack
  const matchingPkg =
    multiPkgs.find((p) => totalBase >= Number(p.conversionQty)) || multiPkgs[0];
  const conv = roundStockQty(Number(matchingPkg.conversionQty));
  const fullPackages = Math.floor(totalBase / conv);
  const remainderLoose = roundStockQty(Math.max(0, totalBase - fullPackages * conv));

  let packageBreakdownText = '';
  if (fullPackages > 0 && remainderLoose > 0) {
    packageBreakdownText = `${formatNumber(fullPackages)} ${matchingPkg.unitName} (${formatNumber(conv)}) + ${formatNumber(remainderLoose)} loose`;
  } else if (fullPackages > 0) {
    packageBreakdownText = `${formatNumber(fullPackages)} ${matchingPkg.unitName} (${formatNumber(conv)})`;
  } else if (totalBase > 0) {
    packageBreakdownText = `${formatNumber(totalBase)} loose ${baseUnit} (< 1 ${matchingPkg.unitName})`;
  }

  return {
    totalBase,
    baseUnit,
    fullPackages,
    packageUnit: matchingPkg.unitName,
    packageConversionQty: conv,
    remainderLoose,
    summaryText: packageBreakdownText ? `${totalLabel} · ${packageBreakdownText}` : totalLabel,
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
