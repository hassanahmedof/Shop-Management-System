// @vitest-environment node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCaremartApp, type ServerDependencies } from '../server';
import { resetServerCooccurrenceStore } from './upsellCooccurrenceStore';
import { resetServerFeedbackStore } from './upsellFeedbackStore';

const OWNER_UID = 'owner_uid_test_1';
const ADMIN_UID = 'admin_uid_test_2';
const STAFF_UID = 'staff_uid_test_3';
const STAFF_ID = 'staff_doc_3';
const OTHER_SHOP_STAFF_UID = 'staff_other_shop_4';

async function startTestServer(overrides: Partial<ServerDependencies>) {
  const app = createCaremartApp(overrides);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe('server HTTP security & verification gates', () => {
  let tempDir = '';
  let activeServer: Awaited<ReturnType<typeof startTestServer>> | null = null;
  let docMap: Map<string, Record<string, unknown>>;
  let saleItemsMap: Map<string, Array<Record<string, unknown>>>;
  let suggestSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caremart-server-sec-'));
    docMap = new Map<string, Record<string, unknown>>([
      ['appState/ownerSetup', { ownerUid: OWNER_UID, initialized: true }],
      [
        `staffAuthMap/${STAFF_UID}`,
        { isActive: true, shopId: OWNER_UID, staffId: STAFF_ID },
      ],
      [
        `shops/${OWNER_UID}/staff/${STAFF_ID}`,
        {
          ownerUid: OWNER_UID,
          authUid: STAFF_UID,
          isActive: true,
          role: 'sales_staff',
          permissions: { canAddSales: true },
        },
      ],
      [
        `adminAuthMap/${ADMIN_UID}`,
        { isActive: true, shopId: OWNER_UID, adminMemberId: 'adm_1' },
      ],
      [
        `staffAuthMap/${OTHER_SHOP_STAFF_UID}`,
        { isActive: true, shopId: 'other_shop_xyz', staffId: 'staff_other' },
      ],
      [
        'shops/other_shop_xyz/staff/staff_other',
        {
          ownerUid: 'other_shop_xyz',
          authUid: OTHER_SHOP_STAFF_UID,
          isActive: true,
          role: 'sales_staff',
          permissions: { canAddSales: true },
        },
      ],
      ['staffLookup/u_activeuser', { isActive: true, shopId: OWNER_UID, loginVersion: 2 }],
      ['staffLookup/u_disableduser', { isActive: false, shopId: OWNER_UID, loginVersion: 1 }],
      ['adminLookup/u_activeadmin', { isActive: true, shopId: OWNER_UID, loginVersion: 1 }],
      ['adminLookup/u_disabledadmin', { isActive: false, shopId: OWNER_UID, loginVersion: 1 }],
      [`shops/${OWNER_UID}/products/prod_a`, { ownerUid: OWNER_UID, name: 'Shampoo A' }],
      [`shops/${OWNER_UID}/products/prod_b`, { ownerUid: OWNER_UID, name: 'Conditioner B' }],
      [`shops/${OWNER_UID}/staffCatalog/prod_a`, { ownerUid: OWNER_UID, name: 'Shampoo A' }],
      ['shops/other_shop_xyz/products/prod_foreign', { ownerUid: 'other_shop_xyz', name: 'Foreign' }],
    ]);
    saleItemsMap = new Map();
    suggestSpy = vi.fn().mockResolvedValue({
      available: true,
      cached: false,
      suggested: { candidateId: 'prod_b', romanUrduPrompt: 'Saath mein Conditioner bhi lein' },
    });
  });

  afterEach(async () => {
    if (activeServer) {
      await activeServer.close();
      activeServer = null;
    }
    resetServerCooccurrenceStore(OWNER_UID, tempDir);
    resetServerFeedbackStore(OWNER_UID, tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeDeps(): Partial<ServerDependencies> {
    return {
      cooccurrenceCacheDir: tempDir,
      feedbackCacheDir: tempDir,
      verifyFirebaseIdToken: async (token: string) => {
        if (token === 'owner-token') {
          return {
            uid: OWNER_UID,
            email: 'owner@example.com',
            emailVerified: true,
            provider: 'password',
            name: 'Owner',
          };
        }
        if (token === 'staff-token') {
          return {
            uid: STAFF_UID,
            email: 'ali.v1.owner_@staff.caremart.app',
            emailVerified: true,
            provider: 'password',
            name: 'Ali',
          };
        }
        if (token === 'other-staff-token') {
          return {
            uid: OTHER_SHOP_STAFF_UID,
            email: 'other.v1.other_@staff.caremart.app',
            emailVerified: true,
            provider: 'password',
            name: 'Other',
          };
        }
        throw new Error('Invalid token');
      },
      firestoreGetDoc: async (docPath: string) => docMap.get(docPath) ?? null,
      firestoreQuerySaleItemsBySaleId: async (shopId: string, saleId: string) =>
        saleItemsMap.get(`${shopId}:${saleId}`) ?? [],
      firestoreBatchGetDocs: async (docPaths: string[]) => {
        const out = new Map<string, Record<string, unknown>>();
        for (const p of docPaths) {
          const val = docMap.get(p);
          if (val) out.set(p, val);
        }
        return out;
      },
      suggestUpsellWithGemini: suggestSpy as unknown as ServerDependencies['suggestUpsellWithGemini'],
    };
  }

  it('sets baseline security headers, omits X-Powered-By and X-Frame-Options, and returns JSON 404 for unknown /api routes', async () => {
    activeServer = await startTestServer(makeDeps());
    const res = await fetch(`${activeServer.baseUrl}/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('API endpoint not found.');
  });

  it('enforces strict 64kb JSON limit on standard routes while allowing larger /api/admin/sheets/sync payloads', async () => {
    activeServer = await startTestServer(makeDeps());
    const oversized = JSON.stringify({ pad: 'a'.repeat(80 * 1024) });
    const blocked = await fetch(`${activeServer.baseUrl}/api/staff/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });
    expect(blocked.status).toBe(413);

    // /api/admin/sheets/sync allows up to 10mb JSON parsing (will reject unauthenticated with 401 rather than 413)
    const sheetsRes = await fetch(`${activeServer.baseUrl}/api/admin/sheets/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });
    expect(sheetsRes.status).toBe(401);
  });

  it('returns identical 404 responses for inactive and non-existent lookup usernames and rate-limits repeated probing', async () => {
    activeServer = await startTestServer(makeDeps());

    const inactiveRes = await fetch(`${activeServer.baseUrl}/api/staff/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'disableduser' }),
    });
    const missingRes = await fetch(`${activeServer.baseUrl}/api/staff/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ghostuser' }),
    });

    expect(inactiveRes.status).toBe(404);
    expect(missingRes.status).toBe(404);
    expect(await inactiveRes.json()).toEqual(await missingRes.json());

    const adminInactive = await fetch(`${activeServer.baseUrl}/api/admin/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'disabledadmin' }),
    });
    const adminMissing = await fetch(`${activeServer.baseUrl}/api/admin/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ghostadmin' }),
    });
    expect(adminInactive.status).toBe(404);
    expect(adminMissing.status).toBe(404);
    expect(await adminInactive.json()).toEqual(await adminMissing.json());

    // Per-target limiter allows 8 requests/min on same key; 9th should be 429
    let saw429 = false;
    for (let i = 0; i < 10; i++) {
      const probe = await fetch(`${activeServer.baseUrl}/api/staff/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'activeuser' }),
      });
      if (probe.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });

  it('verifies Firestore sale ownership and line items on /api/upsell/cooccurrence/update and /rebuild', async () => {
    docMap.set(`shops/${OWNER_UID}/sales/sale_ok`, {
      ownerUid: OWNER_UID,
      status: 'completed',
    });
    saleItemsMap.set(`${OWNER_UID}:sale_ok`, [
      { productId: 'prod_a', status: 'completed' },
      { productId: 'prod_b', status: 'completed' },
    ]);
    docMap.set(`shops/${OWNER_UID}/sales/sale_cancelled`, {
      ownerUid: OWNER_UID,
      status: 'cancelled',
    });
    docMap.set(`shops/${OWNER_UID}/staffSales/staff_sale_ok`, {
      ownerUid: OWNER_UID,
      staffAuthUid: STAFF_UID,
      staffId: STAFF_ID,
      status: 'completed',
      items: [{ productId: 'prod_a' }, { productId: 'prod_b' }],
    });

    activeServer = await startTestServer(makeDeps());

    // 1. Unauthenticated rejected
    const unauth = await fetch(`${activeServer.baseUrl}/api/upsell/cooccurrence/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saleId: 'sale_ok', status: 'completed', productIds: ['prod_a', 'prod_b'] }),
    });
    expect(unauth.status).toBe(401);

    // 2. Fabricated productId not in sale line items rejected (403)
    const tampered = await fetch(`${activeServer.baseUrl}/api/upsell/cooccurrence/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner-token',
      },
      body: JSON.stringify({ saleId: 'sale_ok', status: 'completed', productIds: ['prod_a', 'prod_fake'] }),
    });
    expect(tampered.status).toBe(403);

    // 3. Cancelled Firestore sale rejected (409) even if client claims completed
    const cancelledRes = await fetch(`${activeServer.baseUrl}/api/upsell/cooccurrence/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner-token',
      },
      body: JSON.stringify({
        saleId: 'sale_cancelled',
        status: 'completed',
        productIds: ['prod_a', 'prod_b'],
      }),
    });
    expect(cancelledRes.status).toBe(409);

    // 4. Cross-shop staff attempting to read/write another shop sale rejected (403)
    const crossShop = await fetch(`${activeServer.baseUrl}/api/upsell/cooccurrence/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer other-staff-token',
      },
      body: JSON.stringify({
        saleId: 'staff_sale_ok',
        status: 'completed',
        productIds: ['prod_a', 'prod_b'],
      }),
    });
    expect(crossShop.status).toBe(403);

    // 5. Verified owner sale accepted & ingested
    const okOwner = await fetch(`${activeServer.baseUrl}/api/upsell/cooccurrence/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner-token',
      },
      body: JSON.stringify({ saleId: 'sale_ok', status: 'completed', productIds: ['prod_a', 'prod_b'] }),
    });
    expect(okOwner.status).toBe(200);
    const okJson = (await okOwner.json()) as { ingestedCount: number; totalCompletedSales: number };
    expect(okJson.ingestedCount).toBe(1);
    expect(okJson.totalCompletedSales).toBe(1);

    // 6. Verified staff sale accepted & ingested
    const okStaff = await fetch(`${activeServer.baseUrl}/api/upsell/cooccurrence/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer staff-token',
      },
      body: JSON.stringify({
        saleId: 'staff_sale_ok',
        status: 'completed',
        productIds: ['prod_a', 'prod_b'],
      }),
    });
    expect(okStaff.status).toBe(200);
    const staffJson = (await okStaff.json()) as { totalCompletedSales: number };
    expect(staffJson.totalCompletedSales).toBe(2);

    // 7. Rebuild rejects staff (owner only) and rejects unverified sale IDs
    const staffRebuild = await fetch(`${activeServer.baseUrl}/api/upsell/cooccurrence/rebuild`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer staff-token',
      },
      body: JSON.stringify({
        version: 2,
        resetFirst: true,
        sales: [{ saleId: 'staff_sale_ok', status: 'completed', productIds: ['prod_a', 'prod_b'] }],
      }),
    });
    expect(staffRebuild.status).toBe(403);

    const fabricatedRebuild = await fetch(`${activeServer.baseUrl}/api/upsell/cooccurrence/rebuild`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner-token',
      },
      body: JSON.stringify({
        version: 2,
        resetFirst: true,
        sales: [{ saleId: 'nonexistent_sale', status: 'completed', productIds: ['prod_a', 'prod_b'] }],
      }),
    });
    expect(fabricatedRebuild.status).toBe(403);
  });

  it('verifies product ownership and eventId deduplication on /api/upsell/feedback', async () => {
    activeServer = await startTestServer(makeDeps());

    const foreignProductRes = await fetch(`${activeServer.baseUrl}/api/upsell/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner-token',
      },
      body: JSON.stringify({
        eventId: 'evt_test_foreign_001',
        productId: 'prod_foreign',
        eventType: 'accepted',
      }),
    });
    expect(foreignProductRes.status).toBe(403);

    const firstAccept = await fetch(`${activeServer.baseUrl}/api/upsell/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer staff-token',
      },
      body: JSON.stringify({
        eventId: 'evt_test_unique_001',
        productId: 'prod_a',
        eventType: 'accepted',
      }),
    });
    expect(firstAccept.status).toBe(200);
    const firstBody = (await firstAccept.json()) as { duplicate: boolean; revision: number };
    expect(firstBody.duplicate).toBe(false);
    expect(firstBody.revision).toBe(1);

    const replayAccept = await fetch(`${activeServer.baseUrl}/api/upsell/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer staff-token',
      },
      body: JSON.stringify({
        eventId: 'evt_test_unique_001',
        productId: 'prod_a',
        eventType: 'accepted',
      }),
    });
    expect(replayAccept.status).toBe(200);
    const replayBody = (await replayAccept.json()) as { duplicate: boolean; revision: number };
    expect(replayBody.duplicate).toBe(true);
    expect(replayBody.revision).toBe(1);
  });

  it('enforces per-user rate limiting on /api/upsell/suggest', async () => {
    activeServer = await startTestServer(makeDeps());
    const payload = JSON.stringify({
      cart: [{ id: 'prod_a', name: 'Shampoo A', categoryName: 'Hair', brandName: 'Brand', quantity: 1 }],
      candidates: [
        {
          id: 'prod_b',
          name: 'Conditioner B',
          categoryName: 'Hair',
          brandName: 'Brand',
          salePrice: 400,
          unitName: 'bottle',
          stockSummary: '10 in stock',
        },
      ],
    });

    let limitedStatus = 0;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${activeServer.baseUrl}/api/upsell/suggest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer owner-token',
        },
        body: payload,
      });
      if (r.status === 429) {
        limitedStatus = r.status;
        break;
      }
      expect(r.status).toBe(200);
    }
    expect(limitedStatus).toBe(429);
    expect(suggestSpy).toHaveBeenCalledTimes(15);
  });
});
