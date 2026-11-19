import type { DiscordTransactionNotificationPayload } from '../../shared/discordSchema';
import { auth } from '../lib/firebase';

const CLIENT_DEDUPE_STORAGE_KEY = 'cm_discord_notified_keys';
const CLIENT_DEDUPE_MAX = 250;
const memoryNotifiedKeys = new Set<string>();

function loadStoredKeys(): string[] {
  try {
    const raw = localStorage.getItem(CLIENT_DEDUPE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function hasAlreadyNotified(key: string): boolean {
  if (memoryNotifiedKeys.has(key)) return true;
  const stored = loadStoredKeys();
  return stored.includes(key);
}

function markNotified(key: string): void {
  memoryNotifiedKeys.add(key);
  try {
    const stored = loadStoredKeys().filter((k) => k !== key);
    stored.push(key);
    const trimmed = stored.slice(-CLIENT_DEDUPE_MAX);
    localStorage.setItem(CLIENT_DEDUPE_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota or restricted browser context errors
  }
}

/**
 * Fires an independent, non-blocking Discord webhook notification via the backend API.
 * Guaranteed never to throw or interfere with Firestore transactions or UI state.
 */
export async function notifyDiscordTransaction(
  shopId: string,
  payload: DiscordTransactionNotificationPayload
): Promise<void> {
  if (!shopId || !payload?.dedupeId) return;

  const dedupeKey = `${shopId}:${payload.type}:${payload.dedupeId}`;
  if (hasAlreadyNotified(dedupeKey)) {
    return;
  }

  // Mark optimistically before dispatching so retries never duplicate
  markNotified(dedupeKey);

  try {
    const currentUser = auth.currentUser;
    if (!currentUser) return;
    const idToken = await currentUser.getIdToken();
    if (!idToken) return;

    const body = JSON.stringify(payload);
    const useKeepalive = body.length < 60_000;

    const res = await fetch('/api/notifications/discord', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body,
      keepalive: useKeepalive,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`Discord notification endpoint returned ${res.status}: ${errText.slice(0, 150)}`);
    }
  } catch (err) {
    console.warn(
      'Discord notification failed (transaction was still saved):',
      err instanceof Error ? err.message : err
    );
  }
}
