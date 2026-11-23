import type { Timestamp } from 'firebase/firestore';
import type { Product } from '../types/shop';

export const SHOP_TIMEZONE = 'Asia/Karachi';

/**
 * Returns YYYY-MM-DD in Asia/Karachi timezone for reliable date comparisons and storage.
 */
export function getKarachiDateIso(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/**
 * Converts YYYY-MM-DD into DD-MM-YYYY for display across the entire app and reports.
 */
export function formatDateDDMMYYYY(isoDate: string): string {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return isoDate || '—';
  }
  const [y, m, d] = isoDate.split('-');
  return `${d}-${m}-${y}`;
}

/**
 * Formats a Firestore Timestamp or Date into DD-MM-YYYY HH:mm in Asia/Karachi.
 */
export function formatDateTimeKarachi(input?: Timestamp | Date | string | null): string {
  if (!input) return '—';
  let dateObj: Date;
  if (typeof input === 'string') {
    dateObj = new Date(input);
  } else if (input instanceof Date) {
    dateObj = input;
  } else if (typeof (input as Timestamp).toDate === 'function') {
    dateObj = (input as Timestamp).toDate();
  } else {
    return '—';
  }
  if (Number.isNaN(dateObj.getTime())) return '—';

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHOP_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(dateObj);

  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')}`;
}

/**
 * Adds or subtracts calendar days from a YYYY-MM-DD string.
 */
export function addDaysToIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Returns YYYY-MM month key from YYYY-MM-DD.
 */
export function getMonthKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/**
 * Returns previous YYYY-MM month key given YYYY-MM.
 */
export function getPreviousMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 2, 1));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}`;
}

export function formatMonthLabel(monthKey: string): string {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return monthKey;
  const [y, m] = monthKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dt);
}

/**
 * Formats numbers in Pakistani Rupees (PKR).
 */
export function formatPKR(amount: number, showDecimals = false): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const formatted = new Intl.NumberFormat('en-PK', {
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  }).format(Math.round(safe * 100) / 100);
  return `PKR ${formatted}`;
}

export function formatNumber(val: number): string {
  const safe = Number.isFinite(val) ? val : 0;
  return new Intl.NumberFormat('en-PK', {
    maximumFractionDigits: 2,
  }).format(safe);
}

/**
 * Profit Margin % = ((Sale Price - Purchase Price) / Sale Price) * 100
 */
export function calcProfitMarginPct(purchasePrice: number, salePrice: number): number {
  if (!Number.isFinite(salePrice) || salePrice <= 0) return 0;
  const margin = ((salePrice - purchasePrice) / salePrice) * 100;
  return Math.round(margin * 100) / 100;
}

export interface ProductStockStatus {
  isOutOfStock: boolean;
  isLowStock: boolean;
  isExpired: boolean;
  isNearingExpiry: boolean;
  daysUntilExpiry: number | null;
}

export function getProductStockStatus(
  product: Product,
  todayIso: string,
  expiryAlertDays = 30
): ProductStockStatus {
  const isOutOfStock = product.currentStock <= 0;
  const isLowStock = product.currentStock > 0 && product.currentStock <= product.minStockLevel;

  let isExpired = false;
  let isNearingExpiry = false;
  let daysUntilExpiry: number | null = null;

  if (product.expiryDate && /^\d{4}-\d{2}-\d{2}$/.test(product.expiryDate)) {
    const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
    const expMs = Date.parse(`${product.expiryDate}T00:00:00Z`);
    const diffDays = Math.round((expMs - todayMs) / (1000 * 60 * 60 * 24));
    daysUntilExpiry = diffDays;
    if (diffDays < 0) {
      isExpired = true;
    } else if (diffDays <= expiryAlertDays) {
      isNearingExpiry = true;
    }
  }

  return {
    isOutOfStock,
    isLowStock,
    isExpired,
    isNearingExpiry,
    daysUntilExpiry,
  };
}

export function roundMoney(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

export function csvSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function normalizeCustomerWhatsapp(raw?: string | null): string | undefined {
  const cleaned = (raw || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return undefined;
  return cleaned.slice(0, 30);
}

export function validateOptionalCustomerWhatsapp(raw?: string | null): string | null {
  const cleaned = normalizeCustomerWhatsapp(raw);
  if (!cleaned) return null;
  if (!/^\+?[\d(][\d\s\-().]{4,29}$/.test(cleaned)) {
    return 'Enter a valid WhatsApp/mobile number (e.g. +92 300 1234567 or 03001234567), or leave blank.';
  }
  const digitsOnly = cleaned.replace(/\D/g, '');
  if (digitsOnly.length < 7 || digitsOnly.length > 15) {
    return 'Phone number should contain between 7 and 15 digits, or leave blank.';
  }
  return null;
}

