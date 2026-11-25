# CareMart Shop Management System — Technical Proposals for Deferred STOP-AND-ASK Architecture Changes

**Status:** Proposal Only (Awaiting Explicit Approval — **No Code, Rules, Credentials, or Production Data Modified**)  
**Target Environment:** CareMart Web POS & Inventory Management System  
**Firebase Project Database:** `ai-studio-36596f53-ce10-4ba0-aae2-9d7f9051d6fe` (`(default)`)  
**Companion Downloadable Word Document:** `/public/CareMart_STOP_AND_ASK_Technical_Proposals.docx`

---

## Executive Overview

During the Master Security, Reliability, and Architecture Audit, **Groups 1–6** (non-breaking, schema-compatible code hardening and regression test fixes) were completed and verified (`9` Vitest test files, `46/46` passing tests, strict `tsc --noEmit`, `eslint`, and production Vite bundle checks).

The remaining **six STOP-AND-ASK items** below are deliberately deferred because each involves at least one of the following high-impact changes:
- Modifying `firestore.rules` or `firestore.indexes.json`
- Rotating or hardening fallback/default secrets or requiring environment variable provisioning
- Schema changes, subcollection introductions, or backwards-compatibility considerations for existing live Firestore documents and local server vaults
- Production container/runtime deployment actions

This document contains the complete, unabridged engineering specification for all six proposals so every trade-off, migration detail, security rule change, rollback path, and unresolved decision can be reviewed before any implementation or deployment is authorized.

| Section | Proposal Title | Primary Risk Addressed | Schema / Rules Change? | Requires Env / Secret Change? | Live Data Backfill Needed? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **§4.1** | Initial Owner Setup Gate & Firestore Rules | First-user race / open initial owner bootstrap without server-verified email allowlist or email verification | Yes (`firestore.rules` + optional setup lock) | Recommended (`OWNER_EMAIL`, `OWNER_GATE_SECRET`, optional bootstrap token) | No (existing `appState/ownerSetup` stays valid) |
| **§4.3** | Encryption Secret Enforcement & Legacy Credential Migration | Hardcoded fallback secret used to encrypt Google Sheets Service Account & Discord Webhook vaults on disk | No (vault envelope `v: 2` metadata only) | Yes (`SERVICE_ACCOUNT_ENCRYPTION_KEY`, `OWNER_GATE_SECRET`, `SESSION_SECRET`) | Zero-downtime dual-read / re-encrypt migration |
| **§5.3** | FIFO Allocation Above 50 Batches | Silent truncation `fifo.allocations.slice(0, 50)` corrupts edit/cancel restoration when a sale consumes >50 batches | Yes (`firestore.rules` + subcollection or split ledger) | No | Optional historical audit check |
| **§7.1** | Co-Occurrence Cache Above 2,000 Processed Sales | Eviction of oldest `processedSaleIds` beyond 2,000 causes double-counting on replay/rebuild and unbounded `pairCounts` skew | Yes (`firestore.rules` + sharded/subcollection dedup ledger) | No | One-time migration from `cooccurrence_v2` |
| **§8** | Feedback Storage Migration to Firestore | `.caremart-cache/feedback_v1_*.json` on local container filesystem is lost on Cloud Run restarts and unshared across instances | Yes (`firestore.rules` + new Firestore docs/subcollections) | No | Best-effort import from container/browser mirror |
| **§5.5** | Firestore Product & Supplier Deletion Rules | Direct SDK/REST `delete` on `products` / `suppliers` bypasses client-side `shopService.ts` guards against deleting stocked/referenced records | Yes (`firestore.rules` + optional counter/lock field) | No | Minimal backfill if history-lock flag chosen |

---

## Table of Contents

