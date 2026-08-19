export interface Keypoint2DMeasurement { readonly x: number; readonly y: number; readonly confidence: number; readonly timestamp: number; }
export interface Pose6DoFMeasurement { readonly position: Float32Array | readonly number[]; readonly orientation: Float32Array | readonly number[]; readonly confidence: number; readonly timestamp: number; readonly scale?: number; }
export interface FusionState { readonly position: Float32Array; readonly velocity: Float32Array; readonly acceleration: Float32Array; readonly orientation: Float32Array; readonly covariance: Float32Array; readonly timestamp: number; readonly quaternionUKF: Float32Array | null; readonly scaleUKF: number; }

const N = 15;
const SIGMA = N * 2 + 1;
// A very small alpha combined with Float32 storage produces enormous cancelling
// weights. 0.25 keeps the sigma cloud local without destroying precision.
const ALPHA = 0.25;
const BETA = 2;
const KAPPA = 0;
const LAMBDA = ALPHA * ALPHA * (N + KAPPA) - N;
const GAMMA = Math.sqrt(N + LAMBDA);
const WM0 = LAMBDA / (N + LAMBDA);
const WC0 = WM0 + (1 - ALPHA * ALPHA + BETA);
const WI = 1 / (2 * (N + LAMBDA));
const EPS = 1e-6;
const QW = 9;
const QX = 10;
const QY = 11;
const QZ = 12;
const SCALE = 13;
const WZ = 14;

export class UKFEngine {
  private readonly x = new Float32Array(N);
  private readonly p = new Float32Array(N * N);
  private readonly sigma = new Float32Array(SIGMA * N);
  private readonly propagated = new Float32Array(SIGMA * N);
  private readonly mean = new Float32Array(N);
  private readonly scratch = new Float32Array(N * N);
  private readonly k = new Float32Array(N);
  private readonly quaternion = this.x.subarray(QW, QZ + 1);
  private readonly orientation = new Float32Array([0, 0, 0, 1]);
  private readonly state: FusionState;
  private initialized = false;
  private lastTimestamp = 0;
  processNoise: number;

  constructor(processNoise = 0.035) {
    this.processNoise = processNoise;
    this.x[QW] = 1;
    this.x[SCALE] = 1;
    this.resetCovariance();
    this.state = { position: this.x.subarray(0, 3), velocity: this.x.subarray(3, 6), acceleration: this.x.subarray(6, 9), orientation: this.orientation, covariance: this.p, timestamp: 0, quaternionUKF: this.quaternion, scaleUKF: 1 };
  }

  reset(): void {
    this.x.fill(0); this.p.fill(0); this.x[QW] = 1; this.x[SCALE] = 1;
    this.resetCovariance(); this.initialized = false; this.lastTimestamp = 0;
  }

  predict(timestamp: number): FusionState {
    if (!this.initialized) { this.lastTimestamp = timestamp; return this.publish(timestamp); }
    const elapsed = (timestamp - this.lastTimestamp) * 0.001;
    if (elapsed <= 0) return this.publish(this.lastTimestamp);
    const dt = Math.min(elapsed, 0.1);
    this.lastTimestamp = timestamp;
    this.computeSigmaPoints();
    for (let s = 0; s < SIGMA; s += 1) this.propagateSigma(s * N, dt);
    this.unscentedMeanCovariance(dt);
    this.normalizeQuaternion(this.x, QW);
    return this.publish(timestamp);
  }

  updateKeypoint2D(m: Keypoint2DMeasurement, depthMeters = 0): FusionState {
    if (!this.initialized) { this.x[0] = m.x; this.x[1] = m.y; this.x[2] = depthMeters; this.initialized = true; this.lastTimestamp = m.timestamp; }
    else this.predict(m.timestamp);
    const r = Math.max(0.0004, 0.018 / Math.max(m.confidence, 0.05));
    this.scalarUpdate(0, m.x, r); this.scalarUpdate(1, m.y, r);
    if (Number.isFinite(depthMeters)) this.scalarUpdate(2, depthMeters, 0.05);
    return this.publish(m.timestamp);
  }

  updatePose6DoF(m: Pose6DoFMeasurement): FusionState {
    if (!this.initialized) { this.x[0] = m.position[0]; this.x[1] = m.position[1]; this.x[2] = m.position[2]; this.x[QW] = m.orientation[3]; this.x[QX] = m.orientation[0]; this.x[QY] = m.orientation[1]; this.x[QZ] = m.orientation[2]; this.x[SCALE] = m.scale ?? 1; this.initialized = true; this.lastTimestamp = m.timestamp; }
    else this.predict(m.timestamp);
    const dot = this.x[QX] * m.orientation[0] + this.x[QY] * m.orientation[1] + this.x[QZ] * m.orientation[2] + this.x[QW] * m.orientation[3];
    const sign = dot < 0 ? -1 : 1;
    const r = Math.max(0.00001, 0.004 / Math.max(m.confidence, 0.05));
    this.scalarUpdate(0, m.position[0], r); this.scalarUpdate(1, m.position[1], r); this.scalarUpdate(2, m.position[2], r);
    this.scalarUpdate(QW, m.orientation[3] * sign, r); this.scalarUpdate(QX, m.orientation[0] * sign, r); this.scalarUpdate(QY, m.orientation[1] * sign, r); this.scalarUpdate(QZ, m.orientation[2] * sign, r);
    if (m.scale !== undefined) this.scalarUpdateScale(m.scale, r);
    this.normalizeQuaternion(this.x, QW);
    return this.publish(m.timestamp);
  }

