/**
 * Module-level singleton that owns the streaming ASR client lifecycle.
 *
 * This survives React component mount/unmount so live caption continues
 * across page navigation.  Toggle points (UI button, tray menu) both
 * call the same start()/stop()/toggle() methods.
 */

import { StreamingASRClient, speechRecorder, audioRelayMixer, captureSpeakerAudio } from './audio'
import { useASRStore, type UtteranceEntry } from '@/store/useASRStore'
import type { TranscribeResponse } from '@/services/api'

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${min}:${s}`
}

class LiveCaptionService {
  private streamer: StreamingASRClient | null = null
  private finalized = true

  get isActive(): boolean {
    return this.streamer !== null
  }

  async start(): Promise<void> {
    const state = useASRStore.getState()
    const { settings } = state

    if (this.streamer) return
    if (state.recordStatus !== 'idle') return
    if (state.transcribeStatus === 'uploading' || state.transcribeStatus === 'polling') return

    // Req: 未设置后端地址时不进行任何通信（不连 WebSocket、不回退本机）。
    if (!settings.backendConfirmed || !settings.serverUrl.trim()) {
      state.setLiveCaptionStatus('error')
      state.setError('未配置后端地址。请在「设置 → 后端地址」填写并点击「确认」后再开始实时识别。')
      return
    }

    // Reset transient state
    state.setLiveUtterances([])
    this.finalized = false
    state.setLiveCaptionStatus('connecting')

    // Requirement 2a: show caption overlay immediately
    if (settings.showDesktopCaptions) {
      await window.electronAPI?.showCaptionOverlay('正在聆听…', {
        fontSize: settings.captionFontSize,
        color: settings.captionFontColor,
        backgroundOpacity: settings.captionBackgroundOpacity,
        width: settings.captionBoxWidth,
        height: settings.captionBoxHeight,
        x: settings.captionBoxX,
        y: settings.captionBoxY,
      })
    }

    this.streamer = new StreamingASRClient(settings.serverUrl, (event) => {
      const s = useASRStore.getState()
      if (event.type === 'accepted') {
        // WebSocket accepted; model loading in progress
      }
      if (event.type === 'loading') {
        // Backend loading heartbeat
      }
      if (event.type === 'configured') {
        s.setLiveCaptionStatus('listening')
      }
      if (event.type === 'speech_start') {
        const entry: UtteranceEntry = { text: '', startedAt: new Date(), endedAt: null }
        s.setLiveUtterances([...s.liveUtterances, entry])
        s.setLiveCaptionStatus('transcribing')
      }
      if (event.type === 'partial') {
        this.updateUtterance(event.text)
        this.refreshCaptionOverlay()
      }
      if (event.type === 'final') {
        this.finalizeUtterance(event.text)
        this.refreshCaptionOverlay()
        s.setLiveCaptionStatus('listening')
      }
      if (event.type === 'error') {
        s.setLiveCaptionStatus('error')
        s.setError(event.message)
      }
      if (event.type === 'closed') {
        this.streamer = null
        this.saveToHistory()
      }
    })

    try {
      const useSpeaker = settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__'
      const preparedInput = useSpeaker
        ? await captureSpeakerAudio()
        : audioRelayMixer.isActive()
          ? audioRelayMixer.createInputStream()
          : speechRecorder.takePreparedStream(settings.audioInputDeviceId || undefined)

      await this.streamer.start({
        engine: settings.streamingEngine,
        language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
        deviceId: useSpeaker ? undefined : (settings.audioInputDeviceId || undefined),
        inputStream: preparedInput,
        userId: settings.userId || undefined,
        archive: settings.allowServerDataCollection,
      })
      state.updateSettings({ liveCaptionEnabled: true })
      window.electronAPI?.notifyLiveCaptionState(true)
    } catch (err) {
      this.streamer?.stop()
      this.streamer = null
      state.setLiveCaptionStatus('error')
      throw err
    }
  }

  async stop(): Promise<void> {
    if (!this.streamer) return
    const s = this.streamer
    this.streamer = null
    s.stop()
    await window.electronAPI?.hideCaptionOverlay()
    window.electronAPI?.notifyLiveCaptionState(false)
    this.saveToHistory()
  }

  async toggle(): Promise<void> {
    if (this.isActive) {
      await this.stop()
    } else {
      await this.start()
    }
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private updateUtterance(partial: string): void {
    const s = useASRStore.getState()
    const utterances = [...s.liveUtterances]
    const last = utterances.length - 1
    if (last < 0 || utterances[last].endedAt !== null) {
      utterances.push({ text: partial, startedAt: new Date(), endedAt: null })
    } else {
      utterances[last] = { ...utterances[last], text: partial }
    }
    s.setLiveUtterances(utterances)
  }

  private finalizeUtterance(text: string): void {
    const s = useASRStore.getState()
    const utterances = [...s.liveUtterances]
    const last = utterances.length - 1
    if (last >= 0 && utterances[last].endedAt === null) {
      utterances[last] = { ...utterances[last], text: text || utterances[last].text, endedAt: new Date() }
    } else if (text) {
      const now = new Date()
      utterances.push({ text, startedAt: now, endedAt: now })
    }
    s.setLiveUtterances(utterances)
  }

  private async refreshCaptionOverlay(): Promise<void> {
    const s = useASRStore.getState()
    if (!s.settings.showDesktopCaptions) return
    const lines = s.liveUtterances.map((u) => u.text).filter(Boolean)
    // Requirement 2d: only show the most recent 2 lines
    const display = lines.slice(-2).join('\n')
    await window.electronAPI?.showCaptionOverlay(display || '正在聆听…', {
      fontSize: s.settings.captionFontSize,
      color: s.settings.captionFontColor,
      backgroundOpacity: s.settings.captionBackgroundOpacity,
      width: s.settings.captionBoxWidth,
      height: s.settings.captionBoxHeight,
      x: s.settings.captionBoxX,
      y: s.settings.captionBoxY,
    })
  }

  private saveToHistory(): void {
    if (this.finalized) return
    this.finalized = true

    const s = useASRStore.getState()
    s.setLiveCaptionStatus('idle')
    s.updateSettings({ liveCaptionEnabled: false })

    const utterances = s.liveUtterances.filter((u) => u.text.trim())
    if (!utterances.length) return

    // Requirement 1: each utterance gets its own timestamp block
    const fullText = utterances
      .map((u) => {
        const start = formatTime(u.startedAt)
        const end = u.endedAt ? formatTime(u.endedAt) : formatTime(new Date())
        return `${start}  → ${end}\n${u.text}`
      })
      .join('\n\n')

    const result: TranscribeResponse = {
      task_id: `live_${Date.now()}`,
      status: 'success',
      full_text: fullText,
      segments: utterances.map((u) => ({
        text: u.text,
        start: u.startedAt.getTime() / 1000,
        end: (u.endedAt || new Date()).getTime() / 1000,
      })),
      language: s.settings.defaultLanguage,
      engine_used: s.settings.streamingEngine,
      confidence: null,
      duration_sec: null,
      elapsed_sec: null,
    }
    s.setCurrentResult(result)
    s.addHistory({
      ...result,
      id: result.task_id,
      created_at: new Date().toISOString(),
      filename: 'live_caption.pcm',
    })
  }
}

export const liveCaptionService = new LiveCaptionService()
