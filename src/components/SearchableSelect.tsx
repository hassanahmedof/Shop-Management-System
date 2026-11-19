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
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => getHighlightSegments(text, query), [text, query]);
  return (
    <>
      {segments.map((seg, idx) =>
        seg.match ? (
          <mark
            key={idx}
            className="bg-amber-100 text-slate-900 rounded-xs px-0.5 font-semibold"
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
  debounceMs = 150,
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

  // Debounce search text slightly for fast filtering on 500–5,000+ records
  useEffect(() => {
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
        return 'text-emerald-700';
      case 'warning':
        return 'text-amber-700';
      case 'danger':
        return 'text-red-600';
      default:
        return 'text-slate-500';
    }
  };

  const renderResultsBody = () => {
    if (isBusy && options.length === 0) {
      return (
        <div className="p-5 flex items-center justify-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin text-teal-600" />
          <span>Loading records from database...</span>
        </div>
      );
    }

    if (matchedOptions.length === 0) {
      return (
        <div className="p-4 text-center space-y-2">
          <p className="text-sm font-medium text-slate-700">{noResultsMessage}</p>
          {hasQuery && (
            <p className="text-xs text-slate-500">
              No records match &ldquo;{trimmedQuery}&rdquo;. Try a shorter keyword.
            </p>
          )}
          {hasQuery && (
            <button
              type="button"
              onClick={handleClear}
              className="px-3 py-1.5 text-xs font-semibold text-teal-700 border border-teal-200 hover:bg-teal-50 rounded-lg cursor-pointer"
            >
              Clear Search
            </button>
          )}
        </div>
      );
    }

    return (
      <>
        <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-mono-num tabular-nums">
          <span>
            Showing {formatNumber(paginatedOptions.length)} of {formatNumber(matchedOptions.length)}
            {hasQuery ? ' matches' : ' records'}
          </span>
          {(isBusy || isFiltering) && (
            <span className="inline-flex items-center gap-1 text-teal-700 font-sans">
              <Loader2 className="w-3 h-3 animate-spin" />
              Searching...
            </span>
          )}
        </div>

        <ul role="listbox" className="divide-y divide-slate-100">
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
                  <div className="px-3 py-1.5 bg-teal-50/50 border-b border-slate-100 flex items-center justify-between gap-2 text-[11px] font-semibold text-teal-800">
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="w-3 h-3 text-teal-600 shrink-0" />
                      <span>Frequent Items</span>
                    </span>
                    <span className="font-normal text-slate-500">Recent activity</span>
                  </div>
                )}
                {showAllHeader && (
                  <div className="px-3 py-1.5 bg-slate-50 border-b border-slate-100 text-[11px] font-semibold text-slate-500">
                    All Records
                  </div>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => handleSelectOption(opt)}
                  className={`w-full text-left px-3 py-2 min-h-[44px] transition-colors flex flex-col gap-0.5 cursor-pointer ${
                    opt.disabled
                      ? 'bg-slate-50/80 opacity-65 hover:bg-slate-100'
                      : isHighlighted
                      ? 'bg-teal-50/80'
                      : isSelected
                      ? 'bg-teal-50/40'
                      : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-900 leading-snug flex items-center gap-1.5 min-w-0">
                      <span className="truncate">
                        {hasQuery ? (
                          <HighlightedText text={opt.label} query={trimmedQuery} />
                        ) : (
                          opt.label
                        )}
                      </span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-teal-600 shrink-0" />}
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
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-600 font-mono-num tabular-nums">
                      {opt.subtitle && (
                        <span className="font-sans text-slate-600">
                          {hasQuery ? (
                            <HighlightedText text={opt.subtitle} query={trimmedQuery} />
                          ) : (
                            opt.subtitle
                          )}
                        </span>
                      )}
                      {opt.subtitle && opt.meta && (
                        <span aria-hidden="true" className="text-slate-300">
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
          <div className="p-2 border-t border-slate-100 bg-slate-50 text-center">
            <button
              type="button"
              onClick={() =>
                setVisibleCount((prev) => Math.min(prev + pageSize, matchedOptions.length))
              }
              className="px-3.5 py-1.5 text-xs font-semibold text-teal-700 hover:text-teal-800 bg-white border border-slate-200 rounded-lg cursor-pointer"
            >
              Load {Math.min(pageSize, matchedOptions.length - visibleCount)} More Results
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
          className={`w-full ${mobileTriggerHeight} px-3 text-left bg-white border border-slate-200 hover:border-slate-300 focus:border-teal-600 rounded-lg flex items-center justify-between gap-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed min-w-0`}
        >
          <span className="flex items-center gap-2 min-w-0 flex-1">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span
              className={`truncate ${
                hasRealSelection || (value === '' && emptyOptionLabel)
                  ? 'text-slate-900 font-medium'
                  : 'text-slate-400'
              }`}
            >
              {displayClosedLabel}
            </span>
          </span>
          <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
        </button>
      ) : (
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
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
            className={`w-full ${sizeClass} pl-8 pr-8 border border-slate-200 rounded-lg bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-600 disabled:bg-slate-100 disabled:cursor-not-allowed`}
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
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {/* Desktop Popover Results */}
      {isOpen && !isMobile && (
        <div className="absolute left-0 right-0 min-w-[260px] mt-1.5 z-40 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
          {blockedNotice && (
            <div className="px-3.5 py-2 bg-red-50 border-b border-red-200 text-xs font-medium text-red-700">
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
          className="fixed inset-0 z-50 bg-white flex flex-col"
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel || placeholder}
        >
          <div className="p-3 border-b border-slate-200 bg-white flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setBlockedNotice(null);
              }}
              aria-label="Close selector"
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-600 hover:text-slate-900 rounded-lg cursor-pointer"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>

            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
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
                className="w-full min-h-[44px] pl-9 pr-10 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50 text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-teal-600"
              />
              {queryText && (
                <button
                  type="button"
                  onClick={handleClear}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] flex items-center justify-center text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {blockedNotice && (
            <div className="px-4 py-2.5 bg-red-50 border-b border-red-200 text-xs font-medium text-red-700 shrink-0">
              {blockedNotice}
            </div>
          )}

          <div onScroll={handleResultsScroll} className="flex-1 overflow-y-auto bg-white">
            {renderResultsBody()}
          </div>
        </div>
      )}
    </div>
  );
}
