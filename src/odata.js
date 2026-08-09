const clone = (value) => JSON.parse(JSON.stringify(value));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function decimalToMinor(value) {
  const match = String(value ?? '').trim().match(/^([+-]?)(\d+)(?:[.,](\d+))?$/);
  invariant(match, 'Десятичная сумма имеет неверный формат');
  const [, sign, whole, fraction = ''] = match;
  let minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if ((fraction[2] ?? '0') >= '5') minor += 1n;
  if (sign === '-') minor = -minor;
  const result = Number(minor);
  invariant(Number.isSafeInteger(result), 'Десятичная сумма выходит за безопасный диапазон');
  return result;
}

export function normalizeODataServiceRoot(input) {
  const url = new URL(input);
  invariant(['http:', 'https:'].includes(url.protocol), 'OData URL должен использовать HTTP или HTTPS');
  invariant(!url.username && !url.password, 'Учётные данные нельзя передавать в OData URL');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\$metadata\/?$/i, '').replace(/\/+$/, '') + '/';
  return url.href;
}

function resolveODataLink(candidate, baseUrl, serviceRoot) {
  const base = new URL(baseUrl);
  const resolved = new URL(candidate, base);
  invariant(['http:', 'https:'].includes(resolved.protocol), 'OData URL должен использовать HTTP или HTTPS');
  invariant(!resolved.username && !resolved.password, 'Учётные данные нельзя передавать в OData URL');
  invariant(resolved.origin === base.origin, 'OData nextLink указывает на другой origin');
  if (serviceRoot) {
    const root = new URL(normalizeODataServiceRoot(serviceRoot));
    invariant(resolved.origin === root.origin, 'OData nextLink указывает на другой origin');
    const rootPath = root.pathname;
    const rootWithoutSlash = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
    invariant(resolved.pathname === rootWithoutSlash || resolved.pathname.startsWith(rootPath), 'OData nextLink выходит за границы service root');
  }
  return resolved.href;
}

export function getMetadataUrl(serviceRoot) {
  return new URL('$metadata', normalizeODataServiceRoot(serviceRoot)).href;
}

export function buildODataPageUrl(serviceRoot, entitySet, options = {}) {
  invariant(entitySet, 'Не указан entity set');
  if (options.nextLink) return resolveODataLink(options.nextLink, normalizeODataServiceRoot(serviceRoot), serviceRoot);
  const url = new URL(encodeURIComponent(entitySet), normalizeODataServiceRoot(serviceRoot));
  if (options.select?.length) url.searchParams.set('$select', options.select.join(','));
  if (options.filter) url.searchParams.set('$filter', options.filter);
  if (options.orderBy) url.searchParams.set('$orderby', options.orderBy);
  if (options.expand) url.searchParams.set('$expand', options.expand);
  if (options.top != null) {
    invariant(Number.isInteger(options.top) && options.top > 0, '$top должен быть положительным целым');
    url.searchParams.set('$top', String(options.top));
  }
  if (options.skip != null) url.searchParams.set('$skip', String(options.skip));
  if (options.skipToken) url.searchParams.set('$skiptoken', options.skipToken);
  return url.href;
}

export function readODataPage(payload) {
  if (Array.isArray(payload?.value)) {
    return { records: payload.value, nextLink: payload['@odata.nextLink'] ?? payload['odata.nextLink'] ?? null };
  }
  if (Array.isArray(payload?.d?.results)) {
    return { records: payload.d.results, nextLink: payload.d.__next ?? null };
  }
  if (payload?.d && typeof payload.d === 'object') {
    return { records: [payload.d], nextLink: null };
  }
  throw new Error('Ответ не похож на страницу OData');
}

async function unwrapResponse(value) {
  if (value && typeof value.json === 'function') {
    if ('ok' in value && !value.ok) throw new Error(`OData вернул HTTP ${value.status}`);
    return value.json();
  }
  return value;
}

