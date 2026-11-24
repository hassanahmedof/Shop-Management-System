import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

export interface UpsellCartContextItem {
  id: string;
  name: string;
  categoryName: string;
  brandName: string;
  bottleSize?: string;
  quantity: number;
  unitName?: string;
}

export interface UpsellCandidateContextItem {
  id: string;
  name: string;
  categoryName: string;
  brandName: string;
  bottleSize?: string;
  salePrice: number;
  unitName: string;
  stockSummary: string;
}

export interface GeminiUpsellRequestInput {
  cart: UpsellCartContextItem[];
  candidates: UpsellCandidateContextItem[];
}

export interface GeminiUpsellRecommendation {
  candidateId: string;
  romanUrduPrompt: string;
}

export interface GeminiUpsellResult {
  available: boolean;
  reason?: string;
  cached?: boolean;
  suggested: GeminiUpsellRecommendation | null;
}

const GEMINI_UPSELL_MODEL = 'gemini-4-hydrogen';
const GEMINI_TIMEOUT_MS = 4500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 250;
const BILLING_OR_AUTH_COOLDOWN_MS = 15 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  suggested: GeminiUpsellRecommendation | null;
}

const responseCache = new Map<string, CacheEntry>();
let cachedClientKey = '';
let cachedClient: GoogleGenAI | null = null;
let serverUnavailableUntilMs = 0;
let serverUnavailableReason = '';

function classifyGeminiFailure(err: unknown): {
  disableDurationMs: number;
  reason: string;
} {
  const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
  const statusCode =
    typeof errObj?.status === 'number'
      ? errObj.status
      : typeof errObj?.code === 'number'
        ? errObj.code
        : 0;
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err || '');
  const lower = msg.toLowerCase();

  if (
    statusCode === 402 ||
    lower.includes('"code":402') ||
    lower.includes('prepayment credits') ||
    lower.includes('billing')
  ) {
    return {
      disableDurationMs: BILLING_OR_AUTH_COOLDOWN_MS,
      reason: 'GEMINI_CREDITS_DEPLETED',
    };
  }

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied')
  ) {
    return {
      disableDurationMs: BILLING_OR_AUTH_COOLDOWN_MS,
      reason: 'GEMINI_AUTH_UNAVAILABLE',
    };
  }

  if (
    statusCode === 429 ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return {
      disableDurationMs: RATE_LIMIT_COOLDOWN_MS,
      reason: 'GEMINI_RATE_LIMITED',
    };
  }

  return {
    disableDurationMs: 0,
    reason: 'GEMINI_UPSELL_UNAVAILABLE',
  };
}

