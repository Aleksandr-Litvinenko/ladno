import { createStore } from './src/store.js?v=0.1.0-r2';
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
  rejectInvoice,
  remainingInvoiceGoodsLines,
  submitInvoiceForReview,
} from './src/domain.js?v=0.1.0-r2';
import { createODataEnvelope, upsertODataEnvelopes } from './src/odata.js?v=0.1.0-r2';

const store = createStore();
const viewRoot = document.querySelector('[data-view]');
const detailDialog = document.querySelector('[data-detail-dialog]');
const createDialog = document.querySelector('[data-create-dialog]');
const navigationDialog = document.querySelector('[data-navigation-dialog]');
const searchDialog = document.querySelector('[data-search-dialog]');
const liveStatus = document.querySelector('[data-live-status]');
const alertStatus = document.querySelector('[data-alert-status]');
const toastRegion = document.querySelector('[data-toast-region]');
const createForm = document.querySelector('[data-create-form]');
const createType = document.querySelector('[data-create-type]');
let currentDetailId = null;
let lastDialogTrigger = null;
let operationBusy = false;
let activeFilter = { query: '', status: 'all' };

const NAVIGATION = [
  {
    label: 'Операции',
    items: [
      ['overview', '01', 'Обзор'],
      ['supplier-invoices', '02', 'Счета поставщикам'],
      ['customer-invoices', '03', 'Счета покупателям'],
      ['warehouse', '04', 'Склад'],
    ],
  },
  {
    label: 'Финансы',
    items: [
      ['finance-pnl', '05', 'P&L'],
      ['finance-cashflow', '06', 'Cash Flow'],
      ['finance-calendar', '07', 'Платёжный календарь'],
      ['integration', '08', 'Обмен с 1С'],
    ],
  },
];

const VIEW_TITLES = {
  overview: 'Обзор',
  'supplier-invoices': 'Счета поставщикам',
  'customer-invoices': 'Счета покупателям',
  warehouse: 'Склад',
  'finance-pnl': 'P&L',
  'finance-cashflow': 'Cash Flow',
  'finance-calendar': 'Платёжный календарь',
  integration: 'Обмен с 1С',
};

const APPROVAL_LABELS = {
  draft: ['Черновик', 'neutral'],
  review: ['На согласовании', 'warning'],
  approved: ['Согласован', 'success'],
  rejected: ['Отклонён', 'danger'],
};

const FULFILLMENT_LABELS = {
  pending: ['Не исполнен', 'neutral'],
  partial: ['Исполнен частично', 'warning'],
  complete: ['Исполнен', 'success'],
  not_applicable: ['Без склада', 'info'],
};

const SETTLEMENT_LABELS = {
  unplanned: ['Не запланирован', 'neutral'],
  planned: ['В календаре', 'info'],
  partial: ['Оплачен частично', 'warning'],
  paid: ['Оплачен', 'success'],
};

const PAYMENT_EVENT_LABELS = {
  executed: 'Исполнено',
  planned: 'Запланировано',
  overdue: 'Просрочено',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMoney(minor, options = {}) {
  const value = Number(minor ?? 0) / 100;
  return new Intl.NumberFormat('ru-RU', {
    style: options.plain ? 'decimal' : 'currency',
    currency: 'RUB',
    minimumFractionDigits: options.cents === false ? 0 : 2,
    maximumFractionDigits: options.cents === false ? 0 : 2,
  }).format(value);
}

function formatDate(value, options = {}) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', options.short
    ? { day: '2-digit', month: '2-digit', year: '2-digit' }
    : { day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(`${value}T12:00:00`));
}

function countLabel(value, forms) {
  const absolute = Math.abs(Number(value));
  const lastTwo = absolute % 100;
  const last = absolute % 10;
  const form = lastTwo >= 11 && lastTwo <= 14
    ? forms[2]
    : last === 1
      ? forms[0]
      : last >= 2 && last <= 4
        ? forms[1]
        : forms[2];
  return `${new Intl.NumberFormat('ru-RU').format(value)} ${form}`;
}

function parseMoney(value) {
  const normalized = String(value ?? '').replace(/\s/g, '').replace(',', '.');
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Введите положительную сумму');
  const minor = Math.round(amount * 100);
  if (!Number.isSafeInteger(minor)) throw new Error('Сумма слишком велика');
  return minor;
}

function parseQuantity(value) {
  const quantity = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Количество должно быть положительным');
  return quantity;
}

function counterpartyName(state, invoice) {
  return state.counterparties.find((item) => item.id === invoice.counterpartyId)?.name ?? invoice.counterpartyName ?? 'Контрагент не указан';
}

function itemName(state, itemId) {
  return state.items.find((item) => item.id === itemId)?.name ?? itemId;
}

function warehouseName(state, warehouseId) {
  return state.warehouses.find((item) => item.id === warehouseId)?.name ?? warehouseId;
}

function badge(label, tone = 'neutral') {
  return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
}

function stateBadge(dictionary, value) {
  const [label, tone] = dictionary[value] ?? [value, 'neutral'];
  return badge(label, tone);
}

function invoiceBadges(view) {
  return `<span class="status-stack">
    ${stateBadge(APPROVAL_LABELS, view.approval)}
    ${stateBadge(FULFILLMENT_LABELS, view.fulfillment)}
    ${stateBadge(SETTLEMENT_LABELS, view.settlement)}
    ${view.overdue ? badge('Просрочен', 'danger') : ''}
  </span>`;
}

