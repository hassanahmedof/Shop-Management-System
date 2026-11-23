import type { SearchableSelectOption } from '../components/SearchableSelect';
import type { AdminMember, Sale, ShopSettings, StaffMember } from '../types/shop';
import { roundMoney } from './formatters';
import { roundStockQty } from './packaging';

export const OWNER_PRIMARY_ID = 'owner_primary';
export const OWNER_UNASSIGNED_ID = 'owner_unassigned';
export const ALL_OWNERS_FILTER_ID = 'all_owners';
export const ALL_STAFF_FILTER_ID = 'all_staff';

export interface AuthUserSummary {
  uid: string;
  displayName?: string | null;
  email?: string | null;
}

export interface ResolvedSellerIdentity {
  staffId: string;
  staffName: string;
  adminName: string;
  role: 'owner';
}

export interface SellerPerformanceRow {
  sellerKey: string;
  sellerLabel: string;
  roleType: 'owner_admin' | 'unassigned' | 'staff';
  orders: number;
  unitsSold: number;
  revenue: number;
  cost: number;
  grossProfit: number;
  cashTotal: number;
  onlineTotal: number;
  avgBill: number;
}

function isGenericOwnerLabel(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return !lower || lower === 'owner' || lower === 'shop owner' || lower === 'admin' || lower === 'shop admin';
}

export function extractAdminNameFromLabel(label: string): string {
  const trimmed = label.trim();
  const stripped = trimmed.replace(/^owner\s*[–-]\s*/i, '').trim();
  return stripped || trimmed;
}

export function formatOwnerAdminLabel(name: string): string {
  const clean = name.trim();
  if (!clean || clean.toLowerCase() === 'owner') {
    return 'Owner – Unassigned';
  }
  if (/^owner\s*[–-]\s*/i.test(clean)) {
    const suffix = extractAdminNameFromLabel(clean);
    return suffix ? `Owner – ${suffix}` : 'Owner – Unassigned';
  }
  return `Owner – ${clean}`;
}

export function resolvePrimaryOwnerName(
  settings: ShopSettings | null,
  user?: AuthUserSummary | null,
  shopId?: string | null,
  sales?: Sale[]
): string {
  const settingsName = (settings?.ownerName || '').trim();
  if (settingsName && !isGenericOwnerLabel(settingsName)) {
    return settingsName;
  }

  if (user && (!shopId || user.uid === shopId)) {
    const authDisplay = (user.displayName || '').trim();
    if (authDisplay && !isGenericOwnerLabel(authDisplay)) {
      return authDisplay;
    }
  }

  if (sales && sales.length > 0) {
    const primarySale = sales.find(
      (s) => s.staffId === OWNER_PRIMARY_ID && Boolean(s.staffName?.trim())
    );
    if (primarySale?.staffName) {
      const extracted = extractAdminNameFromLabel(primarySale.staffName);
      if (extracted && !isGenericOwnerLabel(extracted)) {
        return extracted;
      }
    }
  }

  if (user && (!shopId || user.uid === shopId)) {
    const emailPrefix = (user.email?.split('@')[0] || '').trim();
    if (emailPrefix) {
      return emailPrefix;
    }
  }

  if (settingsName) {
    return settingsName;
  }

  return 'Primary Owner';
}

export function resolveCurrentAdminSeller(
  user: AuthUserSummary | null,
  shopId: string | null | undefined,
  adminMembers: AdminMember[],
  settings: ShopSettings | null,
  sales?: Sale[]
): ResolvedSellerIdentity {
  const matchedAdmin = user ? adminMembers.find((m) => m.authUid === user.uid) : undefined;
  if (matchedAdmin) {
    const adminName = (matchedAdmin.name || matchedAdmin.username || 'Admin').trim();
    return {
      staffId: `admin:${matchedAdmin.id}`,
      staffName: formatOwnerAdminLabel(adminName).slice(0, 120),
      adminName,
      role: 'owner',
    };
  }

  if (user && shopId && user.uid !== shopId) {
    const fallbackName =
      (user.displayName || '').trim() ||
      (user.email?.split('@')[0] || '').trim() ||
      'Admin';
    return {
      staffId: `admin_uid:${user.uid}`,
      staffName: formatOwnerAdminLabel(fallbackName).slice(0, 120),
      adminName: fallbackName,
      role: 'owner',
    };
  }

  const ownerName = resolvePrimaryOwnerName(settings, user, shopId, sales);
  return {
    staffId: OWNER_PRIMARY_ID,
    staffName: formatOwnerAdminLabel(ownerName).slice(0, 120),
    adminName: ownerName,
    role: 'owner',
  };
}

