import { onAuthStateChanged } from 'firebase/auth';
import type { DiscordTransactionNotificationPayload } from '../../shared/discordSchema';
import { auth } from '../lib/firebase';
import { recordPerfMetric, startPerfTimer } from '../utils/perfMonitor';

const CLIENT_DEDUPE_STORAGE_KEY = 'cm_discord_notified_keys';
const CLIENT_QUEUE_STORAGE_KEY = 'cm_discord_queue_v1';
const CLIENT_DEDUPE_MAX = 400;
const MAX_COMPLETED_HISTORY = 50;
const MAX_RETRY_ATTEMPTS = 6;
const RETRY_BACKOFF_MS = [3000, 10_000, 30_000, 60_000, 120_000, 300_000];

export type DiscordJobStatus = 'pending' | 'completed' | 'failed';

export interface DiscordQueuedJob {
  id: string; // `${shopId}:${type}:${dedupeId}`
  shopId: string;
  payload: DiscordTransactionNotificationPayload;
  status: DiscordJobStatus;
  retryCount: number;
  nextAttemptAt: number;
  createdAtMs: number;
  completedAtMs?: number;
  lastError?: string;
}

export interface DiscordCapabilitiesClient {
  configured: boolean;
  status: 'active' | 'not_configured' | 'invalid_format';
  source: 'vault' | 'env' | 'none';
  diagnostic: string | null;
}

export interface DiscordTestAlertResponse {
  ok: boolean;
  sent: boolean;
  statusCode?: number;
  messageId?: string;
  error?: string;
  reason?: string;
  retryAfterMs?: number;
}

const memoryNotifiedKeys = new Set<string>();
let memoryQueue: DiscordQueuedJob[] | null = null;
let drainingPromise: Promise<void> | null = null;
let retryTimerId: number | null = null;
let listenersBound = false;
const queueListeners = new Set<() => void>();

function notifyQueueListeners(): void {
  for (const listener of queueListeners) {
    try {
      listener();
    } catch {
      // Ignore subscriber errors
    }
  }
}

export function subscribeDiscordQueue(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

function safeReadJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeWriteJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota or restricted browser context errors
  }
}

function loadStoredKeys(): string[] {
  const parsed = safeReadJson<unknown>(CLIENT_DEDUPE_STORAGE_KEY, []);
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
}

function hasAlreadyNotified(key: string): boolean {
  if (memoryNotifiedKeys.has(key)) return true;
  return loadStoredKeys().includes(key);
}

function markNotified(key: string): void {
  memoryNotifiedKeys.add(key);
  const stored = loadStoredKeys().filter((k) => k !== key);
  stored.push(key);
  safeWriteJson(CLIENT_DEDUPE_STORAGE_KEY, stored.slice(-CLIENT_DEDUPE_MAX));
}

function normalizeJobStatus(raw: unknown): DiscordJobStatus {
  if (raw === 'completed' || raw === 'sent') return 'completed';
  if (raw === 'failed') return 'failed';
  return 'pending';
}

function readQueue(): DiscordQueuedJob[] {
  if (memoryQueue !== null) return memoryQueue;
  const parsed = safeReadJson<unknown>(CLIENT_QUEUE_STORAGE_KEY, []);
  if (!Array.isArray(parsed)) {
    memoryQueue = [];
    return memoryQueue;
  }
  memoryQueue = parsed
    .filter(
      (x): x is DiscordQueuedJob =>
        Boolean(x) &&
        typeof x === 'object' &&
        typeof (x as DiscordQueuedJob).id === 'string' &&
        typeof (x as DiscordQueuedJob).shopId === 'string' &&
        Boolean((x as DiscordQueuedJob).payload)
    )
    .map((x) => ({
      ...x,
      status: normalizeJobStatus((x as { status?: unknown }).status),
    }));
  return memoryQueue;
}

function writeQueue(next: DiscordQueuedJob[]): void {
  // Always retain all pending & failed jobs; keep latest MAX_COMPLETED_HISTORY completed jobs
  const activeOrFailed = next.filter((j) => j.status === 'pending' || j.status === 'failed');
  const completed = next
    .filter((j) => j.status === 'completed')
    .sort((a, b) => (a.completedAtMs ?? a.createdAtMs) - (b.completedAtMs ?? b.createdAtMs))
    .slice(-MAX_COMPLETED_HISTORY);
  const compact = [...completed, ...activeOrFailed].sort((a, b) => a.createdAtMs - b.createdAtMs);
  memoryQueue = compact;
  safeWriteJson(CLIENT_QUEUE_STORAGE_KEY, compact);
  notifyQueueListeners();
}

