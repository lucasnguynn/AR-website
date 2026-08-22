import assert from 'node:assert/strict';
import { CameraSystem } from '../src/services/cameraSystem';

function fakeStream(facingMode: 'user' | 'environment' = 'user') {
  let stopped = 0;
  const track = {
    kind: 'video',
    readyState: 'live',
    stop() { stopped += 1; this.readyState = 'ended'; },
    getSettings() { return { width: 1280, height: 720, facingMode, deviceId: `fake-${facingMode}` }; },
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
  return { stream: stream as unknown as MediaStream, track, stopped: () => stopped };
}

function fakeVideo() {
  return {
    srcObject: null,
    playsInline: false,
    muted: false,
    readyState: 1,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 640,
    clientHeight: 360,
    play: async () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLVideoElement;
}

export async function runCameraSystemTests(): Promise<void> {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const htmlMediaDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLMediaElement');

  try {
    Object.defineProperty(globalThis, 'HTMLMediaElement', { configurable: true, value: { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 } });

    let getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream> = async () => {
      throw new DOMException('denied', 'NotAllowedError');
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: (constraints: MediaStreamConstraints) => getUserMedia(constraints) } },
    });

    const video = fakeVideo();
    const camera = new CameraSystem({}, 0);
    await assert.rejects(() => camera.start(video, 'user'), /Camera permission denied/);
    assert.equal(camera.getState().status, 'ERROR', 'failed acquisition must not be reported READY');
    assert.equal(camera.getState().stream, null);

    const recovered = fakeStream('user');
    getUserMedia = async () => recovered.stream;
    await camera.recover();
    assert.equal(camera.getState().status, 'READY', 'recover() can restart after an initial failure with no stream');
    assert.equal(camera.getState().metadata?.facingMode, 'user');

    const restored = fakeStream('user');
    let switchCall = 0;
    getUserMedia = async () => {
      switchCall += 1;
      if (switchCall === 1) throw new DOMException('rear camera unavailable', 'NotAllowedError');
      return restored.stream;
    };
    await camera.switchCamera('environment');
    assert.equal(camera.getState().status, 'READY', 'failed switch restores a usable previous camera before READY');
    assert.equal(camera.getState().facingMode, 'user');

    camera.stop();

    let resolvePending!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => { resolvePending = resolve; });
    const stale = fakeStream('user');
    getUserMedia = async () => pending;
    const pendingStart = camera.start(video, 'user');
    camera.stop();
    resolvePending(stale.stream);
    await pendingStart;
    assert.ok(stale.stopped() > 0, 'a stale getUserMedia result is stopped instead of leaking the camera indicator');
    assert.equal(camera.getState().stream, null);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
    if (htmlMediaDescriptor) Object.defineProperty(globalThis, 'HTMLMediaElement', htmlMediaDescriptor);
    else delete (globalThis as { HTMLMediaElement?: unknown }).HTMLMediaElement;
  }
}
