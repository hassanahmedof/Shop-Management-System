import { ArrowLeft, Check, ChevronDown, Clock, Loader2, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  filterAndRankSelectOptions,
  getHighlightSegments,
  inferSelectScope,
  partitionFrequentSelectOptions,
  recordSelectActivity,
  type SearchableSelectOption,
} from '../services/recordSearchService';
import { formatNumber } from '../utils/formatters';

export type { SearchableSelectOption };

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string, option?: SearchableSelectOption) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyOptionLabel?: string;
  noResultsMessage?: string;
  loading?: boolean;
  onRefreshOptions?: () => Promise<void>;
  pageSize?: number;
  debounceMs?: number;
  disabled?: boolean;
  required?: boolean;
  inputId?: string;
  ariaLabel?: string;
  className?: string;
  size?: 'sm' | 'md';
  suggestionScope?: string;
  suggestedValues?: string[];
  maxFrequentItems?: number;
  showFrequentSection?: boolean;
  onCreateFromQuery?: (query: string) => void;
  createFromQueryLabel?: string;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => getHighlightSegments(text, query), [text, query]);
  return (
    <>
      {segments.map((seg, idx) =>
        seg.match ? (
          <mark
            key={idx}
            className="bg-[var(--cm-warning-soft)] text-[var(--cm-text-primary)] rounded-xs px-0.5 font-semibold"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={idx}>{seg.text}</span>
        )
      )}
    </>
  );
}

