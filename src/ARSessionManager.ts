/**
 * ARSessionManager.ts
 * 
 * Orchestrator class that manages the complete AR session lifecycle.
 * Implements decoupled tracking and rendering loops, MediaPipe Web Worker integration,
 * state management, and zero-upload privacy architecture.
 * 
 * @module ARSessionManager
 */

import { RingPoseEstimator, HandTrackingResult, RingPose } from './RingPoseEstimator';
import { ARScene } from './ARScene';
import { useARStore } from './store/useARStore';

/**
 * AR Session State Enum
 */
export enum ARSessionState {
  /** Initial state before any setup */
  IDLE = 'IDLE',
  /** Initializing camera and MediaPipe */
  INITIALIZING = 'INITIALIZING',
  /** Camera ready, waiting for hand detection */
  CAMERA_READY = 'CAMERA_READY',
  /** Hand detected, tracking active */
  TRACKING_ACTIVE = 'TRACKING_ACTIVE',
  /** Hand lost, maintaining last known pose */
  TRACKING_LOST = 'TRACKING_LOST',
  /** Error occurred */
  ERROR = 'ERROR',
  /** Session stopped */
  STOPPED = 'STOPPED',
}

/**
 * Session configuration
 */
export interface ARSessionConfig {
  /** Path to MediaPipe Hand Landmarker WASM files */
  mediaPipeWasmPath: string;
  /** Path to the ring model GLB file */
  ringModelUrl: string;
  /** Initial ring scale */
  ringScale: number;
  /** Target FPS for tracking loop (10-30 recommended) */
  trackingFPS: number;
  /** Minimum confidence for hand detection */
  minDetectionConfidence: number;
  /** Minimum confidence for landmark tracking */
  minTrackingConfidence: number;
  /** Video constraints for getUserMedia */
  videoConstraints: MediaStreamConstraints['video'];
}

/**
 * Default session configuration
 */
