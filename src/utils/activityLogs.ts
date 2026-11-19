import type { Timestamp } from 'firebase/firestore';
import type { AuditLog } from '../types/shop';
import { formatDateTimeKarachi, getKarachiDateIso } from './formatters';

export type ActivityCategory =
  | 'all'
  | 'sales'
  | 'inventory'
  | 'staff'
  | 'purchases'
  | 'expenses'
  | 'settings';

export interface ActivityActionMeta {
  category: Exclude<ActivityCategory, 'all'>;
  categoryLabel: string;
  actionLabel: string;
  toneClass: string;
}

const ACTION_META_MAP: Record<string, ActivityActionMeta> = {
  CREATE_SALE: {
    category: 'sales',
    categoryLabel: 'Sales',
    actionLabel: 'Sale Recorded',
    toneClass: 'text-emerald-700',
  },
  SYNC_STAFF_SALE: {
    category: 'sales',
    categoryLabel: 'Sales',
    actionLabel: 'Staff Sale Recorded',
    toneClass: 'text-teal-700',
  },
  EDIT_SALE: {
    category: 'sales',
    categoryLabel: 'Sales',
    actionLabel: 'Sale Edited',
    toneClass: 'text-amber-700',
  },
  CANCEL_SALE: {
    category: 'sales',
    categoryLabel: 'Sales',
    actionLabel: 'Sale Cancelled',
    toneClass: 'text-red-700',
  },
  STOCK_ADJUSTMENT: {
    category: 'inventory',
    categoryLabel: 'Inventory',
    actionLabel: 'Stock Adjusted',
    toneClass: 'text-amber-700',
  },
  CREATE_PRODUCT: {
    category: 'inventory',
    categoryLabel: 'Inventory',
    actionLabel: 'Product Added',
    toneClass: 'text-teal-700',
  },
  UPDATE_PRODUCT: {
    category: 'inventory',
    categoryLabel: 'Inventory',
    actionLabel: 'Product Updated',
    toneClass: 'text-slate-800',
  },
  DELETE_PRODUCT: {
    category: 'inventory',
    categoryLabel: 'Inventory',
    actionLabel: 'Product Deleted',
    toneClass: 'text-red-700',
  },
  STAFF_LOGIN: {
    category: 'staff',
    categoryLabel: 'Staff & Logins',
    actionLabel: 'Staff Login',
    toneClass: 'text-teal-700',
  },
  OWNER_LOGIN: {
    category: 'staff',
    categoryLabel: 'Staff & Logins',
    actionLabel: 'Owner Login',
    toneClass: 'text-slate-700',
  },
  CREATE_STAFF: {
    category: 'staff',
    categoryLabel: 'Staff & Logins',
    actionLabel: 'Staff Created',
    toneClass: 'text-emerald-700',
  },
  UPDATE_STAFF: {
    category: 'staff',
    categoryLabel: 'Staff & Logins',
    actionLabel: 'Staff Updated',
    toneClass: 'text-amber-700',
  },
  RESET_STAFF_PASSWORD: {
    category: 'staff',
    categoryLabel: 'Staff & Logins',
    actionLabel: 'Password Reset',
    toneClass: 'text-amber-700',
  },
  CREATE_PURCHASE: {
    category: 'purchases',
    categoryLabel: 'Purchases',
    actionLabel: 'Purchase Recorded',
    toneClass: 'text-teal-700',
  },
  SETTLE_SUPPLIER_BALANCE: {
    category: 'purchases',
    categoryLabel: 'Purchases',
    actionLabel: 'Supplier Payment',
    toneClass: 'text-emerald-700',
  },
  CANCEL_PURCHASE: {
    category: 'purchases',
    categoryLabel: 'Purchases',
    actionLabel: 'Purchase Cancelled',
    toneClass: 'text-red-700',
  },
  CREATE_EXPENSE: {
    category: 'expenses',
    categoryLabel: 'Expenses',
    actionLabel: 'Expense Added',
    toneClass: 'text-slate-800',
  },
  UPDATE_EXPENSE: {
    category: 'expenses',
    categoryLabel: 'Expenses',
    actionLabel: 'Expense Edited',
    toneClass: 'text-amber-700',
  },
  DELETE_EXPENSE: {
    category: 'expenses',
    categoryLabel: 'Expenses',
    actionLabel: 'Expense Deleted',
    toneClass: 'text-red-700',
  },
  UPDATE_SETTINGS: {
    category: 'settings',
    categoryLabel: 'Settings',
    actionLabel: 'Settings Updated',
    toneClass: 'text-slate-700',
  },
};

export function getActivityActionMeta(log: AuditLog): ActivityActionMeta {
  const exact = ACTION_META_MAP[log.action];
  if (exact) return exact;

  const action = (log.action || '').toUpperCase();
  const entity = (log.entityType || '').toLowerCase();

  if (action.includes('SALE') || entity === 'sale') {
    return {
      category: 'sales',
      categoryLabel: 'Sales',
      actionLabel: log.action.replace(/_/g, ' '),
      toneClass: 'text-slate-800',
    };
  }
  if (action.includes('STOCK') || action.includes('PRODUCT') || entity === 'product' || entity === 'stockadjustment') {
    return {
      category: 'inventory',
      categoryLabel: 'Inventory',
      actionLabel: log.action.replace(/_/g, ' '),
      toneClass: 'text-slate-800',
    };
  }
  if (action.includes('STAFF') || action.includes('LOGIN') || entity === 'staff' || entity === 'auth') {
    return {
      category: 'staff',
      categoryLabel: 'Staff & Logins',
      actionLabel: log.action.replace(/_/g, ' '),
      toneClass: 'text-slate-800',
    };
  }
  if (action.includes('PURCHASE') || action.includes('SUPPLIER') || entity === 'purchase') {
    return {
      category: 'purchases',
      categoryLabel: 'Purchases',
      actionLabel: log.action.replace(/_/g, ' '),
      toneClass: 'text-slate-800',
    };
  }
  if (action.includes('EXPENSE') || entity === 'expense') {
    return {
      category: 'expenses',
      categoryLabel: 'Expenses',
      actionLabel: log.action.replace(/_/g, ' '),
      toneClass: 'text-slate-800',
    };
  }

  return {
    category: 'settings',
    categoryLabel: 'Settings',
    actionLabel: log.action.replace(/_/g, ' ') || 'Activity',
    toneClass: 'text-slate-700',
  };
}

export function getAuditLogKarachiDateIso(ts?: Timestamp): string {
  if (!ts) return '';
  const dateObj = typeof ts.toDate === 'function' ? ts.toDate() : null;
  if (!dateObj || Number.isNaN(dateObj.getTime())) return '';
  return getKarachiDateIso(dateObj);
}

export function formatAuditTimestamp(ts?: Timestamp): string {
  return formatDateTimeKarachi(ts);
}
