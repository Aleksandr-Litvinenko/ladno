const APPROVALS = new Set(['draft', 'review', 'approved', 'rejected']);
const FULFILLMENTS = new Set(['pending', 'partial', 'complete', 'not_applicable']);
const SETTLEMENTS = new Set(['unplanned', 'planned', 'partial', 'paid']);
const LIFECYCLES = new Set(['active', 'closed', 'cancelled']);
const STOCK_DOCUMENT_TYPES = new Set(['receipt', 'shipment', 'transfer', 'supplier_return', 'customer_return', 'adjustment']);

export const cloneState = (value) => JSON.parse(JSON.stringify(value));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertMinor(value, label = 'Сумма') {
  invariant(Number.isSafeInteger(value), `${label} должна быть целым числом копеек`);
  return value;
}

function assertDate(value, label = 'Дата') {
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(value ?? ''), `${label} должна иметь формат YYYY-MM-DD`);
  return value;
}

function inPeriod(date, from, to) {
  return (!from || date >= from) && (!to || date <= to);
}

function dateRange(from, to) {
  assertDate(from, 'Начало периода');
  assertDate(to, 'Конец периода');
  invariant(from <= to, 'Начало периода должно быть не позже конца');
  const result = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const finish = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= finish) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export function calculateLineTotals(line) {
  const quantity = Number(line.quantity);
  invariant(Number.isFinite(quantity) && quantity > 0, 'Количество должно быть положительным');
  const unitPriceMinor = assertMinor(line.unitPriceMinor, 'Цена');
  invariant(unitPriceMinor >= 0, 'Цена не может быть отрицательной');
  const vatRateBps = Number(line.vatRateBps ?? 0);
  invariant(Number.isInteger(vatRateBps) && vatRateBps >= 0, 'Ставка НДС должна быть неотрицательной');

  if (line.priceIncludesVat !== false) {
    const grossMinor = Math.round(quantity * unitPriceMinor);
    const vatMinor = vatRateBps === 0 ? 0 : Math.round((grossMinor * vatRateBps) / (10_000 + vatRateBps));
    return { netMinor: grossMinor - vatMinor, vatMinor, grossMinor };
  }

  const netMinor = Math.round(quantity * unitPriceMinor);
  const vatMinor = Math.round((netMinor * vatRateBps) / 10_000);
  return { netMinor, vatMinor, grossMinor: netMinor + vatMinor };
}

export function calculateInvoiceTotals(invoice) {
  return (invoice.lines ?? []).reduce(
    (total, line) => {
      const row = calculateLineTotals(line);
      total.netMinor += row.netMinor;
      total.vatMinor += row.vatMinor;
      total.grossMinor += row.grossMinor;
      return total;
    },
    { netMinor: 0, vatMinor: 0, grossMinor: 0 },
  );
}

export function validateInvoice(invoice) {
  const errors = [];
  if (!['payable', 'receivable'].includes(invoice.direction)) errors.push('Неизвестное направление счёта');
  if (!invoice.organizationId) errors.push('Не указана организация');
  if (!invoice.counterpartyId) errors.push('Не указан контрагент');
  if (!invoice.contractId) errors.push('Не указан договор');
  if (!invoice.number) errors.push('Не указан номер');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.date ?? '')) errors.push('Некорректная дата счёта');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.dueDate ?? '')) errors.push('Некорректный срок оплаты');
  if (!(invoice.lines?.length > 0)) errors.push('В счёте нет строк');
  try {
    if (calculateInvoiceTotals(invoice).grossMinor <= 0) errors.push('Сумма счёта должна быть положительной');
  } catch (error) {
    errors.push(error.message);
  }
  if (!APPROVALS.has(invoice.approval)) errors.push('Некорректное состояние согласования');
  if (!FULFILLMENTS.has(invoice.fulfillment)) errors.push('Некорректное состояние исполнения');
  if (!SETTLEMENTS.has(invoice.settlement)) errors.push('Некорректное состояние расчётов');
  if (!LIFECYCLES.has(invoice.lifecycle)) errors.push('Некорректное состояние жизненного цикла');
  return errors;
}

