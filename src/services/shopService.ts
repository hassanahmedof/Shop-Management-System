import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import { enqueueSheetsBackgroundTask } from './backgroundTaskQueue';
import { notifyDiscordTransaction } from './discordNotificationService';
import type {
  AdjustmentType,
  BatchAllocation,
  Brand,
  Category,
  Expense,
  ExpenseCategory,
  InventoryBatch,
  OriginType,
  PaymentMethod,
  Product,
  ProductPackagingUnit,
  ProductTemplate,
  ProductTemplatePackaging,
  Purchase,
  PurchaseItem,
  Sale,
  SaleItem,
  ShopSettings,
  Supplier,
} from '../types/shop';
import {
  calcProfitMarginPct,
  formatDateTimeKarachi,
  getKarachiDateIso,
  normalizeCustomerWhatsapp,
  roundMoney,
} from '../utils/formatters';
import {
  allocateFifoFromBatches,
  CATEGORY_MERGE_RULES,
  DEFAULT_PRODUCT_CATEGORIES,
  getEffectiveBaseUnit,
  isImportedCategoryName,
  normalizeCategoryKey,
  normalizePackagingUnits,
  resolveCanonicalCategoryName,
  roundStockQty,
} from '../utils/packaging';

import {
  DEFAULT_PRODUCT_BRANDS,
  findExactBrandMatch,
  normalizeBrandKey,
  resolveBrandCategoryIds,
} from '../utils/brands';
import {
  DEFAULT_PRODUCT_TEMPLATES,
  normalizeTemplateKey,
  resolveTemplateCategoryAndBrand,
} from '../utils/productTemplates';
import { recordPerfMetric, startPerfTimer } from '../utils/perfMonitor';
import { formatOwnerAdminLabel, OWNER_PRIMARY_ID } from '../utils/sellerAttribution';

function clip(val: string | undefined | null, maxLen: number): string {
  return (val || '').trim().slice(0, maxLen);
}

function shopCol(uid: string, name: string) {
  return collection(db, 'shops', uid, name);
}

function shopDoc(uid: string, name: string, id: string) {
  return doc(db, 'shops', uid, name, id);
}

function generateTxnNumber(prefix: string): string {
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${y}${m}${d}-${rand}`;
}

const DEFAULT_CATEGORIES = DEFAULT_PRODUCT_CATEGORIES;
const DEFAULT_BRANDS = DEFAULT_PRODUCT_BRANDS;

const DEFAULT_EXPENSE_CATEGORIES: Array<{ id: string; name: string }> = [
  { id: 'exp_rent', name: 'Shop Rent' },
  { id: 'exp_electricity', name: 'Electricity' },
  { id: 'exp_water', name: 'Water' },
  { id: 'exp_internet', name: 'Internet' },
  { id: 'exp_salaries', name: 'Salaries' },
  { id: 'exp_transport', name: 'Transportation' },
  { id: 'exp_delivery', name: 'Delivery' },
  { id: 'exp_packaging', name: 'Packaging' },
  { id: 'exp_maintenance', name: 'Maintenance' },
  { id: 'exp_other', name: 'Other Expenses' },
];

/**
 * Ensures the user profile, root shop workspace, general settings, and default
 * catalog/expense categories exist on first login.
 * Never seeds fake sales, fake purchases, or fake products.
 */
async function withOfflineRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const code =
        typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
      const isTransient = msg.includes('offline') || msg.includes('unavailable') || code === 'unavailable';
      if (!isTransient || attempt === retries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function ensureShopInitialized(
  user: User,
  ownerProof?: string,
  verifiedEmail?: string,
  options?: { shopName?: string; ownerName?: string; shopId?: string }
): Promise<void> {
  const uid = user.uid;
  const targetShopId = options?.shopId || uid;
  const isAddedAdmin = targetShopId !== uid;
  const displayName = clip(
    options?.ownerName || user.displayName || user.email?.split('@')[0] || (isAddedAdmin ? 'Shop Admin' : 'Shop Owner'),
    120
  );
  const initialShopName = clip(options?.shopName || 'CareMart Hygiene & Baby Care', 150);
  const email = clip((verifiedEmail || user.email || '').trim().toLowerCase(), 200);

  if (!email) {
    throw new Error('Access Denied. Verified email address is required.');
  }

  if (!isAddedAdmin) {
    const setupRef = doc(db, 'appState', 'ownerSetup');
    const adminRef = doc(db, 'admins', uid);

    let setupExists = false;
    let setupOwnerUid = '';
    try {
      const setupSnap = await withOfflineRetry(() => getDoc(setupRef));
      setupExists = setupSnap.exists();
      if (setupExists) {
        setupOwnerUid = String(setupSnap.data()?.ownerUid || '');
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, 'appState/ownerSetup');
    }

    if (setupExists && setupOwnerUid && setupOwnerUid !== uid) {
      throw new Error('An Owner/Admin account is already configured for this shop.');
    }

    let adminExists = false;
    try {
      const adminSnap = await withOfflineRetry(() => getDoc(adminRef));
      adminExists = adminSnap.exists();
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `admins/${uid}`);
    }

    if (!setupExists || !adminExists) {
      if (!adminExists && !ownerProof) {
        throw new Error('Access Denied. Server Owner authorization proof is required.');
      }
      try {
        await withOfflineRetry(async () => {
          const batch = writeBatch(db);
          if (!setupExists) {
            batch.set(setupRef, {
              ownerUid: uid,
              initialized: true,
              createdAt: serverTimestamp(),
            });
          }
          if (!adminExists) {
            batch.set(adminRef, {
              uid,
              email,
              role: 'owner',
              ownerProof,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
          await batch.commit();
        });
      } catch (err) {
        handleFirestoreError(
          err,
          OperationType.CREATE,
          !setupExists ? 'appState/ownerSetup' : `admins/${uid}`
        );
      }
    }
  }

  const userRef = doc(db, 'users', uid);
  let userExists = false;
  try {
    const userSnap = await withOfflineRetry(() => getDoc(userRef));
    userExists = userSnap.exists();
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `users/${uid}`);
  }
  if (!userExists) {
    try {
      await setDoc(userRef, {
        uid,
        displayName,
        email,
        role: isAddedAdmin ? 'admin' : 'owner',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `users/${uid}`);
    }
  }

  if (isAddedAdmin) {
    return;
  }

  const rootShopRef = doc(db, 'shops', uid);
  let shopAlreadyExists = false;
  try {
    const shopSnap = await withOfflineRetry(() => getDoc(rootShopRef));
    shopAlreadyExists = shopSnap.exists();
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `shops/${uid}`);
  }
  if (!shopAlreadyExists) {
    try {
      await setDoc(rootShopRef, {
        ownerUid: uid,
        shopName: initialShopName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `shops/${uid}`);
    }
  }

  const settingsRef = shopDoc(uid, 'settings', 'general');
  let settingsExists = false;
  try {
    const settingsSnap = await withOfflineRetry(() => getDoc(settingsRef));
    settingsExists = settingsSnap.exists();
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `shops/${uid}/settings/general`);
  }
  if (!settingsExists) {
    try {
      const batch = writeBatch(db);
      batch.set(settingsRef, {
        ownerUid: uid,
        shopName: initialShopName,
        ownerName: displayName,
        phone: '',
        address: '',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        dateFormat: 'DD-MM-YYYY',
        language: 'English',
        expiryAlertDays: 30,
        autoBackupEnabled: true,
        lastBackupAt: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      for (const cat of DEFAULT_CATEGORIES) {
        batch.set(shopDoc(uid, 'categories', cat.id), {
          ownerUid: uid,
          name: cat.name,
          description: cat.description,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      for (const expCat of DEFAULT_EXPENSE_CATEGORIES) {
        batch.set(shopDoc(uid, 'expenseCategories', expCat.id), {
          ownerUid: uid,
          name: expCat.name,
          isDefault: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();

      // Chunk brand writes (<= 350 ops/batch) to stay safely under Firestore's 500-write batch limit
      for (let i = 0; i < DEFAULT_BRANDS.length; i += 350) {
        const brandBatch = writeBatch(db);
        const brandChunk = DEFAULT_BRANDS.slice(i, i + 350);
        for (const brand of brandChunk) {
          brandBatch.set(shopDoc(uid, 'brands', brand.id), {
            ownerUid: uid,
            name: clip(brand.name, 100),
            categoryIds: brand.categoryIds.slice(0, 25),
            isActive: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        await brandBatch.commit();
      }

      // Seed default product suggestion catalog right after base workspace entities
      const templateChunks: typeof DEFAULT_PRODUCT_TEMPLATES[] = [];
      for (let i = 0; i < DEFAULT_PRODUCT_TEMPLATES.length; i += 350) {
        templateChunks.push(DEFAULT_PRODUCT_TEMPLATES.slice(i, i + 350));
      }
      const catNameById = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c.name]));
      const brandNameById = new Map(DEFAULT_BRANDS.map((b) => [b.id, b.name]));
      for (const chunk of templateChunks) {
        const tplBatch = writeBatch(db);
        for (const tpl of chunk) {
          tplBatch.set(
            shopDoc(uid, 'productTemplates', tpl.id),
            buildProductTemplateWritePayload(uid, {
              ...tpl,
              categoryName: catNameById.get(tpl.categoryId) || 'Other Products',
              brandName: brandNameById.get(tpl.brandId) || 'Generic',
              isActive: true,
              isCustom: false,
            })
          );
        }
        await tplBatch.commit();
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `shops/${uid}/settings/general`);
    }
  }
}

// ------------------------------------------------------------------
// Categories, Brands, Suppliers, Expense Categories
// ------------------------------------------------------------------
export async function ensureDefaultCategories(
  uid: string,
  existingCategories: Category[],
  existingProducts: Product[] = []
): Promise<void> {
  try {
    type BatchOp =
      | { type: 'set'; ref: ReturnType<typeof shopDoc>; data: Record<string, unknown> }
      | { type: 'update'; ref: ReturnType<typeof shopDoc>; data: Record<string, unknown> }
      | { type: 'delete'; ref: ReturnType<typeof shopDoc> };

    const ops: BatchOp[] = [];
    const existingIds = new Set(existingCategories.map((c) => c.id));
    const handledCatIds = new Set<string>();
    const deletedCatIds = new Set<string>();
    const idRemap = new Map<string, { id: string; name: string }>();
    const aliasNameRemap = new Map<string, { id: string; name: string }>();
    const mergeRuleCanonicalIds = new Set(CATEGORY_MERGE_RULES.map((r) => r.canonicalId));

    // 1. Handle the 3 consolidated / renamed categories while preserving IDs wherever possible
    for (const rule of CATEGORY_MERGE_RULES) {
      const legacyIdSet = new Set(rule.legacyIds || []);
      const matches = existingCategories.filter(
        (c) =>
          !deletedCatIds.has(c.id) &&
          (c.id === rule.canonicalId ||
            legacyIdSet.has(c.id) ||
            rule.aliases.includes(normalizeCategoryKey(c.name)))
      );

      const keeper =
        matches.find((c) => c.id === rule.canonicalId) ||
        matches.find((c) => normalizeCategoryKey(c.name) === normalizeCategoryKey(rule.canonicalName)) ||
        matches[0];

      let targetId: string;
      if (keeper) {
        targetId = keeper.id;
        handledCatIds.add(keeper.id);
        if (keeper.name !== rule.canonicalName || (keeper.description || '') !== rule.description) {
          ops.push({
            type: 'update',
            ref: shopDoc(uid, 'categories', keeper.id),
            data: {
              name: clip(rule.canonicalName, 100),
              description: clip(rule.description, 300),
              updatedAt: serverTimestamp(),
            },
          });
        }
      } else {
        const freshRef = existingIds.has(rule.canonicalId)
          ? doc(shopCol(uid, 'categories'))
          : shopDoc(uid, 'categories', rule.canonicalId);
        targetId = freshRef.id;
        existingIds.add(targetId);
        ops.push({
          type: 'set',
          ref: freshRef,
          data: {
            ownerUid: uid,
            name: clip(rule.canonicalName, 100),
            description: clip(rule.description, 300),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }

      idRemap.set(targetId, { id: targetId, name: rule.canonicalName });
      for (const alias of rule.aliases) {
        aliasNameRemap.set(alias, { id: targetId, name: rule.canonicalName });
      }

      for (const dup of matches) {
        if (dup.id === targetId) continue;
        handledCatIds.add(dup.id);
        deletedCatIds.add(dup.id);
        idRemap.set(dup.id, { id: targetId, name: rule.canonicalName });
        ops.push({
          type: 'delete',
          ref: shopDoc(uid, 'categories', dup.id),
        });
      }
    }

    // 2. Ensure the remaining 8 standalone standard categories exist and are deduplicated
    for (const def of DEFAULT_CATEGORIES) {
      if (mergeRuleCanonicalIds.has(def.id)) continue;
      const defKey = normalizeCategoryKey(def.name);
      const matches = existingCategories.filter(
        (c) =>
          !deletedCatIds.has(c.id) &&
          !handledCatIds.has(c.id) &&
          (c.id === def.id || normalizeCategoryKey(c.name) === defKey)
      );

      const keeper = matches.find((c) => c.id === def.id) || matches[0];
      let targetId: string;

      if (keeper) {
        targetId = keeper.id;
        handledCatIds.add(keeper.id);
        if (keeper.name !== def.name) {
          ops.push({
            type: 'update',
            ref: shopDoc(uid, 'categories', keeper.id),
            data: {
              name: clip(def.name, 100),
              description: clip(keeper.description || def.description, 300),
              updatedAt: serverTimestamp(),
            },
          });
        }
      } else {
        const freshRef = existingIds.has(def.id)
          ? doc(shopCol(uid, 'categories'))
          : shopDoc(uid, 'categories', def.id);
        targetId = freshRef.id;
        existingIds.add(targetId);
        ops.push({
          type: 'set',
          ref: freshRef,
          data: {
            ownerUid: uid,
            name: clip(def.name, 100),
            description: clip(def.description, 300),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }

      idRemap.set(targetId, { id: targetId, name: def.name });
      aliasNameRemap.set(defKey, { id: targetId, name: def.name });

      for (const dup of matches) {
        if (dup.id === targetId) continue;
        handledCatIds.add(dup.id);
        deletedCatIds.add(dup.id);
        idRemap.set(dup.id, { id: targetId, name: def.name });
        ops.push({
          type: 'delete',
          ref: shopDoc(uid, 'categories', dup.id),
        });
      }
    }

    // 3. Remove legacy "Imported Products" category (migrating products to originType='imported' + Other Products)
    const importedMatches = existingCategories.filter(
      (c) =>
        !deletedCatIds.has(c.id) &&
        (c.id === 'cat_imported' || isImportedCategoryName(c.name))
    );
    const importedCatIds = new Set<string>(['cat_imported']);
    for (const impCat of importedMatches) {
      importedCatIds.add(impCat.id);
      handledCatIds.add(impCat.id);
      deletedCatIds.add(impCat.id);
      ops.push({
        type: 'delete',
        ref: shopDoc(uid, 'categories', impCat.id),
      });
    }

    // 4. Deduplicate any remaining custom categories with matching normalized names
    const customKeepers = new Map<string, Category>();
    for (const c of existingCategories) {
      if (handledCatIds.has(c.id) || deletedCatIds.has(c.id)) continue;
      const key = normalizeCategoryKey(c.name);
      if (!key) continue;
      const existingKeeper = customKeepers.get(key);
      if (!existingKeeper) {
        customKeepers.set(key, c);
      } else {
        deletedCatIds.add(c.id);
        idRemap.set(c.id, { id: existingKeeper.id, name: existingKeeper.name });
        ops.push({
          type: 'delete',
          ref: shopDoc(uid, 'categories', c.id),
        });
      }
    }

    // 5. Migrate products assigned to merged, renamed, duplicate, or Imported Products categories
    const otherTarget = aliasNameRemap.get('other products') || {
      id: 'cat_other',
      name: 'Other Products',
    };

    const needsProductMigration =
      ops.some((op) => op.type !== 'set') ||
      importedMatches.length > 0 ||
      existingCategories.some(
        (c) =>
          isImportedCategoryName(c.name) ||
          CATEGORY_MERGE_RULES.some(
            (r) =>
              (r.legacyIds && r.legacyIds.includes(c.id)) ||
              r.aliases.includes(normalizeCategoryKey(c.name))
          )
      );

    const productsToCheck =
      existingProducts.length > 0
        ? existingProducts
        : needsProductMigration
          ? await getDocs(query(shopCol(uid, 'products'), where('ownerUid', '==', uid))).then(
              (snap) => snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Product, 'id'>) }))
            )
          : [];

    for (const p of productsToCheck) {
      const fromImportedCat =
        importedCatIds.has(p.categoryId) || isImportedCategoryName(p.categoryName || '');

      if (fromImportedCat) {
        const nextOrigin: OriginType = p.originType === 'local' ? 'local' : 'imported';
        if (
          p.categoryId !== otherTarget.id ||
          p.categoryName !== otherTarget.name ||
          p.originType !== nextOrigin
        ) {
          ops.push({
            type: 'update',
            ref: shopDoc(uid, 'products', p.id),
            data: {
              categoryId: otherTarget.id,
              categoryName: clip(otherTarget.name, 100),
              originType: nextOrigin,
              updatedAt: serverTimestamp(),
            },
          });
        }
        continue;
      }

      const target =
        idRemap.get(p.categoryId) || aliasNameRemap.get(normalizeCategoryKey(p.categoryName || ''));
      if (target && (p.categoryId !== target.id || p.categoryName !== target.name)) {
        ops.push({
          type: 'update',
          ref: shopDoc(uid, 'products', p.id),
          data: {
            categoryId: target.id,
            categoryName: clip(target.name, 100),
            updatedAt: serverTimestamp(),
          },
        });
      }
    }

    if (ops.length === 0) return;

    const CHUNK_SIZE = 400;
    for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      const chunk = ops.slice(i, i + CHUNK_SIZE);
      for (const op of chunk) {
        if (op.type === 'set') batch.set(op.ref, op.data);
        else if (op.type === 'update') batch.update(op.ref, op.data);
        else batch.delete(op.ref);
      }
      await batch.commit();
    }
  } catch (err) {
    console.warn('Category cleanup & backfill skipped:', err);
  }
}

export async function createCategory(uid: string, name: string, description: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Category name is required.');
  }
  if (isImportedCategoryName(trimmed)) {
    throw new Error(
      '"Imported Products" is handled via the Product Origin (Local / Imported) field instead of a separate category.'
    );
  }

  const canonicalName = resolveCanonicalCategoryName(trimmed);
  const canonicalKey = normalizeCategoryKey(canonicalName);

  try {
    const snap = await getDocs(query(shopCol(uid, 'categories'), where('ownerUid', '==', uid)));
    const existingMatch = snap.docs.find((d) => {
      const existingName = String(d.data()?.name || '');
      return (
        normalizeCategoryKey(resolveCanonicalCategoryName(existingName)) === canonicalKey ||
        normalizeCategoryKey(existingName) === normalizeCategoryKey(trimmed)
      );
    });
    if (existingMatch) {
      const existingName = String(existingMatch.data()?.name || canonicalName);
      throw new Error(`Category "${existingName}" already exists.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/categories`);
  }

  const ref = doc(shopCol(uid, 'categories'));
  try {
    await setDoc(ref, {
      ownerUid: uid,
      name: clip(canonicalName, 100),
      description: clip(description, 300),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `shops/${uid}/categories/${ref.id}`);
  }
}

export async function updateCategory(uid: string, id: string, name: string, description: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Category name is required.');
  }
  if (isImportedCategoryName(trimmed)) {
    throw new Error(
      '"Imported Products" is handled via the Product Origin (Local / Imported) field instead of a separate category.'
    );
  }

  const canonicalName = resolveCanonicalCategoryName(trimmed);
  const canonicalKey = normalizeCategoryKey(canonicalName);

  try {
    const snap = await getDocs(query(shopCol(uid, 'categories'), where('ownerUid', '==', uid)));
    const duplicate = snap.docs.find((d) => {
      if (d.id === id) return false;
      const existingName = String(d.data()?.name || '');
      return normalizeCategoryKey(resolveCanonicalCategoryName(existingName)) === canonicalKey;
    });
    if (duplicate) {
      const existingName = String(duplicate.data()?.name || canonicalName);
      throw new Error(`Another category named "${existingName}" already exists.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/categories`);
  }

  const ref = shopDoc(uid, 'categories', id);
  try {
    await updateDoc(ref, {
      name: clip(canonicalName, 100),
      description: clip(description, 300),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/categories/${id}`);
  }
}

