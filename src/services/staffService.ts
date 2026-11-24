import { createUserWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, getStaffProvisionAuth, handleFirestoreError, OperationType } from '../lib/firebase';
import type {
  InventoryBatch,
  PaymentMethod,
  Product,
  StaffCatalogItem,
  StaffLookup,
  StaffMember,
  StaffPermissions,
  StaffSale,
  StaffSaleLine,
} from '../types/shop';
import { formatDateTimeKarachi, normalizeCustomerWhatsapp, roundMoney } from '../utils/formatters';
import {
  allocateFifoFromBatches,
  getAllowedSaleUnits,
  getEffectiveBaseUnit,
  roundStockQty,
  toStaffPackagingUnits,
} from '../utils/packaging';
import { enqueueSheetsBackgroundTask } from './backgroundTaskQueue';
import { notifyDiscordTransaction } from './discordNotificationService';
import { enqueueSaleCooccurrenceUpdate } from './upsellCooccurrenceService';
import { recordPerfMetric, startPerfTimer } from '../utils/perfMonitor';

function clip(val: string | undefined | null, maxLen: number): string {
  return (val || '').trim().slice(0, maxLen);
}

async function getCurrentIdToken(): Promise<string> {
  const current = auth.currentUser;
  if (!current) {
    throw new Error('Authentication required. Please sign in again.');
  }
  return current.getIdToken();
}

async function authorizeApiRequest<T = Record<string, unknown>>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH',
  body?: unknown
): Promise<T> {
  const token = await getCurrentIdToken();
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || 'Access denied by server.');
  }
  return data;
}

export function getShopCode(shopId: string): string {
  return shopId.slice(0, 6).toLowerCase();
}

export function buildStaffLookupKey(shopCode: string, username: string): string {
  return `${shopCode.trim().toLowerCase()}_${username.trim().toLowerCase()}`;
}

export function buildUsernameLookupKey(username: string): string {
  return `u_${username.trim().toLowerCase()}`;
}

export function buildStaffSyntheticEmail(
  usernameLower: string,
  loginVersion: number,
  shopCode: string
): string {
  return `${usernameLower}.v${loginVersion}.${shopCode.toLowerCase()}@staff.caremart.app`;
}

export function validateStaffUsername(username: string): string | null {
  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 40) {
    return 'Username must be between 2 and 40 characters.';
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return 'Username may only contain letters, numbers, underscores (_), and hyphens (-).';
  }
  return null;
}

function generateStaffSaleNumber(): string {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `SL-${y}${m}${d}-${rand}`;
}

export function getCatalogAllowedUids(staffList: StaffMember[]): string[] {
  const uids: string[] = [];
  for (const s of staffList) {
    if (s.isActive && (s.permissions?.canViewStock || s.permissions?.canAddSales) && s.authUid) {
      if (!uids.includes(s.authUid)) {
        uids.push(s.authUid);
      }
    }
  }
  return uids.slice(0, 50);
}

export async function fetchActiveStaffUids(ownerUid: string): Promise<string[]> {
  try {
    const q = query(collection(db, 'shops', ownerUid, 'staff'), where('ownerUid', '==', ownerUid));
    const snap = await getDocs(q);
    const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StaffMember, 'id'>) }));
    return getCatalogAllowedUids(list);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `shops/${ownerUid}/staff`);
  }
}

