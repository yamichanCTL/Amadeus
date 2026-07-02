/**
 * Module-level singleton that owns the offline/quick-recognition (录音→转写)
 * lifecycle.
 *
 * This survives React component mount/unmount so that recognition continues
 * across page navigation — the user can switch to History/Settings while a
 * recording or transcription is in flight without interrupting it, and the
 * status overlay (managed by the Electron main process) keeps reflecting
 * recording/thinking/result. The global hotkey and the Transcribe page both
 * call the same toggle()/forceStop()/runTranscription() methods.
 *
 * Mirrors the lifecycle pattern of liveCaptionService.
 */

import { ASRApi, isAsyncResponse, type LLMOperation, type TranscribeOptions, type TranscribeResponse } from './api'
import { blobToBase64, captureSpeakerAudio, speechRecorder } from './audio'
import { liveCaptionService } from './liveCaption'
import { finishTelemetryTrace, recordTelemetryStage, startTelemetryTrace } from './telemetry'
import { useASRStore } from '@/store/useASRStore'

const terminalStatuses = new Set(['success', 'failed', 'cancelled'])

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) window.clearTimeout(timer)
  }
}

export function buildTranscribeOptions(): TranscribeOptions {
  const settings = useASRStore.getState().settings
  const options: TranscribeOptions = {
    engine: settings.offlineEngine,
    timeout_sec: settings.timeoutSec,
    language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
    whisper_model: settings.whisperModel,
    enable_punctuation: settings.enablePunctuation,
    enable_hotwords: true,
    allow_server_data_collection: settings.allowServerDataCollection,
    archive_dir: settings.archiveDir || undefined,
    user_id: settings.userId || undefined,
  }
  if ((settings.llmAutoPolish || settings.llmAutoTranslate) && settings.llmModel.trim() && settings.llmBaseUrl.trim() && settings.llmApiToken.trim()) {
    options.llm = {
      enable_polish: settings.llmAutoPolish,
      enable_translate: settings.llmAutoTranslate,
      target_language: settings.llmTargetLanguage || 'English',
      provider: settings.llmProvider,
      model: settings.llmModel,
      base_url: settings.llmBaseUrl,
      api_token: settings.llmApiToken,
      style: settings.llmStyle || undefined,
      prompt: settings.llmAutoPolish ? settings.llmPolishPrompt || undefined : undefined
    }
  }
  return options
}

/** Select the text the user explicitly asked the automatic enhancement path
 * to deliver. Raw ASR remains the lossless fallback when the LLM failed. */
export function selectDeliveryText(result: TranscribeResponse): string {
  const settings = useASRStore.getState().settings
  if (settings.llmAutoTranslate) {
    const translated = result.llm_outputs?.translate?.text?.trim()
    if (translated) return translated
  }
  if (settings.llmAutoPolish) {
    const polished = result.llm_outputs?.polish?.text?.trim()
    if (polished) return polished
  }
  return result.full_text.trim()
}

export class RecordingService {
  /** Set when a transcription starts; cleared on completion. Read by the UI. */
  taskStartedAt: Date | null = null
  taskEndedAt: Date | null = null

  private requestController: AbortController | null = null
  /** Monotonic ID incremented on each runTranscription call.
   *  deliverResult checks this to avoid a stale transcription's
   *  overlay update clobbering a newer transcription's state. */
  private transcriptionId = 0

  get isBusy(): boolean {
    const s = useASRStore.getState()
    return s.recordStatus !== 'idle'
      || ['uploading', 'processing', 'polling'].includes(s.transcribeStatus)
  }

  /** True when actively recording (microphone open). */
  get isRecording(): boolean {
    return useASRStore.getState().recordStatus === 'recording'
  }

  /** Re-arm the selected physical microphone for the next recording. */
  prepare() {
    const latest = useASRStore.getState().settings
    if (latest.inputSource === 'speaker' || latest.audioInputDeviceId === '__speaker_loopback__') return
    void speechRecorder.prepare(latest.audioInputDeviceId || undefined).catch(() => undefined)
  }