export async function deleteCategory(uid: string, id: string): Promise<void> {
  const ref = shopDoc(uid, 'categories', id);
  try {
    await deleteDoc(ref);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `shops/${uid}/categories/${id}`);
  }
}

function sanitizeBrandCategoryIds(categoryIds?: string[]): string[] {
  if (!Array.isArray(categoryIds)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of categoryIds) {
    const val = clip(raw, 128);
    if (!val || seen.has(val)) continue;
    seen.add(val);
    cleaned.push(val);
    if (cleaned.length >= 25) break;
  }
  return cleaned;
}

interface BrandBackfillStats {
  brandsAdded: number;
  brandsUpdated: number;
  addedByCategory: Record<string, number>;
}

async function runDefaultBrandsSync(
  uid: string,
  existingBrands: Brand[] = [],
  existingCategories?: Category[],
  options?: { forceCheck?: boolean }
): Promise<BrandBackfillStats> {
  const stats: BrandBackfillStats = {
    brandsAdded: 0,
    brandsUpdated: 0,
    addedByCategory: {},
  };

  const storageKey = `cm_brands_v4_seeded_${uid}`;
  const alreadySeededLocally =
    !options?.forceCheck &&
    typeof window !== 'undefined' &&
    window.localStorage.getItem(storageKey) === '1';

  const hasMissingLegacyMeta = (list: Brand[]) =>
    list.some(
      (b) =>
        [
          'brand_pampers',
          'brand_huggies',
          'brand_molfix',
          'brand_bonapapa',
          'brand_rosepetal',
          'brand_johnsons',
          'brand_lifebuoy',
          'brand_dove',
        ].includes(b.id) &&
        (!Array.isArray(b.categoryIds) || b.categoryIds.length === 0 || b.isActive === undefined)
    );

  const hasExpandedV4Library = (list: Brand[]) => {
    const idSet = new Set(list.map((b) => b.id));
    return (
      list.length >= 220 &&
      idSet.has('brand_durex') &&
      idSet.has('brand_cerave') &&
      idSet.has('brand_morinaga') &&
      idSet.has('brand_vitaltea') &&
      idSet.has('brand_brookebond') &&
      idSet.has('brand_indomie') &&
      idSet.has('brand_guard')
    );
  };

  const isBrandsDone = (list: Brand[]) =>
    !hasMissingLegacyMeta(list) &&
    ((alreadySeededLocally && list.length >= 120) || hasExpandedV4Library(list));

  // Fast path: if caller already has live listener data and v4 brands are seeded, skip all Firestore reads
  if (!options?.forceCheck && existingBrands.length > 0 && isBrandsDone(existingBrands)) {
    if (typeof window !== 'undefined' && !alreadySeededLocally) {
      window.localStorage.setItem(storageKey, '1');
    }
    return stats;
  }

  const currentBrands: Brand[] =
    existingBrands.length > 0
      ? existingBrands
      : await getDocs(query(shopCol(uid, 'brands'), where('ownerUid', '==', uid))).then(
          (brandsSnap) =>
            brandsSnap.docs.map((d) => ({
              id: d.id,
              ...(d.data() as Omit<Brand, 'id'>),
            }))
        );

  if (!options?.forceCheck && currentBrands.length > 0 && isBrandsDone(currentBrands)) {
    if (typeof window !== 'undefined' && !alreadySeededLocally) {
      window.localStorage.setItem(storageKey, '1');
    }
    return stats;
  }

  const liveCategories: Category[] =
    existingCategories && existingCategories.length > 0
      ? existingCategories
      : await getDocs(query(shopCol(uid, 'categories'), where('ownerUid', '==', uid))).then(
          (catsSnap) =>
            catsSnap.docs.map((d) => ({
              id: d.id,
              ...(d.data() as Omit<Category, 'id'>),
            }))
        );

  const existingIds = new Set(currentBrands.map((b) => b.id));
  const existingById = new Map(currentBrands.map((b) => [b.id, b]));
  const existingByKey = new Map<string, Brand>();
  for (const b of currentBrands) {
    const k = normalizeBrandKey(b.name);
    if (k && !existingByKey.has(k)) {
      existingByKey.set(k, b);
    }
  }

  type BatchOp =
    | { type: 'set'; ref: ReturnType<typeof shopDoc>; data: Record<string, unknown> }
    | { type: 'update'; ref: ReturnType<typeof shopDoc>; data: Record<string, unknown> };

  const ops: BatchOp[] = [];

  for (const def of DEFAULT_BRANDS) {
    const resolvedCatIds = resolveBrandCategoryIds(def.categoryIds, liveCategories);
    const matched = existingById.get(def.id) || existingByKey.get(normalizeBrandKey(def.name));

    if (matched) {
      const existingCats = Array.isArray(matched.categoryIds) ? matched.categoryIds : [];
      const existingCatSet = new Set(existingCats);
      const mergedCats = sanitizeBrandCategoryIds([...existingCats, ...resolvedCatIds]);
      const addedCats = mergedCats.some((cid) => !existingCatSet.has(cid));
      const needsActive = matched.isActive === undefined;
      if (addedCats || existingCats.length === 0 || needsActive) {
        ops.push({
          type: 'update',
          ref: shopDoc(uid, 'brands', matched.id),
          data: {
            categoryIds: mergedCats.length > 0 ? mergedCats : resolvedCatIds,
            isActive: matched.isActive !== false,
            updatedAt: serverTimestamp(),
          },
        });
        stats.brandsUpdated += 1;
      }
      continue;
    }

    const targetRef = existingIds.has(def.id)
      ? doc(shopCol(uid, 'brands'))
      : shopDoc(uid, 'brands', def.id);
    existingIds.add(targetRef.id);
    ops.push({
      type: 'set',
      ref: targetRef,
      data: {
        ownerUid: uid,
        name: clip(def.name, 100),
        categoryIds: resolvedCatIds,
        isActive: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
    });
    stats.brandsAdded += 1;
    for (const cid of resolvedCatIds) {
      stats.addedByCategory[cid] = (stats.addedByCategory[cid] || 0) + 1;
    }
  }

  if (ops.length > 0) {
    const CHUNK_SIZE = 350;
    for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      const chunk = ops.slice(i, i + CHUNK_SIZE);
      for (const op of chunk) {
        if (op.type === 'set') batch.set(op.ref, op.data);
        else batch.update(op.ref, op.data);
      }
      await batch.commit();
    }
  }

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(storageKey, '1');
  }
  return stats;
}

export async function ensureDefaultBrands(
  uid: string,
  existingBrands: Brand[] = [],
  existingCategories?: Category[]
): Promise<void> {
  try {
    await runDefaultBrandsSync(uid, existingBrands, existingCategories);
  } catch (err) {
    console.warn('Default brand library backfill skipped:', err);
  }
}

export type BrandInput =
  | string
  | {
      name: string;
      categoryIds?: string[];
      isActive?: boolean;
    };

export async function createBrand(uid: string, input: BrandInput): Promise<string> {
  const rawName = typeof input === 'string' ? input : input.name;
  const trimmed = rawName.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    throw new Error('Brand name is required.');
  }

  try {
    const snap = await getDocs(query(shopCol(uid, 'brands'), where('ownerUid', '==', uid)));
    const existingBrands: Brand[] = snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<Brand, 'id'>),
    }));
    const duplicate = findExactBrandMatch(trimmed, existingBrands);
    if (duplicate) {
      throw new Error(`Brand "${duplicate.name}" already exists.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/brands`);
  }

  const categoryIds = typeof input === 'string' ? [] : sanitizeBrandCategoryIds(input.categoryIds);
  const isActive = typeof input === 'string' ? true : input.isActive !== false;

  const ref = doc(shopCol(uid, 'brands'));
  try {
    await setDoc(ref, {
      ownerUid: uid,
      name: clip(trimmed, 100),
      categoryIds,
      isActive,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `shops/${uid}/brands/${ref.id}`);
  }
}

export async function updateBrand(uid: string, id: string, input: BrandInput): Promise<void> {
  const rawName = typeof input === 'string' ? input : input.name;
  const trimmed = rawName.trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    throw new Error('Brand name is required.');
  }

  let existingBrands: Brand[] = [];
  try {
    const snap = await getDocs(query(shopCol(uid, 'brands'), where('ownerUid', '==', uid)));
    existingBrands = snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<Brand, 'id'>),
    }));
    const duplicate = findExactBrandMatch(trimmed, existingBrands, id);
    if (duplicate) {
      throw new Error(`Another brand named "${duplicate.name}" already exists.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/brands`);
  }

  const currentBrand = existingBrands.find((b) => b.id === id);
  const clippedName = clip(trimmed, 100);
  const nameChanged = Boolean(currentBrand && currentBrand.name !== clippedName);

  const updatePayload: Record<string, unknown> = {
    name: clippedName,
    updatedAt: serverTimestamp(),
  };
  if (typeof input !== 'string') {
    if (input.categoryIds !== undefined) {
      updatePayload.categoryIds = sanitizeBrandCategoryIds(input.categoryIds);
    }
    if (input.isActive !== undefined) {
      updatePayload.isActive = Boolean(input.isActive);
    }
  }

  const ref = shopDoc(uid, 'brands', id);
  try {
    await updateDoc(ref, updatePayload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/brands/${id}`);
  }

  if (nameChanged) {
    try {
      const prodSnap = await getDocs(
        query(shopCol(uid, 'products'), where('ownerUid', '==', uid), where('brandId', '==', id))
      );
      if (!prodSnap.empty) {
        const CHUNK_SIZE = 400;
        for (let i = 0; i < prodSnap.docs.length; i += CHUNK_SIZE) {
          const batch = writeBatch(db);
          const chunk = prodSnap.docs.slice(i, i + CHUNK_SIZE);
          for (const prodDoc of chunk) {
            batch.update(prodDoc.ref, {
              brandName: clippedName,
              updatedAt: serverTimestamp(),
            });
          }
          await batch.commit();
        }
      }
      const tplSnap = await getDocs(
        query(shopCol(uid, 'productTemplates'), where('ownerUid', '==', uid), where('brandId', '==', id))
      );
      if (!tplSnap.empty) {
        const CHUNK_SIZE = 400;
        for (let i = 0; i < tplSnap.docs.length; i += CHUNK_SIZE) {
          const batch = writeBatch(db);
          const chunk = tplSnap.docs.slice(i, i + CHUNK_SIZE);
          for (const tplDoc of chunk) {
            batch.update(tplDoc.ref, {
              brandName: clippedName,
              updatedAt: serverTimestamp(),
            });
          }
          await batch.commit();
        }
      }
    } catch (err) {
      console.warn('Brand rename product sync skipped:', err);
    }
  }
}

export async function toggleBrandStatus(uid: string, id: string, isActive: boolean): Promise<void> {
  const ref = shopDoc(uid, 'brands', id);
  try {
    await updateDoc(ref, {
      isActive: Boolean(isActive),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/brands/${id}`);
  }
}

export async function deleteBrand(uid: string, id: string): Promise<void> {
  const ref = shopDoc(uid, 'brands', id);
  try {
    await deleteDoc(ref);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `shops/${uid}/brands/${id}`);
  }
}

