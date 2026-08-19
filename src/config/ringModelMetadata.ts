/** Measured from the POSITION accessor bounds in public/models/nhan.glb. */
export interface RingModelMetadata {
  readonly assetPath: string;
  readonly outerDiameterModelUnits: number;
  readonly heightModelUnits: number;
  readonly visualFingerWidthFraction: number;
  readonly visualScaleRange: Readonly<{ min: number; max: number }>;
}

export const RING_MODEL_METADATA: RingModelMetadata = Object.freeze({
  assetPath: 'models/nhan.glb',
  outerDiameterModelUnits: 1.9013477563858032,
  heightModelUnits: 1.3235336542129517,
  visualFingerWidthFraction: 0.65,
  visualScaleRange: Object.freeze({ min: 0.005, max: 0.08 }),
});
