import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installFetchTelemetry } from './services/telemetry'

installFetchTelemetry()

if (navigator.userAgent.includes('Windows')) {
  import('./styles/global.css')
} else {
  import('./styles/mac.css')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