export async function createSupplier(
  uid: string,
  input: { name: string; phone: string; address: string; notes: string }
): Promise<string> {
  const ref = doc(shopCol(uid, 'suppliers'));
  try {
    await setDoc(ref, {
      ownerUid: uid,
      name: clip(input.name, 150),
      phone: clip(input.phone, 40),
      address: clip(input.address, 300),
      totalPurchased: 0,
      totalPaid: 0,
      outstandingBalance: 0,
      notes: clip(input.notes, 500),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `shops/${uid}/suppliers/${ref.id}`);
  }
}

export async function updateSupplier(
  uid: string,
  id: string,
  input: { name: string; phone: string; address: string; notes: string }
): Promise<void> {
  const ref = shopDoc(uid, 'suppliers', id);
  try {
    await updateDoc(ref, {
      name: clip(input.name, 150),
      phone: clip(input.phone, 40),
      address: clip(input.address, 300),
      notes: clip(input.notes, 500),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/suppliers/${id}`);
  }
}

export async function deleteSupplier(uid: string, id: string): Promise<void> {
  const ref = shopDoc(uid, 'suppliers', id);
  try {
    await deleteDoc(ref);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `shops/${uid}/suppliers/${id}`);
  }
}

export async function createExpenseCategory(uid: string, name: string): Promise<string> {
  const ref = doc(shopCol(uid, 'expenseCategories'));
  try {
    await setDoc(ref, {
      ownerUid: uid,
      name: clip(name, 100),
      isDefault: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `shops/${uid}/expenseCategories/${ref.id}`);
  }
}

export async function deleteExpenseCategory(uid: string, id: string): Promise<void> {
  const ref = shopDoc(uid, 'expenseCategories', id);
  try {
    await deleteDoc(ref);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `shops/${uid}/expenseCategories/${id}`);
  }
}

// ------------------------------------------------------------------
// Products CRUD
// ------------------------------------------------------------------
export interface ProductInput {
  name: string;
  categoryId: string;
  categoryName: string;
  brandId: string;
  brandName: string;
  purchasePrice: number;
  salePrice: number;
  wholesalePrice: number;
  currentStock: number;
  minStockLevel: number;
  maxStockLevel: number;
  unit: string;
  baseUnit?: string;
  packagingUnits?: ProductPackagingUnit[];
  originType?: OriginType;
  bottleSize?: string;
  storageLocation?: string;
  isReturnable?: boolean;
  returnableUnitName?: string;
  depositPerReturnable?: number;
  emptyContainersOnHand?: number;
  supplierId: string;
  supplierName: string;
  expiryDate: string;
  isActive: boolean;
}

export async function createProduct(uid: string, input: ProductInput): Promise<string> {
  const prodRef = doc(shopCol(uid, 'products'));
  const baseUnit = clip(input.baseUnit || input.unit || 'Piece', 40) || 'Piece';
  const packagingUnits = normalizePackagingUnits(input.packagingUnits, baseUnit);
  const purchasePrice = Math.max(0, roundMoney(input.purchasePrice));
  const salePrice = Math.max(0, roundMoney(input.salePrice));
  const wholesalePrice = Math.max(0, roundMoney(input.wholesalePrice));
  const profitMarginPct = calcProfitMarginPct(purchasePrice, salePrice);
  const initialStock = roundStockQty(Math.max(0, Number(input.currentStock) || 0));
  const todayIso = getKarachiDateIso();

  try {
    const batch = writeBatch(db);
    batch.set(prodRef, {
      ownerUid: uid,
      name: clip(input.name, 180),
      categoryId: clip(input.categoryId, 128),
      categoryName: clip(input.categoryName, 100),
      brandId: clip(input.brandId, 128),
      brandName: clip(input.brandName, 100),
      purchasePrice,
      salePrice,
      wholesalePrice,
      currentStock: initialStock,
      minStockLevel: roundStockQty(Math.max(0, Number(input.minStockLevel) || 0)),
      maxStockLevel: roundStockQty(Math.max(0, Number(input.maxStockLevel) || 0)),
      unit: baseUnit,
      baseUnit,
      packagingUnits,
      originType: (input.originType === 'local' || input.originType === 'imported'
        ? input.originType
        : '') as OriginType,
      bottleSize: clip(input.bottleSize, 40),
      storageLocation: clip(input.storageLocation, 80),
      isReturnable: Boolean(input.isReturnable),
      returnableUnitName: clip(input.returnableUnitName, 40),
      depositPerReturnable: Math.max(0, roundMoney(Number(input.depositPerReturnable) || 0)),
      emptyContainersOnHand: roundStockQty(Math.max(0, Number(input.emptyContainersOnHand) || 0)),
      supplierId: clip(input.supplierId, 128),
      supplierName: clip(input.supplierName, 150),
      expiryDate: clip(input.expiryDate, 20),
      profitMarginPct,
      isActive: input.isActive,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (initialStock > 0) {
      const movRef = doc(shopCol(uid, 'stockMovements'));
      batch.set(movRef, {
        ownerUid: uid,
        productId: prodRef.id,
        productName: clip(input.name, 180),
        movementDate: todayIso,
        movementType: 'initial_stock',
        quantityChange: initialStock,
        previousStock: 0,
        newStock: initialStock,
        unitName: baseUnit,
        unitQuantity: initialStock,
        conversionFactor: 1,
        baseQuantity: initialStock,
        referenceId: prodRef.id,
        notes: 'Initial opening stock on product creation',
        createdAt: serverTimestamp(),
      });

      const batchRef = doc(shopCol(uid, 'inventoryBatches'));
      batch.set(batchRef, {
        ownerUid: uid,
        productId: prodRef.id,
        productName: clip(input.name, 180),
        purchaseId: 'opening',
        purchaseNumber: 'OPENING',
        purchaseDate: todayIso,
        supplierId: clip(input.supplierId, 128),
        supplierName: clip(input.supplierName || 'Opening Stock', 150),
        initialBaseQty: initialStock,
        remainingBaseQty: initialStock,
        unitCostInBase: purchasePrice,
        expiryDate: clip(input.expiryDate, 20),
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    const logRef = doc(shopCol(uid, 'auditLogs'));
    batch.set(logRef, {
      ownerUid: uid,
      action: 'CREATE_PRODUCT',
      entityType: 'product',
      entityId: prodRef.id,
      summary: clip(`Added product ${input.name} (Stock: ${initialStock} ${baseUnit})`, 400),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
    enqueueSheetsBackgroundTask({
      dedupeId: prodRef.id,
      shopId: uid,
      entityType: 'product',
      entityId: prodRef.id,
      action: 'CREATE_PRODUCT',
      summary: clip(`Product "${input.name}"`, 180),
      targetSheets: ['Products', 'Inventory', 'Daily Summary'],
    });
    return prodRef.id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `shops/${uid}/products/${prodRef.id}`);
  }
}

export async function updateProduct(
  uid: string,
  productId: string,
  input: Omit<ProductInput, 'currentStock'>
): Promise<void> {
  const prodRef = shopDoc(uid, 'products', productId);
  const baseUnit = clip(input.baseUnit || input.unit || 'Piece', 40) || 'Piece';
  const packagingUnits = normalizePackagingUnits(input.packagingUnits, baseUnit);
  const purchasePrice = Math.max(0, roundMoney(input.purchasePrice));
  const salePrice = Math.max(0, roundMoney(input.salePrice));
  const wholesalePrice = Math.max(0, roundMoney(input.wholesalePrice));
  const profitMarginPct = calcProfitMarginPct(purchasePrice, salePrice);

  try {
    const batch = writeBatch(db);
    batch.update(prodRef, {
      name: clip(input.name, 180),
      categoryId: clip(input.categoryId, 128),
      categoryName: clip(input.categoryName, 100),
      brandId: clip(input.brandId, 128),
      brandName: clip(input.brandName, 100),
      purchasePrice,
      salePrice,
      wholesalePrice,
      minStockLevel: roundStockQty(Math.max(0, Number(input.minStockLevel) || 0)),
      maxStockLevel: roundStockQty(Math.max(0, Number(input.maxStockLevel) || 0)),
      unit: baseUnit,
      baseUnit,
      packagingUnits,
      originType: (input.originType === 'local' || input.originType === 'imported'
        ? input.originType
        : '') as OriginType,
      bottleSize: clip(input.bottleSize, 40),
      storageLocation: clip(input.storageLocation, 80),
      isReturnable: Boolean(input.isReturnable),
      returnableUnitName: clip(input.returnableUnitName, 40),
      depositPerReturnable: Math.max(0, roundMoney(Number(input.depositPerReturnable) || 0)),
      emptyContainersOnHand: roundStockQty(Math.max(0, Number(input.emptyContainersOnHand) || 0)),
      supplierId: clip(input.supplierId, 128),
      supplierName: clip(input.supplierName, 150),
      expiryDate: clip(input.expiryDate, 20),
      profitMarginPct,
      isActive: input.isActive,
      updatedAt: serverTimestamp(),
    });

    const logRef = doc(shopCol(uid, 'auditLogs'));
    batch.set(logRef, {
      ownerUid: uid,
      action: 'UPDATE_PRODUCT',
      entityType: 'product',
      entityId: productId,
      summary: clip(`Updated product ${input.name} (Buy: ${purchasePrice}/${baseUnit}, Sell: ${salePrice}/${baseUnit})`, 400),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
    enqueueSheetsBackgroundTask({
      dedupeId: `${productId}:update:${Date.now()}`,
      shopId: uid,
      entityType: 'product',
      entityId: productId,
      action: 'UPDATE_PRODUCT',
      summary: clip(`Updated product "${input.name}"`, 180),
      targetSheets: ['Products', 'Inventory', 'Daily Summary'],
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/products/${productId}`);
  }
}

export async function deleteProduct(uid: string, product: Product): Promise<void> {
  const prodRef = shopDoc(uid, 'products', product.id);
  try {
    const batch = writeBatch(db);
    batch.delete(prodRef);
    const logRef = doc(shopCol(uid, 'auditLogs'));
    batch.set(logRef, {
      ownerUid: uid,
      action: 'DELETE_PRODUCT',
      entityType: 'product',
      entityId: product.id,
      summary: clip(`Deleted product ${product.name}`, 400),
      createdAt: serverTimestamp(),
    });
    await batch.commit();
    enqueueSheetsBackgroundTask({
      dedupeId: `${product.id}:delete`,
      shopId: uid,
      entityType: 'product',
      entityId: product.id,
      action: 'DELETE_PRODUCT',
      summary: clip(`Deleted product "${product.name}"`, 180),
      targetSheets: ['Products', 'Inventory', 'Daily Summary'],
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `shops/${uid}/products/${product.id}`);
  }
}

// ------------------------------------------------------------------
// Product Suggestion Templates Catalog CRUD & Backfill
// ------------------------------------------------------------------
export interface ProductTemplateInput {
  name: string;
  categoryId: string;
  categoryName: string;
  brandId: string;
  brandName: string;
  variant: string;
  originType?: OriginType;
  baseUnit: string;
  defaultPurchaseUnit?: string;
  defaultSaleUnit?: string;
  packagingUnits?: ProductTemplatePackaging[];
  hasUnconfirmedPackaging?: boolean;
  suggestedPurchasePrice?: number;
  suggestedSalePrice?: number;
  suggestedWholesalePrice?: number;
  priceSource?: string;
  priceUpdatedAt?: string;
  trackExpiry?: boolean;
  bottleSize?: string;
  storageLocation?: string;
  isReturnable?: boolean;
  returnableUnitName?: string;
  searchKeywords?: string[];
  isActive?: boolean;
  isCustom?: boolean;
}

function sanitizeTemplatePackaging(
  units: ProductTemplatePackaging[] | undefined,
  baseUnit: string
): ProductTemplatePackaging[] {
  if (!Array.isArray(units)) return [];
  const baseLower = baseUnit.trim().toLowerCase();
  const seen = new Set<string>();
  const cleaned: ProductTemplatePackaging[] = [];
  for (const u of units) {
    const unitName = clip(u.unitName, 40);
    if (!unitName || unitName.toLowerCase() === baseLower || seen.has(unitName.toLowerCase())) {
      continue;
    }
    const containsQty = roundStockQty(Number(u.containsQty) || 0);
    const conversionQty = roundStockQty(Number(u.conversionQty) || containsQty);
    if (containsQty <= 0 || conversionQty <= 0) continue;
    seen.add(unitName.toLowerCase());
    cleaned.push({
      unitName,
      containsQty,
      parentUnitName: clip(u.parentUnitName || baseUnit, 40) || baseUnit,
      conversionQty,
      allowPurchase: u.allowPurchase !== false,
      allowSale: u.allowSale !== false,
      isDefaultPurchase: Boolean(u.isDefaultPurchase),
      isDefaultSale: Boolean(u.isDefaultSale),
      needsConfirmation: Boolean(u.needsConfirmation),
    });
    if (cleaned.length >= 15) break;
  }
  return cleaned;
}

function sanitizeTemplateKeywords(keywords?: string[]): string[] {
  if (!Array.isArray(keywords)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const kw of keywords) {
    const clean = clip(kw, 50).toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 15) break;
  }
  return out;
}

function buildProductTemplateWritePayload(
  uid: string,
  input: ProductTemplateInput,
  options?: { isUpdate?: boolean }
): Record<string, unknown> {
  const baseUnit = clip(input.baseUnit || 'Piece', 40) || 'Piece';
  const packagingUnits = sanitizeTemplatePackaging(input.packagingUnits, baseUnit);
  const originType: OriginType =
    input.originType === 'local' || input.originType === 'imported' ? input.originType : '';
  const hasUnconfirmed =
    Boolean(input.hasUnconfirmedPackaging) ||
    packagingUnits.some((u) => Boolean(u.needsConfirmation));

  const payload: Record<string, unknown> = {
    name: clip(input.name, 180),
    categoryId: clip(input.categoryId, 128),
    categoryName: clip(input.categoryName || 'Other Products', 100),
    brandId: clip(input.brandId, 128),
    brandName: clip(input.brandName || 'Generic', 100),
    variant: clip(input.variant, 120),
    originType,
    baseUnit,
    defaultPurchaseUnit: clip(input.defaultPurchaseUnit, 40),
    defaultSaleUnit: clip(input.defaultSaleUnit, 40),
    packagingUnits,
    hasUnconfirmedPackaging: hasUnconfirmed,
    trackExpiry: Boolean(input.trackExpiry),
    bottleSize: clip(input.bottleSize, 40),
    storageLocation: clip(input.storageLocation, 80),
    isReturnable: Boolean(input.isReturnable),
    returnableUnitName: clip(input.returnableUnitName, 40),
    searchKeywords: sanitizeTemplateKeywords(input.searchKeywords),
    isActive: input.isActive !== false,
    isCustom: Boolean(input.isCustom),
    updatedAt: serverTimestamp(),
  };

  if (
    input.suggestedPurchasePrice !== undefined &&
    Number.isFinite(Number(input.suggestedPurchasePrice)) &&
    Number(input.suggestedPurchasePrice) >= 0
  ) {
    payload.suggestedPurchasePrice = roundMoney(Number(input.suggestedPurchasePrice));
  }
  if (
    input.suggestedSalePrice !== undefined &&
    Number.isFinite(Number(input.suggestedSalePrice)) &&
    Number(input.suggestedSalePrice) >= 0
  ) {
    payload.suggestedSalePrice = roundMoney(Number(input.suggestedSalePrice));
  }
  if (
    input.suggestedWholesalePrice !== undefined &&
    Number.isFinite(Number(input.suggestedWholesalePrice)) &&
    Number(input.suggestedWholesalePrice) >= 0
  ) {
    payload.suggestedWholesalePrice = roundMoney(Number(input.suggestedWholesalePrice));
  }
  if (input.priceSource !== undefined) {
    payload.priceSource = clip(input.priceSource, 150);
  }
  if (input.priceUpdatedAt !== undefined) {
    payload.priceUpdatedAt = clip(input.priceUpdatedAt, 40);
  }

  if (!options?.isUpdate) {
    payload.ownerUid = uid;
    payload.createdAt = serverTimestamp();
  }

  return payload;
}

interface TemplateBackfillStats {
  templatesAdded: number;
  templatesSkippedExisting: number;
  addedByCategory: Record<string, number>;
  skippedByCategory: Record<string, number>;
}

async function runDefaultProductTemplatesSync(
  uid: string,
  existingTemplates?: ProductTemplate[],
  existingCategories?: Category[],
  existingBrands?: Brand[],
  options?: { forceCheck?: boolean }
): Promise<TemplateBackfillStats> {
  const stats: TemplateBackfillStats = {
    templatesAdded: 0,
    templatesSkippedExisting: 0,
    addedByCategory: {},
    skippedByCategory: {},
  };

  const storageKey = `cm_templates_v3_seeded_${uid}`;
  const alreadySeededLocally =
    !options?.forceCheck &&
    typeof window !== 'undefined' &&
    window.localStorage.getItem(storageKey) === '1';

  const hasExpandedV3Templates = (list: ProductTemplate[]) => {
    const idSet = new Set(list.map((t) => t.id));
    return (
      list.length >= 400 &&
      idSet.has('tpl_cerelac_wheat_340g') &&
      idSet.has('tpl_tapal_danedar_900g') &&
      idSet.has('tpl_fruitavitals_chaunsa_1l') &&
      idSet.has('tpl_shan_karahi_50g') &&
      idSet.has('tpl_sw_durex_featherlite_12')
    );
  };

  const isTemplatesDone = (list: ProductTemplate[]) =>
    (alreadySeededLocally && list.length >= 250) || hasExpandedV3Templates(list);

  // Fast path: reuse live listener data without triggering Firestore collection scans
  if (!options?.forceCheck && existingTemplates && isTemplatesDone(existingTemplates)) {
    if (typeof window !== 'undefined' && !alreadySeededLocally) {
      window.localStorage.setItem(storageKey, '1');
    }
    return stats;
  }

  const liveTemplates: ProductTemplate[] =
    existingTemplates && existingTemplates.length > 0
      ? existingTemplates
      : await getDocs(
          query(shopCol(uid, 'productTemplates'), where('ownerUid', '==', uid))
        ).then((snap) =>
          snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as Omit<ProductTemplate, 'id'>),
          }))
        );

  if (!options?.forceCheck && liveTemplates.length > 0 && isTemplatesDone(liveTemplates)) {
    if (typeof window !== 'undefined' && !alreadySeededLocally) {
      window.localStorage.setItem(storageKey, '1');
    }
    return stats;
  }

  const [liveCategories, liveBrands] = await Promise.all([
    existingCategories && existingCategories.length > 0
      ? Promise.resolve(existingCategories)
      : getDocs(query(shopCol(uid, 'categories'), where('ownerUid', '==', uid))).then(
          (catsSnap) =>
            catsSnap.docs.map((d) => ({
              id: d.id,
              ...(d.data() as Omit<Category, 'id'>),
            }))
        ),
    existingBrands && existingBrands.length > 0
      ? Promise.resolve(existingBrands)
      : getDocs(query(shopCol(uid, 'brands'), where('ownerUid', '==', uid))).then(
          (brandsSnap) =>
            brandsSnap.docs.map((d) => ({
              id: d.id,
              ...(d.data() as Omit<Brand, 'id'>),
            }))
        ),
  ]);

  const existingIds = new Set(liveTemplates.map((t) => t.id));
  const existingKeys = new Set(
    liveTemplates.map((t) => normalizeTemplateKey(t.categoryId, t.brandId, t.name, t.variant))
  );

  const toInsert: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (const def of DEFAULT_PRODUCT_TEMPLATES) {
    const resolved = resolveTemplateCategoryAndBrand(def, liveCategories, liveBrands);
    const key = normalizeTemplateKey(
      resolved.categoryId,
      resolved.brandId,
      def.name,
      def.variant
    );
    if (existingIds.has(def.id) || existingKeys.has(key)) {
      stats.templatesSkippedExisting += 1;
      stats.skippedByCategory[resolved.categoryId] =
        (stats.skippedByCategory[resolved.categoryId] || 0) + 1;
      continue;
    }
    existingIds.add(def.id);
    existingKeys.add(key);
    toInsert.push({
      id: def.id,
      data: buildProductTemplateWritePayload(uid, {
        ...def,
        categoryId: resolved.categoryId,
        categoryName: resolved.categoryName,
        brandId: resolved.brandId,
        brandName: resolved.brandName,
        isActive: true,
        isCustom: false,
      }),
    });
    stats.templatesAdded += 1;
    stats.addedByCategory[resolved.categoryId] =
      (stats.addedByCategory[resolved.categoryId] || 0) + 1;
  }

  if (toInsert.length > 0) {
    const CHUNK_SIZE = 350;
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const batch = writeBatch(db);
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      for (const item of chunk) {
        batch.set(shopDoc(uid, 'productTemplates', item.id), item.data);
      }
      await batch.commit();
    }
  }

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(storageKey, '1');
  }
  return stats;
}

