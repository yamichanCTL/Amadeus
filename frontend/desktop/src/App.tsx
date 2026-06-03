import { useEffect, useMemo } from 'react'
import { ASRApi } from '@/services/api'
import { registerTrigger } from '@/services/hotkey'
import { useASRStore } from '@/store/useASRStore'
import { TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { StatusBar } from '@/components/StatusBar'
import { TranscribePage } from '@/pages/Transcribe'
import { HistoryPage } from '@/pages/History'
import { SummaryPage } from '@/pages/Summary'
import { ModelsPage } from '@/pages/Models'
import { SettingsPage } from '@/pages/Settings'
import { PlaceholderPage } from '@/pages/Placeholder'

function localDateValue(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10)
}

function minutesOfDay(value: string) {
  const [hour, minute] = value.split(':').map(Number)
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null
}

function isWithinWindow(now: Date, startTime: string, endTime: string) {
  const start = minutesOfDay(startTime)
  const end = minutesOfDay(endTime)
  if (start === null && end === null) return true
  const current = now.getHours() * 60 + now.getMinutes()
  if (start !== null && end === null) return current >= start
  if (start === null && end !== null) return current <= end
  if (start === null || end === null) return true
  return start <= end ? current >= start && current <= end : current >= start || current <= end
}

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
      if (useASRStore.getState().serverStatus !== 'connected') setServerStatus('checking')
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

  useEffect(() => {
    if (!settings.passiveSummaryEnabled) return
    let stopped = false
    let running = false
    const runPassiveSummary = async () => {
      if (stopped || running) return
      const latest = useASRStore.getState().settings
      if (!latest.passiveSummaryEnabled) return
      if (!latest.llmModel.trim() || !latest.llmBaseUrl.trim() || !latest.llmApiToken.trim()) return
      const now = new Date()
      if (!isWithinWindow(now, latest.passiveSummaryStartTime, latest.passiveSummaryEndTime)) return
      const lastAt = Date.parse(latest.passiveSummaryLastRunAt || '')
      const frequencyMs = Math.max(5, latest.passiveSummaryFrequencyMin || 60) * 60_000
      if (Number.isFinite(lastAt) && now.getTime() - lastAt < frequencyMs) return
      running = true
      const attemptedAt = now.toISOString()
      try {
        const summary = await api.summarizeArchive({
          date: localDateValue(now),
          user_id: latest.passiveSummaryUserId.trim() || undefined,
          category: latest.passiveSummaryCategory.trim() || undefined,
          start_time: latest.passiveSummaryStartTime || undefined,
          end_time: latest.passiveSummaryEndTime || undefined,
          provider: latest.llmProvider,
          model: latest.llmModel,
          base_url: latest.llmBaseUrl,
          api_token: latest.llmApiToken,
          style: latest.llmStyle || '工作纪要',
          max_input_chars: 24000
        })
        if (latest.passiveSummaryAutoCloudSave) {
          await api.saveArchiveSummary({
            summary,
            user_id: latest.passiveSummaryUserId.trim() || undefined,
            category: '被动总结'
          })
        }
      } catch (error) {
        console.warn('Passive summary failed', error)
      } finally {
        updateSettings({ passiveSummaryLastRunAt: attemptedAt })
        running = false
      }
    }
    void runPassiveSummary()
    const timer = window.setInterval(runPassiveSummary, 60_000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [
    api,
    settings.passiveSummaryEnabled,
    settings.passiveSummaryFrequencyMin,
    settings.passiveSummaryStartTime,
    settings.passiveSummaryEndTime,
    updateSettings
  ])

  return (
    <div className="win11-body">
      <TitleBar />
      <div className="app-shell">
        <Sidebar />
        <main className="content">
          <AppTopBar />
          {page === 'home' && <PlaceholderPage kind="home" />}
          {page === 'realtime' && <PlaceholderPage kind="realtime" />}
          {page === 'transcribe' && <TranscribePage />}
          {page === 'history' && <HistoryPage />}
          {page === 'summary' && <SummaryPage />}
          {page === 'events' && <PlaceholderPage kind="events" />}
          {page === 'models' && <ModelsPage />}
          {page === 'settings' && <SettingsPage />}
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
