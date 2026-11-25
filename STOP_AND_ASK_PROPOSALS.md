# CareMart Shop Management System — Revised Technical Proposals (v2) for Deferred STOP-AND-ASK Architecture Changes

**Document Version:** `2.0` (Revised per Architectural Review)  
**Previous Version Archive:** `/STOP_AND_ASK_PROPOSALS.v1.md` *(Note: This AI Studio container workspace does not have a `.git` repository initialized — `git status` fails with `not a git repository` — so v1 is preserved intact at `/STOP_AND_ASK_PROPOSALS.v1.md` on disk rather than a local Git commit.)*  
**Status:** Proposal Only (Awaiting Explicit Individual Item Approval — **No Code, Rules, Credentials, Migrations, or Deployments Executed**)  
**Firebase Project Database:** `ai-studio-36596f53-ce10-4ba0-aae2-9d7f9051d6fe` (`(default)`)  
**Companion Downloadable Word Document:** `/public/CareMart_STOP_AND_ASK_Technical_Proposals.docx`

---

## Revision Summary (v1 → v2)

This revision directly addresses every architectural and security concern raised during review:

| Item | Key v2 Strengthening Over v1 |
| :--- | :--- |
| **§4.1 Owner Setup Security** | Option B now strictly enforces the **actual configured `OWNER_EMAIL`** (never merely `email_verified`) in `firestore.rules` AND blocks unauthorized direct Firestore SDK writes to `appState/ownerSetup` and `admins/{uid}` (`Option A` locks `allow create: if false;` with server-side Firestore REST/Admin provisioning; `Option B` binds `OWNER_EMAIL` + `email_verified` + single-use atomic pair check in rules without any public `gateSecret()` literal). |
| **§4.3 Encryption & Migration** | Explicitly drops any assumption of silent recovery: explains Cloud Run ephemeral container disk behavior (`.caremart-secrets/` does not exist locally and is wiped on cold container restarts unless persisted), mandates backup-before-reencrypt (`*.v1.bak`), details explicit `VAULT_DECRYPT_KEY_MISMATCH` diagnostics without overwriting ciphertext, and provides a Cloud Run–durable persistence path. |
| **§5.3 FIFO > 50 Batches** | Proves mathematically against the actual `createSale`, `editSale`, `cancelSale`, and `reconcileStaffSaleToOwnerLedger` code paths that **100% of deducted batches** are recorded (zero `.slice(0, 50)`) and restored, accounting for **every** write inside Firestore's **500-write transaction limit** (including `saleItems`, `stockMovements`, `products`, `inventoryBatches`, `sales`, `staffSales`, `auditLogs`, and overflow chunk docs). |
| **§7.1 Co-Occurrence > 2,000 Sales** | Eliminates the 5,000-ID array cap completely. Replaces capped hash arrays with **1-document-per-sale idempotency records (`upsellProcessedSales/{saleId}`)** (or unbounded linked overflow pages as an alternative), preventing silent history loss, guaranteeing serialized concurrency via `runTransaction`, handling `epoch`-versioned rebuilds, and enabling exact `cancelSale`/`editSale` pair subtraction. |
| **§8 Feedback Migration to Firestore** | Replaces full-map read-modify-write overwrites with **atomic + idempotent** persistence: create-only `upsellFeedbackEvents/{eventId}` deduplication paired with either atomic Firestore `:commit` `FieldValue.increment(1)` transforms + strict delta rules (Pattern A) or staff append-only event docs + owner/server transactional folding (Pattern B). |
| **§5.5 Deletion Rules** | Upgrades from field-only checks to **deterministic referential protection in `firestore.rules`** (`hasTransactionHistory` monotonic lock flag + `entityLocks/{lockId}` + `currentStock == 0` / `outstandingBalance == 0` / `totalPurchased == 0` / `totalPaid == 0` + pre-deployment historical backfill) so direct Firestore SDK/REST calls cannot delete historical products or suppliers and damage financial reports. |

---

## Table of Contents

