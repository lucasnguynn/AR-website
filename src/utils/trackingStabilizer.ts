import * as THREE from 'three';
import type { HandResult, NormalisedLandmark } from '../types/ar.types';
import { LM } from '../types/ar.types';

export enum TrackingState {
  SEARCHING = 'SEARCHING',
  LOCKING = 'LOCKING',
  TRACKING = 'TRACKING',
  UNCERTAIN = 'UNCERTAIN',
  LOST = 'LOST',
}

export interface RingPoseSample {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
  confidence: number;
  timestamp: number;
  landmarks?: NormalisedLandmark[];
}

export interface StabilizedRingPose {
  state: TrackingState;
  visible: boolean;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: number;
  confidence: number;
}

export interface TrackingStabilizerOptions {
  minConfidence: number;
  lockConfidence: number;
  lockFrames: number;
  graceMs: number;
  lostMs: number;
  maxPositionSpeed: number;
  maxAngularSpeed: number;
  maxScaleRatioPerSecond: number;
  minFingerLength: number;
  maxFingerLength: number;
  maxFingerLengthRatio: number;
  positionMinCutoff: number;
  positionBeta: number;
  rotationMinCutoff: number;
  rotationBeta: number;
  derivativeCutoff: number;
  relockBlendMs: number;
}

const DEFAULT_OPTIONS: TrackingStabilizerOptions = {
  minConfidence: 0.45,
  lockConfidence: 0.62,
  lockFrames: 3,
  graceMs: 140,
  lostMs: 420,
  maxPositionSpeed: 7.5,
  maxAngularSpeed: 18,
  maxScaleRatioPerSecond: 4,
  minFingerLength: 0.015,
  maxFingerLength: 0.9,
  maxFingerLengthRatio: 1.65,
  positionMinCutoff: 1.15,
  positionBeta: 18,
  rotationMinCutoff: 1.25,
  rotationBeta: 10,
  derivativeCutoff: 1,
  relockBlendMs: 100,
};

const EPSILON = 1e-8;
const REQUIRED = [LM.INDEX_MCP, LM.RING_MCP, LM.RING_PIP, LM.PINKY_MCP] as const;

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function finiteVector(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function finiteQuaternion(q: THREE.Quaternion): boolean {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w) && Math.abs(q.lengthSq() - 1) < 0.15;
}

function landmark(landmarks: NormalisedLandmark[], index: number): NormalisedLandmark | null {
  for (let i = 0; i < landmarks.length; i += 1) if (landmarks[i].index === index) return landmarks[i];
  return null;
}

function validLandmarkGeometry(landmarks: NormalisedLandmark[]): boolean {
  for (let i = 0; i < REQUIRED.length; i += 1) {
    const point = landmark(landmarks, REQUIRED[i]);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return false;
    if (point.x < -0.15 || point.x > 1.15 || point.y < -0.15 || point.y > 1.15 || Math.abs(point.z) > 2.5) return false;
  }
  return true;
}

class OneEuroVector3 {
  private initialized = false;
  private readonly value = new THREE.Vector3();
  private readonly derivative = new THREE.Vector3();
  private readonly previousRaw = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  reset(): void { this.initialized = false; }

  update(raw: THREE.Vector3, dt: number, minCutoff: number, beta: number, derivativeCutoff: number): THREE.Vector3 {
    if (!this.initialized) {
      this.value.copy(raw); this.previousRaw.copy(raw); this.derivative.set(0, 0, 0); this.initialized = true;
      return this.value;
    }
    const safeDt = Math.max(1 / 120, Math.min(dt, 1 / 15));
    const derivativeAlpha = alpha(derivativeCutoff, safeDt);
    this.scratch.copy(raw).sub(this.previousRaw).multiplyScalar(1 / safeDt);
    this.derivative.lerp(this.scratch, derivativeAlpha);
    const cutoff = minCutoff + beta * this.derivative.length();
    this.value.lerp(raw, alpha(cutoff, safeDt));
    this.previousRaw.copy(raw);
    return this.value;
  }
}

