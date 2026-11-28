import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PurchasesPage } from '../pages/PurchasesPage';
import { SettingsPage } from '../pages/SettingsPage';
import type { Purchase, Supplier } from '../types/shop';

const mockState = vi.hoisted(() => ({
  suppliers: [] as Supplier[],
  purchases: [] as Purchase[],
  updateSupplier: vi.fn(async () => undefined),
  createSupplier: vi.fn(async () => 'sup_new'),
  deleteSupplier: vi.fn(async () => undefined),
}));

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { uid: 'owner_1', email: 'owner@caremart.pk' } },
  db: {},
  OperationType: {
    CREATE: 'create',
    UPDATE: 'update',
    DELETE: 'delete',
    LIST: 'list',
    GET: 'get',
    WRITE: 'write',
  },
  handleFirestoreError: (err: unknown) => {
    throw err instanceof Error ? err : new Error(String(err));
  },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'owner_1', email: 'owner@caremart.pk', displayName: 'Owner' },
    shopId: 'owner_1',
  }),
}));

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({
    isDark: false,
    toggleTheme: vi.fn(),
  }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('../contexts/GoogleSheetsSyncContext', () => ({
  useGoogleSheetsSync: () => null,
}));

vi.mock('../services/discordNotificationService', () => ({
  fetchDiscordCapabilities: vi.fn(async () => ({ configured: false })),
  getDiscordQueueStats: vi.fn(async () => ({ pending: 0, failed: 0 })),
  removeDiscordWebhookVault: vi.fn(),
  retryFailedDiscordNotifications: vi.fn(),
  saveDiscordWebhookVault: vi.fn(),
  sendDiscordTestAlert: vi.fn(),
  subscribeDiscordQueue: vi.fn(() => () => {}),
}));

vi.mock('../contexts/ShopDataContext', () => ({
  useShopData: () => ({
    settings: {
      shopName: 'CareMart',
      ownerName: 'Owner',
      phone: '0300-0000000',
      address: 'Lahore',
      expiryAlertDays: 30,
      autoBackupEnabled: true,
    },
    categories: [],
    brands: [],
    productTemplates: [],
    suppliers: mockState.suppliers,
    expenseCategories: [],
    products: [],
    sales: [],
    saleItems: [],
    purchases: mockState.purchases,
    purchaseItems: [],
    expenses: [],
    stockMovements: [],
    stockAdjustments: [],
    auditLogs: [],
    backups: [],
  }),
}));

vi.mock('../services/shopService', () => ({
  createCategory: vi.fn(),
  createExpenseCategory: vi.fn(),
  createSupplier: (...args: unknown[]) => mockState.createSupplier(...(args as [])),
  updateSupplier: (...args: unknown[]) => mockState.updateSupplier(...(args as [])),
  deleteSupplier: (...args: unknown[]) => mockState.deleteSupplier(...(args as [])),
  deleteCategory: vi.fn(),
  deleteExpenseCategory: vi.fn(),
  recordBackupSnapshot: vi.fn(),
  updateShopSettings: vi.fn(),
  createPurchase: vi.fn(),
  cancelPurchase: vi.fn(),
  settlePurchaseBalance: vi.fn(),
}));

vi.mock('../services/recordSearchService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/recordSearchService')>();
  return {
    ...actual,
    computeTopActivityValues: () => [],
  };
});

function makeSupplier(overrides: Partial<Supplier> = {}): Supplier {
  return {
    id: 'sup_1',
    ownerUid: 'owner_1',
    name: 'Metro Distributors',
    phone: '0300-1112233',
    address: 'Shah Alam Market',
    email: 'old@metro.pk',
    totalPurchased: 25000,
    totalPaid: 20000,
    outstandingBalance: 5000,
    notes: 'Delivers on Monday',
    ...overrides,
  };
}

