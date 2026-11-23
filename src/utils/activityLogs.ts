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
    toneClass: 'text-[var(--cm-success)]',
  },
  SYNC_STAFF_SALE: {
    category: 'sales',
    categoryLabel: 'Sales',
    actionLabel: 'Staff Sale Recorded',
    toneClass: 'text-[var(--cm-accent-text)]',
  },
  EDIT_SALE: {
    category: 'sales',
    categoryLabel: 'Sales',
    actionLabel: 'Sale Edited',
    toneClass: 'text-[var(--cm-warning)]',
  },
  CANCEL_SALE: {
    category: 'sales',
    categoryLabel: 'Sales',
    actionLabel: 'Sale Cancelled',
    toneClass: 'text-[var(--cm-danger)]',
  },
  STOCK_ADJUSTMENT: {
    category: 'inventory',
    categoryLabel: 'Inventory',
    actionLabel: 'Stock Adjusted',
    toneClass: 'text-[var(--cm-warning)]',
  },
  CREATE_PRODUCT: {
    category: 'inventory',
    categoryLabel: 'Inventory',
    actionLabel: 'Product Added',
    toneClass: 'text-[var(--cm-accent-text)]',
  },
  UPDATE_PRODUCT: {
    category: 'inventory',
    categoryLabel: 'Inventory',
    actionLabel: 'Product Updated',
    toneClass: 'text-[var(--cm-text-primary)]',
  },
  DELETE_PRODUCT: {
    category: 'inventory',
    categoryLabel: 'Inventory',
    actionLabel: 'Product Deleted',
    toneClass: 'text-[var(--cm-danger)]',
  },
  STAFF_LOGIN: {
    category: 'staff',
    categoryLabel: 'Staff & Logins',
    actionLabel: 'Staff Login',
    toneClass: 'text-[var(--cm-accent-text)]',
  },
  OWNER_LOGIN: {
    category: 'staff',
    categoryLabel: 'Staff & Logins',
    actionLabel: 'Owner Login',
    toneClass: 'text-[var(--cm-text-secondary)]',
  },
  CREATE_STAFF: {
    category: 'staff',
    categoryLabel: 'Staff & Logins',
    actionLabel: 'Staff Created',
    toneClass: 'text-[var(--cm-success)]',
  },
  UPDATE_STAFF: {
    category: 'staff',
    categoryLabel: 'Staff & Logins',
    actionLabel: 'Staff Updated',
    toneClass: 'text-[var(--cm-warning)]',
  },
  RESET_STAFF_PASSWORD: {
    category: 'staff',
    categoryLabel: 'Staff & Logins',
    actionLabel: 'Password Reset',
    toneClass: 'text-[var(--cm-warning)]',
  },
  CREATE_PURCHASE: {
    category: 'purchases',
    categoryLabel: 'Purchases',
    actionLabel: 'Purchase Recorded',
    toneClass: 'text-[var(--cm-accent-text)]',
  },
  SETTLE_SUPPLIER_BALANCE: {
    category: 'purchases',
    categoryLabel: 'Purchases',
    actionLabel: 'Supplier Payment',
    toneClass: 'text-[var(--cm-success)]',
  },
  CANCEL_PURCHASE: {
    category: 'purchases',
    categoryLabel: 'Purchases',
    actionLabel: 'Purchase Cancelled',
    toneClass: 'text-[var(--cm-danger)]',
  },
  CREATE_EXPENSE: {
    category: 'expenses',
    categoryLabel: 'Expenses',
    actionLabel: 'Expense Added',
    toneClass: 'text-[var(--cm-text-primary)]',
  },
  UPDATE_EXPENSE: {
    category: 'expenses',
    categoryLabel: 'Expenses',
    actionLabel: 'Expense Edited',
    toneClass: 'text-[var(--cm-warning)]',
  },
  DELETE_EXPENSE: {
    category: 'expenses',
    categoryLabel: 'Expenses',
    actionLabel: 'Expense Deleted',
    toneClass: 'text-[var(--cm-danger)]',
  },
  UPDATE_SETTINGS: {
    category: 'settings',
    categoryLabel: 'Settings',
    actionLabel: 'Settings Updated',
    toneClass: 'text-[var(--cm-text-secondary)]',
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
      toneClass: 'text-[var(--cm-text-primary)]',
    };
  }
  if (action.includes('STOCK') || action.includes('PRODUCT') || entity === 'product' || entity === 'stockadjustment') {
    return {
      category: 'inventory',
      categoryLabel: 'Inventory',
      actionLabel: log.action.replace(/_/g, ' '),
      toneClass: 'text-[var(--cm-text-primary)]',
    };
  }
  if (action.includes('STAFF') || action.includes('LOGIN') || entity === 'staff' || entity === 'auth') {
    return {
      category: 'staff',
      categoryLabel: 'Staff & Logins',
      actionLabel: log.action.replace(/_/g, ' '),
      toneClass: 'text-[var(--cm-text-primary)]',
    };
  }
  if (action.includes('PURCHASE') || action.includes('SUPPLIER') || entity === 'purchase') {
    return {
      category: 'purchases',
      categoryLabel: 'Purchases',
      actionLabel: log.action.replace(/_/g, ' '),
      toneClass: 'text-[var(--cm-text-primary)]',
    };
  }
  if (action.includes('EXPENSE') || entity === 'expense') {
    return {
      category: 'expenses',
      categoryLabel: 'Expenses',
      actionLabel: log.action.replace(/_/g, ' '),
      toneClass: 'text-[var(--cm-text-primary)]',
    };
  }

  return {
    category: 'settings',
    categoryLabel: 'Settings',
    actionLabel: log.action.replace(/_/g, ' ') || 'Activity',
    toneClass: 'text-[var(--cm-text-secondary)]',
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
