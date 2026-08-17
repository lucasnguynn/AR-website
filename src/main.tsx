import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Remove the static HTML loading screen before React renders
const loadingEl = document.getElementById('loading')
if (loadingEl) {
  loadingEl.remove()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
