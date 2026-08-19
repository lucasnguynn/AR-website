# Forensic release audit

This audit records production reachability rather than source presence. It must be updated when composition-root routing changes. Browser-only and physical-device behavior remains subject to the hardware release matrix in `quality-gate.md`.

## Runtime source graph

`main.tsx` mounts `App`, which lazy-loads `ARTryOnModal` after explicit user interaction. The modal constructs one `AROrchestrator` with ordered adapters: immersive WebXR, iOS Quick Look, camera composite, then interactive 3D. An adapter is reported active only after its real `start()` completes.

The camera-composite path starts a local, muted video stream, creates a SHA-384-verified MediaPipe worker and verified model/WASM blob URLs, and publishes only the latest landmark result. `RingScene` projects each new timestamp once, computes anatomical visual-relative scale, ingests it into `UKFPosePipeline`, samples its bounded kinematic prediction in the R3F loop, and applies the pose to the active GLB clone. No metric calibration is claimed.

The WebXR adapter requests a real `immersive-ar` session. `WebXRScene` binds the Three runtime; the manager owns the XR animation loop, consumes XR hand joints when supplied, and calls `getDepthInformation` for each XR view. Session, binding, and reference space must all exist before diagnostics report active. Missing XR hand/depth features retain the usable geometric proxy.

Camera depth is opt-in through `VITE_ENABLE_MONOCULAR_DEPTH=true`. Only then does bounded 518×518 capture feed the verified ONNX worker with backpressure; completed depth textures drive the depth-only occlusion proxy. Missing/invalid model, worker failure, or inference pressure falls back to the allocation-stable geometric finger proxy. With the flag disabled, monocular code is implemented but not loaded.

The GLB clone is passed through the semantic material strategy. Metal meshes receive the WebGPU TSL node-material implementation on WebGPU and supported physical PBR on WebGL. Meshes classified as gemstones receive the spectral TSL material on WebGPU and physical PBR fallback on WebGL. The shipped GLB's stable metadata classifies its only mesh as metal, so the gemstone implementation is production-reachable only when a configured model actually contains a gemstone semantic. Environment IBL and adaptive lighting are consumed by the active scene. The WebGPU enhancement helper adjusts supported raster/PBR properties; it is not a ray-tracing implementation.

Quick Look consumes the shipped USDZ and preview image under `import.meta.env.BASE_URL`. Interactive 3D consumes the shipped GLB under the same deployment base. Final-dist verification requires each enabled URL to be non-empty and represented by exact byte size and SHA-384 in the generated public integrity manifest. That manifest is tamper detection, not authentication or authorization.

Privacy telemetry is implemented as local, redacted event aggregation but is not imported by the production composition root. Learned LSTM and Transformer predictors and `PredictiveKalmanFusion` are implemented but deliberately disabled because no held-out validation fixture authorizes production activation.

## Maturity matrix

| Maturity class | Subsystems |
| --- | --- |
| ACTIVE + VERIFIED | Camera-composite routing; MediaPipe local worker; worker/model/WASM integrity; anatomical visual scale; UKF measurement filtering; bounded kinematic prediction; duplicate timestamp rejection; geometric finger occlusion; semantic metal material strategy; environment/IBL; adaptive quality degradation and recovery; Quick Look assets; interactive 3D; final-artifact integrity; camera `audio: false` and teardown contracts |
| ACTIVE + HARDWARE VERIFICATION REQUIRED | Immersive WebXR session lifecycle; XR hand joints; native XR depth consumption; WebGPU renderer and TSL metal materials; iOS Quick Look launch/physical scale; ten-cycle camera/worker/GPU teardown; mobile thermal and driver behavior |
| IMPLEMENTED BUT DISABLED EXPERIMENTAL | LSTM predictor; Transformer predictor; `PredictiveKalmanFusion`; opt-in monocular ONNX depth when its separately licensed model is absent from this release; privacy telemetry; gemstone spectral TSL path for models carrying gemstone semantics |
| FALLBACK ONLY | WebGL physical PBR materials; geometric depth proxy when native/monocular depth is unavailable; interactive 3D when camera/XR/Quick Look are unavailable |
| MISSING / BLOCKED | Physical-device evidence for the hardware-required rows; deploy-origin HTTP security-header evidence on GitHub Pages; metric ring calibration/true-size claim; ONNX depth asset and provenance for opt-in monocular depth |

## Security and performance findings

- Camera constraints disable audio. Camera frames and landmarks have no upload path; inference is same-origin worker-local and no biometric result is persisted.
- Worker creation fails closed when the final manifest entry, byte count, or SHA-384 differs. No browser signing secret exists.
- Static scans reject `eval`/`new Function` and remote CV upload patterns. GitHub Pages is not claimed to apply `_headers`; only a post-deploy response check can establish header enforcement.
- Hand capture is bounded and single-flight. Monocular capture is bounded to 518×518 and checks downstream capacity before extraction. Tracking timestamps prevent repeated ingestion.
- R3F owns one camera-composite loop; the XR manager owns one XR display loop. Reusable proxy geometry is transformed, not recreated per frame. Optional ONNX runtime is worker-lazy.
- Modal teardown stops the selected adapter, camera tracks, callbacks/timers, verified workers, blob URLs, depth resources, pose state, cloned geometry/materials, and R3F renderer resources. Automated lifecycle contracts do not replace the required ten-cycle physical camera-indicator/GPU-memory observation.

## Acceptance decision

**PARTIAL — not production-ready.** Local deterministic gates can establish build, integrity, routing, fallback, and simulated lifecycle contracts. Release acceptance remains blocked on physical-device evidence, deployment response-header evidence, and (if monocular depth is enabled) a licensed ONNX asset with provenance. The current release safely leaves monocular depth disabled and does not claim metric sizing.
