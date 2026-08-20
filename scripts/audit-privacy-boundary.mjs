import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : [join(directory, entry.name)]))).flat().filter((path) => /\.(?:ts|tsx)$/.test(path));
}

const files = await sourceFiles('src');
const outboundSinks = /\b(?:sendBeacon|WebSocket|EventSource)\s*\(/;
const forbiddenPayload = /\b(?:landmarks?|keypoints?|biometric|geometry|imageData|videoFrame|depthMap)\s*:/i;
for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (outboundSinks.test(source) && file !== join('src', 'utils', 'PrivacyTelemetry.ts')) throw new Error(`Unreviewed telemetry/network sink: ${file}`);
}
const telemetry = await readFile(join('src', 'utils', 'PrivacyTelemetry.ts'), 'utf8');
if (!telemetry.includes("const TELEMETRY_ENDPOINT = '/telemetry/ar'")) throw new Error('Telemetry must remain same-origin.');
const payloadDefinition = telemetry.match(/const payload: SafeEventPayload = \{([\s\S]*?)\n  \};/)?.[1] ?? '';
if (!payloadDefinition || forbiddenPayload.test(payloadDefinition)) throw new Error('Telemetry payload includes biometric, frame, landmark, geometry, or raw depth data.');
console.log(`Privacy boundary passed: ${files.length} client files scanned; telemetry is same-origin and payload-field allowlisted.`);