class OneEuroQuaternion {
  private initialized = false;
  private readonly value = new THREE.Quaternion();
  private previousRaw = new THREE.Quaternion();
  private angularVelocity = 0;
  private readonly scratch = new THREE.Quaternion();

  reset(): void { this.initialized = false; this.angularVelocity = 0; }

  update(raw: THREE.Quaternion, dt: number, minCutoff: number, beta: number, derivativeCutoff: number): THREE.Quaternion {
    if (!this.initialized) {
      this.value.copy(raw); this.previousRaw.copy(raw); this.initialized = true;
      return this.value;
    }
    const safeDt = Math.max(1 / 120, Math.min(dt, 1 / 15));
    this.scratch.copy(raw);
    if (this.value.dot(this.scratch) < 0) this.scratch.set(-this.scratch.x, -this.scratch.y, -this.scratch.z, -this.scratch.w);
    const rawAngleSpeed = this.previousRaw.angleTo(this.scratch) / safeDt;
    const derivativeAlpha = alpha(derivativeCutoff, safeDt);
    this.angularVelocity += (rawAngleSpeed - this.angularVelocity) * derivativeAlpha;
    const cutoff = minCutoff + beta * this.angularVelocity;
    this.value.slerp(this.scratch, alpha(cutoff, safeDt)).normalize();
    this.previousRaw.copy(this.scratch);
    return this.value;
  }
}

export class RingTrackingStabilizer {
  private readonly options: TrackingStabilizerOptions;
  private state = TrackingState.SEARCHING;
  private lockCount = 0;
  private lastTimestamp = 0;
  private lastGoodTimestamp = 0;
  private readonly posFilter = new OneEuroVector3();
  private readonly quatFilter = new OneEuroQuaternion();
  private scale = 1;
  private readonly outputPosition = new THREE.Vector3();
  private readonly outputQuaternion = new THREE.Quaternion();
  private readonly result: StabilizedRingPose = { state: TrackingState.SEARCHING, visible: false, position: this.outputPosition, quaternion: this.outputQuaternion, scale: 1, confidence: 0 };
  private readonly previousPosition = new THREE.Vector3();
  private readonly previousQuaternion = new THREE.Quaternion();
  private previousScale = 1;
  private hasPreviousPose = false;
  private previousFingerLength = 0;

