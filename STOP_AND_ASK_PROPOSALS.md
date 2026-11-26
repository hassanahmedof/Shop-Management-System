# CareMart Shop Management System — Final Technical Proposals (v3) for Deferred STOP-AND-ASK Architecture Changes

**Document Version:** `3.0` (Final Pre-Approval Revision)  
**Original v1 Archive:** `/STOP_AND_ASK_PROPOSALS.v1.md` *(Preserved unchanged on disk. Note: This AI Studio workspace container has no `.git` repository initialized — `git status` fails with `fatal: not a git repository` — so v1 is preserved directly as `/STOP_AND_ASK_PROPOSALS.v1.md`.)*  
**Status:** Proposal Only (Awaiting Individual Item Approval — **No Code, Firestore Rules, Schemas, Indexes, Credentials, Production Data, or Deployments Modified**)  
**Firebase Project Database:** `ai-studio-36596f53-ce10-4ba0-aae2-9d7f9051d6fe` (`(default)`)  
**Companion Downloadable Word Document:** `/public/CareMart_STOP_AND_ASK_Technical_Proposals.docx`

---

## Revision History & Summary of v3 Hardening

| Proposal | Key v3 Additions & Corrections |
| :--- | :--- |
| **§4.1 Owner Setup Gate** | Preserves Approach A (`allow create: if false;` + server-side transaction) and Approach B (deploy-time `OWNER_EMAIL` SHA-256 hash + `email_verified == true` + dual-doc atomic batch), explicitly separating verified token verification from unverified Cloud Run IAM eligibility. |
| **§4.3 Encryption & `SESSION_SECRET`** | Explicitly separates (1) Env/Secret-Manager credentials, (2) Persistent-volume vaults, and (3) Ephemeral Cloud Run container disk. Proves from `server.ts` exact `SESSION_SECRET` behavior (`caremart_session` cookie vs Firebase Bearer ID tokens). Enforces strict non-destructive handling on decryption failure (never overwrite/discard failed ciphertext). |
| **§5.3 FIFO > 50 Batches** | Verifies **exact read-before-write phase order** in `createSale`, `editSale`, `cancelSale`, and `reconcileStaffSaleToOwnerLedger`; corrects `reconcileStaffSaleToOwnerLedger` write budget to include `auditLogs` (`+1` at `staffService.ts:1167`); documents 2-round Phase-1 `tx.get` before any write; proves every created sale (`W_create <= 480`) can ALWAYS be cancelled (`W_cancel <= 481 < 500`) and specifies exact regression tests. |
| **§7.1 Co-Occurrence > 2,000 Sales** | Designs a **race-free staging + epoch cutover + catch-up + durable retry** rebuild (`cooccurrence_staging` → atomic cutover to `cooccurrence_v3`), replacing the broken in-place `resetFirst` partial-wipe bug (`upsellCooccurrenceService.ts:976`). Explicitly details atomic `editSale` old-pair reversal + new-pair application and `cancelSale` pair subtraction. |
| **§8 Feedback Migration** | Eliminates any staff-writable shared aggregate; adds **rule-enforced two-condition retention & cleanup** (`folded == true && foldedAt < request.time - 7d/30d`) that can never delete unprocessed `folded == false` events even during extended owner absence. |
| **§5.5 Deletion Locks** | Establishes a **strict 4-phase safe migration & deployment sequence**: never activates strict `allow delete` rules while legacy historical items lack locks (or denies all hard deletes during the migration window), verifies `missingLocks === 0` via manifest before Phase 3, and provides an exact per-phase rollback sequence. |

---

## Table of Contents

