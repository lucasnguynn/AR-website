/**
 * coordinateMapping.ts
 *
 * Strict MediaPipe-normalized-video to Three.js projection utilities plus an
 * anatomical ring-pose solver. The hot-path APIs accept caller-owned output
 * vectors/quaternions so WebAR render loops can run without per-frame Three.js
 * allocations.
 */

import * as THREE from 'three';
import { RING_MODEL_METADATA } from '../config/ringModelMetadata';
import type { NormalisedLandmark } from '../types/ar.types';
import { LM } from '../types/ar.types';

const BASE_Z = 1.5;
const Z_SCALE = 5.0;
export const RING_SEGMENT_T = 0.25;

const EPSILON = 1e-8;

export interface ProjectionParams {
  videoElement: HTMLVideoElement;
  canvasElement: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  isMirrored?: boolean;
}

export interface ViewportMappingParams {
  videoWidth: number;
  videoHeight: number;
  videoElementWidth: number;
  videoElementHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  isMirrored?: boolean;
}

export interface AnatomicalRingPoseOutputs {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale?: THREE.Vector3;
}

export interface AnatomicalRingPoseOptions {
  ringSegmentT?: number;
  ringModelDiameter?: number;
  fingerWidthFraction?: number;
}

const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane();
const _planeNormal = new THREE.Vector3(0, 0, 1);
const _worldPos = new THREE.Vector3();

const _basisForward = new THREE.Vector3();
const _basisRight = new THREE.Vector3();
const _basisUp = new THREE.Vector3();
const _handSpan = new THREE.Vector3();
const _ringMatrix = new THREE.Matrix4();

export function normalisedLandmarkToNdc(
  lm: NormalisedLandmark,
  params: ViewportMappingParams,
  out: THREE.Vector2 = _ndc,
): THREE.Vector2 | null {
  const {
    videoWidth,
    videoHeight,
    videoElementWidth,
    videoElementHeight,
    canvasWidth,
    canvasHeight,
    isMirrored = true,
  } = params;

  if (
    videoWidth <= 0 ||
    videoHeight <= 0 ||
    videoElementWidth <= 0 ||
    videoElementHeight <= 0 ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return null;
  }

  const normX = isMirrored ? 1 - lm.x : lm.x;
  const coverScale = Math.max(videoElementWidth / videoWidth, videoElementHeight / videoHeight);
  const scaledVideoW = videoWidth * coverScale;
  const scaledVideoH = videoHeight * coverScale;
  const cropX = (scaledVideoW - videoElementWidth) * 0.5;
  const cropY = (scaledVideoH - videoElementHeight) * 0.5;

  const elemNormX = (normX * scaledVideoW - cropX) / videoElementWidth;
  const elemNormY = (lm.y * scaledVideoH - cropY) / videoElementHeight;

  const canvasNormX = elemNormX * (videoElementWidth / canvasWidth);
  const canvasNormY = elemNormY * (videoElementHeight / canvasHeight);

  out.set(
    Math.max(-1, Math.min(1, canvasNormX * 2 - 1)),
    Math.max(-1, Math.min(1, -(canvasNormY * 2 - 1))),
  );
  return out;
}

