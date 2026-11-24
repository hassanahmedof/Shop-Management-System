import type { SearchableProductItem } from '../services/productSearchService';
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
}

type ProductFamilyId =
  | 'diapers'
  | 'wipes'
  | 'baby_care_topicals'
  | 'baby_nutrition'
  | 'tea'
  | 'coffee'
  | 'milk_dairy'
  | 'sugar'
  | 'bread_bakery'
  | 'breakfast_spread'
  | 'cold_drinks'
  | 'juice_water'
  | 'snacks_chips'
  | 'biscuits_confectionery'
  | 'toothpaste'
  | 'toothbrush_oral'
  | 'shampoo'
  | 'hair_care_addon'
  | 'soap_wash'
  | 'winter_skincare'
  | 'sanitary_pads'
  | 'intimate_hygiene'
  | 'condoms'
  | 'lubricants'
  | 'laundry_detergent'
  | 'laundry_addon'
  | 'dishwash_cleaner'
  | 'kitchen_cleaning_tools'
  | 'tissues_paper'
  | 'sanitizer_handwash'
  | 'shaving'
  | 'deodorant';

interface FamilyDefinition {
  id: ProductFamilyId;
  keywords: string[];
  excludeKeywords?: string[];
}

interface PairingTarget {
  targetFamily: ProductFamilyId;
  baseWeight: number;
  qtyBonusPerUnit?: number;
  preferValuePackAtQty?: number;
  /** Skip suggesting this target if any of these families already meet/exceed sufficient quantity ratio */
  saturatedIfFamilyPresent?: Array<{ family: ProductFamilyId; minQtyRatio?: number; minAbsQty?: number }>;
  prompt: (targetName: string, anchorCount: number) => string;
}

interface FamilyPairingRule {
  sourceFamily: ProductFamilyId;
  targets: PairingTarget[];
}

