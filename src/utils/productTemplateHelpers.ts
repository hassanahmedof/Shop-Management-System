import type {
  Brand,
  Category,
  OriginType,
  ProductTemplate,
  ProductTemplatePackaging,
} from '../types/shop';
import { DEFAULT_PRODUCT_BRANDS, normalizeBrandKey } from './brands';
import { DEFAULT_PRODUCT_CATEGORIES, normalizeCategoryKey } from './packaging';
import { recordPerfMetric, startPerfTimer } from './perfMonitor';

export interface DefaultProductTemplateDef {
  id: string;
  name: string;
  categoryId: string;
  brandId: string;
  variant: string;
  originType?: OriginType;
  baseUnit: string;
  defaultPurchaseUnit?: string;
  defaultSaleUnit?: string;
  packagingUnits?: ProductTemplatePackaging[];
  hasUnconfirmedPackaging?: boolean;
  suggestedPurchasePrice?: number;
  suggestedSalePrice?: number;
  suggestedWholesalePrice?: number;
  priceSource?: string;
  priceUpdatedAt?: string;
  trackExpiry?: boolean;
  bottleSize?: string;
  storageLocation?: string;
  isReturnable?: boolean;
  returnableUnitName?: string;
  searchKeywords?: string[];
}

export function normalizeTemplateKey(
  categoryId: string,
  brandId: string,
  name: string,
  variant = ''
): string {
  const clean = (val: string) =>
    val
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  return `${clean(categoryId)}::${clean(brandId)}::${clean(name)}::${clean(variant)}`;
}

export function resolveTemplateCategoryAndBrand(
  def: Pick<DefaultProductTemplateDef, 'categoryId' | 'brandId'>,
  liveCategories: Category[],
  liveBrands: Brand[]
): {
  categoryId: string;
  categoryName: string;
  brandId: string;
  brandName: string;
} {
  const defCatById = new Map(DEFAULT_PRODUCT_CATEGORIES.map((c) => [c.id, c.name]));
  const defBrandById = new Map(DEFAULT_PRODUCT_BRANDS.map((b) => [b.id, b.name]));

  const liveCatById = new Map(liveCategories.map((c) => [c.id, c]));
  const liveCatByKey = new Map(
    liveCategories.map((c) => [normalizeCategoryKey(c.name), c])
  );

  const canonicalCatName = defCatById.get(def.categoryId) || 'Other Products';
  const matchedCat =
    liveCatById.get(def.categoryId) ||
    liveCatByKey.get(normalizeCategoryKey(canonicalCatName));

  const liveBrandById = new Map(liveBrands.map((b) => [b.id, b]));
  const liveBrandByKey = new Map(
    liveBrands.map((b) => [normalizeBrandKey(b.name), b])
  );

  const canonicalBrandName = defBrandById.get(def.brandId) || 'Generic';
  const matchedBrand =
    liveBrandById.get(def.brandId) ||
    liveBrandByKey.get(normalizeBrandKey(canonicalBrandName));

  return {
    categoryId: matchedCat?.id || def.categoryId,
    categoryName: matchedCat?.name || canonicalCatName,
    brandId: matchedBrand?.id || def.brandId,
    brandName: matchedBrand?.name || canonicalBrandName,
  };
}

export interface IndexedTemplateEntry {
  tpl: ProductTemplate;
  nameLower: string;
  variantLower: string;
  brandLower: string;
  catLower: string;
  combined: string;
}

export interface TemplateSearchIndex {
  all: IndexedTemplateEntry[];
  active: IndexedTemplateEntry[];
  byCategoryActive: Map<string, IndexedTemplateEntry[]>;
  byBrandActive: Map<string, IndexedTemplateEntry[]>;
  byCategoryBrandActive: Map<string, IndexedTemplateEntry[]>;
}

function toIndexedTemplateEntry(tpl: ProductTemplate): IndexedTemplateEntry {
  const nameLower = tpl.name.toLowerCase();
  const variantLower = (tpl.variant || '').toLowerCase();
  const brandLower = (tpl.brandName || '').toLowerCase();
  const catLower = (tpl.categoryName || '').toLowerCase();
  const bottleLower = (tpl.bottleSize || '').toLowerCase();
  const keywordsLower = tpl.searchKeywords?.length
    ? tpl.searchKeywords.join(' ').toLowerCase()
    : '';
  return {
    tpl,
    nameLower,
    variantLower,
    brandLower,
    catLower,
    combined: `${nameLower} ${variantLower} ${brandLower} ${catLower} ${bottleLower} ${keywordsLower}`,
  };
}

