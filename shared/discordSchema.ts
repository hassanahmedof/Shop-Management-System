import type { PaymentMethod } from '../src/types/shop.ts';

export interface DiscordNotificationItem {
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  unit?: string;
}

export interface DiscordSaleNotificationPayload {
  type: 'sale';
  dedupeId: string;
  saleId: string;
  saleDate: string;
  saleDateTime: string;
  staffName: string;
  paymentMethod: PaymentMethod;
  items: DiscordNotificationItem[];
  totalAmount: number;
  totalProfit?: number;
  notes?: string;
}

export interface DiscordPurchaseNotificationPayload {
  type: 'purchase';
  dedupeId: string;
  purchaseId: string;
  purchaseDate: string;
  supplierName: string;
  paymentMethod: PaymentMethod;
  items: DiscordNotificationItem[];
  totalAmount: number;
  amountPaid: number;
  balanceDue: number;
  notes?: string;
}

export interface DiscordExpenseNotificationPayload {
  type: 'expense';
  dedupeId: string;
  expenseId: string;
  expenseDate: string;
  title: string;
  categoryName: string;
  amount: number;
  paymentMethod: PaymentMethod;
  notes?: string;
}

export type DiscordTransactionNotificationPayload =
  | DiscordSaleNotificationPayload
  | DiscordPurchaseNotificationPayload
  | DiscordExpenseNotificationPayload;