const DEFAULT_CONFIG: ARSessionConfig = {
  mediaPipeWasmPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  ringModelUrl: '/models/ring.glb',
  ringScale: 1.0,
  trackingFPS: 20,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
  videoConstraints: {
    facingMode: 'environment',
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

/**
 * Callback types for session events
 */
export type SessionStateCallback = (state: ARSessionState, error?: string) => void;
export type PoseUpdateCallback = (pose: RingPose | null) => void;

/**
 * Message types for Web Worker communication
 */
interface WorkerInitMessage {
  type: 'INIT';
  wasmPath: string;
  minDetectionConfidence: number;
  minTrackingConfidence: number;
}

interface WorkerProcessMessage {
  type: 'PROCESS';
  imageData: ImageData;
  timestamp: number;
}

interface WorkerStopMessage {
  type: 'STOP';
}

/**
 * Response types from Web Worker
 */
interface WorkerReadyResponse {
  type: 'READY';
}

interface WorkerHandResultResponse {
  type: 'HAND_RESULT';
  result: HandTrackingResult | null;
  timestamp: number;
}

interface WorkerErrorResponse {
  type: 'ERROR';
  error: string;
}

type WorkerResponse = WorkerReadyResponse | WorkerHandResultResponse | WorkerErrorResponse;

/**
 * Inline Web Worker code for MediaPipe processing
 * This keeps all processing local (zero-upload architecture)
 */
const createWorkerBlob = (): Blob => {
  const workerCode = `
    let handLandmarker = null;
    let minDetectionConfidence = 0.5;
    let minTrackingConfidence = 0.5;

    self.onmessage = async (event) => {
      const { type } = event.data;

      if (type === 'INIT') {
        try {
          const { wasmPath, minDetectionConfidence: detConf, minTrackingConfidence: trackConf } = event.data;
          minDetectionConfidence = detConf;
          minTrackingConfidence = trackConf;

          // Import MediaPipe Tasks Vision
          // @fix BUG-04: Updated version from 0.10.3 to 0.10.14 to match package.json
          const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm');
          
          // Initialize Hand Landmarker
          const filesetResolver = await vision.FilesetResolver.forVisionTasks(wasmPath);
          handLandmarker = await vision.HandLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
              // @fix BUG-04: Use direct CDN URL for hand_landmarker.task instead of wasmPath + '/hand_landmarker.task'
              modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
              delegate: 'GPU',
            },
            runningMode: 'VIDEO',
            numHands: 1,
            minHandDetectionConfidence: minDetectionConfidence,
            minHandPresenceConfidence: minTrackingConfidence,
            minTrackingConfidence: minTrackingConfidence,
          });

          self.postMessage({ type: 'READY' });
        } catch (error) {
          self.postMessage({ type: 'ERROR', error: error.message });
        }
      } else if (type === 'PROCESS') {
        if (!handLandmarker) {
          self.postMessage({ type: 'ERROR', error: 'Hand landmarker not initialized' });
          return;
        }

        try {
          const { imageData, timestamp } = event.data;
          
          // Detect landmarks
          const results = handLandmarker.detectForVideo(imageData, timestamp);
          
          if (results.landmarks && results.landmarks.length > 0) {
            // Extract first hand's landmarks
            const landmarks = results.landmarks[0].map((lm) => ({
              x: lm.x,
              y: lm.y,
              z: lm.z,
              visibility: lm.visibility,
              confidence: undefined, // MediaPipe doesn't provide per-landmark confidence in this version
            }));

            const handedness = results.handednesses?.[0]?.[0]?.categoryName === 'Left' ? 'Left' : 'Right';
            const confidence = results.handednesses?.[0]?.[0]?.score ?? 1.0;

            self.postMessage({
              type: 'HAND_RESULT',
              result: {
                landmarks,
                handedness,
                confidence,
              },
              timestamp,
            });
          } else {
            self.postMessage({
              type: 'HAND_RESULT',
              result: null,
              timestamp,
            });
          }

          // IMPORTANT: Clear results to free memory (zero-upload privacy)
          results.landmarks = null;
          results.handednesses = null;
        } catch (error) {
          self.postMessage({ type: 'ERROR', error: error.message });
        }
      } else if (type === 'STOP') {
        // Cleanup
        if (handLandmarker) {
          handLandmarker.close();
          handLandmarker = null;
        }
      }
    };
  `;

  return new Blob([workerCode], { type: 'application/javascript' });
};

/**
 * AR Session Manager
 * 
 * Main orchestrator for the Virtual Ring Try-On experience:
 * - Manages camera stream lifecycle
 * - Spawns MediaPipe Web Worker for non-blocking CV
 * - Runs decoupled tracking (async) and rendering (requestAnimationFrame) loops
 * - Handles state transitions and error recovery
 * - Ensures zero-upload privacy by processing everything locally
 */
export class ARSessionManager {
  private config: ARSessionConfig;
  private scene: ARScene | null = null;
  private poseEstimator: RingPoseEstimator | null = null;
  
  // Media
  private videoElement: HTMLVideoElement | null = null;
  private mediaStream: MediaStream | null = null;
  private worker: Worker | null = null;
  
  // State
  private state: ARSessionState = ARSessionState.IDLE;
  private lastPose: RingPose | null = null;
  private isTracking: boolean = false;
  private isRendering: boolean = false;
  
  // Loop control
  private animationFrameId: number | null = null;
  
  // Callbacks
  public onStateChange: SessionStateCallback | null = null;
  private onPoseUpdate: PoseUpdateCallback | null = null;
  public onError: ((error: Error) => void) | null = null;

  constructor(config: Partial<ARSessionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set state change callback
   */
  setStateCallback(callback: SessionStateCallback): void {
    this.onStateChange = callback;
  }

  /**
   * Set error callback
   */
  setErrorCallback(callback: (error: Error) => void): void {
    this.onError = callback;
  }

  /**
   * Set pose update callback
   */
  setPoseCallback(callback: PoseUpdateCallback): void {
    this.onPoseUpdate = callback;
  }

  /**
   * Get current session state
   */
  getState(): ARSessionState {
    return this.state;
  }

  /**
   * Update internal state and notify callback
   */
  private setState(newState: ARSessionState, error?: string): void {
    this.state = newState;
    if (this.onStateChange) {
      this.onStateChange(newState, error);
    }
  }

  /**
   * Initialize the AR session
   * Sets up camera, worker, and scene
   */
  async initialize(containerElement: HTMLElement): Promise<void> {
    try {
      this.setState(ARSessionState.INITIALIZING);

      // Create video element
      this.videoElement = document.createElement('video');
      this.videoElement.setAttribute('playsinline', 'true');
      this.videoElement.setAttribute('muted', 'true');
      this.videoElement.style.display = 'none';

      // Setup camera
      await this.setupCamera();

      // Initialize scene
      const rect = containerElement.getBoundingClientRect();
      this.scene = new ARScene({
        width: rect.width,
        height: rect.height,
      });
      this.scene.setVideoElement(this.videoElement);

      // Append canvas to container
      containerElement.appendChild(this.scene.getDomElement());

      // Initialize pose estimator
      this.poseEstimator = new RingPoseEstimator();

      // Setup Web Worker
      await this.setupWorker();

      // Load ring model with progress callback
      const setModelLoadingProgress = useARStore.getState().setModelLoadingProgress;
      await this.scene.loadRing(
        this.config.ringModelUrl,
        this.config.ringScale,
        (progress: number) => {
          setModelLoadingProgress(progress);
        }
      );

      this.setState(ARSessionState.CAMERA_READY);

    } catch (error) {
      console.error('AR Session initialization failed:', error);
      this.setState(ARSessionState.ERROR, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Setup camera stream using getUserMedia
   */
  private async setupCamera(): Promise<void> {
    if (!this.videoElement) {
      throw new Error('Video element not created');
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: this.config.videoConstraints,
      });

      this.videoElement.srcObject = this.mediaStream;
      
      return new Promise((resolve, reject) => {
        this.videoElement!.onloadedmetadata = () => {
          this.videoElement!.play().then(resolve).catch(reject);
        };
        this.videoElement!.onerror = () => reject(new Error('Video loading failed'));
      });
    } catch (error) {
      throw new Error(`Camera access denied: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Setup MediaPipe Web Worker for non-blocking CV processing
   */
  private async setupWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      const blob = createWorkerBlob();
      const workerUrl = URL.createObjectURL(blob);
      this.worker = new Worker(workerUrl);
      // Revoke immediately after worker is created — the worker holds its own reference
      URL.revokeObjectURL(workerUrl)

      // @fix BUG-04: Store timeoutId so we can clear it when READY fires
      let timeoutId: ReturnType<typeof setTimeout>;

      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const { type } = event.data;

        if (type === 'READY') {
          // @fix BUG-04: Clear timeout to prevent reject() on already-resolved Promise
          clearTimeout(timeoutId);
          resolve();
        } else if (type === 'HAND_RESULT') {
          this.handleHandResult(event.data.result, event.data.timestamp);
        } else if (type === 'ERROR') {
          console.error('Worker error:', event.data.error);
        }
      };

      this.worker.onerror = (error) => {
        console.error('Worker error:', error);
        reject(error);
      };

      // Initialize worker
      this.worker.postMessage({
        type: 'INIT',
        wasmPath: this.config.mediaPipeWasmPath,
        minDetectionConfidence: this.config.minDetectionConfidence,
        minTrackingConfidence: this.config.minTrackingConfidence,
      } as WorkerInitMessage);

      // Timeout for worker initialization
      timeoutId = setTimeout(() => {
        reject(new Error('Worker initialization timeout'));
      }, 10000);
    });
  }

  /**
   * Handle hand tracking result from worker
   */
  private handleHandResult(result: HandTrackingResult | null, timestamp: number): void {
    if (!this.poseEstimator || !this.scene) {
      return;
    }

    if (result && result.landmarks) {
      // Estimate 3D pose
      const pose = this.poseEstimator.estimatePose(result, this.scene.camera, timestamp);

      if (pose) {
        this.lastPose = pose;
        this.isTracking = true;
        
        if (this.state !== ARSessionState.TRACKING_ACTIVE) {
          this.setState(ARSessionState.TRACKING_ACTIVE);
        }

        // Notify pose update
        if (this.onPoseUpdate) {
          this.onPoseUpdate(pose);
        }
      } else {
        this.isTracking = false;
        if (this.state === ARSessionState.TRACKING_ACTIVE) {
          this.setState(ARSessionState.TRACKING_LOST);
        }
      }
    } else {
      this.isTracking = false;
      if (this.state === ARSessionState.TRACKING_ACTIVE) {
        this.setState(ARSessionState.TRACKING_LOST);
      }
    }
  }

  /**
   * Start the tracking loop using requestVideoFrameCallback
   * This ensures MediaPipe only processes when a new physical frame is available,
   * eliminating CPU waste from setTimeout-based polling.
   * @fix BUG-09: Add graceful fallback to setInterval for Firefox which doesn't support requestVideoFrameCallback
   */
  private startTrackingLoop(): void {
    const processFrame = async () => {
      if (!this.isTracking || !this.worker || !this.videoElement) {
        return;
      }

      try {
        // Create offscreen canvas for frame extraction
        const canvas = document.createElement('canvas');
        canvas.width = this.videoElement.videoWidth;
        canvas.height = this.videoElement.videoHeight;
        const ctx = canvas.getContext('2d');

        if (!ctx) {
          throw new Error('Could not get 2D context');
        }

        // Draw current video frame
        ctx.drawImage(this.videoElement, 0, 0, canvas.width, canvas.height);
        
        // Get image data for worker
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const timestamp = performance.now();

        // Send to worker for processing
        this.worker.postMessage({
          type: 'PROCESS',
          imageData,
          timestamp,
        } as WorkerProcessMessage, [imageData.data.buffer]);

      } catch (error) {
        console.error('Frame processing error:', error);
      }

      // Re-register callback for next frame only if still tracking
      if (this.isTracking && this.videoElement) {
        if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
          this.videoElement.requestVideoFrameCallback(processFrame);
        }
        // setTimeout fallback handled below
      }
    };

    this.isTracking = true;

    // @fix BUG-09: Firefox doesn't support requestVideoFrameCallback, use setInterval fallback
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this.videoElement?.requestVideoFrameCallback(processFrame);
    } else {
      // Firefox fallback: poll at configured trackingFPS
      const intervalMs = 1000 / this.config.trackingFPS;
      const intervalId = setInterval(() => {
        if (!this.isTracking) {
          clearInterval(intervalId);
          return;
        }
        processFrame();
      }, intervalMs);
    }
  }

  /**
   * Start the rendering loop (requestAnimationFrame, 60 FPS)
   */
  private startRenderLoop(): void {
    const render = () => {
      if (!this.isRendering || !this.scene) {
        return;
      }

      // Update ring pose if available
      if (this.lastPose) {
        this.scene.updatePose(this.lastPose);
      }

      // Render scene
      this.scene.render();

      this.animationFrameId = requestAnimationFrame(render);
    };

    this.isRendering = true;
    render();
  }

  /**
   * Start the AR session
   * Begins both tracking and rendering loops
   * 
   * @param video - The video element for camera feed
   * @param canvas - The canvas element for Three.js rendering
   * @deprecated Use initialize() followed by startLoops() instead
   */
  start(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
    if (this.state !== ARSessionState.CAMERA_READY && this.state !== ARSessionState.TRACKING_LOST) {
      console.warn('Cannot start session in current state:', this.state);
      return;
    }

    // Set video element in scene
    if (this.scene) {
      this.scene.setVideoElement(video);
    }

    // Setup renderer canvas
    if (this.scene) {
      const container = canvas.parentElement;
      if (container) {
        container.appendChild(this.scene.getDomElement());
        
        // Initial resize with object-cover compensation
        const rect = container.getBoundingClientRect();
        this.scene.resize(rect.width, rect.height, video.videoWidth, video.videoHeight);
      }
    }

    this.startTrackingLoop();
    this.startRenderLoop();
  }

  /**
   * Start the tracking and render loops after initialize() has been called.
   * This is the preferred method for starting the AR session after calling initialize().
   * @fix NEW-02: New method to support the correct architecture where initialize() sets up
   * the camera stream and Three.js canvas internally, then startLoops() begins the cycles.
   */
  public startLoops(): void {
    if (this.state !== ARSessionState.CAMERA_READY &&
        this.state !== ARSessionState.TRACKING_LOST) {
      console.warn('Cannot start loops in current state:', this.state);
      return;
    }
    this.startTrackingLoop();
    this.startRenderLoop();
  }

  /**
   * Resize the AR scene to match new container dimensions.
   * @fix NEW-02: Public method to allow ARVideoCanvas to resize without accessing private scene property.
   */
  public resize(width: number, height: number): void {
    if (!this.videoElement || !this.scene) return;
    this.scene.resize(width, height, this.videoElement.videoWidth, this.videoElement.videoHeight);
  }

  /**
   * Stop the AR session
   * Halts all loops but preserves resources
   */
  stop(): void {
    this.isTracking = false;
    this.isRendering = false;

    // Cancel animation frame
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    this.setState(ARSessionState.STOPPED);
  }

  /**
   * Dispose all resources and cleanup
   * Must be called when component unmounts or session ends
   */
  dispose(): void {
    // Stop session
    this.stop();

    // Terminate worker
    if (this.worker) {
      this.worker.postMessage({ type: 'STOP' } as WorkerStopMessage);
      this.worker.terminate();
      this.worker = null;
    }

    // Stop media stream
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    // Cleanup video element
    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement.remove();
      this.videoElement = null;
    }

    // Dispose scene
    if (this.scene) {
      this.scene.dispose();
      this.scene = null;
    }

    // Dispose pose estimator
    if (this.poseEstimator) {
      this.poseEstimator.dispose();
      this.poseEstimator = null;
    }

    // Reset state
    this.lastPose = null;
    this.setState(ARSessionState.IDLE);
  }

  /**
   * Get current pose (for debugging or external use)
   */
  getCurrentPose(): RingPose | null {
    return this.lastPose;
  }

  /**
   * Check if session is actively tracking a hand
   */
  isActivelyTracking(): boolean {
    return this.isTracking && this.state === ARSessionState.TRACKING_ACTIVE;
  }

  /**
   * Take a snapshot of the current AR frame
   * Composites the video feed and Three.js canvas onto an in-memory 2D canvas
   * 
   * @returns Base64 PNG data URL, or null if not ready
   */
  takeSnapshot(): string | null {
    if (!this.videoElement || !this.scene) {
      return null;
    }

    const scene = this.scene as unknown as { renderer: import('three').WebGLRenderer };
    const renderer = scene.renderer;
    
    // Get dimensions from video
    const videoWidth = this.videoElement.videoWidth;
    const videoHeight = this.videoElement.videoHeight;
    
    if (videoWidth === 0 || videoHeight === 0) {
      return null;
    }

    // Create an in-memory canvas for compositing
    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = videoWidth;
    compositeCanvas.height = videoHeight;
    const ctx = compositeCanvas.getContext('2d');
    
    if (!ctx) {
      return null;
    }

    // Draw the current video frame
    ctx.drawImage(this.videoElement, 0, 0, videoWidth, videoHeight);

    // Draw the Three.js canvas on top
    // First, force a render to ensure we have the latest frame
    this.scene.render();
    
    const threeCanvas = renderer.domElement;
    ctx.drawImage(threeCanvas, 0, 0, videoWidth, videoHeight);

    // Return as base64 PNG data URL
    return compositeCanvas.toDataURL('image/png');
  }
}

export default ARSessionManager;
