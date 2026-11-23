import { Plus, Receipt, ShoppingBag, Truck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { NavSection } from '../types/shop';

interface QuickActionFabProps {
  activeSection: NavSection;
  onNavigate: (section: NavSection) => void;
}

const QUICK_ACTIONS: Array<{
  id: NavSection;
  label: string;
  subtitle: string;
  icon: typeof ShoppingBag;
}> = [
  {
    id: 'sales',
    label: 'Add Sale',
    subtitle: 'Open sales entry form',
    icon: ShoppingBag,
  },
  {
    id: 'purchases',
    label: 'Add Purchase',
    subtitle: 'Record supplier stock purchase',
    icon: Truck,
  },
  {
    id: 'expenses',
    label: 'Record Expense',
    subtitle: 'Log operating expense',
    icon: Receipt,
  },
];

export function QuickActionFab({ activeSection, onNavigate }: QuickActionFabProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleSelectAction = (target: NavSection) => {
    setOpen(false);
    onNavigate(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (activeSection === 'sales' || activeSection === 'purchases') {
    return null;
  }

  return (
    <div ref={rootRef} className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-30 flex flex-col items-end gap-2">
      {open && (
        <div
          role="menu"
          aria-label="Quick Actions"
          className="w-60 bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] rounded-xl shadow-xl p-1.5 space-y-1"
        >
          <div className="px-2.5 py-1.5 border-b border-[var(--cm-border)] text-[11px] font-semibold text-[var(--cm-text-muted)]">
            Quick Actions
          </div>
          {QUICK_ACTIONS.map((action) => {
            const Icon = action.icon;
            const isCurrent = activeSection === action.id;
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                onClick={() => handleSelectAction(action.id)}
                className={`w-full text-left px-3 py-2.5 min-h-[44px] rounded-lg flex items-center gap-3 transition-colors cursor-pointer ${
                  isCurrent
                    ? 'bg-[var(--cm-accent-soft)] text-[var(--cm-accent-text)]'
                    : 'text-[var(--cm-text-primary)] hover:bg-[var(--cm-bg-hover)]'
                }`}
              >
                <span
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                    isCurrent
                      ? 'bg-[var(--cm-accent)] text-white'
                      : 'bg-[var(--cm-bg-subtle)] text-[var(--cm-accent-text)]'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold leading-tight">{action.label}</span>
                  <span className="block text-[11px] text-[var(--cm-text-muted)] truncate">{action.subtitle}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={open ? 'Close quick actions menu' : 'Open quick actions menu'}
        className="h-11 px-3.5 sm:h-12 sm:px-4 rounded-2xl bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] active:scale-[0.98] text-white shadow-lg flex items-center gap-2 text-sm font-semibold transition-all whitespace-nowrap cursor-pointer"
      >
        {open ? <X className="w-4 h-4 shrink-0" /> : <Plus className="w-4 h-4 shrink-0" />}
        <span className="hidden sm:inline">Quick Action</span>
      </button>
    </div>
  );
}
