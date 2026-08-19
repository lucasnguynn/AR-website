import assert from 'node:assert/strict';
import { protocolMessage, validateDepthInbound, validateDepthOutbound, validateMediaPipeInbound, validateMediaPipeOutbound, WORKER_PROTOCOL_VERSION } from '../src/protocol/workerProtocol';

export function runWorkerProtocolTests(): void {
  assert.equal(validateMediaPipeInbound(protocolMessage({ type: 'INIT', payload: { wasmBlobUrl: 'blob:wasm', modelUrl: '/model.task' } })), true);
  assert.equal(validateMediaPipeOutbound(protocolMessage({ type: 'READY' })), true);
  assert.equal(validateMediaPipeOutbound(protocolMessage({ type: 'DEGRADED', payload: { metrics: {} } })), true);
  assert.equal(validateMediaPipeInbound(protocolMessage({ type: 'RESUME' })), true);
  assert.equal(validateMediaPipeInbound(protocolMessage({ type: 'DESTROY' })), true);
  assert.equal(validateMediaPipeInbound({ type: 'DESTROY', protocolVersion: WORKER_PROTOCOL_VERSION + 1 }), false);
  assert.equal(validateMediaPipeInbound(protocolMessage({ type: 'DETECT', payload: { buffer: new ArrayBuffer(4), width: 1, height: 1, timestamp: 2 } })), true, 'ordered frames carry source timestamps');
  assert.equal(validateMediaPipeInbound(protocolMessage({ type: 'DETECT', payload: { buffer: new ArrayBuffer(0), width: Number.NaN, height: 1, timestamp: 2 } })), false);
  assert.equal(validateDepthInbound(protocolMessage({ type: 'INIT', payload: {} })), true);
  assert.equal(validateDepthOutbound(protocolMessage({ type: 'DEGRADED', payload: { frameId: 4, reason: 'backpressure' } })), true, 'queue overflow is a typed degraded result');
  assert.equal(validateDepthOutbound(protocolMessage({ type: 'DESTROYED' })), true);
}
