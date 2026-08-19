# Production quality gate

## Reproducible build environment

The frozen-lock release environment is Ubuntu (the `ubuntu-latest` GitHub Actions
runner), Node 20.20.2, and npm 11.4.2. Use `npm ci`; do not reuse `node_modules`
or fall back to `npm install`. The required release stack is Three.js 0.170.0,
MediaPipe Tasks Vision 0.10.35, ONNX Runtime Web 1.20.1, and Vite 5.4.21. CI
checks the npm version before installation so changes to the Node
distribution's bundled package manager fail visibly rather than silently
rewriting dependency resolution.

`npm run quality` is the local equivalent of the required pull-request gate. It validates required binary assets, strict TypeScript, lint, unit and simulated-browser contracts, the static CSP, a production build, the final SHA-384 artifact manifest, and gzip budgets. The integrity manifest detects accidental or hostile byte changes; it is **not** client authorization and contains no signing secret.

The integration suite deliberately mocks capability routing only. It does not certify ARCore/ARKit tracking, native depth accuracy, camera permission UI, WebGPU drivers, thermal behavior, or jewelry scale on physical devices.

## Hardware release matrix

Before a production release, record device/OS/browser, renderer, tracking and depth diagnostic tiers, and pass/fail evidence for:

- Android Chrome ARCore: WebXR session grant/denial, hand input if exposed, native-depth occlusion when exposed, graceful geometric fallback, interruption/resume, and rear-camera thermal stability for 10 minutes.
- iPhone/iPad Safari: valid Quick Look launch and physical USDZ scale, camera-composite permission grant/denial, orientation changes, and modal teardown (camera indicator turns off).
- Desktop Chrome, Firefox, Safari, and Edge: keyboard modal lifecycle, interactive 3D controls, WebGL fallback, reduced motion, and no camera request until Try On is selected.
- Low-memory and network-throttled mobile: lazy AR chunk behavior, worker integrity failure UI, missing/tampered binary rejection, tracking loss/recovery, and no crash.

GitHub Pages may ignore repository `_headers` files. The post-deploy job captures actual response headers; do not claim CSP or Permissions-Policy enforcement unless that evidence contains them. If headers are absent, enforce them at a host/CDN that supports response-header configuration before treating them as a security boundary.

## Binary provenance

| Asset | Purpose | Release validation |
| --- | --- | --- |
| `models/hand_landmarker.task` | MediaPipe hand landmarks | required, non-empty, SHA-384 final-manifest entry |
| `wasm/vision_wasm_internal.wasm` | local MediaPipe WASM runtime | required, non-empty, SHA-384 final-manifest entry |
| `models/nhan.glb` / `nhan.usdz` | ring render and Quick Look | required, non-empty, SHA-384 final-manifest entry |
| `models/depth/depth_anything_v2_small.onnx` | optional local monocular depth | required only when `VITE_ENABLE_MONOCULAR_DEPTH=true`; never silently substituted |

Binary licensing and upstream checksums must be attached to release evidence when an asset is updated; the generated manifest proves build identity, not upstream provenance.
