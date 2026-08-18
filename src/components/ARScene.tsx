// Usage in your top-level AR component (e.g. src/components/ARScene.tsx)
// Replace however you currently track loading state with this pattern:

import { useLoadingState } from '../hooks/useLoadingState';

function ARScene() {
  const { isLoading, markLoaded } = useLoadingState();

  return (
    <>
      {/* Overlay dismisses when markLoaded() fires OR timeout elapses */}
      {isLoading && <LoadingOverlay />}

      <Canvas>
        {/* Pass markLoaded into a thin sentinel component that calls it
            on mount — i.e., after Suspense resolves and RingScene renders. */}
        <OnMountNotifier onMount={markLoaded} />
        <RingScene fingerMidpoint={...} fingerRotation={...} />
      </Canvas>
    </>
  );
}

/**
 * Invisible R3F component whose only job is calling `onMount` in a useEffect.
 * Because it lives inside <Canvas> and inside the Suspense tree, its useEffect
 * fires only AFTER the GLB has loaded and the scene is ready to render.
 */
function OnMountNotifier({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
