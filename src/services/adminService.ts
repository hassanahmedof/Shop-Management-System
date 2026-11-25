import { createUserWithEmailAndPassword, deleteUser, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, getStaffProvisionAuth, handleFirestoreError, OperationType } from '../lib/firebase';
import type { AdminMember } from '../types/shop';
import { buildUsernameLookupKey, getShopCode, validateStaffUsername } from './staffService';

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

export function buildAdminLookupKey(shopCode: string, username: string): string {
  return `${shopCode.trim().toLowerCase()}_${username.trim().toLowerCase()}`;
}

export function buildAdminSyntheticEmail(
  usernameLower: string,
  loginVersion: number,
  shopCode: string
): string {
  return `${usernameLower}.v${loginVersion}.${shopCode.toLowerCase()}@admin.caremart.app`;
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
    return new Error('This admin credential version already exists. Please try another username.');
  }
  return err instanceof Error ? err : new Error('Failed to create admin credentials.');
}

export async function lookupAdminLogin(
  usernameInput: string,
  shopCodeInput?: string
): Promise<{
  shopId: string;
  loginVersion: number;
  isActive: boolean;
  syntheticEmail: string;
}> {
  const uname = usernameInput.trim();
  const userErr = validateStaffUsername(uname);
  if (userErr) throw new Error(userErr);

  const res = await fetch('/api/admin/lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: uname,
      shopCode: shopCodeInput?.trim() || '',
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    shopId?: string;
    loginVersion?: number;
    isActive?: boolean;
    syntheticEmail?: string;
    error?: string;
  };
  if (!res.ok || !data.syntheticEmail) {
    throw new Error(data.error || 'Invalid admin username or password.');
  }
  return {
    shopId: String(data.shopId || ''),
    loginVersion: Number(data.loginVersion || 1),
    isActive: Boolean(data.isActive),
    syntheticEmail: data.syntheticEmail,
  };
}

