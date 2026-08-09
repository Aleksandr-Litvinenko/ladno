import test from 'node:test';
import assert from 'node:assert/strict';

import { createSeedState } from '../src/seed.js';
import {
  approveInvoice,
  buildPaymentCalendar,
  calculateCashFlow,
  calculateInventory,
  calculateInvoiceTotals,
  calculatePnl,
  deriveInvoiceView,
  postStockDocument,
  recordPayment,
  remainingInvoiceGoodsLines,
} from '../src/domain.js';

test('seed содержит счета обоих направлений, а деньги заданы копейками', () => {
  const state = createSeedState();
  assert.deepEqual(new Set(state.invoices.map((invoice) => invoice.direction)), new Set(['payable', 'receivable']));
  for (const invoice of state.invoices) {
    const totals = calculateInvoiceTotals(invoice);
    assert.equal(Number.isSafeInteger(totals.grossMinor), true);
    assert.ok(totals.grossMinor > 0);
  }
});

test('несогласованный счёт поставщика не попадает в календарь до согласования', () => {
  const state = createSeedState();
  const invoiceId = 'invoice-payable-4821';
  assert.equal(deriveInvoiceView(state, invoiceId).settlement, 'unplanned');
  const before = buildPaymentCalendar(state, { from: '2026-08-09', to: '2026-08-15' });
  assert.equal(before.rows.flatMap((row) => row.events).some((event) => event.invoiceId === invoiceId), false);

  const approved = approveInvoice(state, invoiceId, { at: '2026-08-09T10:00:00.000Z' });
  const after = buildPaymentCalendar(approved, { from: '2026-08-09', to: '2026-08-15' });
  const event = after.rows.flatMap((row) => row.events).find((item) => item.invoiceId === invoiceId);
  assert.equal(event.date, '2026-08-14');
  assert.equal(event.amountMinor, 248_600_00);
});

test('черновик и отклонённый счёт не считаются просроченными обязательствами', () => {
  const state = createSeedState();
  const invoice = state.invoices.find((item) => item.id === 'invoice-payable-4821');
  invoice.dueDate = '2026-08-01';
  invoice.approval = 'draft';
  assert.equal(deriveInvoiceView(state, invoice, '2026-08-09').overdue, false);
  invoice.approval = 'rejected';
  assert.equal(deriveInvoiceView(state, invoice, '2026-08-09').overdue, false);
  invoice.approval = 'approved';
  assert.equal(deriveInvoiceView(state, invoice, '2026-08-09').overdue, true);
});

test('повторное согласование идемпотентно', () => {
  const initial = createSeedState();
  const approved = approveInvoice(initial, 'invoice-payable-4821', {
    actorId: 'manager', at: '2026-08-09T10:00:00.000Z', eventId: 'approval-1',
  });
  const repeated = approveInvoice(approved, 'invoice-payable-4821', {
    actorId: 'manager', at: '2026-08-09T10:00:01.000Z', eventId: 'approval-2',
  });
  assert.equal(repeated.invoices.find((invoice) => invoice.id === 'invoice-payable-4821').approval, 'approved');
  assert.equal(repeated.auditEvents.filter((event) => event.action === 'approved').length, 1);
});

test('частичная и полная оплата меняют только ось settlement', () => {
  const initial = createSeedState();
  const invoiceId = 'invoice-receivable-1042';
  const total = calculateInvoiceTotals(initial.invoices.find((invoice) => invoice.id === invoiceId)).grossMinor;
  const alreadyPaid = deriveInvoiceView(initial, invoiceId).paidMinor;
  const partialAmount = 59_200_00;
  const partial = recordPayment(initial, {
    id: 'payment-in-002', direction: 'inflow', status: 'executed', date: '2026-08-09',
    amountMinor: partialAmount, cashflowCategory: 'operating',
    allocations: [{ invoiceId, amountMinor: partialAmount }],
  });
  assert.equal(deriveInvoiceView(partial, invoiceId).settlement, 'partial');

  const finalAmount = total - alreadyPaid - partialAmount;
  const paid = recordPayment(partial, {
    id: 'payment-in-003', direction: 'inflow', status: 'executed', date: '2026-08-10',
    amountMinor: finalAmount, cashflowCategory: 'operating',
    allocations: [{ invoiceId, amountMinor: finalAmount }],
  });
  const view = deriveInvoiceView(paid, invoiceId);
  assert.equal(view.settlement, 'paid');
  assert.equal(view.fulfillment, 'partial');
  assert.equal(view.lifecycle, 'active');
});