export async function ensureDefaultProductTemplates(
  uid: string,
  existingTemplates?: ProductTemplate[],
  existingCategories?: Category[],
  existingBrands?: Brand[]
): Promise<void> {
  try {
    await runDefaultProductTemplatesSync(
      uid,
      existingTemplates,
      existingCategories,
      existingBrands
    );
  } catch (err) {
    console.warn('Default product templates backfill skipped:', err);
  }
}

export interface CatalogAuditCategorySummary {
  categoryId: string;
  categoryName: string;
  description: string;
  isCanonical: boolean;
  liveBrandCount: number;
  brandsAdded: number;
  liveTemplateCount: number;
  activeTemplateCount: number;
  templatesAdded: number;
  templatesSkippedExisting: number;
  liveStoreProductCount: number;
  unconfirmedPackagingCount: number;
  unpricedTemplateCount: number;
  sampleBrands: string[];
}

export interface CatalogAuditReport {
  auditedAtIso: string;
  totalLiveCategories: number;
  canonicalCategoryCount: number;
  customCategoryCount: number;
  totalLiveBrands: number;
  brandsAdded: number;
  brandsCategoryMerged: number;
  totalLiveTemplates: number;
  totalActiveTemplates: number;
  templatesAdded: number;
  templatesSkippedExisting: number;
  totalLiveStoreProducts: number;
  totalUnconfirmedPackaging: number;
  totalUnpricedTemplates: number;
  categories: CatalogAuditCategorySummary[];
}

export async function runLiveCatalogAuditAndSync(
  uid: string,
  options?: { syncMissing?: boolean }
): Promise<CatalogAuditReport> {
  const syncMissing = options?.syncMissing !== false;

  const [catSnap0, brandSnap0, tplSnap0, prodSnap0] = await Promise.all([
    getDocs(query(shopCol(uid, 'categories'), where('ownerUid', '==', uid))),
    getDocs(query(shopCol(uid, 'brands'), where('ownerUid', '==', uid))),
    getDocs(query(shopCol(uid, 'productTemplates'), where('ownerUid', '==', uid))),
    getDocs(query(shopCol(uid, 'products'), where('ownerUid', '==', uid))),
  ]);

  let liveCats: Category[] = catSnap0.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<Category, 'id'>),
  }));
  let liveBrands: Brand[] = brandSnap0.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<Brand, 'id'>),
  }));
  let liveTemplates: ProductTemplate[] = tplSnap0.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<ProductTemplate, 'id'>),
  }));
  const liveProducts: Product[] = prodSnap0.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<Product, 'id'>),
  }));

  let brandStats: BrandBackfillStats = {
    brandsAdded: 0,
    brandsUpdated: 0,
    addedByCategory: {},
  };
  let tplStats: TemplateBackfillStats = {
    templatesAdded: 0,
    templatesSkippedExisting: 0,
    addedByCategory: {},
    skippedByCategory: {},
  };

  if (syncMissing) {
    await ensureDefaultCategories(uid, liveCats, liveProducts);
    const refreshedCatsSnap = await getDocs(
      query(shopCol(uid, 'categories'), where('ownerUid', '==', uid))
    );
    liveCats = refreshedCatsSnap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<Category, 'id'>),
    }));

    brandStats = await runDefaultBrandsSync(uid, liveBrands, liveCats, { forceCheck: true });
    if (brandStats.brandsAdded > 0 || brandStats.brandsUpdated > 0) {
      const refreshedBrandsSnap = await getDocs(
        query(shopCol(uid, 'brands'), where('ownerUid', '==', uid))
      );
      liveBrands = refreshedBrandsSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Brand, 'id'>),
      }));
    }

    tplStats = await runDefaultProductTemplatesSync(
      uid,
      liveTemplates,
      liveCats,
      liveBrands,
      { forceCheck: true }
    );
    if (tplStats.templatesAdded > 0) {
      const refreshedTplSnap = await getDocs(
        query(shopCol(uid, 'productTemplates'), where('ownerUid', '==', uid))
      );
      liveTemplates = refreshedTplSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<ProductTemplate, 'id'>),
      }));
    }
  } else {
    // Audit-only counts: determine how many templates already exist vs canonical set
    const existingIds = new Set(liveTemplates.map((t) => t.id));
    const existingKeys = new Set(
      liveTemplates.map((t) => normalizeTemplateKey(t.categoryId, t.brandId, t.name, t.variant))
    );
    for (const def of DEFAULT_PRODUCT_TEMPLATES) {
      const resolved = resolveTemplateCategoryAndBrand(def, liveCats, liveBrands);
      const key = normalizeTemplateKey(resolved.categoryId, resolved.brandId, def.name, def.variant);
      if (existingIds.has(def.id) || existingKeys.has(key)) {
        tplStats.templatesSkippedExisting += 1;
        tplStats.skippedByCategory[resolved.categoryId] =
          (tplStats.skippedByCategory[resolved.categoryId] || 0) + 1;
      }
    }
  }

  const canonicalIdSet = new Set(DEFAULT_CATEGORIES.map((c) => c.id));
  const canonicalNameSet = new Set(DEFAULT_CATEGORIES.map((c) => normalizeCategoryKey(c.name)));

  const categorySummaries: CatalogAuditCategorySummary[] = [...liveCats]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cat) => {
      const isCanonical =
        canonicalIdSet.has(cat.id) || canonicalNameSet.has(normalizeCategoryKey(cat.name));
      const catBrands = liveBrands.filter((b) => (b.categoryIds || []).includes(cat.id));
      const catTemplates = liveTemplates.filter(
        (t) =>
          t.categoryId === cat.id ||
          normalizeCategoryKey(t.categoryName) === normalizeCategoryKey(cat.name)
      );
      const catProducts = liveProducts.filter(
        (p) =>
          p.categoryId === cat.id ||
          normalizeCategoryKey(p.categoryName) === normalizeCategoryKey(cat.name)
      );
      const unconfirmedPackagingCount = catTemplates.filter((t) =>
        Boolean(t.hasUnconfirmedPackaging)
      ).length;
      const unpricedTemplateCount = catTemplates.filter(
        (t) => !t.suggestedSalePrice || t.suggestedSalePrice <= 0
      ).length;

      return {
        categoryId: cat.id,
        categoryName: cat.name,
        description: cat.description || '',
        isCanonical,
        liveBrandCount: catBrands.length,
        brandsAdded: brandStats.addedByCategory[cat.id] || 0,
        liveTemplateCount: catTemplates.length,
        activeTemplateCount: catTemplates.filter((t) => t.isActive !== false).length,
        templatesAdded: tplStats.addedByCategory[cat.id] || 0,
        templatesSkippedExisting: tplStats.skippedByCategory[cat.id] || 0,
        liveStoreProductCount: catProducts.length,
        unconfirmedPackagingCount,
        unpricedTemplateCount,
        sampleBrands: catBrands
          .map((b) => b.name)
          .sort((a, b) => a.localeCompare(b))
          .slice(0, 8),
      };
    });

  return {
    auditedAtIso: new Date().toISOString(),
    totalLiveCategories: liveCats.length,
    canonicalCategoryCount: categorySummaries.filter((c) => c.isCanonical).length,
    customCategoryCount: categorySummaries.filter((c) => !c.isCanonical).length,
    totalLiveBrands: liveBrands.length,
    brandsAdded: brandStats.brandsAdded,
    brandsCategoryMerged: brandStats.brandsUpdated,
    totalLiveTemplates: liveTemplates.length,
    totalActiveTemplates: liveTemplates.filter((t) => t.isActive !== false).length,
    templatesAdded: tplStats.templatesAdded,
    templatesSkippedExisting: tplStats.templatesSkippedExisting,
    totalLiveStoreProducts: liveProducts.length,
    totalUnconfirmedPackaging: liveTemplates.filter((t) => Boolean(t.hasUnconfirmedPackaging)).length,
    totalUnpricedTemplates: liveTemplates.filter(
      (t) => !t.suggestedSalePrice || t.suggestedSalePrice <= 0
    ).length,
    categories: categorySummaries,
  };
}

export async function createProductTemplate(
  uid: string,
  input: ProductTemplateInput
): Promise<string> {
  const trimmedName = input.name.trim().replace(/\s+/g, ' ');
  if (!trimmedName) {
    throw new Error('Template product name is required.');
  }

  const candidateKey = normalizeTemplateKey(
    input.categoryId,
    input.brandId,
    trimmedName,
    input.variant
  );

  try {
    const snap = await getDocs(
      query(shopCol(uid, 'productTemplates'), where('ownerUid', '==', uid))
    );
    const duplicate = snap.docs.find((d) => {
      const data = d.data() as ProductTemplate;
      return (
        normalizeTemplateKey(data.categoryId, data.brandId, data.name, data.variant) ===
        candidateKey
      );
    });
    if (duplicate) {
      const dData = duplicate.data() as ProductTemplate;
      throw new Error(`Catalog template "${dData.name}" already exists for this variant.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/productTemplates`);
  }

  const ref = doc(shopCol(uid, 'productTemplates'));
  try {
    await setDoc(
      ref,
      buildProductTemplateWritePayload(uid, {
        ...input,
        name: trimmedName,
        isCustom: input.isCustom !== false,
      })
    );
    return ref.id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `shops/${uid}/productTemplates/${ref.id}`);
  }
}

export async function updateProductTemplate(
  uid: string,
  templateId: string,
  input: ProductTemplateInput
): Promise<void> {
  const trimmedName = input.name.trim().replace(/\s+/g, ' ');
  if (!trimmedName) {
    throw new Error('Template product name is required.');
  }

  const candidateKey = normalizeTemplateKey(
    input.categoryId,
    input.brandId,
    trimmedName,
    input.variant
  );

  try {
    const snap = await getDocs(
      query(shopCol(uid, 'productTemplates'), where('ownerUid', '==', uid))
    );
    const duplicate = snap.docs.find((d) => {
      if (d.id === templateId) return false;
      const data = d.data() as ProductTemplate;
      return (
        normalizeTemplateKey(data.categoryId, data.brandId, data.name, data.variant) ===
        candidateKey
      );
    });
    if (duplicate) {
      const dData = duplicate.data() as ProductTemplate;
      throw new Error(`Another catalog template named "${dData.name}" already exists for this variant.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/productTemplates`);
  }

  const ref = shopDoc(uid, 'productTemplates', templateId);
  try {
    await updateDoc(
      ref,
      buildProductTemplateWritePayload(uid, { ...input, name: trimmedName }, { isUpdate: true })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/productTemplates/${templateId}`);
  }
}

export async function toggleProductTemplateStatus(
  uid: string,
  templateId: string,
  isActive: boolean
): Promise<void> {
  const ref = shopDoc(uid, 'productTemplates', templateId);
  try {
    await updateDoc(ref, {
      isActive: Boolean(isActive),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/productTemplates/${templateId}`);
  }
}

export async function deleteProductTemplate(uid: string, templateId: string): Promise<void> {
  const ref = shopDoc(uid, 'productTemplates', templateId);
  try {
    await deleteDoc(ref);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `shops/${uid}/productTemplates/${templateId}`);
  }
}

// ------------------------------------------------------------------
// Sales Management (Atomic Transactions + Multi-Unit + FIFO COGS)
// ------------------------------------------------------------------
export interface SaleLineDraft {
  productId: string;
  unitName?: string;
  conversionFactor?: number;
  quantity: number;
  salePricePerUnit: number;
}

