import { AR_RUNTIME_CONFIG } from './arRuntimeConfig';

/** Contract between CAD/Blender export and the runtime placement engine. */
export interface RingModelMetadata {
  readonly assetVersion: string;
  /** Backward-compatible default asset path; prefer AR_RUNTIME_CONFIG assets for LOD selection. */
  readonly assetPath: string;
  readonly modelOuterDiameterUnits: number;
  readonly modelHeightUnits: number;
  readonly referenceOuterDiameterMeters: number;
  readonly metersPerModelUnit: number;
  readonly visualFingerSegmentBaselineMeters: number;
  readonly visualScaleClamp: Readonly<{ min: number; max: number }>;
  readonly requiredSemanticRoles: readonly ['metal', 'gemstone'];
  readonly metricCalibrationValidated: boolean;
  // Backward-compatible visual-placement fields used by coordinateMapping.ts.
  readonly outerDiameterModelUnits: number;
  readonly heightModelUnits: number;
  readonly visualFingerWidthFraction: number;
  readonly visualScaleRange: Readonly<{ min: number; max: number }>;
}

const MODEL_OUTER_DIAMETER_UNITS = 1.9013477563858032;
const REFERENCE_OUTER_DIAMETER_METERS = AR_RUNTIME_CONFIG.product.referenceOuterDiameterMm / 1000;

export const RING_MODEL_METADATA: RingModelMetadata = Object.freeze({
  assetVersion: AR_RUNTIME_CONFIG.product.assetVersion,
  assetPath: 'models/nhan.glb',
  modelOuterDiameterUnits: MODEL_OUTER_DIAMETER_UNITS,
  modelHeightUnits: 1.3235336542129517,
  referenceOuterDiameterMeters: REFERENCE_OUTER_DIAMETER_METERS,
  metersPerModelUnit: REFERENCE_OUTER_DIAMETER_METERS / MODEL_OUTER_DIAMETER_UNITS,
  visualFingerSegmentBaselineMeters: 0.045,
  visualScaleClamp: Object.freeze({ min: 0.72, max: 1.32 }),
  requiredSemanticRoles: Object.freeze(['metal', 'gemstone'] as const),
  metricCalibrationValidated: AR_RUNTIME_CONFIG.features.metricCalibrationValidated,
  outerDiameterModelUnits: MODEL_OUTER_DIAMETER_UNITS,
  heightModelUnits: 1.3235336542129517,
  visualFingerWidthFraction: 0.65,
  visualScaleRange: Object.freeze({ min: 0.005, max: 0.08 }),
});

/**
 * Returns a world-scale factor for the authored GLB.
 *
 * - Metric mode keeps the physical diameter fixed and is only allowed after
 *   calibration has been explicitly validated.
 * - Visual mode allows a conservative relative adjustment against finger
 *   anatomy without claiming ring-size accuracy.
 */
export function computeRingWorldScale(fingerSegmentMeters?: number): number {
  const base = RING_MODEL_METADATA.metersPerModelUnit;
  if (RING_MODEL_METADATA.metricCalibrationValidated || fingerSegmentMeters === undefined) return base;

  const relative = fingerSegmentMeters / RING_MODEL_METADATA.visualFingerSegmentBaselineMeters;
  const clamped = Math.min(
    RING_MODEL_METADATA.visualScaleClamp.max,
    Math.max(RING_MODEL_METADATA.visualScaleClamp.min, relative),
  );
  return base * clamped;
}
