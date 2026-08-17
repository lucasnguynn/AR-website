/**
 * TrackingSmoother.ts  — UPGRADED
 *
 * Two-stage smoothing pipeline for AR pose data:
 *
 *   Stage 1 — EMA (Exponential Moving Average) pre-filter
 *     Cheap O(1) per-axis filter that kills high-frequency jitter introduced
 *     by landmark quantisation noise and GPU rounding in MediaPipe.
 *     Applied BEFORE the One Euro Filter so the adaptive cutoff sees a
 *     cleaner signal and its derivative estimate is more accurate.
 *
 *   Stage 2 — One Euro Filter
 *     Frequency-adaptive filter that slows smoothing on fast movement and
 *     tightens it when the hand is nearly still. Uses SLERP on quaternions
 *     for rotation to avoid gimbal-lock artefacts.
 *
 * Usage — drop-in replacement for the original TrackingSmoother.ts.
 * All existing exports are preserved.
 *
 * @module TrackingSmoother
 */

import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// EMA Filter (Stage 1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scalar EMA (Exponential Moving Average) filter.
 *
 * Formula:
 *   output_t = α · input_t + (1 − α) · output_{t−1}
 *
 * α close to 1 → very responsive (little smoothing)
 * α close to 0 → heavy smoothing (slow to follow changes)
 *
 * Recommended starting value: α = 0.25 for hand-tracking at 20–30 fps.
 * Increase to 0.4–0.6 for faster responsiveness on high-end devices.
 */
export class ScalarEMAFilter {
  private alpha: number;
  private value: number | null = null;

  constructor(alpha: number = 0.25) {
    if (alpha <= 0 || alpha > 1) {
      throw new RangeError(`EMA alpha must be in (0, 1]. Got: ${alpha}`);
    }
    this.alpha = alpha;
  }

  apply(input: number): number {
    if (this.value === null) {
      this.value = input;
      return input;
    }
    this.value = this.alpha * input + (1 - this.alpha) * this.value;
    return this.value;
  }

  reset(): void {
    this.value = null;
  }

  /** Dynamically adapt α — useful when tracking confidence drops */
  setAlpha(alpha: number): void {
    this.alpha = Math.max(0.01, Math.min(1, alpha));
  }
}

/**
 * Vector3 EMA filter — applies independent ScalarEMAFilters to x, y, z.
 * Preallocates a single output Vector3 to avoid per-frame GC pressure.
 */
export class Vector3EMAFilter {
  private fx: ScalarEMAFilter;
  private fy: ScalarEMAFilter;
  private fz: ScalarEMAFilter;
  private out: THREE.Vector3 = new THREE.Vector3();

  constructor(alpha: number = 0.25) {
    this.fx = new ScalarEMAFilter(alpha);
    this.fy = new ScalarEMAFilter(alpha);
    this.fz = new ScalarEMAFilter(alpha);
  }

  /**
   * @param v Input vector (not mutated)
   * @param output Optional pre-allocated output vector; new Vector3 used if omitted
   */
  apply(v: THREE.Vector3, output?: THREE.Vector3): THREE.Vector3 {
    const r = output ?? this.out;
    r.x = this.fx.apply(v.x);
    r.y = this.fy.apply(v.y);
    r.z = this.fz.apply(v.z);
    return r;
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }

  setAlpha(alpha: number): void {
    this.fx.setAlpha(alpha);
    this.fy.setAlpha(alpha);
    this.fz.setAlpha(alpha);
  }
}

/**
 * Quaternion EMA filter using spherical linear interpolation (SLERP).
 *
 * SLERP(q_prev, q_new, α) where α = EMA alpha.
 * This is the quaternion-space analogue of scalar EMA and avoids
 * the discontinuities that occur when filtering Euler angles independently.
 */
export class QuaternionEMAFilter {
  private alpha: number;
  private last: THREE.Quaternion | null = null;
  private out: THREE.Quaternion = new THREE.Quaternion();

  constructor(alpha: number = 0.25) {
    this.alpha = Math.max(0.01, Math.min(1, alpha));
  }