export async function createSale(
  uid: string,
  input: {
    saleDate: string;
    paymentMethod: PaymentMethod;
    customerWhatsapp?: string;
    notes: string;
    items: SaleLineDraft[];
  },
  options?: {
    allowStockOverride?: boolean;
    activeBatchIds?: string[];
    recordedBy?: {
      staffId?: string;
      staffName?: string;
    };
  }
): Promise<string> {
  if (!input.items.length) {
    throw new Error('Add at least one product to record a sale.');
  }

  const allowStockOverride = Boolean(options?.allowStockOverride);

  // Resolve exact authenticated Owner / Admin identity when a sale is saved
  const currentUser = auth.currentUser;
  let sellerId = clip(options?.recordedBy?.staffId || '', 128);
  let sellerName = clip(options?.recordedBy?.staffName || '', 120);

  if (!sellerId || !sellerName) {
    if (currentUser && currentUser.uid !== uid) {
      let resolvedName = '';
      let resolvedMemberId = '';
      try {
        const mapSnap = await getDoc(doc(db, 'adminAuthMap', currentUser.uid));
        const adminMemberId = mapSnap.exists() ? String(mapSnap.data()?.adminMemberId || '') : '';
        if (adminMemberId) {
          resolvedMemberId = adminMemberId;
          const memberSnap = await getDoc(shopDoc(uid, 'adminMembers', adminMemberId));
          if (memberSnap.exists()) {
            const mData = memberSnap.data() as { name?: string; username?: string };
            resolvedName = (mData.name || mData.username || '').trim();
          }
        }
      } catch {
        // Ignore lookup error and fall back to Auth profile
      }
      const fallbackAdminName =
        resolvedName ||
        currentUser.displayName?.trim() ||
        currentUser.email?.split('@')[0]?.trim() ||
        'Admin';
      sellerId = resolvedMemberId ? `admin:${resolvedMemberId}` : `admin_uid:${currentUser.uid}`;
      sellerName = clip(formatOwnerAdminLabel(fallbackAdminName), 120);
    } else {
      let ownerDisplayName = currentUser?.displayName?.trim() || '';
      if (!ownerDisplayName) {
        try {
          const settingsSnap = await getDoc(shopDoc(uid, 'settings', 'general'));
          if (settingsSnap.exists()) {
            const sData = settingsSnap.data() as { ownerName?: string };
            const configured = (sData.ownerName || '').trim();
            if (configured && configured.toLowerCase() !== 'shop owner') {
              ownerDisplayName = configured;
            }
          }
        } catch {
          // Ignore settings fallback lookup failure
        }
      }
      if (!ownerDisplayName) {
        ownerDisplayName = currentUser?.email?.split('@')[0]?.trim() || 'Primary Owner';
      }
      sellerId = OWNER_PRIMARY_ID;
      sellerName = clip(formatOwnerAdminLabel(ownerDisplayName), 120);
    }
  }

  // Merge duplicate (productId, unitName) rows while preserving separate unit lines (e.g. Pack + Piece)
  interface MergedSaleLine {
    key: string;
    productId: string;
    unitName: string;
    conversionFactor: number;
    unitQuantity: number;
    baseQuantity: number;
    salePricePerUnit: number;
  }
  const merged = new Map<string, MergedSaleLine>();
  const involvedProductIds = new Set<string>();

  for (const row of input.items) {
    const unitQty = roundStockQty(Number(row.quantity) || 0);
    const conv = roundStockQty(Number(row.conversionFactor) || 1);
    if (unitQty <= 0) throw new Error('Quantity must be greater than zero.');
    if (conv <= 0) throw new Error('Unit conversion factor must be greater than zero.');
    if (row.salePricePerUnit < 0) throw new Error('Selling price cannot be negative.');

    const cleanUnit = clip(row.unitName || '', 40);
    const key = `${row.productId}::${cleanUnit.toLowerCase() || '__base__'}`;
    involvedProductIds.add(row.productId);

    const existing = merged.get(key);
    if (existing) {
      existing.unitQuantity = roundStockQty(existing.unitQuantity + unitQty);
      existing.baseQuantity = roundStockQty(existing.unitQuantity * existing.conversionFactor);
      existing.salePricePerUnit = roundMoney(row.salePricePerUnit);
    } else {
      merged.set(key, {
        key,
        productId: row.productId,
        unitName: cleanUnit,
        conversionFactor: conv,
        unitQuantity: unitQty,
        baseQuantity: roundStockQty(unitQty * conv),
        salePricePerUnit: roundMoney(row.salePricePerUnit),
      });
    }
  }

  // Reuse caller's live activeBatchIds when available to avoid a full inventoryBatches scan per sale
  let candidateBatchIds: string[] = [];
  if (options?.activeBatchIds !== undefined) {
    candidateBatchIds = options.activeBatchIds;
  } else {
    try {
      const batchSnap = await getDocs(
        query(shopCol(uid, 'inventoryBatches'), where('ownerUid', '==', uid))
      );
      candidateBatchIds = batchSnap.docs
        .filter((d) => {
          const data = d.data() as InventoryBatch;
          return (
            involvedProductIds.has(data.productId) &&
            data.status === 'active' &&
            Number(data.remainingBaseQty) > 0
          );
        })
        .map((d) => d.id);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, `shops/${uid}/inventoryBatches`);
    }
  }

  const saleRef = doc(shopCol(uid, 'sales'));
  const saleNumber = generateTxnNumber('SL');
  const stopTx = startPerfTimer();

  try {
    let discordPayload: Parameters<typeof notifyDiscordTransaction>[1] | null = null;

    await runTransaction(db, async (tx) => {
      // Phase 1: ALL reads before ANY writes (parallelized via Promise.all)
      const involvedPids = Array.from(involvedProductIds);
      const [prodSnaps, batchSnaps] = await Promise.all([
        Promise.all(involvedPids.map((pid) => tx.get(shopDoc(uid, 'products', pid)))),
        Promise.all(candidateBatchIds.map((batchId) => tx.get(shopDoc(uid, 'inventoryBatches', batchId)))),
      ]);

      const productMap = new Map<string, Product>();
      for (let i = 0; i < involvedPids.length; i += 1) {
        const pid = involvedPids[i];
        const pSnap = prodSnaps[i];
        if (!pSnap.exists()) {
          throw new Error('Selected product no longer exists.');
        }
        productMap.set(pid, { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) });
      }

      const batchesByProduct = new Map<string, InventoryBatch[]>();
      for (const bSnap of batchSnaps) {
        if (!bSnap.exists()) continue;
        const bData = { id: bSnap.id, ...(bSnap.data() as Omit<InventoryBatch, 'id'>) };
        if (bData.status === 'active' && roundStockQty(bData.remainingBaseQty) > 0) {
          const arr = batchesByProduct.get(bData.productId) || [];
          arr.push(bData);
          batchesByProduct.set(bData.productId, arr);
        }
      }

      // Sum total base units requested per product across all unit lines
      const requestedBaseByProduct = new Map<string, number>();
      for (const line of merged.values()) {
        requestedBaseByProduct.set(
          line.productId,
          roundStockQty((requestedBaseByProduct.get(line.productId) || 0) + line.baseQuantity)
        );
      }

      for (const [pid, reqBase] of requestedBaseByProduct.entries()) {
        const product = productMap.get(pid)!;
        const baseUnit = getEffectiveBaseUnit(product);
        if (!allowStockOverride && product.currentStock < reqBase) {
          throw new Error(
            `Insufficient stock for "${product.name}". Available: ${product.currentStock} ${baseUnit}, Requested: ${reqBase} ${baseUnit}.`
          );
        }
      }

      // Phase 2: Calculate FIFO costs, prepare writes
      let totalAmount = 0;
      let totalCost = 0;
      let totalQuantity = 0;
      const discordItems: Array<{
        productName: string;
        quantity: number;
        unitPrice: number;
        lineTotal: number;
        unit: string;
      }> = [];

      const runningStock = new Map<string, number>();
      for (const [pid, prod] of productMap.entries()) {
        runningStock.set(pid, roundStockQty(prod.currentStock));
      }

      const batchMutations = new Map<string, { remainingBaseQty: number; status: 'active' | 'exhausted' }>();

      for (const line of merged.values()) {
        const product = productMap.get(line.productId)!;
        const baseUnit = getEffectiveBaseUnit(product);
        const unitLabel = line.unitName || baseUnit;
        const productBatches = batchesByProduct.get(line.productId) || [];

        const fifo = allocateFifoFromBatches(
          productBatches,
          line.baseQuantity,
          product.purchasePrice
        );
        for (const mut of fifo.updatedBatches) {
          batchMutations.set(mut.batchId, {
            remainingBaseQty: mut.nextRemainingBaseQty,
            status: mut.nextStatus,
          });
        }

        const lineTotal = roundMoney(line.unitQuantity * line.salePricePerUnit);
        const lineCost = fifo.totalCost;
        const lineProfit = roundMoney(lineTotal - lineCost);

        totalAmount = roundMoney(totalAmount + lineTotal);
        totalCost = roundMoney(totalCost + lineCost);
        totalQuantity = roundStockQty(totalQuantity + line.baseQuantity);

        discordItems.push({
          productName: clip(product.name, 180),
          quantity: line.unitQuantity,
          unitPrice: line.salePricePerUnit,
          lineTotal,
          unit:
            line.conversionFactor > 1
              ? clip(`${unitLabel} (${line.conversionFactor} ${baseUnit})`, 40)
              : clip(unitLabel, 40),
        });

        const prevStock = runningStock.get(line.productId) ?? product.currentStock;
        const nextStock = roundStockQty(Math.max(0, prevStock - line.baseQuantity));
        runningStock.set(line.productId, nextStock);

        const itemRef = doc(shopCol(uid, 'saleItems'));
        tx.set(itemRef, {
          ownerUid: uid,
          saleId: saleRef.id,
          saleDate: input.saleDate,
          productId: line.productId,
          productName: clip(product.name, 180),
          categoryId: clip(product.categoryId, 128),
          categoryName: clip(product.categoryName, 100),
          brandId: clip(product.brandId, 128),
          brandName: clip(product.brandName, 100),
          quantity: line.unitQuantity,
          unitName: clip(unitLabel, 40),
          unitQuantity: line.unitQuantity,
          conversionFactor: line.conversionFactor,
          baseQuantity: line.baseQuantity,
          salePricePerUnit: line.salePricePerUnit,
          purchasePriceAtSale: fifo.weightedBaseUnitCost,
          lineTotal,
          lineCost,
          lineProfit,
          batchAllocations: fifo.allocations.slice(0, 50),
          staffId: sellerId,
          staffName: sellerName,
          status: 'completed',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        const movRef = doc(shopCol(uid, 'stockMovements'));
        tx.set(movRef, {
          ownerUid: uid,
          productId: line.productId,
          productName: clip(product.name, 180),
          movementDate: input.saleDate,
          movementType: 'sale',
          quantityChange: -line.baseQuantity,
          previousStock: prevStock,
          newStock: nextStock,
          unitName: clip(unitLabel, 40),
          unitQuantity: line.unitQuantity,
          conversionFactor: line.conversionFactor,
          baseQuantity: line.baseQuantity,
          referenceId: saleRef.id,
          notes: clip(`Sale ${saleNumber} (${line.unitQuantity} ${unitLabel})`, 500),
          createdAt: serverTimestamp(),
        });
      }

      for (const [pid, nextStock] of runningStock.entries()) {
        tx.update(shopDoc(uid, 'products', pid), {
          currentStock: nextStock,
          updatedAt: serverTimestamp(),
        });
      }

      for (const [batchId, mut] of batchMutations.entries()) {
        tx.update(shopDoc(uid, 'inventoryBatches', batchId), {
          remainingBaseQty: mut.remainingBaseQty,
          status: mut.status,
          updatedAt: serverTimestamp(),
        });
      }

      const totalProfit = roundMoney(totalAmount - totalCost);
      const saleDateTime = formatDateTimeKarachi(new Date());
      const cleanWhatsapp = normalizeCustomerWhatsapp(input.customerWhatsapp);

      tx.set(saleRef, {
        ownerUid: uid,
        saleNumber,
        saleDate: input.saleDate,
        saleDateTime,
        paymentMethod: input.paymentMethod,
        totalAmount,
        totalCost,
        totalProfit,
        totalQuantity,
        itemCount: merged.size,
        staffId: sellerId,
        staffName: sellerName,
        recordedByRole: 'owner',
        ...(cleanWhatsapp ? { customerWhatsapp: clip(cleanWhatsapp, 32) } : {}),
        notes: clip(input.notes, 500),
        status: 'completed',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const logRef = doc(shopCol(uid, 'auditLogs'));
      tx.set(logRef, {
        ownerUid: uid,
        action: 'CREATE_SALE',
        entityType: 'sale',
        entityId: saleRef.id,
        summary: clip(
          `Recorded sale ${saleNumber} (${input.paymentMethod}) by ${sellerName}: PKR ${totalAmount} · Profit PKR ${totalProfit}`,
          400
        ),
        createdAt: serverTimestamp(),
      });

      discordPayload = {
        type: 'sale',
        dedupeId: saleRef.id,
        saleId: saleNumber,
        saleDate: input.saleDate,
        saleDateTime,
        staffName: sellerName,
        paymentMethod: input.paymentMethod,
        items: discordItems,
        totalAmount,
        totalProfit,
        notes: clip(input.notes, 500),
      };
    });

    if (discordPayload) {
      void notifyDiscordTransaction(uid, discordPayload);
    }

    recordPerfMetric('firebase_tx', 'create_sale', stopTx(), {
      items: merged.size,
      batches: candidateBatchIds.length,
    });

    enqueueSheetsBackgroundTask({
      dedupeId: saleRef.id,
      shopId: uid,
      entityType: 'sale',
      entityId: saleRef.id,
      action: 'CREATE_SALE',
      summary: `Sale ${saleNumber}`,
      targetSheets: [
        'Sales',
        'Sales Details',
        'Products',
        'Inventory',
        'Stock Movements',
        'Daily Summary',
        'Monthly Summary',
        'Staff Performance',
      ],
    });

    return saleRef.id;
  } catch (err) {
    if (err instanceof Error && (err.message.includes('Insufficient stock') || err.message.includes('Selected product'))) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `shops/${uid}/sales/${saleRef.id}`);
  }
}

export async function editSale(
  uid: string,
  sale: Sale,
  existingItems: SaleItem[],
  updated: {
    saleDate: string;
    paymentMethod: PaymentMethod;
    customerWhatsapp?: string;
    notes: string;
    items: SaleLineDraft[];
  },
  options?: {
    allowStockOverride?: boolean;
  }
): Promise<void> {
  if (sale.status === 'cancelled') {
    throw new Error('Cancelled sales cannot be edited.');
  }
  if (!updated.items.length) {
    throw new Error('A sale must contain at least one product.');
  }

  const allowStockOverride = Boolean(options?.allowStockOverride);

  interface MergedEditLine {
    key: string;
    productId: string;
    unitName: string;
    conversionFactor: number;
    unitQuantity: number;
    baseQuantity: number;
    salePricePerUnit: number;
  }
  const newMap = new Map<string, MergedEditLine>();
  const newProductIds = new Set<string>();

  for (const row of updated.items) {
    const unitQty = roundStockQty(Number(row.quantity) || 0);
    const conv = roundStockQty(Number(row.conversionFactor) || 1);
    if (unitQty <= 0) throw new Error('Quantity must be greater than zero.');
    if (conv <= 0) throw new Error('Unit conversion factor must be greater than zero.');
    if (row.salePricePerUnit < 0) throw new Error('Selling price cannot be negative.');
    const cleanUnit = clip(row.unitName || '', 40);
    const key = `${row.productId}::${cleanUnit.toLowerCase() || '__base__'}`;
    newProductIds.add(row.productId);

    const cur = newMap.get(key);
    if (cur) {
      cur.unitQuantity = roundStockQty(cur.unitQuantity + unitQty);
      cur.baseQuantity = roundStockQty(cur.unitQuantity * cur.conversionFactor);
      cur.salePricePerUnit = roundMoney(row.salePricePerUnit);
    } else {
      newMap.set(key, {
        key,
        productId: row.productId,
        unitName: cleanUnit,
        conversionFactor: conv,
        unitQuantity: unitQty,
        baseQuantity: roundStockQty(unitQty * conv),
        salePricePerUnit: roundMoney(row.salePricePerUnit),
      });
    }
  }

  // Group old items safely (supporting legacy single-row-per-product and new multi-unit keys)
  const oldItemsById = new Map<string, SaleItem>();
  const oldKeyMap = new Map<string, SaleItem>();
  const oldProductIds = new Set<string>();
  const referencedBatchIds = new Set<string>();

  for (const item of existingItems) {
    oldItemsById.set(item.id, item);
    oldProductIds.add(item.productId);
    const uKey = `${item.productId}::${(item.unitName || '').trim().toLowerCase() || '__base__'}`;
    if (!oldKeyMap.has(uKey)) {
      oldKeyMap.set(uKey, item);
    }
    if (Array.isArray(item.batchAllocations)) {
      for (const alloc of item.batchAllocations) {
        if (alloc?.batchId) referencedBatchIds.add(alloc.batchId);
      }
    }
  }

  const allProductIds = Array.from(new Set([...oldProductIds, ...newProductIds]));

  // Pre-query batches for involved products + referenced batch IDs
  let candidateBatchIds: string[] = [];
  try {
    const batchSnap = await getDocs(
      query(shopCol(uid, 'inventoryBatches'), where('ownerUid', '==', uid))
    );
    const allPidSet = new Set(allProductIds);
    candidateBatchIds = batchSnap.docs
      .filter((d) => {
        const b = d.data() as InventoryBatch;
        return (
          referencedBatchIds.has(d.id) ||
          (allPidSet.has(b.productId) && b.status !== 'cancelled')
        );
      })
      .map((d) => d.id);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/inventoryBatches`);
  }

  try {
    await runTransaction(db, async (tx) => {
      const saleRef = shopDoc(uid, 'sales', sale.id);
      const ssRef = shopDoc(uid, 'staffSales', sale.id);
      const [saleSnap, ssSnap, prodSnaps, batchSnaps] = await Promise.all([
        tx.get(saleRef),
        tx.get(ssRef),
        Promise.all(allProductIds.map((pid) => tx.get(shopDoc(uid, 'products', pid)))),
        Promise.all(candidateBatchIds.map((bId) => tx.get(shopDoc(uid, 'inventoryBatches', bId)))),
      ]);
      if (!saleSnap.exists() || saleSnap.data()?.status === 'cancelled') {
        throw new Error('Sale no longer active.');
      }

      const productMap = new Map<string, Product>();
      for (let i = 0; i < allProductIds.length; i += 1) {
        const pSnap = prodSnaps[i];
        if (pSnap.exists()) {
          productMap.set(allProductIds[i], { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) });
        }
      }

      const batchMap = new Map<string, InventoryBatch>();
      const batchesByProduct = new Map<string, InventoryBatch[]>();
      for (const bSnap of batchSnaps) {
        if (!bSnap.exists()) continue;
        const bData = { id: bSnap.id, ...(bSnap.data() as Omit<InventoryBatch, 'id'>) };
        if (bData.status === 'cancelled') continue;
        batchMap.set(bData.id, bData);
        const arr = batchesByProduct.get(bData.productId) || [];
        arr.push(bData);
        batchesByProduct.set(bData.productId, arr);
      }

      // Compute total old vs new base quantities per product
      const oldBaseByProduct = new Map<string, number>();
      for (const item of existingItems) {
        if (item.status === 'cancelled') continue;
        const baseQ = roundStockQty(item.baseQuantity ?? item.quantity * (item.conversionFactor || 1));
        oldBaseByProduct.set(item.productId, roundStockQty((oldBaseByProduct.get(item.productId) || 0) + baseQ));
      }

      const newBaseByProduct = new Map<string, number>();
      for (const line of newMap.values()) {
        newBaseByProduct.set(
          line.productId,
          roundStockQty((newBaseByProduct.get(line.productId) || 0) + line.baseQuantity)
        );
      }

      // Track original batch remaining qty to detect changes
      const originalBatchRemaining = new Map<string, { remainingBaseQty: number; status: InventoryBatch['status'] }>();
      for (const [bId, b] of batchMap.entries()) {
        originalBatchRemaining.set(bId, {
          remainingBaseQty: b.remainingBaseQty,
          status: b.status,
        });
      }

      // Restore batch allocations from active existing items in memory
      for (const item of existingItems) {
        if (item.status === 'cancelled' || !Array.isArray(item.batchAllocations)) continue;
        for (const alloc of item.batchAllocations) {
          const b = batchMap.get(alloc.batchId);
          if (!b) continue;
          const nextRem = roundStockQty(Math.min(b.initialBaseQty, b.remainingBaseQty + alloc.consumedBaseQty));
          b.remainingBaseQty = nextRem;
          b.status = nextRem > 0 ? 'active' : 'exhausted';
        }
      }

      // Validate and apply stock delta per product
      for (const pid of allProductIds) {
        const oldBase = oldBaseByProduct.get(pid) ?? 0;
        const newBase = newBaseByProduct.get(pid) ?? 0;
        const stockDelta = roundStockQty(oldBase - newBase);
        if (stockDelta !== 0) {
          const prod = productMap.get(pid);
          if (!prod) {
            if (stockDelta < 0) {
              throw new Error('Product not found to deduct additional stock.');
            }
            continue;
          }
          const rawNextStock = roundStockQty(prod.currentStock + stockDelta);
          if (!allowStockOverride && rawNextStock < 0) {
            throw new Error(
              `Insufficient stock for "${prod.name}". Available: ${prod.currentStock}, Extra needed: ${Math.abs(stockDelta)}.`
            );
          }
          const nextStock = Math.max(0, rawNextStock);
          tx.update(shopDoc(uid, 'products', pid), {
            currentStock: nextStock,
            updatedAt: serverTimestamp(),
          });

          const movRef = doc(shopCol(uid, 'stockMovements'));
          tx.set(movRef, {
            ownerUid: uid,
            productId: pid,
            productName: clip(prod.name, 180),
            movementDate: updated.saleDate,
            movementType: 'sale_edit',
            quantityChange: roundStockQty(nextStock - prod.currentStock),
            previousStock: prod.currentStock,
            newStock: nextStock,
            referenceId: sale.id,
            notes: clip(`Edited sale ${sale.saleNumber}`, 500),
            createdAt: serverTimestamp(),
          });
        }
      }

      // Match reusable existing saleItem docs cleanly
      const reusedItemIds = new Set<string>();
      const matchedOldItemForKey = new Map<string, SaleItem>();

      for (const [key, line] of newMap.entries()) {
        const direct = oldKeyMap.get(key);
        if (direct && !reusedItemIds.has(direct.id)) {
          matchedOldItemForKey.set(key, direct);
          reusedItemIds.add(direct.id);
        } else {
          // Fallback for legacy item missing unitName
          const fallback = existingItems.find(
            (i) => i.productId === line.productId && !reusedItemIds.has(i.id)
          );
          if (fallback) {
            matchedOldItemForKey.set(key, fallback);
            reusedItemIds.add(fallback.id);
          }
        }
      }

      // Delete any old items not reused
      for (const oldItem of oldItemsById.values()) {
        if (!reusedItemIds.has(oldItem.id)) {
          tx.delete(shopDoc(uid, 'saleItems', oldItem.id));
        }
      }

      let totalAmount = 0;
      let totalCost = 0;
      let totalQuantity = 0;

      for (const [key, line] of newMap.entries()) {
        const oldItem = matchedOldItemForKey.get(key);
        const prod = productMap.get(line.productId);
        const baseUnit = getEffectiveBaseUnit(prod);
        const unitLabel = line.unitName || oldItem?.unitName || baseUnit;
        const fallbackBaseCost = oldItem
          ? roundMoney(oldItem.purchasePriceAtSale)
          : roundMoney(prod?.purchasePrice ?? 0);

        let weightedBaseUnitCost = fallbackBaseCost;
        let lineCost = 0;
        let nextAllocations: BatchAllocation[] = [];

        const prodBatches = (batchesByProduct.get(line.productId) || []).filter(
          (b) => (b.purchaseDate || '') <= updated.saleDate || (oldItem?.batchAllocations || []).some((a) => a.batchId === b.id)
        );

        const oldHadBatches = Boolean(oldItem?.batchAllocations && oldItem.batchAllocations.length > 0);
        if (prodBatches.length > 0 && (oldHadBatches || !oldItem)) {
          const fifo = allocateFifoFromBatches(prodBatches, line.baseQuantity, fallbackBaseCost);
          weightedBaseUnitCost = fifo.weightedBaseUnitCost;
          lineCost = fifo.totalCost;
          nextAllocations = fifo.allocations.slice(0, 50);
        } else {
          // Legacy unbatched sale item: preserve historical purchasePriceAtSale per base unit
          weightedBaseUnitCost = fallbackBaseCost;
          lineCost = roundMoney(line.baseQuantity * weightedBaseUnitCost);
        }

        const lineTotal = roundMoney(line.unitQuantity * line.salePricePerUnit);
        const lineProfit = roundMoney(lineTotal - lineCost);

        totalAmount = roundMoney(totalAmount + lineTotal);
        totalCost = roundMoney(totalCost + lineCost);
        totalQuantity = roundStockQty(totalQuantity + line.baseQuantity);

        if (oldItem) {
          tx.update(shopDoc(uid, 'saleItems', oldItem.id), {
            saleDate: updated.saleDate,
            quantity: line.unitQuantity,
            unitName: clip(unitLabel, 40),
            unitQuantity: line.unitQuantity,
            conversionFactor: line.conversionFactor,
            baseQuantity: line.baseQuantity,
            salePricePerUnit: line.salePricePerUnit,
            purchasePriceAtSale: weightedBaseUnitCost,
            lineTotal,
            lineCost,
            lineProfit,
            batchAllocations: nextAllocations,
            updatedAt: serverTimestamp(),
          });
        } else if (prod) {
          const itemRef = doc(shopCol(uid, 'saleItems'));
          tx.set(itemRef, {
            ownerUid: uid,
            saleId: sale.id,
            saleDate: updated.saleDate,
            productId: line.productId,
            productName: clip(prod.name, 180),
            categoryId: clip(prod.categoryId, 128),
            categoryName: clip(prod.categoryName, 100),
            brandId: clip(prod.brandId, 128),
            brandName: clip(prod.brandName, 100),
            quantity: line.unitQuantity,
            unitName: clip(unitLabel, 40),
            unitQuantity: line.unitQuantity,
            conversionFactor: line.conversionFactor,
            baseQuantity: line.baseQuantity,
            salePricePerUnit: line.salePricePerUnit,
            purchasePriceAtSale: weightedBaseUnitCost,
            lineTotal,
            lineCost,
            lineProfit,
            batchAllocations: nextAllocations,
            ...(sale.staffId ? { staffId: sale.staffId } : {}),
            ...(sale.staffName ? { staffName: sale.staffName } : {}),
            status: 'completed',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }

      // Persist all modified inventory batches
      for (const [bId, b] of batchMap.entries()) {
        const orig = originalBatchRemaining.get(bId);
        if (!orig) continue;
        if (orig.remainingBaseQty !== b.remainingBaseQty || orig.status !== b.status) {
          tx.update(shopDoc(uid, 'inventoryBatches', bId), {
            remainingBaseQty: b.remainingBaseQty,
            status: b.status,
            updatedAt: serverTimestamp(),
          });
        }
      }

      const totalProfit = roundMoney(totalAmount - totalCost);
      const cleanWhatsapp = normalizeCustomerWhatsapp(updated.customerWhatsapp);
      const existingSaleWhatsapp = saleSnap.data()?.customerWhatsapp;
      const whatsappPatch = cleanWhatsapp
        ? { customerWhatsapp: clip(cleanWhatsapp, 32) }
        : existingSaleWhatsapp !== undefined
        ? { customerWhatsapp: deleteField() }
        : {};

      tx.update(saleRef, {
        saleDate: updated.saleDate,
        paymentMethod: updated.paymentMethod,
        totalAmount,
        totalCost,
        totalProfit,
        totalQuantity,
        itemCount: newMap.size,
        ...whatsappPatch,
        notes: clip(updated.notes, 500),
        updatedAt: serverTimestamp(),
      });

      if (ssSnap.exists()) {
        const staffLines = Array.from(newMap.values()).map((line) => {
          const oldItem = matchedOldItemForKey.get(line.key);
          const prod = productMap.get(line.productId);
          const baseUnit = getEffectiveBaseUnit(prod);
          const productName = prod?.name || oldItem?.productName || 'Product';
          return {
            productId: line.productId,
            productName: clip(productName, 180),
            quantity: line.unitQuantity,
            unitName: clip(line.unitName || oldItem?.unitName || baseUnit, 40),
            unitQuantity: line.unitQuantity,
            conversionFactor: line.conversionFactor,
            baseQuantity: line.baseQuantity,
            salePricePerUnit: line.salePricePerUnit,
            lineTotal: roundMoney(line.unitQuantity * line.salePricePerUnit),
          };
        });
        const existingSsWhatsapp = ssSnap.data()?.customerWhatsapp;
        const ssWhatsappPatch = cleanWhatsapp
          ? { customerWhatsapp: clip(cleanWhatsapp, 32) }
          : existingSsWhatsapp !== undefined
          ? { customerWhatsapp: deleteField() }
          : {};
        tx.update(ssRef, {
          saleDate: updated.saleDate,
          paymentMethod: updated.paymentMethod,
          totalAmount,
          totalQuantity,
          itemCount: staffLines.length,
          items: staffLines,
          ...ssWhatsappPatch,
          notes: clip(updated.notes, 500),
          updatedAt: serverTimestamp(),
        });
      }

      const logRef = doc(shopCol(uid, 'auditLogs'));
      tx.set(logRef, {
        ownerUid: uid,
        action: 'EDIT_SALE',
        entityType: 'sale',
        entityId: sale.id,
        summary: clip(`Edited sale ${sale.saleNumber}: New Total PKR ${totalAmount} · Profit PKR ${totalProfit}`, 400),
        createdAt: serverTimestamp(),
      });
    });

    enqueueSheetsBackgroundTask({
      dedupeId: `${sale.id}:edit:${Date.now()}`,
      shopId: uid,
      entityType: 'sale',
      entityId: sale.id,
      action: 'EDIT_SALE',
      summary: `Edited sale ${sale.saleNumber}`,
      targetSheets: [
        'Sales',
        'Sales Details',
        'Products',
        'Inventory',
        'Stock Movements',
        'Daily Summary',
        'Monthly Summary',
        'Staff Performance',
      ],
    });
  } catch (err) {
    if (err instanceof Error && (err.message.includes('Insufficient stock') || err.message.includes('Cancelled'))) {
      throw err;
    }
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/sales/${sale.id}`);
  }
}

