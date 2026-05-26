import { useEffect, useMemo } from 'react'
import { ASRApi } from '@/services/api'
import { registerTrigger } from '@/services/hotkey'
import { useASRStore } from '@/store/useASRStore'
import { TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { StatusBar } from '@/components/StatusBar'
import { TranscribePage } from '@/pages/Transcribe'
import { HistoryPage } from '@/pages/History'
import { ModelsPage } from '@/pages/Models'
import { SettingsPage } from '@/pages/Settings'

function AppTopBar() {
  const settings = useASRStore((state) => state.settings)
  const setPage = useASRStore((state) => state.setPage)

  return (
    <div className="app-topbar">
      <div className="mode-pill">
        <span aria-hidden="true">↻</span>
        <strong>{settings.llmModel || 'GPT Voice'} / {settings.defaultEngine}</strong>
        <small>⌄</small>
      </div>
      <button type="button" className="icon-button" title="设置" onClick={() => setPage('settings')}>⚙</button>
      <button type="button" className="avatar-button" title="账户">●</button>
    </div>
  )
}

export default function App() {
  const page = useASRStore((state) => state.page)
  const settings = useASRStore((state) => state.settings)
  const setServerStatus = useASRStore((state) => state.setServerStatus)
  const setPage = useASRStore((state) => state.setPage)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])

  useEffect(() => {
    let alive = true
    const check = async () => {
      setServerStatus('checking')
      try {
        await api.health()
        if (alive) setServerStatus('connected')
      } catch {
        if (alive) setServerStatus('disconnected')
      }
    }
    check()
    const timer = window.setInterval(check, 10000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [api, setServerStatus])

  useEffect(() => {
    const theme = settings.theme === 'windows' ? 'system' : settings.theme
    document.documentElement.dataset.theme = theme
    window.electronAPI?.setTheme(theme === 'system' ? 'system' : theme)
  }, [settings.theme])

  useEffect(() => {
    registerTrigger(settings.triggerType, settings.triggerKey).catch(() => undefined)
    return () => {
      window.electronAPI?.unregisterHotkey()
      window.electronAPI?.unregisterMouseButton()
    }
  }, [settings.triggerType, settings.triggerKey])

  useEffect(() => {
    const offClosed = window.electronAPI?.onCaptionOverlayClosed(() => updateSettings({ liveCaptionEnabled: false }))
    const offStyle = window.electronAPI?.onCaptionOverlayStyleChanged((bounds) =>
      updateSettings({
        captionBoxX: typeof bounds.x === 'number' ? bounds.x : settings.captionBoxX,
        captionBoxY: typeof bounds.y === 'number' ? bounds.y : settings.captionBoxY,
        captionBoxWidth: typeof bounds.width === 'number' ? bounds.width : settings.captionBoxWidth,
        captionBoxHeight: typeof bounds.height === 'number' ? bounds.height : settings.captionBoxHeight
      })
    )
    const offSettings = window.electronAPI?.onCaptionOverlaySettingsRequested(() => setPage('settings'))
    return () => {
      offClosed?.()
      offStyle?.()
      offSettings?.()
    }
  }, [setPage, settings.captionBoxHeight, settings.captionBoxWidth, settings.captionBoxX, settings.captionBoxY, updateSettings])

  return (
    <div className="win11-body">
      <TitleBar />
      <div className="app-shell">
        <Sidebar />
        <main className="content">
          <AppTopBar />
          {page === 'transcribe' && <TranscribePage />}
          {page === 'history' && <HistoryPage />}
          {page === 'models' && <ModelsPage />}
          {page === 'settings' && <SettingsPage />}
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
