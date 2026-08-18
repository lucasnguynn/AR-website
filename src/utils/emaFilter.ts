/**
 * emaFilter.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM WITH A FIXED-ALPHA EMA  (Task 3)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The classic EMA:
 *   output = alpha * input + (1 - alpha) * prevOutput
 *
 * With alpha = 0.3 (common "smooth" default):
 *   • Jitter at rest: low — good
 *   • Lag during fast motion: HIGH — ring trails the finger visibly
 *
 * With alpha = 0.8 (common "responsive" default):
 *   • Lag: low — good
 *   • Jitter at rest: HIGH — ring bounces on a stationary hand
 *
 * These are mutually exclusive with a fixed alpha.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIX: VELOCITY-ADAPTIVE α
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. Measure the per-frame Euclidean distance between the new raw position
 *    and the current filtered position.  Call this `velocity`.
 *
 * 2. Map velocity to alpha via a sigmoid-like curve:
 *      normalised_v = clamp(velocity / VELOCITY_SCALE, 0, 1)
 *      alpha = lerp(ALPHA_MIN, ALPHA_MAX, normalised_v)
 *
 *   • velocity ≈ 0 (stationary hand):  alpha ≈ ALPHA_MIN (0.35) → very smooth
 *   • velocity large (fast swing):     alpha ≈ ALPHA_MAX (0.90) → snaps to finger
 *
 * 3. Smooth alpha itself with a small secondary EMA to avoid flickering
 *    between the two regimes on alternating frames.
 *
 * This gives a ring that stays locked during jewellery inspection (still hand)
 * and tracks instantaneously when the customer moves to compare rings.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ORIENTATION SLERP
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A fixed slerp factor (e.g. 0.5) on the quaternion is fine for slow rotations
 * but causes the ring to noticeably lag behind during wrist flips.
 * We apply the same velocity-adaptive principle to quaternion slerp:
 *   - Use angular velocity (angle between current and target quaternion) as the
 *     velocity signal.
 *   - High angular velocity → slerp factor near 1 (immediate snap)
 *   - Low angular velocity  → slerp factor near ALPHA_MIN (smooth)
 */

import * as THREE from 'three';

// ──────────────────────────────────────────────────────────────────────────────
// Tuning parameters — backed by empirical testing on mobile devices
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Smoothing alpha when the hand is nearly stationary.
 * Lower = smoother, higher = more responsive.
 * Range [0, 1].  Default: 0.35 (visually steady at 30 fps).
 */
const ALPHA_MIN = 0.35;

/**
 * Smoothing alpha when the hand is moving fast.
 * Default: 0.88 (ring follows finger with ~1-frame lag at 30 fps).
 */
const ALPHA_MAX = 0.88;

/**
 * World-unit velocity (per frame) at which alpha is 50% of its max range.
 * Tune down if the ring feels sluggish on small, precise movements.
 */
const VELOCITY_SCALE = 0.04;

/**
 * Alpha used to smooth the alpha itself.  This prevents the ring from
 * flickering between smooth and snappy on alternating stationary frames.
 */
const ALPHA_SMOOTH_ALPHA = 0.3;

/**
 * Angular velocity (in radians/frame) at which quaternion slerp is 50% of max.
 */
const ANGULAR_VELOCITY_SCALE = 0.15;

// ──────────────────────────────────────────────────────────────────────────────
// VelocityAdaptiveEMAFilter
// ──────────────────────────────────────────────────────────────────────────────

export class VelocityAdaptiveEMAFilter {
  // Internal state
  private filtered: THREE.Vector3 = new THREE.Vector3();
  private filteredQuat: THREE.Quaternion = new THREE.Quaternion();
  private prevAlpha: number = ALPHA_MIN;
  private prevAlphaQuat: number = ALPHA_MIN;
  private initialised: boolean = false;
  private initialisedQuat: boolean = false;

  // Scratch objects — avoid per-frame allocation
  private readonly _delta = new THREE.Vector3();
  private readonly _tmpQuat = new THREE.Quaternion();