export function createTemplateSearchIndex(templates: ProductTemplate[]): TemplateSearchIndex {
  const sorted = [...templates].sort((a, b) => a.name.localeCompare(b.name));
  const all: IndexedTemplateEntry[] = [];
  const active: IndexedTemplateEntry[] = [];
  const byCategoryActive = new Map<string, IndexedTemplateEntry[]>();
  const byBrandActive = new Map<string, IndexedTemplateEntry[]>();
  const byCategoryBrandActive = new Map<string, IndexedTemplateEntry[]>();

  for (let i = 0; i < sorted.length; i += 1) {
    const entry = toIndexedTemplateEntry(sorted[i]);
    all.push(entry);
    if (!entry.tpl.isActive) continue;

    active.push(entry);

    if (entry.tpl.categoryId) {
      const catArr = byCategoryActive.get(entry.tpl.categoryId);
      if (catArr) catArr.push(entry);
      else byCategoryActive.set(entry.tpl.categoryId, [entry]);
    }

    if (entry.tpl.brandId) {
      const brandArr = byBrandActive.get(entry.tpl.brandId);
      if (brandArr) brandArr.push(entry);
      else byBrandActive.set(entry.tpl.brandId, [entry]);
    }

    if (entry.tpl.categoryId && entry.tpl.brandId) {
      const cbKey = `${entry.tpl.categoryId}::${entry.tpl.brandId}`;
      const cbArr = byCategoryBrandActive.get(cbKey);
      if (cbArr) cbArr.push(entry);
      else byCategoryBrandActive.set(cbKey, [entry]);
    }
  }

  return {
    all,
    active,
    byCategoryActive,
    byBrandActive,
    byCategoryBrandActive,
  };
}

