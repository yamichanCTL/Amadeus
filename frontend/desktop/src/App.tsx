import { useEffect, useMemo, useRef, useState } from 'react'
import { ASRApi } from '@/services/api'
import { registerTrigger } from '@/services/hotkey'
import { recordingService } from '@/services/recordingService'
import { useASRStore } from '@/store/useASRStore'
import { TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { StatusBar } from '@/components/StatusBar'
import { ActivityBar } from '@/components/ActivityBar'
import { PageBoundary } from '@/components/PageBoundary'
import { RealtimeAgentPage } from '@/pages/RealtimeAgent'
import { TranscribePage } from '@/pages/Transcribe'
import { HistoryPage } from '@/pages/History'
import { SummaryPage } from '@/pages/Summary'
import { SettingsPage } from '@/pages/Settings'
import { HomePage } from '@/pages/Home'
import { VoiceChangerPage } from '@/pages/VoiceChanger'
import { DebugConsolePage } from '@/pages/DebugConsole'
import { audioRelayMixer, runAudioRelayDeviceE2E, speechRecorder } from '@/services/audio'
import { liveCaptionService } from '@/services/liveCaption'
import { buildLocalSummaryRecords } from '@/services/summaryRecords'
import { saveSummaryToLocalLog } from '@/services/summaryLog'
import { useLocalRuntimeConnection } from '@/services/localRuntimeConnection'
import { resolveTaskLLM } from '@/services/taskModels'

const isE2EMode = new URLSearchParams(window.location.search).get('e2e') === '1'

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

export default function App() {
  useLocalRuntimeConnection()
  const contentRef = useRef<HTMLElement>(null)
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('amadeus.ui.sidebarCollapsed') === 'true' } catch { return false } })
  const toggleSidebar = () => setCollapsed((value) => { try { localStorage.setItem('amadeus.ui.sidebarCollapsed', String(!value)) } catch { /* Optional preference. */ } return !value })
  const page = useASRStore((state) => state.page)
  const settings = useASRStore((state) => state.settings)
  const setServerStatus = useASRStore((state) => state.setServerStatus)
  const serverStatus = useASRStore((state) => state.serverStatus)
  const setPage = useASRStore((state) => state.setPage)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const setPetCommand = useASRStore((state) => state.setPetCommand)
  const setError = useASRStore((state) => state.setError)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  useEffect(() => {
    contentRef.current?.scrollTo?.({ top: 0 })
    if (['realtime', 'transcribe', 'history', 'summary', 'voice'].includes(page)) {
      try { localStorage.setItem('amadeus.ui.lastTask', page) } catch { /* Optional preference. */ }
    }
  }, [page])

  // Older saved navigation and integrations can still request the retired hub.
  // Route them to task entry points instead of another copy of model editors.
  useEffect(() => { if (page === 'models') setPage('home') }, [page, setPage])

  useEffect(() => {
    const openLinkedPage = () => { if (['#realtime', '#meeting'].includes(window.location.hash)) setPage('realtime') }
    openLinkedPage()
    window.addEventListener('hashchange', openLinkedPage)
    return () => window.removeEventListener('hashchange', openLinkedPage)
  }, [setPage])

  useEffect(() => {
    let alive = true
    const check = async () => {
      const serverUrl = useASRStore.getState().settings.serverUrl
      const backendConfirmed = useASRStore.getState().settings.backendConfirmed
      // 用户未配置后端地址时不尝试连接，避免自动连接外网被拦截
      if (!backendConfirmed || !serverUrl) {
        if (alive) setServerStatus('disconnected')
        return
      }
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
  }, [api, setServerStatus, settings.backendConfirmed])

  useEffect(() => {
    const theme = settings.theme === 'windows' ? 'system' : settings.theme
    document.documentElement.dataset.theme = theme
    window.electronAPI?.setTheme(theme === 'system' ? 'system' : theme)
  }, [settings.theme])

  useEffect(() => {
    window.electronAPI?.setKeepRunningInBackground(settings.keepRunningInBackground)
  }, [settings.keepRunningInBackground])

  useEffect(() => {
    void window.electronAPI?.setPetEnabled(settings.agentPetEnabled)
  }, [settings.agentPetEnabled])

  useEffect(() => {
    const offEnabled = window.electronAPI?.onPetEnabledChanged((enabled) => updateSettings({ agentPetEnabled: enabled }))
    const offCommand = window.electronAPI?.onPetCommand((command) => {
      if (!['open', 'voice', 'text'].includes(command.type)) return
      setPetCommand(command)
      setPage('realtime')
    })
    return () => { offEnabled?.(); offCommand?.() }
  }, [setPage, setPetCommand, updateSettings])

  useEffect(() => {
    if (!isE2EMode) return
    window.__amadeusE2EAudio = runAudioRelayDeviceE2E
    return () => { delete window.__amadeusE2EAudio }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      const persistedUserId = await window.electronAPI?.getUserId().catch(() => '')
      if (!alive) return
      const storeUserId = useASRStore.getState().settings.userId
      if (persistedUserId) updateSettings({ userId: persistedUserId, passiveSummaryUserId: persistedUserId })
      else if (storeUserId) {
        updateSettings({ passiveSummaryUserId: storeUserId })
        await window.electronAPI?.saveUserId(storeUserId)
      }
    })()
    return () => { alive = false }
  }, [updateSettings])

  // Sync auto-launch status from OS on startup
  useEffect(() => {
    let alive = true
    void (async () => {
      const enabled = await window.electronAPI?.getAutoLaunch().catch(() => false)
      if (alive && typeof enabled === 'boolean') {
        updateSettings({ autoLaunchEnabled: enabled })
      }
    })()
    return () => { alive = false }
  }, [updateSettings])

  useEffect(() => {
    if (!settings.audioRelayEnabled) {
      audioRelayMixer.stop()
      return
    }
    if (settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__') {
      audioRelayMixer.stop()
      updateSettings({ audioRelayEnabled: false })
      return
    }
    void audioRelayMixer.start({
      inputDeviceId: settings.audioInputDeviceId || undefined,
      outputDeviceId: settings.audioOutputDeviceId || undefined,
    }).catch((relayError: unknown) => {
      setError(relayError instanceof Error ? `音频中转启动失败：${relayError.message}` : '音频中转启动失败')
    })
  }, [setError, settings.audioInputDeviceId, settings.audioOutputDeviceId, settings.audioRelayEnabled, settings.inputSource, updateSettings])

  useEffect(() => {
    if (isE2EMode) return
    // Navigation and preference changes must not cancel a running ASR task.
    // Its owning service handles stopping and re-arming the microphone.
    if (recordingService.isBusy || liveCaptionService.isActive) return
    if (page === 'realtime' && settings.agentRealtimeProvider !== 'off') {
      // Cancel also invalidates a pending getUserMedia prewarm request.
      speechRecorder.cancel()
      return
    }
    if (settings.audioRelayEnabled) {
      speechRecorder.cancel()
      return
    }
    // 扬声器模式下不需要预热麦克风
    if (settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__') {
      speechRecorder.cancel()
      return
    }
    void speechRecorder.prepare(settings.audioInputDeviceId || undefined).catch(() => undefined)
  }, [page, settings.agentRealtimeProvider, settings.audioInputDeviceId, settings.audioRelayEnabled, settings.inputSource])

  useEffect(() => () => {
    audioRelayMixer.stop()
    speechRecorder.cancel()
  }, [])

  useEffect(() => {
    if (isE2EMode) return
    registerTrigger(settings.triggerType, settings.triggerKey).catch(() => undefined)
    return () => {
      window.electronAPI?.unregisterHotkey()
      window.electronAPI?.unregisterMouseButton()
    }
  }, [settings.triggerType, settings.triggerKey])

  // Global hotkey: toggle recording directly via the singleton service so it
  // works regardless of which page is active. The old approach dispatched a
  // custom event consumed by the Transcribe page, which broke when the user
  // navigated away — recording got interrupted and the overlay stuck on
  // "thinking" (问题 4). Now recording survives page navigation.
  useEffect(() => window.electronAPI?.onHotkeyTriggered(() => {
    const state = useASRStore.getState()
    const processing = state.recordStatus === 'processing'
      || ['uploading', 'processing', 'polling'].includes(state.transcribeStatus)
      || state.liveCaptionStatus !== 'idle'
    if (processing) void recordingService.forceStop()
    else void recordingService.toggle(true)
  }), [])

  useEffect(() => {
    const offCancel = window.electronAPI?.onStatusRecognitionCancelled(() => {
      void recordingService.forceStop()
    })
    const offSubmit = window.electronAPI?.onStatusRecognitionSubmitted(() => {
      if (recordingService.isRecording) void recordingService.toggle(true)
    })
    return () => {
      offCancel?.()
      offSubmit?.()
    }
  }, [])

  useEffect(() => {
    const offClosed = window.electronAPI?.onCaptionOverlayClosed(() => {
      // The caption close button ends the current live-recognition session but
      // must not disable the user's persistent "show desktop captions" setting.
      if (liveCaptionService.isActive) {
        void liveCaptionService.stop()
      }
    })
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

  // Requirement 4c: tray icon toggle for live caption
  useEffect(() => {
    const off = window.electronAPI?.onLiveCaptionTrayToggle(() => {
      void liveCaptionService.toggle()
    })
    return () => off?.()
  }, [])

  useEffect(() => {
    if (!settings.passiveSummaryEnabled) return
    let stopped = false
    let running = false
    const runPassiveSummary = async () => {
      if (stopped || running) return
      const latest = useASRStore.getState().settings
      if (!latest.backendConfirmed || !latest.serverUrl.trim()) return
      if (!latest.passiveSummaryEnabled) return
      const summaryModel = resolveTaskLLM(latest, 'summary')
      if (!summaryModel.model.trim() || !summaryModel.baseUrl.trim() || !summaryModel.apiToken.trim()) return
      const now = new Date()
      if (!isWithinWindow(now, latest.passiveSummaryStartTime, latest.passiveSummaryEndTime)) return
      const lastAt = Date.parse(latest.passiveSummaryLastRunAt || '')
      const frequencyMs = Math.max(5, latest.passiveSummaryFrequencyMin || 60) * 60_000
      if (Number.isFinite(lastAt) && now.getTime() - lastAt < frequencyMs) return
      running = true
      const attemptedAt = now.toISOString()
      try {
        const records = latest.passiveSummarySource === 'server' ? undefined : buildLocalSummaryRecords(
          useASRStore.getState().history,
          {
            date: localDateValue(now),
            category: latest.passiveSummaryCategory,
            startTime: latest.passiveSummaryStartTime,
            endTime: latest.passiveSummaryEndTime,
          }
        )
        const summary = await api.streamArchiveSummary({
          date: localDateValue(now),
          user_id: latest.passiveSummaryUserId.trim() || undefined,
          category: latest.passiveSummaryCategory.trim() || undefined,
          start_time: latest.passiveSummaryStartTime || undefined,
          end_time: latest.passiveSummaryEndTime || undefined,
          provider: summaryModel.provider,
          model: summaryModel.model,
          base_url: summaryModel.baseUrl,
          api_token: summaryModel.apiToken,
          prompt: latest.summaryPrompt,
          style: latest.llmStyle || '工作纪要',
          max_input_chars: 24000,
          records,
        }, () => undefined)
        await saveSummaryToLocalLog(summary, latest.archiveDir)
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
    settings.passiveSummarySource,
    updateSettings
  ])

  return (
    <div className="win11-body">
      <TitleBar />
      <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
        <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
        <div className="workspace-column">
        <main className="content" ref={contentRef}>
          {page !== 'home' && page !== 'models' && page !== 'settings' && (!settings.serverUrl || !settings.backendConfirmed || serverStatus === 'disconnected') && (
            <section className="local-runtime-welcome" aria-label="本机环境快速开始">
              <div><strong>后端服务未连接</strong><p>运行环境与后端地址在首页统一管理，所有任务共用。</p></div>
              <button type="button" className="primary" onClick={() => setPage('home')}>前往首页</button>
            </section>
          )}
          <PageBoundary key={page} onHome={() => setPage('home')}>
          {page === 'home' && <HomePage />}
          {page === 'realtime' && <RealtimeAgentPage />}
          {page === 'transcribe' && <TranscribePage />}
          {page === 'history' && <HistoryPage />}
          {page === 'summary' && <SummaryPage />}
          {page === 'settings' && <SettingsPage />}
          {page === 'voice' && <VoiceChangerPage />}
          {page === 'debug' && <DebugConsolePage />}
          </PageBoundary>
        </main>
        <ActivityBar />
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