export function getConfiguredGeminiApiKey(): string {
  let raw = (process.env.GEMINI_API_KEY || '').trim();
  if (/^gemini_api_key\s*=/i.test(raw)) {
    raw = raw.replace(/^gemini_api_key\s*=/i, '').trim();
  }
  raw = raw.replace(/^['"]+|['"]+$/g, '').trim();
  if (!raw || raw === 'MY_GEMINI_API_KEY' || raw.length < 16) {
    return '';
  }
  return raw;
}

export function isGeminiUpsellConfigured(): boolean {
  return Boolean(getConfiguredGeminiApiKey());
}

function getGenAIClient(): GoogleGenAI | null {
  const apiKey = getConfiguredGeminiApiKey();
  if (!apiKey) return null;
  if (!cachedClient || cachedClientKey !== apiKey) {
    cachedClientKey = apiKey;
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

function cleanText(val: unknown, maxLen: number): string {
  if (typeof val !== 'string') return '';
  return val.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

export function sanitizeUpsellRequestInput(raw: unknown): GeminiUpsellRequestInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.cart) || !Array.isArray(body.candidates)) return null;
  if (body.cart.length === 0 || body.cart.length > 40) return null;
  if (body.candidates.length === 0 || body.candidates.length > 30) return null;

  const cart: UpsellCartContextItem[] = [];
  for (const item of body.cart) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = cleanText(rec.id, 120);
    const name = cleanText(rec.name, 160);
    if (!id || !name) continue;
    const rawQty = Number(rec.quantity);
    const quantity = Number.isFinite(rawQty) && rawQty > 0 ? Math.min(9999, rawQty) : 1;
    cart.push({
      id,
      name,
      categoryName: cleanText(rec.categoryName, 80),
      brandName: cleanText(rec.brandName, 80),
      bottleSize: cleanText(rec.bottleSize, 40),
      quantity,
      unitName: cleanText(rec.unitName, 40),
    });
  }

  const seenCandidateIds = new Set<string>();
  const candidates: UpsellCandidateContextItem[] = [];
  for (const item of body.candidates) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = cleanText(rec.id, 120);
    const name = cleanText(rec.name, 160);
    if (!id || !name || seenCandidateIds.has(id)) continue;
    seenCandidateIds.add(id);
    const rawPrice = Number(rec.salePrice);
    candidates.push({
      id,
      name,
      categoryName: cleanText(rec.categoryName, 80),
      brandName: cleanText(rec.brandName, 80),
      bottleSize: cleanText(rec.bottleSize, 40),
      salePrice: Number.isFinite(rawPrice) && rawPrice >= 0 ? Math.round(rawPrice * 100) / 100 : 0,
      unitName: cleanText(rec.unitName, 40) || 'Piece',
      stockSummary: cleanText(rec.stockSummary, 60),
    });
  }

  if (cart.length === 0 || candidates.length === 0) return null;
  return { cart, candidates };
}

function buildCacheKey(shopId: string, input: GeminiUpsellRequestInput): string {
  const cartKey = input.cart
    .map((c) => `${c.id}:${c.quantity}:${c.unitName || ''}`)
    .sort()
    .join('|');
  const candKey = input.candidates
    .map((c) => c.id)
    .sort()
    .join(',');
  return crypto.createHash('sha256').update(`${shopId}::${cartKey}::${candKey}`).digest('hex');
}

function setCachedResult(key: string, suggested: GeminiUpsellRecommendation | null): void {
  const now = Date.now();
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey) responseCache.delete(oldestKey);
  }
  responseCache.set(key, {
    expiresAt: now + CACHE_TTL_MS,
    suggested,
  });
}

function buildDefaultRomanUrduPrompt(productName: string): string {
  return `Customer se poochain: saath ${productName} bhi rakh lain?`;
}

