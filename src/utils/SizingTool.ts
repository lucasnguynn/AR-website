import type { HandTrackingResult, NormalisedLandmark } from '../types/ar.types';
import { LM } from '../types/ar.types';

export interface RingSizeEstimate {
  isPinching: boolean;
  pixelToMmRatio: number | null;
  fingerDiameterMm: number | null;
  circumferenceMm: number | null;
  usRingSize: number | null;
  confidence: number;
}

const CREDIT_CARD_WIDTH_MM = 85.6;
const PINCH_THRESHOLD = 0.045;
const RING_FINGER_WIDTH_COMPENSATION = 0.82;

function getLandmark(landmarks: NormalisedLandmark[], index: number): NormalisedLandmark | null {
  return landmarks.find((landmark) => landmark.index === index) ?? null;
}

function distancePixels(a: NormalisedLandmark, b: NormalisedLandmark, width: number, height: number): number {
  const dx = (a.x - b.x) * width;
  const dy = (a.y - b.y) * height;
  return Math.hypot(dx, dy);
}

export function estimatePixelToMmRatio(referenceWidthPixels: number, referenceWidthMm = CREDIT_CARD_WIDTH_MM): number | null {
  if (!Number.isFinite(referenceWidthPixels) || referenceWidthPixels <= 0) return null;
  return referenceWidthMm / referenceWidthPixels;
}

export function circumferenceMmToUsRingSize(circumferenceMm: number): number | null {
  if (!Number.isFinite(circumferenceMm) || circumferenceMm < 36 || circumferenceMm > 85) return null;
  return Math.round(((circumferenceMm - 36.5) / 2.55 + 0.5) * 2) / 2;
}

export function estimateRingSizeFromPinch(
  result: HandTrackingResult | null,
  video: HTMLVideoElement | null,
  referenceWidthPixels?: number,
): RingSizeEstimate {
  const empty: RingSizeEstimate = {
    isPinching: false,
    pixelToMmRatio: null,
    fingerDiameterMm: null,
    circumferenceMm: null,
    usRingSize: null,
    confidence: 0,
  };

  if (!result?.detected || !video || video.videoWidth <= 0 || result.hands.length === 0) return empty;

  const hand = result.hands[0];
  const thumbTip = getLandmark(hand.landmarks, LM.THUMB_TIP);
  const indexTip = getLandmark(hand.landmarks, LM.INDEX_TIP);
  const ringMcp = getLandmark(hand.landmarks, LM.RING_MCP);
  const pinkyMcp = getLandmark(hand.landmarks, LM.PINKY_MCP);
  if (!thumbTip || !indexTip || !ringMcp || !pinkyMcp) return empty;

  const pinchNorm = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
  const isPinching = pinchNorm <= PINCH_THRESHOLD;
  const referencePixels = referenceWidthPixels ?? distancePixels(ringMcp, pinkyMcp, video.videoWidth, video.videoHeight) / 0.32;
  const pixelToMmRatio = estimatePixelToMmRatio(referencePixels);
  if (!isPinching || pixelToMmRatio === null) return { ...empty, isPinching, pixelToMmRatio, confidence: hand.confidence };

  const fingerWidthPixels = distancePixels(ringMcp, pinkyMcp, video.videoWidth, video.videoHeight) * RING_FINGER_WIDTH_COMPENSATION;
  const fingerDiameterMm = fingerWidthPixels * pixelToMmRatio;
  const circumferenceMm = fingerDiameterMm * Math.PI;
  return {
    isPinching,
    pixelToMmRatio,
    fingerDiameterMm,
    circumferenceMm,
    usRingSize: circumferenceMmToUsRingSize(circumferenceMm),
    confidence: clamp(hand.confidence, 0, 1),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
