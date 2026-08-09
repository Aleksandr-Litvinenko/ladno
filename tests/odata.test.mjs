import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildODataPageUrl,
  collectODataPages,
  createODataEnvelope,
  decimalToMinor,
  getMetadataUrl,
  normalizeMetadata,
  readODataPage,
  suggestEntityMappings,
  upsertODataEnvelopes,
} from '../src/odata.js';

test('преобразует десятичную строку 1С в копейки без двоичного округления', () => {
  assert.equal(decimalToMinor('248600.005'), 24_860_001);
  assert.equal(decimalToMinor('41 433,33'.replace(' ', '')), 4_143_333);
  assert.equal(decimalToMinor('-0.015'), -2);
  assert.throws(() => decimalToMinor('12x'), /неверный формат/);
});

test('строит ограниченный OData URL без ручной склейки параметров', () => {
  const root = 'https://example.test/base/odata/standard.odata';
  assert.equal(getMetadataUrl(root), 'https://example.test/base/odata/standard.odata/$metadata');
  const url = new URL(buildODataPageUrl(root, 'Catalog_Контрагенты', {
    select: ['Ref_Key', 'Description'], filter: 'DeletionMark eq false', top: 100,
  }));
  assert.equal(decodeURIComponent(url.pathname).endsWith('/Catalog_Контрагенты'), true);
  assert.equal(url.searchParams.get('$select'), 'Ref_Key,Description');
  assert.equal(url.searchParams.get('$filter'), 'DeletionMark eq false');
  assert.equal(url.searchParams.get('$top'), '100');
  assert.throws(() => getMetadataUrl('ftp://example.test/odata'), /HTTP или HTTPS/);
  const credentialUrl = new URL('https://example.test/odata');
  credentialUrl.username = 'user';
  credentialUrl.password = 'secret';
  assert.throws(() => getMetadataUrl(credentialUrl.href), /Учётные данные/);
});

test('читает страницы OData v4 и старую обёртку v3', () => {
  assert.deepEqual(readODataPage({ value: [{ id: 1 }], '@odata.nextLink': '?page=2' }), {
    records: [{ id: 1 }], nextLink: '?page=2',
  });
  assert.deepEqual(readODataPage({ d: { results: [{ id: 2 }], __next: '/next' } }), {
    records: [{ id: 2 }], nextLink: '/next',
  });
});

test('paging собирает записи и останавливается по nextLink', async () => {
  const requested = [];
  const result = await collectODataPages(async (url) => {
    requested.push(url);
    if (requested.length === 1) return { value: [{ Ref_Key: '1' }], '@odata.nextLink': '?page=2' };
    return { value: [{ Ref_Key: '2' }] };
  }, 'https://example.test/odata/standard.odata/Catalog_Test?$top=1');
  assert.deepEqual(result.records.map((record) => record.Ref_Key), ['1', '2']);
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, false);
  assert.equal(requested[1], 'https://example.test/odata/standard.odata/Catalog_Test?page=2');
});

test('не следует по OData nextLink на другой origin или за service root', async () => {
  assert.throws(() => buildODataPageUrl('https://onec.example/base/odata/standard.odata', 'Catalog_Test', {
    nextLink: 'http://169.254.169.254/latest/meta-data/',
  }), /другой origin/);

  let calls = 0;
  await assert.rejects(collectODataPages(async () => {
    calls += 1;
    return { value: [{ Ref_Key: '1' }], '@odata.nextLink': 'http://169.254.169.254/latest/meta-data/' };
  }, 'https://onec.example/base/odata/standard.odata/Catalog_Test'), /другой origin/);
  assert.equal(calls, 1);

  await assert.rejects(collectODataPages(async () => ({ value: [], '@odata.nextLink': '/admin' }),
    'https://onec.example/base/odata/standard.odata/Catalog_Test',
    { serviceRoot: 'https://onec.example/base/odata/standard.odata' }), /границы service root/);

  const credentialNextLink = new URL('https://onec.example/base/odata/standard.odata/Catalog_Test?page=2');
  credentialNextLink.username = 'user';
  credentialNextLink.password = 'secret';
  await assert.rejects(collectODataPages(async () => ({ value: [], '@odata.nextLink': credentialNextLink.href }),
    'https://onec.example/base/odata/standard.odata/Catalog_Test'), /Учётные данные/);
});

test('нормализует $metadata в инвентарь entity sets и полей', () => {
  const metadata = `<?xml version="1.0"?>
    <Schema Namespace="StandardODATA" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Catalog_Контрагенты_Type">
        <Key><PropertyRef Name="Ref_Key" /></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false" />
        <Property Name="Description" Type="Edm.String" MaxLength="150" />
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Catalog_Контрагенты" EntityType="StandardODATA.Catalog_Контрагенты_Type" />
      </EntityContainer>
    </Schema>`;
  const inventory = normalizeMetadata(metadata);
  assert.equal(inventory.entitySets.length, 1);
  assert.deepEqual(inventory.entitySets[0].keys, ['Ref_Key']);
  assert.deepEqual(inventory.entitySets[0].properties.map((property) => property.name), ['Ref_Key', 'Description']);
  assert.deepEqual(suggestEntityMappings(inventory).counterparties, ['Catalog_Контрагенты']);
});

test('envelope сохраняет устойчивый ключ источника и применяет mapping', () => {
  const envelope = createODataEnvelope({
    connectionId: 'onec-demo', entitySet: 'Document_Счет', entity: 'supplier_invoice',
    fetchedAt: '2026-08-09T12:00:00.000Z',
    sourceRecord: { Ref_Key: 'uuid-1', DataVersion: 'v1', DeletionMark: false, Number: '4821', Total: 248_600_00 },
    mapping: { number: 'Number', totalMinor: 'Total' },
  });
  assert.equal(envelope.source.refKey, 'uuid-1');
  assert.match(envelope.source.payloadHash, /^fnv1a32:[0-9a-f]{8}$/);
  assert.deepEqual(envelope.record, { number: '4821', totalMinor: 248_600_00 });
});

test('upsert идемпотентен и не перезаписывает локальные поля', () => {
  const first = createODataEnvelope({
    connectionId: 'onec', entitySet: 'Catalog_Test', entity: 'item', fetchedAt: '2026-08-09T12:00:00.000Z',
    sourceRecord: { Ref_Key: '1', DataVersion: 'v1', Description: 'Старое' },
  });
  first.local = { category: 'manual' };
  const same = createODataEnvelope({
    connectionId: 'onec', entitySet: 'Catalog_Test', entity: 'item', fetchedAt: '2026-08-09T13:00:00.000Z',
    sourceRecord: { Ref_Key: '1', DataVersion: 'v1', Description: 'Старое' },
  });
  const unchanged = upsertODataEnvelopes([first], [same]);
  assert.equal(unchanged.unchanged, 1);

  const changed = createODataEnvelope({
    connectionId: 'onec', entitySet: 'Catalog_Test', entity: 'item', fetchedAt: '2026-08-09T14:00:00.000Z',
    sourceRecord: { Ref_Key: '1', DataVersion: 'v2', Description: 'Новое' },
  });
  const updated = upsertODataEnvelopes(unchanged.records, [changed]);
  assert.equal(updated.updated, 1);
  assert.equal(updated.records[0].record.Description, 'Новое');
  assert.deepEqual(updated.records[0].local, { category: 'manual' });
});
