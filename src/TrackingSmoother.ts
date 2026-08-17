/**
 * TrackingSmoother.ts
 * 
 * Implements the One Euro Filter for temporal smoothing of AR pose data.
 * This filter is critical for reducing jitter in position and rotation updates
 * while maintaining responsiveness to actual hand movement.
 * 
 * Mathematical Foundation:
 * The One Euro Filter uses a frequency-based cutoff to smooth signals.
 * alpha = 1 / (1 + min_cutoff / (2*pi*dt))
 * 
 * @module TrackingSmoother
 */

import * as THREE from 'three';

/**
 * Configuration parameters for the One Euro Filter
 */
export interface OneEuroFilterConfig {
  /** Minimum cutoff frequency for the raw signal (default: 0.5) */
  minCutoff: number;
  /** Beta parameter for adaptive cutoff based on derivative (default: 0.1) */
  beta: number;
  /** Maximum cutoff frequency to prevent over-smoothing (default: 10.0) */
  maxCutoff: number;
}

/**
 * Default configuration values optimized for hand tracking at ~30 FPS
 */
const DEFAULT_CONFIG: OneEuroFilterConfig = {
  minCutoff: 0.5,
  beta: 0.1,
  maxCutoff: 10.0,
};

/**
 * One Euro Filter implementation for scalar values
 * 
 * This class implements the core One Euro Filter algorithm for a single
 * numeric value. It adapts its smoothing based on the rate of change
 * (derivative) of the input signal.
 */
class ScalarOneEuroFilter {
  private lastValue: number | null = null;
  private lastDerivative: number | null = null;
  private lastTime: number | null = null;
  private config: OneEuroFilterConfig;

