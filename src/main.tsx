import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// NOTE: React.StrictMode intentionally omitted — it causes WebGL context loss
// because it double-invokes effects in development, which tears down and
// re-creates the Three.js renderer, exhausting the browser's WebGL context limit.
// See: https://react.dev/reference/react/StrictMode#fixing-bugs-found-by-strict-mode
ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />
)

// Remove the static HTML loading screen after React has mounted.
// This is the #loading div in index.html — it is completely separate from the
// React-managed loading overlay in ARTryOnModal (which is driven by Zustand state).
// The 500ms delay gives React time to paint its first frame so there's no flash.
const loadingElement = document.getElementById('loading')
if (loadingElement) {
  setTimeout(() => {
    loadingElement.style.opacity = '0'
    setTimeout(() => loadingElement.remove(), 500)
  }, 500)
}
