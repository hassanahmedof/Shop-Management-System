import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  Edit3,
  Plus,
  Power,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import {
  type CatalogAuditReport,
  createProductTemplate,
  deleteProductTemplate,
  runLiveCatalogAuditAndSync,
  toggleProductTemplateStatus,
  updateProductTemplate,
} from '../services/shopService';
import type {
  Brand,
  Category,
  OriginType,
  Product,
  ProductTemplate,
  ProductTemplatePackaging,
} from '../types/shop';
import { getBrandSearchAliases, isBrandActive } from '../utils/brands';
import { formatNumber, formatPKR } from '../utils/formatters';
import {
  MAX_PACKAGING_LEVELS,
  pluralizeUnit,
  resolveCumulativeConversion,
  STANDARD_UNITS,
} from '../utils/packaging';
import { normalizeTemplateKey } from '../utils/productTemplateHelpers';
import { CompactSection } from './CompactSection';

interface CatalogTemplateManagerSectionProps {
  shopId: string;
  productTemplates: ProductTemplate[];
  categories: Category[];
  brands: Brand[];
  products?: Product[];
}

interface TemplatePkgRow {
  key: string;
  unitName: string;
  containsQty: string;
  parentUnitName: string;
  allowPurchase: boolean;
  allowSale: boolean;
  isDefaultPurchase: boolean;
  isDefaultSale: boolean;
  needsConfirmation: boolean;
}

interface TemplateFormState {
  name: string;
  variant: string;
  categoryId: string;
  brandId: string;
  originType: OriginType;
  baseUnit: string;
  customBaseUnit: boolean;
  suggestedPurchasePrice: string;
  suggestedSalePrice: string;
  priceSource: string;
  bottleSize: string;
  storageLocation: string;
  trackExpiry: boolean;
  packagingUnits: TemplatePkgRow[];
}

const STANDARD_UNIT_SET = new Set(STANDARD_UNITS.map((u) => u.toLowerCase()));

function makeEmptyForm(categories: Category[]): TemplateFormState {
  return {
    name: '',
    variant: '',
    categoryId: categories[0]?.id || '',
    brandId: '',
    originType: '',
    baseUnit: 'Piece',
    customBaseUnit: false,
    suggestedPurchasePrice: '',
    suggestedSalePrice: '',
    priceSource: '',
    bottleSize: '',
    storageLocation: '',
    trackExpiry: false,
    packagingUnits: [],
  };
}

function toTemplateFormState(tpl: ProductTemplate): TemplateFormState {
  const baseUnit = (tpl.baseUnit || 'Piece').trim() || 'Piece';
  return {
    name: tpl.name,
    variant: tpl.variant || '',
    categoryId: tpl.categoryId || '',
    brandId: tpl.brandId || '',
    originType: tpl.originType || '',
    baseUnit,
    customBaseUnit: !STANDARD_UNIT_SET.has(baseUnit.toLowerCase()),
    suggestedPurchasePrice:
      tpl.suggestedPurchasePrice !== undefined && tpl.suggestedPurchasePrice > 0
        ? String(tpl.suggestedPurchasePrice)
        : '',
    suggestedSalePrice:
      tpl.suggestedSalePrice !== undefined && tpl.suggestedSalePrice > 0
        ? String(tpl.suggestedSalePrice)
        : '',
    priceSource: tpl.priceSource || '',
    bottleSize: tpl.bottleSize || '',
    storageLocation: tpl.storageLocation || '',
    trackExpiry: Boolean(tpl.trackExpiry),
    packagingUnits: (tpl.packagingUnits || []).map((u, idx) => ({
      key: `tplpkg-${idx}-${u.unitName}`,
      unitName: u.unitName,
      containsQty: String(u.containsQty ?? u.conversionQty ?? 1),
      parentUnitName: u.parentUnitName || baseUnit,
      allowPurchase: u.allowPurchase !== false,
      allowSale: u.allowSale !== false,
      isDefaultPurchase: Boolean(u.isDefaultPurchase),
      isDefaultSale: Boolean(u.isDefaultSale),
      needsConfirmation: Boolean(u.needsConfirmation),
    })),
  };
}

