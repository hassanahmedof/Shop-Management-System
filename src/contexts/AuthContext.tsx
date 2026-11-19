import type { User } from 'firebase/auth';
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithPopup,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { auth, db, googleAuthProvider, googleSheetsAuthProvider } from '../lib/firebase';
import { lookupAdminLogin } from '../services/adminService';
import {
  clearCachedStaffSession,
  isNetworkOrOfflineError,
  loadCachedStaffSession,
  saveCachedStaffSession,
} from '../services/offlineSyncService';
import { ensureShopInitialized, recordOwnerLoginAudit } from '../services/shopService';
import { lookupStaffLogin, recordStaffLoginAudit } from '../services/staffService';
import type { AdminAuthMap, SessionRole, StaffAuthMap, StaffMember } from '../types/shop';
import {
  classifyGoogleAuthError,
  type SheetsErrorResolution,
  SheetsOAuthError,
} from '../utils/sheetsErrorHandling';

const LOGIN_AUDIT_SESSION_PREFIX = 'cm_login_audit_';
const LOW_STOCK_TOAST_SESSION_PREFIX = 'cm_low_stock_notified_';

function clearLoginSessionMarkers(uid?: string) {
  try {
    if (uid) {
      sessionStorage.removeItem(`${LOGIN_AUDIT_SESSION_PREFIX}${uid}`);
      sessionStorage.removeItem(`${LOW_STOCK_TOAST_SESSION_PREFIX}${uid}`);
      return;
    }
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (
        key &&
        (key.startsWith(LOGIN_AUDIT_SESSION_PREFIX) || key.startsWith(LOW_STOCK_TOAST_SESSION_PREFIX))
      ) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => sessionStorage.removeItem(k));
  } catch {
    // Ignore sessionStorage errors in restricted browser contexts
  }
}

function shouldRecordLoginAudit(uid: string): boolean {
  try {
    const key = `${LOGIN_AUDIT_SESSION_PREFIX}${uid}`;
    if (sessionStorage.getItem(key) === '1') {
      return false;
    }
    sessionStorage.setItem(key, '1');
    return true;
  } catch {
    return true;
  }
}

function getAuthErrorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : '';
}

export interface InitialAdminSetupInput {
  displayName: string;
  shopName: string;
  email: string;
  password: string;
}

