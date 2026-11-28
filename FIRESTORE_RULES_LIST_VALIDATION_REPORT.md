# Firestore Security Rules — List Element Validation Audit & Platform Limits Report

**Repository:** CareMart Shop Manager  
**Target File:** `firestore.rules` (`rules_version = '2'`)  
**Scope:** Analysis of array/list element validation gaps (specifically `websiteOrders.items`), Firestore Security Rules platform constraints, full `[0]` inventory across `firestore.rules`, and remediation paths.

---

## 1. Executive Summary

During review of `firestore.rules`, `isValidWebsiteOrderCore(data, shopId)` (line `924`) only validates the first element of the `items` array:

```javascript
&& data.items is list && data.items.size() >= 1 && data.items.size() <= 50
&& isValidWebsiteOrderItemMap(data.items[0])
```

Additionally, `match /websiteOrders/{orderId}` -> `allow create` (lines `1837-1839`) only verifies active status and atomic `storefrontCatalog` stock decrement for `incoming().items[0].productId`.

While the gap is real—any malformed item at index `1..49` bypasses `isValidWebsiteOrderItemMap`—**this cannot be fixed inside `firestore.rules` alone while retaining `items.size() <= 50`** due to hard platform limits in Cloud Firestore Security Rules `rules_version = '2'`.

---

## 2. Firestore Security Rules Platform Limits

### 2.1 No List Iteration (`.all()`, `.map()`, `.filter()`, Loops, or Recursion)
In Cloud Firestore Security Rules (`rules_version = '2'`), `rules.List` only provides the following methods:
- `concat(list)`
- `hasAll(list)`
- `hasAny(list)`
- `hasOnly(list)`
- `join(separator)`
- `removeAll(list)`
- `size()`
- `toSet()`
- Index/slice access (`x[i]`, `x[i:j]`) and membership (`v in x`)

List comprehensions/predicates such as `data.items.all(item, isValidWebsiteOrderItemMap(item))`, `.map()`, `.filter()`, `for` loops, and recursive helper functions are **not supported** by Firestore Security Rules and fail rules compilation.

### 2.2 Hard 1,000-Expression-Per-Request Limit
Cloud Firestore enforces a hard limit of **1,000 evaluated expressions per request** (every identifier, literal, property access, index operation, comparison, logical operator, and function call counts toward the budget, and `let` bindings / function parameters re-evaluate each time they are referenced).

Unrolling `isValidWebsiteOrderItemMap(data.items[i])` across `i = 0..49`:
- Each `isValidWebsiteOrderItemMap` check validates map type, `keys().hasOnly(...)` / `keys().hasAll(...)`, `productId` (`isValidId` regex + length), `productName`, `unitName`, `conversionFactor`, `quantity`, `baseQuantity`, `unitPrice`, and `lineTotal`.
- That consumes roughly **~90–150 AST expressions per item**.
- At **50 items**, unrolled validation consumes **~4,500–7,000+ expressions**, far exceeding the **1,000-expression limit** and causing valid 50-item orders (as well as ~10+ item orders) to fail at runtime with `PERMISSION_DENIED`.

### 2.3 Hard 10 Document-Lookup Limit (`get` / `getAfter` / `exists`)
Firestore Security Rules limits single-document rule evaluation to **10 total document lookups** (`get`, `getAfter`, `exists`, `existsAfter`).  
Validating `storefrontCatalog` `isActive == true` and atomic `currentStock` decrements (`get` + `getAfter`) across all items in a 50-item order would require up to `100` lookups (plus `shopExists`), which is also impossible inside `firestore.rules`.

---

## 3. Complete Inventory of `[0]` List-Element Checks in `firestore.rules`

Every instance where a bounded list currently validates element `[0]` as a structural type check:

| Line(s) | Helper / Rule Block | Field | Current Constraint | Max Size |
| :--- | :--- | :--- | :--- | :--- |
| `332` | `isValidStaffCatalogItem` | `packagingUnits` | `size() == 0 \|\| [0] is map` | `<= 25` |
| `341` | `isValidStaffCatalogItem` | `allowedStaffUids` | `size() == 0 \|\| [0] is string` | `<= 50` |
| `365` | `isValidStaffSale` | `items` | `size() >= 1 && <= 200 && [0] is map` | `<= 200` |
| `393` | `isValidBrand` | `categoryIds` | `size() == 0 \|\| [0] is string` | `<= 25` |
| `453` | `isValidProduct` | `packagingUnits` | `size() == 0 \|\| [0] is map` | `<= 25` |
| `496` | `isValidProductTemplate` | `packagingUnits` | `size() == 0 \|\| [0] is map` | `<= 15` |
| `508` | `isValidProductTemplate` | `searchKeywords` | `size() == 0 \|\| [0] is string` | `<= 15` |
| `579` | `isValidSaleItem` | `batchAllocations` | `size() == 0 \|\| [0] is map` | `<= 50` |
| `822` | `isValidSheetsSyncJob` | `targetSheets` | `size() >= 1 && <= 20 && [0] is string` | `<= 20` |
| `850` | `isValidUpsellCooccurrenceCache` | `processedSaleIds` | `size() == 0 \|\| ([0] is string && [0].size() <= 128)` | `<= 2000` |
| `887` | `isValidStorefrontCatalogItem` | `packagingUnits` | `size() == 0 \|\| [0] is map` | `<= 25` |
| `924` | `isValidWebsiteOrderCore` | `items` | `isValidWebsiteOrderItemMap(data.items[0])` | `<= 50` |
| `1837-1839` | `websiteOrders` `allow create` | `items[0].productId` | `get()` / `getAfter()` `storefrontCatalog` active + stock decrement | N/A |

