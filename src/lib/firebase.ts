import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
interface FirebaseWebConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
}

const localFirebaseModules = import.meta.glob<
  FirebaseWebConfig & { default?: FirebaseWebConfig }
>('../../firebase-applet-config.json', { eager: true });

function resolveFirebaseConfig(): FirebaseWebConfig {
  const firstMod = Object.values(localFirebaseModules)[0];
  const fileConfig = firstMod ? firstMod.default ?? firstMod : undefined;

  const projectId =
    (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined)?.trim() ||
    fileConfig?.projectId ||
    '';
  const apiKey =
    (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined)?.trim() ||
    fileConfig?.apiKey ||
    '';
  const authDomain =
    (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined)?.trim() ||
    fileConfig?.authDomain ||
    (projectId ? `${projectId}.firebaseapp.com` : '');
  const appId =
    (import.meta.env.VITE_FIREBASE_APP_ID as string | undefined)?.trim() ||
    fileConfig?.appId ||
    '';
  const firestoreDatabaseId =
    (import.meta.env.VITE_FIREBASE_DATABASE_ID as string | undefined)?.trim() ||
    fileConfig?.firestoreDatabaseId ||
    '(default)';
  const storageBucket =
    (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined)?.trim() ||
    fileConfig?.storageBucket ||
    undefined;
  const messagingSenderId =
    (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined)?.trim() ||
    fileConfig?.messagingSenderId ||
    undefined;
  const measurementId =
    (import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined)?.trim() ||
    fileConfig?.measurementId ||
    undefined;

  return {
    projectId,
    appId,
    apiKey,
    authDomain,
    firestoreDatabaseId,
    ...(storageBucket ? { storageBucket } : {}),
    ...(messagingSenderId ? { messagingSenderId } : {}),
    ...(measurementId ? { measurementId } : {}),
  };
}

const firebaseConfig = resolveFirebaseConfig();

const app = getApps().some((a) => a.name === '[DEFAULT]') ? getApp() : initializeApp(firebaseConfig);
const firestoreDatabaseId = firebaseConfig.firestoreDatabaseId || '(default)';

function initDb() {
  try {
    return initializeFirestore(
      app,
      {
        experimentalAutoDetectLongPolling: true,
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      },
      firestoreDatabaseId
    );
  } catch {
    try {
      return initializeFirestore(
        app,
        { experimentalAutoDetectLongPolling: true },
        firestoreDatabaseId
      );
    } catch {
      return getFirestore(app, firestoreDatabaseId);
    }
  }
}

export const db = initDb();
export const auth = getAuth(app);

// Primary Owner sign-in provider: keep standard identity scopes ONLY so accounts in
// Google's Advanced Protection Program are not blocked at login by sensitive Workspace scopes.
export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({ prompt: 'select_account' });

// Optional browser OAuth provider specifically for requesting Google Sheets access when desired.
export const googleSheetsAuthProvider = new GoogleAuthProvider();
googleSheetsAuthProvider.addScope('https://www.googleapis.com/auth/spreadsheets');
googleSheetsAuthProvider.setCustomParameters({ prompt: 'consent select_account' });

export function getStaffProvisionAuth() {
  const existing = getApps().find((a) => a.name === 'StaffProvisioner');
  const secondaryApp = existing || initializeApp(firebaseConfig, 'StaffProvisioner');
  return getAuth(secondaryApp);
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration. Firestore client is offline.');
    }
  }
}

void testConnection();