  /** Toggle recording on/off. When stopping, runs transcription and (if
   *  autoInject) injects/copies the result. Survives page navigation. */
  async toggle(autoInject = false): Promise<void> {
    const state = useASRStore.getState()

    // Stop path: a recording is in progress → stop, transcribe, inject.
    if (state.recordStatus === 'recording') {
      state.setRecordStatus('processing')
      await window.electronAPI?.showStatusOverlay('thinking', 0, '正在识别并准备输入文本')
      try {
        const { blob } = await speechRecorder.stop()
        // Skip empty/too-small recordings: a silent mic produces a tiny
        // WebM/Opus header without real audio. Sending this to the ASR
        // backend would either return a hallucinated result or an empty
        // string — either way the previous clipboard content could leak
        // through if injectText fails (Bug 1).
        if (blob.size < 800) {
          const s = useASRStore.getState()
          s.setTranscribeStatus('done')
          s.setError('')
          s.setRecordStatus('idle')
          await window.electronAPI?.showStatusOverlay('result', 0, '未检测到有效语音，请重试')
          this.prepare()
          return
        }
        await this.runTranscription(blob, `recording_${Date.now()}.webm`, autoInject)
      } catch (stopError) {
        // stop() can throw if the recorder was cancelled out from under us
        // (e.g. a previous forceStop). Without this guard the overlay would
        // be stuck on "thinking" forever — the original "卡在异常thinking" bug.
        const s = useASRStore.getState()
        s.setError(stopError instanceof Error ? stopError.message : '录音结束失败')
        s.setTranscribeStatus('error')
        await window.electronAPI?.hideStatusOverlay()
      } finally {
        const s = useASRStore.getState()
        s.setRecordStatus('idle')
        this.prepare()
      }
      return
    }

    // Start path: refuse if a transcription or live caption is already running.
    if (state.transcribeStatus === 'uploading' || state.transcribeStatus === 'processing'
      || state.transcribeStatus === 'polling' || state.liveCaptionStatus !== 'idle') return

    const settings = state.settings
    const setError = useASRStore.getState().setError
    setError('')
    useASRStore.getState().setRecordStatus('recording')
    try {
      void window.electronAPI?.captureTextTarget?.().catch(() => false)
      await window.electronAPI?.showStatusOverlay('recording', 0)

      const useSpeaker = settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__'
      let inputStream: MediaStream | undefined
      if (useSpeaker) {
        inputStream = await captureSpeakerAudio()
      }
      const preparedInput = useSpeaker ? undefined : speechRecorder.takePreparedStream(settings.audioInputDeviceId || undefined)

      await withTimeout(
        speechRecorder.start(
          useSpeaker ? undefined : (settings.audioInputDeviceId || undefined),
          inputStream || preparedInput,
          (level) => {
            if (useASRStore.getState().recordStatus === 'recording') {
              void window.electronAPI?.showStatusOverlay('recording', level)
            }
          }
        ),
        5000,
        '麦克风启动超时，请检查输入设备是否被其他软件独占'
      )
    } catch (recordError) {
      speechRecorder.cancel()
      useASRStore.getState().setRecordStatus('idle')
      const settingsNow = useASRStore.getState().settings
      const sourceLabel = (settingsNow.inputSource === 'speaker' || settingsNow.audioInputDeviceId === '__speaker_loopback__') ? '扬声器' : '麦克风'
      setError(recordError instanceof Error ? recordError.message : `无法启动${sourceLabel}录音`)
      await window.electronAPI?.hideStatusOverlay()
    }
  }

  /** Force-stop everything: recording, in-flight transcription, live caption. */
  async forceStop(): Promise<void> {
    speechRecorder.cancel()
    if (this.requestController) {
      this.requestController.abort(new DOMException('识别已强制停止', 'AbortError'))
      this.requestController = null
    }
    await liveCaptionService.stop()
    const state = useASRStore.getState()
    if (state.activeTaskId) {
      const api = new ASRApi(state.settings.serverUrl)
      await api.cancelTask(state.activeTaskId).catch(() => undefined)
    }
    state.setRecordStatus('idle')
    state.setTranscribeStatus('cancelled')
    this.taskEndedAt = new Date()
    state.setError('识别已强制停止，可立即重新开始')
    await Promise.all([
      window.electronAPI?.hideStatusOverlay(),
      window.electronAPI?.hideCaptionOverlay(),
    ])
    this.prepare()
  }