1. [§4.1 Initial Owner Setup Gate and Firestore Rules](#41-initial-owner-setup-gate-and-firestore-rules)
2. [§4.3 Encryption Secret Enforcement and Legacy Credential Migration](#43-encryption-secret-enforcement-and-legacy-credential-migration)
3. [§5.3 FIFO Allocation Above 50 Batches](#53-fifo-allocation-above-50-batches)
4. [§7.1 Co-Occurrence Cache Above 2,000 Processed Sales](#71-co-occurrence-cache-above-2000-processed-sales)
5. [§8 Feedback Storage Migration to Firestore](#8-feedback-storage-migration-to-firestore)
6. [§5.5 Firestore Product & Supplier Deletion Rules](#55-firestore-product-and-supplier-deletion-rules)

---

<a id="41-initial-owner-setup-gate-and-firestore-rules"></a>
## 1. §4.1 Initial Owner Setup Gate and Firestore Rules

### 1.1 Exact Files and Functions That Will Change
- **`server.ts`**
  - Constants/Helpers: `OWNER_GATE_SECRET` (lines 86–87), `getConfiguredOwnerEmail()` (lines 101–111), `computeOwnerProof()` (lines 113–118), `getPrimaryOwnerUidCached()` (lines 534–552)
  - Authorization & Routes: `authorizeOwnerUser()` (lines 554–656), `GET /api/auth/owner-setup-status` (lines 938–951), `POST /api/auth/verify-owner` (lines 954–997), `GET /api/health` (lines 915–935)
  - New helper: `isBootstrapTokenValid()` (if bootstrap secret mode is approved) and `hasVerifiedOwnerEmail()`
- **`firestore.rules`**
  - Helpers: `isOwnerAuthUser()` (lines 29–35), `isOwnerSetupAuthorizedFor(uid)` (lines 45–54), `gateSecret()` (lines 56–58), `isAuthorizedAdminDoc(uid)` (lines 60–64), `isValidOwnerSetupState()` & `isValidAdminRecord()`
  - Match blocks: `match /appState/{stateId}` (lines 857–867), `match /admins/{adminUid}` (lines 872–888)
- **`src/contexts/AuthContext.tsx`**
  - `initializeForUser()` (lines 202–408), `setupInitialAdmin()` (around lines 601–680), `signInOwnerWithEmail()`, `recoverOwnerWithGoogle()`
- **`src/components/LoginScreen.tsx`**
  - Initial Owner Setup form (optional bootstrap passkey input & explicit verification state / error handling when `OWNER_EMAIL` allowlist rejects an email or `email_verified` is false)
- **`src/services/shopService.ts`**
  - `ensureShopInitialized()` (lines 160–223) — transition away from hardcoded `ownerProof` / public client `appState/ownerSetup` creation if server-provisioned bootstrap or HMAC-signed proof is selected
- **`.env.example`**
  - Document `OWNER_EMAIL`, `OWNER_GATE_SECRET`, and (if chosen) `OWNER_BOOTSTRAP_SECRET`

### 1.2 Current Implementation and Verified Issue
1. **Unchecked `OWNER_EMAIL` in `authorizeOwnerUser()` (`server.ts:554–656`):**
   - `getConfiguredOwnerEmail()` (`server.ts:101–111`) reads `process.env.OWNER_EMAIL` (only returning non-empty strings containing `@`).
   - However, `getConfiguredOwnerEmail()` is currently referenced **only** as a boolean indicator in `GET /api/health` (`lines 921, 931`) and `GET /api/auth/owner-setup-status` (`lines 943, 948`).
   - Inside `authorizeOwnerUser()` (`lines 588–655`), when `!primaryOwnerUid` (meaning `appState/ownerSetup` does not exist yet), **any authenticated Firebase user** whose provider is `'password'` or `'google.com'` and whose email does not end with `@staff.caremart.app` passes `authorizeOwnerUser()` and receives a valid signed `ownerProof` from `POST /api/auth/verify-owner` (`line 973`).
2. **Hardcoded `OWNER_GATE_SECRET` & `gateSecret()` in Both Server and Rules:**
   - `server.ts:86–87` falls back to `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'` whenever `process.env.OWNER_GATE_SECRET` is unset.
   - `firestore.rules:56–58` hardcodes the identical literal string inside `function gateSecret() { return 'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'; }`, and `match /admins/{adminUid}` (`line 884`) validates `incoming().ownerProof == hashing.sha256(request.auth.uid + ':' + request.auth.token.email.lower() + ':' + gateSecret()).toHexString().lower()`.
   - Anyone with read access to `firestore.rules` (for example, repository readers) knows the static `gateSecret()` literal, allowing them to forge `ownerProof` offline and commit `appState/ownerSetup` + `admins/{theirUid}` directly against Firestore via the client SDK on an uninitialized database—bypassing `POST /api/auth/verify-owner` entirely.
3. **Missing `email_verified` Enforcement & Public Read on `appState/ownerSetup`:**
   - `firestore.rules:29–35` (`isOwnerAuthUser()`) checks `request.auth.token.firebase.sign_in_provider in ['password', 'google.com']` and `!email.lower().matches('.*@staff\\.caremart\\.app$')`, but does **not** require `request.auth.token.email_verified == true` during initial setup or Google recovery.
   - `firestore.rules:858` allows unauthenticated `get` on `appState/ownerSetup` (`allow get: if stateId == 'ownerSetup';`), exposing `ownerUid` to unauthenticated callers.

### 1.3 Proposed Solution
Use a **two-layer hardening model** (Server Gate + Firestore Rules) that closes both the fresh-install bootstrap race and the static-secret forgeability vulnerability while keeping single-shop live deployments safe:

1. **Server Enforcement of Configured Owner Email & Verified Identity (`server.ts`):**
   - In `authorizeOwnerUser(user, token, options)`:
     - When `!primaryOwnerUid` (initial setup) and `getConfiguredOwnerEmail()` returns a non-empty configured address `configuredEmail`:
       - Require `emailLower === configuredEmail`. Return `403` (`"This account email is not authorized to initialize this shop."`) otherwise.
     - Enforce `user.emailVerified === true` (already decoded from Firebase ID token) during initial `setup` when provider is `'google.com'` (or optionally for `'password'` as well — see Unresolved Questions §1.11 regarding Firebase Email Verification for password accounts).
     - In production (`NODE_ENV === 'production'`), refuse to issue `ownerProof` if `OWNER_GATE_SECRET` is missing or equals the legacy default literal.
   - Remove static server secret reliance from client-readable `firestore.rules` by **one of two mutually exclusive rule architectures** (selectable on approval):
     - **Option A (Recommended — Firebase Custom Claims / Admin SDK Provisioning via Server Endpoint):**
       - When `POST /api/auth/verify-owner` (mode `'setup'`) approves the primary owner (matching `OWNER_EMAIL` or valid `OWNER_BOOTSTRAP_SECRET` when `OWNER_EMAIL` is unset), the server writes `appState/ownerSetup` and `admins/{uid}` directly using a Firebase Admin/Service-Account or privileged server-verified token—or sets a custom claim `role: 'owner'`—and `firestore.rules` disables client `allow create` on `appState/ownerSetup` and `admins/{uid}` (`allow create: if false;` or requires `request.auth.token.ownerInitialized == true`).
     - **Option B (No Admin SDK Key Required — Rules-Enforced Owner Email Literal / Verified Claim + Setup Disable Toggle):**
       - Keep client writeBatch in `ensureShopInitialized()`, remove `gateSecret()` literal from `firestore.rules`, require `request.auth.token.email_verified == true`, and either:
         - Lock `appState/ownerSetup` creation to a deployment-time allowlisted owner email in rules (if static single-tenant) or require `ownerSetup` to be pre-seeded by an authenticated admin CLI script during provisioning, setting `allow create: if false;` in production `firestore.rules` once setup is complete.

2. **Restrict `appState/ownerSetup` Read Visibility (`firestore.rules`):**
   - Change `match /appState/{stateId}` from public `allow get: if stateId == 'ownerSetup';` to `allow get: if isOwnerAuthUser() && stateId == 'ownerSetup';` (since unauthenticated login screen status checks already go through `GET /api/auth/owner-setup-status`, which returns `{ setupCompleted: boolean }` with zero `ownerUid` leakage).

### 1.4 Required Database/Schema Changes and Migrations
- **Existing schema preserved:**
  - `appState/ownerSetup`: `{ ownerUid: string, initialized: boolean, createdAt: Timestamp }`
  - `admins/{uid}`: `{ uid: string, email: string, role: 'owner', ownerProof: string, createdAt: Timestamp, updatedAt: Timestamp }`
- **Optional additive fields (backwards-compatible):**
  - On `appState/ownerSetup`: optional `setupVersion: 2`, `lockedByEmailHash?: string` (only if Option B needs audit metadata; update `isValidOwnerSetupState()` in `firestore.rules` to allow optional fields).
- **Migration needed for already-initialized shops:** **None.** When `appState/ownerSetup` already exists with `initialized == true`, `!exists(/databases/$(database)/documents/appState/ownerSetup)` is already `false`, preventing any second owner from claiming setup.

### 1.5 Compatibility with Existing Data and Credentials
- **Existing primary owner:** Continues authenticating with existing UID (`appState/ownerSetup.ownerUid == request.auth.uid`) and existing `admins/{uid}` document. `admins/{uid}` is never recreated during normal logins once `adminExists == true`.
- **Existing added admins (`adminAuthMap` / `adminMembers`):** Unaffected; `authorizeOwnerUser()` routes added admins through `adminAuthMap/{user.uid}` after `primaryOwnerUid` is resolved.
- **Existing sales staff (`@staff.caremart.app`):** Unaffected; explicitly blocked from owner routes and `isOwnerAuthUser()`.
- **Important warning if rotating `OWNER_GATE_SECRET` on existing shop:** If `admins/{uid}` already exists, `firestore.rules:884` (`incoming().ownerProof == ...`) only runs on `allow create`, **not** on `get` or normal reads/writes (`isAuthorizedAdminDoc` on lines 60–64 only checks `role == 'owner'` and `email`). Rotating `OWNER_GATE_SECRET` on the server therefore does **not** break an already-initialized primary owner!

### 1.6 Impact on Owner, Staff, Sales, Purchases, Inventory, and Recommendations
- **Owner:** Initial setup on a fresh database requires matching `OWNER_EMAIL` (if configured) and/or a one-time bootstrap token; existing owner login is unchanged. If `email_verified == true` is enforced for password accounts, the owner must click a verification link (or verify via Google Sign-In) before completing initial setup.
- **Staff:** Zero impact; staff sign-in uses `@staff.caremart.app` synthetic accounts and `/api/auth/verify-staff`.
- **Sales / Purchases / Inventory / Recommendations:** Zero runtime impact; all operational collections under `shops/{shopId}/...` continue checking `isOwner(shopId)` and staff permissions identically.

### 1.7 Firestore Security Rule Changes
Illustrative target rules (Option A vs. hardened Option B; exact variant chosen upon approval):

```rules
// Replace lines 29-35
function isOwnerAuthUser() {
  return isSignedIn()
    && request.auth.token.firebase.sign_in_provider in ['password', 'google.com']
    && request.auth.token.email is string
    && request.auth.token.email.size() >= 3
    && !request.auth.token.email.lower().matches('.*@staff\\.caremart\\.app$');
}

function isVerifiedOwnerEmail() {
  return request.auth.token.email_verified == true;
}

// Replace lines 857-888 (Hardened Setup Lock — Option A / Locked Post-Setup)
match /appState/{stateId} {
  // Remove unauthenticated public read of ownerUid; client LoginScreen uses /api/auth/owner-setup-status
  allow get: if isOwnerAuthUser() && stateId == 'ownerSetup';
  allow list: if false;
  // Option A (server-provisioned bootstrap): allow create: if false;
  // Option B (allowlisted first-time bootstrap when email is verified & uninitialized):
  allow create: if isOwnerAuthUser()
    && isVerifiedOwnerEmail()
    && isNotStaffAccount(request.auth.uid)
    && stateId == 'ownerSetup'
    && !exists(/databases/$(database)/documents/appState/ownerSetup)
    && isValidOwnerSetupState(incoming())
    && incoming().createdAt == request.time;
  allow update, delete: if false;
}

match /admins/{adminUid} {
  allow get: if isOwnerAuthUser()
    && isValidId(adminUid)
    && adminUid == request.auth.uid
    && (resource == null || existing().email == request.auth.token.email.lower());
  allow list: if false;
  // Option A: allow create: if false; (provisioned by server Admin SDK / trusted bootstrap script)
  // Option B (if client creation kept, remove static gateSecret() fallback or restrict via allowlisted email/verified claim):
  allow create: if false; // Recommended once shop is already initialized
  allow update, delete: if false;
}
```

### 1.8 Testing Strategy
1. **Firebase Firestore Emulator Rules Tests (`vitest` + `@firebase/rules-unit-testing`):**
   - Unauthenticated `getDoc(doc(db, 'appState/ownerSetup'))` -> MUST FAIL (`PERMISSION_DENIED`).
   - Attacker with unverified email or non-matching `OWNER_EMAIL` attempting to write `appState/ownerSetup` or `admins/{attackerUid}` -> MUST FAIL.
   - Attacker knowing legacy static `cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301` attempting to forge `ownerProof` directly via Firestore SDK -> MUST FAIL.
   - Staff account (`@staff.caremart.app` or present in `staffAuthMap`) attempting setup -> MUST FAIL.
   - Legitimate pre-configured owner completing sign-in when `appState/ownerSetup` already exists -> MUST SUCCEED.
2. **Server Unit/Route Tests (`server.test.ts`):**
   - Mock `OWNER_EMAIL=owner@caremart.com`, call `POST /api/auth/verify-owner` with `other@example.com` when `appState/ownerSetup` is absent -> MUST return `403`.
   - Call with `owner@caremart.com` -> MUST return `200` and `authorized: true`.
   - When `OWNER_GATE_SECRET` is unset in `NODE_ENV=production` -> `POST /api/auth/verify-owner` returns `503` (fail-closed) rather than signing with legacy literal.

### 1.9 Rollback Procedure
1. Keep a timestamped backup copy of `firestore.rules` before deploying (`firebase` rules release history in Firebase Console also retains previous rule versions).
2. If an owner setup or login regression occurs after deployment:
   - Re-deploy previous `firestore.rules` version via `deploy_firebase` / Firebase Console Rules History (one-click rollback).
   - Revert `server.ts` env check if a missing `OWNER_GATE_SECRET` in production caused `503` while provisioning env vars.
3. No Firestore documents are altered by `§4.1`, so zero data rollback is required.

### 1.10 Required Manual Production Actions
1. Confirm `appState/ownerSetup` already exists on the production database (`ai-studio-36596f53-ce10-4ba0-aae2-9d7f9051d6fe`).
2. Set production environment variables in deployment configuration / Cloud Run secrets:
   - `OWNER_EMAIL=<shop-owner-email>`
   - `OWNER_GATE_SECRET=<cryptographically-random-64-hex-char-secret>` (generate via `openssl rand -hex 32`)
   - Optionally `OWNER_BOOTSTRAP_SECRET=<one-time-token>` (only needed for brand-new uninitialized shops)
3. Explicitly approve deployment of updated `firestore.rules`.

### 1.11 Risks, Dependencies, and Unresolved Questions
- **Question 1 (Email Verification for Password Accounts):** Newly created Firebase Email/Password users start with `email_verified: false` until they click a verification email (whereas Google Sign-In sets `email_verified: true`). Do you want to enforce `email_verified == true` for **both** Password and Google initial setup (requiring the owner to verify their email via link during setup), or enforce `email_verified == true` for Google + rely on `OWNER_EMAIL` + `OWNER_BOOTSTRAP_SECRET` for Password setup?
- **Question 2 (Setup Rules Lock Mode):** Since your production shop is likely already initialized (`appState/ownerSetup` already exists), would you prefer **Option A** (lock `appState/ownerSetup` and `admins` `allow create: if false` in `firestore.rules` and let the server Admin SDK handle any future brand-new shop bootstrap) or **Option B** (keep client `writeBatch` for fresh installs gated by `OWNER_EMAIL` / bootstrap secret)?
- **Dependency:** `§4.1` and `§4.3` share `OWNER_GATE_SECRET`; coordinate setting `OWNER_GATE_SECRET` and `SERVICE_ACCOUNT_ENCRYPTION_KEY` in production before turning on strict fail-closed enforcement (see §4.3).

---

<a id="43-encryption-secret-enforcement-and-legacy-credential-migration"></a>
## 2. §4.3 Encryption Secret Enforcement and Legacy Credential Migration

### 2.1 Exact Files and Functions That Will Change
- **`server/googleSheetsService.ts`**
  - `getVaultEncryptionKey()` (lines 39–48)
  - `readServiceAccountFromVault()` and `saveServiceAccountToVault()` (lines 250–380)
  - Add: `getLegacyVaultEncryptionKeys()`, `decryptVaultEnvelopeWithFallback()`, `migrateLegacyServiceAccountVault()`
- **`server/discordNotifier.ts`**
  - `getVaultEncryptionKey()` (lines 54–63)
  - `readWebhookFromVault()` (lines 156–220) and `saveWebhookToVault()` (lines 380–430)
  - Add: `getLegacyVaultEncryptionKeys()`, `decryptDiscordVaultWithFallback()`, `migrateLegacyDiscordVault()`
- **`server.ts`**
  - `OWNER_GATE_SECRET` (lines 86–87), `SESSION_SECRET` (lines 88–93)
  - Startup validation banner / production fail-closed guard (`assertProductionSecretsConfigured()`)
  - Admin config health diagnostics (report whether vaults use legacy vs dedicated encryption key without exposing secret material)
- **`.env.example`**
  - Document `SERVICE_ACCOUNT_ENCRYPTION_KEY`, `OWNER_GATE_SECRET`, and `SESSION_SECRET` with explicit generation instructions (`openssl rand -hex 32`)

### 2.2 Current Implementation and Verified Issue
1. **Shared Weak Default Seed in Both Vaults:**
   - `server/googleSheetsService.ts:39–48` computes the AES-256-GCM key as:
     ```ts
     const secretSeed =
       (process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY || '').trim() ||
       (process.env.OWNER_GATE_SECRET || '').trim() ||
       'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301';
     return crypto.createHash('sha256').update(`caremart-service-account-vault:v1:${secretSeed}`).digest();
     ```
   - `server/discordNotifier.ts:54–63` uses the **exact same fallback chain**:
     ```ts
     const secretSeed =
       (process.env.SERVICE_ACCOUNT_ENCRYPTION_KEY || '').trim() ||
       (process.env.OWNER_GATE_SECRET || '').trim() ||
       'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301';
     return crypto.createHash('sha256').update(`caremart-discord-webhook-vault:v1:${secretSeed}`).digest();
     ```
   - `server.ts:88–93` derives `SESSION_SECRET` from `OWNER_GATE_SECRET` + `firebaseConfig.projectId`, which also collapses to a deterministic public value whenever `OWNER_GATE_SECRET` and `SESSION_SECRET` are unset.
2. **Security Impact:**
   - Any attacker who reads `.caremart-secrets/sa_*.enc.json` or `.caremart-secrets/discord_*.enc.json` (e.g., via container backup, filesystem leak, or misconfigured volume snapshot) can decrypt stored Google Service Account private keys and Discord webhook URLs immediately using the public fallback literal `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'`.
3. **Operational Migration Hazard (Why This Is STOP-AND-ASK):**
   - If `.caremart-secrets/*.enc.json` files already exist in production encrypted with the legacy fallback key (or an older `OWNER_GATE_SECRET`), simply replacing the fallback with an error or setting a brand-new `SERVICE_ACCOUNT_ENCRYPTION_KEY` without a dual-key migration path will immediately cause `Unsupported state or unable to authenticate data` (`GCM auth tag mismatch`) and break live Google Sheets sync and Discord low-stock/sale alerts.

### 2.3 Proposed Solution
Implement a **2-Phase Zero-Downtime Key Rotation & Fail-Closed Enforcement Strategy**:

1. **Key Derivation Separation & Versioning (`v: 2` Envelope):**
   - Stop falling back to `OWNER_GATE_SECRET` or `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'` for **writing** new vaults in production.
   - Require `SERVICE_ACCOUNT_ENCRYPTION_KEY` (at least 32 characters / 128+ bits entropy; recommended 64 hex chars).
   - Introduce `LEGACY_ENCRYPTION_KEYS` (optional comma-separated env var) plus an opt-in one-time migration bridge `ALLOW_LEGACY_FALLBACK_DECRYPT=true` (temporarily enabled during migration window only):
     - **Decrypt order:**
       1. Primary `SERVICE_ACCOUNT_ENCRYPTION_KEY` (`v: 2` HKDF-SHA256 / domain-separated key, or `v: 1` SHA-256 key)
       2. Any keys listed in `LEGACY_ENCRYPTION_KEYS` (ordered newest to oldest)
       3. Legacy `OWNER_GATE_SECRET` (if distinct from `SERVICE_ACCOUNT_ENCRYPTION_KEY`)
       4. *Only if `ALLOW_LEGACY_FALLBACK_DECRYPT=true`*: legacy hardcoded `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'`
     - **Auto-Re-Encryption on Read:** Whenever a `v: 1` or legacy-key vault decrypts successfully using a fallback key, immediately atomically re-encrypt and persist it as `v: 2` using the primary `SERVICE_ACCOUNT_ENCRYPTION_KEY` (writing `.tmp` + `renameSync`), logging a safe non-secret audit notice (`"Migrated vault sa_... to v2 key"`).
2. **HKDF / Scrypt Key Derivation for `v: 2`:**
   - Replace bare SHA-256 concatenation with Node's built-in `crypto.hkdfSync('sha256', primarySecret, salt, info, 32)` (with domain info `'caremart-sa-vault-v2'` and `'caremart-discord-vault-v2'`).
3. **Production Startup & Save-Time Guard (`server.ts`):**
   - In `NODE_ENV === 'production'`:
     - If `SERVICE_ACCOUNT_ENCRYPTION_KEY` is empty, shorter than 32 chars, or equals the legacy gate literal:
       - Vault **writes** (`saveServiceAccountToVault`, `saveWebhookToVault`) refuse to encrypt with weak material and return `503` with clear operator instructions (`"SERVICE_ACCOUNT_ENCRYPTION_KEY must be configured on the server before saving credentials."`).
       - `SESSION_SECRET` refuses to sign session cookies with weak defaults (fail closed or generate an ephemeral per-boot random secret with a critical warning, forcing re-login on restart rather than accepting forged cookies).
   - In development/test (`NODE_ENV !== 'production'`): keep tests self-contained by allowing an explicit test key or ephemeral per-process dev key in `.caremart-secrets/.dev-ephemeral.key` (`0600` perms, gitignored) rather than a public hardcoded constant.

### 2.4 Required Database/Schema Changes and Migrations
- **Firestore Schema:** **No changes** (`ServiceAccount` and Discord secrets are never stored in Firestore; they remain strictly server-side).
- **Local Vault JSON Schema (`.caremart-secrets/sa_<hash>.enc.json` & `discord_<hash>.enc.json`):**
  - Current `v: 1`: `{ v: 1, iv: base64, tag: base64, data: base64, updatedAt: number }`
  - New `v: 2`: `{ v: 2, kdf: 'hkdf-sha256', iv: base64(12B), tag: base64(16B), data: base64, updatedAt: number, rotatedAt?: number }`
- **One-Time Migration Trigger:** Automatic on first vault read (or via a dedicated authenticated owner endpoint `POST /api/admin/vault/migrate` or startup pre-warm loop over `.caremart-secrets/*.enc.json`).

### 2.5 Compatibility with Existing Data and Credentials
- **If existing vaults exist encrypted with the legacy default or old `OWNER_GATE_SECRET`:**
  - Setting `SERVICE_ACCOUNT_ENCRYPTION_KEY=<new-secret>` alongside `ALLOW_LEGACY_FALLBACK_DECRYPT=true` (and optionally `LEGACY_ENCRYPTION_KEYS=<previous-secret>`) ensures **100% seamless decryption** on the very first read and automatic atomic upgrade to `v: 2`.
  - After all vault files show `v: 2` (can be checked via `/api/health` or migration log), `ALLOW_LEGACY_FALLBACK_DECRYPT` is removed from production env vars, permanently retiring the hardcoded literal.
- **If existing credentials were supplied via `GOOGLE_SERVICE_ACCOUNT_JSON` / `DISCORD_WEBHOOK_URL` env vars directly:** Completely unaffected (env var path bypasses disk vault files).

### 2.6 Impact on Owner, Staff, Sales, Purchases, Inventory, and Recommendations
- **Owner:** Zero disruption during two-phase migration. Re-saving credentials in Settings uses `v: 2` key automatically. If `SESSION_SECRET` switches from default to a real secret, any currently logged-in owner/staff browser cookies simply refresh silently via Firebase ID token on next `/api/auth/verify-*` call.
- **Staff / Sales / Purchases / Inventory / Recommendations:** No impact on POS workflows; Sheets background sync and Discord notifications continue operating without interruption.

### 2.7 Firestore Security Rule Changes
- **None required.** All secret vault operations live strictly on the Node.js Express server (`server/googleSheetsService.ts`, `server/discordNotifier.ts`, `server.ts`).

### 2.8 Testing Strategy
1. **Unit Tests (`server/googleSheetsService.test.ts` & `server/discordNotifier.test.ts`):**
   - Encrypt a sample payload as `v: 1` using the legacy hardcoded seed -> configure `SERVICE_ACCOUNT_ENCRYPTION_KEY=<new-32B-secret>` + `ALLOW_LEGACY_FALLBACK_DECRYPT=true` -> verify `readServiceAccountFromVault()` and `readWebhookFromVault()` successfully decrypt, return the exact JSON/URL, and upgrade the file on disk to `v: 2`.
   - Re-read the upgraded file with `ALLOW_LEGACY_FALLBACK_DECRYPT=false` -> verify it succeeds strictly with the new primary key and **fails** if encrypted only with the legacy key when fallback is disabled.
   - Verify `NODE_ENV=production` rejects missing or short (`< 32` chars) `SERVICE_ACCOUNT_ENCRYPTION_KEY` when saving a vault.
2. **Integration Verification:**
   - Trigger test Discord alert and Sheets status probe against a migrated vault file in a temporary directory.

### 2.9 Rollback Procedure
1. Before enabling `SERVICE_ACCOUNT_ENCRYPTION_KEY` in production, take a backup copy of `.caremart-secrets/*.enc.json` (stored encrypted or securely off-box).
2. If decryption fails after rotation:
   - Temporarily restore `.caremart-secrets/*.enc.json` backup and add the previous secret to `LEGACY_ENCRYPTION_KEYS` (or enable `ALLOW_LEGACY_FALLBACK_DECRYPT=true`).
   - Alternatively, owner can re-paste the Service Account JSON and Discord Webhook URL inside Settings -> Integrations to overwrite the vault cleanly.

### 2.10 Required Manual Production Actions
1. Check whether `.caremart-secrets/` currently holds any `sa_*.enc.json` or `discord_*.enc.json` files in production (and whether `GOOGLE_SERVICE_ACCOUNT_JSON` / `DISCORD_WEBHOOK_URL` env vars are currently used).
2. Generate two independent 32-byte (64-hex-character) secrets:
   - `SERVICE_ACCOUNT_ENCRYPTION_KEY`
   - `SESSION_SECRET`
   (Plus `OWNER_GATE_SECRET` from §4.1.)
3. **Deployment Step A:** Deploy code with `SERVICE_ACCOUNT_ENCRYPTION_KEY`, `SESSION_SECRET`, `OWNER_GATE_SECRET`, and `ALLOW_LEGACY_FALLBACK_DECRYPT=true` (plus `LEGACY_ENCRYPTION_KEYS` if any previous custom `OWNER_GATE_SECRET` was ever set).
4. Trigger `/api/admin/sheets/status` and `/api/health?probe=discord` once while signed in as Owner so vaults auto-migrate to `v: 2`.
5. **Deployment Step B:** Remove `ALLOW_LEGACY_FALLBACK_DECRYPT` (and `LEGACY_ENCRYPTION_KEYS`) from production environment variables.

### 2.11 Risks, Dependencies, and Unresolved Questions
- **Risk (Ephemeral Container Disk on Cloud Run):** Note that `.caremart-secrets/` itself sits on the container's local filesystem (`path.resolve(process.cwd(), '.caremart-secrets')`). Unless mounted on persistent storage or injected via Secret Manager env vars (`GOOGLE_SERVICE_ACCOUNT_JSON`, `DISCORD_WEBHOOK_URL`), container restarts wipe `.caremart-secrets/`. Should we also consider encrypted Firestore/Secret-Manager vault storage in a future phase, or do you manage these via Cloud Run environment variables/persistent volume?
- **Question:** Were any Service Account JSON or Discord Webhook URLs previously saved through the Settings UI while `OWNER_GATE_SECRET` was unset (meaning we definitely need **Step A** with `ALLOW_LEGACY_FALLBACK_DECRYPT=true`)?

---

<a id="53-fifo-allocation-above-50-batches"></a>
## 3. §5.3 FIFO Allocation Above 50 Batches

### 3.1 Exact Files and Functions That Will Change
- **`src/types/shop.ts`**
  - `SaleItem` interface (around line 252): add `allocationOverflowCount?: number` and `allocationsStorageMode?: 'inline' | 'subcollection'` (if subcollection approach chosen), plus `SaleItemBatchAllocation` interface
- **`src/utils/packaging.ts`**
  - `allocateFifoFromBatches()` (line 701+) — optionally group/merge multiple allocations referencing the same `batchId` and verify deterministic ordering
- **`src/services/shopService.ts`**
  - `createSale()` (lines 2425–2510, specifically `.slice(0, 50)` at line 2486)
  - `editSale()` (lines 2700–2970, specifically restore loop at lines 2794–2802 and `.slice(0, 50)` / `nextAllocations` at lines 2890–2960)
  - `cancelSale()` (lines 3070–3200, specifically restoration loops at lines 3091–3099 and lines 3175–3183)
  - `importHistoricalSaleToLedger()` / adjustment paths (line 4144)
  - New helper: `readSaleItemBatchAllocations()`, `writeOverflowBatchAllocations()`
- **`src/services/staffService.ts`**
  - `reconcileStaffSaleToOwnerLedger()` (lines 955–1140, specifically `.slice(0, 50)` at line 1114)
- **`firestore.rules`**
  - `isValidSaleItem(data, shopId)` (lines 546–584, specifically line 578 `data.batchAllocations.size() <= 50`)
  - New `match /saleItemAllocations/{allocId}` (or `match /saleItems/{saleItemId}/allocations/{chunkId}`) rule block if chunked storage is selected
- **`firestore.indexes.json`**
  - Add index on `saleItemAllocations` `(ownerUid, saleId)` / `(ownerUid, saleItemId)` if stored as a top-level shop subcollection `shops/{shopId}/saleItemAllocations`

### 3.2 Current Implementation and Verified Issue
1. **Silent Loss of Allocations Past Index 50:**
   - `allocateFifoFromBatches()` (`src/utils/packaging.ts:701`) consumes `inventoryBatches` in FIFO order and deducts `remainingBaseQty` from **every** batch it touches (`60` batches, `100` batches, etc.).
   - However, when writing the `saleItems` document, **three separate code paths truncate the array**:
     - `src/services/shopService.ts:2486` (`createSale`): `batchAllocations: fifo.allocations.slice(0, 50)`
     - `src/services/shopService.ts:2900–2952` (`editSale`): truncates new allocations if >50
     - `src/services/staffService.ts:1114` (`reconcileStaffSaleToOwnerLedger`): `batchAllocations: fifo.allocations.slice(0, 50)`
   - And `firestore.rules:578` hard-rejects any `saleItem` with `data.batchAllocations.size() > 50`.
2. **Verified Inventory & COGS Corruption Scenario:**
   - Suppose a wholesale order sells `120` units of a fast-moving micro-batch item spread across `65` small active purchase batches (`2` units each).
   - `createSale()` deducts `remainingBaseQty` from all `65` batches inside the Firestore transaction, **but only records batches 1–50** on `saleItems/{itemId}.batchAllocations`.
   - Batches 51–65 are permanently marked `exhausted` (`remainingBaseQty: 0`) with **no audit link back to the `saleItem`**.
   - If the owner later runs **`editSale()`** (`shopService.ts:2794–2802`) or **`cancelSale()`** (`shopService.ts:3093–3099`, `3175–3183`), caremart only restores stock to batches 1–50 while restoring `product.currentStock` for the full `120` units. Result: **`product.currentStock` exceeds `sum(inventoryBatches.remainingBaseQty)`**, causing phantom stock drift and inaccurate future FIFO COGS.
3. **Important Secondary Limit — Firestore 500-Write Transaction Cap:**
   - Even if `batchAllocations` allowed 500 entries, a single Firestore `runTransaction` / `writeBatch` allows at most **500 document writes** total across all cart items, batches, sale header, audit log, and product updates.

### 3.3 Proposed Solution
Use a **Hybrid Inline + Overflow Chunking & Guarded Transaction Architecture**:

1. **Pre-Allocation Batch Consolidation (`allocateFifoFromBatches`):**
   - Ensure allocations returned by `allocateFifoFromBatches()` are strictly 1-to-1 per `batchId` (no duplicate batch entries), keeping array size minimal.
2. **Dual Storage Threshold (Backwards-Compatible for 99.9% of Sales):**
   - **Normal sales (`allocations.length <= 50`):** Keep writing `batchAllocations` inline on `saleItems/{saleItemId}` exactly as today (`allocationsStorageMode` omitted or `'inline'`). **Zero extra Firestore reads or writes** for normal POS transactions!
   - **High-batch sales (`allocations.length > 50`):**
     - **Option A (Raise Inline Cap to `250` + Explicit Reject/Split Above Transaction Budget — Simplest Schema):**
       - Raise `firestore.rules:578` cap from `50` to `250` (a `BatchAllocation` object `{ batchId, qty, baseQty, unitCost }` is ~120 bytes; 250 entries ≈ 30 KB, far below Firestore's 1 MiB document cap), **and** guard `createSale` / `editSale` / `reconcileStaffSaleToOwnerLedger` so if `fifo.allocations.length > 250` or total transaction writes would approach `450` (near Firestore's 500-op hard limit), fail explicitly with a clear actionable error (`"This line spans too many small inventory batches in a single transaction; split the sale quantity or consolidate batches."`) **before committing any partial batch deductions**, rather than silently slicing!
     - **Option B (Unlimited via Overflow Subcollection `saleItemAllocations`):**
       - Store the first 50 allocations inline (or store `allocationsStorageMode: 'chunked'`) and write overflow chunks of up to 200 allocations into `shops/{shopId}/saleItemAllocations/{saleItemId}_chunk_{n}` (`{ ownerUid, saleId, saleItemId, chunkIndex, allocations, createdAt }`).
       - `editSale()` and `cancelSale()` check `item.allocationsStorageMode === 'chunked'` (or `allocationCount > 50`) and load all `saleItemAllocations` chunks for `saleId` before computing batch restoration.
       - Still enforces Firestore's 500-write transaction limit safely by validating `estimatedWrites <= 480` up front (or chunking batch updates cleanly if needed).
   - **Recommended choice:** **Option A (`250` inline cap + strict fail-closed write budget check, no silent `.slice(0, 50)`)** OR **Option A + Option B overflow chunks if any SKU routinely splits across >250 batches**. Removing silent `.slice(0, 50)` in favor of explicit integrity preservation is mandatory in either option.

### 3.4 Required Database/Schema Changes and Migrations
- **Option A:**
  - Zero new collections or indexes.
  - `SaleItem` schema unchanged (`batchAllocations` remains optional `BatchAllocation[]`).
- **Option B:**
  - Add optional fields to `SaleItem`: `allocationsStorageMode?: 'inline' | 'chunked'`, `totalAllocationCount?: number`.
  - Add shop subcollection `shops/{shopId}/saleItemAllocations/{chunkId}` + composite index `(ownerUid ASC, saleId ASC)` in `firestore.indexes.json`.
- **Historical Data Migration:**
  - Read-only diagnostic script (run with owner approval only) can scan existing `saleItems` where `batchAllocations.length == 50` to detect if any historical sale was silently truncated (`sum(batchAllocations.baseQty) < saleItem.baseQuantity`), surfacing a report for manual stock batch reconciliation without mutating data unexpectedly.

### 3.5 Compatibility with Existing Data and Credentials
- **100% backwards compatible:** Existing `saleItems` with `0–50` inline `batchAllocations` and no new fields continue working identically in `editSale()`, `cancelSale()`, and `reconcileStaffSaleToOwnerLedger()`.
- No credential changes required.

### 3.6 Impact on Owner, Staff, Sales, Purchases, Inventory, and Recommendations
- **Owner / Sales / Inventory:** Eliminates silent `currentStock` vs. `inventoryBatches` desynchronization on large multi-batch sales, edits, and cancellations. Prevents exceeding Firestore's 500-operation transaction limit mid-sale.
- **Staff:** `reconcileStaffSaleToOwnerLedger()` applies identical integrity checks (no silent `.slice(0, 50)`).
- **Purchases:** Batch consolidation tools or normal purchase batch creation (`inventoryBatches`) remain unchanged.
- **Recommendations:** No impact.

### 3.7 Firestore Security Rule Changes
**Option A (`firestore.rules:578`):**
```rules
// Update line 578 inside isValidSaleItem(data, shopId)
&& (!('batchAllocations' in data) || (
  data.batchAllocations is list
  && data.batchAllocations.size() <= 250
  && (data.batchAllocations.size() == 0 || data.batchAllocations[0] is map)
))
```
**Option B (if chunked overflow collection added):**
```rules
function isValidSaleItemAllocationChunk(data, shopId) {
  return data.keys().hasAll(['ownerUid', 'saleId', 'saleItemId', 'chunkIndex', 'allocations', 'createdAt'])
    && data.keys().hasOnly(['ownerUid', 'saleId', 'saleItemId', 'chunkIndex', 'allocations', 'createdAt'])
    && data.ownerUid == shopId
    && isValidId(data.saleId)
    && isValidId(data.saleItemId)
    && data.chunkIndex is int && data.chunkIndex >= 0 && data.chunkIndex <= 50
    && data.allocations is list && data.allocations.size() >= 1 && data.allocations.size() <= 200
    && data.createdAt is timestamp;
}

match /saleItemAllocations/{chunkId} {
  allow get, list: if isOwner(shopId) && existing().ownerUid == shopId;
  allow create: if isOwner(shopId) && isValidId(chunkId) && isValidSaleItemAllocationChunk(incoming(), shopId) && shopExists(shopId) && incoming().createdAt == request.time;
  allow update: if false;
  allow delete: if isOwner(shopId) && isValidId(chunkId) && shopExists(shopId) && existing().ownerUid == shopId;
}
```
*(Also allow optional `allocationsStorageMode` / `totalAllocationCount` in `isValidSaleItem`.)*

### 3.8 Testing Strategy
1. **Unit & Service Tests (`src/services/shopService.test.ts` & `src/services/staffService.test.ts`):**
   - Sale consuming **65** active FIFO batches -> verify **all 65** allocations are preserved (`sum(allocations.baseQty) === line.baseQuantity`), zero silent truncation.
   - `cancelSale()` on that 65-batch sale -> verify **all 65** batches have `remainingBaseQty` restored accurately and `sum(batches.remainingBaseQty) === product.currentStock`.
   - `editSale()` reducing quantity on a 65-batch sale -> verify batches 51–65 restore properly.
   - Sale exceeding Firestore's safe transaction write budget (`>480` batch writes) -> verify atomic pre-check rejects cleanly without mutating any batch or product stock.
2. **Firestore Emulator Rules Tests:**
   - Verify `saleItems` with 65 `batchAllocations` succeeds under new rules and >250 (or malformed `allocations` chunks under Option B) fails.

### 3.9 Rollback Procedure
1. If Option A is deployed: revert `firestore.rules` line 578 back to `<= 50` and revert `shopService.ts`/`staffService.ts` cap; existing sales with `<= 50` entries are unaffected. (Note: any sale recorded with 51–250 allocations before rollback would still restore cleanly unless `editSale` rewrites >50 allocations while old rules are active.)
2. If Option B is deployed: keep `saleItemAllocations` readable during rollback, or run inverse merge before removing rules.

### 3.10 Required Manual Production Actions
1. Deploy updated `firestore.rules` (and `firestore.indexes.json` if Option B is chosen) **before** deploying the updated client build so clients writing >50 allocations are never rejected by older rules.
2. Optionally run the read-only audit scan for existing `saleItems` with `batchAllocations.length == 50`.

### 3.11 Risks, Dependencies, and Unresolved Questions
- **Question:** Does your shop ever expect a single sale line to consume more than **250** separate purchase batches in one transaction (note Firestore itself caps any single atomic transaction at 500 total document writes across all items, batches, sale header, and audit log)? If 250 is sufficient, **Option A** avoids adding a new subcollection and extra reads/writes entirely.

---

<a id="71-co-occurrence-cache-above-2000-processed-sales"></a>
## 4. §7.1 Co-Occurrence Cache Above 2,000 Processed Sales

### 4.1 Exact Files and Functions That Will Change
- **`shared/upsellCacheSchema.ts`**
  - Constants: `COOCCURRENCE_CACHE_VERSION` (`2` -> `3` if breaking schema, or keep `2` with additive shard metadata), `MAX_PROCESSED_SALE_IDS` (currently `2000`, line 2), `MAX_INDEXED_PRODUCTS` (`1000`, line 3), `MAX_NEIGHBORS_PER_PRODUCT` (`40`, line 4)
  - Add: `CooccurrenceDedupShard`, `SalePairRecord` (for accurate cancellation/edit decrementing!)
- **`server/upsellCooccurrenceStore.ts`**
  - `applyCompletedSaleSync()` (lines 195–251), `hydrateServerCooccurrenceFromExternalSnapshot()` (lines 264–293), `recordServerCooccurrenceBatch()` (lines 295+)
  - Add: time-bucketed / hashed deduplication shard tracking + optional `removeSaleFromCooccurrence()` for cancelled sales
- **`src/services/upsellCooccurrenceService.ts`**
  - `applyCompletedSaleToLocalStore()`, `hydrateCooccurrenceCacheFromServer()`, `persistCooccurrenceToFirestore()`, `triggerBackgroundCooccurrenceBackfill()`
  - Add: Firestore shard read/write (`upsellCache/cooccurrence_dedup_YYYYMM` or `upsellDedupShards/{bucketId}`), cursor/watermark tracking (`lastProcessedSaleCreatedAt` / `lastProcessedSaleId`)
- **`server.ts`**
  - `GET /api/upsell/cooccurrence`, `POST /api/upsell/cooccurrence/update`, `POST /api/upsell/cooccurrence/rebuild` (lines 1916–2122)
- **`firestore.rules`**
  - `isValidUpsellCooccurrenceCache(data, shopId)` (lines 830–852, specifically line 848 `processedSaleIds.size() <= 2000`)
  - `match /upsellCache/{cacheId}` (lines 1605–1634, specifically lines 1607, 1615, 1622, 1633 hardcoding `cacheId == 'cooccurrence_v2'`)

### 4.2 Current Implementation and Verified Issue
1. **FIFO Eviction of `processedSaleIds` at 2,000 Sales (`server/upsellCooccurrenceStore.ts:213–219` & `273–275`):**
   - `shared/upsellCacheSchema.ts:2` caps `MAX_PROCESSED_SALE_IDS = 2000`.
   - When sale #2,001 arrives, `applyCompletedSaleSync()` executes:
     ```ts
     const excess = state.snapshot.processedSaleIds.length - MAX_PROCESSED_SALE_IDS;
     const removed = state.snapshot.processedSaleIds.splice(0, excess);
     for (const oldId of removed) {
       state.processedSet.delete(oldId);
     }
     ```
   - And `firestore.rules:848` enforces `data.processedSaleIds.size() <= 2000`.
2. **Verified Bugs Beyond 2,000 Sales:**
   - **Double-Counting on Replay / Multi-Device Sync / Partial Rebuild:** Once sale #1 is evicted from `processedSaleIds`, `processedSet.has(sale1Id)` returns `false`. If another POS terminal flushes a delayed offline queue or triggers a partial backfill including sale #1, sale #1's `saleCountsByProduct` and `pairCounts` are incremented **again**, silently inflating co-occurrence weights and distorting confidence/lift scoring.
   - **Document Size & `pairCounts` Matrix Growth:** As catalog size or history grows, storing all deduplication IDs inline inside a single 1 MiB Firestore document (`cooccurrence_v2`) does not scale past ~15,000–25,000 IDs even if raised, whereas separating the deduplication ledger from the summary matrix scales cleanly to hundreds of thousands of sales.
   - **Cancellations Not Subtracted:** Currently, completed sales that are later `cancelled` remain counted inside `totalCompletedSales`, `saleCountsByProduct`, and `pairCounts` unless a full rebuild runs.

### 4.3 Proposed Solution
Decouple the **Aggregated Co-Occurrence Matrix Document** (small, fast, <100 KB, read by POS) from a **Sharded Deduplication Ledger** (never downloaded in full by POS cart rendering!):

1. **Keep POS Read Path Fast (Single Document Read):**
   - POS / Product Details (`useSalesAssistant`, `ProductRelatedSuggestions`) continues reading **only** `shops/{shopId}/upsellCache/cooccurrence_v2` (or `cooccurrence_v3`), containing `totalCompletedSales`, `saleCountsByProduct`, `pairCounts`, `revision`, and an `updatedThroughTimestamp` watermark.
   - Remove the full historical `processedSaleIds` array from the hot matrix snapshot (or keep only the most recent `200` hot IDs for fast offline tab collision checks).
2. **Sharded Deduplication Ledger (`shops/{shopId}/upsellDedup/{shardKey}`):**
   - Partition sale deduplication by **year-month** (`YYYY-MM`, e.g., `2026-11`) or deterministic **hash prefix bucket** (`h_00` .. `h_ff`, 256 buckets, ~40 bytes/ID -> each bucket holds ~10,000+ sale IDs safely well under 1 MiB).
   - **Recommended partitioning:** **Deterministic 64-bucket or 128-bucket hash** (`bucket = sha256(saleId)[0..1] % 64`, stored at `shops/{shopId}/upsellDedup/bucket_00`..`bucket_63`):
     - A shop with `100,000` completed sales averages only `~1,560` sale IDs (~45 KB) per bucket!
     - Checking idempotency for a completed sale (`POST /api/upsell/cooccurrence/update` or transaction write) reads/updates **only 1 single bucket doc** (`O(1)` lookup, independent of total shop sales!).
3. **Rolling Window / Exponential Decay Support (Optional Enhancement):**
   - Keep `saleCountsByProduct` and `pairCounts` bounded to `MAX_INDEXED_PRODUCTS` (`1000`) and `MAX_NEIGHBORS_PER_PRODUCT` (`40`), while ensuring zero double-counting for every historical sale recorded in `upsellDedup/bucket_XX`.
4. **Full Rebuild & Cancellation Handling:**
   - Full rebuild resets `cooccurrence` matrix + updates touched `upsellDedup` shards cleanly using a `rebuildEpoch` counter so old shards don't block legitimate rebuilds.

### 4.4 Required Database/Schema Changes and Migrations
- **Firestore Subcollection Addition:**
  - `shops/{shopId}/upsellCache/cooccurrence_v2` (or `v3`):
    - Keep `totalCompletedSales`, `saleCountsByProduct`, `pairCounts`, `revision`, `updatedAt`.
    - Retain optional `recentSaleIds: string[]` (capped `<= 500`) + `dedupMode: 'sharded_v1'` + `rebuildEpoch: number`.
  - New docs inside existing `upsellCache` or sibling `upsellDedup`: `shops/{shopId}/upsellDedup/{bucketId}`:
    ```ts
    {
      ownerUid: string;
      epoch: number;
      saleIds: string[]; // capped <= 5000 per bucket (~150KB max)
      updatedAt: Timestamp;
    }
    ```
- **Migration Script / Lazy Migration:**
  - Triggered once on owner login or via explicit migration job when `cooccurrence_v2.processedSaleIds.length > 0` and `dedupMode !== 'sharded_v1'`:
    - Partition existing `processedSaleIds` (up to 2,000) into their target `upsellDedup/bucket_XX` documents in batches (`<= 64` writes), then update `cooccurrence_v2` with `dedupMode: 'sharded_v1'` and shrink inline `processedSaleIds` to the latest 200.
  - For shops that **already** exceeded 2,000 sales before migration: run one owner-triggered background full rebuild (`POST /api/upsell/cooccurrence/rebuild` / Firestore batch) to construct accurate counts + full `upsellDedup` shards from actual `status == 'completed'` sales.

### 4.5 Compatibility with Existing Data and Credentials
- **Backwards-compatible:** Shops with `<= 2,000` sales work immediately during lazy migration with zero lost counts.
- **No credential changes required.**
- **Existing localStorage / server `.caremart-cache` mirrors:** Cache version check (`v2` vs `v3` or `dedupMode` field) gracefully hydrates from authoritative Firestore/server state and ignores stale browser mirrors.

### 4.6 Impact on Owner, Staff, Sales, Purchases, Inventory, and Recommendations
- **Sales Entry & Checkout:** **Zero blocking impact.** Co-occurrence update remains strictly asynchronous post-sale; POS cart reads only the single small matrix doc.
- **Staff:** Staff sales ingestion via `/api/upsell/cooccurrence/update` performs 1 extra `O(1)` bucket check on the server/client and remains allowed under `staffCanAddSales(shopId)`.
- **Recommendations:** Accuracy improves significantly for mature shops (>2,000 sales) because double-counting and replay skew are eliminated.
- **Purchases / Inventory:** Zero impact.

### 4.7 Firestore Security Rule Changes
```rules
function isValidUpsellDedupBucket(data, shopId) {
  return data.keys().hasAll(['ownerUid', 'epoch', 'saleIds', 'updatedAt'])
    && data.keys().hasOnly(['ownerUid', 'epoch', 'saleIds', 'updatedAt'])
    && data.ownerUid == shopId
    && data.epoch is int && data.epoch >= 0
    && data.saleIds is list && data.saleIds.size() <= 5000
    && (data.saleIds.size() == 0 || (data.saleIds[0] is string && data.saleIds[0].size() <= 128))
    && data.updatedAt is timestamp;
}

match /upsellDedup/{bucketId} {
  allow get: if isValidId(bucketId)
    && bucketId.matches('^bucket_([0-5][0-9]|6[0-3])$')
    && (
      (isOwner(shopId) && (resource == null || (shopExists(shopId) && existing().ownerUid == shopId))) ||
      (staffCanAddSales(shopId) && shopExists(shopId) && (resource == null || existing().ownerUid == shopId))
    );
  allow list: if false;
  allow create, update: if isOwner(shopId)
    && isValidId(bucketId)
    && bucketId.matches('^bucket_([0-5][0-9]|6[0-3])$')
    && isValidUpsellDedupBucket(incoming(), shopId)
    && incoming().updatedAt == request.time
    && shopExists(shopId);
  allow delete: if isOwner(shopId) && isValidId(bucketId) && shopExists(shopId);
}
```
*(And update `isValidUpsellCooccurrenceCache` in `firestore.rules:830–852` to accept optional `dedupMode` and `rebuildEpoch` fields so existing and migrated docs both pass validation.)*

### 4.8 Testing Strategy
1. **Unit Tests (`server/upsellCooccurrenceStore.test.ts` & `src/services/upsellCooccurrenceService.test.ts`):**
   - Feed `3,500` synthetic completed sales -> assert `totalCompletedSales === 3500`.
   - Replay sale #1 (`sale_0001`), sale #500 (`sale_0500`), and sale #3499 -> assert `skippedDuplicateCount === 3`, `totalCompletedSales` remains `3500`, and `saleCountsByProduct` / `pairCounts` do not change.
   - Verify bucket distribution across `bucket_00..bucket_63` stays balanced (`~55` IDs per bucket for 3,500 sales).
2. **Emulator Rules Tests:**
   - Verify `upsellDedup/bucket_00` rejects >5,000 IDs or arbitrary bucket names like `bucket_999`.
   - Verify staff with `canAddSales` cannot tamper directly with `upsellDedup` via Firestore client SDK (server-verified route or owner reconciliation handles writes).

### 4.9 Rollback Procedure
1. Keep `processedSaleIds` (most recent 2,000) intact on `cooccurrence_v2` or restore `isValidUpsellCooccurrenceCache` to accept both schemas.
2. Rolling back code simply falls back to the capped `<= 2,000` array without deleting any shop sales data (`sales` and `saleItems` are always the source of truth, and co-occurrence can always be rebuilt deterministically).

### 4.10 Required Manual Production Actions
1. Deploy updated `firestore.rules` first.
2. Deploy updated server and client bundle.
3. Have shop owner run a one-time "Rebuild Upsell Co-occurrence" action (or automatic startup migration) if the shop already has `> 2,000` historical completed sales.

### 4.11 Risks, Dependencies, and Unresolved Questions
- **Question 1 (Version Bump vs Additive Upgrade):** Should we bump `COOCCURRENCE_CACHE_VERSION` from `2` to `3` (clean slate rebuild, zero mixed schema ambiguity) or upgrade `cooccurrence_v2` in place with additive `dedupMode: 'sharded_v1'`?
- **Question 2 (Cancelled Sales Subtraction):** Should we also store minimal `saleProductSets` or handle sale cancellation decrements asynchronously in the same shard/endpoint?

---

<a id="8-feedback-storage-migration-to-firestore"></a>
## 5. §8 Feedback Storage Migration to Firestore

### 5.1 Exact Files and Functions That Will Change
- **`shared/upsellCacheSchema.ts`**
  - Constants & types: `UPSELL_FEEDBACK_VERSION` (line 23), `MAX_FEEDBACK_PRODUCTS` (500), `MAX_FEEDBACK_PAIR_KEYS` (400), `UpsellFeedbackSnapshot` (lines 49–56), `UpsellFeedbackEventInput`
  - Add: `MAX_FEEDBACK_EVENT_IDS` (shared constant instead of server-only), optional `recentEventIds` / Firestore shard compatibility
- **`server/upsellFeedbackStore.ts`**
  - `getServerFeedbackSnapshot()`, `recordServerFeedbackEventWithStatus()`, `loadOrCreateState()` (lines 141–294)
  - Refactor to Firestore-backed hydration + persistence (accepting injectable Firestore client/REST helpers `firestoreGetDoc` / `firestoreUpsertDoc` or Admin SDK) while keeping local `.caremart-cache` strictly as an optional L1 speed cache rather than the authoritative store
- **`server.ts`**
  - `GET /api/upsell/feedback` (lines 2179–2214)
  - `POST /api/upsell/feedback` (lines 2216–2310)
  - Persist updated feedback snapshot + dedup state to `shops/{shopId}/upsellCache/feedback_v1` (or `upsellFeedback` collection)
- **`src/services/upsellFeedbackService.ts`**
  - `hydrateFeedbackFromServer()`, `flushPendingFeedbackEvents()`, `recordUpsellFeedbackEvent()`
  - Add: direct Firestore fallback read on `shops/{shopId}/upsellCache/feedback_v1` (just like `upsellCooccurrenceService.ts` hydrates from Firestore when server cold-starts) and owner/staff sync coordination
- **`firestore.rules`**
  - Expand `match /upsellCache/{cacheId}` (lines 1605–1634) OR add `match /upsellFeedback/{docId}` with strict field validation (`isValidUpsellFeedbackCache`) and bounded `recentEventIds` / shard dedup

### 5.2 Current Implementation and Verified Issue
1. **Ephemeral Container Filesystem Is the Only Backend Store (`server/upsellFeedbackStore.ts:13, 26–29, 121–179`):**
   - `server/upsellFeedbackStore.ts` writes `feedback_v1_<sha256(shopId)>.json` exclusively to `DEFAULT_CACHE_DIR = path.resolve(process.cwd(), '.caremart-cache')`.
   - Unlike co-occurrence (`cooccurrence_v2` in `firestore.rules:1605–1634` + `server.ts:1931–1955`), feedback has **no Firestore collection or rule** at all.
2. **Verified Data Loss Scenarios:**
   - **Cloud Run / Container Restart or Scale-Down-to-Zero:** Container local disk (`.caremart-cache/`) is wiped on every redeploy or idle scale-to-zero event. All learned `shown`, `accepted`, `dismissed`, and `removedAfterAdd` counters reset to zero.
   - **Multi-Instance Split-Brain:** If Cloud Run runs `>= 2` instances, Instance A and Instance B maintain separate `.caremart-cache/` files, returning diverging counters to different POS registers.
   - **Offline Client Replay:** Browser `localStorage` queue (`cm_upsell_feedback_pending_v1_<shopId>`) survives only on that single browser and cannot share cross-register feedback totals once container state resets.

### 5.3 Proposed Solution
Mirror the proven **Co-Occurrence Multi-Tier Architecture** (`Memory -> Container Disk L1 -> Authoritative Firestore`) for Upsell Feedback:

1. **Authoritative Firestore Document (`shops/{shopId}/upsellCache/feedback_v1`):**
   - Document schema mirrors `UpsellFeedbackSnapshot`:
     ```ts
     {
       ownerUid: string;
       version: 1;
       revision: number;
       productStats: Record<string, UpsellFeedbackCounters>;      // max 500 keys
       categoryPairStats: Record<string, UpsellFeedbackCounters>; // max 400 keys
       recentEventIds: string[];                                  // max 1000 recent eventIds for idempotency
       createdAt: Timestamp;
       updatedAt: Timestamp;
     }
     ```
   - Bounded size: `500` product stats (~55 KB) + `400` category pair stats (~45 KB) + `1,000` event IDs (~25 KB) ≈ **~125 KB** total (under 13% of Firestore's 1 MiB limit).
2. **Server Read/Write Flow (`server.ts` & `server/upsellFeedbackStore.ts`):**
   - **Cold hydration on `GET /api/upsell/feedback`:** If in-memory & `.caremart-cache` revision is `0` (`!feedbackFirestoreCheckedShops.has(shopId)`), `server.ts` reads `shops/{shopId}/upsellCache/feedback_v1` using `authCtx.token` (or Firebase Admin if configured) and hydrates `upsellFeedbackStore`.
   - **Write-through on `POST /api/upsell/feedback`:** After validating product ownership and deduplicating `eventId`, update in-memory + disk L1 immediately (sub-millisecond) and debounce/flush the authoritative snapshot to `shops/{shopId}/upsellCache/feedback_v1` (with optimistic concurrency or monotonic counter `max()` merge so concurrent instances never overwrite higher revisions).
3. **Optional Client Fallback Hydration (`src/services/upsellFeedbackService.ts`):**
   - If `/api/upsell/feedback` returns empty/unavailable, client reads `shops/{shopId}/upsellCache/feedback_v1` directly (for owners and `staffCanAddSales` staff), keeping Sales Entry UI non-blocking.
   - Owner writes (or server-proxied writes via authenticated bearer token) commit persisted state to Firestore cleanly.

### 5.4 Required Database/Schema Changes and Migrations
- **New Firestore Document Path:** `shops/{shopId}/upsellCache/feedback_v1` (reuses the existing `upsellCache` collection; no new top-level collections or composite indexes needed because it uses direct `doc()` `get` only, `allow list: if false`).
- **One-Time Migration:**
  - When a shop first hits `GET /api/upsell/feedback` or `POST /api/upsell/feedback` after deployment:
    - If local `.caremart-cache/feedback_v1_*.json` has `revision > 0` and Firestore `feedback_v1` does not exist yet, persist the local snapshot into Firestore `feedback_v1`.
    - Similarly, on the client side, if the browser's `cm_upsell_feedback_mirror_v1_<shopId>` has non-zero stats and both server and Firestore are at `revision: 0`, seed/flush pending events safely.

### 5.5 Compatibility with Existing Data and Credentials
- **100% backwards-compatible:** Existing `UpsellFeedbackSnapshot` interface in `shared/upsellCacheSchema.ts` does not break; only `recentEventIds` (optional) is added for Firestore persistence.
- **Staff & Owner Tokens:** Existing Bearer ID tokens passed to `/api/upsell/feedback` already satisfy Firestore REST write/read permissions (or if staff cannot write `upsellCache` directly in Firestore rules, see §5.7 / §5.11 below on whether staff writes go via server Admin SDK or staff-scoped feedback rule!).

### 5.6 Impact on Owner, Staff, Sales, Purchases, Inventory, and Recommendations
- **Sales Entry & Checkout:** Completely non-blocking (`POST /api/upsell/feedback` fires asynchronously; UI never waits for Firestore persistence).
- **Staff:** Staff POS sessions both benefit from shared shop-wide feedback signals and contribute `shown`/`accepted`/`dismissed` telemetry across shifts and devices.
- **Recommendations:** Eliminates cold resets of acceptance/dismissal penalties across Cloud Run restarts, stabilizing `useSalesAssistant` and `ProductRelatedSuggestions` ranking over time.
- **Purchases / Inventory:** Zero impact.

### 5.7 Firestore Security Rule Changes
In `firestore.rules`:
```rules
function isValidUpsellFeedbackCache(data, shopId) {
  return data.keys().hasAll([
      'ownerUid', 'version', 'revision',
      'productStats', 'categoryPairStats',
      'createdAt', 'updatedAt'
    ])
    && data.keys().hasOnly([
      'ownerUid', 'version', 'revision',
      'productStats', 'categoryPairStats', 'recentEventIds',
      'createdAt', 'updatedAt'
    ])
    && data.ownerUid is string && data.ownerUid == shopId && data.ownerUid.size() <= 128
    && data.version is number && data.version == 1
    && data.revision is number && data.revision >= 0
    && data.productStats is map && data.productStats.size() <= 500
    && data.categoryPairStats is map && data.categoryPairStats.size() <= 400
    && (!('recentEventIds' in data) || (data.recentEventIds is list && data.recentEventIds.size() <= 1000))
    && data.createdAt is timestamp
    && data.updatedAt is timestamp;
}

// Update match /upsellCache/{cacheId} (lines 1605-1634)
match /upsellCache/{cacheId} {
  allow get: if isValidId(cacheId)
    && cacheId in ['cooccurrence_v2', 'feedback_v1']
    && (
      (isOwner(shopId) && (resource == null || (shopExists(shopId) && existing().ownerUid == shopId))) ||
      (staffCanAddSales(shopId) && shopExists(shopId) && (resource == null || existing().ownerUid == shopId))
    );
  allow list: if false;
  allow create: if isValidId(cacheId)
    && shopExists(shopId)
    && incoming().createdAt == request.time
    && incoming().updatedAt == request.time
    && (
      (cacheId == 'cooccurrence_v2' && isOwner(shopId) && isValidUpsellCooccurrenceCache(incoming(), shopId)) ||
      (cacheId == 'feedback_v1' && (isOwner(shopId) || staffCanAddSales(shopId)) && isValidUpsellFeedbackCache(incoming(), shopId))
    );
  allow update: if isValidId(cacheId)
    && existing().ownerUid == shopId
    && incoming().ownerUid == existing().ownerUid
    && incoming().createdAt == existing().createdAt
    && incoming().updatedAt == request.time
    && shopExists(shopId)
    && (
      (cacheId == 'cooccurrence_v2' && isOwner(shopId) && isValidUpsellCooccurrenceCache(incoming(), shopId) && ...) ||
      (cacheId == 'feedback_v1' && (isOwner(shopId) || staffCanAddSales(shopId)) && isValidUpsellFeedbackCache(incoming(), shopId) &&
        incoming().diff(existing()).affectedKeys().hasOnly([
          'version', 'revision', 'productStats', 'categoryPairStats', 'recentEventIds', 'updatedAt'
        ]))
    );
  allow delete: if isOwner(shopId) && isValidId(cacheId) && cacheId in ['cooccurrence_v2', 'feedback_v1'] && shopExists(shopId) && existing().ownerUid == shopId;
}
```
*(Note: If you prefer **not** to let staff tokens directly update `feedback_v1` in Firestore rules, then either use Firebase Admin SDK in `server.ts` or write staff events into a staff-owned `upsellFeedbackEvents/{eventId}` append-only doc that owner/server aggregates.)*

### 5.8 Testing Strategy
1. **Unit & Store Tests (`server/upsellFeedbackStore.test.ts` & `src/services/upsellFeedbackService.test.ts`):**
   - Cold server boot with cleared memory + deleted `.caremart-cache/` -> `GET /api/upsell/feedback` hydrates from mocked `firestoreGetDoc('shops/{shopId}/upsellCache/feedback_v1')` and returns stored counters.
   - `POST /api/upsell/feedback` -> writes through to Firestore mock + updates revision; duplicate `eventId` returns `duplicate: true` without double-incrementing even after simulated server restart.
2. **Firestore Emulator Rules Tests:**
   - Validate schema bounds (`productStats.size() <= 500`, `categoryPairStats.size() <= 400`, `recentEventIds.size() <= 1000`).
   - Verify non-shop users and staff without `canAddSales` are denied read/write access.

### 5.9 Rollback Procedure
1. Revert `server.ts` and `upsellFeedbackStore.ts` to disk-only persistence; `feedback_v1` in Firestore sits harmlessly inert.
2. Revert `firestore.rules` `match /upsellCache/{cacheId}` to `cacheId == 'cooccurrence_v2'` only.

### 5.10 Required Manual Production Actions
1. Deploy updated `firestore.rules`.
2. Deploy updated application build.

### 5.11 Risks, Dependencies, and Unresolved Questions
- **Question (Staff Write Scope in Rules vs Append-Only Event Queue):** Allowing `staffCanAddSales(shopId)` to `update` the shared `feedback_v1` document lets server REST calls work with a staff user's Bearer token without needing a separate Firebase Admin SDK key, **but** theoretically lets a malicious authenticated staff client overwrite `feedback_v1` counters directly via SDK (bounded to that document only, no financial/inventory impact). Alternatively, we can keep `feedback_v1` owner-write-only and let staff write append-only `upsellFeedbackEvents/{eventId}` docs, or use a server Admin SDK credential. Which model do you prefer?

---

<a id="55-firestore-product-and-supplier-deletion-rules"></a>
## 6. §5.5 Firestore Product & Supplier Deletion Rules

### 6.1 Exact Files and Functions That Will Change
- **`firestore.rules`**
  - `match /suppliers/{supplierId}` (`allow delete` at line 1244)
  - `match /products/{productId}` (`allow delete` at line 1283)
  - Optionally `match /staffCatalog/{productId}` (`allow delete`)
  - Helper functions: `canSafelyDeleteProduct()`, `canSafelyDeleteSupplier()` (plus optional `hasTransactionHistory` / lock field validation inside `isValidProduct()` and `isValidSupplier()`)
- **`src/services/shopService.ts`** (only if lock/history marker fields are introduced)
  - `deleteProduct()` (lines 1442–1541) and `deleteSupplier()` (lines 1153–1200) — already enforce full stock, batch, saleItem, and purchaseItem checks in app code (completed in Group 2!)
  - `createPurchase()`, `createSale()`, `adjustStock()` (only if an immutable `hasHistory: true` flag is stamped on `products` / `suppliers` during transactions)
- **`src/types/shop.ts`**
  - Optional `hasTransactionHistory?: boolean` on `Product` / `Supplier` (only if Option B lock flag is chosen)

### 6.2 Current Implementation and Verified Issue
1. **Application Layer Is Already Protected (`shopService.ts`):**
   - `deleteProduct()` (`shopService.ts:1442–1541`) checks: `currentStock > 0`, existing `active` or `exhausted` `inventoryBatches`, and references in `saleItems` or `purchaseItems` before executing `batch.delete(prodRef)`.
   - `deleteSupplier()` (`shopService.ts:1153–1200`) checks: `outstandingBalance > 0`, `totalPurchased > 0`, `totalPaid > 0`, and references in `products` or `purchases` before executing `deleteDoc(ref)`.
2. **Firestore Security Rules Still Permit Direct Unchecked Deletion (`firestore.rules:1244, 1283`):**
   - `firestore.rules:1244`:
     ```rules
     allow delete: if isOwner(shopId) && isValidId(supplierId) && shopExists(shopId) && existing().ownerUid == shopId;
     ```
   - `firestore.rules:1283`:
     ```rules
     allow delete: if isOwner(shopId) && isValidId(productId) && shopExists(shopId) && existing().ownerUid == shopId;
     ```
   - Anyone with an authenticated owner token using the Firebase client SDK or REST API directly (bypassing `shopService.ts`) can hard-delete a `product` that still has `currentStock: 100` or active batches, or a `supplier` with `outstandingBalance: 50000`, breaking financial ledger referential integrity.
3. **Important Firestore Security Rules Architecture Constraint:**
   - Firestore Security Rules **cannot execute collection queries** (`where('productId', '==', productId)` across `saleItems`, `purchaseItems`, or `inventoryBatches`) because `exists()`/`get()` in rules require deterministic document paths. Therefore, rules must enforce what is deterministically provable on the document itself (and/or via a deterministic lock document/flag).

### 6.3 Proposed Solution
Provide a **Two-Tier Rule Hardening Plan** (Tier 1 Zero-Migration Immediate Protection + Optional Tier 2 Deterministic History Lock):

1. **Tier 1 (Zero Schema/Migration — Immediate Deterministic Field Guards in `firestore.rules`):**
   - **`products` `allow delete`:** Require:
     - `existing().currentStock == 0`
     - `existing().emptyContainersOnHand == 0` (when `'emptyContainersOnHand' in existing()`)
     - *(Optional strict policy)* Require `existing().isActive == false` (forces Archive/Deactivate before Delete, matching POS best practice!).
   - **`suppliers` `allow delete`:** Require:
     - `existing().outstandingBalance == 0`
     - `existing().totalPurchased == 0`
     - `existing().totalPaid == 0`
   - **Why Tier 1 is clean:** Every one of those fields is **already mandatory** on every `products` and `suppliers` document (`isValidProduct`, `isValidSupplier` in `firestore.rules`), so **zero database backfill is needed**!
2. **Tier 2 (Optional Full Referential Protection in Rules Even Against Direct REST Calls):**
   - Even with `currentStock == 0`, a product could have `0` remaining stock **because it was sold out** (appearing in historical `saleItems` and exhausted `inventoryBatches`).
   - To enforce "never hard-delete a product with historical transactions" **inside Firestore rules themselves** (not just in `shopService.ts`), add either:
     - **Sub-option 2A (Monotonic Lock Field on Product):** Add optional `hasHistory: true` (once set `true`, rules forbid changing it back to `false`), stamped inside `createPurchase`, `createSale`, and `createInventoryBatch`. `allow delete` requires `!('hasHistory' in existing()) || existing().hasHistory == false`.
     - **Sub-option 2B (Deterministic Lock Marker Doc):** Write `shops/{shopId}/entityLocks/prod_{productId}` once a product enters any purchase/sale/batch; `products` `allow delete` checks `!exists(/databases/$(database)/documents/shops/$(shopId)/entityLocks/prod_$(productId))`.
   - Note: For **existing** products that already had sales/batches prior to deploying Tier 2, a one-time backfill script would mark `hasHistory: true` (or create lock docs) for historical protection; `shopService.ts` continues running its query checks regardless.

### 6.4 Required Database/Schema Changes and Migrations
- **Tier 1:** **Zero** schema changes and **zero** migrations.
- **Tier 2 (only if approved):**
  - **2A:** Add optional `hasHistory?: boolean` to `Product` (`isValidProduct` allows optional `'hasHistory'`, immutable once `true`); one-time owner migration scans `inventoryBatches`, `saleItems`, `purchaseItems` to set `hasHistory: true` on matching `products`.
  - **2B:** Add `entityLocks/{lockId}` subcollection + rules; one-time owner migration writes marker docs for products appearing in `inventoryBatches`/`saleItems`/`purchaseItems`.

### 6.5 Compatibility with Existing Data and Credentials
- **Tier 1:** 100% compatible with every existing product and supplier document in production immediately.
- **Tier 2:** Backwards-compatible for reads/writes; historical protection via rules on pre-existing products only takes effect after running the optional backfill script (until then, `shopService.ts` still enforces full historical query checks).
- No credential changes required.

### 6.6 Impact on Owner, Staff, Sales, Purchases, Inventory, and Recommendations
- **Owner:**
  - Cannot delete a stocked product (`currentStock > 0`) or a supplier with financial history (`totalPurchased > 0`, `totalPaid > 0`, `outstandingBalance > 0`) even via raw API/console SDK calls.
  - If `isActive == false` is required on delete, owner simply edits a newly-created mistake product to Inactive before clicking Delete (or UI offers an "Archive & Delete" flow when stock and history are 0).
- **Staff:** Staff have never had delete permission on `products` or `suppliers`; zero impact.
- **Sales / Purchases / Inventory / Recommendations:** Protects historical report accuracy, COGS attribution, and recommendation `productId` referential integrity.

### 6.7 Firestore Security Rule Changes
**Tier 1 Rules (`firestore.rules:1244, 1283`):**
```rules
// Line 1244 (suppliers)
allow delete: if isOwner(shopId)
  && isValidId(supplierId)
  && shopExists(shopId)
  && existing().ownerUid == shopId
  && existing().outstandingBalance == 0
  && existing().totalPurchased == 0
  && existing().totalPaid == 0;

// Line 1283 (products)
allow delete: if isOwner(shopId)
  && isValidId(productId)
  && shopExists(shopId)
  && existing().ownerUid == shopId
  && existing().currentStock == 0
  && (!('emptyContainersOnHand' in existing()) || existing().emptyContainersOnHand == 0);
  // Optional if Archive-before-delete policy is approved:
  // && existing().isActive == false
  // Optional if Tier 2A lock field is approved:
  // && (!('hasHistory' in existing()) || existing().hasHistory == false);
```
*(Also ensure `staffCatalog/{productId}` `allow delete` mirrors the identical `products/{productId}` state or restricts deletion unless parent product does not exist / has 0 stock.)*

### 6.8 Testing Strategy
1. **Firebase Firestore Emulator Rules Tests:**
   - Direct `deleteDoc` on a product with `currentStock: 5` -> MUST FAIL (`PERMISSION_DENIED`).
   - Direct `deleteDoc` on a product with `currentStock: 0` and `emptyContainersOnHand: 2` -> MUST FAIL (`PERMISSION_DENIED`).
   - Direct `deleteDoc` on a supplier with `outstandingBalance: 100` or `totalPurchased: 500` -> MUST FAIL (`PERMISSION_DENIED`).
   - Direct `deleteDoc` on an unused test product (`currentStock: 0`, `emptyContainersOnHand: 0`, `hasHistory: false`) -> MUST SUCCEED.
2. **Existing Vitest Suite (`src/services/shopService.test.ts`):**
   - Continue asserting `deleteProduct()` and `deleteSupplier()` reject stocked, batched, and historically referenced items cleanly with user-friendly error messages.

### 6.9 Rollback Procedure
1. Restore previous `allow delete` lines (`1244`, `1283`) in `firestore.rules` via `deploy_firebase` or Firebase Console Rules History.
2. Under Tier 1, zero data or code rollback is needed.

### 6.10 Required Manual Production Actions
1. Deploy updated `firestore.rules`.
2. *(Only if Tier 2 is approved)* Run the one-time owner migration script to mark `hasHistory: true` (or write `entityLocks`) for products with existing sales/purchases/batches.

### 6.11 Risks, Dependencies, and Unresolved Questions
- **Question 1 (Tier 1 vs Tier 2):** Is **Tier 1** (enforcing `currentStock == 0`, `emptyContainersOnHand == 0`, and supplier `totalPurchased/totalPaid/outstandingBalance == 0` in `firestore.rules`, paired with the already-implemented `shopService.ts` historical query guards) sufficient, or do you want **Tier 2** (`hasHistory` flag + backfill migration) so even raw REST calls cannot delete a zero-stock historical SKU?
- **Question 2 (Archive-Before-Delete Policy):** Should `firestore.rules` also require `existing().isActive == false` before a product can be hard-deleted, or allow direct deletion of unused active mistake entries as long as stock and history are zero?

---

## Summary Checklist for Approval

To proceed cleanly in small, reversible steps, please indicate your approval and choice for each open decision:

1. **§4.1 Owner Setup Gate:** Approve Option A (server-only bootstrap / lock `appState/ownerSetup` & `admins` creation) or Option B, and confirm `email_verified` handling for password accounts.
2. **§4.3 Encryption Secret Enforcement:** Confirm whether production currently holds saved `.caremart-secrets/*.enc.json` files needing the 2-step `ALLOW_LEGACY_FALLBACK_DECRYPT=true` migration window.
3. **§5.3 FIFO > 50 Batches:** Choose Option A (`250` inline cap + atomic write-budget guard) vs Option B (unlimited `saleItemAllocations` overflow chunks).
4. **§7.1 Co-Occurrence > 2,000 Sales:** Approve `64`-bucket `upsellDedup` shard architecture and indicate whether to bump version `v2 -> v3` or migrate `v2` in place.
5. **§8 Feedback Migration to Firestore:** Approve `shops/{shopId}/upsellCache/feedback_v1` and choose whether staff writes share `feedback_v1` (with `staffCanAddSales` rule) or write to an append-only event/Admin-SDK path.
6. **§5.5 Product & Supplier Delete Rules:** Choose Tier 1 (zero-migration deterministic field checks in rules) vs Tier 2 (`hasHistory` / `entityLocks` backfill), and whether `isActive == false` should be required prior to delete.