export async function collectODataPages(fetchPage, initialUrl, options = {}) {
  invariant(typeof fetchPage === 'function', 'fetchPage должен быть функцией');
  const maxPages = options.maxPages ?? 100;
  invariant(Number.isInteger(maxPages) && maxPages > 0, 'maxPages должен быть положительным целым');
  const seen = new Set();
  const records = [];
  let pages = 0;
  let nextLink = resolveODataLink(initialUrl, initialUrl, options.serviceRoot);

  while (nextLink && pages < maxPages) {
    const currentUrl = resolveODataLink(nextLink, initialUrl, options.serviceRoot);
    invariant(!seen.has(currentUrl), 'Обнаружен цикл OData paging');
    seen.add(currentUrl);
    const payload = await unwrapResponse(await fetchPage(currentUrl));
    const page = readODataPage(payload);
    records.push(...page.records);
    pages += 1;
    nextLink = page.nextLink ? resolveODataLink(page.nextLink, currentUrl, options.serviceRoot) : null;
  }

  return { records, pages, nextLink, truncated: Boolean(nextLink) };
}

function parseAttributes(fragment) {
  const attributes = {};
  const expression = /([\w:.-]+)\s*=\s*(["'])(.*?)\2/g;
  for (const match of fragment.matchAll(expression)) attributes[match[1]] = match[3];
  return attributes;
}

function localTypeName(type) {
  return String(type ?? '').split('.').pop();
}

export function normalizeMetadata(input) {
  if (input && typeof input === 'object') {
    if (Array.isArray(input.entitySets)) return clone(input);
    if (Array.isArray(input)) return { entitySets: clone(input), entityTypes: [] };
  }
  invariant(typeof input === 'string' && input.includes('<'), 'Метаданные должны быть XML-строкой');
  const xml = input;
  const entityTypes = [];
  const typeExpression = /<(?:\w+:)?EntityType\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?EntityType>/gi;
  for (const match of xml.matchAll(typeExpression)) {
    const attributes = parseAttributes(match[1]);
    const body = match[2];
    const properties = [];
    const propertyExpression = /<(?:\w+:)?Property\b([^>]*?)(?:\/\s*>|>[\s\S]*?<\/(?:\w+:)?Property>)/gi;
    for (const propertyMatch of body.matchAll(propertyExpression)) {
      const property = parseAttributes(propertyMatch[1]);
      if (!property.Name) continue;
      properties.push({
        name: property.Name,
        type: property.Type ?? null,
        nullable: property.Nullable !== 'false',
        maxLength: property.MaxLength ?? null,
        precision: property.Precision == null ? null : Number(property.Precision),
        scale: property.Scale ?? null,
      });
    }
    const keys = [...body.matchAll(/<(?:\w+:)?PropertyRef\b([^>]*?)\/\s*>/gi)]
      .map((keyMatch) => parseAttributes(keyMatch[1]).Name)
      .filter(Boolean);
    const navigationProperties = [...body.matchAll(/<(?:\w+:)?NavigationProperty\b([^>]*?)(?:\/\s*>|>)/gi)]
      .map((navigationMatch) => {
        const item = parseAttributes(navigationMatch[1]);
        return { name: item.Name, type: item.Type ?? null };
      })
      .filter((item) => item.name);
    entityTypes.push({ name: attributes.Name, keys, properties, navigationProperties });
  }

  const byType = new Map(entityTypes.map((type) => [type.name, type]));
  const entitySets = [];
  const setExpression = /<(?:\w+:)?EntitySet\b([^>]*?)(?:\/\s*>|>)/gi;
  for (const match of xml.matchAll(setExpression)) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.Name) continue;
    const typeName = localTypeName(attributes.EntityType);
    const type = byType.get(typeName);
    entitySets.push({
      name: attributes.Name,
      entityType: attributes.EntityType ?? null,
      keys: type?.keys ?? [],
      properties: type?.properties ?? [],
      navigationProperties: type?.navigationProperties ?? [],
    });
  }
  entitySets.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { entitySets, entityTypes };
}

