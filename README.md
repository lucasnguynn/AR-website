# COLORA WebAR / XR Jewelry Try-On

Browser-based jewelry try-on built with React 18, Vite, Three.js r170, MediaPipe Tasks Vision, WebXR fallbacks, Apple AR Quick Look, and a verified same-origin asset pipeline.

## Current production runtime

The currently validated browser composition is deliberately conservative:

- **Camera-composite AR:** React 18 + React Three Fiber v8 + WebGL2.
- **Hand tracking:** same-origin MediaPipe worker/model/WASM with SHA-384 verification against the final build manifest.
- **WebXR:** raw immersive-ar session path where the browser/device supports it; hardware validation is still required for XR hand/depth behavior.
- **iOS:** Apple AR Quick Look using a checked-in USDZ and preview image.
- **Occlusion:** geometric proxy by default; monocular ONNX depth remains disabled until its model provenance and hardware gates pass.
- **Metric sizing:** disabled until physical calibration passes.

WebGPU hardware may be detected, but the production React18/R3F8 camera Canvas remains WebGL2. WebGPU renderer activation is a separate React19/R3F9 migration gate.

## Development and quality commands

```bash
npm ci
npm run quality
npm run build
```

`npm run quality` runs dependency/asset validation, TypeScript, ESLint, unit/integration tests, CSP/privacy audits, the production build, integrity verification, and bundle budgets.

## Runtime asset layout

```text
assets/models/raw/
└── nhan.glb                 # authoring-quality semantic source; not served directly

public/models/
├── nhan.glb                 # temporary development fallback
├── nhan-high.glb            # generated production LOD after semantic source is approved
├── nhan-medium.glb          # generated production LOD
├── nhan-low.glb             # generated production LOD
├── nhan.usdz                # authored production Quick Look asset
├── nhan-preview.png         # Quick Look/product preview image
└── hand_landmarker.task     # MediaPipe model

public/wasm/
└── vision_wasm_internal.wasm
```

See `docs/ASSET_AUTHORING_GUIDE.md` before uploading a new jewelry model.

## Semantic ring contract

Every production primitive must have explicit glTF extras. Naming alone is intentionally not accepted by the release gate.

```text
RingRoot
├── Metal
│   └── extras.materialRole = "metal"
└── Gemstone
    ├── extras.materialRole = "gemstone"
    └── extras.gemstoneType = "diamond" | "sapphire" | "ruby" | "emerald" | "amethyst"
```

After `assets/models/raw/nhan.glb` is uploaded, the **Semantic Ring Asset Pipeline** validates the source, generates HIGH/MEDIUM/LOW LODs, applies Draco compression, revalidates semantics/budgets, and commits only validated runtime GLBs.

Do **not** update `.env.production` to `nhan-high.glb`, `nhan-medium.glb`, and `nhan-low.glb` until all three files exist and the asset pipeline is green.

## Apple Quick Look

`public/models/nhan.usdz` is a separate release asset. The included `scripts/glb_to_usdz.py` is a minimal geometry converter useful for diagnostics, not a production-fidelity jewelry exporter: it does not preserve the complete material/appearance stack. For production, export and visually validate the USDZ from the approved CAD/Blender source using an Apple-compatible USDZ workflow.

The preview image configured by `VITE_RING_PREVIEW` must also exist and be same-origin.

## Deployment integrity and platform security

`npm run build` validates enabled runtime assets, creates the final Vite output, and hashes the final worker/model/Quick Look files into `dist/integrity-manifest.json`. Runtime verified loaders reject an asset when its exact path, byte size, or SHA-384 does not match that manifest.

The checked-in `_headers` files are portable policy documentation for hosts that support custom response headers. **GitHub Pages does not apply them as deployment configuration.** The application keeps a compatible meta CSP, while `.github/workflows/post-deploy.yml` records the headers GitHub Pages actually returns and verifies deployed critical asset integrity.

## Feature flags that remain OFF

```dotenv
VITE_ENABLE_MONOCULAR_DEPTH=false
VITE_ENABLE_METRIC_SIZING=false
VITE_METRIC_CALIBRATION_VALIDATED=false
VITE_ENABLE_PRIVACY_TELEMETRY=false
```

Do not enable these flags merely because the implementation exists. Each has a separate release gate documented under `docs/`.