export async function cancelSale(uid: string, sale: Sale, reason = 'Cancelled by owner'): Promise<void> {
  if (sale.status === 'cancelled') return;

  const itemsQuery = query(shopCol(uid, 'saleItems'), where('ownerUid', '==', uid));
  let items: SaleItem[] = [];
  try {
    const snap = await getDocs(itemsQuery);
    items = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<SaleItem, 'id'>) }))
      .filter((item) => item.saleId === sale.id);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/saleItems`);
  }

  const referencedBatchIds = new Set<string>();
  for (const item of items) {
    if (item.status !== 'cancelled' && Array.isArray(item.batchAllocations)) {
      for (const alloc of item.batchAllocations) {
        if (alloc?.batchId) referencedBatchIds.add(alloc.batchId);
      }
    }
  }

  const todayIso = getKarachiDateIso();

  try {
    await runTransaction(db, async (tx) => {
      const saleRef = shopDoc(uid, 'sales', sale.id);
      const ssRef = shopDoc(uid, 'staffSales', sale.id);
      const uniqueProdIds = Array.from(new Set(items.map((item) => item.productId)));
      const batchIdList = Array.from(referencedBatchIds);

      const [saleSnap, ssSnap, prodDocs, batchDocs] = await Promise.all([
        tx.get(saleRef),
        tx.get(ssRef),
        Promise.all(uniqueProdIds.map((pid) => tx.get(shopDoc(uid, 'products', pid)))),
        Promise.all(batchIdList.map((bId) => tx.get(shopDoc(uid, 'inventoryBatches', bId)))),
      ]);
      if (!saleSnap.exists() || saleSnap.data()?.status === 'cancelled') {
        throw new Error('Sale is already cancelled.');
      }

      const prodSnaps = new Map<string, Product>();
      for (let i = 0; i < uniqueProdIds.length; i += 1) {
        const pSnap = prodDocs[i];
        if (pSnap.exists()) {
          prodSnaps.set(uniqueProdIds[i], { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) });
        }
      }

      const batchSnaps = new Map<string, InventoryBatch>();
      for (const bSnap of batchDocs) {
        if (bSnap.exists()) {
          batchSnaps.set(bSnap.id, { id: bSnap.id, ...(bSnap.data() as Omit<InventoryBatch, 'id'>) });
        }
      }

      const runningStock = new Map<string, number>();
      for (const [pid, prod] of prodSnaps.entries()) {
        runningStock.set(pid, roundStockQty(prod.currentStock));
      }

      const batchRestoreAccum = new Map<string, number>();

      for (const item of items) {
        if (item.status !== 'cancelled') {
          tx.update(shopDoc(uid, 'saleItems', item.id), {
            status: 'cancelled',
            updatedAt: serverTimestamp(),
          });

          const restoreBase = roundStockQty(
            item.baseQuantity ?? item.quantity * (item.conversionFactor || 1)
          );
          const cur = runningStock.get(item.productId);
          if (cur !== undefined) {
            const next = roundStockQty(cur + restoreBase);
            runningStock.set(item.productId, next);
            const movRef = doc(shopCol(uid, 'stockMovements'));
            tx.set(movRef, {
              ownerUid: uid,
              productId: item.productId,
              productName: clip(item.productName, 180),
              movementDate: todayIso,
              movementType: 'sale_cancel',
              quantityChange: restoreBase,
              previousStock: cur,
              newStock: next,
              unitName: clip(item.unitName || '', 40),
              unitQuantity: item.unitQuantity ?? item.quantity,
              conversionFactor: item.conversionFactor ?? 1,
              baseQuantity: restoreBase,
              referenceId: sale.id,
              notes: clip(`Returned from cancelled sale ${sale.saleNumber}`, 500),
              createdAt: serverTimestamp(),
            });
          }

          if (Array.isArray(item.batchAllocations)) {
            for (const alloc of item.batchAllocations) {
              if (!alloc?.batchId || !alloc.consumedBaseQty) continue;
              batchRestoreAccum.set(
                alloc.batchId,
                roundStockQty((batchRestoreAccum.get(alloc.batchId) || 0) + alloc.consumedBaseQty)
              );
            }
          }
        }
      }

      for (const [bId, addQty] of batchRestoreAccum.entries()) {
        const batch = batchSnaps.get(bId);
        if (!batch || batch.status === 'cancelled') continue;
        const nextRem = roundStockQty(Math.min(batch.initialBaseQty, batch.remainingBaseQty + addQty));
        tx.update(shopDoc(uid, 'inventoryBatches', bId), {
          remainingBaseQty: nextRem,
          status: nextRem > 0 ? 'active' : 'exhausted',
          updatedAt: serverTimestamp(),
        });
      }

      for (const [pid, nextStock] of runningStock.entries()) {
        tx.update(shopDoc(uid, 'products', pid), {
          currentStock: nextStock,
          updatedAt: serverTimestamp(),
        });
      }

      const combinedNotes = sale.notes ? `${sale.notes} | Cancelled: ${reason}` : `Cancelled: ${reason}`;
      tx.update(saleRef, {
        status: 'cancelled',
        notes: clip(combinedNotes, 500),
        updatedAt: serverTimestamp(),
      });

      if (ssSnap.exists()) {
        tx.update(ssRef, {
          status: 'cancelled',
          notes: clip(combinedNotes, 500),
          updatedAt: serverTimestamp(),
        });
      }

      const logRef = doc(shopCol(uid, 'auditLogs'));
      tx.set(logRef, {
        ownerUid: uid,
        action: 'CANCEL_SALE',
        entityType: 'sale',
        entityId: sale.id,
        summary: clip(`Cancelled sale ${sale.saleNumber} (PKR ${sale.totalAmount}) and restored inventory`, 400),
        createdAt: serverTimestamp(),
      });
    });

    enqueueSheetsBackgroundTask({
      dedupeId: `${sale.id}:cancel`,
      shopId: uid,
      entityType: 'sale',
      entityId: sale.id,
      action: 'CANCEL_SALE',
      summary: `Cancelled sale ${sale.saleNumber}`,
      targetSheets: [
        'Sales',
        'Sales Details',
        'Products',
        'Inventory',
        'Stock Movements',
        'Daily Summary',
        'Monthly Summary',
        'Staff Performance',
      ],
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('already cancelled')) throw err;
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/sales/${sale.id}`);
  }
}

// ------------------------------------------------------------------
// Purchases & Supplier Balances (Multi-Unit + FIFO Batch Creation)
// ------------------------------------------------------------------
export interface PurchaseLineDraft {
  productId: string;
  unitName?: string;
  conversionFactor?: number;
  expiryDate?: string;
  quantity: number;
  purchasePricePerUnit: number;
}

