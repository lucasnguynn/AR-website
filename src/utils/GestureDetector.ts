import type { HandTrackingResult, NormalisedLandmark } from '../types/ar.types';
import { LM } from '../types/ar.types';

export type GestureType = 'PINCH' | 'OPEN_PALM' | 'THUMBS_UP';

export interface GestureDetection {
  type: GestureType;
  confidence: number;
  handedness: string;
  timestamp: number;
}

const PINCH_THRESHOLD = 0.04;
const MIN_DEBOUNCE_MS = 200;
const MAX_DEBOUNCE_MS = 1200;
const VELOCITY_STILL = 0.002;
const VELOCITY_FAST = 0.035;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function interpolate(min: number, max: number, t: number): number {
  return min + (max - min) * clamp(t, 0, 1);
}

export class GestureDetector {
  private readonly lastTrigger = new Map<GestureType, number>();
  private previousPalmCenter: { x: number; y: number; z: number; timestamp: number } | null = null;

  private calculateHandVelocity(landmarks: NormalisedLandmark[], now: number): number {
    const wrist = getLandmark(landmarks, LM.WRIST);
    const middleMcp = getLandmark(landmarks, LM.MIDDLE_MCP);
    if (!wrist || !middleMcp) return 0;

    const palmCenter = {
      x: (wrist.x + middleMcp.x) / 2,
      y: (wrist.y + middleMcp.y) / 2,
      z: (wrist.z + middleMcp.z) / 2,
      timestamp: now,
    };

    const previous = this.previousPalmCenter;
    this.previousPalmCenter = palmCenter;
    if (!previous || now <= previous.timestamp) return 0;

    const elapsedMs = now - previous.timestamp;
    return Math.hypot(palmCenter.x - previous.x, palmCenter.y - previous.y, palmCenter.z - previous.z) / elapsedMs;
  }

  private getAdaptiveDebounceMs(velocity: number): number {
    const velocityFactor = (velocity - VELOCITY_STILL) / (VELOCITY_FAST - VELOCITY_STILL);
    return interpolate(MAX_DEBOUNCE_MS, MIN_DEBOUNCE_MS, velocityFactor);
  }

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

      if (thumbTip && indexTip && distance2D(thumbTip, indexTip) < PINCH_THRESHOLD) {
        detections.push({ type: 'PINCH', confidence: hand.confidence, handedness: hand.handedness, timestamp: now });
      }

      const extended = FINGER_TIPS.map((tipIndex, index) => isExtended(getLandmark(landmarks, tipIndex), getLandmark(landmarks, FINGER_PIPS[index]), wrist));
      const middleMcp = getLandmark(landmarks, LM.MIDDLE_MCP);
      if (extended.every(Boolean) && wrist && middleTip && middleMcp) {
        const palmX = middleMcp.x - wrist.x;
        const palmY = middleMcp.y - wrist.y;
        const fingerX = middleTip.x - middleMcp.x;
        const fingerY = middleTip.y - middleMcp.y;
        if (dot(palmX, palmY, fingerX, fingerY) > 0) {
          detections.push({ type: 'OPEN_PALM', confidence: hand.confidence, handedness: hand.handedness, timestamp: now });
        }
      }

      const thumbIp = getLandmark(landmarks, LM.THUMB_IP);
      const curledFingers = [indexTip, middleTip, ringTip, pinkyTip].every((tip) => wrist && tip && distance2D(tip, wrist) < distance2D(thumbTip ?? tip, wrist) * 0.92);
      if (wrist && thumbTip && thumbIp && curledFingers && Math.abs(thumbTip.y - thumbIp.y) > Math.abs(thumbTip.x - thumbIp.x) * 1.25 && thumbTip.y < thumbIp.y) {
        detections.push({ type: 'THUMBS_UP', confidence: hand.confidence, handedness: hand.handedness, timestamp: now });
      }
    }

    const debounceMs = this.getAdaptiveDebounceMs(maxVelocity);

    return detections.filter((detection) => {
      const last = this.lastTrigger.get(detection.type) ?? -Infinity;
      if (now - last < debounceMs) return false;
      this.lastTrigger.set(detection.type, now);
      return true;
    });
  }
}
