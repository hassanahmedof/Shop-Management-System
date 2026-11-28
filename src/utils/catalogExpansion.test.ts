import { describe, expect, it } from 'vitest';
import type { Brand, Category, ProductTemplate } from '../types/shop';
import {
  DEFAULT_PRODUCT_BRANDS,
  findExactBrandMatch,
  getBrandSearchAliases,
  normalizeBrandKey,
} from './brands';
import { DEFAULT_PRODUCT_CATEGORIES } from './packaging';
import {
  createTemplateSearchIndex,
  normalizeTemplateKey,
  queryTemplateIndex,
  resolveTemplateCategoryAndBrand,
  suggestCategoryAndBrandFromName,
} from './productTemplateHelpers';
import { DEFAULT_PRODUCT_TEMPLATES } from './productTemplates';

function toLiveBrand(def: (typeof DEFAULT_PRODUCT_BRANDS)[number]): Brand {
  return {
    id: def.id,
    ownerUid: 'test_owner',
    name: def.name,
    categoryIds: def.categoryIds,
    isActive: true,
  };
}

function toLiveCategory(def: (typeof DEFAULT_PRODUCT_CATEGORIES)[number]): Category {
  return {
    id: def.id,
    ownerUid: 'test_owner',
    name: def.name,
    description: def.description,
  };
}

