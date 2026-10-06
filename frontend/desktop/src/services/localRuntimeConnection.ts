import { useEffect } from 'react'
import { useASRStore } from '@/store/useASRStore'
import type { LocalRuntimeState } from './localRuntimeTypes'

const LAST_MANAGED_URL = 'amadeus.localRuntime.lastUrl'

function normalizedUrl(value: string) {
  return value.trim().replace(/\/+$/, '')
}

function rememberedUrl() {
  try { return localStorage.getItem(LAST_MANAGED_URL) || '' } catch { return '' }
}

function rememberUrl(value: string) {
  try { localStorage.setItem(LAST_MANAGED_URL, normalizedUrl(value)) } catch { /* Storage may be unavailable. */ }
}

/** Installation temporarily clears state.url; retain the identity of the
 * selected local service without treating an unrelated remote backend as it. */
export function isSelectedLocalRuntime(state: LocalRuntimeState | null, configuredUrl: string): boolean {
  const selected = normalizedUrl(configuredUrl)
  if (!state || !selected) return false
  const local = normalizedUrl(state.url || rememberedUrl())
  return Boolean(local && selected === local)
}

/** A user click can select local service; background events must preserve a remote server. */
export function connectLocalRuntime(state: LocalRuntimeState, explicit = false) {
  if (state.phase !== 'running' || !state.url) return
  const settings = useASRStore.getState().settings
  const current = normalizedUrl(settings.serverUrl)
  const previous = normalizedUrl(rememberedUrl())
  const canConnect = explicit || (state.autoStart && (!current || (!!previous && current === previous)))
  rememberUrl(state.url)
  if (canConnect) useASRStore.getState().updateSettings({ serverUrl: state.url, backendConfirmed: true })
}

/** Keep auto-start connection working even when the Settings page has never been opened. */
export function useLocalRuntimeConnection() {
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.localRuntimeStatus || !api.onLocalRuntimeState) return
    let alive = true
    let eventReceived = false
    const off = api.onLocalRuntimeState((state) => {
      eventReceived = true
      if (alive) connectLocalRuntime(state)
    })
    void api.localRuntimeStatus().then((state) => {
      if (alive && !eventReceived) connectLocalRuntime(state)
    }).catch(() => { /* The Settings panel exposes environment diagnostics. */ })
    return () => { alive = false; off() }
  }, [])
}
