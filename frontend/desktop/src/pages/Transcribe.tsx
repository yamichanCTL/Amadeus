import { useEffect, useMemo, useRef, useState } from 'react'
import { AssistantFigure } from '@/components/AssistantFigure'
import { AudioPlayer } from '@/components/AudioPlayer'
import { DropZone, type LocalAudioFile } from '@/components/DropZone'
import { RecordButton } from '@/components/RecordButton'
import { ASRApi, isAsyncResponse, type LLMOperation, type TranscribeOptions, type TranscribeResponse } from '@/services/api'
import { AudioRecorder, StreamingASRClient, blobToBase64 } from '@/services/audio'
import { finishTelemetryTrace, recordTelemetryStage, startTelemetryTrace } from '@/services/telemetry'
import { useASRStore } from '@/store/useASRStore'

const terminalStatuses = new Set(['success', 'failed', 'cancelled'])

function formatClock(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDateTime(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}:${s}`
}

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}:${min}:${s}`
}

function todayDate(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

interface UtteranceEntry {
  text: string
  startedAt: Date
  endedAt: Date | null
}

export function TranscribePage() {
  const settings = useASRStore((state) => state.settings)
  const transcribeStatus = useASRStore((state) => state.transcribeStatus)
  const recordStatus = useASRStore((state) => state.recordStatus)
  const liveCaptionStatus = useASRStore((state) => state.liveCaptionStatus)
  const currentResult = useASRStore((state) => state.currentResult)
  const activeTaskId = useASRStore((state) => state.activeTaskId)
  const error = useASRStore((state) => state.error)
  const setTranscribeStatus = useASRStore((state) => state.setTranscribeStatus)
  const setRecordStatus = useASRStore((state) => state.setRecordStatus)
  const setLiveCaptionStatus = useASRStore((state) => state.setLiveCaptionStatus)
  const setCurrentResult = useASRStore((state) => state.setCurrentResult)
  const setActiveTaskId = useASRStore((state) => state.setActiveTaskId)
  const setError = useASRStore((state) => state.setError)
  const addHistory = useASRStore((state) => state.addHistory)
  const updateHistoryResult = useASRStore((state) => state.updateHistoryResult)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const recorderRef = useRef(new AudioRecorder())
  const streamerRef = useRef<StreamingASRClient | null>(null)
  const utterancesRef = useRef<UtteranceEntry[]>([])
  const liveFinalizedRef = useRef(true)
  const [utterances, setUtterances] = useState<UtteranceEntry[]>([])
  const [liveStatusText, setLiveStatusText] = useState('准备连接')
  const [taskStartedAt, setTaskStartedAt] = useState<Date | null>(null)
  const [taskEndedAt, setTaskEndedAt] = useState<Date | null>(null)
  const [llmStatus, setLlmStatus] = useState<LLMOperation | 'idle'>('idle')
  const [pendingFiles, setPendingFiles] = useState<LocalAudioFile[]>([])

  const translationConfig = () => ({
    provider: settings.translationProvider || settings.llmProvider,
    model: settings.translationModel.trim() || settings.llmModel,
    baseUrl: settings.translationBaseUrl.trim() || settings.llmBaseUrl,
    apiToken: settings.translationApiToken.trim() || settings.llmApiToken
  })

  useEffect(() => {
    return window.electronAPI?.onHotkeyTriggered(() => {
      if (liveCaptionStatus === 'idle') void toggleRecording(true)
    })
  }, [liveCaptionStatus, recordStatus])

  const buildOptions = (): TranscribeOptions => {
    const options: TranscribeOptions = {
      engine: settings.offlineEngine,
      language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
      whisper_model: settings.whisperModel,
      enable_punctuation: settings.enablePunctuation,
      enable_hotwords: true,
      allow_server_data_collection: settings.allowServerDataCollection,
      archive_dir: settings.archiveDir || undefined
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

  const pollTask = async (taskId: string) => {
    setTranscribeStatus('polling')
    const startedAt = Date.now()
    const timeoutMs = settings.timeoutSec === 0 ? 30 * 60 * 1000 : settings.timeoutSec * 1000
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000))
      const result = await api.task(taskId)
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
          client_timing: result.client_timing
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
    if (settings.injectMode === 'inject' && autoInject) await window.electronAPI?.injectText(result.full_text)
  }

  const runTranscription = async (blob: Blob, filename: string, autoInject: boolean) => {
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
      const response = await api.transcribe(blob, filename, buildOptions())
      recordTelemetryStage(trace, isAsyncResponse(response) ? '服务端已入队' : '识别响应接收')
      const result = isAsyncResponse(response) ? await pollTask(response.task_id) : response
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
      setTranscribeStatus('error')
      setError(transcribeError instanceof Error ? transcribeError.message : '转写失败')
      finishTelemetryTrace(trace, transcribeError instanceof Error ? transcribeError.message : '识别失败', 'error')
    } finally {
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
      await window.electronAPI?.showStatusOverlay('processing')
      try {
        const { blob } = await recorderRef.current.stop()
        await runTranscription(blob, `recording_${Date.now()}.webm`, autoInject)
      } finally {
        setRecordStatus('idle')
      }
      return
    }

    if (transcribeStatus === 'uploading' || transcribeStatus === 'processing' || transcribeStatus === 'polling' || liveCaptionStatus !== 'idle') return
    setError('')
    try {
      await recorderRef.current.start(settings.audioInputDeviceId || undefined)
      setRecordStatus('recording')
      await window.electronAPI?.showStatusOverlay('recording')
    } catch (recordError) {
      recorderRef.current.cancel()
      setRecordStatus('idle')
      setError(recordError instanceof Error ? recordError.message : '无法启动麦克风录音')
      await window.electronAPI?.hideStatusOverlay()
    }
  }

  const showLiveCaption = async (partial = '') => {
    // Update the last utterance's text with the latest partial — avoids a
    // separate "识别中" article and the "（空）" placeholder.
    if (partial) {
      setUtterances((prev) => {
        const next = [...prev]
        const last = next.length - 1
        if (last >= 0 && next[last].endedAt === null) {
          next[last] = { ...next[last], text: partial }
        }
        utterancesRef.current = next
        return next
      })
    }
    // Desktop caption overlay: show last 4 lines (finalized + current)
    if (settings.showDesktopCaptions) {
      const lines = utterancesRef.current.map((u) => u.text).filter(Boolean)
      const display = lines.slice(-4).join('\n')
      await window.electronAPI?.showCaptionOverlay(display, {
        fontSize: settings.captionFontSize,
        color: settings.captionFontColor,
        backgroundOpacity: settings.captionBackgroundOpacity,
        width: settings.captionBoxWidth,
        height: settings.captionBoxHeight,
        x: settings.captionBoxX,
        y: settings.captionBoxY
      })
    }
  }

  const finalizeLiveCaption = () => {
    if (liveFinalizedRef.current) return
    liveFinalizedRef.current = true
    setLiveCaptionStatus('idle')
    setLiveStatusText('已停止')
    updateSettings({ liveCaptionEnabled: false })
    setTaskEndedAt(new Date())
    const text = utterancesRef.current.map((u) => u.text).filter(Boolean).join('\n').trim()
    if (!text) return
    const result: TranscribeResponse = {
      task_id: `live_${Date.now()}`,
      status: 'success',
      full_text: text,
      segments: [],
      language: settings.defaultLanguage,
      engine_used: settings.streamingEngine,
      confidence: null,
      duration_sec: null,
      elapsed_sec: null
    }
    setCurrentResult(result)
    addHistory({ ...result, id: result.task_id, created_at: new Date().toISOString(), filename: 'live_caption.pcm' })
  }

  const toggleLiveCaption = async () => {
    if (liveCaptionStatus !== 'idle') {
      setLiveCaptionStatus('stopping')
      setLiveStatusText('正在停止…')
      const streamer = streamerRef.current
      streamerRef.current = null
      streamer?.stop()
      await window.electronAPI?.hideCaptionOverlay()
      finalizeLiveCaption()
      return
    }

    if (recordStatus !== 'idle' || transcribeStatus === 'uploading' || transcribeStatus === 'polling') return
    utterancesRef.current = []
    setUtterances([])
    liveFinalizedRef.current = false
    setLiveCaptionStatus('connecting')
    setLiveStatusText('正在连接后端…')
    const sessionStartedAt = new Date()
    setTaskStartedAt(sessionStartedAt)
    setTaskEndedAt(null)
    streamerRef.current = new StreamingASRClient(settings.serverUrl, (event) => {
      if (event.type === 'accepted') setLiveStatusText('连接成功，等待模型加载…')
      if (event.type === 'loading') setLiveStatusText(event.message)
      if (event.type === 'ready') setLiveStatusText('模型已加载，正在预热…')
      if (event.type === 'configured') {
        setLiveCaptionStatus('listening')
        setLiveStatusText('连接成功，正在监听')
      }
      if (event.type === 'speech_start') {
        const entry: UtteranceEntry = { text: '', startedAt: new Date(), endedAt: null }
        setUtterances((prev) => {
          const next = [...prev, entry]
          utterancesRef.current = next
          return next
        })
        setLiveCaptionStatus('transcribing')
      }
      if (event.type === 'partial') void showLiveCaption(event.text)
      if (event.type === 'final') {
        setUtterances((prev) => {
          const next = [...prev]
          const last = next.length - 1
          if (last >= 0) {
            // text is already filled by successive partials; just stamp endedAt
            next[last] = { ...next[last], text: event.text || next[last].text, endedAt: new Date() }
          }
          utterancesRef.current = next
          return next
        })
        void showLiveCaption()
        setLiveCaptionStatus('listening')
      }
      if (event.type === 'error') {
        setError(event.message)
        setLiveStatusText(event.message)
        setLiveCaptionStatus('error')
      }
      if (event.type === 'closed') {
        streamerRef.current = null
        finalizeLiveCaption()
      }
    })
    await streamerRef.current.start({
      engine: settings.streamingEngine,
      language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
      deviceId: settings.audioInputDeviceId || undefined
    })
    updateSettings({ liveCaptionEnabled: true })
  }

  const cancelTask = async () => {
    if (!activeTaskId) return
    await api.cancelTask(activeTaskId)
    setTranscribeStatus('cancelled')
    setActiveTaskId(null)
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
              <span className="soft-badge">{todayDate()}</span>
              <span className="soft-badge">自动识别：{settings.defaultLanguage === 'auto' ? '自动' : settings.defaultLanguage}</span>
            </div>
            {liveCaptionStatus !== 'idle' ? (
              <div className="preview-transcript">
                {utterances.length === 0 ? (
                  <article>
                    <time>{taskStartedAt ? formatDateTime(taskStartedAt) : '--:--:--'}</time>
                    <strong>实时识别</strong>
                    <p>{liveStatusText}</p>
                  </article>
                ) : (
                  utterances.map((u, i) => {
                    const isLast = i === utterances.length - 1
                    const inProgress = isLast && u.endedAt === null
                    return (
                      <article key={i}>
                        <time>{formatDateTime(u.startedAt)} → {u.endedAt ? formatDateTime(u.endedAt) : '...'}</time>
                        <strong>{inProgress ? '识别中' : '实时识别'}</strong>
                        <p>{u.text || (inProgress ? '…' : '')}</p>
                      </article>
                    )
                  })
                )}
              </div>
            ) : currentResult ? (
              <div className="preview-transcript">
                <article>
                  <time>{taskStartedAt ? formatDateTime(taskStartedAt) : '--:--:--'}
                    {taskEndedAt ? ` → ${formatDateTime(taskEndedAt)}` : ''}
                  </time>
                  <strong>识别结果</strong>
                  <p>{currentResult.full_text || '暂无文本'}</p>
                </article>
                {currentResult.llm_outputs?.polish?.text && (
                  <article>
                    <time>AI</time>
                    <strong>智能润色</strong>
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