const FAMILY_DEFINITIONS: FamilyDefinition[] = [
  {
    id: 'wipes',
    keywords: ['baby wipe', 'wet wipe', 'wipes'],
  },
  {
    id: 'diapers',
    keywords: [
      'diaper',
      'diapers',
      'pampers',
      'molfix',
      'bona papa',
      'canbebe',
      'huggies',
      'shield baby',
      'momse',
      'bebem',
      'susu',
      'leo baby',
    ],
    excludeKeywords: ['wipe', 'wipes'],
  },
  {
    id: 'baby_care_topicals',
    keywords: [
      'rash cream',
      'baby lotion',
      'baby powder',
      'baby shampoo',
      'baby soap',
      'baby oil',
      'baby wash',
      'top to toe',
      'baby cream',
      'baby balm',
      'sudocrem',
    ],
  },
  {
    id: 'baby_nutrition',
    keywords: ['cerelac', 'lactogen', 'nan', 'nido', 'pediasure', 'morinaga', 'similac', 'baby milk', 'formula'],
  },
  {
    id: 'tea',
    keywords: ['tea', 'chai', 'patti', 'tapal', 'lipton', 'vital', 'brooke bond', 'supreme', 'green tea', 'danedar'],
    excludeKeywords: ['tree oil', 'tea tree'],
  },
  {
    id: 'coffee',
    keywords: ['coffee', 'nescafe', 'davidoff', 'classic coffee'],
  },
  {
    id: 'sugar',
    keywords: ['sugar', 'cheeni'],
    excludeKeywords: ['sugar free', 'lipstick', 'scrub'],
  },
  {
    id: 'milk_dairy',
    keywords: ['milk', 'doodh', 'olpers', 'milkpak', 'nurpur', 'prema', 'haleeb', 'good milk', 'everyday', 'tarang', 'whitener'],
    excludeKeywords: [
      'body milk',
      'cleansing milk',
      'shampoo',
      'lotion',
      'soap',
      'baby milk',
      'formula',
      'lactogen',
      'cerelac',
      'nan',
      'nido',
      'pediasure',
      'morinaga',
      'similac',
      'infant',
      'dairy milk',
      'chocolate',
      'cadbury',
      'kitkat',
      'mars',
      'snickers',
      'ice cream',
      'biscuit',
      'wafer',
      'cookie',
      'shake',
      'milky',
    ],
  },
  {
    id: 'bread_bakery',
    keywords: ['bread', 'double roti', 'dawn bread', 'bunny', 'rusk', 'papa', 'bun'],
  },
  {
    id: 'breakfast_spread',
    keywords: ['butter', 'margarine', 'blue band', 'jam', 'honey', 'eggs', 'anda', 'mayo', 'cheese'],
    excludeKeywords: ['body butter', 'cocoa butter', 'shea butter', 'lotion', 'cream'],
  },
  {
    id: 'cold_drinks',
    keywords: [
      'pepsi',
      'coke',
      'coca cola',
      'sprite',
      '7up',
      'fanta',
      'mountain dew',
      'mirinda',
      'sting',
      'pakola',
      'marinda',
      'cold drink',
      'soft drink',
      'soda',
      'gourmet cola',
    ],
  },
  {
    id: 'juice_water',
    keywords: ['juice', 'shezan', 'nestle fruita', 'mazaa', 'slice', 'tang', 'mineral water', 'aquafina', 'dasani', 'nestle pure'],
  },
  {
    id: 'snacks_chips',
    keywords: ['lays', 'chips', 'kurkure', 'cheetos', 'kurleez', 'slanty', 'nimko', 'pringles', 'popcorn', 'noodle', 'knorr', 'shoop', 'snack', 'namkeen'],
    excludeKeywords: ['biscuit', 'sooper', 'marie', 'gala', 'oreo', 'tuc', 'prince', 'wafer', 'cookie', 'chocolate', 'cake', 'candy', 'toffee'],
  },
  {
    id: 'biscuits_confectionery',
    keywords: ['biscuit', 'sooper', 'marie', 'gala', 'oreo', 'tuc', 'prince', 'wafer', 'cookie', 'chocolate', 'cake', 'dairy milk'],
  },
  {
    id: 'toothpaste',
    keywords: ['toothpaste', 'colgate', 'sensodyne', 'pepsodent', 'close up', 'closeup', 'medicam', 'miswak'],
  },
  {
    id: 'toothbrush_oral',
    keywords: ['toothbrush', 'tooth brush', 'mouthwash', 'listerine'],
    excludeKeywords: ['hair brush', 'toilet brush'],
  },
  {
    id: 'shampoo',
    keywords: ['shampoo', 'sunsilk', 'head & shoulders', 'pantene', 'clear', 'dove shampoo', 'tresemme', 'lifebuoy shampoo'],
    excludeKeywords: ['baby shampoo'],
  },
  {
    id: 'hair_care_addon',
    keywords: ['conditioner', 'hair oil', 'amla', 'coconut oil', 'mustard oil', 'hair serum'],
  },
  {
    id: 'winter_skincare',
    keywords: ['cold cream', 'winter', 'vaseline', 'petroleum', 'glycerine', 'moisturizer', 'body lotion', 'nivea', 'ponds', 'jergens', 'lip balm', 'chapstick', 'hand cream'],
  },
  {
    id: 'soap_wash',
    keywords: ['soap', 'sabun', 'lux', 'safeguard', 'dettol', 'lifebuoy', 'body wash', 'face wash'],
    excludeKeywords: ['dish', 'laundry', 'washing', 'baby soap', 'sanitizer'],
  },
  {
    id: 'sanitary_pads',
    keywords: ['always', 'butterfly', 'molped', 'stayfree', 'whisper', 'sanitary', 'pads', 'napkin'],
    excludeKeywords: ['sanitizer', 'handwash', 'hand wash', 'cotton', 'antiseptic', 'adult diaper', 'adult diapers', 'panty liner'],
  },
  {
    id: 'intimate_hygiene',
    keywords: ['panty liner', 'intimate wash', 'intimate hygiene'],
  },
  {
    id: 'condoms',
    keywords: [
      'condom',
      'durex',
      'josh',
      'sathi',
      'saathi',
      'touch',
      'klimax',
      'pasante',
      'skyn',
      'trojan',
      'amore',
      'contempo',
      'rough rider',
      'excite',
    ],
    excludeKeywords: ['lubricant', 'gel', 'soft touch', 'lotion', 'cream', 'face wash', 'soap', 'shampoo', 'wipe', 'wipes'],
  },
  {
    id: 'lubricants',
    keywords: ['lubricant', 'play gel', 'ky jelly', 'k-y', 'ky', 'intimacy gel', 'massage gel', 'lube'],
  },
  {
    id: 'laundry_detergent',
    keywords: ['surf', 'ariel', 'brite', 'bonus', 'washing powder', 'detergent', 'rin', 'express power'],
  },
  {
    id: 'laundry_addon',
    keywords: ['comfort', 'softener', 'bleach', 'robin', 'neel', 'laundry soap'],
  },
  {
    id: 'dishwash_cleaner',
    keywords: ['lemon max', 'vim', 'dishwash', 'dish wash', 'harpic', 'finile', 'phenyl', 'domex'],
  },
  {
    id: 'kitchen_cleaning_tools',
    keywords: ['sponge', 'scotch', 'scrubber', 'kitchen roll', 'garbage bag', 'gloves'],
  },
  {
    id: 'tissues_paper',
    keywords: ['tissue', 'rose petal', 'tulip', 'facial tissue', 'toilet roll', 'kitchen roll'],
  },
  {
    id: 'sanitizer_handwash',
    keywords: ['hand wash', 'handwash', 'sanitizer'],
  },
  {
    id: 'shaving',
    keywords: ['razor', 'gillette', 'treet', 'shaving', 'after shave', 'aftershave'],
  },
  {
    id: 'deodorant',
    keywords: ['deodorant', 'body spray', 'roll on', 'perfume', 'fog', 'axe', 'rexona'],
  },
];

