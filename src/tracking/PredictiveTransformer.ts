// FILE: src/tracking/PredictiveTransformer.ts
import type { FusionState } from './UKFEngine';

/** Predicted pose returned by the deterministic transformer tracker. */
export interface PredictedPose { readonly position: Float32Array; readonly orientation: Float32Array; readonly horizonMs: number; readonly confidence: number; }

const SEQ = 8;
const INPUT = 15;
const MODEL = 32;
const FF = 64;
const HEADS = 4;
const HEAD = MODEL / HEADS;
const LAYERS = 2;
const OUTPUT = 7;

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}

const GLOBAL_SEED = 42;
const _rng = splitmix32(GLOBAL_SEED);

function xavier(length: number, fanIn: number, fanOut: number): Float32Array {
  const a = new Float32Array(length);
  const limit = Math.sqrt(6 / (fanIn + fanOut));
  for (let i = 0; i < length; i += 1) a[i] = (_rng() * 2 - 1) * limit;
  return a;
}

/** Seeded Transformer pose predictor with deterministic Xavier initialization. */
export class PredictiveTransformer {
  private readonly history = new Float32Array(SEQ * INPUT);
  private readonly x = new Float32Array(SEQ * MODEL);
  private readonly y = new Float32Array(SEQ * MODEL);
  private readonly q = new Float32Array(SEQ * MODEL);
  private readonly k = new Float32Array(SEQ * MODEL);
  private readonly v = new Float32Array(SEQ * MODEL);
  private readonly attn = new Float32Array(SEQ * SEQ);
  private readonly ff = new Float32Array(SEQ * FF);
  private readonly residual = new Float32Array(OUTPUT);
  private readonly outPosition = new Float32Array(3);
  private readonly outOrientation = new Float32Array([0, 0, 0, 1]);
  private readonly output: PredictedPose = { position: this.outPosition, orientation: this.outOrientation, horizonMs: 0, confidence: 0 };
  private filled = 0;
  private cursor = 0;

  private readonly inW = xavier(INPUT * MODEL, INPUT, MODEL);
  private readonly pos = xavier(SEQ * MODEL, SEQ, MODEL);
  private readonly wq = xavier(LAYERS * MODEL * MODEL, MODEL, MODEL);
  private readonly wk = xavier(LAYERS * MODEL * MODEL, MODEL, MODEL);
  private readonly wv = xavier(LAYERS * MODEL * MODEL, MODEL, MODEL);
  private readonly wo = xavier(LAYERS * MODEL * MODEL, MODEL, MODEL);
  private readonly w1 = xavier(LAYERS * MODEL * FF, MODEL, FF);
  private readonly w2 = xavier(LAYERS * FF * MODEL, FF, MODEL);
  private readonly outW = xavier(MODEL * OUTPUT, MODEL, OUTPUT);

  /** Clears temporal history while preserving deterministic weights. */
  reset(): void { this.history.fill(0); this.filled = 0; this.cursor = 0; }

  /** Predicts a future pose from the current fusion state. */
  predict(state: FusionState, horizonMs: 16.667 | 33.334 | number = 16.667): PredictedPose {
    this.pushState(state);
    this.embed();
    for (let layer = 0; layer < LAYERS; layer += 1) this.layer(layer);
    this.project(state, horizonMs);
    return this.output;
  }

  private pushState(s: FusionState): void {
    const o = this.cursor * INPUT;
    this.history[o] = s.position[0]; this.history[o + 1] = s.position[1]; this.history[o + 2] = s.position[2];
    this.history[o + 3] = s.velocity[0]; this.history[o + 4] = s.velocity[1]; this.history[o + 5] = s.velocity[2];
    this.history[o + 6] = s.acceleration[0]; this.history[o + 7] = s.acceleration[1]; this.history[o + 8] = s.acceleration[2];
    const q = s.quaternionUKF;
    if (q) { this.history[o + 9] = q[0]; this.history[o + 10] = q[1]; this.history[o + 11] = q[2]; this.history[o + 12] = q[3]; }
    else { this.history[o + 9] = s.orientation[3]; this.history[o + 10] = s.orientation[0]; this.history[o + 11] = s.orientation[1]; this.history[o + 12] = s.orientation[2]; }
    this.history[o + 13] = s.scaleUKF; this.history[o + 14] = s.timestamp * 0.001;
    this.cursor = (this.cursor + 1) & (SEQ - 1); if (this.filled < SEQ) this.filled += 1;
  }

  private embed(): void {
    for (let t = 0; t < SEQ; t += 1) {
      const src = ((this.cursor + t) & (SEQ - 1)) * INPUT;
      const dst = t * MODEL;
      for (let m = 0; m < MODEL; m += 1) { let sum = this.pos[dst + m]; for (let i = 0; i < INPUT; i += 1) sum += this.history[src + i] * this.inW[i * MODEL + m]; this.x[dst + m] = this.filled === SEQ || t >= SEQ - this.filled ? sum : 0; }
    }
  }

