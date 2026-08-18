import type { FusionState } from './UKFEngine';

export interface PredictiveLSTMWeights {
  readonly inputKernel: Float32Array;
  readonly recurrentKernel: Float32Array;
  readonly bias: Float32Array;
  readonly projection: Float32Array;
  readonly projectionBias: Float32Array;
}

export interface PredictedPose { readonly position: Float32Array; readonly orientation: Float32Array; readonly horizonMs: number; readonly confidence: number; }

const INPUT = 9;
const OUTPUT = 7;

function sigmoid(x: number): number { return 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, x)))); }

export class PredictiveLSTM {
  private readonly hiddenSize: number;
  private readonly weights: PredictiveLSTMWeights;
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
  }

  reset(): void { this.hidden.fill(0); this.cell.fill(0); this.confidence = 0.5; }

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
