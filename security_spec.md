# Security Specification — Retail Shop Management System

## 1. Data Invariants
1. **Strict Workspace Isolation**: Every shop record (`products`, `categories`, `brands`, `suppliers`, `sales`, `saleItems`, `purchases`, `purchaseItems`, `expenseCategories`, `expenses`, `stockMovements`, `stockAdjustments`, `settings`, `auditLogs`, `backups`) resides under `/shops/{shopId}/...` where `shopId == request.auth.uid` and `ownerUid == request.auth.uid`.
2. **Verified Email Requirement**: Unverified accounts (`email_verified != true`) and unauthenticated callers are denied all reads and writes.
3. **Immutable Audit & Movement Ledgers**: `stockMovements`, `stockAdjustments`, `auditLogs`, and `backups` are append-only (`allow update, delete: if false`).
4. **Terminal State Locking**: Once a `sale` or `purchase` reaches `status == 'cancelled'`, no further updates are allowed.
5. **Temporal Integrity**: `createdAt` is locked to `request.time` on creation and immutable on updates; `updatedAt` is locked to `request.time` on creation and updates.
6. **Privilege Escalation Prevention**: Users creating their `/users/{userId}` profile may only set `role: 'owner'` and cannot elevate `role` on update.

## 2. The "Dirty Dozen" Attack Payloads
1. **Unauthenticated Product Read**: Anonymous caller attempts `get` on `/shops/u1/products/p1` -> `PERMISSION_DENIED`.
2. **Unverified Email Write**: Authenticated user with `email_verified: false` attempts `create` on `/shops/u1/products/p1` -> `PERMISSION_DENIED`.
3. **Cross-Tenant List Scraping**: User `u2` attempts `list` on `/shops/u1/sales` -> `PERMISSION_DENIED`.
4. **OwnerUid Spoofing on Create**: User `u1` creates product under `/shops/u1/products/p1` with `ownerUid: 'u2'` -> `PERMISSION_DENIED`.
5. **Shadow / Ghost Field Injection**: User `u1` creates a sale with extra field `isDiscountApproved: true` -> `PERMISSION_DENIED`.
6. **Self-Assigned Admin Privilege Escalation**: User `u1` creates `/users/u1` with `role: 'admin'` -> `PERMISSION_DENIED`.
7. **Invalid Payment Method Injection**: User `u1` creates a sale with `paymentMethod: 'Crypto'` instead of `'Cash'` or `'Online'` -> `PERMISSION_DENIED`.
8. **Negative Price / Stock Poisoning**: User `u1` creates a product with `purchasePrice: -50` -> `PERMISSION_DENIED`.
9. **Oversized String DoS (Denial of Wallet)**: User `u1` creates a product with `name` of 2,000 characters -> `PERMISSION_DENIED`.
10. **Path Variable ID Poisoning**: User `u1` creates a product with doc ID containing invalid characters or length > 128 -> `PERMISSION_DENIED`.
11. **Terminal State Mutation**: User `u1` attempts to update a sale whose `existing().status == 'cancelled'` -> `PERMISSION_DENIED`.
12. **Audit Log Tampering**: User `u1` attempts to update or delete an entry in `/shops/u1/auditLogs/log1` -> `PERMISSION_DENIED`.
