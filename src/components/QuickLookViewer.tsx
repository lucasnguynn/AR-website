import type { AnchorHTMLAttributes, CSSProperties, ReactNode } from 'react';

const ACCENT_COLOR = '#D5FD50';

export interface QuickLookViewerProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'rel' | 'children'> {
  usdzSrc: string;
  posterSrc?: string;
  label?: string;
  children?: ReactNode;
}

const buttonStyle: CSSProperties = {
  alignItems: 'center',
  background: ACCENT_COLOR,
  border: `2px solid ${ACCENT_COLOR}`,
  borderRadius: '999px',
  boxShadow: `0 0 24px ${ACCENT_COLOR}66`,
  color: '#111',
  cursor: 'pointer',
  display: 'inline-flex',
  fontWeight: 700,
  gap: '0.5rem',
  justifyContent: 'center',
  minHeight: '44px',
  padding: '0.75rem 1.25rem',
  textDecoration: 'none',
};

const posterStyle: CSSProperties = {
  borderRadius: '50%',
  height: '28px',
  objectFit: 'cover',
  outline: `2px solid ${ACCENT_COLOR}`,
  width: '28px',
};

export function QuickLookViewer({ usdzSrc, posterSrc, label = 'View in AR', children, style, ...anchorProps }: QuickLookViewerProps) {
  return (
    <a
      {...anchorProps}
      aria-label={anchorProps['aria-label'] ?? label}
      href={usdzSrc}
      rel="ar"
      style={{ ...buttonStyle, ...style }}
    >
      {posterSrc ? <img alt="" aria-hidden="true" src={posterSrc} style={posterStyle} /> : null}
      <span>{children ?? label}</span>
    </a>
  );
}

export default QuickLookViewer;