export async function createAdminMember(
  shopId: string,
  input: {
    name: string;
    phone: string;
    username: string;
    password: string;
  }
): Promise<string> {
  const name = clip(input.name, 120);
  const phone = clip(input.phone, 40);
  const username = clip(input.username, 40);
  const usernameLower = username.toLowerCase();

  if (!name) throw new Error('Admin full name is required.');
  const userErr = validateStaffUsername(username);
  if (userErr) throw new Error(userErr);
  if (!input.password || input.password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  await authorizeApiRequest('/api/admin/admins/authorize', 'POST', { name, username });

  const shopCode = getShopCode(shopId);
  const lookupKey = buildAdminLookupKey(shopCode, usernameLower);
  const usernameLookupKey = buildUsernameLookupKey(usernameLower);

  const [existingAdminLookup, existingAdminUserLookup, existingStaffLookup, existingStaffUserLookup] =
    await Promise.all([
      getDoc(doc(db, 'adminLookup', lookupKey)),
      getDoc(doc(db, 'adminLookup', usernameLookupKey)),
      getDoc(doc(db, 'staffLookup', lookupKey)),
      getDoc(doc(db, 'staffLookup', usernameLookupKey)),
    ]);

  if (
    existingAdminLookup.exists() ||
    existingAdminUserLookup.exists() ||
    existingStaffLookup.exists() ||
    existingStaffUserLookup.exists()
  ) {
    throw new Error(`Username "${username}" is already registered. Choose a different username.`);
  }

  const syntheticEmail = buildAdminSyntheticEmail(usernameLower, 1, shopCode);
  const provisionAuth = getStaffProvisionAuth();
  let createdAuthUser: User | null = null;

  try {
    const cred = await createUserWithEmailAndPassword(provisionAuth, syntheticEmail, input.password);
    createdAuthUser = cred.user;
  } catch (err) {
    throw mapProvisionAuthError(err);
  }

  const adminAuthUid = createdAuthUser.uid;
  const adminRef = doc(collection(db, 'shops', shopId, 'adminMembers'));

  try {
    await runTransaction(db, async (tx) => {
      const adminLookupRef = doc(db, 'adminLookup', lookupKey);
      const adminUserLookupRef = doc(db, 'adminLookup', usernameLookupKey);
      const staffLookupRef = doc(db, 'staffLookup', lookupKey);
      const staffUserLookupRef = doc(db, 'staffLookup', usernameLookupKey);

      const [l1, l2, l3, l4] = await Promise.all([
        tx.get(adminLookupRef),
        tx.get(adminUserLookupRef),
        tx.get(staffLookupRef),
        tx.get(staffUserLookupRef),
      ]);
      if (l1.exists() || l2.exists() || l3.exists() || l4.exists()) {
        throw new Error(`Username "${username}" is already registered. Choose a different username.`);
      }

      const record: Omit<AdminMember, 'id'> = {
        ownerUid: shopId,
        shopId,
        shopCode,
        name,
        phone,
        username,
        usernameLower,
        authUid: adminAuthUid,
        loginVersion: 1,
        role: 'admin',
        isActive: true,
      };

      tx.set(adminRef, {
        ...record,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const lookupDocPayload = {
        ownerUid: shopId,
        shopId,
        adminMemberId: adminRef.id,
        loginVersion: 1,
        isActive: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      tx.set(adminLookupRef, lookupDocPayload);
      tx.set(adminUserLookupRef, lookupDocPayload);

      tx.set(doc(db, 'adminAuthMap', adminAuthUid), {
        ownerUid: shopId,
        shopId,
        adminMemberId: adminRef.id,
        isActive: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(collection(db, 'shops', shopId, 'auditLogs')), {
        ownerUid: shopId,
        action: 'CREATE_ADMIN',
        entityType: 'admin',
        entityId: adminRef.id,
        summary: clip(`Added shop admin "${name}" (@${username})`, 400),
        createdAt: serverTimestamp(),
      });
    });

    return adminRef.id;
  } catch (err) {
    try {
      await deleteUser(createdAuthUser);
    } catch {
      // Best-effort rollback of provisioned auth account on Firestore failure
    }
    if (err instanceof Error && err.message.includes('already registered')) {
      throw err;
    }
    handleFirestoreError(err, OperationType.CREATE, `shops/${shopId}/adminMembers/${adminRef.id}`);
  } finally {
    await signOut(provisionAuth).catch(() => {});
  }
}

export async function updateAdminMember(
  shopId: string,
  member: AdminMember,
  updates: {
    name: string;
    phone: string;
    isActive: boolean;
  }
): Promise<void> {
  const name = clip(updates.name, 120);
  if (!name) throw new Error('Admin full name is required.');
  const phone = clip(updates.phone, 40);
  const lookupKey = buildAdminLookupKey(member.shopCode, member.usernameLower);
  const usernameLookupKey = buildUsernameLookupKey(member.usernameLower);

  await authorizeApiRequest(`/api/admin/admins/${encodeURIComponent(member.id)}/authorize`, 'PATCH');

  try {
    const [lookupSnap, usernameLookupSnap] = await Promise.all([
      getDoc(doc(db, 'adminLookup', lookupKey)),
      getDoc(doc(db, 'adminLookup', usernameLookupKey)),
    ]);

    const batch = writeBatch(db);
    batch.update(doc(db, 'shops', shopId, 'adminMembers', member.id), {
      name,
      phone,
      isActive: updates.isActive,
      updatedAt: serverTimestamp(),
    });

    if (lookupSnap.exists()) {
      batch.update(doc(db, 'adminLookup', lookupKey), {
        isActive: updates.isActive,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(db, 'adminLookup', lookupKey), {
        ownerUid: shopId,
        shopId,
        adminMemberId: member.id,
        loginVersion: member.loginVersion || 1,
        isActive: updates.isActive,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    if (usernameLookupSnap.exists()) {
      batch.update(doc(db, 'adminLookup', usernameLookupKey), {
        isActive: updates.isActive,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(db, 'adminLookup', usernameLookupKey), {
        ownerUid: shopId,
        shopId,
        adminMemberId: member.id,
        loginVersion: member.loginVersion || 1,
        isActive: updates.isActive,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    if (member.authUid) {
      batch.update(doc(db, 'adminAuthMap', member.authUid), {
        isActive: updates.isActive,
        updatedAt: serverTimestamp(),
      });
    }

    batch.set(doc(collection(db, 'shops', shopId, 'auditLogs')), {
      ownerUid: shopId,
      action: 'UPDATE_ADMIN',
      entityType: 'admin',
      entityId: member.id,
      summary: clip(
        `Updated admin "${name}" (@${member.username}) · Active: ${updates.isActive ? 'Yes' : 'No'}`,
        400
      ),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${shopId}/adminMembers/${member.id}`);
  }
}

export async function resetAdminMemberPassword(
  shopId: string,
  member: AdminMember,
  newPassword: string
): Promise<void> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }

  await authorizeApiRequest(
    `/api/admin/admins/${encodeURIComponent(member.id)}/reset-password/authorize`,
    'POST'
  );

  const nextVersion = (member.loginVersion || 1) + 1;
  const syntheticEmail = buildAdminSyntheticEmail(member.usernameLower, nextVersion, member.shopCode);
  const provisionAuth = getStaffProvisionAuth();
  let newAuthUid = '';

  try {
    const cred = await createUserWithEmailAndPassword(provisionAuth, syntheticEmail, newPassword);
    newAuthUid = cred.user.uid;
    await signOut(provisionAuth);
  } catch (err) {
    throw mapProvisionAuthError(err);
  }

  const lookupKey = buildAdminLookupKey(member.shopCode, member.usernameLower);
  const usernameLookupKey = buildUsernameLookupKey(member.usernameLower);

  try {
    const [lookupSnap, usernameLookupSnap] = await Promise.all([
      getDoc(doc(db, 'adminLookup', lookupKey)),
      getDoc(doc(db, 'adminLookup', usernameLookupKey)),
    ]);

    const batch = writeBatch(db);
    batch.update(doc(db, 'shops', shopId, 'adminMembers', member.id), {
      authUid: newAuthUid,
      loginVersion: nextVersion,
      updatedAt: serverTimestamp(),
    });

    if (lookupSnap.exists()) {
      batch.update(doc(db, 'adminLookup', lookupKey), {
        loginVersion: nextVersion,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(db, 'adminLookup', lookupKey), {
        ownerUid: shopId,
        shopId,
        adminMemberId: member.id,
        loginVersion: nextVersion,
        isActive: member.isActive,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    if (usernameLookupSnap.exists()) {
      batch.update(doc(db, 'adminLookup', usernameLookupKey), {
        loginVersion: nextVersion,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(doc(db, 'adminLookup', usernameLookupKey), {
        ownerUid: shopId,
        shopId,
        adminMemberId: member.id,
        loginVersion: nextVersion,
        isActive: member.isActive,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    batch.set(doc(db, 'adminAuthMap', newAuthUid), {
      ownerUid: shopId,
      shopId,
      adminMemberId: member.id,
      isActive: member.isActive,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (member.authUid && member.authUid !== newAuthUid) {
      batch.delete(doc(db, 'adminAuthMap', member.authUid));
    }

    batch.set(doc(collection(db, 'shops', shopId, 'auditLogs')), {
      ownerUid: shopId,
      action: 'RESET_ADMIN_PASSWORD',
      entityType: 'admin',
      entityId: member.id,
      summary: clip(`Reset password for admin "${member.name}" (@${member.username})`, 400),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${shopId}/adminMembers/${member.id}`);
  }
}
