import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
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
import { notifyDiscordTransaction } from './discordNotificationService';
import type {
  AdjustmentType,
  Brand,
  Category,
  Expense,
  ExpenseCategory,
  PaymentMethod,
  Product,
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
  roundMoney,
} from '../utils/formatters';

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

const DEFAULT_CATEGORIES: Array<{ id: string; name: string; description: string }> = [
  { id: 'cat_diapers', name: 'Baby Diapers & Pampers', description: 'Disposable diapers, pull-ups, and newborn packs' },
  { id: 'cat_wipes', name: 'Baby Wipes', description: 'Sensitive, unscented, and fragrance baby wet wipes' },
  { id: 'cat_tissues', name: 'Facial & Toilet Tissues', description: 'Tissue boxes, pocket packs, toilet rolls, and kitchen towels' },
  { id: 'cat_baby_care', name: 'Baby Bath & Skincare', description: 'Baby lotions, shampoos, oils, powders, and rash creams' },
  { id: 'cat_personal_care', name: 'Personal Care & Toiletries', description: 'Soaps, body washes, shampoos, deodorants, and oral care' },
  { id: 'cat_hygiene', name: 'Hygiene & Sanitary', description: 'Sanitary pads, adult diapers, sanitizers, and cotton swabs' },
];

const DEFAULT_BRANDS: Array<{ id: string; name: string }> = [
  { id: 'brand_pampers', name: 'Pampers' },
  { id: 'brand_huggies', name: 'Huggies' },
  { id: 'brand_molfix', name: 'Molfix' },
  { id: 'brand_bonapapa', name: 'Bona Papa' },
  { id: 'brand_rosepetal', name: 'Rose Petal' },
  { id: 'brand_johnsons', name: "Johnson's" },
  { id: 'brand_lifebuoy', name: 'Lifebuoy' },
  { id: 'brand_dove', name: 'Dove' },
];

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

      for (const brand of DEFAULT_BRANDS) {
        batch.set(shopDoc(uid, 'brands', brand.id), {
          ownerUid: uid,
          name: brand.name,
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
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `shops/${uid}/settings/general`);
    }
  }
}

