import test from 'node:test';
import assert from 'node:assert/strict';

import { createSeedState } from '../src/seed.js';
import { createMemoryStorage, createStore, DEFAULT_STORAGE_KEY, validateStateShape } from '../src/store.js';

test('схема состояния требует настройки и все рабочие коллекции', () => {
  const withoutSettings = createSeedState();
  delete withoutSettings.settings;
  assert.ok(validateStateShape(withoutSettings).includes('settings должен быть объектом'));

  const withoutSyncRuns = createSeedState();
  delete withoutSyncRuns.syncRuns;
  assert.ok(validateStateShape(withoutSyncRuns).includes('syncRuns должен быть массивом'));
});

test('хранилище не загружает и не импортирует неполную схему', () => {
  const invalid = createSeedState();
  delete invalid.odataRecords;
  const storage = createMemoryStorage({ [DEFAULT_STORAGE_KEY]: JSON.stringify(invalid) });
  const store = createStore({ storage });
  assert.deepEqual(store.getState(), createSeedState());
  assert.throws(() => store.importJson(invalid), /odataRecords должен быть массивом/);
});
