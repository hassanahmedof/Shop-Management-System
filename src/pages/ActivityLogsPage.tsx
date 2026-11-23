import { Activity, RotateCcw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CompactExpandableRow } from '../components/CompactSection';
import { useShopData } from '../contexts/ShopDataContext';
import {
  type ActivityCategory,
  formatAuditTimestamp,
  getActivityActionMeta,
  getAuditLogKarachiDateIso,
} from '../utils/activityLogs';
import { formatDateDDMMYYYY, formatNumber } from '../utils/formatters';

const CATEGORY_TABS: Array<{ id: ActivityCategory; label: string }> = [
  { id: 'all', label: 'All Activity' },
  { id: 'sales', label: 'Sales & Edits' },
  { id: 'inventory', label: 'Inventory & Stock' },
  { id: 'staff', label: 'Staff & Logins' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'settings', label: 'Settings' },
];

const PAGE_BATCH = 50;

export function ActivityLogsPage() {
  const { auditLogs, loading } = useShopData();
  const [categoryFilter, setCategoryFilter] = useState<ActivityCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(PAGE_BATCH);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const enrichedLogs = useMemo(
    () =>
      auditLogs.map((log) => ({
        log,
        meta: getActivityActionMeta(log),
        dateIso: getAuditLogKarachiDateIso(log.createdAt),
      })),
    [auditLogs]
  );

  const counts = useMemo(() => {
    let salesEdits = 0;
    let inventory = 0;
    let staffLogins = 0;
    for (const item of enrichedLogs) {
      if (item.meta.category === 'sales') salesEdits += 1;
      else if (item.meta.category === 'inventory') inventory += 1;
      else if (item.meta.category === 'staff') staffLogins += 1;
    }
    return {
      total: enrichedLogs.length,
      salesEdits,
      inventory,
      staffLogins,
    };
  }, [enrichedLogs]);

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return enrichedLogs.filter(({ log, meta, dateIso }) => {
      if (categoryFilter !== 'all' && meta.category !== categoryFilter) {
        return false;
      }
      if (dateFilter && dateIso !== dateFilter) {
        return false;
      }
      if (q) {
        const hay = `${meta.actionLabel} ${meta.categoryLabel} ${log.action} ${log.summary} ${log.entityType} ${log.entityId}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [enrichedLogs, categoryFilter, dateFilter, searchQuery]);

  const visibleLogs = filteredLogs.slice(0, visibleLimit);
  const hasFilters = categoryFilter !== 'all' || Boolean(searchQuery.trim()) || Boolean(dateFilter);

  const handleResetFilters = () => {
    setCategoryFilter('all');
    setSearchQuery('');
    setDateFilter('');
    setVisibleLimit(PAGE_BATCH);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="cm-surface border rounded-xl p-3 h-16 animate-pulse" />
          ))}
        </div>
        <div className="cm-surface border rounded-xl p-4 h-60 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header Summary Strip */}
      <section aria-label="Activity log summary" className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <div className="cm-surface border rounded-xl p-3 flex flex-col justify-between gap-1">
          <span className="text-[11px] sm:text-xs font-medium text-[var(--cm-text-muted)]">Total Logged</span>
          <span className="text-lg sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-text-primary)]">
            {formatNumber(counts.total)}
          </span>
        </div>
        <div className="cm-surface border rounded-xl p-3 flex flex-col justify-between gap-1">
          <span className="text-[11px] sm:text-xs font-medium text-[var(--cm-text-muted)]">Sales &amp; Edits</span>
          <span className="text-lg sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-success)]">
            {formatNumber(counts.salesEdits)}
          </span>
        </div>
        <div className="cm-surface border rounded-xl p-3 flex flex-col justify-between gap-1">
          <span className="text-[11px] sm:text-xs font-medium text-[var(--cm-text-muted)]">Inventory &amp; Stock</span>
          <span className="text-lg sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-warning)]">
            {formatNumber(counts.inventory)}
          </span>
        </div>
        <div className="cm-surface border rounded-xl p-3 flex flex-col justify-between gap-1">
          <span className="text-[11px] sm:text-xs font-medium text-[var(--cm-text-muted)]">Staff &amp; Logins</span>
          <span className="text-lg sm:text-xl font-bold font-mono-num tabular-nums text-[var(--cm-accent-text)]">
            {formatNumber(counts.staffLogins)}
          </span>
        </div>
      </section>

      {/* Filter Toolbar & Chronological Ledger */}
      <section className="cm-surface border rounded-xl overflow-hidden">
        <div className="px-3.5 py-3 sm:px-4 border-b border-[var(--cm-border)] space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[var(--cm-accent)] shrink-0" />
              <div>
                <h2 className="text-sm sm:text-base font-semibold text-[var(--cm-text-primary)]">Activity Logs</h2>
                <p className="text-[11px] sm:text-xs text-[var(--cm-text-muted)]">
                  Chronological audit trail across sales edits, stock adjustments, and staff logins
                </p>
              </div>
            </div>
            <div className="text-xs text-[var(--cm-text-muted)] font-mono-num tabular-nums whitespace-nowrap">
              {formatNumber(visibleLogs.length)} / {formatNumber(filteredLogs.length)} events
            </div>
          </div>

          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2.5">
            <div className="flex items-center gap-1 p-1 bg-[var(--cm-bg-subtle)] rounded-lg overflow-x-auto max-w-full">
              {CATEGORY_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setCategoryFilter(tab.id);
                    setVisibleLimit(PAGE_BATCH);
                  }}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    categoryFilter === tab.id
                      ? 'bg-[var(--cm-bg-surface)] text-[var(--cm-text-primary)] shadow-xs'
                      : 'text-[var(--cm-text-secondary)] hover:text-[var(--cm-text-primary)]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-center gap-2">
              <div className="relative flex-1 sm:min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-[var(--cm-text-muted)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search actions, product, staff..."
                  aria-label="Search activity logs"
                  className="w-full pl-8 pr-3 py-1.5 min-h-[38px] sm:min-h-0 text-xs cm-input border rounded-lg focus:outline-none focus:border-[var(--cm-accent)]"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  aria-label="Filter by date"
                  className="flex-1 sm:flex-initial px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs cm-input border rounded-lg font-mono-num focus:outline-none focus:border-[var(--cm-accent)]"
                />

                {hasFilters && (
                  <button
                    type="button"
                    onClick={handleResetFilters}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[38px] sm:min-h-0 text-xs font-medium text-[var(--cm-text-secondary)] bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] rounded-lg cursor-pointer whitespace-nowrap"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {filteredLogs.length === 0 ? (
          <div className="p-6 text-center space-y-2">
            <p className="text-sm font-medium text-[var(--cm-text-secondary)]">
              {auditLogs.length === 0
                ? 'No user actions have been recorded yet.'
                : 'No activity logs match your current filters.'}
            </p>
            <p className="text-xs text-[var(--cm-text-muted)]">
              {auditLogs.length === 0
                ? 'Sales edits, inventory adjustments, purchases, expenses, and staff logins will appear here chronologically.'
                : dateFilter
                ? `No events logged on ${formatDateDDMMYYYY(dateFilter)} for the selected filter.`
                : 'Try adjusting your search query or switching to All Activity.'}
            </p>
            {hasFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="mt-2 px-3 py-1.5 text-xs font-semibold text-[var(--cm-accent-text)] border border-[var(--cm-accent-border)] hover:bg-[var(--cm-accent-soft)] rounded-lg cursor-pointer"
              >
                Clear Filters
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] text-xs font-semibold text-[var(--cm-text-secondary)]">
                    <th className="py-2 px-3 whitespace-nowrap">Timestamp (PKT)</th>
                    <th className="py-2 px-3 whitespace-nowrap">Module</th>
                    <th className="py-2 px-3 whitespace-nowrap">Action</th>
                    <th className="py-2 px-3">Details</th>
                    <th className="py-2 px-3 whitespace-nowrap text-right">Reference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cm-border)] text-xs sm:text-sm">
                  {visibleLogs.map(({ log, meta }) => (
                    <tr key={log.id} className="hover:bg-[var(--cm-bg-hover)]">
                      <td className="py-2 px-3 font-mono-num tabular-nums text-xs text-[var(--cm-text-muted)] whitespace-nowrap">
                        {formatAuditTimestamp(log.createdAt)}
                      </td>
                      <td className="py-2 px-3 text-xs font-medium text-[var(--cm-text-secondary)] whitespace-nowrap">
                        {meta.categoryLabel}
                      </td>
                      <td className={`py-2 px-3 text-xs font-semibold whitespace-nowrap ${meta.toneClass}`}>
                        {meta.actionLabel}
                      </td>
                      <td className="py-2 px-3 text-xs text-[var(--cm-text-primary)]">
                        {log.summary}
                      </td>
                      <td className="py-2 px-3 text-right font-mono-num tabular-nums text-xs text-[var(--cm-text-muted)] whitespace-nowrap">
                        {log.entityType} · {log.entityId.slice(0, 8)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="md:hidden divide-y divide-[var(--cm-border)]">
              {visibleLogs.map(({ log, meta }) => (
                <CompactExpandableRow
                  key={log.id}
                  title={log.summary}
                  subtitle={`${formatAuditTimestamp(log.createdAt)} · ${meta.categoryLabel}`}
                  rightPrimary={<span className={meta.toneClass}>{meta.actionLabel}</span>}
                  isExpanded={expandedLogId === log.id}
                  onToggle={() => setExpandedLogId((prev) => (prev === log.id ? null : log.id))}
                  expandedContent={
                    <div className="space-y-1.5 text-[var(--cm-text-secondary)]">
                      <div className="text-[var(--cm-text-primary)]">{log.summary}</div>
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-num text-[var(--cm-text-muted)]">
                        <span>{formatAuditTimestamp(log.createdAt)}</span>
                        <span>{log.entityType} · {log.entityId.slice(0, 8)}</span>
                      </div>
                    </div>
                  }
                />
              ))}
            </div>

            {filteredLogs.length > visibleLogs.length && (
              <div className="px-3.5 py-2.5 border-t border-[var(--cm-border)] bg-[var(--cm-bg-subtle)] flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--cm-text-muted)] font-mono-num tabular-nums">
                  {formatNumber(filteredLogs.length - visibleLogs.length)} older events
                </span>
                <button
                  type="button"
                  onClick={() => setVisibleLimit((prev) => prev + PAGE_BATCH)}
                  className="px-3 py-1.5 text-xs font-semibold text-[var(--cm-accent-text)] bg-[var(--cm-bg-surface)] border border-[var(--cm-border)] hover:bg-[var(--cm-bg-hover)] rounded-lg cursor-pointer"
                >
                  Load More
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
