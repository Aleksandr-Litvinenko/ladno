import { createSeedState, SCHEMA_VERSION } from './seed.js?v=0.1.0-r2';

export const DEFAULT_STORAGE_KEY = 'ladno:v1:state';

const clone = (value) => JSON.parse(JSON.stringify(value));

export function createMemoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    clear() { data.clear(); },
  };
}

function resolveStorage(storage) {
  if (storage) return storage;
  try {
    if (globalThis.localStorage) return globalThis.localStorage;
  } catch {
    // Закрытый localStorage не должен ломать демо: используем память вкладки.
  }
  return createMemoryStorage();
}

export function validateStateShape(state) {
  if (!state || typeof state !== 'object') return ['Состояние должно быть объектом'];
  const errors = [];
  if (state.schemaVersion !== SCHEMA_VERSION) errors.push(`Неподдерживаемая версия схемы: ${state.schemaVersion}`);
  if (!state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) {
    errors.push('settings должен быть объектом');
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.settings.today ?? '')) errors.push('settings.today должен иметь формат YYYY-MM-DD');
    if (!state.settings.currency) errors.push('settings.currency обязателен');
    if (!Number.isSafeInteger(state.settings.openingCashMinor)) errors.push('settings.openingCashMinor должен быть целым числом копеек');
    if (!Number.isSafeInteger(state.settings.minimumCashMinor)) errors.push('settings.minimumCashMinor должен быть целым числом копеек');
  }
  for (const collection of [
    'organizations', 'counterparties', 'contracts', 'warehouses', 'items', 'invoices',
    'stockDocuments', 'payments', 'financialEntries', 'auditEvents', 'odataRecords', 'syncRuns',
  ]) {
    if (!Array.isArray(state[collection])) errors.push(`${collection} должен быть массивом`);
  }
  return errors;
}

export function createStore(options = {}) {
  const storage = resolveStorage(options.storage);
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const seedFactory = options.seedFactory ?? createSeedState;
  const listeners = new Set();

  function load() {
    const serialized = storage.getItem(storageKey);
    if (!serialized) return seedFactory();
    try {
      const parsed = JSON.parse(serialized);
      if (validateStateShape(parsed).length === 0) return parsed;
    } catch {
      // Повреждённое состояние заменяется воспроизводимым seed-набором.
    }
    return seedFactory();
  }

  let state = load();

  function persist() {
    storage.setItem(storageKey, JSON.stringify(state));
  }

  function notify() {
    const snapshot = clone(state);
    for (const listener of listeners) listener(snapshot);
  }

  return {
    getState() {
      return clone(state);
    },

    setState(nextOrUpdater) {
      const candidate = typeof nextOrUpdater === 'function'
        ? nextOrUpdater(clone(state))
        : nextOrUpdater;
      const errors = validateStateShape(candidate);
      if (errors.length) throw new Error(errors.join('; '));
      state = clone(candidate);
      persist();
      notify();
      return clone(state);
    },

    reset() {
      state = seedFactory();
      persist();
      notify();
      return clone(state);
    },

    clear() {
      storage.removeItem(storageKey);
      state = seedFactory();
      notify();
      return clone(state);
    },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Подписчик должен быть функцией');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    exportJson(space = 2) {
      return JSON.stringify(state, null, space);
    },

    importJson(serialized) {
      const candidate = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
      const errors = validateStateShape(candidate);
      if (errors.length) throw new Error(errors.join('; '));
      state = clone(candidate);
      persist();
      notify();
      return clone(state);
    },
  };
}
