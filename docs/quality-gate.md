# Release Quality Gate

A release candidate is accepted only when automated gates and the required physical-device observations both pass.

## Automated GitHub gates

### Quality + GitHub Pages

Required:

```text
npm ci
npm run validate:dependencies
npm run quality
GitHub Pages artifact upload
deploy-pages
```

`npm run quality` covers asset validation, TypeScript, ESLint, unit tests, integration tests, CSP/privacy audits, production build/integrity verification, and bundle budgets.

### Semantic Ring Asset Pipeline

This pipeline becomes meaningful only after `assets/models/raw/nhan.glb` exists.

It must pass:

```text
strict source semantic validation
        ↓
HIGH / MEDIUM / LOW generation
        ↓
Draco compression
        ↓
strict generated semantic validation
        ↓
triangle + file-size audit
```

Production semantic validation requires explicit glTF extras and does not accept naming heuristics.

### Post-deploy evidence

The deployed GitHub Pages revision must pass:

- deployment reachability,
- meta CSP check,
- integrity-manifest check,
- deployed critical-asset byte/SHA-384 check,
- Lighthouse thresholds,
- response-header capture for evidence.

Do not interpret `_headers` files as proof that GitHub Pages applies those headers.

## Product asset gates

Before switching `.env.production` to generated LODs:

- source `assets/models/raw/nhan.glb` must be the approved product revision,
- every production primitive must have explicit semantic extras,
- all three generated GLBs must exist,
- all three generated GLBs must pass release budgets,
- visual inspection must confirm gemstone facets and ring silhouette were not damaged by simplification,
- `public/models/nhan.usdz` must represent the same revision,
- `public/models/nhan-preview.png` must represent the same revision.

## Physical device matrix

Record device model, OS, browser version, commit SHA, product asset version, and screen recording/log evidence.

### Android / Chrome camera composite

Pass only when:

- camera permission/start succeeds,
- ring tracks the intended finger,
- WebGL2 renderer remains stable,
- camera switch/retry does not retain stale tracks,
- geometric occlusion remains usable,
- modal close stops the camera indicator.

### WebXR-capable Android device

Pass only when physically observed:

- immersive session starts from the CTA gesture,
- session exits cleanly,
- XR hand routing is correct when provided,
- native depth is consumed only when actual depth information is returned,
- missing XR features fall back without crashing,
- multi-view/stereo assumptions are verified on any device that exposes multiple views.

### iPhone / iPad Safari Quick Look

Pass only when:

- tapping the Quick Look preview launches AR,
- the approved USDZ appears,
- model orientation is correct,
- scale is sensible with content scaling disabled,
- metal/gem appearance is acceptable,
- returning from Quick Look restores the web UI.

### Ten open/close cycles

Open and fully close Try On ten times. Fail if any cycle leaves:

- camera indicator active,
- XR session active,
- uncaught error,
- obvious monotonic memory growth beyond the agreed device baseline.

### Ten-minute stability

Operate a fresh session continuously for ten minutes. Sample FPS/memory once per minute and record any browser/OS thermal warning or externally observed severe throttling.

## Feature-specific activation gates

### Monocular depth

Keep `VITE_ENABLE_MONOCULAR_DEPTH=false` until:

- ONNX model source, revision, and license are documented,
- exact released bytes are integrity verified,
- compiled depth worker URL is verified,
- WebGPU/WASM provider behavior is measured,
- memory, FPS, battery, and thermal behavior pass target hardware.

### Metric sizing

Keep both metric flags false until physical ring gauges and a multi-device calibration matrix pass. CAD dimensions alone do not authorize a true-size claim.

### WebGPU renderer

Current production camera rendering is WebGL2. WebGPU activation requires the separate React19/R3F9 renderer migration plus shader and target-device validation.
