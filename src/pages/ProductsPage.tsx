import { Edit3, Filter, Plus, Search, Trash2, X } from 'lucide-react';
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
  createSupplier,
  deleteProduct,
  updateProduct,
} from '../services/shopService';
import type { Product } from '../types/shop';
import {
  calcProfitMarginPct,
  formatDateDDMMYYYY,
  formatPKR,
  getKarachiDateIso,
  getProductStockStatus,
} from '../utils/formatters';

const UNITS = ['Pack', 'Piece', 'Box', 'Bottle', 'Carton', 'Dozen', 'Roll', 'Sachet', 'Kg', 'Gram', 'Litre', 'ml'];

interface ProductFormState {
  name: string;
  categoryId: string;
  brandId: string;
  purchasePrice: string;
  salePrice: string;
  wholesalePrice: string;
  currentStock: string;
  minStockLevel: string;
  maxStockLevel: string;
  unit: string;
  supplierId: string;
  expiryDate: string;
}

const emptyForm: ProductFormState = {
  name: '',
  categoryId: '',
  brandId: '',
  purchasePrice: '',
  salePrice: '',
  wholesalePrice: '0',
  currentStock: '0',
  minStockLevel: '5',
  maxStockLevel: '100',
  unit: 'Pack',
  supplierId: '',
  expiryDate: '',
};