function appendAudit(state, event) {
  state.auditEvents ??= [];
  state.auditEvents.push(event);
}

export function submitInvoiceForReview(state, invoiceId, context = {}) {
  const next = cloneState(state);
  const invoice = next.invoices.find((item) => item.id === invoiceId);
  invariant(invoice, 'Счёт не найден');
  invariant(invoice.lifecycle === 'active', 'Неактивный счёт нельзя отправить на согласование');
  const errors = validateInvoice(invoice);
  invariant(errors.length === 0, errors.join('; '));
  if (invoice.approval === 'review') return next;
  invariant(['draft', 'rejected'].includes(invoice.approval), 'Недопустимый переход на согласование');
  invoice.approval = 'review';
  invoice.rowVersion = (invoice.rowVersion ?? 0) + 1;
  appendAudit(next, {
    id: context.eventId ?? `${invoiceId}:review:${context.at ?? 'now'}`,
    entity: 'invoice', entityId: invoiceId, action: 'submitted_for_review',
    actorId: context.actorId ?? 'demo-user', at: context.at ?? new Date().toISOString(),
  });
  return next;
}

export function approveInvoice(state, invoiceId, context = {}) {
  const next = cloneState(state);
  const invoice = next.invoices.find((item) => item.id === invoiceId);
  invariant(invoice, 'Счёт не найден');
  if (invoice.approval === 'approved') return next;
  invariant(invoice.lifecycle === 'active', 'Неактивный счёт нельзя согласовать');
  invariant(invoice.approval === 'review', 'Счёт должен находиться на согласовании');
  const errors = validateInvoice(invoice);
  invariant(errors.length === 0, errors.join('; '));
  invoice.approval = 'approved';
  invoice.rowVersion = (invoice.rowVersion ?? 0) + 1;
  appendAudit(next, {
    id: context.eventId ?? `${invoiceId}:approved:${context.at ?? 'now'}`,
    entity: 'invoice', entityId: invoiceId, action: 'approved',
    actorId: context.actorId ?? 'demo-user', at: context.at ?? new Date().toISOString(),
  });
  return next;
}

export function rejectInvoice(state, invoiceId, context = {}) {
  const next = cloneState(state);
  const invoice = next.invoices.find((item) => item.id === invoiceId);
  invariant(invoice, 'Счёт не найден');
  if (invoice.approval === 'rejected') return next;
  invariant(invoice.approval === 'review', 'Отклонить можно только счёт на согласовании');
  invoice.approval = 'rejected';
  invoice.rowVersion = (invoice.rowVersion ?? 0) + 1;
  appendAudit(next, {
    id: context.eventId ?? `${invoiceId}:rejected:${context.at ?? 'now'}`,
    entity: 'invoice', entityId: invoiceId, action: 'rejected', reason: context.reason ?? '',
    actorId: context.actorId ?? 'demo-user', at: context.at ?? new Date().toISOString(),
  });
  return next;
}

function balanceKey(warehouseId, itemId) {
  return `${warehouseId}::${itemId}`;
}

