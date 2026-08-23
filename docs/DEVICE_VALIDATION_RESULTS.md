# Device Validation Results

No physical-device evidence is committed for the current release candidate yet. Automated browser tests validate routing and lifecycle contracts only; they are not substitutes for hardware evidence.

| Gate | Required observation | Current result | Evidence to attach |
| --- | --- | --- | --- |
| Android camera + WebGL2 | Camera starts, hand tracks, ring renders and remains stable | **NOT TESTED — HARDWARE REQUIRED** | Device/OS/Chrome, commit SHA, screen recording, console diagnostics |
| Android camera retry/switch | Permission/device failures recover or fail cleanly; no stale camera track remains | **NOT TESTED — HARDWARE REQUIRED** | Camera indicator video, logs across retry/switch |
| Android occlusion fallback | Geometric finger occlusion remains visually usable | **NOT TESTED — HARDWARE REQUIRED** | Near/far hand-pose recording |
| Android WebXR session | Immersive session starts from CTA and exits cleanly | **NOT TESTED — HARDWARE REQUIRED** | Device/browser support, session log, recording |
| Android WebXR hand tracking | XR joints actually drive the ring when exposed | **NOT TESTED — HARDWARE REQUIRED** | Joint-source diagnostics + recording |
| Android WebXR native depth | Real depth is consumed and fallback remains safe when unavailable | **NOT TESTED — HARDWARE REQUIRED** | Depth-tier diagnostics + recording |
| XR multi-view | Any device returning multiple XR views uses correct per-view assumptions | **NOT TESTED — HARDWARE REQUIRED** | View count and depth diagnostics |
| iOS/iPadOS Quick Look | Approved USDZ launches with correct orientation/usable physical scale | **NOT TESTED — HARDWARE REQUIRED** | iPhone/iPad model, OS/Safari, screen recording |
| Ten open/close cycles | Camera/XR/workers/render resources return to baseline | **NOT TESTED — HARDWARE REQUIRED** | Ten-cycle log, camera indicator, memory samples |
| Ten-minute session | No crash, runaway memory, severe throttling, or thermal warning | **NOT TESTED — HARDWARE REQUIRED** | FPS/memory by minute, battery/thermal notes |
| WebGPU renderer migration | React19/R3F9 WebGPU Canvas and TSL path render correctly | **DEFERRED — NOT ACTIVE IN CURRENT PRODUCTION** | Future migration build/device evidence |
| Monocular depth | Licensed ONNX asset and provider path pass memory/FPS/thermal tests | **DISABLED** | Future model provenance + benchmark sheet |
| Metric sizing | Physical gauge measurements pass across target devices | **DISABLED** | Calibration matrix |

## Scripted procedure

1. Deploy one immutable release-candidate commit over HTTPS.
2. Record commit SHA, asset version, device model, OS, browser version, battery level, and ambient conditions.
3. Run each applicable graphics/XR/Quick Look row once with console diagnostics captured where possible.
4. Perform ten full Try On open/close cycles and record camera/XR teardown after each cycle.
5. Start a fresh ten-minute session; record FPS/memory once per minute and any thermal/battery anomalies.
6. Attach unedited logs and recordings to the release record.
7. Mark PASS only when the behavior is observed on hardware. API presence or a mocked test is not enough.

## Current verdict

**BETA — automated contracts improved; physical hardware release matrix remains open.**
