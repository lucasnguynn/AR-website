type WorkerGlobal = typeof self & {
  caches?: CacheStorage;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<RequestMessage>) => void): void;
};

type OrtTensor = { data: Float32Array | number[]; dims: readonly number[] };
type OrtSession = { inputNames: readonly string[]; outputNames: readonly string[]; run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>> };
type OrtModule = { Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => unknown; InferenceSession: { create(model: string | ArrayBuffer, options: { executionProviders: readonly string[] }) : Promise<OrtSession> } };

type RequestMessage =
  | { type: 'init'; modelUrl?: string }
  | { type: 'estimate'; frameId: number; image: ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement };

type ResponseMessage =
  | { type: 'ready' }
  | { type: 'depth'; frameId: number; width: number; height: number; depth: Float32Array }
  | { type: 'skipped'; frameId: number }
  | { type: 'error'; frameId?: number; message: string };

const workerScope = self as WorkerGlobal;
const INPUT_SIZE = 518;
const MODEL_CACHE = 'ar-depth-anything-v2-small-v1';
const DEFAULT_MODEL_URL = '/models/depth/depth_anything_v2_small.onnx';
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

let ort: OrtModule | null = null;
let session: OrtSession | null = null;
let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let busy = false;
let frameCounter = 0;

async function importOnnxRuntimeWebGpu(): Promise<OrtModule> {
  if (ort) return ort;
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<OrtModule>;
  const packageName = 'onnxruntime-web';
  const backendPath = 'webgpu';
  ort = await dynamicImport(`${packageName}/${backendPath}`);
  return ort;
}

async function cachedModelBuffer(modelUrl: string): Promise<ArrayBuffer> {
  const request = new Request(modelUrl, { credentials: 'same-origin' });
  if (!workerScope.caches) return fetch(request).then((response) => response.arrayBuffer());

  const cache = await workerScope.caches.open(MODEL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached.arrayBuffer();

  const response = await fetch(request);
  if (!response.ok) throw new Error(`Failed to fetch depth model: ${response.status} ${response.statusText}`);
  await cache.put(request, response.clone());
  return response.arrayBuffer();
}

async function init(modelUrl = DEFAULT_MODEL_URL): Promise<void> {
  if (session) return;
  if (!('gpu' in navigator)) throw new Error('WebGPU is not available for ONNX Runtime Web depth inference.');
  const runtime = await importOnnxRuntimeWebGpu();
  const model = await cachedModelBuffer(modelUrl);
  session = await runtime.InferenceSession.create(model, { executionProviders: ['webgpu'] });
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
  ctx.drawImage(image as CanvasImageSource, 0, 0, INPUT_SIZE, INPUT_SIZE);
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

async function estimate(frameId: number, image: ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement): Promise<void> {
  frameCounter += 1;
  if (busy || frameCounter % 3 !== 1) {
    workerScope.postMessage({ type: 'skipped', frameId } satisfies ResponseMessage);
    return;
  }
  busy = true;
  try {
    if (!session) await init();
    if (!session || !ort) throw new Error('Depth Anything v2 Small session was not initialized.');
    const input = imageToTensor(image);
    const inputName = session.inputNames[0] ?? 'input';
    const feeds = { [inputName]: new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]) };
    const outputs = await session.run(feeds);
    const output = outputs[session.outputNames[0]] ?? Object.values(outputs)[0];
    if (!output) throw new Error('Depth Anything v2 Small produced no output tensor.');
    const depth = coerceDepth(output);
    workerScope.postMessage({ type: 'depth', frameId, width: INPUT_SIZE, height: INPUT_SIZE, depth } satisfies ResponseMessage, [depth.buffer]);
  } finally {
    busy = false;
    if (image instanceof ImageBitmap) image.close();
  }
}

workerScope.addEventListener('message', (event: MessageEvent<RequestMessage>) => {
  const message = event.data;
  if (message.type === 'init') {
    init(message.modelUrl)
      .then(() => workerScope.postMessage({ type: 'ready' } satisfies ResponseMessage))
      .catch((error: unknown) => workerScope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies ResponseMessage));
    return;
  }

  estimate(message.frameId, message.image)
    .catch((error: unknown) => workerScope.postMessage({ type: 'error', frameId: message.frameId, message: error instanceof Error ? error.message : String(error) } satisfies ResponseMessage));
});
