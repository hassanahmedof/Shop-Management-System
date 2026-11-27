import {
  collection,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from '../lib/firebase';
import type {
  InventoryBatch,
  Product,
  Sale,
  ShopSettings,
  StorefrontCatalogItem,
  StorefrontMeta,
  WebsiteOrder,
  WebsiteOrderStatus,
} from '../types/shop';
import {
  getKarachiDateIso,
  normalizeCustomerWhatsapp,
  roundMoney,
} from '../utils/formatters';
import {
  getEffectiveBaseUnit,
  roundStockQty,
  toStorefrontPackagingUnits,
} from '../utils/packaging';
import { WEBSITE_STOREFRONT_ID, WEBSITE_STOREFRONT_LABEL } from '../utils/sellerAttribution';
import { enqueueSheetsBackgroundTask } from './backgroundTaskQueue';
import { notifyDiscordTransaction } from './discordNotificationService';
import {
  fetchCandidateActiveBatchIds,
  fetchSaleItemsAndReferencedBatches,
  generateTxnNumber,
  normalizeAndMergeSaleLines,
  stageCancelSaleLedgerWrites,
  stageValidatedSaleLedgerWrites,
} from './shopService';
import {
  enqueueCooccurrenceMutationReconcile,
  enqueueSaleCooccurrenceUpdate,
} from './upsellCooccurrenceService';

function clip(val: string | undefined | null, maxLen: number): string {
  return (val || '').trim().slice(0, maxLen);
}

export function computePendingWebsiteReservedByProduct(
  orders: Array<Pick<WebsiteOrder, 'status' | 'items'>>
): Map<string, number> {
  const reserved = new Map<string, number>();
  for (const order of orders) {
    if (order.status !== 'Pending Confirmation') continue;
    for (const item of order.items || []) {
      if (!item?.productId) continue;
      const baseQty = roundStockQty(
        Math.max(
          0,
          Number(item.baseQuantity) ||
            (Number(item.quantity) || 0) * (Number(item.conversionFactor) || 1)
        )
      );
      if (baseQty <= 0) continue;
      reserved.set(item.productId, roundStockQty((reserved.get(item.productId) || 0) + baseQty));
    }
  }
  return reserved;
}

export function buildStorefrontMetaPayload(
  shopId: string,
  settings: Pick<ShopSettings, 'shopName' | 'phone' | 'address' | 'currency'>
): Omit<StorefrontMeta, 'id' | 'updatedAt'> {
  return {
    ownerUid: shopId,
    shopName: clip(settings.shopName || 'CareMart Shop', 150) || 'CareMart Shop',
    phone: clip(settings.phone, 40),
    address: clip(settings.address, 300),
    currency: 'PKR',
  };
}

export async function syncStorefrontMeta(
  shopId: string,
  settings: Pick<ShopSettings, 'shopName' | 'phone' | 'address' | 'currency'> | null
): Promise<void> {
  if (!settings) return;
  const metaRef = doc(db, 'shops', shopId, 'storefront', 'meta');
  const next = buildStorefrontMetaPayload(shopId, settings);
  try {
    const snap = await getDoc(metaRef);
    if (snap.exists()) {
      const cur = snap.data() as Partial<StorefrontMeta>;
      if (
        cur.ownerUid === next.ownerUid &&
        (cur.shopName || '') === next.shopName &&
        (cur.phone || '') === next.phone &&
        (cur.address || '') === next.address &&
        cur.currency === next.currency
      ) {
        return;
      }
    }
    await setDoc(metaRef, {
      ...next,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `shops/${shopId}/storefront/meta`);
  }
}

export function buildStorefrontCatalogPayload(
  shopId: string,
  product: Product,
  availableStock: number
): Omit<StorefrontCatalogItem, 'id' | 'updatedAt'> {
  const baseUnit = clip(getEffectiveBaseUnit(product), 40) || 'Piece';
  return {
    ownerUid: shopId,
    productId: product.id,
    name: clip(product.name, 180) || 'Product',
    category: clip(product.categoryName, 100),
    brand: clip(product.brandName, 100),
    salePrice: Math.max(0, roundMoney(product.salePrice)),
    currentStock: Math.max(0, roundStockQty(availableStock)),
    unit: baseUnit,
    baseUnit,
    packagingUnits: toStorefrontPackagingUnits(product.packagingUnits, baseUnit),
    image: clip(product.image, 500),
    isActive: Boolean(product.isActive),
  };
}

export async function syncStorefrontCatalogDocuments(
  shopId: string,
  products: Product[],
  websiteOrders: WebsiteOrder[],
  existingCatalog: StorefrontCatalogItem[]
): Promise<void> {
  const pendingReservedByProduct = computePendingWebsiteReservedByProduct(websiteOrders);
  const existingMap = new Map(existingCatalog.map((item) => [item.productId || item.id, item]));
  const productIds = new Set(products.map((p) => p.id));

  const ops: Array<(batch: ReturnType<typeof writeBatch>) => void> = [];

  for (const product of products) {
    const cur = existingMap.get(product.id);
    const pendingQty = pendingReservedByProduct.get(product.id) || 0;
    const availableStock = Math.max(0, roundStockQty((product.currentStock || 0) - pendingQty));
    const next = buildStorefrontCatalogPayload(shopId, product, availableStock);
    const nextPkgsJson = JSON.stringify(next.packagingUnits);
    const curPkgsJson = JSON.stringify(cur?.packagingUnits || []);

    const needsUpdate =
      !cur ||
      cur.ownerUid !== next.ownerUid ||
      cur.productId !== next.productId ||
      cur.name !== next.name ||
      (cur.category || '') !== next.category ||
      (cur.brand || '') !== next.brand ||
      cur.salePrice !== next.salePrice ||
      cur.currentStock !== next.currentStock ||
      cur.unit !== next.unit ||
      (cur.baseUnit || cur.unit) !== next.baseUnit ||
      curPkgsJson !== nextPkgsJson ||
      (cur.image || '') !== next.image ||
      Boolean(cur.isActive) !== next.isActive;

    if (needsUpdate) {
      ops.push((batch) => {
        batch.set(doc(db, 'shops', shopId, 'storefrontCatalog', product.id), {
          ...next,
          updatedAt: serverTimestamp(),
        });
      });
    }
  }

  for (const existingItem of existingCatalog) {
    const key = existingItem.productId || existingItem.id;
    if (!productIds.has(key)) {
      ops.push((batch) => {
        batch.delete(doc(db, 'shops', shopId, 'storefrontCatalog', existingItem.id));
      });
    }
  }

  if (ops.length === 0) return;

  for (let i = 0; i < ops.length; i += 400) {
    const chunk = ops.slice(i, i + 400);
    const batch = writeBatch(db);
    chunk.forEach((fn) => fn(batch));
    await batch.commit();
  }
}

export async function confirmWebsiteOrder(
  shopId: string,
  order: WebsiteOrder,
  options?: {
    allowStockOverride?: boolean;
    activeBatchIds?: string[];
    confirmedByUid?: string;
    confirmedByName?: string;
  }
): Promise<{ saleId: string; saleNumber: string }> {
  if (order.status !== 'Pending Confirmation') {
    throw new Error(`Order ${order.orderNumber} is already "${order.status}".`);
  }
  if (!order.items?.length) {
    throw new Error('Cannot confirm an order with no line items.');
  }

  const lineDrafts = order.items.map((item) => ({
    productId: item.productId,
    unitName: item.unitName,
    conversionFactor: item.conversionFactor,
    quantity: item.quantity,
    salePricePerUnit: item.unitPrice,
  }));

  const { merged, involvedProductIds } = normalizeAndMergeSaleLines(lineDrafts);
  const involvedPids = Array.from(involvedProductIds);
  const minimumTxWrites = 2 * merged.size + involvedPids.length + 3;
  if (minimumTxWrites > 500) {
    throw new Error(
      `Order ${order.orderNumber} requires at least ${minimumTxWrites} database writes, exceeding Firestore's 500-write atomic transaction limit.`
    );
  }

  const candidateBatchIds = await fetchCandidateActiveBatchIds(
    shopId,
    involvedPids,
    options?.activeBatchIds
  );

  const saleRef = doc(collection(db, 'shops', shopId, 'sales'));
  const saleNumber = generateTxnNumber('SL');
  const orderRef = doc(db, 'shops', shopId, 'websiteOrders', order.id);
  const saleDate = getKarachiDateIso();
  const allowStockOverride = Boolean(options?.allowStockOverride);

  const currentUser = auth.currentUser;
  const confirmedBy = clip(options?.confirmedByUid || currentUser?.uid || shopId, 128);
  const confirmedByName = clip(
    options?.confirmedByName || currentUser?.displayName || currentUser?.email?.split('@')[0] || 'Shop Owner',
    120
  );

  try {
    let discordPayload: Parameters<typeof notifyDiscordTransaction>[1] | null = null;

    await runTransaction(db, async (tx) => {
      // Phase 1: ALL reads before ANY writes
      const [orderSnap, prodSnaps, batchSnaps] = await Promise.all([
        tx.get(orderRef),
        Promise.all(involvedPids.map((pid) => tx.get(doc(db, 'shops', shopId, 'products', pid)))),
        Promise.all(candidateBatchIds.map((bid) => tx.get(doc(db, 'shops', shopId, 'inventoryBatches', bid)))),
      ]);

      if (!orderSnap.exists()) {
        throw new Error(`Website order ${order.orderNumber} no longer exists.`);
      }
      const liveOrder = { id: orderSnap.id, ...(orderSnap.data() as Omit<WebsiteOrder, 'id'>) };
      if (liveOrder.status !== 'Pending Confirmation') {
        throw new Error(`Order ${liveOrder.orderNumber} is already "${liveOrder.status}".`);
      }

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

      const notesParts = [
        `Website Order ${liveOrder.orderNumber}`,
        `${liveOrder.customerName} (${liveOrder.customerPhone})`,
        liveOrder.customerAddress,
      ];
      if ((liveOrder.deliveryFee || 0) > 0) {
        notesParts.push(`COD Delivery Fee: PKR ${liveOrder.deliveryFee}`);
      }
      if (liveOrder.customerNotes) {
        notesParts.push(`Customer Note: ${liveOrder.customerNotes}`);
      }
      const combinedNotes = clip(notesParts.join(' · '), 500);

      const staged = stageValidatedSaleLedgerWrites({
        tx,
        uid: shopId,
        saleRef,
        saleNumber,
        saleDate,
        paymentMethod: 'Cash',
        customerWhatsapp: normalizeCustomerWhatsapp(liveOrder.customerPhone),
        notes: combinedNotes,
        sellerId: WEBSITE_STOREFRONT_ID,
        sellerName: WEBSITE_STOREFRONT_LABEL,
        recordedByRole: 'website',
        allowStockOverride,
        merged,
        productMap,
        batchesByProduct,
        extraPlannedWrites: 1,
        auditAction: 'CONFIRM_WEBSITE_ORDER',
        auditSummary: `Confirmed website order ${liveOrder.orderNumber} -> Sale ${saleNumber} (${liveOrder.customerName}): PKR ${liveOrder.subtotal}`,
      });

      tx.update(orderRef, {
        status: 'Confirmed',
        linkedSaleId: saleRef.id,
        linkedSaleNumber: saleNumber,
        confirmedBy,
        confirmedByName,
        confirmedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      discordPayload = staged.discordPayload;
    });

    if (discordPayload) {
      void notifyDiscordTransaction(shopId, discordPayload);
    }

    enqueueSheetsBackgroundTask({
      dedupeId: saleRef.id,
      shopId,
      entityType: 'sale',
      entityId: saleRef.id,
      action: 'CREATE_SALE',
      summary: `Website order ${order.orderNumber} -> Sale ${saleNumber}`,
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

    enqueueSaleCooccurrenceUpdate(
      shopId,
      saleRef.id,
      involvedPids,
      () => (auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null)),
      { isOwner: true }
    );

    return { saleId: saleRef.id, saleNumber };
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('Insufficient stock') ||
        err.message.includes('Selected product') ||
        err.message.includes('already') ||
        err.message.includes('no longer exists') ||
        err.message.includes('500-write atomic transaction limit'))
    ) {
      throw err;
    }
    handleFirestoreError(err, OperationType.WRITE, `shops/${shopId}/websiteOrders/${order.id}`);
  }
}

export async function rejectWebsiteOrder(
  shopId: string,
  order: WebsiteOrder,
  reason = 'Cancelled by shop'
): Promise<void> {
  if (order.status !== 'Pending Confirmation') {
    throw new Error(`Only pending orders can be rejected without cancelling a sale (current: ${order.status}).`);
  }

  const orderRef = doc(db, 'shops', shopId, 'websiteOrders', order.id);
  const reservedByProduct = computePendingWebsiteReservedByProduct([order]);
  const productIds = Array.from(reservedByProduct.keys());
  const cleanReason = clip(reason || 'Cancelled by shop', 300) || 'Cancelled by shop';

  try {
    await runTransaction(db, async (tx) => {
      // Phase 1: ALL reads before ANY writes
      const [orderSnap, sfSnaps, prodSnaps] = await Promise.all([
        tx.get(orderRef),
        Promise.all(productIds.map((pid) => tx.get(doc(db, 'shops', shopId, 'storefrontCatalog', pid)))),
        Promise.all(productIds.map((pid) => tx.get(doc(db, 'shops', shopId, 'products', pid)))),
      ]);

      if (!orderSnap.exists()) {
        throw new Error(`Website order ${order.orderNumber} no longer exists.`);
      }
      const liveOrder = { id: orderSnap.id, ...(orderSnap.data() as Omit<WebsiteOrder, 'id'>) };
      if (liveOrder.status !== 'Pending Confirmation') {
        throw new Error(`Order ${liveOrder.orderNumber} is already "${liveOrder.status}".`);
      }

      const liveReserved = computePendingWebsiteReservedByProduct([liveOrder]);

      for (let i = 0; i < productIds.length; i += 1) {
        const pid = productIds[i];
        const sfSnap = sfSnaps[i];
        if (!sfSnap.exists()) continue;

        const addBack = liveReserved.get(pid) || 0;
        if (addBack <= 0) continue;

        const sfData = sfSnap.data() as Partial<StorefrontCatalogItem>;
        const currentSfStock = roundStockQty(Math.max(0, Number(sfData.currentStock) || 0));
        let restoredStock = roundStockQty(currentSfStock + addBack);

        const prodSnap = prodSnaps[i];
        if (prodSnap.exists()) {
          const prodData = prodSnap.data() as Partial<Product>;
          const realStock = roundStockQty(Math.max(0, Number(prodData.currentStock) || 0));
          restoredStock = Math.min(realStock, restoredStock);
        }

        tx.update(doc(db, 'shops', shopId, 'storefrontCatalog', pid), {
          currentStock: restoredStock,
          updatedAt: serverTimestamp(),
        });
      }

      tx.update(orderRef, {
        status: 'Cancelled/Rejected',
        rejectionReason: cleanReason,
        cancelledAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.set(doc(collection(db, 'shops', shopId, 'auditLogs')), {
        ownerUid: shopId,
        action: 'REJECT_WEBSITE_ORDER',
        entityType: 'websiteOrder',
        entityId: order.id,
        summary: clip(
          `Rejected website order ${liveOrder.orderNumber} (${liveOrder.customerName}): ${cleanReason}`,
          400
        ),
        createdAt: serverTimestamp(),
      });
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('already') ||
        err.message.includes('no longer exists') ||
        err.message.includes('Only pending'))
    ) {
      throw err;
    }
    handleFirestoreError(err, OperationType.UPDATE, `shops/${shopId}/websiteOrders/${order.id}`);
  }
}

export async function cancelConfirmedWebsiteOrder(
  shopId: string,
  order: WebsiteOrder,
  reason = 'Cancelled after confirmation'
): Promise<void> {
  if (order.status !== 'Confirmed' && order.status !== 'Out for Delivery') {
    throw new Error(`Order ${order.orderNumber} cannot be cancelled in "${order.status}" state.`);
  }
  const cleanReason = clip(reason || 'Cancelled after confirmation', 300) || 'Cancelled after confirmation';
  const orderRef = doc(db, 'shops', shopId, 'websiteOrders', order.id);
  const linkedSaleId = order.linkedSaleId;

  if (!linkedSaleId) {
    await rejectWebsiteOrderFallbackNoSale(shopId, order, cleanReason);
    return;
  }

  const { items, uniqueProdIds, referencedBatchIds } = await fetchSaleItemsAndReferencedBatches(
    shopId,
    linkedSaleId
  );
  const todayIso = getKarachiDateIso();

  try {
    await runTransaction(db, async (tx) => {
      const saleRef = doc(db, 'shops', shopId, 'sales', linkedSaleId);
      const [orderSnap, saleSnap, prodDocs, batchDocs] = await Promise.all([
        tx.get(orderRef),
        tx.get(saleRef),
        Promise.all(uniqueProdIds.map((pid) => tx.get(doc(db, 'shops', shopId, 'products', pid)))),
        Promise.all(referencedBatchIds.map((bid) => tx.get(doc(db, 'shops', shopId, 'inventoryBatches', bid)))),
      ]);

      if (!orderSnap.exists()) {
        throw new Error(`Website order ${order.orderNumber} no longer exists.`);
      }
      const liveOrder = { id: orderSnap.id, ...(orderSnap.data() as Omit<WebsiteOrder, 'id'>) };
      if (liveOrder.status !== 'Confirmed' && liveOrder.status !== 'Out for Delivery') {
        throw new Error(`Order ${liveOrder.orderNumber} is already "${liveOrder.status}".`);
      }

      if (saleSnap.exists() && saleSnap.data()?.status !== 'cancelled') {
        const saleData = saleSnap.data() as Omit<Sale, 'id'>;
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

        stageCancelSaleLedgerWrites({
          tx,
          uid: shopId,
          saleId: linkedSaleId,
          saleNumber: saleData.saleNumber || order.linkedSaleNumber || order.orderNumber,
          saleTotalAmount: saleData.totalAmount ?? order.subtotal,
          existingNotes: saleData.notes || '',
          reason: cleanReason,
          todayIso,
          items,
          saleRef,
          prodSnaps,
          batchSnaps,
          auditAction: 'CANCEL_WEBSITE_ORDER',
          auditSummary: `Cancelled website order ${liveOrder.orderNumber} and reversed sale ${saleData.saleNumber || linkedSaleId}: ${cleanReason}`,
        });
      }

      tx.update(orderRef, {
        status: 'Cancelled/Rejected',
        rejectionReason: cleanReason,
        cancelledAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });

    enqueueSheetsBackgroundTask({
      dedupeId: `${linkedSaleId}:cancel`,
      shopId,
      entityType: 'sale',
      entityId: linkedSaleId,
      action: 'CANCEL_SALE',
      summary: `Cancelled website order ${order.orderNumber}`,
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

    enqueueCooccurrenceMutationReconcile(shopId, linkedSaleId);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('already') || err.message.includes('no longer exists'))
    ) {
      throw err;
    }
    handleFirestoreError(err, OperationType.UPDATE, `shops/${shopId}/websiteOrders/${order.id}`);
  }
}

async function rejectWebsiteOrderFallbackNoSale(
  shopId: string,
  order: WebsiteOrder,
  cleanReason: string
): Promise<void> {
  const orderRef = doc(db, 'shops', shopId, 'websiteOrders', order.id);
  await runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) {
      throw new Error(`Website order ${order.orderNumber} no longer exists.`);
    }
    const live = orderSnap.data() as WebsiteOrder;
    if (live.status !== 'Confirmed' && live.status !== 'Out for Delivery') {
      throw new Error(`Order ${order.orderNumber} is already "${live.status}".`);
    }
    tx.update(orderRef, {
      status: 'Cancelled/Rejected',
      rejectionReason: cleanReason,
      cancelledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

export async function updateWebsiteOrderDeliveryStatus(
  shopId: string,
  order: WebsiteOrder,
  nextStatus: Extract<WebsiteOrderStatus, 'Out for Delivery' | 'Delivered'>
): Promise<void> {
  const orderRef = doc(db, 'shops', shopId, 'websiteOrders', order.id);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists()) {
        throw new Error(`Website order ${order.orderNumber} no longer exists.`);
      }
      const live = snap.data() as WebsiteOrder;
      const isValidTransition =
        (live.status === 'Confirmed' &&
          (nextStatus === 'Out for Delivery' || nextStatus === 'Delivered')) ||
        (live.status === 'Out for Delivery' && nextStatus === 'Delivered');

      if (!isValidTransition) {
        throw new Error(
          `Cannot move order ${order.orderNumber} from "${live.status}" to "${nextStatus}".`
        );
      }

      const patch: Record<string, unknown> = {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      };
      if (nextStatus === 'Out for Delivery') {
        patch.outForDeliveryAt = serverTimestamp();
      } else if (nextStatus === 'Delivered') {
        patch.deliveredAt = serverTimestamp();
      }

      tx.update(orderRef, patch);
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('Cannot move order') || err.message.includes('no longer exists'))
    ) {
      throw err;
    }
    handleFirestoreError(err, OperationType.UPDATE, `shops/${shopId}/websiteOrders/${order.id}`);
  }
}