test('склад использует скользящую средневзвешенную себестоимость', () => {
  const state = {
    stockDocuments: [
      { id: 'r1', type: 'receipt', date: '2026-08-01', posted: true, warehouseToId: 'w', lines: [{ id: '1', itemId: 'i', quantity: 10, unitCostMinor: 10_000 }] },
      { id: 'r2', type: 'receipt', date: '2026-08-02', posted: true, warehouseToId: 'w', lines: [{ id: '1', itemId: 'i', quantity: 10, unitCostMinor: 20_000 }] },
      { id: 's1', type: 'shipment', date: '2026-08-03', posted: true, warehouseFromId: 'w', lines: [{ id: '1', itemId: 'i', quantity: 4, unitPriceMinor: 30_000 }] },
    ],
  };
  const inventory = calculateInventory(state);
  assert.deepEqual(inventory.balances[0], {
    warehouseId: 'w', itemId: 'i', quantity: 16, valueMinor: 240_000, averageCostMinor: 15_000,
  });
  assert.equal(inventory.movements.find((movement) => movement.sourceDocumentId === 's1').totalCostMinor, 60_000);
});

test('отгрузка сверх остатка отклоняется атомарно', () => {
  const initial = {
    stockDocuments: [{ id: 'r1', type: 'receipt', date: '2026-08-01', posted: true, warehouseToId: 'w', lines: [{ id: '1', itemId: 'i', quantity: 1, unitCostMinor: 10_000 }] }],
    auditEvents: [],
  };
  const shipment = { id: 's1', type: 'shipment', date: '2026-08-02', warehouseFromId: 'w', lines: [{ id: '1', itemId: 'i', quantity: 2, unitPriceMinor: 20_000 }] };
  assert.throws(() => postStockDocument(initial, shipment), /Недостаточно остатка/);
  assert.equal(initial.stockDocuments.length, 1);
});

test('склад отклоняет отрицательную себестоимость, неизвестный тип и пустой документ', () => {
  const state = {
    warehouses: [{ id: 'w', name: 'Склад' }],
    items: [{ id: 'i', kind: 'goods' }],
    stockDocuments: [],
    auditEvents: [],
  };
  assert.throws(() => postStockDocument(state, {
    id: 'negative', type: 'receipt', date: '2026-08-01', warehouseToId: 'w',
    lines: [{ id: '1', itemId: 'i', quantity: 1, unitCostMinor: -100 }],
  }), /не может быть отрицательной/);
  assert.throws(() => postStockDocument(state, {
    id: 'unknown', type: 'teleport', date: '2026-08-01', warehouseToId: 'w',
    lines: [{ id: '1', itemId: 'i', quantity: 1, unitCostMinor: 100 }],
  }), /Неизвестный тип/);
  assert.throws(() => postStockDocument(state, {
    id: 'empty', type: 'receipt', date: '2026-08-01', warehouseToId: 'w', lines: [],
  }), /содержать строки/);
});

test('перемещение сохраняет общую оценку запасов без ошибки округления', () => {
  const inventory = calculateInventory({
    stockDocuments: [
      { id: 'r', type: 'receipt', date: '2026-08-01', posted: true, warehouseToId: 'a', lines: [{ id: '1', itemId: 'i', quantity: 3, unitCostMinor: 10_001 }] },
      { id: 't', type: 'transfer', date: '2026-08-02', posted: true, warehouseFromId: 'a', warehouseToId: 'b', lines: [{ id: '1', itemId: 'i', quantity: 2 }] },
    ],
  });
  assert.equal(inventory.balances.reduce((sum, balance) => sum + balance.valueMinor, 0), 30_003);
  assert.equal(inventory.balances.reduce((sum, balance) => sum + balance.quantity, 0), 3);
});

