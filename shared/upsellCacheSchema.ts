export const COOCCURRENCE_CACHE_VERSION = 2;
export const MAX_PROCESSED_SALE_IDS = 2000;
export const MAX_INDEXED_PRODUCTS = 1000;
export const MAX_NEIGHBORS_PER_PRODUCT = 40;

export interface CooccurrenceSaleInput {
  saleId: string;
  status?: string;
  productIds: string[];
}

export interface CooccurrenceSnapshot {
  version: number;
  shopId: string;
  revision: number;
  totalCompletedSales: number;
  saleCountsByProduct: Record<string, number>;
  pairCounts: Record<string, Record<string, number>>;
  processedSaleIds: string[];
  updatedAt: number;
}

export const UPSELL_FEEDBACK_VERSION = 1;
export const MAX_FEEDBACK_PRODUCTS = 500;
export const MAX_FEEDBACK_PAIR_KEYS = 400;

export type UpsellFeedbackEventType =
  | 'shown'
  | 'accepted'
  | 'dismissed'
  | 'removed_after_add';

export interface UpsellFeedbackCounters {
  shown: number;
  accepted: number;
  dismissed: number;
  removedAfterAdd: number;
  lastUpdatedAt: number;
}

export interface UpsellFeedbackEventInput {
  eventId?: string;
  productId: string;
  eventType: UpsellFeedbackEventType;
  categoryKey?: string;
  anchorCategoryKeys?: string[];
}

export interface UpsellFeedbackSnapshot {
  version: number;
  shopId: string;
  revision: number;
  productStats: Record<string, UpsellFeedbackCounters>;
  categoryPairStats: Record<string, UpsellFeedbackCounters>;
  updatedAt: number;
}

