// FILE: src/tracking/MotionDataCapture.ts
import { LSTM_WEIGHT_KEY, saveWeights } from './MLWeightManager';

/** Captured privacy-local motion sample stored only in sessionStorage. */
export interface MotionSample {
  readonly t: number;
  readonly pos: readonly [number, number, number];
  readonly vel: readonly [number, number, number];
  readonly quat: readonly [number, number, number, number];
}

const MAX_SAMPLES = 1800;
const SAMPLES_KEY = 'webar-motion-samples';
const INPUT_FRAMES = 8;
const INPUT_WIDTH = 9;
const OUTPUT_WIDTH = 7;

function readSamples(): MotionSample[] {
  const raw = sessionStorage.getItem(SAMPLES_KEY) ?? '[]';
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isMotionSample);
}

function isMotionSample(value: unknown): value is MotionSample {
  if (typeof value !== 'object' || value === null) return false;
  const sample = value as { t?: unknown; pos?: unknown; vel?: unknown; quat?: unknown };
  return typeof sample.t === 'number' && isTuple(sample.pos, 3) && isTuple(sample.vel, 3) && isTuple(sample.quat, 4);
}

function isTuple(value: unknown, length: number): value is readonly number[] {
  return Array.isArray(value) && value.length === length && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function toLstmGateWeights(rawWeights: Float32Array[]): Float32Array[] {
  if (rawWeights.length < 5) return rawWeights;
  const kernel = rawWeights[0];
  const recurrent = rawWeights[1];
  const bias = rawWeights[2];
  const projection = rawWeights[3];
  const projectionBias = rawWeights[4];
  const hidden = 16;
  const split = (source: Float32Array, rows: number, gate: number): Float32Array => {
    const out = new Float32Array(rows * hidden);
    for (let row = 0; row < rows; row += 1) for (let col = 0; col < hidden; col += 1) out[row * hidden + col] = source[row * hidden * 4 + gate * hidden + col] ?? 0;
    return out;
  };
  const gateBias = (gate: number): Float32Array => bias.slice(gate * hidden, gate * hidden + hidden);
  return [split(kernel, INPUT_WIDTH, 1), split(kernel, INPUT_WIDTH, 0), split(kernel, INPUT_WIDTH, 2), split(kernel, INPUT_WIDTH, 3), split(recurrent, hidden, 1), split(recurrent, hidden, 0), split(recurrent, hidden, 2), split(recurrent, hidden, 3), gateBias(1), gateBias(0), gateBias(2), gateBias(3), projection.slice(0, hidden * OUTPUT_WIDTH), projectionBias.slice(0, OUTPUT_WIDTH)];
}

function onIdle(): Promise<void> {
  if (typeof window !== 'undefined' && window.requestIdleCallback) {
    return new Promise((resolve) => window.requestIdleCallback?.(() => resolve(), { timeout: 500 }) ?? resolve());
  }
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/** Captures one motion sample into sessionStorage, keeping at most 60 seconds at 30 fps. */
export function captureSample(sample: MotionSample): void {
  const all = readSamples();
  if (all.length >= MAX_SAMPLES) all.shift();
  all.push(sample);
  sessionStorage.setItem(SAMPLES_KEY, JSON.stringify(all));
}

/** Trains a tiny in-browser LSTM on captured session motion and persists its 14 tensors. */
export async function trainOnCapturedData(): Promise<void> {
  const samples = readSamples();
  if (samples.length < 100) {
    console.warn('[LSTM] Insufficient data for training');
    return;
  }
  await onIdle();
  await import('@tensorflow/tfjs-backend-webgpu');
  const tf = await import('@tensorflow/tfjs-core');
  await tf.setBackend('webgpu').catch(async () => { await tf.setBackend('webgl'); });
  await tf.ready();
  const x: number[][][] = [];
  const y: number[][] = [];
  for (let i = INPUT_FRAMES; i < samples.length; i += 1) {
    x.push(samples.slice(i - INPUT_FRAMES, i).map((sample) => [...sample.pos, ...sample.vel, ...sample.quat.slice(0, 3)]));
    y.push([...samples[i].pos, ...samples[i].quat]);
  }
  const model = tf.sequential({ layers: [tf.layers.lstm({ units: 16, inputShape: [INPUT_FRAMES, INPUT_WIDTH], returnSequences: false }), tf.layers.dense({ units: OUTPUT_WIDTH })] });
  model.compile({ optimizer: tf.train.adam(0.001), loss: 'meanSquaredError' });
  const xTensor = tf.tensor3d(x);
  const yTensor = tf.tensor2d(y);
  try {
    await model.fit(xTensor, yTensor, { epochs: 10, batchSize: 32, callbacks: { onEpochEnd: async (epoch, logs) => console.info(`[LSTM train] epoch ${epoch} loss=${Number(logs?.loss ?? 0).toFixed(4)}`) } });
    const weights = model.getWeights().map((weight) => new Float32Array(weight.dataSync()));
    await saveWeights(LSTM_WEIGHT_KEY, toLstmGateWeights(weights));
  } finally {
    xTensor.dispose();
    yTensor.dispose();
    model.dispose();
  }
  sessionStorage.removeItem(SAMPLES_KEY);
  console.info('[LSTM] Training complete — weights saved to IDB');
}

console.log('[MotionDataCapture] session-only capture and micro-training ready');
// VERIFY: Captured motion trains during idle time and saves 14 LSTM tensors to IDB.
