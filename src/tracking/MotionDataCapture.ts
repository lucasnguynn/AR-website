import { LSTM_WEIGHT_KEY, MLWeightManager } from './MLWeightManager';
import { PredictiveLSTM, type PredictiveLSTMWeights } from './PredictiveLSTM';
import type { FusionState } from './UKFEngine';

const STORAGE_KEY = 'wear-jewelry-ar-motion-samples';
const SAMPLE_LIMIT = 1800;
const MIN_SAMPLE_INTERVAL_MS = 1000 / 30;
const TRAINING_EPOCHS = 10;
const INPUT = 9;
const OUTPUT = 7;

type MotionSample = readonly [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
type TensorLike = { dispose(): void; data(): Promise<Float32Array | Int32Array | Uint8Array>; };
type ModelLike = { fit(xs: TensorLike, ys: TensorLike, options: { epochs: number; verbose: number; shuffle: boolean; batchSize: number }): Promise<unknown>; predict(xs: TensorLike): TensorLike; dispose(): void; };
type TFJSLike = { sequential(): { add(layer: unknown): void; compile(options: unknown): void; fit: ModelLike['fit']; predict: ModelLike['predict']; dispose: ModelLike['dispose']; }; layers: { dense(options: { inputShape?: number[]; units: number; activation?: string; }): unknown; }; tensor2d(values: Float32Array, shape: [number, number]): TensorLike; train: { adam(learningRate: number): unknown; }; };

type IdleDeadlineLike = { timeRemaining(): number; didTimeout: boolean; };
type IdleWindow = Window & { requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout: number }) => number; tf?: TFJSLike; };

function readSamples(): MotionSample[] {
  if (typeof sessionStorage === 'undefined') return [];
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try { const parsed = JSON.parse(raw) as MotionSample[]; return Array.isArray(parsed) ? parsed.slice(-SAMPLE_LIMIT) : []; }
  catch { return []; }
}

function writeSamples(samples: readonly MotionSample[]): void {
  if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(STORAGE_KEY, JSON.stringify(samples.slice(-SAMPLE_LIMIT)));
}

function toSample(state: FusionState): MotionSample {
  return [state.timestamp, state.position[0], state.position[1], state.position[2], state.velocity[0], state.velocity[1], state.velocity[2], state.acceleration[0], state.acceleration[1], state.acceleration[2], state.orientation[0], state.orientation[1], state.orientation[2], state.orientation[3], state.quaternionUKF?.[0] ?? state.orientation[3], state.scaleUKF];
}

function makeTrainingMatrices(samples: readonly MotionSample[]): { xs: Float32Array; ys: Float32Array; rows: number } {
  const rows = Math.max(0, samples.length - 1);
  const xs = new Float32Array(rows * INPUT);
  const ys = new Float32Array(rows * OUTPUT);
  for (let r = 0; r < rows; r += 1) {
    const current = samples[r]; const next = samples[r + 1];
    xs.set(current.slice(1, 10), r * INPUT);
    ys[r * OUTPUT] = next[1] - current[1]; ys[r * OUTPUT + 1] = next[2] - current[2]; ys[r * OUTPUT + 2] = next[3] - current[3];
    ys[r * OUTPUT + 3] = next[13] - current[13]; ys[r * OUTPUT + 4] = next[10] - current[10]; ys[r * OUTPUT + 5] = next[11] - current[11]; ys[r * OUTPUT + 6] = next[12] - current[12];
  }
  return { xs, ys, rows };
}

function requestIdle(callback: () => void): void {
  if (typeof window === 'undefined') return;
  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback) idleWindow.requestIdleCallback(() => callback(), { timeout: 2000 });
  else window.setTimeout(callback, 0);
}

export class MotionDataCapture {
  private samples: MotionSample[] = readSamples();
  private lastTimestamp = this.samples.length > 0 ? this.samples[this.samples.length - 1][0] : -Infinity;
  private training = false;

  capture(state: FusionState): void {
    if (state.timestamp - this.lastTimestamp < MIN_SAMPLE_INTERVAL_MS) return;
    this.lastTimestamp = state.timestamp;
    this.samples.push(toSample(state));
    if (this.samples.length > SAMPLE_LIMIT) this.samples = this.samples.slice(-SAMPLE_LIMIT);
    writeSamples(this.samples);
    if (this.samples.length === SAMPLE_LIMIT) this.scheduleTraining();
  }

  clear(): void { this.samples = []; this.lastTimestamp = -Infinity; if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(STORAGE_KEY); }

  async trainNow(tf = (typeof window !== 'undefined' ? (window as IdleWindow).tf : undefined), hiddenSize = 16): Promise<PredictiveLSTMWeights | null> {
    if (!tf || this.samples.length < SAMPLE_LIMIT) return null;
    const { xs, ys, rows } = makeTrainingMatrices(this.samples);
    if (rows < 1) return null;
    const model = tf.sequential();
    model.add(tf.layers.dense({ inputShape: [INPUT], units: hiddenSize, activation: 'tanh' }));
    model.add(tf.layers.dense({ units: OUTPUT }));
    model.compile({ optimizer: tf.train.adam(0.003), loss: 'meanSquaredError' });
    const xTensor = tf.tensor2d(xs, [rows, INPUT]);
    const yTensor = tf.tensor2d(ys, [rows, OUTPUT]);
    try {
      await model.fit(xTensor, yTensor, { epochs: TRAINING_EPOCHS, verbose: 0, shuffle: false, batchSize: 32 });
      const predictions = model.predict(xTensor);
      const trained = await predictions.data();
      predictions.dispose();
      const weights = PredictiveLSTM.createDefaultWeights(hiddenSize);
      for (let o = 0; o < OUTPUT; o += 1) weights.projectionBias[o] = trained[o] ?? 0;
      await MLWeightManager.update(LSTM_WEIGHT_KEY, hiddenSize, weights);
      return weights;
    } finally { xTensor.dispose(); yTensor.dispose(); model.dispose(); }
  }

  private scheduleTraining(): void {
    if (this.training) return;
    this.training = true;
    requestIdle(() => { void this.trainNow().finally(() => { this.training = false; }); });
  }
}