export function validateGeminiRawOutput(
  rawText: string,
  allowedCandidates: Map<string, UpsellCandidateContextItem>
): GeminiUpsellRecommendation | null {
  if (!rawText) return null;
  let parsed: { candidateId?: unknown; romanUrduPrompt?: unknown } | null = null;
  try {
    parsed = JSON.parse(rawText) as { candidateId?: unknown; romanUrduPrompt?: unknown };
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const chosenId = typeof parsed.candidateId === 'string' ? parsed.candidateId.trim() : '';
  if (!chosenId) return null;

  const matchedCandidate = allowedCandidates.get(chosenId);
  if (!matchedCandidate) {
    return null;
  }

  let prompt = cleanText(parsed.romanUrduPrompt, 115);
  if (!prompt || prompt.length < 6) {
    prompt = buildDefaultRomanUrduPrompt(matchedCandidate.name);
  }

  return {
    candidateId: matchedCandidate.id,
    romanUrduPrompt: prompt,
  };
}

export async function suggestUpsellWithGemini(
  shopId: string,
  input: GeminiUpsellRequestInput,
  options?: {
    generateFn?: (promptPayload: {
      systemInstruction: string;
      contents: string;
    }) => Promise<string>;
  }
): Promise<GeminiUpsellResult> {
  const allowedCandidates = new Map<string, UpsellCandidateContextItem>();
  for (const c of input.candidates) {
    allowedCandidates.set(c.id, c);
  }

  const cacheKey = buildCacheKey(shopId, input);
  const now = Date.now();
  const cached = responseCache.get(cacheKey);
  if (cached && now < cached.expiresAt) {
    if (cached.suggested && !allowedCandidates.has(cached.suggested.candidateId)) {
      responseCache.delete(cacheKey);
    } else {
      return {
        available: true,
        cached: true,
        suggested: cached.suggested,
      };
    }
  }

  if (!options?.generateFn && Date.now() < serverUnavailableUntilMs) {
    return {
      available: false,
      reason: serverUnavailableReason || 'GEMINI_TEMPORARILY_UNAVAILABLE',
      suggested: null,
    };
  }

  const ai = options?.generateFn ? null : getGenAIClient();
  if (!ai && !options?.generateFn) {
    return {
      available: false,
      reason: 'GEMINI_NOT_CONFIGURED',
      suggested: null,
    };
  }

  const systemInstruction = [
    'You are a retail POS upsell advisor for a Pakistani neighborhood pharmacy and mart (CareMart).',
    'Select AT MOST ONE genuinely complementary in-stock product from `eligibleCandidates` that pairs naturally with the ENTIRE `currentCart`.',
    'Rules:',
    '1. Only choose a `candidateId` that exists verbatim in `eligibleCandidates`.',
    '2. Never suggest a variant, alternative pack size, or near-duplicate of anything already in `currentCart`.',
    '3. Consider item quantities in `currentCart`. If no candidate is genuinely helpful, return candidateId: null.',
    '4. Write `romanUrduPrompt` as a very short, natural, polite Roman Urdu sentence for the cashier (max 12 words), e.g., "Chai ke saath Nestle MilkPak bhi rakh lain?".',
  ].join('\n');

  const compactPayload = JSON.stringify({
    currentCart: input.cart.map((c) => ({
      name: c.name,
      brand: c.brandName || undefined,
      category: c.categoryName || undefined,
      size: c.bottleSize || undefined,
      qty: c.quantity,
      unit: c.unitName || undefined,
    })),
    eligibleCandidates: input.candidates.map((c) => ({
      id: c.id,
      name: c.name,
      brand: c.brandName || undefined,
      category: c.categoryName || undefined,
      size: c.bottleSize || undefined,
      pricePkr: c.salePrice,
      unit: c.unitName,
    })),
  });

  try {
    const rawText = options?.generateFn
      ? await options.generateFn({ systemInstruction, contents: compactPayload })
      : await Promise.race<string>([
          (async () => {
            const response = await ai!.models.generateContent({
              model: GEMINI_UPSELL_MODEL,
              contents: compactPayload,
              config: {
                systemInstruction,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                temperature: 0.2,
                maxOutputTokens: 180,
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    candidateId: {
                      type: Type.STRING,
                      nullable: true,
                      description:
                        'Exact id from eligibleCandidates, or null if no complementary product fits.',
                    },
                    romanUrduPrompt: {
                      type: Type.STRING,
                      description:
                        'Short, polite Roman Urdu suggestion sentence for the cashier (max 12 words).',
                    },
                  },
                  required: ['candidateId', 'romanUrduPrompt'],
                },
              },
            });
            return response.text || '';
          })(),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('Gemini request timed out.')), GEMINI_TIMEOUT_MS)
          ),
        ]);

    const suggested = validateGeminiRawOutput(rawText, allowedCandidates);
    setCachedResult(cacheKey, suggested);
    return {
      available: true,
      cached: false,
      suggested,
    };
  } catch (err) {
    const failure = classifyGeminiFailure(err);
    if (!options?.generateFn && failure.disableDurationMs > 0) {
      serverUnavailableUntilMs = Date.now() + failure.disableDurationMs;
      serverUnavailableReason = failure.reason;
      return {
        available: false,
        reason: failure.reason,
        suggested: null,
      };
    }
    return {
      available: true,
      reason: failure.reason,
      suggested: null,
    };
  }
}

export function clearGeminiUpsellCache(): void {
  responseCache.clear();
  serverUnavailableUntilMs = 0;
  serverUnavailableReason = '';
}
