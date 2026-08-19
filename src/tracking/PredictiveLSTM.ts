// FILE: src/tracking/PredictiveLSTM.ts
import { LSTM_WEIGHT_KEY, loadWeights, saveWeights } from './MLWeightManager';
import type { FusionState } from './UKFEngine';

/** Complete predictive LSTM tensor bundle. */
export interface PredictiveLSTMWeights {
  readonly inputKernel: Float32Array;
  readonly recurrentKernel: Float32Array;
  readonly bias: Float32Array;
  readonly projection: Float32Array;
  readonly projectionBias: Float32Array;
}

/** Predicted pose returned by the recurrent tracker. */
export interface PredictedPose { readonly position: Float32Array; readonly orientation: Float32Array; readonly horizonMs: number; readonly confidence: number; }

const INPUT = 9;
const OUTPUT = 7;

function sigmoid(x: number): number { return 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, x)))); }

/** Lightweight deterministic LSTM pose predictor with IndexedDB weight persistence. */
export class PredictiveLSTM {
  private readonly hiddenSize: number;
  private weights: PredictiveLSTMWeights;
  private readonly hidden: Float32Array;
  private readonly cell: Float32Array;
  private readonly gates: Float32Array;
  private readonly input: Float32Array;
  private readonly output: PredictedPose;
  private readonly outPosition = new Float32Array(3);
  private readonly outOrientation = new Float32Array([0, 0, 0, 1]);
  private confidence = 0.5;

  constructor(hiddenSize = 16, weights?: PredictiveLSTMWeights) {
    this.hiddenSize = hiddenSize;
    this.weights = weights ?? PredictiveLSTM.createDefaultWeights(hiddenSize);
    this.hidden = new Float32Array(hiddenSize);
    this.cell = new Float32Array(hiddenSize);
    this.gates = new Float32Array(hiddenSize * 4);
    this.input = new Float32Array(INPUT);
    this.output = { position: this.outPosition, orientation: this.outOrientation, horizonMs: 0, confidence: 0 };
    if (!weights) void this.init();
  }

  /** Resets recurrent state and confidence without changing weights. */
  reset(): void { this.hidden.fill(0); this.cell.fill(0); this.confidence = 0.5; }

  /** Loads persisted weights when available, otherwise keeps deterministic Xavier-style defaults. */
  async init(): Promise<void> {
    const saved = await loadWeights(LSTM_WEIGHT_KEY).catch(() => null);
    if (saved && this.loadFromArrays(saved)) {
      console.info(`[LSTM] Loaded from IDB — ${saved.length} weight tensors`);
      return;
    }
    this.weights = PredictiveLSTM.createDefaultWeights(this.hiddenSize);
    this.reset();
    console.info('[LSTM] Xavier init (no saved weights)');
  }

  /** Backwards-compatible persisted weight loader. */
  async loadPersistedWeights(): Promise<boolean> {
    const saved = await loadWeights(LSTM_WEIGHT_KEY).catch(() => null);
    return saved ? this.loadFromArrays(saved) : false;
  }

  /** Returns the active LSTM tensor bundle. */
  getWeights(): PredictiveLSTMWeights { return this.weights; }

  /** Persists the complete 14-tensor gate-split LSTM weight set to IndexedDB. */
  async saveCurrentWeights(): Promise<void> {
    await saveWeights(LSTM_WEIGHT_KEY, this.toArrays());
  }

  /** Returns a defensive copy of every persisted tensor for deterministic backup/reload validation. */
  exportWeightTensors(): Float32Array[] { return this.toArrays(); }

  /** Loads a complete validated persisted tensor set; corrupted or partial sets are rejected. */
  importWeightTensors(tensors: Float32Array[]): boolean { return this.loadFromArrays(tensors); }

