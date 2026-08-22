import { AR_RUNTIME_CONFIG } from '../config/arRuntimeConfig';

type PrivacyClean = { readonly __brand: 'privacy-clean' };

export type AREventName =
  | 'AR_CTA_CLICKED'
  | 'AR_MODE_SELECTED'
  | 'AR_SESSION_STARTED'
  | 'AR_SESSION_ENDED'
  | 'AR_TRACKING_ACQUIRED'
  | 'AR_TRACKING_LOST'
  | 'AR_MODEL_LOADED'
  | 'AR_PRESET_CHANGED'
  | 'AR_QUICKLOOK_LAUNCHED'
  | 'AR_GESTURE_DETECTED'
  | 'AR_FALLBACK_SELECTED'
  | 'AR_FATAL_ERROR';

export type SafeARContext = {
  readonly experience?: string;
  readonly renderer?: string;
  readonly depthTier?: string;
  readonly qualityTier?: string;
  readonly reasonCode?: string;
};

export type SafeEventPayload = PrivacyClean & {
  eventName: AREventName;
  timestamp: number;
  sessionId: string;
  durationMs: number;
  sku: string;
  assetVersion: string;
  context?: SafeARContext;
};

const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
let ephemeralSessionId: string | null = null;

function dntEnabled(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.doNotTrack === '1' || (navigator as Navigator & { msDoNotTrack?: string }).msDoNotTrack === '1';
}

function getSessionId(): string {
  if (ephemeralSessionId) return ephemeralSessionId;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    ephemeralSessionId = crypto.randomUUID();
  } else {
    // Ephemeral only; never persisted and never derived from device/user data.
    ephemeralSessionId = `ar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return ephemeralSessionId;
}

function clean(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const sanitized = String(value).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, max);
  return sanitized || undefined;
}

function sanitizeContext(context?: SafeARContext): SafeARContext | undefined {
  if (!context) return undefined;
  const safe = {
    experience: clean(context.experience, 48),
    renderer: clean(context.renderer, 32),
    depthTier: clean(context.depthTier, 32),
    qualityTier: clean(context.qualityTier, 16),
    reasonCode: clean(context.reasonCode, 64),
  } satisfies SafeARContext;

  return Object.values(safe).some(Boolean) ? safe : undefined;
}

export function sanitizePayload(eventName: AREventName, context?: SafeARContext): SafeEventPayload {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const safeContext = sanitizeContext(context);
  return {
    __brand: 'privacy-clean',
    eventName,
    timestamp: Date.now(),
    sessionId: getSessionId(),
    durationMs: Math.max(0, Math.round(now - startedAt)),
    sku: AR_RUNTIME_CONFIG.product.sku,
    assetVersion: AR_RUNTIME_CONFIG.product.assetVersion,
    ...(safeContext ? { context: safeContext } : {}),
  };
}

/** No camera frame, landmark, hand geometry, IP-derived identifier or PII is accepted. */
export function sendPrivacyTelemetry(eventName: AREventName, context?: SafeARContext): boolean {
  if (!AR_RUNTIME_CONFIG.features.telemetry || dntEnabled() || typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
  const payload = sanitizePayload(eventName, context);
  const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  return navigator.sendBeacon(AR_RUNTIME_CONFIG.telemetryEndpoint, body);
}
