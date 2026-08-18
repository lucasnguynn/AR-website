/**
 * coordinateMapping.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE OLD PROJECTION MATH FAILS  (Task 2 root cause analysis)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MediaPipe gives us landmarks in NORMALISED VIDEO-FRAME space:
 *   x ∈ [0, 1]   measured left→right in the RAW capture frame
 *   y ∈ [0, 1]   measured top→bottom in the RAW capture frame
 *   z             relative depth in "hand-width" units (negative = toward camera)
 *
 * The naive (broken) conversion is:
 *   ndcX = lm.x * 2 - 1
 *   ndcY = -(lm.y * 2 - 1)
 *
 * This is only correct when ALL of these hold simultaneously:
 *   A. The <video> element has exactly the same pixel dimensions as the
 *      Three.js <canvas> (they are stacked via position:absolute).
 *   B. The video fills the element with no cropping (object-fit: contain + exact
 *      aspect match).
 *   C. The camera is NOT mirrored (rear camera).
 *
 * In practice, none of A, B, or C hold for a front-facing jewellery try-on:
 *   A. The canvas can be 375×812 while the raw video is 640×480 (4:3).
 *   B. object-fit: cover crops the video to fill the element, so landmark
 *      x=0.5 in video space ≠ pixel 375/2 in element space.
 *   C. The front camera video is CSS-mirrored (transform: scaleX(-1)), so
 *      landmark x and the visual position are mirror images.
 *
 * The ring therefore appears at the wrong x/y and the wrong depth, making it
 * look like it's "not attached" to the finger.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CORRECT PIPELINE  (implemented below)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   [1] Mirror-flip X for front camera:
 *         mirroredX = 1 - lm.x
 *
 *   [2] Account for object-fit: cover aspect-ratio cropping:
 *         coverScale  = max(elemW / videoW,  elemH / videoH)
 *         scaledVideoW = videoW * coverScale  (px in display space)
 *         scaledVideoH = videoH * coverScale
 *         cropX = (scaledVideoW - elemW) / 2   (px cropped from each side)
 *         cropY = (scaledVideoH - elemH) / 2
 *         displayPxX = mirroredX * scaledVideoW - cropX
 *         displayPxY = lm.y      * scaledVideoH - cropY
 *         elemNormX = displayPxX / elemW   → now in [0,1] of the display box
 *         elemNormY = displayPxY / elemH
 *
 *   [3] Map element-space → canvas-space (they should match but may differ):
 *         canvNormX = elemNormX * (elemW / canvW)
 *         canvNormY = elemNormY * (elemH / canvH)
 *
 *   [4] Convert to NDC [-1, 1]:
 *         ndcX =   canvNormX * 2 - 1
 *         ndcY = -(canvNormY * 2 - 1)   ← WebGL Y is inverted
 *
 *   [5] Clamp to [-1,1] (landmark briefly outside frustum → edge-clamp):
 *         ndcX = clamp(ndcX, -1, 1)
 *         ndcY = clamp(ndcY, -1, 1)
 *
 *   [6] Build a camera ray via Raycaster.setFromCamera():
 *         raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera)
 *
 *   [7] Map MediaPipe z → world Z-plane depth and intersect the ray:
 *         worldPlaneZ = BASE_Z - lm.z * Z_SCALE
 *         plane = new THREE.Plane(new THREE.Vector3(0,0,1), -worldPlaneZ)
 *         raycaster.ray.intersectPlane(plane, worldPos)
 *
 * Step [2] is the critical missing piece in virtually every broken WebAR demo.
 * Step [7] keeps the ring inside the camera frustum regardless of hand depth.
 */

import * as THREE from 'three';
import type { NormalisedLandmark } from '../types/ar.types';

// ──────────────────────────────────────────────────────────────────────────────
// Tuning constants — adjust these if the ring is consistently offset
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The world-space Z coordinate the ring hovers around when lm.z = 0.
 * Assumes the Three.js camera is at z = 5 looking toward the origin.
 * A value of 1.5 places the ring roughly one-third of the way between
 * the camera and origin — comfortable viewing distance.
 */
const BASE_Z = 1.5;

/**
 * Amplification of MediaPipe's relative z depth into world units.
 * MediaPipe z range for a hand: roughly [-0.12, 0.06].
 * With Z_SCALE=5, that maps to [-0.6, 0.3] world units of variation around BASE_Z.
 * Increase this if the ring noticeably "flattens" when the hand tilts.
 */
const Z_SCALE = 5.0;

/**
 * Fraction along the MCP→PIP segment where the ring centre sits.
 * 0 = exactly at the MCP (base knuckle), 1 = at the PIP (middle knuckle).
 * Rings typically sit just above the MCP, so 0.25 is a realistic default.
 */
