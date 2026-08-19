import type { HandTrackingResult, TrackingMetrics } from '../types/ar.types';

export const WORKER_PROTOCOL_VERSION = 1 as const;
export type WorkerProtocolVersion = typeof WORKER_PROTOCOL_VERSION;
type Versioned<T> = T & { protocolVersion: WorkerProtocolVersion };

export interface MediaPipeFramePayload { buffer: ArrayBuffer; width: number; height: number; timestamp: number }
export type MediaPipeInboundMessage = Versioned<
  | { type: 'INIT'; payload: { wasmBlobUrl: string; modelUrl: string } }
  | { type: 'DETECT'; payload: MediaPipeFramePayload }
  | { type: 'PAUSE' | 'RESUME' | 'DESTROY' }
>;
export type MediaPipeWorkerState = 'INIT' | 'READY' | 'PROCESS' | 'DEGRADED' | 'DESTROY';
export type MediaPipeOutboundMessage = Versioned<
  | { type: 'READY' | 'PAUSED' | 'DESTROYED' }
  | { type: 'PROGRESS'; payload: { phase: 'wasm' | 'model'; progress: number } }
  | { type: 'RESULT'; payload: HandTrackingResult & { metrics: TrackingMetrics } }
  | { type: 'DEGRADED'; payload: { metrics: TrackingMetrics } }
  | { type: 'ERROR'; payload: { message: string; state: MediaPipeWorkerState } }
>;
export type UnversionedMediaPipeOutboundMessage = MediaPipeOutboundMessage extends infer Message
  ? Message extends { protocolVersion: WorkerProtocolVersion }
    ? Omit<Message, 'protocolVersion'>
    : never
  : never;

export type DepthTier = 'monocular-depth' | 'degraded-depth';
export type DepthInboundMessage = Versioned<
  | { type: 'INIT'; payload: { modelUrl?: string } }
  | { type: 'DETECT'; payload: { frameId: number; image: ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement; tier?: DepthTier } }
  | { type: 'PAUSE' | 'RESUME' | 'DESTROY' }
>;
export type DepthOutboundMessage = Versioned<
  | { type: 'READY' | 'DESTROYED' }
  | { type: 'RESULT'; payload: { frameId: number; width: number; height: number; depth: Float32Array; tier: DepthTier; averageMs: number } }
  | { type: 'DEGRADED'; payload: { frameId: number; reason: 'backpressure' } }
  | { type: 'ERROR'; payload: { message: string; frameId?: number } }
>;

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null; }
function versioned(value: unknown): value is RecordValue & { protocolVersion: WorkerProtocolVersion; type: string } {
  return record(value) && value.protocolVersion === WORKER_PROTOCOL_VERSION && typeof value.type === 'string';
}
export function validateMediaPipeInbound(value: unknown): value is MediaPipeInboundMessage {
  if (!versioned(value)) return false;
  if (value.type === 'PAUSE' || value.type === 'RESUME' || value.type === 'DESTROY') return true;
  if (!record(value.payload)) return false;
  if (value.type === 'INIT') return typeof value.payload.wasmBlobUrl === 'string' && typeof value.payload.modelUrl === 'string';
  return value.type === 'DETECT' && value.payload.buffer instanceof ArrayBuffer && Number.isFinite(value.payload.width) && Number.isFinite(value.payload.height) && Number.isFinite(value.payload.timestamp);
}
export function validateMediaPipeOutbound(value: unknown): value is MediaPipeOutboundMessage {
  if (!versioned(value)) return false;
  if (value.type === 'READY' || value.type === 'PAUSED' || value.type === 'DESTROYED') return true;
  return ['PROGRESS', 'RESULT', 'DEGRADED', 'ERROR'].includes(value.type) && record(value.payload);
}
export function validateDepthInbound(value: unknown): value is DepthInboundMessage {
  if (!versioned(value)) return false;
  if (value.type === 'PAUSE' || value.type === 'RESUME' || value.type === 'DESTROY') return true;
  if (!record(value.payload)) return false;
  if (value.type === 'INIT') return value.payload.modelUrl === undefined || typeof value.payload.modelUrl === 'string';
  return value.type === 'DETECT' && Number.isFinite(value.payload.frameId) && record(value.payload.image);
}
export function validateDepthOutbound(value: unknown): value is DepthOutboundMessage {
  return versioned(value) && (value.type === 'READY' || value.type === 'DESTROYED' || (['RESULT', 'DEGRADED', 'ERROR'].includes(value.type) && record(value.payload)));
}

export function protocolMessage<T extends { type: string }>(message: T): T & { protocolVersion: WorkerProtocolVersion } {
  return { ...message, protocolVersion: WORKER_PROTOCOL_VERSION };
}