export function isStaffRecordedSale(
  sale: Pick<Sale, 'staffId' | 'recordedByRole'>
): boolean {
  if (sale.recordedByRole === 'staff') return true;
  if (sale.recordedByRole === 'owner') return false;
  const sid = (sale.staffId || '').trim();
  if (!sid || sid === 'owner' || sid === OWNER_PRIMARY_ID || sid === OWNER_UNASSIGNED_ID) {
    return false;
  }
  if (sid.startsWith('admin:') || sid.startsWith('admin_uid:')) {
    return false;
  }
  return true;
}

export function getSaleSellerKey(
  sale: Pick<Sale, 'staffId' | 'recordedByRole'>
): string {
  if (isStaffRecordedSale(sale)) {
    return (sale.staffId || '').trim() || 'staff';
  }
  const sid = (sale.staffId || '').trim();
  if (sid === OWNER_PRIMARY_ID || sid.startsWith('admin:') || sid.startsWith('admin_uid:')) {
    return sid;
  }
  return OWNER_UNASSIGNED_ID;
}

export function formatSaleSellerLabel(
  sale: Pick<Sale, 'staffId' | 'staffName' | 'recordedByRole'>
): string {
  if (isStaffRecordedSale(sale)) {
    return (sale.staffName || '').trim() || 'Sales Staff';
  }
  const raw = (sale.staffName || '').trim();
  if (!raw || raw.toLowerCase() === 'owner') {
    return 'Owner – Unassigned';
  }
  return formatOwnerAdminLabel(raw);
}

export function matchesSellerFilter(
  sale: Pick<Sale, 'staffId' | 'recordedByRole'>,
  filterValue: string
): boolean {
  if (!filterValue || filterValue === 'all') return true;
  if (filterValue === ALL_OWNERS_FILTER_ID || filterValue === 'owner') {
    return !isStaffRecordedSale(sale);
  }
  if (filterValue === ALL_STAFF_FILTER_ID) {
    return isStaffRecordedSale(sale);
  }
  return getSaleSellerKey(sale) === filterValue;
}

export function buildSellerFilterOptions(params: {
  sales: Sale[];
  staffMembers: StaffMember[];
  adminMembers: AdminMember[];
  settings: ShopSettings | null;
  user?: AuthUserSummary | null;
  shopId?: string | null;
  includeAllOwnersOption?: boolean;
}): SearchableSelectOption[] {
  const {
    sales,
    staffMembers,
    adminMembers,
    settings,
    user,
    shopId,
    includeAllOwnersOption = true,
  } = params;

  const options: SearchableSelectOption[] = [];
  const seenKeys = new Set<string>();

  if (includeAllOwnersOption) {
    options.push({
      value: ALL_OWNERS_FILTER_ID,
      label: 'Owner (All Admins)',
      subtitle: 'All owner & admin recorded sales',
      keywords: ['owner', 'admin', 'all admins'],
    });
  }

  const primaryOwnerName = resolvePrimaryOwnerName(settings, user, shopId, sales);
  options.push({
    value: OWNER_PRIMARY_ID,
    label: formatOwnerAdminLabel(primaryOwnerName),
    subtitle: 'Primary Owner account',
    keywords: ['owner', 'primary', primaryOwnerName],
  });
  seenKeys.add(OWNER_PRIMARY_ID);

  for (const admin of adminMembers) {
    const key = `admin:${admin.id}`;
    const label = formatOwnerAdminLabel(admin.name || admin.username);
    options.push({
      value: key,
      label,
      subtitle: `Admin · @${admin.username}${admin.isActive ? '' : ' (Inactive)'}`,
      keywords: [label, admin.name, admin.username, admin.phone, 'owner', 'admin'].filter(Boolean),
    });
    seenKeys.add(key);
  }

  const hasUnassignedOwnerSales = sales.some(
    (s) => getSaleSellerKey(s) === OWNER_UNASSIGNED_ID
  );
  if (hasUnassignedOwnerSales) {
    options.push({
      value: OWNER_UNASSIGNED_ID,
      label: 'Owner – Unassigned',
      subtitle: 'Older owner sales without admin attribution',
      keywords: ['owner', 'unassigned', 'legacy'],
    });
    seenKeys.add(OWNER_UNASSIGNED_ID);
  }

  for (const staff of staffMembers) {
    options.push({
      value: staff.id,
      label: staff.name,
      subtitle: `Sales Staff · @${staff.username}${staff.phone ? ` · ${staff.phone}` : ''}`,
      keywords: [staff.name, staff.username, staff.phone, 'staff'].filter(Boolean),
    });
    seenKeys.add(staff.id);
  }

  // Include any historical seller keys present in sales (e.g. deleted staff/admin)
  for (const s of sales) {
    const key = getSaleSellerKey(s);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const label = formatSaleSellerLabel(s);
    options.push({
      value: key,
      label,
      subtitle: isStaffRecordedSale(s) ? 'Sales Staff (Historical)' : 'Admin (Historical)',
      keywords: [label],
    });
  }

  return options;
}

