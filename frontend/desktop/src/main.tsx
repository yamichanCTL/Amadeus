import React from 'react'
import ReactDOM from 'react-dom/client'
import { installFetchTelemetry } from './services/telemetry'

installFetchTelemetry()

const baseStyles = navigator.userAgent.includes('Windows') ? import('./styles/global.css') : import('./styles/mac.css')
void baseStyles.then(() => import('./styles/workspace.css')).then(() => import('./App')).then(({ default: App }) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><App /></React.StrictMode>
  )
})
