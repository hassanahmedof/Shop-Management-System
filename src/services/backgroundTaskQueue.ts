import type { SheetTabName } from '../../shared/googleSheetsSchema';

const STORAGE_KEY = 'cm_bg_sheets_queue_v1';
const MAX_RETRY_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = [4000, 12_000, 35_000, 90_000];
const MAX_COMPLETED_HISTORY = 60;

export type BackgroundTaskStatus = 'pending' | 'completed' | 'failed';
export type BackgroundEntityType =
  | 'sale'
  | 'staff_sale'
  | 'purchase'
  | 'expense'
  | 'stock_adjustment'
  | 'product';

export interface BackgroundSheetsTask {
  id: string; // `${shopId}:${entityType}:${dedupeId}`
  dedupeId: string;
  shopId: string;
  entityType: BackgroundEntityType;
  entityId: string;
  action: string;
  summary: string;
  targetSheets: SheetTabName[];
  status: BackgroundTaskStatus;
  retryCount: number;
  nextAttemptAt: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  lastError?: string;
}

export interface EnqueueSheetsTaskInput {
  dedupeId: string;
  shopId: string;
  entityType: BackgroundEntityType;
  entityId: string;
  action: string;
  summary: string;
  targetSheets: SheetTabName[];
  allowRequeueIfCompleted?: boolean;
}

let memoryTasks: BackgroundSheetsTask[] | null = null;
const queueListeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of queueListeners) {
    try {
      listener();
    } catch {
      // Ignore subscriber errors
    }
  }
}

export function subscribeSheetsQueue(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

function safeReadStorage(): BackgroundSheetsTask[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is BackgroundSheetsTask =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as BackgroundSheetsTask).id === 'string' &&
        typeof (item as BackgroundSheetsTask).shopId === 'string' &&
        Array.isArray((item as BackgroundSheetsTask).targetSheets)
    );
  } catch {
    return [];
  }
}

function safeWriteStorage(tasks: BackgroundSheetsTask[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    // Ignore storage quota or restricted browser context errors
  }
}

function readTasks(): BackgroundSheetsTask[] {
  if (memoryTasks !== null) return memoryTasks;
  memoryTasks = safeReadStorage();
  return memoryTasks;
}

function writeTasks(next: BackgroundSheetsTask[]): void {
  const activeOrFailed = next.filter((t) => t.status === 'pending' || t.status === 'failed');
  const completed = next
    .filter((t) => t.status === 'completed')
    .sort((a, b) => (a.completedAtMs ?? a.updatedAtMs) - (b.completedAtMs ?? b.updatedAtMs))
    .slice(-MAX_COMPLETED_HISTORY);
  const compact = [...completed, ...activeOrFailed].sort((a, b) => a.createdAtMs - b.createdAtMs);
  memoryTasks = compact;
  safeWriteStorage(compact);
  notifyListeners();
}

export function enqueueSheetsBackgroundTask(input: EnqueueSheetsTaskInput): BackgroundSheetsTask | null {
  const shopId = (input.shopId || '').trim();
  const dedupeId = (input.dedupeId || '').trim();
  if (!shopId || !dedupeId || !input.targetSheets.length) {
    return null;
  }

  const taskId = `${shopId}:${input.entityType}:${dedupeId}`;
  const now = Date.now();
  const tasks = readTasks();
  const existing = tasks.find((t) => t.id === taskId);

  if (existing) {
    if (existing.status === 'completed' && !input.allowRequeueIfCompleted) {
      return existing;
    }

    const mergedSheets = Array.from(new Set<SheetTabName>([...existing.targetSheets, ...input.targetSheets]));
    const updated: BackgroundSheetsTask = {
      ...existing,
      summary: input.summary || existing.summary,
      targetSheets: mergedSheets,
      status: 'pending',
      retryCount: existing.status === 'failed' ? 0 : existing.retryCount,
      nextAttemptAt: now,
      updatedAtMs: now,
      lastError: existing.status === 'pending' ? existing.lastError : undefined,
    };

    writeTasks(tasks.map((t) => (t.id === taskId ? updated : t)));
    return updated;
  }

  const created: BackgroundSheetsTask = {
    id: taskId,
    dedupeId,
    shopId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    summary: input.summary,
    targetSheets: Array.from(new Set<SheetTabName>(input.targetSheets)),
    status: 'pending',
    retryCount: 0,
    nextAttemptAt: now,
    createdAtMs: now,
    updatedAtMs: now,
  };

  writeTasks([...tasks, created]);
  return created;
}

