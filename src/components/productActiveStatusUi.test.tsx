import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductsPage } from '../pages/ProductsPage';
import { SalesPage } from '../pages/SalesPage';
import type { Product, Sale, SaleItem } from '../types/shop';
import { SearchableProductSelector } from './SearchableProductSelector';

const mockState = vi.hoisted(() => ({
  products: [] as Product[],
  sales: [] as Sale[],
  saleItems: [] as SaleItem[],
  createProduct: vi.fn(async () => 'prod_new'),
  updateProduct: vi.fn(async () => undefined),
  createSale: vi.fn(async () => 'sale_new'),
}));

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { uid: 'owner_1' } },
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

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('../contexts/GoogleSheetsSyncContext', () => ({
  useGoogleSheetsSync: () => null,
}));

vi.mock('../contexts/ShopDataContext', () => ({
  useShopData: () => ({
    products: mockState.products,
    categories: [{ id: 'cat_1', ownerUid: 'owner_1', name: 'Baby Care', description: '' }],
    brands: [{ id: 'br_1', ownerUid: 'owner_1', name: 'LEO', categoryIds: ['cat_1'], isActive: true }],
    suppliers: [
      {
        id: 'sup_1',
        ownerUid: 'owner_1',
        name: 'Main Supplier',
        phone: '03001112233',
        address: '',
        totalPurchased: 0,
        totalPaid: 0,
        outstandingBalance: 0,
        notes: '',
      },
    ],
    productTemplates: [],
    sales: mockState.sales,
    saleItems: mockState.saleItems,
    purchaseItems: [],
    staffMembers: [],
    adminMembers: [],
    inventoryBatches: [],
    settings: {
      shopName: 'CareMart',
      ownerName: 'Owner',
      expiryAlertDays: 30,
    },
  }),
}));

vi.mock('../services/shopService', () => ({
  createProduct: (...args: unknown[]) => mockState.createProduct(...(args as [])),
  updateProduct: (...args: unknown[]) => mockState.updateProduct(...(args as [])),
  deleteProduct: vi.fn(),
  createBrand: vi.fn(),
  createCategory: vi.fn(),
  createSupplier: vi.fn(),
  createProductTemplate: vi.fn(),
  createSale: (...args: unknown[]) => mockState.createSale(...(args as [])),
  editSale: vi.fn(),
  cancelSale: vi.fn(),
}));

vi.mock('../services/recordSearchService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/recordSearchService')>();
  return {
    ...actual,
    computeTopActivityValues: () => [],
  };
});

vi.mock('../hooks/useSalesAssistant', () => ({
  useSalesAssistant: () => ({
    suggestion: null,
    dismissSuggestion: vi.fn(),
    onSuggestionAccepted: vi.fn(),
    onProductAdded: vi.fn(),
    onCartCleared: vi.fn(),
    onSaleSaved: vi.fn(),
  }),
}));

function makeProduct(overrides: Partial<Product>): Product {
  return {
    id: 'p_1',
    ownerUid: 'owner_1',
    name: 'LEO Baby Wipes 72s',
    categoryId: 'cat_1',
    categoryName: 'Baby Care',
    brandId: 'br_1',
    brandName: 'LEO',
    purchasePrice: 150,
    salePrice: 220,
    wholesalePrice: 200,
    currentStock: 25,
    minStockLevel: 5,
    maxStockLevel: 100,
    unit: 'Piece',
    baseUnit: 'Piece',
    supplierId: 'sup_1',
    supplierName: 'Main Supplier',
    expiryDate: '',
    profitMarginPct: 31.8,
    isActive: true,
    ...overrides,
  };
}

