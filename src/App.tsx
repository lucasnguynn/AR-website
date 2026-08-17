import { useState } from 'react';
import ARTryOnModal from './components/ARTryOnModal';
import { DEFAULT_CATALOG } from './components/RingCatalog';

/**
 * Public glTF-Binary ring model from the official Khronos sample repo.
 * Using the first item from the catalog as the default ring.
 */
const RING_MODEL_URL = DEFAULT_CATALOG[0].modelUrl

function App() {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="flex flex-col items-center justify-center w-full min-h-screen bg-black gap-6">
      {/* Hero label */}
      <h1 className="text-brand-neon text-4xl font-bold tracking-tight text-center px-4">
        WebAR Jewelry Try-On
      </h1>

      <p className="text-white/60 text-sm text-center max-w-xs px-4">
        Point your camera at your hand and see how the ring looks in real time.
      </p>

      {/* Primary CTA — opens the real ARTryOnModal */}
      <button
        onClick={() => setIsOpen(true)}
        className="
          mt-4 px-10 py-4
          bg-brand-neon text-black
          text-lg font-bold rounded-full
          hover:opacity-90 active:scale-95
          transition-all duration-150
          shadow-[0_0_24px_rgba(213,253,80,0.35)]
        "
      >
        Try On Ring
      </button>

      {/*
        Real ARTryOnModal — previously this was an inline mock that:
          • lacked the required `onClose` and `ringModelUrl` props,
          • duplicated component logic already defined in ARTryOnModal.tsx,
          • and used hardcoded arbitrary Tailwind colour values.
        All three issues are resolved here.
      */}
      <ARTryOnModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        ringModelUrl={RING_MODEL_URL}
      />
    </div>
  )
}

export default App
