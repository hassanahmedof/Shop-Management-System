import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Edit3,
  Filter,
  Package,
  Plus,
  Search,
  Snowflake,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { CompactExpandableRow } from '../components/CompactSection';
import { SearchableSelect, type SearchableSelectOption } from '../components/SearchableSelect';
import { useAuth } from '../contexts/AuthContext';
import { useShopData } from '../contexts/ShopDataContext';
import { useToast } from '../contexts/ToastContext';
import { computeTopActivityValues } from '../services/recordSearchService';
import {
  createBrand,
  createCategory,
  createProduct,
  createProductTemplate,
  createSupplier,
  deleteProduct,
  updateProduct,
} from '../services/shopService';
import type { OriginType, Product, ProductPackagingUnit, ProductTemplate } from '../types/shop';
import {
  calcProfitMarginPct,
  formatDateDDMMYYYY,
  formatNumber,
  formatPKR,
  getKarachiDateIso,
  getProductStockStatus,
  roundMoney,
} from '../utils/formatters';
import {
  formatStockBreakdown,
  getEffectiveBaseUnit,
  hydrateHierarchicalPackaging,
  isFractionalUnit,
  isImportedCategoryName,
  MAX_PACKAGING_LEVELS,
  normalizeCategoryKey,
  pluralizeUnit,
  resolveCanonicalCategoryName,
  resolveCumulativeConversion,
  roundStockQty,
  STANDARD_UNITS,
} from '../utils/packaging';
import {
  findExactBrandMatch,
  findSimilarBrands,
  formatBrandCategoryNames,
  isBrandActive,
} from '../utils/brands';
import {
  createTemplateSearchIndex,
  normalizeTemplateKey,
  queryTemplateIndex,
  suggestCategoryAndBrandFromName,
} from '../utils/productTemplates';

interface PackagingFormRow {
  key: string;
  unitName: string;
  customUnitMode: boolean;
  containsQty: string;
  parentUnitName: string;
  allowPurchase: boolean;
  allowSale: boolean;
  purchasePrice: string;
  salePrice: string;
  wholesalePrice: string;
  isDefaultPurchase: boolean;
  isDefaultSale: boolean;
}

interface ManualBaseOverrides {
  purchase: boolean;
  sale: boolean;
  wholesale: boolean;
}

interface ProductFormState {
  name: string;
  categoryId: string;
  brandId: string;
  purchasePrice: string;
  salePrice: string;
  wholesalePrice: string;
  currentStock: string;
  openingStockUnit: string;
  minStockLevel: string;
  maxStockLevel: string;
  baseUnit: string;
  supplierId: string;
  expiryDate: string;
  packagingUnits: PackagingFormRow[];
  originType: OriginType;
  bottleSize: string;
  storageLocation: string;
  isReturnable: boolean;
  returnableUnitName: string;
  depositPerReturnable: string;
  emptyContainersOnHand: string;
}

const emptyForm: ProductFormState = {
  name: '',
  categoryId: '',
  brandId: '',
  purchasePrice: '',
  salePrice: '',
  wholesalePrice: '0',
  currentStock: '0',
  openingStockUnit: 'Piece',
  minStockLevel: '5',
  maxStockLevel: '100',
  baseUnit: 'Piece',
  supplierId: '',
  expiryDate: '',
  packagingUnits: [],
  originType: '',
  bottleSize: '',
  storageLocation: '',
  isReturnable: false,
  returnableUnitName: '',
  depositPerReturnable: '0',
  emptyContainersOnHand: '0',
};

const STANDARD_UNIT_SET = new Set(STANDARD_UNITS.map((u) => u.toLowerCase()));

function toFormPackagingRows(
  units: ProductPackagingUnit[] | undefined,
  baseUnit: string
): PackagingFormRow[] {
  const hydrated = hydrateHierarchicalPackaging(units, baseUnit);
  return hydrated.map((u, idx) => ({
    key: `pkg-${idx}-${u.unitName}`,
    unitName: u.unitName,
    customUnitMode: !STANDARD_UNIT_SET.has((u.unitName || '').trim().toLowerCase()),
    containsQty: String(u.containsQty ?? u.conversionQty),
    parentUnitName: (u.parentUnitName || baseUnit).trim() || baseUnit,
    allowPurchase: u.allowPurchase !== false,
    allowSale: u.allowSale !== false,
    purchasePrice: u.purchasePrice ? String(u.purchasePrice) : '',
    salePrice: u.salePrice ? String(u.salePrice) : '',
    wholesalePrice: u.wholesalePrice ? String(u.wholesalePrice) : '',
    isDefaultPurchase: Boolean(u.isDefaultPurchase),
    isDefaultSale: Boolean(u.isDefaultSale),
  }));
}

function computeDerivedBasePrices(
  rows: PackagingFormRow[],
  baseUnit: string
): {
  purchase: number | null;
  sale: number | null;
  wholesale: number | null;
  sourceUnit: { purchase?: string; sale?: string; wholesale?: string };
  conversionsByKey: Map<string, number>;
} {
  const resolved = resolveCumulativeConversion(
    rows.map((r) => ({
      unitName: r.unitName.trim(),
      containsQty: Number(r.containsQty) || 0,
      parentUnitName: r.parentUnitName || baseUnit,
    })),
    baseUnit
  );

  const conversionsByKey = new Map<string, number>();
  const resolvedRows = rows.map((r) => {
    const conv = resolved.get(r.unitName.trim().toLowerCase())?.conversionQty || 0;
    conversionsByKey.set(r.key, conv);
    return { row: r, conv };
  });

  // Sort ascending by cumulative conversion so smallest configured package derives per-unit cost cleanly
  const sorted = [...resolvedRows]
    .filter((item) => item.conv > 0)
    .sort((a, b) => a.conv - b.conv);

  let purchase: number | null = null;
  let sale: number | null = null;
  let wholesale: number | null = null;
  const sourceUnit: { purchase?: string; sale?: string; wholesale?: string } = {};

  for (const { row, conv } of sorted) {
    const pVal = Number(row.purchasePrice);
    if (purchase === null && Number.isFinite(pVal) && pVal > 0) {
      purchase = roundMoney(pVal / conv);
      sourceUnit.purchase = row.unitName;
    }
    const sVal = Number(row.salePrice);
    if (sale === null && Number.isFinite(sVal) && sVal > 0) {
      sale = roundMoney(sVal / conv);
      sourceUnit.sale = row.unitName;
    }
    const wVal = Number(row.wholesalePrice);
    if (wholesale === null && Number.isFinite(wVal) && wVal > 0) {
      wholesale = roundMoney(wVal / conv);
      sourceUnit.wholesale = row.unitName;
    }
  }

  return { purchase, sale, wholesale, sourceUnit, conversionsByKey };
}

interface ProductsPageProps {
  onOpenCatalogSettings?: () => void;
}