interface AuthContextValue {
  user: User | null;
  sessionRole: SessionRole | null;
  shopId: string | null;
  staffProfile: StaffMember | null;
  loading: boolean;
  initializingShop: boolean;
  shopReady: boolean;
  ownerSetupCompleted: boolean | null;
  authError: string | null;
  authErrorCode: string | null;
  authErrorResolution: SheetsErrorResolution | null;
  googleSheetsAccessToken: string | null;
  clearAuthError: () => void;
  refreshOwnerSetupStatus: () => Promise<boolean>;
  signInOwnerWithEmail: (identifier: string, password: string) => Promise<void>;
  setupInitialAdmin: (input: InitialAdminSetupInput) => Promise<void>;
  sendAdminPasswordReset: (email: string) => Promise<void>;
  recoverOwnerWithGoogle: () => Promise<void>;
  authorizeGoogleSheets: () => Promise<string | null>;
  clearGoogleSheetsToken: () => void;
  signInAsStaff: (username: string, password: string) => Promise<void>;
  retryInitialization: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [sessionRole, setSessionRole] = useState<SessionRole | null>(null);
  const [shopId, setShopId] = useState<string | null>(null);
  const [staffProfile, setStaffProfile] = useState<StaffMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializingShop, setInitializingShop] = useState(false);
  const [shopReady, setShopReady] = useState(false);
  const [ownerSetupCompleted, setOwnerSetupCompleted] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authErrorCode, setAuthErrorCode] = useState<string | null>(null);
  const [authErrorResolution, setAuthErrorResolution] = useState<SheetsErrorResolution | null>(null);
  // Strictly memory-only OAuth access token for Google Sheets API (never persisted in storage)
  const [googleSheetsAccessToken, setGoogleSheetsAccessToken] = useState<string | null>(null);

  const initSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const usingCachedOfflineSessionRef = useRef(false);
  const pendingSetupMetaRef = useRef<{
    shopName?: string;
    ownerName?: string;
    mode?: 'setup' | 'signin';
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshOwnerSetupStatus = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/auth/owner-setup-status');
      const data = (await res.json().catch(() => ({}))) as { setupCompleted?: boolean };
      const completed = Boolean(data.setupCompleted);
      if (mountedRef.current) {
        setOwnerSetupCompleted(completed);
      }
      return completed;
    } catch {
      if (mountedRef.current) {
        setOwnerSetupCompleted((prev) => prev ?? false);
      }
      return false;
    }
  }, []);

  useEffect(() => {
    void refreshOwnerSetupStatus();
  }, [refreshOwnerSetupStatus]);

  const clearGoogleSheetsToken = () => {
    if (mountedRef.current) {
      setGoogleSheetsAccessToken(null);
    }
  };

  const rejectUnauthorizedSession = async (message: string, code: string | null = null) => {
    const currentUid = auth.currentUser?.uid;
    clearLoginSessionMarkers(currentUid);
    clearCachedStaffSession(currentUid);
    usingCachedOfflineSessionRef.current = false;
    pendingSetupMetaRef.current = null;
    if (mountedRef.current) {
      setSessionRole(null);
      setShopId(null);
      setStaffProfile(null);
      setShopReady(false);
      setGoogleSheetsAccessToken(null);
      setAuthErrorResolution(null);
      setAuthErrorCode(code);
      setAuthError(message);
    }
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    await signOut(auth).catch(() => undefined);
  };

  const restoreStaffFromOfflineCache = (targetUid: string): boolean => {
    const cached = loadCachedStaffSession(targetUid);
    if (!cached) return false;
    usingCachedOfflineSessionRef.current = true;
    setSessionRole('sales_staff');
    setShopId(cached.shopId);
    setStaffProfile(cached.staffProfile);
    setShopReady(true);
    return true;
  };

  const initializeForUser = async (targetUser: User) => {
    const seq = ++initSeqRef.current;
    const isStale = () => !mountedRef.current || initSeqRef.current !== seq;

    const setupMeta = pendingSetupMetaRef.current;
    pendingSetupMetaRef.current = null;

    setSessionRole(null);
    setShopId(null);
    setStaffProfile(null);
    setInitializingShop(true);
    setShopReady(false);
    setAuthError(null);
    setAuthErrorCode(null);
    setAuthErrorResolution(null);
    usingCachedOfflineSessionRef.current = false;

    try {
      const emailLower = (targetUser.email || '').trim().toLowerCase();
      const isSyntheticStaff = emailLower.endsWith('@staff.caremart.app');
      const isPasswordProvider = targetUser.providerData.some((p) => p.providerId === 'password');
      const isGoogleProvider = targetUser.providerData.some((p) => p.providerId === 'google.com');

      if (isSyntheticStaff) {
        if (!isPasswordProvider || isGoogleProvider) {
          await rejectUnauthorizedSession(
            'Sales staff must log in using their assigned username and password.'
          );
          return;
        }

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          if (restoreStaffFromOfflineCache(targetUser.uid)) {
            return;
          }
          throw new Error(
            'You are offline and no cached staff workspace was found on this device. Connect to the internet to sign in.'
          );
        }

        try {
          const idToken = await targetUser.getIdToken();
          if (isStale()) return;

          const verifyRes = await fetch('/api/auth/verify-staff', {
            method: 'POST',
            headers: { Authorization: `Bearer ${idToken}` },
          });
          const verifyData = (await verifyRes.json().catch(() => ({}))) as {
            authorized?: boolean;
            role?: string;
            shopId?: string;
            error?: string;
          };
          if (isStale()) return;

          if (verifyRes.status === 401 || verifyRes.status === 403) {
            await rejectUnauthorizedSession(
              verifyData.error || 'Your staff credentials are inactive or unauthorized.'
            );
            return;
          }

          if (!verifyRes.ok) {
            throw new Error(verifyData.error || `Server verification unavailable (${verifyRes.status}).`);
          }

          if (
            !verifyData.authorized ||
            verifyData.role !== 'sales_staff' ||
            !verifyData.shopId
          ) {
            await rejectUnauthorizedSession(
              verifyData.error || 'Your staff credentials are inactive or unauthorized.'
            );
            return;
          }

          const mapSnap = await getDoc(doc(db, 'staffAuthMap', targetUser.uid));
          if (isStale()) return;
          if (!mapSnap.exists()) {
            await rejectUnauthorizedSession(
              'Your staff credentials are no longer active. Please contact the shop owner.'
            );
            return;
          }

          const authMap = mapSnap.data() as StaffAuthMap;
          if (!authMap.isActive || authMap.shopId !== verifyData.shopId) {
            await rejectUnauthorizedSession('This staff account has been deactivated by the shop owner.');
            return;
          }

          const staffSnap = await getDoc(doc(db, 'shops', authMap.shopId, 'staff', authMap.staffId));
          if (isStale()) return;
          if (!staffSnap.exists()) {
            await rejectUnauthorizedSession('Staff profile not found. Please contact the shop owner.');
            return;
          }

          const staffData = { id: staffSnap.id, ...(staffSnap.data() as Omit<StaffMember, 'id'>) };
          if (!staffData.isActive || staffData.authUid !== targetUser.uid) {
            await rejectUnauthorizedSession('This staff session is inactive or credentials were reset.');
            return;
          }

          saveCachedStaffSession(targetUser.uid, authMap.shopId, staffData);
          usingCachedOfflineSessionRef.current = false;
          setSessionRole('sales_staff');
          setShopId(authMap.shopId);
          setStaffProfile(staffData);
          setShopReady(true);

          if (shouldRecordLoginAudit(targetUser.uid)) {
            void recordStaffLoginAudit(authMap.shopId, staffData).catch((err) => {
              console.error('Staff login audit failed:', err);
            });
          }
        } catch (staffErr) {
          if (isStale()) return;
          if (isNetworkOrOfflineError(staffErr) && restoreStaffFromOfflineCache(targetUser.uid)) {
            return;
          }
          throw staffErr;
        }
      } else {
        if (!isPasswordProvider && !isGoogleProvider) {
          await rejectUnauthorizedSession(
            'Access Denied. Owner/Admin login requires Email & Password authentication.'
          );
          return;
        }

        const idToken = await targetUser.getIdToken();
        if (isStale()) return;

        const verifyRes = await fetch('/api/auth/verify-owner', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ mode: setupMeta?.mode || 'signin' }),
        });
        const verifyData = (await verifyRes.json().catch(() => ({}))) as {
          authorized?: boolean;
          role?: string;
          shopId?: string;
          email?: string;
          ownerProof?: string;
          error?: string;
        };
        if (isStale()) return;

        if (
          !verifyRes.ok ||
          !verifyData.authorized ||
          verifyData.role !== 'owner' ||
          !verifyData.ownerProof
        ) {
          await rejectUnauthorizedSession(
            verifyData.error ||
              'Access Denied. This account is not authorized to access the Owner/Admin panel.'
          );
          void refreshOwnerSetupStatus();
          return;
        }

        const resolvedShopId = verifyData.shopId || targetUser.uid;
        await ensureShopInitialized(targetUser, verifyData.ownerProof, verifyData.email, {
          shopName: setupMeta?.shopName,
          ownerName: setupMeta?.ownerName,
          shopId: resolvedShopId,
        });
        if (isStale()) return;

        setOwnerSetupCompleted(true);
        setSessionRole('owner');
        setShopId(resolvedShopId);
        setStaffProfile(null);
        setShopReady(true);

        if (shouldRecordLoginAudit(targetUser.uid)) {
          void recordOwnerLoginAudit(
            resolvedShopId,
            verifyData.email || targetUser.email || '',
            targetUser.uid
          ).catch((err) => {
            console.error('Owner login audit failed:', err);
          });
        }
      }
    } catch (err) {
      if (!isStale()) {
        setSessionRole(null);
        setShopId(null);
        setStaffProfile(null);
        setAuthError(err instanceof Error ? err.message : 'Failed to initialize shop workspace.');
        setShopReady(false);
      }
    } finally {
      if (!isStale()) {
        setInitializingShop(false);
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      if (nextUser) {
        setUser(nextUser);
        await initializeForUser(nextUser);
      } else {
        initSeqRef.current += 1;
        usingCachedOfflineSessionRef.current = false;
        setUser(null);
        setSessionRole(null);
        setShopId(null);
        setStaffProfile(null);
        setShopReady(false);
        setGoogleSheetsAccessToken(null);
        setInitializingShop(false);
        setLoading(false);
      }
    });
    return () => unsub();
  }, []);

  // Re-verify cached offline staff session in the background once back online
  useEffect(() => {
    if (!user || sessionRole !== 'sales_staff' || !shopId) return;

    const verifyOnlineSession = async () => {
      if (!usingCachedOfflineSessionRef.current || !navigator.onLine) return;
      try {
        const idToken = await user.getIdToken();
        const verifyRes = await fetch('/api/auth/verify-staff', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (verifyRes.status === 401 || verifyRes.status === 403) {
          const data = (await verifyRes.json().catch(() => ({}))) as { error?: string };
          await rejectUnauthorizedSession(
            data.error || 'Your staff credentials are inactive or unauthorized.'
          );
          return;
        }
        if (verifyRes.ok) {
          const data = (await verifyRes.json().catch(() => ({}))) as {
            authorized?: boolean;
            role?: string;
            shopId?: string;
            error?: string;
          };
          if (!data.authorized || data.role !== 'sales_staff' || data.shopId !== shopId) {
            await rejectUnauthorizedSession(
              data.error || 'Your staff credentials are inactive or unauthorized.'
            );
            return;
          }
          usingCachedOfflineSessionRef.current = false;
        }
      } catch {
        // Remain resilient if connectivity fluctuates again
      }
    };

    window.addEventListener('online', verifyOnlineSession);
    return () => window.removeEventListener('online', verifyOnlineSession);
  }, [user, sessionRole, shopId]);

  // Real-time staff status & permission enforcement
  useEffect(() => {
    if (!user || sessionRole !== 'sales_staff' || !shopId || !staffProfile?.id) return;
    const staffDocRef = doc(db, 'shops', shopId, 'staff', staffProfile.id);
    const unsub = onSnapshot(
      staffDocRef,
      (snap) => {
        if (!snap.exists()) {
          if (!snap.metadata.fromCache) {
            void rejectUnauthorizedSession('Staff account was removed by the shop owner.');
          }
          return;
        }
        const updated = { id: snap.id, ...(snap.data() as Omit<StaffMember, 'id'>) };
        if (!updated.isActive || updated.authUid !== user.uid) {
          void rejectUnauthorizedSession(
            'Your staff account was deactivated or your password was reset by the shop owner.'
          );
          return;
        }
        saveCachedStaffSession(user.uid, shopId, updated);
        setStaffProfile(updated);
      },
      (error) => {
        if (isNetworkOrOfflineError(error)) return;
        const code = getAuthErrorCode(error);
        if (code === 'permission-denied' || code === 'unauthenticated') {
          void rejectUnauthorizedSession('Your staff access was revoked or updated by the shop owner.');
        }
      }
    );
    return () => unsub();
  }, [user, sessionRole, shopId, staffProfile?.id]);

  const clearAuthError = () => {
    setAuthError(null);
    setAuthErrorCode(null);
    setAuthErrorResolution(null);
  };

  const retryInitialization = async () => {
    if (user) {
      await initializeForUser(user);
    }
  };

  // Synchronous revocation listener for Added Admins (if deactivated or password reset)
  useEffect(() => {
    if (!user || sessionRole !== 'owner' || !shopId || user.uid === shopId) return;

    const mapRef = doc(db, 'adminAuthMap', user.uid);
    const unsubMap = onSnapshot(
      mapRef,
      (snap) => {
        if (!snap.exists()) {
          void rejectUnauthorizedSession(
            'Your Admin access was revoked or your password was reset.'
          );
          return;
        }
        const mapData = snap.data() as AdminAuthMap;
        if (!mapData.isActive || mapData.shopId !== shopId) {
          void rejectUnauthorizedSession('Your Admin account has been deactivated.');
        }
      },
      () => {
        // Ignore transient offline errors
      }
    );

    return () => {
      unsubMap();
    };
  }, [user, sessionRole, shopId, rejectUnauthorizedSession]);

  const signInOwnerWithEmail = async (identifier: string, password: string) => {
    setAuthError(null);
    setAuthErrorCode(null);
    setAuthErrorResolution(null);
    clearLoginSessionMarkers();

    const trimmed = identifier.trim();
    if (!trimmed) {
      setAuthError('Enter your Owner email or Admin username.');
      return;
    }

    pendingSetupMetaRef.current = { mode: 'signin' };

    try {
      let loginEmail = '';
      if (trimmed.includes('@')) {
        loginEmail = trimmed.toLowerCase();
        if (loginEmail.endsWith('@staff.caremart.app')) {
          pendingSetupMetaRef.current = null;
          setAuthError('Sales Staff accounts must use the Sales Staff tab.');
          return;
        }
      } else {
        const lookup = await lookupAdminLogin(trimmed);
        loginEmail = lookup.syntheticEmail;
      }

      await signInWithEmailAndPassword(auth, loginEmail, password);
    } catch (err) {
      pendingSetupMetaRef.current = null;
      const code = getAuthErrorCode(err);
      setAuthErrorCode(code || null);
      if (
        code === 'auth/invalid-credential' ||
        code === 'auth/wrong-password' ||
        code === 'auth/user-not-found'
      ) {
        setAuthError(
          'Incorrect email/username or password. If you previously accessed this shop with Google Sign-In, click "Send Password Setup Link" or use Google Recovery below.'
        );
      } else if (code === 'auth/invalid-email') {
        setAuthError('Please enter a valid email address or admin username.');
      } else if (code === 'auth/too-many-requests') {
        setAuthError('Too many failed login attempts. Please wait a moment and try again.');
      } else if (code === 'auth/operation-not-allowed') {
        setAuthError(
          'Email/Password sign-in is disabled in Firebase Authentication Console (Authentication -> Sign-in method -> Email/Password).'
        );
      } else {
        setAuthError(err instanceof Error ? err.message : 'Unable to sign in.');
      }
      throw err;
    }
  };

  const setupInitialAdmin = async (input: InitialAdminSetupInput) => {
    setAuthError(null);
    setAuthErrorCode(null);
    setAuthErrorResolution(null);
    clearLoginSessionMarkers();

    const displayName = input.displayName.trim();
    const shopName = input.shopName.trim();
    const email = input.email.trim().toLowerCase();
    const password = input.password;

    if (!displayName) {
      setAuthError('Owner name is required.');
      return;
    }
    if (!shopName) {
      setAuthError('Shop name is required.');
      return;
    }
    if (!email || !email.includes('@')) {
      setAuthError('Please enter a valid email address.');
      return;
    }
    if (email.endsWith('@staff.caremart.app')) {
      setAuthError('Owner email cannot use the internal staff domain.');
      return;
    }
    if (!password || password.length < 6) {
      setAuthError('Password must be at least 6 characters.');
      return;
    }

    // Re-check single-owner setup lock before creating an Auth account
    const alreadyDone = await refreshOwnerSetupStatus();
    if (alreadyDone) {
      setAuthError(
        'Initial Admin setup is already completed. Please sign in with your Owner email and password.'
      );
      return;
    }

    pendingSetupMetaRef.current = {
      shopName,
      ownerName: displayName,
      mode: 'setup',
    };

    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName }).catch(() => undefined);
    } catch (err) {
      pendingSetupMetaRef.current = null;
      const code = getAuthErrorCode(err);
      setAuthErrorCode(code || null);
      if (code === 'auth/email-already-in-use') {
        setAuthError(
          'An account with this email already exists in Firebase Authentication. Sign in with your password, or click "Send Password Setup Link" if this email was previously linked to Google.'
        );
      } else if (code === 'auth/weak-password') {
        setAuthError('Password must be at least 6 characters.');
      } else if (code === 'auth/invalid-email') {
        setAuthError('Please enter a valid email address.');
      } else if (code === 'auth/operation-not-allowed') {
        setAuthError(
          'Email/Password sign-in is disabled in Firebase Authentication Console (Authentication -> Sign-in method -> Email/Password).'
        );
      } else {
        setAuthError(err instanceof Error ? err.message : 'Unable to create Owner/Admin account.');
      }
      throw err;
    }
  };

  const sendAdminPasswordReset = async (email: string) => {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) {
      throw new Error('Enter a valid Owner email address first.');
    }
    await sendPasswordResetEmail(auth, normalized);
  };

  const recoverOwnerWithGoogle = async () => {
    setAuthError(null);
    setAuthErrorCode(null);
    setAuthErrorResolution(null);
    clearLoginSessionMarkers();
    pendingSetupMetaRef.current = { mode: 'signin' };

    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err) {
      pendingSetupMetaRef.current = null;
      const code = getAuthErrorCode(err);
      setAuthErrorCode(code || null);
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setAuthError(
          'Google popup was closed or blocked in this preview frame. Either open the app URL in a new browser tab, or use "Send Password Setup Link" with your Owner email.'
        );
      } else {
        setAuthError(err instanceof Error ? err.message : 'Google recovery sign-in failed.');
      }
      throw err;
    }
  };

  const authorizeGoogleSheets = async (): Promise<string | null> => {
    if (!user || sessionRole !== 'owner') {
      throw new Error('Only the authorized shop Owner/Admin can connect Google Sheets.');
    }
    try {
      const result = await reauthenticateWithPopup(user, googleSheetsAuthProvider);
      const cred = GoogleAuthProvider.credentialFromResult(result);
      const token = cred?.accessToken || null;
      if (!token) {
        throw new SheetsOAuthError({
          code: 'token_missing',
          severity: 'warning',
          title: 'Google Sheets Permission Not Granted',
          summary:
            'Google did not return a Sheets access token. Ensure the Google Sheets permission checkbox is selected.',
          cause: 'The OAuth consent completed without granting the Google Sheets scope.',
          steps: [
            'Use a Google Service Account in AI Studio Secrets (recommended), or grant Google Sheets permission in the popup.',
          ],
          suggestAlternatives: true,
          possiblePolicyBlock: false,
          retryable: true,
          rawMessage: 'Missing accessToken in GoogleAuthProvider credential.',
        });
      }
      if (mountedRef.current) {
        setGoogleSheetsAccessToken(token);
      }
      return token;
    } catch (err) {
      if (err instanceof SheetsOAuthError) {
        throw err;
      }
      const resolution = classifyGoogleAuthError(err, 'sheets_oauth', user.email);
      throw new SheetsOAuthError(resolution);
    }
  };

  const signInAsStaff = async (username: string, password: string) => {
    setAuthError(null);
    setAuthErrorCode(null);
    clearLoginSessionMarkers();
    try {
      const { syntheticEmail } = await lookupStaffLogin(username);
      await signInWithEmailAndPassword(auth, syntheticEmail, password);
    } catch (err) {
      const code = getAuthErrorCode(err);
      setAuthErrorCode(code || null);
      if (code === 'auth/operation-not-allowed') {
        setAuthError(
          'Email/Password sign-in is disabled in Firebase Authentication Console (Authentication -> Sign-in method -> Email/Password).'
        );
      } else if (
        code === 'auth/invalid-credential' ||
        code === 'auth/wrong-password' ||
        code === 'auth/user-not-found'
      ) {
        setAuthError('Incorrect username or password. Ask the shop owner if your password was reset.');
      } else {
        setAuthError(err instanceof Error ? err.message : 'Staff sign-in failed. Please try again.');
      }
      throw err;
    }
  };

  const logout = async () => {
    const uid = user?.uid;
    clearLoginSessionMarkers(uid);
    clearCachedStaffSession(uid);
    usingCachedOfflineSessionRef.current = false;
    initSeqRef.current += 1;
    setAuthError(null);
    setAuthErrorCode(null);
    setShopReady(false);
    setGoogleSheetsAccessToken(null);
    setSessionRole(null);
    setShopId(null);
    setStaffProfile(null);
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    await signOut(auth);
    void refreshOwnerSetupStatus();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        sessionRole,
        shopId,
        staffProfile,
        loading,
        initializingShop,
        shopReady,
        ownerSetupCompleted,
        authError,
        authErrorCode,
        authErrorResolution,
        googleSheetsAccessToken,
        clearAuthError,
        refreshOwnerSetupStatus,
        signInOwnerWithEmail,
        setupInitialAdmin,
        sendAdminPasswordReset,
        recoverOwnerWithGoogle,
        authorizeGoogleSheets,
        clearGoogleSheetsToken,
        signInAsStaff,
        retryInitialization,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
