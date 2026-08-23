# V5 Status

This file describes the repository at the current GitHub Pages / React18 / R3F8 release architecture. It must not claim a feature is production-active merely because implementation code exists.

| Phase | Status | Evidence | Next gate |
| --- | --- | --- | --- |
| Repository sanitation | **ACTIVE** | Generated `node_modules/` and `dist/` content is not part of the runtime source; reproducible-build sanitation runs on dependency/build-tool changes and on schedule. | Keep clean-install workflow green. |
| Lockfile / deterministic build | **ACTIVE, CI authoritative** | `package.json` and `package-lock.json` pin MediaPipe `0.10.35`; GitHub Actions uses `npm ci`; final asset hashes are recorded in `dist/integrity-manifest.json`. | Confirm `Quality + GitHub Pages` and sanitation workflows remain green after dependency changes. |
| Camera composite AR | **ACTIVE** | Bounded camera acquisition/recovery, stale-stream teardown, same-origin verified MediaPipe worker/model/WASM, anatomical pose projection, UKF filtering, adaptive quality, and WebGL2 rendering are wired into the production composition. | Physical Android/iOS camera lifecycle and ten-cycle resource validation. |
| Production graphics backend | **ACTIVE: WebGL2** | React 18 + R3F v8 production Canvas is synchronous WebGL2. WebGPU hardware detection is informational only. | React19/R3F9 migration and dedicated WebGPU device QA before activating a WebGPU Canvas. |
| WebXR immersive AR | **HARDWARE VALIDATION REQUIRED** | User-gesture `requestSession`, late renderer binding, XR hand routing, native-depth path, and geometric fallback exist. | Test on supported Android/WebXR hardware, including session teardown, hand data, depth behavior, and multi-view assumptions. |
| Apple Quick Look | **HARDWARE VALIDATION REQUIRED** | Declarative `a[rel="ar"] > img` launcher, same-origin USDZ, preview image, and fixed-scaling fragment are present. | Validate `public/models/nhan.usdz` scale/appearance on real iPhone/iPad Safari. |
| Semantic production ring | **BLOCKED BY SOURCE ASSET** | Strict source and generated-LOD gates now require explicit `materialRole` and `gemstoneType` extras. Current served `nhan.glb` remains the development fallback. | Upload approved `assets/models/raw/nhan.glb` with separate Metal + Gemstone semantics. |
| HIGH/MEDIUM/LOW ring LOD | **BLOCKED BY SOURCE ASSET** | Asset pipeline can generate and Draco-compress three tiers, then enforce strict semantics and byte/triangle budgets. | Generate and visually inspect all three LODs before switching `.env.production`. |
| Gemstone optical path | **IMPLEMENTED, NOT PRODUCTION-REACHABLE WITH CURRENT MODEL** | Runtime material strategy supports explicit gemstone meshes. Current camera production renderer is WebGL2; TSL/WebGPU path remains deferred with the WebGPU renderer migration. | Supply semantic gemstone geometry; validate WebGL material first, then WebGPU in the migration phase. |
| Monocular ONNX depth | **IMPLEMENTED BUT OFF** | Worker/backpressure/depth integration exists; runtime flag is false and no release ONNX asset is shipped. | Review model provenance/license, use compiled verified worker URL, benchmark RAM/FPS/thermal, then enable intentionally. |
| Metric sizing | **OFF** | Runtime calibration metadata exists but the feature flags remain false. | Physical ring-gauge/device calibration matrix. |
| Privacy telemetry | **OFF** | Privacy-safe telemetry implementation exists but no production endpoint is enabled. | Deploy/review a same-origin endpoint before enabling. |
| GitHub Pages deployment | **ACTIVE** | Quality gate uploads the verified `dist` artifact; post-deploy workflow checks meta CSP, integrity manifest, critical asset hashes, Lighthouse, and captures actual response headers. | Treat GitHub Pages response-header limitations as platform evidence, not as `_headers` enforcement. |

## Current release verdict

**BETA / engineering validation build.** The browser runtime is significantly hardened, but production release is still blocked by the semantic product asset and physical-device evidence.
