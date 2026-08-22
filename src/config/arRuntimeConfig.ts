import type { ProductARMetadata } from '../types/productAR.types';

export type ARQualityTier = 'HIGH' | 'MEDIUM' | 'LOW';

function envFlag(value: string | boolean | undefined, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function finitePositive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sameOriginPath(value: string | undefined, fallback: string): string {
  const path = (value || fallback).trim();
  if (/^(?:https?:)?\/\//i.test(path)) {
    throw new Error(`Cross-origin runtime endpoint is not allowed by the current privacy contract: ${path}`);
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function asset(path: string): string {
  const cleanBase = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  return `${cleanBase}${path.replace(/^\//, '')}`;
}

const modelHigh = import.meta.env.VITE_RING_MODEL_HIGH || 'models/nhan.glb';
const modelMedium = import.meta.env.VITE_RING_MODEL_MEDIUM || modelHigh;
const modelLow = import.meta.env.VITE_RING_MODEL_LOW || modelMedium;

/**
 * One source of truth for AR runtime assets, product metadata, feature flags and
 * performance budgets. Product/SKU systems can replace this object later without
 * changing AR core code.
 */
export const AR_RUNTIME_CONFIG = Object.freeze({
  product: Object.freeze({
    sku: import.meta.env.VITE_PRODUCT_SKU || 'RING-DEMO-001',
    name: import.meta.env.VITE_PRODUCT_NAME || 'Classic Ring',
    assetVersion: import.meta.env.VITE_ASSET_VERSION || '1',
    referenceOuterDiameterMm: finitePositive(import.meta.env.VITE_RING_OUTER_DIAMETER_MM, 18),
  }),
  assets: Object.freeze({
    handLandmarker: asset('models/hand_landmarker.task'),
    mediapipeWasmRoot: asset('wasm'),
    ring: Object.freeze({
      HIGH: asset(modelHigh),
      MEDIUM: asset(modelMedium),
      LOW: asset(modelLow),
    } as Record<ARQualityTier, string>),
    usdz: asset(import.meta.env.VITE_RING_USDZ || 'models/nhan.usdz'),
    preview: asset(import.meta.env.VITE_RING_PREVIEW || 'models/nhan-preview.png'),
    depthModel: asset(import.meta.env.VITE_DEPTH_MODEL || 'models/depth/depth_anything_v2_small.onnx'),
  }),
  features: Object.freeze({
    monocularDepth: envFlag(import.meta.env.VITE_ENABLE_MONOCULAR_DEPTH),
    metricSizingRequested: envFlag(import.meta.env.VITE_ENABLE_METRIC_SIZING),
    /** Must only become true after physical calibration/device validation. */
    metricCalibrationValidated: envFlag(import.meta.env.VITE_METRIC_CALIBRATION_VALIDATED),
    telemetry: envFlag(import.meta.env.VITE_ENABLE_PRIVACY_TELEMETRY),
  }),
  performance: Object.freeze({
    HIGH: Object.freeze({ dpr: 2, shadows: true, depthIntervalMs: 66, targetFrameMs: 16.7 }),
    MEDIUM: Object.freeze({ dpr: 1.5, shadows: false, depthIntervalMs: 100, targetFrameMs: 22 }),
    LOW: Object.freeze({ dpr: 1, shadows: false, depthIntervalMs: 180, targetFrameMs: 33 }),
  } as Record<ARQualityTier, { dpr: number; shadows: boolean; depthIntervalMs: number; targetFrameMs: number }>),
  telemetryEndpoint: sameOriginPath(import.meta.env.VITE_TELEMETRY_ENDPOINT, '/telemetry/ar'),
});

export const CURRENT_PRODUCT_AR_METADATA: ProductARMetadata = Object.freeze({
  sku: AR_RUNTIME_CONFIG.product.sku,
  name: AR_RUNTIME_CONFIG.product.name,
  assetVersion: AR_RUNTIME_CONFIG.product.assetVersion,
  modelGlb: AR_RUNTIME_CONFIG.assets.ring,
  modelUsdz: AR_RUNTIME_CONFIG.assets.usdz,
  previewImage: AR_RUNTIME_CONFIG.assets.preview,
  realWorldOuterDiameterMm: AR_RUNTIME_CONFIG.product.referenceOuterDiameterMm,
  targetFinger: 'RING',
  anchorPosition: 0.28,
  rotationOffset: Object.freeze({ x: 0, y: 0, z: 0 }),
});

export function ringModelUrlForQuality(quality: ARQualityTier): string {
  return CURRENT_PRODUCT_AR_METADATA.modelGlb[quality];
}

export function metricSizingEnabled(): boolean {
  return AR_RUNTIME_CONFIG.features.metricSizingRequested && AR_RUNTIME_CONFIG.features.metricCalibrationValidated;
}