const FAMILY_PAIRINGS: FamilyPairingRule[] = [
  {
    sourceFamily: 'diapers',
    targets: [
      {
        targetFamily: 'wipes',
        baseWeight: 95,
        qtyBonusPerUnit: 8,
        preferValuePackAtQty: 2,
        prompt: (name) => `Diapers ke saath ${name} bhi rakh lain?`,
      },
      {
        targetFamily: 'baby_care_topicals',
        baseWeight: 68,
        qtyBonusPerUnit: 5,
        prompt: (name) => `Baby care ke liye saath ${name} chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'wipes',
    targets: [
      {
        targetFamily: 'diapers',
        baseWeight: 85,
        qtyBonusPerUnit: 7,
        preferValuePackAtQty: 2,
        prompt: (name) => `Wipes ke saath ${name} bhi dekh lain?`,
      },
      {
        targetFamily: 'baby_care_topicals',
        baseWeight: 72,
        qtyBonusPerUnit: 5,
        prompt: (name) => `Baby care ke liye saath ${name} chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'baby_nutrition',
    targets: [
      {
        targetFamily: 'wipes',
        baseWeight: 82,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Baby item ke saath ${name} bhi rakh lain?`,
      },
      {
        targetFamily: 'diapers',
        baseWeight: 78,
        qtyBonusPerUnit: 6,
        preferValuePackAtQty: 2,
        prompt: (name) => `Saath ${name} bhi dekh lain?`,
      },
      {
        targetFamily: 'baby_care_topicals',
        baseWeight: 64,
        qtyBonusPerUnit: 4,
        prompt: (name) => `Baby care ke liye saath ${name} chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'tea',
    targets: [
      {
        targetFamily: 'sugar',
        baseWeight: 88,
        qtyBonusPerUnit: 7,
        preferValuePackAtQty: 2,
        prompt: (name) => `Chai ke saath ${name} bhi rakh lain?`,
      },
      {
        targetFamily: 'milk_dairy',
        baseWeight: 86,
        qtyBonusPerUnit: 7,
        preferValuePackAtQty: 2,
        prompt: (name, anchors) =>
          anchors > 1
            ? `Chai aur nashtay ke liye saath ${name} bhi rakh lain?`
            : `Chai ke liye saath ${name} chahiye?`,
      },
      {
        targetFamily: 'biscuits_confectionery',
        baseWeight: 68,
        qtyBonusPerUnit: 5,
        saturatedIfFamilyPresent: [{ family: 'bread_bakery', minAbsQty: 2 }],
        prompt: (name) => `Chai ke saath ${name} bhi le lain?`,
      },
    ],
  },
  {
    sourceFamily: 'coffee',
    targets: [
      {
        targetFamily: 'milk_dairy',
        baseWeight: 86,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Coffee ke saath ${name} bhi rakh lain?`,
      },
      {
        targetFamily: 'sugar',
        baseWeight: 78,
        qtyBonusPerUnit: 5,
        prompt: (name) => `Coffee ke saath ${name} chahiye?`,
      },
      {
        targetFamily: 'biscuits_confectionery',
        baseWeight: 65,
        qtyBonusPerUnit: 4,
        prompt: (name) => `Coffee ke saath ${name} bhi le lain?`,
      },
    ],
  },
  {
    sourceFamily: 'milk_dairy',
    targets: [
      {
        targetFamily: 'bread_bakery',
        baseWeight: 88,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Doodh ke saath ${name} bhi rakh lain?`,
      },
      {
        targetFamily: 'tea',
        baseWeight: 76,
        qtyBonusPerUnit: 5,
        prompt: (name) => `Doodh ke saath ${name} chahiye?`,
      },
      {
        targetFamily: 'biscuits_confectionery',
        baseWeight: 62,
        qtyBonusPerUnit: 4,
        saturatedIfFamilyPresent: [{ family: 'bread_bakery', minAbsQty: 1 }],
        prompt: (name) => `Saath ${name} bhi le lain?`,
      },
    ],
  },
  {
    sourceFamily: 'bread_bakery',
    targets: [
      {
        targetFamily: 'breakfast_spread',
        baseWeight: 86,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Bread ke saath ${name} bhi rakh lain?`,
      },
      {
        targetFamily: 'milk_dairy',
        baseWeight: 84,
        qtyBonusPerUnit: 6,
        prompt: (name, anchors) =>
          anchors > 1
            ? `Chai aur bread ke saath ${name} bhi rakh lain?`
            : `Nashtay ke liye saath ${name} chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'cold_drinks',
    targets: [
      {
        targetFamily: 'snacks_chips',
        baseWeight: 92,
        qtyBonusPerUnit: 9,
        preferValuePackAtQty: 3,
        saturatedIfFamilyPresent: [{ family: 'biscuits_confectionery', minQtyRatio: 1 }],
        prompt: (name) => `Cold drink ke saath ${name} bhi rakh lain?`,
      },
      {
        targetFamily: 'biscuits_confectionery',
        baseWeight: 66,
        qtyBonusPerUnit: 6,
        saturatedIfFamilyPresent: [{ family: 'snacks_chips', minQtyRatio: 0.75 }],
        prompt: (name) => `Drink ke saath ${name} chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'juice_water',
    targets: [
      {
        targetFamily: 'snacks_chips',
        baseWeight: 82,
        qtyBonusPerUnit: 7,
        preferValuePackAtQty: 3,
        saturatedIfFamilyPresent: [{ family: 'biscuits_confectionery', minQtyRatio: 1 }],
        prompt: (name) => `Saath ${name} bhi le lain?`,
      },
      {
        targetFamily: 'biscuits_confectionery',
        baseWeight: 70,
        qtyBonusPerUnit: 5,
        saturatedIfFamilyPresent: [{ family: 'snacks_chips', minQtyRatio: 0.75 }],
        prompt: (name) => `Saath ${name} chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'snacks_chips',
    targets: [
      {
        targetFamily: 'cold_drinks',
        baseWeight: 90,
        qtyBonusPerUnit: 9,
        preferValuePackAtQty: 3,
        saturatedIfFamilyPresent: [{ family: 'juice_water', minQtyRatio: 0.5 }],
        prompt: (name) => `Snacks ke saath thanda ${name} bhi rakh lain?`,
      },
      {
        targetFamily: 'juice_water',
        baseWeight: 72,
        qtyBonusPerUnit: 6,
        saturatedIfFamilyPresent: [{ family: 'cold_drinks', minQtyRatio: 0.5 }],
        prompt: (name) => `Snacks ke saath ${name} chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'toothpaste',
    targets: [
      {
        targetFamily: 'toothbrush_oral',
        baseWeight: 88,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Toothpaste ke saath ${name} bhi chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'toothbrush_oral',
    targets: [
      {
        targetFamily: 'toothpaste',
        baseWeight: 88,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Brush ke saath ${name} bhi rakh lain?`,
      },
    ],
  },
  {
    sourceFamily: 'shampoo',
    targets: [
      {
        targetFamily: 'hair_care_addon',
        baseWeight: 86,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Shampoo ke saath ${name} bhi dekh lain?`,
      },
      {
        targetFamily: 'soap_wash',
        baseWeight: 66,
        qtyBonusPerUnit: 4,
        prompt: (name) => `Saath ${name} bhi chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'winter_skincare',
    targets: [
      {
        targetFamily: 'soap_wash',
        baseWeight: 64,
        qtyBonusPerUnit: 4,
        prompt: (name) => `Saath ${name} bhi dekh lain?`,
      },
    ],
  },
  {
    sourceFamily: 'soap_wash',
    targets: [
      {
        targetFamily: 'winter_skincare',
        baseWeight: 74,
        qtyBonusPerUnit: 5,
        prompt: (name) => `Saath ${name} bhi dekh lain?`,
      },
      {
        targetFamily: 'tissues_paper',
        baseWeight: 66,
        qtyBonusPerUnit: 4,
        prompt: (name) => `Saath ${name} bhi rakh lain?`,
      },
    ],
  },
  {
    sourceFamily: 'sanitary_pads',
    targets: [
      {
        targetFamily: 'intimate_hygiene',
        baseWeight: 84,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Saath ${name} bhi rakh lain?`,
      },
      {
        targetFamily: 'wipes',
        baseWeight: 72,
        qtyBonusPerUnit: 5,
        prompt: (name) => `Saath ${name} bhi chahiye?`,
      },
      {
        targetFamily: 'tissues_paper',
        baseWeight: 66,
        qtyBonusPerUnit: 4,
        prompt: (name) => `Saath ${name} bhi dekh lain?`,
      },
    ],
  },
  {
    sourceFamily: 'condoms',
    targets: [
      {
        targetFamily: 'lubricants',
        baseWeight: 88,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Saath ${name} bhi dekh lain?`,
      },
      {
        targetFamily: 'wipes',
        baseWeight: 72,
        qtyBonusPerUnit: 4,
        prompt: (name) => `Saath ${name} bhi rakh lain?`,
      },
    ],
  },
  {
    sourceFamily: 'laundry_detergent',
    targets: [
      {
        targetFamily: 'laundry_addon',
        baseWeight: 84,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Kapron ki safai ke saath ${name} bhi chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'dishwash_cleaner',
    targets: [
      {
        targetFamily: 'kitchen_cleaning_tools',
        baseWeight: 84,
        qtyBonusPerUnit: 6,
        prompt: (name) => `Safai ke saath ${name} bhi rakh lain?`,
      },
    ],
  },
  {
    sourceFamily: 'tissues_paper',
    targets: [
      {
        targetFamily: 'sanitizer_handwash',
        baseWeight: 80,
        qtyBonusPerUnit: 5,
        prompt: (name) => `Tissue ke saath ${name} bhi chahiye?`,
      },
    ],
  },
  {
    sourceFamily: 'shaving',
    targets: [
      {
        targetFamily: 'deodorant',
        baseWeight: 78,
        qtyBonusPerUnit: 5,
        prompt: (name) => `Shave ke saath ${name} bhi rakh lain?`,
      },
    ],
  },
];

const VALUE_PACK_REGEX = /\b(jumbo|family|value|mega|economy|super|combo|large|xl|xxl|1\.5|2\.25|2l|1l|80|72|100|pack of)\b/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KEYWORD_REGEX_CACHE = new Map<string, RegExp>();

function getKeywordRegex(keyword: string): RegExp {
  const normalized = keyword.trim().toLowerCase();
  let regex = KEYWORD_REGEX_CACHE.get(normalized);
  if (!regex) {
    const escaped = escapeRegex(normalized).replace(/\s+/g, '\\s+');
    const optionalPlural = normalized.endsWith('s') ? '' : 's?';
    regex = new RegExp(`(?:^|[^a-z0-9])${escaped}${optionalPlural}(?:$|[^a-z0-9])`, 'i');
    KEYWORD_REGEX_CACHE.set(normalized, regex);
  }
  return regex;
}

function normalizeHaystack(item: Pick<SearchableProductItem, 'name' | 'brandName' | 'categoryName' | 'bottleSize'>): string {
  return `${item.name || ''} ${item.brandName || ''} ${item.categoryName || ''} ${item.bottleSize || ''}`.toLowerCase();
}

function matchesAnyKeyword(haystack: string, keywords: string[]): boolean {
  return keywords.some((kw) => getKeywordRegex(kw).test(haystack));
}

function detectProductFamilies(item: SearchableProductItem): ProductFamilyId[] {
  const hay = normalizeHaystack(item);
  const matched: ProductFamilyId[] = [];
  for (const def of FAMILY_DEFINITIONS) {
    if (matchesAnyKeyword(hay, def.keywords)) {
      if (def.excludeKeywords && matchesAnyKeyword(hay, def.excludeKeywords)) {
        continue;
      }
      matched.push(def.id);
    }
  }
  return matched;
}

const PAIRING_MAP = new Map<ProductFamilyId, PairingTarget[]>(
  FAMILY_PAIRINGS.map((rule) => [rule.sourceFamily, rule.targets])
);

interface CategoryPairingTarget {
  targetCategory: string;
  baseWeight: number;
  qtyBonusPerUnit?: number;
  preferValuePackAtQty?: number;
  prompt: (targetName: string, anchorCount: number) => string;
}

const CATEGORY_PAIRINGS: Record<string, CategoryPairingTarget[]> = {
  'diapers & pampers': [
    {
      targetCategory: 'baby wipes',
      baseWeight: 86,
      qtyBonusPerUnit: 7,
      preferValuePackAtQty: 2,
      prompt: (name) => `Diapers ke saath ${name} bhi rakh lain?`,
    },
    {
      targetCategory: 'baby care',
      baseWeight: 66,
      qtyBonusPerUnit: 5,
      prompt: (name) => `Baby care ke liye saath ${name} chahiye?`,
    },
    {
      targetCategory: 'tissue & paper products',
      baseWeight: 48,
      qtyBonusPerUnit: 3,
      prompt: (name) => `Saath ${name} bhi dekh lain?`,
    },
  ],
  'baby wipes': [
    {
      targetCategory: 'baby care',
      baseWeight: 70,
      qtyBonusPerUnit: 5,
      prompt: (name) => `Baby care ke liye saath ${name} chahiye?`,
    },
    {
      targetCategory: 'diapers & pampers',
      baseWeight: 68,
      qtyBonusPerUnit: 5,
      preferValuePackAtQty: 2,
      prompt: (name) => `Wipes ke saath ${name} bhi dekh lain?`,
    },
    {
      targetCategory: 'tissue & paper products',
      baseWeight: 50,
      qtyBonusPerUnit: 3,
      prompt: (name) => `Saath ${name} bhi rakh lain?`,
    },
  ],
  'baby care': [
    {
      targetCategory: 'baby wipes',
      baseWeight: 74,
      qtyBonusPerUnit: 6,
      prompt: (name) => `Baby care ke saath ${name} bhi rakh lain?`,
    },
    {
      targetCategory: 'diapers & pampers',
      baseWeight: 64,
      qtyBonusPerUnit: 5,
      preferValuePackAtQty: 2,
      prompt: (name) => `Saath ${name} bhi dekh lain?`,
    },
    {
      targetCategory: 'tissue & paper products',
      baseWeight: 48,
      qtyBonusPerUnit: 3,
      prompt: (name) => `Saath ${name} chahiye?`,
    },
  ],
  'cold drinks & beverages': [
    {
      targetCategory: 'snacks & confectionery',
      baseWeight: 84,
      qtyBonusPerUnit: 8,
      preferValuePackAtQty: 3,
      prompt: (name) => `Cold drink ke saath ${name} bhi rakh lain?`,
    },
    {
      targetCategory: 'tissue & paper products',
      baseWeight: 44,
      qtyBonusPerUnit: 3,
      prompt: (name) => `Saath ${name} bhi chahiye?`,
    },
  ],
  'snacks & confectionery': [
    {
      targetCategory: 'cold drinks & beverages',
      baseWeight: 84,
      qtyBonusPerUnit: 8,
      preferValuePackAtQty: 3,
      prompt: (name) => `Snacks ke saath thanda ${name} bhi rakh lain?`,
    },
    {
      targetCategory: 'bottled water & juices',
      baseWeight: 64,
      qtyBonusPerUnit: 5,
      prompt: (name) => `Snacks ke saath ${name} chahiye?`,
    },
    {
      targetCategory: 'tissue & paper products',
      baseWeight: 46,
      qtyBonusPerUnit: 3,
      prompt: (name) => `Saath ${name} bhi dekh lain?`,
    },
  ],
  'bottled water & juices': [
    {
      targetCategory: 'snacks & confectionery',
      baseWeight: 78,
      qtyBonusPerUnit: 6,
      preferValuePackAtQty: 3,
      prompt: (name) => `Saath ${name} bhi le lain?`,
    },
    {
      targetCategory: 'tissue & paper products',
      baseWeight: 46,
      qtyBonusPerUnit: 3,
      prompt: (name) => `Saath ${name} chahiye?`,
    },
  ],
  'sexual wellness': [
    {
      targetCategory: 'hygiene & sanitary',
      baseWeight: 68,
      qtyBonusPerUnit: 4,
      prompt: (name) => `Saath ${name} bhi dekh lain?`,
    },
    {
      targetCategory: 'tissue & paper products',
      baseWeight: 62,
      qtyBonusPerUnit: 4,
      prompt: (name) => `Saath ${name} bhi rakh lain?`,
    },
    {
      targetCategory: 'personal care & toiletries',
      baseWeight: 52,
      qtyBonusPerUnit: 3,
      prompt: (name) => `Saath ${name} chahiye?`,
    },
  ],
  'hygiene & sanitary': [
    {
      targetCategory: 'tissue & paper products',
      baseWeight: 74,
      qtyBonusPerUnit: 5,
      prompt: (name) => `Saath ${name} bhi rakh lain?`,
    },
    {
      targetCategory: 'baby wipes',
      baseWeight: 66,
      qtyBonusPerUnit: 4,
      prompt: (name) => `Saath ${name} chahiye?`,
    },
    {
      targetCategory: 'personal care & toiletries',
      baseWeight: 54,
      qtyBonusPerUnit: 3,
      prompt: (name) => `Saath ${name} bhi dekh lain?`,
    },
  ],
  'household cleaning': [
    {
      targetCategory: 'tissue & paper products',
      baseWeight: 70,
      qtyBonusPerUnit: 5,
      prompt: (name) => `Safai ke saath ${name} bhi rakh lain?`,
    },
    {
      targetCategory: 'personal care & toiletries',
      baseWeight: 54,
      qtyBonusPerUnit: 4,
      prompt: (name) => `Saath ${name} chahiye?`,
    },
  ],
  'tissue & paper products': [
    {
      targetCategory: 'hygiene & sanitary',
      baseWeight: 66,
      qtyBonusPerUnit: 4,
      prompt: (name) => `Tissue ke saath ${name} bhi chahiye?`,
    },
    {
      targetCategory: 'personal care & toiletries',
      baseWeight: 60,
      qtyBonusPerUnit: 4,
      prompt: (name) => `Saath ${name} bhi rakh lain?`,
    },
    {
      targetCategory: 'household cleaning',
      baseWeight: 52,
      qtyBonusPerUnit: 3,
      prompt: (name) => `Saath ${name} bhi dekh lain?`,
    },
  ],
  'personal care & toiletries': [
    {
      targetCategory: 'tissue & paper products',
      baseWeight: 62,
      qtyBonusPerUnit: 4,
      prompt: (name) => `Saath ${name} bhi rakh lain?`,
    },
    {
      targetCategory: 'hygiene & sanitary',
      baseWeight: 58,
      qtyBonusPerUnit: 4,
      prompt: (name) => `Saath ${name} chahiye?`,
    },
  ],
};

/** Single-type dedicated categories whose generic fallback should not repeat if already in cart */
const SINGLE_TYPE_CATEGORIES = new Set<string>([
  'diapers & pampers',
  'baby wipes',
  'tissue & paper products',
]);

function extractBaseVariantKey(
  item: Pick<SearchableProductItem, 'name' | 'brandName'>
): string {
  const stripped = (item.name || '')
    .toLowerCase()
    .replace(/\b\d+(\.\d+)?\s*(g|gm|grams?|kg|ml|l|ltr|liters?|litres?|s|pcs|pc|pieces?|pack|packs|sheet|sheets|pulls?)\b/gi, ' ')
    .replace(/\b(jumbo|mega|value|economy|super|family|mini|small|medium|large|xl|xxl|xxxl|combo|variety|pack\s+of\s+\d+|box|pouch|bottle|can|sachet|refill|twin\s+pack)\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const brand = (item.brandName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!stripped) return '';
  return brand && !stripped.startsWith(brand) ? `${brand} ${stripped}` : stripped;
}

export function getUpsellSuggestion(params: {
  cartItems?: CartAssistantItem[];
  cartProductIds?: string[];
  catalog: SearchableProductItem[];
  dismissedProductIds?: string[];
  removedProductIds?: string[];
}): UpsellSuggestion | null {
  try {
    const {
      cartItems,
      cartProductIds,
      catalog,
      dismissedProductIds = [],
      removedProductIds = [],
    } = params;
    if (!Array.isArray(catalog) || catalog.length === 0) return null;

    // Normalize cart lines (preserve backward compatibility with cartProductIds callers)
    const normalizedCart: CartAssistantItem[] = Array.isArray(cartItems) && cartItems.length > 0
      ? cartItems.filter((c) => Boolean(c.productId))
      : Array.isArray(cartProductIds)
        ? cartProductIds.filter(Boolean).map((id) => ({ productId: id, quantity: 1, conversionFactor: 1 }))
        : [];

    if (normalizedCart.length === 0) return null;

    const catalogById = new Map<string, SearchableProductItem>();
    const familiesByProductId = new Map<string, ProductFamilyId[]>();
    for (const item of catalog) {
      catalogById.set(item.id, item);
    }

    const getFamilies = (item: SearchableProductItem): ProductFamilyId[] => {
      let fam = familiesByProductId.get(item.id);
      if (!fam) {
        fam = detectProductFamilies(item);
        familiesByProductId.set(item.id, fam);
      }
      return fam;
    };

    // Aggregate the ENTIRE current cart: product IDs, base-variant keys, categories, families, quantities & brands
    const cartIdSet = new Set<string>();
    const cartBaseVariants = new Set<string>();
    const cartFamilyQty = new Map<ProductFamilyId, number>();
    const cartFamilyTopAnchor = new Map<ProductFamilyId, string>();
    const cartCategoryQty = new Map<string, number>();
    const cartCategoryTopAnchor = new Map<string, string>();
    const cartBrands = new Set<string>();

    for (const line of normalizedCart) {
      if (!line.productId) continue;
      cartIdSet.add(line.productId);
      const catalogItem = catalogById.get(line.productId);
      if (!catalogItem) continue;

      const qty = Math.max(0.25, Number(line.quantity) || 1);
      const conv = Math.max(1, Number(line.conversionFactor) || 1);
      const effectiveQty = roundStockQty(qty * conv);

      if (catalogItem.brandName) {
        cartBrands.add(catalogItem.brandName.trim().toLowerCase());
      }

      const baseKey = extractBaseVariantKey(catalogItem);
      if (baseKey.length >= 3) {
        cartBaseVariants.add(baseKey);
      }

      const catKey = normalizeCategoryKey(catalogItem.categoryName || '');
      if (catKey) {
        cartCategoryQty.set(catKey, roundStockQty((cartCategoryQty.get(catKey) || 0) + effectiveQty));
        if (!cartCategoryTopAnchor.has(catKey)) {
          cartCategoryTopAnchor.set(catKey, catalogItem.id);
        }
      }

      const fams = getFamilies(catalogItem);
      for (const fam of fams) {
        cartFamilyQty.set(fam, roundStockQty((cartFamilyQty.get(fam) || 0) + effectiveQty));
        if (!cartFamilyTopAnchor.has(fam)) {
          cartFamilyTopAnchor.set(fam, catalogItem.id);
        }
      }
    }

    if (cartFamilyQty.size === 0 && cartCategoryQty.size === 0) return null;

    interface TargetDemand {
      score: number;
      anchorCount: number;
      triggerProductId: string;
      ruleId: string;
      preferValuePack: boolean;
      promptFn: (name: string, anchorCount: number) => string;
    }

    // 1) Whole-cart demand by complementary product family
    const targetDemands = new Map<ProductFamilyId, TargetDemand>();

    for (const [sourceFam, sourceQty] of cartFamilyQty.entries()) {
      const targets = PAIRING_MAP.get(sourceFam);
      if (!targets) continue;

      for (const target of targets) {
        // Strictly never recommend a product family that is ALREADY present in the cart
        if (cartFamilyQty.has(target.targetFamily)) continue;

        // Quantity sufficiency check: if a sibling/related family already satisfies the need, skip
        if (target.saturatedIfFamilyPresent) {
          const isSaturated = target.saturatedIfFamilyPresent.some((sat) => {
            const presentQty = cartFamilyQty.get(sat.family) || 0;
            if (presentQty <= 0) return false;
            if (sat.minAbsQty !== undefined && presentQty >= sat.minAbsQty) return true;
            if (sat.minQtyRatio !== undefined && presentQty >= sourceQty * sat.minQtyRatio) return true;
            return false;
          });
          if (isSaturated) continue;
        }

        const extraQtyUnits = Math.max(0, sourceQty - 1);
        const qtyBoost = Math.min(40, extraQtyUnits * (target.qtyBonusPerUnit ?? 5));
        const contribution = target.baseWeight + qtyBoost;
        const preferValue =
          target.preferValuePackAtQty !== undefined && sourceQty >= target.preferValuePackAtQty;

        const existing = targetDemands.get(target.targetFamily);
        const anchorId = cartFamilyTopAnchor.get(sourceFam) || '';
        if (existing) {
          existing.score += contribution * 0.85;
          existing.anchorCount += 1;
          existing.preferValuePack = existing.preferValuePack || preferValue;
          if (contribution > target.baseWeight) {
            existing.triggerProductId = anchorId;
            existing.promptFn = target.prompt;
          }
        } else {
          targetDemands.set(target.targetFamily, {
            score: contribution,
            anchorCount: 1,
            triggerProductId: anchorId,
            ruleId: `${sourceFam}_to_${target.targetFamily}`,
            preferValuePack: preferValue,
            promptFn: target.prompt,
          });
        }
      }
    }

    // 2) Whole-cart demand by complementary store category
    const categoryDemands = new Map<string, TargetDemand>();

    for (const [sourceCat, sourceQty] of cartCategoryQty.entries()) {
      const catTargets = CATEGORY_PAIRINGS[sourceCat];
      if (!catTargets) continue;

      for (const target of catTargets) {
        if (SINGLE_TYPE_CATEGORIES.has(target.targetCategory) && cartCategoryQty.has(target.targetCategory)) {
          continue;
        }

        const extraQtyUnits = Math.max(0, sourceQty - 1);
        const qtyBoost = Math.min(35, extraQtyUnits * (target.qtyBonusPerUnit ?? 4));
        const contribution = target.baseWeight + qtyBoost;
        const preferValue =
          target.preferValuePackAtQty !== undefined && sourceQty >= target.preferValuePackAtQty;

        const existing = categoryDemands.get(target.targetCategory);
        const anchorId = cartCategoryTopAnchor.get(sourceCat) || '';
        if (existing) {
          existing.score += contribution * 0.75;
          existing.anchorCount += 1;
          existing.preferValuePack = existing.preferValuePack || preferValue;
          if (contribution > target.baseWeight) {
            existing.triggerProductId = anchorId;
            existing.promptFn = target.prompt;
          }
        } else {
          categoryDemands.set(target.targetCategory, {
            score: contribution,
            anchorCount: 1,
            triggerProductId: anchorId,
            ruleId: `cat_${sourceCat}_to_${target.targetCategory}`,
            preferValuePack: preferValue,
            promptFn: target.prompt,
          });
        }
      }
    }

    if (targetDemands.size === 0 && categoryDemands.size === 0) return null;

    const excludedSet = new Set(
      [...dismissedProductIds, ...removedProductIds].filter(Boolean)
    );
    let bestSuggestion: UpsellSuggestion | null = null;

    for (const candidate of catalog) {
      if (candidate.isActive === false) continue;
      if (cartIdSet.has(candidate.id) || excludedSet.has(candidate.id)) continue;

      // Respect existing available-stock & default sale unit packaging rules
      const availableBaseStock = roundStockQty(Math.max(0, Number(candidate.currentStock) || 0));
      if (availableBaseStock <= 0) continue;
      const defaultSaleUnit = getDefaultSaleUnit(candidate);
      if (availableBaseStock < defaultSaleUnit.conversionQty) continue;

      // Never suggest an alternative pack/size/variant of a product already in the cart
      const candBaseKey = extractBaseVariantKey(candidate);
      if (candBaseKey.length >= 3 && cartBaseVariants.has(candBaseKey)) continue;

      const candFamilies = getFamilies(candidate);
      if (candFamilies.some((fam) => cartFamilyQty.has(fam))) continue;

      const candCatKey = normalizeCategoryKey(candidate.categoryName || '');
      const catDemand = candCatKey ? categoryDemands.get(candCatKey) : undefined;

      // Find best matching demand (product-family relationship + category-level relationship)
      let matchedDemand: TargetDemand | null = null;
      let baseDemandScore = 0;

      for (const candFam of candFamilies) {
        const famDemand = targetDemands.get(candFam);
        if (!famDemand) continue;
        const combined = famDemand.score + (catDemand ? Math.min(8, catDemand.score * 0.08) : 0);
        if (!matchedDemand || combined > baseDemandScore) {
          matchedDemand = famDemand;
          baseDemandScore = combined;
        }
      }

      if (!matchedDemand && catDemand) {
        matchedDemand = catDemand;
        baseDemandScore = catDemand.score;
      }

      if (!matchedDemand) continue;

      let candidateScore = baseDemandScore;

      // Healthy available stock readiness measured in sellable default units (up to +12)
      const sellableUnits = Math.floor(availableBaseStock / Math.max(1, defaultSaleUnit.conversionQty));
      candidateScore += Math.min(12, Math.max(1, sellableUnits));

      // Subtle brand affinity without overriding primary complementary relevance
      const candBrand = (candidate.brandName || '').trim().toLowerCase();
      if (candBrand && cartBrands.has(candBrand)) {
        candidateScore += 4;
      }

      // Value / larger pack preference only when cart quantities justify it
      const isValuePack = VALUE_PACK_REGEX.test(`${candidate.name} ${candidate.bottleSize || ''}`);
      if (matchedDemand.preferValuePack && isValuePack) {
        candidateScore += 18;
      } else if (!matchedDemand.preferValuePack && !isValuePack) {
        candidateScore += 4;
      }

      if (!bestSuggestion || candidateScore > bestSuggestion.score) {
        const stockBreakdown = formatStockBreakdown(availableBaseStock, candidate);
        bestSuggestion = {
          product: candidate,
          triggerProductId: matchedDemand.triggerProductId,
          romanUrduPrompt: matchedDemand.promptFn(candidate.name, matchedDemand.anchorCount),
          stockSummary: stockBreakdown.summaryText,
          ruleId: matchedDemand.ruleId,
          score: Math.round(candidateScore * 100) / 100,
        };
      }
    }

    return bestSuggestion;
  } catch {
    return null;
  }
}