let drainNeedsAnotherPass = false;

function bindGlobalListeners(): void {
  if (listenersBound || typeof window === 'undefined') return;
  listenersBound = true;
  window.addEventListener('online', () => {
    void flushDiscordNotificationQueue();
  });
  window.addEventListener('focus', () => {
    if (readQueue().some((j) => j.status === 'pending')) {
      void flushDiscordNotificationQueue();
    }
  });
  window.addEventListener('storage', (e) => {
    if (e.key === CLIENT_QUEUE_STORAGE_KEY) {
      memoryQueue = null;
      notifyQueueListeners();
      void flushDiscordNotificationQueue();
    } else if (e.key === CLIENT_DEDUPE_STORAGE_KEY) {
      memoryNotifiedKeys.clear();
    }
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void flushDiscordNotificationQueue();
      }
    });
  }
}

function scheduleQueueRetry(delayMs: number): void {
  if (typeof window === 'undefined') return;
  if (retryTimerId !== null) {
    window.clearTimeout(retryTimerId);
  }
  retryTimerId = window.setTimeout(() => {
    retryTimerId = null;
    void flushDiscordNotificationQueue();
  }, Math.max(250, delayMs));
}

interface DiscordApiResponseBody {
  ok?: boolean;
  sent?: boolean;
  deduplicated?: boolean;
  skipped?: boolean;
  retryable?: boolean;
  code?: string;
  statusCode?: number;
  messageId?: string;
  retryAfterMs?: number;
  reason?: string;
  error?: string;
}

function parseRetryAfterHeaderMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) {
    return Math.min(120_000, Math.max(1000, Math.ceil(secs * 1000)));
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function postDiscordPayloadOnce(
  body: string,
  idToken: string
): Promise<{ res: Response; data: DiscordApiResponseBody }> {
  // Persisted localStorage queue handles durability across tab closes, so standard foreground fetch
  // avoids Chrome's 64KB keepalive quota & proxy/CORS abort issues on mobile and iframe previews.
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => {
        controller.abort();
      }, 15_000)
    : null;

  try {
    const res = await fetch('/api/notifications/discord', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body,
      signal: controller ? controller.signal : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as DiscordApiResponseBody;
    return { res, data };
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

async function dispatchDiscordJob(job: DiscordQueuedJob): Promise<{
  outcome: 'completed' | 'permanent_fail' | 'retryable_error' | 'defer_auth';
  error?: string;
  retryAfterMs?: number;
}> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    return { outcome: 'defer_auth', error: 'Waiting for authenticated user session.' };
  }

  let idToken = '';
  try {
    idToken = await withTimeout(
      currentUser.getIdToken(),
      10_000,
      'Timed out reading authentication token.'
    );
  } catch (err) {
    return {
      outcome: 'retryable_error',
      error: err instanceof Error ? err.message : 'Unable to read auth token.',
    };
  }
  if (!idToken) {
    return { outcome: 'retryable_error', error: 'Missing auth token.' };
  }

  const body = JSON.stringify(job.payload);

  try {
    let { res, data } = await postDiscordPayloadOnce(body, idToken);

    // If token expired between checks, force refresh once and immediately retry
    if (res.status === 401) {
      try {
        const refreshedToken = await withTimeout(
          currentUser.getIdToken(true),
          10_000,
          'Timed out refreshing authentication token.'
        );
        if (refreshedToken) {
          ({ res, data } = await postDiscordPayloadOnce(body, refreshedToken));
        }
      } catch {
        // Fall through with original 401 handling
      }
    }

    if (res.ok) {
      if (data.skipped) {
        return {
          outcome: 'permanent_fail',
          error:
            data.reason ||
            data.error ||
            'Discord webhook is not configured on the server.',
        };
      }
      if (data.sent || data.deduplicated || data.ok === true) {
        return { outcome: 'completed' };
      }
      return {
        outcome: data.retryable === false ? 'permanent_fail' : 'retryable_error',
        error: data.error || 'Discord webhook delivery was not confirmed.',
        retryAfterMs: data.retryAfterMs,
      };
    }

    const errMsg = data.error || data.reason || `HTTP ${res.status}`;
    const retryAfterMs = data.retryAfterMs ?? parseRetryAfterHeaderMs(res);

    // 503 / skipped (missing or malformed webhook secret) -> mark failed with explicit diagnostic, never completed
    if (
      res.status === 503 ||
      data.skipped ||
      data.code === 'DISCORD_WEBHOOK_NOT_CONFIGURED' ||
      data.code === 'DISCORD_WEBHOOK_INVALID'
    ) {
      return {
        outcome: 'permanent_fail',
        error: errMsg.slice(0, 200),
      };
    }

    if (
      res.status === 400 ||
      res.status === 403 ||
      res.status === 404 ||
      res.status === 422 ||
      data.retryable === false
    ) {
      return {
        outcome: 'permanent_fail',
        error: `Discord notification rejected (${res.status}): ${errMsg.slice(0, 160)}`,
      };
    }

    return {
      outcome: 'retryable_error',
      error: errMsg.slice(0, 180),
      retryAfterMs,
    };
  } catch (err) {
    return {
      outcome: 'retryable_error',
      error: err instanceof Error ? err.message : 'Network error sending Discord notification.',
    };
  }
}

/**
 * Drains queued Discord webhook jobs completely asynchronously in the background.
 * Handles deduplication, offline deferral, exponential backoff & 429 rate-limit retries,
 * and accurate failure diagnostics.
 */
export function flushDiscordNotificationQueue(): Promise<void> {
  if (drainingPromise) {
    drainNeedsAnotherPass = true;
    return drainingPromise;
  }

  let currentDrain: Promise<void> | null = null;
  currentDrain = (async () => {
    // Yield one microtask so `drainingPromise = currentDrain` always executes before `finally`
    // even when the queue has no due pending jobs and exits without awaiting network I/O.
    await Promise.resolve();
    try {
      do {
        drainNeedsAnotherPass = false;
        while (true) {
          if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            break;
          }

          const now = Date.now();
          const queue = readQueue();
          const nextJob = queue.find(
            (j) => j.status === 'pending' && j.nextAttemptAt <= now
          );

          if (!nextJob) {
            const earliestFuture = queue
              .filter((j) => j.status === 'pending' && j.nextAttemptAt > now)
              .reduce<number | null>(
                (min, j) => (min === null || j.nextAttemptAt < min ? j.nextAttemptAt : min),
                null
              );
            if (earliestFuture !== null) {
              scheduleQueueRetry(earliestFuture - now);
            }
            break;
          }

          if (hasAlreadyNotified(nextJob.id)) {
            writeQueue(
              readQueue().map((j) =>
                j.id === nextJob.id
                  ? { ...j, status: 'completed' as const, completedAtMs: Date.now(), lastError: undefined }
                  : j
              )
            );
            continue;
          }

          const stopTimer = startPerfTimer();
          const result = await dispatchDiscordJob(nextJob);
          const elapsed = stopTimer();

          if (result.outcome === 'completed') {
            markNotified(nextJob.id);
            writeQueue(
              readQueue().map((j) =>
                j.id === nextJob.id
                  ? {
                      ...j,
                      status: 'completed' as const,
                      completedAtMs: Date.now(),
                      lastError: undefined,
                    }
                  : j
              )
            );
            try {
              recordPerfMetric('discord_async', `notify_${nextJob.payload.type}`, elapsed, {
                outcome: 'completed',
                retries: nextJob.retryCount,
              });
            } catch {
              // Ignore metrics errors
            }
            continue;
          }

          if (result.outcome === 'defer_auth') {
            // Do not burn retry attempts while waiting for Firebase auth session hydration
            writeQueue(
              readQueue().map((j) =>
                j.id === nextJob.id
                  ? {
                      ...j,
                      status: 'pending' as const,
                      nextAttemptAt: Date.now() + 2000,
                      lastError: result.error,
                    }
                  : j
              )
            );
            scheduleQueueRetry(2000);
            break;
          }

          if (result.outcome === 'permanent_fail') {
            writeQueue(
              readQueue().map((j) =>
                j.id === nextJob.id
                  ? {
                      ...j,
                      status: 'failed' as const,
                      retryCount: nextJob.retryCount + 1,
                      lastError: result.error,
                    }
                  : j
              )
            );
            try {
              recordPerfMetric('discord_async', `notify_${nextJob.payload.type}`, elapsed, {
                outcome: 'failed',
                retries: nextJob.retryCount + 1,
              });
            } catch {
              // Ignore metrics errors
            }
            console.warn(result.error || 'Discord notification could not be delivered.');
            continue;
          }

          const nextRetryCount = nextJob.retryCount + 1;
          if (nextRetryCount > MAX_RETRY_ATTEMPTS) {
            writeQueue(
              readQueue().map((j) =>
                j.id === nextJob.id
                  ? {
                      ...j,
                      status: 'failed' as const,
                      retryCount: nextRetryCount,
                      lastError: result.error,
                    }
                  : j
              )
            );
            try {
              recordPerfMetric('discord_async', `notify_${nextJob.payload.type}`, elapsed, {
                outcome: 'failed',
                retries: nextRetryCount,
              });
            } catch {
              // Ignore metrics errors
            }
            console.warn(`Discord notification failed after retries (${nextJob.id}): ${result.error}`);
          } else {
            const baseBackoffMs =
              RETRY_BACKOFF_MS[Math.min(nextRetryCount - 1, RETRY_BACKOFF_MS.length - 1)] || 60_000;
            const jitterMs = Math.floor(Math.random() * 600);
            const delayMs = Math.max(baseBackoffMs + jitterMs, result.retryAfterMs || 0);
            const nextAttemptAt = Date.now() + delayMs;
            writeQueue(
              readQueue().map((j) =>
                j.id === nextJob.id
                  ? {
                      ...j,
                      status: 'pending' as const,
                      retryCount: nextRetryCount,
                      nextAttemptAt,
                      lastError: result.error,
                    }
                  : j
              )
            );
          }
        }
      } while (drainNeedsAnotherPass);
    } finally {
      if (drainingPromise === currentDrain) {
        drainingPromise = null;
      }
    }
  })();

  drainingPromise = currentDrain;
  return currentDrain;
}

