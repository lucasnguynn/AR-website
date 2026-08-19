# AR-website
Riết sắp khùng mà Github còn lỗi

## Deployment integrity and platform security

`npm run build` first validates every enabled runtime asset, builds once, then hashes the **final** worker/model/Quick Look files in `dist/integrity-manifest.json`. Deploy `dist` unchanged. The browser fetches that manifest and refuses to create a worker or consume verified ML bytes when an exact path, byte size, or SHA-384 digest does not match. This is public release integrity metadata—not authentication or private asset authorization.

The checked-in `_headers` file is portable configuration for hosts that support it. GitHub Pages does not apply this file, so do not claim COOP/COEP or response CSP is active there. The CSP meta tag remains a compatible document policy (but cannot express `frame-ancestors`); run `npm run verify:headers -- https://deployment.example/` against the real deployment to record actual HTTP headers.

Quick Look assets are reproducibly derived with `python3 scripts/glb_to_usdz.py public/models/nhan.glb`; the converter emits an uncompressed, 64-byte-aligned USDZ containing real mesh geometry. CI installs the license-compatible Pixar `usd-core` package for independent ecosystem tooling, though conversion itself uses only Python's standard library.
