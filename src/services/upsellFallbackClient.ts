import type { SearchableProductItem } from './productSearchService';
import {
  buildGeminiFallbackPayload,
  type CartAssistantItem,
  filterEligibleUpsellCandidates,
  type UpsellSuggestion,
  validateGeminiUpsellResponse,
} from '../utils/salesAssistant';

interface ClientCacheEntry {
  expiresAt: number;
  candidateId: string | null;
  romanUrduPrompt?: string;
}

const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;
const CLIENT_CACHE_MAX_ENTRIES = 60;
const SERVER_UNAVAILABLE_BACKOFF_MS = 5 * 60 * 1000;

const clientResponseCache = new Map<string, ClientCacheEntry>();
let geminiUnavailableUntilMs = 0;

export function buildUpsellCacheKey(params: {
  shopId: string;
  cartSignature: string;
  dismissedProductIds: string[];
  removedProductIds: string[];
}): string {
  const excludedSig = Array.from(
    new Set([...params.dismissedProductIds, ...params.removedProductIds].filter(Boolean))
  )
    .sort()
    .join(',');
  return `${params.shopId}::${params.cartSignature}::${excludedSig}`;
}

export function isGeminiFallbackTemporarilyDisabled(now = Date.now()): boolean {
  return geminiUnavailableUntilMs > now;
}

export function clearGeminiFallbackClientState(): void {
  clientResponseCache.clear();
  geminiUnavailableUntilMs = 0;
}

export function getCachedGeminiSuggestion(params: {
  cacheKey: string;
  cartItems: CartAssistantItem[];
  catalog: SearchableProductItem[];
  dismissedProductIds: string[];
  removedProductIds: string[];
}): { hit: boolean; suggestion: UpsellSuggestion | null } {
  const cached = clientResponseCache.get(params.cacheKey);
  if (!cached) return { hit: false, suggestion: null };
  if (Date.now() >= cached.expiresAt) {
    clientResponseCache.delete(params.cacheKey);
    return { hit: false, suggestion: null };
  }
  if (!cached.candidateId) {
    return { hit: true, suggestion: null };
  }
  const validated = validateGeminiUpsellResponse({
    candidateId: cached.candidateId,
    romanUrduPrompt: cached.romanUrduPrompt,
    cartItems: params.cartItems,
    catalog: params.catalog,
    dismissedProductIds: params.dismissedProductIds,
    removedProductIds: params.removedProductIds,
  });
  if (!validated) {
    // Stock or exclusions changed since cache write — invalidate stale cache entry
    clientResponseCache.delete(params.cacheKey);
    return { hit: false, suggestion: null };
  }
  return { hit: true, suggestion: validated };
}

function storeClientCacheEntry(
  cacheKey: string,
  candidateId: string | null,
  romanUrduPrompt?: string
): void {
  if (clientResponseCache.size >= CLIENT_CACHE_MAX_ENTRIES) {
    const oldest = clientResponseCache.keys().next().value;
    if (oldest) clientResponseCache.delete(oldest);
  }
  clientResponseCache.set(cacheKey, {
    expiresAt: Date.now() + CLIENT_CACHE_TTL_MS,
    candidateId,
    romanUrduPrompt,
  });
}

export async function fetchGeminiUpsellFallback(params: {
  shopId: string;
  cartSignature: string;
  cartItems: CartAssistantItem[];
  catalog: SearchableProductItem[];
  dismissedProductIds: string[];
  removedProductIds: string[];
  getIdToken: () => Promise<string | null>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ suggestion: UpsellSuggestion | null; aborted?: boolean }> {
  const {
    shopId,
    cartSignature,
    cartItems,
    catalog,
    dismissedProductIds,
    removedProductIds,
    getIdToken,
    signal,
    fetchImpl = fetch,
  } = params;

  if (!shopId || cartItems.length === 0 || catalog.length === 0) {
    return { suggestion: null };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { suggestion: null };
  }

  if (isGeminiFallbackTemporarilyDisabled()) {
    return { suggestion: null };
  }

  const cacheKey = buildUpsellCacheKey({
    shopId,
    cartSignature,
    dismissedProductIds,
    removedProductIds,
  });

  const cached = getCachedGeminiSuggestion({
    cacheKey,
    cartItems,
    catalog,
    dismissedProductIds,
    removedProductIds,
  });
  if (cached.hit) {
    return { suggestion: cached.suggestion };
  }

  const { normalizedCart, eligibleCandidates, catalogById } = filterEligibleUpsellCandidates({
    cartItems,
    catalog,
    dismissedProductIds,
    removedProductIds,
  });

  if (normalizedCart.length === 0 || eligibleCandidates.length === 0) {
    return { suggestion: null };
  }

  const payload = buildGeminiFallbackPayload({
    cartItems: normalizedCart,
    catalogById,
    eligibleCandidates,
    maxCandidates: 20,
  });
  if (!payload) {
    return { suggestion: null };
  }

  let token: string | null = null;
  try {
    token = await getIdToken();
  } catch {
    return { suggestion: null };
  }
  if (!token || signal?.aborted) {
    return { suggestion: null, aborted: Boolean(signal?.aborted) };
  }

  try {
    const res = await fetchImpl('/api/upsell/suggest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (signal?.aborted) {
      return { suggestion: null, aborted: true };
    }

    if (res.status === 503) {
      // Server-side GEMINI_API_KEY not configured or temporarily disabled — back off quietly
      geminiUnavailableUntilMs = Date.now() + SERVER_UNAVAILABLE_BACKOFF_MS;
      return { suggestion: null };
    }

    if (!res.ok) {
      return { suggestion: null };
    }

    const body = (await res.json()) as {
      ok?: boolean;
      available?: boolean;
      reason?: string;
      suggestion?: { candidateId?: string | null; romanUrduPrompt?: string } | null;
    };

    if (body?.available === false) {
      const reason = body.reason || '';
      const backoffMs =
        reason === 'GEMINI_CREDITS_DEPLETED' || reason === 'GEMINI_AUTH_UNAVAILABLE'
          ? 15 * 60 * 1000
          : reason === 'GEMINI_RATE_LIMITED'
            ? 2 * 60 * 1000
            : SERVER_UNAVAILABLE_BACKOFF_MS;
      geminiUnavailableUntilMs = Date.now() + backoffMs;
      return { suggestion: null };
    }

    const candidateId =
      typeof body?.suggestion?.candidateId === 'string' ? body.suggestion.candidateId.trim() : '';
    const prompt =
      typeof body?.suggestion?.romanUrduPrompt === 'string'
        ? body.suggestion.romanUrduPrompt.trim()
        : '';

    if (!candidateId) {
      storeClientCacheEntry(cacheKey, null);
      return { suggestion: null };
    }

    const validated = validateGeminiUpsellResponse({
      candidateId,
      romanUrduPrompt: prompt,
      cartItems: normalizedCart,
      catalog,
      dismissedProductIds,
      removedProductIds,
    });

    if (validated) {
      storeClientCacheEntry(cacheKey, validated.product.id, validated.romanUrduPrompt);
    }
    return { suggestion: validated };
  } catch (err) {
    if (
      signal?.aborted ||
      (err instanceof Error && err.name === 'AbortError')
    ) {
      return { suggestion: null, aborted: true };
    }
    return { suggestion: null };
  }
}