  /** Run an offline transcription on a pre-captured blob. Used by toggle()
   *  (after recording) and by the file-upload confirm flow. */
  async runTranscription(blob: Blob, filename: string, autoInject: boolean): Promise<void> {
    const controller = new AbortController()
    if (this.requestController) this.requestController.abort()
    this.requestController = controller
    // Bump the ID so any in-flight deliverResult from a previous
    // transcription becomes a no-op for overlay updates.
    const myId = ++this.transcriptionId
    const settings = useASRStore.getState().settings
    if (!settings.backendConfirmed || !settings.serverUrl.trim()) {
      const state = useASRStore.getState()
      state.setTranscribeStatus('error')
      state.setRecordStatus('idle')
      state.setError('未确认后端地址。请先在「设置」中输入后端 IP/地址并点击「确认」。')
      return
    }
    const api = new ASRApi(settings.serverUrl)
    const trace = startTelemetryTrace('asr', `文件 ASR · ${filename}`, settings.offlineEngine)
    recordTelemetryStage(trace, '用户确认开始')
    const s0 = useASRStore.getState()
    s0.setTranscribeStatus('uploading')
    s0.setError('')
    s0.setActiveTaskId(null)
    this.taskStartedAt = new Date()
    this.taskEndedAt = null
    try {
      recordTelemetryStage(trace, '上传请求发送', { detail: `${blob.size} bytes` })
      const response = await api.transcribe(blob, filename, buildTranscribeOptions(), { signal: controller.signal })
      recordTelemetryStage(trace, isAsyncResponse(response) ? '服务端已入队' : '识别响应接收')
      const s1 = useASRStore.getState()
      if (isAsyncResponse(response)) s1.setActiveTaskId(response.task_id)
      const result = isAsyncResponse(response) ? await this.pollTask(api, response.task_id, controller.signal) : response
      useASRStore.getState().setActiveTaskId(null)
      recordTelemetryStage(trace, '自动回填开始')
      const deliveryPromise = this.deliverResult(result, autoInject, myId).then(() => {
        recordTelemetryStage(trace, '自动回填完成')
      })
      if (result.timing) {
        const timingLabels: Record<string, string> = {
          upload_read_sec: '后端读取上传',
          audio_probe_sec: '音频探测',
          task_create_sec: '任务创建',
          model_ready_sec: '模型就绪',
          asr_sec: 'ASR 推理',
          punctuation_sec: '标点恢复',
          hotword_sec: '热词处理',
          llm_sec: 'LLM 后处理',
          persist_sec: '结果持久化',
        }
        const backendStages = Object.entries(timingLabels).map(([key, label]) => ({
          label,
          durationMs: Number(result.timing?.[key]) * 1000,
        })).filter((stage) => Number.isFinite(stage.durationMs) && stage.durationMs >= 0)
        let backendCursorMs = Math.max(
          0,
          performance.now() - trace.startedAt - backendStages.reduce((sum, stage) => sum + stage.durationMs, 0),
        )
        for (const { label, durationMs } of backendStages) {
          backendCursorMs += durationMs
          recordTelemetryStage(trace, label, { durationMs, backendMs: durationMs, offsetMs: backendCursorMs })
        }
      }
      // Run persist and delivery in parallel — persist updates local state,
      // delivery injects text to foreground window. They don't depend on each other.
      await Promise.all([this.persistResult(result, filename, blob), deliveryPromise])
      recordTelemetryStage(trace, '前端归档与展示')
      finishTelemetryTrace(trace, `${result.full_text.length} 字`)
    } catch (transcribeError) {
      const s = useASRStore.getState()
      if (controller.signal.aborted || (transcribeError instanceof DOMException && transcribeError.name === 'AbortError')) {
        s.setTranscribeStatus('cancelled')
        s.setError('识别已强制停止')
        finishTelemetryTrace(trace, '用户强制停止', 'error')
      } else {
        s.setTranscribeStatus('error')
        s.setError(transcribeError instanceof Error ? transcribeError.message : '转写失败')
        finishTelemetryTrace(trace, transcribeError instanceof Error ? transcribeError.message : '识别失败', 'error')
      }
      // 出错或取消时隐藏状态覆盖层 — 但仅当本转录仍是最新的才操作浮层，
      // 避免旧转录的 catch 块覆盖新转录刚显示的浮层。
      if (this.transcriptionId === myId) {
        await window.electronAPI?.hideStatusOverlay()
      }
    } finally {
      if (this.requestController === controller) this.requestController = null
      useASRStore.getState().setActiveTaskId(null)
    }
  }

