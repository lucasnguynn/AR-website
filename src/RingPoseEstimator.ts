/**
 * RingPoseEstimator.ts
 * 
 * Core 3D math module for estimating ring pose from MediaPipe hand landmarks.
 * Implements coordinate mapping, quaternion rotation calculation, and temporal smoothing.
 * 
 * This module executes the precise mathematical pipeline required for accurate
 * ring placement on the user's finger in AR space.
 * 
 * @module RingPoseEstimator
 */

import * as THREE from 'three';
import { Vector3OneEuroFilter, RotationOneEuroFilter, OneEuroFilterConfig } from './TrackingSmoother';

/**
 * MediaPipe Hand Landmark indices for ring finger tracking
 */
export const RingFingerLandmarks = {
  MCP: 13, // Metacarpophalangeal joint (base of ring finger)
  PIP: 14, // Proximal Interphalangeal joint (first knuckle)
  DIP: 15, // Distal Interphalangeal joint (second knuckle)
  TIP: 16, // Fingertip
} as const;

/**
 * Reference landmarks for calculating hand orientation
 */
export const OrientationLandmarks = {
  IndexMCP: 5,
  PinkyMCP: 17,
} as const;

/**
 * Metadata for ring AR configuration
 */
export interface RingARMetadata {
  /** Position along the finger where the ring anchor is placed (0.0 = MCP, 1.0 = PIP) */
  anchorPosition: number;
  /** Additional rotation offset to apply to the ring (in radians) */
  rotationOffset: THREE.Euler;
  /** Scale factor for the ring model */
  scale: number;
}

/**
 * Default ring metadata values optimized for realistic ring placement
 */
const DEFAULT_RING_METADATA: RingARMetadata = {
  anchorPosition: 0.45, // Slightly below the midpoint between MCP and PIP
  rotationOffset: new THREE.Euler(0, 0, 0),
  scale: 1.0,
};

/**
 * Normalized landmark from MediaPipe (coordinates in [0, 1] range)
 */
export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  confidence?: number;
}

/**
 * Hand tracking result from MediaPipe
 */
export interface HandTrackingResult {
  /** Array of 21 normalized landmarks */
  landmarks: NormalizedLandmark[];
  /** Handedness: 'Left' or 'Right' */
  handedness: 'Left' | 'Right';
  /** Confidence score of the detection */
  confidence: number;
}

/**
 * Estimated ring pose in 3D world space
 */
export interface RingPose {
  /** Position in world coordinates */
  position: THREE.Vector3;
  /** Rotation as a quaternion */
  rotation: THREE.Quaternion;
  /** Scale factor */
  scale: number;
  /** Confidence of the pose estimation */
  confidence: number;
  /** Timestamp of the pose estimation */
  timestamp: number;
}

/**
 * Configuration for the pose estimator
 */
export interface PoseEstimatorConfig {
  /** Depth heuristic multiplier for unprojection (default: 200mm) */
  depthMultiplier: number;
  /** Depth heuristic offset for unprojection (default: 50mm) */
  depthOffset: number;
  /** Minimum confidence threshold for valid poses */
  minConfidence: number;
  /** Smoothing filter configuration */
  filterConfig: Partial<OneEuroFilterConfig>;
}

/**
 * Default pose estimator configuration
 */
const DEFAULT_ESTIMATOR_CONFIG: PoseEstimatorConfig = {
  depthMultiplier: 200,
  depthOffset: 50,
  minConfidence: 0.5,
  filterConfig: {
    minCutoff: 0.5,
    beta: 0.1,
    maxCutoff: 10.0,
  },
};

/**
 * Ring Pose Estimator
 * 
 * Transforms 2D MediaPipe hand landmarks into 3D ring poses using:
 * 1. Coordinate mapping from normalized space to NDC to world space
 * 2. Quaternion-based rotation calculation from finger vectors
 * 3. Temporal smoothing via One Euro Filter
 */
export class RingPoseEstimator {
  private config: PoseEstimatorConfig;
  private metadata: RingARMetadata;
  
  // Reusable Three.js objects to avoid garbage collection
  private worldPosition: THREE.Vector3;
  private forwardVector: THREE.Vector3;
  private rightVector: THREE.Vector3;
  private upVector: THREE.Vector3;
  private matrix: THREE.Matrix4;
  
  // Temporal smoothing filters
  private positionFilter: Vector3OneEuroFilter;
  private rotationFilter: RotationOneEuroFilter;
  
  // Last valid pose for fallback
  private lastValidPose: RingPose | null = null;