1. [§4.1 Owner Setup Gate and Firestore Security Rules](#41-owner-setup-gate-and-firestore-security-rules)
2. [§4.3 Encryption Secret Enforcement and Legacy Credential Migration](#43-encryption-secret-enforcement-and-legacy-credential-migration)
3. [§5.3 FIFO Allocation Recording, Restoration, and 500-Write Budget Proof](#53-fifo-allocation-recording-restoration-and-500-write-budget-proof)
4. [§7.1 Co-Occurrence Cache Scaling Beyond 2,000 Processed Sales](#71-co-occurrence-cache-scaling-beyond-2000-processed-sales)
5. [§8 Atomic and Idempotent Feedback Storage Migration to Firestore](#8-atomic-and-idempotent-feedback-storage-migration-to-firestore)
6. [§5.5 Product and Supplier Referential Deletion Rules](#55-product-and-supplier-referential-deletion-rules)
7. [Unverified Assumptions & Pre-Implementation Verification Matrix](#unverified-assumptions--pre-implementation-verification-matrix)

---

<a id="41-owner-setup-gate-and-firestore-security-rules"></a>
## 1. §4.1 Owner Setup Gate and Firestore Security Rules

### 1.1 Exact Implementation Approach and Affected Files

#### Verified Current Implementation & Vulnerability
- `server.ts:86–87`: `OWNER_GATE_SECRET` falls back to literal `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'`.
- `server.ts:101–111`: `getConfiguredOwnerEmail()` parses `process.env.OWNER_EMAIL`, but is **only** checked as a boolean in `/api/health` (`921, 931`) and `/api/auth/owner-setup-status` (`943, 948`).
- `server.ts:554–656`: `authorizeOwnerUser()` **never compares `user.email` against `getConfiguredOwnerEmail()`** when `!primaryOwnerUid`. Any unmapped non-staff Firebase user receives a signed `ownerProof` from `POST /api/auth/verify-owner` (`line 973`).
- `firestore.rules:56–58, 857–888`: Hardcodes the identical static literal inside `gateSecret()`. Because `firestore.rules` is readable in source/deployments, an attacker can compute `sha256(uid + ':' + email + ':cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301')` locally and directly call `writeBatch` via the Firestore client SDK on an uninitialized database to create `appState/ownerSetup` and `admins/{attackerUid}`—completely bypassing `server.ts` and `OWNER_EMAIL`.
- `firestore.rules:858`: `allow get: if stateId == 'ownerSetup';` leaks `ownerUid` to unauthenticated users.
- `package.json`: Confirmed `firebase-admin` is **not** currently installed (`server.ts` performs Firebase ID token verification via Google JWKS + Firestore operations via HTTPS REST API with the caller's Bearer token).

#### Two Concrete Hardened Designs (No Bypass Via Direct Firestore SDK)

Because Firestore Security Rules **cannot read server environment variables (`process.env.OWNER_EMAIL`) dynamically**, enforcing the actual configured `OWNER_EMAIL` while blocking unauthorized direct SDK writes requires **one of two mutually exclusive implementations**:

##### Approach A (Recommended — Zero Client Creation in Rules + Server-Side Provisioning)
1. **Lock `firestore.rules` completely against direct SDK creation:**
   - `match /appState/{stateId}` → `allow create, update, delete: if false;`
   - `match /admins/{adminUid}` → `allow create, update, delete: if false;`
   - Mathematically guarantees **no client (authorized or unauthorized) can ever directly write initial owner documents via the Firestore SDK**.
2. **Server-Side Privileged Provisioning (`server.ts`):**
   - Authenticate server-side Firestore Admin/REST calls via `firebase-admin` (added to `package.json`, initialized via Application Default Credentials on Cloud Run / `FIREBASE_SERVICE_ACCOUNT_JSON`) or Google OAuth2 Service Account JWT using existing `crypto` primitives.
   - Inside `POST /api/auth/verify-owner` (`mode: 'setup'`):
     1. Require `OWNER_EMAIL` to be configured (`getConfiguredOwnerEmail() !== ''`); **fail closed (`503`)** if unset in production.
     2. Enforce `user.email === getConfiguredOwnerEmail()` (exact lowercase match) AND `user.emailVerified === true` (or explicit policy decision on initial password signup verification).
     3. Execute a Firestore **server transaction** checking `!appState/ownerSetup.exists`, then atomically write `appState/ownerSetup`, `admins/{user.uid}`, and (if needed) `users/{user.uid}` / `shops/{user.uid}` with server-only `ownerProof` (derived from `OWNER_GATE_SECRET`, **never** shared in rules).
3. **`src/services/shopService.ts:160–223` (`ensureShopInitialized`):**
   - Stop attempting client `writeBatch` creation of `appState/ownerSetup` and `admins/{uid}`. Instead, verify they already exist (provisioned by `/api/auth/verify-owner`) and only initialize shop workspace defaults (`shops/{uid}`, `settings/main`, default categories) once `admins/{uid}` is confirmed.

##### Approach B (Hardened Client Rules — Explicit Deploy-Time `OWNER_EMAIL` Binding in `firestore.rules`, No Static Secret Fallback)
If you want to avoid adding server-side Firestore Admin credentials (`firebase-admin`) and keep client `writeBatch` creation for initial setup:
1. **Enforce Actual Configured `OWNER_EMAIL` Inside Both `server.ts` AND `firestore.rules`:**
   - Remove `gateSecret()` static literal from `firestore.rules` and remove the hardcoded fallback in `server.ts:86–87`.
   - Bind the configured owner email directly inside `firestore.rules` using a canonical SHA-256 email digest (so the raw email is not even exposed in plaintext rules!) **generated deterministically from `process.env.OWNER_EMAIL` before rules deployment**:
     ```rules
     function expectedOwnerEmailSha256() {
       return '<64-hex-sha256-of-lowercased-trimmed-OWNER_EMAIL>';
     }
     function isConfiguredOwnerEmail() {
       return request.auth.token.email is string
         && hashing.sha256(request.auth.token.email.lower()).toHexString().lower() == expectedOwnerEmailSha256();
     }
     ```
     *(Pre-deploy verification script fails deployment if `expectedOwnerEmailSha256()` still contains a placeholder or does not match `sha256(OWNER_EMAIL)`!)*
   - Inside `firestore.rules`, **every** initial owner document creation (`appState/ownerSetup` AND `admins/{adminUid}`) requires **all four conditions simultaneously**:
     1. `isOwnerAuthUser()` (provider `'password'` or `'google.com'`, non-staff)
     2. `request.auth.token.email_verified == true`
     3. `isConfiguredOwnerEmail()` (matches the exact SHA-256 of `OWNER_EMAIL`)
     4. `isNotStaffAccount(request.auth.uid)`
     5. `!exists(/databases/$(database)/documents/appState/ownerSetup)` AND atomic dual-doc batch (`existsAfter(appState/ownerSetup)` + `existsAfter(admins/$(request.auth.uid))`)
   - In `server.ts` (`authorizeOwnerUser`), ALSO require `emailLower === configuredEmail` when `!primaryOwnerUid`, require `user.emailVerified === true`, and require `OWNER_GATE_SECRET` (minimum 32 chars) in production so `ownerProof` HMAC cannot be forged with a public fallback literal.
   - **Post-setup locking option:** Once initial setup completes on a single-shop deployment, `appState/ownerSetup` exists (`!exists(...)` becomes permanently `false`), and `allow create` can optionally be tightened to `if false` in subsequent rules updates.

#### Affected Files
- `server.ts` (`OWNER_GATE_SECRET`, `getConfiguredOwnerEmail`, `authorizeOwnerUser`, `POST /api/auth/verify-owner`, `GET /api/auth/owner-setup-status`)
- `firestore.rules` (`isOwnerAuthUser`, `isVerifiedOwnerEmail`, `isConfiguredOwnerEmail` or `allow create: if false`, `match /appState/{stateId}`, `match /admins/{adminUid}`)
- `src/services/shopService.ts` (`ensureShopInitialized`, lines 160–223)
- `src/contexts/AuthContext.tsx` (`initializeForUser`, `setupInitialAdmin`, lines 202–408, 605–676; handle email verification step if `email_verified` required)
- `src/components/LoginScreen.tsx` (surface clear guidance if owner email does not match `OWNER_EMAIL` or email verification link is pending)
- `package.json` *(only if Approach A installs `firebase-admin`)*
- `.env.example` (`OWNER_EMAIL`, `OWNER_GATE_SECRET`)

### 1.2 Data Integrity Guarantees
- **Single-Owner Uniqueness:** `appState/ownerSetup` has a fixed document ID `'ownerSetup'` with `allow update, delete: if false;`. Combined with `!exists(appState/ownerSetup)` (Approach B) or `allow create: if false;` + server transaction `precondition: { exists: false }` (Approach A), two owners can never overwrite or co-claim the primary shop slot.
- **Email Allowlist Guarantee:** Neither the UI, nor `/api/auth/verify-owner`, nor direct Firestore SDK calls can initialize `appState/ownerSetup` or `admins/{uid}` unless the authenticated token belongs to the exact verified `OWNER_EMAIL`.
- **Zero Unauthenticated `ownerUid` Leakage:** Restricting `appState/ownerSetup` `allow get` to `isOwnerAuthUser()` prevents unauthenticated enumeration of the owner UID.

### 1.3 Concurrency and Failure Handling
- **Concurrent Setup Race:**
  - Under Approach A: Two concurrent requests to `/api/auth/verify-owner` run Firestore server transactions targeting `appState/ownerSetup` with `exists: false` precondition; Firestore guarantees at most one succeeds while the second receives `409 Conflict` (`ALREADY_EXISTS`).
  - Under Approach B: Two concurrent client `writeBatch` commits racing on `!exists(appState/ownerSetup)` serialize inside Firestore; only the first succeeds and the second fails `PERMISSION_DENIED` (then retries as normal sign-in if UID matches).
- **Missing Env Configuration Failure (`Fail Closed`):** If `NODE_ENV === 'production'` and `OWNER_EMAIL` or `OWNER_GATE_SECRET` is missing/weak, `/api/auth/verify-owner` returns `503 Service Unavailable` with explicit operator message—never falling back to open registration or `'cm_gate_...'`.
- **Unverified Password Account Handling:** If `createUserWithEmailAndPassword` produces `emailVerified === false`, `setupInitialAdmin` sends `sendEmailVerification(cred.user)` and signs out cleanly (or prompts user to click link & refresh token via `user.reload()`) before calling `/api/auth/verify-owner` — no orphaned `appState/ownerSetup` is written until verification succeeds.

### 1.4 Backward Compatibility
- **Already-initialized primary owner:** Completely unaffected. `admins/{uid}` is only checked via `isAuthorizedAdminDoc(uid)` (`role == 'owner' && email == request.auth.token.email.lower()`) during normal reads/writes, never `allow create`.
- **Added admins (`adminAuthMap` / `adminMembers`) & Sales Staff (`staffAuthMap`):** Completely unaffected.
- **Rotating `OWNER_GATE_SECRET`:** Safe for already-initialized shops because existing `admins/{uid}` docs are not re-created or re-verified against `gateSecret()` on read.

### 1.5 Firestore Rules and Permissions

```rules
// Illustrative Option B Rules (Zero static gateSecret; enforces actual OWNER_EMAIL hash + verified email)
// NOTE: Replace <SHA256_OWNER_EMAIL_LOWER> at deploy time via verified build/deploy check.
function isConfiguredOwnerEmail() {
  return request.auth.token.email is string
    && request.auth.token.email_verified == true
    && hashing.sha256(request.auth.token.email.lower()).toHexString().lower() == '<SHA256_OWNER_EMAIL_LOWER>';
}

match /appState/{stateId} {
  allow get: if isOwnerAuthUser() && stateId == 'ownerSetup';
  allow list: if false;
  // Option A: allow create: if false;
  // Option B:
  allow create: if isOwnerAuthUser()
    && isConfiguredOwnerEmail()
    && isNotStaffAccount(request.auth.uid)
    && stateId == 'ownerSetup'
    && !exists(/databases/$(database)/documents/appState/ownerSetup)
    && existsAfter(/databases/$(database)/documents/admins/$(request.auth.uid))
    && isValidOwnerSetupState(incoming())
    && incoming().ownerUid == request.auth.uid
    && incoming().createdAt == request.time;
  allow update, delete: if false;
}

match /admins/{adminUid} {
  allow get: if isOwnerAuthUser()
    && isValidId(adminUid)
    && adminUid == request.auth.uid
    && (resource == null || existing().email == request.auth.token.email.lower());
  allow list: if false;
  // Option A: allow create: if false;
  // Option B:
  allow create: if isOwnerAuthUser()
    && isConfiguredOwnerEmail()
    && isNotStaffAccount(request.auth.uid)
    && isOwnerSetupAuthorizedFor(request.auth.uid)
    && isValidId(adminUid)
    && adminUid == request.auth.uid
    && isValidAdminRecord(incoming())
    && incoming().email == request.auth.token.email.lower()
    && incoming().createdAt == request.time
    && incoming().updatedAt == request.time;
  allow update, delete: if false;
}
```

### 1.6 Emulator and Regression Tests
- **Firestore Emulator Rules Suite:**
  1. Attacker signed in with `attacker@gmail.com` (`email_verified: true`) directly calls `setDoc(doc(db, 'appState/ownerSetup'), ...)` + `admins/{attackerUid}` with forged legacy `ownerProof` → **MUST FAIL (`PERMISSION_DENIED`)** under both Option A and Option B.
  2. User with matching `OWNER_EMAIL` but `email_verified: false` directly calls `setDoc(doc(db, 'appState/ownerSetup'), ...)` → **MUST FAIL (`PERMISSION_DENIED`)**.
  3. Unauthenticated `getDoc(doc(db, 'appState/ownerSetup'))` → **MUST FAIL (`PERMISSION_DENIED`)**.
  4. Verified configured owner on Option B (or server-provisioned under Option A) completes initial setup → **MUST SUCCEED**, and a subsequent second create attempt → **MUST FAIL**.
- **Server Vitest (`server.test.ts`):**
  - `POST /api/auth/verify-owner` with `OWNER_EMAIL=owner@caremart.com` rejects `other@caremart.com` with `403`, rejects `emailVerified: false` with `403`, and fails closed (`503`) when `OWNER_GATE_SECRET` or `OWNER_EMAIL` is missing in `NODE_ENV=production`.

### 1.7 Rollback Procedure
1. Restore previous `firestore.rules` revision from Firebase Console Rules History (or backup file) via `deploy_firebase`.
2. Revert `server.ts` / `AuthContext.tsx` / `shopService.ts` changes and redeploy previous container image.
3. No Firestore documents are mutated by deploying Option A or Option B rules for an already-initialized shop.

### 1.8 Production Configuration and Manual Actions
1. **Verify before choosing Option A vs Option B:** Confirm in Firebase Console whether `appState/ownerSetup` already exists in database `ai-studio-36596f53-ce10-4ba0-aae2-9d7f9051d6fe`.
2. Provision production secrets:
   - `OWNER_EMAIL` (exact shop owner email)
   - `OWNER_GATE_SECRET` (`openssl rand -hex 32`)
   - *(If Option A)* Ensure Cloud Run runtime service account has Cloud Datastore User IAM role (or provide `FIREBASE_SERVICE_ACCOUNT_JSON`).
   - *(If Option B)* Compute SHA-256 of lowercased `OWNER_EMAIL` and embed into `firestore.rules` before running `deploy_firebase` (and verify `expectedOwnerEmailSha256()` is not a placeholder).

---

<a id="43-encryption-secret-enforcement-and-legacy-credential-migration"></a>
## 2. §4.3 Encryption Secret Enforcement and Legacy Credential Migration

### 2.1 Exact Implementation Approach and Affected Files

#### Verified Current Storage & Encryption Facts
- `server/googleSheetsService.ts:39–48, 348–378`: Encrypts Google Service Account JSON to `.caremart-secrets/sa_<sha256(uid)[:24]>.enc.json` (`v: 1`, AES-256-GCM) using `SHA-256('caremart-service-account-vault:v1:' + (SERVICE_ACCOUNT_ENCRYPTION_KEY || OWNER_GATE_SECRET || 'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'))`.
- `server/discordNotifier.ts:54–63, 400–424`: Encrypts Discord Webhook URL to `.caremart-secrets/discord_<sha256(shopId)[:24]>.enc.json` (`v: 1`, AES-256-GCM) using the exact same fallback chain with prefix `'caremart-discord-webhook-vault:v1:'`.
- `server.ts:86–93`: `SESSION_SECRET` falls back to `SHA-256('${OWNER_GATE_SECRET}:${firebaseConfig.projectId}:session')`.
- **Verified workspace state:** `.caremart-secrets/` **does not exist** in the workspace container right now. In Cloud Run deployments without a persistent volume mount, the container filesystem is **ephemeral**: any file under `.caremart-secrets/` is wiped whenever a Cloud Run revision deploys, scales to zero, or replaces an instance!

#### Honest Reality Regarding Existing Encrypted Credentials (No Silent Recovery Assumption)
1. **Scenario 1 — Credentials configured via Environment Variables (`GOOGLE_SERVICE_ACCOUNT_JSON`, `DISCORD_WEBHOOK_URL`):**
   - Plaintext env/Secret-Manager values bypass `.caremart-secrets/*.enc.json` completely and remain **100% accessible** across restarts and encryption key changes.
2. **Scenario 2 — Credentials saved via Settings UI to `.caremart-secrets/*.enc.json` on an Ephemeral Cloud Run Container:**
   - **Cannot be preserved across a container restart/redeploy** unless `.caremart-secrets` is mounted on persistent storage (e.g., Cloud Run Volume / Cloud Storage FUSE / Filestore) OR migrated into a durable backend store (encrypted envelope in Cloud Secret Manager or Firestore). Rebuilding/redeploying a stateless Cloud Run container wipes `.caremart-secrets/`—no key migration code can recover a deleted container file!
3. **Scenario 3 — Existing `.caremart-secrets/*.enc.json` files DO exist on persistent storage or live disk:**
   - AES-256-GCM **only** decrypts if we possess the **exact seed** that was active when that file was encrypted (`SERVICE_ACCOUNT_ENCRYPTION_KEY`, `OWNER_GATE_SECRET`, or `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'`).
   - If an unknown ad-hoc secret was previously used and lost, decryption will **fail explicitly** (`Unsupported state or unable to authenticate data`). We **never** silently swallow, delete, or overwrite failed vault files.

#### Exact Implementation Design
1. **Separate Keyring & HKDF-SHA256 `v: 2` Envelope (`server/googleSheetsService.ts`, `server/discordNotifier.ts`):**
   - **Primary write key:** Strictly derived from `process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY` (must be `>= 32` chars and distinct from `OWNER_GATE_SECRET` and `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'`) via `crypto.hkdfSync('sha256', primaryKey, salt, info, 32)`.
   - **Production fail-closed enforcement (`NODE_ENV === 'production'`):**
     - Refuse to encrypt/save new vaults (`503`) if `SERVICE_ACCOUNT_ENCRYPTION_KEY` is missing, `< 32` chars, or matches the legacy default literal.
     - Refuse to sign session cookies with weak defaults: require `SESSION_SECRET` (`>= 32` chars) in production (or fail startup cleanly with explicit log error rather than forging weak cookies).
2. **Explicit Multi-Key Migration Chain (`readServiceAccountFromVault`, `readWebhookFromVault`):**
   - Candidate decryption keys tried strictly in order:
     1. Current `SERVICE_ACCOUNT_ENCRYPTION_KEY` (`v: 2` HKDF if `envelope.v === 2`, else `v: 1` SHA-256)
     2. Explicit comma-separated `LEGACY_ENCRYPTION_KEYS` (`v: 1` SHA-256)
     3. Explicit `LEGACY_OWNER_GATE_SECRET` or current `OWNER_GATE_SECRET` (`v: 1` SHA-256)
     4. **Strictly gated legacy default:** `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'` is ONLY attempted when `process.env.ALLOW_LEGACY_FALLBACK_DECRYPT === 'true'` during an explicit migration window!
   - **Safe Re-Encryption with Immutable `.v1.bak` Backup:**
     - If decryption succeeds with a legacy/fallback key AND `SERVICE_ACCOUNT_ENCRYPTION_KEY` is configured:
       1. Validate decrypted JSON/URL schema completely first.
       2. Copy original ciphertext to `<vaultPath>.v1.bak.<timestamp>` (`0600` permissions) if not already backed up.
       3. Write new `v: 2` envelope atomically via `<vaultPath>.tmp.<pid>` → `renameSync(<tmp>, <vaultPath>)`.
     - If **all** candidate keys fail GCM tag verification:
       - Do **not** delete or modify the `.enc.json` file.
       - Return structured status `'decrypt_failed'` (`VAULT_DECRYPT_KEY_MISMATCH`) surfaced clearly in Settings UI + `/api/admin/sheets/status` + `/api/health`, instructing the operator either to supply the original key in `LEGACY_ENCRYPTION_KEYS` or re-save the credential in Settings.
3. **Optional Durable Cloud Run Persistence Upgrade (Recommended Follow-Up):**
   - Document option to store the `v: 2` AES-256-GCM ciphertext envelope inside Firestore (`shops/{shopId}/serverVault/{type}`, `allow read, write: if false;` for ALL client SDKs—readable/writable ONLY by `server.ts` via Firebase Admin / Service Account!) while keeping `SERVICE_ACCOUNT_ENCRYPTION_KEY` strictly in Cloud Run Secrets. That way Cloud Run cold restarts never lose Settings-saved credentials AND Firestore admins/clients still cannot read plaintext or even ciphertext!

#### Affected Files
- `server/googleSheetsService.ts` (`getVaultEncryptionKey`, `readServiceAccountFromVault`, `saveServiceAccountToVault`)
- `server/discordNotifier.ts` (`getVaultEncryptionKey`, `readWebhookFromVault`, `saveWebhookToVault`)
- `server.ts` (`OWNER_GATE_SECRET`, `SESSION_SECRET`, startup secret validation, `/api/health` non-secret key/vault health flags)
- `.env.example` (document `SERVICE_ACCOUNT_ENCRYPTION_KEY`, `SESSION_SECRET`, `LEGACY_ENCRYPTION_KEYS`, `ALLOW_LEGACY_FALLBACK_DECRYPT`)

### 2.2 Data Integrity Guarantees
- **Authenticated Encryption Integrity:** AES-256-GCM 128-bit authentication tag guarantees corrupted or wrong-key ciphertext is rejected before JSON parsing; corrupted files are never silently treated as empty or overwritten.
- **Atomic Writes + Pre-Rotation Backups:** Writing to `.tmp` + `fs.renameSync` prevents half-written vault files during crashes; `.v1.bak` preserves exact pre-migration ciphertext for deterministic rollback.

### 2.3 Concurrency and Failure Handling
- **Concurrent Reads/Migrations:** Protect in-process migration of a given vault path with a `Map<string, Promise<...>>` per-file lock so two concurrent requests on boot do not race creating `.v1.bak` or renaming `.tmp` simultaneously.
- **Startup Failure Mode:** If `SESSION_SECRET` or `SERVICE_ACCOUNT_ENCRYPTION_KEY` is missing in production, surface deterministic HTTP `503` on vault save/auth rather than crashing the whole read-only health check or silently downgrading cryptography.

### 2.4 Backward Compatibility
- Existing `v: 1` vaults encrypted under `OWNER_GATE_SECRET` or the legacy fallback remain 100% readable during the controlled migration window (`ALLOW_LEGACY_FALLBACK_DECRYPT=true` + `LEGACY_ENCRYPTION_KEYS`) and upgrade automatically to `v: 2`.
- Env-var credentials (`GOOGLE_SERVICE_ACCOUNT_JSON`, `DISCORD_WEBHOOK_URL`) remain 100% compatible with zero changes.

### 2.5 Firestore Rules and Permissions
- **No Firestore rules changes required** for disk vault migration.
- *(Only if the optional Cloud Run–durable server-only Firestore vault envelope is approved later)*: add `match /serverVault/{vaultId} { allow read, write: if false; }` under `shops/{shopId}` so client SDK access is completely blocked.

### 2.6 Emulator and Regression Tests
- **Vitest Unit Tests (`server/googleSheetsService.test.ts`, `server/discordNotifier.test.ts`):**
  1. Legacy `v: 1` vault encrypted with default literal → read with `SERVICE_ACCOUNT_ENCRYPTION_KEY=<new>` and `ALLOW_LEGACY_FALLBACK_DECRYPT=true` → verifies successful decrypt, `.v1.bak` created, primary file upgraded to `v: 2`, and re-read succeeds with `ALLOW_LEGACY_FALLBACK_DECRYPT=false`.
  2. Wrong key decrypt (`LEGACY_ENCRYPTION_KEYS` wrong, `ALLOW_LEGACY_FALLBACK_DECRYPT=false`) → returns `'decrypt_failed'` (`VAULT_DECRYPT_KEY_MISMATCH`), original ciphertext file **untouched**.
  3. `NODE_ENV=production` with missing/short `SERVICE_ACCOUNT_ENCRYPTION_KEY` → `saveServiceAccountForOwner` / `saveDiscordWebhookForOwner` throws explicit config error without writing weak ciphertext.

### 2.7 Rollback Procedure
1. Keep `.caremart-secrets/*.v1.bak` backups and old `SERVICE_ACCOUNT_ENCRYPTION_KEY` / `OWNER_GATE_SECRET` recorded securely before rotation.
2. To roll back:
   - Restore `.v1.bak` over `.enc.json` (if any client/code downgrade occurs) AND restore previous `SERVICE_ACCOUNT_ENCRYPTION_KEY` / `OWNER_GATE_SECRET` / `SESSION_SECRET` env vars in Cloud Run.
   - Re-entering credentials in Settings UI or setting `GOOGLE_SERVICE_ACCOUNT_JSON` / `DISCORD_WEBHOOK_URL` env vars directly also restores integrations immediately.

### 2.8 Production Configuration and Manual Actions
1. **Check live production state BEFORE migration:** Verify whether `.caremart-secrets/` currently holds files in the running Cloud Run instance or whether credentials are injected via `GOOGLE_SERVICE_ACCOUNT_JSON` / `DISCORD_WEBHOOK_URL` secrets.
2. **Generate independent 32-byte secrets** (`openssl rand -hex 32`) for `SERVICE_ACCOUNT_ENCRYPTION_KEY`, `SESSION_SECRET`, and `OWNER_GATE_SECRET` and store backups in a secure password manager / GCP Secret Manager.
3. **Two-phase rollout:**
   - **Step 1:** Deploy with new secrets + `ALLOW_LEGACY_FALLBACK_DECRYPT=true` (and `LEGACY_ENCRYPTION_KEYS` if any custom key existed previously). Trigger `/api/admin/sheets/status` and `/api/health?probe=discord` as Owner to migrate any disk vaults to `v: 2`.
   - **Step 2:** Remove `ALLOW_LEGACY_FALLBACK_DECRYPT` and `LEGACY_ENCRYPTION_KEYS` once migrated, and strongly consider configuring `GOOGLE_SERVICE_ACCOUNT_JSON` / `DISCORD_WEBHOOK_URL` in Cloud Run Secrets (or persistent volume) so container restarts never wipe credentials.

---

<a id="53-fifo-allocation-recording-restoration-and-500-write-budget-proof"></a>
## 3. §5.3 FIFO Allocation Recording, Restoration, and 500-Write Budget Proof

### 3.1 Exact Implementation Approach and Affected Files

#### Exact Current Write Inventory & Truncation Bug
Verified in `src/services/shopService.ts` and `src/services/staffService.ts`:
- `createSale()` (`shopService.ts:2486`) slices `fifo.allocations.slice(0, 50)`.
- `editSale()` (`shopService.ts:2900`) slices `fifo.allocations.slice(0, 50)`.
- `reconcileStaffSaleToOwnerLedger()` (`staffService.ts:1114`) slices `fifo.allocations.slice(0, 50)`.
- `firestore.rules:578` caps `batchAllocations.size() <= 50`.
- Meanwhile, `allocateFifoFromBatches()` (`src/utils/packaging.ts:701`) deducts from **every** batch it touches (`> 50` batches if a line spans many micro-batches). Batches 51+ are deducted in `inventoryBatches` (`line 2521`), never recorded on `saleItems`, and therefore **never restored** by `editSale()` (`lines 2794–2802`) or `cancelSale()` (`lines 3093–3098`, `3175–3183`).

#### Exact Implementation: Overflow Subcollection + Pre-Commit 500-Write Budget Guard
1. **Inline + Deterministic Overflow Chunks (`saleItemAllocations`):**
   - **Normal sales (`allocations.length <= 50`):** Stored identically inline on `saleItems/{itemId}.batchAllocations` (`allocationsStorageMode` omitted or `'inline'`). **Zero extra reads or writes.**
   - **High-batch sales (`allocations.length > 50`):**
     - Store allocations `0..49` inline in `saleItems/{itemId}.batchAllocations` (keeping fast compatibility), set:
       - `allocationsStorageMode: 'chunked'`
       - `allocationChunkCount: K` (where $K = \lceil (\text{allocations.length} - 50) / 150 \rceil$)
       - `totalAllocationCount: allocations.length`
     - Write deterministic overflow chunk docs at `shops/{shopId}/saleItemAllocations/${saleItemId}_c${chunkIdx}` (`chunkIdx = 0..K-1`, max `150` allocations/chunk ≈ 18 KB/doc, safely under 1 MiB):
       ```ts
       {
         ownerUid: string,
         saleId: string,
         saleItemId: string,
         chunkIndex: number,
         allocations: BatchAllocation[], // 1..150 items
         createdAt: Timestamp
       }
       ```
     - **Why deterministic doc IDs (`${saleItemId}_c${chunkIdx}`) are critical:** Inside `editSale()` and `cancelSale()`, because `allocationChunkCount` is stored on `saleItem`, the transaction can call `tx.get(shopDoc(uid, 'saleItemAllocations', `${item.id}_c${idx}`))` **inside `runTransaction`** (Firestore transactions allow `tx.get` on document refs, not collection queries!), guaranteeing serializable, race-free reading of 100% of allocations!
2. **Hard Pre-Commit Firestore 500-Write Transaction Budget Check:**
   - Before executing any `tx.set` / `tx.update` / `tx.delete`, compute the exact write count $W$ for the transaction (see proof in §3.2) and enforce $W \le 480$ (leaving 20 writes headroom below Firestore's 500-write hard transaction limit).
   - If $W > 480$, abort **atomically inside Phase 1/2 before any writes** with a clear error indicating the exact cart/batch count limit so zero partial inventory deduction ever occurs.

#### Affected Files
- `src/types/shop.ts` (`SaleItem`, new `SaleItemAllocationChunk`)
- `src/utils/packaging.ts` (`allocateFifoFromBatches` — assert/deduplicate 1 entry per `batchId`)
- `src/services/shopService.ts`:
  - `createSale()` (lines 2385–2580)
  - `editSale()` (lines 2700–3010)
  - `cancelSale()` (lines 3073–3230)
  - New helpers: `computeSaleWriteBudget()`, `loadSaleItemAllocationsTransactional()`
- `src/services/staffService.ts`:
  - `reconcileStaffSaleToOwnerLedger()` (lines 955–1170)
- `firestore.rules`:
  - `isValidSaleItem` (lines 545–584) + `match /saleItems/{itemId}` `affectedKeys`
  - New `match /saleItemAllocations/{chunkId}`
- `firestore.indexes.json`:
  - Optional index on `saleItemAllocations` `(ownerUid ASC, saleId ASC)` for cleanup/audits

### 3.2 Data Integrity Guarantees — Complete Write Budget & Restoration Proof

#### Step 1: Exact Firestore Write Count Equations (Verified Against Code)
Let:
- `L` = number of cart / sale lines (`merged.size` / `newMap.size` / `items.length`)
- `P` = number of distinct product IDs (`runningStock.size` / updated products)
- `B` = number of distinct `inventoryBatches` updated (`batchMutations.size` / `batchRestoreAccum.size`)
- `D` = deleted `saleItems` docs in `editSale`
- `C_new` = overflow chunk docs created (`sum over i=1..L of ceil(max(0, allocs_i - 50) / 150)`)
- `C_old_del` = old overflow chunk docs deleted/replaced in `editSale`

Verified write operations per Firestore transaction:

| Operation | `sales` / `staffSales` | `saleItems` | `stockMovements` | `products` | `inventoryBatches` | `auditLogs` | `saleItemAllocations` | Total Writes `W` |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **`createSale()`** (`shopService.ts:2465–2575`) | `1` (`sales`) | `L` | `L` | `P` | `B` | `1` | `C_new` | `W_create = 2L + P + B + 2 + C_new` |
| **`reconcileStaffSaleToOwnerLedger()`** (`staffService.ts:984–1170`) | `2` (`sales` + `staffSales`) | `L` | `L` | `P` | `B` | `0` | `C_new` | `W_reconcile = 2L + P + B + 2 + C_new` |
| **`editSale()`** (`shopService.ts:2734–3020`) | `1` or `2` | `L + D` | `<= P` | `<= P` | `B_touched` (`<= B_old + B_new`) | `1` | `C_new + C_old_del` | `W_edit <= L + D + 2P + B_touched + 3 + C_new + C_old_del` |
| **`cancelSale()`** (`shopService.ts:3103–3229`) | `1` or `2` | `L_active` | `L_active` | `P` | `B_restored` | `1` | `0` (chunks left read-only) | `W_cancel <= 2L + P + B_restored + 3` |

*(Note: In `editSale()`, every batch modified during restoration OR new FIFO allocation is deduplicated into `batchMap` and written at most once at `shopService.ts:2963–2973`, so `B_touched <= B_old + B_new`.)*

#### Step 2: Proof That Every Deducted Batch Is Recorded and Restorable
1. **Completeness of Recording:** For every line `i`, `allocateFifoFromBatches()` produces unique-by-`batchId` allocations `A_i` matching `fifo.updatedBatches` 1-for-1:
   - `sum(a.consumedBaseQty for a in A_i) == sum(b.prevRemaining - b.nextRemaining for b in updatedBatches_i)`
   - Because `.slice(0, 50)` is removed and all entries of `A_i` are stored across `saleItems/{id}.batchAllocations[0..49]` plus deterministic overflow chunks `saleItemAllocations/${itemId}_c{0..K-1}` before `tx` finishes, **every** deducted `batchId` and exact `consumedBaseQty` is persisted atomically inside the same Firestore transaction that deducts `inventoryBatches`.
2. **Feasibility Guarantee Under Firestore's 500-Write Limit:**
   - Every distinct batch deducted requires `1` `tx.update(inventoryBatches/{batchId})`. Thus any valid transaction in Firestore **cannot** deduct more than `B_max < 500 - (2L + P + 2)` distinct batches regardless of storage layout.
   - With `150` allocations per overflow chunk, storing `B` allocations adds only `ceil(max(0, B - 50) / 150) <= 3` extra document writes—still leaving capacity for **~450+ batch allocations in a single atomic transaction** while strictly enforcing `W <= 480`!
   - **Important Edge Case for `cancelSale()` and `editSale()`:**
     - What if an `editSale()` restores `B_old = 260` old batches AND allocates `B_new = 260` mostly *disjoint* new batches (`B_touched > 480`)? The pre-commit budget check catches `W_edit > 480` cleanly before writing and instructs the owner to **cancel the sale and enter replacement sales**.
     - Crucially, **every sale that succeeded at `createSale()` (`W_create <= 480`) satisfies `W_cancel <= W_create + 1 <= 481 < 500`**, because `cancelSale()` writes **`0` overflow chunk docs** and restores at most the exact `B` batches that `createSale()` deducted (plus at most `+1` `staffSales` header update). Therefore **every recorded sale can ALWAYS be atomically cancelled and 100% restored in a single transaction!**

### 3.3 Concurrency and Failure Handling
- **Transactional Chunk Reads:** Inside `editSale` and `cancelSale`, `tx.get` fetches `saleRef`, `saleItems`, deterministic `saleItemAllocations/${id}_c${0..K-1}`, `products`, and **all** `inventoryBatches` referenced across both inline and chunk allocations. If another transaction modifies the sale or any batch concurrently, Firestore automatically aborts and retries the transaction with fresh snapshots.
- **Safety Assertion:** Before committing `createSale` / `editSale` / `reconcileStaffSaleToOwnerLedger`, verify `recordedCount === fifo.allocations.length` and `W <= 480`; throw an explicit descriptive error if violated.
- **Unbatched Overflow / Override Sales:** When `allowStockOverride` is used and active batches run out before `line.baseQuantity`, `fifo.allocations` equals only the actual batch quantities deducted; `cancelSale` restores `Math.min(batch.initialBaseQty, batch.remainingBaseQty + addQty)` safely.

### 3.4 Backward Compatibility
- **100% backwards-compatible:** All existing `saleItems` with `0..50` `batchAllocations` and without `allocationsStorageMode` or `allocationChunkCount` continue reading and restoring identically.
- No changes to existing `saleItems` data or APIs required.

### 3.5 Firestore Rules and Permissions

```rules
// Inside isValidSaleItem(data, shopId) (line 545+):
// Allow optional 'allocationsStorageMode', 'allocationChunkCount', 'totalAllocationCount' in hasOnly([...])
&& (!('batchAllocations' in data) || (data.batchAllocations is list && data.batchAllocations.size() <= 50 && (data.batchAllocations.size() == 0 || data.batchAllocations[0] is map)))
&& (!('allocationsStorageMode' in data) || data.allocationsStorageMode in ['inline', 'chunked'])
&& (!('allocationChunkCount' in data) || (data.allocationChunkCount is int && data.allocationChunkCount >= 0 && data.allocationChunkCount <= 20))
&& (!('totalAllocationCount' in data) || (data.totalAllocationCount is int && data.totalAllocationCount >= 0 && data.totalAllocationCount <= 2000))

// Also allow updating those 3 fields inside match /saleItems/{itemId} allow update affectedKeys list.

function isValidSaleItemAllocationChunk(data, shopId) {
  return data.keys().hasAll(['ownerUid', 'saleId', 'saleItemId', 'chunkIndex', 'allocations', 'createdAt'])
    && data.keys().hasOnly(['ownerUid', 'saleId', 'saleItemId', 'chunkIndex', 'allocations', 'createdAt'])
    && data.ownerUid is string && data.ownerUid == shopId && data.ownerUid.size() <= 128
    && isValidId(data.saleId)
    && isValidId(data.saleItemId)
    && data.chunkIndex is int && data.chunkIndex >= 0 && data.chunkIndex < 20
    && data.allocations is list && data.allocations.size() >= 1 && data.allocations.size() <= 150
    && data.allocations[0] is map
    && data.createdAt is timestamp;
}

match /saleItemAllocations/{chunkId} {
  allow get: if isOwner(shopId) && isValidId(chunkId) && (resource == null || (shopExists(shopId) && existing().ownerUid == shopId));
  allow list: if isOwner(shopId) && existing().ownerUid == shopId;
  allow create: if isOwner(shopId)
    && isValidId(chunkId)
    && chunkId == incoming().saleItemId + '_c' + string(incoming().chunkIndex)
    && isValidSaleItemAllocationChunk(incoming(), shopId)
    && incoming().createdAt == request.time
    && shopExists(shopId);
  allow update: if false; // Immutable chunks (new edits write/delete chunks explicitly)
  allow delete: if isOwner(shopId) && isValidId(chunkId) && shopExists(shopId) && existing().ownerUid == shopId;
}
```

### 3.6 Emulator and Regression Tests
1. **Vitest Service Tests (`src/services/financialTransactions.test.ts`):**
   - `createSale` consuming **120 batches** (`2` units each = `240` units) on 1 item + 5 normal items → verify `batchAllocations` holds 50, `saleItemAllocations/{itemId}_c0` holds 70, total recorded = 120, `W_create < 480`.
   - `cancelSale` on that 120-batch sale → assert **all 120** batches restore `remainingBaseQty` to exact pre-sale levels and `product.currentStock === sum(batches.remainingBaseQty)`.
   - `editSale` reducing quantity from 240 to 130 across those 120 batches → assert batches 51–120 restore cleanly.
   - `reconcileStaffSaleToOwnerLedger` spanning 80 batches → assert all 80 recorded across inline + chunk.
   - Massive cart spanning **485 write ops** → assert `createSale` aborts cleanly *before* mutating any product or batch (`0` partial stock changes).
2. **Firestore Emulator Rules Tests:**
   - Verify deterministic chunk ID enforcement (`${saleItemId}_c0`), max 150 entries/chunk, and staff denial on `saleItemAllocations`.

### 3.7 Rollback Procedure
1. Keep `saleItemAllocations` read permissions in `firestore.rules` even if rolling back client write code so any high-batch sale created while live can still be edited/cancelled cleanly.
2. Revert `shopService.ts` / `staffService.ts` only after confirming no active chunked sales require creation, or keep read-path fallback permanently.

### 3.8 Production Configuration and Manual Actions
1. Deploy updated `firestore.rules` (and `firestore.indexes.json` if optional `(ownerUid, saleId)` index is added) **before** deploying the client bundle.
2. Optionally run a read-only diagnostic check scanning historical `saleItems` where `batchAllocations.size() == 50` to identify if any past live sale was ever truncated before this fix.

---

<a id="71-co-occurrence-cache-above-2000-processed-sales"></a>
## 4. §7.1 Co-Occurrence Cache Scaling Beyond 2,000 Processed Sales

### 4.1 Exact Implementation Approach and Affected Files

#### Verified Current Flaws
- `shared/upsellCacheSchema.ts:2`: `MAX_PROCESSED_SALE_IDS = 2000`.
- `server/upsellCooccurrenceStore.ts:213–219, 273–275`: `applyCompletedSaleSync()` splices oldest entries out of `processedSaleIds` and `processedSet` once size `> 2000`. Replaying an evicted sale ID increments `totalCompletedSales`, `saleCountsByProduct`, and `pairCounts` a second time.
- `firestore.rules:848, 1607`: Enforces `processedSaleIds.size() <= 2000` and hardcodes `cacheId == 'cooccurrence_v2'`.
- `src/services/shopService.ts` (`cancelSale` / `editSale`): Currently does **not** decrement co-occurrence counts when a completed sale is cancelled.

#### Revised Architecture: Unbounded Per-Sale Idempotency Ledger (`upsellProcessedSales/{saleId}`) + Epoch-Versioned Matrix
To eliminate **every** fixed bucket ceiling (no 2,000-ID cap AND no 5,000-ID hash-bucket overflow ceiling!), separate the **hot aggregated matrix** from an **unbounded 1-doc-per-sale idempotency ledger**:

1. **Hot Aggregated Matrix (`shops/{shopId}/upsellCache/cooccurrence_v3`):**
   - Contains **zero unbounded ID arrays**:
     ```ts
     {
       ownerUid: string,
       version: 3,
       epoch: number,             // Incremented atomically on full rebuild
       revision: number,          // Monotonic matrix revision
       totalCompletedSales: number,
       saleCountsByProduct: Record<string, number>, // max 1000 keys
       pairCounts: Record<string, Record<string, number>>, // max 1000 outer x 40 inner
       createdAt: Timestamp,
       updatedAt: Timestamp
     }
     ```
   - Read once on session load / background sync by POS & Product Details (<80 KB doc, constant `O(1)` read regardless of whether the shop has `100` or `1,000,000` sales!).
2. **Unbounded Per-Sale Idempotency Ledger (`shops/{shopId}/upsellProcessedSales/{saleId}`):**
   - Each processed sale creates/updates **its own** tiny document (~250 bytes):
     ```ts
     {
       ownerUid: string,
       saleId: string,
       epoch: number,                   // Matches matrix.epoch when counted
       status: 'counted' | 'reverted',
       productIds: string[],            // Exact deduplicated productIds (max 40) counted into matrix
       updatedAt: Timestamp
     }
     ```
   - **Why `upsellProcessedSales/{saleId}` never overflows:** Even at `1,000,000` sales, every sale has its own independent 250-byte document (`O(1)` `get`), never hits any `5,000`-ID array limit or `1 MiB` Firestore document limit, and **never evicts historical deduplication records**!
   - **Why storing `productIds` enables exact `cancelSale` / `editSale` reversal:**
     - When `cancelSale(saleId)` completes asynchronously, the co-occurrence worker runs a Firestore transaction reading `upsellProcessedSales/{saleId}` and `cooccurrence_v3`. If `epoch === matrix.epoch && status === 'counted'`, it decrements `totalCompletedSales` (`-1`), `saleCountsByProduct[p]` (`-1`), and `pairCounts[a][b]` (`-1`) using those **exact** counted `productIds`, and flips `status: 'reverted'`.
3. **Serialized Concurrency (No Lost Updates Across Multiple Registers / Cloud Run Instances):**
   - All updates to `cooccurrence_v3` + `upsellProcessedSales/{saleId}` execute inside an **atomic Firestore transaction** (either via `runTransaction` from the client SDK or Firestore REST `:beginTransaction` + `:commit` in `server.ts`, or via server Admin SDK if enabled):
     - Inside the transaction: `tx.get(dedupRef)` and `tx.get(matrixRef)`.
     - If `dedupSnap.exists() && dedupSnap.epoch === matrix.epoch && dedupSnap.status === 'counted'`: **return `duplicate: true` immediately (zero double-counting!)**.
     - Otherwise, update `matrixRef` (`revision + 1`, counts updated) AND set `dedupRef` (`epoch: matrix.epoch, status: 'counted', productIds`) **in the exact same atomic transaction**!
   - **No more `.caremart-cache` split-brain authority:** Server memory/disk `.caremart-cache/` acts purely as an L1 read-through cache keyed by `(epoch, revision)` and refreshed from Firestore whenever `revision` advances—never as an independent counter that diverges across Cloud Run instances.
4. **Epoch-Safe Full Rebuilds Without Deleting Millions of Docs Atomically:**
   - When an owner runs a full rebuild:
     1. Read current `matrix.epoch` (e.g., `E`), compute `nextEpoch = E + 1`.
     2. Stream completed sales in paginated batches of `150`, accumulating the clean fresh matrix in memory (or staging snapshot).
     3. Commit `cooccurrence_v3` with `epoch: nextEpoch`, `revision: prevRevision + 1`, and fresh counts **while tagging batched `upsellProcessedSales/{saleId}` docs with `epoch: nextEpoch`** (using `writeBatch` chunks of `400` writes).
     4. Any old `upsellProcessedSales/{saleId}` doc still carrying `epoch < matrix.epoch` is automatically treated as "not yet counted in `nextEpoch`" (never blocking a rebuild AND never requiring deletion of all historical docs before swap!). Meanwhile, concurrent live sales occurring during rebuild target `matrix.epoch` cleanly via `runTransaction` idempotency.

#### Affected Files
- `shared/upsellCacheSchema.ts` (`COOCCURRENCE_CACHE_VERSION = 3`, `UpsellProcessedSaleDoc`, `CooccurrenceSnapshot`)
- `server/upsellCooccurrenceStore.ts` (L1 cache keyed by `(epoch, revision)`, remove 2,000-ID eviction counter mutation, support Firestore transactional sync)
- `server.ts` (`GET /api/upsell/cooccurrence`, `POST /api/upsell/cooccurrence/update`, `POST /api/upsell/cooccurrence/rebuild`, new `POST /api/upsell/cooccurrence/cancel`)
- `src/services/upsellCooccurrenceService.ts` (transactional `upsellProcessedSales/{saleId}` + `cooccurrence_v3` updates, async `enqueueSaleCooccurrenceReversal`, paginated epoch rebuild)
- `src/services/shopService.ts` (`cancelSale()` asynchronously fires `enqueueSaleCooccurrenceReversal` post-commit)
- `firestore.rules` (`isValidUpsellCooccurrenceCache`, `isValidUpsellProcessedSale`, `match /upsellCache/{cacheId}`, `match /upsellProcessedSales/{saleId}`)

### 4.2 Data Integrity Guarantees
- **Zero Silent Eviction:** Every processed sale ID persists permanently in `upsellProcessedSales/{saleId}` with no array cap (`MAX_PROCESSED_SALE_IDS` limit removed).
- **Exact Idempotency & No Lost Updates:** Atomic `runTransaction` over `(matrixRef, dedupRef)` guarantees that concurrent retries, multi-device offline flushes, and duplicate API requests can increment a given `saleId` at most **once per epoch**, and concurrent distinct sales serialize cleanly without overwriting each other's counts.
- **Cancellation Consistency:** Cancelled sales cleanly reverse their exact counted pairs without requiring a full rebuild.

### 4.3 Concurrency and Failure Handling
- **Transaction Contention Backoff:** Under heavy multi-register load (`> 5` concurrent writes/sec to the single `cooccurrence_v3` doc), Firestore `runTransaction` retries automatically up to 5 times; any residual contention falls back into `upsellCooccurrenceService.ts`'s existing durable offline retry queue (`cm_upsell_pending_updates_*`) with exponential backoff, never affecting POS checkout speed.
- **Permission Note for Staff Registers:** Since `staffCanAddSales(shopId)` staff should not directly rewrite the shop-wide `cooccurrence_v3` matrix from client SDK if untrusted:
  - **Recommended:** Staff checkout submits `POST /api/upsell/cooccurrence/update` and `server.ts` executes the transaction using Firebase Admin / Owner-delegated service credentials (justifies `firebase-admin` / server ADC!), OR staff writes an append-only `upsellPendingSales/{saleId}` marker (`allow create`) that owner/server drains transactionally! Wait—if `firebase-admin` / server ADC is unavailable, owner reconciliation (`reconcileStaffSaleToOwnerLedger`, which already runs for every staff sale!) already reconciles staff sales into the owner ledger and can invoke the transactional co-occurrence write cleanly under Owner credentials! Let's highlight this verified synergy!

### 4.4 Backward Compatibility
- Bumping `COOCCURRENCE_CACHE_VERSION` to `3` (`cooccurrence_v3`) cleanly avoids schema collisions with legacy `cooccurrence_v2` docs while keeping `cooccurrence_v2` readable during transition.
- A one-time owner background backfill rebuilds `cooccurrence_v3` + `upsellProcessedSales/*` from authoritative `sales` (`status == 'completed'`) and `saleItems`.

### 4.5 Firestore Rules and Permissions

```rules
function isValidUpsellCooccurrenceCacheV3(data, shopId) {
  return data.keys().hasAll([
      'ownerUid', 'version', 'epoch', 'revision', 'totalCompletedSales',
      'saleCountsByProduct', 'pairCounts', 'createdAt', 'updatedAt'
    ])
    && data.keys().hasOnly([
      'ownerUid', 'version', 'epoch', 'revision', 'totalCompletedSales',
      'saleCountsByProduct', 'pairCounts', 'createdAt', 'updatedAt'
    ])
    && data.ownerUid == shopId
    && data.version == 3
    && data.epoch is int && data.epoch >= 1
    && data.revision is int && data.revision >= 0
    && data.totalCompletedSales is int && data.totalCompletedSales >= 0
    && data.saleCountsByProduct is map && data.saleCountsByProduct.size() <= 1000
    && data.pairCounts is map && data.pairCounts.size() <= 1000
    && data.createdAt is timestamp
    && data.updatedAt is timestamp;
}

function isValidUpsellProcessedSale(data, shopId, saleId) {
  return data.keys().hasAll(['ownerUid', 'saleId', 'epoch', 'status', 'productIds', 'updatedAt'])
    && data.keys().hasOnly(['ownerUid', 'saleId', 'epoch', 'status', 'productIds', 'updatedAt'])
    && data.ownerUid == shopId
    && data.saleId == saleId
    && data.epoch is int && data.epoch >= 1
    && data.status in ['counted', 'reverted']
    && data.productIds is list && data.productIds.size() <= 40
    && data.updatedAt is timestamp;
}

match /upsellCache/{cacheId} {
  allow get: if isValidId(cacheId)
    && cacheId in ['cooccurrence_v2', 'cooccurrence_v3']
    && ((isOwner(shopId) && (resource == null || existing().ownerUid == shopId))
        || (staffCanAddSales(shopId) && shopExists(shopId) && (resource == null || existing().ownerUid == shopId)));
  allow list: if false;
  allow create, update: if isOwner(shopId) && shopExists(shopId) && ...;
  allow delete: if isOwner(shopId) && shopExists(shopId) && existing().ownerUid == shopId;
}

match /upsellProcessedSales/{saleId} {
  allow get: if isOwner(shopId) && isValidId(saleId) && (resource == null || existing().ownerUid == shopId);
  allow list: if isOwner(shopId) && existing().ownerUid == shopId;
  allow create, update: if isOwner(shopId)
    && isValidId(saleId)
    && isValidUpsellProcessedSale(incoming(), shopId, saleId)
    && incoming().updatedAt == request.time
    && shopExists(shopId);
  allow delete: if isOwner(shopId) && isValidId(saleId) && shopExists(shopId);
}
```

### 4.6 Emulator and Regression Tests
1. **Scale & Replay Tests (`upsellCooccurrenceService.test.ts` / `upsellCooccurrenceStore.test.ts`):**
   - Process `6,000` distinct completed sales → assert `totalCompletedSales === 6000` and 6,000 `upsellProcessedSales/*` markers exist.
   - Replay sales `#1`, `#2500`, `#5999` concurrently → assert `totalCompletedSales` remains `6000` (0 duplicates).
   - Cancel sale `#1` → assert `upsellProcessedSales/sale_1.status === 'reverted'`, `totalCompletedSales === 5999`, and pair counts decrement accurately; re-running cancel is a no-op.
   - Concurrent `Promise.all` of 10 distinct sales via transactional mock → assert all 10 reflected (`totalCompletedSales === 6009`, zero lost updates).
2. **Emulator Rules Tests:**
   - Verify `staffCanAddSales` can read `cooccurrence_v3` but **cannot** tamper with `cooccurrence_v3` or `upsellProcessedSales/*` directly.

### 4.7 Rollback Procedure
1. Keep `cooccurrence_v2` untouched during `v3` rollout; rolling back `COOCCURRENCE_CACHE_VERSION` to `2` in client/server restores previous behavior immediately.
2. Delete/ignore `upsellProcessedSales` cleanly without affecting `sales` or `saleItems`.

### 4.8 Production Configuration and Manual Actions
1. Deploy updated `firestore.rules`.
2. Deploy updated app build.
3. Have Owner trigger one-time background rebuild from Settings/Dashboard if historical sales exist so `cooccurrence_v3` and `upsellProcessedSales/*` populate from `sales` + `saleItems`.

---

<a id="8-atomic-and-idempotent-feedback-storage-migration-to-firestore"></a>
## 5. §8 Atomic and Idempotent Feedback Storage Migration to Firestore

### 5.1 Exact Implementation Approach and Affected Files

#### Verified Current Flaws
- `server/upsellFeedbackStore.ts:13–29, 121–294`: Stores `UpsellFeedbackSnapshot` + `processedEventIds` strictly in `.caremart-cache/feedback_v1_<hash>.json` on the ephemeral container disk.
- `server.ts:2179–2310`: `GET /api/upsell/feedback` and `POST /api/upsell/feedback` never read from or persist to Firestore. Restarts wipe learned acceptance/dismissal penalties, and multiple Cloud Run instances maintain divergent local files.
- **Why naive shared-doc updates break:** If multiple staff/owner devices read `feedback_v1`, increment locally, and write back the full `productStats` / `categoryPairStats` maps, concurrent requests silently overwrite each other's counters (**lost-update race**)!

#### Genuinely Atomic, Idempotent, Zero-Overwrite Architecture: Append-Only Deduplicated Event Ledger + Owner-Authoritative Transactional Folding (With Real-Time Optional Atomic Increment)

We recommend **Pattern B (Two-Layer Event Ledger + Transactional Folding)** as primary—and detail **Pattern A** as an alternative if instant cross-device counter reflection via staff token is required without server Admin SDK:

##### Pattern B (Recommended — Zero Staff Overwrite Risk + 100% Atomic & Idempotent)
1. **Immutable, Idempotent Event Creation (`shops/{shopId}/upsellFeedbackEvents/{eventId}`):**
   - Client (`upsellFeedbackService.ts`) generates a deterministic or unique `eventId` per discrete UX action (e.g., `fb_${actorUidSlice}_${cartSessionId}_${productId}_${eventType}_${seq}`, valid `^[a-zA-Z0-9_.:-]{8,128}$`).
   - `POST /api/upsell/feedback` (or direct Firestore SDK for offline-queued flush) validates product ownership (`products`/`staffCatalog`), then executes a **create-only** Firestore write on `shops/{shopId}/upsellFeedbackEvents/{eventId}` (REST `PATCH` with `currentDocument.exists=false` / SDK `runTransaction` `!snap.exists()`):
     ```ts
     {
       ownerUid: string,
       eventId: string,
       actorUid: string,
       actorRole: 'owner' | 'staff',
       productId: string,
       eventType: 'shown' | 'accepted' | 'dismissed' | 'removed_after_add',
       categoryKey: string,
       anchorCategoryKeys: string[], // max 10
       folded: boolean,              // starts false (or folded in same tx if server/owner)
       createdAt: Timestamp
     }
     ```
   - **Idempotency & Concurrency Proof:**
     - Firestore guarantees `currentDocument: { exists: false }` (or `allow create` with `allow update: if false` for staff) succeeds **at most once per `eventId`** across all Cloud Run instances and browser retries.
     - Replaying the same `eventId` fails with `409 ALREADY_EXISTS`, which `POST /api/upsell/feedback` converts cleanly into `{ ok: true, duplicate: true }`—**zero duplicate counting ever**!
     - Because two concurrent staff requests create **distinct document IDs** (`fb_staffA_...` vs `fb_staffB_...`), **two staff members can NEVER overwrite or contend with each other**!
2. **Atomic Transactional Folding into `shops/{shopId}/upsellCache/feedback_v1`:**
   - **If caller is Owner** (or **if server uses Firebase Admin / Service Account credentials**): `POST /api/upsell/feedback` (or a debounced background batch every 5–10s / on `GET`) folds all `folded == false` events inside a single Firestore `runTransaction`:
     - Reads `feedback_v1` + up to `50` unfolded `upsellFeedbackEvents` docs (`folded == false`).
     - Inside `runTransaction`: re-checks `eventSnap.data().folded === false`, increments `productStats[pid][metric]` and `categoryPairStats[pair][metric]` + `revision`, sets `eventSnap.folded = true`, and caps `productStats` (`<= 500` LRU) and `categoryPairStats` (`<= 400` LRU) cleanly.
   - **If caller is Staff (and no server Admin SDK is configured):**
     - Staff `POST /api/upsell/feedback` atomically creates `upsellFeedbackEvents/{eventId}` (`folded: false`) and returns `202` / `200` with optimistic local mirror increment so the staff UI updates immediately.
     - Whenever **any** Owner dashboard/session runs (or via existing background reconciliation alongside `reconcileStaffSaleToOwnerLedger`), pending `folded == false` events are atomically folded into `feedback_v1` via `runTransaction`!
   - *(Compare **Pattern A** if instant staff-to-staff global sync without Admin SDK is required: inside a single Firestore REST `:commit` batch, execute Write #1 `create` `upsellFeedbackEvents/{eventId}` (`exists: false` precondition) + Write #2 `transform` `FieldValue.increment(1)` on `productStats.<pid>.<field>`, `categoryPairStats.<pair>.<field>`, `revision`—requires Firestore rules verifying `incoming().revision == existing().revision + 1` and forbidding key deletions by staff, which still needs periodic owner LRU pruning once `productStats.size()` nears `500`. **Pattern B** has cleaner rules and zero map-key-limit contention!)*

#### Affected Files
- `shared/upsellCacheSchema.ts` (`UpsellFeedbackEventDoc`, `MAX_FEEDBACK_EVENT_IDS`, `UpsellFeedbackSnapshot`)
- `server/upsellFeedbackStore.ts` (demote disk `.caremart-cache/` to non-authoritative L1 cache keyed by `(shopId, revision)`)
- `server.ts` (`GET /api/upsell/feedback`, `POST /api/upsell/feedback` — Firestore REST `create` with `exists=false` + transactional folding when authorized, plus `POST /api/upsell/feedback/reconcile` for Owner)
- `src/services/upsellFeedbackService.ts` (hydrate from Firestore `feedback_v1` + unfolded events, durable `localStorage` offline queue with stable `eventId`s, owner folding hook)
- `src/contexts/ShopDataContext.tsx` (invoke `reconcileUnfoldedFeedbackEvents(shopId)` for Owner alongside `reconcileStaffSaleToOwnerLedger`)
- `firestore.rules` (`isValidUpsellFeedbackCache`, `isValidUpsellFeedbackEvent`, `match /upsellCache/{cacheId}`, `match /upsellFeedbackEvents/{eventId}`)
- `firestore.indexes.json` (composite index on `upsellFeedbackEvents` `(ownerUid ASC, folded ASC, createdAt ASC)`)

### 5.2 Data Integrity Guarantees
- **True Idempotency Beyond Memory & Container Life:** Because `eventId` uniqueness is enforced by Firestore document primary key (`upsellFeedbackEvents/{eventId}` with `exists: false` precondition), surviving container restarts, multi-instance scaling, and offline browser queue replays, **zero events are ever double-counted**.
- **Zero Lost Updates Under Concurrent Staff Activity:** Concurrent staff writes hit distinct `upsellFeedbackEvents/{eventId}` docs with zero contention; folding into `feedback_v1` runs exclusively inside serialized Firestore `runTransaction` checking `folded === false`.
- **Tamper Resistance:** Staff accounts can never decrement, reset, or overwrite `feedback_v1` counters.

### 5.3 Concurrency and Failure Handling
- **Two Staff Clicks Simultaneously:** Staff A creates `upsellFeedbackEvents/fb_A_1`; Staff B creates `upsellFeedbackEvents/fb_B_1`. Zero lock contention, zero overwrites.
- **Duplicate Replay / Network Retry:** Client retries `fb_A_1` after timeout → Firestore rejects second create with `409 ALREADY_EXISTS` → server/client treats `409` as idempotent success (`duplicate: true`) and drops the item from the pending retry queue.
- **Folding Race Between Two Owner Tabs:** Both tabs run `runTransaction` reading `folded === false` events and `feedback_v1`. Firestore aborts and retries the second tab, which sees `folded === true` on re-read and skips those events—guaranteeing exact `+1` count per event.
- **Offline POS Checkout:** Browser queues `{ eventId, ... }` in `localStorage` (`cm_upsell_feedback_pending_v1_*`) and flushes cleanly once online.

### 5.4 Backward Compatibility
- Existing `UpsellFeedbackSnapshot` shape (`productStats`, `categoryPairStats`, `revision`, `version: 1`) stays identical.
- On first upgrade, if local `.caremart-cache/feedback_v1_*.json` or browser mirror has counters while Firestore `feedback_v1` does not exist yet, an owner session seeds `feedback_v1` once safely (`create` if absent).

### 5.5 Firestore Rules and Permissions

```rules
function isValidUpsellFeedbackEvent(data, shopId, eventId) {
  return data.keys().hasAll([
      'ownerUid', 'eventId', 'actorUid', 'actorRole',
      'productId', 'eventType', 'folded', 'createdAt'
    ])
    && data.keys().hasOnly([
      'ownerUid', 'eventId', 'actorUid', 'actorRole',
      'productId', 'eventType', 'categoryKey', 'anchorCategoryKeys',
      'folded', 'createdAt'
    ])
    && data.ownerUid == shopId
    && data.eventId == eventId
    && data.actorUid == request.auth.uid
    && data.actorRole in ['owner', 'staff']
    && isValidId(data.productId)
    && exists(/databases/$(database)/documents/shops/$(shopId)/products/$(data.productId))
    && data.eventType in ['shown', 'accepted', 'dismissed', 'removed_after_add']
    && (!('categoryKey' in data) || (data.categoryKey is string && data.categoryKey.size() <= 80))
    && (!('anchorCategoryKeys' in data) || (data.anchorCategoryKeys is list && data.anchorCategoryKeys.size() <= 10))
    && data.folded is bool
    && data.createdAt is timestamp;
}

// In match /upsellFeedbackEvents/{eventId}:
match /upsellFeedbackEvents/{eventId} {
  allow get: if isValidId(eventId)
    && ((isOwner(shopId) && (resource == null || existing().ownerUid == shopId))
        || (staffCanAddSales(shopId) && resource != null && existing().actorUid == request.auth.uid));
  allow list: if isOwner(shopId) && existing().ownerUid == shopId;
  allow create: if eventId.matches('^[a-zA-Z0-9_.:-]{8,128}$')
    && shopExists(shopId)
    && isValidUpsellFeedbackEvent(incoming(), shopId, eventId)
    && incoming().createdAt == request.time
    && (
      (isOwner(shopId) && incoming().actorRole == 'owner') ||
      (staffCanAddSales(shopId) && incoming().actorRole == 'staff' && incoming().folded == false)
    );
  allow update: if isOwner(shopId)
    && shopExists(shopId)
    && existing().ownerUid == shopId
    && existing().folded == false
    && incoming().folded == true
    && incoming().diff(existing()).affectedKeys().hasOnly(['folded']);
  allow delete: if isOwner(shopId) && shopExists(shopId) && existing().ownerUid == shopId;
}

// feedback_v1 under match /upsellCache/{cacheId}:
// Readable by isOwner(shopId) || staffCanAddSales(shopId)
// Writable ONLY by isOwner(shopId) (or server Admin SDK if provisioned)
```

### 5.6 Emulator and Regression Tests
1. **Vitest Concurrency & Idempotency Tests (`upsellFeedbackService.test.ts` & `upsellFeedbackStore.test.ts`):**
   - Simulate 20 concurrent `POST /api/upsell/feedback` events from Staff A and Staff B + duplicate replay of 5 `eventId`s → assert `20` unique events folded, `0` overwritten counters, `0` duplicates counted.
   - Simulate server restart (clear memory + delete `.caremart-cache/`) → assert hydration restores exact counters from Firestore `feedback_v1` + unfolded events.
2. **Emulator Rules Tests:**
   - Staff creates `upsellFeedbackEvents/{id}` with `folded: false` → **SUCCEEDS**.
   - Staff attempts to update `upsellCache/feedback_v1` directly or forge `actorUid` / `actorRole: 'owner'` or `folded: true` → **FAILS (`PERMISSION_DENIED`)**.
   - Staff attempts to create duplicate `upsellFeedbackEvents/{id}` → **FAILS (`ALREADY_EXISTS` / `PERMISSION_DENIED` on update)**.

### 5.7 Rollback Procedure
1. Revert `server.ts`, `upsellFeedbackStore.ts`, and `upsellFeedbackService.ts` to disk-backed mode.
2. Revert `firestore.rules` (removing `upsellFeedbackEvents` and `feedback_v1` branch in `upsellCache`).
3. Existing `upsellFeedbackEvents` docs remain inert without touching any sales/inventory collections.

### 5.8 Production Configuration and Manual Actions
1. Deploy updated `firestore.rules` and `firestore.indexes.json` (`upsellFeedbackEvents` index `(ownerUid, folded, createdAt)`).
2. Deploy updated build.
3. Optional: Decide whether to add `firebase-admin` / Cloud Run Service Account so staff events fold immediately on the server instead of waiting for an owner session.

---

<a id="55-product-and-supplier-deletion-rules"></a>
## 6. §5.5 Product and Supplier Referential Deletion Rules

### 6.1 Exact Implementation Approach and Affected Files

#### Verified Current Gap
- Client app logic (`shopService.ts:1153–1200` `deleteSupplier()`, `1442–1541` `deleteProduct()`) already queries `inventoryBatches`, `saleItems`, `purchaseItems`, `products`, and `purchases` before deleting.
- **However, `firestore.rules:1244` (`suppliers`) and `1283` (`products`) only check ownership!**
- Crucially, checking only `currentStock == 0` in `firestore.rules` is **insufficient** to protect historical data: a product that was purchased, sold completely out (`currentStock == 0`), and has exhausted `inventoryBatches`, `saleItems`, `purchaseItems`, and `stockMovements` could still be hard-deleted via direct Firestore SDK/REST calls—damaging product lineage, batch provenance, restock links, and historical inventory audits! Similarly, a supplier linked to existing products or cancelled/paid purchases could be hard-deleted if only `outstandingBalance == 0` were checked.

#### Exact Implementation: Deterministic History Locks (`entityLocks` + Monotonic `hasTransactionHistory` Flag) Enforced in `firestore.rules`
Because Firestore Security Rules cannot run collection queries across `saleItems`/`purchaseItems`/`inventoryBatches`, enforce referential integrity deterministically inside `firestore.rules` using **both** intrinsic financial balances AND an **irreversible transaction-history lock**:

1. **Monotonic `hasTransactionHistory` Flag + Immutable `entityLocks/{lockId}` Subcollection:**
   - Whenever any transaction creates/links a record referencing a product or supplier:
     - **Product triggers:** `createPurchase()`, `createSale()`, `editSale()`, `adjustStock()`, `reconcileStaffSaleToOwnerLedger()`, `importHistoricalSaleToLedger()`.
       - Set `hasTransactionHistory: true` on `products/{productId}` **and** write an immutable marker doc `shops/{shopId}/entityLocks/prod_${productId}` (`{ ownerUid, entityType: 'product', entityId: productId, createdAt }`) inside the **exact same Firestore `runTransaction` / `writeBatch`**!
     - **Supplier triggers:** `createPurchase()`, `recordSupplierPayment()`, `createProduct()` (when `supplierId` is non-empty and linked to a supplier doc).
       - Set `hasTransactionHistory: true` on `suppliers/{supplierId}` **and** write immutable `shops/{shopId}/entityLocks/sup_${supplierId}`!
   - **Why BOTH `hasTransactionHistory` + `entityLocks`?**
     - `entityLocks` is **immutable (`allow update, delete: if false;`)** once created, so not even an owner token calling raw SDK `updateDoc` can clear `hasTransactionHistory` back to `false` and delete the historical record!
2. **Enforce Full Guard Conditions in `firestore.rules` (`allow delete`):**
   - **`products/{productId}` `allow delete`:**
     - `existing().currentStock == 0`
     - `(!('emptyContainersOnHand' in existing()) || existing().emptyContainersOnHand == 0)`
     - `existing().get('hasTransactionHistory', false) == false`
     - `!exists(/databases/$(database)/documents/shops/$(shopId)/entityLocks/prod_$(productId))`
     - `existing().isActive == false` *(recommended Archive-first policy, or confirmed toggle)*
   - **`suppliers/{supplierId}` `allow delete`:**
     - `existing().outstandingBalance == 0`
     - `existing().totalPurchased == 0`
     - `existing().totalPaid == 0`
     - `existing().get('hasTransactionHistory', false) == false`
     - `!exists(/databases/$(database)/documents/shops/$(shopId)/entityLocks/sup_$(supplierId))`
   - **`staffCatalog/{productId}` `allow delete`:**
     - Require parent `products/{productId}` either no longer exists OR satisfies `!exists(.../entityLocks/prod_$(productId))` and `currentStock == 0`, preventing orphaned staff catalog deletion on active historical products.
3. **Pre-Rule Mandatory Historical Backfill Script:**
   - Before deploying the `entityLocks` / `hasTransactionHistory` rule enforcement, run an idempotent owner-triggered migration script scanning `inventoryBatches`, `saleItems`, `purchaseItems`, `stockMovements`, `purchases`, `supplierPayments`, and `products` (for `supplierId` links) to create `entityLocks/prod_<id>` + `entityLocks/sup_<id>` and stamp `hasTransactionHistory: true` on every pre-existing historical product and supplier.

#### Affected Files
- `src/types/shop.ts` (`Product.hasTransactionHistory?: boolean`, `Supplier.hasTransactionHistory?: boolean`)
- `src/services/shopService.ts`:
  - `createPurchase()`, `createSale()`, `editSale()`, `adjustStock()`, `recordSupplierPayment()`, `createProduct()`, `updateProduct()` (stamp `hasTransactionHistory: true` + `entityLocks` inside existing transactions)
  - `deleteProduct()` (lines 1442–1541) and `deleteSupplier()` (lines 1153–1200) — keep full query guards + clear user messaging directing to Archive (`isActive: false`)
  - New idempotent helper: `backfillEntityHistoryLocks(uid)` (explicitly run once by owner before turning on strict lock enforcement if historical data exists)
- `src/services/staffService.ts`:
  - `reconcileStaffSaleToOwnerLedger()` (stamp `hasTransactionHistory: true` + `entityLocks/prod_${pid}` if not yet marked)
- `firestore.rules`:
  - `isValidProduct`, `isValidSupplier` (allow optional `hasTransactionHistory` boolean, immutable once `true`)
  - `match /products/{productId}` (`allow delete` + `allow update` immutability of `hasTransactionHistory == true`)
  - `match /suppliers/{supplierId}` (`allow delete` + `allow update` immutability of `hasTransactionHistory == true`)
  - `match /entityLocks/{lockId}` (`allow update, delete: if false;`)

### 6.2 Data Integrity Guarantees
- **Zero Orphaned Sales/Purchases/Batches/Financial Reports:** Even a direct Firestore SDK/REST delete request cannot delete any product or supplier with stock, balances, or transaction history once locked.
- **Irreversible Lock:** Because `entityLocks` forbids `update` and `delete`, and `hasTransactionHistory` forbids `true → false` transitions, an owner or compromised session cannot bypass deletion rules by resetting a flag first.
- **Safe Archival:** Historical SKUs can always be deactivated (`isActive: false`), hiding them from POS selection while preserving 100% of past invoices, COGS, supplier ledgers, and P&L reports.

### 6.3 Concurrency and Failure Handling
- **Concurrent First Purchase/Sale vs Delete Race:** If an owner opens Delete on an unused product while another action records a purchase/sale on it, `deleteDoc` runs concurrently with `createPurchase`/`createSale`. Writing `entityLocks/prod_${productId}` inside `createPurchase`/`createSale` forces Firestore's preconditions to block `delete` once committed; additionally, executing `deleteProduct` inside `runTransaction` (checking `tx.get(prodRef)` + `tx.get(lockRef)` alongside pre-queried checks) closes the last client-side TOCTOU window!
- **500-Write Budget Note:** Setting `hasTransactionHistory: true` on `products`/`suppliers` (which are already updated in `createSale`/`createPurchase`) adds `0` extra product writes; creating `entityLocks/prod_${id}` only happens if `!lockSnap.exists()` (at most once in the lifetime of a SKU, and accounted for in §5.3's 480-write budget!).

### 6.4 Backward Compatibility
- Products and suppliers created prior to migration without `hasTransactionHistory` still work seamlessly in all read/update/sale/purchase flows (`hasTransactionHistory` optional).
- `shopService.ts`'s existing `getDocs` referential checks continue protecting legacy products/suppliers even during the transition window prior to completing backfill.

### 6.5 Firestore Rules and Permissions

```rules
// Monotonic field helper: once true, cannot revert to false
// Inside match /products/{productId} allow update:
&& !(existing().get('hasTransactionHistory', false) == true && incoming().get('hasTransactionHistory', false) == false)

// Hardened delete on products (line 1283):
allow delete: if isOwner(shopId)
  && isValidId(productId)
  && shopExists(shopId)
  && existing().ownerUid == shopId
  && existing().currentStock == 0
  && (!('emptyContainersOnHand' in existing()) || existing().emptyContainersOnHand == 0)
  && existing().isActive == false
  && existing().get('hasTransactionHistory', false) == false
  && !exists(/databases/$(database)/documents/shops/$(shopId)/entityLocks/$( 'prod_' + productId ));

// Hardened delete on suppliers (line 1244):
allow delete: if isOwner(shopId)
  && isValidId(supplierId)
  && shopExists(shopId)
  && existing().ownerUid == shopId
  && existing().outstandingBalance == 0
  && existing().totalPurchased == 0
  && existing().totalPaid == 0
  && existing().get('hasTransactionHistory', false) == false
  && !exists(/databases/$(database)/documents/shops/$(shopId)/entityLocks/$( 'sup_' + supplierId ));

match /entityLocks/{lockId} {
  allow get, list: if isOwner(shopId) && existing().ownerUid == shopId;
  allow create: if isOwner(shopId)
    && isValidId(lockId)
    && (lockId.matches('^prod_.+') || lockId.matches('^sup_.+'))
    && incoming().keys().hasAll(['ownerUid', 'entityType', 'entityId', 'createdAt'])
    && incoming().keys().hasOnly(['ownerUid', 'entityType', 'entityId', 'createdAt'])
    && incoming().ownerUid == shopId
    && incoming().entityType in ['product', 'supplier']
    && isValidId(incoming().entityId)
    && incoming().createdAt == request.time
    && shopExists(shopId);
  allow update, delete: if false;
}
```

### 6.6 Emulator and Regression Tests
1. **Firestore Emulator Rules Tests:**
   - Direct `deleteDoc` on product with `currentStock: 10` → **FAILS**.
   - Direct `deleteDoc` on zero-stock product (`currentStock: 0`, `isActive: false`) that has `hasTransactionHistory: true` or `entityLocks/prod_<id>` → **FAILS (`PERMISSION_DENIED`)**.
   - Direct attempt to flip `hasTransactionHistory: true → false` or delete `entityLocks/prod_<id>` → **FAILS (`PERMISSION_DENIED`)**.
   - Direct `deleteDoc` on supplier with `outstandingBalance: 0, totalPurchased: 0, totalPaid: 0` but `entityLocks/sup_<id>` present (or `totalPurchased: 100`) → **FAILS**.
   - Direct `deleteDoc` on genuinely unused archived product (`currentStock: 0, isActive: false, hasTransactionHistory: false`, no lock) → **SUCCEEDS**.
2. **Vitest Service Tests (`financialTransactions.test.ts`):**
   - `createPurchase` / `createSale` stamps `hasTransactionHistory: true` and creates `entityLocks`; subsequent `deleteProduct` / `deleteSupplier` fails even after stock reaches `0`.

### 6.7 Rollback Procedure
1. Restore previous `allow delete` rules (`1244, 1283`) in `firestore.rules` if an unexpected legitimate deletion is blocked.
2. Client-side `shopService.ts` query checks remain active as safety net; `entityLocks` documents can sit harmlessly without breaking any reports or transactions.

### 6.8 Production Configuration and Manual Actions
1. Deploy `firestore.rules` with `entityLocks` and optional `hasTransactionHistory` fields first.
2. Run the one-time owner-approved `backfillEntityHistoryLocks(shopId)` script (scanning `inventoryBatches`, `saleItems`, `purchaseItems`, `stockMovements`, `purchases`, `supplierPayments`, and product supplier links) to lock all existing historical products and suppliers **before** relying solely on `entityLocks` for legacy items.
3. Inform shop owner that `Archive / Deactivate (isActive: false)` is required before deleting even an unused mistake product (if `existing().isActive == false` guard is kept).

---

<a id="unverified-assumptions--pre-implementation-verification-matrix"></a>
## 7. Unverified Assumptions & Pre-Implementation Verification Matrix

To avoid making silent assumptions that could fail in live production, the table below explicitly separates **codebase facts verified directly in repository files** from **production/environment assumptions that CANNOT be inspected from this sandbox container and MUST be verified before executing any approved item**:

| Area | Verified Fact in Codebase | Unverified Production Assumption (Must Check Before Implementation) |
| :--- | :--- | :--- |
| **Git / Version History** | Verified `.git` directory does **not** exist in `/app/applet`; v1 saved at `/STOP_AND_ASK_PROPOSALS.v1.md`. | Whether you maintain an external Git/GitHub repository outside this AI Studio container where commits should be pushed. |
| **Firebase Admin SDK (`§4.1`, `§7.1`, `§8`)** | Verified `firebase-admin` is **not** in `package.json`; `server.ts` currently uses HTTPS REST with user Bearer ID tokens only. | Whether the Cloud Run service account has IAM permissions (Application Default Credentials / Datastore User) to use `firebase-admin` without needing an exported JSON key, or whether client-signed/user-scoped REST approaches are required. |
| **Production Owner Bootstrap (`§4.1`)** | Verified `appState/ownerSetup` logic in `server.ts` and `firestore.rules`, and `OWNER_EMAIL` is currently unchecked during initial setup. | Whether `appState/ownerSetup` and `admins/{ownerUid}` **already exist** in live Firestore DB `ai-studio-36596f53-ce10-4ba0-aae2-9d7f9051d6fe`, whether `OWNER_EMAIL` is already set in Cloud Run Secrets, and whether the owner's Firebase Auth password account has `email_verified == true`. |
| **Production Vault Files & Secrets (`§4.3`)** | Verified `.caremart-secrets/` does **not** exist in the container workspace, while `.caremart-cache/` exists locally (`cooccurrence_v2_*.json`, `feedback_v1_*.json`). | Whether live production uses `GOOGLE_SERVICE_ACCOUNT_JSON` / `DISCORD_WEBHOOK_URL` env secrets vs `.caremart-secrets/*.enc.json` files on a persistent volume, and whether any custom `OWNER_GATE_SECRET` or `SERVICE_ACCOUNT_ENCRYPTION_KEY` was ever previously configured in production. |
| **Live Data Scale (`§5.3`, `§7.1`, `§5.5`)** | Verified `batchAllocations.size() <= 50` and `MAX_PROCESSED_SALE_IDS = 2000` in code/rules. | Actual live counts in `ai-studio-36596f53-ce10-4ba0-aae2-9d7f9051d6fe`: (a) whether any historical `saleItems` already hit `batchAllocations.length == 50`, (b) total completed `sales` count (`< 2,000` or `> 2,000`), and (c) number of historical `products` / `suppliers` needing `entityLocks` backfill. |
| **Product Delete UX (`§5.5`)** | Verified `shopService.ts` already blocks deleting stocked/historical items in UI. | Whether you want `existing().isActive == false` (Archive-first) strictly enforced in `firestore.rules` even for brand-new unused test entries, or allow deleting unused active entries while locking all `hasTransactionHistory` items. |

---

## Individual Approval Checklist

Reply with your approval (and option selection where applicable) per item when ready:

1. **§4.1 Owner Setup Security:** Approve **Approach A** (server-side provisioning + `allow create: if false;` in rules — requires Cloud Run ADC or `firebase-admin` key) OR **Approach B** (deploy-time `OWNER_EMAIL` SHA-256 hash + `email_verified == true` enforced in `firestore.rules`). Confirm whether `email_verified == true` should also be required for initial Email/Password setup.
2. **§4.3 Encryption & Migration:** Confirm whether production relies on env secrets (`GOOGLE_SERVICE_ACCOUNT_JSON`, `DISCORD_WEBHOOK_URL`) or disk vaults needing the 2-step `ALLOW_LEGACY_FALLBACK_DECRYPT=true` migration window, and whether you want follow-up durable server-only Firestore vault storage (`shops/{shopId}/serverVault`).
3. **§5.3 FIFO > 50 Batches:** Approve deterministic `saleItemAllocations/${saleItemId}_c${chunkIndex}` overflow chunking + strict `W <= 480` pre-commit transaction budget check (eliminating `.slice(0, 50)` completely).
4. **§7.1 Co-Occurrence > 2,000 Sales:** Approve `cooccurrence_v3` + unbounded `upsellProcessedSales/{saleId}` per-sale idempotency ledger + `cancelSale` exact-pair reversal.
5. **§8 Feedback Migration:** Approve **Pattern B** (append-only `upsellFeedbackEvents/{eventId}` deduplication + atomic owner/server transactional folding into `feedback_v1`) OR **Pattern A** (`:commit` atomic `FieldValue.increment(1)` with strict delta rules).
6. **§5.5 Deletion Rules:** Approve `entityLocks` + monotonic `hasTransactionHistory` lock + historical backfill + field checks in `firestore.rules`, and confirm whether `existing().isActive == false` should also be mandatory prior to hard deletion.