export function CatalogTemplateManagerSection({
  shopId,
  productTemplates,
  categories,
  brands,
  products = [],
}: CatalogTemplateManagerSectionProps) {
  const { showToast } = useToast();

  const [search, setSearch] = useState('');
  const [filterCatId, setFilterCatId] = useState('');
  const [filterBrandId, setFilterBrandId] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'active' | 'inactive' | 'unconfirmed'
  >('all');

  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateFormState>(() => makeEmptyForm(categories));
  const [filterFormBrandsByCategory, setFilterFormBrandsByCategory] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditReport, setAuditReport] = useState<CatalogAuditReport | null>(null);
  const [showAuditPanel, setShowAuditPanel] = useState(false);

  const categoryMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories]
  );
  const brandMap = useMemo(() => new Map(brands.map((b) => [b.id, b])), [brands]);

  const filterBrands = useMemo(() => {
    const list = filterCatId
      ? brands.filter((b) => (b.categoryIds || []).includes(filterCatId))
      : brands;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [brands, filterCatId]);

  const formBrandChoices = useMemo(() => {
    const filtered = brands.filter((b) => {
      if (!isBrandActive(b) && b.id !== form.brandId) return false;
      if (filterFormBrandsByCategory && form.categoryId) {
        return (b.categoryIds || []).includes(form.categoryId) || b.id === form.brandId;
      }
      return true;
    });
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [brands, filterFormBrandsByCategory, form.categoryId, form.brandId]);

  const activeCount = useMemo(
    () => productTemplates.filter((t) => t.isActive !== false).length,
    [productTemplates]
  );

  const unconfirmedCount = useMemo(
    () => productTemplates.filter((t) => Boolean(t.hasUnconfirmedPackaging)).length,
    [productTemplates]
  );

  const duplicateTemplate = useMemo(() => {
    if (!editorMode || !form.name.trim()) return null;
    const candidateKey = normalizeTemplateKey(
      form.categoryId,
      form.brandId,
      form.name,
      form.variant
    );
    return (
      productTemplates.find((t) => {
        if (editorMode === 'edit' && t.id === editingId) return false;
        return normalizeTemplateKey(t.categoryId, t.brandId, t.name, t.variant) === candidateKey;
      }) || null
    );
  }, [editorMode, editingId, form.categoryId, form.brandId, form.name, form.variant, productTemplates]);

  const filteredTemplates = useMemo(() => {
    const tokens = search
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    return productTemplates
      .filter((t) => {
        const active = t.isActive !== false;
        if (statusFilter === 'active' && !active) return false;
        if (statusFilter === 'inactive' && active) return false;
        if (statusFilter === 'unconfirmed' && !t.hasUnconfirmedPackaging) return false;
        if (filterCatId && t.categoryId !== filterCatId) return false;
        if (filterBrandId && t.brandId !== filterBrandId) return false;
        if (tokens.length > 0) {
          const aliasHay = getBrandSearchAliases(t.brandName || '').join(' ');
          const hay = `${t.name} ${t.variant || ''} ${t.categoryName} ${t.brandName} ${aliasHay} ${t.bottleSize || ''} ${(t.searchKeywords || []).join(' ')}`.toLowerCase();
          if (!tokens.every((tok) => hay.includes(tok))) return false;
        }
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [productTemplates, search, filterCatId, filterBrandId, statusFilter]);

  const openCreateForm = () => {
    setEditorMode('create');
    setEditingId(null);
    setForm(makeEmptyForm(categories));
    setFilterFormBrandsByCategory(true);
    setConfirmDeleteId(null);
  };

  const openEditForm = (tpl: ProductTemplate) => {
    setEditorMode('edit');
    setEditingId(tpl.id);
    setForm(toTemplateFormState(tpl));
    setFilterFormBrandsByCategory(true);
    setConfirmDeleteId(null);
  };

  const closeEditor = () => {
    setEditorMode(null);
    setEditingId(null);
  };

  const handleAddPkgRow = () => {
    if (form.packagingUnits.length >= MAX_PACKAGING_LEVELS) {
      showToast({
        title: 'Max Packaging Levels',
        message: `Up to ${MAX_PACKAGING_LEVELS} packaging levels supported.`,
        tone: 'warning',
      });
      return;
    }
    const used = new Set([
      form.baseUnit.toLowerCase(),
      ...form.packagingUnits.map((r) => r.unitName.toLowerCase()),
    ]);
    const preferred = ['Packet', 'Pack', 'Box', 'Carton', 'Crate', 'Dozen'];
    const pick = preferred.find((u) => !used.has(u.toLowerCase())) || 'Pack';
    const prevParent =
      form.packagingUnits[form.packagingUnits.length - 1]?.unitName || form.baseUnit || 'Piece';

    setForm((prev) => ({
      ...prev,
      packagingUnits: [
        ...prev.packagingUnits,
        {
          key: `tplpkg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          unitName: pick,
          containsQty: '',
          parentUnitName: prevParent,
          allowPurchase: true,
          allowSale: true,
          isDefaultPurchase: prev.packagingUnits.length === 0,
          isDefaultSale: false,
          needsConfirmation: false,
        },
      ],
    }));
  };

  const handleSaveTemplate = async () => {
    if (!shopId || !form.name.trim()) return;
    if (duplicateTemplate) {
      showToast({
        title: 'Duplicate Template Prevented',
        message: `"${duplicateTemplate.name}" already exists for this category/brand/variant.`,
        tone: 'warning',
      });
      return;
    }

    const baseUnit = form.baseUnit.trim() || 'Piece';
    const seenUnits = new Set<string>([baseUnit.toLowerCase()]);

    for (const row of form.packagingUnits) {
      const unitName = row.unitName.trim();
      const qty = Number(row.containsQty);
      if (!unitName) {
        showToast({ title: 'Missing Package Name', message: 'Enter each package unit name.', tone: 'warning' });
        return;
      }
      if (seenUnits.has(unitName.toLowerCase())) {
        showToast({
          title: 'Duplicate Package Unit',
          message: `Unit "${unitName}" appears twice.`,
          tone: 'warning',
        });
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        showToast({
          title: 'Invalid Conversion Quantity',
          message: `Enter a positive quantity inside 1 ${unitName}.`,
          tone: 'warning',
        });
        return;
      }
      seenUnits.add(unitName.toLowerCase());
    }

    const resolvedMap = resolveCumulativeConversion(
      form.packagingUnits.map((r) => ({
        unitName: r.unitName.trim(),
        containsQty: Number(r.containsQty) || 0,
        parentUnitName: r.parentUnitName.trim() || baseUnit,
      })),
      baseUnit
    );

    const packagingUnits: ProductTemplatePackaging[] = [];
    for (const row of form.packagingUnits) {
      const unitName = row.unitName.trim();
      const resolved = resolvedMap.get(unitName.toLowerCase());
      if (!resolved || resolved.conversionQty <= 0) {
        showToast({
          title: 'Invalid Packaging Chain',
          message: `Check parent link for "${unitName}".`,
          tone: 'warning',
        });
        return;
      }
      packagingUnits.push({
        unitName,
        containsQty: resolved.containsQty,
        parentUnitName: resolved.parentUnitName,
        conversionQty: resolved.conversionQty,
        allowPurchase: row.allowPurchase,
        allowSale: row.allowSale,
        isDefaultPurchase: row.isDefaultPurchase,
        isDefaultSale: row.isDefaultSale,
        needsConfirmation: row.needsConfirmation,
      });
    }

    const cat = categoryMap.get(form.categoryId);
    const brand = brandMap.get(form.brandId);
    const defaultPurchaseUnit =
      packagingUnits.find((p) => p.isDefaultPurchase)?.unitName || baseUnit;
    const defaultSaleUnit = packagingUnits.find((p) => p.isDefaultSale)?.unitName || baseUnit;

    const buyVal = form.suggestedPurchasePrice.trim()
      ? Math.max(0, Number(form.suggestedPurchasePrice) || 0)
      : editorMode === 'edit'
      ? 0
      : undefined;
    const sellVal = form.suggestedSalePrice.trim()
      ? Math.max(0, Number(form.suggestedSalePrice) || 0)
      : editorMode === 'edit'
      ? 0
      : undefined;

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        variant: form.variant.trim(),
        categoryId: cat?.id || form.categoryId || '',
        categoryName: cat?.name || 'Other Products',
        brandId: brand?.id || '',
        brandName: brand?.name || 'Generic',
        originType: form.originType,
        baseUnit,
        defaultPurchaseUnit,
        defaultSaleUnit,
        packagingUnits,
        hasUnconfirmedPackaging: packagingUnits.some((u) => Boolean(u.needsConfirmation)),
        suggestedPurchasePrice: buyVal,
        suggestedSalePrice: sellVal,
        priceSource: form.priceSource.trim(),
        priceUpdatedAt: sellVal && sellVal > 0 ? new Date().getFullYear().toString() : '',
        bottleSize: form.bottleSize.trim(),
        storageLocation: form.storageLocation.trim(),
        trackExpiry: form.trackExpiry,
        isActive: true,
        isCustom: true,
      };

      if (editorMode === 'edit' && editingId) {
        await updateProductTemplate(shopId, editingId, payload);
        showToast({
          title: 'Catalog Template Updated',
          message: `"${payload.name}" updated cleanly.`,
          tone: 'success',
          durationMs: 3000,
        });
      } else {
        await createProductTemplate(shopId, payload);
        showToast({
          title: 'Catalog Template Added',
          message: `"${payload.name}" is now available in quick product suggestions.`,
          tone: 'success',
          durationMs: 3000,
        });
      }
      closeEditor();
    } catch (err) {
      showToast({
        title: 'Save Failed',
        message: err instanceof Error ? err.message : 'Could not save catalog template.',
        tone: 'error',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (tpl: ProductTemplate) => {
    if (!shopId) return;
    const nextActive = tpl.isActive === false;
    try {
      await toggleProductTemplateStatus(shopId, tpl.id, nextActive);
      showToast({
        title: nextActive ? 'Template Activated' : 'Template Hidden',
        message: nextActive
          ? `"${tpl.name}" will appear in Product Suggestions.`
          : `"${tpl.name}" hidden from suggestions; existing products unaffected.`,
        tone: 'info',
        durationMs: 3000,
      });
    } catch (err) {
      showToast({
        title: 'Status Update Failed',
        message: err instanceof Error ? err.message : 'Could not update template status.',
        tone: 'error',
      });
    }
  };

  const handleDeleteTemplate = async (tpl: ProductTemplate) => {
    if (!shopId) return;
    try {
      await deleteProductTemplate(shopId, tpl.id);
      setConfirmDeleteId(null);
      if (editingId === tpl.id) closeEditor();
      showToast({
        title: 'Template Removed',
        message: `"${tpl.name}" removed from catalog suggestions.`,
        tone: 'info',
        durationMs: 3000,
      });
    } catch (err) {
      showToast({
        title: 'Delete Failed',
        message: err instanceof Error ? err.message : 'Could not delete catalog template.',
        tone: 'error',
      });
    }
  };

  const handleRunCatalogAudit = async () => {
    if (!shopId || auditing) return;
    setAuditing(true);
    try {
      const report = await runLiveCatalogAuditAndSync(shopId, { syncMissing: true });
      setAuditReport(report);
      setShowAuditPanel(true);
      showToast({
        title: 'Catalog Audited & Synced',
        message: `${report.totalLiveCategories} categories · +${report.brandsAdded} brands, +${report.templatesAdded} templates synced (${report.templatesSkippedExisting} existing preserved).`,
        tone: 'success',
        durationMs: 4500,
      });
    } catch (err) {
      showToast({
        title: 'Audit Failed',
        message:
          err instanceof Error
            ? err.message
            : 'Could not run live Firebase catalog audit. Check internet connection.',
        tone: 'error',
      });
    } finally {
      setAuditing(false);
    }
  };

  return (
    <CompactSection
      title="Product Suggestion Catalog"
      subtitle="Preloaded & custom Category → Brand → Product templates for one-tap setup"
      summary={`${activeCount} active · ${productTemplates.length} templates${
        unconfirmedCount > 0 ? ` · ${unconfirmedCount} confirm pack` : ''
      }`}
      collapsible
      defaultOpen={false}
      bodyClassName="p-3.5 sm:p-4 space-y-3"
    >
      {/* Search, Category Filter, Brand Filter & Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1fr_175px_165px_145px_auto_auto] gap-2">
        <div className="relative min-w-0">
          <Search className="w-3.5 h-3.5 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Search catalog products, size, brand..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="cm-input w-full pl-8 pr-7 py-1.5 min-h-[38px] sm:min-h-0 text-sm border rounded-lg"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear catalog search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <select
          aria-label="Filter catalog by category"
          value={filterCatId}
          onChange={(e) => {
            const nextCat = e.target.value;
            setFilterCatId(nextCat);
            if (nextCat && filterBrandId) {
              const br = brandMap.get(filterBrandId);
              if (br && !(br.categoryIds || []).includes(nextCat)) {
                setFilterBrandId('');
              }
            }
          }}
          className="cm-input px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs sm:text-sm border rounded-lg"
        >
          <option value="">All Categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter catalog by brand"
          value={filterBrandId}
          onChange={(e) => setFilterBrandId(e.target.value)}
          className="cm-input px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs sm:text-sm border rounded-lg"
        >
          <option value="">All Brands</option>
          {filterBrands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter catalog by status"
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as 'all' | 'active' | 'inactive' | 'unconfirmed')
          }
          className="cm-input px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs sm:text-sm border rounded-lg"
        >
          <option value="all">All Status</option>
          <option value="active">Active Only</option>
          <option value="inactive">Hidden / Inactive</option>
          <option value="unconfirmed">Needs Pack Confirm</option>
        </select>

        <button
          type="button"
          disabled={auditing || !shopId}
          onClick={() => void handleRunCatalogAudit()}
          title="Audit all live Firebase categories, merge missing Pakistani/imported brands & templates safely"
          className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-[38px] sm:min-h-0 text-xs font-semibold cm-surface border rounded-lg text-[var(--cm-text-primary)] hover:bg-[var(--cm-bg-hover)] disabled:opacity-50 cursor-pointer shrink-0"
        >
          {auditing ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--cm-accent-text)]" />
          ) : (
            <ClipboardCheck className="w-3.5 h-3.5 text-[var(--cm-accent-text)]" />
          )}
          {auditing ? 'Auditing...' : 'Audit & Sync'}
        </button>

        <button
          type="button"
          onClick={() => (editorMode === 'create' ? closeEditor() : openCreateForm())}
          className="inline-flex items-center justify-center gap-1 px-3 py-1.5 min-h-[38px] sm:min-h-0 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          New Template
        </button>
      </div>

      {/* Collapsible Live Firebase Catalog Audit Report */}
      {auditReport && showAuditPanel && (
        <div className="p-3 sm:p-3.5 cm-subtle border rounded-xl space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-[var(--cm-text-primary)]">
              <ClipboardCheck className="w-4 h-4 text-[var(--cm-accent-text)]" />
              <span>Live Firebase Catalog Audit Report</span>
              <span className="text-[10px] font-normal text-[var(--cm-text-muted)]">
                ({products.length} store items checked)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowAuditPanel(false)}
              className="text-xs text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
            >
              Hide Report
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="p-2 cm-surface border rounded-lg">
              <div className="text-[10px] text-[var(--cm-text-muted)]">Categories Checked</div>
              <div className="font-semibold text-[var(--cm-text-primary)] font-mono-num">
                {auditReport.totalLiveCategories}
                {auditReport.customCategoryCount > 0 && (
                  <span className="text-[10px] font-normal text-[var(--cm-text-secondary)]">
                    {' '}
                    ({auditReport.customCategoryCount} custom)
                  </span>
                )}
              </div>
            </div>
            <div className="p-2 cm-surface border rounded-lg">
              <div className="text-[10px] text-[var(--cm-text-muted)]">Brands in Firebase</div>
              <div className="font-semibold text-[var(--cm-text-primary)] font-mono-num">
                {auditReport.totalLiveBrands}
                {(auditReport.brandsAdded > 0 || auditReport.brandsCategoryMerged > 0) && (
                  <span className="text-[10px] font-normal text-[var(--cm-success)]">
                    {' '}
                    (+{auditReport.brandsAdded} new / {auditReport.brandsCategoryMerged} linked)
                  </span>
                )}
              </div>
            </div>
            <div className="p-2 cm-surface border rounded-lg">
              <div className="text-[10px] text-[var(--cm-text-muted)]">Catalog Templates</div>
              <div className="font-semibold text-[var(--cm-text-primary)] font-mono-num">
                {auditReport.totalLiveTemplates}
                <span className="text-[10px] font-normal text-[var(--cm-text-secondary)]">
                  {' '}
                  (+{auditReport.templatesAdded} added · {auditReport.templatesSkippedExisting} kept)
                </span>
              </div>
            </div>
            <div className="p-2 cm-surface border rounded-lg">
              <div className="text-[10px] text-[var(--cm-text-muted)]">Verify Pack / Price</div>
              <div className="font-semibold text-[var(--cm-warning)] font-mono-num">
                {auditReport.totalUnconfirmedPackaging} pack · {auditReport.totalUnpricedTemplates}{' '}
                price
              </div>
            </div>
          </div>

          <div className="border border-[var(--cm-border)] rounded-lg overflow-x-auto max-h-64 overflow-y-auto cm-surface">
            <table className="w-full text-left text-[11px] border-collapse min-w-[540px]">
              <thead className="sticky top-0 cm-subtle border-b border-[var(--cm-border)] text-[var(--cm-text-secondary)]">
                <tr>
                  <th className="py-1.5 px-2.5 font-semibold">Category</th>
                  <th className="py-1.5 px-2 font-semibold text-right">Brands</th>
                  <th className="py-1.5 px-2 font-semibold text-right">Templates</th>
                  <th className="py-1.5 px-2 font-semibold text-right">Store Items</th>
                  <th className="py-1.5 px-2.5 font-semibold text-right">Confirm Pack / Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--cm-border)]">
                {auditReport.categories.map((row) => (
                  <tr
                    key={row.categoryId}
                    onClick={() => setFilterCatId(row.categoryId)}
                    title="Click to filter catalog templates by this category"
                    className="hover:bg-[var(--cm-bg-hover)] cursor-pointer"
                  >
                    <td className="py-1.5 px-2.5">
                      <div className="font-medium text-[var(--cm-text-primary)] flex items-center gap-1.5">
                        <span>{row.categoryName}</span>
                        {!row.isCanonical && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--cm-info-soft)] text-[var(--cm-info)]">
                            Custom
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono-num text-[var(--cm-text-primary)]">
                      {row.liveBrandCount}
                      {row.brandsAdded > 0 && (
                        <span className="text-[var(--cm-success)]"> (+{row.brandsAdded})</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono-num text-[var(--cm-text-primary)]">
                      {row.liveTemplateCount}
                      {row.templatesAdded > 0 && (
                        <span className="text-[var(--cm-success)]"> (+{row.templatesAdded})</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono-num text-[var(--cm-text-secondary)]">
                      {row.liveStoreProductCount}
                    </td>
                    <td className="py-1.5 px-2.5 text-right font-mono-num text-[var(--cm-warning)]">
                      {row.unconfirmedPackagingCount} / {row.unpricedTemplateCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add / Edit Template Drawer */}
      {editorMode && (
        <div className="p-3 sm:p-3.5 cm-subtle border rounded-xl space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs sm:text-sm font-semibold text-[var(--cm-text-primary)]">
              {editorMode === 'edit' ? 'Edit Catalog Template' : 'Add Catalog Product Template'}
            </span>
            <button
              type="button"
              onClick={closeEditor}
              className="text-xs text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
            >
              Close
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Product Name *
              </label>
              <input
                type="text"
                maxLength={180}
                placeholder="e.g., Pepsi Cola 1.5 Litre PET or Molfix Maxi No. 4 (50 Pcs)"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="cm-input w-full px-3 py-1.5 text-sm border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Variant / Size Spec
              </label>
              <input
                type="text"
                maxLength={120}
                placeholder="e.g., 500ml PET, Maxi 50 Pcs"
                value={form.variant}
                onChange={(e) => setForm({ ...form, variant: e.target.value })}
                className="cm-input w-full px-3 py-1.5 text-sm border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Category *
              </label>
              <select
                value={form.categoryId}
                onChange={(e) => {
                  const nextCat = e.target.value;
                  setForm((prev) => {
                    let nextBrand = prev.brandId;
                    if (nextCat && nextBrand && filterFormBrandsByCategory) {
                      const br = brandMap.get(nextBrand);
                      if (br && !(br.categoryIds || []).includes(nextCat)) {
                        nextBrand = '';
                      }
                    }
                    return { ...prev, categoryId: nextCat, brandId: nextBrand };
                  });
                }}
                className="cm-input w-full px-2.5 py-1.5 text-sm border rounded-lg"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="text-[11px] font-medium text-[var(--cm-text-secondary)]">
                  Brand
                </label>
                {form.categoryId && (
                  <button
                    type="button"
                    onClick={() => setFilterFormBrandsByCategory((v) => !v)}
                    className="text-[10px] font-medium text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                  >
                    {filterFormBrandsByCategory ? 'Category Only' : 'All Brands'}
                  </button>
                )}
              </div>
              <select
                value={form.brandId}
                onChange={(e) => setForm({ ...form, brandId: e.target.value })}
                className="cm-input w-full px-2.5 py-1.5 text-sm border rounded-lg"
              >
                <option value="">Generic / Unbranded</option>
                {formBrandChoices.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Origin
              </label>
              <select
                value={form.originType}
                onChange={(e) => setForm({ ...form, originType: e.target.value as OriginType })}
                className="cm-input w-full px-2.5 py-1.5 text-sm border rounded-lg"
              >
                <option value="">Standard / Unspecified</option>
                <option value="local">Local</option>
                <option value="imported">Imported</option>
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[11px] font-medium text-[var(--cm-text-secondary)]">
                  Smallest Stock Unit *
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setForm((prev) => ({ ...prev, customBaseUnit: !prev.customBaseUnit }))
                  }
                  className="text-[10px] text-[var(--cm-accent-text)] hover:underline cursor-pointer"
                >
                  {form.customBaseUnit ? 'List' : 'Custom'}
                </button>
              </div>
              {form.customBaseUnit ? (
                <input
                  type="text"
                  maxLength={40}
                  value={form.baseUnit}
                  onChange={(e) => setForm({ ...form, baseUnit: e.target.value })}
                  className="cm-input w-full px-2.5 py-1.5 text-sm border rounded-lg"
                />
              ) : (
                <select
                  value={form.baseUnit}
                  onChange={(e) => setForm({ ...form, baseUnit: e.target.value })}
                  className="cm-input w-full px-2.5 py-1.5 text-sm border rounded-lg"
                >
                  {STANDARD_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Est. Purchase / {form.baseUnit} (Opt.)
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="Blank = unverified"
                value={form.suggestedPurchasePrice}
                onChange={(e) =>
                  setForm({ ...form, suggestedPurchasePrice: e.target.value })
                }
                className="cm-input w-full px-2.5 py-1.5 text-sm border rounded-lg font-mono-num"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Est. Retail / {form.baseUnit} (Opt.)
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="Blank = unverified"
                value={form.suggestedSalePrice}
                onChange={(e) => setForm({ ...form, suggestedSalePrice: e.target.value })}
                className="cm-input w-full px-2.5 py-1.5 text-sm border rounded-lg font-mono-num"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Price Reference Note (Opt.)
              </label>
              <input
                type="text"
                maxLength={150}
                placeholder="e.g., Market Estimate"
                value={form.priceSource}
                onChange={(e) => setForm({ ...form, priceSource: e.target.value })}
                className="cm-input w-full px-2.5 py-1.5 text-sm border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Pack / Bottle Size (Opt.)
              </label>
              <input
                type="text"
                maxLength={40}
                placeholder="e.g., 500ml, 200g"
                value={form.bottleSize}
                onChange={(e) => setForm({ ...form, bottleSize: e.target.value })}
                className="cm-input w-full px-2.5 py-1.5 text-sm border rounded-lg"
              />
            </div>

            <div>
              <label className="block text-[11px] font-medium text-[var(--cm-text-secondary)] mb-1">
                Default Shelf / Aisle (Opt.)
              </label>
              <input
                type="text"
                maxLength={80}
                placeholder="e.g., Cold Drinks Chiller"
                value={form.storageLocation}
                onChange={(e) => setForm({ ...form, storageLocation: e.target.value })}
                className="cm-input w-full px-2.5 py-1.5 text-sm border rounded-lg"
              />
            </div>
          </div>

          {/* Packaging Levels inside template */}
          <div className="p-2.5 cm-surface border rounded-lg space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-[var(--cm-text-primary)]">
                Packaging Hierarchy ({form.packagingUnits.length})
              </span>
              <button
                type="button"
                onClick={handleAddPkgRow}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-[var(--cm-accent-text)] bg-[var(--cm-accent-soft)] border border-[var(--cm-accent-border)] rounded cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                Add Level
              </button>
            </div>
            {form.packagingUnits.length > 0 && (
              <div className="space-y-2">
                {form.packagingUnits.map((row, idx) => {
                  const parentCands = [form.baseUnit.trim() || 'Piece'];
                  for (let i = 0; i < idx; i += 1) {
                    const u = form.packagingUnits[i].unitName.trim();
                    if (u && !parentCands.includes(u)) parentCands.push(u);
                  }
                  return (
                    <div
                      key={row.key}
                      className="grid grid-cols-1 sm:grid-cols-[110px_80px_120px_1fr_auto] gap-1.5 items-center p-2 cm-subtle border rounded-md text-xs"
                    >
                      <input
                        type="text"
                        maxLength={40}
                        placeholder="Packet / Carton"
                        value={row.unitName}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            packagingUnits: prev.packagingUnits.map((r) =>
                              r.key === row.key ? { ...r, unitName: e.target.value } : r
                            ),
                          }))
                        }
                        className="cm-input px-2 py-1 text-xs border rounded"
                      />
                      <input
                        type="number"
                        min="0.001"
                        step="any"
                        placeholder="Qty"
                        value={row.containsQty}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            packagingUnits: prev.packagingUnits.map((r) =>
                              r.key === row.key ? { ...r, containsQty: e.target.value } : r
                            ),
                          }))
                        }
                        className="cm-input px-2 py-1 text-xs border rounded font-mono-num"
                      />
                      <select
                        value={
                          parentCands.includes(row.parentUnitName)
                            ? row.parentUnitName
                            : parentCands[0]
                        }
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            packagingUnits: prev.packagingUnits.map((r) =>
                              r.key === row.key
                                ? { ...r, parentUnitName: e.target.value }
                                : r
                            ),
                          }))
                        }
                        className="cm-input px-2 py-1 text-xs border rounded"
                      >
                        {parentCands.map((c) => (
                          <option key={c} value={c}>
                            {pluralizeUnit(c, 2)}
                          </option>
                        ))}
                      </select>
                      <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--cm-text-secondary)] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={row.needsConfirmation}
                          onChange={(e) =>
                            setForm((prev) => ({
                              ...prev,
                              packagingUnits: prev.packagingUnits.map((r) =>
                                r.key === row.key
                                  ? { ...r, needsConfirmation: e.target.checked }
                                  : r
                              ),
                            }))
                          }
                          className="accent-[var(--cm-warning)]"
                        />
                        <span>Confirm pack qty</span>
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          setForm((prev) => ({
                            ...prev,
                            packagingUnits: prev.packagingUnits.filter(
                              (r) => r.key !== row.key
                            ),
                          }))
                        }
                        className="p-1 text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] cursor-pointer justify-self-end"
                        aria-label="Remove level"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex items-center gap-2 text-xs text-[var(--cm-text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={form.trackExpiry}
                onChange={(e) => setForm({ ...form, trackExpiry: e.target.checked })}
                className="accent-[var(--cm-accent)]"
              />
              <span>Usually has expiry date</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeEditor}
                className="px-3 py-1.5 text-xs cm-surface border rounded-lg text-[var(--cm-text-secondary)] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving || !form.name.trim() || Boolean(duplicateTemplate)}
                onClick={() => void handleSaveTemplate()}
                className="inline-flex items-center gap-1 px-3.5 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] disabled:opacity-50 rounded-lg cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                {saving
                  ? 'Saving...'
                  : editorMode === 'edit'
                  ? 'Save Changes'
                  : 'Save Template'}
              </button>
            </div>
          </div>

          {duplicateTemplate && (
            <div className="p-2 bg-[var(--cm-warning-soft)] border border-[var(--cm-warning-border)] rounded-lg text-[11px] text-[var(--cm-warning)]">
              Duplicate prevented: &ldquo;{duplicateTemplate.name}&rdquo; already exists for
              this category, brand &amp; variant.
            </div>
          )}
        </div>
      )}

      {/* Results Count */}
      <div className="flex items-center justify-between text-[11px] text-[var(--cm-text-muted)]">
        <span>
          Showing {filteredTemplates.length} of {productTemplates.length} catalog templates
        </span>
        {(search || filterCatId || filterBrandId || statusFilter !== 'all') && (
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setFilterCatId('');
              setFilterBrandId('');
              setStatusFilter('all');
            }}
            className="text-[var(--cm-accent-text)] hover:underline cursor-pointer"
          >
            Reset filters
          </button>
        )}
      </div>

      {/* Templates List */}
      <div className="divide-y divide-[var(--cm-border)] max-h-96 overflow-y-auto border border-[var(--cm-border)] rounded-xl">
        {filteredTemplates.length === 0 ? (
          <div className="p-4 text-center text-xs text-[var(--cm-text-muted)]">
            No catalog templates match your search or category/brand filters.
          </div>
        ) : (
          filteredTemplates.map((tpl) => {
            const active = tpl.isActive !== false;
            const packSummary = (tpl.packagingUnits || [])
              .map(
                (u) =>
                  `1 ${u.unitName} = ${formatNumber(u.containsQty)} ${pluralizeUnit(
                    u.parentUnitName || tpl.baseUnit,
                    u.containsQty
                  )}`
              )
              .join(' · ');

            return (
              <div key={tpl.id} className="p-2.5 sm:px-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`text-xs sm:text-sm font-semibold ${
                          active
                            ? 'text-[var(--cm-text-primary)]'
                            : 'text-[var(--cm-text-muted)] line-through'
                        }`}
                      >
                        {tpl.name}
                      </span>
                      {tpl.variant && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded cm-subtle border border-[var(--cm-border)] text-[var(--cm-text-secondary)]">
                          {tpl.variant}
                        </span>
                      )}
                      {tpl.originType && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--cm-info-soft)] text-[var(--cm-info)] capitalize">
                          {tpl.originType}
                        </span>
                      )}
                      {tpl.hasUnconfirmedPackaging && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--cm-warning-soft)] border border-[var(--cm-warning-border)] text-[var(--cm-warning)]"
                          title="Packaging count is estimated — confirm before finalizing"
                        >
                          <AlertTriangle className="w-2.5 h-2.5" />
                          Confirm pack qty
                        </span>
                      )}
                      {!active && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded cm-subtle border border-[var(--cm-border)] text-[var(--cm-text-muted)]">
                          Hidden
                        </span>
                      )}
                    </div>

                    <div className="text-[11px] text-[var(--cm-text-secondary)] flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>
                        {tpl.categoryName} · {tpl.brandName} · Base: {tpl.baseUnit}
                      </span>
                      {packSummary && (
                        <span className="font-mono-num text-[var(--cm-text-muted)]">
                          ({packSummary})
                        </span>
                      )}
                      {tpl.suggestedSalePrice !== undefined && tpl.suggestedSalePrice > 0 && (
                        <span className="font-mono-num text-[var(--cm-accent-text)]">
                          Est. {formatPKR(tpl.suggestedSalePrice)}/{tpl.baseUnit}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => openEditForm(tpl)}
                      title="Edit template"
                      className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-accent-text)] rounded-lg cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleActive(tpl)}
                      title={active ? 'Hide from suggestions' : 'Activate in suggestions'}
                      className={`p-1.5 rounded-lg cursor-pointer ${
                        active
                          ? 'text-[var(--cm-success)] hover:bg-[var(--cm-bg-hover)]'
                          : 'text-[var(--cm-text-muted)] hover:text-[var(--cm-success)]'
                      }`}
                    >
                      <Power className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setConfirmDeleteId((prev) => (prev === tpl.id ? null : tpl.id))
                      }
                      title="Delete template"
                      className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] rounded-lg cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {confirmDeleteId === tpl.id && (
                  <div className="p-2 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-[var(--cm-danger)]">
                      Remove &ldquo;{tpl.name}&rdquo; from catalog suggestions? Existing products &amp; sales history are NOT deleted.
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleDeleteTemplate(tpl)}
                        className="px-2 py-1 text-[11px] font-semibold bg-[var(--cm-danger)] text-white rounded cursor-pointer"
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2 py-1 text-[11px] cm-surface border rounded cursor-pointer text-[var(--cm-text-secondary)]"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </CompactSection>
  );
}