export function getSheetsQueueTasks(shopId?: string): BackgroundSheetsTask[] {
  return readTasks().filter((t) => (!shopId ? true : t.shopId === shopId));
}

export function getPendingSheetsTasks(shopId: string): BackgroundSheetsTask[] {
  return readTasks().filter((t) => t.shopId === shopId && t.status === 'pending');
}

export function getDueSheetsTasks(shopId: string, now = Date.now()): BackgroundSheetsTask[] {
  return readTasks().filter(
    (t) => t.shopId === shopId && t.status === 'pending' && t.nextAttemptAt <= now
  );
}

export function getNextSheetsRetryAt(shopId: string): number | null {
  return readTasks()
    .filter((t) => t.shopId === shopId && t.status === 'pending')
    .reduce<number | null>(
      (min, t) => (min === null || t.nextAttemptAt < min ? t.nextAttemptAt : min),
      null
    );
}

export function getSheetsQueueStats(shopId?: string): {
  pending: number;
  completed: number;
  failed: number;
} {
  const list = getSheetsQueueTasks(shopId);
  return {
    pending: list.filter((t) => t.status === 'pending').length,
    completed: list.filter((t) => t.status === 'completed').length,
    failed: list.filter((t) => t.status === 'failed').length,
  };
}

export function markSheetsTasksCompleted(
  shopId: string,
  taskIds: string[],
  maxCreatedAtMs?: number
): void {
  const idSet = new Set(taskIds);
  if (idSet.size === 0 && maxCreatedAtMs === undefined) return;
  const now = Date.now();
  let changed = false;

  const next = readTasks().map((t) => {
    if (t.shopId !== shopId) return t;
    const matchesById = idSet.has(t.id);
    const matchesByAge =
      maxCreatedAtMs !== undefined &&
      t.status !== 'completed' &&
      t.createdAtMs <= maxCreatedAtMs;
    if (!matchesById && !matchesByAge) return t;
    changed = true;
    return {
      ...t,
      status: 'completed' as const,
      completedAtMs: now,
      updatedAtMs: now,
      lastError: undefined,
    };
  });

  if (changed) {
    writeTasks(next);
  }
}

export function markSheetsTasksRetryOrFailed(
  shopId: string,
  taskIds: string[],
  errorMessage: string,
  options?: {
    deferWithoutPenalty?: boolean;
    forcePermanentFail?: boolean;
  }
): number | null {
  const idSet = new Set(taskIds);
  if (idSet.size === 0) return getNextSheetsRetryAt(shopId);

  const now = Date.now();
  let changed = false;

  const next = readTasks().map((t) => {
    if (t.shopId !== shopId || !idSet.has(t.id)) return t;
    changed = true;

    if (options?.deferWithoutPenalty) {
      return {
        ...t,
        status: 'pending' as const,
        nextAttemptAt: now + 5000,
        updatedAtMs: now,
        lastError: errorMessage,
      };
    }

    const nextRetry = t.retryCount + 1;
    if (options?.forcePermanentFail || nextRetry > MAX_RETRY_ATTEMPTS) {
      return {
        ...t,
        status: 'failed' as const,
        retryCount: nextRetry,
        updatedAtMs: now,
        lastError: errorMessage,
      };
    }

    const delayMs =
      RETRY_BACKOFF_MS[Math.min(nextRetry - 1, RETRY_BACKOFF_MS.length - 1)] || 35_000;
    return {
      ...t,
      status: 'pending' as const,
      retryCount: nextRetry,
      nextAttemptAt: now + delayMs,
      updatedAtMs: now,
      lastError: errorMessage,
    };
  });

  if (changed) {
    writeTasks(next);
  }
  return getNextSheetsRetryAt(shopId);
}

export function retryFailedSheetsTasks(shopId: string): number {
  const now = Date.now();
  let resetCount = 0;

  const next = readTasks().map((t) => {
    if (t.shopId !== shopId) return t;
    if (t.status === 'failed' || (t.status === 'pending' && t.nextAttemptAt > now)) {
      resetCount += 1;
      return {
        ...t,
        status: 'pending' as const,
        retryCount: 0,
        nextAttemptAt: now,
        updatedAtMs: now,
        lastError: undefined,
      };
    }
    return t;
  });

  if (resetCount > 0) {
    writeTasks(next);
  }
  return resetCount;
}

export function __resetSheetsQueueMemoryForTest(): void {
  memoryTasks = null;
}