export async function syncStaffCatalogDocuments(
  ownerUid: string,
  products: Product[],
  staffList: StaffMember[],
  existingCatalog: StaffCatalogItem[]
): Promise<void> {
  const allowedStaffUids = getCatalogAllowedUids(staffList);
  const allowedKey = [...allowedStaffUids].sort().join(',');
  const existingMap = new Map(existingCatalog.map((c) => [c.productId, c]));
  const productIds = new Set(products.map((p) => p.id));

  const ops: Array<(batch: ReturnType<typeof writeBatch>) => void> = [];

  for (const p of products) {
    const cur = existingMap.get(p.id);
    const curKey = cur ? [...(cur.allowedStaffUids || [])].sort().join(',') : '';
    const baseUnit = clip(getEffectiveBaseUnit(p), 40);
    const staffPkgs = toStaffPackagingUnits(p.packagingUnits, baseUnit);
    const curPkgsJson = JSON.stringify(cur?.packagingUnits || []);
    const nextPkgsJson = JSON.stringify(staffPkgs);
    const wholesalePrice = Math.max(0, roundMoney(p.wholesalePrice || 0));
    const originType = p.originType || '';
    const bottleSize = clip(p.bottleSize, 40);
    const storageLocation = clip(p.storageLocation, 80);
    const isReturnable = Boolean(p.isReturnable);
    const returnableUnitName = clip(p.returnableUnitName, 40);
    const depositPerReturnable = Math.max(0, roundMoney(p.depositPerReturnable || 0));

    const needsUpdate =
      !cur ||
      cur.name !== clip(p.name, 180) ||
      cur.categoryName !== clip(p.categoryName, 100) ||
      cur.brandName !== clip(p.brandName, 100) ||
      cur.salePrice !== Math.max(0, roundMoney(p.salePrice)) ||
      (cur.wholesalePrice ?? 0) !== wholesalePrice ||
      cur.currentStock !== Math.max(0, roundStockQty(p.currentStock)) ||
      cur.unit !== baseUnit ||
      (cur.baseUnit || cur.unit) !== baseUnit ||
      curPkgsJson !== nextPkgsJson ||
      (cur.originType || '') !== originType ||
      (cur.bottleSize || '') !== bottleSize ||
      (cur.storageLocation || '') !== storageLocation ||
      Boolean(cur.isReturnable) !== isReturnable ||
      (cur.returnableUnitName || '') !== returnableUnitName ||
      (cur.depositPerReturnable ?? 0) !== depositPerReturnable ||
      cur.isActive !== Boolean(p.isActive) ||
      curKey !== allowedKey;

    if (needsUpdate) {
      ops.push((batch) => {
        batch.set(doc(db, 'shops', ownerUid, 'staffCatalog', p.id), {
          ownerUid,
          productId: p.id,
          name: clip(p.name, 180),
          categoryName: clip(p.categoryName, 100),
          brandName: clip(p.brandName, 100),
          salePrice: Math.max(0, roundMoney(p.salePrice)),
          wholesalePrice,
          currentStock: Math.max(0, roundStockQty(p.currentStock)),
          unit: baseUnit,
          baseUnit,
          packagingUnits: staffPkgs,
          originType,
          bottleSize,
          storageLocation,
          isReturnable,
          returnableUnitName,
          depositPerReturnable,
          isActive: Boolean(p.isActive),
          allowedStaffUids,
          updatedAt: serverTimestamp(),
        });
      });
    }
  }

  for (const c of existingCatalog) {
    if (!productIds.has(c.productId)) {
      ops.push((batch) => {
        batch.delete(doc(db, 'shops', ownerUid, 'staffCatalog', c.id));
      });
    }
  }

  if (ops.length === 0) return;

  for (let i = 0; i < ops.length; i += 400) {
    const chunk = ops.slice(i, i + 400);
    const batch = writeBatch(db);
    chunk.forEach((fn) => fn(batch));
    await batch.commit();
  }
}

function mapProvisionAuthError(err: unknown): Error {
  const code =
    typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (code === 'auth/operation-not-allowed') {
    return new Error(
      'Email/Password sign-in is disabled in Firebase Authentication Console (Authentication -> Sign-in method -> Email/Password).'
    );
  }
  if (code === 'auth/weak-password') {
    return new Error('Password must be at least 6 characters.');
  }
  if (code === 'auth/email-already-in-use') {
    return new Error('This staff credential version already exists. Please try another username.');
  }
  return err instanceof Error ? err : new Error('Failed to create staff credentials.');
}

