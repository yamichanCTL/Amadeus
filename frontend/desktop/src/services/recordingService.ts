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
import { audioRelayMixer, blobToBase64, captureSpeakerAudio, speechRecorder } from './audio'
import { liveCaptionService } from './liveCaption'
import { finishTelemetryTrace, recordTelemetryStage, startTelemetryTrace } from './telemetry'
import { useASRStore } from '@/store/useASRStore'

const terminalStatuses = new Set(['success', 'failed', 'cancelled'])

function translationConfig() {
  const settings = useASRStore.getState().settings
  return {
    provider: settings.translationProvider || settings.llmProvider,
    model: settings.translationModel.trim() || settings.llmModel,
    baseUrl: settings.translationBaseUrl.trim() || settings.llmBaseUrl,
    apiToken: settings.translationApiToken.trim() || settings.llmApiToken
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
  const translate = translationConfig()
  const onlyTranslate = settings.llmAutoTranslate && !settings.llmAutoPolish
  const autoModel = onlyTranslate ? translate.model : settings.llmModel
  const autoBaseUrl = onlyTranslate ? translate.baseUrl : settings.llmBaseUrl
  const autoToken = onlyTranslate ? translate.apiToken : settings.llmApiToken
  const autoProvider = onlyTranslate ? translate.provider : settings.llmProvider
  if ((settings.llmAutoPolish || settings.llmAutoTranslate) && autoModel.trim() && autoBaseUrl.trim() && autoToken.trim()) {
    options.llm = {
      enable_polish: settings.llmAutoPolish,
      enable_translate: settings.llmAutoTranslate,
      target_language: settings.llmTargetLanguage || 'English',
      provider: autoProvider,
      model: autoModel,
      base_url: autoBaseUrl,
      api_token: autoToken,
      style: settings.llmStyle || undefined
    }
  }
  return options
}

export { translationConfig }

class RecordingService {
  /** Set when a transcription starts; cleared on completion. Read by the UI. */
  taskStartedAt: Date | null = null
  taskEndedAt: Date | null = null

  private requestController: AbortController | null = null

  get isBusy(): boolean {
    const s = useASRStore.getState()
    return s.recordStatus !== 'idle'
      || ['uploading', 'processing', 'polling'].includes(s.transcribeStatus)
  }

  /** True when actively recording (microphone open). */
  get isRecording(): boolean {
    return useASRStore.getState().recordStatus === 'recording'
  }

  /** Re-arm the microphone for the next recording (unless relay/speaker mode). */
  prepare() {
    const latest = useASRStore.getState().settings
    if (latest.audioRelayEnabled || audioRelayMixer.isActive()) return
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
    try {
      await window.electronAPI?.showStatusOverlay('recording', 0)
      const relayInput = audioRelayMixer.isActive() ? audioRelayMixer.createInputStream() : undefined

      const useSpeaker = settings.inputSource === 'speaker' || settings.audioInputDeviceId === '__speaker_loopback__'
      let inputStream: MediaStream | undefined = relayInput
      if (!inputStream && useSpeaker) {
        inputStream = await captureSpeakerAudio()
      }

      await speechRecorder.start(
        useSpeaker ? undefined : (settings.audioInputDeviceId || undefined),
        inputStream,
        (level) => {
          void window.electronAPI?.showStatusOverlay('recording', level)
        }
      )
      useASRStore.getState().setRecordStatus('recording')
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
    const settings = useASRStore.getState().settings
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
      useASRStore.getState().setActiveTaskId(null)
      await this.persistResult(result, filename, blob, autoInject)
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
      // 出错或取消时隐藏状态覆盖层
      await window.electronAPI?.hideStatusOverlay()
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
    while (Date.now() - startedAt < timeoutMs) {
      if (signal.aborted) throw new DOMException('识别已强制停止', 'AbortError')
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(resolve, 1000)
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

  private async persistResult(result: TranscribeResponse, filename: string, blob: Blob, autoInject: boolean) {
    const settings = useASRStore.getState().settings
    const audio_url = URL.createObjectURL(blob)
    const resultWithAudio = { ...result, audio_url }
    const s = useASRStore.getState()
    s.setCurrentResult(resultWithAudio)
    s.setTranscribeStatus('done')
    s.setError('')
    this.taskEndedAt = new Date()

    let archived_audio = ''
    let archived_json = ''
    try {
      const archiveRoot = settings.archiveDir || (await window.electronAPI?.getDefaultArchiveDir()) || ''
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
          user_id: settings.userId || undefined
        }
      })
      archived_audio = archived?.audio || ''
      archived_json = archived?.json || ''
    } catch (archiveError) {
      console.warn(archiveError)
    }

    useASRStore.getState().addHistory({
      ...resultWithAudio,
      id: result.task_id,
      created_at: new Date().toISOString(),
      filename,
      archived_audio,
      archived_json
    })

    const hasText = result.full_text.trim().length > 0

    if (autoInject && settings.injectMode === 'inject') {
      // Guard: don't inject empty text — it would clear the clipboard and
      // leak the previous ASR result if the PowerShell script fails (Bug 1).
      if (!hasText) {
        await window.electronAPI?.showStatusOverlay('result', 0, '未识别到语音内容')
        return
      }
      try {
        const injected = await window.electronAPI?.injectText(result.full_text)
        if (injected === false) {
          await window.electronAPI?.showStatusOverlay('result', 0, result.full_text)
        } else {
          await window.electronAPI?.hideStatusOverlay()
        }
      } catch {
        await window.electronAPI?.showStatusOverlay('result', 0, result.full_text)
      }
    } else if (autoInject && settings.injectMode === 'copy') {
      await window.electronAPI?.textToClipboard(result.full_text)
      await window.electronAPI?.showStatusOverlay('result', 0, hasText ? result.full_text : '未识别到语音内容')
    } else if (!autoInject) {
      if (hasText) await window.electronAPI?.textToClipboard(result.full_text)
      await window.electronAPI?.hideStatusOverlay()
    }
  }
}

export const recordingService = new RecordingService()
