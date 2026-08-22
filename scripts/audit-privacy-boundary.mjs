import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : [join(directory, entry.name)]))).flat().filter((path) => /\.(?:ts|tsx)$/.test(path));
}

const files = await sourceFiles('src');
const outboundSinks = /\b(?:sendBeacon|WebSocket|EventSource)\s*\(/;
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (outboundSinks.test(source) && file !== join('src', 'utils', 'PrivacyTelemetry.ts')) throw new Error(`Unreviewed telemetry/network sink: ${file}`);
}

const telemetry = await readFile(join('src', 'utils', 'PrivacyTelemetry.ts'), 'utf8');
const payloadType = telemetry.match(/export type SafeEventPayload[\s\S]*?= PrivacyClean & \{([\s\S]*?)\n\};/)?.[1] ?? '';
const forbiddenPayloadField = /\b(?:landmarks?|keypoints?|biometric|geometry|imageData|videoFrame|depthMap|cameraId|poseHistory)\s*\??:/i;
if (!payloadType || forbiddenPayloadField.test(payloadType)) throw new Error('Telemetry payload type includes biometric, frame, landmark, geometry, raw depth, camera or pose-history data.');

const config = await readFile(join('src', 'config', 'arRuntimeConfig.ts'), 'utf8');
if (!config.includes("sameOriginPath(import.meta.env.VITE_TELEMETRY_ENDPOINT, '/telemetry/ar')")) {
  throw new Error('Telemetry endpoint must be constrained by the same-origin path validator.');
}
if (!telemetry.includes('AR_RUNTIME_CONFIG.telemetryEndpoint')) throw new Error('Telemetry sink must use the reviewed runtime endpoint.');

console.log(`Privacy boundary passed: ${files.length} client files scanned; network sink and payload fields are allowlisted.`);
