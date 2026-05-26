import { useEffect, useMemo, useRef, useState } from 'react'
import { AssistantFigure } from '@/components/AssistantFigure'
import { DropZone, type LocalAudioFile } from '@/components/DropZone'
import { RecordButton } from '@/components/RecordButton'
import { ASRApi, isAsyncResponse, type LLMOperation, type TranscribeOptions, type TranscribeResponse } from '@/services/api'
import { AudioRecorder, AudioSegmentStreamer, blobToBase64 } from '@/services/audio'
import { useASRStore } from '@/store/useASRStore'

const terminalStatuses = new Set(['success', 'failed', 'cancelled'])

function formatClock(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(seconds?: number | null) {
  if (!seconds) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

export function TranscribePage() {
  const settings = useASRStore((state) => state.settings)
  const models = useASRStore((state) => state.models)
  const transcribeStatus = useASRStore((state) => state.transcribeStatus)
  const recordStatus = useASRStore((state) => state.recordStatus)
  const liveCaptionStatus = useASRStore((state) => state.liveCaptionStatus)
  const currentResult = useASRStore((state) => state.currentResult)
  const activeTaskId = useASRStore((state) => state.activeTaskId)
  const history = useASRStore((state) => state.history)
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
  const streamerRef = useRef<AudioSegmentStreamer | null>(null)
  const liveQueueRef = useRef<Blob[]>([])
  const liveProcessingRef = useRef(false)
  const [liveText, setLiveText] = useState('')
  const [llmStatus, setLlmStatus] = useState<LLMOperation | 'idle'>('idle')

  useEffect(() => {
    return window.electronAPI?.onHotkeyTriggered(() => {
      if (liveCaptionStatus === 'idle') void toggleRecording(true)
    })
  }, [liveCaptionStatus, recordStatus])

  const buildOptions = (): TranscribeOptions => {
    const loaded = models.filter((model) => model.is_loaded).map((model) => model.engine)
    const selected = settings.multiEngine ? settings.selectedEngines : [settings.defaultEngine]
    const engines = loaded.length ? selected.filter((engine) => loaded.includes(engine)) : selected
    const options: TranscribeOptions = {
      engines: engines.length ? engines : [settings.defaultEngine],
      language: settings.defaultLanguage === 'auto' ? undefined : settings.defaultLanguage,
      whisper_model: settings.whisperModel,
      enable_punctuation: settings.enablePunctuation,
      enable_diarize: settings.enableDiarize,
      merge_strategy: settings.mergeStrategy,
      allow_server_data_collection: settings.allowServerDataCollection,
      archive_dir: settings.archiveDir || undefined
    }
    if (
      (settings.llmAutoPolish || settings.llmAutoTranslate) &&
      settings.llmModel.trim() &&
      settings.llmBaseUrl.trim() &&
      settings.llmApiToken.trim()
    ) {
      options.llm = {
        enable_polish: settings.llmAutoPolish,
        enable_translate: settings.llmAutoTranslate,
        target_language: settings.llmTargetLanguage || 'English',
        model: settings.llmModel,
        base_url: settings.llmBaseUrl,
        api_token: settings.llmApiToken,
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
    setCurrentResult(result)
    setTranscribeStatus('done')
    setError('')

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
          engine_results: result.engine_results
        }
      })
      archived_audio = archived?.audio || ''
      archived_json = archived?.json || ''
    } catch (archiveError) {
      console.warn(archiveError)
    }

    addHistory({
      ...result,
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
    setTranscribeStatus('uploading')
    setError('')
    setActiveTaskId(null)
    try {
      const response = await api.transcribe(blob, filename, buildOptions())
      const result = isAsyncResponse(response) ? await pollTask(response.task_id) : response
      setActiveTaskId(null)
      await persistResult(result, filename, blob, autoInject)
    } catch (transcribeError) {
      setTranscribeStatus('error')
      setError(transcribeError instanceof Error ? transcribeError.message : '转写失败')
    } finally {
      setActiveTaskId(null)
      await window.electronAPI?.hideStatusOverlay()
    }
  }

  const handleFiles = async (files: LocalAudioFile[]) => {
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
    await recorderRef.current.start(settings.audioInputDeviceId || undefined)
    setRecordStatus('recording')
    await window.electronAPI?.showStatusOverlay('recording')
  }

  const processLiveQueue = async () => {
    if (liveProcessingRef.current || !liveQueueRef.current.length) return
    liveProcessingRef.current = true
    setLiveCaptionStatus('transcribing')
    const blob = liveQueueRef.current.shift()!
    try {
      const response = await api.transcribe(blob, `live_caption_${Date.now()}.webm`, buildOptions())
      const result = isAsyncResponse(response) ? await pollTask(response.task_id) : response
      const merged = `${liveText}\n${result.full_text}`.trim()
      setLiveText(merged)
      if (settings.showDesktopCaptions) {
        await window.electronAPI?.showCaptionOverlay(merged.split('\n').slice(-4).join('\n'), {
          fontSize: settings.captionFontSize,
          color: settings.captionFontColor,
          backgroundOpacity: settings.captionBackgroundOpacity,
          width: settings.captionBoxWidth,
          height: settings.captionBoxHeight,
          x: settings.captionBoxX,
          y: settings.captionBoxY
        })
      }
    } catch (liveError) {
      setError(liveError instanceof Error ? liveError.message : '实时字幕转写失败')
      setLiveCaptionStatus('error')
    } finally {
      liveProcessingRef.current = false
      if (liveCaptionStatus !== 'idle') setLiveCaptionStatus('listening')
      void processLiveQueue()
    }
  }

  const toggleLiveCaption = async () => {
    if (liveCaptionStatus !== 'idle') {
      streamerRef.current?.stop()
      streamerRef.current = null
      setLiveCaptionStatus('idle')
      updateSettings({ liveCaptionEnabled: false })
      await window.electronAPI?.hideCaptionOverlay()
      if (liveText.trim()) {
        const result: TranscribeResponse = {
          task_id: `live_${Date.now()}`,
          status: 'success',
          full_text: liveText.trim(),
          segments: [],
          language: settings.defaultLanguage,
          engine_used: 'live',
          confidence: null,
          duration_sec: null,
          elapsed_sec: null
        }
        setCurrentResult(result)
        addHistory({ ...result, id: result.task_id, created_at: new Date().toISOString(), filename: 'live_caption.webm' })
      }
      return
    }

    if (recordStatus !== 'idle' || transcribeStatus === 'uploading' || transcribeStatus === 'polling') return
    setLiveText('')
    liveQueueRef.current = []
    streamerRef.current = new AudioSegmentStreamer((blob) => {
      liveQueueRef.current = [...liveQueueRef.current, blob].slice(-3)
      void processLiveQueue()
    })
    await streamerRef.current.start(settings.inputSource === 'speaker' ? 'speaker' : 'microphone', settings.liveCaptionChunkSec, settings.audioInputDeviceId || undefined)
    setLiveCaptionStatus('listening')
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
    if (!settings.llmModel.trim() || !settings.llmBaseUrl.trim() || !settings.llmApiToken.trim()) {
      setError('请先在设置中填写大模型接口、模型和 API Token')
      return
    }
    setLlmStatus(operation)
    setError('')
    try {
      const processed = await api.processText({
        text: currentResult.full_text,
        operation,
        model: settings.llmModel,
        base_url: settings.llmBaseUrl,
        api_token: settings.llmApiToken,
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
                <h1>文件转写</h1>
                <p>支持音频 / 视频文件的批量转写，准确高效，轻松获取文字记录。</p>
              </div>
              <span className="soft-badge">{transcribeStatus === 'idle' ? '待转写' : transcribeStatus}</span>
            </div>
            <DropZone onFiles={handleFiles} />
          </section>

          <section className="panel recent-tasks-panel">
            <div className="section-head">
              <div>
                <h2>最近任务（5）</h2>
                <p>批量任务、队列状态和导出入口集中管理。</p>
              </div>
              <button type="button" onClick={() => window.electronAPI?.textToClipboard(currentResult?.full_text || '')} disabled={!currentResult}>
                复制最新
              </button>
            </div>
            <div className="task-table">
              <div className="task-row task-head">
                <span />
                <strong>文件名称</strong>
                <span>时长</span>
                <span>语言</span>
                <span>引擎</span>
                <span>状态</span>
              </div>
              {history.slice(0, 5).map((item, index) => (
                <article key={item.id} className="task-row">
                  <span className="play-dot">▶</span>
                  <strong>{item.filename}</strong>
                  <span>{formatDuration(item.duration_sec)}</span>
                  <span>{item.language || '自动'}</span>
                  <span>{item.engine_used}</span>
                  <span className="status-ok">{index === 0 ? '最新' : '已完成'}</span>
                </article>
              ))}
              {!history.length && (
                <p className="empty">拖入文件或开始录音后，任务会显示在这里。</p>
              )}
            </div>
          </section>
        </div>

        <aside className="transcribe-side">
          <section className="panel preview-panel">
            <div className="section-head compact">
              <h2>转写预览</h2>
              <span className="soft-badge">自动识别：{settings.defaultLanguage === 'auto' ? '自动' : settings.defaultLanguage}</span>
            </div>
            {currentResult ? (
              <div className="preview-transcript">
                <article>
                  <time>00:00:00</time>
                  <span className="speaker-dot blue" />
                  <strong>发言人 1</strong>
                  <p>{currentResult.full_text || '暂无文本'}</p>
                </article>
                {currentResult.llm_outputs?.polish?.text && (
                  <article>
                    <time>AI</time>
                    <span className="speaker-dot purple" />
                    <strong>智能润色</strong>
                    <p>{currentResult.llm_outputs.polish.text}</p>
                  </article>
                )}
              </div>
            ) : (
              <div className="preview-transcript sample">
                <article>
                  <time>00:00:00</time>
                  <span className="speaker-dot blue" />
                  <strong>发言人 1</strong>
                  <p>好的，大家早上好，今天我们主要讨论的是新产品的需求评审。</p>
                </article>
                <article>
                  <time>00:00:18</time>
                  <span className="speaker-dot purple" />
                  <strong>发言人 2</strong>
                  <p>这次新产品的定位是面向中小企业的协同办公工具。</p>
                </article>
              </div>
            )}
            <div className="preview-actions">
              <button type="button" disabled={!currentResult} onClick={() => window.electronAPI?.textToClipboard(currentResult?.full_text || '')}>复制结果</button>
              <button type="button" disabled={!currentResult || llmStatus !== 'idle'} onClick={() => void processCurrentText('polish')}>
                {llmStatus === 'polish' ? '润色中' : '润色'}
              </button>
              <button type="button" disabled={!currentResult || llmStatus !== 'idle'} onClick={() => void processCurrentText('translate')}>
                {llmStatus === 'translate' ? '翻译中' : '翻译'}
              </button>
            </div>
          </section>

          <section className="panel quick-settings">
            <div className="section-head compact">
              <h2>转写设置</h2>
              <button type="button" onClick={() => updateSettings({ enablePunctuation: true, enableDiarize: false })}>恢复默认</button>
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
              <button type="button" className={settings.enableDiarize ? 'quick-tile active' : 'quick-tile'} onClick={() => updateSettings({ enableDiarize: !settings.enableDiarize })}>
                <span>♟</span>
                <strong>说话人分离</strong>
                <small>{settings.enableDiarize ? '已开启' : '自动识别'}</small>
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
            <strong>{recordStatus === 'recording' ? '正在聆听...' : '准备识别'}</strong>
            <small>{recordStatus === 'recording' ? '轻触结束识别' : '拖入文件或按下麦克风开始'}</small>
          </div>
        </div>
        <RecordButton onToggle={() => void toggleRecording(false)} />
        <button type="button" className={liveCaptionStatus !== 'idle' ? 'primary' : ''} onClick={() => void toggleLiveCaption()}>
          {liveCaptionStatus === 'idle' ? '实时字幕' : '停止字幕'}
        </button>
        <div className="network-meter">
          <span />
          <strong>网络良好</strong>
          <small>{formatClock()}</small>
        </div>
      </section>

      {error && <p className="error floating-error">{error}</p>}
      {liveText && <pre className="live-text">{liveText}</pre>}
    </div>
  )
}
