export type ProductARQualityTier = 'HIGH' | 'MEDIUM' | 'LOW';

/** Shared commerce -> AR metadata contract. Safe to mirror in Medusa product metadata later. */
export interface ProductARMetadata {
  readonly sku: string;
  readonly name: string;
  readonly assetVersion: string;
  readonly modelGlb: Readonly<Record<ProductARQualityTier, string>>;
  readonly modelUsdz?: string;
  readonly previewImage?: string;
  readonly realWorldOuterDiameterMm: number;
  readonly innerDiameterMm?: number;
  readonly targetFinger: 'RING' | 'INDEX' | 'MIDDLE';
  readonly anchorPosition: number;
  readonly rotationOffset: Readonly<{ x: number; y: number; z: number }>;
}

export function validateProductARMetadata(metadata: ProductARMetadata): readonly string[] {
  const errors: string[] = [];
  if (!metadata.sku.trim()) errors.push('sku is required');
  if (!metadata.assetVersion.trim()) errors.push('assetVersion is required');
  if (!Number.isFinite(metadata.realWorldOuterDiameterMm) || metadata.realWorldOuterDiameterMm <= 0) errors.push('realWorldOuterDiameterMm must be > 0');
  if (metadata.innerDiameterMm !== undefined && (!Number.isFinite(metadata.innerDiameterMm) || metadata.innerDiameterMm <= 0)) errors.push('innerDiameterMm must be > 0 when provided');
  if (metadata.anchorPosition < 0 || metadata.anchorPosition > 1) errors.push('anchorPosition must be between 0 and 1');
  for (const tier of ['HIGH', 'MEDIUM', 'LOW'] as const) {
    if (!metadata.modelGlb[tier]) errors.push(`modelGlb.${tier} is required`);
  }
  return errors;
}
