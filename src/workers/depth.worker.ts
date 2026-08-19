// FILE: src/workers/depth.worker.ts
import * as ort from 'onnxruntime-web/webgpu';
import { protocolMessage, validateDepthInbound, type DepthTier } from '../protocol/workerProtocol';

type WorkerGlobal = typeof self & {
  caches?: CacheStorage;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
};

const workerScope = self as WorkerGlobal;
type OrtTensor = { data: Float32Array | readonly number[]; dims: readonly number[] };
type OrtSession = { inputNames: readonly string[]; outputNames: readonly string[]; run(feeds: Record<string, ort.Tensor>): Promise<Record<string, OrtTensor>> };
const INPUT_SIZE = 518;
const MODEL_CACHE = 'webar-models-v1';
const DEFAULT_MODEL_URL = '/models/depth/depth_anything_v2_small.onnx';
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

ort.env.wasm.wasmPaths = '/wasm/ort/';

let session: OrtSession | null = null;
let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let busy = false;
let lastInferenceAt = 0;
let averageMs = 0;

async function cachedModelBuffer(modelUrl: string): Promise<ArrayBuffer> {
  const request = new Request(modelUrl, { credentials: 'same-origin' });
  if (!workerScope.caches) {
    const response = await fetch(request);
    if (!response.ok) throw new Error(`Failed to fetch depth model: ${response.status} ${response.statusText}`);
    return response.arrayBuffer();
  }

  const cache = await workerScope.caches.open(MODEL_CACHE);
  const cached = await cache.match(request);
  const response = cached ?? await fetch(request);
  if (!response.ok) throw new Error(`Failed to fetch depth model: ${response.status} ${response.statusText}`);
  if (!cached) await cache.put(request, response.clone());
  return response.arrayBuffer();
}

async function init(modelUrl = DEFAULT_MODEL_URL): Promise<void> {
  if (session) return;
  const model = await cachedModelBuffer(modelUrl);
  session = await ort.InferenceSession.create(model, { executionProviders: ['webgpu', 'wasm'], graphOptimizationLevel: 'all' });
}

function getContext(): OffscreenCanvasRenderingContext2D {
  if (!canvas) canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  if (!context) context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Unable to create depth preprocessing canvas.');
  return context;
}

function imageToTensor(image: ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement): Float32Array {
  const ctx = getContext();
  ctx.clearRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  if (image instanceof ImageData) {
    const source = new OffscreenCanvas(image.width, image.height);
    const sourceContext = source.getContext('2d');
    if (!sourceContext) throw new Error('Unable to create ImageData preprocessing canvas.');
    sourceContext.putImageData(image, 0, 0);
    ctx.drawImage(source, 0, 0, INPUT_SIZE, INPUT_SIZE);
  } else {
    ctx.drawImage(image, 0, 0, INPUT_SIZE, INPUT_SIZE);
  }
  const rgba = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  const input = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < plane; i += 1) {
    const r = rgba[i * 4] / 255;
    const g = rgba[i * 4 + 1] / 255;
    const b = rgba[i * 4 + 2] / 255;
    input[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    input[plane + i] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    input[plane * 2 + i] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }
  return input;
}

function coerceDepth(output: OrtTensor): Float32Array {
  const values = output.data instanceof Float32Array ? output.data : new Float32Array(output.data);
  if (values.length === INPUT_SIZE * INPUT_SIZE) return new Float32Array(values);
  const depth = new Float32Array(INPUT_SIZE * INPUT_SIZE);
  depth.set(values.subarray(0, depth.length));
  return depth;
}

async function estimate(frameId: number, image: ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement, tier: DepthTier = 'monocular-depth'): Promise<void> {
  const now = performance.now();
  const minimumIntervalMs = tier === 'degraded-depth' ? 100 : 33;
  if (busy || now - lastInferenceAt < minimumIntervalMs) {
    workerScope.postMessage(protocolMessage({ type: 'DEGRADED', payload: { frameId, reason: 'backpressure' } }));
    return;
  }
  busy = true;
  try {
    if (!session) await init();
    if (!session) throw new Error('Depth Anything v2 Small session was not initialized.');
    const input = imageToTensor(image);
    const inputName = session.inputNames[0] ?? 'input';
    const feeds = { [inputName]: new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]) };
    const outputs = await session.run(feeds);
    const output = outputs[session.outputNames[0]] ?? Object.values(outputs)[0];
    if (!output) throw new Error('Depth Anything v2 Small produced no output tensor.');
    const depth = coerceDepth(output);
    const elapsedMs = performance.now() - now;
    averageMs = averageMs === 0 ? elapsedMs : averageMs * 0.8 + elapsedMs * 0.2;
    lastInferenceAt = performance.now();
    const reportedTier: DepthTier = averageMs > 30 ? 'degraded-depth' : tier;
    workerScope.postMessage(protocolMessage({ type: 'RESULT', payload: { frameId, width: INPUT_SIZE, height: INPUT_SIZE, depth, tier: reportedTier, averageMs } }), [depth.buffer]);
  } finally {
    busy = false;
    if (image instanceof ImageBitmap) image.close();
  }
}

workerScope.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!validateDepthInbound(event.data)) {
    workerScope.postMessage(protocolMessage({ type: 'ERROR', payload: { message: 'Rejected invalid or incompatible worker protocol message' } }));
    return;
  }
  const message = event.data;
  if (message.type === 'INIT') {
    init(message.payload.modelUrl)
      .then(() => workerScope.postMessage(protocolMessage({ type: 'READY' })))
      .catch((error: unknown) => workerScope.postMessage(protocolMessage({ type: 'ERROR', payload: { message: error instanceof Error ? error.message : String(error) } })));
    return;
  }
  if (message.type === 'DESTROY') {
    session = null; canvas = null; context = null;
    workerScope.postMessage(protocolMessage({ type: 'DESTROYED' }));
    workerScope.close();
    return;
  }
  if (message.type !== 'DETECT') return;
  const { frameId, image, tier } = message.payload;
  estimate(frameId, image, tier)
    .catch((error: unknown) => workerScope.postMessage(protocolMessage({ type: 'ERROR', payload: { frameId, message: error instanceof Error ? error.message : String(error) } })));
});
// VERIFY: console.log('ONNX Runtime WebGPU uses Cache API model reuse with webgpu/wasm fallback')