/**
 * Initializes the Discord background queue worker on app boot, binding network recovery
 * and auth readiness listeners, and flushing any pending notifications persisted before reload.
 */
export function initializeDiscordQueueWorker(): () => void {
  bindGlobalListeners();
  const now = Date.now();
  const queue = readQueue();
  // Recover any jobs that previously failed solely while waiting for an auth session
  const recovered = queue.map((j) =>
    j.status === 'failed' && j.lastError === 'Waiting for authenticated user session.'
      ? { ...j, status: 'pending' as const, retryCount: 0, nextAttemptAt: now, lastError: undefined }
      : j
  );
  if (recovered.some((j, i) => j !== queue[i])) {
    writeQueue(recovered);
  }
  if (recovered.some((j) => j.status === 'pending')) {
    void flushDiscordNotificationQueue();
  }
  const unsubAuth = onAuthStateChanged(auth, (firebaseUser) => {
    if (!firebaseUser) return;
    const current = readQueue();
    // Reset nextAttemptAt for jobs that were deferred waiting for auth so they flush immediately
    const woken = current.map((j) =>
      j.status === 'pending' && j.lastError === 'Waiting for authenticated user session.'
        ? { ...j, nextAttemptAt: Date.now(), lastError: undefined }
        : j
    );
    if (woken.some((j, i) => j !== current[i])) {
      writeQueue(woken);
    }
    if (woken.some((j) => j.status === 'pending')) {
      void flushDiscordNotificationQueue();
    }
  });
  return () => {
    unsubAuth();
    if (typeof window !== 'undefined' && retryTimerId !== null) {
      window.clearTimeout(retryTimerId);
      retryTimerId = null;
    }
  };
}

export function getDiscordQueueJobs(shopId?: string): DiscordQueuedJob[] {
  return readQueue().filter((j) => (!shopId ? true : j.shopId === shopId));
}

export function getDiscordQueueStats(shopId?: string): {
  pending: number;
  completed: number;
  failed: number;
  latestError: string | null;
} {
  const queue = getDiscordQueueJobs(shopId);
  const failedJobs = queue.filter((j) => j.status === 'failed');
  const pendingWithErr = queue.filter((j) => j.status === 'pending' && Boolean(j.lastError));
  const latestSource =
    failedJobs[failedJobs.length - 1] || pendingWithErr[pendingWithErr.length - 1] || null;
  return {
    pending: queue.filter((j) => j.status === 'pending').length,
    completed: queue.filter((j) => j.status === 'completed').length,
    failed: failedJobs.length,
    latestError: latestSource?.lastError || null,
  };
}

export async function retryFailedDiscordNotifications(shopId?: string): Promise<void> {
  const now = Date.now();
  const queue = readQueue();
  let changed = false;
  const updated = queue.map((j) => {
    if (j.status === 'failed' && (!shopId || j.shopId === shopId)) {
      changed = true;
      return {
        ...j,
        status: 'pending' as const,
        retryCount: 0,
        nextAttemptAt: now,
        lastError: undefined,
      };
    }
    return j;
  });
  if (changed) {
    writeQueue(updated);
  }
  await flushDiscordNotificationQueue();
}

