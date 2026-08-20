# V5 Device Validation Results

No physical-device evidence was available in this environment. Browser capability mocks validate routing and recovery only; they are not hardware evidence.

| gate | required observation | result | evidence to capture |
| --- | --- | --- | --- |
| Android WebGPU: camera + TSL metal | local camera starts; metal renders through the WebGPU path | **NOT TESTED - HARDWARE REQUIRED** | device/build ID, browser version, renderer diagnostics, screen recording |
| Android WebGPU: TSL gem | authored gemstone mesh uses the TSL optical material | **NOT TESTED - HARDWARE REQUIRED** | gemstone asset ID, diagnostics, controlled-light recording |
| Android WebGPU: occlusion | hand/ring occlusion is visually correct and depth tier is reported | **NOT TESTED - HARDWARE REQUIRED** | depth tier, recording across near/far poses, console log |
| Android WebGL fallback | WebGPU-disabled device retains camera composite and physical-material fallback | **NOT TESTED - HARDWARE REQUIRED** | renderer diagnostics, recording, error log |
| Android WebXR native depth | immersive-ar session consumes native depth and cleans up on exit | **NOT TESTED - HARDWARE REQUIRED** | device/build ID, WebXR flags, depth diagnostics, session log |
| Android WebXR hand tracking | tracked hand drives output and session resources clean up | **NOT TESTED - HARDWARE REQUIRED** | joint-source diagnostics, recording, session log |
| iOS Safari Quick Look | tapping View in AR opens the shipped USDZ at fixed scale | **NOT TESTED - HARDWARE REQUIRED** | iPhone/iOS/Safari versions, deployed URL, screen recording |
| 10 open/close sessions | camera, workers, animation frames, and render resources return to baseline | **NOT TESTED - HARDWARE REQUIRED** | timestamped session log and memory samples after every close |
| 10-minute continuous run | no crash, runaway memory, thermal warning, or unacceptable throttling | **NOT TESTED - HARDWARE REQUIRED** | start/end memory, FPS samples, OS thermal warning/temperature-tool log |

## Scripted procedure

1. Use an immutable release-candidate deployment over HTTPS; record its commit SHA, device model/OS, browser version, battery state, and ambient conditions.
2. Run each graphics/XR row once with remote console logging enabled. Record the runtime diagnostics shown by the application; do not infer native depth or hand tracking from API presence.
3. Open and fully close Try On ten times. After each close, confirm the camera indicator stops and record the browser/OS memory value. Fail on a retained camera, active XR session, uncaught error, or sustained growth above the agreed device baseline.
4. Start a fresh session and operate it continuously for ten minutes. Sample FPS/memory once per minute and record any OS thermal warning or externally measured temperature. Browsers expose no portable thermal API, so thermal PASS requires physical-device observation.
5. Attach unedited logs and recordings to the release record. Enter PASS only when output consumption, fallback, and cleanup are observed—not merely when capability detection succeeds.

## Automated evidence boundary

`tests/e2e/release-validation.spec.ts` covers modal behavior, focus containment/restoration, mocked WebXR-negative routing, permission denial, Quick Look URL construction, ten lifecycle repetitions, and a configurable ten-minute browser survival/heap bound. It makes no WebGPU, native-depth, hand-tracking, temperature, or physical-device claim.

## Final verdict

**BETA** — automated release validation exists, but every required physical hardware gate remains untested.
