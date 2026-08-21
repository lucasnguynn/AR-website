// src/hooks/useLoadingState.ts
import { useState, useEffect, useRef, useCallback } from 'react';

const LOADING_TIMEOUT_MS = 12_000; // Force-dismiss after 12 s; prevents deadlock

/**
 * Returns `isLoading` that resolves when:
 *   (a) the caller signals `markLoaded()`, OR
 *   (b) the timeout elapses (safety-net for Draco / network hangs).
 *
 * This decouples the overlay lifetime from the GLB load promise, so a
 * stalled decoder can never keep the UI permanently frozen.
 */
export function useLoadingState() {
  const [isLoading, setIsLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    // Safety-net: if GLB never resolves, dismiss the overlay anyway.
    timerRef.current = setTimeout(() => {
      setIsLoading(false);
    }, LOADING_TIMEOUT_MS);

    return () => clearTimeout(timerRef.current);
  }, []);

  const markLoaded = useCallback(() => {
    clearTimeout(timerRef.current);
    setIsLoading(false);
  }, []);

  return { isLoading, markLoaded };
}
