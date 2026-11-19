// Security rules verification matrix for the Dirty Dozen payloads against firestore.rules.
// Intended for Firebase Emulator / Rules Unit Testing verification.

export interface DirtyDozenCase {
  id: number;
  name: string;
  collectionPath: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  authUid: string | null;
  emailVerified: boolean;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const dirtyDozenCases: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Product Read',
    collectionPath: '/shops/u1/products/p1',
    operation: 'get',
    authUid: null,
    emailVerified: false,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified Email Write',
    collectionPath: '/shops/u1/products/p1',
    operation: 'create',
    authUid: 'u1',
    emailVerified: false,
    payload: { ownerUid: 'u1', name: 'Diapers Pack' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Cross-Tenant List Scraping',
    collectionPath: '/shops/u1/sales',
    operation: 'list',
    authUid: 'u2',
    emailVerified: true,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'OwnerUid Spoofing on Create',
    collectionPath: '/shops/u1/products/p1',
    operation: 'create',
    authUid: 'u1',
    emailVerified: true,
    payload: { ownerUid: 'u2', name: 'Baby Wipes' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow Field Injection',
    collectionPath: '/shops/u1/sales/s1',
    operation: 'create',
    authUid: 'u1',
    emailVerified: true,
    payload: { ownerUid: 'u1', paymentMethod: 'Cash', isDiscountApproved: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Self-Assigned Admin Role',
    collectionPath: '/users/u1',
    operation: 'create',
    authUid: 'u1',
    emailVerified: true,
    payload: { uid: 'u1', displayName: 'Owner', email: 'owner@shop.pk', role: 'admin' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Invalid Payment Method',
    collectionPath: '/shops/u1/sales/s2',
    operation: 'create',
    authUid: 'u1',
    emailVerified: true,
    payload: { ownerUid: 'u1', paymentMethod: 'Card' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Negative Purchase Price',
    collectionPath: '/shops/u1/products/p2',
    operation: 'create',
    authUid: 'u1',
    emailVerified: true,
    payload: { ownerUid: 'u1', purchasePrice: -10 },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Oversized String Resource Poisoning',
    collectionPath: '/shops/u1/products/p3',
    operation: 'create',
    authUid: 'u1',
    emailVerified: true,
    payload: { ownerUid: 'u1', name: 'A'.repeat(2000) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Invalid Document ID Path Poisoning',
    collectionPath: '/shops/u1/products/invalid$id#path',
    operation: 'create',
    authUid: 'u1',
    emailVerified: true,
    payload: { ownerUid: 'u1', name: 'Valid Name' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Cancelled Sale Terminal State Mutation',
    collectionPath: '/shops/u1/sales/s_cancelled',
    operation: 'update',
    authUid: 'u1',
    emailVerified: true,
    payload: { status: 'completed', notes: 'Reopened' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Audit Log Tampering',
    collectionPath: '/shops/u1/auditLogs/log1',
    operation: 'delete',
    authUid: 'u1',
    emailVerified: true,
    expected: 'PERMISSION_DENIED',
  },
];