describe('Active / Inactive product UI lifecycle across ProductsPage, SearchableProductSelector, and SalesPage', () => {
  beforeEach(() => {
    mockState.createProduct.mockClear();
    mockState.updateProduct.mockClear();
    mockState.createSale.mockClear();
    mockState.sales = [];
    mockState.saleItems = [];
    mockState.products = [
      makeProduct({ id: 'p_active', name: 'LEO Baby Wipes 72s', isActive: true, currentStock: 20 }),
      makeProduct({ id: 'p_inactive', name: 'Mothercare Archived Lotion', isActive: false, currentStock: 14 }),
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
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  });

  it('defaults new products to Active, shows Inactive label in ProductsPage, and allows reactivating via Edit modal', async () => {
    render(<ProductsPage />);

    // Both Active and Inactive products remain visible in Products Management, with Inactive badge on the inactive one
    expect(screen.getAllByText('LEO Baby Wipes 72s').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mothercare Archived Lotion').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Inactive').length).toBeGreaterThan(0);

    // Filter by Inactive Only -> active product hidden, inactive visible
    const statusFilter = screen.getByLabelText('Filter by product status');
    fireEvent.change(statusFilter, { target: { value: 'inactive' } });
    expect(screen.queryByText('LEO Baby Wipes 72s')).toBeNull();
    expect(screen.getAllByText('Mothercare Archived Lotion').length).toBeGreaterThan(0);

    // Reset filter to All Statuses
    fireEvent.change(statusFilter, { target: { value: '' } });

    // Open Add Product -> Product Status defaults to Active
    fireEvent.click(screen.getByRole('button', { name: /add product/i }));
    const activeBtn = screen.getByRole('button', { name: /^Active$/i });
    const inactiveBtn = screen.getByRole('button', { name: /^Inactive$/i });
    expect(activeBtn.getAttribute('aria-pressed')).toBe('true');
    expect(inactiveBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    // Edit the Inactive product -> switch back to Active -> saves with isActive: true
    const editButtons = screen.getAllByTitle('Edit product');
    fireEvent.click(editButtons[1]);
    expect(screen.getByRole('button', { name: /^Inactive$/i }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /^Active$/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockState.updateProduct).toHaveBeenCalledTimes(1);
    });
    expect(mockState.updateProduct).toHaveBeenCalledWith(
      'owner_1',
      'p_inactive',
      expect.objectContaining({
        name: 'Mothercare Archived Lotion',
        isActive: true,
      })
    );
  });

  it('excludes inactive products from Sales typing and voice search, rejects stale selections, and restores them when reactivated', async () => {
    class MockSpeechRecognition {
      lang = 'en-US';
      interimResults = true;
      maxAlternatives = 1;
      continuous = false;
      onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }> }) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        this.onresult?.({
          results: {
            length: 1,
            0: { isFinal: true, 0: { transcript: 'Mothercare Archived Lotion' } },
          },
        });
        this.onend?.();
      }
      stop() {}
      abort() {}
    }
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = MockSpeechRecognition;

    const { rerender } = render(<SalesPage />);
    const quickInput = document.getElementById('quick-add-product-search') as HTMLInputElement;
    expect(quickInput).toBeTruthy();

    // Typing inactive product name yields no matches in Sales search
    fireEvent.focus(quickInput);
    fireEvent.change(quickInput, { target: { value: 'Mothercare Archived Lotion' } });
    await waitFor(() => {
      expect(screen.getByText(/No active products match/i)).toBeTruthy();
    });

    // Voice search speaking inactive product name also yields zero matches
    const voiceBtn = screen.getByRole('button', { name: /search product by voice/i });
    fireEvent.click(voiceBtn);
    await waitFor(() => {
      expect(screen.getByText(/No active products match/i)).toBeTruthy();
    });

    // Typing active product shows it and allows adding it to cart
    fireEvent.change(quickInput, { target: { value: 'LEO Baby Wipes' } });
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeTruthy();
    });
    const leoOption = screen.getByRole('option');
    fireEvent.click(leoOption.querySelector('button')!);
    expect(screen.getAllByText(/LEO Baby Wipes 72s/i).length).toBeGreaterThan(0);

    // Reactivate Mothercare Archived Lotion -> reappears in Sales search immediately
    mockState.products = [
      makeProduct({ id: 'p_active', name: 'LEO Baby Wipes 72s', isActive: true, currentStock: 20 }),
      makeProduct({ id: 'p_inactive', name: 'Mothercare Archived Lotion', isActive: true, currentStock: 14 }),
    ];
    rerender(<SalesPage />);
    fireEvent.focus(quickInput);
    fireEvent.change(quickInput, { target: { value: 'Mothercare Archived Lotion' } });
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeTruthy();
    });
    expect(screen.getByText(/Stock: 14 Piece/i)).toBeTruthy();
  });

  it('SearchableProductSelector blocks direct pick on an inactive item passed in stale props', () => {
    const onSelect = vi.fn();
    render(
      <SearchableProductSelector
        mode="quick-add"
        items={[
          {
            id: 'p_stale_inactive',
            name: 'Stale Inactive Item',
            brandName: 'Brand',
            categoryName: 'Cat',
            salePrice: 100,
            currentStock: 5,
            unit: 'Piece',
            baseUnit: 'Piece',
            isActive: false,
          },
        ]}
        onSelect={onSelect}
      />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Stale Inactive Item' } });
    expect(screen.getByText(/Searching across 0 active catalog items/i)).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