const DOMAIN_PATTERNS = {
  organizations: [/организац/i, /organization/i],
  counterparties: [/контрагент/i, /counterpart/i],
  items: [/номенклатур/i, /item|product/i],
  warehouses: [/склад/i, /warehouse/i],
  supplierInvoices: [/счет.*постав/i, /supplier.*invoice/i],
  customerInvoices: [/счет.*покуп|счет.*клиент/i, /customer.*invoice/i],
  receipts: [/поступлен|приобретен/i, /receipt|purchase/i],
  shipments: [/реализац|отгруз/i, /shipment|sale/i],
  payments: [/списан.*счет|поступлен.*счет|платеж/i, /payment|cash/i],
  inventoryBalances: [/товар.*склад.*balance|запас.*balance/i, /inventory.*balance|stock.*balance/i],
};

export function suggestEntityMappings(metadata) {
  const inventory = normalizeMetadata(metadata);
  return Object.fromEntries(Object.entries(DOMAIN_PATTERNS).map(([domain, patterns]) => [
    domain,
    inventory.entitySets.filter((entitySet) => patterns.some((pattern) => pattern.test(entitySet.name))).map((entitySet) => entitySet.name),
  ]));
}

function readPath(source, path) {
  if (typeof path === 'function') return path(source);
  return String(path).split('.').reduce((value, key) => value?.[key], source);
}

export function applyFieldMapping(record, mapping) {
  return Object.fromEntries(Object.entries(mapping).map(([target, source]) => [target, readPath(record, source)]));
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function hashPayload(payload) {
  const text = stableStringify(payload);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createODataEnvelope(options) {
  const { connectionId, entitySet, entity, sourceRecord, mapping = {}, fetchedAt } = options;
  invariant(connectionId, 'Не указан connectionId');
  invariant(entitySet, 'Не указан entitySet');
  invariant(entity, 'Не указан внутренний тип сущности');
  invariant(sourceRecord && typeof sourceRecord === 'object', 'Не передана запись OData');
  const refKey = sourceRecord.Ref_Key ?? sourceRecord.refKey ?? sourceRecord.ID ?? sourceRecord.Id;
  invariant(refKey, 'В записи OData нет Ref_Key');
  const record = Object.keys(mapping).length ? applyFieldMapping(sourceRecord, mapping) : clone(sourceRecord);
  return {
    source: {
      connectionId,
      entitySet,
      refKey: String(refKey),
      dataVersion: sourceRecord.DataVersion ?? sourceRecord.dataVersion ?? null,
      deletionMark: Boolean(sourceRecord.DeletionMark ?? sourceRecord.deletionMark),
      posted: sourceRecord.Posted == null ? null : Boolean(sourceRecord.Posted),
      fetchedAt: fetchedAt ?? new Date().toISOString(),
      payloadHash: hashPayload(sourceRecord),
    },
    entity,
    record,
  };
}

function envelopeKey(envelope) {
  return [envelope.source.connectionId, envelope.source.entitySet, envelope.source.refKey].join('::');
}

export function upsertODataEnvelopes(existing, incoming) {
  const records = clone(existing ?? []);
  const index = new Map(records.map((record, position) => [envelopeKey(record), position]));
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  for (const envelope of incoming ?? []) {
    const key = envelopeKey(envelope);
    const position = index.get(key);
    if (position == null) {
      index.set(key, records.length);
      records.push(clone(envelope));
      inserted += 1;
      continue;
    }
    const previous = records[position];
    if (previous.source.dataVersion === envelope.source.dataVersion && previous.source.payloadHash === envelope.source.payloadHash) {
      unchanged += 1;
      continue;
    }
    records[position] = { ...clone(envelope), local: previous.local == null ? undefined : clone(previous.local) };
    if (records[position].local === undefined) delete records[position].local;
    updated += 1;
  }
  return { records, inserted, updated, unchanged };
}
