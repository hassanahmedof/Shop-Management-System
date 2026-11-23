import { Check, Edit3, Plus, Power, Search, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import {
  createBrand,
  deleteBrand,
  toggleBrandStatus,
  updateBrand,
} from '../services/shopService';
import type { Brand, Category, Product } from '../types/shop';
import {
  findExactBrandMatch,
  findSimilarBrands,
  formatBrandCategoryNames,
  isBrandActive,
} from '../utils/brands';
import { CompactSection } from './CompactSection';

interface BrandManagerSectionProps {
  shopId: string;
  brands: Brand[];
  categories: Category[];
  products: Product[];
}

export function BrandManagerSection({
  shopId,
  brands,
  categories,
  products,
}: BrandManagerSectionProps) {
  const { showToast } = useToast();

  const [search, setSearch] = useState('');
  const [filterCatId, setFilterCatId] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  // Add brand state
  const [showAddForm, setShowAddForm] = useState(false);
  const [newBrandName, setNewBrandName] = useState('');
  const [newBrandCatIds, setNewBrandCatIds] = useState<string[]>([]);
  const [savingNew, setSavingNew] = useState(false);

  // Edit brand state
  const [editingBrandId, setEditingBrandId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCatIds, setEditCatIds] = useState<string[]>([]);
  const [editIsActive, setEditIsActive] = useState(true);
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete confirmation (prevent accidental deletion of brands attached to products)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const categoryNameMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories]
  );

  const productCountByBrand = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of products) {
      if (!p.brandId) continue;
      map.set(p.brandId, (map.get(p.brandId) || 0) + 1);
    }
    return map;
  }, [products]);

  const activeCount = useMemo(
    () => brands.filter((b) => isBrandActive(b)).length,
    [brands]
  );

  const newExactMatch = useMemo(
    () => (newBrandName.trim() ? findExactBrandMatch(newBrandName, brands) : null),
    [newBrandName, brands]
  );

  const newSimilarMatches = useMemo(
    () => (newBrandName.trim() ? findSimilarBrands(newBrandName, brands, undefined, 4) : []),
    [newBrandName, brands]
  );

  const editExactMatch = useMemo(
    () =>
      editingBrandId && editName.trim()
        ? findExactBrandMatch(editName, brands, editingBrandId)
        : null,
    [editingBrandId, editName, brands]
  );

  const editSimilarMatches = useMemo(
    () =>
      editingBrandId && editName.trim()
        ? findSimilarBrands(editName, brands, editingBrandId, 3)
        : [],
    [editingBrandId, editName, brands]
  );

  const filteredBrands = useMemo(() => {
    const q = search.trim().toLowerCase();
    return brands.filter((b) => {
      const active = isBrandActive(b);
      if (statusFilter === 'active' && !active) return false;
      if (statusFilter === 'inactive' && active) return false;
      if (filterCatId && !(b.categoryIds || []).includes(filterCatId)) return false;
      if (q) {
        const catNames = (b.categoryIds || [])
          .map((cid) => categoryNameMap.get(cid) || '')
          .join(' ')
          .toLowerCase();
        if (!b.name.toLowerCase().includes(q) && !catNames.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [brands, search, filterCatId, statusFilter, categoryNameMap]);

  const openEditBrand = (b: Brand) => {
    setEditingBrandId(b.id);
    setEditName(b.name);
    setEditCatIds(Array.isArray(b.categoryIds) ? [...b.categoryIds] : []);
    setEditIsActive(isBrandActive(b));
    setConfirmDeleteId(null);
  };

  const handleAddBrand = async () => {
    if (!shopId || !newBrandName.trim()) return;
    if (newExactMatch) {
      showToast({
        title: 'Duplicate brand prevented',
        message: `"${newExactMatch.name}" already exists.`,
        tone: 'info',
        durationMs: 3500,
      });
      return;
    }

    setSavingNew(true);
    try {
      const trimmed = newBrandName.trim().replace(/\s+/g, ' ');
      await createBrand(shopId, {
        name: trimmed,
        categoryIds: newBrandCatIds,
        isActive: true,
      });
      setNewBrandName('');
      setNewBrandCatIds([]);
      setShowAddForm(false);
      showToast({
        title: 'Brand Added',
        message: `"${trimmed}" added to brand library.`,
        tone: 'success',
        durationMs: 3000,
      });
    } catch (err) {
      showToast({
        title: 'Could not add brand',
        message: err instanceof Error ? err.message : 'Failed to create brand.',
        tone: 'error',
        durationMs: 4000,
      });
    } finally {
      setSavingNew(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!shopId || !editingBrandId || !editName.trim()) return;
    if (editExactMatch) {
      showToast({
        title: 'Duplicate brand prevented',
        message: `Another brand named "${editExactMatch.name}" already exists.`,
        tone: 'error',
        durationMs: 3500,
      });
      return;
    }

    setSavingEdit(true);
    try {
      const trimmed = editName.trim().replace(/\s+/g, ' ');
      await updateBrand(shopId, editingBrandId, {
        name: trimmed,
        categoryIds: editCatIds,
        isActive: editIsActive,
      });
      setEditingBrandId(null);
      showToast({
        title: 'Brand Updated',
        message: `"${trimmed}" updated across brand library & products.`,
        tone: 'success',
        durationMs: 3000,
      });
    } catch (err) {
      showToast({
        title: 'Update Failed',
        message: err instanceof Error ? err.message : 'Could not update brand.',
        tone: 'error',
        durationMs: 4000,
      });
    } finally {
      setSavingEdit(false);
    }
  };

  const handleToggleActive = async (b: Brand) => {
    if (!shopId) return;
    const nextActive = !isBrandActive(b);
    try {
      await toggleBrandStatus(shopId, b.id, nextActive);
      showToast({
        title: nextActive ? 'Brand Activated' : 'Brand Deactivated',
        message: nextActive
          ? `"${b.name}" is now selectable on new products.`
          : `"${b.name}" hidden from new products; existing products preserved.`,
        tone: 'info',
        durationMs: 3000,
      });
    } catch (err) {
      showToast({
        title: 'Status Update Failed',
        message: err instanceof Error ? err.message : 'Could not update brand status.',
        tone: 'error',
      });
    }
  };

  const handleDeleteBrand = async (b: Brand) => {
    if (!shopId) return;
    try {
      await deleteBrand(shopId, b.id);
      setConfirmDeleteId(null);
      if (editingBrandId === b.id) setEditingBrandId(null);
      showToast({
        title: 'Brand Removed',
        message: `"${b.name}" removed from brand library.`,
        tone: 'info',
        durationMs: 3000,
      });
    } catch (err) {
      showToast({
        title: 'Delete Failed',
        message: err instanceof Error ? err.message : 'Could not delete brand.',
        tone: 'error',
      });
    }
  };

  return (
    <CompactSection
      title="Brand Library & Management"
      summary={`${activeCount} active · ${brands.length} total`}
      collapsible
      defaultOpen={false}
      bodyClassName="p-3.5 sm:p-4 space-y-3"
    >
      {/* Search, Category Filter & Add Toggle */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Search brands or categories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="cm-input w-full pl-8 pr-7 py-1.5 min-h-[38px] sm:min-h-0 text-sm border rounded-lg"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear brand search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <select
          aria-label="Filter brands by category"
          value={filterCatId}
          onChange={(e) => setFilterCatId(e.target.value)}
          className="cm-input px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs sm:text-sm border rounded-lg sm:max-w-[200px]"
        >
          <option value="">All Categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter brands by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
          className="cm-input px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs sm:text-sm border rounded-lg sm:w-[115px]"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>

        <button
          type="button"
          onClick={() => setShowAddForm((prev) => !prev)}
          className="inline-flex items-center justify-center gap-1 px-3 py-1.5 min-h-[38px] sm:min-h-0 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          New Brand
        </button>
      </div>

      {/* Add New Brand Drawer */}
      {showAddForm && (
        <div className="p-3 cm-subtle border rounded-xl space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[var(--cm-text-primary)]">
              Add Brand to Library
            </span>
            <button
              type="button"
              onClick={() => {
                setShowAddForm(false);
                setNewBrandName('');
                setNewBrandCatIds([]);
              }}
              className="text-xs text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
            >
              Close
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              placeholder="Brand name (e.g., Tapal, Pampers, Colgate)"
              value={newBrandName}
              onChange={(e) => setNewBrandName(e.target.value)}
              className="cm-input flex-1 min-w-[180px] px-3 py-1.5 text-sm border rounded-lg"
            />
            <button
              type="button"
              disabled={savingNew || !newBrandName.trim() || Boolean(newExactMatch)}
              onClick={() => void handleAddBrand()}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed rounded-lg cursor-pointer shrink-0"
            >
              {savingNew ? 'Saving...' : 'Save Brand'}
            </button>
          </div>

          {newSimilarMatches.length > 0 && (
            <div className="p-2.5 bg-[var(--cm-warning-soft)] border border-[var(--cm-warning-border)] rounded-lg space-y-1.5">
              <div className="text-[11px] font-semibold text-[var(--cm-warning)]">
                {newExactMatch
                  ? `Duplicate prevented: "${newExactMatch.name}" already exists.`
                  : 'Similar existing brands detected (click to inspect/edit instead):'}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {newSimilarMatches.map((m) => (
                  <button
                    key={m.brand.id}
                    type="button"
                    onClick={() => {
                      setShowAddForm(false);
                      setNewBrandName('');
                      setNewBrandCatIds([]);
                      setSearch(m.brand.name);
                      openEditBrand(m.brand);
                    }}
                    className="px-2 py-1 text-xs font-medium cm-surface border border-[var(--cm-warning-border)] hover:border-[var(--cm-accent)] rounded-md text-[var(--cm-text-primary)] cursor-pointer"
                  >
                    <span className="font-semibold">{m.brand.name}</span>
                    <span className="ml-1 text-[10px] text-[var(--cm-text-muted)]">({m.reason})</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-[var(--cm-text-secondary)]">
              Assign Categories (multi-select — leave empty for all categories)
            </div>
            <div className="flex flex-wrap gap-1.5">
              {categories.map((cat) => {
                const selected = newBrandCatIds.includes(cat.id);
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() =>
                      setNewBrandCatIds((prev) =>
                        prev.includes(cat.id)
                          ? prev.filter((id) => id !== cat.id)
                          : prev.length < 25
                          ? [...prev, cat.id]
                          : prev
                      )
                    }
                    className={`px-2 py-1 text-[11px] font-medium rounded-md border cursor-pointer transition-colors ${
                      selected
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
        </div>
      )}

      {/* Results Count */}
      <div className="flex items-center justify-between text-[11px] text-[var(--cm-text-muted)]">
        <span>
          Showing {filteredBrands.length} of {brands.length} brands
        </span>
        {(search || filterCatId || statusFilter !== 'all') && (
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setFilterCatId('');
              setStatusFilter('all');
            }}
            className="text-[var(--cm-accent-text)] hover:underline cursor-pointer"
          >
            Reset filters
          </button>
        )}
      </div>

      {/* Brands List */}
      <div className="divide-y divide-[var(--cm-border)] max-h-96 overflow-y-auto border border-[var(--cm-border)] rounded-xl">
        {filteredBrands.length === 0 ? (
          <div className="p-4 text-center text-xs text-[var(--cm-text-muted)]">
            No brands match your search or category filter.
          </div>
        ) : (
          filteredBrands.map((b) => {
            const active = isBrandActive(b);
            const isEditing = editingBrandId === b.id;
            const linkedProducts = productCountByBrand.get(b.id) || 0;

            return (
              <div key={b.id} className="p-2.5 sm:px-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`text-xs sm:text-sm font-semibold truncate ${
                          active ? 'text-[var(--cm-text-primary)]' : 'text-[var(--cm-text-muted)] line-through'
                        }`}
                      >
                        {b.name}
                      </span>
                      {!active && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--cm-bg-subtle)] border border-[var(--cm-border)] text-[var(--cm-text-muted)]">
                          Inactive
                        </span>
                      )}
                      {linkedProducts > 0 && (
                        <span className="text-[10px] font-mono-num text-[var(--cm-text-muted)]">
                          · {linkedProducts} {linkedProducts === 1 ? 'product' : 'products'}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-[var(--cm-text-secondary)] truncate">
                      {formatBrandCategoryNames(b, categoryNameMap, 4)}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => (isEditing ? setEditingBrandId(null) : openEditBrand(b))}
                      title="Edit brand & categories"
                      className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-accent-text)] rounded-lg cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggleActive(b)}
                      title={active ? 'Deactivate brand' : 'Activate brand'}
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
                        setConfirmDeleteId((prev) => (prev === b.id ? null : b.id))
                      }
                      title="Delete brand"
                      className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-danger)] rounded-lg cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {confirmDeleteId === b.id && (
                  <div className="p-2 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-[var(--cm-danger)]">
                      {linkedProducts > 0
                        ? `Used by ${linkedProducts} product(s). Recommend Deactivating instead of deleting.`
                        : `Remove "${b.name}" from brand library?`}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {linkedProducts > 0 && active && (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            void handleToggleActive(b);
                          }}
                          className="px-2 py-1 text-[11px] font-semibold cm-surface border rounded cursor-pointer text-[var(--cm-text-primary)]"
                        >
                          Deactivate Instead
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleDeleteBrand(b)}
                        className="px-2 py-1 text-[11px] font-semibold bg-[var(--cm-danger)] text-white rounded cursor-pointer"
                      >
                        Delete
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

                {isEditing && (
                  <div className="p-2.5 cm-subtle border rounded-lg space-y-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Brand name"
                        className="cm-input flex-1 min-w-[160px] px-2.5 py-1.5 text-xs sm:text-sm border rounded-lg"
                      />
                      <label className="inline-flex items-center gap-1.5 text-xs text-[var(--cm-text-secondary)] cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={editIsActive}
                          onChange={(e) => setEditIsActive(e.target.checked)}
                          className="rounded border-[var(--cm-border-strong)]"
                        />
                        Active
                      </label>
                    </div>

                    {editExactMatch && (
                      <div className="text-[11px] text-[var(--cm-danger)] font-medium">
                        Duplicate name: &ldquo;{editExactMatch.name}&rdquo; already exists.
                      </div>
                    )}
                    {!editExactMatch && editSimilarMatches.length > 0 && (
                      <div className="text-[11px] text-[var(--cm-warning)]">
                        Similar existing brand(s):{' '}
                        {editSimilarMatches.map((m) => m.brand.name).join(', ')}
                      </div>
                    )}

                    <div className="space-y-1">
                      <div className="text-[11px] font-medium text-[var(--cm-text-secondary)]">
                        Assigned Categories ({editCatIds.length === 0 ? 'All' : editCatIds.length})
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {categories.map((cat) => {
                          const checked = editCatIds.includes(cat.id);
                          return (
                            <button
                              key={cat.id}
                              type="button"
                              onClick={() =>
                                setEditCatIds((prev) =>
                                  prev.includes(cat.id)
                                    ? prev.filter((id) => id !== cat.id)
                                    : prev.length < 25
                                    ? [...prev, cat.id]
                                    : prev
                                )
                              }
                              className={`px-2 py-0.5 text-[11px] font-medium rounded border cursor-pointer transition-colors ${
                                checked
                                  ? 'bg-[var(--cm-accent-soft)] text-[var(--cm-accent-text)] border-[var(--cm-accent-border)]'
                                  : 'cm-surface text-[var(--cm-text-secondary)] border-[var(--cm-border)]'
                              }`}
                            >
                              {cat.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingBrandId(null)}
                        className="px-2.5 py-1 text-xs cm-surface border rounded-lg text-[var(--cm-text-secondary)] cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={savingEdit || !editName.trim() || Boolean(editExactMatch)}
                        onClick={() => void handleSaveEdit()}
                        className="inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] disabled:opacity-50 rounded-lg cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        {savingEdit ? 'Saving...' : 'Save Changes'}
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