export function queryTemplateIndex(
  index: TemplateSearchIndex,
  params: {
    categoryId?: string;
    brandId?: string;
    query?: string;
    includeInactive?: boolean;
  }
): ProductTemplate[] {
  const stopTimer = params.query?.trim() ? startPerfTimer() : null;
  const tokens = (params.query || '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let pool: IndexedTemplateEntry[];
  if (!params.includeInactive) {
    if (params.categoryId && params.brandId) {
      pool = index.byCategoryBrandActive.get(`${params.categoryId}::${params.brandId}`) || [];
    } else if (params.categoryId) {
      pool = index.byCategoryActive.get(params.categoryId) || [];
    } else if (params.brandId) {
      pool = index.byBrandActive.get(params.brandId) || [];
    } else {
      pool = index.active;
    }
  } else {
    pool = index.all.filter((e) => {
      if (params.categoryId && e.tpl.categoryId !== params.categoryId) return false;
      if (params.brandId && e.tpl.brandId !== params.brandId) return false;
      return true;
    });
  }

  if (tokens.length === 0) {
    const direct = pool.map((e) => e.tpl);
    if (stopTimer) {
      recordPerfMetric('catalog_search', 'search_templates', stopTimer(), {
        templateCount: index.all.length,
        matchCount: direct.length,
      });
    }
    return direct;
  }

  const scored: Array<{ tpl: ProductTemplate; score: number }> = [];
  for (let i = 0; i < pool.length; i += 1) {
    const entry = pool[i];
    let matchedAll = true;
    let score = 0;

    for (let t = 0; t < tokens.length; t += 1) {
      const token = tokens[t];
      if (!entry.combined.includes(token)) {
        matchedAll = false;
        break;
      }
      if (entry.nameLower.startsWith(token)) score += 60;
      else if (entry.nameLower.includes(token)) score += 35;
      else if (entry.variantLower.includes(token)) score += 25;
      else if (entry.brandLower.includes(token)) score += 20;
      else score += 10;
    }

    if (matchedAll) {
      scored.push({ tpl: entry.tpl, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.tpl.name.localeCompare(b.tpl.name);
  });

  const ranked = scored.map((s) => s.tpl);
  if (stopTimer) {
    recordPerfMetric('catalog_search', 'search_templates', stopTimer(), {
      templateCount: index.all.length,
      matchCount: ranked.length,
    });
  }
  return ranked;
}

export function filterAndRankTemplates(
  templates: ProductTemplate[],
  params: {
    categoryId?: string;
    brandId?: string;
    query?: string;
    includeInactive?: boolean;
  }
): ProductTemplate[] {
  const index = createTemplateSearchIndex(templates);
  return queryTemplateIndex(index, params);
}

const CATEGORY_KEYWORD_HINTS: Array<{ catId: string; keywords: string[] }> = [
  { catId: 'cat_sexual_wellness', keywords: ['condom', 'lubricant', 'lube', 'lubricating gel', 'intimacy gel', 'intimate gel', 'massage gel', 'delay spray', 'durex', 'sathi', 'saathi', 'ky jelly', 'k-y'] },
  { catId: 'cat_diapers', keywords: ['diaper', 'pampers', 'molfix', 'canbebe', 'mamypoko', 'pants', 'newborn', 'maxi', 'midi', 'jumbo'] },
  { catId: 'cat_wipes', keywords: ['wipe', 'wipes', 'wet wipe'] },
  { catId: 'cat_baby_care', keywords: ['cerelac', 'lactogen', 'lactogrow', 'nan optipro', 'morinaga', 'similac', 'pediasure', 'aptamil', 'enfagrow', 'formula', 'baby cereal', 'baby lotion', 'baby oil', 'baby powder', 'baby shampoo', 'rash cream', 'baby soap', 'baby bath', 'cologne', 'feeding bottle'] },
  { catId: 'cat_tissues', keywords: ['tissue', 'facial', 'toilet roll', 'kitchen roll', 'napkin', 'paper towel', 'zzoop', 'rose petal'] },
  { catId: 'cat_hygiene', keywords: ['sanitary', 'pad', 'liner', 'adult diaper', 'tena', 'butterfly', 'whisper', 'kotex', 'sanitizer', 'antiseptic', 'cotton bud', 'handwash'] },
  { catId: 'cat_personal_care', keywords: ['lip balm', 'lip therapy', 'lip mask', 'cold cream', 'hand cream', 'foot cream', 'petroleum jelly', 'glycerin', 'moisturizer', 'shampoo', 'conditioner', 'hair oil', 'soap', 'body wash', 'shower gel', 'lotion', 'cream', 'face wash', 'toothpaste', 'toothbrush', 'mouthwash', 'deodorant', 'body spray', 'razor'] },
  { catId: 'cat_household_cleaning', keywords: ['detergent', 'washing powder', 'dishwash', 'bleach', 'phenyl', 'toilet cleaner', 'glass cleaner', 'insect', 'surf', 'ariel', 'harpic', 'domex', 'vim', 'scrubber', 'fabric softener'] },
  { catId: 'cat_cold_drinks', keywords: ['cola', 'soda', 'pepsi', 'sprite', '7up', 'dew', 'sting', 'pakola', 'energy', 'malt', 'barbican', 'tea', 'coffee', 'danedar', 'tapal', 'lipton', 'brooke bond', 'vital tea', 'nescafe', 'everyday', 'can', 'fizz', 'syrup', 'rooh afza', 'jam-e-shirin'] },
  { catId: 'cat_water_juices', keywords: ['water', 'juice', 'nectar', 'fruita vitals', 'nesfruta', 'milk', 'milkpak', 'olpers', 'tarang', 'tetra', 'pure life', 'aquafina', 'tang', 'lani', 'rani'] },
  { catId: 'cat_snacks', keywords: ['chips', 'biscuit', 'cookie', 'chocolate', 'candy', 'toffee', 'wafer', 'noodle', 'indomie', 'maggi', 'knorr', 'snack', 'crisp', 'nutella', 'cupcake'] },
  { catId: 'cat_other', keywords: ['cooking oil', 'banaspati', 'ghee', 'masala', 'spices', 'salt', 'pickle', 'ketchup', 'jam', 'mayonnaise', 'butter', 'margarine', 'rice', 'basmati', 'nuggets', 'custard', 'kheer', 'battery'] },
];

export function suggestCategoryAndBrandFromName(
  productName: string,
  categories: Category[],
  brands: Brand[]
): { categoryId?: string; brandId?: string } {
  const lower = productName.toLowerCase().trim();
  if (!lower) return {};

  let suggestedBrandId: string | undefined;
  let longestBrandLen = 0;
  for (const b of brands) {
    if (b.isActive === false) continue;
    const bLower = b.name.toLowerCase().trim();
    if (bLower.length >= 2 && lower.includes(bLower) && bLower.length > longestBrandLen) {
      suggestedBrandId = b.id;
      longestBrandLen = bLower.length;
    }
  }

  let suggestedCategoryId: string | undefined;
  for (const hint of CATEGORY_KEYWORD_HINTS) {
    if (hint.keywords.some((kw) => lower.includes(kw))) {
      const defName = DEFAULT_PRODUCT_CATEGORIES.find((c) => c.id === hint.catId)?.name || '';
      const matched = categories.find(
        (c) =>
          c.id === hint.catId ||
          (defName && normalizeCategoryKey(c.name) === normalizeCategoryKey(defName))
      );
      if (matched) {
        suggestedCategoryId = matched.id;
        break;
      }
    }
  }

  if (!suggestedCategoryId && suggestedBrandId) {
    const brandObj = brands.find((b) => b.id === suggestedBrandId);
    if (brandObj?.categoryIds && brandObj.categoryIds.length > 0) {
      suggestedCategoryId = brandObj.categoryIds[0];
    }
  }

  return { categoryId: suggestedCategoryId, brandId: suggestedBrandId };
}
