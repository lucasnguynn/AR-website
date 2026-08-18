import { PredictiveLSTM, type PredictedPose } from './PredictiveLSTM';
import { UKFEngine, type FusionState, type Keypoint2DMeasurement, type Pose6DoFMeasurement } from './UKFEngine';

export interface FusionInput {
  readonly keypoint2D?: Keypoint2DMeasurement;
  readonly pose6DoF?: Pose6DoFMeasurement;
  readonly depthMeters?: number;
  readonly timestamp: number;
}

export interface PredictiveFusionOutput {
  readonly filtered: FusionState;
  readonly predicted16ms: PredictedPose;
  readonly predicted33ms: PredictedPose;
  readonly latencyBudgetMs: number;
}

export class PredictiveKalmanFusion {
  private readonly ukf: UKFEngine;
  private readonly lstm16: PredictiveLSTM;
  private readonly lstm33: PredictiveLSTM;
  private readonly output: PredictiveFusionOutput;

  constructor(ukf = new UKFEngine(), lstm16 = new PredictiveLSTM(), lstm33 = new PredictiveLSTM()) {
    this.ukf = ukf;
    this.lstm16 = lstm16;
    this.lstm33 = lstm33;
    const filtered = this.ukf.predict(0);
    this.output = {
      filtered,
      predicted16ms: this.lstm16.predict(filtered, 16.667),
      predicted33ms: this.lstm33.predict(filtered, 33.334),
      latencyBudgetMs: 30,
    };
  }

  reset(): void { this.ukf.reset(); this.lstm16.reset(); this.lstm33.reset(); }

  update(input: FusionInput): PredictiveFusionOutput {
    let state = this.ukf.predict(input.timestamp);
    if (input.keypoint2D) state = this.ukf.updateKeypoint2D(input.keypoint2D, input.depthMeters ?? state.position[2]);
    if (input.pose6DoF) state = this.ukf.updatePose6DoF(input.pose6DoF);
    (this.output as { filtered: FusionState }).filtered = state;
    (this.output as { predicted16ms: PredictedPose }).predicted16ms = this.lstm16.predict(state, 16.667);
    (this.output as { predicted33ms: PredictedPose }).predicted33ms = this.lstm33.predict(state, 33.334);
    return this.output;
  }

  predictOnly(timestamp: number): PredictiveFusionOutput {
    const state = this.ukf.predict(timestamp);
    (this.output as { filtered: FusionState }).filtered = state;
    (this.output as { predicted16ms: PredictedPose }).predicted16ms = this.lstm16.predict(state, 16.667);
    (this.output as { predicted33ms: PredictedPose }).predicted33ms = this.lstm33.predict(state, 33.334);
    return this.output;
  }
}