export function ProductsPage({ onOpenCatalogSettings }: ProductsPageProps = {}) {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { products, categories, brands, productTemplates, suppliers, settings } = useShopData();
  const { showToast } = useToast();

  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterSupplier, setFilterSupplier] = useState('');
  const [filterOrigin, setFilterOrigin] = useState<'' | 'local' | 'imported'>('');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);

  const categoryOptions = useMemo<SearchableSelectOption[]>(
    () =>
      categories.map((c) => ({
        value: c.id,
        label: c.name,
        subtitle: c.description || 'Product category',
      })),
    [categories]
  );

  const categoryNameMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories]
  );

  const indexedBrands = useMemo(() => {
    const activeByCategory = new Map<string, typeof brands>();
    const activeAll: typeof brands = [];
    const byId = new Map<string, (typeof brands)[number]>();
    const baseOptionById = new Map<string, SearchableSelectOption>();

    const sorted = [...brands].sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 0; i < sorted.length; i += 1) {
      const b = sorted[i];
      byId.set(b.id, b);
      const active = isBrandActive(b);
      const catNames = (b.categoryIds || [])
        .map((cid) => categoryNameMap.get(cid) || '')
        .filter(Boolean);
      const opt: SearchableSelectOption = {
        value: b.id,
        label: b.name,
        subtitle: formatBrandCategoryNames(b, categoryNameMap, 2),
        badge: active ? undefined : 'Inactive',
        badgeTone: active ? undefined : 'neutral',
        keywords: [b.name, ...catNames],
      };
      baseOptionById.set(b.id, opt);

      if (active) {
        activeAll.push(b);
        const catIds = b.categoryIds || [];
        for (let c = 0; c < catIds.length; c += 1) {
          const cid = catIds[c];
          const list = activeByCategory.get(cid);
          if (list) list.push(b);
          else activeByCategory.set(cid, [b]);
        }
      }
    }

    return {
      activeAll,
      activeByCategory,
      byId,
      baseOptionById,
      allOptions: sorted.map((b) => baseOptionById.get(b.id)!),
    };
  }, [brands, categoryNameMap]);

  const brandOptions = indexedBrands.allOptions;

  const templateSearchIndex = useMemo(
    () => createTemplateSearchIndex(productTemplates),
    [productTemplates]
  );

  const supplierOptions = useMemo<SearchableSelectOption[]>(
    () =>
      suppliers.map((s) => ({
        value: s.id,
        label: s.name,
        subtitle: s.phone ? `Phone: ${s.phone}` : s.address || 'Supplier',
        keywords: [s.name, s.phone, s.address].filter(Boolean),
      })),
    [suppliers]
  );

  const unitOptions = useMemo<SearchableSelectOption[]>(
    () =>
      STANDARD_UNITS.map((u) => ({
        value: u,
        label: u,
        subtitle: isFractionalUnit(u) ? 'Weight / volume unit (supports decimals)' : 'Countable retail / packaging unit',
      })),
    []
  );

  const frequentCategoryIds = useMemo(
    () => computeTopActivityValues(products, (p) => p.categoryId, 5),
    [products]
  );

  const frequentBrandIds = useMemo(
    () => computeTopActivityValues(products, (p) => p.brandId, 5),
    [products]
  );

  const frequentSupplierIds = useMemo(
    () => computeTopActivityValues(products, (p) => p.supplierId, 5),
    [products]
  );

  const frequentUnits = useMemo(
    () => computeTopActivityValues(products, (p) => getEffectiveBaseUnit(p), 5),
    [products]
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductFormState>(emptyForm);
  const [customBaseUnitMode, setCustomBaseUnitMode] = useState(false);
  const [manualBaseOverrides, setManualBaseOverrides] = useState<ManualBaseOverrides>({
    purchase: false,
    sale: false,
    wholesale: false,
  });
  const [showColdDrinkSection, setShowColdDrinkSection] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Quick inline add for Category / Brand / Supplier
  const [quickType, setQuickType] = useState<'category' | 'brand' | 'supplier' | null>(null);
  const [quickName, setQuickName] = useState('');
  const [quickPhone, setQuickPhone] = useState('');
  const [quickBrandCategoryIds, setQuickBrandCategoryIds] = useState<string[]>([]);
  const [filterBrandsByCategory, setFilterBrandsByCategory] = useState(true);

  // Catalog suggestion picker & unknown product template creation
  const [templateSearch, setTemplateSearch] = useState('');
  const [appliedTemplate, setAppliedTemplate] = useState<ProductTemplate | null>(null);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateVariant, setTemplateVariant] = useState('');

  const modalBrandOptions = useMemo<SearchableSelectOption[]>(() => {
    const selectedCatId = form.categoryId;
    const basePool =
      filterBrandsByCategory && selectedCatId
        ? indexedBrands.activeByCategory.get(selectedCatId) || []
        : indexedBrands.activeAll;

    const resultList = [...basePool];
    if (form.brandId && !resultList.some((b) => b.id === form.brandId)) {
      const currentBrand = indexedBrands.byId.get(form.brandId);
      if (currentBrand) resultList.push(currentBrand);
    }

    if (!filterBrandsByCategory && selectedCatId) {
      const catSet = new Set((indexedBrands.activeByCategory.get(selectedCatId) || []).map((b) => b.id));
      resultList.sort((a, b) => {
        const aMatches = catSet.has(a.id);
        const bMatches = catSet.has(b.id);
        if (aMatches !== bMatches) return aMatches ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    return resultList.map((b) => {
      const baseOpt = indexedBrands.baseOptionById.get(b.id)!;
      const active = isBrandActive(b);
      const matchesCat = Boolean(selectedCatId && (b.categoryIds || []).includes(selectedCatId));
      return {
        ...baseOpt,
        badge: !active ? 'Inactive' : matchesCat ? 'In Category' : undefined,
        badgeTone: !active ? 'warning' : matchesCat ? 'success' : undefined,
      };
    });
  }, [indexedBrands, form.categoryId, form.brandId, filterBrandsByCategory]);

  const modalBrandSuggestedIds = useMemo(() => {
    if (!form.categoryId) return frequentBrandIds;
    const categoryMatched = (indexedBrands.activeByCategory.get(form.categoryId) || []).map((b) => b.id);
    const merged: string[] = [];
    for (const id of [...frequentBrandIds, ...categoryMatched]) {
      if (id && !merged.includes(id)) merged.push(id);
      if (merged.length >= 6) break;
    }
    return merged;
  }, [indexedBrands, form.categoryId, frequentBrandIds]);

  const quickBrandExactMatch = useMemo(() => {
    if (quickType !== 'brand' || !quickName.trim()) return null;
    return findExactBrandMatch(quickName, brands);
  }, [quickType, quickName, brands]);

  const quickBrandSimilarMatches = useMemo(() => {
    if (quickType !== 'brand' || !quickName.trim()) return [];
    return findSimilarBrands(quickName, brands, undefined, 4);
  }, [quickType, quickName, brands]);

  const suggestedTemplates = useMemo(() => {
    if (editing) return [];
    return queryTemplateIndex(templateSearchIndex, {
      categoryId: form.categoryId || undefined,
      brandId: form.brandId || undefined,
      query: templateSearch,
    });
  }, [editing, templateSearchIndex, form.categoryId, form.brandId, templateSearch]);

  const existingProductKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const p of products) {
      if (editing && p.id === editing.id) continue;
      const n = p.name.trim().toLowerCase();
      keys.add(`${n}::${p.brandId || ''}`);
      keys.add(n);
    }
    return keys;
  }, [products, editing]);

  const customNameHints = useMemo(() => {
    if (editing || appliedTemplate) return {};
    const trimmed = form.name.trim();
    if (trimmed.length < 3) return {};
    return suggestCategoryAndBrandFromName(trimmed, categories, brands);
  }, [editing, appliedTemplate, form.name, categories, brands]);

  const duplicateProductMatch = useMemo(() => {
    const q = form.name.trim().toLowerCase();
    if (!q) return null;
    return (
      products.find(
        (p) =>
          (!editing || p.id !== editing.id) &&
          p.name.trim().toLowerCase() === q &&
          (!form.brandId || !p.brandId || p.brandId === form.brandId)
      ) || null
    );
  }, [products, form.name, form.brandId, editing]);

  const todayIso = getKarachiDateIso();
  const alertDays = settings?.expiryAlertDays ?? 30;

  const baseUnitOptions = useMemo<SearchableSelectOption[]>(() => {
    const baseLower = form.baseUnit.trim().toLowerCase();
    const list = [...unitOptions];
    if (form.baseUnit.trim() && !STANDARD_UNIT_SET.has(baseLower)) {
      list.unshift({
        value: form.baseUnit.trim(),
        label: form.baseUnit.trim(),
        subtitle: 'Custom stock unit',
      });
    }
    return list;
  }, [unitOptions, form.baseUnit]);

  const packagingCalc = useMemo(
    () => computeDerivedBasePrices(form.packagingUnits, form.baseUnit || 'Piece'),
    [form.packagingUnits, form.baseUnit]
  );

  const openingStockConversion = useMemo(() => {
    const selected = (form.openingStockUnit || form.baseUnit).trim().toLowerCase();
    if (!selected || selected === (form.baseUnit || 'Piece').trim().toLowerCase()) return 1;
    const match = form.packagingUnits.find(
      (r) => r.unitName.trim().toLowerCase() === selected
    );
    if (!match) return 1;
    return packagingCalc.conversionsByKey.get(match.key) || 1;
  }, [form.openingStockUnit, form.baseUnit, form.packagingUnits, packagingCalc]);

  const liveMarginPct = useMemo(
    () => calcProfitMarginPct(Number(form.purchasePrice) || 0, Number(form.salePrice) || 0),
    [form.purchasePrice, form.salePrice]
  );

  const applyAutoPricesToForm = (
    nextForm: ProductFormState,
    overrides: ManualBaseOverrides
  ): ProductFormState => {
    const derived = computeDerivedBasePrices(nextForm.packagingUnits, nextForm.baseUnit || 'Piece');
    return {
      ...nextForm,
      purchasePrice:
        !overrides.purchase && derived.purchase !== null
          ? String(derived.purchase)
          : nextForm.purchasePrice,
      salePrice:
        !overrides.sale && derived.sale !== null
          ? String(derived.sale)
          : nextForm.salePrice,
      wholesalePrice:
        !overrides.wholesale && derived.wholesale !== null
          ? String(derived.wholesale)
          : nextForm.wholesalePrice,
    };
  };

  const openAddModal = () => {
    setEditing(null);
    setForm({
      ...emptyForm,
      categoryId: categories[0]?.id || '',
      brandId: '',
      supplierId: suppliers[0]?.id || '',
    });
    setCustomBaseUnitMode(false);
    setManualBaseOverrides({ purchase: false, sale: false, wholesale: false });
    setFilterBrandsByCategory(true);
    setTemplateSearch('');
    setAppliedTemplate(null);
    setSaveAsTemplate(false);
    setTemplateVariant('');
    setQuickType(null);
    setQuickName('');
    setQuickBrandCategoryIds([]);
    setShowColdDrinkSection(false);
    setError(null);
    setModalOpen(true);
  };

  const openEditModal = (p: Product) => {
    const hasBeverageOrReturnable = Boolean(
      p.bottleSize || p.storageLocation || p.isReturnable
    );
    const effectiveBase = getEffectiveBaseUnit(p);
    const pkgRows = toFormPackagingRows(p.packagingUnits, effectiveBase);
    const derived = computeDerivedBasePrices(pkgRows, effectiveBase);

    setEditing(p);
    setForm({
      name: p.name,
      categoryId: p.categoryId,
      brandId: p.brandId,
      purchasePrice: String(p.purchasePrice),
      salePrice: String(p.salePrice),
      wholesalePrice: String(p.wholesalePrice ?? 0),
      currentStock: String(p.currentStock),
      openingStockUnit: effectiveBase,
      minStockLevel: String(p.minStockLevel),
      maxStockLevel: String(p.maxStockLevel),
      baseUnit: effectiveBase,
      supplierId: p.supplierId,
      expiryDate: p.expiryDate || '',
      packagingUnits: pkgRows,
      originType: p.originType || '',
      bottleSize: p.bottleSize || '',
      storageLocation: p.storageLocation || '',
      isReturnable: Boolean(p.isReturnable),
      returnableUnitName: p.returnableUnitName || '',
      depositPerReturnable: String(p.depositPerReturnable ?? 0),
      emptyContainersOnHand: String(p.emptyContainersOnHand ?? 0),
    });
    setCustomBaseUnitMode(!STANDARD_UNIT_SET.has(effectiveBase.toLowerCase()));
    setManualBaseOverrides({
      purchase:
        derived.purchase !== null && Math.abs((Number(p.purchasePrice) || 0) - derived.purchase) > 0.02,
      sale:
        derived.sale !== null && Math.abs((Number(p.salePrice) || 0) - derived.sale) > 0.02,
      wholesale:
        derived.wholesale !== null && Math.abs((Number(p.wholesalePrice) || 0) - derived.wholesale) > 0.02,
    });
    setShowColdDrinkSection(hasBeverageOrReturnable);
    setFilterBrandsByCategory(true);
    setTemplateSearch('');
    setAppliedTemplate(null);
    setSaveAsTemplate(false);
    setTemplateVariant('');
    setQuickType(null);
    setQuickName('');
    setQuickBrandCategoryIds([]);
    setError(null);
    setModalOpen(true);
  };

  const applyProductTemplate = (tpl: ProductTemplate) => {
    const resolvedCatId =
      categories.find((c) => c.id === tpl.categoryId)?.id ||
      categories.find((c) => c.name.toLowerCase() === tpl.categoryName.toLowerCase())?.id ||
      form.categoryId;

    const resolvedBrandId =
      brands.find((b) => b.id === tpl.brandId)?.id ||
      brands.find((b) => b.name.toLowerCase() === tpl.brandName.toLowerCase())?.id ||
      '';

    const effectiveBase = (tpl.baseUnit || 'Piece').trim() || 'Piece';
    const pkgRows: PackagingFormRow[] = (tpl.packagingUnits || []).map((u, idx) => ({
      key: `tpl-${tpl.id}-${idx}`,
      unitName: u.unitName,
      customUnitMode: !STANDARD_UNIT_SET.has((u.unitName || '').trim().toLowerCase()),
      containsQty: String(u.containsQty ?? u.conversionQty ?? 1),
      parentUnitName: (u.parentUnitName || effectiveBase).trim() || effectiveBase,
      allowPurchase: u.allowPurchase !== false,
      allowSale: u.allowSale !== false,
      purchasePrice: '',
      salePrice: '',
      wholesalePrice: '',
      isDefaultPurchase: Boolean(u.isDefaultPurchase),
      isDefaultSale: Boolean(u.isDefaultSale),
    }));

    setForm((prev) => ({
      ...prev,
      name: tpl.name,
      categoryId: resolvedCatId,
      brandId: resolvedBrandId,
      originType: tpl.originType || '',
      baseUnit: effectiveBase,
      openingStockUnit: effectiveBase,
      packagingUnits: pkgRows,
      purchasePrice:
        tpl.suggestedPurchasePrice !== undefined && tpl.suggestedPurchasePrice > 0
          ? String(tpl.suggestedPurchasePrice)
          : '',
      salePrice:
        tpl.suggestedSalePrice !== undefined && tpl.suggestedSalePrice > 0
          ? String(tpl.suggestedSalePrice)
          : '',
      wholesalePrice:
        tpl.suggestedWholesalePrice !== undefined && tpl.suggestedWholesalePrice > 0
          ? String(tpl.suggestedWholesalePrice)
          : '0',
      bottleSize: tpl.bottleSize || '',
      storageLocation: tpl.storageLocation || '',
      isReturnable: Boolean(tpl.isReturnable),
      returnableUnitName: tpl.returnableUnitName || '',
    }));
    setCustomBaseUnitMode(!STANDARD_UNIT_SET.has(effectiveBase.toLowerCase()));
    setManualBaseOverrides({ purchase: false, sale: false, wholesale: false });
    setShowColdDrinkSection(Boolean(tpl.isReturnable));
    setAppliedTemplate(tpl);
    setSaveAsTemplate(false);
    setTemplateVariant('');
    setError(null);
  };

  const handleBaseUnitChange = (newBaseRaw: string) => {
    const newBase = newBaseRaw.trim() || 'Piece';
    setForm((prev) => {
      const oldBase = prev.baseUnit.trim() || 'Piece';
      const oldBaseLower = oldBase.toLowerCase();
      const nextRows = prev.packagingUnits.map((r) =>
        r.parentUnitName.trim().toLowerCase() === oldBaseLower
          ? { ...r, parentUnitName: newBase }
          : r
      );
      const nextOpeningUnit =
        prev.openingStockUnit.trim().toLowerCase() === oldBaseLower
          ? newBase
          : prev.openingStockUnit;
      const updatedForm: ProductFormState = {
        ...prev,
        baseUnit: newBase,
        openingStockUnit: nextOpeningUnit,
        packagingUnits: nextRows,
      };
      return applyAutoPricesToForm(updatedForm, manualBaseOverrides);
    });
  };

  const handleAddPackagingRow = () => {
    if (form.packagingUnits.length >= MAX_PACKAGING_LEVELS) {
      setError(`Maximum of ${MAX_PACKAGING_LEVELS} packaging levels supported per product.`);
      return;
    }

    const usedUnits = new Set([
      form.baseUnit.toLowerCase(),
      ...form.packagingUnits.map((r) => r.unitName.toLowerCase()),
    ]);
    const preferredOrder = ['Packet', 'Pack', 'Box', 'Carton', 'Crate', 'Dozen', 'Bundle', 'Set'];
    const defaultPick =
      preferredOrder.find((u) => !usedUnits.has(u.toLowerCase())) ||
      STANDARD_UNITS.find((u) => !usedUnits.has(u.toLowerCase())) ||
      `Level ${form.packagingUnits.length + 1}`;

    setForm((prev) => {
      const previousLevel = prev.packagingUnits[prev.packagingUnits.length - 1];
      const defaultParent = previousLevel?.unitName.trim() || prev.baseUnit.trim() || 'Piece';
      return {
        ...prev,
        packagingUnits: [
          ...prev.packagingUnits,
          {
            key: `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            unitName: defaultPick,
            customUnitMode: !STANDARD_UNIT_SET.has(defaultPick.toLowerCase()),
            containsQty: '',
            parentUnitName: defaultParent,
            allowPurchase: true,
            allowSale: true,
            purchasePrice: '',
            salePrice: '',
            wholesalePrice: '',
            isDefaultPurchase: prev.packagingUnits.length === 0,
            isDefaultSale: false,
          },
        ],
      };
    });
  };

  const updatePackagingRow = (key: string, patch: Partial<PackagingFormRow>) => {
    setForm((prev) => {
      const targetBefore = prev.packagingUnits.find((r) => r.key === key);
      const oldNameLower = targetBefore?.unitName.trim().toLowerCase() || '';
      const newName = patch.unitName !== undefined ? patch.unitName : targetBefore?.unitName || '';

      const nextRows = prev.packagingUnits.map((row) => {
        if (row.key === key) {
          return { ...row, ...patch };
        }
        let nextRow = row;
        // Keep default flags exclusive across packaging rows
        if (patch.isDefaultPurchase) {
          nextRow = { ...nextRow, isDefaultPurchase: false };
        }
        if (patch.isDefaultSale) {
          nextRow = { ...nextRow, isDefaultSale: false };
        }
        // Cascade rename if another level references this package as its parentUnitName
        if (
          patch.unitName !== undefined &&
          oldNameLower &&
          nextRow.parentUnitName.trim().toLowerCase() === oldNameLower
        ) {
          nextRow = { ...nextRow, parentUnitName: newName.trim() || prev.baseUnit };
        }
        return nextRow;
      });

      const nextOpeningUnit =
        patch.unitName !== undefined &&
        oldNameLower &&
        prev.openingStockUnit.trim().toLowerCase() === oldNameLower
          ? newName.trim() || prev.baseUnit
          : prev.openingStockUnit;

      return applyAutoPricesToForm(
        {
          ...prev,
          openingStockUnit: nextOpeningUnit,
          packagingUnits: nextRows,
        },
        manualBaseOverrides
      );
    });
  };

  const removePackagingRow = (key: string) => {
    setForm((prev) => {
      const removed = prev.packagingUnits.find((r) => r.key === key);
      const removedNameLower = removed?.unitName.trim().toLowerCase() || '';
      const fallbackParent = removed?.parentUnitName || prev.baseUnit;
      const fallbackContains = Number(removed?.containsQty) || 1;

      const nextRows = prev.packagingUnits
        .filter((r) => r.key !== key)
        .map((row) => {
          if (removedNameLower && row.parentUnitName.trim().toLowerCase() === removedNameLower) {
            const curContains = Number(row.containsQty) || 0;
            return {
              ...row,
              parentUnitName: fallbackParent,
              containsQty:
                curContains > 0 && fallbackContains > 0
                  ? String(roundStockQty(curContains * fallbackContains))
                  : row.containsQty,
            };
          }
          return row;
        });

      const nextOpeningUnit =
        removedNameLower && prev.openingStockUnit.trim().toLowerCase() === removedNameLower
          ? prev.baseUnit
          : prev.openingStockUnit;

      return applyAutoPricesToForm(
        {
          ...prev,
          openingStockUnit: nextOpeningUnit,
          packagingUnits: nextRows,
        },
        manualBaseOverrides
      );
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId) return;
    setError(null);

    if (!form.name.trim()) {
      setError('Product name is required.');
      return;
    }

    const baseUnit = form.baseUnit.trim() || 'Piece';
    const seenUnits = new Set<string>([baseUnit.toLowerCase()]);

    for (const pkg of form.packagingUnits) {
      const unitName = pkg.unitName.trim();
      const contains = Number(pkg.containsQty);
      if (!unitName) {
        setError('Each packaging level must specify a Package Name.');
        return;
      }
      if (seenUnits.has(unitName.toLowerCase())) {
        setError(`Duplicate unit "${unitName}" in packaging configuration.`);
        return;
      }
      if (!Number.isFinite(contains) || contains <= 0) {
        setError(`Enter how many ${pkg.parentUnitName || baseUnit}s are inside 1 ${unitName} (> 0).`);
        return;
      }
      seenUnits.add(unitName.toLowerCase());
    }

    const hierarchyMap = resolveCumulativeConversion(
      form.packagingUnits.map((r) => ({
        unitName: r.unitName.trim(),
        containsQty: Number(r.containsQty) || 0,
        parentUnitName: r.parentUnitName.trim() || baseUnit,
      })),
      baseUnit
    );

    const packagingUnits: ProductPackagingUnit[] = [];
    for (const pkg of form.packagingUnits) {
      const unitName = pkg.unitName.trim();
      const resolved = hierarchyMap.get(unitName.toLowerCase());
      if (!resolved || resolved.conversionQty <= 0) {
        setError(`Could not resolve conversion for ${unitName}. Check parent packaging chain.`);
        return;
      }
      packagingUnits.push({
        unitName,
        conversionQty: resolved.conversionQty,
        containsQty: resolved.containsQty,
        parentUnitName: resolved.parentUnitName,
        allowPurchase: pkg.allowPurchase,
        allowSale: pkg.allowSale,
        purchasePrice: Math.max(0, Number(pkg.purchasePrice) || 0),
        salePrice: Math.max(0, Number(pkg.salePrice) || 0),
        wholesalePrice: Math.max(0, Number(pkg.wholesalePrice) || 0),
        isDefaultPurchase: pkg.isDefaultPurchase,
        isDefaultSale: pkg.isDefaultSale,
      });
    }

    const fallbackOtherCat = categories.find(
      (c) => c.id === 'cat_other' || normalizeCategoryKey(c.name) === 'other products'
    );
    const cat = categories.find((c) => c.id === form.categoryId) || fallbackOtherCat;
    const brand = brands.find((b) => b.id === form.brandId);
    const sup = suppliers.find((s) => s.id === form.supplierId);

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        categoryId: cat?.id || '',
        categoryName: cat?.name || 'Other Products',
        brandId: brand?.id || '',
        brandName: brand?.name || 'Generic',
        purchasePrice: Number(form.purchasePrice) || 0,
        salePrice: Number(form.salePrice) || 0,
        wholesalePrice: Number(form.wholesalePrice) || 0,
        minStockLevel: Number(form.minStockLevel) || 0,
        maxStockLevel: Number(form.maxStockLevel) || 0,
        unit: baseUnit,
        baseUnit,
        packagingUnits,
        originType: form.originType,
        bottleSize: form.bottleSize.trim(),
        storageLocation: form.storageLocation.trim(),
        isReturnable: form.isReturnable,
        returnableUnitName: form.isReturnable ? form.returnableUnitName.trim() : '',
        depositPerReturnable: form.isReturnable ? Math.max(0, Number(form.depositPerReturnable) || 0) : 0,
        emptyContainersOnHand: form.isReturnable ? Math.max(0, Number(form.emptyContainersOnHand) || 0) : 0,
        supplierId: sup?.id || '',
        supplierName: sup?.name || 'Walk-in / Direct',
        expiryDate: form.expiryDate || '',
        isActive: true,
      };

      if (editing) {
        await updateProduct(activeShopId, editing.id, payload);
        showToast({ title: 'Product updated', message: payload.name, tone: 'success' });
      } else {
        const openingBaseQty = roundStockQty(
          Math.max(0, Number(form.currentStock) || 0) * (openingStockConversion || 1)
        );
        await createProduct(activeShopId, {
          ...payload,
          currentStock: openingBaseQty,
        });

        let savedToCatalog = false;
        if (saveAsTemplate) {
          const candKey = normalizeTemplateKey(
            payload.categoryId,
            payload.brandId,
            payload.name,
            templateVariant
          );
          const alreadyExists = productTemplates.some(
            (t) =>
              normalizeTemplateKey(t.categoryId, t.brandId, t.name, t.variant) === candKey
          );
          if (!alreadyExists) {
            try {
              await createProductTemplate(activeShopId, {
                name: payload.name,
                categoryId: payload.categoryId,
                categoryName: payload.categoryName,
                brandId: payload.brandId,
                brandName: payload.brandName,
                variant: templateVariant.trim(),
                originType: payload.originType,
                baseUnit: payload.baseUnit,
                defaultPurchaseUnit:
                  payload.packagingUnits.find((u) => u.isDefaultPurchase)?.unitName ||
                  payload.baseUnit,
                defaultSaleUnit:
                  payload.packagingUnits.find((u) => u.isDefaultSale)?.unitName ||
                  payload.baseUnit,
                packagingUnits: payload.packagingUnits.map((u) => ({
                  unitName: u.unitName,
                  containsQty: u.containsQty || u.conversionQty,
                  parentUnitName: u.parentUnitName || payload.baseUnit,
                  conversionQty: u.conversionQty,
                  allowPurchase: u.allowPurchase,
                  allowSale: u.allowSale,
                  isDefaultPurchase: u.isDefaultPurchase,
                  isDefaultSale: u.isDefaultSale,
                  needsConfirmation: false,
                })),
                hasUnconfirmedPackaging: false,
                suggestedPurchasePrice:
                  payload.purchasePrice > 0 ? payload.purchasePrice : undefined,
                suggestedSalePrice: payload.salePrice > 0 ? payload.salePrice : undefined,
                priceSource:
                  payload.salePrice > 0 || payload.purchasePrice > 0
                    ? 'Saved from Shop Product'
                    : undefined,
                bottleSize: payload.bottleSize,
                storageLocation: payload.storageLocation,
                isReturnable: payload.isReturnable,
                returnableUnitName: payload.returnableUnitName,
                trackExpiry: Boolean(payload.expiryDate),
                isActive: true,
                isCustom: true,
              });
              savedToCatalog = true;
            } catch (tplErr) {
              console.warn('Catalog template creation skipped:', tplErr);
            }
          }
        }

        showToast({
          title: 'Product added',
          message: savedToCatalog
            ? `${payload.name} (also saved to Catalog Suggestions)`
            : payload.name,
          tone: 'success',
        });
      }
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save product.');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickCreate = async () => {
    if (!activeShopId || !quickName.trim()) return;
    try {
      if (quickType === 'category') {
        const trimmed = quickName.trim();
        if (isImportedCategoryName(trimmed)) {
          showToast({
            title: 'Use Product Origin instead',
            message: 'Select "Imported" in Origin Classification rather than creating an Imported category.',
            tone: 'info',
          });
          setQuickName('');
          setQuickType(null);
          return;
        }
        const canonicalName = resolveCanonicalCategoryName(trimmed);
        const canonicalKey = normalizeCategoryKey(canonicalName);
        const existingCat = categories.find(
          (c) => normalizeCategoryKey(resolveCanonicalCategoryName(c.name)) === canonicalKey
        );
        if (existingCat) {
          setForm((f) => ({ ...f, categoryId: existingCat.id }));
          showToast({
            title: 'Existing category selected',
            message: `Using "${existingCat.name}".`,
            tone: 'info',
            durationMs: 3000,
          });
        } else {
          const id = await createCategory(activeShopId, canonicalName, '');
          setForm((f) => ({ ...f, categoryId: id }));
        }
      } else if (quickType === 'brand') {
        const trimmedBrand = quickName.trim().replace(/\s+/g, ' ');
        if (quickBrandExactMatch) {
          setForm((f) => ({ ...f, brandId: quickBrandExactMatch.id }));
          showToast({
            title: 'Existing brand selected',
            message: `Using "${quickBrandExactMatch.name}" to prevent duplicate brands.`,
            tone: 'info',
            durationMs: 3500,
          });
          setQuickName('');
          setQuickBrandCategoryIds([]);
          setQuickType(null);
          return;
        }
        const id = await createBrand(activeShopId, {
          name: trimmedBrand,
          categoryIds: quickBrandCategoryIds,
          isActive: true,
        });
        setForm((f) => ({ ...f, brandId: id }));
        showToast({
          title: 'Brand added to library',
          message: `"${trimmedBrand}" is now available across products.`,
          tone: 'success',
          durationMs: 3000,
        });
      } else if (quickType === 'supplier') {
        const id = await createSupplier(activeShopId, {
          name: quickName,
          phone: quickPhone,
          address: '',
          notes: '',
        });
        setForm((f) => ({ ...f, supplierId: id }));
      }
      setQuickName('');
      setQuickPhone('');
      setQuickBrandCategoryIds([]);
      setQuickType(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create item.';
      setError(msg);
      showToast({ title: 'Could not add item', message: msg, tone: 'error' });
    }
  };

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (filterCat && p.categoryId !== filterCat) return false;
      if (filterBrand && p.brandId !== filterBrand) return false;
      if (filterSupplier && p.supplierId !== filterSupplier) return false;
      if (filterOrigin && (p.originType || '') !== filterOrigin) return false;
      if (q) {
        const hay = `${p.name} ${p.categoryName} ${p.brandName} ${p.supplierName} ${p.originType || ''} ${p.bottleSize || ''} ${p.storageLocation || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [products, search, filterCat, filterBrand, filterSupplier, filterOrigin]);

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="cm-surface border rounded-xl p-3 sm:p-4 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-4 h-4 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search products, brand, supplier, size..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="cm-input w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowMobileFilters((v) => !v)}
              className="lg:hidden min-h-[40px] inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-[var(--cm-text-secondary)] bg-[var(--cm-bg-subtle)] hover:bg-[var(--cm-bg-hover)] border border-[var(--cm-border)] rounded-lg cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>{showMobileFilters ? 'Hide' : 'Filters'}</span>
            </button>
            <button
              type="button"
              onClick={openAddModal}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs sm:text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add Product</span>
            </button>
          </div>
        </div>

        <div
          className={`${
            showMobileFilters ? 'grid' : 'hidden lg:grid'
          } grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2`}
        >
          <SearchableSelect
            size="sm"
            ariaLabel="Filter by category"
            suggestionScope="category"
            suggestedValues={frequentCategoryIds}
            options={categoryOptions}
            value={filterCat}
            onChange={setFilterCat}
            emptyOptionLabel="All Categories"
            placeholder="All Categories"
            searchPlaceholder="Search category..."
          />
          <SearchableSelect
            size="sm"
            ariaLabel="Filter by brand"
            suggestionScope="brand"
            suggestedValues={frequentBrandIds}
            options={brandOptions}
            value={filterBrand}
            onChange={setFilterBrand}
            emptyOptionLabel="All Brands"
            placeholder="All Brands"
            searchPlaceholder="Search brand..."
          />
          <SearchableSelect
            size="sm"
            ariaLabel="Filter by supplier"
            suggestionScope="supplier"
            suggestedValues={frequentSupplierIds}
            options={supplierOptions}
            value={filterSupplier}
            onChange={setFilterSupplier}
            emptyOptionLabel="All Suppliers"
            placeholder="All Suppliers"
            searchPlaceholder="Search supplier..."
          />
          <select
            aria-label="Filter by origin"
            value={filterOrigin}
            onChange={(e) => setFilterOrigin(e.target.value as '' | 'local' | 'imported')}
            className="cm-input w-full min-h-[36px] px-2.5 py-1.5 text-xs sm:text-sm border rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
          >
            <option value="">All Origins (Local / Imported)</option>
            <option value="local">Local Products</option>
            <option value="imported">Imported Products</option>
          </select>
        </div>
      </div>

      {/* Product List */}
      <section className="cm-surface border rounded-xl overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-[var(--cm-border)] flex items-center justify-between text-xs text-[var(--cm-text-muted)]">
          <span className="font-semibold text-[var(--cm-text-primary)]">Product Catalog</span>
          <div className="flex items-center gap-3">
            {onOpenCatalogSettings && (
              <button
                type="button"
                onClick={onOpenCatalogSettings}
                className="text-[11px] font-medium text-[var(--cm-accent-text)] hover:underline cursor-pointer"
              >
                Manage Catalog Templates
              </button>
            )}
            <span className="font-mono-num">{filteredProducts.length} products</span>
          </div>
        </div>

        {filteredProducts.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm text-[var(--cm-text-muted)]">
              {products.length === 0
                ? 'No products added yet. Add diapers, baby wipes, cold drinks, snacks, or toiletries to begin.'
                : 'No products match your search filters.'}
            </p>
            {products.length === 0 && (
              <button
                type="button"
                onClick={openAddModal}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add First Product
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Mobile Compact Expandable List */}
            <div className="md:hidden divide-y divide-[var(--cm-border)]">
              {filteredProducts.map((p) => {
                const st = getProductStockStatus(p, todayIso, alertDays);
                const bd = formatStockBreakdown(p.currentStock, p);
                const stockClass = st.isOutOfStock
                  ? 'text-[var(--cm-danger)] font-semibold'
                  : st.isLowStock
                    ? 'text-[var(--cm-warning)] font-semibold'
                    : 'text-[var(--cm-success)]';

                return (
                  <CompactExpandableRow
                    key={p.id}
                    title={
                      <span className="inline-flex items-center gap-1.5 flex-wrap">
                        <span>{p.name}</span>
                        {p.bottleSize && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--cm-info-soft)] text-[var(--cm-info)] font-mono-num">
                            {p.bottleSize}
                          </span>
                        )}
                      </span>
                    }
                    subtitle={[
                      p.categoryName,
                      p.brandName,
                      p.originType === 'imported'
                        ? 'Imported'
                        : p.originType === 'local'
                          ? 'Local'
                          : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    rightPrimary={`${formatPKR(p.salePrice)}/${bd.baseUnit}`}
                    rightSecondary={<span className={stockClass}>{bd.summaryText}</span>}
                    isExpanded={expandedProductId === p.id}
                    onToggle={() =>
                      setExpandedProductId((cur) => (cur === p.id ? null : p.id))
                    }
                    expandedContent={
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <span className="text-[var(--cm-text-muted)]">Base Cost:</span>{' '}
                            <span className="font-mono-num font-medium text-[var(--cm-text-primary)]">
                              {formatPKR(p.purchasePrice)}/{bd.baseUnit}
                            </span>
                          </div>
                          <div>
                            <span className="text-[var(--cm-text-muted)]">Margin:</span>{' '}
                            <span className="font-mono-num font-semibold text-[var(--cm-success)]">
                              {p.profitMarginPct}%
                            </span>
                          </div>
                          <div>
                            <span className="text-[var(--cm-text-muted)]">Supplier:</span>{' '}
                            <span className="text-[var(--cm-text-primary)]">{p.supplierName || '—'}</span>
                          </div>
                          <div>
                            <span className="text-[var(--cm-text-muted)]">Expiry:</span>{' '}
                            <span className="font-mono-num text-[var(--cm-text-primary)]">
                              {p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—'}
                            </span>
                          </div>
                          {p.storageLocation && (
                            <div>
                              <span className="text-[var(--cm-text-muted)]">Location:</span>{' '}
                              <span className="text-[var(--cm-text-primary)]">{p.storageLocation}</span>
                            </div>
                          )}
                          {p.isReturnable && (
                            <div>
                              <span className="text-[var(--cm-text-muted)]">Empty Empties:</span>{' '}
                              <span className="font-mono-num text-[var(--cm-text-primary)]">
                                {formatNumber(p.emptyContainersOnHand || 0)} {p.returnableUnitName || 'Crate'}
                              </span>
                            </div>
                          )}
                        </div>

                        {Array.isArray(p.packagingUnits) && p.packagingUnits.length > 0 && (
                          <div className="pt-1.5 border-t border-[var(--cm-border)] space-y-1">
                            <div className="text-[11px] font-semibold text-[var(--cm-text-secondary)]">
                              Packaging Levels
                            </div>
                            <div className="grid grid-cols-1 gap-1">
                              {p.packagingUnits.map((pkg) => {
                                const hasParentChain =
                                  pkg.containsQty &&
                                  pkg.parentUnitName &&
                                  pkg.parentUnitName.toLowerCase() !== bd.baseUnit.toLowerCase();
                                return (
                                  <div
                                    key={pkg.unitName}
                                    className="px-2 py-1 rounded cm-surface border text-[11px] flex items-center justify-between gap-2"
                                  >
                                    <span className="font-medium text-[var(--cm-text-primary)]">
                                      {hasParentChain
                                        ? `1 ${pkg.unitName} = ${formatNumber(pkg.containsQty!)} ${pluralizeUnit(pkg.parentUnitName!, pkg.containsQty!)} (${formatNumber(pkg.conversionQty)} ${pluralizeUnit(bd.baseUnit, pkg.conversionQty)})`
                                        : `1 ${pkg.unitName} = ${formatNumber(pkg.conversionQty)} ${pluralizeUnit(bd.baseUnit, pkg.conversionQty)}`}
                                    </span>
                                    <span className="font-mono-num text-[var(--cm-text-secondary)]">
                                      Buy {formatPKR(pkg.purchasePrice)} · Sell {formatPKR(pkg.salePrice)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        <div className="flex items-center justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => openEditModal(p)}
                            className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-[var(--cm-text-primary)] cm-surface border rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (activeShopId) {
                                void deleteProduct(activeShopId, p);
                                showToast({ title: 'Product deleted', message: p.name, tone: 'info' });
                              }
                            }}
                            className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-[var(--cm-danger)] bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete</span>
                          </button>
                        </div>
                      </div>
                    }
                  />
                );
              })}
            </div>

            {/* Desktop Dense Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                    <th className="py-2.5 px-3">Product Name</th>
                    <th className="py-2.5 px-3">Category · Brand</th>
                    <th className="py-2.5 px-3">Packaging</th>
                    <th className="py-2.5 px-3 text-right">Base Cost</th>
                    <th className="py-2.5 px-3 text-right">Base Sale</th>
                    <th className="py-2.5 px-3 text-right">Margin</th>
                    <th className="py-2.5 px-3 text-right">Stock</th>
                    <th className="py-2.5 px-3">Expiry</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                  {filteredProducts.map((p) => {
                    const st = getProductStockStatus(p, todayIso, alertDays);
                    const bd = formatStockBreakdown(p.currentStock, p);
                    const stockClass = st.isOutOfStock
                      ? 'text-[var(--cm-danger)] font-semibold'
                      : st.isLowStock
                        ? 'text-[var(--cm-warning)] font-semibold'
                        : 'text-[var(--cm-text-primary)]';

                    return (
                      <tr key={p.id} className="hover:bg-[var(--cm-bg-hover)]">
                        <td className="py-2 px-3">
                          <div className="font-medium text-[var(--cm-text-primary)]">{p.name}</div>
                          {(p.bottleSize || p.storageLocation || p.originType || p.isReturnable) && (
                            <div className="flex flex-wrap items-center gap-1 mt-0.5 text-[10px]">
                              {p.bottleSize && (
                                <span className="px-1.5 py-0.2 rounded bg-[var(--cm-info-soft)] text-[var(--cm-info)] font-mono-num">
                                  {p.bottleSize}
                                </span>
                              )}
                              {p.originType && (
                                <span className="px-1.5 py-0.2 rounded bg-[var(--cm-bg-subtle)] text-[var(--cm-text-secondary)] capitalize">
                                  {p.originType}
                                </span>
                              )}
                              {p.storageLocation && (
                                <span className="text-[var(--cm-text-muted)]">{p.storageLocation}</span>
                              )}
                              {p.isReturnable && (
                                <span className="px-1.5 py-0.2 rounded bg-[var(--cm-warning-soft)] text-[var(--cm-warning)] font-mono-num">
                                  Empties: {formatNumber(p.emptyContainersOnHand || 0)}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-xs text-[var(--cm-text-muted)]">
                          <div>{p.categoryName} · {p.brandName}</div>
                          <div className="text-[11px]">{p.supplierName || '—'}</div>
                        </td>
                        <td className="py-2 px-3 text-xs">
                          <div className="font-medium text-[var(--cm-text-secondary)]">
                            Smallest Unit: {bd.baseUnit}
                          </div>
                          {Array.isArray(p.packagingUnits) && p.packagingUnits.length > 0 && (
                            <div className="text-[11px] text-[var(--cm-text-muted)] space-y-0.5">
                              {p.packagingUnits.slice(0, 2).map((pkg) => {
                                const hasParentChain =
                                  pkg.containsQty &&
                                  pkg.parentUnitName &&
                                  pkg.parentUnitName.toLowerCase() !== bd.baseUnit.toLowerCase();
                                return (
                                  <div key={pkg.unitName} className="font-mono-num">
                                    {hasParentChain
                                      ? `1 ${pkg.unitName} = ${formatNumber(pkg.containsQty!)} ${pluralizeUnit(pkg.parentUnitName!, pkg.containsQty!)} (${formatNumber(pkg.conversionQty)})`
                                      : `1 ${pkg.unitName} = ${formatNumber(pkg.conversionQty)} ${pluralizeUnit(bd.baseUnit, pkg.conversionQty)}`}{' '}
                                    · {formatPKR(pkg.salePrice)}
                                  </div>
                                );
                              })}
                              {p.packagingUnits.length > 2 && (
                                <div className="text-[10px] text-[var(--cm-accent-text)]">
                                  +{p.packagingUnits.length - 2} more levels
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-text-secondary)] whitespace-nowrap">
                          {formatPKR(p.purchasePrice)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num font-semibold text-[var(--cm-text-primary)] whitespace-nowrap">
                          {formatPKR(p.salePrice)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num text-[var(--cm-success)]">
                          {p.profitMarginPct}%
                        </td>
                        <td className={`py-2 px-3 text-right font-mono-num whitespace-nowrap ${stockClass}`}>
                          <div>{bd.totalLabel}</div>
                          {bd.packageBreakdownText && (
                            <div className="text-[11px] font-normal text-[var(--cm-text-muted)]">
                              ({bd.packageBreakdownText})
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 font-mono-num text-xs">
                          {p.expiryDate ? (
                            <span
                              className={
                                st.isExpired
                                  ? 'text-[var(--cm-danger)] font-semibold'
                                  : st.isNearingExpiry
                                    ? 'text-[var(--cm-warning)] font-semibold'
                                    : 'text-[var(--cm-text-secondary)]'
                              }
                            >
                              {formatDateDDMMYYYY(p.expiryDate)}
                            </span>
                          ) : (
                            <span className="text-[var(--cm-text-muted)]">—</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openEditModal(p)}
                              className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-accent-text)] rounded cursor-pointer"
                              title="Edit product"
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => activeShopId && void deleteProduct(activeShopId, p)}
                              className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] rounded cursor-pointer"
                              title="Delete product"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {/* Add / Edit Product Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-[var(--cm-bg-overlay)] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="cm-surface border rounded-t-2xl sm:rounded-xl w-full max-w-3xl max-h-[94vh] flex flex-col shadow-xl">
            <div className="px-4 py-3 sm:px-5 border-b border-[var(--cm-border)] flex items-center justify-between shrink-0">
              <h3 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">
                {editing ? 'Edit Product & Packaging' : 'Add New Product & Packaging'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
              <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1">
                {error && (
                  <div className="p-3 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg text-xs sm:text-sm text-[var(--cm-danger)]">
                    {error}
                  </div>
                )}

                {/* Step 1: Category & Brand + Catalog Product Suggestions */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-[var(--cm-text-secondary)]">
                        1. Category
                      </label>
                      <button
                        type="button"
                        onClick={() => setQuickType('category')}
                        className="text-xs text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                      >
                        + New
                      </button>
                    </div>
                    <SearchableSelect
                      ariaLabel="Select category"
                      suggestionScope="category"
                      suggestedValues={frequentCategoryIds}
                      options={categoryOptions}
                      value={form.categoryId}
                      onChange={(val) => {
                        setForm((prev) => {
                          let nextBrandId = prev.brandId;
                          if (val && nextBrandId && filterBrandsByCategory) {
                            const br = brands.find((b) => b.id === nextBrandId);
                            if (br && !(br.categoryIds || []).includes(val)) {
                              nextBrandId = '';
                            }
                          }
                          return { ...prev, categoryId: val, brandId: nextBrandId };
                        });
                      }}
                      emptyOptionLabel="All Categories / Other"
                      placeholder="Search category..."
                      searchPlaceholder="Type category name..."
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <label className="text-xs font-medium text-[var(--cm-text-secondary)]">
                        2. Brand
                      </label>
                      <div className="flex items-center gap-2">
                        {form.categoryId && (
                          <button
                            type="button"
                            onClick={() => setFilterBrandsByCategory((prev) => !prev)}
                            className={`text-[11px] font-medium px-1.5 py-0.5 rounded border cursor-pointer transition-colors ${
                              filterBrandsByCategory
                                ? 'bg-[var(--cm-accent-soft)] text-[var(--cm-accent-text)] border-[var(--cm-accent-border)]'
                                : 'text-[var(--cm-text-muted)] border-[var(--cm-border)] hover:text-[var(--cm-text-primary)]'
                            }`}
                            title="Show only brands associated with the selected category"
                          >
                            {filterBrandsByCategory ? 'Category Only' : 'All Brands'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setQuickType('brand');
                            setQuickName('');
                            setQuickBrandCategoryIds(form.categoryId ? [form.categoryId] : []);
                          }}
                          className="text-xs text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                        >
                          + New
                        </button>
                      </div>
                    </div>
                    <SearchableSelect
                      ariaLabel="Select brand"
                      suggestionScope="brand"
                      suggestedValues={modalBrandSuggestedIds}
                      options={modalBrandOptions}
                      value={form.brandId}
                      onChange={(val) => setForm((prev) => ({ ...prev, brandId: val }))}
                      emptyOptionLabel="Generic / Unbranded"
                      placeholder="Search brand..."
                      searchPlaceholder="Type brand name (or choose Generic)..."
                      createFromQueryLabel="Add brand"
                      onCreateFromQuery={(typed) => {
                        setQuickType('brand');
                        setQuickName(typed);
                        setQuickBrandCategoryIds(form.categoryId ? [form.categoryId] : []);
                      }}
                    />
                  </div>
                </div>

                {/* One-Tap Catalog Suggestions (Add Mode) */}
                {!editing && (
                  <div className="p-3 cm-subtle border rounded-xl space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-[var(--cm-accent-text)] shrink-0" />
                        <span className="text-xs font-semibold text-[var(--cm-text-primary)]">
                          Suggested Catalog Products ({suggestedTemplates.length})
                        </span>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <span className="text-[11px] text-[var(--cm-text-muted)]">
                          Tap a product to auto-fill
                        </span>
                        {onOpenCatalogSettings && (
                          <button
                            type="button"
                            onClick={() => {
                              setModalOpen(false);
                              onOpenCatalogSettings();
                            }}
                            className="text-[11px] font-medium text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                          >
                            Manage Catalog
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-[var(--cm-text-muted)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        placeholder="Search suggestions by product, size, variant (e.g. Molfix 50, Pepsi 1.5L, Lifebuoy)..."
                        value={templateSearch}
                        onChange={(e) => setTemplateSearch(e.target.value)}
                        className="cm-input w-full pl-8 pr-7 py-1.5 text-xs sm:text-sm border rounded-lg"
                      />
                      {templateSearch && (
                        <button
                          type="button"
                          onClick={() => setTemplateSearch('')}
                          aria-label="Clear suggestion search"
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    {appliedTemplate && (
                      <div className="p-2.5 cm-surface border border-[var(--cm-accent-border)] rounded-lg space-y-1 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--cm-accent-text)]">
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            Auto-filled: {appliedTemplate.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => setAppliedTemplate(null)}
                            className="text-[11px] text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
                          >
                            Dismiss
                          </button>
                        </div>
                        {appliedTemplate.hasUnconfirmedPackaging && (
                          <div className="flex items-start gap-1.5 text-[11px] text-[var(--cm-warning)]">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span>
                              Pack count is estimated — please verify the packaging quantity below before saving.
                            </span>
                          </div>
                        )}
                        {appliedTemplate.suggestedSalePrice !== undefined &&
                          appliedTemplate.suggestedSalePrice > 0 && (
                            <div className="text-[11px] text-[var(--cm-text-muted)]">
                              Price pre-filled as editable estimate ({appliedTemplate.priceSource || 'Market Est.'}). Verify supplier cost &amp; retail price.
                            </div>
                          )}
                      </div>
                    )}

                    <div className="max-h-44 overflow-y-auto divide-y divide-[var(--cm-border)] cm-surface border border-[var(--cm-border)] rounded-lg">
                      {suggestedTemplates.length === 0 ? (
                        <div className="p-3 text-center space-y-2">
                          <p className="text-xs text-[var(--cm-text-muted)]">
                            No catalog match{form.categoryId || form.brandId ? ' in this Category/Brand filter' : ''}. Type the product name below or use your search query directly.
                          </p>
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            {templateSearch.trim() && (
                              <button
                                type="button"
                                onClick={() => {
                                  const typed = templateSearch.trim();
                                  const hints = suggestCategoryAndBrandFromName(
                                    typed,
                                    categories,
                                    brands
                                  );
                                  setForm((prev) => ({
                                    ...prev,
                                    name: typed,
                                    categoryId: prev.categoryId || hints.categoryId || '',
                                    brandId: prev.brandId || hints.brandId || '',
                                  }));
                                  setAppliedTemplate(null);
                                  setSaveAsTemplate(true);
                                }}
                                className="px-2.5 py-1 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-md cursor-pointer"
                              >
                                Use &ldquo;{templateSearch.trim()}&rdquo; as New Product
                              </button>
                            )}
                            {(form.categoryId || form.brandId) && (
                              <button
                                type="button"
                                onClick={() =>
                                  setForm((prev) => ({ ...prev, categoryId: '', brandId: '' }))
                                }
                                className="px-2.5 py-1 text-xs font-medium cm-subtle border rounded-md text-[var(--cm-text-secondary)] cursor-pointer"
                              >
                                Search Across All Categories &amp; Brands
                              </button>
                            )}
                          </div>
                        </div>
                      ) : (
                        suggestedTemplates.slice(0, 40).map((tpl) => {
                          const packHint = (tpl.packagingUnits || [])
                            .slice(0, 1)
                            .map(
                              (u) =>
                                `1 ${u.unitName} = ${formatNumber(u.containsQty)} ${pluralizeUnit(
                                  u.parentUnitName || tpl.baseUnit,
                                  u.containsQty
                                )}`
                            )
                            .join('');
                          const alreadyAdded =
                            existingProductKeys.has(
                              `${tpl.name.trim().toLowerCase()}::${tpl.brandId || ''}`
                            ) || existingProductKeys.has(tpl.name.trim().toLowerCase());
                          const isSelected = appliedTemplate?.id === tpl.id;

                          return (
                            <button
                              key={tpl.id}
                              type="button"
                              onClick={() => applyProductTemplate(tpl)}
                              className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 hover:bg-[var(--cm-bg-hover)] transition-colors cursor-pointer ${
                                isSelected ? 'bg-[var(--cm-accent-soft)]' : ''
                              }`}
                            >
                              <div className="min-w-0 flex-1 space-y-0.5">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-xs font-semibold text-[var(--cm-text-primary)]">
                                    {tpl.name}
                                  </span>
                                  {tpl.variant && (
                                    <span className="text-[10px] px-1.5 py-0.2 rounded cm-subtle border border-[var(--cm-border)] text-[var(--cm-text-secondary)]">
                                      {tpl.variant}
                                    </span>
                                  )}
                                  {tpl.originType && (
                                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-[var(--cm-info-soft)] text-[var(--cm-info)] capitalize">
                                      {tpl.originType}
                                    </span>
                                  )}
                                  {alreadyAdded && (
                                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-[var(--cm-success-soft)] text-[var(--cm-success)]">
                                      In Shop
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] text-[var(--cm-text-muted)] flex flex-wrap items-center gap-x-2">
                                  <span>
                                    {tpl.brandName} · Base: {tpl.baseUnit}
                                  </span>
                                  {packHint && (
                                    <span className="font-mono-num">{packHint}</span>
                                  )}
                                  {tpl.hasUnconfirmedPackaging && (
                                    <span className="text-[var(--cm-warning)] font-medium">
                                      · Confirm pack qty
                                    </span>
                                  )}
                                </div>
                              </div>

                              <div className="text-right shrink-0">
                                {tpl.suggestedSalePrice !== undefined &&
                                tpl.suggestedSalePrice > 0 ? (
                                  <div className="text-[11px] font-mono-num font-semibold text-[var(--cm-accent-text)]">
                                    ~{formatPKR(tpl.suggestedSalePrice)}/{tpl.baseUnit}
                                    <span className="block text-[9px] font-normal text-[var(--cm-text-muted)]">
                                      Est. Retail
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-[11px] font-medium text-[var(--cm-accent-text)]">
                                    Select →
                                  </span>
                                )}
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}

                {/* Product Name & Core Meta */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2 space-y-1.5">
                    <label className="block text-xs font-medium text-[var(--cm-text-secondary)]">
                      3. Product Name *
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={180}
                      placeholder="Auto-filled from suggestion above, or type a custom product name..."
                      value={form.name}
                      onChange={(e) => {
                        setForm({ ...form, name: e.target.value });
                        if (appliedTemplate && e.target.value !== appliedTemplate.name) {
                          setAppliedTemplate(null);
                        }
                      }}
                      className="cm-input w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
                    />

                    {duplicateProductMatch && (
                      <div className="text-[11px] text-[var(--cm-warning)] flex items-center gap-1.5">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        <span>
                          A product named &ldquo;{duplicateProductMatch.name}&rdquo; already exists in your inventory.
                        </span>
                      </div>
                    )}

                    {!editing &&
                      !appliedTemplate &&
                      (customNameHints.categoryId || customNameHints.brandId) &&
                      (customNameHints.categoryId !== form.categoryId ||
                        (customNameHints.brandId && customNameHints.brandId !== form.brandId)) && (
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--cm-text-secondary)]">
                          <span>Smart match:</span>
                          <button
                            type="button"
                            onClick={() =>
                              setForm((prev) => ({
                                ...prev,
                                categoryId: customNameHints.categoryId || prev.categoryId,
                                brandId: customNameHints.brandId || prev.brandId,
                              }))
                            }
                            className="px-2 py-0.5 rounded bg-[var(--cm-accent-soft)] text-[var(--cm-accent-text)] border border-[var(--cm-accent-border)] font-medium cursor-pointer"
                          >
                            Apply{' '}
                            {[
                              customNameHints.categoryId
                                ? categoryNameMap.get(customNameHints.categoryId)
                                : '',
                              customNameHints.brandId
                                ? brands.find((b) => b.id === customNameHints.brandId)?.name
                                : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </button>
                        </div>
                      )}

                    {!editing && !appliedTemplate && form.name.trim().length > 0 && (
                      <div className="p-2 cm-subtle border rounded-lg flex flex-wrap items-center justify-between gap-2">
                        <label className="inline-flex items-center gap-2 text-[11px] text-[var(--cm-text-secondary)] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={saveAsTemplate}
                            onChange={(e) => setSaveAsTemplate(e.target.checked)}
                            className="accent-[var(--cm-accent)]"
                          />
                          <span>
                            Save &ldquo;{form.name.trim()}&rdquo; to permanent Catalog Suggestions for future reuse
                          </span>
                        </label>
                        {saveAsTemplate && (
                          <input
                            type="text"
                            maxLength={120}
                            placeholder="Optional variant/size (e.g. 500ml)"
                            value={templateVariant}
                            onChange={(e) => setTemplateVariant(e.target.value)}
                            className="cm-input px-2.5 py-1 text-xs border rounded-md min-w-[180px]"
                          />
                        )}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-[var(--cm-text-secondary)]">
                        4. Supplier
                      </label>
                      <button
                        type="button"
                        onClick={() => setQuickType('supplier')}
                        className="text-xs text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                      >
                        + New
                      </button>
                    </div>
                    <SearchableSelect
                      ariaLabel="Select supplier"
                      suggestionScope="supplier"
                      suggestedValues={frequentSupplierIds}
                      options={supplierOptions}
                      value={form.supplierId}
                      onChange={(val) => setForm({ ...form, supplierId: val })}
                      emptyOptionLabel="Walk-in / Direct"
                      placeholder="Search supplier..."
                      searchPlaceholder="Type supplier name or phone..."
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                        5. Expiry (Opt.)
                      </label>
                      <input
                        type="date"
                        value={form.expiryDate}
                        onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
                        className="cm-input w-full px-2.5 py-2 text-sm border rounded-lg font-mono-num"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1">
                        6. Origin (Opt.)
                      </label>
                      <select
                        aria-label="Product origin"
                        value={form.originType}
                        onChange={(e) =>
                          setForm({ ...form, originType: e.target.value as OriginType })
                        }
                        className="cm-input w-full px-2.5 py-2 text-sm border rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
                      >
                        <option value="">Standard / Unspecified</option>
                        <option value="local">Local</option>
                        <option value="imported">Imported</option>
                      </select>
                    </div>
                  </div>
                </div>

                {quickType && (
                  <div className="p-3 cm-subtle border rounded-lg space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[var(--cm-text-primary)] capitalize">
                        Quick Add {quickType}
                      </span>
                      {quickType === 'brand' && (
                        <span className="text-[11px] text-[var(--cm-text-muted)]">
                          Adds to permanent brand library
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="text"
                        placeholder={`Enter ${quickType} name`}
                        value={quickName}
                        onChange={(e) => setQuickName(e.target.value)}
                        className="cm-input flex-1 min-w-[160px] px-3 py-1.5 text-sm border rounded-lg"
                      />
                      {quickType === 'supplier' && (
                        <input
                          type="text"
                          placeholder="Phone (optional)"
                          value={quickPhone}
                          onChange={(e) => setQuickPhone(e.target.value)}
                          className="cm-input px-3 py-1.5 text-sm border rounded-lg"
                        />
                      )}
                      <button
                        type="button"
                        disabled={!quickName.trim() || Boolean(quickType === 'brand' && quickBrandExactMatch)}
                        onClick={() => void handleQuickCreate()}
                        className="px-3 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg cursor-pointer"
                      >
                        {quickType === 'brand' ? 'Save Brand' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setQuickType(null);
                          setQuickName('');
                          setQuickPhone('');
                          setQuickBrandCategoryIds([]);
                        }}
                        className="px-3 py-1.5 text-xs font-medium text-[var(--cm-text-secondary)] cm-surface border rounded-lg cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>

                    {quickType === 'brand' && quickBrandSimilarMatches.length > 0 && (
                      <div className="p-2.5 bg-[var(--cm-warning-soft)] border border-[var(--cm-warning-border)] rounded-lg space-y-1.5">
                        <div className="text-[11px] font-semibold text-[var(--cm-warning)]">
                          {quickBrandExactMatch
                            ? `Brand "${quickBrandExactMatch.name}" already exists in your library:`
                            : 'Possible existing brand matches found (avoid duplicates):'}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {quickBrandSimilarMatches.map((m) => (
                            <button
                              key={m.brand.id}
                              type="button"
                              onClick={() => {
                                setForm((f) => ({ ...f, brandId: m.brand.id }));
                                setQuickType(null);
                                setQuickName('');
                                setQuickBrandCategoryIds([]);
                                showToast({
                                  title: 'Existing brand selected',
                                  message: `Selected "${m.brand.name}".`,
                                  tone: 'info',
                                  durationMs: 2500,
                                });
                              }}
                              className="px-2 py-1 text-xs font-medium cm-surface border border-[var(--cm-warning-border)] hover:border-[var(--cm-accent)] rounded-md text-[var(--cm-text-primary)] cursor-pointer"
                            >
                              Use <span className="font-semibold">{m.brand.name}</span>
                              <span className="ml-1 text-[10px] text-[var(--cm-text-muted)]">
                                ({m.reason})
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {quickType === 'brand' && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-medium text-[var(--cm-text-secondary)]">
                          Relevant Categories (optional — multi-select)
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {categories.map((cat) => {
                            const checked = quickBrandCategoryIds.includes(cat.id);
                            return (
                              <button
                                key={cat.id}
                                type="button"
                                onClick={() =>
                                  setQuickBrandCategoryIds((prev) =>
                                    prev.includes(cat.id)
                                      ? prev.filter((id) => id !== cat.id)
                                      : prev.length < 25
                                      ? [...prev, cat.id]
                                      : prev
                                  )
                                }
                                className={`px-2 py-1 text-[11px] font-medium rounded-md border cursor-pointer transition-colors ${
                                  checked
                                    ? 'bg-[var(--cm-accent-soft)] text-[var(--cm-accent-text)] border-[var(--cm-accent-border)]'
                                    : 'cm-surface text-[var(--cm-text-secondary)] border-[var(--cm-border)] hover:border-[var(--cm-border-strong)]'
                                }`}
                              >
                                {cat.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Packaging & Pricing Setup (Smallest Stock Unit -> Sequential Packaging Hierarchy -> Auto Per-Unit Pricing) */}
                <div className="p-3 sm:p-4 cm-subtle border rounded-xl space-y-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Package className="w-4 h-4 text-[var(--cm-accent-text)] shrink-0" />
                      <div>
                        <h4 className="text-xs sm:text-sm font-semibold text-[var(--cm-text-primary)]">
                          Packaging &amp; Pricing Setup
                        </h4>
                        <p className="text-[11px] text-[var(--cm-text-muted)]">
                          Choose the smallest sellable stock unit, add larger packages, and prices per unit calculate automatically.
                        </p>
                      </div>
                    </div>
                    <div className="text-xs font-mono-num font-semibold text-[var(--cm-success)]">
                      Margin: {liveMarginPct}%
                    </div>
                  </div>

                  {/* Step 1: Smallest Stock Unit */}
                  <div className="p-2.5 cm-surface border rounded-lg space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] font-semibold text-[var(--cm-text-primary)]">
                        Smallest Stock Unit *
                      </label>
                      <button
                        type="button"
                        onClick={() => setCustomBaseUnitMode((v) => !v)}
                        className="text-[11px] font-medium text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                      >
                        {customBaseUnitMode ? 'Pick Standard Unit' : '+ Custom Unit'}
                      </button>
                    </div>
                    {customBaseUnitMode ? (
                      <input
                        type="text"
                        required
                        maxLength={40}
                        placeholder="e.g., Piece, Bottle, Can, Packet, Roll, Tube"
                        value={form.baseUnit}
                        onChange={(e) => handleBaseUnitChange(e.target.value)}
                        className="cm-input w-full px-2.5 py-2 text-sm border rounded-lg"
                      />
                    ) : (
                      <SearchableSelect
                        size="sm"
                        ariaLabel="Select smallest stock unit"
                        suggestionScope="unit"
                        suggestedValues={frequentUnits}
                        options={baseUnitOptions}
                        value={form.baseUnit}
                        onChange={(val) => handleBaseUnitChange(val || 'Piece')}
                        placeholder="e.g., Piece, Bottle, Can, Packet..."
                        searchPlaceholder="Search unit..."
                      />
                    )}
                    <p className="text-[11px] text-[var(--cm-text-muted)]">
                      All stock counts and FIFO batches track inventory in{' '}
                      <strong className="text-[var(--cm-text-secondary)]">
                        {pluralizeUnit(form.baseUnit, 2)}
                      </strong>
                      .
                    </p>
                  </div>

                  {/* Step 2: Packaging Levels Hierarchy */}
                  <div className="cm-surface border rounded-lg p-2.5 sm:p-3 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs font-semibold text-[var(--cm-text-primary)]">
                          Larger Packaging Levels ({form.packagingUnits.length})
                        </div>
                        <p className="text-[11px] text-[var(--cm-text-muted)]">
                          Define sequentially: e.g., 1 Packet = 45 Pieces, then 1 Carton = 24 Packets.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleAddPackagingRow}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Packaging Level
                      </button>
                    </div>

                    {form.packagingUnits.length === 0 ? (
                      <div className="text-[11px] text-[var(--cm-text-muted)] p-2.5 rounded-lg cm-subtle border border-dashed text-center">
                        Sold &amp; purchased in {form.baseUnit} only. Click &ldquo;Add Packaging Level&rdquo; to add Packet, Box, Carton, or Crate levels.
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {form.packagingUnits.map((pkg, idx) => {
                          const totalInBase = packagingCalc.conversionsByKey.get(pkg.key) || 0;
                          const pkgBuyNum = Number(pkg.purchasePrice) || 0;
                          const pkgSaleNum = Number(pkg.salePrice) || 0;
                          const pkgWholeNum = Number(pkg.wholesalePrice) || 0;
                          const perBaseBuy =
                            totalInBase > 0 && pkgBuyNum > 0 ? roundMoney(pkgBuyNum / totalInBase) : 0;
                          const perBaseSale =
                            totalInBase > 0 && pkgSaleNum > 0 ? roundMoney(pkgSaleNum / totalInBase) : 0;
                          const perBaseWhole =
                            totalInBase > 0 && pkgWholeNum > 0 ? roundMoney(pkgWholeNum / totalInBase) : 0;

                          // Available parent units: Smallest Stock Unit + earlier defined levels (cycle-free DAG)
                          const parentCandidates: string[] = [form.baseUnit.trim() || 'Piece'];
                          const parentSeen = new Set([parentCandidates[0].toLowerCase()]);
                          for (let i = 0; i < idx; i += 1) {
                            const prevName = form.packagingUnits[i].unitName.trim();
                            if (prevName && !parentSeen.has(prevName.toLowerCase())) {
                              parentSeen.add(prevName.toLowerCase());
                              parentCandidates.push(prevName);
                            }
                          }

                          const activeParent = parentCandidates.some(
                            (p) => p.toLowerCase() === pkg.parentUnitName.trim().toLowerCase()
                          )
                            ? pkg.parentUnitName
                            : parentCandidates[0];

                          const containsNum = Number(pkg.containsQty) || 0;
                          const parentLabel =
                            containsNum > 0
                              ? pluralizeUnit(activeParent, containsNum)
                              : pluralizeUnit(activeParent, 2);

                          return (
                            <div
                              key={pkg.key}
                              className="p-2.5 cm-subtle border rounded-lg space-y-2.5"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="text-[11px] font-semibold text-[var(--cm-text-primary)] font-mono-num">
                                  <span>
                                    Level {idx + 1}: 1 {pkg.unitName || 'Package'} ={' '}
                                    {containsNum > 0 ? formatNumber(containsNum) : '?'} {parentLabel}
                                  </span>
                                  {totalInBase > 0 &&
                                    activeParent.toLowerCase() !==
                                      (form.baseUnit || 'Piece').trim().toLowerCase() && (
                                      <span className="ml-1.5 text-[var(--cm-accent-text)]">
                                        (= {formatNumber(totalInBase)}{' '}
                                        {pluralizeUnit(form.baseUnit, totalInBase)})
                                      </span>
                                    )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => removePackagingRow(pkg.key)}
                                  className="p-1 text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] cursor-pointer"
                                  aria-label="Remove packaging level"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                                {/* Package Name */}
                                <div className="sm:col-span-3">
                                  <div className="flex items-center justify-between mb-0.5">
                                    <label className="text-[10px] font-medium text-[var(--cm-text-muted)]">
                                      Package Name *
                                    </label>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updatePackagingRow(pkg.key, {
                                          customUnitMode: !pkg.customUnitMode,
                                        })
                                      }
                                      className="text-[10px] text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                                    >
                                      {pkg.customUnitMode ? 'List' : 'Custom'}
                                    </button>
                                  </div>
                                  {pkg.customUnitMode ? (
                                    <input
                                      type="text"
                                      required
                                      maxLength={40}
                                      placeholder="e.g., Jumbo Pack"
                                      value={pkg.unitName}
                                      onChange={(e) =>
                                        updatePackagingRow(pkg.key, { unitName: e.target.value })
                                      }
                                      className="cm-input w-full px-2 py-1.5 text-xs border rounded-md"
                                    />
                                  ) : (
                                    <select
                                      value={pkg.unitName}
                                      onChange={(e) =>
                                        updatePackagingRow(pkg.key, { unitName: e.target.value })
                                      }
                                      className="cm-input w-full px-2 py-1.5 text-xs border rounded-md"
                                    >
                                      {STANDARD_UNITS.filter(
                                        (u) => u.toLowerCase() !== form.baseUnit.trim().toLowerCase()
                                      ).map((u) => (
                                        <option key={u} value={u}>
                                          {u}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                </div>

                                {/* Contains Qty + Immediately Smaller Unit */}
                                <div className="sm:col-span-4">
                                  <label className="block text-[10px] font-medium text-[var(--cm-text-muted)] mb-0.5">
                                    Contains *
                                  </label>
                                  <div className="flex items-center gap-1.5">
                                    <input
                                      type="number"
                                      min="0.001"
                                      step="any"
                                      required
                                      placeholder="e.g., 45 or 24"
                                      value={pkg.containsQty}
                                      onChange={(e) =>
                                        updatePackagingRow(pkg.key, { containsQty: e.target.value })
                                      }
                                      className="cm-input w-24 shrink-0 px-2 py-1.5 text-xs border rounded-md font-mono-num"
                                    />
                                    <select
                                      aria-label={`Unit contained inside ${pkg.unitName || 'package'}`}
                                      value={activeParent}
                                      onChange={(e) =>
                                        updatePackagingRow(pkg.key, {
                                          parentUnitName: e.target.value,
                                        })
                                      }
                                      className="cm-input flex-1 min-w-0 px-2 py-1.5 text-xs border rounded-md"
                                    >
                                      {parentCandidates.map((cand) => (
                                        <option key={cand} value={cand}>
                                          {pluralizeUnit(cand, 2)}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>

                                {/* Package Prices */}
                                <div className="sm:col-span-5 grid grid-cols-3 gap-1.5">
                                  <div>
                                    <label className="block text-[10px] font-medium text-[var(--cm-text-muted)] mb-0.5">
                                      Purchase Price
                                    </label>
                                    <input
                                      type="number"
                                      min={0}
                                      step="0.01"
                                      placeholder="PKR"
                                      value={pkg.purchasePrice}
                                      onChange={(e) =>
                                        updatePackagingRow(pkg.key, {
                                          purchasePrice: e.target.value,
                                        })
                                      }
                                      className="cm-input w-full px-2 py-1.5 text-xs border rounded-md font-mono-num"
                                    />
                                    {perBaseBuy > 0 && (
                                      <div className="text-[10px] text-[var(--cm-text-muted)] font-mono-num mt-0.5 truncate">
                                        {formatPKR(perBaseBuy)}/{form.baseUnit}
                                      </div>
                                    )}
                                  </div>

                                  <div>
                                    <label className="block text-[10px] font-medium text-[var(--cm-text-muted)] mb-0.5">
                                      Selling Price
                                    </label>
                                    <input
                                      type="number"
                                      min={0}
                                      step="0.01"
                                      placeholder="PKR"
                                      value={pkg.salePrice}
                                      onChange={(e) =>
                                        updatePackagingRow(pkg.key, { salePrice: e.target.value })
                                      }
                                      className="cm-input w-full px-2 py-1.5 text-xs border rounded-md font-mono-num"
                                    />
                                    {perBaseSale > 0 && (
                                      <div className="text-[10px] text-[var(--cm-accent-text)] font-mono-num mt-0.5 truncate">
                                        {formatPKR(perBaseSale)}/{form.baseUnit}
                                      </div>
                                    )}
                                  </div>

                                  <div>
                                    <label className="block text-[10px] font-medium text-[var(--cm-text-muted)] mb-0.5">
                                      Wholesale (Opt.)
                                    </label>
                                    <input
                                      type="number"
                                      min={0}
                                      step="0.01"
                                      placeholder="PKR"
                                      value={pkg.wholesalePrice}
                                      onChange={(e) =>
                                        updatePackagingRow(pkg.key, {
                                          wholesalePrice: e.target.value,
                                        })
                                      }
                                      className="cm-input w-full px-2 py-1.5 text-xs border rounded-md font-mono-num"
                                    />
                                    {perBaseWhole > 0 && (
                                      <div className="text-[10px] text-[var(--cm-text-muted)] font-mono-num mt-0.5 truncate">
                                        {formatPKR(perBaseWhole)}/{form.baseUnit}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-3 pt-0.5 text-[11px] text-[var(--cm-text-secondary)]">
                                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={pkg.allowPurchase}
                                    onChange={(e) =>
                                      updatePackagingRow(pkg.key, {
                                        allowPurchase: e.target.checked,
                                        isDefaultPurchase: e.target.checked
                                          ? pkg.isDefaultPurchase
                                          : false,
                                      })
                                    }
                                    className="accent-[var(--cm-accent)]"
                                  />
                                  <span>Allow Purchase</span>
                                </label>
                                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={pkg.allowSale}
                                    onChange={(e) =>
                                      updatePackagingRow(pkg.key, {
                                        allowSale: e.target.checked,
                                        isDefaultSale: e.target.checked ? pkg.isDefaultSale : false,
                                      })
                                    }
                                    className="accent-[var(--cm-accent)]"
                                  />
                                  <span>Allow Sale</span>
                                </label>
                                {pkg.allowPurchase && (
                                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={pkg.isDefaultPurchase}
                                      onChange={(e) =>
                                        updatePackagingRow(pkg.key, {
                                          isDefaultPurchase: e.target.checked,
                                        })
                                      }
                                      className="accent-[var(--cm-accent)]"
                                    />
                                    <span>Default Purchase Unit</span>
                                  </label>
                                )}
                                {pkg.allowSale && (
                                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={pkg.isDefaultSale}
                                      onChange={(e) =>
                                        updatePackagingRow(pkg.key, {
                                          isDefaultSale: e.target.checked,
                                        })
                                      }
                                      className="accent-[var(--cm-accent)]"
                                    />
                                    <span>Default Sale Unit</span>
                                  </label>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Step 3: Per Smallest Stock Unit Pricing & Stock Thresholds */}
                  <div className="p-2.5 sm:p-3 cm-surface border rounded-lg space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-[var(--cm-text-primary)]">
                        Pricing &amp; Stock per {form.baseUnit}
                      </div>
                      {(packagingCalc.purchase !== null || packagingCalc.sale !== null) && (
                        <span className="text-[11px] text-[var(--cm-text-muted)]">
                          Auto-calculated from package price (editable to override)
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                      <div>
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <label className="text-[11px] font-medium text-[var(--cm-text-secondary)]">
                            Cost / {form.baseUnit} (PKR)
                          </label>
                          {manualBaseOverrides.purchase && packagingCalc.purchase !== null && (
                            <button
                              type="button"
                              onClick={() => {
                                setManualBaseOverrides((o) => ({ ...o, purchase: false }));
                                setForm((f) => ({
                                  ...f,
                                  purchasePrice: String(packagingCalc.purchase),
                                }));
                              }}
                              className="text-[10px] font-semibold text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                            >
                              Auto-calc
                            </button>
                          )}
                        </div>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          placeholder="Optional (0)"
                          value={form.purchasePrice}
                          onChange={(e) => {
                            setManualBaseOverrides((o) => ({ ...o, purchase: true }));
                            setForm({ ...form, purchasePrice: e.target.value });
                          }}
                          className="cm-input w-full px-2.5 py-2 text-sm border rounded-lg font-mono-num"
                        />
                        {packagingCalc.sourceUnit.purchase && !manualBaseOverrides.purchase && (
                          <div className="text-[10px] text-[var(--cm-success)] mt-0.5">
                            Auto from {packagingCalc.sourceUnit.purchase}
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <label className="text-[11px] font-medium text-[var(--cm-text-secondary)]">
                            Selling / {form.baseUnit} (PKR)
                          </label>
                          {manualBaseOverrides.sale && packagingCalc.sale !== null && (
                            <button
                              type="button"
                              onClick={() => {
                                setManualBaseOverrides((o) => ({ ...o, sale: false }));
                                setForm((f) => ({ ...f, salePrice: String(packagingCalc.sale) }));
                              }}
                              className="text-[10px] font-semibold text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                            >
                              Auto-calc
                            </button>
                          )}
                        </div>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          placeholder="Optional (0)"
                          value={form.salePrice}
                          onChange={(e) => {
                            setManualBaseOverrides((o) => ({ ...o, sale: true }));
                            setForm({ ...form, salePrice: e.target.value });
                          }}
                          className="cm-input w-full px-2.5 py-2 text-sm border rounded-lg font-mono-num"
                        />
                        {packagingCalc.sourceUnit.sale && !manualBaseOverrides.sale && (
                          <div className="text-[10px] text-[var(--cm-success)] mt-0.5">
                            Auto from {packagingCalc.sourceUnit.sale}
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-1 mb-1">
                          <label className="text-[11px] font-medium text-[var(--cm-text-secondary)]">
                            Wholesale / {form.baseUnit}
                          </label>
                          {manualBaseOverrides.wholesale && packagingCalc.wholesale !== null && (
                            <button
                              type="button"
                              onClick={() => {
                                setManualBaseOverrides((o) => ({ ...o, wholesale: false }));
                                setForm((f) => ({
                                  ...f,
                                  wholesalePrice: String(packagingCalc.wholesale),
                                }));
                              }}
                              className="text-[10px] font-semibold text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                            >
                              Auto-calc
                            </button>
                          )}
                        </div>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={form.wholesalePrice}
                          onChange={(e) => {
                            setManualBaseOverrides((o) => ({ ...o, wholesale: true }));
                            setForm({ ...form, wholesalePrice: e.target.value });
                          }}
                          className="cm-input w-full px-2.5 py-2 text-sm border rounded-lg font-mono-num"
                        />
                      </div>

                      {!editing && (
                        <div>
                          <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                            Opening Stock
                          </label>
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              min={0}
                              step={isFractionalUnit(form.openingStockUnit || form.baseUnit) ? '0.001' : '1'}
                              value={form.currentStock}
                              onChange={(e) => setForm({ ...form, currentStock: e.target.value })}
                              className="cm-input w-20 flex-1 min-w-0 px-2 py-2 text-sm border rounded-lg font-mono-num"
                            />
                            {form.packagingUnits.some((r) => r.unitName.trim() && (packagingCalc.conversionsByKey.get(r.key) || 0) > 0) && (
                              <select
                                aria-label="Opening stock unit"
                                value={form.openingStockUnit || form.baseUnit}
                                onChange={(e) =>
                                  setForm({ ...form, openingStockUnit: e.target.value })
                                }
                                className="cm-input px-1.5 py-2 text-xs border rounded-lg max-w-[96px]"
                              >
                                <option value={form.baseUnit}>{form.baseUnit}</option>
                                {form.packagingUnits
                                  .filter((r) => r.unitName.trim() && (packagingCalc.conversionsByKey.get(r.key) || 0) > 0)
                                  .map((r) => (
                                    <option key={r.key} value={r.unitName}>
                                      {r.unitName}
                                    </option>
                                  ))}
                              </select>
                            )}
                          </div>
                          {openingStockConversion > 1 && Number(form.currentStock) > 0 && (
                            <div className="text-[10px] text-[var(--cm-accent-text)] font-mono-num mt-0.5">
                              = {formatNumber(roundStockQty((Number(form.currentStock) || 0) * openingStockConversion))}{' '}
                              {pluralizeUnit(
                                form.baseUnit,
                                (Number(form.currentStock) || 0) * openingStockConversion
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      <div>
                        <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                          Min Alert ({form.baseUnit})
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={isFractionalUnit(form.baseUnit) ? '0.001' : '1'}
                          value={form.minStockLevel}
                          onChange={(e) => setForm({ ...form, minStockLevel: e.target.value })}
                          className="cm-input w-full px-2.5 py-2 text-sm border rounded-lg font-mono-num"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                          Max Target ({form.baseUnit})
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={isFractionalUnit(form.baseUnit) ? '0.001' : '1'}
                          value={form.maxStockLevel}
                          onChange={(e) => setForm({ ...form, maxStockLevel: e.target.value })}
                          className="cm-input w-full px-2.5 py-2 text-sm border rounded-lg font-mono-num"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Collapsible Cold Drinks, Storage & Returnable Packaging */}
                <div className="cm-surface border rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowColdDrinkSection((v) => !v)}
                    className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-[var(--cm-bg-hover)] cursor-pointer"
                  >
                    <span className="inline-flex items-center gap-2 text-xs sm:text-sm font-semibold text-[var(--cm-text-primary)] flex-wrap">
                      <Snowflake className="w-4 h-4 text-[var(--cm-info)] shrink-0" />
                      <span>Beverage, Chiller &amp; Returnable Packaging (Optional)</span>
                      {(form.bottleSize || form.storageLocation) && (
                        <span className="text-[11px] font-normal text-[var(--cm-text-muted)]">
                          · {[form.bottleSize, form.storageLocation].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                    {showColdDrinkSection ? (
                      <ChevronDown className="w-4 h-4 text-[var(--cm-text-muted)] shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-[var(--cm-text-muted)] shrink-0" />
                    )}
                  </button>

                  {showColdDrinkSection && (
                    <div className="p-3.5 border-t border-[var(--cm-border)] space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">

                        <div>
                          <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                            Bottle / Can Size
                          </label>
                          <input
                            type="text"
                            maxLength={40}
                            placeholder="e.g., 250ml, 500ml, 1.5L, 330ml Can"
                            value={form.bottleSize}
                            onChange={(e) => setForm({ ...form, bottleSize: e.target.value })}
                            className="cm-input w-full px-2.5 py-2 text-xs sm:text-sm border rounded-lg"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                            Fridge / Storage Location
                          </label>
                          <input
                            type="text"
                            maxLength={80}
                            placeholder="e.g., Chiller 1, Aisle B"
                            value={form.storageLocation}
                            onChange={(e) => setForm({ ...form, storageLocation: e.target.value })}
                            className="cm-input w-full px-2.5 py-2 text-xs sm:text-sm border rounded-lg"
                          />
                        </div>
                      </div>

                      <div className="pt-2 border-t border-[var(--cm-border)] space-y-2.5">
                        <label className="inline-flex items-center gap-2 text-xs font-medium text-[var(--cm-text-primary)] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.isReturnable}
                            onChange={(e) => setForm({ ...form, isReturnable: e.target.checked })}
                            className="accent-[var(--cm-accent)]"
                          />
                          <span>Tracks Returnable Bottles / Empty Crates &amp; Refundable Deposit</span>
                        </label>

                        {form.isReturnable && (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                            <div>
                              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                                Returnable Container Unit
                              </label>
                              <input
                                type="text"
                                maxLength={40}
                                placeholder="e.g., Crate or Glass Bottle"
                                value={form.returnableUnitName}
                                onChange={(e) =>
                                  setForm({ ...form, returnableUnitName: e.target.value })
                                }
                                className="cm-input w-full px-2.5 py-2 text-xs sm:text-sm border rounded-lg"
                              />
                            </div>

                            <div>
                              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                                Refundable Deposit (PKR)
                              </label>
                              <input
                                type="number"
                                min={0}
                                step="1"
                                value={form.depositPerReturnable}
                                onChange={(e) =>
                                  setForm({ ...form, depositPerReturnable: e.target.value })
                                }
                                className="cm-input w-full px-2.5 py-2 text-xs sm:text-sm border rounded-lg font-mono-num"
                              />
                            </div>

                            <div>
                              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                                Empty Crates/Bottles On Hand
                              </label>
                              <input
                                type="number"
                                min={0}
                                step="1"
                                value={form.emptyContainersOnHand}
                                onChange={(e) =>
                                  setForm({ ...form, emptyContainersOnHand: e.target.value })
                                }
                                className="cm-input w-full px-2.5 py-2 text-xs sm:text-sm border rounded-lg font-mono-num"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="px-4 py-3 sm:px-5 border-t border-[var(--cm-border)] cm-surface flex justify-end gap-2 shrink-0 rounded-b-xl">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="min-h-[42px] px-4 py-2 text-sm font-medium text-[var(--cm-text-secondary)] cm-surface border hover:bg-[var(--cm-bg-hover)] rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="min-h-[42px] px-5 py-2 text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg disabled:opacity-50 cursor-pointer"
                >
                  {saving ? 'Saving...' : editing ? 'Save Changes' : 'Add Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