export function landmarkToWorld(
  lm: NormalisedLandmark,
  params: ProjectionParams,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 | null {
  const { videoElement, canvasElement, camera, isMirrored = true } = params;

  const ndc = normalisedLandmarkToNdc(
    lm,
    {
      videoWidth: videoElement.videoWidth,
      videoHeight: videoElement.videoHeight,
      videoElementWidth: videoElement.clientWidth,
      videoElementHeight: videoElement.clientHeight,
      canvasWidth: canvasElement.clientWidth,
      canvasHeight: canvasElement.clientHeight,
      isMirrored,
    },
    _ndc,
  );
  if (!ndc) return null;

  _raycaster.setFromCamera(ndc, camera);
  _plane.set(_planeNormal, -(BASE_Z - lm.z * Z_SCALE));

  const hit = _raycaster.ray.intersectPlane(_plane, _worldPos);
  if (!hit) return null;

  out.copy(_worldPos);
  return out;
}

export function projectRingLandmarks(
  landmarks: NormalisedLandmark[],
  params: ProjectionParams,
  out: Record<number, THREE.Vector3>,
): boolean {
  const byIndex: Array<NormalisedLandmark | undefined> = [];
  for (const landmark of landmarks) {
    if (landmark.index !== undefined) byIndex[landmark.index] = landmark;
  }
  const indexMcp = byIndex[LM.INDEX_MCP];
  const ringMcp = byIndex[LM.RING_MCP];
  const ringPip = byIndex[LM.RING_PIP];
  const pinkyMcp = byIndex[LM.PINKY_MCP];

  if (!indexMcp || !ringMcp || !ringPip || !pinkyMcp) return false;

  return Boolean(
    landmarkToWorld(indexMcp, params, out[LM.INDEX_MCP]) &&
      landmarkToWorld(ringMcp, params, out[LM.RING_MCP]) &&
      landmarkToWorld(ringPip, params, out[LM.RING_PIP]) &&
      landmarkToWorld(pinkyMcp, params, out[LM.PINKY_MCP]),
  );
}

export function computeAnatomicalRingPose(
  projectedLandmarks: Record<number, THREE.Vector3>,
  outputs: AnatomicalRingPoseOutputs,
  options: AnatomicalRingPoseOptions = {},
): number | null {
  const indexMcp = projectedLandmarks[LM.INDEX_MCP];
  const ringMcp = projectedLandmarks[LM.RING_MCP];
  const ringPip = projectedLandmarks[LM.RING_PIP];
  const pinkyMcp = projectedLandmarks[LM.PINKY_MCP];

  _basisForward.subVectors(ringPip, ringMcp);
  if (_basisForward.lengthSq() < EPSILON) return null;
  _basisForward.normalize();

  _handSpan.subVectors(pinkyMcp, indexMcp);
  if (_handSpan.lengthSq() < EPSILON) return null;
  _handSpan.normalize();

  _basisRight.crossVectors(_basisForward, _handSpan);
  if (_basisRight.lengthSq() < EPSILON) return null;
  _basisRight.normalize();

  _basisUp.crossVectors(_basisRight, _basisForward).normalize();

  _ringMatrix.makeBasis(_basisRight, _basisUp, _basisForward);
  outputs.quaternion.setFromRotationMatrix(_ringMatrix);

  outputs.position.copy(ringMcp).lerp(ringPip, options.ringSegmentT ?? RING_SEGMENT_T);

  const scale = computeRingScale(
    ringMcp,
    ringPip,
    options.ringModelDiameter,
    options.fingerWidthFraction,
  );
  outputs.scale?.setScalar(scale);
  return scale;
}

export function computeRingQuaternion(
  projectedLandmarks: Record<number, THREE.Vector3>,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  const outputs = { position: _worldPos, quaternion: out };
  const scale = computeAnatomicalRingPose(projectedLandmarks, outputs);
  if (scale === null) out.identity();
  return out;
}

export function computeRingScale(
  posMCP: THREE.Vector3,
  posPIP: THREE.Vector3,
  ringModelDiameter = RING_MODEL_METADATA.outerDiameterModelUnits,
  fingerWidthFraction = RING_MODEL_METADATA.visualFingerWidthFraction,
): number {
  const segmentLength = posMCP.distanceTo(posPIP);
  const scale = (segmentLength * fingerWidthFraction) / ringModelDiameter;
  return Math.max(RING_MODEL_METADATA.visualScaleRange.min, Math.min(RING_MODEL_METADATA.visualScaleRange.max, scale));
}

let _captureCanvas: OffscreenCanvas | null = null;
let _captureCtx: OffscreenCanvasRenderingContext2D | null = null;

export function inferenceFrameSize(width: number, height: number, longestEdge = 384): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, longestEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function captureVideoFrame(
  video: HTMLVideoElement,
): { buffer: ArrayBuffer; width: number; height: number } | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth === 0 || sourceHeight === 0) return null;

  // MediaPipe's hand model does not benefit from a multi-megapixel RGBA input.
  // Resize before readback so the fallback copies at most ~0.15 MP rather than
  // the complete camera frame (often 2-8 MP on mobile devices).
  const { width: w, height: h } = inferenceFrameSize(sourceWidth, sourceHeight);

  if (!_captureCanvas || _captureCanvas.width !== w || _captureCanvas.height !== h) {
    (_captureCanvas as OffscreenCanvas & { close?: () => void } | null)?.close?.();
    _captureCanvas = new OffscreenCanvas(w, h);
    _captureCtx = _captureCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  }

  _captureCtx!.drawImage(video, 0, 0, sourceWidth, sourceHeight, 0, 0, w, h);
  const imageData = _captureCtx!.getImageData(0, 0, w, h);

  return {
    buffer: imageData.data.buffer.slice(0),
    width: w,
    height: h,
  };
}
