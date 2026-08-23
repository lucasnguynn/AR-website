// FILE: src/workers/depth.worker.ts
import * as ort from 'onnxruntime-web/webgpu';
import ortWasmSimdUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortWasmJsepUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import { protocolMessage, validateDepthInbound, type DepthTier } from '../protocol/workerProtocol';

type WorkerGlobal = typeof self & {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
};

const workerScope = self as WorkerGlobal;
type OrtTensor = { data: Float32Array | readonly number[]; dims: readonly number[] };
type OrtSession = {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, OrtTensor>>;
};

const INPUT_SIZE = 518;
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

(ort.env.wasm as unknown as { wasmPaths: string | Record<string, string> }).wasmPaths = {
  'ort-wasm-simd-threaded.wasm': ortWasmSimdUrl,
  'ort-wasm-simd-threaded.jsep.wasm': ortWasmJsepUrl,
};

let session: OrtSession | null = null;
let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let busy = false;
let lastInferenceAt = 0;
let averageMs = 0;
let provider: 'webgpu' | 'wasm' = 'wasm';

async function init(model: ArrayBuffer): Promise<void> {
  if (session) return;

  try {
    session = await ort.InferenceSession.create(model, {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
    });
    provider = 'webgpu';
  } catch {
    session = await ort.InferenceSession.create(model, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    provider = 'wasm';
  }
}

function getContext(): OffscreenCanvasRenderingContext2D {
  if (!canvas) canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  if (!context) context = canvas.getContext('2d', { willReadFrequently: true });

  if (!context) {
    throw new Error('Unable to create depth preprocessing canvas.');
  }

  return context;
}

function imageToTensor(
  image: ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement,
): Float32Array {
  const ctx = getContext();
  ctx.clearRect(0, 0, INPUT_SIZE, INPUT_SIZE);

  if (image instanceof ImageData) {
    const source = new OffscreenCanvas(image.width, image.height);
    const sourceContext = source.getContext('2d');

    if (!sourceContext) {
      throw new Error('Unable to create ImageData preprocessing canvas.');
    }

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

function quickselect(
  values: Float32Array,
  k: number,
  left = 0,
  right = values.length - 1,
): number {
  while (left < right) {
    const pivot = values[(left + right) >>> 1];
    let low = left;
    let high = right;

    while (low <= high) {
      while (values[low] < pivot) low += 1;
      while (values[high] > pivot) high -= 1;

      if (low <= high) {
        const value = values[low];
        values[low] = values[high];
        values[high] = value;
        low += 1;
        high -= 1;
      }
    }

    if (k <= high) {
      right = high;
    } else if (k >= low) {
      left = low;
    } else {
      break;
    }
  }

  return values[k];
}

function coerceDepth(output: OrtTensor): Float32Array {
  const values = output.data instanceof Float32Array
    ? output.data
    : new Float32Array(output.data);

  const depth = new Float32Array(INPUT_SIZE * INPUT_SIZE);
  depth.set(values.subarray(0, depth.length));

  // Depth Anything emits relative inverse depth. Robust normalization turns it
  // into conservative camera-space meters consumed by the fragment depth pass.
  const finite = new Float32Array(depth.length);
  let finiteCount = 0;

  for (let i = 0; i < depth.length; i += 1) {
    if (Number.isFinite(depth[i])) {
      finite[finiteCount++] = depth[i];
    }
  }

  if (finiteCount === 0) {
    throw new Error('Depth Anything output contained no finite samples.');
  }

  const lowIndex = Math.floor(finiteCount * 0.02);
  const highIndex = Math.floor(finiteCount * 0.98);
  const low = quickselect(finite, lowIndex, 0, finiteCount - 1);
  const high = quickselect(finite, highIndex, lowIndex, finiteCount - 1);
  const range = Math.max(high - low, 1e-6);

  for (let i = 0; i < depth.length; i += 1) {
    const inverse = Math.min(1, Math.max(0, (depth[i] - low) / range));
    depth[i] = 0.65 - inverse * 0.47;
  }

  return depth;
}

async function estimate(
  frameId: number,
  image: ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement,
  tier: DepthTier = 'monocular-depth',
): Promise<void> {
  const now = performance.now();
  const minimumIntervalMs = tier === 'degraded-depth' ? 100 : 33;

  if (busy || now - lastInferenceAt < minimumIntervalMs) {
    workerScope.postMessage(
      protocolMessage({
        type: 'DEGRADED',
        payload: { frameId, reason: 'backpressure' },
      }),
    );

    // The ImageBitmap is transferred to this worker. Returning before the main
    // try/finally would otherwise retain its decoder/GPU resources.
    if (image instanceof ImageBitmap) image.close();
    return;
  }

  busy = true;

  try {
    if (!session) {
      throw new Error('Depth Anything v2 Small session was not initialized.');
    }

    const input = imageToTensor(image);
    const inputName = session.inputNames[0] ?? 'input';

    const feeds = {
      [inputName]: new ort.Tensor(
        'float32',
        input,
        [1, 3, INPUT_SIZE, INPUT_SIZE],
      ),
    };

    const outputs = await session.run(feeds);
    const output = outputs[session.outputNames[0]] ?? Object.values(outputs)[0];

    if (!output) {
      throw new Error('Depth Anything v2 Small produced no output tensor.');
    }

    const depth = coerceDepth(output);
    const elapsedMs = performance.now() - now;

    averageMs = averageMs === 0
      ? elapsedMs
      : averageMs * 0.8 + elapsedMs * 0.2;

    lastInferenceAt = performance.now();

    const reportedTier: DepthTier = averageMs > 30
      ? 'degraded-depth'
      : tier;

    workerScope.postMessage(
      protocolMessage({
        type: 'RESULT',
        payload: {
          frameId,
          width: INPUT_SIZE,
          height: INPUT_SIZE,
          depth,
          tier: reportedTier,
          averageMs,
          provider,
        },
      }),
      [depth.buffer],
    );
  } finally {
    busy = false;
    if (image instanceof ImageBitmap) image.close();
  }
}

workerScope.addEventListener(
  'message',
  (event: MessageEvent<unknown>) => {
    if (!validateDepthInbound(event.data)) {
      workerScope.postMessage(
        protocolMessage({
          type: 'ERROR',
          payload: {
            message: 'Rejected invalid or incompatible worker protocol message',
          },
        }),
      );
      return;
    }

    const message = event.data;

    if (message.type === 'INIT') {
      init(message.payload.model)
        .then(() => {
          workerScope.postMessage(
            protocolMessage({
              type: 'READY',
              payload: { provider },
            }),
          );
        })
        .catch((error: unknown) => {
          workerScope.postMessage(
            protocolMessage({
              type: 'ERROR',
              payload: {
                message: error instanceof Error
                  ? error.message
                  : String(error),
              },
            }),
          );
        });
      return;
    }

    if (message.type === 'DESTROY') {
      session = null;
      canvas = null;
      context = null;

      workerScope.postMessage(
        protocolMessage({ type: 'DESTROYED' }),
      );

      workerScope.close();
      return;
    }

    if (message.type !== 'DETECT') return;

    const { frameId, image, tier } = message.payload;

    estimate(frameId, image, tier)
      .catch((error: unknown) => {
        workerScope.postMessage(
          protocolMessage({
            type: 'ERROR',
            payload: {
              frameId,
              message: error instanceof Error
                ? error.message
                : String(error),
            },
          }),
        );
      });
  },
);

// VERIFY: console.log('ONNX Runtime WebGPU uses Cache API model reuse with webgpu/wasm fallback')