export function computeSellerPerformanceBreakdown(params: {
  sales: Sale[];
  staffMembers: StaffMember[];
  adminMembers: AdminMember[];
  settings: ShopSettings | null;
  user?: AuthUserSummary | null;
  shopId?: string | null;
  fromDate?: string;
  toDate?: string;
}): SellerPerformanceRow[] {
  const { sales, staffMembers, adminMembers, settings, user, shopId, fromDate, toDate } = params;

  const map = new Map<string, SellerPerformanceRow>();
  const ensureRow = (
    sellerKey: string,
    sellerLabel: string,
    roleType: SellerPerformanceRow['roleType']
  ) => {
    let row = map.get(sellerKey);
    if (!row) {
      row = {
        sellerKey,
        sellerLabel,
        roleType,
        orders: 0,
        unitsSold: 0,
        revenue: 0,
        cost: 0,
        grossProfit: 0,
        cashTotal: 0,
        onlineTotal: 0,
        avgBill: 0,
      };
      map.set(sellerKey, row);
    }
    return row;
  };

  // Seed Primary Owner and all Admins so both Admins can always be compared side-by-side
  const primaryOwnerName = resolvePrimaryOwnerName(settings, user, shopId, sales);
  ensureRow(OWNER_PRIMARY_ID, formatOwnerAdminLabel(primaryOwnerName), 'owner_admin');

  for (const admin of adminMembers) {
    ensureRow(
      `admin:${admin.id}`,
      formatOwnerAdminLabel(admin.name || admin.username),
      'owner_admin'
    );
  }

  for (const st of staffMembers) {
    ensureRow(st.id, st.name, 'staff');
  }

  for (const s of sales) {
    if (s.status === 'cancelled') continue;
    if (fromDate && s.saleDate < fromDate) continue;
    if (toDate && s.saleDate > toDate) continue;

    const key = getSaleSellerKey(s);
    const label = formatSaleSellerLabel(s);
    const roleType: SellerPerformanceRow['roleType'] =
      key === OWNER_UNASSIGNED_ID
        ? 'unassigned'
        : isStaffRecordedSale(s)
          ? 'staff'
          : 'owner_admin';

    const row = ensureRow(key, label, roleType);
    // Keep most specific label if seeded name was generic
    if (roleType === 'owner_admin' && s.staffName && !isGenericOwnerLabel(s.staffName)) {
      row.sellerLabel = formatSaleSellerLabel(s);
    }
    row.orders += 1;
    row.unitsSold = roundStockQty(row.unitsSold + s.totalQuantity);
    row.revenue = roundMoney(row.revenue + s.totalAmount);
    row.cost = roundMoney(row.cost + s.totalCost);
    row.grossProfit = roundMoney(row.grossProfit + s.totalProfit);
    if (s.paymentMethod === 'Cash') {
      row.cashTotal = roundMoney(row.cashTotal + s.totalAmount);
    } else {
      row.onlineTotal = roundMoney(row.onlineTotal + s.totalAmount);
    }
  }

  const rows = Array.from(map.values())
    .filter((r) => r.roleType === 'owner_admin' || r.orders > 0)
    .map((r) => ({
      ...r,
      avgBill: r.orders > 0 ? roundMoney(r.revenue / r.orders) : 0,
    }));

  return rows.sort((a, b) => {
    if (b.revenue !== a.revenue) return b.revenue - a.revenue;
    if (a.roleType !== b.roleType) {
      const rank = { owner_admin: 0, staff: 1, unassigned: 2 };
      return rank[a.roleType] - rank[b.roleType];
    }
    return a.sellerLabel.localeCompare(b.sellerLabel);
  });
}