  constructor(options: Partial<TrackingStabilizerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  reset(): void {
    this.state = TrackingState.SEARCHING; this.lockCount = 0; this.lastTimestamp = 0; this.lastGoodTimestamp = 0;
    this.posFilter.reset(); this.quatFilter.reset(); this.hasPreviousPose = false; this.previousFingerLength = 0;
    this.outputPosition.set(0, 0, 0); this.outputQuaternion.identity(); this.scale = 1; this.updateResult(false, 0);
  }

  update(sample: RingPoseSample | null): StabilizedRingPose {
    const timestamp = sample?.timestamp ?? (this.lastTimestamp > 0 ? this.lastTimestamp + 16.667 : performance.now());
    const dt = this.lastTimestamp > 0 ? Math.max(1 / 120, Math.min((timestamp - this.lastTimestamp) / 1000, 1 / 15)) : 1 / 60;
    this.lastTimestamp = timestamp;
    const valid = sample !== null && this.accept(sample, dt);

    if (!valid || !sample) return this.handleMiss(timestamp);

    this.lastGoodTimestamp = timestamp;
    this.advanceLockedState(sample.confidence);
    const filteredPosition = this.posFilter.update(sample.position, dt, this.options.positionMinCutoff, this.options.positionBeta, this.options.derivativeCutoff);
    const filteredQuaternion = this.quatFilter.update(sample.quaternion, dt, this.options.rotationMinCutoff, this.options.rotationBeta, this.options.derivativeCutoff);
    const scaleAlpha = alpha(this.options.positionMinCutoff, dt);
    this.scale += (sample.scale - this.scale) * scaleAlpha;
    this.outputPosition.copy(filteredPosition); this.outputQuaternion.copy(filteredQuaternion); this.result.scale = this.scale;
    this.previousPosition.copy(sample.position); this.previousQuaternion.copy(sample.quaternion); this.previousScale = sample.scale; this.hasPreviousPose = true;
    return this.updateResult(this.state !== TrackingState.LOST && this.state !== TrackingState.SEARCHING, sample.confidence);
  }

  private accept(sample: RingPoseSample, dt: number): boolean {
    if (sample.confidence < this.options.minConfidence || !finiteVector(sample.position) || !finiteQuaternion(sample.quaternion) || !Number.isFinite(sample.scale) || sample.scale <= 0) return false;
    if (sample.landmarks && !validLandmarkGeometry(sample.landmarks)) return false;
    const fingerLength = sample.landmarks ? this.fingerLength(sample.landmarks) : 0;
    if (fingerLength > 0) {
      if (fingerLength < this.options.minFingerLength || fingerLength > this.options.maxFingerLength) return false;
      if (this.previousFingerLength > 0) {
        const ratio = Math.max(fingerLength, this.previousFingerLength) / Math.min(fingerLength, this.previousFingerLength);
        if (ratio > this.options.maxFingerLengthRatio) return false;
      }
      this.previousFingerLength = fingerLength;
    }
    if (!this.hasPreviousPose) return true;
    if (sample.position.distanceTo(this.previousPosition) / dt > this.options.maxPositionSpeed) return false;
    if (this.previousQuaternion.angleTo(sample.quaternion) / dt > this.options.maxAngularSpeed) return false;
    const ratio = Math.max(sample.scale, this.previousScale) / Math.max(EPSILON, Math.min(sample.scale, this.previousScale));
    return Math.log(ratio) / dt <= this.options.maxScaleRatioPerSecond;
  }

  private fingerLength(landmarks: NormalisedLandmark[]): number {
    const mcp = landmark(landmarks, LM.RING_MCP); const pip = landmark(landmarks, LM.RING_PIP);
    if (!mcp || !pip) return 0;
    const dx = pip.x - mcp.x; const dy = pip.y - mcp.y; const dz = pip.z - mcp.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private advanceLockedState(confidence: number): void {
    if (confidence >= this.options.lockConfidence) this.lockCount += 1;
    else this.lockCount = Math.max(0, this.lockCount - 1);
    if (this.state === TrackingState.SEARCHING || this.state === TrackingState.LOST) {
      this.state = this.lockCount >= this.options.lockFrames ? TrackingState.TRACKING : TrackingState.LOCKING;
      if (this.state === TrackingState.LOCKING) { this.posFilter.reset(); this.quatFilter.reset(); }
    } else if (this.state === TrackingState.LOCKING && this.lockCount >= this.options.lockFrames) this.state = TrackingState.TRACKING;
    else if (this.state === TrackingState.UNCERTAIN && this.lockCount >= 1) this.state = TrackingState.TRACKING;
  }

  private handleMiss(timestamp: number): StabilizedRingPose {
    const age = timestamp - this.lastGoodTimestamp;
    if (this.lastGoodTimestamp === 0) this.state = TrackingState.SEARCHING;
    else if (age <= this.options.graceMs) this.state = this.state === TrackingState.TRACKING ? TrackingState.UNCERTAIN : this.state;
    else if (age <= this.options.lostMs) this.state = TrackingState.UNCERTAIN;
    else { this.state = TrackingState.LOST; this.lockCount = 0; this.posFilter.reset(); this.quatFilter.reset(); this.hasPreviousPose = false; this.previousFingerLength = 0; }
    return this.updateResult(this.lastGoodTimestamp > 0 && this.state !== TrackingState.LOST && this.state !== TrackingState.SEARCHING, 0);
  }

  private updateResult(visible: boolean, confidence: number): StabilizedRingPose {
    this.result.state = this.state; this.result.visible = visible; this.result.confidence = confidence; return this.result;
  }
}

export function handConfidence(hand: HandResult | null | undefined): number {
  return clamp01(hand?.confidence ?? 0);
}