export async function createPurchase(
  uid: string,
  input: {
    purchaseDate: string;
    supplierId: string;
    paymentMethod: PaymentMethod;
    amountPaid: number;
    notes: string;
    items: PurchaseLineDraft[];
  }
): Promise<string> {
  if (!input.supplierId) throw new Error('Please select a supplier.');
  if (!input.items.length) throw new Error('Please add at least one product.');

  interface MergedPurchaseLine {
    productId: string;
    unitName: string;
    conversionFactor: number;
    unitQuantity: number;
    baseQuantity: number;
    purchasePricePerUnit: number;
    expiryDate: string;
  }

  const merged = new Map<string, MergedPurchaseLine>();
  const involvedProductIds = new Set<string>();

  for (const row of input.items) {
    const unitQty = roundStockQty(Number(row.quantity) || 0);
    const conv = roundStockQty(Number(row.conversionFactor) || 1);
    if (unitQty <= 0) throw new Error('Quantity purchased must be greater than zero.');
    if (conv <= 0) throw new Error('Unit conversion factor must be greater than zero.');
    if (row.purchasePricePerUnit < 0) throw new Error('Purchase price cannot be negative.');

    const cleanUnit = clip(row.unitName || '', 40);
    const exp = clip(row.expiryDate || '', 20);
    const key = `${row.productId}::${cleanUnit.toLowerCase() || '__base__'}::${exp}`;
    involvedProductIds.add(row.productId);

    const cur = merged.get(key);
    if (cur) {
      cur.unitQuantity = roundStockQty(cur.unitQuantity + unitQty);
      cur.baseQuantity = roundStockQty(cur.unitQuantity * cur.conversionFactor);
      cur.purchasePricePerUnit = roundMoney(row.purchasePricePerUnit);
    } else {
      merged.set(key, {
        productId: row.productId,
        unitName: cleanUnit,
        conversionFactor: conv,
        unitQuantity: unitQty,
        baseQuantity: roundStockQty(unitQty * conv),
        purchasePricePerUnit: roundMoney(row.purchasePricePerUnit),
        expiryDate: exp,
      });
    }
  }

  const purchaseRef = doc(shopCol(uid, 'purchases'));
  const purchaseNumber = generateTxnNumber('PO');

  try {
    let discordPayload: Parameters<typeof notifyDiscordTransaction>[1] | null = null;

    await runTransaction(db, async (tx) => {
      const supRef = shopDoc(uid, 'suppliers', input.supplierId);
      const involvedPids = Array.from(involvedProductIds);
      const [supSnap, prodSnaps] = await Promise.all([
        tx.get(supRef),
        Promise.all(involvedPids.map((pid) => tx.get(shopDoc(uid, 'products', pid)))),
      ]);
      if (!supSnap.exists()) throw new Error('Selected supplier not found.');
      const supplier = { id: supSnap.id, ...(supSnap.data() as Omit<Supplier, 'id'>) };

      const productMap = new Map<string, Product>();
      for (let i = 0; i < involvedPids.length; i += 1) {
        const pSnap = prodSnaps[i];
        if (!pSnap.exists()) throw new Error('Selected product not found.');
        productMap.set(involvedPids[i], { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) });
      }

      let totalAmount = 0;
      let totalQuantity = 0;
      const discordItems: Array<{
        productName: string;
        quantity: number;
        unitPrice: number;
        lineTotal: number;
        unit: string;
      }> = [];

      const runningProductState = new Map<
        string,
        { currentStock: number; purchasePrice: number; salePrice: number }
      >();
      for (const [pid, prod] of productMap.entries()) {
        runningProductState.set(pid, {
          currentStock: roundStockQty(Math.max(0, prod.currentStock)),
          purchasePrice: Math.max(0, roundMoney(prod.purchasePrice)),
          salePrice: Math.max(0, roundMoney(prod.salePrice)),
        });
      }

      for (const line of merged.values()) {
        const product = productMap.get(line.productId)!;
        const baseUnit = getEffectiveBaseUnit(product);
        const unitLabel = line.unitName || baseUnit;
        const lineTotal = roundMoney(line.unitQuantity * line.purchasePricePerUnit);
        const unitCostInBase =
          line.baseQuantity > 0 ? roundMoney(lineTotal / line.baseQuantity) : 0;

        totalAmount = roundMoney(totalAmount + lineTotal);
        totalQuantity = roundStockQty(totalQuantity + line.baseQuantity);

        discordItems.push({
          productName: clip(product.name, 180),
          quantity: line.unitQuantity,
          unitPrice: line.purchasePricePerUnit,
          lineTotal,
          unit:
            line.conversionFactor > 1
              ? clip(`${unitLabel} (${line.conversionFactor} ${baseUnit})`, 40)
              : clip(unitLabel, 40),
        });

        const state = runningProductState.get(line.productId)!;
        const oldStock = state.currentStock;
        const newStock = roundStockQty(oldStock + line.baseQuantity);
        const weightedBaseCost =
          newStock > 0
            ? roundMoney((oldStock * state.purchasePrice + lineTotal) / newStock)
            : unitCostInBase;
        state.currentStock = newStock;
        state.purchasePrice = weightedBaseCost;

        const itemRef = doc(shopCol(uid, 'purchaseItems'));
        tx.set(itemRef, {
          ownerUid: uid,
          purchaseId: purchaseRef.id,
          purchaseDate: input.purchaseDate,
          supplierId: supplier.id,
          productId: line.productId,
          productName: clip(product.name, 180),
          quantity: line.unitQuantity,
          unitName: clip(unitLabel, 40),
          unitQuantity: line.unitQuantity,
          conversionFactor: line.conversionFactor,
          baseQuantity: line.baseQuantity,
          expiryDate: clip(line.expiryDate, 20),
          purchasePricePerUnit: line.purchasePricePerUnit,
          lineTotal,
          status: 'completed',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // Create dedicated FIFO Inventory Batch preserving exact cost & expiry of this lot
        const batchRef = doc(shopCol(uid, 'inventoryBatches'));
        tx.set(batchRef, {
          ownerUid: uid,
          productId: line.productId,
          productName: clip(product.name, 180),
          purchaseId: purchaseRef.id,
          purchaseNumber,
          purchaseDate: input.purchaseDate,
          supplierId: supplier.id,
          supplierName: clip(supplier.name, 150),
          initialBaseQty: line.baseQuantity,
          remainingBaseQty: line.baseQuantity,
          unitCostInBase,
          expiryDate: clip(line.expiryDate, 20),
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        const movRef = doc(shopCol(uid, 'stockMovements'));
        tx.set(movRef, {
          ownerUid: uid,
          productId: line.productId,
          productName: clip(product.name, 180),
          movementDate: input.purchaseDate,
          movementType: 'purchase',
          quantityChange: line.baseQuantity,
          previousStock: oldStock,
          newStock,
          unitName: clip(unitLabel, 40),
          unitQuantity: line.unitQuantity,
          conversionFactor: line.conversionFactor,
          baseQuantity: line.baseQuantity,
          referenceId: purchaseRef.id,
          notes: clip(
            `Purchase ${purchaseNumber} (${line.unitQuantity} ${unitLabel} = +${line.baseQuantity} ${baseUnit}) from ${supplier.name}`,
            500
          ),
          createdAt: serverTimestamp(),
        });
      }

      for (const [pid, state] of runningProductState.entries()) {
        const newMargin = calcProfitMarginPct(state.purchasePrice, state.salePrice);
        tx.update(shopDoc(uid, 'products', pid), {
          currentStock: state.currentStock,
          purchasePrice: state.purchasePrice,
          profitMarginPct: newMargin,
          updatedAt: serverTimestamp(),
        });
      }

      const amountPaid = Math.min(totalAmount, Math.max(0, roundMoney(input.amountPaid)));
      const balanceDue = Math.max(0, roundMoney(totalAmount - amountPaid));

      tx.set(purchaseRef, {
        ownerUid: uid,
        purchaseNumber,
        purchaseDate: input.purchaseDate,
        supplierId: supplier.id,
        supplierName: clip(supplier.name, 150),
        totalAmount,
        amountPaid,
        balanceDue,
        paymentMethod: input.paymentMethod,
        totalQuantity,
        itemCount: merged.size,
        notes: clip(input.notes, 500),
        status: 'completed',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.update(supRef, {
        totalPurchased: roundMoney((supplier.totalPurchased || 0) + totalAmount),
        totalPaid: roundMoney((supplier.totalPaid || 0) + amountPaid),
        outstandingBalance: roundMoney((supplier.outstandingBalance || 0) + balanceDue),
        updatedAt: serverTimestamp(),
      });

      const logRef = doc(shopCol(uid, 'auditLogs'));
      tx.set(logRef, {
        ownerUid: uid,
        action: 'CREATE_PURCHASE',
        entityType: 'purchase',
        entityId: purchaseRef.id,
        summary: clip(
          `Recorded purchase ${purchaseNumber} from ${supplier.name}: PKR ${totalAmount} (Paid: PKR ${amountPaid}, Due: PKR ${balanceDue})`,
          400
        ),
        createdAt: serverTimestamp(),
      });

      discordPayload = {
        type: 'purchase',
        dedupeId: purchaseRef.id,
        purchaseId: purchaseNumber,
        purchaseDate: input.purchaseDate,
        supplierName: clip(supplier.name, 150),
        paymentMethod: input.paymentMethod,
        items: discordItems,
        totalAmount,
        amountPaid,
        balanceDue,
        notes: clip(input.notes, 500),
      };
    });

    if (discordPayload) {
      void notifyDiscordTransaction(uid, discordPayload);
    }

    enqueueSheetsBackgroundTask({
      dedupeId: purchaseRef.id,
      shopId: uid,
      entityType: 'purchase',
      entityId: purchaseRef.id,
      action: 'CREATE_PURCHASE',
      summary: `Purchase ${purchaseNumber}`,
      targetSheets: [
        'Purchases',
        'Purchase Details',
        'Products',
        'Inventory',
        'Stock Movements',
        'Suppliers',
        'Daily Summary',
        'Monthly Summary',
      ],
    });

    return purchaseRef.id;
  } catch (err) {
    if (err instanceof Error && (err.message.includes('Selected') || err.message.includes('Please'))) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `shops/${uid}/purchases/${purchaseRef.id}`);
  }
}

export async function settlePurchaseBalance(
  uid: string,
  purchase: Purchase,
  paymentAmount: number,
  paymentMethod: PaymentMethod
): Promise<void> {
  if (purchase.status === 'cancelled') throw new Error('Cannot pay a cancelled purchase.');
  const pay = roundMoney(paymentAmount);
  if (pay <= 0 || pay > purchase.balanceDue) {
    throw new Error('Payment amount must be between 1 and the remaining balance due.');
  }

  try {
    await runTransaction(db, async (tx) => {
      const pRef = shopDoc(uid, 'purchases', purchase.id);
      const sRef = shopDoc(uid, 'suppliers', purchase.supplierId);
      const [pSnap, sSnap] = await Promise.all([tx.get(pRef), tx.get(sRef)]);
      if (!pSnap.exists()) throw new Error('Purchase not found.');

      const curP = pSnap.data() as Purchase;
      const newPaid = roundMoney(curP.amountPaid + pay);
      const newDue = Math.max(0, roundMoney(curP.totalAmount - newPaid));

      tx.update(pRef, {
        amountPaid: newPaid,
        balanceDue: newDue,
        paymentMethod,
        notes: clip(
          curP.notes ? `${curP.notes} | Paid PKR ${pay} (${paymentMethod})` : `Paid PKR ${pay} (${paymentMethod})`,
          500
        ),
        updatedAt: serverTimestamp(),
      });

      if (sSnap.exists()) {
        const sup = sSnap.data() as Supplier;
        tx.update(sRef, {
          totalPaid: roundMoney((sup.totalPaid || 0) + pay),
          outstandingBalance: Math.max(0, roundMoney((sup.outstandingBalance || 0) - pay)),
          updatedAt: serverTimestamp(),
        });
      }

      const logRef = doc(shopCol(uid, 'auditLogs'));
      tx.set(logRef, {
        ownerUid: uid,
        action: 'SETTLE_SUPPLIER_BALANCE',
        entityType: 'purchase',
        entityId: purchase.id,
        summary: clip(`Paid PKR ${pay} toward ${purchase.purchaseNumber} (${purchase.supplierName})`, 400),
        createdAt: serverTimestamp(),
      });
    });

    enqueueSheetsBackgroundTask({
      dedupeId: `${purchase.id}:settle:${Date.now()}`,
      shopId: uid,
      entityType: 'purchase',
      entityId: purchase.id,
      action: 'SETTLE_SUPPLIER_BALANCE',
      summary: `Settled balance for ${purchase.purchaseNumber}`,
      targetSheets: ['Purchases', 'Suppliers', 'Daily Summary', 'Monthly Summary'],
    });
  } catch (err) {
    if (err instanceof Error && (err.message.includes('Payment') || err.message.includes('cancelled'))) throw err;
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/purchases/${purchase.id}`);
  }
}

export async function cancelPurchase(uid: string, purchase: Purchase, reason = 'Cancelled by owner'): Promise<void> {
  if (purchase.status === 'cancelled') return;

  const itemsQuery = query(shopCol(uid, 'purchaseItems'), where('ownerUid', '==', uid));
  let items: PurchaseItem[] = [];
  let linkedBatchIds: string[] = [];
  try {
    const [itemsSnap, batchesSnap] = await Promise.all([
      getDocs(itemsQuery),
      getDocs(query(shopCol(uid, 'inventoryBatches'), where('ownerUid', '==', uid))),
    ]);
    items = itemsSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<PurchaseItem, 'id'>) }))
      .filter((item) => item.purchaseId === purchase.id);
    linkedBatchIds = batchesSnap.docs
      .filter((d) => (d.data() as InventoryBatch).purchaseId === purchase.id)
      .map((d) => d.id);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/purchaseItems`);
  }

  const todayIso = getKarachiDateIso();

  try {
    await runTransaction(db, async (tx) => {
      const pRef = shopDoc(uid, 'purchases', purchase.id);
      const supRef = shopDoc(uid, 'suppliers', purchase.supplierId);
      const uniqueProdIds = Array.from(new Set(items.map((item) => item.productId)));

      const [pSnap, supSnap, prodSnaps, batchSnaps] = await Promise.all([
        tx.get(pRef),
        tx.get(supRef),
        Promise.all(uniqueProdIds.map((pid) => tx.get(shopDoc(uid, 'products', pid)))),
        Promise.all(linkedBatchIds.map((bId) => tx.get(shopDoc(uid, 'inventoryBatches', bId)))),
      ]);
      if (!pSnap.exists() || pSnap.data()?.status === 'cancelled') {
        throw new Error('Purchase is already cancelled.');
      }

      const prodMap = new Map<string, Product>();
      for (let i = 0; i < uniqueProdIds.length; i += 1) {
        const prodSnap = prodSnaps[i];
        if (prodSnap.exists()) {
          prodMap.set(uniqueProdIds[i], { id: prodSnap.id, ...(prodSnap.data() as Omit<Product, 'id'>) });
        }
      }

      const batchDocs: InventoryBatch[] = [];
      for (const bSnap of batchSnaps) {
        if (bSnap.exists()) {
          const bData = { id: bSnap.id, ...(bSnap.data() as Omit<InventoryBatch, 'id'>) };
          if (bData.status !== 'cancelled') {
            if (roundStockQty(bData.remainingBaseQty) < roundStockQty(bData.initialBaseQty)) {
              throw new Error(
                `Cannot cancel purchase: some units from "${bData.productName}" (${purchase.purchaseNumber}) have already been sold or adjusted.`
              );
            }
            batchDocs.push(bData);
          }
        }
      }

      const runningStock = new Map<string, number>();
      for (const [pid, prod] of prodMap.entries()) {
        runningStock.set(pid, roundStockQty(prod.currentStock));
      }

      for (const item of items) {
        if (item.status === 'cancelled') continue;
        const baseQty = roundStockQty(item.baseQuantity ?? item.quantity * (item.conversionFactor || 1));
        const cur = runningStock.get(item.productId);
        if (cur !== undefined) {
          if (cur < baseQty) {
            throw new Error(
              `Cannot cancel purchase: "${item.productName}" only has ${cur} in stock (purchased ${baseQty}).`
            );
          }
          const next = roundStockQty(cur - baseQty);
          runningStock.set(item.productId, next);

          const movRef = doc(shopCol(uid, 'stockMovements'));
          tx.set(movRef, {
            ownerUid: uid,
            productId: item.productId,
            productName: clip(item.productName, 180),
            movementDate: todayIso,
            movementType: 'purchase_cancel',
            quantityChange: -baseQty,
            previousStock: cur,
            newStock: next,
            unitName: clip(item.unitName || '', 40),
            unitQuantity: item.unitQuantity ?? item.quantity,
            conversionFactor: item.conversionFactor ?? 1,
            baseQuantity: baseQty,
            referenceId: purchase.id,
            notes: clip(`Reversed from cancelled purchase ${purchase.purchaseNumber}`, 500),
            createdAt: serverTimestamp(),
          });
        }
        tx.update(shopDoc(uid, 'purchaseItems', item.id), {
          status: 'cancelled',
          updatedAt: serverTimestamp(),
        });
      }

      for (const batchDoc of batchDocs) {
        tx.update(shopDoc(uid, 'inventoryBatches', batchDoc.id), {
          remainingBaseQty: 0,
          status: 'cancelled',
          updatedAt: serverTimestamp(),
        });
      }

      for (const [pid, nextStock] of runningStock.entries()) {
        tx.update(shopDoc(uid, 'products', pid), {
          currentStock: nextStock,
          updatedAt: serverTimestamp(),
        });
      }

      if (supSnap.exists()) {
        const sup = supSnap.data() as Supplier;
        tx.update(supRef, {
          totalPurchased: Math.max(0, roundMoney((sup.totalPurchased || 0) - purchase.totalAmount)),
          totalPaid: Math.max(0, roundMoney((sup.totalPaid || 0) - purchase.amountPaid)),
          outstandingBalance: Math.max(0, roundMoney((sup.outstandingBalance || 0) - purchase.balanceDue)),
          updatedAt: serverTimestamp(),
        });
      }

      const notes = purchase.notes ? `${purchase.notes} | Cancelled: ${reason}` : `Cancelled: ${reason}`;
      tx.update(pRef, {
        status: 'cancelled',
        notes: clip(notes, 500),
        updatedAt: serverTimestamp(),
      });

      const logRef = doc(shopCol(uid, 'auditLogs'));
      tx.set(logRef, {
        ownerUid: uid,
        action: 'CANCEL_PURCHASE',
        entityType: 'purchase',
        entityId: purchase.id,
        summary: clip(`Cancelled purchase ${purchase.purchaseNumber} and reversed stock`, 400),
        createdAt: serverTimestamp(),
      });
    });

    enqueueSheetsBackgroundTask({
      dedupeId: `${purchase.id}:cancel`,
      shopId: uid,
      entityType: 'purchase',
      entityId: purchase.id,
      action: 'CANCEL_PURCHASE',
      summary: `Cancelled purchase ${purchase.purchaseNumber}`,
      targetSheets: [
        'Purchases',
        'Purchase Details',
        'Products',
        'Inventory',
        'Stock Movements',
        'Suppliers',
        'Daily Summary',
        'Monthly Summary',
      ],
    });
  } catch (err) {
    if (err instanceof Error && (err.message.includes('Cannot cancel') || err.message.includes('already cancelled'))) {
      throw err;
    }
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/purchases/${purchase.id}`);
  }
}

// ------------------------------------------------------------------
// Expense Management
// ------------------------------------------------------------------
export async function createExpense(
  uid: string,
  input: {
    title: string;
    categoryId: string;
    categoryName: string;
    amount: number;
    expenseDate: string;
    paymentMethod: PaymentMethod;
    notes: string;
  }
): Promise<string> {
  if (input.amount <= 0) throw new Error('Expense amount must be greater than zero.');
  const ref = doc(shopCol(uid, 'expenses'));
  try {
    const expenseAmount = roundMoney(input.amount);
    const expenseTitle = clip(input.title, 150);
    const expenseCategoryName = clip(input.categoryName, 100);
    const expenseNotes = clip(input.notes, 500);

    const batch = writeBatch(db);
    batch.set(ref, {
      ownerUid: uid,
      title: expenseTitle,
      categoryId: clip(input.categoryId, 128),
      categoryName: expenseCategoryName,
      amount: expenseAmount,
      expenseDate: input.expenseDate,
      paymentMethod: input.paymentMethod,
      notes: expenseNotes,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    const logRef = doc(shopCol(uid, 'auditLogs'));
    batch.set(logRef, {
      ownerUid: uid,
      action: 'CREATE_EXPENSE',
      entityType: 'expense',
      entityId: ref.id,
      summary: clip(`Recorded expense "${input.title}" (${input.categoryName}): PKR ${input.amount}`, 400),
      createdAt: serverTimestamp(),
    });
    await batch.commit();

    void notifyDiscordTransaction(uid, {
      type: 'expense',
      dedupeId: ref.id,
      expenseId: ref.id,
      expenseDate: input.expenseDate,
      title: expenseTitle,
      categoryName: expenseCategoryName,
      amount: expenseAmount,
      paymentMethod: input.paymentMethod,
      notes: expenseNotes,
    });

    enqueueSheetsBackgroundTask({
      dedupeId: ref.id,
      shopId: uid,
      entityType: 'expense',
      entityId: ref.id,
      action: 'CREATE_EXPENSE',
      summary: clip(`Expense "${expenseTitle}"`, 180),
      targetSheets: ['Expenses', 'Daily Summary', 'Monthly Summary'],
    });

    return ref.id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `shops/${uid}/expenses/${ref.id}`);
  }
}

export async function updateExpense(
  uid: string,
  expenseId: string,
  input: {
    title: string;
    categoryId: string;
    categoryName: string;
    amount: number;
    expenseDate: string;
    paymentMethod: PaymentMethod;
    notes: string;
  }
): Promise<void> {
  if (input.amount <= 0) throw new Error('Expense amount must be greater than zero.');
  const ref = shopDoc(uid, 'expenses', expenseId);
  try {
    const batch = writeBatch(db);
    batch.update(ref, {
      title: clip(input.title, 150),
      categoryId: clip(input.categoryId, 128),
      categoryName: clip(input.categoryName, 100),
      amount: roundMoney(input.amount),
      expenseDate: input.expenseDate,
      paymentMethod: input.paymentMethod,
      notes: clip(input.notes, 500),
      updatedAt: serverTimestamp(),
    });
    const logRef = doc(shopCol(uid, 'auditLogs'));
    batch.set(logRef, {
      ownerUid: uid,
      action: 'UPDATE_EXPENSE',
      entityType: 'expense',
      entityId: expenseId,
      summary: clip(`Updated expense "${input.title}": PKR ${input.amount}`, 400),
      createdAt: serverTimestamp(),
    });
    await batch.commit();
    enqueueSheetsBackgroundTask({
      dedupeId: `${expenseId}:update:${Date.now()}`,
      shopId: uid,
      entityType: 'expense',
      entityId: expenseId,
      action: 'UPDATE_EXPENSE',
      summary: clip(`Updated expense "${input.title}"`, 180),
      targetSheets: ['Expenses', 'Daily Summary', 'Monthly Summary'],
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/expenses/${expenseId}`);
  }
}

export async function deleteExpense(uid: string, expense: Expense): Promise<void> {
  const ref = shopDoc(uid, 'expenses', expense.id);
  try {
    const batch = writeBatch(db);
    batch.delete(ref);
    const logRef = doc(shopCol(uid, 'auditLogs'));
    batch.set(logRef, {
      ownerUid: uid,
      action: 'DELETE_EXPENSE',
      entityType: 'expense',
      entityId: expense.id,
      summary: clip(`Deleted expense "${expense.title}" (PKR ${expense.amount})`, 400),
      createdAt: serverTimestamp(),
    });
    await batch.commit();
    enqueueSheetsBackgroundTask({
      dedupeId: `${expense.id}:delete`,
      shopId: uid,
      entityType: 'expense',
      entityId: expense.id,
      action: 'DELETE_EXPENSE',
      summary: clip(`Deleted expense "${expense.title}"`, 180),
      targetSheets: ['Expenses', 'Daily Summary', 'Monthly Summary'],
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `shops/${uid}/expenses/${expense.id}`);
  }
}

// ------------------------------------------------------------------
// Stock Adjustments (Multi-Unit + FIFO Batch Reconciliation)
// ------------------------------------------------------------------
export async function createStockAdjustment(
  uid: string,
  input: {
    productId: string;
    quantity: number;
    unitName?: string;
    conversionFactor?: number;
    adjustmentDate: string;
    adjustmentType: AdjustmentType;
    reason: string;
    notes: string;
    emptyContainerDelta?: number;
  }
): Promise<string> {
  const unitQty = roundStockQty(Number(input.quantity) || 0);
  const conv = roundStockQty(Number(input.conversionFactor) || 1);
  if (unitQty <= 0) throw new Error('Adjustment quantity must be greater than zero.');
  if (conv <= 0) throw new Error('Unit conversion factor must be greater than zero.');

  const baseQuantity = roundStockQty(unitQty * conv);
  const adjRef = doc(shopCol(uid, 'stockAdjustments'));

  let activeBatchIds: string[] = [];
  if (input.adjustmentType !== 'add') {
    try {
      const snap = await getDocs(
        query(shopCol(uid, 'inventoryBatches'), where('ownerUid', '==', uid))
      );
      activeBatchIds = snap.docs
        .filter((d) => {
          const b = d.data() as InventoryBatch;
          return (
            b.productId === input.productId &&
            b.status === 'active' &&
            Number(b.remainingBaseQty) > 0
          );
        })
        .map((d) => d.id);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, `shops/${uid}/inventoryBatches`);
    }
  }

  try {
    await runTransaction(db, async (tx) => {
      const pRef = shopDoc(uid, 'products', input.productId);
      const [pSnap, batchSnaps] = await Promise.all([
        tx.get(pRef),
        Promise.all(activeBatchIds.map((bId) => tx.get(shopDoc(uid, 'inventoryBatches', bId)))),
      ]);
      if (!pSnap.exists()) throw new Error('Product not found.');
      const product = { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) };

      const batchDocs: InventoryBatch[] = [];
      for (const bSnap of batchSnaps) {
        if (bSnap.exists()) {
          batchDocs.push({ id: bSnap.id, ...(bSnap.data() as Omit<InventoryBatch, 'id'>) });
        }
      }

      const baseUnit = getEffectiveBaseUnit(product);
      const unitLabel = clip(input.unitName || baseUnit, 40) || baseUnit;
      const delta = input.adjustmentType === 'add' ? baseQuantity : -baseQuantity;
      const previousStock = roundStockQty(product.currentStock);
      const newStock = roundStockQty(previousStock + delta);

      if (newStock < 0) {
        throw new Error(
          `Cannot deduct ${unitQty} ${unitLabel} (${baseQuantity} ${baseUnit}) from "${product.name}" (current stock: ${previousStock} ${baseUnit}).`
        );
      }

      const productPatch: Record<string, unknown> = {
        currentStock: newStock,
        updatedAt: serverTimestamp(),
      };
      if (typeof input.emptyContainerDelta === 'number' && input.emptyContainerDelta !== 0) {
        const prevEmpty = roundStockQty(Math.max(0, Number(product.emptyContainersOnHand) || 0));
        productPatch.emptyContainersOnHand = roundStockQty(
          Math.max(0, prevEmpty + input.emptyContainerDelta)
        );
      }

      tx.update(pRef, productPatch);

      if (input.adjustmentType === 'add') {
        const batchRef = doc(shopCol(uid, 'inventoryBatches'));
        tx.set(batchRef, {
          ownerUid: uid,
          productId: product.id,
          productName: clip(product.name, 180),
          purchaseId: 'adj_add',
          purchaseNumber: 'ADJ-ADD',
          purchaseDate: input.adjustmentDate,
          supplierId: clip(product.supplierId, 128),
          supplierName: clip(product.supplierName || 'Stock Adjustment', 150),
          initialBaseQty: baseQuantity,
          remainingBaseQty: baseQuantity,
          unitCostInBase: Math.max(0, roundMoney(product.purchasePrice)),
          expiryDate: clip(product.expiryDate, 20),
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        const fifo = allocateFifoFromBatches(batchDocs, baseQuantity, product.purchasePrice);
        for (const mut of fifo.updatedBatches) {
          tx.update(shopDoc(uid, 'inventoryBatches', mut.batchId), {
            remainingBaseQty: mut.nextRemainingBaseQty,
            status: mut.nextStatus,
            updatedAt: serverTimestamp(),
          });
        }
      }

      tx.set(adjRef, {
        ownerUid: uid,
        productId: product.id,
        productName: clip(product.name, 180),
        adjustmentDate: input.adjustmentDate,
        adjustmentType: input.adjustmentType,
        quantity: unitQty,
        unitName: unitLabel,
        unitQuantity: unitQty,
        conversionFactor: conv,
        baseQuantity,
        reason: clip(input.reason, 200),
        notes: clip(input.notes, 500),
        previousStock,
        newStock,
        createdAt: serverTimestamp(),
      });

      const movRef = doc(shopCol(uid, 'stockMovements'));
      tx.set(movRef, {
        ownerUid: uid,
        productId: product.id,
        productName: clip(product.name, 180),
        movementDate: input.adjustmentDate,
        movementType: `adjustment_${input.adjustmentType}`,
        quantityChange: delta,
        previousStock,
        newStock,
        unitName: unitLabel,
        unitQuantity: unitQty,
        conversionFactor: conv,
        baseQuantity,
        referenceId: adjRef.id,
        notes: clip(`${input.adjustmentType.toUpperCase()} (${unitQty} ${unitLabel}): ${input.reason}`, 500),
        createdAt: serverTimestamp(),
      });

      const logRef = doc(shopCol(uid, 'auditLogs'));
      tx.set(logRef, {
        ownerUid: uid,
        action: 'STOCK_ADJUSTMENT',
        entityType: 'stockAdjustment',
        entityId: adjRef.id,
        summary: clip(
          `${input.adjustmentType.toUpperCase()} ${unitQty} ${unitLabel} (${baseQuantity} ${baseUnit}) on ${product.name} (${previousStock} -> ${newStock})`,
          400
        ),
        createdAt: serverTimestamp(),
      });
    });

    enqueueSheetsBackgroundTask({
      dedupeId: adjRef.id,
      shopId: uid,
      entityType: 'stock_adjustment',
      entityId: adjRef.id,
      action: 'STOCK_ADJUSTMENT',
      summary: clip(`Stock adjustment (${input.adjustmentType})`, 180),
      targetSheets: [
        'Stock Adjustments',
        'Stock Movements',
        'Products',
        'Inventory',
        'Daily Summary',
      ],
    });

    return adjRef.id;
  } catch (err) {
    if (err instanceof Error && (err.message.includes('Cannot deduct') || err.message.includes('not found'))) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `shops/${uid}/stockAdjustments/${adjRef.id}`);
  }
}

// ------------------------------------------------------------------
// Settings & Backups
// ------------------------------------------------------------------
export async function updateShopSettings(
  uid: string,
  input: Pick<ShopSettings, 'shopName' | 'ownerName' | 'phone' | 'address' | 'expiryAlertDays' | 'autoBackupEnabled'>
): Promise<void> {
  const ref = shopDoc(uid, 'settings', 'general');
  try {
    const batch = writeBatch(db);
    batch.update(ref, {
      shopName: clip(input.shopName, 150),
      ownerName: clip(input.ownerName, 120),
      phone: clip(input.phone, 40),
      address: clip(input.address, 300),
      expiryAlertDays: Math.min(365, Math.max(1, Number(input.expiryAlertDays) || 30)),
      autoBackupEnabled: Boolean(input.autoBackupEnabled),
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, 'shops', uid), {
      shopName: clip(input.shopName, 150),
      updatedAt: serverTimestamp(),
    });
    const logRef = doc(shopCol(uid, 'auditLogs'));
    batch.set(logRef, {
      ownerUid: uid,
      action: 'UPDATE_SETTINGS',
      entityType: 'settings',
      entityId: 'general',
      summary: clip(`Updated shop settings (${input.shopName})`, 400),
      createdAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/settings/general`);
  }
}

export async function recordBackupSnapshot(
  uid: string,
  backupType: 'automatic' | 'manual',
  recordCount: number,
  notes: string
): Promise<void> {
  const backupRef = doc(shopCol(uid, 'backups'));
  const settingsRef = shopDoc(uid, 'settings', 'general');
  const nowIso = getKarachiDateIso();

  try {
    const batch = writeBatch(db);
    batch.set(backupRef, {
      ownerUid: uid,
      backupType,
      recordCount,
      notes: clip(notes, 300),
      createdAt: serverTimestamp(),
    });
    batch.update(settingsRef, {
      lastBackupAt: nowIso,
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `shops/${uid}/backups/${backupRef.id}`);
  }
}

export async function recordOwnerLoginAudit(
  shopId: string,
  emailOrUsername: string,
  actorUid?: string
): Promise<void> {
  const logRef = doc(shopCol(shopId, 'auditLogs'));
  await setDoc(logRef, {
    ownerUid: shopId,
    action: 'OWNER_LOGIN',
    entityType: 'auth',
    entityId: clip(actorUid || shopId, 128),
    summary: clip(`Owner/Admin signed in (${emailOrUsername || 'Admin account'})`, 400),
    createdAt: serverTimestamp(),
  });
}

