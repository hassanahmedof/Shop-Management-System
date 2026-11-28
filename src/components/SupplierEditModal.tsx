import { AlertCircle, Save, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import { updateSupplier } from '../services/shopService';
import type { Supplier } from '../types/shop';
import { formatPKR } from '../utils/formatters';

interface SupplierEditModalProps {
  shopId: string;
  supplier: Supplier;
  existingSuppliers: Supplier[];
  onClose: () => void;
  onSaved?: (updated: {
    id: string;
    name: string;
    phone: string;
    address: string;
    email: string;
    notes: string;
  }) => void;
}

export function SupplierEditModal({
  shopId,
  supplier,
  existingSuppliers,
  onClose,
  onSaved,
}: SupplierEditModalProps) {
  const { showToast } = useToast();
  const [name, setName] = useState(supplier.name || '');
  const [phone, setPhone] = useState(supplier.phone || '');
  const [email, setEmail] = useState(supplier.email || '');
  const [address, setAddress] = useState(supplier.address || '');
  const [notes, setNotes] = useState(supplier.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(supplier.name || '');
    setPhone(supplier.phone || '');
    setEmail(supplier.email || '');
    setAddress(supplier.address || '');
    setNotes(supplier.notes || '');
    setError(null);
  }, [supplier]);

  const normalizedName = name.trim().replace(/\s+/g, ' ').toLowerCase();
  const duplicateSupplier = normalizedName
    ? existingSuppliers.find(
        (s) =>
          s.id !== supplier.id &&
          (s.name || '').trim().replace(/\s+/g, ' ').toLowerCase() === normalizedName
      )
    : undefined;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shopId) return;
    setError(null);

    const trimmedName = name.trim().replace(/\s+/g, ' ');
    if (!trimmedName) {
      setError('Supplier name is required.');
      return;
    }
    if (duplicateSupplier) {
      setError(`Another supplier named "${duplicateSupplier.name}" already exists.`);
      return;
    }
    const trimmedEmail = email.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('Enter a valid email address or leave it blank.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: trimmedName,
        phone: phone.trim(),
        address: address.trim(),
        email: trimmedEmail,
        notes: notes.trim(),
      };
      await updateSupplier(shopId, supplier.id, payload);
      showToast({
        title: 'Supplier Updated',
        message: `"${trimmedName}" saved successfully.`,
        tone: 'success',
        durationMs: 3000,
      });
      onSaved?.({ id: supplier.id, ...payload });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update supplier.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-[var(--cm-bg-overlay)] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="supplier-edit-modal-title"
    >
      <div className="cm-surface border rounded-xl w-full max-w-lg p-5 sm:p-6 space-y-4 shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[var(--cm-border)] pb-3">
          <div>
            <h3
              id="supplier-edit-modal-title"
              className="text-base font-semibold text-[var(--cm-text-primary)]"
            >
              Edit Supplier
            </h3>
            <p className="text-[11px] text-[var(--cm-text-muted)] mt-0.5">
              Supplier ID and purchase ledger totals are preserved automatically.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close supplier edit dialog"
            className="p-1 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Read-only preserved ledger summary */}
        <div className="grid grid-cols-3 gap-2 p-2.5 cm-subtle border rounded-lg text-xs">
          <div>
            <div className="text-[10px] text-[var(--cm-text-muted)]">Total Purchased</div>
            <div className="font-mono-num font-semibold text-[var(--cm-text-primary)]">
              {formatPKR(supplier.totalPurchased || 0)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[var(--cm-text-muted)]">Total Paid</div>
            <div className="font-mono-num font-semibold text-[var(--cm-success)]">
              {formatPKR(supplier.totalPaid || 0)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[var(--cm-text-muted)]">Outstanding</div>
            <div
              className={`font-mono-num font-semibold ${
                (supplier.outstandingBalance || 0) > 0
                  ? 'text-[var(--cm-warning)]'
                  : 'text-[var(--cm-text-muted)]'
              }`}
            >
              {formatPKR(supplier.outstandingBalance || 0)}
            </div>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="p-3 bg-[var(--cm-danger-soft)] border border-[var(--cm-danger-border)] rounded-lg text-xs sm:text-sm text-[var(--cm-danger)] flex items-start gap-2"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label
              htmlFor="edit-supplier-name"
              className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1"
            >
              Supplier Name *
            </label>
            <input
              id="edit-supplier-name"
              type="text"
              required
              maxLength={150}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Metro Distributors"
              className="cm-input w-full px-3 py-2 text-sm border rounded-lg"
            />
            {duplicateSupplier && (
              <p className="text-[11px] text-[var(--cm-danger)] mt-1">
                Another supplier named &ldquo;{duplicateSupplier.name}&rdquo; already exists.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="edit-supplier-phone"
                className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1"
              >
                Phone
              </label>
              <input
                id="edit-supplier-phone"
                type="text"
                maxLength={40}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0300-1234567"
                className="cm-input w-full px-3 py-2 text-sm border rounded-lg font-mono-num"
              />
            </div>

            <div>
              <label
                htmlFor="edit-supplier-email"
                className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1"
              >
                Email
              </label>
              <input
                id="edit-supplier-email"
                type="email"
                maxLength={200}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="orders@supplier.pk"
                className="cm-input w-full px-3 py-2 text-sm border rounded-lg"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="edit-supplier-address"
              className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1"
            >
              Address
            </label>
            <input
              id="edit-supplier-address"
              type="text"
              maxLength={300}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Street, Market, City"
              className="cm-input w-full px-3 py-2 text-sm border rounded-lg"
            />
          </div>

          <div>
            <label
              htmlFor="edit-supplier-notes"
              className="block text-xs font-medium text-[var(--cm-text-secondary)] mb-1"
            >
              Notes
            </label>
            <textarea
              id="edit-supplier-notes"
              rows={2}
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Payment terms, contact person, delivery schedule..."
              className="cm-input w-full px-3 py-2 text-sm border rounded-lg resize-none"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--cm-border)]">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-xs sm:text-sm font-medium text-[var(--cm-text-secondary)] cm-surface border hover:bg-[var(--cm-bg-hover)] rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || Boolean(duplicateSupplier)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] disabled:opacity-50 rounded-lg cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