  scalarUpdateScale(scale: number, noise = 0.001): void { this.scalarUpdate(SCALE, scale, noise); this.x[SCALE] = Math.max(EPS, this.x[SCALE]); }

  private propagateSigma(o: number, dt: number): void {
    const dt2 = 0.5 * dt * dt;
    this.propagated[o] = this.sigma[o] + this.sigma[o + 3] * dt + this.sigma[o + 6] * dt2;
    this.propagated[o + 1] = this.sigma[o + 1] + this.sigma[o + 4] * dt + this.sigma[o + 7] * dt2;
    this.propagated[o + 2] = this.sigma[o + 2] + this.sigma[o + 5] * dt + this.sigma[o + 8] * dt2;
    this.propagated[o + 3] = this.sigma[o + 3] + this.sigma[o + 6] * dt; this.propagated[o + 4] = this.sigma[o + 4] + this.sigma[o + 7] * dt; this.propagated[o + 5] = this.sigma[o + 5] + this.sigma[o + 8] * dt;
    this.propagated[o + 6] = this.sigma[o + 6]; this.propagated[o + 7] = this.sigma[o + 7]; this.propagated[o + 8] = this.sigma[o + 8];
    const angle = this.sigma[o + WZ] * dt * 0.5; const c = Math.cos(angle); const z = Math.sin(angle);
    const qw = this.sigma[o + QW], qx = this.sigma[o + QX], qy = this.sigma[o + QY], qz = this.sigma[o + QZ];
    this.propagated[o + QW] = qw * c - qz * z; this.propagated[o + QX] = qx * c + qy * z; this.propagated[o + QY] = qy * c - qx * z; this.propagated[o + QZ] = qz * c + qw * z;
    this.normalizeQuaternion(this.propagated, o + QW);
    this.propagated[o + SCALE] = this.sigma[o + SCALE]; this.propagated[o + WZ] = this.sigma[o + WZ];
  }

  private computeSigmaPoints(): void { this.cholesky(); this.sigma.set(this.x, 0); for (let c = 0; c < N; c += 1) for (let r = 0; r < N; r += 1) { const v = GAMMA * this.scratch[r * N + c]; this.sigma[(1 + c) * N + r] = this.x[r] + v; this.sigma[(1 + N + c) * N + r] = this.x[r] - v; } }

  private unscentedMeanCovariance(dt: number): void { this.mean.fill(0); this.p.fill(0); for (let s = 0; s < SIGMA; s += 1) { const w = s === 0 ? WM0 : WI; const o = s * N; for (let i = 0; i < N; i += 1) this.mean[i] += w * this.propagated[o + i]; } this.normalizeQuaternion(this.mean, QW); for (let s = 0; s < SIGMA; s += 1) { const w = s === 0 ? WC0 : WI; const o = s * N; for (let i = 0; i < N; i += 1) for (let j = 0; j < N; j += 1) this.p[i * N + j] += w * (this.propagated[o + i] - this.mean[i]) * (this.propagated[o + j] - this.mean[j]); } this.x.set(this.mean); const q = this.processNoise * dt; for (let i = 0; i < N; i += 1) this.p[i * N + i] += q + EPS; this.symmetrizeCovariance(); }

  private scalarUpdate(index: number, measurement: number, noise: number): void { const innovationVariance = Math.max(EPS, this.p[index * N + index] + noise); for (let i = 0; i < N; i += 1) this.k[i] = this.p[i * N + index] / innovationVariance; const residual = measurement - this.x[index]; for (let i = 0; i < N; i += 1) this.x[i] += this.k[i] * residual; this.scratch.set(this.p); for (let i = 0; i < N; i += 1) for (let j = 0; j < N; j += 1) this.p[i * N + j] = this.scratch[i * N + j] - this.k[i] * this.scratch[index * N + j] - this.scratch[i * N + index] * this.k[j] + this.k[i] * innovationVariance * this.k[j]; this.symmetrizeCovariance(); }
  private symmetrizeCovariance(): void { for (let i = 0; i < N; i += 1) { this.p[i * N + i] = Math.max(this.p[i * N + i], EPS); for (let j = 0; j < i; j += 1) { const v = (this.p[i * N + j] + this.p[j * N + i]) * 0.5; this.p[i * N + j] = v; this.p[j * N + i] = v; } } }
  private cholesky(): void { this.scratch.fill(0); for (let i = 0; i < N; i += 1) for (let j = 0; j <= i; j += 1) { let sum = this.p[i * N + j]; for (let k = 0; k < j; k += 1) sum -= this.scratch[i * N + k] * this.scratch[j * N + k]; this.scratch[i * N + j] = i === j ? Math.sqrt(Math.max(sum, EPS)) : sum / Math.max(this.scratch[j * N + j], EPS); } }
  private normalizeQuaternion(a: Float32Array, o: number): void { const inv = 1 / Math.max(EPS, Math.hypot(a[o], a[o + 1], a[o + 2], a[o + 3])); a[o] *= inv; a[o + 1] *= inv; a[o + 2] *= inv; a[o + 3] *= inv; }
  private resetCovariance(): void { for (let i = 0; i < N; i += 1) this.p[i * N + i] = i < 3 ? 0.015 : i < 6 ? 0.08 : i < 9 ? 0.18 : i < 13 ? 0.025 : 0.01; }
  private publish(timestamp: number): FusionState { this.orientation[0] = this.x[QX]; this.orientation[1] = this.x[QY]; this.orientation[2] = this.x[QZ]; this.orientation[3] = this.x[QW]; (this.state as { timestamp: number; scaleUKF: number }).timestamp = timestamp; (this.state as { scaleUKF: number }).scaleUKF = this.x[SCALE]; return this.state; }
}