export async function createStaffMember(
  ownerUid: string,
  input: {
    name: string;
    phone: string;
    username: string;
    password: string;
    permissions: StaffPermissions;
  },
  products: Product[],
  existingStaff: StaffMember[],
  existingCatalog: StaffCatalogItem[]
): Promise<string> {
  const name = clip(input.name, 120);
  const phone = clip(input.phone, 40);
  const username = clip(input.username, 40);
  const usernameLower = username.toLowerCase();

  if (!name) throw new Error('Staff full name is required.');
  const userErr = validateStaffUsername(username);
  if (userErr) throw new Error(userErr);
  if (!input.password || input.password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  await authorizeApiRequest('/api/admin/staff/authorize', 'POST', { name, username });

  const shopCode = getShopCode(ownerUid);
  const lookupKey = buildStaffLookupKey(shopCode, usernameLower);
  const usernameLookupKey = buildUsernameLookupKey(usernameLower);

  const [existingLookup, existingUserLookup, existingAdminLookup, existingAdminUserLookup] =
    await Promise.all([
      getDoc(doc(db, 'staffLookup', lookupKey)),
      getDoc(doc(db, 'staffLookup', usernameLookupKey)),
      getDoc(doc(db, 'adminLookup', lookupKey)),
      getDoc(doc(db, 'adminLookup', usernameLookupKey)),
    ]);
  if (
    existingLookup.exists() ||
    existingUserLookup.exists() ||
    existingAdminLookup.exists() ||
    existingAdminUserLookup.exists()
  ) {
    throw new Error(`Username "${username}" is already registered. Choose a different username.`);
  }

  const syntheticEmail = buildStaffSyntheticEmail(usernameLower, 1, shopCode);
  const provisionAuth = getStaffProvisionAuth();
  let staffAuthUid = '';

  try {
    const cred = await createUserWithEmailAndPassword(provisionAuth, syntheticEmail, input.password);
    staffAuthUid = cred.user.uid;
    await signOut(provisionAuth);
  } catch (err) {
    throw mapProvisionAuthError(err);
  }

  const staffRef = doc(collection(db, 'shops', ownerUid, 'staff'));

  try {
    const batch = writeBatch(db);
    const newStaffRecord: Omit<StaffMember, 'id'> = {
      ownerUid,
      shopId: ownerUid,
      shopCode,
      name,
      phone,
      username,
      usernameLower,
      authUid: staffAuthUid,
      loginVersion: 1,
      role: 'sales_staff',
      isActive: true,
      permissions: input.permissions,
    };

    batch.set(staffRef, {
      ...newStaffRecord,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const lookupDocPayload = {
      ownerUid,
      shopId: ownerUid,
      staffId: staffRef.id,
      loginVersion: 1,
      isActive: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    batch.set(doc(db, 'staffLookup', lookupKey), lookupDocPayload);
    batch.set(doc(db, 'staffLookup', usernameLookupKey), lookupDocPayload);

    batch.set(doc(db, 'staffAuthMap', staffAuthUid), {
      ownerUid,
      shopId: ownerUid,
      staffId: staffRef.id,
      isActive: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(collection(db, 'shops', ownerUid, 'auditLogs')), {
      ownerUid,
      action: 'CREATE_STAFF',
      entityType: 'staff',
      entityId: staffRef.id,
      summary: clip(`Added sales staff "${name}" (@${username})`, 400),
      createdAt: serverTimestamp(),
    });

    await batch.commit();

    const updatedStaffList: StaffMember[] = [...existingStaff, { id: staffRef.id, ...newStaffRecord }];
    await syncStaffCatalogDocuments(ownerUid, products, updatedStaffList, existingCatalog);

    return staffRef.id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `shops/${ownerUid}/staff/${staffRef.id}`);
  }
}

export async function updateStaffMember(
  ownerUid: string,
  staff: StaffMember,
  updates: {
    name: string;
    phone: string;
    isActive: boolean;
    permissions: StaffPermissions;
  },
  products: Product[],
  allStaff: StaffMember[],
  existingCatalog: StaffCatalogItem[]
): Promise<void> {
  const name = clip(updates.name, 120);
  if (!name) throw new Error('Staff full name is required.');
  const phone = clip(updates.phone, 40);
  const lookupKey = buildStaffLookupKey(staff.shopCode, staff.usernameLower);
  const usernameLookupKey = buildUsernameLookupKey(staff.usernameLower);

  await authorizeApiRequest(`/api/admin/staff/${encodeURIComponent(staff.id)}/authorize`, 'PATCH');

  try {
    const [lookupSnap, usernameLookupSnap] = await Promise.all([
      getDoc(doc(db, 'staffLookup', lookupKey)),
      getDoc(doc(db, 'staffLookup', usernameLookupKey)),
    ]);

    const batch = writeBatch(db);
    batch.update(doc(db, 'shops', ownerUid, 'staff', staff.id), {
      name,
      phone,
      isActive: updates.isActive,
      permissions: updates.permissions,
      updatedAt: serverTimestamp(),
    });

    if (lookupSnap.exists()) {
      batch.update(doc(db, 'staffLookup', lookupKey), {
        isActive: updates.isActive,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(db, 'staffLookup', lookupKey), {
        ownerUid,
        shopId: ownerUid,
        staffId: staff.id,
        loginVersion: staff.loginVersion || 1,
        isActive: updates.isActive,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    if (usernameLookupSnap.exists()) {
      batch.update(doc(db, 'staffLookup', usernameLookupKey), {
        isActive: updates.isActive,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(db, 'staffLookup', usernameLookupKey), {
        ownerUid,
        shopId: ownerUid,
        staffId: staff.id,
        loginVersion: staff.loginVersion || 1,
        isActive: updates.isActive,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    if (staff.authUid) {
      batch.update(doc(db, 'staffAuthMap', staff.authUid), {
        isActive: updates.isActive,
        updatedAt: serverTimestamp(),
      });
    }

    batch.set(doc(collection(db, 'shops', ownerUid, 'auditLogs')), {
      ownerUid,
      action: 'UPDATE_STAFF',
      entityType: 'staff',
      entityId: staff.id,
      summary: clip(
        `Updated staff "${name}" (@${staff.username}) · Active: ${updates.isActive ? 'Yes' : 'No'}`,
        400
      ),
      createdAt: serverTimestamp(),
    });

    await batch.commit();

    const nextStaffList = allStaff.map((s) =>
      s.id === staff.id
        ? {
            ...s,
            name,
            phone,
            isActive: updates.isActive,
            permissions: updates.permissions,
          }
        : s
    );
    await syncStaffCatalogDocuments(ownerUid, products, nextStaffList, existingCatalog);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${ownerUid}/staff/${staff.id}`);
  }
}

export async function resetStaffPassword(
  ownerUid: string,
  staff: StaffMember,
  newPassword: string,
  products: Product[],
  allStaff: StaffMember[],
  existingCatalog: StaffCatalogItem[]
): Promise<void> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }

  await authorizeApiRequest(
    `/api/admin/staff/${encodeURIComponent(staff.id)}/reset-password/authorize`,
    'POST'
  );

  const nextVersion = (staff.loginVersion || 1) + 1;
  const syntheticEmail = buildStaffSyntheticEmail(staff.usernameLower, nextVersion, staff.shopCode);
  const provisionAuth = getStaffProvisionAuth();
  let newAuthUid = '';

  try {
    const cred = await createUserWithEmailAndPassword(provisionAuth, syntheticEmail, newPassword);
    newAuthUid = cred.user.uid;
    await signOut(provisionAuth);
  } catch (err) {
    throw mapProvisionAuthError(err);
  }

  const lookupKey = buildStaffLookupKey(staff.shopCode, staff.usernameLower);
  const usernameLookupKey = buildUsernameLookupKey(staff.usernameLower);

  try {
    const [lookupSnap, usernameLookupSnap] = await Promise.all([
      getDoc(doc(db, 'staffLookup', lookupKey)),
      getDoc(doc(db, 'staffLookup', usernameLookupKey)),
    ]);

    const batch = writeBatch(db);
    batch.update(doc(db, 'shops', ownerUid, 'staff', staff.id), {
      authUid: newAuthUid,
      loginVersion: nextVersion,
      updatedAt: serverTimestamp(),
    });

    if (lookupSnap.exists()) {
      batch.update(doc(db, 'staffLookup', lookupKey), {
        loginVersion: nextVersion,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(db, 'staffLookup', lookupKey), {
        ownerUid,
        shopId: ownerUid,
        staffId: staff.id,
        loginVersion: nextVersion,
        isActive: staff.isActive,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    if (usernameLookupSnap.exists()) {
      batch.update(doc(db, 'staffLookup', usernameLookupKey), {
        loginVersion: nextVersion,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(db, 'staffLookup', usernameLookupKey), {
        ownerUid,
        shopId: ownerUid,
        staffId: staff.id,
        loginVersion: nextVersion,
        isActive: staff.isActive,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    batch.set(doc(db, 'staffAuthMap', newAuthUid), {
      ownerUid,
      shopId: ownerUid,
      staffId: staff.id,
      isActive: staff.isActive,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (staff.authUid && staff.authUid !== newAuthUid) {
      batch.delete(doc(db, 'staffAuthMap', staff.authUid));
    }

    batch.set(doc(collection(db, 'shops', ownerUid, 'auditLogs')), {
      ownerUid,
      action: 'RESET_STAFF_PASSWORD',
      entityType: 'staff',
      entityId: staff.id,
      summary: clip(`Reset password for "${staff.name}" (@${staff.username})`, 400),
      createdAt: serverTimestamp(),
    });

    await batch.commit();

    const nextStaffList = allStaff.map((s) =>
      s.id === staff.id ? { ...s, authUid: newAuthUid, loginVersion: nextVersion } : s
    );
    await syncStaffCatalogDocuments(ownerUid, products, nextStaffList, existingCatalog);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${ownerUid}/staff/${staff.id}`);
  }
}

export async function ensureUsernameStaffLookupIndexes(
  ownerUid: string,
  staffList: StaffMember[]
): Promise<void> {
  for (const s of staffList) {
    if (!s.usernameLower) continue;
    const key = buildUsernameLookupKey(s.usernameLower);
    const ref = doc(db, 'staffLookup', key);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ownerUid,
        shopId: ownerUid,
        staffId: s.id,
        loginVersion: s.loginVersion || 1,
        isActive: Boolean(s.isActive),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  }
}

export async function lookupStaffLogin(
  username: string,
  shopCode?: string
): Promise<{ lookup: StaffLookup; syntheticEmail: string }> {
  const uname = username.trim().toLowerCase();
  const code = (shopCode || '').trim().toLowerCase();
  if (!uname) {
    throw new Error('Enter your username and password.');
  }

  const res = await fetch('/api/staff/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: uname,
      shopCode: code || undefined,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    shopId?: string;
    loginVersion?: number;
    isActive?: boolean;
    syntheticEmail?: string;
    error?: string;
  };
  if (!res.ok || !data.syntheticEmail || !data.shopId) {
    throw new Error(data.error || 'Invalid username or password. Contact your shop owner if needed.');
  }

  return {
    lookup: {
      ownerUid: data.shopId,
      shopId: data.shopId,
      staffId: '',
      loginVersion: Number(data.loginVersion || 1),
      isActive: Boolean(data.isActive),
    },
    syntheticEmail: data.syntheticEmail,
  };
}

export async function createStaffSale(
  shopId: string,
  staff: StaffMember,
  input: {
    saleDate: string;
    paymentMethod: PaymentMethod;
    customerWhatsapp?: string;
    notes: string;
    items: Array<{
      productId: string;
      quantity: number;
      unitName?: string;
      conversionFactor?: number;
    }>;
    saleNumber?: string;
    saleDateTime?: string;
    clientRequestId?: string;
  }
): Promise<string> {
  if (!staff.isActive || !staff.permissions.canAddSales) {
    throw new Error('You do not have permission to record sales.');
  }
  if (!input.items.length) {
    throw new Error('Add at least one product to record a sale.');
  }

  const merged = new Map<
    string,
    {
      productId: string;
      unitName: string;
      conversionFactor: number;
      unitQuantity: number;
    }
  >();

  for (const row of input.items) {
    if (!row.productId) throw new Error('Select a product for every row.');
    const qty = roundStockQty(Number(row.quantity) || 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error('Quantity must be greater than zero.');
    }
    const unitKey = (row.unitName || '').trim();
    const conv = roundStockQty(Number(row.conversionFactor) || 1) || 1;
    const key = `${row.productId}::${unitKey}`;
    const prev = merged.get(key);
    if (prev) {
      prev.unitQuantity = roundStockQty(prev.unitQuantity + qty);
    } else {
      merged.set(key, {
        productId: row.productId,
        unitName: unitKey,
        conversionFactor: conv,
        unitQuantity: qty,
      });
    }
  }

  const distinctProductIds = Array.from(new Set(Array.from(merged.values()).map((m) => m.productId)));
  const saleRef = doc(collection(db, 'shops', shopId, 'staffSales'));
  const saleNumber = input.saleNumber?.trim() || generateStaffSaleNumber();
  const saleDateTime = input.saleDateTime?.trim() || formatDateTimeKarachi(new Date());

  const stopTx = startPerfTimer();

  try {
    let discordPayload: Parameters<typeof notifyDiscordTransaction>[1] | null = null;

    await runTransaction(db, async (tx) => {
      const catalogSnaps = await Promise.all(
        distinctProductIds.map((productId) => tx.get(doc(db, 'shops', shopId, 'staffCatalog', productId)))
      );
      const catalogMap = new Map<string, StaffCatalogItem>();
      for (let i = 0; i < distinctProductIds.length; i += 1) {
        const productId = distinctProductIds[i];
        const cSnap = catalogSnaps[i];
        if (!cSnap.exists()) {
          throw new Error('Selected product is not available in the catalog.');
        }
        catalogMap.set(productId, { id: cSnap.id, ...(cSnap.data() as Omit<StaffCatalogItem, 'id'>) });
      }

      const resolvedEntries: Array<{
        item: StaffCatalogItem;
        unitName: string;
        unitQuantity: number;
        conversionFactor: number;
        baseQuantity: number;
        salePricePerUnit: number;
      }> = [];

      const totalBaseByProduct = new Map<string, number>();

      for (const row of merged.values()) {
        const catalogItem = catalogMap.get(row.productId)!;
        const allowedUnits = getAllowedSaleUnits(catalogItem);
        const matchedUnit =
          (row.unitName
            ? allowedUnits.find((u) => u.unitName.toLowerCase() === row.unitName.toLowerCase())
            : undefined) || allowedUnits[0];

        if (!matchedUnit) {
          throw new Error(`Invalid unit selected for "${catalogItem.name}".`);
        }

        const conv = roundStockQty(matchedUnit.conversionQty || row.conversionFactor || 1);
        const baseQty = roundStockQty(row.unitQuantity * conv);
        totalBaseByProduct.set(
          catalogItem.productId,
          roundStockQty((totalBaseByProduct.get(catalogItem.productId) || 0) + baseQty)
        );

        resolvedEntries.push({
          item: catalogItem,
          unitName: matchedUnit.unitName,
          unitQuantity: row.unitQuantity,
          conversionFactor: conv,
          baseQuantity: baseQty,
          salePricePerUnit: roundMoney(matchedUnit.salePrice),
        });
      }

      for (const [pid, neededBase] of totalBaseByProduct.entries()) {
        const catalogItem = catalogMap.get(pid)!;
        const baseUnit = getEffectiveBaseUnit(catalogItem);
        if (catalogItem.currentStock < neededBase) {
          throw new Error(
            `Insufficient stock for "${catalogItem.name}". Available: ${catalogItem.currentStock} ${baseUnit}, Requested: ${neededBase} ${baseUnit}.`
          );
        }
      }

      let totalAmount = 0;
      let totalQuantity = 0;
      const lines: StaffSaleLine[] = [];
      const discordItems: Array<{
        productName: string;
        quantity: number;
        unitPrice: number;
        lineTotal: number;
        unit: string;
      }> = [];

      for (const entry of resolvedEntries) {
        const baseUnit = getEffectiveBaseUnit(entry.item);
        const lineTotal = roundMoney(entry.unitQuantity * entry.salePricePerUnit);
        totalAmount = roundMoney(totalAmount + lineTotal);
        totalQuantity = roundStockQty(totalQuantity + entry.baseQuantity);

        lines.push({
          productId: entry.item.productId,
          productName: clip(entry.item.name, 180),
          quantity: entry.unitQuantity,
          unitName: clip(entry.unitName, 40),
          unitQuantity: entry.unitQuantity,
          conversionFactor: entry.conversionFactor,
          baseQuantity: entry.baseQuantity,
          salePricePerUnit: entry.salePricePerUnit,
          lineTotal,
        });

        discordItems.push({
          productName: clip(entry.item.name, 180),
          quantity: entry.unitQuantity,
          unitPrice: entry.salePricePerUnit,
          lineTotal,
          unit:
            entry.conversionFactor > 1
              ? clip(`${entry.unitName} (${entry.conversionFactor} ${baseUnit})`, 40)
              : clip(entry.unitName, 40),
        });
      }

      for (const [pid, consumedBase] of totalBaseByProduct.entries()) {
        const catalogItem = catalogMap.get(pid)!;
        tx.update(doc(db, 'shops', shopId, 'staffCatalog', pid), {
          currentStock: roundStockQty(Math.max(0, catalogItem.currentStock - consumedBase)),
          updatedAt: serverTimestamp(),
        });
      }

      const cleanWhatsapp = normalizeCustomerWhatsapp(input.customerWhatsapp);

      tx.set(saleRef, {
        ownerUid: shopId,
        shopId,
        saleNumber,
        saleDate: input.saleDate,
        saleDateTime,
        paymentMethod: input.paymentMethod,
        totalAmount,
        totalQuantity,
        itemCount: lines.length,
        items: lines,
        staffId: staff.id,
        staffAuthUid: staff.authUid,
        staffName: clip(staff.name, 120),
        staffUsername: clip(staff.username, 40),
        ...(cleanWhatsapp ? { customerWhatsapp: clip(cleanWhatsapp, 32) } : {}),
        notes: clip(input.notes, 500),
        status: 'completed',
        syncedToLedger: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      discordPayload = {
        type: 'sale',
        dedupeId: saleRef.id,
        saleId: saleNumber,
        saleDate: input.saleDate,
        saleDateTime,
        staffName: clip(staff.name, 120),
        paymentMethod: input.paymentMethod,
        items: discordItems,
        totalAmount,
        notes: clip(input.notes, 500),
      };
    });

    if (discordPayload) {
      void notifyDiscordTransaction(shopId, discordPayload);
    }

    recordPerfMetric('firebase_tx', 'create_staff_sale', stopTx(), {
      items: merged.size,
    });

    enqueueSaleCooccurrenceUpdate(
      shopId,
      saleRef.id,
      distinctProductIds,
      () => (auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null))
    );

    return saleRef.id;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('Insufficient stock') ||
        err.message.includes('Selected product') ||
        err.message.includes('Invalid unit') ||
        err.message.includes('permission'))
    ) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `shops/${shopId}/staffSales/${saleRef.id}`);
  }
}

export async function reconcileStaffSaleToOwnerLedger(
  ownerUid: string,
  staffSale: StaffSale
): Promise<void> {
  if (staffSale.syncedToLedger) return;

  const involvedProductIds = new Set(staffSale.items.map((i) => i.productId));
  let candidateBatchIds: string[] = [];
  try {
    const batchSnap = await getDocs(
      query(collection(db, 'shops', ownerUid, 'inventoryBatches'), where('ownerUid', '==', ownerUid))
    );
    candidateBatchIds = batchSnap.docs
      .filter((d) => {
        const data = d.data() as InventoryBatch;
        return (
          involvedProductIds.has(data.productId) &&
          data.status === 'active' &&
          Number(data.remainingBaseQty) > 0
        );
      })
      .map((d) => d.id);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `shops/${ownerUid}/inventoryBatches`);
  }

  let reconciledDiscordPayload: Parameters<typeof notifyDiscordTransaction>[1] | null = null;

  try {
    await runTransaction(db, async (tx) => {
      const ssRef = doc(db, 'shops', ownerUid, 'staffSales', staffSale.id);
      const saleRef = doc(db, 'shops', ownerUid, 'sales', staffSale.id);
      const uniqueProdIds = Array.from(involvedProductIds);

      const [ssSnap, saleSnap, prodSnaps, batchSnaps] = await Promise.all([
        tx.get(ssRef),
        tx.get(saleRef),
        Promise.all(uniqueProdIds.map((pid) => tx.get(doc(db, 'shops', ownerUid, 'products', pid)))),
        Promise.all(candidateBatchIds.map((bId) => tx.get(doc(db, 'shops', ownerUid, 'inventoryBatches', bId)))),
      ]);

      if (!ssSnap.exists()) return;
      const currentSS = ssSnap.data() as StaffSale;
      if (currentSS.syncedToLedger) return;

      if (saleSnap.exists()) {
        tx.update(ssRef, { syncedToLedger: true, updatedAt: serverTimestamp() });
        return;
      }

      const prodMap = new Map<string, Product>();
      for (let i = 0; i < uniqueProdIds.length; i += 1) {
        const pSnap = prodSnaps[i];
        if (pSnap.exists()) {
          prodMap.set(uniqueProdIds[i], { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) });
        }
      }

      const batchesByProduct = new Map<string, InventoryBatch[]>();
      for (const bSnap of batchSnaps) {
        if (!bSnap.exists()) continue;
        const bData = { id: bSnap.id, ...(bSnap.data() as Omit<InventoryBatch, 'id'>) };
        if (bData.status === 'active' && roundStockQty(bData.remainingBaseQty) > 0) {
          const arr = batchesByProduct.get(bData.productId) || [];
          arr.push(bData);
          batchesByProduct.set(bData.productId, arr);
        }
      }

      const runningStock = new Map<string, number>();
      for (const [pid, prod] of prodMap.entries()) {
        runningStock.set(pid, roundStockQty(prod.currentStock));
      }

      const batchMutations = new Map<
        string,
        { remainingBaseQty: number; status: 'active' | 'exhausted' }
      >();

      let totalAmount = 0;
      let totalCost = 0;
      let totalQuantity = 0;

      for (const line of currentSS.items) {
        const prod = prodMap.get(line.productId);
        const baseUnit = prod ? getEffectiveBaseUnit(prod) : line.unitName || 'Piece';
        const unitName = clip(line.unitName || baseUnit, 40);
        const unitQty = roundStockQty(line.unitQuantity ?? line.quantity);
        const conv = roundStockQty(line.conversionFactor ?? 1) || 1;
        const baseQty = roundStockQty(line.baseQuantity ?? unitQty * conv);

        const productBatches = batchesByProduct.get(line.productId) || [];
        const fifo = allocateFifoFromBatches(
          productBatches,
          baseQty,
          prod?.purchasePrice ?? 0
        );
        for (const mut of fifo.updatedBatches) {
          batchMutations.set(mut.batchId, {
            remainingBaseQty: mut.nextRemainingBaseQty,
            status: mut.nextStatus,
          });
        }

        const lineTotal = roundMoney(unitQty * line.salePricePerUnit);
        const lineCost = fifo.totalCost;
        const lineProfit = roundMoney(lineTotal - lineCost);

        totalAmount = roundMoney(totalAmount + lineTotal);
        totalCost = roundMoney(totalCost + lineCost);
        totalQuantity = roundStockQty(totalQuantity + baseQty);

        if (prod) {
          const prevStock = runningStock.get(line.productId) ?? prod.currentStock;
          const nextStock = roundStockQty(Math.max(0, prevStock - baseQty));
          runningStock.set(line.productId, nextStock);

          tx.set(doc(collection(db, 'shops', ownerUid, 'stockMovements')), {
            ownerUid,
            productId: line.productId,
            productName: clip(line.productName, 180),
            movementDate: currentSS.saleDate,
            movementType: 'sale',
            quantityChange: -baseQty,
            previousStock: prevStock,
            newStock: nextStock,
            unitName,
            unitQuantity: unitQty,
            conversionFactor: conv,
            baseQuantity: baseQty,
            referenceId: staffSale.id,
            notes: clip(
              `Staff sale ${currentSS.saleNumber} (${unitQty} ${unitName}) by ${currentSS.staffName}`,
              500
            ),
            createdAt: serverTimestamp(),
          });
        }

        tx.set(doc(collection(db, 'shops', ownerUid, 'saleItems')), {
          ownerUid,
          saleId: staffSale.id,
          saleDate: currentSS.saleDate,
          productId: line.productId,
          productName: clip(line.productName, 180),
          categoryId: clip(prod?.categoryId || '', 128),
          categoryName: clip(prod?.categoryName || 'Uncategorized', 100),
          brandId: clip(prod?.brandId || '', 128),
          brandName: clip(prod?.brandName || '', 100),
          quantity: unitQty,
          unitName,
          unitQuantity: unitQty,
          conversionFactor: conv,
          baseQuantity: baseQty,
          salePricePerUnit: line.salePricePerUnit,
          purchasePriceAtSale: fifo.weightedBaseUnitCost,
          lineTotal,
          lineCost,
          lineProfit,
          batchAllocations: fifo.allocations.slice(0, 50),
          staffId: currentSS.staffId,
          staffName: clip(currentSS.staffName, 120),
          status: currentSS.status,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      for (const [pid, nextStock] of runningStock.entries()) {
        tx.update(doc(db, 'shops', ownerUid, 'products', pid), {
          currentStock: nextStock,
          updatedAt: serverTimestamp(),
        });
      }

      for (const [batchId, mut] of batchMutations.entries()) {
        tx.update(doc(db, 'shops', ownerUid, 'inventoryBatches', batchId), {
          remainingBaseQty: mut.remainingBaseQty,
          status: mut.status,
          updatedAt: serverTimestamp(),
        });
      }

      const totalProfit = roundMoney(totalAmount - totalCost);
      const cleanWhatsapp = normalizeCustomerWhatsapp(currentSS.customerWhatsapp);

      tx.set(saleRef, {
        ownerUid,
        saleNumber: currentSS.saleNumber,
        saleDate: currentSS.saleDate,
        saleDateTime: currentSS.saleDateTime,
        paymentMethod: currentSS.paymentMethod,
        totalAmount,
        totalCost,
        totalProfit,
        totalQuantity,
        itemCount: currentSS.items.length,
        staffId: currentSS.staffId,
        staffName: clip(currentSS.staffName, 120),
        recordedByRole: 'staff',
        ...(cleanWhatsapp ? { customerWhatsapp: clip(cleanWhatsapp, 32) } : {}),
        notes: clip(currentSS.notes, 500),
        status: currentSS.status,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.update(ssRef, {
        syncedToLedger: true,
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(collection(db, 'shops', ownerUid, 'auditLogs')), {
        ownerUid,
        action: 'SYNC_STAFF_SALE',
        entityType: 'sale',
        entityId: staffSale.id,
        summary: clip(
          `Synced staff sale ${currentSS.saleNumber} by ${currentSS.staffName} (PKR ${totalAmount} · Profit PKR ${totalProfit})`,
          400
        ),
        createdAt: serverTimestamp(),
      });

      const createdAtTs = currentSS.createdAt as { toMillis?: () => number; seconds?: number } | undefined;
      const createdAtMs =
        typeof createdAtTs?.toMillis === 'function'
          ? createdAtTs.toMillis()
          : typeof createdAtTs?.seconds === 'number'
          ? createdAtTs.seconds * 1000
          : 0;
      const isRecentSale = createdAtMs === 0 || Date.now() - createdAtMs <= 30 * 60 * 1000;

      if (isRecentSale) {
        reconciledDiscordPayload = {
          type: 'sale',
          dedupeId: staffSale.id,
          saleId: currentSS.saleNumber,
          saleDate: currentSS.saleDate,
          saleDateTime: currentSS.saleDateTime,
          staffName: clip(currentSS.staffName, 120),
          paymentMethod: currentSS.paymentMethod,
          items: currentSS.items.map((line) => {
            const unitQty = roundStockQty(line.unitQuantity ?? line.quantity);
            const conv = roundStockQty(line.conversionFactor ?? 1) || 1;
            const unitLabel = clip(line.unitName || 'Piece', 40);
            const prod = prodMap.get(line.productId);
            const baseUnit = prod ? getEffectiveBaseUnit(prod) : unitLabel;
            return {
              productName: clip(line.productName, 180),
              quantity: unitQty,
              unitPrice: line.salePricePerUnit,
              lineTotal: roundMoney(unitQty * line.salePricePerUnit),
              unit: conv > 1 ? clip(`${unitLabel} (${conv} ${baseUnit})`, 40) : unitLabel,
            };
          }),
          totalAmount,
          totalProfit,
          notes: clip(currentSS.notes, 500),
        };
      }
    });

    if (reconciledDiscordPayload) {
      void notifyDiscordTransaction(ownerUid, reconciledDiscordPayload);
    }

    enqueueSheetsBackgroundTask({
      dedupeId: staffSale.id,
      shopId: ownerUid,
      entityType: 'staff_sale',
      entityId: staffSale.id,
      action: 'SYNC_STAFF_SALE',
      summary: `Staff sale ${staffSale.saleNumber} by ${staffSale.staffName}`,
      targetSheets: [
        'Sales',
        'Sales Details',
        'Products',
        'Inventory',
        'Stock Movements',
        'Daily Summary',
        'Monthly Summary',
        'Staff Performance',
      ],
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `shops/${ownerUid}/staffSales/${staffSale.id}`);
  }
}

export async function recordStaffLoginAudit(shopId: string, staff: StaffMember): Promise<void> {
  const logRef = doc(collection(db, 'shops', shopId, 'auditLogs'));
  await setDoc(logRef, {
    ownerUid: shopId,
    action: 'STAFF_LOGIN',
    entityType: 'staff',
    entityId: clip(staff.id, 128),
    summary: clip(`Staff login: ${staff.name} (@${staff.username})`, 400),
    createdAt: serverTimestamp(),
  });
}

