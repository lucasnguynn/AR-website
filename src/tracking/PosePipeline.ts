import { UKFEngine, type FusionState } from './UKFEngine';

export type PredictionMode = 'kinematic' | 'transformer-experimental' | 'lstm-experimental';
export type ScaleMode = 'visual-relative' | 'metric-calibrated';

export interface HandMeasurement {
  readonly sourceTimestamp: number;
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly scale: number;
  readonly scaleMode: ScaleMode;
  readonly confidence: number;
}

export interface RenderPose {
  readonly position: Float32Array;
  readonly quaternion: Float32Array;
  readonly scale: number;
  readonly confidence: number;
  readonly visible: boolean;
  readonly sourceTimestamp: number;
  readonly displayTimestamp: number;
}

export interface PoseDiagnostics {
  readonly filter: 'ukf';
  readonly prediction: PredictionMode;
  readonly scaleMode: ScaleMode;
  readonly ingestedMeasurements: number;
  readonly rejectedDuplicateMeasurements: number;
  readonly lastSourceTimestamp: number | null;
  readonly tracking: 'searching' | 'tracking' | 'lost';
}

export interface PosePipeline {
  ingest(measurement: HandMeasurement): void;
  sample(displayTimestamp: DOMHighResTimeStamp): RenderPose | null;
  reset(): void;
  diagnostics(): PoseDiagnostics;
}

export interface PosePipelineOptions {
  readonly prediction?: PredictionMode;
  readonly trackingLossMs?: number;
  readonly maxPredictionMs?: number;
}

/** Production pose composition root. Learned modes are labelled experimental and opt-in. */
export class UKFPosePipeline implements PosePipeline {
  private readonly ukf: UKFEngine;
  private readonly prediction: PredictionMode;
  private readonly trackingLossMs: number;
  private readonly maxPredictionMs: number;
  private state: FusionState | null = null;
  private lastSourceTimestamp: number | null = null;
  private lastScaleMode: ScaleMode = 'visual-relative';
  private lastConfidence = 0;
  private ingested = 0;
  private duplicates = 0;
  private tracking: PoseDiagnostics['tracking'] = 'searching';
  private readonly position = new Float32Array(3);
  private readonly quaternion = new Float32Array([0, 0, 0, 1]);
  private readonly output: RenderPose = { position: this.position, quaternion: this.quaternion, scale: 1, confidence: 0, visible: false, sourceTimestamp: 0, displayTimestamp: 0 };

  constructor(options: PosePipelineOptions = {}, ukf = new UKFEngine()) {
    this.ukf = ukf;
    this.prediction = options.prediction ?? 'kinematic';
    if (this.prediction !== 'kinematic') throw new Error(`${this.prediction} is experimental and has no held-out validation fixture; production activation is refused`);
    this.trackingLossMs = options.trackingLossMs ?? 420;
    this.maxPredictionMs = options.maxPredictionMs ?? 50;
  }

  ingest(measurement: HandMeasurement): void {
    if (measurement.sourceTimestamp === this.lastSourceTimestamp) { this.duplicates += 1; return; }
    if (this.lastSourceTimestamp !== null && measurement.sourceTimestamp < this.lastSourceTimestamp) return;
    if (!this.valid(measurement)) return;
    this.state = this.ukf.updatePose6DoF({
      timestamp: measurement.sourceTimestamp,
      position: measurement.position,
      orientation: measurement.quaternion,
      scale: measurement.scale,
      confidence: measurement.confidence,
    });
    this.lastSourceTimestamp = measurement.sourceTimestamp;
    this.lastScaleMode = measurement.scaleMode;
    this.lastConfidence = measurement.confidence;
    this.ingested += 1;
    this.tracking = 'tracking';
  }

  sample(displayTimestamp: DOMHighResTimeStamp): RenderPose | null {
    const state = this.state;
    const sourceTimestamp = this.lastSourceTimestamp;
    if (!state || sourceTimestamp === null) return null;
    const ageMs = Math.max(0, displayTimestamp - sourceTimestamp);
    if (ageMs > this.trackingLossMs) { this.resetFilterAfterLoss(); return null; }
    const dt = Math.min(ageMs, this.maxPredictionMs) * 0.001;
    for (let i = 0; i < 3; i += 1) this.position[i] = state.position[i] + state.velocity[i] * dt + 0.5 * state.acceleration[i] * dt * dt;
    this.copyContinuousQuaternion(state.orientation);
    (this.output as { scale: number }).scale = state.scaleUKF;
    (this.output as { confidence: number }).confidence = this.lastConfidence * Math.max(0, 1 - ageMs / this.trackingLossMs);
    (this.output as { visible: boolean }).visible = true;
    (this.output as { sourceTimestamp: number }).sourceTimestamp = sourceTimestamp;
    (this.output as { displayTimestamp: number }).displayTimestamp = displayTimestamp;
    return this.output;
  }

  reset(): void {
    this.ukf.reset(); this.state = null; this.lastSourceTimestamp = null; this.lastConfidence = 0;
    this.position.fill(0); this.quaternion.set([0, 0, 0, 1]); this.tracking = 'searching';
  }

  diagnostics(): PoseDiagnostics {
    return { filter: 'ukf', prediction: this.prediction, scaleMode: this.lastScaleMode, ingestedMeasurements: this.ingested, rejectedDuplicateMeasurements: this.duplicates, lastSourceTimestamp: this.lastSourceTimestamp, tracking: this.tracking };
  }

  private resetFilterAfterLoss(): void { this.reset(); this.tracking = 'lost'; }

  private copyContinuousQuaternion(source: Float32Array): void {
    const dot = this.quaternion[0] * source[0] + this.quaternion[1] * source[1] + this.quaternion[2] * source[2] + this.quaternion[3] * source[3];
    const sign = dot < 0 ? -1 : 1;
    for (let i = 0; i < 4; i += 1) this.quaternion[i] = source[i] * sign;
  }

  private valid(m: HandMeasurement): boolean {
    return Number.isFinite(m.sourceTimestamp) && Number.isFinite(m.scale) && m.scale > 0 && Number.isFinite(m.confidence) && m.confidence >= 0 && m.confidence <= 1
      && m.position.every(Number.isFinite) && m.quaternion.every(Number.isFinite) && Math.abs(Math.hypot(...m.quaternion) - 1) < 0.1;
  }
}
