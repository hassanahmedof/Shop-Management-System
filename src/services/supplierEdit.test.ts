// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Purchase, Supplier } from '../types/shop';

const state = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  autoIdSeq: 1,
}));

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { uid: 'shop_1', getIdToken: async () => 'tok' } },
  db: { __mockDb: true },
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

vi.mock('./backgroundTaskQueue', () => ({
  enqueueSheetsBackgroundTask: vi.fn(),
}));

vi.mock('./discordNotificationService', () => ({
  notifyDiscordTransaction: vi.fn(),
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

  const where = (field: string, op: string, value: unknown) => ({
    __type: 'where',
    field,
    op,
    value,
  });

  const query = (
    colRef: { __type: string; path: string },
    ...constraints: Array<{ __type: string; field?: string; op?: string; value?: unknown }>
  ) => ({
    __type: 'query',
    path: colRef.path,
    constraints,
  });

  const makeSnap = (docPath: string, data: Record<string, unknown> | undefined) => {
    const id = docPath.split('/').pop() || '';
    return {
      id,
      ref: { __type: 'doc', id, path: docPath },
      exists: () => Boolean(data),
      data: () => (data ? structuredClone(data) : undefined),
    };
  };

  const getDoc = async (ref: { path: string }) => {
    return makeSnap(ref.path, state.docs.get(ref.path));
  };

  const getDocs = async (q: {
    __type: string;
    path: string;
    constraints?: Array<{ __type: string; field?: string; op?: string; value?: unknown }>;
  }) => {
    const prefix = `${q.path}/`;
    const matched: Array<ReturnType<typeof makeSnap>> = [];

    for (const [docPath, raw] of state.docs.entries()) {
      if (!docPath.startsWith(prefix)) continue;
      const remainder = docPath.slice(prefix.length);
      if (remainder.includes('/')) continue;

      let ok = true;
      for (const c of q.constraints || []) {
        if (c.__type === 'where' && c.field) {
          if (c.op === '==' && raw[c.field] !== c.value) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;

      matched.push(makeSnap(docPath, raw));
    }

    return {
      empty: matched.length === 0,
      docs: matched,
    };
  };

  const writeBatch = () => {
    const ops: Array<() => void> = [];
    return {
      set: (ref: { path: string }, data: Record<string, unknown>) => {
        ops.push(() => state.docs.set(ref.path, structuredClone(data)));
      },
      update: (ref: { path: string }, patch: Record<string, unknown>) => {
        ops.push(() => {
          const cur = state.docs.get(ref.path) || {};
          state.docs.set(ref.path, { ...cur, ...structuredClone(patch) });
        });
      },
      delete: (ref: { path: string }) => {
        ops.push(() => state.docs.delete(ref.path));
      },
      commit: async () => {
        for (const op of ops) op();
      },
    };
  };

  return {
    collection,
    doc,
    where,
    query,
    getDoc,
    getDocs,
    writeBatch,
    runTransaction: vi.fn(),
    deleteDoc: async (ref: { path: string }) => {
      state.docs.delete(ref.path);
    },
    setDoc: async (ref: { path: string }, data: Record<string, unknown>) => {
      state.docs.set(ref.path, structuredClone(data));
    },
    updateDoc: async (ref: { path: string }, patch: Record<string, unknown>) => {
      const cur = state.docs.get(ref.path);
      if (!cur) throw new Error(`Document ${ref.path} does not exist`);
      state.docs.set(ref.path, { ...cur, ...structuredClone(patch) });
    },
    deleteField: () => ({ __deleteField: true }),
    serverTimestamp: () => 'SERVER_TIMESTAMP',
  };
});

import { createSupplier, updateSupplier } from './shopService';

const UID = 'shop_1';

function seedSupplier(id: string, overrides: Partial<Supplier> = {}): Supplier {
  const sup: Supplier = {
    id,
    ownerUid: UID,
    name: 'Metro Distributors',
    phone: '0300-1112233',
    address: 'Shah Alam Market, Lahore',
    totalPurchased: 45000,
    totalPaid: 30000,
    outstandingBalance: 15000,
    notes: 'Weekly Tuesday delivery',
    ...overrides,
  };
  const { id: _id, ...docBody } = sup;
  state.docs.set(`shops/${UID}/suppliers/${id}`, {
    ...docBody,
    createdAt: 'CREATED_TS',
    updatedAt: 'OLD_TS',
  });
  return sup;
}

describe('Supplier Edit & Duplicate Guard (Firebase Service)', () => {
  beforeEach(() => {
    state.docs.clear();
    state.autoIdSeq = 1;
  });

  it('updates supplier details (name, phone, address, email, notes) while preserving ID, ledger totals, and purchase history', async () => {
    seedSupplier('sup_existing');
    seedSupplier('sup_other', {
      name: 'Alpha Wholesale',
      phone: '0321-9998887',
      address: 'Karachi',
      totalPurchased: 0,
      totalPaid: 0,
      outstandingBalance: 0,
      notes: '',
    });

    const purchaseRecord: Omit<Purchase, 'id'> = {
      ownerUid: UID,
      purchaseNumber: 'PO-2026-001',
      purchaseDate: '2026-11-10',
      supplierId: 'sup_existing',
      supplierName: 'Metro Distributors',
      paymentMethod: 'Cash',
      totalAmount: 45000,
      amountPaid: 30000,
      balanceDue: 15000,
      totalQuantity: 100,
      itemCount: 2,
      notes: 'Opening stock PO',
      status: 'completed',
    };
    state.docs.set(`shops/${UID}/purchases/po_1`, { ...purchaseRecord });

    state.docs.set(`shops/${UID}/products/prod_1`, {
      ownerUid: UID,
      name: 'LEO Baby Wipes 72s',
      supplierId: 'sup_existing',
      supplierName: 'Metro Distributors',
    });

    await updateSupplier(UID, 'sup_existing', {
      name: '  Metro   Cash & Carry  ',
      phone: '0300-7654321',
      address: 'Hall Road, Lahore',
      email: 'orders@metrocash.pk',
      notes: 'Net 15 terms',
    });

    // Exact same document ID updated (no duplicates created)
    const supplierKeys = Array.from(state.docs.keys()).filter((k) =>
      k.startsWith(`shops/${UID}/suppliers/`)
    );
    expect(supplierKeys).toEqual([
      `shops/${UID}/suppliers/sup_existing`,
      `shops/${UID}/suppliers/sup_other`,
    ]);

    const updated = state.docs.get(`shops/${UID}/suppliers/sup_existing`)!;
    expect(updated.name).toBe('Metro Cash & Carry');
    expect(updated.phone).toBe('0300-7654321');
    expect(updated.address).toBe('Hall Road, Lahore');
    expect(updated.email).toBe('orders@metrocash.pk');
    expect(updated.notes).toBe('Net 15 terms');

    // Financial ledger totals & createdAt preserved untouched
    expect(updated.totalPurchased).toBe(45000);
    expect(updated.totalPaid).toBe(30000);
    expect(updated.outstandingBalance).toBe(15000);
    expect(updated.createdAt).toBe('CREATED_TS');

    // Linked product's supplierName updated in Firebase; purchase history record preserved intact
    expect(state.docs.get(`shops/${UID}/products/prod_1`)?.supplierName).toBe('Metro Cash & Carry');
    const savedPo = state.docs.get(`shops/${UID}/purchases/po_1`)!;
    expect(savedPo.supplierId).toBe('sup_existing');
    expect(savedPo.totalAmount).toBe(45000);
    expect(savedPo.balanceDue).toBe(15000);
  });

  it('allows updating contact fields on the same supplier without renaming, and blocks duplicate supplier names', async () => {
    seedSupplier('sup_1', { name: 'National Traders' });
    seedSupplier('sup_2', { name: 'Shan Distributors' });

    // Editing same supplier keeping identical name (different case/spacing) must succeed
    await expect(
      updateSupplier(UID, 'sup_1', {
        name: 'National Traders',
        phone: '0333-1234567',
        address: 'Updated Plaza',
        email: 'sales@nationaltraders.pk',
        notes: 'Updated contact',
      })
    ).resolves.toBeUndefined();
    expect(state.docs.get(`shops/${UID}/suppliers/sup_1`)?.email).toBe('sales@nationaltraders.pk');

    // Renaming sup_1 to match sup_2 (ignoring case & extra spaces) must fail
    await expect(
      updateSupplier(UID, 'sup_1', {
        name: '  shan   distributors ',
        phone: '0333-1234567',
        address: 'Updated Plaza',
        email: '',
        notes: '',
      })
    ).rejects.toThrow(/already exists/i);

    // Creating a duplicate supplier must also fail
    await expect(
      createSupplier(UID, {
        name: 'national traders',
        phone: '',
        address: '',
        email: '',
        notes: '',
      })
    ).rejects.toThrow(/already exists/i);

    // Invalid email rejected cleanly before database write
    await expect(
      updateSupplier(UID, 'sup_1', {
        name: 'National Traders',
        phone: '',
        address: '',
        email: 'not-an-email',
        notes: '',
      })
    ).rejects.toThrow(/valid supplier email/i);
  });
});