  constructor(
    metadata: Partial<RingARMetadata> = {},
    config: Partial<PoseEstimatorConfig> = {}
  ) {
    this.metadata = { ...DEFAULT_RING_METADATA, ...metadata };
    this.config = { ...DEFAULT_ESTIMATOR_CONFIG, ...config };
    
    // Initialize reusable Three.js objects
    this.worldPosition = new THREE.Vector3();
    this.forwardVector = new THREE.Vector3();
    this.rightVector = new THREE.Vector3();
    this.upVector = new THREE.Vector3();
    this.matrix = new THREE.Matrix4();
    
    // Initialize smoothing filters with configured parameters
    this.positionFilter = new Vector3OneEuroFilter(this.config.filterConfig);
    this.rotationFilter = new RotationOneEuroFilter(this.config.filterConfig);
  }

  /**
   * Update ring metadata dynamically
   */
  setMetadata(metadata: Partial<RingARMetadata>): void {
    this.metadata = { ...this.metadata, ...metadata };
  }

  /**
   * Convert normalized MediaPipe landmark to NDC (Normalized Device Coordinates)
   * 
   * MediaPipe returns coordinates where:
   * - x: 0 (left) to 1 (right)
   * - y: 0 (top) to 1 (bottom)
   * - z: relative depth (smaller = closer to camera)
   * 
   * NDC in Three.js:
   * - x: -1 (left) to 1 (right)
   * - y: -1 (bottom) to 1 (top)
   * - z: 0 (near) to 1 (far)
   */
  private normalizedToNDC(landmark: NormalizedLandmark): THREE.Vector3 {
    return new THREE.Vector3(
      landmark.x * 2 - 1,           // [0,1] -> [-1,1]
      -(landmark.y * 2 - 1),        // [0,1] -> [1,-1] (flip Y for Three.js)
      landmark.z                     // Keep z as-is for depth calculation
    );
  }

  /**
   * Calculate depth value from normalized z-coordinate
   * 
   * Uses heuristic: depth = z_norm * depthMultiplier + depthOffset
   * This approximates the distance from camera to hand in millimeters
   */
  private calculateDepth(normalizedZ: number): number {
    return normalizedZ * this.config.depthMultiplier + this.config.depthOffset;
  }

  /**
   * Unproject NDC coordinates to world space using camera and depth heuristic
   */
  private unprojectToWorld(
    ndc: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    depthMm: number
  ): THREE.Vector3 {
    // Convert depth from mm to Three.js units (assuming 1 unit = 1mm)
    const depth = depthMm;
    
    // Create a new vector for NDC with updated z for unprojection
    const ndcWithDepth = new THREE.Vector3(
      ndc.x,
      ndc.y,
      (depth - camera.near) / (camera.far - camera.near)
    );
    
    // Unproject to world space
    return ndcWithDepth.unproject(camera).clone();
  }

  /**
   * Get interpolated anchor point between MCP and PIP joints
   */
  private getAnchorPoint(
    mcp: NormalizedLandmark,
    pip: NormalizedLandmark
  ): NormalizedLandmark {
    const t = this.metadata.anchorPosition;
    
    return {
      x: mcp.x + (pip.x - mcp.x) * t,
      y: mcp.y + (pip.y - mcp.y) * t,
      z: mcp.z + (pip.z - mcp.z) * t,
    };
  }

  /**
   * Calculate the forward vector (direction along the finger)
   */
  private calculateForwardVector(mcp: THREE.Vector3, pip: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3().subVectors(pip, mcp).normalize();
  }

  /**
   * Calculate the right vector (perpendicular to finger, across the hand)
   */
  private calculateRightVector(indexMCP: THREE.Vector3, pinkyMCP: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3().subVectors(pinkyMCP, indexMCP).normalize();
  }

  /**
   * Construct rotation matrix from basis vectors and convert to quaternion
   * 
   * This implements the crucial quaternion rotation calculation:
   * 1. Forward = normalize(PIP - MCP)
   * 2. Right = normalize(Pinky_MCP - Index_MCP)
   * 3. Up = normalize(cross(Right, Forward))
   * 4. Re-orthogonalize Right = normalize(cross(Forward, Up))
   * 5. Construct Matrix4 from basis vectors
   * 6. Extract quaternion from matrix
   */
  private calculateRotation(
    forward: THREE.Vector3,
    right: THREE.Vector3
  ): THREE.Quaternion {
    // Calculate up vector using cross product
    const upVector = new THREE.Vector3().crossVectors(right, forward).normalize();
    
    // Re-orthogonalize right vector
    const rightVector = new THREE.Vector3().crossVectors(forward, upVector).normalize();
    
    // Construct rotation matrix from basis vectors
    // Columns represent: Right, Up, Forward (basis vectors)
    const matrix = new THREE.Matrix4().makeBasis(
      rightVector,
      upVector,
      forward
    );
    
    // Extract quaternion from rotation matrix
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
    
    // Apply rotation offset from metadata
    if (this.metadata.rotationOffset) {
      const offsetQuaternion = new THREE.Quaternion().setFromEuler(this.metadata.rotationOffset);
      quaternion.multiply(offsetQuaternion);
    }
    
    return quaternion;
  }