  constructor(config: Partial<OneEuroFilterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculate the alpha smoothing factor
   * @param cutoff - The cutoff frequency
   * @param dt - Delta time in seconds
   * @returns Alpha value between 0 and 1
   */
  private calculateAlpha(cutoff: number, dt: number): number {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  /**
   * Apply exponential smoothing
   * @param value - Current value
   * @param lastValue - Previous smoothed value
   * @param alpha - Smoothing factor
   * @returns Smoothed value
   */
  private exponentialSmoothing(value: number, lastValue: number, alpha: number): number {
    return alpha * value + (1 - alpha) * lastValue;
  }

  /**
   * Process a new value through the filter
   * @param value - Raw input value
   * @param timestamp - Current timestamp in milliseconds
   * @returns Smoothed value
   */
  apply(value: number, timestamp: number): number {
    // Initialize on first call
    if (this.lastValue === null || this.lastTime === null) {
      this.lastValue = value;
      this.lastTime = timestamp;
      return value;
    }

    // Calculate delta time in seconds
    const dt = (timestamp - this.lastTime) / 1000;
    
    // Prevent division by zero or negative dt
    if (dt <= 0) {
      return this.lastValue;
    }

    // Calculate derivative (rate of change)
    const derivative = (value - this.lastValue) / dt;

    // Apply smoothing to derivative
    let smoothedDerivative = derivative;
    if (this.lastDerivative !== null) {
      const derivativeCutoff = this.config.minCutoff + this.config.beta * Math.abs(derivative);
      const clampedCutoff = Math.min(derivativeCutoff, this.config.maxCutoff);
      const alphaDeriv = this.calculateAlpha(clampedCutoff, dt);
      smoothedDerivative = this.exponentialSmoothing(derivative, this.lastDerivative, alphaDeriv);
    }

    // Calculate adaptive cutoff for the main signal
    const cutoff = this.config.minCutoff + this.config.beta * Math.abs(smoothedDerivative);
    const clampedCutoff = Math.min(cutoff, this.config.maxCutoff);
    const alpha = this.calculateAlpha(clampedCutoff, dt);

    // Apply smoothing to the main signal
    const smoothedValue = this.exponentialSmoothing(value, this.lastValue, alpha);

    // Update state
    this.lastValue = smoothedValue;
    this.lastDerivative = smoothedDerivative;
    this.lastTime = timestamp;

    return smoothedValue;
  }

  /**
   * Reset the filter state
   */
  reset(): void {
    this.lastValue = null;
    this.lastDerivative = null;
    this.lastTime = null;
  }
}

/**
 * Vector3 One Euro Filter for smoothing 3D positions
 * 
 * Applies independent One Euro Filters to each axis (x, y, z)
 */
export class Vector3OneEuroFilter {
  private filterX: ScalarOneEuroFilter;
  private filterY: ScalarOneEuroFilter;
  private filterZ: ScalarOneEuroFilter;

  constructor(config: Partial<OneEuroFilterConfig> = {}) {
    this.filterX = new ScalarOneEuroFilter(config);
    this.filterY = new ScalarOneEuroFilter(config);
    this.filterZ = new ScalarOneEuroFilter(config);
  }

  /**
   * Apply filter to a Vector3
   * @param vector - Input vector
   * @param timestamp - Current timestamp in milliseconds
   * @param output - Optional output vector to reuse
   * @returns Smoothed vector
   */
  apply(vector: THREE.Vector3, timestamp: number, output?: THREE.Vector3): THREE.Vector3 {
    const result = output ?? new THREE.Vector3();
    
    result.x = this.filterX.apply(vector.x, timestamp);
    result.y = this.filterY.apply(vector.y, timestamp);
    result.z = this.filterZ.apply(vector.z, timestamp);
    
    return result;
  }

  /**
   * Reset all axis filters
   */
  reset(): void {
    this.filterX.reset();
    this.filterY.reset();
    this.filterZ.reset();
  }
}

/**
 * Quaternion/Euler One Euro Filter for smoothing rotations
 * 
 * Applies filtering to Euler angles (in degrees) to avoid gimbal lock issues
 * that can occur when filtering quaternion components directly.
 */
export class RotationOneEuroFilter {
  private filterX: ScalarOneEuroFilter;
  private filterY: ScalarOneEuroFilter;
  private filterZ: ScalarOneEuroFilter;

  constructor(config: Partial<OneEuroFilterConfig> = {}) {
    this.filterX = new ScalarOneEuroFilter(config);
    this.filterY = new ScalarOneEuroFilter(config);
    this.filterZ = new ScalarOneEuroFilter(config);
  }

  /**
   * Apply filter to Euler angles
   * @param euler - Input euler angles (in radians)
   * @param timestamp - Current timestamp in milliseconds
   * @param output - Optional output euler to reuse
   * @returns Smoothed euler angles
   */
  apply(euler: THREE.Euler, timestamp: number, output?: THREE.Euler): THREE.Euler {
    const result = output ?? new THREE.Euler();
    
    // Convert to degrees for filtering (more intuitive cutoff values)
    const toDegrees = 180 / Math.PI;
    const toRadians = Math.PI / 180;
    
    result.x = this.filterX.apply(euler.x * toDegrees, timestamp) * toRadians;
    result.y = this.filterY.apply(euler.y * toDegrees, timestamp) * toRadians;
    result.z = this.filterZ.apply(euler.z * toDegrees, timestamp) * toRadians;
    result.order = euler.order;
    
    return result;
  }

  /**
   * Apply filter directly to a quaternion by converting to euler first
   * @param quaternion - Input quaternion
   * @param timestamp - Current timestamp in milliseconds
   * @param output - Optional output quaternion to reuse
   * @returns Smoothed quaternion
   */
  applyToQuaternion(quaternion: THREE.Quaternion, timestamp: number, output?: THREE.Quaternion): THREE.Quaternion {
    const euler = new THREE.Euler().setFromQuaternion(quaternion);
    const smoothedEuler = this.apply(euler, timestamp);
    
    const result = output ?? new THREE.Quaternion();
    result.setFromEuler(smoothedEuler);
    
    return result;
  }

  /**
   * Reset all axis filters
   */
  reset(): void {
    this.filterX.reset();
    this.filterY.reset();
    this.filterZ.reset();
  }
}

/**
 * Combined pose smoother for both position and rotation
 * 
 * Provides a unified interface for smoothing complete ring pose data
 */
export class PoseSmoother {
  public positionFilter: Vector3OneEuroFilter;
  public rotationFilter: RotationOneEuroFilter;

  constructor(config: Partial<OneEuroFilterConfig> = {}) {
    this.positionFilter = new Vector3OneEuroFilter(config);
    this.rotationFilter = new RotationOneEuroFilter(config);
  }

  /**
   * Smooth a complete pose (position + rotation)
   * @param position - Position vector to smooth
   * @param rotation - Rotation euler to smooth
   * @param timestamp - Current timestamp in milliseconds
   * @returns Object containing smoothed position and rotation
   */
  apply(
    position: THREE.Vector3,
    rotation: THREE.Euler,
    timestamp: number
  ): { position: THREE.Vector3; rotation: THREE.Euler } {
    return {
      position: this.positionFilter.apply(position, timestamp),
      rotation: this.rotationFilter.apply(rotation, timestamp),
    };
  }

  /**
   * Reset all filters
   */
  reset(): void {
    this.positionFilter.reset();
    this.rotationFilter.reset();
  }
}

// Export for backward compatibility and direct usage
export { ScalarOneEuroFilter as OneEuroFilter };
