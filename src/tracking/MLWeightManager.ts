import type { PredictiveLSTMWeights } from './PredictiveLSTM';

const DB_NAME = 'wear-jewelry-ar-ml';
const DB_VERSION = 1;
const STORE_NAME = 'weights';
export const LSTM_WEIGHT_KEY = 'predictive-lstm-v1';

interface StoredWeights { readonly key: string; readonly hiddenSize: number; readonly updatedAt: number; readonly inputKernel: number[]; readonly recurrentKernel: number[]; readonly bias: number[]; readonly projection: number[]; readonly projectionBias: number[]; }

function hasIndexedDB(): boolean { return typeof indexedDB !== 'undefined'; }

function openWeightsDB(): Promise<IDBDatabase> {
  if (!hasIndexedDB()) return Promise.reject(new Error('IndexedDB is unavailable'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openWeightsDB().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = action(tx.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('IndexedDB transaction failed')); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('IndexedDB transaction aborted')); };
  }));
}

function serializeWeights(key: string, hiddenSize: number, weights: PredictiveLSTMWeights): StoredWeights {
  return { key, hiddenSize, updatedAt: Date.now(), inputKernel: Array.from(weights.inputKernel), recurrentKernel: Array.from(weights.recurrentKernel), bias: Array.from(weights.bias), projection: Array.from(weights.projection), projectionBias: Array.from(weights.projectionBias) };
}

function deserializeWeights(stored: StoredWeights, hiddenSize: number): PredictiveLSTMWeights | null {
  if (stored.hiddenSize !== hiddenSize) return null;
  return { inputKernel: new Float32Array(stored.inputKernel), recurrentKernel: new Float32Array(stored.recurrentKernel), bias: new Float32Array(stored.bias), projection: new Float32Array(stored.projection), projectionBias: new Float32Array(stored.projectionBias) };
}

export class MLWeightManager {
  static async create(key: string, hiddenSize: number, weights: PredictiveLSTMWeights): Promise<void> { await transaction('readwrite', (store) => store.add(serializeWeights(key, hiddenSize, weights))); }
  static async read(key = LSTM_WEIGHT_KEY, hiddenSize = 16): Promise<PredictiveLSTMWeights | null> { const stored = await transaction<StoredWeights | undefined>('readonly', (store) => store.get(key)); return stored ? deserializeWeights(stored, hiddenSize) : null; }
  static async update(key: string, hiddenSize: number, weights: PredictiveLSTMWeights): Promise<void> { await transaction('readwrite', (store) => store.put(serializeWeights(key, hiddenSize, weights))); }
  static async delete(key = LSTM_WEIGHT_KEY): Promise<void> { await transaction('readwrite', (store) => store.delete(key)); }
  static async saveLSTMWeights(weights: PredictiveLSTMWeights, hiddenSize = 16): Promise<void> { await MLWeightManager.update(LSTM_WEIGHT_KEY, hiddenSize, weights); }
}