  private layer(layer: number): void {
    this.matmulSeq(this.x, this.wq, layer * MODEL * MODEL, this.q, MODEL);
    this.matmulSeq(this.x, this.wk, layer * MODEL * MODEL, this.k, MODEL);
    this.matmulSeq(this.x, this.wv, layer * MODEL * MODEL, this.v, MODEL);
    this.attention();
    this.matmulSeq(this.y, this.wo, layer * MODEL * MODEL, this.q, MODEL);
    for (let i = 0; i < this.x.length; i += 1) this.x[i] += this.q[i];
    this.matmulSeq(this.x, this.w1, layer * MODEL * FF, this.ff, FF);
    for (let i = 0; i < this.ff.length; i += 1) this.ff[i] = Math.max(0, this.ff[i]);
    this.matmulSeq(this.ff, this.w2, layer * FF * MODEL, this.y, MODEL);
    for (let i = 0; i < this.x.length; i += 1) this.x[i] += this.y[i];
  }

  private matmulSeq(a: Float32Array, w: Float32Array, wo: number, out: Float32Array, cols: number): void { for (let t = 0; t < SEQ; t += 1) for (let c = 0; c < cols; c += 1) { let sum = 0; const ar = t * (a.length / SEQ); const width = a.length / SEQ; for (let i = 0; i < width; i += 1) sum += a[ar + i] * w[wo + i * cols + c]; out[t * cols + c] = sum; } }

  private attention(): void {
    const scale = 1 / Math.sqrt(HEAD);
    this.y.fill(0);
    for (let h = 0; h < HEADS; h += 1) for (let t = 0; t < SEQ; t += 1) {
      let max = -Infinity; const ao = t * SEQ;
      for (let j = 0; j < SEQ; j += 1) { let dot = 0; for (let d = 0; d < HEAD; d += 1) dot += this.q[t * MODEL + h * HEAD + d] * this.k[j * MODEL + h * HEAD + d]; const val = dot * scale; this.attn[ao + j] = val; if (val > max) max = val; }
      let denom = 0; for (let j = 0; j < SEQ; j += 1) { const e = Math.exp(this.attn[ao + j] - max); this.attn[ao + j] = e; denom += e; }
      for (let d = 0; d < HEAD; d += 1) { let sum = 0; for (let j = 0; j < SEQ; j += 1) sum += (this.attn[ao + j] / denom) * this.v[j * MODEL + h * HEAD + d]; this.y[t * MODEL + h * HEAD + d] = sum; }
    }
  }

  private project(state: FusionState, horizonMs: number): void {
    const row = (SEQ - 1) * MODEL;
    for (let o = 0; o < OUTPUT; o += 1) { let sum = 0; for (let i = 0; i < MODEL; i += 1) sum += this.x[row + i] * this.outW[i * OUTPUT + o]; this.residual[o] = sum * 0.01; }
    const dt = horizonMs * 0.001;
    for (let i = 0; i < 3; i += 1) this.outPosition[i] = state.position[i] + state.velocity[i] * dt + 0.5 * state.acceleration[i] * dt * dt + this.residual[i];
    const q = state.quaternionUKF;
    const qw = q ? q[0] : state.orientation[3];
    const qx = q ? q[1] : state.orientation[0];
    const qy = q ? q[2] : state.orientation[1];
    const qz = q ? q[3] : state.orientation[2];
    this.outOrientation[0] = qx + this.residual[4]; this.outOrientation[1] = qy + this.residual[5]; this.outOrientation[2] = qz + this.residual[6]; this.outOrientation[3] = qw + this.residual[3];
    const inv = 1 / Math.max(1e-6, Math.hypot(this.outOrientation[0], this.outOrientation[1], this.outOrientation[2], this.outOrientation[3]));
    this.outOrientation[0] *= inv; this.outOrientation[1] *= inv; this.outOrientation[2] *= inv; this.outOrientation[3] *= inv;
    const motion = Math.hypot(state.velocity[0], state.velocity[1], state.velocity[2]) + Math.hypot(state.acceleration[0], state.acceleration[1], state.acceleration[2]) * dt;
    (this.output as { horizonMs: number; confidence: number }).horizonMs = horizonMs; (this.output as { confidence: number }).confidence = Math.max(0.12, Math.min(0.97, 0.9 - motion * 0.07));
  }
}

console.log('[PredictiveTransformer] splitmix32 seeded Xavier ready');
// VERIFY: Transformer same input yields same output across 10 browser refreshes.
