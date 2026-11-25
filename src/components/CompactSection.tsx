import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

interface CompactSectionProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
  bodyClassName?: string;
  className?: string;
}

export function CompactSection({
  title,
  subtitle,
  icon,
  summary,
  actions,
  collapsible = false,
  defaultOpen = true,
  open: controlledOpen,
  onToggle,
  children,
  bodyClassName = '',
  className = '',
}: CompactSectionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const handleToggle = () => {
    if (!collapsible) return;
    if (onToggle) {
      onToggle();
    } else {
      setInternalOpen((v) => !v);
    }
  };

  return (
    <section className={`cm-surface border rounded-2xl overflow-x-clip ${className}`}>
      <div
        className={`px-3.5 py-2.5 sm:px-4 sm:py-3 flex flex-wrap items-center justify-between gap-2 ${
          isOpen ? 'border-b border-[var(--cm-border)]' : ''
        }`}
      >
        {collapsible ? (
          <button
            type="button"
            onClick={handleToggle}
            aria-expanded={isOpen}
            className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer group"
          >
            <span className="text-[var(--cm-text-muted)] group-hover:text-[var(--cm-accent-text)] shrink-0">
              {isOpen ? (
                <ChevronDown className="w-4 h-4 text-[var(--cm-accent-text)]" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </span>
            {icon && <span className="shrink-0">{icon}</span>}
            <div className="min-w-0 flex-1">
              <div className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)] truncate">
                {title}
              </div>
              {subtitle && (
                <div className="text-[11px] sm:text-xs text-[var(--cm-text-muted)] truncate">{subtitle}</div>
              )}
            </div>
          </button>
        ) : (
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {icon && <span className="shrink-0">{icon}</span>}
            <div className="min-w-0 flex-1">
              <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)] truncate">
                {title}
              </h2>
              {subtitle && (
                <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)] truncate">{subtitle}</p>
              )}
            </div>
          </div>
        )}

        {(summary || actions) && (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {summary && (
              <div className="text-xs text-[var(--cm-text-muted)] font-mono-num tabular-nums">{summary}</div>
            )}
            {actions}
          </div>
        )}
      </div>

      {isOpen && <div className={bodyClassName}>{children}</div>}
    </section>
  );
}

interface CompactExpandableRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  rightPrimary: ReactNode;
  rightSecondary?: ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  expandedContent: ReactNode;
  dimmed?: boolean;
  rowToneClass?: string;
}

export function CompactExpandableRow({
  title,
  subtitle,
  rightPrimary,
  rightSecondary,
  isExpanded,
  onToggle,
  expandedContent,
  dimmed = false,
  rowToneClass = '',
}: CompactExpandableRowProps) {
  return (
    <div className={`touch-pan-y ${dimmed ? 'opacity-65' : ''} ${rowToneClass}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full px-3 py-2.5 min-h-[48px] flex items-center justify-between gap-2.5 text-left hover:bg-[var(--cm-bg-hover)] transition-colors cursor-pointer touch-pan-y"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-[var(--cm-text-muted)] shrink-0">
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-[var(--cm-accent-text)]" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs sm:text-sm font-medium text-[var(--cm-text-primary)] truncate">{title}</div>
            {subtitle && (
              <div className="text-[11px] text-[var(--cm-text-muted)] truncate font-mono-num tabular-nums">
                {subtitle}
              </div>
            )}
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="text-xs sm:text-sm font-semibold font-mono-num tabular-nums text-[var(--cm-text-primary)] whitespace-nowrap">
            {rightPrimary}
          </div>
          {rightSecondary && (
            <div className="text-[11px] font-mono-num tabular-nums text-[var(--cm-text-muted)] whitespace-nowrap">
              {rightSecondary}
            </div>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="px-3.5 py-2.5 bg-[var(--cm-bg-subtle)] border-t border-[var(--cm-border)] space-y-2 text-xs touch-pan-y overflow-x-clip">
          {expandedContent}
        </div>
      )}
    </div>
  );
}
