export type PrivacyTelemetryEvent = 'STARTED' | 'ENDED' | 'GESTURE_USED';

interface PrivacyTelemetryPayload {
  event: PrivacyTelemetryEvent;
  timestamp: string;
  sessionAgeMs: number;
}

const TELEMETRY_ENDPOINT = '/telemetry/ar';
const startedAt = performance.now();

function dntEnabled(): boolean {
  return navigator.doNotTrack === '1' || (navigator as Navigator & { msDoNotTrack?: string }).msDoNotTrack === '1';
}

export function sendPrivacyTelemetry(event: PrivacyTelemetryEvent): boolean {
  if (dntEnabled()) return false;

  const payload: PrivacyTelemetryPayload = {
    event,
    timestamp: new Date().toISOString(),
    sessionAgeMs: Math.round(performance.now() - startedAt),
  };

  const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  return navigator.sendBeacon(TELEMETRY_ENDPOINT, body);
}
