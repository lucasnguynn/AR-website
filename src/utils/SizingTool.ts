import type { HandTrackingResult, NormalisedLandmark } from '../types/ar.types';
import { LM } from '../types/ar.types';

export type UkRingSize = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z' | 'Z+1' | 'Z+2' | 'Z+3' | 'Z+4' | 'Z+5' | 'Z+6';

export interface RingSizeEstimate {
  pixelPerMm: number | null;
  pixelToMmRatio: number | null;
  fingerDiameterMm: number | null;
  circumferenceMm: number | null;
  usRingSize: number | null;
  euRingSize: number | null;
  ukRingSize: UkRingSize | null;
  jpRingSize: number | null;
  confidence: number;
  frameCount: number;
}

const MCP_TO_PIP_MM = 25;
const SMOOTHING_FRAMES = 30;
const RING_WIDTH_SCALE = 0.5;
const UK_SIZES: UkRingSize[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Z+1', 'Z+2', 'Z+3', 'Z+4', 'Z+5', 'Z+6'];

function getLandmark(landmarks: NormalisedLandmark[], index: number): NormalisedLandmark | null {
  return landmarks.find((landmark) => landmark.index === index) ?? null;
}

function distancePixels(a: NormalisedLandmark, b: NormalisedLandmark, width: number, height: number): number {
  const dx = (a.x - b.x) * width;
  const dy = (a.y - b.y) * height;
  const dz = (a.z - b.z) * Math.max(width, height);
  return Math.hypot(dx, dy, dz);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

function emptyEstimate(confidence = 0, frameCount = 0): RingSizeEstimate {
  return {
    pixelPerMm: null,
    pixelToMmRatio: null,
    fingerDiameterMm: null,
    circumferenceMm: null,
    usRingSize: null,
    euRingSize: null,
    ukRingSize: null,
    jpRingSize: null,
    confidence,
    frameCount,
  };
}

export function circumferenceMmToUsRingSize(circumferenceMm: number): number | null {
  if (!Number.isFinite(circumferenceMm) || circumferenceMm < 36 || circumferenceMm > 86) return null;
  return roundHalf((circumferenceMm - 36.53) / 2.553 + 0.5);
}

export function circumferenceMmToEuRingSize(circumferenceMm: number): number | null {
  if (!Number.isFinite(circumferenceMm) || circumferenceMm < 36 || circumferenceMm > 86) return null;
  return Math.round(circumferenceMm);
}

export function circumferenceMmToUkRingSize(circumferenceMm: number): UkRingSize | null {
  if (!Number.isFinite(circumferenceMm) || circumferenceMm < 37.8 || circumferenceMm > 69.7) return null;
  const index = clamp(Math.round((circumferenceMm - 37.82) / 1.25), 0, UK_SIZES.length - 1);
  return UK_SIZES[index];
}

export function circumferenceMmToJpRingSize(circumferenceMm: number): number | null {
  if (!Number.isFinite(circumferenceMm) || circumferenceMm < 40 || circumferenceMm > 76) return null;
  return clamp(Math.round(circumferenceMm - 40), 1, 36);
}

export class SizingTool {
  private readonly samples: number[] = [];

  reset(): void {
    this.samples.length = 0;
  }

  estimate(result: HandTrackingResult | null, video: HTMLVideoElement | null): RingSizeEstimate {
    if (!result?.detected || !video || video.videoWidth <= 0 || video.videoHeight <= 0 || result.hands.length === 0) {
      this.reset();
      return emptyEstimate();
    }

    const hand = result.hands[0];
    const landmarks = hand.landmarks;
    const required = [LM.INDEX_MCP, LM.INDEX_PIP, LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.RING_MCP, LM.RING_PIP, LM.PINKY_MCP, LM.PINKY_PIP];
    const points = required.map((index) => getLandmark(landmarks, index));
    if (points.some((point) => !point)) return emptyEstimate(clamp(hand.confidence, 0, 1), this.samples.length);

    const calibrationPairs: Array<[number, number]> = [
      [LM.INDEX_MCP, LM.INDEX_PIP],
      [LM.MIDDLE_MCP, LM.MIDDLE_PIP],
      [LM.RING_MCP, LM.RING_PIP],
      [LM.PINKY_MCP, LM.PINKY_PIP],
    ];
    const distances = calibrationPairs.flatMap(([mcp, pip]) => {
      const a = getLandmark(landmarks, mcp);
      const b = getLandmark(landmarks, pip);
      return a && b ? [distancePixels(a, b, video.videoWidth, video.videoHeight)] : [];
    });
    const averageMcpToPipPixels = distances.reduce((sum, distance) => sum + distance, 0) / distances.length;
    const pixelPerMm = averageMcpToPipPixels / MCP_TO_PIP_MM;
    if (!Number.isFinite(pixelPerMm) || pixelPerMm <= 0) return emptyEstimate(clamp(hand.confidence, 0, 1), this.samples.length);

    const ringMcp = getLandmark(landmarks, LM.RING_MCP);
    const pinkyMcp = getLandmark(landmarks, LM.PINKY_MCP);
    if (!ringMcp || !pinkyMcp) return emptyEstimate(clamp(hand.confidence, 0, 1), this.samples.length);

    const widthPixels = distancePixels(ringMcp, pinkyMcp, video.videoWidth, video.videoHeight) * RING_WIDTH_SCALE;
    const fingerDiameterMm = widthPixels / pixelPerMm;
    const circumferenceMm = fingerDiameterMm * Math.PI;

    this.samples.push(circumferenceMm);
    if (this.samples.length > SMOOTHING_FRAMES) this.samples.shift();
    const smoothedCircumferenceMm = this.samples.reduce((sum, sample) => sum + sample, 0) / this.samples.length;
    const smoothedDiameterMm = smoothedCircumferenceMm / Math.PI;

    return {
      pixelPerMm,
      pixelToMmRatio: 1 / pixelPerMm,
      fingerDiameterMm: smoothedDiameterMm,
      circumferenceMm: smoothedCircumferenceMm,
      usRingSize: circumferenceMmToUsRingSize(smoothedCircumferenceMm),
      euRingSize: circumferenceMmToEuRingSize(smoothedCircumferenceMm),
      ukRingSize: circumferenceMmToUkRingSize(smoothedCircumferenceMm),
      jpRingSize: circumferenceMmToJpRingSize(smoothedCircumferenceMm),
      confidence: clamp(hand.confidence * clamp(this.samples.length / SMOOTHING_FRAMES, 0.35, 1), 0, 1),
      frameCount: this.samples.length,
    };
  }
}

const defaultSizingTool = new SizingTool();

export function estimateRingSizeFromPinch(result: HandTrackingResult | null, video: HTMLVideoElement | null): RingSizeEstimate {
  return defaultSizingTool.estimate(result, video);
}
