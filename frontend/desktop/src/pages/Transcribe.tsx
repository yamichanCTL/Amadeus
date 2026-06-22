import { useEffect, useMemo, useRef, useState } from 'react'
import { AssistantFigure } from '@/components/AssistantFigure'
import { AudioPlayer } from '@/components/AudioPlayer'
import { DropZone, type LocalAudioFile } from '@/components/DropZone'
import { RecordButton } from '@/components/RecordButton'
import { ASRApi, isAsyncResponse, type LLMOperation, type TranscribeOptions, type TranscribeResponse } from '@/services/api'
import { audioRelayMixer, blobToBase64, speechRecorder } from '@/services/audio'
import { liveCaptionService } from '@/services/liveCaption'
import { finishTelemetryTrace, recordTelemetryStage, startTelemetryTrace } from '@/services/telemetry'
import { useASRStore, type UtteranceEntry } from '@/store/useASRStore'

const terminalStatuses = new Set(['success', 'failed', 'cancelled'])

function formatClock(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${min}:${s}`
}

export function TranscribePage() {
  const settings = useASRStore((state) => state.settings)
  const transcribeStatus = useASRStore((state) => state.transcribeStatus)
  const recordStatus = useASRStore((state) => state.recordStatus)
  const liveCaptionStatus = useASRStore((state) => state.liveCaptionStatus)
  const currentResult = useASRStore((state) => state.currentResult)
  const activeTaskId = useASRStore((state) => state.activeTaskId)
  const error = useASRStore((state) => state.error)
  const utterances = useASRStore((state) => state.liveUtterances)
  const setTranscribeStatus = useASRStore((state) => state.setTranscribeStatus)
  const setRecordStatus = useASRStore((state) => state.setRecordStatus)
  const setCurrentResult = useASRStore((state) => state.setCurrentResult)
  const setActiveTaskId = useASRStore((state) => state.setActiveTaskId)
  const setError = useASRStore((state) => state.setError)
  const addHistory = useASRStore((state) => state.addHistory)
  const updateHistoryResult = useASRStore((state) => state.updateHistoryResult)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const recorderRef = useRef(speechRecorder)
  const requestControllerRef = useRef<AbortController | null>(null)
  const levelUpdateAtRef = useRef(0)
  const [taskStartedAt, setTaskStartedAt] = useState<Date | null>(null)
  const [taskEndedAt, setTaskEndedAt] = useState<Date | null>(null)
  const [llmStatus, setLlmStatus] = useState<LLMOperation | 'idle'>('idle')
  const [pendingFiles, setPendingFiles] = useState<LocalAudioFile[]>([])

  // Derive status text from liveCaptionStatus
  const liveStatusText = useMemo(() => {
    switch (liveCaptionStatus) {
      case 'idle': return '已停止'
      case 'connecting': return '正在连接后端…'
      case 'listening': return '连接成功，正在监听'
      case 'transcribing': return '转写中…'
      case 'stopping': return '正在停止…'
      case 'error': return '连接错误'
      default: return '准备连接'
    }
  }, [liveCaptionStatus])

  useEffect(() => {
    return () => {
      recorderRef.current.cancel()
      requestControllerRef.current?.abort()
      // NOTE: do NOT stop liveCaptionService here — it survives page navigation (Req 4b)
      const latest = useASRStore.getState().settings
      if (!latest.audioRelayEnabled && !liveCaptionService.isActive) {
        void recorderRef.current.prepare(latest.audioInputDeviceId || undefined).catch(() => undefined)
      }
    }
  }, [])

  const translationConfig = () => ({
    provider: settings.translationProvider || settings.llmProvider,
    model: settings.translationModel.trim() || settings.llmModel,
    baseUrl: settings.translationBaseUrl.trim() || settings.llmBaseUrl,
    apiToken: settings.translationApiToken.trim() || settings.llmApiToken
  })

  const prepareRecorder = () => {
    const latest = useASRStore.getState().settings
    if (latest.audioRelayEnabled || audioRelayMixer.isActive()) return
    void recorderRef.current.prepare(latest.audioInputDeviceId || undefined).catch(() => undefined)
  }

  useEffect(() => {
    const handleGlobalRecording = () => {
      const state = useASRStore.getState()
      const processing = state.recordStatus === 'processing'
        || ['uploading', 'processing', 'polling'].includes(state.transcribeStatus)
        || state.liveCaptionStatus !== 'idle'
      if (processing) void forceStop()
      else void toggleRecording(true)
    }
    window.addEventListener('amadeus:toggle-recording', handleGlobalRecording)
    return () => window.removeEventListener('amadeus:toggle-recording', handleGlobalRecording)
  })

  const buildOptions = (): TranscribeOptions => {
    const options: TranscribeOptions = {
      engine: settings.offlineEngine,
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

  const pollTask = async (taskId: string, signal: AbortSignal) => {
    setTranscribeStatus('polling')
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

  const persistResult = async (result: TranscribeResponse, filename: string, blob: Blob, autoInject: boolean) => {
    const audio_url = URL.createObjectURL(blob)
    const resultWithAudio = { ...result, audio_url }
    setCurrentResult(resultWithAudio)
    setTranscribeStatus('done')
    setError('')
    setTaskEndedAt(new Date())

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

    addHistory({
      ...resultWithAudio,
      id: result.task_id,
      created_at: new Date().toISOString(),
      filename,
      archived_audio,
      archived_json
    })

    if (settings.injectMode === 'copy' || !autoInject) await window.electronAPI?.textToClipboard(result.full_text)
    if (settings.injectMode === 'inject' && autoInject) {
      try {
        const injected = await window.electronAPI?.injectText(result.full_text)
        if (injected === false) setError('当前平台仅支持复制；识别文本已保存到剪贴板')
      } catch (injectError) {
        await window.electronAPI?.textToClipboard(result.full_text)
        setError(injectError instanceof Error ? injectError.message : '自动输入失败，文本已复制到剪贴板')
      }
    }
  }

  const runTranscription = async (blob: Blob, filename: string, autoInject: boolean) => {
    const controller = new AbortController()
    requestControllerRef.current?.abort()
    requestControllerRef.current = controller
    const trace = startTelemetryTrace('asr', `文件 ASR · ${filename}`, settings.offlineEngine)
    recordTelemetryStage(trace, '用户确认开始')
    setTranscribeStatus('uploading')
    setError('')
    setActiveTaskId(null)
    const startedAt = new Date()
    setTaskStartedAt(startedAt)
    setTaskEndedAt(null)
    try {
      recordTelemetryStage(trace, '上传请求发送', { detail: `${blob.size} bytes` })
      const response = await api.transcribe(blob, filename, buildOptions(), { signal: controller.signal })
      recordTelemetryStage(trace, isAsyncResponse(response) ? '服务端已入队' : '识别响应接收')
      if (isAsyncResponse(response)) setActiveTaskId(response.task_id)
      const result = isAsyncResponse(response) ? await pollTask(response.task_id, controller.signal) : response
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
      setActiveTaskId(null)
      await persistResult(result, filename, blob, autoInject)
      recordTelemetryStage(trace, '前端归档与展示')
      finishTelemetryTrace(trace, `${result.full_text.length} 字`)
    } catch (transcribeError) {
      if (controller.signal.aborted || (transcribeError instanceof DOMException && transcribeError.name === 'AbortError')) {
        setTranscribeStatus('cancelled')
        setError('识别已强制停止')
        finishTelemetryTrace(trace, '用户强制停止', 'error')
      } else {
        setTranscribeStatus('error')
        setError(transcribeError instanceof Error ? transcribeError.message : '转写失败')
        finishTelemetryTrace(trace, transcribeError instanceof Error ? transcribeError.message : '识别失败', 'error')
      }
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null
      setActiveTaskId(null)
      await window.electronAPI?.hideStatusOverlay()
    }
  }

  const handleFiles = (files: LocalAudioFile[]) => {
    setPendingFiles(files)
    setError('')
  }

  const confirmFiles = async () => {
    const files = pendingFiles
    if (!files.length) return
    setPendingFiles([])
    for (const file of files) {
      await runTranscription(file.blob, file.name, false)
    }
  }

  const toggleRecording = async (autoInject = false) => {
    if (recordStatus === 'recording') {
      setRecordStatus('processing')
      await window.electronAPI?.showStatusOverlay('thinking', 0, '正在识别并准备输入文本')
      try {
        const { blob } = await recorderRef.current.stop()
        await runTranscription(blob, `recording_${Date.now()}.webm`, autoInject)
      } finally {
        setRecordStatus('idle')
        prepareRecorder()
      }
      return
    }

    if (transcribeStatus === 'uploading' || transcribeStatus === 'processing' || transcribeStatus === 'polling' || liveCaptionStatus !== 'idle') return
    setError('')
    try {
      await window.electronAPI?.showStatusOverlay('recording', 0)
      const relayInput = audioRelayMixer.isActive() ? audioRelayMixer.createInputStream() : undefined
      await recorderRef.current.start(settings.audioInputDeviceId || undefined, relayInput, (level) => {
        const now = performance.now()
        if (now - levelUpdateAtRef.current < 70) return
        levelUpdateAtRef.current = now
        void window.electronAPI?.showStatusOverlay('recording', level)
      })
      setRecordStatus('recording')
    } catch (recordError) {
      recorderRef.current.cancel()
      setRecordStatus('idle')
      setError(recordError instanceof Error ? recordError.message : '无法启动麦克风录音')
      await window.electronAPI?.hideStatusOverlay()
    }
  }

  const forceStop = async () => {
    recorderRef.current.cancel()
    requestControllerRef.current?.abort(new DOMException('识别已强制停止', 'AbortError'))
    requestControllerRef.current = null
    await liveCaptionService.stop()
    if (activeTaskId) await api.cancelTask(activeTaskId).catch(() => undefined)
    setRecordStatus('idle')
    setTranscribeStatus('cancelled')
    setTaskEndedAt(new Date())
    setError('识别已强制停止，可立即重新开始')
    await Promise.all([
      window.electronAPI?.hideStatusOverlay(),
      window.electronAPI?.hideCaptionOverlay(),
    ])
    prepareRecorder()
  }

  const toggleLiveCaption = async () => {
    if (liveCaptionStatus !== 'idle') {
      // Delegate to singleton — it handles stop + history save
      await liveCaptionService.stop()
      setTaskEndedAt(new Date())
      return
    }

    if (recordStatus !== 'idle' || transcribeStatus === 'uploading' || transcribeStatus === 'polling') return
    const sessionStartedAt = new Date()
    setTaskStartedAt(sessionStartedAt)
    setTaskEndedAt(null)
    try {
      await liveCaptionService.start()
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : '实时识别启动失败')
    }
  }

  const processCurrentText = async (operation: LLMOperation) => {
    if (!currentResult?.full_text.trim()) return
    const translate = translationConfig()
    const model = operation === 'translate' ? translate.model : settings.llmModel
    const baseUrl = operation === 'translate' ? translate.baseUrl : settings.llmBaseUrl
    const apiToken = operation === 'translate' ? translate.apiToken : settings.llmApiToken
    const provider = operation === 'translate' ? translate.provider : settings.llmProvider
    if (!model.trim() || !baseUrl.trim() || !apiToken.trim()) {
      setError('请先在模型管理中填写对应模型接口、模型和 API Token')
      return
    }
    setLlmStatus(operation)
    setError('')
    try {
      const processed = await api.processText({
        text: currentResult.full_text,
        operation,
        model,
        base_url: baseUrl,
        api_token: apiToken,
        provider,
        target_language: settings.llmTargetLanguage || 'English',
        style: settings.llmStyle || undefined
      })
      const next: TranscribeResponse = {
        ...currentResult,
        llm_outputs: {
          ...(currentResult.llm_outputs || {}),
          [operation]: processed
        },
        llm_error: null
      }
      setCurrentResult(next)
      updateHistoryResult(next.task_id, { llm_outputs: next.llm_outputs, llm_error: null })
    } catch (processError) {
      setError(processError instanceof Error ? processError.message : '大模型处理失败')
    } finally {
      setLlmStatus('idle')
    }
  }

  return (
    <div className="page transcribe-page">
      <div className="transcribe-layout">
        <div className="transcribe-main">
          <section className="panel upload-panel">
            <div className="section-head">
              <div>
                <h1>语音识别</h1>
                <p>选择音频 / 视频文件后先确认，再开始识别，不会因拖放立即上传。</p>
              </div>
              <span className="soft-badge">{transcribeStatus === 'idle' ? '待识别' : transcribeStatus}</span>
            </div>
            <DropZone onFiles={handleFiles} />
            {pendingFiles.length > 0 && (
              <div className="pending-files" role="status">
                <div>
                  <strong>已选择 {pendingFiles.length} 个文件，等待确认</strong>
                  <span>{pendingFiles.map((file) => file.name).join('、')}</span>
                </div>
                <button type="button" onClick={() => setPendingFiles([])}>取消</button>
                <button type="button" className="primary" onClick={() => void confirmFiles()}>确认并开始识别</button>
              </div>
            )}
          </section>

          <section className="panel preview-panel">
            <div className="section-head compact">
              <h2>识别预览</h2>
              <span className="soft-badge">自动识别：{settings.defaultLanguage === 'auto' ? '自动' : settings.defaultLanguage}</span>
            </div>
            {liveCaptionStatus !== 'idle' ? (
              <div className="preview-transcript">
                {utterances.length === 0 ? (
                  <article>
                    <time>{taskStartedAt ? formatTime(taskStartedAt) : '--:--:--'}  → ...</time>
                    <p>{liveStatusText}</p>
                  </article>
                ) : (
                  utterances.map((u, i) => {
                    const isLast = i === utterances.length - 1
                    const inProgress = isLast && u.endedAt === null
                    return (
                      <article key={i}>
                        <time>{formatTime(u.startedAt)}  → {u.endedAt ? formatTime(u.endedAt) : '...'}</time>
                        <p>{u.text || (inProgress ? '…' : '')}</p>
                      </article>
                    )
                  })
                )}
              </div>
            ) : currentResult ? (
              <div className="preview-transcript">
                <article>
                  <time>{taskStartedAt ? formatTime(taskStartedAt) : '--:--:--'}
                    {taskEndedAt ? `  → ${formatTime(taskEndedAt)}` : '  → ...'}
                  </time>
                  <p>{currentResult.full_text || '暂无文本'}</p>
                </article>
                {currentResult.llm_outputs?.polish?.text && (
                  <article>
                    <time>AI</time>
                    <p>{currentResult.llm_outputs.polish.text}</p>
                  </article>
                )}
              </div>
            ) : (
              <div className="preview-transcript" />
            )}
            <div className="preview-footer">
              <div className="preview-actions">
                <button type="button" disabled={!currentResult} onClick={() => window.electronAPI?.textToClipboard(currentResult?.full_text || '')}>复制结果</button>
                <button type="button" disabled={!currentResult || llmStatus !== 'idle'} onClick={() => void processCurrentText('polish')}>
                  {llmStatus === 'polish' ? '润色中' : '润色'}
                </button>
                <button type="button" disabled={!currentResult || llmStatus !== 'idle'} onClick={() => void processCurrentText('translate')}>
                  {llmStatus === 'translate' ? '翻译中' : '翻译'}
                </button>
              </div>
              {currentResult && <AudioPlayer item={currentResult} />}
            </div>
          </section>
        </div>

        <aside className="transcribe-side">
          <section className="panel quick-settings">
            <div className="section-head compact">
              <h2>识别设置</h2>
              <button type="button" onClick={() => updateSettings({ enablePunctuation: true })}>恢复默认</button>
            </div>
            <div className="quick-grid">
              <button type="button" className="quick-tile">
                <span>🌐</span>
                <strong>识别语言</strong>
                <small>{settings.defaultLanguage === 'auto' ? '自动识别' : settings.defaultLanguage}</small>
              </button>
              <button type="button" className={settings.enablePunctuation ? 'quick-tile active' : 'quick-tile'} onClick={() => updateSettings({ enablePunctuation: !settings.enablePunctuation })}>
                <span>☉</span>
                <strong>标点恢复</strong>
                <small>{settings.enablePunctuation ? '已开启' : '未开启'}</small>
              </button>
              <button type="button" className={settings.llmAutoTranslate ? 'quick-tile active' : 'quick-tile'} onClick={() => updateSettings({ llmAutoTranslate: !settings.llmAutoTranslate })}>
                <span>文</span>
                <strong>翻译</strong>
                <small>{settings.llmAutoTranslate ? settings.llmTargetLanguage : '不翻译'}</small>
              </button>
            </div>
          </section>

          <div className="assistant-zone">
            <div className="assistant-bubble">
              <strong>我在这里协助你~</strong>
              <span>有什么需要帮忙的吗？</span>
            </div>
            <AssistantFigure className="assistant-figure" />
          </div>
        </aside>
      </div>

      <section className="dock-player">
        <div className="player-info">
          <span className="mini-wave large" aria-hidden="true" />
          <div>
            <strong>{liveCaptionStatus !== 'idle' ? liveStatusText : recordStatus === 'recording' ? '正在聆听...' : '准备识别'}</strong>
            <small>{liveCaptionStatus !== 'idle' ? `实时识别：${liveCaptionStatus}` : recordStatus === 'recording' ? '轻触结束识别' : '拖入文件或按下麦克风开始'}</small>
          </div>
        </div>
        <RecordButton onToggle={() => void toggleRecording(false)} />
        <button type="button" className={liveCaptionStatus !== 'idle' ? 'primary' : ''} onClick={() => void toggleLiveCaption()}>
          {liveCaptionStatus === 'idle' ? '实时识别' : '停止识别'}
        </button>
        {(recordStatus !== 'idle' || liveCaptionStatus !== 'idle' || ['uploading', 'processing', 'polling'].includes(transcribeStatus)) && (
          <button type="button" className="force-stop-button" onClick={() => void forceStop()}>强制停止</button>
        )}
        <div className="network-meter">
          <span />
          <strong>网络良好</strong>
          <small>{formatClock()}</small>
        </div>
      </section>

      {error && <p className="error floating-error">{error}</p>}
    </div>
  )
}
