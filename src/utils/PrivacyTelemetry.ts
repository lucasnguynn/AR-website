// FILE: src/utils/PrivacyTelemetry.ts
type PrivacyClean = { readonly __brand: 'privacy-clean' };

/**
 * Whitelisted privacy-safe AR telemetry event names.
 */
export type AREventName =
  | 'AR_SESSION_STARTED'
  | 'AR_SESSION_ENDED'
  | 'AR_TRACKING_ACQUIRED'
  | 'AR_TRACKING_LOST'
  | 'AR_MODEL_LOADED'
  | 'AR_PRESET_CHANGED'
  | 'AR_QUICKLOOK_LAUNCHED'
  | 'AR_GESTURE_DETECTED';

/**
 * Privacy-sanitized telemetry payload that intentionally excludes PII, camera frames, landmarks, and biometric fields.
 */
export type SafeEventPayload = PrivacyClean & {
  eventName: AREventName;
  timestamp: number;
  sessionId: string;
  deviceClass: string;
  arState: string;
  durationMs?: number;
};

const TELEMETRY_ENDPOINT = '/telemetry/ar';
const startedAt = performance.now();
let ephemeralSessionId: string | null = null;

function dntEnabled(): boolean {
  return navigator.doNotTrack === '1' || (navigator as Navigator & { msDoNotTrack?: string }).msDoNotTrack === '1';
}

function getSessionId(): string {
  if (ephemeralSessionId) return ephemeralSessionId;
  ephemeralSessionId = crypto.randomUUID();
  return ephemeralSessionId;
}

function isAREventName(value: unknown): value is AREventName {
  return (
    value === 'AR_SESSION_STARTED' ||
    value === 'AR_SESSION_ENDED' ||
    value === 'AR_TRACKING_ACQUIRED' ||
    value === 'AR_TRACKING_LOST' ||
    value === 'AR_MODEL_LOADED' ||
    value === 'AR_PRESET_CHANGED' ||
    value === 'AR_QUICKLOOK_LAUNCHED' ||
    value === 'AR_GESTURE_DETECTED'
  );
}

/**
 * Returns a branded payload containing only privacy-safe AR telemetry fields.
 */
export function sanitizePayload(raw: Record<string, unknown>): SafeEventPayload {
  const { eventName, arState, deviceClass, durationMs } = raw;
  const safeEventName: AREventName = isAREventName(eventName) ? eventName : 'AR_SESSION_STARTED';
  const payload: SafeEventPayload = {
    __brand: 'privacy-clean',
    eventName: safeEventName,
    timestamp: Date.now(),
    sessionId: getSessionId(),
    deviceClass: String(deviceClass ?? 'unknown'),
    arState: String(arState ?? ''),
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
  };
  console.info('[Privacy] Payload sanitized — no PII keys');
  return payload;
}

/**
 * Sends privacy-safe AR telemetry with an ephemeral in-memory session identifier.
 */
export function sendPrivacyTelemetry(eventName: AREventName): boolean {
  if (dntEnabled()) return false;

  const payload = sanitizePayload({
    eventName,
    arState: 'unknown',
    deviceClass: 'unknown',
    durationMs: Math.round(performance.now() - startedAt),
  });

  const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  return navigator.sendBeacon(TELEMETRY_ENDPOINT, body);
}
// VERIFY: console.log('[Privacy] Payload sanitized — no PII keys')