function movementSort(a, b) {
  return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

function validateStockDocument(state, document) {
  invariant(document?.id, 'У складского документа должен быть id');
  invariant(STOCK_DOCUMENT_TYPES.has(document.type), `Неизвестный тип складского документа: ${document.type ?? 'не указан'}`);
  assertDate(document.date, `Дата документа ${document.id}`);
  invariant(Array.isArray(document.lines) && document.lines.length > 0, 'Складской документ должен содержать строки');

  const requireWarehouse = (warehouseId, label) => {
    invariant(warehouseId, `${label} не указан`);
    if (Array.isArray(state.warehouses) && state.warehouses.length > 0) {
      invariant(state.warehouses.some((warehouse) => warehouse.id === warehouseId), `${label} не найден`);
    }
  };

  if (['receipt', 'customer_return'].includes(document.type)) requireWarehouse(document.warehouseToId, 'Склад-получатель');
  if (['shipment', 'supplier_return'].includes(document.type)) requireWarehouse(document.warehouseFromId, 'Склад-источник');
  if (document.type === 'transfer') {
    requireWarehouse(document.warehouseFromId, 'Склад-источник');
    requireWarehouse(document.warehouseToId, 'Склад-получатель');
    invariant(document.warehouseFromId !== document.warehouseToId, 'Склады перемещения должны различаться');
  }

  for (const line of document.lines) {
    invariant(line?.itemId, 'В строке склада не указана номенклатура');
    if (Array.isArray(state.items) && state.items.length > 0) {
      invariant(state.items.some((item) => item.id === line.itemId), `Номенклатура ${line.itemId} не найдена`);
    }
    invariant(Number.isFinite(line.quantity) && line.quantity !== 0, 'Количество склада должно быть ненулевым числом');
    if (document.type !== 'adjustment') invariant(line.quantity > 0, 'Количество склада должно быть положительным');

    const isReceipt = ['receipt', 'customer_return'].includes(document.type)
      || (document.type === 'adjustment' && line.quantity > 0);
    if (isReceipt) {
      const unitCostMinor = assertMinor(line.unitCostMinor, 'Себестоимость единицы');
      invariant(unitCostMinor >= 0, 'Себестоимость единицы не может быть отрицательной');
    }
    if (document.type === 'adjustment') {
      const warehouseId = line.quantity > 0
        ? document.warehouseToId ?? document.warehouseId
        : document.warehouseFromId ?? document.warehouseId;
      requireWarehouse(warehouseId, line.quantity > 0 ? 'Склад-получатель' : 'Склад-источник');
    }
  }
}

export function calculateInventory(state, options = {}) {
  const throughDate = options.throughDate;
  const allowNegative = options.allowNegative === true;
  const balanceMap = new Map();
  const movements = [];

  function getBalance(warehouseId, itemId) {
    const key = balanceKey(warehouseId, itemId);
    if (!balanceMap.has(key)) balanceMap.set(key, { warehouseId, itemId, quantity: 0, valueMinor: 0 });
    return balanceMap.get(key);
  }

  function receive(document, line, warehouseId, unitCostMinor, quantity = line.quantity, exactTotalCostMinor = null) {
    invariant(warehouseId, `Не указан склад-получатель в ${document.id}`);
    invariant(Number.isFinite(quantity) && quantity > 0, 'Количество прихода должно быть положительным');
    assertMinor(unitCostMinor, 'Себестоимость единицы');
    invariant(unitCostMinor >= 0, 'Себестоимость единицы не может быть отрицательной');
    const totalCostMinor = exactTotalCostMinor == null
      ? assertMinor(Math.round(quantity * unitCostMinor), 'Стоимость прихода')
      : assertMinor(exactTotalCostMinor, 'Стоимость перемещения');
    invariant(totalCostMinor >= 0, 'Стоимость прихода не может быть отрицательной');
    const balance = getBalance(warehouseId, line.itemId);
    balance.quantity += quantity;
    invariant(Number.isFinite(balance.quantity), 'Количество вышло за допустимый диапазон');
    balance.valueMinor = assertMinor(balance.valueMinor + totalCostMinor, 'Стоимость остатка');
    movements.push({
      id: `${document.id}:${line.id ?? line.itemId}:in:${warehouseId}`,
      sourceDocumentId: document.id, sourceType: document.type, date: document.date,
      warehouseId, itemId: line.itemId, quantity, totalCostMinor, direction: 'in',
    });
    return totalCostMinor;
  }

  function issue(document, line, warehouseId, quantity = line.quantity) {
    invariant(warehouseId, `Не указан склад-источник в ${document.id}`);
    invariant(Number.isFinite(quantity) && quantity > 0, 'Количество расхода должно быть положительным');
    const balance = getBalance(warehouseId, line.itemId);
    if (!allowNegative) invariant(balance.quantity >= quantity, `Недостаточно остатка ${line.itemId} на складе ${warehouseId}`);
    const totalCostMinor = assertMinor(balance.quantity > 0
      ? Math.round((balance.valueMinor * quantity) / balance.quantity)
      : Math.round(quantity * (line.unitCostMinor ?? 0)), 'Стоимость выбытия');
    balance.quantity -= quantity;
    balance.valueMinor -= totalCostMinor;
    if (Math.abs(balance.quantity) < 1e-9) {
      balance.quantity = 0;
      balance.valueMinor = 0;
    }
    movements.push({
      id: `${document.id}:${line.id ?? line.itemId}:out:${warehouseId}`,
      sourceDocumentId: document.id, sourceType: document.type, date: document.date,
      warehouseId, itemId: line.itemId, quantity: -quantity, totalCostMinor, direction: 'out',
    });
    return totalCostMinor;
  }

  const documents = (state.stockDocuments ?? [])
    .filter((document) => document.posted && (!throughDate || document.date <= throughDate))
    .slice()
    .sort(movementSort);

  for (const document of documents) {
    validateStockDocument(state, document);
    for (const line of document.lines ?? []) {
      if (document.type === 'receipt') receive(document, line, document.warehouseToId, line.unitCostMinor);
      else if (document.type === 'shipment' || document.type === 'supplier_return') issue(document, line, document.warehouseFromId);
      else if (document.type === 'customer_return') receive(document, line, document.warehouseToId, line.unitCostMinor);
      else if (document.type === 'transfer') {
        const transferCost = issue(document, line, document.warehouseFromId);
        receive(document, line, document.warehouseToId, Math.round(transferCost / line.quantity), line.quantity, transferCost);
      } else if (document.type === 'adjustment') {
        if (line.quantity > 0) receive(document, line, document.warehouseToId ?? document.warehouseId, line.unitCostMinor);
        else issue(document, { ...line, quantity: Math.abs(line.quantity) }, document.warehouseFromId ?? document.warehouseId);
      }
    }
  }

  const balances = [...balanceMap.values()].map((balance) => ({
    ...balance,
    averageCostMinor: balance.quantity === 0 ? 0 : Math.round(balance.valueMinor / balance.quantity),
  }));
  return { balances, movements };
}

export function postStockDocument(state, document, context = {}) {
  validateStockDocument(state, document);
  invariant(!(state.stockDocuments ?? []).some((item) => item.id === document.id), 'Складской документ уже существует');
  const next = cloneState(state);
  next.stockDocuments ??= [];
  next.stockDocuments.push({ ...cloneState(document), posted: true });
  calculateInventory(next);
  appendAudit(next, {
    id: context.eventId ?? `${document.id}:posted:${context.at ?? 'now'}`,
    entity: 'stock_document', entityId: document.id, action: 'posted',
    actorId: context.actorId ?? 'demo-user', at: context.at ?? new Date().toISOString(),
  });
  return next;
}

export function allocatedPaidMinor(state, invoiceId) {
  return (state.payments ?? [])
    .filter((payment) => payment.status === 'executed')
    .flatMap((payment) => payment.allocations ?? [])
    .filter((allocation) => allocation.invoiceId === invoiceId)
    .reduce((sum, allocation) => {
      const amountMinor = assertMinor(allocation.amountMinor, 'Сумма зачёта');
      invariant(amountMinor > 0, 'Сумма зачёта должна быть положительной');
      return sum + amountMinor;
    }, 0);
}

function plannedMinor(state, invoiceId) {
  return (state.payments ?? [])
    .filter((payment) => payment.status === 'planned')
    .flatMap((payment) => payment.allocations ?? [])
    .filter((allocation) => allocation.invoiceId === invoiceId)
    .reduce((sum, allocation) => {
      const amountMinor = assertMinor(allocation.amountMinor, 'Плановая сумма');
      invariant(amountMinor > 0, 'Плановая сумма должна быть положительной');
      return sum + amountMinor;
    }, 0);
}

function deriveFulfillment(state, invoice) {
  const goods = (invoice.lines ?? []).filter((line) => state.items?.find((item) => item.id === line.itemId)?.kind === 'goods');
  if (goods.length === 0) return invoice.fulfillment === 'complete' ? 'complete' : 'not_applicable';
  const required = new Map(goods.map((line) => [line.itemId, (goods.filter((row) => row.itemId === line.itemId).reduce((sum, row) => sum + row.quantity, 0))]));
  const actual = new Map([...required.keys()].map((itemId) => [itemId, 0]));
  for (const document of state.stockDocuments ?? []) {
    if (!document.posted || document.invoiceId !== invoice.id) continue;
    for (const line of document.lines ?? []) {
      if (!actual.has(line.itemId)) continue;
      let sign = 0;
      if (invoice.direction === 'payable' && document.type === 'receipt') sign = 1;
      if (invoice.direction === 'payable' && document.type === 'supplier_return') sign = -1;
      if (invoice.direction === 'receivable' && document.type === 'shipment') sign = 1;
      if (invoice.direction === 'receivable' && document.type === 'customer_return') sign = -1;
      actual.set(line.itemId, actual.get(line.itemId) + sign * line.quantity);
    }
  }
  const fulfilled = [...required.entries()].reduce((sum, [itemId, quantity]) => sum + Math.min(actual.get(itemId), quantity), 0);
  const total = [...required.values()].reduce((sum, quantity) => sum + quantity, 0);
  if (fulfilled <= 0) return 'pending';
  if ([...required.entries()].every(([itemId, quantity]) => actual.get(itemId) >= quantity)) return 'complete';
  return 'partial';
}

export function remainingInvoiceGoodsLines(state, invoiceOrId) {
  const invoice = typeof invoiceOrId === 'string'
    ? state.invoices.find((item) => item.id === invoiceOrId)
    : invoiceOrId;
  invariant(invoice, 'Счёт не найден');
  const goodsLines = (invoice.lines ?? [])
    .filter((line) => state.items?.find((item) => item.id === line.itemId)?.kind === 'goods');
  const fulfilledByItem = new Map(goodsLines.map((line) => [line.itemId, 0]));

  for (const document of state.stockDocuments ?? []) {
    if (!document.posted || document.invoiceId !== invoice.id) continue;
    for (const line of document.lines ?? []) {
      if (!fulfilledByItem.has(line.itemId)) continue;
      let sign = 0;
      if (invoice.direction === 'payable' && document.type === 'receipt') sign = 1;
      if (invoice.direction === 'payable' && document.type === 'supplier_return') sign = -1;
      if (invoice.direction === 'receivable' && document.type === 'shipment') sign = 1;
      if (invoice.direction === 'receivable' && document.type === 'customer_return') sign = -1;
      fulfilledByItem.set(line.itemId, fulfilledByItem.get(line.itemId) + sign * line.quantity);
    }
  }

  return goodsLines.flatMap((line) => {
    const fulfilled = fulfilledByItem.get(line.itemId) ?? 0;
    const applied = Math.min(Math.max(fulfilled, 0), line.quantity);
    let remaining = line.quantity - applied;
    fulfilledByItem.set(line.itemId, fulfilled - applied);
    if (fulfilled < 0) {
      remaining += Math.abs(fulfilled);
      fulfilledByItem.set(line.itemId, 0);
    }
    return remaining > 0 ? [{ ...line, quantity: remaining }] : [];
  });
}

export function deriveInvoiceView(state, invoiceOrId, asOfDate = state.settings?.today) {
  const invoice = typeof invoiceOrId === 'string'
    ? state.invoices.find((item) => item.id === invoiceOrId)
    : invoiceOrId;
  invariant(invoice, 'Счёт не найден');
  const totals = calculateInvoiceTotals(invoice);
  const paidMinor = allocatedPaidMinor(state, invoice.id);
  const remainingMinor = Math.max(0, totals.grossMinor - paidMinor);
  const planned = plannedMinor(state, invoice.id);
  let settlement = 'unplanned';
  if (remainingMinor === 0) settlement = 'paid';
  else if (paidMinor > 0) settlement = 'partial';
  else if (planned > 0) settlement = 'planned';
  const fulfillment = deriveFulfillment(state, invoice);
  const overdue = invoice.lifecycle === 'active'
    && invoice.approval === 'approved'
    && remainingMinor > 0
    && Boolean(asOfDate)
    && invoice.dueDate < asOfDate;
  const lifecycle = invoice.lifecycle === 'cancelled' ? 'cancelled'
    : invoice.approval === 'approved' && settlement === 'paid' && ['complete', 'not_applicable'].includes(fulfillment)
      ? 'closed'
      : 'active';
  return { ...invoice, ...totals, paidMinor, remainingMinor, settlement, fulfillment, lifecycle, overdue };
}

export function materializeInvoiceStates(state, asOfDate = state.settings?.today) {
  const next = cloneState(state);
  next.invoices = next.invoices.map((invoice) => {
    const view = deriveInvoiceView(next, invoice, asOfDate);
    return { ...invoice, settlement: view.settlement, fulfillment: view.fulfillment, lifecycle: view.lifecycle };
  });
  return next;
}

export function recordPayment(state, payment, context = {}) {
  invariant(payment?.id, 'У платежа должен быть id');
  invariant(!state.payments?.some((item) => item.id === payment.id), 'Платёж уже существует');
  invariant(['inflow', 'outflow'].includes(payment.direction), 'Неизвестное направление платежа');
  invariant(['planned', 'executed', 'cancelled'].includes(payment.status), 'Неизвестное состояние платежа');
  assertDate(payment.date);
  assertMinor(payment.amountMinor);
  invariant(payment.amountMinor > 0, 'Сумма платежа должна быть положительной');
  const allocationsByInvoice = new Map();
  const allocationTotal = (payment.allocations ?? []).reduce((sum, allocation) => {
    const amountMinor = assertMinor(allocation.amountMinor, 'Сумма зачёта');
    invariant(amountMinor > 0, 'Сумма зачёта должна быть положительной');
    allocationsByInvoice.set(allocation.invoiceId, (allocationsByInvoice.get(allocation.invoiceId) ?? 0) + amountMinor);
    return sum + amountMinor;
  }, 0);
  invariant(allocationTotal <= payment.amountMinor, 'Распределено больше суммы платежа');

  for (const [invoiceId, allocatedMinor] of allocationsByInvoice) {
    const invoice = state.invoices.find((item) => item.id === invoiceId);
    invariant(invoice, `Счёт ${invoiceId} не найден`);
    invariant((payment.direction === 'outflow') === (invoice.direction === 'payable'), 'Направление платежа не соответствует счёту');
    if (payment.status === 'planned') {
      invariant(invoice.approval === 'approved', 'Планировать расчёт можно только по согласованному счёту');
      invariant(invoice.lifecycle === 'active', 'Планировать расчёт можно только по активному счёту');
    }
    if (payment.status === 'executed') {
      const remaining = calculateInvoiceTotals(invoice).grossMinor - allocatedPaidMinor(state, invoice.id);
      invariant(allocatedMinor <= remaining, `Оплата превышает остаток по счёту ${invoice.number}`);
    }
  }

  const next = cloneState(state);
  next.payments ??= [];
  next.payments.push(cloneState(payment));
  appendAudit(next, {
    id: context.eventId ?? `${payment.id}:recorded:${context.at ?? 'now'}`,
    entity: 'payment', entityId: payment.id, action: payment.status === 'executed' ? 'executed' : 'planned',
    actorId: context.actorId ?? 'demo-user', at: context.at ?? new Date().toISOString(),
  });
  return materializeInvoiceStates(next, context.asOfDate ?? next.settings?.today);
}

export function calculatePnl(state, options = {}) {
  const inventory = calculateInventory(state, { throughDate: options.to });
  const costByDocument = new Map();
  for (const movement of inventory.movements) {
    costByDocument.set(movement.sourceDocumentId, (costByDocument.get(movement.sourceDocumentId) ?? 0) + movement.totalCostMinor);
  }

  let revenueMinor = 0;
  let cogsMinor = 0;
  for (const document of state.stockDocuments ?? []) {
    if (!document.posted || !inPeriod(document.date, options.from, options.to)) continue;
    if (document.type === 'shipment' || document.type === 'customer_return') {
      const sign = document.type === 'shipment' ? 1 : -1;
      revenueMinor += sign * (document.lines ?? []).reduce((sum, line) => {
        if (!Number.isSafeInteger(line.unitPriceMinor)) return sum;
        return sum + calculateLineTotals(line).netMinor;
      }, 0);
      cogsMinor += sign * (costByDocument.get(document.id) ?? 0);
    }
  }

  let operatingExpensesMinor = 0;
  let otherIncomeMinor = 0;
  let otherExpensesMinor = 0;
  for (const entry of state.financialEntries ?? []) {
    if (!entry.posted || !inPeriod(entry.date, options.from, options.to)) continue;
    assertMinor(entry.amountMinor, 'Финансовая запись');
    if (entry.kind === 'revenue') revenueMinor += entry.amountMinor;
    else if (entry.kind === 'cogs') cogsMinor += entry.amountMinor;
    else if (entry.kind === 'operating_expense') operatingExpensesMinor += entry.amountMinor;
    else if (entry.kind === 'other_income') otherIncomeMinor += entry.amountMinor;
    else if (entry.kind === 'other_expense') otherExpensesMinor += entry.amountMinor;
  }
  const grossProfitMinor = revenueMinor - cogsMinor;
  const operatingProfitMinor = grossProfitMinor - operatingExpensesMinor;
  const netProfitMinor = operatingProfitMinor + otherIncomeMinor - otherExpensesMinor;
  return { revenueMinor, cogsMinor, grossProfitMinor, operatingExpensesMinor, operatingProfitMinor, otherIncomeMinor, otherExpensesMinor, netProfitMinor };
}

export function calculateCashFlow(state, options = {}) {
  const from = options.from;
  const to = options.to;
  let openingMinor = options.openingCashMinor ?? state.settings?.openingCashMinor ?? 0;
  const categories = {
    operating: { inflowMinor: 0, outflowMinor: 0, netMinor: 0 },
    investing: { inflowMinor: 0, outflowMinor: 0, netMinor: 0 },
    financing: { inflowMinor: 0, outflowMinor: 0, netMinor: 0 },
  };
  for (const payment of state.payments ?? []) {
    if (payment.status !== 'executed') continue;
    assertMinor(payment.amountMinor);
    const sign = payment.direction === 'inflow' ? 1 : -1;
    if (from && payment.date < from) {
      openingMinor += sign * payment.amountMinor;
      continue;
    }
    if (!inPeriod(payment.date, from, to)) continue;
    const group = categories[payment.cashflowCategory] ?? categories.operating;
    if (payment.direction === 'inflow') group.inflowMinor += payment.amountMinor;
    else group.outflowMinor += payment.amountMinor;
  }
  for (const group of Object.values(categories)) group.netMinor = group.inflowMinor - group.outflowMinor;
  const inflowMinor = Object.values(categories).reduce((sum, group) => sum + group.inflowMinor, 0);
  const outflowMinor = Object.values(categories).reduce((sum, group) => sum + group.outflowMinor, 0);
  const netMinor = inflowMinor - outflowMinor;
  return { openingMinor, categories, inflowMinor, outflowMinor, netMinor, closingMinor: openingMinor + netMinor };
}

export function buildPaymentCalendar(state, options) {
  const { from, to } = options;
  const dates = dateRange(from, to);
  const eventMap = new Map(dates.map((date) => [date, []]));
  const plannedByInvoice = new Map();
  const opening = calculateCashFlow(state, { from, to: from < to ? from : to, openingCashMinor: options.openingCashMinor }).openingMinor;

  function addEvent(event) {
    if (eventMap.has(event.date)) eventMap.get(event.date).push(event);
  }

  for (const payment of state.payments ?? []) {
    if (payment.status === 'executed') {
      addEvent({ id: payment.id, date: payment.date, direction: payment.direction, amountMinor: payment.amountMinor, status: 'executed' });
      continue;
    }
    if (payment.status !== 'planned') continue;
    let allowedAmount = 0;
    for (const allocation of payment.allocations ?? []) {
      const invoice = state.invoices.find((item) => item.id === allocation.invoiceId);
      if (!invoice) continue;
      const expectedDirection = invoice.direction === 'payable' ? 'outflow' : 'inflow';
      if (payment.direction !== expectedDirection || invoice.approval !== 'approved' || invoice.lifecycle !== 'active') continue;
      const remainingMinor = deriveInvoiceView(state, invoice, options.asOfDate ?? from).remainingMinor;
      const alreadyPlannedMinor = plannedByInvoice.get(invoice.id) ?? 0;
      const allowedAllocationMinor = Math.min(
        allocation.amountMinor,
        Math.max(0, remainingMinor - alreadyPlannedMinor),
      );
      allowedAmount += allowedAllocationMinor;
      plannedByInvoice.set(invoice.id, alreadyPlannedMinor + allowedAllocationMinor);
    }
    if ((payment.allocations ?? []).length === 0) allowedAmount = payment.amountMinor;
    if (allowedAmount > 0) {
      const eventDate = payment.date < from ? from : payment.date;
      addEvent({
        id: payment.id,
        date: eventDate,
        originalDate: payment.date,
        direction: payment.direction,
        amountMinor: allowedAmount,
        status: payment.date < (options.asOfDate ?? from) ? 'overdue' : 'planned',
      });
    }
  }

  for (const invoice of state.invoices ?? []) {
    if (invoice.lifecycle !== 'active' || invoice.approval !== 'approved') continue;
    const remainingMinor = deriveInvoiceView(state, invoice, options.asOfDate ?? from).remainingMinor;
    const uncoveredMinor = Math.max(0, remainingMinor - (plannedByInvoice.get(invoice.id) ?? 0));
    if (uncoveredMinor > 0) {
      const eventDate = invoice.dueDate < from ? from : invoice.dueDate;
      addEvent({
        id: `invoice-plan:${invoice.id}`,
        invoiceId: invoice.id,
        date: eventDate,
        originalDueDate: invoice.dueDate,
        direction: invoice.direction === 'payable' ? 'outflow' : 'inflow',
        amountMinor: uncoveredMinor,
        status: invoice.dueDate < (options.asOfDate ?? from) ? 'overdue' : 'planned',
      });
    }
  }

  let running = opening;
  const minimumCashMinor = options.minimumCashMinor ?? state.settings?.minimumCashMinor ?? 0;
  const rows = dates.map((date) => {
    const events = eventMap.get(date);
    const inflowMinor = events.filter((event) => event.direction === 'inflow').reduce((sum, event) => sum + event.amountMinor, 0);
    const outflowMinor = events.filter((event) => event.direction === 'outflow').reduce((sum, event) => sum + event.amountMinor, 0);
    const row = { date, openingMinor: running, inflowMinor, outflowMinor, netMinor: inflowMinor - outflowMinor, events };
    running += row.netMinor;
    row.closingMinor = running;
    row.cashGap = running < minimumCashMinor;
    return row;
  });
  return { openingMinor: opening, closingMinor: running, minimumCashMinor, hasCashGap: rows.some((row) => row.cashGap), rows };
}
