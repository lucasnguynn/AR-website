import { AR_RUNTIME_CONFIG } from '../config/arRuntimeConfig';
import { sendPrivacyTelemetry, type AREventName, type SafeARContext } from './PrivacyTelemetry';

interface UmamiAnalytics {
  track(eventName: string, data?: Record<string, string | number | boolean>): void;
}

declare global {
  interface Window { umami?: UmamiAnalytics; }
}

function toUmamiData(context?: SafeARContext): Record<string, string> | undefined {
  if (!context) return undefined;
  const entries = Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function analyticsAllowed(): boolean {
  return AR_RUNTIME_CONFIG.features.telemetry
    && typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && navigator.doNotTrack !== '1';
}

/** Vendor-neutral analytics boundary. Only the allowlisted privacy-clean context may leave the AR core. */
export function trackAREvent(eventName: AREventName, context?: SafeARContext): void {
  if (!analyticsAllowed()) return;
  sendPrivacyTelemetry(eventName, context);
  window.umami?.track(eventName.toLowerCase(), toUmamiData(context));
}