// ------------------------------------------------------------------
// Categories, Brands, Suppliers, Expense Categories
// ------------------------------------------------------------------
export async function createCategory(uid: string, name: string, description: string): Promise<string> {
  const ref = doc(shopCol(uid, 'categories'));
  try {
    await setDoc(ref, {
      ownerUid: uid,
      name: clip(name, 100),
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
  const ref = shopDoc(uid, 'categories', id);
  try {
    await updateDoc(ref, {
      name: clip(name, 100),
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

export async function createBrand(uid: string, name: string): Promise<string> {
  const ref = doc(shopCol(uid, 'brands'));
  try {
    await setDoc(ref, {
      ownerUid: uid,
      name: clip(name, 100),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `shops/${uid}/brands/${ref.id}`);
  }
}

export async function updateBrand(uid: string, id: string, name: string): Promise<void> {
  const ref = shopDoc(uid, 'brands', id);
  try {
    await updateDoc(ref, {
      name: clip(name, 100),
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
  supplierId: string;
  supplierName: string;
  expiryDate: string;
  isActive: boolean;
}

export async function createProduct(uid: string, input: ProductInput): Promise<string> {
  const prodRef = doc(shopCol(uid, 'products'));
  const profitMarginPct = calcProfitMarginPct(input.purchasePrice, input.salePrice);
  const initialStock = Math.max(0, Number(input.currentStock) || 0);
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
      purchasePrice: Math.max(0, roundMoney(input.purchasePrice)),
      salePrice: Math.max(0, roundMoney(input.salePrice)),
      wholesalePrice: Math.max(0, roundMoney(input.wholesalePrice)),
      currentStock: initialStock,
      minStockLevel: Math.max(0, Number(input.minStockLevel) || 0),
      maxStockLevel: Math.max(0, Number(input.maxStockLevel) || 0),
      unit: clip(input.unit || 'Pack', 40),
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
        referenceId: prodRef.id,
        notes: 'Initial opening stock on product creation',
        createdAt: serverTimestamp(),
      });
    }

    const logRef = doc(shopCol(uid, 'auditLogs'));
    batch.set(logRef, {
      ownerUid: uid,
      action: 'CREATE_PRODUCT',
      entityType: 'product',
      entityId: prodRef.id,
      summary: clip(`Added product ${input.name} (Stock: ${initialStock} ${input.unit})`, 400),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
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
  const profitMarginPct = calcProfitMarginPct(input.purchasePrice, input.salePrice);

  try {
    const batch = writeBatch(db);
    batch.update(prodRef, {
      name: clip(input.name, 180),
      categoryId: clip(input.categoryId, 128),
      categoryName: clip(input.categoryName, 100),
      brandId: clip(input.brandId, 128),
      brandName: clip(input.brandName, 100),
      purchasePrice: Math.max(0, roundMoney(input.purchasePrice)),
      salePrice: Math.max(0, roundMoney(input.salePrice)),
      wholesalePrice: Math.max(0, roundMoney(input.wholesalePrice)),
      minStockLevel: Math.max(0, Number(input.minStockLevel) || 0),
      maxStockLevel: Math.max(0, Number(input.maxStockLevel) || 0),
      unit: clip(input.unit || 'Pack', 40),
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
      summary: clip(`Updated product ${input.name} (Buy: ${input.purchasePrice}, Sell: ${input.salePrice})`, 400),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
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
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `shops/${uid}/products/${product.id}`);
  }
}

// ------------------------------------------------------------------
// Sales Management (Atomic Transactions + Historical COGS Snapshot)
// ------------------------------------------------------------------
export interface SaleLineDraft {
  productId: string;
  quantity: number;
  salePricePerUnit: number;
}

export async function createSale(
  uid: string,
  input: {
    saleDate: string;
    paymentMethod: PaymentMethod;
    notes: string;
    items: SaleLineDraft[];
  },
  options?: {
    allowStockOverride?: boolean;
  }
): Promise<string> {
  if (!input.items.length) {
    throw new Error('Add at least one product to record a sale.');
  }

  const allowStockOverride = Boolean(options?.allowStockOverride);

  // Merge duplicate product rows if any
  const merged = new Map<string, { quantity: number; salePricePerUnit: number }>();
  for (const row of input.items) {
    if (row.quantity <= 0) throw new Error('Quantity must be greater than zero.');
    if (row.salePricePerUnit < 0) throw new Error('Selling price cannot be negative.');
    const existing = merged.get(row.productId);
    if (existing) {
      existing.quantity += row.quantity;
      existing.salePricePerUnit = row.salePricePerUnit;
    } else {
      merged.set(row.productId, {
        quantity: row.quantity,
        salePricePerUnit: row.salePricePerUnit,
      });
    }
  }

  const saleRef = doc(shopCol(uid, 'sales'));
  const saleNumber = generateTxnNumber('SL');

  try {
    let discordPayload: Parameters<typeof notifyDiscordTransaction>[1] | null = null;

    await runTransaction(db, async (tx) => {
      const productEntries: Array<{
        productId: string;
        product: Product;
        qty: number;
        salePrice: number;
      }> = [];

      // All reads must come before writes in a Firestore transaction
      for (const [productId, line] of merged.entries()) {
        const pRef = shopDoc(uid, 'products', productId);
        const pSnap = await tx.get(pRef);
        if (!pSnap.exists()) {
          throw new Error('Selected product no longer exists.');
        }
        const product = { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) };
        if (!allowStockOverride && product.currentStock < line.quantity) {
          throw new Error(
            `Insufficient stock for "${product.name}". Available: ${product.currentStock} ${product.unit}, Requested: ${line.quantity}.`
          );
        }
        productEntries.push({
          productId,
          product,
          qty: line.quantity,
          salePrice: roundMoney(line.salePricePerUnit),
        });
      }

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

      for (const entry of productEntries) {
        const lineTotal = roundMoney(entry.qty * entry.salePrice);
        const purchasePriceAtSale = roundMoney(entry.product.purchasePrice);
        const lineCost = roundMoney(entry.qty * purchasePriceAtSale);
        const lineProfit = roundMoney(lineTotal - lineCost);

        totalAmount = roundMoney(totalAmount + lineTotal);
        totalCost = roundMoney(totalCost + lineCost);
        totalQuantity += entry.qty;

        discordItems.push({
          productName: clip(entry.product.name, 180),
          quantity: entry.qty,
          unitPrice: entry.salePrice,
          lineTotal,
          unit: clip(entry.product.unit || '', 40),
        });

        const prevStock = entry.product.currentStock;
        const newStock = Math.max(0, prevStock - entry.qty);

        tx.update(shopDoc(uid, 'products', entry.productId), {
          currentStock: newStock,
          updatedAt: serverTimestamp(),
        });

        const itemRef = doc(shopCol(uid, 'saleItems'));
        tx.set(itemRef, {
          ownerUid: uid,
          saleId: saleRef.id,
          saleDate: input.saleDate,
          productId: entry.productId,
          productName: clip(entry.product.name, 180),
          categoryId: clip(entry.product.categoryId, 128),
          categoryName: clip(entry.product.categoryName, 100),
          brandId: clip(entry.product.brandId, 128),
          brandName: clip(entry.product.brandName, 100),
          quantity: entry.qty,
          salePricePerUnit: entry.salePrice,
          purchasePriceAtSale,
          lineTotal,
          lineCost,
          lineProfit,
          staffId: 'owner',
          staffName: 'Owner',
          status: 'completed',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        const movRef = doc(shopCol(uid, 'stockMovements'));
        tx.set(movRef, {
          ownerUid: uid,
          productId: entry.productId,
          productName: clip(entry.product.name, 180),
          movementDate: input.saleDate,
          movementType: 'sale',
          quantityChange: -entry.qty,
          previousStock: prevStock,
          newStock,
          referenceId: saleRef.id,
          notes: clip(`Sale ${saleNumber}`, 500),
          createdAt: serverTimestamp(),
        });
      }

      const totalProfit = roundMoney(totalAmount - totalCost);
      const saleDateTime = formatDateTimeKarachi(new Date());

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
        itemCount: productEntries.length,
        staffId: 'owner',
        staffName: 'Owner',
        recordedByRole: 'owner',
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
          `Recorded sale ${saleNumber} (${input.paymentMethod}): PKR ${totalAmount} · Profit PKR ${totalProfit}`,
          400
        ),
        createdAt: serverTimestamp(),
      });

      const actorName = auth.currentUser?.displayName?.trim() || 'Owner';
      discordPayload = {
        type: 'sale',
        dedupeId: saleRef.id,
        saleId: saleNumber,
        saleDate: input.saleDate,
        saleDateTime,
        staffName: actorName,
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

  // Merge updated items by productId
  const newMap = new Map<string, { quantity: number; salePricePerUnit: number }>();
  for (const row of updated.items) {
    if (row.quantity <= 0) throw new Error('Quantity must be greater than zero.');
    if (row.salePricePerUnit < 0) throw new Error('Selling price cannot be negative.');
    const cur = newMap.get(row.productId);
    if (cur) {
      cur.quantity += row.quantity;
      cur.salePricePerUnit = row.salePricePerUnit;
    } else {
      newMap.set(row.productId, { quantity: row.quantity, salePricePerUnit: roundMoney(row.salePricePerUnit) });
    }
  }

  const oldMap = new Map<string, SaleItem>();
  for (const item of existingItems) {
    oldMap.set(item.productId, item);
  }

  const allProductIds = Array.from(new Set([...oldMap.keys(), ...newMap.keys()]));

  try {
    await runTransaction(db, async (tx) => {
      const saleRef = shopDoc(uid, 'sales', sale.id);
      const ssRef = shopDoc(uid, 'staffSales', sale.id);
      const saleSnap = await tx.get(saleRef);
      const ssSnap = await tx.get(ssRef);
      if (!saleSnap.exists() || saleSnap.data()?.status === 'cancelled') {
        throw new Error('Sale no longer active.');
      }

      const productMap = new Map<string, Product>();
      for (const pid of allProductIds) {
        const pSnap = await tx.get(shopDoc(uid, 'products', pid));
        if (pSnap.exists()) {
          productMap.set(pid, { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) });
        }
      }

      // Compute stock delta: delta = oldQty - newQty (positive returns stock, negative deducts more stock)
      for (const pid of allProductIds) {
        const oldQty = oldMap.get(pid)?.quantity ?? 0;
        const newQty = newMap.get(pid)?.quantity ?? 0;
        const stockDelta = oldQty - newQty;
        if (stockDelta !== 0) {
          const prod = productMap.get(pid);
          if (!prod) {
            if (stockDelta < 0) {
              throw new Error('Product not found to deduct additional stock.');
            }
            continue;
          }
          const rawNextStock = prod.currentStock + stockDelta;
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
            quantityChange: nextStock - prod.currentStock,
            previousStock: prod.currentStock,
            newStock: nextStock,
            referenceId: sale.id,
            notes: clip(`Edited sale ${sale.saleNumber}`, 500),
            createdAt: serverTimestamp(),
          });
        }
      }

      let totalAmount = 0;
      let totalCost = 0;
      let totalQuantity = 0;

      // Delete removed items
      for (const [pid, oldItem] of oldMap.entries()) {
        if (!newMap.has(pid)) {
          tx.delete(shopDoc(uid, 'saleItems', oldItem.id));
        }
      }

      // Update existing or create new items (preserving historical purchasePriceAtSale for existing items!)
      for (const [pid, line] of newMap.entries()) {
        const oldItem = oldMap.get(pid);
        const prod = productMap.get(pid);
        const historicalCost = oldItem
          ? oldItem.purchasePriceAtSale
          : roundMoney(prod?.purchasePrice ?? 0);

        const lineTotal = roundMoney(line.quantity * line.salePricePerUnit);
        const lineCost = roundMoney(line.quantity * historicalCost);
        const lineProfit = roundMoney(lineTotal - lineCost);

        totalAmount = roundMoney(totalAmount + lineTotal);
        totalCost = roundMoney(totalCost + lineCost);
        totalQuantity += line.quantity;

        if (oldItem) {
          tx.update(shopDoc(uid, 'saleItems', oldItem.id), {
            saleDate: updated.saleDate,
            quantity: line.quantity,
            salePricePerUnit: line.salePricePerUnit,
            lineTotal,
            lineCost,
            lineProfit,
            updatedAt: serverTimestamp(),
          });
        } else if (prod) {
          const itemRef = doc(shopCol(uid, 'saleItems'));
          tx.set(itemRef, {
            ownerUid: uid,
            saleId: sale.id,
            saleDate: updated.saleDate,
            productId: pid,
            productName: clip(prod.name, 180),
            categoryId: clip(prod.categoryId, 128),
            categoryName: clip(prod.categoryName, 100),
            brandId: clip(prod.brandId, 128),
            brandName: clip(prod.brandName, 100),
            quantity: line.quantity,
            salePricePerUnit: line.salePricePerUnit,
            purchasePriceAtSale: historicalCost,
            lineTotal,
            lineCost,
            lineProfit,
            status: 'completed',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      }

      const totalProfit = roundMoney(totalAmount - totalCost);

      tx.update(saleRef, {
        saleDate: updated.saleDate,
        paymentMethod: updated.paymentMethod,
        totalAmount,
        totalCost,
        totalProfit,
        totalQuantity,
        itemCount: newMap.size,
        notes: clip(updated.notes, 500),
        updatedAt: serverTimestamp(),
      });

      if (ssSnap.exists()) {
        const staffLines = Array.from(newMap.entries()).map(([pid, line]) => {
          const oldItem = oldMap.get(pid);
          const prod = productMap.get(pid);
          const productName = prod?.name || oldItem?.productName || 'Product';
          return {
            productId: pid,
            productName: clip(productName, 180),
            quantity: line.quantity,
            salePricePerUnit: line.salePricePerUnit,
            lineTotal: roundMoney(line.quantity * line.salePricePerUnit),
          };
        });
        tx.update(ssRef, {
          saleDate: updated.saleDate,
          paymentMethod: updated.paymentMethod,
          totalAmount,
          totalQuantity,
          itemCount: staffLines.length,
          items: staffLines,
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
  } catch (err) {
    if (err instanceof Error && (err.message.includes('Insufficient stock') || err.message.includes('Cancelled'))) {
      throw err;
    }
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/sales/${sale.id}`);
  }
}

export async function cancelSale(uid: string, sale: Sale, reason = 'Cancelled by owner'): Promise<void> {
  if (sale.status === 'cancelled') return;

  const itemsQuery = query(shopCol(uid, 'saleItems'), where('saleId', '==', sale.id));
  let items: SaleItem[] = [];
  try {
    const snap = await getDocs(itemsQuery);
    items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SaleItem, 'id'>) }));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/saleItems`);
  }

  const todayIso = getKarachiDateIso();

  try {
    await runTransaction(db, async (tx) => {
      const saleRef = shopDoc(uid, 'sales', sale.id);
      const ssRef = shopDoc(uid, 'staffSales', sale.id);
      const saleSnap = await tx.get(saleRef);
      const ssSnap = await tx.get(ssRef);
      if (!saleSnap.exists() || saleSnap.data()?.status === 'cancelled') {
        throw new Error('Sale is already cancelled.');
      }

      const prodSnaps = new Map<string, Product>();
      for (const item of items) {
        if (!prodSnaps.has(item.productId)) {
          const pSnap = await tx.get(shopDoc(uid, 'products', item.productId));
          if (pSnap.exists()) {
            prodSnaps.set(item.productId, { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) });
          }
        }
      }

      const runningStock = new Map<string, number>();
      for (const [pid, prod] of prodSnaps.entries()) {
        runningStock.set(pid, prod.currentStock);
      }

      for (const item of items) {
        if (item.status !== 'cancelled') {
          tx.update(shopDoc(uid, 'saleItems', item.id), {
            status: 'cancelled',
            updatedAt: serverTimestamp(),
          });
          const cur = runningStock.get(item.productId);
          if (cur !== undefined) {
            const next = cur + item.quantity;
            runningStock.set(item.productId, next);
            const movRef = doc(shopCol(uid, 'stockMovements'));
            tx.set(movRef, {
              ownerUid: uid,
              productId: item.productId,
              productName: clip(item.productName, 180),
              movementDate: todayIso,
              movementType: 'sale_cancel',
              quantityChange: item.quantity,
              previousStock: cur,
              newStock: next,
              referenceId: sale.id,
              notes: clip(`Returned from cancelled sale ${sale.saleNumber}`, 500),
              createdAt: serverTimestamp(),
            });
          }
        }
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
  } catch (err) {
    if (err instanceof Error && err.message.includes('already cancelled')) throw err;
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/sales/${sale.id}`);
  }
}

// ------------------------------------------------------------------
// Purchases & Supplier Balances
// ------------------------------------------------------------------
export interface PurchaseLineDraft {
  productId: string;
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

  const merged = new Map<string, { quantity: number; purchasePricePerUnit: number }>();
  for (const row of input.items) {
    if (row.quantity <= 0) throw new Error('Quantity purchased must be greater than zero.');
    if (row.purchasePricePerUnit < 0) throw new Error('Purchase price cannot be negative.');
    const cur = merged.get(row.productId);
    if (cur) {
      cur.quantity += row.quantity;
      cur.purchasePricePerUnit = row.purchasePricePerUnit;
    } else {
      merged.set(row.productId, {
        quantity: row.quantity,
        purchasePricePerUnit: roundMoney(row.purchasePricePerUnit),
      });
    }
  }

  const purchaseRef = doc(shopCol(uid, 'purchases'));
  const purchaseNumber = generateTxnNumber('PO');

  try {
    let discordPayload: Parameters<typeof notifyDiscordTransaction>[1] | null = null;

    await runTransaction(db, async (tx) => {
      const supRef = shopDoc(uid, 'suppliers', input.supplierId);
      const supSnap = await tx.get(supRef);
      if (!supSnap.exists()) throw new Error('Selected supplier not found.');
      const supplier = { id: supSnap.id, ...(supSnap.data() as Omit<Supplier, 'id'>) };

      const productEntries: Array<{
        productId: string;
        product: Product;
        qty: number;
        unitCost: number;
      }> = [];

      for (const [pid, line] of merged.entries()) {
        const pSnap = await tx.get(shopDoc(uid, 'products', pid));
        if (!pSnap.exists()) throw new Error('Selected product not found.');
        productEntries.push({
          productId: pid,
          product: { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) },
          qty: line.quantity,
          unitCost: line.purchasePricePerUnit,
        });
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

      for (const entry of productEntries) {
        const lineTotal = roundMoney(entry.qty * entry.unitCost);
        totalAmount = roundMoney(totalAmount + lineTotal);
        totalQuantity += entry.qty;

        discordItems.push({
          productName: clip(entry.product.name, 180),
          quantity: entry.qty,
          unitPrice: entry.unitCost,
          lineTotal,
          unit: clip(entry.product.unit || '', 40),
        });

        const oldStock = Math.max(0, entry.product.currentStock);
        const newStock = oldStock + entry.qty;
        // Weighted average purchase cost keeps inventory valuation accurate across price changes
        const weightedCost =
          newStock > 0
            ? roundMoney((oldStock * entry.product.purchasePrice + entry.qty * entry.unitCost) / newStock)
            : entry.unitCost;
        const newMargin = calcProfitMarginPct(weightedCost, entry.product.salePrice);

        tx.update(shopDoc(uid, 'products', entry.productId), {
          currentStock: newStock,
          purchasePrice: weightedCost,
          profitMarginPct: newMargin,
          updatedAt: serverTimestamp(),
        });

        const itemRef = doc(shopCol(uid, 'purchaseItems'));
        tx.set(itemRef, {
          ownerUid: uid,
          purchaseId: purchaseRef.id,
          purchaseDate: input.purchaseDate,
          supplierId: supplier.id,
          productId: entry.productId,
          productName: clip(entry.product.name, 180),
          quantity: entry.qty,
          purchasePricePerUnit: entry.unitCost,
          lineTotal,
          status: 'completed',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        const movRef = doc(shopCol(uid, 'stockMovements'));
        tx.set(movRef, {
          ownerUid: uid,
          productId: entry.productId,
          productName: clip(entry.product.name, 180),
          movementDate: input.purchaseDate,
          movementType: 'purchase',
          quantityChange: entry.qty,
          previousStock: oldStock,
          newStock,
          referenceId: purchaseRef.id,
          notes: clip(`Purchase ${purchaseNumber} from ${supplier.name}`, 500),
          createdAt: serverTimestamp(),
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
        itemCount: productEntries.length,
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
      const pSnap = await tx.get(pRef);
      const sSnap = await tx.get(sRef);
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
  } catch (err) {
    if (err instanceof Error && (err.message.includes('Payment') || err.message.includes('cancelled'))) throw err;
    handleFirestoreError(err, OperationType.UPDATE, `shops/${uid}/purchases/${purchase.id}`);
  }
}

export async function cancelPurchase(uid: string, purchase: Purchase, reason = 'Cancelled by owner'): Promise<void> {
  if (purchase.status === 'cancelled') return;

  const itemsQuery = query(shopCol(uid, 'purchaseItems'), where('purchaseId', '==', purchase.id));
  let items: PurchaseItem[] = [];
  try {
    const snap = await getDocs(itemsQuery);
    items = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PurchaseItem, 'id'>) }));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `shops/${uid}/purchaseItems`);
  }

  const todayIso = getKarachiDateIso();

  try {
    await runTransaction(db, async (tx) => {
      const pRef = shopDoc(uid, 'purchases', purchase.id);
      const supRef = shopDoc(uid, 'suppliers', purchase.supplierId);
      const pSnap = await tx.get(pRef);
      const supSnap = await tx.get(supRef);
      if (!pSnap.exists() || pSnap.data()?.status === 'cancelled') {
        throw new Error('Purchase is already cancelled.');
      }

      const prodMap = new Map<string, Product>();
      for (const item of items) {
        if (!prodMap.has(item.productId)) {
          const prodSnap = await tx.get(shopDoc(uid, 'products', item.productId));
          if (prodSnap.exists()) {
            prodMap.set(item.productId, { id: prodSnap.id, ...(prodSnap.data() as Omit<Product, 'id'>) });
          }
        }
      }

      const runningStock = new Map<string, number>();
      for (const [pid, prod] of prodMap.entries()) {
        runningStock.set(pid, prod.currentStock);
      }

      for (const item of items) {
        const cur = runningStock.get(item.productId);
        if (cur !== undefined) {
          if (cur < item.quantity) {
            throw new Error(
              `Cannot cancel purchase: "${item.productName}" only has ${cur} in stock (purchased ${item.quantity}).`
            );
          }
          const next = cur - item.quantity;
          runningStock.set(item.productId, next);

          const movRef = doc(shopCol(uid, 'stockMovements'));
          tx.set(movRef, {
            ownerUid: uid,
            productId: item.productId,
            productName: clip(item.productName, 180),
            movementDate: todayIso,
            movementType: 'purchase_cancel',
            quantityChange: -item.quantity,
            previousStock: cur,
            newStock: next,
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
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `shops/${uid}/expenses/${expense.id}`);
  }
}

// ------------------------------------------------------------------
// Stock Adjustments
// ------------------------------------------------------------------
export async function createStockAdjustment(
  uid: string,
  input: {
    productId: string;
    quantity: number;
    adjustmentDate: string;
    adjustmentType: AdjustmentType;
    reason: string;
    notes: string;
  }
): Promise<string> {
  if (input.quantity <= 0) throw new Error('Adjustment quantity must be greater than zero.');
  const adjRef = doc(shopCol(uid, 'stockAdjustments'));

  try {
    await runTransaction(db, async (tx) => {
      const pRef = shopDoc(uid, 'products', input.productId);
      const pSnap = await tx.get(pRef);
      if (!pSnap.exists()) throw new Error('Product not found.');
      const product = { id: pSnap.id, ...(pSnap.data() as Omit<Product, 'id'>) };

      const delta = input.adjustmentType === 'add' ? input.quantity : -input.quantity;
      const previousStock = product.currentStock;
      const newStock = previousStock + delta;

      if (newStock < 0) {
        throw new Error(
          `Cannot deduct ${input.quantity} ${product.unit} from "${product.name}" (current stock: ${previousStock}).`
        );
      }

      tx.update(pRef, {
        currentStock: newStock,
        updatedAt: serverTimestamp(),
      });

      tx.set(adjRef, {
        ownerUid: uid,
        productId: product.id,
        productName: clip(product.name, 180),
        adjustmentDate: input.adjustmentDate,
        adjustmentType: input.adjustmentType,
        quantity: input.quantity,
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
        referenceId: adjRef.id,
        notes: clip(`${input.adjustmentType.toUpperCase()}: ${input.reason}`, 500),
        createdAt: serverTimestamp(),
      });

      const logRef = doc(shopCol(uid, 'auditLogs'));
      tx.set(logRef, {
        ownerUid: uid,
        action: 'STOCK_ADJUSTMENT',
        entityType: 'stockAdjustment',
        entityId: adjRef.id,
        summary: clip(
          `${input.adjustmentType.toUpperCase()} ${input.quantity} ${product.unit} on ${product.name} (${previousStock} -> ${newStock})`,
          400
        ),
        createdAt: serverTimestamp(),
      });
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

