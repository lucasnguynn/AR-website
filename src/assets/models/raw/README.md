# Production ring source contract

Place the **authoring-quality** GLB here as `nhan.glb` before running `npm run build:assets`.
Do not use the current single-mesh demo GLB as the production source.

Required node contract:

```text
RingRoot
├── Metal
│   └── extras.materialRole = "metal"
└── Gemstone
    ├── extras.materialRole = "gemstone"
    └── extras.gemstoneType = "sapphire" | "ruby" | "diamond" | ...
```

Authoring rules:
- Keep metal and gemstone as separate nodes/primitives.
- Apply transforms before export.
- Use a documented real-world scale; the runtime calibration contract is in `src/config/ringModelMetadata.ts`.
- Do not merge/join Metal and Gemstone during optimization.
- Prefer no baked camera/light nodes in product GLB.
- If textures are added, introduce KTX2/BasisU as a separate reviewed pipeline step.

Build:

```bash
npm run build:assets
```

Expected output:
- `public/models/nhan-high.glb`
- `public/models/nhan-medium.glb`
- `public/models/nhan-low.glb`