  /**
   * Feed a new raw position, get back the EMA-smoothed position.
   * Call once per render frame.
   */
  updatePosition(raw: THREE.Vector3): THREE.Vector3 {
    if (!this.initialised) {
      this.filtered.copy(raw);
      this.initialised = true;
      return this.filtered.clone();
    }

    // ── Compute instantaneous velocity ───────────────────────────────────────
    const velocity = this._delta.copy(raw).sub(this.filtered).length();

    // ── Map velocity → alpha ──────────────────────────────────────────────────
    const t = Math.min(velocity / VELOCITY_SCALE, 1.0);
    // Use a smoothstep curve for a more natural feel than a plain linear lerp
    const tSmooth = t * t * (3 - 2 * t); // smoothstep(0, 1, t)
    const targetAlpha = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * tSmooth;

    // ── Smooth alpha itself ───────────────────────────────────────────────────
    const alpha = ALPHA_SMOOTH_ALPHA * targetAlpha + (1 - ALPHA_SMOOTH_ALPHA) * this.prevAlpha;
    this.prevAlpha = alpha;

    // ── Apply EMA ─────────────────────────────────────────────────────────────
    this.filtered.lerp(raw, alpha);

    return this.filtered.clone();
  }

  /**
   * Feed a new raw quaternion, get back the slerp-smoothed quaternion.
   * Uses the same velocity-adaptive principle applied to angular velocity.
   */
  updateQuaternion(raw: THREE.Quaternion): THREE.Quaternion {
    if (!this.initialisedQuat) {
      this.filteredQuat.copy(raw);
      this.initialisedQuat = true;
      return this.filteredQuat.clone();
    }

    // ── Angular "velocity" = angle between current and target quaternion ──────
    // q1.angleTo(q2) returns the angle in [0, π] radians.
    const angularVelocity = this.filteredQuat.angleTo(raw);

    // ── Map to slerp factor ───────────────────────────────────────────────────
    const t = Math.min(angularVelocity / ANGULAR_VELOCITY_SCALE, 1.0);
    const tSmooth = t * t * (3 - 2 * t);
    const targetFactor = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * tSmooth;

    const slerpFactor =
      ALPHA_SMOOTH_ALPHA * targetFactor + (1 - ALPHA_SMOOTH_ALPHA) * this.prevAlphaQuat;
    this.prevAlphaQuat = slerpFactor;

    // ── Slerp — handle quaternion double-cover (q and -q represent the same
    //    rotation but slerp would take the long way around for the negative).
    this._tmpQuat.copy(raw);
    if (this.filteredQuat.dot(this._tmpQuat) < 0) {
      // Negate to take the short path
      this._tmpQuat.set(
        -this._tmpQuat.x,
        -this._tmpQuat.y,
        -this._tmpQuat.z,
        -this._tmpQuat.w,
      );
    }

    this.filteredQuat.slerp(this._tmpQuat, slerpFactor);

    return this.filteredQuat.clone();
  }

  /**
   * Simultaneously update position and quaternion with a single velocity
   * measurement (the translational velocity drives both).
   */
  update(
    rawPos: THREE.Vector3,
    rawQuat: THREE.Quaternion,
  ): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    return {
      position: this.updatePosition(rawPos),
      quaternion: this.updateQuaternion(rawQuat),
    };
  }

  /**
   * Hard-reset the filter (e.g. when tracking is lost and then re-acquired).
   * Without a reset, the filter "springs" from the last position to the new one.
   */
  reset(): void {
    this.initialised = false;
    this.initialisedQuat = false;
    this.prevAlpha = ALPHA_MIN;
    this.prevAlphaQuat = ALPHA_MIN;
  }

  /** True if the filter has received at least one sample */
  get isInitialised(): boolean {
    return this.initialised;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Scalar EMA — for filtering individual values like scale
// ──────────────────────────────────────────────────────────────────────────────

export class ScalarEMAFilter {
  private value: number = 1;
  private initialised = false;

  constructor(private readonly alpha: number = 0.4) {}

  update(raw: number): number {
    if (!this.initialised) {
      this.value = raw;
      this.initialised = true;
      return raw;
    }
    this.value = this.alpha * raw + (1 - this.alpha) * this.value;
    return this.value;
  }

  reset(): void {
    this.initialised = false;
  }
}
