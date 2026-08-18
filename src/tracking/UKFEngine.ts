export interface Keypoint2DMeasurement { readonly x: number; readonly y: number; readonly confidence: number; readonly timestamp: number; }
export interface Pose6DoFMeasurement { readonly position: Float32Array | readonly number[]; readonly orientation: Float32Array | readonly number[]; readonly confidence: number; readonly timestamp: number; }
export interface FusionState { readonly position: Float32Array; readonly velocity: Float32Array; readonly acceleration: Float32Array; readonly orientation: Float32Array; readonly covariance: Float32Array; readonly timestamp: number; }

const N = 9;
const SIGMA = N * 2 + 1;
const ALPHA = 1e-3;
const BETA = 2;
const KAPPA = 0;
const LAMBDA = ALPHA * ALPHA * (N + KAPPA) - N;
const GAMMA = Math.sqrt(N + LAMBDA);
const WM0 = LAMBDA / (N + LAMBDA);
const WC0 = WM0 + (1 - ALPHA * ALPHA + BETA);
const WI = 1 / (2 * (N + LAMBDA));
const EPS = 1e-6;

export class UKFEngine {
  private readonly x = new Float32Array(N);
  private readonly p = new Float32Array(N * N);
  private readonly sigma = new Float32Array(SIGMA * N);
  private readonly propagated = new Float32Array(SIGMA * N);
  private readonly mean = new Float32Array(N);
  private readonly scratch = new Float32Array(N * N);
  private readonly k = new Float32Array(N);
  private readonly orientation = new Float32Array([0, 0, 0, 1]);
  private readonly state: FusionState;
  private initialized = false;
  private lastTimestamp = 0;

  constructor(processNoise = 0.035) {
    for (let i = 0; i < N; i += 1) this.p[i * N + i] = i < 3 ? 0.015 : i < 6 ? 0.08 : 0.18;
    this.state = { position: this.x.subarray(0, 3), velocity: this.x.subarray(3, 6), acceleration: this.x.subarray(6, 9), orientation: this.orientation, covariance: this.p, timestamp: 0 };
    this.processNoise = processNoise;
  }

  processNoise: number;

  reset(): void {
    this.x.fill(0); this.p.fill(0); this.orientation[0] = 0; this.orientation[1] = 0; this.orientation[2] = 0; this.orientation[3] = 1;
    for (let i = 0; i < N; i += 1) this.p[i * N + i] = i < 3 ? 0.015 : i < 6 ? 0.08 : 0.18;
    this.initialized = false; this.lastTimestamp = 0;
  }

  predict(timestamp: number): FusionState {
    if (!this.initialized) { this.lastTimestamp = timestamp; return this.publish(timestamp); }
    const dt = Math.max(1 / 240, Math.min((timestamp - this.lastTimestamp) * 0.001, 1 / 20));
    this.lastTimestamp = timestamp;
    this.computeSigmaPoints();
    for (let s = 0; s < SIGMA; s += 1) {
      const o = s * N;
      this.propagated[o] = this.sigma[o] + this.sigma[o + 3] * dt + 0.5 * this.sigma[o + 6] * dt * dt;
      this.propagated[o + 1] = this.sigma[o + 1] + this.sigma[o + 4] * dt + 0.5 * this.sigma[o + 7] * dt * dt;
      this.propagated[o + 2] = this.sigma[o + 2] + this.sigma[o + 5] * dt + 0.5 * this.sigma[o + 8] * dt * dt;
      this.propagated[o + 3] = this.sigma[o + 3] + this.sigma[o + 6] * dt;
      this.propagated[o + 4] = this.sigma[o + 4] + this.sigma[o + 7] * dt;
      this.propagated[o + 5] = this.sigma[o + 5] + this.sigma[o + 8] * dt;
      this.propagated[o + 6] = this.sigma[o + 6]; this.propagated[o + 7] = this.sigma[o + 7]; this.propagated[o + 8] = this.sigma[o + 8];
    }
    this.unscentedMeanCovariance(dt);
    return this.publish(timestamp);
  }

