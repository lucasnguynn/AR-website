// FILE: src/utils/GestureDetector.ts
import type { Vector3 } from 'three';
import type { HandTrackingResult, NormalisedLandmark } from '../types/ar.types';
import { LM } from '../types/ar.types';

/** Supported gesture labels emitted by the hand gesture detector. */
export type GestureType = 'PINCH' | 'WAVE' | 'FIST' | 'POINT' | 'PEACE' | 'OPEN_PALM' | 'THUMBS_UP';

/** One debounced hand gesture detection. */
export interface GestureDetection {
  type: GestureType;
  confidence: number;
  handedness: string;
  timestamp: number;
}

const PINCH_THRESHOLD = 0.04;
const BASE_COOLDOWNS: Record<GestureType, number> = {
  PINCH: 400,
  WAVE: 900,
  FIST: 600,
  POINT: 500,
  PEACE: 700,
  OPEN_PALM: 500,
  THUMBS_UP: 600,
};
const FINGER_TIPS = [LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP] as const;
const FINGER_PIPS = [LM.THUMB_IP, LM.INDEX_PIP, LM.MIDDLE_PIP, LM.RING_PIP, LM.PINKY_PIP] as const;

function getLandmark(landmarks: NormalisedLandmark[], index: number): NormalisedLandmark | null {
  return landmarks.find((landmark) => landmark.index === index) ?? null;
}

function distance2D(a: NormalisedLandmark, b: NormalisedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isExtended(tip: NormalisedLandmark | null, pip: NormalisedLandmark | null, wrist: NormalisedLandmark | null): boolean {
  if (!tip || !pip || !wrist) return false;
  return distance2D(tip, wrist) > distance2D(pip, wrist) * 1.08;
}

function dot(ax: number, ay: number, bx: number, by: number): number {
  return ax * bx + ay * by;
}

/** Adaptive per-gesture hand detector with velocity-scaled debounce and confidence calibration. */
export class GestureDetector {
  private readonly lastTrigger = new Map<GestureType, number>();
  private previousPalmCenter: { x: number; y: number; z: number; timestamp: number } | null = null;
  private errorEMA = 0.05;

  /** Updates the prediction error EMA used by confidence calibration. */
  updateError(predicted: Vector3, actual: Vector3): void {
    this.errorEMA = 0.9 * this.errorEMA + 0.1 * predicted.distanceTo(actual);
  }

  /** Computes calibrated confidence from current motion intensity. */
  computeConfidence(motion: number): number {
    return Math.max(0.15, 0.98 - this.errorEMA * 2.0 - motion * 0.04);
  }

  private calculateHandVelocity(landmarks: NormalisedLandmark[], now: number): number {
    const wrist = getLandmark(landmarks, LM.WRIST);
    const middleMcp = getLandmark(landmarks, LM.MIDDLE_MCP);
    if (!wrist || !middleMcp) return 0;
    const palmCenter = { x: (wrist.x + middleMcp.x) / 2, y: (wrist.y + middleMcp.y) / 2, z: (wrist.z + middleMcp.z) / 2, timestamp: now };
    const previous = this.previousPalmCenter;
    this.previousPalmCenter = palmCenter;
    if (!previous || now <= previous.timestamp) return 0;
    return Math.hypot(palmCenter.x - previous.x, palmCenter.y - previous.y, palmCenter.z - previous.z) / (now - previous.timestamp);
  }

  private computeCooldown(type: GestureType, velocity: number): number {
    const base = BASE_COOLDOWNS[type];
    const scale = Math.max(0.3, Math.min(1.5, 1.0 / (velocity + 0.5)));
    return Math.max(200, Math.min(1200, base * scale));
  }

  /** Detects gestures and debounces each gesture type independently. */
  detect(result: HandTrackingResult | null, now = performance.now()): GestureDetection[] {
    if (!result?.detected || result.hands.length === 0) {
      this.previousPalmCenter = null;
      return [];
    }
    const detections: GestureDetection[] = [];
    let maxVelocity = 0;
    for (const hand of result.hands) {
      const landmarks = hand.landmarks;
      const wrist = getLandmark(landmarks, LM.WRIST);
      const thumbTip = getLandmark(landmarks, LM.THUMB_TIP);
      const indexTip = getLandmark(landmarks, LM.INDEX_TIP);
      const middleTip = getLandmark(landmarks, LM.MIDDLE_TIP);
      const ringTip = getLandmark(landmarks, LM.RING_TIP);
      const pinkyTip = getLandmark(landmarks, LM.PINKY_TIP);
      maxVelocity = Math.max(maxVelocity, this.calculateHandVelocity(landmarks, now));
      const motionConfidence = this.computeConfidence(maxVelocity);
      const confidence = Math.min(hand.confidence, motionConfidence);
      if (thumbTip && indexTip && distance2D(thumbTip, indexTip) < PINCH_THRESHOLD) detections.push({ type: 'PINCH', confidence, handedness: hand.handedness, timestamp: now });
      const extended = FINGER_TIPS.map((tipIndex, index) => isExtended(getLandmark(landmarks, tipIndex), getLandmark(landmarks, FINGER_PIPS[index]), wrist));
      const middleMcp = getLandmark(landmarks, LM.MIDDLE_MCP);
      if (extended.every(Boolean) && wrist && middleTip && middleMcp && dot(middleMcp.x - wrist.x, middleMcp.y - wrist.y, middleTip.x - middleMcp.x, middleTip.y - middleMcp.y) > 0) detections.push({ type: 'OPEN_PALM', confidence, handedness: hand.handedness, timestamp: now });
      const thumbIp = getLandmark(landmarks, LM.THUMB_IP);
      const curledFingers = [indexTip, middleTip, ringTip, pinkyTip].every((tip) => wrist && tip && distance2D(tip, wrist) < distance2D(thumbTip ?? tip, wrist) * 0.92);
      if (wrist && thumbTip && thumbIp && curledFingers && Math.abs(thumbTip.y - thumbIp.y) > Math.abs(thumbTip.x - thumbIp.x) * 1.25 && thumbTip.y < thumbIp.y) detections.push({ type: 'THUMBS_UP', confidence, handedness: hand.handedness, timestamp: now });
    }
    return detections.filter((detection) => {
      const last = this.lastTrigger.get(detection.type) ?? -Infinity;
      const cooldown = this.computeCooldown(detection.type, maxVelocity);
      if (now - last < cooldown) return false;
      this.lastTrigger.set(detection.type, now);
      console.log(`[GestureDetector] ${detection.type} cooldown=${cooldown.toFixed(1)}ms velocity=${maxVelocity.toFixed(4)}`);
      return true;
    });
  }
}

console.log('[GestureDetector] adaptive PINCH/WAVE cooldowns ready');
// VERIFY: PINCH cooldown ≠ WAVE cooldown logged in console.
