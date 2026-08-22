// FILE: src/components/QuickLookViewer.tsx
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

import { trackAREvent } from '../utils/ARAnalytics';

/** Props for the iOS AR Quick Look launcher. */
export interface QuickLookViewerProps {
  usdzUrl: string;
  previewImageUrl: string;
  productName: string;
  realWorldDiameterMm: number;
  onDismiss(): void;
}

const containerStyle: CSSProperties = { position: 'relative', display: 'inline-block' };
const imageStyle: CSSProperties = { width: 200, height: 200, objectFit: 'cover', borderRadius: 12, display: 'block' };
const badgeStyle: CSSProperties = {
  position: 'absolute',
  bottom: 8,
  right: 8,
  background: 'rgba(0,0,0,0.72)',
  color: '#fff',
  borderRadius: 8,
  padding: '6px 12px',
  pointerEvents: 'none',
  fontSize: 13,
};

/**
 * Declarative Apple AR Quick Look link.
 *
 * WebKit requires an `a[rel="ar"]` link to contain exactly one direct child and
 * that child must be an `img` or `picture`. Keeping the real anchor in the DOM
 * also preserves the user's tap gesture instead of synthesizing a second click.
 */
export function QuickLookViewer({ usdzUrl, previewImageUrl, productName, realWorldDiameterMm, onDismiss }: QuickLookViewerProps) {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([usdzUrl, previewImageUrl].map(async (url) => {
      const response = await fetch(url, {
        method: 'HEAD',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Quick Look asset unavailable: ${url}`);
    }))
      .then(() => setAvailable(true))
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [previewImageUrl, usdzUrl]);

  const quickLookHref = useMemo(
    () => `${usdzUrl}#allowsContentScaling=0&canonicalWebPageURL=${encodeURIComponent(window.location.href)}`,
    [usdzUrl],
  );

  const handleLaunchAR = useCallback(() => {
    trackAREvent('AR_QUICKLOOK_LAUNCHED', {
      experience: 'quick-look',
      reasonCode: `diameter-${realWorldDiameterMm}mm`,
    });
  }, [realWorldDiameterMm]);

  return (
    <div style={containerStyle}>
      {available === true ? (
        <a
          rel="ar"
          href={quickLookHref}
          onClick={handleLaunchAR}
          aria-label={`View ${productName} in AR at ${realWorldDiameterMm} millimeters`}
          style={{ display: 'block' }}
        >
          <img src={previewImageUrl} alt={productName} style={imageStyle} />
        </a>
      ) : (
        <img src={previewImageUrl} alt={productName} style={imageStyle} />
      )}

      <span aria-hidden="true" style={{ ...badgeStyle, opacity: available === true ? 1 : 0.6 }}>
        {available === null ? 'Checking AR…' : available ? '⬡ View in AR' : 'AR unavailable'}
      </span>

      {available === false && (
        <p role="alert" style={{ maxWidth: 220, marginTop: 10 }}>
          Quick Look assets are unavailable. You can return to the product page.
        </p>
      )}

      <button onClick={onDismiss} className="sr-only" aria-label="Close Quick Look AR preview">
        Close
      </button>
    </div>
  );
}