  apply(q: THREE.Quaternion, output?: THREE.Quaternion): THREE.Quaternion {
    const r = output ?? this.out;

    if (!this.last) {
      this.last = q.clone();
      r.copy(q);
      return r;
    }

    // Ensure shortest-path SLERP (dot product check)
    const dot =
      this.last.x * q.x +
      this.last.y * q.y +
      this.last.z * q.z +
      this.last.w * q.w;

    // If quaternions are in opposite hemispheres, negate one to force shortest arc
const target = dot < 0 ? q.clone().set(-q.x, -q.y, -q.z, -q.w) : q;
    
    r.copy(this.last).slerp(target, this.alpha);
    this.last.copy(r);
    return r;
  }

  reset(): void {
    this.last = null;
  }

  setAlpha(alpha: number): void {
    this.alpha = Math.max(0.01, Math.min(1, alpha));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// One Euro Filter (Stage 2)
// ─────────────────────────────────────────────────────────────────────────────

export interface OneEuroFilterConfig {
  /** Minimum cutoff frequency for the raw signal (default: 0.5) */
  minCutoff: number;
  /** Beta parameter for adaptive cutoff based on derivative (default: 0.1) */
  beta: number;
  /** Maximum cutoff frequency to prevent over-smoothing (default: 10.0) */
  maxCutoff: number;
}

const DEFAULT_CONFIG: OneEuroFilterConfig = {
  minCutoff: 0.5,
  beta: 0.1,
  maxCutoff: 10.0,
};

class ScalarOneEuroFilter {
  private lastValue: number | null = null;
  private lastDerivative: number | null = null;
  private lastTime: number | null = null;
  private config: OneEuroFilterConfig;

  constructor(config: Partial<OneEuroFilterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private calculateAlpha(cutoff: number, dt: number): number {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  private exponentialSmoothing(value: number, lastValue: number, alpha: number): number {
    return alpha * value + (1 - alpha) * lastValue;
  }

  apply(value: number, timestamp: number): number {
    if (this.lastValue === null || this.lastTime === null) {
      this.lastValue = value;
      this.lastTime = timestamp;
      return value;
    }

    const dt = (timestamp - this.lastTime) / 1000;
    if (dt <= 0) return this.lastValue;

    const derivative = (value - this.lastValue) / dt;

    let smoothedDerivative = derivative;
    if (this.lastDerivative !== null) {
      const derivativeCutoff =
        this.config.minCutoff + this.config.beta * Math.abs(derivative);
      const clampedCutoff = Math.min(derivativeCutoff, this.config.maxCutoff);
      const alphaDeriv = this.calculateAlpha(clampedCutoff, dt);
      smoothedDerivative = this.exponentialSmoothing(
        derivative,
        this.lastDerivative,
        alphaDeriv,
      );
    }

    const cutoff =
      this.config.minCutoff + this.config.beta * Math.abs(smoothedDerivative);
    const clampedCutoff = Math.min(cutoff, this.config.maxCutoff);
    const alpha = this.calculateAlpha(clampedCutoff, dt);
    const smoothedValue = this.exponentialSmoothing(value, this.lastValue, alpha);

    this.lastValue = smoothedValue;
    this.lastDerivative = smoothedDerivative;
    this.lastTime = timestamp;
    return smoothedValue;
  }

  reset(): void {
    this.lastValue = null;
    this.lastDerivative = null;
    this.lastTime = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-stage Vector3 filter: EMA → One Euro
// ─────────────────────────────────────────────────────────────────────────────

export class Vector3OneEuroFilter {
  private filterX: ScalarOneEuroFilter;
  private filterY: ScalarOneEuroFilter;
  private filterZ: ScalarOneEuroFilter;

  // Stage-1 EMA pre-filter — knocks out sub-pixel jitter before OEF sees it
  private emaFilter: Vector3EMAFilter;

  constructor(
    config: Partial<OneEuroFilterConfig> = {},
    emaAlpha: number = 0.3,
  ) {
    this.filterX = new ScalarOneEuroFilter(config);
    this.filterY = new ScalarOneEuroFilter(config);
    this.filterZ = new ScalarOneEuroFilter(config);
    this.emaFilter = new Vector3EMAFilter(emaAlpha);
  }

  apply(vector: THREE.Vector3, timestamp: number, output?: THREE.Vector3): THREE.Vector3 {
    // Stage 1: EMA removes high-frequency noise
    const preFiltered = this.emaFilter.apply(vector);

    // Stage 2: One Euro adaptive smoothing
    const result = output ?? new THREE.Vector3();
    result.x = this.filterX.apply(preFiltered.x, timestamp);
    result.y = this.filterY.apply(preFiltered.y, timestamp);
    result.z = this.filterZ.apply(preFiltered.z, timestamp);
    return result;
  }

  reset(): void {
    this.filterX.reset();
    this.filterY.reset();
    this.filterZ.reset();
    this.emaFilter.reset();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-stage Quaternion Rotation filter: EMA → Adaptive SLERP
// ─────────────────────────────────────────────────────────────────────────────

export class RotationOneEuroFilter {
  private lastQuaternion: THREE.Quaternion | null = null;
  private lastTime: number | null = null;
  private config: OneEuroFilterConfig;

  // Stage-1 quaternion EMA
  private emaFilter: QuaternionEMAFilter;

  constructor(config: Partial<OneEuroFilterConfig> = {}, emaAlpha: number = 0.3) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.emaFilter = new QuaternionEMAFilter(emaAlpha);
  }

  apply(euler: THREE.Euler, timestamp: number, output?: THREE.Euler): THREE.Euler {
    const inputQ = new THREE.Quaternion().setFromEuler(euler);

    // Stage 1: quaternion EMA
    const preFilteredQ = this.emaFilter.apply(inputQ);

    if (!this.lastQuaternion || !this.lastTime) {
      this.lastQuaternion = preFilteredQ.clone();
      this.lastTime = timestamp;
      return euler;
    }

    const dt = (timestamp - this.lastTime) / 1000;
    if (dt <= 0) {
      return new THREE.Euler().setFromQuaternion(this.lastQuaternion);
    }

    // Stage 2: adaptive SLERP (One Euro on rotation)
    const angularVelocity = this.lastQuaternion.angleTo(preFilteredQ) / dt;
    const adaptiveCutoff =
      this.config.minCutoff + this.config.beta * angularVelocity;
    const clampedCutoff = Math.min(adaptiveCutoff, this.config.maxCutoff);
    const tau = 1.0 / (2 * Math.PI * clampedCutoff);
    const alpha = 1.0 / (1.0 + tau / dt);

    const smoothedQ = this.lastQuaternion.clone().slerp(preFilteredQ, alpha);
    this.lastQuaternion = smoothedQ.clone();
    this.lastTime = timestamp;

    const result = output ?? new THREE.Euler();
    result.setFromQuaternion(smoothedQ);
    if (euler.order) result.order = euler.order;
    return result;
  }

  applyToQuaternion(
    quaternion: THREE.Quaternion,
    timestamp: number,
    output?: THREE.Quaternion,
  ): THREE.Quaternion {
    const euler = new THREE.Euler().setFromQuaternion(quaternion);
    const smoothedEuler = this.apply(euler, timestamp);
    const result = output ?? new THREE.Quaternion();
    result.setFromEuler(smoothedEuler);
    return result;
  }

  reset(): void {
    this.lastQuaternion = null;
    this.lastTime = null;
    this.emaFilter.reset();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined PoseSmoother
// ─────────────────────────────────────────────────────────────────────────────

export class PoseSmoother {
  public positionFilter: Vector3OneEuroFilter;
  public rotationFilter: RotationOneEuroFilter;

  constructor(config: Partial<OneEuroFilterConfig> = {}, emaAlpha: number = 0.3) {
    this.positionFilter = new Vector3OneEuroFilter(config, emaAlpha);
    this.rotationFilter = new RotationOneEuroFilter(config, emaAlpha);
  }

  apply(
    position: THREE.Vector3,
    rotation: THREE.Euler,
    timestamp: number,
  ): { position: THREE.Vector3; rotation: THREE.Euler } {
    return {
      position: this.positionFilter.apply(position, timestamp),
      rotation: this.rotationFilter.apply(rotation, timestamp),
    };
  }

  reset(): void {
    this.positionFilter.reset();
    this.rotationFilter.reset();
  }
}

// Backward-compat alias
export { ScalarOneEuroFilter as OneEuroFilter };
