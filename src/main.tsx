import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Remove the static HTML loading screen once React has mounted
const loadingEl = document.getElementById('loading')
if (loadingEl) {
  loadingEl.style.transition = 'opacity 0.3s ease-out'
  loadingEl.style.opacity = '0'
  setTimeout(() => loadingEl.remove(), 300)
}
