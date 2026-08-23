# Production Jewelry Asset Authoring Guide

This document defines exactly which image and 3D files are required by the current COLORA WebAR release and how they must be prepared before upload.

## 1. Files already present — keep them

These runtime dependencies already exist and normally should **not** be replaced during jewelry-model work:

```text
public/models/hand_landmarker.task
public/wasm/vision_wasm_internal.wasm
```

They are tied to the pinned MediaPipe Tasks Vision dependency and are synchronized/verified by the build pipeline.

The current repository also contains temporary product assets:

```text
public/models/nhan.glb
public/models/nhan.usdz
public/models/nhan-preview.png
```

`nhan.glb` is still a development fallback and must not be copied into `assets/models/raw/` as the production source.

## 2. New 3D source file you need to add

Add exactly:

```text
assets/models/raw/nhan.glb
```

### Required format

- Binary glTF 2.0 (`.glb`).
- Prefer an uncompressed authoring export; the repository creates release Draco compression itself.
- Keep jewelry geometry, normals, and required vertex data embedded in the GLB.
- Do not include camera or light nodes.
- Apply object transforms before export.
- Do not merge the metal and gemstone into one primitive.

### Required semantic structure

At minimum:

```text
RingRoot
├── Metal
│   └── extras.materialRole = "metal"
└── Gemstone
    ├── extras.materialRole = "gemstone"
    └── extras.gemstoneType = "sapphire"
```

Supported `gemstoneType` values in the current renderer are:

```text
diamond
sapphire
ruby
emerald
amethyst
```

Do not use another value such as `spinel` yet: the current shader preset table does not define it, so a new optical preset should be reviewed before that semantic is released.

### Blender setup

For a Blender export:

1. Keep the ring metal and every gemstone as separate Objects or separate mesh primitives.
2. Rename objects clearly, e.g. `Metal`, `Gemstone_Main`; names are useful to artists but **release validation does not rely on names**.
3. Select the metal object → **Object Properties → Custom Properties** → add:
   - `materialRole` = `metal`
4. Select each gemstone object → Custom Properties → add:
   - `materialRole` = `gemstone`
   - `gemstoneType` = one supported value, e.g. `sapphire`
5. Apply Rotation and Scale (`Ctrl+A`) before export.
6. Export **glTF 2.0 → Format: GLB**.
7. Enable export of **Custom Properties / Extras**.
8. Do not join Metal and Gemstone before export.
9. Upload the exported file to `assets/models/raw/nhan.glb`.

If your exporter puts custom properties on materials or meshes rather than objects, that is acceptable as long as every primitive resolves to exactly one explicit `materialRole` and every gemstone resolves to exactly one supported `gemstoneType`.

## 3. Geometry and LOD expectations

The pipeline generates three runtime files automatically:

```text
public/models/nhan-high.glb
public/models/nhan-medium.glb
public/models/nhan-low.glb
```

Release budgets are:

| Tier | Maximum triangles | Maximum file size |
| --- | ---: | ---: |
| HIGH | 45,000 | 1.5 MB |
| MEDIUM | 20,000 | 900 KB |
| LOW | 8,000 | 500 KB |

The generator targets slightly below those limits to leave safety headroom.

For faceted gemstones, topology is visually important. Inspect the generated HIGH/MEDIUM/LOW files after the workflow. If automatic simplification damages facet geometry, author a lower-topology source or dedicated LOD strategy instead of raising the release budgets blindly.

## 4. Physical scale requirement

The runtime currently carries calibration metadata derived from the existing model in `src/config/ringModelMetadata.ts`.

A new source model must therefore satisfy one of these two approaches:

**Preferred for the first semantic replacement:** preserve the same modeled outer diameter and orientation as the currently approved ring asset.

**Alternative:** export a new documented real-world scale and update `src/config/ringModelMetadata.ts` only after measuring the new GLB and validating the physical calibration contract.

Do not turn on metric sizing just because the CAD dimensions are known. Camera/device calibration remains a separate gate.

## 5. USDZ file required for iPhone/iPad Quick Look

Production requires:

```text
public/models/nhan.usdz
```

This file should represent the **same product revision** as the semantic GLB.

Recommended production workflow:

1. Export from the approved Blender/CAD source through an Apple-compatible USD/USDZ exporter or conversion tool.
2. Preserve the intended physical scale.
3. Preserve metal/gemstone appearance as far as the Quick Look material model supports.
4. Test the USDZ directly on a real iPhone/iPad Safari Quick Look session.
5. Confirm that `allowsContentScaling=0` still produces a sensible physical presentation.
6. Replace `public/models/nhan.usdz` only after that test.

`scripts/glb_to_usdz.py` in this repository is intentionally minimal and is **not** the recommended production appearance exporter.

## 6. Preview image required

Production requires:

```text
public/models/nhan-preview.png
```

Recommended specification:

- PNG, sRGB.
- Prefer square `1024 × 1024 px`.
- Product centered with comfortable margin.
- Clean white, neutral, or transparent background.
- No watermark.
- No text baked into the image.
- Keep the file ideally below ~500 KB after optimization.
- Image must depict the same ring revision and gemstone color as the configured product.

The current preview is `1753 × 1403` and about `1.3 MB`; it works, but a purpose-built square optimized preview will load faster and frame better in the Quick Look launcher.

## 7. Files you do NOT need to add yet

Do not add these until their feature gates are intentionally activated:

```text
public/models/depth/depth_anything_v2_small.onnx
public/environments/*.hdr
```

Monocular depth is currently disabled. A depth ONNX file must not be introduced without its exact provenance, license review, hash, memory/FPS benchmark, and device thermal validation.

The current production renderer uses same-origin procedural lighting and does not require an HDR environment file.

## 8. What happens after you upload `assets/models/raw/nhan.glb`

GitHub Actions should run:

```text
Semantic Ring Asset Pipeline
        ↓
validate explicit Metal + Gemstone extras
        ↓
generate HIGH / MEDIUM / LOW
        ↓
Draco compression
        ↓
validate semantics again
        ↓
validate triangle + byte budgets
        ↓
commit validated files into public/models/
        ↓
trigger Quality + GitHub Pages
```

Only when all three generated LODs exist and both workflows are green should `.env.production` change to:

```dotenv
VITE_RING_MODEL_HIGH=models/nhan-high.glb
VITE_RING_MODEL_MEDIUM=models/nhan-medium.glb
VITE_RING_MODEL_LOW=models/nhan-low.glb
```

At that point, increment `VITE_ASSET_VERSION` as part of the product release.

## 9. Final product-asset checklist

Before changing `.env.production`, verify all of the following:

- [ ] `assets/models/raw/nhan.glb` is the approved semantic source.
- [ ] Every production primitive has explicit `materialRole` extras.
- [ ] At least one metal primitive exists.
- [ ] At least one gemstone primitive exists.
- [ ] Every gemstone has a supported `gemstoneType`.
- [ ] `nhan-high.glb`, `nhan-medium.glb`, `nhan-low.glb` were generated by the green asset workflow.
- [ ] HIGH/MEDIUM/LOW visual appearance was inspected.
- [ ] `public/models/nhan.usdz` matches the same product revision.
- [ ] Quick Look was tested on a real iPhone/iPad.
- [ ] `public/models/nhan-preview.png` matches the same product revision.
- [ ] Physical scale/orientation was checked before any true-size claim.
