# Forensic Release Audit

This document records what is actually reachable in the current deployed composition. Source-code presence alone is not treated as production activation.

## 1. Composition root

`main.tsx` mounts `App`. `App` lazy-loads `ARTryOnModal` after user interaction. `ARTryOnModal` owns one `AROrchestrator` whose ordered adapters are:

1. immersive WebXR when supported,
2. Apple Quick Look on compatible iOS/iPadOS Safari,
3. camera-composite AR,
4. interactive 3D fallback.

An adapter is considered active only after its real start operation completes.

## 2. Camera-composite path

The camera path requests a single video track with `audio: false`. Camera acquisition uses bounded retries, rejects after final failure, restores the previous facing mode when a camera switch cannot be committed, and stops stale streams that resolve after a session has been cancelled.

MediaPipe hand tracking is performed in a same-origin worker. The final worker JavaScript, hand landmarker model, and WASM are verified against the build's SHA-384 integrity manifest before use. Camera frames and landmarks are not uploaded by the AR core.

`RingScene` projects each new hand result once, derives a visual-relative anatomical ring pose, filters/predicts through the production pose pipeline, and updates the active model clone without React state churn per tracking frame.

## 3. Current graphics backend

The production camera-composite Canvas is **WebGL2**.

The repository still contains WebGPU/TSL material implementation code and hardware detection, but React 18 + R3F v8 does not activate the reviewed WebGPU renderer in this release. WebGPU production activation is deferred until a React19/R3F9 migration and target-device validation.

Remote Drei environment presets are not used by the production scene. Current lighting is same-origin/procedural, avoiding an external HDRI dependency that would conflict with the strict same-origin CSP contract.

## 4. WebXR path

The WebXR adapter starts a real `immersive-ar` session from the user gesture. `WebXRScene` binds the Three renderer after the session exists, while `WebXRManager` owns the XR animation loop.

XR hand joints and native depth are consumed when supplied by the browser/device. Missing hand/depth information retains a usable geometric occlusion fallback. Automated mocks verify lifecycle contracts, but they are not physical evidence for Android WebXR hardware, native depth quality, or multi-view correctness.

## 5. Occlusion tiers

The current release behaves as follows:

```text
WebXR native depth, when physically available
        ↓ otherwise
geometric proxy
```

Monocular ONNX depth code exists but `VITE_ENABLE_MONOCULAR_DEPTH=false`, so the optional ONNX model is not a release dependency today.

Before enabling monocular depth, the worker must be loaded through Vite's compiled `?worker&url` output, the model must have reviewed provenance/license and exact integrity evidence, and mobile RAM/FPS/thermal behavior must be validated.

## 6. Product model / semantic material path

The current served `public/models/nhan.glb` remains a development fallback. Production assets must come from:

```text
assets/models/raw/nhan.glb
```

Every production primitive must carry explicit glTF extras:

- `materialRole="metal"`, or
- `materialRole="gemstone"` plus a supported `gemstoneType`.

The release semantic gate deliberately does not accept object/material naming heuristics as proof. The generated HIGH/MEDIUM/LOW files are revalidated after Draco compression and must pass byte and triangle budgets.

Until an approved semantic source is uploaded and three validated LODs exist, `.env.production` intentionally continues to point all quality tiers to the development fallback.

## 7. Apple Quick Look

Quick Look uses a declarative `a[rel="ar"]` containing the preview image so the Safari user gesture is preserved. The configured USDZ and preview image are same-origin assets.

The repository's Python GLB-to-USDZ converter is a minimal geometry diagnostic utility, not a full production jewelry material exporter. `public/models/nhan.usdz` must be visually and physically validated on a real Apple device before release.

## 8. Integrity, privacy, and GitHub Pages

The final Vite output creates `dist/integrity-manifest.json`. Verified runtime loaders compare exact asset path, byte length, and SHA-384 before creating security-sensitive workers or consuming verified model bytes.

The checked-in `_headers` files are portable policy documentation. GitHub Pages does not treat them as response-header configuration. The meta CSP remains part of the document, and the post-deploy workflow captures the headers the platform actually returns.

Privacy telemetry and metric sizing remain disabled by production configuration.

## 9. Maturity matrix

| Class | Subsystems |
| --- | --- |
| **ACTIVE + AUTOMATED CONTRACTS** | Camera lifecycle, camera-composite routing, MediaPipe local verified worker/model/WASM, WebGL2 renderer, pose filtering/prediction, geometric occlusion, adaptive quality, Quick Look launcher structure, final-build integrity checks, GitHub Pages deployment gates |
| **ACTIVE + HARDWARE EVIDENCE REQUIRED** | Android/iOS camera lifecycle, immersive WebXR, XR hand joints, native XR depth, iOS Quick Look scale/appearance, ten-cycle resource teardown, ten-minute thermal/stability behavior |
| **IMPLEMENTED BUT DISABLED** | Monocular ONNX depth, privacy telemetry, metric sizing, WebGPU production renderer |
| **BLOCKED BY ASSET** | Production semantic Metal + Gemstone ring, generated HIGH/MEDIUM/LOW runtime LODs, production-reachable gemstone material routing |

## 10. Release decision

**PARTIAL / BETA.** Do not promote to a true-size or final production jewelry release until the semantic source asset, generated runtime LODs, Quick Look product USDZ, and physical-device matrix have all passed.
