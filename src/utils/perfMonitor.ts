export type PerfCategory =
  | 'sales_save'
  | 'firebase_tx'
  | 'catalog_search'
  | 'discord_async'
  | 'sheets_sync'
  | 'startup';

export interface PerfMetricEntry {
  id: number;
  category: PerfCategory;
  name: string;
  durationMs: number;
  timestampIso: string;
  meta?: Record<string, string | number | boolean>;
}

const MAX_PERF_ENTRIES = 120;
const entries: PerfMetricEntry[] = [];
let nextId = 1;

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function startPerfTimer(): () => number {
  const start = nowMs();
  return () => Math.max(0, Math.round((nowMs() - start) * 100) / 100);
}

export function recordPerfMetric(
  category: PerfCategory,
  name: string,
  durationMs: number,
  meta?: Record<string, string | number | boolean>
): PerfMetricEntry {
  const entry: PerfMetricEntry = {
    id: nextId++,
    category,
    name,
    durationMs: Math.max(0, Math.round(durationMs * 100) / 100),
    timestampIso: new Date().toISOString(),
    meta,
  };

  entries.push(entry);
  if (entries.length > MAX_PERF_ENTRIES) {
    entries.splice(0, entries.length - MAX_PERF_ENTRIES);
  }

  if (typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    const metaSuffix = meta ? ` ${JSON.stringify(meta)}` : '';
    console.debug(`[Perf:${category}] ${name}: ${entry.durationMs.toFixed(1)}ms${metaSuffix}`);
  }

  return entry;
}

export function getPerfMetrics(category?: PerfCategory): PerfMetricEntry[] {
  if (!category) return [...entries];
  return entries.filter((e) => e.category === category);
}

export function clearPerfMetrics(): void {
  entries.length = 0;
}

export function getPerfSummary(): Record<
  string,
  { count: number; avgMs: number; maxMs: number; lastMs: number }
> {
  const grouped = new Map<string, { sum: number; count: number; max: number; last: number }>();
  for (const e of entries) {
    const key = `${e.category}:${e.name}`;
    const cur = grouped.get(key);
    if (!cur) {
      grouped.set(key, { sum: e.durationMs, count: 1, max: e.durationMs, last: e.durationMs });
    } else {
      cur.sum += e.durationMs;
      cur.count += 1;
      if (e.durationMs > cur.max) cur.max = e.durationMs;
      cur.last = e.durationMs;
    }
  }
  const summary: Record<string, { count: number; avgMs: number; maxMs: number; lastMs: number }> = {};
  for (const [k, v] of grouped.entries()) {
    summary[k] = {
      count: v.count,
      avgMs: Math.round((v.sum / v.count) * 100) / 100,
      maxMs: v.max,
      lastMs: v.last,
    };
  }
  return summary;
}

if (typeof window !== 'undefined') {
  (window as unknown as { __cmPerf?: unknown }).__cmPerf = {
    getMetrics: getPerfMetrics,
    getSummary: getPerfSummary,
    clear: clearPerfMetrics,
  };
}
