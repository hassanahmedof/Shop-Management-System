import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffCatalogItem, StaffMember, StaffSale } from '../types/shop';

const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  autoIdSeq: 1,
  failNextStaffLookupWrite: false,
  createdAuthUsers: [] as Array<{ uid: string; email: string }>,
  deletedAuthUids: [] as string[],
  signOutCalls: 0,
  simulateRetryAlreadyExists: false,
}));

vi.mock('../lib/firebase', () => ({
  auth: {
    currentUser: {
      uid: 'owner_1',
      getIdToken: async () => 'owner-token',
    },
  },
  db: { __mockDb: true },
  getStaffProvisionAuth: () => ({ __provisionAuth: true }),
  OperationType: {
    CREATE: 'create',
    UPDATE: 'update',
    DELETE: 'delete',
    LIST: 'list',
    GET: 'get',
    WRITE: 'write',
  },
  handleFirestoreError: (err: unknown) => {
    throw err instanceof Error ? err : new Error(String(err));
  },
}));

vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: vi.fn(async (_auth: unknown, email: string) => {
    const user = { uid: `auth_uid_${state.createdAuthUsers.length + 1}`, email };
    state.createdAuthUsers.push(user);
    return { user };
  }),
  deleteUser: vi.fn(async (user: { uid: string }) => {
    state.deletedAuthUids.push(user.uid);
  }),
  signOut: vi.fn(async () => {
    state.signOutCalls += 1;
  }),
}));

vi.mock('./backgroundTaskQueue', () => ({
  enqueueSheetsBackgroundTask: vi.fn(),
}));

vi.mock('./discordNotificationService', () => ({
  notifyDiscordTransaction: vi.fn(),
}));

vi.mock('./upsellCooccurrenceService', () => ({
  enqueueSaleCooccurrenceUpdate: vi.fn(),
}));

vi.mock('firebase/firestore', () => {
  const collection = (_db: unknown, ...segments: string[]) => ({
    __type: 'collection',
    path: segments.join('/'),
  });

  const doc = (parentOrDb: unknown, ...segments: string[]) => {
    if (
      parentOrDb &&
      typeof parentOrDb === 'object' &&
      (parentOrDb as { __type?: string }).__type === 'collection' &&
      segments.length === 0
    ) {
      const id = `auto_${state.autoIdSeq++}`;
      const base = (parentOrDb as { path: string }).path;
      return { __type: 'doc', id, path: `${base}/${id}` };
    }
    const path = segments.join('/');
    const parts = path.split('/');
    return { __type: 'doc', id: parts[parts.length - 1], path };
  };

  const makeSnap = (docPath: string, data: Record<string, unknown> | undefined) => {
    const id = docPath.split('/').pop() || '';
    return {
      id,
      exists: () => Boolean(data),
      data: () => (data ? structuredClone(data) : undefined),
    };
  };

  const getDoc = async (ref: { path: string }) => makeSnap(ref.path, state.docs.get(ref.path));

  const runTransaction = async (
    _db: unknown,
    updateFn: (tx: {
      get: (ref: { path: string }) => Promise<ReturnType<typeof makeSnap>>;
      set: (ref: { path: string }, data: Record<string, unknown>) => void;
      update: (ref: { path: string }, patch: Record<string, unknown>) => void;
      delete: (ref: { path: string }) => void;
    }) => Promise<unknown>
  ) => {
    const staged = new Map(state.docs);
    const tx = {
      get: async (ref: { path: string }) => makeSnap(ref.path, staged.get(ref.path)),
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        // Simulate Firestore allow create failure when deterministic staffSale already exists
        if (
          state.simulateRetryAlreadyExists &&
          ref.path.includes('/staffSales/') &&
          staged.has(ref.path)
        ) {
          throw new Error('FirebaseError: Missing or insufficient permissions (permission-denied)');
        }
        staged.set(ref.path, structuredClone(data));
      },
      update: (ref: { path: string }, patch: Record<string, unknown>) => {
        const cur = staged.get(ref.path) || {};
        staged.set(ref.path, { ...cur, ...structuredClone(patch) });
      },
      delete: (ref: { path: string }) => {
        staged.delete(ref.path);
      },
    };
    const res = await updateFn(tx);
    state.docs = staged;
    return res;
  };

  const writeBatch = () => ({
    set: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    commit: async () => undefined,
  });

  return {
    collection,
    doc,
    where: vi.fn(),
    query: vi.fn((colRef) => colRef),
    getDoc,
    getDocs: async () => ({ empty: true, docs: [] }),
    setDoc: async (ref: { path: string }, data: Record<string, unknown>) => {
      state.docs.set(ref.path, structuredClone(data));
    },
    runTransaction,
    writeBatch,
    serverTimestamp: () => 'SERVER_TIMESTAMP',
  };
});