  /** Predicts future pose at the requested horizon. */
  predict(state: FusionState, horizonMs: 16.667 | 33.334 | number = 16.667): PredictedPose {
    const dt = horizonMs * 0.001;
    this.input[0] = state.position[0]; this.input[1] = state.position[1]; this.input[2] = state.position[2];
    this.input[3] = state.velocity[0]; this.input[4] = state.velocity[1]; this.input[5] = state.velocity[2];
    this.input[6] = state.acceleration[0]; this.input[7] = state.acceleration[1]; this.input[8] = state.acceleration[2];
    this.step();
    this.project(state, dt);
    (this.output as { horizonMs: number; confidence: number }).horizonMs = horizonMs;
    (this.output as { confidence: number }).confidence = this.confidence;
    return this.output;
  }

  private step(): void {
    const h = this.hiddenSize;
    const inputKernel = this.weights.inputKernel;
    const recurrentKernel = this.weights.recurrentKernel;
    const bias = this.weights.bias;
    for (let g = 0; g < h * 4; g += 1) {
      let sum = bias[g];
      for (let i = 0; i < INPUT; i += 1) sum += this.input[i] * inputKernel[i * h * 4 + g];
      for (let i = 0; i < h; i += 1) sum += this.hidden[i] * recurrentKernel[i * h * 4 + g];
      this.gates[g] = sum;
    }
    for (let i = 0; i < h; i += 1) {
      const inputGate = sigmoid(this.gates[i]);
      const forgetGate = sigmoid(this.gates[h + i]);
      const candidate = Math.tanh(this.gates[h * 2 + i]);
      const outputGate = sigmoid(this.gates[h * 3 + i]);
      this.cell[i] = forgetGate * this.cell[i] + inputGate * candidate;
      this.hidden[i] = outputGate * Math.tanh(this.cell[i]);
    }
  }

  private project(state: FusionState, dt: number): void {
    const p = this.weights.projection;
    const b = this.weights.projectionBias;
    for (let o = 0; o < OUTPUT; o += 1) {
      let sum = b[o];
      for (let i = 0; i < this.hiddenSize; i += 1) sum += this.hidden[i] * p[i * OUTPUT + o];
      if (o < 3) this.outPosition[o] = state.position[o] + state.velocity[o] * dt + 0.5 * state.acceleration[o] * dt * dt + sum;
      else this.outOrientation[o - 3] = state.orientation[o - 3] + sum;
    }
    const inv = 1 / Math.hypot(this.outOrientation[0], this.outOrientation[1], this.outOrientation[2], this.outOrientation[3]);
    this.outOrientation[0] *= inv; this.outOrientation[1] *= inv; this.outOrientation[2] *= inv; this.outOrientation[3] *= inv;
    const motion = Math.hypot(state.velocity[0], state.velocity[1], state.velocity[2]) + Math.hypot(state.acceleration[0], state.acceleration[1], state.acceleration[2]) * dt;
    this.confidence = Math.max(0.15, Math.min(0.98, 0.94 - motion * 0.08));
  }

  private toArrays(): Float32Array[] {
    const h = this.hiddenSize;
    const gates = h * 4;
    const splitInput = (gate: number): Float32Array => {
      const out = new Float32Array(INPUT * h);
      for (let i = 0; i < INPUT; i += 1) for (let j = 0; j < h; j += 1) out[i * h + j] = this.weights.inputKernel[i * gates + gate * h + j];
      return out;
    };
    const splitRecurrent = (gate: number): Float32Array => {
      const out = new Float32Array(h * h);
      for (let i = 0; i < h; i += 1) for (let j = 0; j < h; j += 1) out[i * h + j] = this.weights.recurrentKernel[i * gates + gate * h + j];
      return out;
    };
    const splitBias = (gate: number): Float32Array => this.weights.bias.slice(gate * h, gate * h + h);
    return [splitInput(1), splitInput(0), splitInput(2), splitInput(3), splitRecurrent(1), splitRecurrent(0), splitRecurrent(2), splitRecurrent(3), splitBias(1), splitBias(0), splitBias(2), splitBias(3), new Float32Array(this.weights.projection), new Float32Array(this.weights.projectionBias)];
  }

