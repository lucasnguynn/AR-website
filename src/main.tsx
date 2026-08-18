/**
 * main.tsx
 *
 * Entry point.  Removes the static DOM loading screen (defined in index.html)
 * after React hydrates, with a short fade-out transition.
 */

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// ---------------------------------------------------------------------------
// Remove the static loading screen injected by index.html once React is live
// ---------------------------------------------------------------------------
function AppWithLoadingCleanup() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const loader = document.getElementById('loading');
    if (loader) {
      // Start fade-out
      loader.style.opacity = '0';
      // Remove from DOM after transition completes
      const timer = setTimeout(() => {
        loader.style.display = 'none';
      }, 500);
      return () => clearTimeout(timer);
    }
  }, []);

  if (!mounted) return null;
  return <App />;
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found in index.html');

createRoot(rootEl).render(
  <AppWithLoadingCleanup />
);