import { createAdminMember } from './adminService';
import {
  createAndEnqueueOfflineSale,
  getQueuedOfflineSales,
  syncQueuedOfflineSales,
} from './offlineSyncService';
import { createStaffMember, createStaffSale, toDeterministicStaffSaleId } from './staffService';

const SHOP_ID = 'shop_uid_123456';
const STAFF: StaffMember = {
  id: 'staff_1',
  ownerUid: SHOP_ID,
  shopId: SHOP_ID,
  shopCode: 'shop_u',
  name: 'Bilal',
  phone: '03001234567',
  username: 'bilal',
  usernameLower: 'bilal',
  authUid: 'staff_auth_1',
  loginVersion: 1,
  role: 'sales_staff',
  isActive: true,
  permissions: {
    canAddSales: true,
    canViewOwnSales: true,
    canViewStock: true,
  },
};

const CATALOG_ITEM: StaffCatalogItem = {
  id: 'prod_1',
  ownerUid: SHOP_ID,
  productId: 'prod_1',
  name: 'Soap Bar',
  categoryName: 'Bath',
  brandName: 'CleanCo',
  salePrice: 120,
  currentStock: 20,
  unit: 'Piece',
  baseUnit: 'Piece',
  packagingUnits: [],
  isActive: true,
  allowedStaffUids: ['staff_auth_1'],
};