export const RING_SEGMENT_T = 0.25;

// ──────────────────────────────────────────────────────────────────────────────
// Parameter bag (avoids long argument lists in hot-path code)
// ──────────────────────────────────────────────────────────────────────────────

export interface ProjectionParams {
  videoElement: HTMLVideoElement;
  /** The renderer's DOM element (gl.domElement in R3F). */
  canvasElement: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  /**
   * True if the video element is CSS-mirrored (transform: scaleX(-1)),
   * which is standard for the front-facing camera.
   */
  isMirrored?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Reusable Three.js objects — allocated once, reused every frame.
// Allocating new Vector2/Vector3/Raycaster inside useFrame causes GC pressure.
// ──────────────────────────────────────────────────────────────────────────────
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane();
const _planeNormal = new THREE.Vector3(0, 0, 1); // world z-plane normal
const _worldPos = new THREE.Vector3();

/**
 * Projects a single MediaPipe normalised landmark into Three.js world space,
 * correctly handling mirror-flip, CSS cover cropping, and Z-depth.
 *
 * @returns A THREE.Vector3 in world space, or `null` if the ray misses the plane
 *          (can happen when the camera is rotated; caller should skip that frame).
 */
export function landmarkToWorld(
  lm: NormalisedLandmark,
  params: ProjectionParams,
): THREE.Vector3 | null {
  const {
    videoElement,
    canvasElement,
    camera,
    isMirrored = true,
  } = params;

  // Guard: video must have decoded at least one frame.
  const videoW = videoElement.videoWidth;
  const videoH = videoElement.videoHeight;
  if (videoW === 0 || videoH === 0) return null;

  const elemW = videoElement.clientWidth;
  const elemH = videoElement.clientHeight;
  if (elemW === 0 || elemH === 0) return null;

  const canvW = canvasElement.clientWidth;
  const canvH = canvasElement.clientHeight;

  // ── [1] Mirror-flip for front camera ──────────────────────────────────────
  const normX = isMirrored ? 1.0 - lm.x : lm.x;
  const normY = lm.y;

  // ── [2] CSS object-fit: cover compensation ────────────────────────────────
  //
  // CSS "cover" picks the LARGER of (elemW/videoW) and (elemH/videoH) as the
  // scale factor, ensuring the element is fully filled.  The axis with the
  // smaller ratio gets cropped symmetrically on both sides.
  //
  const scaleX = elemW / videoW;
  const scaleY = elemH / videoH;
  const coverScale = Math.max(scaleX, scaleY);

  const scaledVideoW = videoW * coverScale; // video pixels rendered at display scale
  const scaledVideoH = videoH * coverScale;

  // Crop offsets: how many display pixels are hidden beyond the element edge.
  const cropX = (scaledVideoW - elemW) / 2;  // px cropped from left AND right
  const cropY = (scaledVideoH - elemH) / 2;  // px cropped from top  AND bottom

  // Landmark in display pixel space after crop:
  const displayPxX = normX * scaledVideoW - cropX;
  const displayPxY = normY * scaledVideoH - cropY;

  // Normalise back to [0,1] within the visible display area:
  const elemNormX = displayPxX / elemW;
  const elemNormY = displayPxY / elemH;

  // ── [3] Element → canvas normalised space ─────────────────────────────────
  // If the canvas is overlaid at exactly the same CSS size as the video element
  // these ratios are both 1.0.  Keep the formula generic for flexibility.
  const canvNormX = elemNormX * (elemW / canvW);
  const canvNormY = elemNormY * (elemH / canvH);

  // ── [4] Convert to NDC [-1, 1] ────────────────────────────────────────────
  const rawNdcX = canvNormX * 2 - 1;
  const rawNdcY = -(canvNormY * 2 - 1); // WebGL Y is top-to-bottom → invert

  // ── [5] Clamp to [-1, 1] so the ray always points inside the frustum ──────
  _ndc.set(
    Math.max(-1, Math.min(1, rawNdcX)),
    Math.max(-1, Math.min(1, rawNdcY)),
  );

  // ── [6] Build camera ray via the raycaster ────────────────────────────────
  _raycaster.setFromCamera(_ndc, camera);

  // ── [7] Intersect a world-space Z-plane driven by MediaPipe depth ─────────
  //
  // MediaPipe z convention:
  //   z < 0  →  closer to camera than the reference point (wrist)
  //   z > 0  →  further  from camera
  //
  // Three.js default camera sits at z=+5 looking toward z=0.
  // Higher world-z = CLOSER to camera.
  //
  // Mapping: worldPlaneZ = BASE_Z - lm.z * Z_SCALE
  //   • lm.z = -0.1 (finger tilts toward camera) → planeZ = BASE_Z + 0.5  (closer) ✓
  //   • lm.z =  0.0 (flat hand)                  → planeZ = BASE_Z        (nominal)
  //   • lm.z = +0.1 (finger tilts away)           → planeZ = BASE_Z - 0.5  (further) ✓
  //
  const worldPlaneZ = BASE_Z - lm.z * Z_SCALE;

  // Plane equation: n · x + d = 0  →  (0,0,1)·(x,y,z) + d = 0  →  d = -worldPlaneZ
  _plane.set(_planeNormal, -worldPlaneZ);

  const hit = _raycaster.ray.intersectPlane(_plane, _worldPos);
  if (!hit) {
    // Ray is parallel to the plane (camera rotated 90° around Y — very unlikely
    // in a selfie AR scenario).  Return null so the caller skips this frame.
    return null;
  }

  // Return a *copy* — _worldPos is a shared scratch object.
  return _worldPos.clone();
}

// ──────────────────────────────────────────────────────────────────────────────
// Ring orientation from two knuckle positions
// ──────────────────────────────────────────────────────────────────────────────

const _defaultAxis = new THREE.Vector3(0, 1, 0); // ring model "up" along Y

/**
 * Computes a quaternion that rotates the ring model's Y-axis to align with
 * the finger direction (MCP → PIP).
 *
 * The ring model is assumed to be oriented so that when scale=1 and the
 * quaternion is identity, the ring hole points along +Y.  Most off-the-shelf
 * ring GLB assets exported from Blender in default orientation satisfy this.
 */
export function computeRingQuaternion(
  posMCP: THREE.Vector3,
  posPIP: THREE.Vector3,
  out: THREE.Quaternion = new THREE.Quaternion(),
): THREE.Quaternion {
  const fingerDir = posPIP.clone().sub(posMCP);

  // Guard against zero-length vector (two landmarks at same position)
  if (fingerDir.lengthSq() < 1e-8) {
    out.identity();
    return out;
  }

  fingerDir.normalize();
  out.setFromUnitVectors(_defaultAxis, fingerDir);
  return out;
}

/**
 * Computes the ring's uniform scale factor so the ring diameter matches the
 * visual width of the finger.
 *
 * `segmentWorldLength`: distance in world units between MCP and PIP.
 * `ringModelDiameter`:  the diameter of the ring mesh at scale=1 in world
 *                       units.  Measure this in Blender or with a BoxHelper.
 *                       A typical Blender-exported ring at 1 cm = 0.01 m → 0.01.
 * `fingerWidthFraction`: the ring diameter as a fraction of the MCP–PIP length.
 *                        Physically ~0.65 (finger width ≈ 65% of first segment).
 */
export function computeRingScale(
  posMCP: THREE.Vector3,
  posPIP: THREE.Vector3,
  ringModelDiameter = 0.02,    // adjust to your .glb's actual mesh diameter at scale=1
  fingerWidthFraction = 0.65,
): number {
  const segmentLength = posMCP.distanceTo(posPIP);
  // desired ring diameter = segmentLength * fingerWidthFraction
  // scale = desiredDiameter / modelDiameter
  const scale = (segmentLength * fingerWidthFraction) / ringModelDiameter;
  // Clamp to reasonable range to prevent explosion on bad frames
  return Math.max(0.1, Math.min(20, scale));
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper: capture one video frame into an ArrayBuffer for the worker
// ──────────────────────────────────────────────────────────────────────────────

let _captureCanvas: OffscreenCanvas | null = null;
let _captureCtx: OffscreenCanvasRenderingContext2D | null = null;

/**
 * Draws the current video frame onto an OffscreenCanvas and returns the
 * raw RGBA bytes as a transferable ArrayBuffer.
 *
 * Reuses a single OffscreenCanvas/context pair to avoid per-frame allocation.
 * The returned buffer should be transferred (not copied) to the worker:
 *   worker.postMessage({ buffer }, [buffer])
 */
export function captureVideoFrame(
  video: HTMLVideoElement,
): { buffer: ArrayBuffer; width: number; height: number } | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return null;

  // Lazily create / resize the offscreen canvas
  if (!_captureCanvas || _captureCanvas.width !== w || _captureCanvas.height !== h) {
    _captureCanvas = new OffscreenCanvas(w, h);
    _captureCtx = _captureCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  }

  _captureCtx!.drawImage(video, 0, 0, w, h);
  const imageData = _captureCtx!.getImageData(0, 0, w, h);

  // .buffer is the underlying ArrayBuffer — we .slice() to get an owned copy
  // that can be safely transferred to the worker without leaving a detached
  // TypedArray in the caller.
  return {
    buffer: imageData.data.buffer.slice(0),
    width: w,
    height: h,
  };
}
