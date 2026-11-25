# Security Summary

**Reviewed Files**: 22  
**Issues Resolved**: 11

### Issues Resolved
| Area | File | Line | What Was Happening | Impact | Status | How It Was Fixed |
|---|---|---|---|---|---|---|
| Recommendation History Poisoning | `server.ts` | 1560 | `POST /api/upsell/cooccurrence/update` and `/rebuild` trusted client-supplied `saleId` and `productIds` without checking Firestore ownership, completion status, or line-item membership. | High | Fixed | Added server-side Firestore verification confirming every submitted sale exists under the caller's shop, is not cancelled, and its submitted `productIds` match the shop's stored `saleItems` (or `staffSales` items) before updating co-occurrence counts. |
| Staff / Admin Lookup Enumeration | `server.ts` | 730 | `/api/staff/lookup` and `/api/admin/lookup` could return differing statuses or lack rate throttling, enabling username enumeration. | Medium | Fixed | Enforced a shared sliding-window rate limiter on lookup routes and standardized unknown/inactive responses to uniform `404` payloads. |
| Missing HTTP Hardening & Route Payload Limits | `server.ts` | 2060 | Express accepted a global 10 MB JSON body limit across all routes, lacked security headers, and exposed framework headers. | Medium | Fixed | Disabled `X-Powered-By`, applied `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `Permissions-Policy` headers (preserving AI Studio iframe compatibility), and restricted JSON body size to 64 KB except for Google Sheets sync routes. |
| Upsell Feedback Replay & Offline Loss | `src/services/upsellFeedbackService.ts`, `server/upsellFeedbackStore.ts` | 15 | Feedback submissions had no unique persistent event ID or server-side deduplication, and offline events could be lost or overwritten by empty server snapshots. | Medium | Fixed | Added persistent `eventId` generation and durable local queue storage with exponential backoff, non-destructive merge over server snapshots, and bounded server-side `processedEventIds` deduplication. |
| Purchase Overpayment Race | `src/services/shopService.ts` | 2850 | `settlePurchaseBalance()` validated payment against a potentially stale client-side `balanceDue` before entering the transaction. | High | Fixed | Repeated `status !== 'cancelled'`, `currentDue > 0`, and `pay <= currentDue` validation inside `runTransaction()` using the authoritative transaction snapshot. |
| Purchase Cancellation Stale Financials | `src/services/shopService.ts` | 2980 | `cancelPurchase()` relied on full collection reads and caller-provided purchase fields for supplier/cash reversals. | High | Fixed | Switched to targeted indexed queries on `(ownerUid, purchaseId)` and `(ownerUid, productId, status)`, computing supplier and cash reversals inside `runTransaction()` from the authoritative purchase snapshot. |
| Stale Batch Snapshot During Sale Entry | `src/services/shopService.ts` | 2280 | `createSale()` relied solely on caller-supplied `activeBatchIds`, risking missed newly committed purchase batches or stale batch order. | High | Fixed | Merged caller `activeBatchIds` with fresh per-product indexed `inventoryBatches` queries inside `createSale()`, and fixed co-occurrence queuing to pass product IDs instead of composite `productId::unit` keys. |
| Unsafe Product & Supplier Deletion | `src/services/shopService.ts`, `src/pages/ProductsPage.tsx`, `src/pages/SettingsPage.tsx` | 880 | Product and supplier deletion did not block active stock, linked batches, or historical invoices consistently, and UI showed success without awaiting server completion. | High | Fixed | Blocked deletion when stock, batches, balances, or linked historical transactions exist (guiding users to archive instead), checked `staffCatalog` existence before deleting, and awaited deletion before showing toast feedback. |
| Duplicate Offline Staff Sales | `src/services/staffService.ts`, `src/services/offlineSyncService.ts` | 250 | `createStaffSale()` generated random Firestore document IDs instead of using the offline `clientRequestId`, allowing network-retry duplicates, while offline sync deduplication compared low-entropy sale numbers. | High | Fixed | Derived deterministic `req_<sanitizedId>` document IDs in `createStaffSale()` with idempotent post-conflict verification against owner/staff ownership, increased sale number entropy, and switched sync deduplication strictly to deterministic document IDs. |
| Orphaned Auth Accounts & Username Races | `src/services/staffService.ts`, `src/services/adminService.ts` | 120 | Creating staff or admin accounts reserved `staffLookup`/`adminLookup` non-atomically and risked leaving orphaned Firebase Auth accounts if Firestore writes failed. | Medium | Fixed | Converted lookup checks/writes into atomic `runTransaction()` reservations across all lookup keys and rolled back `deleteUser()` on any provisioning failure while signed in to the secondary Auth instance. |
| Strict TypeScript Checking & Tooling | `tsconfig.json`, `package.json` | 25 | `tsconfig.json` omitted `"strict": true` and `package.json` had an `esbuild` version mismatch with `vite` plus missing `@testing-library/dom`. | Low | Fixed | Enabled `"strict": true` in `tsconfig.json` (zero errors across codebase), updated `esbuild` to `^0.28.0`, and added `@testing-library/dom@^10.4.2` to `devDependencies`. |
| Initial Owner Setup Gate & Firestore Rules Enforcement | `server.ts`, `firestore.rules` | 554 | `OWNER_EMAIL` is not strictly enforced in `authorizeOwnerUser()` when `appState/ownerSetup` does not exist yet, and `firestore.rules` embeds a fallback `gateSecret()`. | High | Needs Follow-Up | Stopped before modifying rules or secrets; awaiting explicit approval of the §4.1 migration/deployment proposal. |
| Encryption Key Fallback Secret | `server/googleSheetsService.ts`, `server/discordNotifier.ts` | 39 | Credential vault encryption falls back to `OWNER_GATE_SECRET` or a hardcoded string if `SERVICE_ACCOUNT_ENCRYPTION_KEY` is unset. | High | Needs Follow-Up | Preserved existing key derivation so production vaults remain decryptable; awaiting explicit approval of the §4.3 migration/rotation proposal. |

### Safeguards Verified
| Area | File | How It's Protected |
|---|---|---|
| Firebase Token & Session Verification | `server.ts` | Verifies Firebase RS256 ID tokens against Google JWKS (`iss`, `aud`, `exp`, `sub`, verified email) and HMAC-signed session cookies via `crypto.timingSafeEqual`. |
| Cross-Shop Isolation | `server.ts` | Owner and staff API endpoints resolve the authoritative `shopId` from verified Firebase membership docs and reject mismatched request `shopId` parameters with `403`. |
| Credential Redaction & Secrets Isolation | `server/googleSheetsService.ts`, `server/upsellAdvisor.ts` | Private keys (`GEMINI_API_KEY`, service account private keys, Discord webhook URLs) stay strictly on the server via `process.env` or encrypted server vaults; never sent to browser clients. |
| Multi-Unit Packaging & Offline Recovery | `src/services/staffService.ts`, `src/utils/packaging.ts` | Conversion math validates finite positive factors and prevents negative stock both client-side and in Firestore security rules. |

---

## PoC Verification

### 1. Co-Occurrence History Poisoning Rejected (`POST /api/upsell/cooccurrence/update`)

#### Summary
| Field | Value |
|---|---|
| Issue Type | Missing server-side sale & line-item verification |
| Impact | High |
| Affected File | `server.ts:1560` |
| Test Scenario | Authenticated caller posts `saleId: "forged-sale-999"` and `productIds: ["prod-a", "prod-b"]` for `shopId: "owner-1"` when that sale does not exist in Firestore or its stored `saleItems` contain different products. |

#### How It Was Fixed
Added `verifyEligibleSalesForCooccurrence()` in `server.ts`, which resolves the sale and its `saleItems` (or `staffSales` document) from Firestore REST APIs under the authenticated `shopId`, checks `status !== 'cancelled'`, and ensures every submitted `productId` belongs to that sale before calling `recordServerCooccurrenceBatch()`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | Signed request arrives at `POST /api/upsell/cooccurrence/update` in `server.ts` | User identity and `shopId` verified via Firebase ID token |
| 2 | Handler invokes `verifyEligibleSalesForCooccurrence()` checking `shops/{shopId}/sales/{saleId}` and `saleItems` query (`server.ts:1590-1650`) | Forged or cancelled sales return no eligible product IDs; mismatched `productIds` are rejected |
| 3 | Response returns `403` (`No eligible completed sales matched shop records`) | **Handled Safely** — verified in `server/serverSecurity.test.ts` |

#### Conclusion
**Fix Verified** - Verified by live HTTP server test suite (`server/serverSecurity.test.ts`): fabricated sales and mismatched product pairings cannot pollute any shop's co-occurrence cache.

---

### 2. Concurrent Purchase Overpayment & Cancellation Protection (`settlePurchaseBalance` / `cancelPurchase`)

#### Summary
| Field | Value |
|---|---|
| Issue Type | Financial race condition using stale pre-transaction balance |
| Impact | High |
| Affected File | `src/services/shopService.ts:2850` |
| Test Scenario | Caller invokes `settlePurchaseBalance()` with `paymentAmount: 500` after a concurrent transaction has already reduced `balanceDue` to `300`. |

#### How It Was Fixed
Moved `status !== 'cancelled'`, `currentDue > 0`, and `pay <= currentDue` assertions inside the Firestore `runTransaction()` callback after `tx.get(purchaseRef)`, and updated `cancelPurchase()` to read authoritative purchase/supplier values inside the transaction.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `settlePurchaseBalance()` enters `runTransaction()` | Acquires transactional snapshot of `purchase` and `supplier` |
| 2 | Reads fresh `curP.balanceDue = 300` and checks `pay > currentDue` (`500 > 300`) | Throws `"Payment amount cannot exceed remaining balance due (300)."` |
| 3 | Transaction aborts before any `tx.update()` runs | **Handled Safely** — verified in `src/services/financialTransactions.test.ts` |

#### Conclusion
**Fix Verified** - Verified in `src/services/financialTransactions.test.ts`: stale UI requests and concurrent settlements cannot drive `balanceDue` or supplier payables negative.

---

### 3. Duplicate Offline Staff Sale Retry Idempotency (`createStaffSale` / `syncQueuedOfflineSales`)

#### Summary
| Field | Value |
|---|---|
| Issue Type | Non-idempotent offline sale retry creating duplicate financial transactions |
| Impact | High |
| Affected File | `src/services/staffService.ts:250` |
| Test Scenario | Offline staff sale with `localId: "offline_abc_123"` commits to `staffSales`, network response drops, and `syncQueuedOfflineSales()` retries the same item twice. |

#### How It Was Fixed
`createStaffSale()` maps `clientRequestId` via `toDeterministicStaffSaleId()` to deterministic Firestore document ID `req_<sanitizedId>` and verifies existing doc ownership on duplicate conflict without re-decrementing `staffCatalog` stock.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | First `createStaffSale()` attempt writes `shops/{shopId}/staffSales/req_offline_abc_123` and decrements `staffCatalog` stock once | Sale created (`id: "req_offline_abc_123"`) |
| 2 | Retry arrives with identical `clientRequestId: "offline_abc_123"`; `tx.set()` detects existing document conflict | Transaction aborts without modifying `staffCatalog` |
| 3 | Catch handler reads `getDoc(saleRef)`, verifies `ownerUid === shopId && staffAuthUid === staff.authUid`, and returns existing sale ID | **Handled Safely** — verified in `src/services/offlineAndProvisioning.test.ts` |

#### Conclusion
**Fix Verified** - Verified in `src/services/offlineAndProvisioning.test.ts`: retrying an already-committed offline sale never creates a second ledger document or deducts stock twice.

---

### 4. Feedback Event Replay Deduplication (`recordUpsellFeedbackEvent`)

#### Summary
| Field | Value |
|---|---|
| Issue Type | Missing idempotency key causing inflated feedback counters on retry |
| Impact | Medium |
| Affected File | `src/services/upsellFeedbackService.ts:120`, `server/upsellFeedbackStore.ts:15` |
| Test Scenario | Client records an `'accepted'` upsell event while offline, retries a failed HTTP `503` submission, and delivers the same queued `eventId` twice to `POST /api/upsell/feedback`. |

#### How It Was Fixed
Each feedback event generates a persistent `eventId`, stays in `localStorage` until a `2xx` or permanent `4xx` response, merges pending local counters on top of server snapshots, and is deduplicated server-side by `processedEventIds`.

#### Step-by-Step Trace
| Step | What Happens in the Code | Outcome |
|---|---|---|
| 1 | `recordUpsellFeedbackEvent()` creates `eventId` and stores event in durable pending queue before `fetch` | `503` retry keeps identical `eventId` queued |
| 2 | Next flush sends same `eventId` to `recordServerFeedbackEventWithStatus()` | First delivery increments counter; duplicate returns `{ duplicate: true }` with no increment |
| 3 | Queue removes event only after confirmed `200` | **Handled Safely** — verified in `src/services/upsellFeedbackService.test.ts` |

#### Conclusion
**Fix Verified** - Verified in `src/services/upsellFeedbackService.test.ts`: transient network failures neither drop feedback events nor double-count replayed submissions.