describe('Supplier Edit UI in SettingsPage and PurchasesPage', () => {
  beforeEach(() => {
    mockState.updateSupplier.mockClear();
    mockState.createSupplier.mockClear();
    mockState.suppliers = [
      makeSupplier(),
      makeSupplier({
        id: 'sup_2',
        name: 'Alpha Suppliers',
        phone: '0321-4445566',
        address: 'Karachi',
        email: '',
        totalPurchased: 0,
        totalPaid: 0,
        outstandingBalance: 0,
        notes: '',
      }),
    ];
    mockState.purchases = [
      {
        id: 'po_1',
        ownerUid: 'owner_1',
        purchaseNumber: 'PO-101',
        purchaseDate: '2026-11-15',
        supplierId: 'sup_1',
        supplierName: 'Metro Distributors',
        paymentMethod: 'Cash',
        totalAmount: 25000,
        amountPaid: 20000,
        balanceDue: 5000,
        totalQuantity: 10,
        itemCount: 1,
        notes: '',
        status: 'completed',
      },
    ];

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('edits an existing supplier from SettingsPage (name, phone, address, email, notes) without creating duplicates', async () => {
    render(<SettingsPage />);

    // Open collapsible Suppliers section
    fireEvent.click(screen.getByRole('button', { name: /Suppliers/i }));

    // Click Edit on Metro Distributors
    fireEvent.click(screen.getByRole('button', { name: 'Edit Metro Distributors' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    const nameInput = screen.getByLabelText(/Supplier Name/i) as HTMLInputElement;
    const phoneInput = screen.getByLabelText(/^Phone$/i) as HTMLInputElement;
    const emailInput = screen.getByLabelText(/^Email$/i) as HTMLInputElement;
    const addressInput = screen.getByLabelText(/^Address$/i) as HTMLInputElement;
    const notesInput = screen.getByLabelText(/^Notes$/i) as HTMLTextAreaElement;

    expect(nameInput.value).toBe('Metro Distributors');
    expect(phoneInput.value).toBe('0300-1112233');
    expect(emailInput.value).toBe('old@metro.pk');
    expect(addressInput.value).toBe('Shah Alam Market');
    expect(notesInput.value).toBe('Delivers on Monday');

    // Duplicate name check disables save and warns admin
    fireEvent.change(nameInput, { target: { value: 'alpha suppliers' } });
    expect(screen.getByText(/Another supplier named/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Save Changes/i }) as HTMLButtonElement).disabled).toBe(true);

    // Enter valid updated details
    fireEvent.change(nameInput, { target: { value: 'Metro Cash & Carry' } });
    fireEvent.change(phoneInput, { target: { value: '0300-9990001' } });
    fireEvent.change(emailInput, { target: { value: 'billing@metrocash.pk' } });
    fireEvent.change(addressInput, { target: { value: 'Hall Road, Lahore' } });
    fireEvent.change(notesInput, { target: { value: 'Net 7 terms' } });

    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(mockState.updateSupplier).toHaveBeenCalledTimes(1);
    });
    expect(mockState.updateSupplier).toHaveBeenCalledWith('owner_1', 'sup_1', {
      name: 'Metro Cash & Carry',
      phone: '0300-9990001',
      address: 'Hall Road, Lahore',
      email: 'billing@metrocash.pk',
      notes: 'Net 7 terms',
    });
    expect(mockState.createSupplier).not.toHaveBeenCalled();
  });

  it('edits supplier from PurchasesPage Supplier Balances and immediately shows updated supplier name in purchase history', async () => {
    const { rerender } = render(<PurchasesPage />);

    const editBtns = screen.getAllByRole('button', { name: 'Edit Metro Distributors' });
    fireEvent.click(editBtns[0]);

    const nameInput = screen.getByLabelText(/Supplier Name/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Metro Prime Supply' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(mockState.updateSupplier).toHaveBeenCalledWith('owner_1', 'sup_1', {
        name: 'Metro Prime Supply',
        phone: '0300-1112233',
        address: 'Shah Alam Market',
        email: 'old@metro.pk',
        notes: 'Delivers on Monday',
      });
    });

    // Simulate Firestore onSnapshot reflecting updated supplier while PO still holds historical supplierName
    mockState.suppliers = [
      makeSupplier({ name: 'Metro Prime Supply' }),
      mockState.suppliers[1],
    ];
    rerender(<PurchasesPage />);

    expect(screen.getAllByText('Metro Prime Supply').length).toBeGreaterThan(0);
    expect(screen.queryByText('Metro Distributors')).toBeNull();
  });
});