  private async pollTask(api: ASRApi, taskId: string, signal: AbortSignal) {
    const settings = useASRStore.getState().settings
    useASRStore.getState().setTranscribeStatus('polling')
    const startedAt = Date.now()
    const timeoutMs = settings.timeoutSec === 0 ? 30 * 60 * 1000 : settings.timeoutSec * 1000
    let pollCount = 0
    while (Date.now() - startedAt < timeoutMs) {
      if (signal.aborted) throw new DOMException('识别已强制停止', 'AbortError')
      // Adaptive polling: start at 200ms for first 5 polls (detect fast completions),
      // then back off to 500ms, then 1000ms for long-running tasks
      const interval = pollCount < 5 ? 200 : pollCount < 15 ? 500 : 1000
      pollCount++
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, interval)
        signal.addEventListener('abort', () => {
          window.clearTimeout(timer)
          reject(new DOMException('识别已强制停止', 'AbortError'))
        }, { once: true })
      })
      const result = await api.task(taskId, signal)
      if (terminalStatuses.has(result.status)) return result
    }
    throw new Error('任务超时')
  }

  private async deliverResult(result: TranscribeResponse, autoInject: boolean, myId: number) {
    const settings = useASRStore.getState().settings
    const deliveryText = selectDeliveryText(result)
    const hasText = deliveryText.length > 0

    // If a newer transcription has started while we were waiting for
    // injectText, don't touch the overlay — the newer transcription owns it.
    const isStale = () => this.transcriptionId !== myId

    if (autoInject && settings.injectMode === 'inject') {
      if (!hasText) {
        if (!isStale()) await window.electronAPI?.showStatusOverlay('result', 0, '未识别到语音内容')
        return
      }
      try {
        const injected = await window.electronAPI?.injectText(deliveryText)
        if (isStale()) return // newer transcription already took over
        if (injected === false) {
          await window.electronAPI?.showStatusOverlay('result', 0, deliveryText)
        } else {
          await window.electronAPI?.hideStatusOverlay()
        }
      } catch {
        if (!isStale()) await window.electronAPI?.showStatusOverlay('result', 0, deliveryText)
      }
    } else if (autoInject && settings.injectMode === 'copy') {
      if (hasText) window.electronAPI?.textToClipboard(deliveryText)
      if (!isStale()) await window.electronAPI?.showStatusOverlay('result', 0, hasText ? deliveryText : '未识别到语音内容')
    } else if (!autoInject) {
      if (hasText) window.electronAPI?.textToClipboard(deliveryText)
      if (!isStale()) await window.electronAPI?.hideStatusOverlay()
    }
  }

  private async persistResult(result: TranscribeResponse, filename: string, blob: Blob) {
    const settings = useASRStore.getState().settings
    const audio_url = URL.createObjectURL(blob)
    const resultWithAudio = { ...result, audio_url }
    const s = useASRStore.getState()
    s.setCurrentResult(resultWithAudio)
    s.setTranscribeStatus('done')
    s.setError('')
    this.taskEndedAt = new Date()

    useASRStore.getState().addHistory({
      ...resultWithAudio,
      id: result.task_id,
      created_at: new Date().toISOString(),
      filename,
      archived_audio: '',
      archived_json: ''
    })

    // This is a user-local Electron archive, not server-side debug retention.
    // The server privacy toggle is enforced by the backend request paths.
    void this.archiveResult(result, filename, blob, settings.archiveDir || undefined)
  }

  private async archiveResult(result: TranscribeResponse, filename: string, blob: Blob, archiveDir?: string) {
    try {
      const archiveRoot = archiveDir || (await window.electronAPI?.getDefaultArchiveDir()) || ''
      const archived = await window.electronAPI?.archiveTranscription({
        archiveRoot,
        taskId: result.task_id,
        filename,
        audioBase64: await blobToBase64(blob),
        audioExtension: filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '.webm',
        metadata: {
          task_id: result.task_id,
          filename,
          full_text: result.full_text,
          segments: result.segments,
          language: result.language,
          engine_used: result.engine_used,
          confidence: result.confidence,
          duration_sec: result.duration_sec,
          elapsed_sec: result.elapsed_sec,
          timing: result.timing,
          client_timing: result.client_timing,
          user_id: useASRStore.getState().settings.userId || undefined
        }
      })
      const archived_audio = archived?.audio || ''
      const archived_json = archived?.json || ''
      useASRStore.getState().updateHistoryResult(result.task_id, { archived_audio, archived_json } as Partial<TranscribeResponse>)
      const current = useASRStore.getState().currentResult
      if (current?.task_id === result.task_id) {
        useASRStore.getState().setCurrentResult({ ...current, archived_audio, archived_json } as TranscribeResponse)
      }
    } catch (archiveError) {
      console.warn(archiveError)
    }
  }
}

export const recordingService = new RecordingService()
