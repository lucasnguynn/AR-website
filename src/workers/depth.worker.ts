import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgpu';
import { loadGraphModel } from '@tensorflow/tfjs-converter';

const workerScope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; addEventListener(type: string, listener: (event: MessageEvent<RequestMessage>) => void): void; };

type RequestMessage =
  | { type: 'init'; modelUrl?: string }
  | { type: 'estimate'; frameId: number; image: ImageBitmap | ImageData | OffscreenCanvas | HTMLCanvasElement };

type ResponseMessage =
  | { type: 'ready' }
  | { type: 'depth'; frameId: number; width: number; height: number; depth: Float32Array }
  | { type: 'skipped'; frameId: number }
  | { type: 'error'; frameId?: number; message: string };

let model: { predict(input: unknown): unknown } | null = null;
let frameCounter = 0;
const INPUT_SIZE = 256;

async function init(modelUrl = '/models/depth/model.json'): Promise<void> {
  if (model) return;
  await tf.setBackend('webgpu');
  await tf.ready();
  model = await loadGraphModel(modelUrl);
}

async function estimate(frameId: number, image: RequestMessage extends infer T ? T extends { image: infer I } ? I : never : never): Promise<void> {
  frameCounter += 1;
  if (frameCounter % 3 !== 1) {
    workerScope.postMessage({ type: 'skipped', frameId } satisfies ResponseMessage);
    return;
  }
  if (!model) await init();
  if (!model) throw new Error('MiDaS depth model was not initialized.');

  const output = tf.tidy(() => {
    const pixels = tf.browser.fromPixels(image as ImageData | ImageBitmap | HTMLCanvasElement | OffscreenCanvas);
    const resized = tf.image.resizeBilinear(pixels, [INPUT_SIZE, INPUT_SIZE], true);
    const normalized = resized.toFloat().div(255).sub(0.5).mul(2).expandDims(0);
    const prediction = model!.predict(normalized) as { squeeze(): { reshape(shape: number[]): { clone(): { data(): Promise<Float32Array | number[]>; dispose(): void } } } } | Array<{ squeeze(): { reshape(shape: number[]): { clone(): { data(): Promise<Float32Array | number[]>; dispose(): void } } } }>;
    const tensor = Array.isArray(prediction) ? prediction[0] : prediction;
    return tensor.squeeze().reshape([INPUT_SIZE, INPUT_SIZE]).clone();
  });

  const data = new Float32Array(await output.data());
  output.dispose();
  workerScope.postMessage({ type: 'depth', frameId, width: INPUT_SIZE, height: INPUT_SIZE, depth: data } satisfies ResponseMessage, [data.buffer]);
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