function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 639px)').matches : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 639px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select an option...',
  searchPlaceholder = 'Type to search...',
  emptyOptionLabel,
  noResultsMessage = 'No matching records found',
  loading = false,
  onRefreshOptions,
  pageSize = 20,
  debounceMs = 50,
  disabled = false,
  required = false,
  inputId,
  ariaLabel,
  className = '',
  size = 'md',
  suggestionScope,
  suggestedValues,
  maxFrequentItems = 5,
  showFrequentSection = true,
  onCreateFromQuery,
  createFromQueryLabel = 'Add to library',
}: SearchableSelectProps) {
  const isMobile = useIsMobileViewport();
  const containerRef = useRef<HTMLDivElement>(null);
  const desktopInputRef = useRef<HTMLInputElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLLIElement | null>(null);
  const refreshTriggeredRef = useRef(false);

  const resolvedScope = useMemo(
    () => suggestionScope || inferSelectScope(ariaLabel, placeholder),
    [suggestionScope, ariaLabel, placeholder]
  );

  const selectedOption = useMemo(
    () => options.find((o) => o.value === value) || null,
    [options, value]
  );

  const [isOpen, setIsOpen] = useState(false);
  const [queryText, setQueryText] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [activeIndex, setActiveIndex] = useState(0);
  const [internalLoading, setInternalLoading] = useState(false);
  const [blockedNotice, setBlockedNotice] = useState<string | null>(null);
  const [activityRevision, setActivityRevision] = useState(0);

  const isFiltering = queryText !== debouncedQuery;
  const isBusy = loading || internalLoading;

  // Keep input text aligned with selected option when closed
  useEffect(() => {
    if (!isOpen) {
      setQueryText(selectedOption ? selectedOption.label : emptyOptionLabel && value === '' ? emptyOptionLabel : '');
      setDebouncedQuery('');
    }
  }, [isOpen, selectedOption, emptyOptionLabel, value]);

  // Fast search debounce for smooth responsiveness on 500–5,000+ records
  useEffect(() => {
    if (!queryText) {
      setDebouncedQuery('');
      setVisibleCount(pageSize);
      setActiveIndex(0);
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(queryText);
      setVisibleCount(pageSize);
      setActiveIndex(0);
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [queryText, pageSize, debounceMs]);

  // Optional direct database fetch when options list is empty on open
  useEffect(() => {
    if (isOpen && options.length === 0 && onRefreshOptions && !refreshTriggeredRef.current) {
      refreshTriggeredRef.current = true;
      setInternalLoading(true);
      void onRefreshOptions()
        .catch(() => undefined)
        .finally(() => setInternalLoading(false));
    }
  }, [isOpen, options.length, onRefreshOptions]);

  // Close desktop dropdown when clicking outside
  useEffect(() => {
    if (!isOpen || isMobile) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setBlockedNotice(null);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen, isMobile]);

  // Auto-focus mobile picker search input when full-screen sheet opens
  useEffect(() => {
    if (isOpen && isMobile) {
      const id = window.setTimeout(() => {
        mobileInputRef.current?.focus();
      }, 40);
      return () => window.clearTimeout(id);
    }
  }, [isOpen, isMobile]);

  const trimmedQuery = debouncedQuery.trim();
  const hasQuery = trimmedQuery.length > 0;

  const emptyResetOption = useMemo<SearchableSelectOption | null>(() => {
    if (!emptyOptionLabel) return null;
    return {
      value: '',
      label: emptyOptionLabel,
      subtitle: 'Show all / clear selection',
    };
  }, [emptyOptionLabel]);

  const { frequentOptions, remainingOptions } = useMemo(() => {
    if (!showFrequentSection) {
      return { frequentOptions: [] as SearchableSelectOption[], remainingOptions: options };
    }
    return partitionFrequentSelectOptions(
      options,
      resolvedScope,
      suggestedValues,
      maxFrequentItems
    );
    // activityRevision intentionally retriggers ranking right after a user selection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, resolvedScope, suggestedValues, maxFrequentItems, showFrequentSection, activityRevision]);

  const showFrequentGroup = !hasQuery && frequentOptions.length > 0;

  const combinedOptions = useMemo(() => {
    if (hasQuery) {
      return emptyResetOption ? [emptyResetOption, ...options] : options;
    }
    const ordered = showFrequentGroup ? [...frequentOptions, ...remainingOptions] : options;
    return emptyResetOption ? [emptyResetOption, ...ordered] : ordered;
  }, [hasQuery, emptyResetOption, options, showFrequentGroup, frequentOptions, remainingOptions]);

  const matchedOptions = useMemo(
    () =>
      hasQuery
        ? filterAndRankSelectOptions(combinedOptions, debouncedQuery)
        : combinedOptions,
    [combinedOptions, debouncedQuery, hasQuery]
  );

  const paginatedOptions = useMemo(
    () => matchedOptions.slice(0, visibleCount),
    [matchedOptions, visibleCount]
  );

  const frequentStartIdx = emptyResetOption ? 1 : 0;
  const remainingStartIdx = frequentStartIdx + frequentOptions.length;

  useEffect(() => {
    if (isOpen && activeOptionRef.current) {
      activeOptionRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, isOpen]);

  const handleOpen = () => {
    if (disabled) return;
    setIsOpen(true);
    setBlockedNotice(null);
    setQueryText('');
    setDebouncedQuery('');
    setVisibleCount(pageSize);
    setActiveIndex(0);
  };

  const handleClear = () => {
    setQueryText('');
    setDebouncedQuery('');
    setVisibleCount(pageSize);
    setActiveIndex(0);
    setBlockedNotice(null);
    if (isMobile) {
      mobileInputRef.current?.focus();
    } else {
      setIsOpen(true);
      desktopInputRef.current?.focus();
    }
  };

  const handleSelectOption = (opt: SearchableSelectOption) => {
    if (opt.disabled) {
      setBlockedNotice(opt.disabledReason || `"${opt.label}" cannot be selected.`);
      return;
    }
    setBlockedNotice(null);
    if (opt.value) {
      recordSelectActivity(resolvedScope, opt.value);
      setActivityRevision((prev) => prev + 1);
    }
    onChange(opt.value, opt);
    setIsOpen(false);
    setQueryText(opt.value === '' && emptyOptionLabel ? emptyOptionLabel : opt.label);
    setDebouncedQuery('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      e.preventDefault();
      handleOpen();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      setBlockedNotice(null);
      desktopInputRef.current?.blur();
      return;
    }

    if (paginatedOptions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, paginatedOptions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = paginatedOptions[activeIndex];
      if (target) {
        handleSelectOption(target);
      }
    }
  };

  const handleResultsScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
      if (visibleCount < matchedOptions.length) {
        setVisibleCount((prev) => Math.min(prev + pageSize, matchedOptions.length));
      }
    }
  };

  const badgeToneClass = (tone?: SearchableSelectOption['badgeTone']) => {
    switch (tone) {
      case 'success':
        return 'text-[var(--cm-success)]';
      case 'warning':
        return 'text-[var(--cm-warning)]';
      case 'danger':
        return 'text-[var(--cm-danger)]';
      default:
        return 'text-[var(--cm-text-muted)]';
    }
  };

  const renderResultsBody = () => {
    if (isBusy && options.length === 0) {
      return (
        <div className="p-5 flex items-center justify-center gap-2 text-xs text-[var(--cm-text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin text-[var(--cm-accent)]" />
          <span>Loading records from database...</span>
        </div>
      );
    }

    const hasExactLabelMatch =
      hasQuery &&
      options.some((o) => o.label.trim().toLowerCase() === trimmedQuery.toLowerCase());

    if (matchedOptions.length === 0) {
      return (
        <div className="p-4 text-center space-y-2.5">
          <p className="text-sm font-medium text-[var(--cm-text-secondary)]">{noResultsMessage}</p>
          {hasQuery && (
            <p className="text-xs text-[var(--cm-text-muted)]">
              No records match &ldquo;{trimmedQuery}&rdquo;.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {hasQuery && onCreateFromQuery && (
              <button
                type="button"
                onClick={() => {
                  const raw = trimmedQuery;
                  setIsOpen(false);
                  onCreateFromQuery(raw);
                }}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer"
              >
                + {createFromQueryLabel}: &ldquo;{trimmedQuery}&rdquo;
              </button>
            )}
            {hasQuery && (
              <button
                type="button"
                onClick={handleClear}
                className="px-3 py-1.5 text-xs font-semibold text-[var(--cm-accent-text)] border border-[var(--cm-accent-border)] hover:bg-[var(--cm-accent-soft)] rounded-lg cursor-pointer"
              >
                Clear Search
              </button>
            )}
          </div>
        </div>
      );
    }

    return (
      <>
        <div className="px-3 py-1.5 bg-[var(--cm-bg-subtle)] border-b border-[var(--cm-border)] flex items-center justify-between text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums">
          <span>
            Showing {formatNumber(paginatedOptions.length)} of {formatNumber(matchedOptions.length)}
            {hasQuery ? ' matches' : ' records'}
          </span>
          {(isBusy || isFiltering) && (
            <span className="inline-flex items-center gap-1 text-[var(--cm-accent-text)] font-sans">
              <Loader2 className="w-3 h-3 animate-spin" />
              Searching...
            </span>
          )}
        </div>

        <ul role="listbox" className="divide-y divide-[var(--cm-border)]">
          {paginatedOptions.map((opt, idx) => {
            const isHighlighted = idx === activeIndex;
            const isSelected = opt.value === value;
            const showFrequentHeader = showFrequentGroup && idx === frequentStartIdx;
            const showAllHeader =
              showFrequentGroup && remainingOptions.length > 0 && idx === remainingStartIdx;

            return (
              <li
                key={`${opt.value || '__empty__'}-${idx}`}
                ref={isHighlighted ? activeOptionRef : null}
                role="option"
                aria-selected={isSelected}
              >
                {showFrequentHeader && (
                  <div className="px-3 py-1.5 bg-[var(--cm-accent-soft)] border-b border-[var(--cm-border)] flex items-center justify-between gap-2 text-[11px] font-semibold text-[var(--cm-accent-text)]">
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="w-3 h-3 shrink-0" />
                      <span>Frequent Items</span>
                    </span>
                    <span className="font-normal text-[var(--cm-text-muted)]">Recent activity</span>
                  </div>
                )}
                {showAllHeader && (
                  <div className="px-3 py-1.5 bg-[var(--cm-bg-subtle)] border-b border-[var(--cm-border)] text-[11px] font-semibold text-[var(--cm-text-muted)]">
                    All Records
                  </div>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => handleSelectOption(opt)}
                  className={`w-full text-left px-3 py-2 min-h-[44px] transition-colors flex flex-col gap-0.5 cursor-pointer ${
                    opt.disabled
                      ? 'bg-[var(--cm-bg-subtle)] opacity-60 hover:bg-[var(--cm-bg-hover)]'
                      : isHighlighted
                      ? 'bg-[var(--cm-accent-soft)]'
                      : isSelected
                      ? 'bg-[var(--cm-accent-soft)]'
                      : 'hover:bg-[var(--cm-bg-hover)]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-[var(--cm-text-primary)] leading-snug flex items-center gap-1.5 min-w-0">
                      <span className="truncate">
                        {hasQuery ? (
                          <HighlightedText text={opt.label} query={trimmedQuery} />
                        ) : (
                          opt.label
                        )}
                      </span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-[var(--cm-accent-text)] shrink-0" />}
                    </span>
                    {opt.badge && (
                      <span
                        className={`text-xs font-semibold whitespace-nowrap shrink-0 ${badgeToneClass(
                          opt.badgeTone
                        )}`}
                      >
                        {opt.badge}
                      </span>
                    )}
                  </div>

                  {(opt.subtitle || opt.meta) && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--cm-text-secondary)] font-mono-num tabular-nums">
                      {opt.subtitle && (
                        <span className="font-sans text-[var(--cm-text-secondary)]">
                          {hasQuery ? (
                            <HighlightedText text={opt.subtitle} query={trimmedQuery} />
                          ) : (
                            opt.subtitle
                          )}
                        </span>
                      )}
                      {opt.subtitle && opt.meta && (
                        <span aria-hidden="true" className="text-[var(--cm-border-strong)]">
                          |
                        </span>
                      )}
                      {opt.meta && (
                        <span>
                          {hasQuery ? (
                            <HighlightedText text={opt.meta} query={trimmedQuery} />
                          ) : (
                            opt.meta
                          )}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {visibleCount < matchedOptions.length && (
          <div className="p-2 border-t border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-center">
            <button
              type="button"
              onClick={() =>
                setVisibleCount((prev) => Math.min(prev + pageSize, matchedOptions.length))
              }
              className="px-3.5 py-1.5 text-xs font-semibold text-[var(--cm-accent-text)] bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] rounded-lg cursor-pointer"
            >
              Load {Math.min(pageSize, matchedOptions.length - visibleCount)} More Results
            </button>
          </div>
        )}

        {hasQuery && onCreateFromQuery && !hasExactLabelMatch && (
          <div className="p-2 border-t border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--cm-text-muted)] truncate">
              Not listed?
            </span>
            <button
              type="button"
              onClick={() => {
                const raw = trimmedQuery;
                setIsOpen(false);
                onCreateFromQuery(raw);
              }}
              className="px-2.5 py-1 text-xs font-semibold text-white bg-[var(--cm-accent)] hover:bg-[var(--cm-accent-hover)] rounded-lg cursor-pointer shrink-0"
            >
              + {createFromQueryLabel}: &ldquo;{trimmedQuery}&rdquo;
            </button>
          </div>
        )}
      </>
    );
  };

  const sizeClass =
    size === 'sm' ? 'min-h-[36px] text-xs py-1.5' : 'min-h-[40px] text-sm py-2';
  const mobileTriggerHeight = size === 'sm' ? 'min-h-[40px] text-xs py-1.5' : 'min-h-[44px] text-sm py-2';

  const displayClosedLabel =
    selectedOption?.label || (value === '' && emptyOptionLabel ? emptyOptionLabel : placeholder);
  const hasRealSelection = Boolean(selectedOption && value !== '');

  return (
    <div ref={containerRef} className={`relative w-full ${className}`}>
      {required && (
        <input
          tabIndex={-1}
          aria-hidden="true"
          required
          value={value}
          onChange={() => undefined}
          className="sr-only"
        />
      )}

      {/* Trigger / Search Input */}
      {isMobile ? (
        <button
          id={inputId}
          type="button"
          disabled={disabled}
          aria-label={ariaLabel || placeholder}
          onClick={handleOpen}
          className={`w-full ${mobileTriggerHeight} px-3 text-left cm-input border hover:border-[var(--cm-border-strong)] focus:border-[var(--cm-accent)] rounded-lg flex items-center justify-between gap-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed min-w-0`}
        >
          <span className="flex items-center gap-2 min-w-0 flex-1">
            <Search className="w-3.5 h-3.5 text-[var(--cm-text-muted)] shrink-0" />
            <span
              className={`truncate ${
                hasRealSelection || (value === '' && emptyOptionLabel)
                  ? 'text-[var(--cm-text-primary)] font-medium'
                  : 'text-[var(--cm-text-muted)]'
              }`}
            >
              {displayClosedLabel}
            </span>
          </span>
          <ChevronDown className="w-4 h-4 text-[var(--cm-text-muted)] shrink-0" />
        </button>
      ) : (
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={desktopInputRef}
            id={inputId}
            type="text"
            disabled={disabled}
            aria-label={ariaLabel || placeholder}
            value={isOpen ? queryText : displayClosedLabel === placeholder ? '' : displayClosedLabel}
            onFocus={handleOpen}
            onChange={(e) => {
              setQueryText(e.target.value);
              if (!isOpen) setIsOpen(true);
              setBlockedNotice(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder={isOpen ? searchPlaceholder : placeholder}
            autoComplete="off"
            role="combobox"
            aria-expanded={isOpen}
            aria-autocomplete="list"
            className={`w-full ${sizeClass} pl-8 pr-8 border cm-input rounded-lg focus:outline-none focus:border-[var(--cm-accent)] disabled:opacity-60 disabled:cursor-not-allowed`}
          />

          {(isOpen ? queryText : hasRealSelection) && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (!isOpen && hasRealSelection && emptyOptionLabel !== undefined) {
                  onChange('');
                } else if (!isOpen) {
                  handleOpen();
                  window.setTimeout(() => desktopInputRef.current?.focus(), 10);
                } else {
                  handleClear();
                }
              }}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Desktop Popover Results */}
      {isOpen && !isMobile && (
        <div className="absolute left-0 right-0 min-w-[260px] mt-1.5 z-40 bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] rounded-xl shadow-lg overflow-hidden">
          {blockedNotice && (
            <div className="px-3.5 py-2 bg-[var(--cm-danger-soft)] border-b border-[var(--cm-danger-border)] text-xs font-medium text-[var(--cm-danger)]">
              {blockedNotice}
            </div>
          )}
          <div onScroll={handleResultsScroll} className="max-h-72 overflow-y-auto">
            {renderResultsBody()}
          </div>
        </div>
      )}

      {/* Mobile Full-Screen Searchable Picker */}
      {isOpen && isMobile && (
        <div
          className="fixed inset-0 z-50 bg-[var(--cm-bg-surface)] flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel || placeholder}
        >
          <div className="p-3 border-b border-[var(--cm-border)] bg-[var(--cm-bg-surface)] flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setBlockedNotice(null);
              }}
              aria-label="Close selector"
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)] rounded-lg cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>

            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={mobileInputRef}
                type="text"
                value={queryText}
                onChange={(e) => {
                  setQueryText(e.target.value);
                  setBlockedNotice(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
                autoComplete="off"
                className="w-full min-h-[44px] pl-9 pr-10 py-2 text-sm border cm-input rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
              />
              {queryText && (
                <button
                  type="button"
                  onClick={handleClear}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] rounded-md cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {blockedNotice && (
            <div className="px-4 py-2.5 bg-[var(--cm-danger-soft)] border-b border-[var(--cm-danger-border)] text-xs font-medium text-[var(--cm-danger)] shrink-0">
              {blockedNotice}
            </div>
          )}

          <div onScroll={handleResultsScroll} className="flex-1 overflow-y-auto bg-[var(--cm-bg-surface)]">
            {renderResultsBody()}
          </div>
        </div>
      )}
    </div>
  );
}