async function requireFreshAdminToken(): Promise<string> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Sign in as Owner/Admin to manage Discord integration.');
  }
  return currentUser.getIdToken();
}

export async function fetchDiscordCapabilities(): Promise<DiscordCapabilitiesClient> {
  const token = await requireFreshAdminToken();
  const res = await fetch('/api/admin/discord/capabilities?verify=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json().catch(() => ({}))) as Partial<DiscordCapabilitiesClient> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || `Failed to inspect Discord configuration (${res.status}).`);
  }
  return {
    configured: Boolean(data.configured),
    status: data.status || 'not_configured',
    source: data.source || 'none',
    diagnostic: data.diagnostic ?? null,
  };
}

export async function saveDiscordWebhookVault(
  webhookUrl: string,
  shopId?: string
): Promise<DiscordCapabilitiesClient> {
  const token = await requireFreshAdminToken();
  const res = await fetch('/api/admin/discord/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ webhookUrl }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<DiscordCapabilitiesClient> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || `Failed to verify and save Discord webhook (${res.status}).`);
  }
  // Automatically replay any queued alerts that previously failed due to missing webhook
  void retryFailedDiscordNotifications(shopId);
  return {
    configured: Boolean(data.configured),
    status: data.status || 'active',
    source: data.source || 'vault',
    diagnostic: data.diagnostic ?? null,
  };
}

export async function removeDiscordWebhookVault(): Promise<DiscordCapabilitiesClient> {
  const token = await requireFreshAdminToken();
  const res = await fetch('/api/admin/discord/webhook', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json().catch(() => ({}))) as Partial<DiscordCapabilitiesClient> & {
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error || `Failed to remove Discord webhook (${res.status}).`);
  }
  return {
    configured: Boolean(data.configured),
    status: data.status || 'not_configured',
    source: data.source || 'none',
    diagnostic: data.diagnostic ?? null,
  };
}

export async function sendDiscordTestAlert(): Promise<DiscordTestAlertResponse> {
  const token = await requireFreshAdminToken();
  const res = await fetch('/api/admin/discord/test', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json().catch(() => ({}))) as Partial<DiscordTestAlertResponse>;
  return {
    ok: Boolean(res.ok && data.sent),
    sent: Boolean(data.sent),
    statusCode: data.statusCode ?? res.status,
    messageId: data.messageId,
    error: data.error,
    reason: data.reason,
    retryAfterMs: data.retryAfterMs,
  };
}

/**
 * Enqueues an independent, non-blocking Discord notification and schedules background delivery.
 * Safe to invoke without `await` immediately after any primary Firebase commit.
 */
export function enqueueDiscordTransaction(
  shopId: string,
  payload: DiscordTransactionNotificationPayload
): void {
  if (!shopId || !payload?.dedupeId) return;
  bindGlobalListeners();

  const dedupeKey = `${shopId}:${payload.type}:${payload.dedupeId}`;
  if (hasAlreadyNotified(dedupeKey)) {
    return;
  }

  const queue = readQueue();
  if (queue.some((j) => j.id === dedupeKey && j.status === 'pending')) {
    setTimeout(() => {
      void flushDiscordNotificationQueue();
    }, 0);
    return;
  }

  const job: DiscordQueuedJob = {
    id: dedupeKey,
    shopId,
    payload,
    status: 'pending',
    retryCount: 0,
    nextAttemptAt: Date.now(),
    createdAtMs: Date.now(),
  };

  writeQueue([...queue.filter((j) => j.id !== dedupeKey), job]);

  // Schedule completely outside the calling UI / transaction stack
  const triggerFlush = () => {
    void flushDiscordNotificationQueue();
  };
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(triggerFlush);
  } else {
    setTimeout(triggerFlush, 0);
  }
}

/**
 * Fires an independent, non-blocking Discord webhook notification via the persistent background queue.
 * Guaranteed never to throw or delay UI state.
 */
export function notifyDiscordTransaction(
  shopId: string,
  payload: DiscordTransactionNotificationPayload
): Promise<void> {
  try {
    enqueueDiscordTransaction(shopId, payload);
  } catch (err) {
    console.warn('Unable to enqueue Discord notification:', err);
  }
  return Promise.resolve();
}

export function __resetDiscordQueueMemoryForTest(): void {
  memoryQueue = null;
  memoryNotifiedKeys.clear();
  drainingPromise = null;
  drainNeedsAnotherPass = false;
  if (typeof window !== 'undefined' && retryTimerId !== null) {
    window.clearTimeout(retryTimerId);
    retryTimerId = null;
  }
}