function uniqueId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function routeFromHash() {
  const value = location.hash.replace(/^#/, '').split('?')[0];
  return VIEW_TITLES[value] ? value : 'overview';
}

function navMarkup(route) {
  return NAVIGATION.map((group) => `<div class="nav-group">
    <p class="nav-label">${escapeHtml(group.label)}</p>
    ${group.items.map(([id, icon, label]) => `<a class="nav-link" href="#${id}" ${route === id ? 'aria-current="page"' : ''}>
      <span class="nav-icon" aria-hidden="true">${icon}</span>
      <span>${escapeHtml(label)}</span>
    </a>`).join('')}
  </div>`).join('');
}

function renderNavigation(route) {
  const markup = navMarkup(route);
  document.querySelector('[data-primary-nav]').innerHTML = markup;
  document.querySelector('[data-mobile-nav]').innerHTML = markup;
}

function pageHeader(kicker, title, description, actions = '') {
  return `<header class="page-header">
    <div>
      <p class="kicker">${escapeHtml(kicker)}</p>
      <h1 tabindex="-1">${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      <span class="freshness">Синтетические данные · сохранение в этом браузере</span>
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </header>`;
}

function metricCard(label, value, note, tone = '') {
  return `<article class="metric-card">
    <span class="metric-label">${escapeHtml(label)}</span>
    <strong class="metric-value">${escapeHtml(value)}</strong>
    <span class="metric-note ${tone}">${escapeHtml(note)}</span>
  </article>`;
}

function invoicesWithView(state, direction) {
  return state.invoices
    .filter((invoice) => invoice.direction === direction)
    .map((invoice) => deriveInvoiceView(state, invoice, state.settings.today));
}

function renderOverview(state) {
  const payable = invoicesWithView(state, 'payable')
    .filter((invoice) => invoice.lifecycle === 'active' && ['review', 'approved'].includes(invoice.approval));
  const receivable = invoicesWithView(state, 'receivable')
    .filter((invoice) => invoice.lifecycle === 'active' && ['review', 'approved'].includes(invoice.approval));
  const inventory = calculateInventory(state);
  const cash = calculateCashFlow(state, { from: '2026-08-01', to: '2026-08-31' });
  const calendar = buildPaymentCalendar(state, { from: '2026-08-09', to: '2026-08-21' });
  const payableMinor = payable.reduce((sum, item) => sum + item.remainingMinor, 0);
  const receivableMinor = receivable.reduce((sum, item) => sum + item.remainingMinor, 0);
  const stockMinor = inventory.balances.reduce((sum, item) => sum + item.valueMinor, 0);
  const decisions = [...payable, ...receivable].filter((invoice) => invoice.approval === 'review');
  const alerts = [];
  if (calendar.hasCashGap) alerts.push(['Кассовый разрыв', 'Прогноз опускается ниже минимального остатка.']);
  for (const invoice of [...payable, ...receivable].filter((item) => item.overdue)) {
    alerts.push([`Просрочен счёт № ${invoice.number}`, `${counterpartyName(state, invoice)} · ${formatMoney(invoice.remainingMinor)}`]);
  }

  return `${pageHeader('Рабочий стол', 'Что требует внимания', 'Счета, склад и деньги в одном управленческом контуре.', '<button class="button button-primary" type="button" data-open-create>+ Создать документ</button>')}
    <section class="metric-grid" aria-label="Ключевые показатели">
      ${metricCard('К оплате поставщикам', formatMoney(payableMinor), countLabel(payable.length, ['документ', 'документа', 'документов']), payableMinor ? 'negative' : 'positive')}
      ${metricCard('Ожидаем от покупателей', formatMoney(receivableMinor), countLabel(receivable.length, ['документ', 'документа', 'документов']), receivableMinor ? 'positive' : '')}
      ${metricCard('Запас по себестоимости', formatMoney(stockMinor), countLabel(inventory.balances.filter((item) => item.quantity > 0).length, ['позиция', 'позиции', 'позиций']), 'positive')}
      ${metricCard('Денежный остаток', formatMoney(cash.closingMinor), 'Факт на конец августа', cash.closingMinor >= state.settings.minimumCashMinor ? 'positive' : 'negative')}
    </section>
    <div class="dashboard-grid">
      <section class="panel" aria-labelledby="decisions-title">
        <div class="panel-head"><div><h2 id="decisions-title">Решения сегодня</h2><p class="panel-description">Документы на текущем этапе согласования.</p></div></div>
        <div class="panel-body">
          ${decisions.length ? `<ul class="decision-list">${decisions.map((invoice) => `<li class="decision-item">
            <span class="document-symbol" aria-hidden="true">${invoice.direction === 'payable' ? 'СП' : 'СПК'}</span>
            <span class="decision-copy"><b>№ ${escapeHtml(invoice.number)} · ${escapeHtml(counterpartyName(state, invoice))}</b><small>${invoice.direction === 'payable' ? 'Счёт поставщика' : 'Счёт покупателю'} · до ${formatDate(invoice.dueDate, { short: true })}</small></span>
            <span class="money">${formatMoney(invoice.grossMinor)}</span>
            <button class="text-button" type="button" data-open-invoice="${escapeHtml(invoice.id)}">Открыть</button>
          </li>`).join('')}</ul>` : '<div class="empty-state"><div><h2>Очередь пуста</h2><p>Документов на согласовании сейчас нет.</p></div></div>'}
        </div>
      </section>
      <aside class="panel" aria-labelledby="alerts-title">
        <div class="panel-head"><h2 id="alerts-title">Контрольные сигналы</h2></div>
        <div class="panel-body">
          ${alerts.length ? `<ul class="alert-list">${alerts.map(([title, copy], index) => `<li class="alert-item"><span aria-hidden="true">${index + 1}</span><span><b>${escapeHtml(title)}</b><small>${escapeHtml(copy)}</small></span></li>`).join('')}</ul>` : '<p class="panel-description">Критических отклонений не найдено.</p>'}
        </div>
      </aside>
    </div>`;
}

function renderInvoiceRegistry(state, direction) {
  const isPayable = direction === 'payable';
  const all = invoicesWithView(state, direction);
  const query = activeFilter.query.toLocaleLowerCase('ru');
  const filtered = all.filter((invoice) => {
    const haystack = `${invoice.number} ${counterpartyName(state, invoice)} ${invoice.purpose ?? ''}`.toLocaleLowerCase('ru');
    const matchesQuery = !query || haystack.includes(query);
    const matchesStatus = activeFilter.status === 'all'
      || invoice.approval === activeFilter.status
      || invoice.settlement === activeFilter.status
      || (activeFilter.status === 'overdue' && invoice.overdue);
    return matchesQuery && matchesStatus;
  });
  const total = all.reduce((sum, item) => sum + item.grossMinor, 0);
  const remaining = all.reduce((sum, item) => sum + item.remainingMinor, 0);

  return `${pageHeader('Документы', isPayable ? 'Счета поставщикам' : 'Счета покупателям', isPayable
    ? 'Контролируйте согласование, поступление и оплату независимо друг от друга.'
    : 'Контролируйте согласование, отгрузку и получение денег независимо друг от друга.', '<button class="button button-primary" type="button" data-open-create>+ Новый счёт</button>')}
    <section class="metric-grid" aria-label="Итоги реестра">
      ${metricCard('Документов', String(all.length), 'В текущем демо-контуре')}
      ${metricCard('Общая сумма', formatMoney(total), 'С НДС')}
      ${metricCard(isPayable ? 'Осталось оплатить' : 'Осталось получить', formatMoney(remaining), 'С учётом факта', remaining ? (isPayable ? 'negative' : 'positive') : 'positive')}
      ${metricCard('На согласовании', String(all.filter((item) => item.approval === 'review').length), 'Требуют решения')}
    </section>
    <section class="section-block" aria-labelledby="registry-title">
      <div class="section-head"><div><h2 id="registry-title">Реестр</h2><p>${filtered.length} из ${countLabel(all.length, ['документа', 'документов', 'документов'])}</p></div></div>
      <form class="filter-bar" data-filter-form>
        <label for="registry-query">Поиск</label>
        <input id="registry-query" name="query" type="search" placeholder="Номер или контрагент" value="${escapeHtml(activeFilter.query)}">
        <label for="registry-status">Статус</label>
        <select id="registry-status" name="status">
          ${[['all', 'Все статусы'], ['review', 'На согласовании'], ['approved', 'Согласован'], ['partial', 'Частичная оплата'], ['paid', 'Оплачен'], ['overdue', 'Просрочен']].map(([value, label]) => `<option value="${value}" ${activeFilter.status === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        <button class="button button-secondary" type="submit">Применить</button>
      </form>
      <div class="table-wrap">
        <table class="data-table">
          <caption>${isPayable ? 'Счета поставщиков' : 'Счета покупателей'} и независимые состояния документа</caption>
          <thead><tr><th scope="col">Документ</th><th scope="col">Контрагент</th><th scope="col">Срок</th><th scope="col">Состояния</th><th scope="col">Сумма</th><th scope="col">Остаток</th><th scope="col">Действие</th></tr></thead>
          <tbody>${filtered.length ? filtered.map((invoice) => `<tr>
            <th scope="row"><span class="table-primary">№ ${escapeHtml(invoice.number)}</span><span class="table-secondary">от ${formatDate(invoice.date, { short: true })}</span></th>
            <td><span class="table-primary">${escapeHtml(counterpartyName(state, invoice))}</span><span class="table-secondary">${escapeHtml(invoice.purpose ?? (isPayable ? 'Закупка' : 'Продажа'))}</span></td>
            <td>${formatDate(invoice.dueDate, { short: true })}</td>
            <td>${invoiceBadges(invoice)}</td>
            <td class="money">${formatMoney(invoice.grossMinor)}</td>
            <td class="money">${formatMoney(invoice.remainingMinor)}</td>
            <td><button class="text-button" type="button" data-open-invoice="${escapeHtml(invoice.id)}">Карточка</button></td>
          </tr>`).join('') : '<tr><td class="table-empty" colspan="7">По выбранным условиям документов нет.</td></tr>'}</tbody>
        </table>
      </div>
    </section>`;
}

function renderWarehouse(state) {
  const inventory = calculateInventory(state);
  const balances = inventory.balances.filter((balance) => Math.abs(balance.quantity) > 1e-9);
  const totalValue = balances.reduce((sum, item) => sum + item.valueMinor, 0);
  const totalUnits = balances.reduce((sum, item) => sum + item.quantity, 0);
  const lowStock = inventory.balances.filter((item) => item.quantity <= 5).length;
  return `${pageHeader('Операционный контур', 'Склад', 'Остатки меняются только после проведения поступления или отгрузки.', '<button class="button button-primary" type="button" data-open-create>+ Складская операция</button>')}
    <section class="stock-summary" aria-label="Итоги склада">
      ${metricCard('Стоимость запаса', formatMoney(totalValue), 'По средневзвешенной себестоимости')}
      ${metricCard('Количество', new Intl.NumberFormat('ru-RU').format(totalUnits), countLabel(balances.length, ['складская позиция', 'складские позиции', 'складских позиций']))}
      ${metricCard('Низкий остаток', String(lowStock), 'Пять единиц или меньше', lowStock ? 'negative' : 'positive')}
    </section>
    <section class="panel" aria-labelledby="stock-title">
      <div class="panel-head"><div><h2 id="stock-title">Остатки по складам</h2><p class="panel-description">Отрицательный доступный остаток запрещён доменным ядром.</p></div></div>
      <div class="table-wrap">
        <table class="data-table"><caption>Текущие остатки и себестоимость</caption>
          <thead><tr><th scope="col">Номенклатура</th><th scope="col">Склад</th><th scope="col">Количество</th><th scope="col">Средняя цена</th><th scope="col">Стоимость</th></tr></thead>
          <tbody>${balances.map((balance) => `<tr><th scope="row"><span class="table-primary">${escapeHtml(itemName(state, balance.itemId))}</span><span class="table-secondary">${escapeHtml(state.items.find((item) => item.id === balance.itemId)?.sku ?? '')}</span></th><td>${escapeHtml(warehouseName(state, balance.warehouseId))}</td><td class="money">${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(balance.quantity)}</td><td class="money">${formatMoney(balance.averageCostMinor)}</td><td class="money">${formatMoney(balance.valueMinor)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </section>
    <section class="panel section-block" aria-labelledby="movement-title">
      <div class="panel-head"><h2 id="movement-title">Последние движения</h2></div>
      <div class="table-wrap"><table class="data-table"><caption>Проведённые движения склада</caption><thead><tr><th scope="col">Дата</th><th scope="col">Операция</th><th scope="col">Номенклатура</th><th scope="col">Склад</th><th scope="col">Количество</th><th scope="col">Себестоимость</th></tr></thead><tbody>
        ${inventory.movements.slice().reverse().map((movement) => `<tr><td>${formatDate(movement.date, { short: true })}</td><td>${movement.direction === 'in' ? badge('Поступление', 'success') : badge('Отгрузка', 'warning')}</td><th scope="row">${escapeHtml(itemName(state, movement.itemId))}</th><td>${escapeHtml(warehouseName(state, movement.warehouseId))}</td><td class="money">${movement.quantity > 0 ? '+' : ''}${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(movement.quantity)}</td><td class="money">${formatMoney(movement.totalCostMinor)}</td></tr>`).join('')}
      </tbody></table></div>
    </section>`;
}

function financeTabs(route) {
  return `<nav class="report-tabs" aria-label="Финансовые отчёты">
    <a href="#finance-pnl" ${route === 'finance-pnl' ? 'aria-current="page"' : ''}>P&L</a>
    <a href="#finance-cashflow" ${route === 'finance-cashflow' ? 'aria-current="page"' : ''}>Cash Flow</a>
    <a href="#finance-calendar" ${route === 'finance-calendar' ? 'aria-current="page"' : ''}>Платёжный календарь</a>
  </nav>`;
}

function statementRow(label, value, total = false) {
  return `<div class="statement-row ${total ? 'is-total' : ''}"><dt>${escapeHtml(label)}</dt><dd>${formatMoney(value)}</dd></div>`;
}

function renderPnl(state) {
  const pnl = calculatePnl(state, { from: '2026-08-01', to: '2026-08-31' });
  return `${pageHeader('Управленческие отчёты', 'P&L · август 2026', 'Отчёт по начислению: деньги и прибыль признаются в разные моменты.')}
    ${financeTabs('finance-pnl')}
    <section class="report-grid" aria-label="Итоги P&L">
      ${metricCard('Выручка', formatMoney(pnl.revenueMinor), 'Без НДС', 'positive')}
      ${metricCard('Валовая прибыль', formatMoney(pnl.grossProfitMinor), 'Выручка минус себестоимость', pnl.grossProfitMinor >= 0 ? 'positive' : 'negative')}
      ${metricCard('Операционная прибыль', formatMoney(pnl.operatingProfitMinor), 'После операционных расходов', pnl.operatingProfitMinor >= 0 ? 'positive' : 'negative')}
    </section>
    <section class="panel section-block"><div class="panel-head"><h2>Отчёт о прибылях и убытках</h2></div><div class="panel-body"><dl class="statement">
      ${statementRow('Выручка', pnl.revenueMinor)}${statementRow('Себестоимость продаж', -pnl.cogsMinor)}${statementRow('Валовая прибыль', pnl.grossProfitMinor, true)}${statementRow('Операционные расходы', -pnl.operatingExpensesMinor)}${statementRow('Операционная прибыль', pnl.operatingProfitMinor, true)}${statementRow('Прочие доходы', pnl.otherIncomeMinor)}${statementRow('Прочие расходы', -pnl.otherExpensesMinor)}${statementRow('Чистая управленческая прибыль', pnl.netProfitMinor, true)}
    </dl><p class="report-note">Это управленческий, а не регламентированный бухгалтерский отчёт. Товарная выручка возникает при отгрузке, услуги отражаются отдельной финансовой записью, себестоимость — при выбытии товара; платежи сами по себе P&L не меняют.</p></div></section>`;
}

function renderCashFlow(state) {
  const cash = calculateCashFlow(state, { from: '2026-08-01', to: '2026-08-31' });
  return `${pageHeader('Управленческие отчёты', 'Cash Flow · август 2026', 'Только исполненные банковские и кассовые платежи.')}
    ${financeTabs('finance-cashflow')}
    <section class="report-grid" aria-label="Итоги Cash Flow">
      ${metricCard('Начальный остаток', formatMoney(cash.openingMinor), 'На начало периода')}
      ${metricCard('Чистый поток', formatMoney(cash.netMinor), `${formatMoney(cash.inflowMinor)} входящих · ${formatMoney(cash.outflowMinor)} исходящих`, cash.netMinor >= 0 ? 'positive' : 'negative')}
      ${metricCard('Конечный остаток', formatMoney(cash.closingMinor), 'На конец периода', cash.closingMinor >= 0 ? 'positive' : 'negative')}
    </section>
    <section class="panel section-block"><div class="panel-head"><h2>Движение денежных средств</h2></div><div class="panel-body"><dl class="statement">
      ${statementRow('Операционная деятельность', cash.categories.operating.netMinor)}
      ${statementRow('Инвестиционная деятельность', cash.categories.investing.netMinor)}
      ${statementRow('Финансовая деятельность', cash.categories.financing.netMinor)}
      ${statementRow('Чистое изменение денежных средств', cash.netMinor, true)}
      ${statementRow('Денежные средства на конец периода', cash.closingMinor, true)}
    </dl><p class="report-note">Плановые платежи сюда не попадают: они отражаются только в платёжном календаре.</p></div></section>`;
}

function renderPaymentCalendar(state) {
  const calendar = buildPaymentCalendar(state, { from: '2026-08-09', to: '2026-08-21' });
  const periodIn = calendar.rows.reduce((sum, row) => sum + row.inflowMinor, 0);
  const periodOut = calendar.rows.reduce((sum, row) => sum + row.outflowMinor, 0);
  return `${pageHeader('Управленческие отчёты', 'Платёжный календарь', 'Прогноз поступлений, выплат и возможных кассовых разрывов.')}
    ${financeTabs('finance-calendar')}
    <section class="report-grid" aria-label="Итоги календаря">
      ${metricCard('Поступления за период', formatMoney(periodIn), 'Факт и ожидаемые оплаты', 'positive')}
      ${metricCard('Выплаты за период', formatMoney(periodOut), 'Факт и согласованные планы', 'negative')}
      ${metricCard('Прогнозный остаток', formatMoney(calendar.closingMinor), calendar.hasCashGap ? 'Есть кассовый разрыв' : 'Ниже лимита не опускается', calendar.hasCashGap ? 'negative' : 'positive')}
    </section>
    <section class="panel section-block"><div class="panel-head"><div><h2>По дням</h2><p class="panel-description">Минимальный остаток: ${formatMoney(calendar.minimumCashMinor)}</p></div></div><div class="panel-body"><ol class="calendar-list">
      ${calendar.rows.map((row) => `<li class="calendar-day ${row.cashGap ? 'has-gap' : ''}">
        <span class="calendar-date"><b>${formatDate(row.date, { short: true })}</b><small>${countLabel(row.events.length, ['событие', 'события', 'событий'])}</small></span>
        <span class="calendar-event">${row.events.length ? row.events.map((event) => event.invoiceId ? `счёт ${escapeHtml(event.invoiceId.split('-').pop())}` : escapeHtml(PAYMENT_EVENT_LABELS[event.status] ?? event.status)).join(', ') : 'Нет операций'}</span>
        <span class="calendar-number inflow"><small>Приход</small><b>${formatMoney(row.inflowMinor)}</b></span>
        <span class="calendar-number outflow"><small>Расход</small><b>${formatMoney(row.outflowMinor)}</b></span>
        <span class="calendar-number balance"><small>Остаток</small><b>${formatMoney(row.closingMinor)}</b></span>
      </li>`).join('')}
    </ol></div></section>`;
}

function renderIntegration(state) {
  const lastRun = state.syncRuns.at(-1);
  return `${pageHeader('Интеграция', 'Обмен с 1С по OData', 'Контракт и сопоставление готовы; рабочие логины и пароль никогда не попадают в браузер.')}
    <section class="integration-grid">
      <article class="integration-card"><h2>Режим</h2><strong class="integration-value">Только чтение</strong><p>Запись, проведение и удаление объектов 1С в версии 0.1.0 выключены.</p></article>
      <article class="integration-card"><h2>Импортировано</h2><strong class="integration-value">${state.odataRecords.length}</strong><p>Нормализованных записей с устойчивым ключом источника.</p></article>
      <article class="integration-card"><h2>Последний запуск</h2><strong class="integration-value">${lastRun ? formatDate(lastRun.date, { short: true }) : 'Не запускался'}</strong><p>${lastRun ? `${lastRun.inserted} добавлено · ${lastRun.unchanged} без изменений` : 'Доступен безопасный тест на синтетических данных.'}</p></article>
      <article class="integration-card is-wide"><h2>Серверный контур</h2><p>Настоящий обмен должен работать по схеме: браузер → API Ladno → OData‑адаптер → HTTPS OData 1С. Сначала адаптер получает <code>$metadata</code>, затем пользователь сопоставляет объекты конкретной конфигурации.</p><pre class="code-block" tabindex="0"><code>GET https://host/base/odata/standard.odata/$metadata
GET .../Catalog_Контрагенты?$select=Ref_Key,Description,DataVersion
GET .../Document_...?$filter=Date ge datetime'2026-08-01'</code></pre><div class="integration-actions"><button class="button button-primary" type="button" data-simulate-odata>Импортировать тестовые записи</button><button class="button button-secondary" type="button" data-export-odata>Выгрузить снимок JSON</button></div></article>
      <article class="integration-card"><h2>Сопоставление</h2><p>Имена наборов зависят от конфигурации 1С и подтверждаются по реальному <code>$metadata</code>.</p><div class="integration-actions"><a class="button button-secondary" href="https://github.com/Aleksandr-Litvinenko/ladno/blob/main/docs/ODATA-1C.md">Документация</a></div></article>
    </section>
    <section class="panel section-block"><div class="panel-head"><h2>Предлагаемые сущности</h2></div><div class="table-wrap"><table class="data-table"><caption>Кандидаты для ручного сопоставления после чтения $metadata</caption><thead><tr><th scope="col">Домен Ladno</th><th scope="col">Возможный набор 1С</th><th scope="col">Режим v0.1.0</th></tr></thead><tbody>
      ${[['Контрагенты', 'Catalog_Контрагенты'], ['Номенклатура', 'Catalog_Номенклатура'], ['Склады', 'Catalog_Склады'], ['Счета поставщиков', 'Document_*Счет*Поставщик*'], ['Счета покупателей', 'Document_*Счет*Покупател*'], ['Остатки', 'AccumulationRegister_*_Balance']].map(([domain, entity]) => `<tr><th scope="row">${domain}</th><td><code>${entity}</code></td><td>${badge('Чтение', 'info')}</td></tr>`).join('')}
    </tbody></table></div></section>
    <section class="panel section-block"><div class="panel-head"><div><h2>Демонстрационные данные</h2><p class="panel-description">Сброс удалит только состояние Ladno из localStorage этого браузера.</p></div><button class="button button-danger" type="button" data-reset-demo>Сбросить демо</button></div></section>`;
}

function renderCurrent(options = {}) {
  const route = routeFromHash();
  const state = store.getState();
  renderNavigation(route);
  document.title = `${VIEW_TITLES[route]} · Ladno`;
  try {
    if (route === 'overview') viewRoot.innerHTML = renderOverview(state);
    else if (route === 'supplier-invoices') viewRoot.innerHTML = renderInvoiceRegistry(state, 'payable');
    else if (route === 'customer-invoices') viewRoot.innerHTML = renderInvoiceRegistry(state, 'receivable');
    else if (route === 'warehouse') viewRoot.innerHTML = renderWarehouse(state);
    else if (route === 'finance-pnl') viewRoot.innerHTML = renderPnl(state);
    else if (route === 'finance-cashflow') viewRoot.innerHTML = renderCashFlow(state);
    else if (route === 'finance-calendar') viewRoot.innerHTML = renderPaymentCalendar(state);
    else viewRoot.innerHTML = renderIntegration(state);
  } catch (error) {
    viewRoot.innerHTML = `${pageHeader('Системное сообщение', 'Не удалось построить экран', 'Демонстрационные данные можно сбросить без риска для внешних систем.')}<div class="error-state"><div><h2>Ошибка расчёта</h2><p>${escapeHtml(error.message)}</p><button class="button button-secondary" type="button" data-reset-demo>Сбросить демо</button></div></div>`;
  }
  if (options.focus) viewRoot.querySelector('h1')?.focus();
}

function workflowSteps(invoice) {
  const payable = invoice.direction === 'payable';
  const labels = payable
    ? ['Создан', 'Финансовая проверка', 'Руководитель', 'Оплата поставщику']
    : ['Создан', 'Коммерческая проверка', 'Финансовая проверка', 'Оплата покупателя'];
  let completeCount = 1;
  if (invoice.approval === 'review') completeCount = 2;
  if (invoice.approval === 'approved') completeCount = invoice.settlement === 'paid' ? 4 : 3;
  if (invoice.approval === 'rejected') completeCount = 1;
  return labels.map((label, index) => ({ label, state: index < completeCount ? 'complete' : index === completeCount ? 'current' : 'pending' }));
}

function invoiceAudit(state, invoice) {
  const events = state.auditEvents.filter((event) => event.entityId === invoice.id);
  if (!events.length) return '<li><time>09.08</time><span>Документ загружен в демонстрационный контур.</span></li>';
  const actions = { submitted_for_review: 'Отправлен на согласование', approved: 'Согласован', rejected: 'Отклонён' };
  return events.slice().reverse().map((event) => `<li><time>${escapeHtml(new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(event.at)))}</time><span>${escapeHtml(actions[event.action] ?? event.action)}</span></li>`).join('');
}

function openInvoice(invoiceId, trigger = document.activeElement) {
  const state = store.getState();
  const invoice = state.invoices.find((item) => item.id === invoiceId);
  if (!invoice) return;
  const view = deriveInvoiceView(state, invoice, state.settings.today);
  currentDetailId = invoiceId;
  lastDialogTrigger = trigger;
  const totals = calculateInvoiceTotals(invoice);
  document.querySelector('[data-detail-heading]').innerHTML = `<p class="kicker">${invoice.direction === 'payable' ? 'Счёт поставщика' : 'Счёт покупателю'}</p><h2 id="detail-title">№ ${escapeHtml(invoice.number)} · ${escapeHtml(counterpartyName(state, invoice))}</h2>`;
  document.querySelector('[data-detail-body]').innerHTML = `<dl class="detail-summary">
      <div><dt>Дата</dt><dd>${formatDate(invoice.date)}</dd></div><div><dt>Срок оплаты</dt><dd>${formatDate(invoice.dueDate)}</dd></div><div><dt>Сумма с НДС</dt><dd>${formatMoney(totals.grossMinor)}</dd></div><div><dt>НДС</dt><dd>${formatMoney(totals.vatMinor)}</dd></div><div><dt>Оплачено</dt><dd>${formatMoney(view.paidMinor)}</dd></div><div><dt>Осталось</dt><dd>${formatMoney(view.remainingMinor)}</dd></div>
    </dl>
    <div class="workflow-grid">
      <article class="workflow-card"><h3>Согласование</h3><div>${stateBadge(APPROVAL_LABELS, view.approval)}</div></article>
      <article class="workflow-card"><h3>${invoice.direction === 'payable' ? 'Поступление' : 'Отгрузка'}</h3><div>${stateBadge(FULFILLMENT_LABELS, view.fulfillment)}</div></article>
      <article class="workflow-card"><h3>Оплата</h3><div>${stateBadge(SETTLEMENT_LABELS, view.settlement)}</div></article>
      <article class="workflow-card"><h3>Жизненный цикл</h3><div>${badge(view.lifecycle === 'closed' ? 'Закрыт' : 'Активен', view.lifecycle === 'closed' ? 'success' : 'info')}</div></article>
    </div>
    <section class="audit-panel" aria-labelledby="chain-title"><h3 id="chain-title">Маршрут документа</h3><ol class="chain-list">${workflowSteps(view).map((step, index) => `<li class="chain-step is-${step.state}"><span class="chain-marker">${step.state === 'complete' ? '✓' : index + 1}</span><span><b>${escapeHtml(step.label)}</b><small>${step.state === 'complete' ? 'Завершено' : step.state === 'current' ? 'Ожидает действия' : 'Следующий этап'}</small></span></li>`).join('')}</ol></section>
    <section class="panel section-block"><div class="panel-head"><h3>Состав документа</h3></div><div class="table-wrap"><table class="data-table"><caption>Строки счёта</caption><thead><tr><th scope="col">Позиция</th><th scope="col">Количество</th><th scope="col">Цена</th><th scope="col">Сумма</th></tr></thead><tbody>${invoice.lines.map((line) => `<tr><th scope="row">${escapeHtml(itemName(state, line.itemId))}</th><td>${line.quantity}</td><td class="money">${formatMoney(line.unitPriceMinor)}</td><td class="money">${formatMoney(line.quantity * line.unitPriceMinor)}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="audit-panel" aria-labelledby="audit-title"><h3 id="audit-title">История</h3><ol class="timeline">${invoiceAudit(state, invoice)}</ol></section>`;

  const actions = [];
  if (view.approval === 'draft' || view.approval === 'rejected') actions.push(`<button class="button button-primary" type="button" data-invoice-action="submit">Отправить на согласование</button>`);
  if (view.approval === 'review') {
    actions.push(`<button class="button button-secondary" type="button" data-invoice-action="reject">Отклонить</button>`);
    actions.push(`<button class="button button-primary" type="button" data-invoice-action="approve">Согласовать</button>`);
  }
  if (view.approval === 'approved') {
    if (view.fulfillment !== 'complete' && view.fulfillment !== 'not_applicable') actions.push(`<button class="button button-secondary" type="button" data-invoice-action="fulfill">${invoice.direction === 'payable' ? 'Принять остаток' : 'Отгрузить остаток'}</button>`);
    if (view.remainingMinor > 0) {
      const paymentVerb = invoice.direction === 'payable' ? 'Оплатить' : 'Получить';
      actions.push(`<button class="button button-secondary" type="button" data-invoice-action="pay-half">${paymentVerb} 50%</button>`);
      actions.push(`<button class="button button-primary" type="button" data-invoice-action="pay-full">${paymentVerb} остаток</button>`);
    }
  }
  document.querySelector('[data-detail-actions]').innerHTML = `<button class="button button-secondary" type="button" data-close-dialog>Закрыть</button>${actions.join('')}`;
  if (!detailDialog.open) detailDialog.showModal();
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
  lastDialogTrigger?.focus?.();
  lastDialogTrigger = null;
}

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' is-error' : ''}`;
  toast.textContent = message;
  toastRegion.replaceChildren(toast);
  if (isError) alertStatus.textContent = message;
  else liveStatus.textContent = message;
  window.setTimeout(() => toast.remove(), isError ? 8000 : 4200);
}

async function runOperation(button, message, updater) {
  if (operationBusy) return;
  operationBusy = true;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = `${original}…`;
  }
  viewRoot.setAttribute('aria-busy', 'true');
  try {
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    store.setState(updater);
    renderCurrent();
    if (currentDetailId && detailDialog.open) openInvoice(currentDetailId, lastDialogTrigger);
    showToast(message);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    operationBusy = false;
    viewRoot.removeAttribute('aria-busy');
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function handleInvoiceAction(action, button) {
  const invoiceId = currentDetailId;
  const state = store.getState();
  const invoice = state.invoices.find((item) => item.id === invoiceId);
  if (!invoice) return;
  const context = { at: new Date().toISOString(), eventId: uniqueId('event') };
  if (action === 'submit') return runOperation(button, 'Счёт отправлен на согласование.', (current) => submitInvoiceForReview(current, invoiceId, context));
  if (action === 'approve') return runOperation(button, 'Решение записано. Счёт согласован.', (current) => approveInvoice(current, invoiceId, context));
  if (action === 'reject') return runOperation(button, 'Счёт отклонён и возвращён инициатору.', (current) => rejectInvoice(current, invoiceId, { ...context, reason: 'Тестовое отклонение' }));
  if (action === 'fulfill') {
    const lines = remainingInvoiceGoodsLines(state, invoice);
    if (!lines.length) return showToast('Товарных строк к исполнению не осталось.');
    const stockDocument = {
      id: uniqueId(invoice.direction === 'payable' ? 'receipt' : 'shipment'),
      type: invoice.direction === 'payable' ? 'receipt' : 'shipment',
      invoiceId,
      date: state.settings.today,
      ...(invoice.direction === 'payable' ? { warehouseToId: 'warehouse-main' } : { warehouseFromId: 'warehouse-main' }),
      lines: lines.map((line) => ({ id: uniqueId('line'), itemId: line.itemId, quantity: line.quantity, ...(invoice.direction === 'payable' ? { unitCostMinor: Math.round(line.unitPriceMinor * 10_000 / (10_000 + (line.vatRateBps ?? 0))) } : { unitPriceMinor: line.unitPriceMinor, vatRateBps: line.vatRateBps, priceIncludesVat: line.priceIncludesVat }) })),
    };
    return runOperation(button, invoice.direction === 'payable' ? 'Поступление проведено.' : 'Отгрузка проведена.', (current) => postStockDocument(current, stockDocument, context));
  }
  if (action === 'pay-half' || action === 'pay-full') {
    const view = deriveInvoiceView(state, invoice);
    const amountMinor = action === 'pay-full' ? view.remainingMinor : Math.max(1, Math.floor(view.remainingMinor / 2));
    const payment = {
      id: uniqueId('payment'), direction: invoice.direction === 'payable' ? 'outflow' : 'inflow', status: 'executed',
      date: state.settings.today, amountMinor, cashflowCategory: 'operating', allocations: [{ invoiceId, amountMinor }],
    };
    const message = invoice.direction === 'payable'
      ? `Оплата ${formatMoney(amountMinor)} записана.`
      : `Поступление ${formatMoney(amountMinor)} записано.`;
    return runOperation(button, message, (current) => recordPayment(current, payment, context));
  }
}

function syncCreateFields() {
  const isStock = ['receipt', 'shipment'].includes(createType.value);
  document.querySelectorAll('[data-invoice-field]').forEach((field) => { field.hidden = isStock; });
  document.querySelectorAll('[data-stock-field]').forEach((field) => { field.hidden = !isStock; });
  document.querySelector('[data-create-submit]').textContent = isStock ? 'Провести операцию' : 'Создать черновик';
}

function openCreate(trigger) {
  lastDialogTrigger = trigger;
  const state = store.getState();
  const stockSelect = document.querySelector('[data-create-form] [name="stockItem"]');
  stockSelect.innerHTML = state.items.filter((item) => item.kind === 'goods').map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  const due = new Date(`${state.settings.today}T12:00:00`);
  due.setDate(due.getDate() + 7);
  createForm.elements.dueDate.value = due.toISOString().slice(0, 10);
  document.querySelector('[data-form-summary]').hidden = true;
  syncCreateFields();
  createDialog.showModal();
  createType.focus();
}

function createInvoiceFromForm(data) {
  const state = store.getState();
  const direction = data.get('type') === 'supplier_invoice' ? 'payable' : 'receivable';
  const counterparty = String(data.get('counterparty') ?? '').trim();
  const dueDate = String(data.get('dueDate') ?? '');
  const purpose = String(data.get('purpose') ?? '').trim();
  const amountMinor = parseMoney(data.get('amount'));
  if (!counterparty) throw new Error('Укажите контрагента');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error('Укажите срок оплаты');
  if (!purpose) throw new Error('Укажите назначение');
  const cpId = uniqueId('counterparty');
  const contractId = uniqueId('contract');
  const invoiceId = uniqueId('invoice');
  const isService = data.get('operationKind') === 'service';
  const item = state.items.find((entry) => entry.kind === (isService ? 'service' : 'goods'));
  const next = structuredClone(state);
  next.counterparties.push({ id: cpId, kind: direction === 'payable' ? 'supplier' : 'customer', name: counterparty, inn: '' });
  next.contracts.push({ id: contractId, counterpartyId: cpId, number: `ДЕМО-${next.contracts.length + 1}`, paymentTermsDays: 7 });
  next.invoices.push({
    id: invoiceId, direction, organizationId: 'org-ladno', counterpartyId: cpId, contractId,
    number: `${direction === 'payable' ? 'П-' : 'К-'}${String(next.invoices.length + 1).padStart(4, '0')}`,
    date: state.settings.today, dueDate, currency: 'RUB', purpose,
    approval: 'draft', fulfillment: isService ? 'not_applicable' : 'pending', settlement: 'unplanned', lifecycle: 'active', rowVersion: 1,
    lines: [{ id: uniqueId('line'), itemId: item.id, quantity: 1, unitPriceMinor: amountMinor, vatRateBps: 2000, priceIncludesVat: true }],
  });
  return { state: next, invoiceId };
}

function createStockFromForm(data) {
  const state = store.getState();
  const type = String(data.get('type'));
  const itemId = String(data.get('stockItem'));
  const quantity = parseQuantity(data.get('quantity'));
  const priceMinor = parseMoney(data.get('unitCost'));
  const document = {
    id: uniqueId(type), type, date: state.settings.today,
    ...(type === 'receipt' ? { warehouseToId: 'warehouse-main' } : { warehouseFromId: 'warehouse-main' }),
    lines: [{ id: uniqueId('line'), itemId, quantity, ...(type === 'receipt' ? { unitCostMinor: priceMinor } : { unitPriceMinor: priceMinor, vatRateBps: 2000, priceIncludesVat: true }) }],
  };
  return postStockDocument(state, document, { at: new Date().toISOString(), eventId: uniqueId('event') });
}

function clearFormErrors() {
  document.querySelectorAll('.field-error').forEach((item) => { item.textContent = ''; });
  document.querySelectorAll('[aria-invalid="true"]').forEach((item) => item.removeAttribute('aria-invalid'));
}

function handleCreateSubmit(event) {
  event.preventDefault();
  clearFormErrors();
  const data = new FormData(createForm);
  try {
    if (['receipt', 'shipment'].includes(String(data.get('type')))) {
      store.setState(createStockFromForm(data));
      showToast('Складская операция проведена.');
      location.hash = '#warehouse';
    } else {
      const result = createInvoiceFromForm(data);
      store.setState(result.state);
      showToast('Черновик счёта создан.');
      location.hash = data.get('type') === 'supplier_invoice' ? '#supplier-invoices' : '#customer-invoices';
      currentDetailId = result.invoiceId;
    }
    closeDialog(createDialog);
    renderCurrent();
  } catch (error) {
    const summary = document.querySelector('[data-form-summary]');
    summary.textContent = error.message;
    summary.hidden = false;
    summary.focus();
    alertStatus.textContent = error.message;
  }
}

function searchResults(query) {
  const state = store.getState();
  const normalized = query.trim().toLocaleLowerCase('ru');
  if (!normalized) return [];
  const invoices = state.invoices.filter((invoice) => `${invoice.number} ${counterpartyName(state, invoice)} ${invoice.purpose ?? ''}`.toLocaleLowerCase('ru').includes(normalized)).map((invoice) => ({ type: 'invoice', id: invoice.id, title: `Счёт № ${invoice.number}`, description: counterpartyName(state, invoice) }));
  const items = state.items.filter((item) => `${item.sku} ${item.name}`.toLocaleLowerCase('ru').includes(normalized)).map((item) => ({ type: 'item', id: item.id, title: item.name, description: `${item.sku} · Склад` }));
  return [...invoices, ...items].slice(0, 12);
}

function showSearchResults(query, target) {
  const results = searchResults(query);
  target.innerHTML = results.length ? `<ul class="search-result-list">${results.map((result) => `<li><button class="search-result-button" type="button" data-search-result-type="${result.type}" data-search-result-id="${escapeHtml(result.id)}"><span><b>${escapeHtml(result.title)}</b><small>${escapeHtml(result.description)}</small></span><span aria-hidden="true">→</span></button></li>`).join('')}</ul>` : '<div class="empty-state"><div><h2>Ничего не найдено</h2><p>Проверьте номер, название контрагента или номенклатуры.</p></div></div>';
  liveStatus.textContent = `Найдено результатов: ${results.length}.`;
}

function simulateODataImport(button) {
  const state = store.getState();
  const incoming = state.invoices.map((invoice) => createODataEnvelope({
    connectionId: 'onec-demo',
    entitySet: invoice.direction === 'payable' ? 'Document_СчетПоставщика_Demo' : 'Document_СчетПокупателю_Demo',
    entity: invoice.direction === 'payable' ? 'supplier_invoice' : 'customer_invoice',
    sourceRecord: { Ref_Key: invoice.id, DataVersion: String(invoice.rowVersion ?? 1), Number: invoice.number, Date: invoice.date, Posted: invoice.approval === 'approved', DeletionMark: false },
    fetchedAt: new Date().toISOString(),
  }));
  return runOperation(button, 'Тестовый OData‑импорт завершён без дублей.', (current) => {
    const result = upsertODataEnvelopes(current.odataRecords, incoming);
    const next = structuredClone(current);
    next.odataRecords = result.records;
    next.syncRuns.push({ id: uniqueId('sync'), date: next.settings.today, at: new Date().toISOString(), inserted: result.inserted, updated: result.updated, unchanged: result.unchanged });
    return next;
  });
}

function exportODataSnapshot() {
  const state = store.getState();
  const payload = { version: '0.1.0', exportedAt: new Date().toISOString(), mode: 'demo-read-only', data: state.odataRecords };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ladno-odata-demo-${state.settings.today}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('Демонстрационный OData‑снимок подготовлен.');
}

document.addEventListener('click', (event) => {
  const openCreateButton = event.target.closest('[data-open-create]');
  if (openCreateButton) return openCreate(openCreateButton);
  const openInvoiceButton = event.target.closest('[data-open-invoice]');
  if (openInvoiceButton) return openInvoice(openInvoiceButton.dataset.openInvoice, openInvoiceButton);
  const closeButton = event.target.closest('[data-close-dialog]');
  if (closeButton) return closeDialog(closeButton.closest('dialog'));
  const navButton = event.target.closest('[data-open-navigation]');
  if (navButton) { lastDialogTrigger = navButton; navigationDialog.showModal(); return; }
  const searchButton = event.target.closest('[data-open-search]');
  if (searchButton) { lastDialogTrigger = searchButton; searchDialog.showModal(); document.querySelector('#dialog-query').focus(); return; }
  const invoiceAction = event.target.closest('[data-invoice-action]');
  if (invoiceAction) return handleInvoiceAction(invoiceAction.dataset.invoiceAction, invoiceAction);
  const searchResult = event.target.closest('[data-search-result-id]');
  if (searchResult) {
    closeDialog(searchDialog);
    if (searchResult.dataset.searchResultType === 'invoice') openInvoice(searchResult.dataset.searchResultId, lastDialogTrigger);
    else location.hash = '#warehouse';
    return;
  }
  const simulateButton = event.target.closest('[data-simulate-odata]');
  if (simulateButton) return simulateODataImport(simulateButton);
  if (event.target.closest('[data-export-odata]')) return exportODataSnapshot();
  if (event.target.closest('[data-reset-demo]')) {
    store.reset();
    activeFilter = { query: '', status: 'all' };
    renderCurrent();
    showToast('Демонстрационные данные восстановлены.');
  }
});

document.addEventListener('submit', (event) => {
  if (event.target.matches('[data-filter-form]')) {
    event.preventDefault();
    const data = new FormData(event.target);
    activeFilter = { query: String(data.get('query') ?? ''), status: String(data.get('status') ?? 'all') };
    renderCurrent();
    return;
  }
  if (event.target.matches('[data-global-search-form]')) {
    event.preventDefault();
    const query = String(new FormData(event.target).get('q') ?? '');
    lastDialogTrigger = event.target.querySelector('button');
    searchDialog.showModal();
    document.querySelector('#dialog-query').value = query;
    showSearchResults(query, document.querySelector('[data-search-results]'));
    return;
  }
  if (event.target.matches('[data-dialog-search-form]')) {
    event.preventDefault();
    showSearchResults(String(new FormData(event.target).get('q') ?? ''), document.querySelector('[data-search-results]'));
  }
});

createForm.addEventListener('submit', handleCreateSubmit);
createType.addEventListener('change', syncCreateFields);
window.addEventListener('hashchange', () => {
  activeFilter = { query: '', status: 'all' };
  closeDialog(navigationDialog);
  renderCurrent({ focus: true });
});

for (const dialog of [detailDialog, createDialog, navigationDialog, searchDialog]) {
  dialog.addEventListener('close', () => {
    if (dialog === detailDialog) currentDetailId = null;
  });
}

renderCurrent();
