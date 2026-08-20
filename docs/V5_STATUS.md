# V5 Status

| phase | status | evidence | next gate |
| --- | --- | --- | --- |
| V5-0 Repository sanitation | PARTIAL | Inventory found 14,628 tracked `node_modules/` paths and 10 tracked `dist/` paths. The branch-specific, allowlisted sanitation workflow and hygiene validator are present; required `public/models/` and `public/wasm/` assets remain tracked. | Push this correction to `v5/v5-0-repository-sanitation`, confirm the automatic sanitation commit, and verify all four generated-path counts are zero. |
| V5 clean lockfile build | PARTIAL | Lockfile excludes `@svenflow/micro-handpose`, pins Three.js 0.170.0, and CI project installs use `npm ci`; local clean install is blocked by this environment returning HTTP 403 for public npm tarballs. | Run two clean `npm ci` + quality pipelines on a clean GitHub Actions runner and compare lockfile plus integrity manifest hashes. |