  updateKeypoint2D(m: Keypoint2DMeasurement, depthMeters = 0): FusionState {
    if (!this.initialized) { this.x[0] = m.x; this.x[1] = m.y; this.x[2] = depthMeters; this.initialized = true; this.lastTimestamp = m.timestamp; }
    else this.predict(m.timestamp);
    this.scalarUpdate(0, m.x, Math.max(0.0004, 0.018 / Math.max(m.confidence, 0.05)));
    this.scalarUpdate(1, m.y, Math.max(0.0004, 0.018 / Math.max(m.confidence, 0.05)));
    if (Number.isFinite(depthMeters)) this.scalarUpdate(2, depthMeters, 0.05);
    return this.publish(m.timestamp);
  }

  updatePose6DoF(m: Pose6DoFMeasurement): FusionState {
    if (!this.initialized) { this.x[0] = m.position[0]; this.x[1] = m.position[1]; this.x[2] = m.position[2]; this.initialized = true; this.lastTimestamp = m.timestamp; }
    else this.predict(m.timestamp);
    const r = Math.max(0.00001, 0.004 / Math.max(m.confidence, 0.05));
    this.scalarUpdate(0, m.position[0], r); this.scalarUpdate(1, m.position[1], r); this.scalarUpdate(2, m.position[2], r);
    this.orientation[0] += (m.orientation[0] - this.orientation[0]) * m.confidence;
    this.orientation[1] += (m.orientation[1] - this.orientation[1]) * m.confidence;
    this.orientation[2] += (m.orientation[2] - this.orientation[2]) * m.confidence;
    this.orientation[3] += (m.orientation[3] - this.orientation[3]) * m.confidence;
    this.normalizeOrientation();
    return this.publish(m.timestamp);
  }

  private computeSigmaPoints(): void {
    this.cholesky();
    this.sigma.set(this.x, 0);
    for (let c = 0; c < N; c += 1) for (let r = 0; r < N; r += 1) {
      const v = GAMMA * this.scratch[r * N + c];
      this.sigma[(1 + c) * N + r] = this.x[r] + v;
      this.sigma[(1 + N + c) * N + r] = this.x[r] - v;
    }
  }

  private unscentedMeanCovariance(dt: number): void {
    this.mean.fill(0); this.p.fill(0);
    for (let s = 0; s < SIGMA; s += 1) { const w = s === 0 ? WM0 : WI; for (let i = 0; i < N; i += 1) this.mean[i] += w * this.propagated[s * N + i]; }
    for (let s = 0; s < SIGMA; s += 1) { const w = s === 0 ? WC0 : WI; const o = s * N; for (let i = 0; i < N; i += 1) for (let j = 0; j < N; j += 1) this.p[i * N + j] += w * (this.propagated[o + i] - this.mean[i]) * (this.propagated[o + j] - this.mean[j]); }
    this.x.set(this.mean); const q = this.processNoise * dt; for (let i = 0; i < N; i += 1) this.p[i * N + i] += q + EPS;
  }

  private scalarUpdate(index: number, measurement: number, noise: number): void {
    const innovationVariance = this.p[index * N + index] + noise;
    for (let i = 0; i < N; i += 1) this.k[i] = this.p[i * N + index] / innovationVariance;
    const residual = measurement - this.x[index];
    for (let i = 0; i < N; i += 1) this.x[i] += this.k[i] * residual;
    for (let i = 0; i < N; i += 1) for (let j = 0; j < N; j += 1) this.p[i * N + j] -= this.k[i] * this.p[index * N + j];
  }

  private cholesky(): void {
    this.scratch.fill(0);
    for (let i = 0; i < N; i += 1) for (let j = 0; j <= i; j += 1) {
      let sum = this.p[i * N + j];
      for (let k = 0; k < j; k += 1) sum -= this.scratch[i * N + k] * this.scratch[j * N + k];
      this.scratch[i * N + j] = i === j ? Math.sqrt(Math.max(sum, EPS)) : sum / Math.max(this.scratch[j * N + j], EPS);
    }
  }

  private normalizeOrientation(): void {
    const inv = 1 / Math.hypot(this.orientation[0], this.orientation[1], this.orientation[2], this.orientation[3]);
    this.orientation[0] *= inv; this.orientation[1] *= inv; this.orientation[2] *= inv; this.orientation[3] *= inv;
  }

  private publish(timestamp: number): FusionState { (this.state as { timestamp: number }).timestamp = timestamp; return this.state; }
}
