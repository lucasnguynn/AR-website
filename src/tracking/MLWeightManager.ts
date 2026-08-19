// FILE: src/tracking/MLWeightManager.ts
const DB_NAME = 'webar-ml-v1';
const DB_VERSION = 1;
const STORE = 'weights';
const MAX_VERSIONS = 3;

interface StoredWeightVersion {
  readonly id: string;
  readonly key: string;
  readonly data: Float32Array[];
  readonly savedAt: number;
}

/** Stable IndexedDB key for the predictive LSTM weights. */
export const LSTM_WEIGHT_KEY = 'lstm-v1';

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function makeVersionId(key: string, savedAt: number): string {
  return `${key}:${savedAt}`;
}

/** Opens the local WebAR ML weights database and creates the weights store when needed. */
export async function openDB(): Promise<IDBDatabase> {
  if (!hasIndexedDB()) throw new Error('IndexedDB is unavailable');
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('by_key', 'key', { unique: false });
        store.createIndex('by_saved_at', 'savedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

function cloneWeights(weights: Float32Array[]): Float32Array[] {
  return weights.map((weight) => {
    if (weight instanceof Float32Array) return new Float32Array(weight);
    if (Array.isArray(weight)) return new Float32Array(weight);
    throw new Error('Corrupted weight tensor in IndexedDB');
  });
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDB();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const request = action(store);
    let result: T | undefined;
    if (request) {
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    }
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('IndexedDB transaction failed')); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('IndexedDB transaction aborted')); };
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function rotateOldVersions(key: string): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const index = tx.objectStore(STORE).index('by_key');
    const rows = await requestToPromise<StoredWeightVersion[]>(index.getAll(IDBKeyRange.only(key)));
    const stale = rows.sort((a, b) => b.savedAt - a.savedAt).slice(MAX_VERSIONS);
    for (const row of stale) tx.objectStore(STORE).delete(row.id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB rotation failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB rotation aborted'));
    });
  } finally {
    db.close();
  }
}

/** Saves a complete model weight tensor set and keeps at most three versions for the key. */
export async function saveWeights(key: string, weights: Float32Array[]): Promise<void> {
  const savedAt = Date.now();
  const row: StoredWeightVersion = { id: makeVersionId(key, savedAt), key, data: cloneWeights(weights), savedAt };
  await withStore('readwrite', (store) => store.put(row));
  await rotateOldVersions(key);
}

/** Loads the newest complete model weight tensor set for the key, or null when none exists. */
export async function loadWeights(key: string): Promise<Float32Array[] | null> {
  const rows = await withStore<StoredWeightVersion[]>('readonly', (store) => store.index('by_key').getAll(IDBKeyRange.only(key)));
  if (!rows || rows.length === 0) return null;
  const newestFirst = rows.sort((a, b) => b.savedAt - a.savedAt);
  for (const row of newestFirst) {
    try { return cloneWeights(row.data); } catch { /* fall back to the prior complete version */ }
  }
  return null;
}

console.log('[MLWeightManager] IndexedDB weight persistence ready');
// VERIFY: saveWeights('lstm-v1', tensors) persists only the newest three versions.
