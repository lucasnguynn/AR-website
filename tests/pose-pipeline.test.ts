import assert from 'node:assert/strict';
import { RING_MODEL_METADATA } from '../src/config/ringModelMetadata';
import { UKFPosePipeline, type HandMeasurement } from '../src/tracking/PosePipeline';
import { PredictiveLSTM } from '../src/tracking/PredictiveLSTM';
import { PredictiveTransformer } from '../src/tracking/PredictiveTransformer';
import { UKFEngine, type FusionState } from '../src/tracking/UKFEngine';
import { computeRingScale } from '../src/utils/coordinateMapping';

const measurement = (timestamp: number, x = 0, scale = 0.02, scaleMode: HandMeasurement['scaleMode'] = 'visual-relative'): HandMeasurement => ({
  sourceTimestamp: timestamp, position: [x, 0, 0], quaternion: [0, 0, 0, 1], scale, scaleMode, confidence: 0.9,
});

function transformerState(): FusionState {
  return { position: new Float32Array([0.1, 0.2, 0.3]), velocity: new Float32Array([0.2, 0, 0]), acceleration: new Float32Array(3), orientation: new Float32Array([0, 0, 0, 1]), covariance: new Float32Array(225), timestamp: 1000, quaternionUKF: new Float32Array([1, 0, 0, 0]), scaleUKF: 0.02 };
}

export async function runPosePipelineTests(): Promise<void> {
  const pipeline = new UKFPosePipeline();
  pipeline.ingest(measurement(1000)); pipeline.ingest(measurement(1000));
  assert.equal(pipeline.diagnostics().ingestedMeasurements, 1, 'one source timestamp is ingested once');
  assert.equal(pipeline.diagnostics().rejectedDuplicateMeasurements, 1);
  const samples = [1000, 1008, 1016, 1024].map((time) => pipeline.sample(time));
  assert.ok(samples.every(Boolean), 'display sampling can outpace tracking measurements');
  assert.equal(pipeline.diagnostics().ingestedMeasurements, 1, 'display sampling never re-ingests');

  pipeline.ingest({ ...measurement(1033), quaternion: [0, 0, 0, -1] });
  const q = pipeline.sample(1033)?.quaternion;
  assert.ok(q && q[3] > 0 && Math.abs(Math.hypot(...q) - 1) < 1e-5, 'quaternion hemisphere remains continuous and normalized');
  assert.equal(pipeline.sample(1500), null, 'tracking loss hides stale poses');
  assert.equal(pipeline.diagnostics().tracking, 'lost');

  pipeline.ingest(measurement(2000, 0, 0.031, 'metric-calibrated'));
  assert.ok(Math.abs((pipeline.sample(2000)?.scale ?? 0) - 0.031) < 1e-4, 'scale propagates through UKF');
  assert.equal(pipeline.diagnostics().scaleMode, 'metric-calibrated');

  const ukf = new UKFEngine();
  for (let i = 0; i < 12; i += 1) ukf.updatePose6DoF({ timestamp: 3000 + i * 16, position: [i * 0.01, 0, 0], orientation: [0, 0, 0, 1], scale: 0.02 + i * 0.0001, confidence: 0.9 });
  const state = ukf.predict(3200);
  assert.ok(state.position[0] > 0.08 && state.velocity[0] > 0, 'UKF update learns and predicts kinematic motion');
  assert.ok(Math.abs(Math.hypot(...state.orientation) - 1) < 1e-5);
  for (let i = 0; i < 15; i += 1) for (let j = 0; j < 15; j += 1) assert.ok(Math.abs(state.covariance[i * 15 + j] - state.covariance[j * 15 + i]) < 1e-5, 'covariance stays symmetric');

  const a = new PredictiveTransformer(73); const b = new PredictiveTransformer(73);
  const ao = a.predict(transformerState(), 16.667); const bo = b.predict(transformerState(), 16.667);
  assert.deepEqual(Array.from(ao.position), Array.from(bo.position)); assert.deepEqual(Array.from(ao.orientation), Array.from(bo.orientation));

  const lstm = new PredictiveLSTM(4, PredictiveLSTM.createDefaultWeights(4));
  const tensors = lstm.exportWeightTensors();
  assert.equal(tensors.length, 14, 'all LSTM tensors are persisted');
  const reloaded = new PredictiveLSTM(4, PredictiveLSTM.createDefaultWeights(4));
  assert.equal(reloaded.importWeightTensors(tensors.map((tensor) => new Float32Array(tensor))), true);
  assert.deepEqual(reloaded.exportWeightTensors().map((tensor) => Array.from(tensor)), tensors.map((tensor) => Array.from(tensor)), 'all tensors survive reload');
  assert.equal(reloaded.importWeightTensors(tensors.slice(0, 13)), false, 'partial persistence is rejected');

  assert.equal(RING_MODEL_METADATA.assetPath, 'models/nhan.glb');
  assert.ok(RING_MODEL_METADATA.outerDiameterModelUnits > 1.9, 'model dimensions are explicit metadata');
  const visualScale = computeRingScale({ distanceTo: () => 0.1 } as never, {} as never);
  assert.ok(visualScale >= RING_MODEL_METADATA.visualScaleRange.min && visualScale <= RING_MODEL_METADATA.visualScaleRange.max);
  const visual = new UKFPosePipeline(); visual.ingest(measurement(4000));
  assert.equal(visual.diagnostics().scaleMode, 'visual-relative');
}