---

## 4. Verification Status in Current Container

- **Static Rules Linting (`eslint firestore.rules`):** Checks ANTLR4 grammar syntax and `@firebase/eslint-plugin-security-rules` static rules only; it does **not** simulate runtime expression counts or payload rejection on `items[1..N]`.
- **Firebase Firestore Emulator Runtime Tests:** Could **not** be executed locally because `java` is not installed in the container, and live production Firestore was not mutated with synthetic test documents.
  - Required emulator test cases (once an emulator-capable environment with Java/JRE is used, or after switching to a backend/subcollection architecture):
    1. 3-item order with all valid items -> `ALLOW`
    2. 3-item order where only index `1` (`items[1]`) is malformed (e.g., negative `quantity` or wrong type) -> `PERMISSION_DENIED` (demonstrating the gap before fix vs rejection after fix)
    3. 50-item order with all valid items -> `ALLOW` (verifying expression budget does not exceed 1,000)

---

## 5. Recommended Remediation Options

### Option A (Recommended): Server-Validated Order Creation or Subcollection Line Items
1. **Backend / Cloud Function Checkout Endpoint (supports 50+ items cleanly):**
   - Expose a server-side endpoint (e.g., Cloud Function or authenticated App-Check-protected Express/Admin SDK endpoint) that validates every item in `items` (`0..49`), recomputes `subtotal`/`totalAmount` from authoritative `storefrontCatalog` prices, checks and decrements `storefrontCatalog` stock for **every** item atomically inside a server transaction, and writes `websiteOrders/{orderId}`.
   - Lock down client-side creation in `firestore.rules` (`allow create: if false;` on `websiteOrders`, and remove public `storefrontCatalog` stock-decrement `update` access).
2. **Alternative (Firestore Subcollection):**
   - Store order header at `/shops/{shopId}/websiteOrders/{orderId}` and each line item as its own document at `/shops/{shopId}/websiteOrders/{orderId}/items/{itemId}` so Firestore rules validate each item document individually (`isValidWebsiteOrderItemMap(incoming())`) in constant O(1) expressions per item.

### Option B: Rules-Only with Reduced Item Limit
If public client-side Firestore transactions must remain without a backend endpoint or subcollection:
- Unroll `isValidWebsiteOrderItemMap(data.items[i])` with concise field checks for `i = 0..(MAX - 1)` **and** reduce `data.items.size()` from `50` to a smaller limit (e.g., `<= 6–8` items) verified against the **Firebase Firestore Emulator** (`@firebase/rules-unit-testing` with Java installed) to stay safely below the 1,000-expression limit.

---

## 6. Implemented Fix: Subcollection-Based Line Items (Starter Tier / Rules-Only)

Option A.2 (Firestore Subcollection) has been implemented so the project runs 100% client-side with zero `firebase-admin` / billing-tier upgrades:

1. **Parent Header (`/shops/{shopId}/websiteOrders/{orderId}`):**
   - Retains customer contact, delivery address, payment method, status, and order-level totals (`itemCount`, `totalQuantity`, `subtotal`, `deliveryFee`, `totalAmount`) and **forbids inline `items` arrays on `create`**.
2. **Line Item Subcollection (`/shops/{shopId}/websiteOrders/{orderId}/items/{itemId}`):**
   - Each ordered item is created as an individual immutable document (`allow update, delete: if false`) validated by `isValidWebsiteOrderItemDoc(incoming(), shopId, orderId)` (constant expression budget per item regardless of cart size up to 50+ items).
   - Verifies per-item math (`baseQuantity ≈ quantity * conversionFactor`, `lineTotal ≈ unitPrice * quantity`) and parent order atomicity via `getAfter(/shops/{shopId}/websiteOrders/{orderId})` (uses 1 cached document access across all items in the transaction).
3. **Authoritative Total/Price Computation & Residual Risk:**
   - The checkout transaction (`placeWebsiteOrder` in `src/services/websiteOrderService.ts`) reads `storefrontCatalog/{productId}` inside `runTransaction`, recomputes authoritative `unitPrice`, `baseQuantity`, `lineTotal`, `subtotal`, `totalQuantity`, and `totalAmount` from catalog data, and decrements `storefrontCatalog/{productId}.currentStock` atomically.
   - **Residual Rules Risk:** Firestore Security Rules cannot query/aggregate child subcollection documents to verify `parent.subtotal == sum(items.lineTotal)`, and Firestore enforces a **20 document-access ceiling (`get`/`exists`/`getAfter`) across an entire transaction** (so calling `get(storefrontCatalog/{productId})` per item inside `items/{itemId}` would break >18 distinct-product checkouts). As operational mitigation, `Pending Confirmation` orders never deduct POS stock or create `sales` records until reviewed and confirmed by the Shop Owner in **Website Orders**, which surfaces stock and catalog price-mismatch warnings directly on the order review panel.