describe('CareMart catalog integrity & 6-brand expansion', () => {
  const liveBrands: Brand[] = DEFAULT_PRODUCT_BRANDS.map(toLiveBrand);
  const liveCategories: Category[] = DEFAULT_PRODUCT_CATEGORIES.map(toLiveCategory);

  it('keeps zero duplicate brand IDs and zero normalized brand key collisions', () => {
    const idSet = new Set<string>();
    const keySet = new Set<string>();

    for (const def of DEFAULT_PRODUCT_BRANDS) {
      expect(idSet.has(def.id), `Duplicate brand id: ${def.id}`).toBe(false);
      idSet.add(def.id);

      const key = normalizeBrandKey(def.name);
      expect(key.length).toBeGreaterThan(0);
      expect(keySet.has(key), `Duplicate normalized brand key: ${key} (${def.name})`).toBe(false);
      keySet.add(key);

      expect(def.categoryIds.length).toBeLessThanOrEqual(25);
    }
  });

  it('includes all 6 target brands with accurate category associations', () => {
    const byId = new Map(DEFAULT_PRODUCT_BRANDS.map((b) => [b.id, b]));

    expect(byId.get('brand_leo')?.categoryIds).toEqual(
      expect.arrayContaining(['cat_diapers', 'cat_wipes'])
    );
    expect(byId.get('brand_royalozone')?.categoryIds).toEqual(
      expect.arrayContaining(['cat_diapers', 'cat_wipes'])
    );
    expect(byId.get('brand_mothercare')?.categoryIds).toEqual(
      expect.arrayContaining(['cat_baby_care', 'cat_wipes'])
    );
    expect(byId.get('brand_shangrila')?.categoryIds).toEqual(
      expect.arrayContaining(['cat_other'])
    );
    expect(byId.get('brand_shan')?.categoryIds).toEqual(
      expect.arrayContaining(['cat_other', 'cat_snacks'])
    );
    expect(byId.get('brand_national')?.categoryIds).toEqual(
      expect.arrayContaining(['cat_other', 'cat_snacks'])
    );
  });

  it('recognizes spelling and search aliases without creating duplicate brands', () => {
    expect(normalizeBrandKey('Shaan')).toBe('shan');
    expect(normalizeBrandKey('Shan Foods')).toBe('shan');
    expect(normalizeBrandKey('National Foods')).toBe('national');
    expect(normalizeBrandKey('Mother Care')).toBe('mothercare');
    expect(normalizeBrandKey('LEO')).toBe('leo');
    expect(normalizeBrandKey('RoyalOzone')).toBe('royal ozone');

    expect(findExactBrandMatch('Shaan', liveBrands)?.id).toBe('brand_shan');
    expect(findExactBrandMatch('Shan Foods', liveBrands)?.id).toBe('brand_shan');
    expect(findExactBrandMatch('Mother Care', liveBrands)?.id).toBe('brand_mothercare');
    expect(findExactBrandMatch('LEO', liveBrands)?.id).toBe('brand_leo');
    expect(findExactBrandMatch('RoyalOzone', liveBrands)?.id).toBe('brand_royalozone');
    expect(findExactBrandMatch('Shangrila', liveBrands)?.id).toBe('brand_shangrila');

    expect(getBrandSearchAliases('Shan')).toContain('shaan');
  });

  it('keeps zero duplicate template IDs or normalized template keys and enforces Firestore rule limits', () => {
    const idSet = new Set<string>();
    const keySet = new Set<string>();
    const brandMap = new Map(DEFAULT_PRODUCT_BRANDS.map((b) => [b.id, b]));
    const catIdSet = new Set(DEFAULT_PRODUCT_CATEGORIES.map((c) => c.id));

    for (const tpl of DEFAULT_PRODUCT_TEMPLATES) {
      expect(idSet.has(tpl.id), `Duplicate template id: ${tpl.id}`).toBe(false);
      idSet.add(tpl.id);

      const nKey = normalizeTemplateKey(tpl.categoryId, tpl.brandId, tpl.name, tpl.variant);
      expect(keySet.has(nKey), `Duplicate normalized template key: ${nKey}`).toBe(false);
      keySet.add(nKey);

      expect(catIdSet.has(tpl.categoryId), `Unknown categoryId ${tpl.categoryId} on ${tpl.id}`).toBe(true);
      const brandDef = brandMap.get(tpl.brandId);
      expect(brandDef, `Unknown brandId ${tpl.brandId} on ${tpl.id}`).toBeDefined();
      expect(
        brandDef?.categoryIds.includes(tpl.categoryId),
        `Brand ${tpl.brandId} missing categoryId ${tpl.categoryId} for ${tpl.id}`
      ).toBe(true);

      // Firestore rules string/array constraints
      expect(tpl.name.length).toBeGreaterThanOrEqual(1);
      expect(tpl.name.length).toBeLessThanOrEqual(180);
      expect(tpl.variant.length).toBeLessThanOrEqual(120);
      expect(tpl.baseUnit.length).toBeGreaterThanOrEqual(1);
      expect(tpl.baseUnit.length).toBeLessThanOrEqual(40);
      if (tpl.bottleSize) expect(tpl.bottleSize.length).toBeLessThanOrEqual(40);
      if (tpl.storageLocation) expect(tpl.storageLocation.length).toBeLessThanOrEqual(80);
      if (tpl.packagingUnits) {
        expect(tpl.packagingUnits.length).toBeLessThanOrEqual(15);
      }
      if (tpl.searchKeywords) {
        expect(tpl.searchKeywords.length).toBeLessThanOrEqual(15);
        for (const kw of tpl.searchKeywords) {
          expect(kw.length).toBeLessThanOrEqual(50);
        }
      }
    }
  });

  it('preserves existing legacy template IDs and adds verified SKU coverage for all 6 brands', () => {
    const ids = new Set(DEFAULT_PRODUCT_TEMPLATES.map((t) => t.id));
    expect(ids.has('tpl_leo_diapers')).toBe(true);
    expect(ids.has('tpl_mothercare_bath_300')).toBe(true);
    expect(ids.has('tpl_mothercare_wipes_60')).toBe(true);
    expect(ids.has('tpl_national_salt_800g')).toBe(true);
    expect(ids.has('tpl_national_pickle_300g')).toBe(true);
    expect(ids.has('tpl_shan_biryani_masala_50g')).toBe(true);
    expect(ids.has('tpl_shan_karahi_50g')).toBe(true);

    const countByBrand = (brandId: string) =>
      DEFAULT_PRODUCT_TEMPLATES.filter((t) => t.brandId === brandId).length;

    expect(countByBrand('brand_leo')).toBeGreaterThanOrEqual(16);
    expect(countByBrand('brand_shangrila')).toBeGreaterThanOrEqual(35);
    expect(countByBrand('brand_shan')).toBeGreaterThanOrEqual(30);
    expect(countByBrand('brand_national')).toBeGreaterThanOrEqual(40);
    expect(countByBrand('brand_mothercare')).toBeGreaterThanOrEqual(22);
    expect(countByBrand('brand_royalozone')).toBeGreaterThanOrEqual(9);
  });

  it('filters templates accurately by category and brand and resolves "Shaan" searches to Shan', () => {
    const liveTemplates: ProductTemplate[] = DEFAULT_PRODUCT_TEMPLATES.map((def) => {
      const resolved = resolveTemplateCategoryAndBrand(def, liveCategories, liveBrands);
      return {
        ...def,
        ownerUid: 'test_owner',
        categoryId: resolved.categoryId,
        categoryName: resolved.categoryName,
        brandId: resolved.brandId,
        brandName: resolved.brandName,
        isActive: true,
        isCustom: false,
      };
    });

    const index = createTemplateSearchIndex(liveTemplates);

    // Searching "shaan" finds both legacy and expanded Shan items
    const shaanMatches = queryTemplateIndex(index, { query: 'shaan' });
    expect(shaanMatches.some((t) => t.id === 'tpl_shan_biryani_masala_50g')).toBe(true);
    expect(shaanMatches.some((t) => t.id === 'tpl_shan_shoop_chatpata_65g')).toBe(true);

    // Category + brand filtering isolates matching items cleanly
    const wipesLeo = queryTemplateIndex(index, { categoryId: 'cat_wipes', brandId: 'brand_leo' });
    expect(wipesLeo.length).toBeGreaterThanOrEqual(3);
    expect(wipesLeo.every((t) => t.categoryId === 'cat_wipes' && t.brandId === 'brand_leo')).toBe(true);

    const diapersRoyalOzone = queryTemplateIndex(index, {
      categoryId: 'cat_diapers',
      brandId: 'brand_royalozone',
    });
    expect(diapersRoyalOzone).toHaveLength(6);

    const shangrilaOther = queryTemplateIndex(index, {
      categoryId: 'cat_other',
      brandId: 'brand_shangrila',
    });
    expect(shangrilaOther.some((t) => t.id === 'tpl_shangrila_worcestershire_300ml')).toBe(true);
    expect(shangrilaOther.some((t) => t.id === 'tpl_shangrila_apple_cider_vinegar_485ml')).toBe(true);

    // Smart name hint recognizes "Shaan" and Mothercare variants
    const shaanHint = suggestCategoryAndBrandFromName('Shaan Sindhi Biryani 60g', liveCategories, liveBrands);
    expect(shaanHint.brandId).toBe('brand_shan');
    expect(shaanHint.categoryId).toBe('cat_other');

    const royalOzoneHint = suggestCategoryAndBrandFromName(
      'Royal Ozone Baby Diapers Large',
      liveCategories,
      liveBrands
    );
    expect(royalOzoneHint.brandId).toBe('brand_royalozone');
    expect(royalOzoneHint.categoryId).toBe('cat_diapers');
  });
});
