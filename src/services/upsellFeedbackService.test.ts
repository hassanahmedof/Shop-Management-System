import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UPSELL_FEEDBACK_VERSION } from '../../shared/upsellCacheSchema';
import {
  flushPendingFeedbackEvents,
  getPendingFeedbackQueueCount,
  getUpsellFeedbackAdjustment,
  recordUpsellFeedbackEvent,
  resetUpsellFeedbackStore,
  syncFeedbackWithBackend,
} from './upsellFeedbackService';

const SHOP_ID = 'shop_feedback_test_1';

describe('upsellFeedbackService durable queue & sync merge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetUpsellFeedbackStore(SHOP_ID);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetUpsellFeedbackStore(SHOP_ID);
  });

  it('assigns unique eventId, retains unsent events across transient failures, and flushes on recovery', async () => {
    let calls = 0;
    const sentBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (init?.body) {
        sentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      if (calls === 1) {
        return new Response(JSON.stringify({ ok: false, error: 'temporary' }), { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true, duplicate: false, revision: 1 }), { status: 200 });
    });

    recordUpsellFeedbackEvent({
      shopId: SHOP_ID,
      productId: 'prod_1',
      eventType: 'accepted',
      categoryKey: 'skincare',
      anchorCategoryKeys: ['hair'],
      getIdToken: async () => 'tok_1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(typeof sentBodies[0]?.eventId).toBe('string');
    expect((sentBodies[0]?.eventId as string).length).toBeGreaterThanOrEqual(8);
    expect(getPendingFeedbackQueueCount(SHOP_ID)).toBe(1);

    // Retry flush after transient failure -> uses SAME eventId and drains queue on 200
    const flushed = await flushPendingFeedbackEvents({
      shopId: SHOP_ID,
      getIdToken: async () => 'tok_1',
      fetchImpl: fetchMock as unknown as typeof fetch,
      ignoreBackoff: true,
    });
    expect(flushed.flushedCount).toBe(1);
    expect(flushed.remainingCount).toBe(0);
    expect(sentBodies[1]?.eventId).toBe(sentBodies[0]?.eventId);
  });

  it('preserves pending local feedback events on top of backend snapshot when POST cannot flush yet', async () => {
    recordUpsellFeedbackEvent({
      shopId: SHOP_ID,
      productId: 'prod_local_pending',
      eventType: 'accepted',
      categoryKey: 'snacks',
      anchorCategoryKeys: ['beverages'],
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(getPendingFeedbackQueueCount(SHOP_ID)).toBe(1);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: false }), { status: 503 });
      }
      if (url.startsWith('/api/upsell/feedback')) {
        return new Response(
          JSON.stringify({
            ok: true,
            unchanged: false,
            snapshot: {
              version: UPSELL_FEEDBACK_VERSION,
              shopId: SHOP_ID,
              revision: 4,
              productStats: {},
              categoryPairStats: {},
              updatedAt: Date.now(),
            },
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    });

    await syncFeedbackWithBackend({
      shopId: SHOP_ID,
      getIdToken: async () => 'tok_1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    // Pending local accepted event was NOT clobbered by empty server snapshot
    expect(getPendingFeedbackQueueCount(SHOP_ID)).toBe(1);
    const adj = getUpsellFeedbackAdjustment({
      shopId: SHOP_ID,
      candidateProductId: 'prod_local_pending',
      candidateCategoryKey: 'snacks',
      anchorCategoryKeys: ['beverages'],
    });
    expect(adj).toBeGreaterThan(0);
  });
});
