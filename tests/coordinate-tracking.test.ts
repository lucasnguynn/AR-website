import assert from 'node:assert/strict';
import * as THREE from 'three';
import { computeAnatomicalRingPose, computeRingScale, normalisedLandmarkToNdc } from '../src/utils/coordinateMapping';
import { RingTrackingStabilizer, TrackingState, type RingPoseSample } from '../src/utils/trackingStabilizer';
import { LM } from '../src/types/ar.types';

function sample(timestamp: number, confidence = 0.9): RingPoseSample {
  return { timestamp, confidence, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: 0.02 };
}

export function runCoordinateTrackingTests(): void {
  const mapping = { videoWidth: 1920, videoHeight: 1080, videoElementWidth: 400, videoElementHeight: 400, canvasWidth: 400, canvasHeight: 400 };
  const center = normalisedLandmarkToNdc({ index: 0, x: 0.5, y: 0.5, z: 0 }, mapping);
  assert.ok(center?.distanceTo(new THREE.Vector2()) < 1e-8, 'object-fit cover retains the source center');
  const right = normalisedLandmarkToNdc({ index: 0, x: 0.55, y: 0.5, z: 0 }, { ...mapping, isMirrored: false }, new THREE.Vector2());
  const mirrored = normalisedLandmarkToNdc({ index: 0, x: 0.55, y: 0.5, z: 0 }, { ...mapping, isMirrored: true }, new THREE.Vector2());
  assert.equal(Math.sign(right?.x ?? 0), -Math.sign(mirrored?.x ?? 0), 'handed camera mirroring changes horizontal handedness');
  assert.equal(normalisedLandmarkToNdc({ index: 0, x: 0, y: 0, z: 0 }, { ...mapping, videoWidth: 0 }), null);

  const points = {
    [LM.INDEX_MCP]: new THREE.Vector3(-1, 0, 0), [LM.RING_MCP]: new THREE.Vector3(0, 0, 0),
    [LM.RING_PIP]: new THREE.Vector3(0, 1, 0), [LM.PINKY_MCP]: new THREE.Vector3(1, 0, 0),
  };
  const output = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3() };
  assert.ok(computeAnatomicalRingPose(points, output) !== null);
  assert.ok(Math.abs(output.quaternion.length() - 1) < 1e-8, 'anatomical basis produces a normalized orientation');
  assert.equal(computeAnatomicalRingPose({ ...points, [LM.RING_PIP]: points[LM.RING_MCP] }, output), null, 'degenerate finger direction fails safely');
  assert.ok(computeRingScale(new THREE.Vector3(), new THREE.Vector3(100, 0, 0)) < 1, 'scale is bounded by calibrated model metadata');

  const stabilizer = new RingTrackingStabilizer({ lockFrames: 2, graceMs: 20, lostMs: 50 });
  assert.equal(stabilizer.update(sample(100)).state, TrackingState.LOCKING);
  assert.equal(stabilizer.update(sample(116)).state, TrackingState.TRACKING);
  assert.equal(stabilizer.update({ ...sample(126), confidence: 0.1 }).state, TrackingState.UNCERTAIN);
  assert.equal(stabilizer.update({ ...sample(200), confidence: 0.1 }).state, TrackingState.LOST);
  assert.equal(stabilizer.update(sample(216)).state, TrackingState.LOCKING, 'recovery must reacquire rather than jump visible');
  assert.equal(stabilizer.update(sample(232)).state, TrackingState.TRACKING);
}
