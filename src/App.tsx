/**
 * App.tsx
 *
 * Root component.  Shows a product page with a "Try On" CTA that opens the
 * ARTryOnModal.  Lazy-imports the modal so the heavy Three.js + R3F bundle
 * is NOT in the initial page load — it only loads when the user clicks "Try On".
 *
 * This is an important optimisation: users browsing products don't pay the
 * Three.js download cost until they actually start the AR experience.
 */

import { lazy, Suspense, useState } from 'react';

// Lazy import — Three.js + R3F + MediaPipe are in a separate chunk and only
// downloaded when the modal is first rendered.
const ARTryOnModal = lazy(() =>
  import('./components/ARTryOnModal').then((m) => ({ default: m.ARTryOnModal })),
);

export default function App() {
  const [showAR, setShowAR] = useState(false);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* ── Product page ─────────────────────────────────────────────── */}
      <main className="max-w-md mx-auto p-6 flex flex-col gap-6">
        <h1 className="text-3xl font-bold text-[#D5FD50]">WebAR Jewelry Try-On</h1>

        {/* Sample product card */}
        <div className="bg-neutral-900 rounded-2xl overflow-hidden shadow-xl">
          <div className="w-full aspect-square bg-neutral-800 flex items-center justify-center text-6xl">
            💍
          </div>
          <div className="p-4 flex flex-col gap-3">
            <h2 className="text-xl font-semibold">Classic Gold Band</h2>
            <p className="text-neutral-400 text-sm">
              18k gold, comfort-fit, 4mm width. Available in sizes 5–12.
            </p>
            <button
              onClick={() => setShowAR(true)}
              className="w-full py-3 rounded-xl bg-[#D5FD50] text-black font-bold text-base hover:bg-[#c0e840] active:scale-95 transition-all"
            >
              Try On
            </button>
          </div>
        </div>
      </main>

      {/* ── AR Modal — lazy loaded ─────────────────────────────────── */}
      {showAR && (
        <Suspense fallback={null}>
          <ARTryOnModal onClose={() => setShowAR(false)} />
        </Suspense>
      )}
    </div>
  );
}
