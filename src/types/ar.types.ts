/**
 * ar.types.ts
 * Shared types for the WebAR hand-tracking pipeline.
 */

// --------------------------------------------------------------------------
// Worker message protocol
// --------------------------------------------------------------------------

/** Messages sent FROM the main thread TO the worker */
export type WorkerInMessage =
  | { type: 'INIT' }
  | {
      type: 'DETECT';
      payload: {
        /** Transferable ArrayBuffer of RGBA pixel data from the video frame */
        buffer: ArrayBuffer;
        width: number;
        height: number;
        /** High-resolution timestamp from performance.now() */
        timestamp: number;
      };
    }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'DESTROY' };

/** Messages sent FROM the worker TO the main thread */
export type WorkerOutMessage =
  | { type: 'READY' }
  | {
      type: 'PROGRESS';
      payload: {
        /** 'wasm' = fetching WASM, 'model' = fetching task model */
        phase: 'wasm' | 'model';
        /** 0-100 */
        progress: number;
      };
    }
  | { type: 'RESULT'; payload: HandTrackingResult }
  | { type: 'ERROR'; payload: { message: string; state?: 'INIT' | 'READY' | 'PROCESS' | 'DESTROY' } }
  | { type: 'PAUSED' }
  | { type: 'DESTROYED' };

// --------------------------------------------------------------------------
// Hand tracking data
// --------------------------------------------------------------------------

/**
 * A single 3-D landmark point from MediaPipe.
 * x, y: normalised to [0, 1] in the RAW video frame (not mirrored).
 * z:    relative depth in "hand-width" units (negative = closer to camera).
 */
export interface NormalisedLandmark {
  /** Original MediaPipe hand-landmark index. Hand tracking emits the full 21-point MediaPipe hand topology. */
  index?: number;
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** Per-hand result with normalized structure */
export interface HandResult {
  /** Full 21-point MediaPipe hand topology for sizing, gestures, and placement. */
  landmarks: NormalisedLandmark[];
  /** Matching world-space landmark subset from MediaPipe, when available. */
  worldLandmarks: NormalisedLandmark[] | null;
  /** 'Left' | 'Right' as detected by MediaPipe (mirror-aware) */
  handedness: string;
  /** Detection confidence 0-1 from MediaPipe handedness category score. */
  confidence: number;
  /** Timestamp of the processed frame. */
  timestamp: number;
}

/** Full result returned by the worker for one video frame */
export interface HandTrackingResult {
  /** Array of detected hands (up to numHands configured) */
  hands: HandResult[];
  /** Whether any hand was detected */
  detected: boolean;
  /** Timestamp of the processed frame */
  frameTimestamp?: number;
}

// --------------------------------------------------------------------------
// Ring placement
// --------------------------------------------------------------------------

/** The processed, filtered ring placement data ready for Three.js */
export interface RingPlacement {
  /** World-space position (Three.js coords) */
  position: [number, number, number];
  /** World-space quaternion (x, y, z, w) */
  quaternion: [number, number, number, number];
  /** Uniform scale factor */
  scale: number;
  /** Whether placement data is valid / hand is detected */
  visible: boolean;
}

// --------------------------------------------------------------------------
// Loading state
// --------------------------------------------------------------------------

export interface LoadingState {
  /** MediaPipe WASM + task model loading progress, 0-100 */
  mediapipe: number;
  /** GLTF ring model loading progress, 0-100 */
  model: number;
  /** Camera permission granted */
  camera: boolean;
  /** Both AI and model are ready */
  ready: boolean;
  /** Non-null if a fatal error occurred */
  error: string | null;
}

// --------------------------------------------------------------------------
// Landmark index constants (MediaPipe Hand)
// --------------------------------------------------------------------------
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13,   // ← base knuckle  — ring sits here
  RING_PIP: 14,   // ← middle knuckle — direction reference
  RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
} as const;

// --------------------------------------------------------------------------
// Performance metrics (optional, for debugging/profiling)
// --------------------------------------------------------------------------

export interface TrackingMetrics {
  /** Total frames received */
  frameCount: number;
  /** Frames dropped due to backpressure or staleness */
  droppedFrames: number;
  /** Frames successfully processed */
  processedFrames: number;
  /** Last inference time in milliseconds */
  lastInferenceMs: number;
  /** Running average inference time */
  avgInferenceMs: number;
  /** Estimated inference FPS */
  inferenceFps: number;
}
