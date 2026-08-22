# Production ring source contract

Place the **authoring-quality semantic GLB** here as `nhan.glb` before the asset pipeline is enabled for a real product asset.
Do not place authoring-source GLBs under `src/` or `public/`.

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
- Use a documented real-world scale; runtime calibration metadata lives in `src/config/ringModelMetadata.ts`.
- Do not merge/join Metal and Gemstone during optimization.
- Prefer no baked camera/light nodes in the product GLB.
- Do not claim true-size until the physical calibration gate has passed.

GitHub-only workflow:
1. Upload the authored file as `assets/models/raw/nhan.glb`.
2. `Semantic Ring Asset Pipeline` validates semantics and generates HIGH/MEDIUM/LOW LODs.
3. Only validated LODs are committed to `public/models/`.
4. After all three LOD files exist and the asset workflow is green, update `.env.production` to point to them.

Expected generated runtime files:
- `public/models/nhan-high.glb`
- `public/models/nhan-medium.glb`
- `public/models/nhan-low.glb`
