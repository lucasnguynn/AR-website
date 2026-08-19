// FILE: src/components/QuickLookViewer.tsx
import { useCallback, type CSSProperties } from 'react';

interface UmamiAnalytics {
  track(eventName: string, data?: Record<string, string | number | boolean>): void;
}

declare global {
  interface Window {
    umami?: UmamiAnalytics;
  }
}

/** Props for the iOS AR Quick Look launcher. */
export interface QuickLookViewerProps {
  usdzUrl: string;
  previewImageUrl: string;
  productName: string;
  realWorldDiameterMm: number;
  onDismiss(): void;
}

const containerStyle: CSSProperties = { position: 'relative', display: 'inline-block' };
const imageStyle: CSSProperties = { width: 200, height: 200, objectFit: 'cover', borderRadius: 12 };
const buttonStyle: CSSProperties = {
  position: 'absolute',
  bottom: 8,
  right: 8,
  background: 'rgba(0,0,0,0.7)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 13,
};

/** Launches Apple's AR Quick Look with a USDZ model and branded preview image. */
export function QuickLookViewer({ usdzUrl, previewImageUrl, productName, realWorldDiameterMm, onDismiss }: QuickLookViewerProps) {
  const handleLaunchAR = useCallback(() => {
    const anchor = document.createElement('a');
    anchor.rel = 'ar';
    anchor.href = `${usdzUrl}#allowsContentScaling=0&canonicalWebPageURL=${encodeURIComponent(window.location.href)}`;
    anchor.setAttribute('aria-label', `View ${productName} in AR at ${realWorldDiameterMm} millimeters`);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.umami?.track('ar_quicklook_launched', { product: productName, diameterMm: realWorldDiameterMm });
  }, [productName, realWorldDiameterMm, usdzUrl]);

  return (
    <div style={containerStyle}>
      <img src={previewImageUrl} alt={productName} style={imageStyle} />
      <button onClick={handleLaunchAR} aria-label="View in AR" style={buttonStyle}>
        <span aria-hidden="true">⬡</span> View in AR
      </button>
      <button onClick={onDismiss} className="sr-only" aria-label="Close Quick Look AR preview">
        Close
      </button>
    </div>
  );
}
// VERIFY: console.log('[AR Experience] QuickLookViewer launches rel=ar USDZ anchors with analytics')
