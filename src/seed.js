export const SCHEMA_VERSION = 1;
export const DEMO_TODAY = '2026-08-09';

const clone = (value) => JSON.parse(JSON.stringify(value));

const seed = {
  schemaVersion: SCHEMA_VERSION,
  generatedAt: '2026-08-09T09:00:00.000Z',
  settings: {
    today: DEMO_TODAY,
    currency: 'RUB',
    openingCashMinor: 3_250_000_00,
    minimumCashMinor: 500_000_00,
  },
  organizations: [
    { id: 'org-ladno', name: 'ООО «Ладно»', inn: '7700000000' },
  ],
  counterparties: [
    { id: 'cp-supplier', kind: 'supplier', name: 'ООО «Северные системы»', inn: '7801000000' },
    { id: 'cp-customer', kind: 'customer', name: 'АО «Точный контур»', inn: '7715000000' },
  ],
  contracts: [
    { id: 'contract-supplier', counterpartyId: 'cp-supplier', number: 'ИТ-17/26', paymentTermsDays: 5 },
    { id: 'contract-customer', counterpartyId: 'cp-customer', number: 'КЛ-08/26', paymentTermsDays: 10 },
  ],
  warehouses: [
    { id: 'warehouse-main', name: 'Основной склад' },
    { id: 'warehouse-reserve', name: 'Резервный склад' },
  ],
  items: [
    { id: 'item-terminal', sku: 'TRM-01', name: 'Терминал сбора данных', kind: 'goods', unit: 'шт.', vatRateBps: 2000 },
    { id: 'item-scanner', sku: 'SCN-02', name: 'Сканер штрихкодов', kind: 'goods', unit: 'шт.', vatRateBps: 2000 },
    { id: 'item-support', sku: 'SRV-01', name: 'Настройка и сопровождение', kind: 'service', unit: 'усл.', vatRateBps: 2000 },
  ],
  invoices: [
    {
      id: 'invoice-payable-4821',
      direction: 'payable',
      organizationId: 'org-ladno',
      counterpartyId: 'cp-supplier',
      contractId: 'contract-supplier',
      number: '4821',
      date: '2026-08-09',
      dueDate: '2026-08-14',
      currency: 'RUB',
      approval: 'review',
      fulfillment: 'partial',
      settlement: 'unplanned',
      lifecycle: 'active',
      rowVersion: 1,
      lines: [
        { id: 'p-line-1', itemId: 'item-terminal', quantity: 10, unitPriceMinor: 19_800_00, vatRateBps: 2000, priceIncludesVat: true },
        { id: 'p-line-2', itemId: 'item-support', quantity: 1, unitPriceMinor: 50_600_00, vatRateBps: 2000, priceIncludesVat: true },
      ],
    },
    {
      id: 'invoice-receivable-1042',
      direction: 'receivable',
      organizationId: 'org-ladno',
      counterpartyId: 'cp-customer',
      contractId: 'contract-customer',
      number: '1042',
      date: '2026-08-04',
      dueDate: '2026-08-14',
      currency: 'RUB',
      approval: 'approved',
      fulfillment: 'partial',
      settlement: 'partial',
      lifecycle: 'active',
      rowVersion: 2,
      lines: [
        { id: 'r-line-1', itemId: 'item-terminal', quantity: 6, unitPriceMinor: 31_200_00, vatRateBps: 2000, priceIncludesVat: true },
        { id: 'r-line-2', itemId: 'item-support', quantity: 1, unitPriceMinor: 72_000_00, vatRateBps: 2000, priceIncludesVat: true },
      ],
    },
  ],
  stockDocuments: [
    {
      id: 'receipt-001',
      type: 'receipt',
      invoiceId: 'invoice-payable-4821',
      date: '2026-08-05',
      posted: true,
      warehouseToId: 'warehouse-main',
      lines: [
        { id: 'receipt-line-1', itemId: 'item-terminal', quantity: 8, unitCostMinor: 16_500_00 },
        { id: 'receipt-line-2', itemId: 'item-scanner', quantity: 20, unitCostMinor: 4_500_00 },
      ],
    },
    {
      id: 'shipment-001',
      type: 'shipment',
      invoiceId: 'invoice-receivable-1042',
      date: '2026-08-07',
      posted: true,
      warehouseFromId: 'warehouse-main',
      lines: [
        { id: 'shipment-line-1', itemId: 'item-terminal', quantity: 4, unitPriceMinor: 31_200_00, vatRateBps: 2000, priceIncludesVat: true },
      ],
    },
  ],
  payments: [
    {
      id: 'payment-in-001',
      direction: 'inflow',
      status: 'executed',
      date: '2026-08-08',
      amountMinor: 100_000_00,
      cashflowCategory: 'operating',
      allocations: [{ invoiceId: 'invoice-receivable-1042', amountMinor: 100_000_00 }],
    },
  ],
  financialEntries: [
    { id: 'entry-service-expense-001', date: '2026-08-06', kind: 'operating_expense', amountMinor: 42_166_67, sourceId: 'invoice-payable-4821', posted: true },
    { id: 'entry-service-revenue-001', date: '2026-08-07', kind: 'revenue', amountMinor: 60_000_00, sourceId: 'invoice-receivable-1042', posted: true },
  ],
  auditEvents: [],
  odataRecords: [],
  syncRuns: [],
};

export function createSeedState() {
  return clone(seed);
}

export const demoSeed = createSeedState();
