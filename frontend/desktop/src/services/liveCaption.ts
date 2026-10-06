/**
 * Module-level singleton that owns the streaming ASR client lifecycle.
 *
 * This survives React component mount/unmount so live caption continues
 * across page navigation.  Toggle points (UI button, tray menu) both
 * call the same start()/stop()/toggle() methods.
 */

import { StreamingASRClient, speechRecorder, audioRelayMixer, blobToBase64, captureSpeakerAudio, type StreamRecording } from './audio'
import { useASRStore, type UtteranceEntry } from '@/store/useASRStore'
import type { TranscribeResponse } from '@/services/api'

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${min}:${s}`
}

export class LiveCaptionService {
  private streamer: StreamingASRClient | null = null
  private starting = false
  private session: { cancelled: boolean; capture: () => void } | null = null
  private sessionTaskId = ''
  private sessionSequence = 0
  private sessionOriginMs = 0

  get isActive(): boolean {
    return this.streamer !== null || this.starting
  }

  async start(): Promise<void> {
    const state = useASRStore.getState()
    const { settings } = state

    if (this.isActive) return
    if (state.recordStatus !== 'idle') return
    if (state.asrModelLoading || state.fileBatchRunning || ['uploading', 'processing', 'polling'].includes(state.transcribeStatus)) return

    // Req: 未设置后端地址时不进行任何通信（不连 WebSocket、不回退本机）。
    if (!settings.backendConfirmed || !settings.serverUrl.trim()) {
      state.setLiveCaptionStatus('error')
      state.setError('未配置后端地址。请先在首页启动本机服务，或连接已有后端，再开始实时识别。')
      return
    }

    // A session token invalidates every awaited stage, including overlay and input capture.
    const session = { cancelled: false, capture: () => {} }
    this.session = session
    this.starting = true
    const isCurrent = () => this.session === session && !session.cancelled
    let client: StreamingASRClient | null = null
    let snapshot: ReturnType<LiveCaptionService['captureSnapshot']> | null = null
    let finalized = false
    session.capture = () => { snapshot ||= this.captureSnapshot() }
    state.setLiveUtterances([])
    this.sessionTaskId = `live_${Date.now()}_${++this.sessionSequence}`
    this.sessionOriginMs = Date.now()
    state.setLiveCaptionStatus('connecting')

    try {
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
      if (!isCurrent()) {
        if (this.session === session) await window.electronAPI?.hideCaptionOverlay()
        return
      }

      client = new StreamingASRClient(settings.serverUrl, (event) => {
        // A stopped client may report its recording later. Archive the captured old
        // session without changing a newer session's text, status or current result.
        if (event.type === 'closed') {
          if (finalized) return
          finalized = true
          session.cancelled = true
          const current = this.session === session
          if (current) { this.streamer = null; this.starting = false }
          this.saveToHistory(event.recording, snapshot || this.captureSnapshot(), current)
          return
        }
        if (!isCurrent()) return
        const currentState = useASRStore.getState()
        if (event.type === 'configured') {
          this.sessionOriginMs = Date.now()
          currentState.setLiveCaptionStatus('listening')
        }
        if (event.type === 'speech_start') {
          const entry: UtteranceEntry = { text: '', startedAt: new Date(), endedAt: null }
          currentState.setLiveUtterances([...currentState.liveUtterances, entry])
          currentState.setLiveCaptionStatus('transcribing')
        }
        if (event.type === 'partial') { this.updateUtterance(event.text); void this.refreshCaptionOverlay() }
        if (event.type === 'final') {
          this.finalizeUtterance(event.text)
          this.syncCurrentResult()
          void this.refreshCaptionOverlay()
          currentState.setLiveCaptionStatus('listening')
        }
        if (event.type === 'error') { currentState.setLiveCaptionStatus('error'); currentState.setError(event.message) }
      })
      this.streamer = client
      const useSpeaker = settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__'
      const preparedInput = useSpeaker
        ? await captureSpeakerAudio()
        : audioRelayMixer.isActive()
          ? audioRelayMixer.createInputStream()
          : speechRecorder.takePreparedStream(settings.audioInputDeviceId || undefined)
      if (!isCurrent()) {
        preparedInput?.getTracks().forEach(track => track.stop())
        return
      }
      await client.start({
        engine: settings.streamingEngine,
        language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
        deviceId: useSpeaker ? undefined : (settings.audioInputDeviceId || undefined),
        inputStream: preparedInput,
        userId: settings.userId || undefined,
        archive: settings.allowServerDataCollection,
      })
      if (!isCurrent()) { client.stop(); return }
      state.updateSettings({ liveCaptionEnabled: true })
      window.electronAPI?.notifyLiveCaptionState(true)
    } catch (err) {
      if (!isCurrent()) { client?.stop(); return }
      session.capture()
      client?.stop()
      this.streamer = null
      state.setLiveCaptionStatus('error')
      throw err
    } finally {
      if (this.session === session) this.starting = false
    }
  }

  async stop(): Promise<void> {
    const session = this.session
    session?.capture()
    if (session) session.cancelled = true
    this.starting = false
    const client = this.streamer
    this.streamer = null
    client?.stop()
    const state = useASRStore.getState()
    state.setLiveCaptionStatus('idle')
    state.updateSettings({ liveCaptionEnabled: false })
    await window.electronAPI?.hideCaptionOverlay()
    if (this.session === session && !this.isActive) window.electronAPI?.notifyLiveCaptionState(false)
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

  private buildCurrentResult(): TranscribeResponse {
    const s = useASRStore.getState()
    const utterances = s.liveUtterances.filter((u) => u.text.trim())
    const fullText = utterances
      .map((u) => {
        const start = formatTime(u.startedAt)
        const end = u.endedAt ? formatTime(u.endedAt) : formatTime(new Date())
        return `${start}  → ${end}\n${u.text}`
      })
      .join('\n\n')
    return {
      task_id: this.sessionTaskId || `live_${Date.now()}`,
      status: 'success',
      full_text: fullText,
      segments: utterances.map((u) => ({
        text: u.text,
        start: Math.max(0, (u.startedAt.getTime() - this.sessionOriginMs) / 1000),
        end: Math.max(0, ((u.endedAt || new Date()).getTime() - this.sessionOriginMs) / 1000),
      })),
      language: s.settings.defaultLanguage,
      engine_used: s.settings.streamingEngine,
      confidence: null,
      duration_sec: null,
      elapsed_sec: null,
    }
  }

  private syncCurrentResult() {
    const result = this.buildCurrentResult()
    if (result.full_text) useASRStore.getState().setCurrentResult(result)
  }

  private captureSnapshot() {
    const state = useASRStore.getState()
    return { result: this.buildCurrentResult(), utterances: state.liveUtterances.filter(u => u.text.trim()), settings: state.settings }
  }

  private saveToHistory(recording: StreamRecording | null, snapshot: ReturnType<LiveCaptionService['captureSnapshot']>, currentSession: boolean): void {
    const s = useASRStore.getState()
    if (currentSession) {
      s.setLiveCaptionStatus('idle')
      s.updateSettings({ liveCaptionEnabled: false })
    }
    const { utterances, settings } = snapshot
    const result = { ...snapshot.result, duration_sec: recording?.durationSec || null }
    if (utterances.length) {
      if (currentSession) s.setCurrentResult(result)
      s.addHistory({
        ...result,
        id: result.task_id,
        created_at: new Date().toISOString(),
        filename: 'live_caption.wav',
      })
    }
    const first = utterances[0]
    const last = utterances[utterances.length - 1]
    void (async () => {
      const archived = await window.electronAPI?.archiveTranscription({
        archiveRoot: settings.archiveDir || undefined,
        archiveCategory: '实时识别',
        taskId: result.task_id,
        filename: 'live_caption.wav',
        audioBase64: recording ? await blobToBase64(recording.blob) : undefined,
        audioExtension: '.wav',
        metadata: {
          task_id: result.task_id,
          filename: 'live_caption.wav',
          full_text: result.full_text,
          segments: result.segments,
          language: result.language,
          engine_used: result.engine_used,
          duration_sec: result.duration_sec,
          sample_rate: recording?.sampleRate,
          samples: recording?.samples,
          user_id: settings.userId || undefined,
          category: '实时转录',
          type: '实时转录',
          spoken_at: {
            start: first?.startedAt.toISOString() || new Date().toISOString(),
            end: (last?.endedAt || new Date()).toISOString(),
          },
        },
      })
      if (!archived) return
      const update = { archived_audio: archived.audio || '', archived_json: archived.json } as Partial<TranscribeResponse>
      s.updateHistoryResult(result.task_id, update)
      const current = useASRStore.getState().currentResult
      if (current?.task_id === result.task_id) s.setCurrentResult({ ...current, ...update } as TranscribeResponse)
    })().catch((archiveError) => console.warn(archiveError))
  }
}

export const liveCaptionService = new LiveCaptionService()