  private loadFromArrays(arrays: Float32Array[]): boolean {
    if (arrays.length === 5 && this.validCombinedShapes(arrays)) {
      this.weights = { inputKernel: new Float32Array(arrays[0]), recurrentKernel: new Float32Array(arrays[1]), bias: new Float32Array(arrays[2]), projection: new Float32Array(arrays[3]), projectionBias: new Float32Array(arrays[4]) };
      this.reset();
      return true;
    }
    if (arrays.length !== 14 || !this.validSplitShapes(arrays)) return false;
    const h = this.hiddenSize;
    const gates = h * 4;
    const inputKernel = new Float32Array(INPUT * gates);
    const recurrentKernel = new Float32Array(h * gates);
    const bias = new Float32Array(gates);
    const order = [1, 0, 2, 3];
    for (let source = 0; source < 4; source += 1) {
      const gate = order[source];
      for (let i = 0; i < INPUT; i += 1) for (let j = 0; j < h; j += 1) inputKernel[i * gates + gate * h + j] = arrays[source][i * h + j] ?? 0;
      for (let i = 0; i < h; i += 1) for (let j = 0; j < h; j += 1) recurrentKernel[i * gates + gate * h + j] = arrays[source + 4][i * h + j] ?? 0;
      bias.set(arrays[source + 8].slice(0, h), gate * h);
    }
    this.weights = { inputKernel, recurrentKernel, bias, projection: new Float32Array(arrays[12]), projectionBias: new Float32Array(arrays[13]) };
    this.reset();
    return true;
  }

  private validCombinedShapes(arrays: Float32Array[]): boolean {
    const h = this.hiddenSize;
    return arrays.every((tensor) => tensor instanceof Float32Array && tensor.every(Number.isFinite))
      && arrays[0].length === INPUT * h * 4 && arrays[1].length === h * h * 4 && arrays[2].length === h * 4
      && arrays[3].length === h * OUTPUT && arrays[4].length === OUTPUT;
  }

  private validSplitShapes(arrays: Float32Array[]): boolean {
    const h = this.hiddenSize;
    return arrays.every((tensor) => tensor instanceof Float32Array && tensor.every(Number.isFinite))
      && arrays.slice(0, 4).every((tensor) => tensor.length === INPUT * h)
      && arrays.slice(4, 8).every((tensor) => tensor.length === h * h)
      && arrays.slice(8, 12).every((tensor) => tensor.length === h)
      && arrays[12].length === h * OUTPUT && arrays[13].length === OUTPUT;
  }

  /** Creates deterministic default LSTM weights. */
  static createDefaultWeights(hiddenSize: number): PredictiveLSTMWeights {
    const gates = hiddenSize * 4;
    const inputKernel = new Float32Array(INPUT * gates);
    const recurrentKernel = new Float32Array(hiddenSize * gates);
    const bias = new Float32Array(gates);
    const projection = new Float32Array(hiddenSize * OUTPUT);
    const projectionBias = new Float32Array(OUTPUT);
    for (let i = 0; i < inputKernel.length; i += 1) inputKernel[i] = Math.sin(i * 12.9898) * 0.012;
    for (let i = 0; i < recurrentKernel.length; i += 1) recurrentKernel[i] = Math.cos(i * 78.233) * 0.006;
    for (let i = hiddenSize; i < hiddenSize * 2; i += 1) bias[i] = 1;
    for (let i = 0; i < projection.length; i += 1) projection[i] = Math.sin(i * 3.17) * 0.0008;
    return { inputKernel, recurrentKernel, bias, projection, projectionBias };
  }
}

console.log('[PredictiveLSTM] persistence and confidence decay ready');
// VERIFY: Second load: "[LSTM] Loaded from IDB — 14 weight tensors"
