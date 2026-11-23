import { ArrowLeft, ChevronDown, Mic, MicOff, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getHighlightSegments,
  type SearchableProductItem,
  searchProductsCatalog,
} from '../services/productSearchService';
import { formatNumber, formatPKR } from '../utils/formatters';
import { formatStockBreakdown, getDefaultSaleUnit } from '../utils/packaging';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0?: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error?: string;
}

interface SpeechRecognitionInstanceLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionConstructorLike = new () => SpeechRecognitionInstanceLike;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructorLike | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructorLike;
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

interface SearchableProductSelectorProps {
  items: SearchableProductItem[];
  selectedProductId?: string;
  onSelect: (item: SearchableProductItem) => void;
  onRefreshCatalog?: () => Promise<void>;
  allowOutOfStock?: boolean;
  placeholder?: string;
  mode?: 'inline' | 'quick-add';
  inputId?: string;
  autoFocusInput?: boolean;
  enableVoiceSearch?: boolean;
}

const RESULTS_PAGE_SIZE = 20;

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

export function SearchableProductSelector({
  items,
  selectedProductId = '',
  onSelect,
  onRefreshCatalog,
  allowOutOfStock = false,
  placeholder = 'Search products by name, brand or category...',
  mode = 'inline',
  inputId,
  autoFocusInput = false,
  enableVoiceSearch = false,
}: SearchableProductSelectorProps) {
  const isMobile = useIsMobileViewport();
  const containerRef = useRef<HTMLDivElement>(null);
  const desktopInputRef = useRef<HTMLInputElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionInstanceLike | null>(null);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedProductId) || null,
    [items, selectedProductId]
  );

  const [isOpen, setIsOpen] = useState(false);
  const [queryText, setQueryText] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(RESULTS_PAGE_SIZE);
  const [activeIndex, setActiveIndex] = useState(0);
  const [stockNotice, setStockNotice] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const refreshTriggeredRef = useRef(false);

  const stopVoiceSearch = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Ignore cleanup errors
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  useEffect(() => {
    return () => {
      stopVoiceSearch();
    };
  }, [stopVoiceSearch]);

  // Sync display when inline selected item changes externally
  useEffect(() => {
    if (mode === 'inline' && !isOpen) {
      setQueryText(selectedItem ? selectedItem.name : '');
    }
  }, [mode, isOpen, selectedItem]);

  // Stop voice recognition when picker closes
  useEffect(() => {
    if (!isOpen) {
      stopVoiceSearch();
    }
  }, [isOpen, stopVoiceSearch]);

  // Fast search debounce (50ms) with instant clear for snappy POS typing
  useEffect(() => {
    if (!queryText) {
      setDebouncedQuery('');
      setVisibleCount(RESULTS_PAGE_SIZE);
      setActiveIndex(0);
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(queryText);
      setVisibleCount(RESULTS_PAGE_SIZE);
      setActiveIndex(0);
    }, 50);
    return () => window.clearTimeout(timer);
  }, [queryText]);

  const activeCatalogCount = useMemo(
    () => items.reduce((count, i) => (i.isActive ? count + 1 : count), 0),
    [items]
  );

  // Trigger optional direct database refresh once if catalog happens to be empty on open
  useEffect(() => {
    if (isOpen && items.length === 0 && onRefreshCatalog && !refreshTriggeredRef.current) {
      refreshTriggeredRef.current = true;
      void onRefreshCatalog().catch(() => undefined);
    }
  }, [isOpen, items.length, onRefreshCatalog]);

  // Close desktop dropdown on outside click
  useEffect(() => {
    if (!isOpen || isMobile) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setStockNotice(null);
        setVoiceNotice(null);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen, isMobile]);

  // Auto-focus mobile picker input when full-screen sheet opens
  useEffect(() => {
    if (isOpen && isMobile) {
      const id = window.setTimeout(() => {
        mobileInputRef.current?.focus();
      }, 40);
      return () => window.clearTimeout(id);
    }
  }, [isOpen, isMobile]);

  useEffect(() => {
    if (autoFocusInput && !isMobile) {
      desktopInputRef.current?.focus();
    }
  }, [autoFocusInput, isMobile]);

  const trimmedQuery = debouncedQuery.trim();
  const hasSearchQuery = trimmedQuery.length > 0;

  const matchedResults = useMemo(() => {
    if (!hasSearchQuery) return [];
    return searchProductsCatalog(items, debouncedQuery);
  }, [items, debouncedQuery, hasSearchQuery]);

  const paginatedResults = useMemo(
    () => matchedResults.slice(0, visibleCount),
    [matchedResults, visibleCount]
  );

  const handleOpenPicker = () => {
    setIsOpen(true);
    setStockNotice(null);
    setVoiceNotice(null);
    if (mode === 'inline' && selectedItem && queryText === selectedItem.name) {
      setQueryText('');
      setDebouncedQuery('');
    }
  };

  const handleClearSearch = () => {
    setQueryText('');
    setDebouncedQuery('');
    setVisibleCount(RESULTS_PAGE_SIZE);
    setActiveIndex(0);
    setStockNotice(null);
    setVoiceNotice(null);
    if (isMobile) {
      mobileInputRef.current?.focus();
    } else {
      setIsOpen(true);
      desktopInputRef.current?.focus();
    }
  };

  const handlePickItem = (item: SearchableProductItem) => {
    if (!allowOutOfStock && item.currentStock <= 0) {
      setStockNotice(`"${item.name}" is currently out of stock.`);
      return;
    }

    stopVoiceSearch();
    setStockNotice(null);
    setVoiceNotice(null);
    onSelect(item);
    setIsOpen(false);

    if (mode === 'quick-add') {
      setQueryText('');
      setDebouncedQuery('');
      setVisibleCount(RESULTS_PAGE_SIZE);
      setActiveIndex(0);
      if (!isMobile) {
        window.setTimeout(() => desktopInputRef.current?.focus(), 20);
      }
    } else {
      setQueryText(item.name);
      setDebouncedQuery('');
    }
  };

  const handleToggleVoice = () => {
    if (!enableVoiceSearch) return;

    if (isListening) {
      stopVoiceSearch();
      return;
    }

    const SpeechCtor = getSpeechRecognitionConstructor();
    if (!SpeechCtor) {
      if (!isOpen) setIsOpen(true);
      setVoiceNotice('Voice search is not supported in this browser. Please type to search.');
      return;
    }

    setVoiceNotice(null);
    setStockNotice(null);
    if (!isOpen) {
      setIsOpen(true);
      setQueryText('');
      setDebouncedQuery('');
    }

    try {
      const recognition = new SpeechCtor();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.continuous = false;

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let transcript = '';
        let isFinal = false;
        for (let i = 0; i < event.results.length; i += 1) {
          const result = event.results[i];
          const alt = result?.[0];
          if (alt?.transcript) {
            transcript += alt.transcript;
          }
          if (result?.isFinal) {
            isFinal = true;
          }
        }
        const cleaned = transcript.trim();
        if (cleaned) {
          setQueryText(cleaned);
          setDebouncedQuery(cleaned);
          setVisibleCount(RESULTS_PAGE_SIZE);
          setActiveIndex(0);
        }
        if (isFinal) {
          setIsListening(false);
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
        setIsListening(false);
        const code = event?.error || '';
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          setVoiceNotice('Microphone permission was denied. Allow mic access or type to search.');
        } else if (code === 'no-speech') {
          setVoiceNotice('No speech detected. Tap the microphone and try again.');
        } else if (code !== 'aborted') {
          setVoiceNotice('Voice search unavailable right now. Please type to search.');
        }
      };

      recognition.onend = () => {
        setIsListening(false);
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      setIsListening(true);
      recognition.start();
    } catch {
      setIsListening(false);
      setVoiceNotice('Unable to start voice search. Please type to search.');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setIsOpen(true);
      return;
    }

    if (e.key === 'Escape') {
      stopVoiceSearch();
      setIsOpen(false);
      setStockNotice(null);
      setVoiceNotice(null);
      return;
    }

    if (!hasSearchQuery || paginatedResults.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, paginatedResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = paginatedResults[activeIndex]?.item;
      if (target) {
        handlePickItem(target);
      }
    }
  };

  const handleResultsScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
      if (visibleCount < matchedResults.length) {
        setVisibleCount((prev) => Math.min(prev + RESULTS_PAGE_SIZE, matchedResults.length));
      }
    }
  };

  const renderResultsBody = () => {
    if (!hasSearchQuery) {
      return (
        <div className="p-4 text-xs text-[var(--cm-text-muted)] space-y-1">
          <p className="font-medium text-[var(--cm-text-secondary)]">
            {enableVoiceSearch
              ? 'Type or tap the microphone to search products'
              : 'Type a product name, brand, or category to search'}
          </p>
          <p>
            Searching across {formatNumber(activeCatalogCount)} active catalog items. Results update instantly.
          </p>
        </div>
      );
    }

    if (matchedResults.length === 0) {
      return (
        <div className="p-5 text-center space-y-2">
          <p className="text-sm font-medium text-[var(--cm-text-secondary)]">No products found</p>
          <p className="text-xs text-[var(--cm-text-muted)]">
            No active products match &ldquo;{trimmedQuery}&rdquo;. Try a shorter word, brand, or category.
          </p>
          <button
            type="button"
            onClick={handleClearSearch}
            className="px-3 py-1.5 text-xs font-semibold text-[var(--cm-accent-text)] border border-[var(--cm-accent-border)] hover:bg-[var(--cm-accent-soft)] rounded-lg cursor-pointer"
          >
            Clear Search
          </button>
        </div>
      );
    }

    return (
      <>
        <div className="px-3.5 py-2 bg-[var(--cm-bg-subtle)] border-b border-[var(--cm-border)] flex items-center justify-between text-[11px] text-[var(--cm-text-muted)] font-mono-num tabular-nums">
          <span>
            Showing {formatNumber(paginatedResults.length)} of {formatNumber(matchedResults.length)} matches
          </span>
          {!allowOutOfStock && <span>Out-of-stock items locked</span>}
        </div>

        <ul role="listbox" className="divide-y divide-[var(--cm-border)]">
          {paginatedResults.map(({ item }, idx) => {
            const isOutOfStock = item.currentStock <= 0;
            const isLowStock = item.currentStock > 0 && item.currentStock <= 10;
            const isDisabled = isOutOfStock && !allowOutOfStock;
            const isHighlightedRow = idx === activeIndex;
            const isSelected = item.id === selectedProductId;
            const breakdown = formatStockBreakdown(item.currentStock, item);
            const defSale = getDefaultSaleUnit(item);

            return (
              <li key={item.id} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => handlePickItem(item)}
                  className={`w-full text-left px-3.5 py-2.5 min-h-[52px] transition-colors flex flex-col gap-0.5 cursor-pointer ${
                    isDisabled
                      ? 'bg-[var(--cm-bg-subtle)] opacity-60 hover:bg-[var(--cm-bg-hover)]'
                      : isHighlightedRow
                      ? 'bg-[var(--cm-accent-soft)]'
                      : isSelected
                      ? 'bg-[var(--cm-accent-soft)]'
                      : 'hover:bg-[var(--cm-bg-hover)]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-[var(--cm-text-primary)] leading-snug">
                      <HighlightedText text={item.name} query={trimmedQuery} />
                      {item.bottleSize && (
                        <span className="ml-1.5 text-[11px] font-mono-num text-[var(--cm-text-muted)]">
                          ({item.bottleSize})
                        </span>
                      )}
                    </span>
                    <span
                      className={`text-xs font-semibold whitespace-nowrap shrink-0 ${
                        isOutOfStock
                          ? 'text-[var(--cm-danger)]'
                          : isLowStock
                          ? 'text-[var(--cm-warning)]'
                          : 'text-[var(--cm-success)]'
                      }`}
                    >
                      {isOutOfStock ? 'Out of Stock' : isLowStock ? 'Low Stock' : 'In Stock'}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--cm-text-secondary)] font-mono-num tabular-nums">
                    <span className="font-sans">
                      <span className="font-medium text-[var(--cm-text-primary)]">
                        {item.brandName ? (
                          <HighlightedText text={item.brandName} query={trimmedQuery} />
                        ) : (
                          'Generic'
                        )}
                      </span>
                    </span>
                    {item.categoryName && (
                      <>
                        <span aria-hidden="true" className="text-[var(--cm-border-strong)]">
                          ·
                        </span>
                        <span className="font-sans text-[var(--cm-text-muted)]">
                          <HighlightedText text={item.categoryName} query={trimmedQuery} />
                        </span>
                      </>
                    )}
                    {item.storageLocation && (
                      <>
                        <span aria-hidden="true" className="text-[var(--cm-border-strong)]">
                          ·
                        </span>
                        <span className="font-sans text-[var(--cm-info)]">
                          {item.storageLocation}
                        </span>
                      </>
                    )}
                    <span aria-hidden="true" className="text-[var(--cm-border-strong)]">
                      |
                    </span>
                    <span className={isOutOfStock ? 'text-[var(--cm-danger)] font-semibold' : 'text-[var(--cm-text-secondary)]'}>
                      Stock: {breakdown.summaryText}
                    </span>
                    <span aria-hidden="true" className="text-[var(--cm-border-strong)]">
                      |
                    </span>
                    <span className="font-semibold text-[var(--cm-text-primary)]">
                      {formatPKR(defSale.salePrice)}/{defSale.unitName}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        {visibleCount < matchedResults.length && (
          <div className="p-2.5 border-t border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-center">
            <button
              type="button"
              onClick={() =>
                setVisibleCount((prev) => Math.min(prev + RESULTS_PAGE_SIZE, matchedResults.length))
              }
              className="px-3.5 py-1.5 text-xs font-semibold text-[var(--cm-accent-text)] bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] rounded-lg cursor-pointer"
            >
              Load {Math.min(RESULTS_PAGE_SIZE, matchedResults.length - visibleCount)} More Results
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Input / Mobile Picker Trigger */}
      {isMobile ? (
        <div className="flex items-center gap-1.5">
          <button
            id={inputId}
            type="button"
            onClick={handleOpenPicker}
            className="flex-1 min-w-0 min-h-[44px] px-3 py-2 text-left text-sm cm-input border hover:border-[var(--cm-border-strong)] focus:border-[var(--cm-accent)] rounded-lg flex items-center justify-between gap-2 transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-2 min-w-0 flex-1">
              <Search className="w-4 h-4 text-[var(--cm-text-muted)] shrink-0" />
              <span
                className={`truncate ${
                  selectedItem && mode === 'inline'
                    ? 'text-[var(--cm-text-primary)] font-medium'
                    : 'text-[var(--cm-text-muted)]'
                }`}
              >
                {selectedItem && mode === 'inline' ? selectedItem.name : placeholder}
              </span>
            </span>
            <ChevronDown className="w-4 h-4 text-[var(--cm-text-muted)] shrink-0" />
          </button>

          {enableVoiceSearch && (
            <button
              type="button"
              onClick={handleToggleVoice}
              aria-label={isListening ? 'Stop voice search' : 'Search product by voice'}
              title={isListening ? 'Stop voice search' : 'Voice search'}
              className={`min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg border transition-colors cursor-pointer shrink-0 ${
                isListening
                  ? 'bg-[var(--cm-danger-soft)] border-[var(--cm-danger-border)] text-[var(--cm-danger)]'
                  : 'bg-[var(--cm-bg-surface)] border-[var(--cm-border)] text-[var(--cm-text-secondary)] hover:text-[var(--cm-accent-text)] hover:border-[var(--cm-accent-border)]'
              }`}
            >
              {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <Search className="w-4 h-4 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={desktopInputRef}
            id={inputId}
            type="text"
            value={isOpen ? queryText : mode === 'inline' && selectedItem ? selectedItem.name : queryText}
            onFocus={handleOpenPicker}
            onChange={(e) => {
              setQueryText(e.target.value);
              if (!isOpen) setIsOpen(true);
              setStockNotice(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            autoComplete="off"
            role="combobox"
            aria-expanded={isOpen}
            aria-autocomplete="list"
            className={`w-full min-h-[42px] pl-9 py-2 text-sm border cm-input rounded-lg focus:outline-none focus:border-[var(--cm-accent)] ${
              enableVoiceSearch ? 'pr-16' : 'pr-9'
            }`}
          />

          <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
            {(queryText || (mode === 'inline' && selectedItem)) && (
              <button
                type="button"
                onClick={() => {
                  if (mode === 'inline' && !isOpen && selectedItem) {
                    setIsOpen(true);
                    setQueryText('');
                    setDebouncedQuery('');
                    window.setTimeout(() => desktopInputRef.current?.focus(), 10);
                  } else {
                    handleClearSearch();
                  }
                }}
                aria-label="Clear search"
                className="p-1.5 text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] rounded-md cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            {enableVoiceSearch && (
              <button
                type="button"
                onClick={handleToggleVoice}
                aria-label={isListening ? 'Stop voice search' : 'Search product by voice'}
                title={isListening ? 'Stop voice search' : 'Voice search'}
                className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                  isListening
                    ? 'text-[var(--cm-danger)] bg-[var(--cm-danger-soft)]'
                    : 'text-[var(--cm-text-muted)] hover:text-[var(--cm-accent-text)] hover:bg-[var(--cm-accent-soft)]'
                }`}
              >
                {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Desktop Inline Popover Panel */}
      {isOpen && !isMobile && (
        <div className="absolute left-0 right-0 mt-1.5 z-40 bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] rounded-xl shadow-lg overflow-hidden">
          {enableVoiceSearch && isListening && (
            <div className="px-3.5 py-2 bg-[var(--cm-accent-soft)] border-b border-[var(--cm-accent-border)] flex items-center justify-between gap-2 text-xs text-[var(--cm-accent-text)]">
              <span className="font-medium">Listening... Speak product name</span>
              <button
                type="button"
                onClick={stopVoiceSearch}
                className="font-semibold underline cursor-pointer"
              >
                Stop
              </button>
            </div>
          )}
          {enableVoiceSearch && voiceNotice && (
            <div className="px-3.5 py-2 bg-[var(--cm-warning-soft)] border-b border-[var(--cm-warning-border)] text-xs font-medium text-[var(--cm-warning)]">
              {voiceNotice}
            </div>
          )}
          {stockNotice && (
            <div className="px-3.5 py-2 bg-[var(--cm-danger-soft)] border-b border-[var(--cm-danger-border)] text-xs font-medium text-[var(--cm-danger)]">
              {stockNotice}
            </div>
          )}
          <div onScroll={handleResultsScroll} className="max-h-80 overflow-y-auto">
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
          aria-label="Search products"
        >
          <div className="p-3 border-b border-[var(--cm-border)] bg-[var(--cm-bg-surface)] flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                stopVoiceSearch();
                setIsOpen(false);
                setStockNotice(null);
                setVoiceNotice(null);
              }}
              aria-label="Close product search"
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
                  setStockNotice(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                autoComplete="off"
                className={`w-full min-h-[44px] pl-9 py-2 text-sm border cm-input rounded-lg focus:outline-none focus:border-[var(--cm-accent)] ${
                  enableVoiceSearch ? 'pr-20' : 'pr-10'
                }`}
              />
              <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                {queryText && (
                  <button
                    type="button"
                    onClick={handleClearSearch}
                    aria-label="Clear search"
                    className="min-w-[36px] min-h-[36px] flex items-center justify-center text-[var(--cm-text-muted)] hover:text-[var(--cm-text-primary)] rounded-md cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
                {enableVoiceSearch && (
                  <button
                    type="button"
                    onClick={handleToggleVoice}
                    aria-label={isListening ? 'Stop voice search' : 'Search product by voice'}
                    className={`min-w-[36px] min-h-[36px] flex items-center justify-center rounded-md cursor-pointer ${
                      isListening ? 'text-[var(--cm-danger)] bg-[var(--cm-danger-soft)]' : 'text-[var(--cm-text-muted)] hover:text-[var(--cm-accent-text)]'
                    }`}
                  >
                    {isListening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  </button>
                )}
              </div>
            </div>
          </div>

          {enableVoiceSearch && isListening && (
            <div className="px-4 py-2.5 bg-[var(--cm-accent-soft)] border-b border-[var(--cm-accent-border)] flex items-center justify-between text-xs text-[var(--cm-accent-text)] shrink-0">
              <span className="font-medium">Listening... Speak product name</span>
              <button
                type="button"
                onClick={stopVoiceSearch}
                className="font-semibold underline cursor-pointer"
              >
                Stop
              </button>
            </div>
          )}

          {enableVoiceSearch && voiceNotice && (
            <div className="px-4 py-2.5 bg-[var(--cm-warning-soft)] border-b border-[var(--cm-warning-border)] text-xs font-medium text-[var(--cm-warning)] shrink-0">
              {voiceNotice}
            </div>
          )}

          {stockNotice && (
            <div className="px-4 py-2.5 bg-[var(--cm-danger-soft)] border-b border-[var(--cm-danger-border)] text-xs font-medium text-[var(--cm-danger)] shrink-0">
              {stockNotice}
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