export function ProductsPage() {
  const { user, shopId } = useAuth();
  const activeShopId = shopId || user?.uid || '';
  const { products, categories, brands, suppliers, settings } = useShopData();
  const { showToast } = useToast();

  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterSupplier, setFilterSupplier] = useState('');
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

  const brandOptions = useMemo<SearchableSelectOption[]>(
    () =>
      brands.map((b) => ({
        value: b.id,
        label: b.name,
        subtitle: 'Product brand',
      })),
    [brands]
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
    () => UNITS.map((u) => ({ value: u, label: u, subtitle: 'Stock unit' })),
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
    () => computeTopActivityValues(products, (p) => p.unit, 5),
    [products]
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Quick inline add for Category / Brand / Supplier
  const [quickType, setQuickType] = useState<'category' | 'brand' | 'supplier' | null>(null);
  const [quickName, setQuickName] = useState('');
  const [quickPhone, setQuickPhone] = useState('');

  const todayIso = getKarachiDateIso();
  const alertDays = settings?.expiryAlertDays ?? 30;

  const liveMarginPct = useMemo(
    () => calcProfitMarginPct(Number(form.purchasePrice) || 0, Number(form.salePrice) || 0),
    [form.purchasePrice, form.salePrice]
  );

  const openAddModal = () => {
    setEditing(null);
    setForm({
      ...emptyForm,
      categoryId: categories[0]?.id || '',
      brandId: brands[0]?.id || '',
      supplierId: suppliers[0]?.id || '',
    });
    setError(null);
    setModalOpen(true);
  };

  const openEditModal = (p: Product) => {
    setEditing(p);
    setForm({
      name: p.name,
      categoryId: p.categoryId,
      brandId: p.brandId,
      purchasePrice: String(p.purchasePrice),
      salePrice: String(p.salePrice),
      wholesalePrice: String(p.wholesalePrice),
      currentStock: String(p.currentStock),
      minStockLevel: String(p.minStockLevel),
      maxStockLevel: String(p.maxStockLevel),
      unit: p.unit,
      supplierId: p.supplierId,
      expiryDate: p.expiryDate,
    });
    setError(null);
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShopId) return;
    setError(null);

    if (!form.name.trim()) {
      setError('Product name is required.');
      return;
    }

    const cat = categories.find((c) => c.id === form.categoryId);
    const brand = brands.find((b) => b.id === form.brandId);
    const sup = suppliers.find((s) => s.id === form.supplierId);

    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        categoryId: cat?.id || '',
        categoryName: cat?.name || 'Uncategorized',
        brandId: brand?.id || '',
        brandName: brand?.name || 'Generic',
        purchasePrice: Number(form.purchasePrice) || 0,
        salePrice: Number(form.salePrice) || 0,
        wholesalePrice: Number(form.wholesalePrice) || 0,
        minStockLevel: Number(form.minStockLevel) || 0,
        maxStockLevel: Number(form.maxStockLevel) || 0,
        unit: form.unit || 'Pack',
        supplierId: sup?.id || '',
        supplierName: sup?.name || 'Walk-in / Direct',
        expiryDate: form.expiryDate || '',
        isActive: true,
      };

      if (editing) {
        await updateProduct(activeShopId, editing.id, payload);
        showToast({ title: 'Product updated', message: payload.name, tone: 'success' });
      } else {
        await createProduct(activeShopId, {
          ...payload,
          currentStock: Number(form.currentStock) || 0,
        });
        showToast({ title: 'Product added', message: payload.name, tone: 'success' });
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
    if (quickType === 'category') {
      const id = await createCategory(activeShopId, quickName, '');
      setForm((f) => ({ ...f, categoryId: id }));
    } else if (quickType === 'brand') {
      const id = await createBrand(activeShopId, quickName);
      setForm((f) => ({ ...f, brandId: id }));
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
    setQuickType(null);
  };

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (filterCat && p.categoryId !== filterCat) return false;
      if (filterBrand && p.brandId !== filterBrand) return false;
      if (filterSupplier && p.supplierId !== filterSupplier) return false;
      if (q) {
        const hay = `${p.name} ${p.categoryName} ${p.brandName} ${p.supplierName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [products, search, filterCat, filterBrand, filterSupplier]);

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 sm:p-4 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search products, brand, supplier..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full min-h-[40px] pl-9 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowMobileFilters((v) => !v)}
              className="lg:hidden min-h-[40px] inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg cursor-pointer"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>{showMobileFilters ? 'Hide' : 'Filters'}</span>
            </button>
            <button
              type="button"
              onClick={openAddModal}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 text-xs sm:text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Add Product</span>
            </button>
          </div>
        </div>

        <div
          className={`${
            showMobileFilters ? 'grid' : 'hidden lg:grid'
          } grid-cols-1 sm:grid-cols-3 gap-2`}
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
        </div>
      </div>

      {/* Product List */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <span className="font-semibold text-slate-800">Product Catalog</span>
          <span className="font-mono-num">{filteredProducts.length} products</span>
        </div>

        {filteredProducts.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm text-slate-500">
              {products.length === 0
                ? 'No products added yet. Add diapers, baby wipes, tissues, or toiletries to begin.'
                : 'No products match your search filters.'}
            </p>
            {products.length === 0 && (
              <button
                type="button"
                onClick={openAddModal}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add First Product
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Mobile Compact Expandable List */}
            <div className="md:hidden divide-y divide-slate-100">
              {filteredProducts.map((p) => {
                const st = getProductStockStatus(p, todayIso, alertDays);
                const stockClass = st.isOutOfStock
                  ? 'text-red-600 font-semibold'
                  : st.isLowStock
                    ? 'text-amber-600 font-semibold'
                    : 'text-emerald-700';

                return (
                  <CompactExpandableRow
                    key={p.id}
                    title={p.name}
                    subtitle={`${p.categoryName} · ${p.brandName}`}
                    rightPrimary={formatPKR(p.salePrice)}
                    rightSecondary={
                      <span className={stockClass}>
                        {p.currentStock} {p.unit}
                      </span>
                    }
                    isExpanded={expandedProductId === p.id}
                    onToggle={() =>
                      setExpandedProductId((cur) => (cur === p.id ? null : p.id))
                    }
                    expandedContent={
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <span className="text-slate-500">Cost:</span>{' '}
                            <span className="font-mono-num font-medium text-slate-900">
                              {formatPKR(p.purchasePrice)}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500">Margin:</span>{' '}
                            <span className="font-mono-num font-semibold text-emerald-700">
                              {p.profitMarginPct}%
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500">Supplier:</span>{' '}
                            <span className="text-slate-800">{p.supplierName || '—'}</span>
                          </div>
                          <div>
                            <span className="text-slate-500">Expiry:</span>{' '}
                            <span className="font-mono-num text-slate-800">
                              {p.expiryDate ? formatDateDDMMYYYY(p.expiryDate) : '—'}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => openEditModal(p)}
                            className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
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
                            className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
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
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-3">Product Name</th>
                    <th className="py-2.5 px-3">Category · Brand</th>
                    <th className="py-2.5 px-3 text-right">Purchase Price</th>
                    <th className="py-2.5 px-3 text-right">Sale Price</th>
                    <th className="py-2.5 px-3 text-right">Margin</th>
                    <th className="py-2.5 px-3 text-right">Stock</th>
                    <th className="py-2.5 px-3">Supplier</th>
                    <th className="py-2.5 px-3">Expiry</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
                  {filteredProducts.map((p) => {
                    const st = getProductStockStatus(p, todayIso, alertDays);
                    const stockClass = st.isOutOfStock
                      ? 'text-red-600 font-semibold'
                      : st.isLowStock
                      ? 'text-amber-600 font-semibold'
                      : 'text-slate-900';

                    return (
                      <tr key={p.id} className="hover:bg-slate-50">
                        <td className="py-2 px-3 font-medium text-slate-900">{p.name}</td>
                        <td className="py-2 px-3 text-xs text-slate-500">
                          {p.categoryName} · {p.brandName}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num text-slate-700 whitespace-nowrap">
                          {formatPKR(p.purchasePrice)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num font-semibold text-slate-900 whitespace-nowrap">
                          {formatPKR(p.salePrice)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono-num text-emerald-700">
                          {p.profitMarginPct}%
                        </td>
                        <td className={`py-2 px-3 text-right font-mono-num whitespace-nowrap ${stockClass}`}>
                          {p.currentStock} {p.unit}
                        </td>
                        <td className="py-2 px-3 text-xs text-slate-600">{p.supplierName || '—'}</td>
                        <td className="py-2 px-3 font-mono-num text-xs">
                          {p.expiryDate ? (
                            <span
                              className={
                                st.isExpired
                                  ? 'text-red-600 font-semibold'
                                  : st.isNearingExpiry
                                  ? 'text-amber-600 font-semibold'
                                  : 'text-slate-600'
                              }
                            >
                              {formatDateDDMMYYYY(p.expiryDate)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openEditModal(p)}
                              className="p-1.5 text-slate-500 hover:text-teal-700 rounded cursor-pointer"
                              title="Edit product"
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => activeShopId && void deleteProduct(activeShopId, p)}
                              className="p-1.5 text-slate-500 hover:text-red-600 rounded cursor-pointer"
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
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white border border-slate-200 rounded-t-2xl sm:rounded-xl w-full max-w-2xl max-h-[92vh] flex flex-col">
            <div className="px-4 py-3 sm:px-5 border-b border-slate-200 flex items-center justify-between shrink-0">
              <h3 className="text-sm sm:text-base font-semibold text-slate-900">
                {editing ? 'Edit Product' : 'Add New Product'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col min-h-0 flex-1">
              <div className="p-4 sm:p-5 space-y-3.5 overflow-y-auto flex-1">
                {error && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs sm:text-sm text-red-700">{error}</div>
                )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">1. Product Name *</label>
                  <input
                    type="text"
                    required
                    maxLength={180}
                    placeholder="e.g., Pampers Active Baby Size 4 (44 pcs)"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-teal-600"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-slate-700">2. Category</label>
                    <button
                      type="button"
                      onClick={() => setQuickType('category')}
                      className="text-xs text-teal-700 hover:underline cursor-pointer"
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
                    onChange={(val) => setForm({ ...form, categoryId: val })}
                    emptyOptionLabel="Uncategorized"
                    placeholder="Search category..."
                    searchPlaceholder="Type category name..."
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-slate-700">3. Brand</label>
                    <button
                      type="button"
                      onClick={() => setQuickType('brand')}
                      className="text-xs text-teal-700 hover:underline cursor-pointer"
                    >
                      + New
                    </button>
                  </div>
                  <SearchableSelect
                    ariaLabel="Select brand"
                    suggestionScope="brand"
                    suggestedValues={frequentBrandIds}
                    options={brandOptions}
                    value={form.brandId}
                    onChange={(val) => setForm({ ...form, brandId: val })}
                    emptyOptionLabel="Generic / Unbranded"
                    placeholder="Search brand..."
                    searchPlaceholder="Type brand name..."
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">4. Purchase Price (PKR) *</label>
                  <input
                    type="number"
                    required
                    min={0}
                    step="0.01"
                    value={form.purchasePrice}
                    onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">5. Sale Price (PKR) *</label>
                  <input
                    type="number"
                    required
                    min={0}
                    step="0.01"
                    value={form.salePrice}
                    onChange={(e) => setForm({ ...form, salePrice: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    6. Wholesale Price (Optional, PKR)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={form.wholesalePrice}
                    onChange={(e) => setForm({ ...form, wholesalePrice: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    13. Profit Margin % (Auto)
                  </label>
                  <div className="px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50 font-mono-num font-semibold text-emerald-700">
                    {liveMarginPct}%
                  </div>
                </div>

                {!editing && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      7. Initial Stock Quantity
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={form.currentStock}
                      onChange={(e) => setForm({ ...form, currentStock: e.target.value })}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">8. Minimum Stock Level</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={form.minStockLevel}
                    onChange={(e) => setForm({ ...form, minStockLevel: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">9. Maximum Stock Level</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={form.maxStockLevel}
                    onChange={(e) => setForm({ ...form, maxStockLevel: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">10. Unit of Measurement</label>
                  <SearchableSelect
                    ariaLabel="Select unit of measurement"
                    suggestionScope="unit"
                    suggestedValues={frequentUnits}
                    options={unitOptions}
                    value={form.unit}
                    onChange={(val) => setForm({ ...form, unit: val || 'Pack' })}
                    placeholder="Select unit..."
                    searchPlaceholder="Search unit..."
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium text-slate-700">11. Supplier</label>
                    <button
                      type="button"
                      onClick={() => setQuickType('supplier')}
                      className="text-xs text-teal-700 hover:underline cursor-pointer"
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
                    placeholder="Search supplier by name or phone..."
                    searchPlaceholder="Type supplier name or phone..."
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    12. Expiry Date (Where Applicable)
                  </label>
                  <input
                    type="date"
                    value={form.expiryDate}
                    onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-mono-num"
                  />
                </div>
              </div>

              {quickType && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                  <div className="text-xs font-semibold text-slate-700 capitalize">
                    Quick Add {quickType}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="text"
                      placeholder={`Enter ${quickType} name`}
                      value={quickName}
                      onChange={(e) => setQuickName(e.target.value)}
                      className="flex-1 min-w-[160px] px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white"
                    />
                    {quickType === 'supplier' && (
                      <input
                        type="text"
                        placeholder="Phone (optional)"
                        value={quickPhone}
                        onChange={(e) => setQuickPhone(e.target.value)}
                        className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => void handleQuickCreate()}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 rounded-lg"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickType(null)}
                      className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg bg-white"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              </div>

              <div className="px-4 py-3 sm:px-5 border-t border-slate-200 bg-white flex justify-end gap-2 shrink-0 rounded-b-xl">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="min-h-[42px] px-4 py-2 text-sm font-medium text-slate-700 border border-slate-200 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="min-h-[42px] px-5 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg disabled:opacity-50 cursor-pointer"
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