describe('offlineSync and account provisioning safety regressions', () => {
  beforeEach(() => {
    state.docs.clear();
    state.autoIdSeq = 1;
    state.createdAuthUsers = [];
    state.deletedAuthUids = [];
    state.signOutCalls = 0;
    state.simulateRetryAlreadyExists = true;
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ authorized: true }),
      }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('commits staffSale idempotently using clientRequestId without double-deducting stock', async () => {
    state.docs.set(`shops/${SHOP_ID}/staffCatalog/prod_1`, structuredClone(CATALOG_ITEM) as unknown as Record<string, unknown>);

    const firstId = await createStaffSale(SHOP_ID, STAFF, {
      saleDate: '2026-01-05',
      paymentMethod: 'Cash',
      notes: 'offline test',
      clientRequestId: 'off_req_99',
      items: [{ productId: 'prod_1', quantity: 3, unitName: 'Piece', conversionFactor: 1 }],
    });

    expect(firstId).toBe(toDeterministicStaffSaleId('off_req_99'));
    expect((state.docs.get(`shops/${SHOP_ID}/staffCatalog/prod_1`) as { currentStock: number }).currentStock).toBe(17);

    // Simulate network drop and retry with identical clientRequestId -> idempotent return, stock stays 17!
    const retryId = await createStaffSale(SHOP_ID, STAFF, {
      saleDate: '2026-01-05',
      paymentMethod: 'Cash',
      notes: 'offline test',
      clientRequestId: 'off_req_99',
      items: [{ productId: 'prod_1', quantity: 3, unitName: 'Piece', conversionFactor: 1 }],
    });

    expect(retryId).toBe(firstId);
    expect((state.docs.get(`shops/${SHOP_ID}/staffCatalog/prod_1`) as { currentStock: number }).currentStock).toBe(17);
  });

  it('does not silently drop distinct queued offline sales even if a remote sale shares saleNumber', async () => {
    state.docs.set(`shops/${SHOP_ID}/staffCatalog/prod_1`, structuredClone(CATALOG_ITEM) as unknown as Record<string, unknown>);
    const catalogMap = new Map<string, StaffCatalogItem>([['prod_1', CATALOG_ITEM]]);

    const queued = createAndEnqueueOfflineSale(SHOP_ID, STAFF, catalogMap, {
      saleDate: '2026-01-05',
      paymentMethod: 'Cash',
      notes: 'distinct offline sale',
      items: [{ productId: 'prod_1', quantity: 2, unitName: 'Piece', conversionFactor: 1 }],
    });

    // Simulate a completely different remote sale doc that happens to have the same saleNumber
    const collidingRemoteSale: StaffSale = {
      id: 'unrelated_remote_doc_id',
      ownerUid: SHOP_ID,
      shopId: SHOP_ID,
      saleNumber: queued.saleNumber,
      saleDate: '2026-01-04',
      saleDateTime: '04/01/2026 10:00 AM',
      paymentMethod: 'Cash',
      totalAmount: 120,
      totalQuantity: 1,
      itemCount: 1,
      items: [],
      staffId: STAFF.id,
      staffAuthUid: STAFF.authUid,
      staffName: STAFF.name,
      staffUsername: STAFF.username,
      notes: '',
      status: 'completed',
      syncedToLedger: false,
    };

    const result = await syncQueuedOfflineSales(SHOP_ID, STAFF, [collidingRemoteSale]);
    expect(result.syncedCount).toBe(1);
    expect(getQueuedOfflineSales(SHOP_ID, STAFF.authUid)).toHaveLength(0);

    // Distinct deterministic doc was committed in Firestore and stock deducted from 20 -> 18
    const expectedDocId = toDeterministicStaffSaleId(queued.localId)!;
    expect(state.docs.has(`shops/${SHOP_ID}/staffSales/${expectedDocId}`)).toBe(true);
    expect((state.docs.get(`shops/${SHOP_ID}/staffCatalog/prod_1`) as { currentStock: number }).currentStock).toBe(18);
  });

  it('rolls back provisioned Firebase Auth user when createStaffMember fails atomic lookup reservation', async () => {
    // Another request claims adminLookup/u_bilal right after pre-check / inside transaction
    state.docs.set('adminLookup/u_bilal', {
      ownerUid: SHOP_ID,
      shopId: SHOP_ID,
      adminMemberId: 'adm_existing',
      isActive: true,
    });

    // Wait: pre-check also reads adminLookup, so to simulate a true mid-flight race we let pre-check pass
    // by inserting into staffLookup inside a race or testing pre-check vs race:
    // Clear first, then inject during authorizeApiRequest mock!
    state.docs.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        // Inject conflicting lookup doc after authorize succeeds? Pre-check runs after authorize.
        // Instead, inject inside getDoc? Wait: we can set it when createUserWithEmailAndPassword runs via fetch or auth!
        return { ok: true, json: async () => ({ authorized: true }) };
      })
    );

    const authMod = await import('firebase/auth');
    vi.mocked(authMod.createUserWithEmailAndPassword).mockImplementationOnce(async (_auth, email) => {
      const user = { uid: 'auth_race_staff_1', email };
      state.createdAuthUsers.push(user);
      // Race condition: conflicting username reserved between pre-check and transaction!
      state.docs.set('staffLookup/u_bilal', { ownerUid: SHOP_ID, isActive: true });
      return { user } as unknown as Awaited<ReturnType<typeof authMod.createUserWithEmailAndPassword>>;
    });

    await expect(
      createStaffMember(
        SHOP_ID,
        {
          name: 'Bilal',
          phone: '0300',
          username: 'bilal',
          password: 'password123',
          permissions: STAFF.permissions,
        },
        [],
        [],
        []
      )
    ).rejects.toThrow(/already registered/i);

    expect(state.deletedAuthUids).toContain('auth_race_staff_1');
    expect(state.signOutCalls).toBe(1);
  });

  it('rolls back provisioned Firebase Auth user when createAdminMember fails transaction commit', async () => {
    const authMod = await import('firebase/auth');
    vi.mocked(authMod.createUserWithEmailAndPassword).mockImplementationOnce(async (_auth, email) => {
      const user = { uid: 'auth_race_admin_1', email };
      state.createdAuthUsers.push(user);
      state.docs.set('adminLookup/u_newadmin', { ownerUid: SHOP_ID, isActive: true });
      return { user } as unknown as Awaited<ReturnType<typeof authMod.createUserWithEmailAndPassword>>;
    });

    await expect(
      createAdminMember(SHOP_ID, {
        name: 'Second Admin',
        phone: '0300',
        username: 'newadmin',
        password: 'password123',
      })
    ).rejects.toThrow(/already registered/i);

    expect(state.deletedAuthUids).toContain('auth_race_admin_1');
    expect(state.signOutCalls).toBe(1);
  });
});