test('остаток исполнения корректно распределяется по повторяющимся строкам и возвратам', () => {
  const state = {
    items: [{ id: 'i', kind: 'goods' }],
    invoices: [{
      id: 'invoice', direction: 'payable',
      lines: [
        { id: 'l1', itemId: 'i', quantity: 5, unitPriceMinor: 100, vatRateBps: 0 },
        { id: 'l2', itemId: 'i', quantity: 5, unitPriceMinor: 90, vatRateBps: 0 },
      ],
    }],
    stockDocuments: [{
      id: 'receipt', invoiceId: 'invoice', type: 'receipt', posted: true,
      lines: [{ itemId: 'i', quantity: 6 }],
    }],
  };
  assert.deepEqual(remainingInvoiceGoodsLines(state, 'invoice').map((line) => [line.id, line.quantity]), [['l2', 4]]);
  state.stockDocuments.push({
    id: 'return', invoiceId: 'invoice', type: 'supplier_return', posted: true,
    lines: [{ itemId: 'i', quantity: 2 }],
  });
  assert.equal(remainingInvoiceGoodsLines(state, 'invoice').reduce((sum, line) => sum + line.quantity, 0), 6);
});

test('P&L строится по отгрузке, Cash Flow — по платежу', () => {
  const base = {
    settings: { openingCashMinor: 0 },
    stockDocuments: [
      { id: 'r', type: 'receipt', date: '2026-08-01', posted: true, warehouseToId: 'w', lines: [{ id: '1', itemId: 'i', quantity: 10, unitCostMinor: 10_000 }] },
      { id: 's', type: 'shipment', date: '2026-08-02', posted: true, warehouseFromId: 'w', lines: [{ id: '1', itemId: 'i', quantity: 4, unitPriceMinor: 24_000, vatRateBps: 2000, priceIncludesVat: true }] },
    ],
    financialEntries: [],
    payments: [],
  };
  const pnlBeforePayment = calculatePnl(base, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(pnlBeforePayment.revenueMinor, 80_000);
  assert.equal(pnlBeforePayment.cogsMinor, 40_000);
  assert.equal(pnlBeforePayment.grossProfitMinor, 40_000);
  assert.equal(calculateCashFlow(base, { from: '2026-08-01', to: '2026-08-31' }).netMinor, 0);

  const withPayment = {
    ...base,
    payments: [{ id: 'p', direction: 'inflow', status: 'executed', date: '2026-08-10', amountMinor: 96_000, cashflowCategory: 'operating', allocations: [] }],
  };
  assert.deepEqual(calculatePnl(withPayment, { from: '2026-08-01', to: '2026-08-31' }), pnlBeforePayment);
  assert.equal(calculateCashFlow(withPayment, { from: '2026-08-01', to: '2026-08-31' }).netMinor, 96_000);
});

test('платёжный календарь выявляет кассовый разрыв', () => {
  const state = {
    settings: { openingCashMinor: 50_000, minimumCashMinor: 0, today: '2026-08-01' },
    items: [{ id: 'service', kind: 'service' }],
    invoices: [{
      id: 'payable', direction: 'payable', organizationId: 'o', counterpartyId: 'c', contractId: 'd',
      number: '1', date: '2026-08-01', dueDate: '2026-08-02', currency: 'RUB',
      approval: 'approved', fulfillment: 'not_applicable', settlement: 'unplanned', lifecycle: 'active',
      lines: [{ id: 'l', itemId: 'service', quantity: 1, unitPriceMinor: 100_000, vatRateBps: 0, priceIncludesVat: true }],
    }],
    stockDocuments: [], payments: [], financialEntries: [], auditEvents: [],
  };
  const calendar = buildPaymentCalendar(state, { from: '2026-08-01', to: '2026-08-03' });
  assert.equal(calendar.hasCashGap, true);
  assert.equal(calendar.rows.find((row) => row.date === '2026-08-02').outflowMinor, 100_000);
  assert.equal(calendar.closingMinor, -50_000);
});

test('фактическая оплата гасит план и не удваивается в платёжном календаре', () => {
  const base = {
    settings: { openingCashMinor: 200_000, minimumCashMinor: 0, today: '2026-08-01' },
    items: [{ id: 'service', kind: 'service' }],
    invoices: [{
      id: 'payable', direction: 'payable', organizationId: 'o', counterpartyId: 'c', contractId: 'd',
      number: '1', date: '2026-08-01', dueDate: '2026-08-05', currency: 'RUB',
      approval: 'approved', fulfillment: 'not_applicable', settlement: 'planned', lifecycle: 'active',
      lines: [{ id: 'l', itemId: 'service', quantity: 1, unitPriceMinor: 100_000, vatRateBps: 0, priceIncludesVat: true }],
    }],
    stockDocuments: [], financialEntries: [], auditEvents: [],
    payments: [{
      id: 'plan', direction: 'outflow', status: 'planned', date: '2026-08-05', amountMinor: 100_000,
      cashflowCategory: 'operating', allocations: [{ invoiceId: 'payable', amountMinor: 100_000 }],
    }],
  };
  const paid = recordPayment(base, {
    id: 'fact', direction: 'outflow', status: 'executed', date: '2026-08-03', amountMinor: 100_000,
    cashflowCategory: 'operating', allocations: [{ invoiceId: 'payable', amountMinor: 100_000 }],
  });
  const calendar = buildPaymentCalendar(paid, { from: '2026-08-01', to: '2026-08-06' });
  assert.equal(calendar.rows.find((row) => row.date === '2026-08-03').outflowMinor, 100_000);
  assert.equal(calendar.rows.find((row) => row.date === '2026-08-05').outflowMinor, 0);
  assert.equal(calendar.closingMinor, 100_000);
});

test('платёж отклоняет отрицательное распределение и совокупную переплату', () => {
  const state = createSeedState();
  const invoiceId = 'invoice-receivable-1042';
  assert.throws(() => recordPayment(state, {
    id: 'negative', direction: 'inflow', status: 'executed', date: '2026-08-09', amountMinor: 1,
    cashflowCategory: 'operating', allocations: [{ invoiceId, amountMinor: -1 }],
  }), /положительной/);

  const remaining = deriveInvoiceView(state, invoiceId).remainingMinor;
  assert.throws(() => recordPayment(state, {
    id: 'duplicate-overpay', direction: 'inflow', status: 'executed', date: '2026-08-09', amountMinor: remaining + 2,
    cashflowCategory: 'operating', allocations: [
      { invoiceId, amountMinor: Math.floor(remaining / 2) + 1 },
      { invoiceId, amountMinor: Math.ceil(remaining / 2) + 1 },
    ],
  }), /превышает остаток/);

  const draftCustomer = structuredClone(state);
  draftCustomer.invoices.find((item) => item.id === invoiceId).approval = 'draft';
  assert.throws(() => recordPayment(draftCustomer, {
    id: 'draft-plan', direction: 'inflow', status: 'planned', date: '2026-08-10', amountMinor: 1,
    cashflowCategory: 'operating', allocations: [{ invoiceId, amountMinor: 1 }],
  }), /согласованному счёту/);
});

test('просроченный неоплаченный счёт переносится на начало календаря', () => {
  const state = createSeedState();
  const invoice = state.invoices.find((item) => item.id === 'invoice-receivable-1042');
  invoice.dueDate = '2026-08-01';
  const calendar = buildPaymentCalendar(state, { from: '2026-08-09', to: '2026-08-10' });
  const event = calendar.rows[0].events.find((item) => item.invoiceId === invoice.id);
  assert.equal(event.status, 'overdue');
  assert.equal(event.originalDueDate, '2026-08-01');
  assert.equal(event.date, '2026-08-09');
});

test('просроченный платёжный план не скрывает обязательство за границей периода', () => {
  const state = createSeedState();
  const invoice = state.invoices.find((item) => item.id === 'invoice-payable-4821');
  invoice.approval = 'approved';
  const plan = {
    id: 'payment-out-plan-001', direction: 'outflow', status: 'planned', date: '2026-08-01',
    amountMinor: 248_600_00, cashflowCategory: 'operating',
    allocations: [{ invoiceId: invoice.id, amountMinor: 248_600_00 }],
  };
  state.payments.push(plan);
  const calendar = buildPaymentCalendar(state, { from: '2026-08-09', to: '2026-08-10' });
  const event = calendar.rows[0].events.find((item) => item.id === plan.id);
  assert.equal(event.status, 'overdue');
  assert.equal(event.originalDate, '2026-08-01');
  assert.equal(event.amountMinor, 248_600_00);
});