1. [§4.1 Owner Setup Gate and Firestore Security Rules](#41-owner-setup-gate-and-firestore-security-rules)
2. [§4.3 Encryption Secret Enforcement, Storage Tiers, Session Impact & Safe Recovery](#43-encryption-secret-enforcement-storage-tiers-session-impact--safe-recovery)
3. [§5.3 FIFO Allocation Read-Before-Write Verification, Exact Write Budgets & Cancellation Proof](#53-fifo-allocation-read-before-write-verification-exact-write-budgets--cancellation-proof)
4. [§7.1 Co-Occurrence Cache Scaling, Race-Free Staging Rebuild & Edit/Cancel Reversal](#71-co-occurrence-cache-scaling-race-free-staging-rebuild--editcancel-reversal)
5. [§8 Atomic, Idempotent Feedback Migration & Safe Folded-Event Retention](#8-atomic-idempotent-feedback-migration--safe-folded-event-retention)
6. [§5.5 Product and Supplier Referential Deletion Locks & Phased Migration Order](#55-product-and-supplier-referential-deletion-locks--phased-migration-order)
7. [Verified Facts vs. Theoretical / Unverified Claims](#verified-facts-vs-theoretical--unverified-claims)

---

<a id="41-owner-setup-gate-and-firestore-security-rules"></a>
## 1. §4.1 Owner Setup Gate and Firestore Security Rules

### 1.1 Exact Files and Functions That Will Change
- **`server.ts`**: `OWNER_GATE_SECRET` (`86–87`), `getConfiguredOwnerEmail()` (`101–111`), `computeOwnerProof()` (`113–118`), `getPrimaryOwnerUidCached()` (`544–552`), `authorizeOwnerUser()` (`554–656`), `GET /api/auth/owner-setup-status` (`938–951`), `POST /api/auth/verify-owner` (`954–997`)
- **`firestore.rules`**: `isOwnerAuthUser()` (`29–35`), `isOwnerSetupAuthorizedFor()` (`45–54`), remove `gateSecret()` (`56–58`), `match /appState/{stateId}` (`857–867`), `match /admins/{adminUid}` (`872–888`)
- **`src/services/shopService.ts`**: `ensureShopInitialized()` (`160–223`)
- **`src/contexts/AuthContext.tsx`**: `initializeForUser()` (`202–408`), `setupInitialAdmin()` (`605–676`)
- **`src/components/LoginScreen.tsx`**: initial setup error / email verification messaging
- **`package.json`**: *(only if Approach A adds `firebase-admin`)*
- **`.env.example`**: document `OWNER_EMAIL`, `OWNER_GATE_SECRET`

### 1.2 Verified Current Flaw & Exact Implementation Approach
- **Verified in `server.ts:554–656`:** When `!primaryOwnerUid`, `authorizeOwnerUser()` only checks `provider in ['password', 'google.com']` and `!email.endsWith('@staff.caremart.app')`—it **never** compares `user.email` against `getConfiguredOwnerEmail()`.
- **Verified in `firestore.rules:56–58, 884`:** `gateSecret()` embeds `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'` in client-readable rules, enabling offline forgery of `ownerProof` and direct Firestore SDK creation of `appState/ownerSetup` + `admins/{uid}` while `appState/ownerSetup` is absent.
- **Verified in `package.json`:** `firebase-admin` is **not** installed; `server.ts` authenticates Firestore REST calls using the caller's Firebase ID token (`Bearer`).

**Two Mutually Exclusive Hardened Approaches (Zero Bypass via Direct Firestore SDK):**
1. **Approach A (Recommended — Server-Only Bootstrap + `allow create: if false` in Rules):**
   - Lock `match /appState/{stateId}` and `match /admins/{adminUid}` to `allow create, update, delete: if false;` in `firestore.rules` so **no client** can ever create initial owner documents via the Firestore SDK.
   - Provision `firebase-admin` (using Cloud Run ADC or `FIREBASE_SERVICE_ACCOUNT_JSON`) in `server.ts`. Inside `POST /api/auth/verify-owner` (`mode: 'setup'`), enforce `OWNER_EMAIL` configured (fail closed `503` if unset in production), `user.email === configuredEmail`, and `user.emailVerified === true`, then execute a server Firestore transaction checking `!appState/ownerSetup.exists` before atomically creating `appState/ownerSetup` + `admins/{uid}`.
   - Update `ensureShopInitialized()` (`shopService.ts:160–223`) so it expects `appState/ownerSetup` and `admins/{uid}` to already exist rather than writing them from the client.
2. **Approach B (Hardened Client Rules — Enforce Actual Configured `OWNER_EMAIL` Without Admin SDK):**
   - Remove static `gateSecret()` completely from `firestore.rules` and remove the hardcoded fallback in `server.ts:86–87` in production.
   - Because Firestore rules cannot read `process.env.OWNER_EMAIL` dynamically, bind the SHA-256 digest of the actual lowercased `OWNER_EMAIL` into `firestore.rules` at deploy time (`isConfiguredOwnerEmail()`), plus enforce `request.auth.token.email_verified == true`, `isNotStaffAccount(request.auth.uid)`, `!exists(.../appState/ownerSetup)`, and atomic dual-doc batch (`existsAfter(.../admins/$(request.auth.uid))` paired with `existsAfter(.../appState/ownerSetup)`).
   - Simultaneously enforce `user.email === getConfiguredOwnerEmail()` + `user.emailVerified === true` inside `server.ts` `authorizeOwnerUser()`.
   - Pre-deploy verification script aborts deployment if `firestore.rules` still contains an unreplaced email-hash placeholder.

### 1.3 Transaction Behavior, Backward Compatibility & Failure Recovery
- **Concurrent Setup Race:** Under Approach A, Firestore server transaction precondition `exists: false` on `appState/ownerSetup` lets at most one request succeed (`409` for losers). Under Approach B, Firestore serializes `!exists(appState/ownerSetup)` atomically across concurrent batches.
- **Unverified Password Accounts:** If `createUserWithEmailAndPassword` yields `emailVerified === false`, `setupInitialAdmin()` triggers `sendEmailVerification()`, prompts verification, and does not write `appState/ownerSetup` until `email_verified == true`.
- **Backward Compatibility:** Already-initialized primary owners (`appState/ownerSetup` exists, `admins/{uid}` exists), added admins (`adminAuthMap`), and staff (`staffAuthMap`) are 100% unaffected because `isAuthorizedAdminDoc()` (`firestore.rules:60–64`) never checks `ownerProof` or `gateSecret()` after creation.

### 1.4 Firestore Rules, Migration Order, Rollback & Tests
- **Rules (`firestore.rules`):** Change `appState/ownerSetup` `allow get` from unauthenticated (`line 858`) to `allow get: if isOwnerAuthUser() && stateId == 'ownerSetup';`. Apply Approach A (`allow create: if false;`) or Approach B (`isConfiguredOwnerEmail()` + `email_verified == true`).
- **Migration Order:** (1) Provision `OWNER_EMAIL` + `OWNER_GATE_SECRET` in Cloud Run Secrets; (2) deploy server/client code; (3) deploy updated `firestore.rules`.
- **Rollback:** Re-deploy previous `firestore.rules` revision from Firebase Console Rules History and redeploy prior server image; zero documents modified for initialized shops.
- **Tests:** Emulator tests asserting unauthorized email, unverified email, legacy `ownerProof` forgery, and unauthenticated `getDoc(appState/ownerSetup)` all return `PERMISSION_DENIED`; server Vitest tests asserting `403` / `503` fail-closed responses.

---

<a id="43-encryption-secret-enforcement-storage-tiers-session-impact--safe-recovery"></a>
## 2. §4.3 Encryption Secret Enforcement, Storage Tiers, Session Impact & Safe Recovery

### 2.1 Exact Files and Functions That Will Change
- **`server/googleSheetsService.ts`**: `getVaultEncryptionKey()` (`39–48`), `readServiceAccountFromVault()`, `saveServiceAccountForOwner()` (`324–385`), `VAULT_DIR`
- **`server/discordNotifier.ts`**: `getVaultEncryptionKey()` (`54–63`), `readWebhookFromVault()` (`156–220`), `saveDiscordWebhookForOwner()` (`370–427`), `VAULT_DIR`
- **`server.ts`**: `OWNER_GATE_SECRET` (`86–87`), `SESSION_SECRET` (`88–93`), startup/config validation, `/api/health` non-secret diagnostics
- **`.env.example`**: document `SERVICE_ACCOUNT_ENCRYPTION_KEY`, `SESSION_SECRET`, `LEGACY_ENCRYPTION_KEYS`, `ALLOW_LEGACY_FALLBACK_DECRYPT`

### 2.2 Explicit Distinction of Credential Storage Models & Cloud Run Behavior

| Storage Mechanism | Where Credentials Live | Survives Cloud Run Restart / Scale-to-Zero? | Shared Across Cloud Run Instances? | Encrypted With `SERVICE_ACCOUNT_ENCRYPTION_KEY`? |
| :--- | :--- | :---: | :---: | :---: |
| **1. Environment / Secret Manager (`GOOGLE_SERVICE_ACCOUNT_JSON`, `DISCORD_WEBHOOK_URL`)** | Injected into `process.env` by Cloud Run / GCP Secret Manager | **Yes** | **Yes** | N/A (managed natively by Secret Manager KMS) |
| **2. Persistent Disk Vault (`CAREMART_SECRETS_DIR` on mounted volume)** | `.caremart-secrets/sa_*.enc.json` & `discord_*.enc.json` on persistent volume (Filestore / Persistent Disk / GCS mount) | **Yes** | **Yes** (if RWX volume) | **Yes** (`AES-256-GCM`) |
| **3. Ephemeral Cloud Run Container Disk (Current Default)** | Local container `./.caremart-secrets/` (`path.resolve(process.cwd(), '.caremart-secrets')`) | **NO — wiped on restart, cold scale-to-zero, or redeploy** | **NO — per-instance only** | **Yes** while that single container stays alive |
| **4. Optional Follow-Up: Server-Only Firestore Vault Envelope (`shops/{shopId}/serverVault/*`)** | Encrypted `v: 2` ciphertext stored in Firestore (`allow read, write: if false;` for all clients), decrypted only in `server.ts` using `SERVICE_ACCOUNT_ENCRYPTION_KEY` | **Yes** | **Yes** | **Yes** (`AES-256-GCM`) |

- **Verified Workspace State:** `.caremart-secrets/` **does not exist** locally in `/app/applet`. If production runs stateless Cloud Run without a persistent volume or env secrets, any credential previously pasted into Settings UI on an earlier container revision was already lost on restart—no key migration can recover files deleted by Cloud Run's ephemeral filesystem.

### 2.3 Exact Impact of Changing `SESSION_SECRET` (Verified in `server.ts`)
- **Verified Code Paths (`server.ts:88–95, 244–270, 974, 1010, 1026–1044`):**
  - `SESSION_SECRET` is used **only** to HMAC-SHA256 sign and verify the `caremart_session` HTTP-only cookie set by `POST /api/auth/verify-owner` (`line 974`) and `POST /api/auth/verify-staff` (`line 1010`), and checked **only** by `GET /api/auth/session` (`lines 1026–1039`).
  - Searching `src/` confirms **zero client calls to `/api/auth/session`**. All protected backend endpoints (`requireOwnerMiddleware`, `requireStaffMiddleware`, `resolveShopIdForUpsellRoute`) and all Firestore client queries authenticate via **Firebase Auth ID tokens** (`Authorization: Bearer <token>`), NOT the `caremart_session` cookie.
- **Exact User Experience When `SESSION_SECRET` Changes:**
  1. Any existing `caremart_session` cookie in browsers immediately fails `crypto.timingSafeEqual` inside `verifySessionToken()`, so `GET /api/auth/session` returns HTTP `401 { authenticated: false }`.
  2. **Active Owner and Staff users in the React app are NOT logged out and see zero POS/Dashboard disruption**, because Firebase Auth ID tokens remain valid.
  3. On the next page reload or sign-in (`AuthContext.initializeForUser()`), `/api/auth/verify-owner` or `/api/auth/verify-staff` issues a fresh `caremart_session` cookie signed with the new `SESSION_SECRET`.
- **Production Enforcement:** Require explicit `SESSION_SECRET` (`>= 32` chars) in `NODE_ENV === 'production'`. If unset in production, generate a per-boot random 32-byte key in memory (`crypto.randomBytes(32).toString('hex')`) with a critical startup warning rather than deriving from a public hardcoded literal (for single-instance ephemeral boot safety, `caremart_session` refreshes cleanly on reload).

### 2.4 Non-Destructive Vault Migration & Failure Recovery Rules
1. **`v: 2` Key Derivation Separation:** Primary writes in `googleSheetsService.ts` and `discordNotifier.ts` derive keys strictly from `SERVICE_ACCOUNT_ENCRYPTION_KEY` (`>= 32` chars) via `crypto.hkdfSync('sha256', keySeed, salt, info, 32)`. In `NODE_ENV === 'production'`, saving a vault fails (`503`) if `SERVICE_ACCOUNT_ENCRYPTION_KEY` is missing, short, or equal to `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'`.
2. **Ordered Read Decryption Chain (`v: 1` → `v: 2`):**
   - Try: (1) `SERVICE_ACCOUNT_ENCRYPTION_KEY` (`v: 2` HKDF or `v: 1` SHA-256), (2) `LEGACY_ENCRYPTION_KEYS` (comma-separated explicit previous keys), (3) `LEGACY_OWNER_GATE_SECRET` / `OWNER_GATE_SECRET`, (4) legacy literal `'cm_gate_...'` **only when `ALLOW_LEGACY_FALLBACK_DECRYPT === 'true'`**.
3. **Immutable `.v1.bak` Before Atomic Re-Encrypt:** When decrypted via a fallback key, validate parsed payload → copy raw file to `<vault>.v1.bak.<ts>` (`0600`) → write `v: 2` via `.tmp` + `renameSync` (serialized per-file in-process promise lock).
4. **NEVER Overwrite or Discard on Decryption Failure:** If AES-256-GCM authentication fails for all configured keys:
   - **Never delete, truncate, or overwrite `.enc.json`!**
   - Preserve the exact file untouched on disk and return structured status `decrypt_failed` (`VAULT_DECRYPT_KEY_MISMATCH`) in `/api/admin/sheets/status` and `/api/health`.
   - Operator either restores the original key in `LEGACY_ENCRYPTION_KEYS` OR owner explicitly submits new credentials in Settings UI (which moves the unreadable file to `<vault>.unreadable.<ts>.bak` rather than erasing evidence).

### 2.5 Firestore Rules, Migration Order, Backward Compatibility, Rollback & Tests
- **Firestore Rules:** None required for disk vaults. (If optional `serverVault` in Firestore is ever added later: `allow read, write: if false;` for all clients.)
- **Migration Order:** Inspect live Cloud Run secrets/volume first → generate `SERVICE_ACCOUNT_ENCRYPTION_KEY`, `SESSION_SECRET`, `OWNER_GATE_SECRET` → deploy Step 1 with `ALLOW_LEGACY_FALLBACK_DECRYPT=true` + `LEGACY_ENCRYPTION_KEYS` → trigger Owner `/api/admin/sheets/status` & `/api/health?probe=discord` → confirm `v: 2` migration logs → deploy Step 2 removing legacy flags (and preferably configure `GOOGLE_SERVICE_ACCOUNT_JSON` & `DISCORD_WEBHOOK_URL` in Cloud Run Secrets).
- **Rollback:** Restore `.v1.bak` over `.enc.json` and revert `SERVICE_ACCOUNT_ENCRYPTION_KEY` / `OWNER_GATE_SECRET` / `SESSION_SECRET` env vars in Cloud Run.
- **Tests:** Vitest tests in `googleSheetsService.test.ts` and `discordNotifier.test.ts` covering `v: 1`→`v: 2` upgrade, `.v1.bak` creation, wrong-key preservation (`VAULT_DECRYPT_KEY_MISMATCH`, file bytes unchanged), and `NODE_ENV=production` weak-key rejection.

---

<a id="53-fifo-allocation-read-before-write-verification-exact-write-budgets--cancellation-proof"></a>
## 3. §5.3 FIFO Allocation Read-Before-Write Verification, Exact Write Budgets & Cancellation Proof

### 3.1 Exact Files and Functions That Will Change
- **`src/types/shop.ts`**: add `allocationsStorageMode?: 'inline' | 'chunked'`, `allocationChunkCount?: number`, `totalAllocationCount?: number` on `SaleItem`, plus `SaleItemAllocationChunk`
- **`src/utils/packaging.ts`**: `allocateFifoFromBatches()` (`line 701+`) — assert 1 allocation entry per unique `batchId`
- **`src/services/shopService.ts`**: `createSale()` (`2320–2625`), `editSale()` (`2627–3071`), `cancelSale()` (`3073–3255`)
- **`src/services/staffService.ts`**: `reconcileStaffSaleToOwnerLedger()` (`955–1243`)
- **`firestore.rules`**: `isValidSaleItem` (`545–584`), `match /saleItems/{itemId}`, new `match /saleItemAllocations/{chunkId}`
- **`firestore.indexes.json`**: optional `(ownerUid ASC, saleId ASC)` on `saleItemAllocations`

### 3.2 Verified Transaction Read-Before-Write Order & Exact Write Budgets

#### Verification Against Actual Code (Line-by-Line)
1. **`createSale()` (`src/services/shopService.ts:2357–2580`):**
   - **Reads (`tx.get`):** Lines `2360–2363` read all `products[involvedPids]` and `inventoryBatches[candidateBatchIds]` via `Promise.all`. Zero `tx.get` calls occur anywhere after line `2363`.
   - **First Write:** Line `2466` (`saleItems`).
   - **Verified Exact Writes:**
     - `1` `sales/{saleId}` (`line 2533`)
     - `L` `saleItems` (`line 2466`, `L = merged.size`)
     - `L` `stockMovements` (`line 2495`, 1 per merged line)
     - `P` `products` (`line 2515`, `P = runningStock.size <= L`)
     - `B` `inventoryBatches` (`line 2522`, `B = batchMutations.size`)
     - `1` `auditLogs` (`line 2555`)
     - `+ C_new` `saleItemAllocations` overflow chunks (`ceil(max(0, allocs_i - 50) / 150)` per line)
     - **Exact Formula:** `W_create = 2L + P + B + 2 + C_new`
2. **`reconcileStaffSaleToOwnerLedger()` (`src/services/staffService.ts:984–1216`):**
   - **Reads (`tx.get`):** Lines `989–994` read `ssRef`, `saleRef`, `products[uniqueProdIds]`, and `inventoryBatches[candidateBatchIds]` via `Promise.all`. Zero `tx.get` calls after line `994`.
   - **First Write:** Line `1072` (`stockMovements`).
   - **Verified Exact Writes (Corrected from v2!):**
     - `1` `sales/{staffSale.id}` (`line 1141`)
     - `1` `staffSales/{staffSale.id}` (`line 1162`)
     - `L` `saleItems` (`line 1094`, `L = currentSS.items.length`)
     - `L_prod` `stockMovements` (`line 1072`, `<= L`, written when `prod` exists)
     - `P` `products` (`line 1124`)
     - `B` `inventoryBatches` (`line 1131`, `B = batchMutations.size`)
     - `1` `auditLogs` (`line 1167`, `SYNC_STAFF_SALE` — omitted in v2, verified at line 1167!)
     - `+ C_new` `saleItemAllocations` overflow chunks
     - **Exact Formula:** `W_reconcile = L + L_prod + P + B + 3 + C_new <= 2L + P + B + 3 + C_new`
3. **`editSale()` (`src/services/shopService.ts:2734–3043`):**
   - **Reads (`tx.get`):** Currently lines `2737–2742` read `saleRef`, `ssRef`, `products[allProductIds]`, and `inventoryBatches[candidateBatchIds]` via `Promise.all`. Zero `tx.get` calls occur after line `2742`.
   - **Proposed Read-Before-Write Extension for Overflow Chunks (Strictly Phase 1 Before Line `2824`):**
     - **Phase 1 Round 1:** `tx.get(saleRef)`, `tx.get(ssRef)`, `tx.get(products[allProductIds])`, AND deterministic chunk docs `tx.get(saleItemAllocations/${item.id}_c${0..item.allocationChunkCount - 1})` for every `existingItem` with `allocationsStorageMode === 'chunked'`.
     - **Phase 1 Round 2 (Still Strictly Before Any Write!):** Union all `batchId`s discovered inside those chunk docs with `candidateBatchIds`, then call `tx.get(inventoryBatches[...])` for every missing referenced batch ID **before line `2824` (`tx.update(products)`)**.
     - **Assert Transaction Integrity:** Verify `saleSnap.data().itemCount === existingItems.filter(i => i.status !== 'cancelled').length` (or `saleVersion` counter on `sales`) so concurrent edits never read stale `existingItems`.
   - **Verified Exact Writes:**
     - `1` `sales/{sale.id}` (`line 2984`)
     - `H_ss` (`0` or `1`) `staffSales/{sale.id}` (`line 3021`, if `ssSnap.exists()`)
     - `P_delta` `products` (`line 2824`, where `stockDelta !== 0`, `<= P`)
     - `P_delta` `stockMovements` (`line 2830`, `<= P`)
     - `D` deleted `saleItems` (`line 2870`, non-reused old items)
     - `L` updated/created `saleItems` (`lines 2915, 2932`, `L = newMap.size`)
     - `B_touched` `inventoryBatches` (`line 2967`, deduplicated across restored + newly allocated batches, `<= B_old + B_new`)
     - `1` `auditLogs` (`line 3035`)
     - `+ C_new` overflow chunk writes (created/updated chunks) + `C_old_del` overflow chunk deletes (for deleted/shrunk items)
     - **Exact Formula:** `W_edit = L + D + 2*P_delta + B_touched + 2 + H_ss + C_new + C_old_del`
4. **`cancelSale()` (`src/services/shopService.ts:3103–3229`):**
   - **Reads (`tx.get`):** Currently lines `3109–3114` read `saleRef`, `ssRef`, `products[uniqueProdIds]`, and `inventoryBatches[batchIdList]` via `Promise.all`. Zero `tx.get` calls occur after line `3114`.
   - **Proposed Read-Before-Write Extension for Overflow Chunks (Strictly Phase 1 Before Line `3143`):**
     - **Phase 1 Round 1:** `tx.get(saleRef)`, `tx.get(ssRef)`, `tx.get(products[uniqueProdIds])`, AND deterministic chunk docs `tx.get(saleItemAllocations/${item.id}_c${0..item.allocationChunkCount - 1})`.
     - **Phase 1 Round 2 (Before Line `3143`):** Merge all chunk `batchAllocations` into `referencedBatchIds`, then `tx.get` every referenced `inventoryBatches` doc before any `tx.update` executes.
   - **Verified Exact Writes:**
     - `1` `sales/{sale.id}` (`line 3206`)
     - `H_ss` (`0` or `1`) `staffSales/{sale.id}` (`line 3213`)
     - `L_active` `saleItems` status updates (`line 3143`)
     - `L_active_prod` `stockMovements` (`line 3156`, `<= L_active`)
     - `P` `products` (`line 3199`)
     - `B_restored` `inventoryBatches` (`line 3191`, `<= B_created`)
     - `1` `auditLogs` (`line 3221`)
     - `0` `saleItemAllocations` writes (overflow chunks remain read-only audit records)
     - **Exact Formula:** `W_cancel = L_active + L_active_prod + P + B_restored + 2 + H_ss <= 2*L_active + P + B_restored + 2 + H_ss`

### 3.3 Proof of Complete Allocation Recording & Guaranteed Cancellation Restoration
1. **Zero Truncation Invariant:** Remove `.slice(0, 50)` at `shopService.ts:2486`, `shopService.ts:2900`, and `staffService.ts:1114`. Allocations `0..49` live on `saleItems/{id}.batchAllocations`; allocations `50..total-1` live in deterministic `saleItemAllocations/${itemId}_c${0..K-1}` (150 per chunk). Assert `inlineCount + sum(chunkCounts) === fifo.allocations.length` inside the transaction before writing `saleRef`.
2. **Pre-Commit Budget Guard (`W <= 480`):** Compute `W` inside `createSale`, `editSale`, and `reconcileStaffSaleToOwnerLedger` **before** calling any `tx.set` / `tx.update` / `tx.delete`. If `W > 480` (leaving 20 writes margin below Firestore's 500-op hard ceiling), throw a deterministic error (`"Transaction exceeds 480 Firestore operations (${W} required across ${B} batches). Split sale lines."`) so zero partial deductions commit.
3. **Mathematical Cancellation Guarantee:**
   - Suppose a sale was created by `createSale()` (`W_create = 2L + P + B + 2 + C_new <= 480`) OR by `reconcileStaffSaleToOwnerLedger()` (`W_reconcile = L + L_prod + P + B + 3 + C_new <= 480`).
   - When `cancelSale()` runs on that sale:
     - Case 1 (owner sale, `H_ss = 0`, `C_new >= 0`): `W_cancel <= 2L + P + B + 2 <= W_create <= 480 < 500`.
     - Case 2 (reconciled staff sale, `H_ss = 1`, `C_new >= 0`): `W_cancel <= 2L + P + B + 3 <= W_reconcile <= 480 < 500`.
   - Even if `editSale()` was allowed only when `W_edit <= 480` (which constrains the new post-edit `L', P', B', C_new'` identically to `2L' + P' + B' + 2 + H_ss <= 480`, except if `B_new` alone was much smaller than `B_old`? Wait—verify that edge case! In `editSale()`, `W_edit` uses `B_touched`, `L`, `2*P_delta`. If `editSale()` created a sale with `L_new=20, P_new=20, B_new=400`, wait: `editSale` only wrote `2*P_delta <= 40` stock movements, whereas `cancelSale` writes `L_active` `saleItems` + `L_active` `stockMovements`! **Good catch!** Therefore `editSale()` MUST ALSO check the future cancellation invariant `2*L_new + P_new + B_new + 3 <= 480` before committing!).
   - With `2L + P + B + 3 <= 480` checked on **both** `createSale`, `reconcileStaffSaleToOwnerLedger`, AND `editSale` (in addition to `W <= 480`), **every sale that can ever exist in the database is mathematically guaranteed to satisfy `W_cancel <= 480 < 500`** and restore **100% of every deducted batch** in one atomic transaction!

### 3.4 Firestore Rules, Backward Compatibility, Rollback & Regression Tests
- **Firestore Rules:** Allow optional `allocationsStorageMode`, `allocationChunkCount`, `totalAllocationCount` in `isValidSaleItem` (`545–584`) and `saleItems` `affectedKeys`; add `match /saleItemAllocations/{chunkId}` enforcing `chunkId == incoming().saleItemId + '_c' + string(incoming().chunkIndex)`, `allow update: if false;`.
- **Backward Compatibility:** Existing `saleItems` without `allocationsStorageMode` (`0..50` allocations) restore identically with zero migration.
- **Migration Order & Rollback:** Deploy `firestore.rules` first, then client build. On rollback, keep `saleItemAllocations` readable in rules so any chunked sales created before rollback remain cancellable/editable.
- **Required Regression Tests (To Be Added Upon Approval):**
  1. **Single-line 120-batch & 350-batch `createSale` → `cancelSale`:** Assert `W_create <= 480`, 100% of batches (`350`) written across inline + chunks, then `cancelSale` restores `remainingBaseQty === initialBaseQty` and `status === 'active'` for **all 350 batches** and `product.currentStock` matches `sum(batches.remainingBaseQty)`.
  2. **Multi-item boundary sale (`L = 10`, `B = 450`, `W = 475 <= 480`) → `cancelSale`:** Prove cancellation succeeds without hitting 500-op failure and restores all 450 batches.
  3. **Staff-reconciled 120-batch `reconcileStaffSaleToOwnerLedger` → `cancelSale`:** Assert `W_reconcile` accurately counts `auditLogs` (`+1`), writes chunks, and `cancelSale` restores all 120 batches + marks `staffSales` cancelled.
  4. **`editSale` 120-batch → 65-batch reduction + invariant test:** Assert batches 1–120 read in Phase 1 before any write, `editSale` rejects if future `W_cancel` would exceed `480`, and all remaining batches restore cleanly.
  5. **Over-budget rejection test (`W = 485 > 480`):** Assert atomic abort leaves `0` modified products or batches.

---

<a id="71-co-occurrence-cache-scaling-race-free-staging-rebuild--editcancel-reversal"></a>
## 4. §7.1 Co-Occurrence Cache Scaling, Race-Free Staging Rebuild & Edit/Cancel Reversal

### 4.1 Exact Files and Functions That Will Change
- **`shared/upsellCacheSchema.ts`**: `COOCCURRENCE_CACHE_VERSION = 3`, `CooccurrenceSnapshotV3`, `UpsellProcessedSaleDoc`, `UpsellRebuildCatchupDoc`
- **`server/upsellCooccurrenceStore.ts`**: demote local file cache to non-authoritative `(epoch, revision)` L1 cache; remove 2,000-ID eviction counter mutations
- **`src/services/upsellCooccurrenceService.ts`**: `enqueueSaleCooccurrenceUpdate()`, `enqueueCooccurrenceMutationReconcile()` → atomic `applySaleEditDeltaToCooccurrence()`, `applySaleCancelReversalToCooccurrence()`, new staged rebuild `runStagedCooccurrenceRebuild()`
- **`src/services/shopService.ts`**: `cancelSale()` & `editSale()` invoke deterministic async co-occurrence edit/cancel events with `saleRevision` + `productIds`
- **`src/services/staffService.ts`**: `reconcileStaffSaleToOwnerLedger()` enqueues co-occurrence update under Owner context once reconciled
- **`server.ts`**: `/api/upsell/cooccurrence`, `/update`, `/rebuild`, `/mutate`
- **`firestore.rules`**: `isValidUpsellCooccurrenceCacheV3`, `match /upsellCache/{cacheId}`, `match /upsellProcessedSales/{saleId}`, `match /upsellRebuildCatchup/{eventId}`

### 4.2 Unbounded Deduplication + Race-Free Staged Rebuild & Cutover Design

#### Why `upsellProcessedSales/{saleId}` Replaces All Bounded Arrays & Buckets
- Every counted sale receives an independent ~250-byte document `shops/{shopId}/upsellProcessedSales/{saleId}` (`{ ownerUid, saleId, epoch, saleRevision, status: 'counted' | 'reverted', productIds: string[<=40], updatedAt }`).
- **Zero 2,000-ID eviction, zero 5,000-ID bucket overflow, zero 1 MiB document limits**, even at 500,000+ sales.

#### Race-Free Staged Rebuild & Atomic Cutover Protocol (Fixing `upsellCooccurrenceService.ts:976`)
1. **Problem with Current Code (`upsellCooccurrenceService.ts:951–1009`):** Current rebuild sends `resetFirst: true` on chunk `0`, wiping the active cache before chunks `1..N` arrive and racing with live sales/cancellations.
2. **Staged Rebuild Protocol (Live POS Traffic Never Interrupted or Wiped):**
   - **Step A — Lock & Open Staging Epoch (`runTransaction` on `cooccurrence_v3` + `cooccurrence_staging`):**
     - Read live `cooccurrence_v3` (`epoch = E`). Check if an active non-stale rebuild lock exists (`activeRebuild.expiresAt > now`).
     - Set `targetEpoch = E + 1`, `rebuildStartedAt = serverTimestamp()`, and set `cooccurrence_v3.activeRebuildEpoch = targetEpoch` (`cooccurrence_v3` live counts remain **100% untouched** for POS reads!).
     - Create `shops/{shopId}/upsellCache/cooccurrence_staging` initialized at `epoch: targetEpoch`, `totalCompletedSales: 0`, empty counts, `status: 'building'`, `watermarkSaleId: ''`.
   - **Step B — Dual-Logging Live Mutations During Rebuild:**
     - While `cooccurrence_v3.activeRebuildEpoch === targetEpoch`, **every** live `createSale`, `editSale`, and `cancelSale` continues updating live `cooccurrence_v3` (`epoch = E`) normally **AND** also appends an immutable catch-up event doc `shops/{shopId}/upsellRebuildCatchup/${targetEpoch}_${saleId}_${mutationSeq}` (`{ ownerUid, targetEpoch, saleId, action: 'completed' | 'edited' | 'cancelled', productIds, appliedToStaging: false, createdAt }`).
   - **Step C — Paginated Historical Scan Into `cooccurrence_staging`:**
     - Stream existing `sales` (`where('ownerUid', '==', shopId).where('status', '==', 'completed').orderBy('createdAt')`, page size `150`) and batch-read their `saleItems`.
     - For each page inside a **staging checkpoint transaction**:
       - Update `cooccurrence_staging` counts + `watermarkSaleId` + write `upsellProcessedSales/{saleId}` (`epoch: targetEpoch`, `status: 'counted'`, `productIds`) for each sale in the page (using `tx.get` check so resumable retries after a network drop at page 4 never double-count page 3!).
       - **Failure mid-rebuild:** Live `cooccurrence_v3` (`epoch = E`) was never modified! Retrying resumes cleanly from `watermarkSaleId` (or restarts safely with `targetEpoch + 1`).
   - **Step D — Catch-Up Drain (Reconciling Concurrent Sales, Edits & Cancellations):**
     - After historical pagination finishes, query `upsellRebuildCatchup` where `targetEpoch == targetEpoch && appliedToStaging == false` (in batches of `<= 40` inside `runTransaction`).
     - For each catch-up event, read `upsellProcessedSales/{saleId}` (`tx.get`) and `sales/{saleId}` (`tx.get`, authoritative source of truth!):
       - If `sales/{saleId}.status === 'cancelled'` and `dedup.epoch === targetEpoch && dedup.status === 'counted'`: subtract `dedup.productIds` from `cooccurrence_staging`, set `dedup.status = 'reverted'`.
       - If `sales/{saleId}.status === 'completed'`:
         - If `dedup.epoch === targetEpoch && dedup.status === 'counted'`: if `dedup.productIds` differs from latest `newIds` (edited during rebuild!), subtract `dedup.productIds`, add `newIds`, update `dedup.productIds = newIds`! If identical, skip cleanly (0 double-counting!).
         - If `dedup` is missing or `dedup.epoch < targetEpoch`: add `newIds`, write `dedup` (`epoch: targetEpoch`, `status: 'counted'`).
       - Mark catch-up doc `appliedToStaging = true`.
   - **Step E — Atomic Cutover Transaction (`cooccurrence_staging` → `cooccurrence_v3`):**
     - Inside one `runTransaction`: verify `stagingSnap.status === 'building'`, verify zero remaining unapplied `upsellRebuildCatchup` docs for `targetEpoch` (re-run Step D if any arrived in the last millisecond!), then **atomically** overwrite `cooccurrence_v3` with `cooccurrence_staging`'s counts, `epoch: targetEpoch`, `revision: live.revision + 1`, `activeRebuildEpoch: null`, and mark `cooccurrence_staging.status = 'committed'`.
     - Any concurrent live sale transaction running 1ms after cutover sees `live.epoch === targetEpoch`, aborts if it read stale `E`, retries automatically on `targetEpoch`, reads `upsellProcessedSales/{saleId}` (`epoch === targetEpoch`?), and either skips (already caught up!) or applies once!

### 4.3 Exact `editSale` & `cancelSale` Delta Reversal + Durable Retry Handling
- **`editSale(uid, sale, existingItems, updated)` Behavior:**
  - `shopService.ts` computes `nextProductIds` directly from `updated.items` and calls `enqueueCooccurrenceMutationReconcile(uid, sale.id, { action: 'edited', productIds: nextProductIds })`.
  - Transaction reads `matrixRef = cooccurrence_v3` and `dedupRef = upsellProcessedSales/{sale.id}`:
    1. **If `dedupSnap.exists() && dedupSnap.epoch === matrix.epoch && dedupSnap.status === 'counted'`:**
       - Read `oldIds = dedupSnap.productIds` (canonical unique list originally counted).
       - **Reverse old combinations:** Decrement `totalCompletedSales` (`max(0, total - 1)`), `saleCountsByProduct[p]` (`max(0, count - 1)` for each `p` in `oldIds`), and every unordered pair `(a, b)` in `oldIds` (`pairCounts[a][b] = max(0, count - 1)`, `pairCounts[b][a] = max(0, count - 1)`; delete 0-count keys to keep map clean).
    2. **Apply new combinations (`nextProductIds`):**
       - Normalize unique `newIds` (`<= 40`). Increment `totalCompletedSales += 1`, `saleCountsByProduct[p] += 1`, and every unordered pair `(a, b)` in `newIds` (`+1`).
    3. Update `dedupRef` (`epoch: matrix.epoch, status: 'counted', productIds: newIds`) and `matrixRef.revision += 1`.
    - *(For `cancelSale`, Step 1 executes identically, Step 2 is skipped, and `dedupRef.status` is set to `'reverted'`.)*
- **Durable Retry Queue (`cm_upsell_pending_updates_v3_<shopId>`):**
  - Pending mutations store `{ saleId, action: 'completed' | 'edited' | 'cancelled', productIds, mutationSeq, retryCount, nextAttemptAt }` in `localStorage`.
  - If offline or transaction contention persists after 5 SDK retries, item remains in the durable queue with bounded exponential backoff (`3s, 10s, 30s, 90s`, re-flushed on `online` event & next `syncCooccurrenceWithBackend`), preserving monotonic `mutationSeq` so out-of-order stale events never overwrite newer edits/cancellations.

### 4.4 Firestore Rules, Migration Order, Backward Compatibility, Rollback & Tests
- **Firestore Rules:** `cooccurrence_v3` + `cooccurrence_staging` readable by `isOwner(shopId) || staffCanAddSales(shopId)`, writable by `isOwner(shopId)` (and server Admin SDK if provisioned). `upsellProcessedSales/{saleId}` writable by `isOwner(shopId)`. `upsellRebuildCatchup/{eventId}` creatable by `isOwner(shopId) || staffCanAddSales(shopId)` (`appliedToStaging == false` for staff), updatable/deletable by `isOwner(shopId)`.
- **Backward Compatibility & Rollback:** `cooccurrence_v2` remains intact during rollout; rollback reverts `COOCCURRENCE_CACHE_VERSION` to `2`.
- **Tests:**
  1. Concurrent live sale + `cancelSale` + `editSale` interleaved between Step C pages `1` and `2` of staged rebuild → assert cutover counts match fresh batch ground truth **with zero lost sales and zero double-counted sales**.
  2. Fail chunk `2` mid-rebuild → verify live `cooccurrence_v3` remains intact (`totalCompletedSales` unchanged) and resuming rebuild completes cleanly.
  3. `editSale` changing `{A, B}` → `{A, C}` → assert `(A, B)` decrements by 1, `(A, C)` increments by 1, `totalCompletedSales` stays 1, and offline retry queue replays idempotently.

---

<a id="8-atomic-idempotent-feedback-migration--safe-folded-event-retention"></a>
## 5. §8 Atomic, Idempotent Feedback Migration & Safe Folded-Event Retention

### 5.1 Exact Files and Functions That Will Change
- **`shared/upsellCacheSchema.ts`**: `UpsellFeedbackEventDoc`, `UpsellFeedbackSnapshot`, `MAX_FEEDBACK_RETENTION_DAYS = 30`
- **`server/upsellFeedbackStore.ts`**: convert disk `.caremart-cache/feedback_v1_*.json` strictly to L1 read-through cache
- **`server.ts`**: `GET /api/upsell/feedback`, `POST /api/upsell/feedback` (create-only `upsellFeedbackEvents/{eventId}` with `exists=false`), `POST /api/upsell/feedback/reconcile`
- **`src/services/upsellFeedbackService.ts`**: `recordUpsellFeedbackEvent()`, `reconcileUnfoldedFeedbackEvents()`, `cleanupOldFoldedFeedbackEvents()`
- **`src/contexts/ShopDataContext.tsx`**: invoke owner `reconcileUnfoldedFeedbackEvents()` + periodic `cleanupOldFoldedFeedbackEvents()`
- **`firestore.rules`**: `match /upsellFeedbackEvents/{eventId}`, `match /upsellCache/{cacheId}` (`feedback_v1` **strictly Owner-write-only**)
- **`firestore.indexes.json`**:
  - `(ownerUid ASC, folded ASC, createdAt ASC)` for owner folding pagination
  - `(ownerUid ASC, folded ASC, foldedAt ASC)` for safe retention cleanup

### 5.2 Strictly Segregated Architecture (Zero Shared Writable Aggregate for Staff)
- **Hard Security Guarantee:** `shops/{shopId}/upsellCache/feedback_v1` allows `allow write: if isOwner(shopId)` **ONLY** (staff tokens `staffCanAddSales(shopId)` have `allow get`, **ZERO `create`/`update`/`delete` permission on `feedback_v1`**!).
- **Staff Event Ingestion (`upsellFeedbackEvents/{eventId}`):**
  - Staff/Owner events are written as **create-only** immutable documents (`allow update: if false` for staff; REST `PATCH` `currentDocument.exists=false`):
    ```ts
    {
      ownerUid: string,
      eventId: string,
      actorUid: string,
      actorRole: 'owner' | 'staff',
      productId: string,
      eventType: 'shown' | 'accepted' | 'dismissed' | 'removed_after_add',
      categoryKey?: string,
      anchorCategoryKeys?: string[],
      folded: false,
      foldedAt: null,
      createdAt: Timestamp
    }
    ```
  - Concurrent staff requests create distinct `eventId` documents—**zero write contention, zero lost counters, zero risk of one staff member overwriting another**.
  - Duplicate retries with the same `eventId` hit `409 ALREADY_EXISTS` (`currentDocument.exists=false`) and return `{ ok: true, duplicate: true }`.

### 5.3 Extended Owner Absence Handling & Pending Event Durability
- **Scenario: Shop operates for weeks/months with only Staff logging in and Owner never opening the dashboard:**
  1. **Zero Data Loss:** Unfolded events (`folded: false`) remain safely in Firestore `upsellFeedbackEvents` indefinitely. There is **no TTL or auto-delete on `folded == false` documents**.
  2. **Bounded Local & Server Continuity:** Each staff terminal retains its local pending retry queue (`cm_upsell_feedback_pending_v1_*` in `localStorage`) until confirmed `200/201/409` in Firestore `upsellFeedbackEvents`, and reads the last folded `feedback_v1` + its own local session feedback mirror so upsell damping still works locally without blocking Sales Entry.
  3. **Catch-Up When Owner Eventually Logs In:** `reconcileUnfoldedFeedbackEvents(shopId)` paginates `where('ownerUid', '==', shopId).where('folded', '==', false).orderBy('createdAt').limit(40)` in a loop (yield 30ms between batches so UI stays responsive), running atomic `runTransaction` per batch of `40` events (`40` event updates + `1` `feedback_v1` update = `41` writes << `500`), re-checking `eventSnap.data().folded === false` inside every transaction and setting `folded: true, foldedAt: serverTimestamp()`. Even `10,000` accumulated staff events fold cleanly in ~250 small background batches without ever exceeding transaction or document limits!
  4. *(Optional Server Enhancement if `firebase-admin` / ADC is later enabled in Approach A of §4.1)*: `server.ts` can also fold immediately on the server under service credentials while keeping client `firestore.rules` strictly Owner-write-only on `feedback_v1`.

### 5.4 Safe Retention & Cleanup of Folded Events (Cannot Delete Unprocessed Events)
1. **Retention Policy:** Keep `folded == true` documents for **`30` days after `foldedAt`** (`MAX_FEEDBACK_RETENTION_DAYS = 30`). This provides a wide safety buffer against delayed offline browser queue replays (`upsellFeedbackService.ts` also drops confirmed `200`/`409` or >30-day-stale offline queue entries cleanly) while preventing unbounded collection growth.
2. **Double-Enforced Cleanup Safety (Query + Security Rules):**
   - **Query filter:** `where('ownerUid', '==', shopId).where('folded', '==', true).where('foldedAt', '<=', thirtyDaysAgoTimestamp).limit(200)` — only ever fetches confirmed folded documents older than 30 days.
   - **Transactional/Rule Guard (`firestore.rules`):** `match /upsellFeedbackEvents/{eventId}` enforces:
     ```rules
     allow delete: if isOwner(shopId)
       && shopExists(shopId)
       && existing().ownerUid == shopId
       && existing().folded == true
       && existing().foldedAt is timestamp
       && existing().foldedAt < request.time - duration.value(7, 'd');
     ```
     Even if a buggy client script called `deleteDoc` on an unfolded (`folded == false`) or recently folded document, **Firestore Security Rules reject the delete with `PERMISSION_DENIED`**, guaranteeing unprocessed staff feedback can **never** be deleted!

### 5.5 Backward Compatibility, Rollback & Tests
- **Backward Compatibility & Migration:** On first Owner sync, if `feedback_v1` does not exist yet and `.caremart-cache/feedback_v1_*.json` or browser mirror has `revision > 0`, seed `feedback_v1` once safely.
- **Rollback:** Revert server/client code and `firestore.rules`; existing `upsellFeedbackEvents` sit inert without disrupting POS.
- **Tests:**
  1. Emulator rules tests: staff `create` (`folded: false`) succeeds; staff `update` on `feedback_v1` or `upsellFeedbackEvents` fails (`PERMISSION_DENIED`); owner `delete` on `folded: false` or `foldedAt` < 7 days old fails (`PERMISSION_DENIED`); owner `delete` on `folded: true && foldedAt < now - 8d` succeeds.
  2. Vitest tests: 50 concurrent staff events + duplicate replays + long-absence backlog of 120 unfolded events folded in 3 batches (`40` per tx) → assert exact counts (`0` lost, `0` duplicated).

---

<a id="55-product-and-supplier-referential-deletion-locks--phased-migration-order"></a>
## 6. §5.5 Product and Supplier Referential Deletion Locks & Phased Migration Order

### 6.1 Exact Files and Functions That Will Change
- **`src/types/shop.ts`**: `Product.hasTransactionHistory?: boolean`, `Supplier.hasTransactionHistory?: boolean`, `EntityLockDoc`
- **`src/services/shopService.ts`**:
  - Transaction writers stamping `hasTransactionHistory: true` + deterministic `entityLocks/prod_${id}` / `entityLocks/sup_${id}`: `createPurchase()`, `createSale()`, `editSale()`, `adjustStock()`, `recordSupplierPayment()`, `createProduct()` (when `supplierId` set), `updateProduct()` (when `supplierId` changed to non-empty), `importHistoricalSaleToLedger()`
  - `deleteProduct()` (`1442–1541`) & `deleteSupplier()` (`1153–1200`) — execute final check + delete inside `runTransaction` reading `entityLocks`
  - New idempotent migration & verification helpers: `backfillEntityHistoryLocks(uid)`, `verifyEntityHistoryLocksCoverage(uid)`
- **`src/services/staffService.ts`**: `reconcileStaffSaleToOwnerLedger()` (`955+`, stamps product lock/flag)
- **`firestore.rules`**: `isValidProduct`, `isValidSupplier`, `match /products/{productId}`, `match /suppliers/{supplierId}`, `match /staffCatalog/{productId}`, new `match /entityLocks/{lockId}`, new `match /migrations/{migrationId}`

### 6.2 Safe 4-Phase Migration & Deployment Order (Zero Unprotected Window)

**Critical Rule:** **NEVER** deploy strict `hasTransactionHistory == false && !exists(entityLocks/...)` deletion rules as the primary guard while pre-existing historical products/suppliers have not been backfilled yet, **AND NEVER** deploy unprotected `allow delete` while migrating. Follow this exact sequence:

#### Phase 1 — Deploy Lock-Down Protection + Compatible Lock-Writing App Code
1. **Deploy Phase-1 `firestore.rules`:**
   - Add `match /entityLocks/{lockId}` (`allow create` by `isOwner(shopId)`, `allow update, delete: if false;`), allow optional `hasTransactionHistory: bool` (immutable once `true`) on `products` & `suppliers`, and add `match /migrations/{migrationId}`.
   - **Throughout the migration window, set `allow delete: if false;` on BOTH `products/{productId}` and `suppliers/{supplierId}` (and `staffCatalog/{productId}` only deletable by owner if `allow delete: if false;` temporarily or locked behind Phase 3)!**
   - *Why this is 100% safe:* Owners cannot lose Archive functionality (`isActive: false` remains active via `update`), while **zero** historical or unbackfilled products/suppliers can be hard-deleted via SDK or REST during the backfill window!
2. **Deploy updated app code (`shopService.ts`, `staffService.ts`):**
   - Every new purchase, sale, stock adjustment, supplier payment, staff reconciliation, and product-supplier link now atomically sets `hasTransactionHistory: true` + `entityLocks/prod_${pid}` / `entityLocks/sup_${sid}` inside its transaction (keeping Phase-1 read-before-write intact: `tx.get(lockRef)` in Phase 1, `tx.set(lockRef)` in Phase 2 only if `!lockSnap.exists()`).

#### Phase 2 — Execute Paginated Historical Backfill & Strict Verification Gate
1. **Run `backfillEntityHistoryLocks(shopId)` (Owner-initiated, paginated, idempotent):**
   - Paginates through `inventoryBatches`, `saleItems`, `purchaseItems`, `stockMovements`, `purchases`, `supplierPayments`, and `products` (extracting every referenced `productId` and `supplierId`).
   - Writes `hasTransactionHistory: true` + `entityLocks/prod_${pid}` / `entityLocks/sup_${sid}` in `writeBatch` chunks of `<= 350` ops (checking existing locks first so re-runs skip already-locked entities).
2. **Mandatory Verification Step (`verifyEntityHistoryLocksCoverage(shopId)`):**
   - Independently re-scans the same collections, counts distinct historical `productId`s and `supplierId`s, verifies every single one has **both** `product.hasTransactionHistory === true` (if product doc still exists) **and** `exists(entityLocks/...)`, and writes a verification manifest `shops/{shopId}/migrations/entityLocks_v1`:
     ```ts
     {
       ownerUid: shopId,
       status: 'verified',
       verifiedProductCount: number,
       verifiedSupplierCount: number,
       missingLocksCount: 0,
       verifiedAt: serverTimestamp()
     }
     ```
   - **Hard Gate:** Phase 3 rules deployment **MUST NOT** proceed unless `migrations/entityLocks_v1.status === 'verified' && missingLocksCount === 0`!

#### Phase 3 — Activate Strict Referential Deletion Rules
- Deploy **Phase-3 `firestore.rules`** replacing temporary `allow delete: if false;` with deterministic referential rules:
  - `products/{productId}` `allow delete` requires: `isOwner(shopId)`, `existing().currentStock == 0`, `(!('emptyContainersOnHand' in existing()) || existing().emptyContainersOnHand == 0)`, `existing().isActive == false`, `existing().get('hasTransactionHistory', false) == false`, `!exists(.../entityLocks/prod_$(productId))`, **AND** `exists(.../migrations/entityLocks_v1)` (rules themselves refuse deletion unless backfill verification manifest exists!).
  - `suppliers/{supplierId}` `allow delete` requires: `isOwner(shopId)`, `existing().outstandingBalance == 0`, `existing().totalPurchased == 0`, `existing().totalPaid == 0`, `existing().get('hasTransactionHistory', false) == false`, `!exists(.../entityLocks/sup_$(supplierId))`, **AND** `exists(.../migrations/entityLocks_v1)`.
  - `staffCatalog/{productId}` `allow delete` requires `isOwner(shopId)` AND (`!exists(.../products/$(productId))` OR `!exists(.../entityLocks/prod_$(productId))`).

### 6.3 Exact Rollback Sequence
1. **If an issue occurs during Phase 1 or Phase 2 (before Phase 3):**
   - Keep `allow delete: if false;` (zero data risk), or revert `firestore.rules` to pre-migration snapshot from Firebase Console Rules History, then revert app build (`shopService.ts`). Existing `entityLocks` / `hasTransactionHistory` fields are harmless additive fields and do not affect sales, purchases, or reports.
2. **If an issue occurs after Phase 3 rules are live:**
   - **Step 1 (Immediate Rules Rollback):** If a false-positive lock or rule bug blocks a legitimate deletion, redeploy `Phase 1` (`allow delete: if false;` while fixing) or pre-migration `firestore.rules` from Firebase Console Rules History (re-enabling `shopService.ts`'s query-guarded `deleteProduct`/`deleteSupplier`).
   - **Step 2 (Code Rollback):** Revert `shopService.ts` / `staffService.ts` to stop writing new `entityLocks` if needed; wait until rules are rolled back BEFORE deploying older code if older code doesn't recognize new fields.
   - **Step 3 (Optional Lock Cleanup):** Only if permanently abandoning `entityLocks`, delete `shops/{shopId}/entityLocks/*` and `migrations/entityLocks_v1` via an owner maintenance script after rules rollback; **never** remove `hasTransactionHistory` without auditing transaction history first.

### 6.4 Concurrency, Backward Compatibility & Tests
- **Concurrent First Transaction vs Delete Race:** Inside `deleteProduct()` / `deleteSupplier()`, convert the final check + delete into a `runTransaction` reading `prodRef`/`supRef` and `entityLocks/{lockId}` in Phase 1 before calling `tx.delete`. Any concurrent `createPurchase`/`createSale` writing `entityLocks` serializes cleanly and aborts `deleteProduct`.
- **Tests:**
  1. Emulator rules tests: `Phase 1` denies all hard deletes (`PERMISSION_DENIED`); `Phase 3` denies delete when `migrations/entityLocks_v1` is absent, when `entityLocks/prod_*` exists, when `hasTransactionHistory == true`, when `currentStock > 0`, or when `isActive == true`; allows delete only for genuinely unused archived products (`missingLocks == 0` verified).
  2. Vitest tests: `backfillEntityHistoryLocks` + `verifyEntityHistoryLocksCoverage` idempotency and verification manifest check across pre-existing sales, purchases, batches, and supplier payments.

---

<a id="verified-facts-vs-theoretical--unverified-claims"></a>
## 7. Verified Facts vs. Theoretical / Unverified Claims

To maintain strict engineering transparency prior to approval, every claim in this document falls into one of two explicitly verified categories:

### 7.1 Directly Verified Against Actual Repository Code & Tooling
1. **Exact existing bugs & line numbers:**
   - `server.ts`: `OWNER_GATE_SECRET` fallback (`86–87`), `SESSION_SECRET` fallback (`88–93`), `authorizeOwnerUser` unchecked `OWNER_EMAIL` (`554–656`), `caremart_session` usage limited solely to `verifySessionToken` in `GET /api/auth/session` (`1026–1039`), zero calls to `/api/auth/session` in `src/`.
   - `server/googleSheetsService.ts` (`39–48, 348–378`) & `server/discordNotifier.ts` (`54–63, 400–424`): `v: 1` AES-256-GCM disk vaults and fallback to `OWNER_GATE_SECRET` / `'cm_gate_7d3e9a2c4f1b8e6092c4a1d7f5b8e301'`.
   - `src/services/shopService.ts`: exact Phase-1 `tx.get` before Phase-2 write order and exact write counts in `createSale` (`2357–2580`), `editSale` (`2734–3043`), `cancelSale` (`3103–3229`), and `.slice(0, 50)` truncation (`2486, 2900`).
   - `src/services/staffService.ts`: exact Phase-1 `tx.get` order and write counts including `auditLogs` (`+1` at `1167`) in `reconcileStaffSaleToOwnerLedger` (`984–1216`) and `.slice(0, 50)` (`1114`).
   - `shared/upsellCacheSchema.ts` (`2`), `server/upsellCooccurrenceStore.ts` (`213–219, 273–275`), & `src/services/upsellCooccurrenceService.ts` (`951–1009`): `2000`-ID eviction and `resetFirst: idx === 0` mid-rebuild wipe bug.
   - `server/upsellFeedbackStore.ts`: disk-only `.caremart-cache/feedback_v1_*.json` persistence.
   - `firestore.rules`: static `gateSecret()` (`56–58`), `batchAllocations.size() <= 50` (`578`), `processedSaleIds.size() <= 2000` (`848`), unchecked `allow delete` on `suppliers` (`1244`) & `products` (`1283`).
   - `package.json`: `firebase-admin` is **not** installed.
   - Workspace filesystem: `.git` does **not** exist; `.caremart-secrets/` does **not** exist; `.caremart-cache/` exists locally; Groups 1–6 Vitest suite (`9` files, `46/46` tests), `tsc --noEmit`, `eslint`, and `vite build` currently pass.

### 7.2 Theoretical / Unverified Claims (Require Emulator Tests or Production Inspection Before Execution)
1. **Proposed `firestore.rules` Expressions Not Yet Tested in Firebase Emulator:**
   - This workspace currently has **0** Firebase Emulator rules tests (`@firebase/rules-unit-testing` / `firebase emulators:exec` is not configured or run).
   - Therefore, exact CEL/Rules behavior—such as `hashing.sha256(...).toHexString().lower()`, `duration.value(7, 'd')` subtraction against `existing().foldedAt`, `chunkId == incoming().saleItemId + '_c' + string(incoming().chunkIndex)`, and cross-document `existsAfter` / `exists` read-cost limits (rules allow max `10` document access calls per single-doc eval / `20` per batch)—is **theoretically sound based on Firestore Rules documentation, NOT yet runtime-verified against the Firebase Emulator**!
2. **Staged Rebuild Cutover & Multi-Instance Cloud Run Contention:**
   - The `cooccurrence_staging` catch-up + atomic cutover protocol (`§7.1`) and transactional batch folding (`§8`) have **not** been stress-tested under concurrent multi-instance Cloud Run traffic or real Firestore transaction retry limits.
3. **Production Environment & Live Database State (Cannot Be Inspected From Sandbox):**
   - Whether Cloud Run runtime IAM has Application Default Credentials (`Datastore User`) for `firebase-admin` (`§4.1`, `§7.1`, `§8`).
   - Whether `appState/ownerSetup` already exists, whether `OWNER_EMAIL` is set in Cloud Run Secrets, and whether the primary owner's password auth account has `email_verified === true` (`§4.1`).
   - Whether live production currently holds `.caremart-secrets/*.enc.json` files on a persistent volume or uses `GOOGLE_SERVICE_ACCOUNT_JSON` / `DISCORD_WEBHOOK_URL` env secrets (`§4.3`).
   - Actual live document counts in `ai-studio-36596f53-ce10-4ba0-aae2-9d7f9051d6fe` (e.g., whether any existing `saleItems` hit `50` allocations, total completed sales `<` or `> 2,000`, and number of historical `products` / `suppliers` requiring `entityLocks` backfill).

---

## Individual Approval Checklist

Please indicate which items (and options) you approve implementing first:

1. **§4.1 Owner Setup Security:** **Approach A** (server provisioning + `allow create: if false;`) or **Approach B** (deploy-time `OWNER_EMAIL` SHA-256 hash + `email_verified == true` in `firestore.rules`).
2. **§4.3 Encryption & Session Hardening:** Approve `v: 2` HKDF vault separation, non-destructive `VAULT_DECRYPT_KEY_MISMATCH` handling, and production `SERVICE_ACCOUNT_ENCRYPTION_KEY` / `SESSION_SECRET` enforcement (and indicate env secret vs persistent disk vs Firestore `serverVault`).
3. **§5.3 FIFO > 50 Batches:** Approve deterministic `saleItemAllocations` chunks + strict Phase-1 read-before-write + `W <= 480` & `W_cancel <= 480` invariants + cancellation restoration regression tests.
4. **§7.1 Co-Occurrence > 2,000 Sales:** Approve `cooccurrence_v3` + `upsellProcessedSales/{saleId}` + race-free `cooccurrence_staging` rebuild & cutover + `editSale` / `cancelSale` delta reversal.
5. **§8 Feedback Migration:** Approve staff create-only `upsellFeedbackEvents/{eventId}` + Owner transactional folding into `feedback_v1` + 30-day (`>= 7d` rule-enforced) folded-event cleanup.
6. **§5.5 Deletion Locks:** Approve the 4-phase migration (`allow delete: if false;` during window → backfill + `verifyEntityHistoryLocksCoverage` manifest → Phase-3 strict `entityLocks` + `hasTransactionHistory` rules).
