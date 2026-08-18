import React, { useEffect, useMemo, useState } from 'react';

import type { RingSizeEstimate } from '../utils/SizingTool';
import type { GestureDetection } from '../utils/GestureDetector';

const CONFIDENCE_THRESHOLD = 0.62;
const STABILITY_MS = 1000;

export interface ARControlsProps {
  confidence: number;
  sizeEstimate: RingSizeEstimate | null;
}

export function ARControls({ confidence, sizeEstimate }: ARControlsProps) {
  const [stableSince, setStableSince] = useState<number | null>(null);
  const [gesture, setGesture] = useState<GestureDetection | null>(null);
  const [stableReady, setStableReady] = useState(false);
  const canDisplaySize = confidence > CONFIDENCE_THRESHOLD && Boolean(sizeEstimate?.usRingSize);

  useEffect(() => {
    if (!canDisplaySize) {
      setStableSince(null);
      setStableReady(false);
      return;
    }

    const startedAt = stableSince ?? performance.now();
    setStableSince(startedAt);
    const timer = window.setTimeout(() => setStableReady(true), Math.max(0, STABILITY_MS - (performance.now() - startedAt)));
    return () => window.clearTimeout(timer);
  }, [canDisplaySize, stableSince]);

  useEffect(() => {
    const onGesture = (event: Event) => {
      setGesture((event as CustomEvent<GestureDetection>).detail);
      window.setTimeout(() => setGesture(null), 1400);
    };
    window.addEventListener('ar:gesture', onGesture);
    return () => window.removeEventListener('ar:gesture', onGesture);
  }, []);

  const sizeText = useMemo(() => {
    if (!sizeEstimate?.usRingSize) return '—';
    return `US ${sizeEstimate.usRingSize} · EU ${sizeEstimate.euRingSize ?? '—'} · UK ${sizeEstimate.ukRingSize ?? '—'} · JP ${sizeEstimate.jpRingSize ?? '—'}`;
  }, [sizeEstimate]);

  return (
    <div className="pointer-events-none absolute inset-x-6 bottom-[calc(env(safe-area-inset-bottom)+2rem)] z-20 space-y-3 text-center">
      <div
        className={`mx-auto w-fit rounded-full border border-[#D5FD50]/25 bg-black/45 px-5 py-3 font-mono text-sm tracking-[0.18em] text-[#D5FD50] backdrop-blur-xl transition duration-700 ${
          canDisplaySize && stableReady ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
        }`}
        aria-live="polite"
      >
        <span className="block text-[0.58rem] uppercase tracking-[0.32em] opacity-70">Estimated ring size</span>
        <span className="mt-1 block">{sizeText}</span>
      </div>

      <div className="mx-auto max-w-sm rounded-3xl border border-white/10 bg-black/35 px-5 py-4 backdrop-blur-xl">
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-[#D5FD50]">Gesture control</p>
        <p className="mt-2 text-sm font-light text-white/75">Pinch select · open palm reset · thumbs up save</p>
        <p className="mt-2 h-5 font-mono text-xs uppercase tracking-[0.24em] text-[#D5FD50]">{gesture ? gesture.type.replace('_', ' ') : 'Awaiting gesture'}</p>
      </div>
    </div>
  );
}
