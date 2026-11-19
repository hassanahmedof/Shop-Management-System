import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { isNetworkOrOfflineError } from './offlineSyncService';
import type { GoogleSheetsIntegration, SheetsSyncJob } from '../types/shop';

const INTEGRATION_DOC_ID = 'googleSheets';

function clip(val: string, maxLen: number): string {
  return val.trim().slice(0, maxLen);
}

export async function ensureIntegrationDoc(
  uid: string,
  initial?: Partial<{
    spreadsheetId: string;
    spreadsheetUrl: string;
    spreadsheetTitle: string;
    autoSyncEnabled: boolean;
    connectionState: GoogleSheetsIntegration['connectionState'];
    lastSyncAt: string;
    lastSyncStatus: GoogleSheetsIntegration['lastSyncStatus'];
    lastError: string;
    syncedRecordCount: number;
  }>
): Promise<void> {
  const path = `shops/${uid}/integrations/${INTEGRATION_DOC_ID}`;
  const ref = doc(db, 'shops', uid, 'integrations', INTEGRATION_DOC_ID);

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (err) {
    if (isNetworkOrOfflineError(err)) return;
    handleFirestoreError(err, OperationType.GET, path);
  }

  if (!snap.exists()) {
    try {
      await setDoc(ref, {
        ownerUid: uid,
        spreadsheetId: clip(initial?.spreadsheetId ?? '', 180),
        spreadsheetUrl: clip(initial?.spreadsheetUrl ?? '', 350),
        spreadsheetTitle: clip(
          initial?.spreadsheetTitle ?? 'CareMart Shop Manager – Business Records',
          180
        ),
        autoSyncEnabled: initial?.autoSyncEnabled ?? true,
        connectionState: initial?.connectionState ?? 'disconnected',
        lastSyncAt: clip(initial?.lastSyncAt ?? '', 64),
        lastSyncStatus: initial?.lastSyncStatus ?? 'idle',
        lastError: clip(initial?.lastError ?? '', 500),
        syncedRecordCount: Math.max(0, initial?.syncedRecordCount ?? 0),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      if (isNetworkOrOfflineError(err)) return;
      handleFirestoreError(err, OperationType.CREATE, path);
    }
    return;
  }

  if (initial && Object.keys(initial).length > 0) {
    const patch: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (initial.spreadsheetId !== undefined) {
      patch.spreadsheetId = clip(initial.spreadsheetId, 180);
    }
    if (initial.spreadsheetUrl !== undefined) {
      patch.spreadsheetUrl = clip(initial.spreadsheetUrl, 350);
    }
    if (initial.spreadsheetTitle !== undefined) {
      patch.spreadsheetTitle = clip(initial.spreadsheetTitle, 180);
    }
    if (initial.autoSyncEnabled !== undefined) {
      patch.autoSyncEnabled = initial.autoSyncEnabled;
    }
    if (initial.connectionState !== undefined) {
      patch.connectionState = initial.connectionState;
    }
    if (initial.lastSyncAt !== undefined) {
      patch.lastSyncAt = clip(initial.lastSyncAt, 64);
    }
    if (initial.lastSyncStatus !== undefined) {
      patch.lastSyncStatus = initial.lastSyncStatus;
    }
    if (initial.lastError !== undefined) {
      patch.lastError = clip(initial.lastError, 500);
    }
    if (initial.syncedRecordCount !== undefined) {
      patch.syncedRecordCount = Math.max(0, initial.syncedRecordCount);
    }
    try {
      await updateDoc(ref, patch);
    } catch (err) {
      if (isNetworkOrOfflineError(err)) return;
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  }
}

export async function enqueueOrUpdateSyncJob(
  uid: string,
  job: {
    id?: string;
    jobType: SheetsSyncJob['jobType'];
    targetSheets: string[];
    recordCount: number;
    status: SheetsSyncJob['status'];
    retryCount: number;
    lastError: string;
    summary: string;
  }
): Promise<string> {
  const safeSheets = job.targetSheets.slice(0, 20);
  if (safeSheets.length === 0) {
    safeSheets.push('Daily Summary');
  }

  if (job.id) {
    const path = `shops/${uid}/sheetsSyncQueue/${job.id}`;
    const ref = doc(db, 'shops', uid, 'sheetsSyncQueue', job.id);
    let snap;
    try {
      snap = await getDoc(ref);
    } catch (err) {
      if (isNetworkOrOfflineError(err)) return job.id;
      handleFirestoreError(err, OperationType.GET, path);
    }
    if (snap.exists()) {
      try {
        await updateDoc(ref, {
          targetSheets: safeSheets,
          recordCount: Math.max(0, Math.round(job.recordCount)),
          status: job.status,
          retryCount: Math.max(0, Math.round(job.retryCount)),
          lastError: clip(job.lastError, 500),
          summary: clip(job.summary, 300),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        if (isNetworkOrOfflineError(err)) return job.id;
        handleFirestoreError(err, OperationType.UPDATE, path);
      }
      return job.id;
    }
  }

  const colRef = collection(db, 'shops', uid, 'sheetsSyncQueue');
  const newRef = job.id ? doc(colRef, job.id) : doc(colRef);
  const writePath = `shops/${uid}/sheetsSyncQueue/${newRef.id}`;
  try {
    await setDoc(newRef, {
      ownerUid: uid,
      jobType: job.jobType,
      targetSheets: safeSheets,
      recordCount: Math.max(0, Math.round(job.recordCount)),
      status: job.status,
      retryCount: Math.max(0, Math.round(job.retryCount)),
      lastError: clip(job.lastError, 500),
      summary: clip(job.summary, 300),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    if (isNetworkOrOfflineError(err)) return newRef.id;
    handleFirestoreError(err, OperationType.CREATE, writePath);
  }
  return newRef.id;
}

export async function deleteSyncJob(uid: string, jobId: string): Promise<void> {
  const path = `shops/${uid}/sheetsSyncQueue/${jobId}`;
  try {
    await deleteDoc(doc(db, 'shops', uid, 'sheetsSyncQueue', jobId));
  } catch (err) {
    if (isNetworkOrOfflineError(err)) return;
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
