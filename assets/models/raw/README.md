# Production ring source contract

Upload the approved authoring-quality semantic source as:

```text
assets/models/raw/nhan.glb
```

Do not place authoring-source GLBs under `src/` or `public/`, and do not copy the current single-mesh development fallback from `public/models/nhan.glb` into this folder.

## Required explicit glTF extras

Every production primitive must resolve to exactly one explicit role:

```text
RingRoot
├── Metal
│   └── extras.materialRole = "metal"
└── Gemstone
    ├── extras.materialRole = "gemstone"
    └── extras.gemstoneType = "sapphire"
```

Current supported gemstone types:

```text
diamond
sapphire
ruby
emerald
amethyst
```

Production validation does **not** accept object/material names as semantic proof.

## Authoring rules

- Keep metal and gemstone as separate objects/primitives.
- Export custom properties/extras.
- Apply transforms before export.
- Keep a documented scale and orientation.
- Do not merge/join Metal and Gemstone during optimization.
- Prefer no baked camera/light nodes.
- Prefer an uncompressed authoring GLB; release compression is created by CI.
- Do not enable metric sizing until physical calibration passes.

See `docs/ASSET_AUTHORING_GUIDE.md` for Blender export, USDZ, preview-image, LOD, and device-QA instructions.

## GitHub-only workflow

1. Upload `assets/models/raw/nhan.glb`.
2. `Semantic Ring Asset Pipeline` validates explicit semantics.
3. CI generates and compresses:
   - `public/models/nhan-high.glb`
   - `public/models/nhan-medium.glb`
   - `public/models/nhan-low.glb`
4. CI revalidates semantics, triangle budgets, and byte budgets.
5. Only validated runtime LODs are committed.
6. After all three files exist and workflows are green, update `.env.production` to use them.