  /**
   * Validate that we have sufficient landmark data
   */
  private validateLandmarks(landmarks: NormalizedLandmark[]): boolean {
    if (landmarks.length < 21) {
      return false;
    }
    
    // Check critical landmarks have reasonable confidence
    const criticalIndices = [
      RingFingerLandmarks.MCP,
      RingFingerLandmarks.PIP,
      OrientationLandmarks.IndexMCP,
      OrientationLandmarks.PinkyMCP,
    ];
    
    for (const index of criticalIndices) {
      const landmark = landmarks[index];
      if (!landmark || landmark.confidence !== undefined && landmark.confidence < this.config.minConfidence) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Main pose estimation method
   * 
   * Takes hand tracking results and calculates the 3D pose for ring placement
   * 
   * @param trackingResult - Hand tracking data from MediaPipe
   * @param camera - Three.js perspective camera for unprojection
   * @param timestamp - Current timestamp for temporal filtering
   * @returns RingPose or null if estimation failed
   */
  estimatePose(
    trackingResult: HandTrackingResult,
    camera: THREE.PerspectiveCamera,
    timestamp: number
  ): RingPose | null {
    // Validate input
    if (!this.validateLandmarks(trackingResult.landmarks)) {
      return this.lastValidPose;
    }
    
    const landmarks = trackingResult.landmarks;
    
    // Get key landmarks
    const mcpLandmark = landmarks[RingFingerLandmarks.MCP];
    const pipLandmark = landmarks[RingFingerLandmarks.PIP];
    const indexMCPLandmark = landmarks[OrientationLandmarks.IndexMCP];
    const pinkyMCPLandmark = landmarks[OrientationLandmarks.PinkyMCP];
    
    if (!mcpLandmark || !pipLandmark || !indexMCPLandmark || !pinkyMCPLandmark) {
      return this.lastValidPose;
    }
    
    // Calculate anchor point (where the ring sits on the finger)
    const anchorLandmark = this.getAnchorPoint(mcpLandmark, pipLandmark);
    
    // Convert to NDC
    const anchorNDC = this.normalizedToNDC(anchorLandmark);
    const mcpNDC = this.normalizedToNDC(mcpLandmark);
    const pipNDC = this.normalizedToNDC(pipLandmark);
    const indexMCPNDC = this.normalizedToNDC(indexMCPLandmark);
    const pinkyMCPNDC = this.normalizedToNDC(pinkyMCPLandmark);
    
    // Calculate depth from anchor point's z-coordinate
    const depthMm = this.calculateDepth(anchorLandmark.z);
    
    // Unproject to world space
    const worldPosition = this.unprojectToWorld(anchorNDC, camera, depthMm);
    const worldMCP = this.unprojectToWorld(mcpNDC, camera, depthMm);
    const worldPIP = this.unprojectToWorld(pipNDC, camera, depthMm);
    const worldIndexMCP = this.unprojectToWorld(indexMCPNDC, camera, depthMm);
    const worldPinkyMCP = this.unprojectToWorld(pinkyMCPNDC, camera, depthMm);
    
    // Calculate basis vectors for rotation
    const forward = this.calculateForwardVector(worldMCP, worldPIP);
    let right = this.calculateRightVector(worldIndexMCP, worldPinkyMCP);
    
    // FEAT-02: Handedness Compensation
    // If it's the user's LEFT hand (which appears on the right side of a mirrored camera),
    // the Index→Pinky direction must be negated to maintain correct ring orientation.
    const isLeftHand = trackingResult.handedness === 'Left';
    if (isLeftHand) {
      right.negate(); // flip the right vector for left hand
    }
    
    // Calculate rotation quaternion
    let rotation = this.calculateRotation(forward, right);
    
    // Apply temporal smoothing
    const euler = new THREE.Euler().setFromQuaternion(rotation);
    const smoothedEuler = this.rotationFilter.apply(euler, timestamp);
    const smoothedPosition = this.positionFilter.apply(worldPosition, timestamp);
    
    // Convert smoothed euler back to quaternion
    rotation.setFromEuler(smoothedEuler);
    
    // Create pose object
    const pose: RingPose = {
      position: smoothedPosition.clone(),
      rotation: rotation.clone(),
      scale: this.metadata.scale,
      confidence: trackingResult.confidence,
      timestamp,
    };
    
    // Store for fallback
    this.lastValidPose = pose;
    
    return pose;
  }

  /**
   * Reset all internal state and filters
   */
  reset(): void {
    this.positionFilter.reset();
    this.rotationFilter.reset();
    this.lastValidPose = null;
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.reset();
  }
}

export default RingPoseEstimator;
