import { useEffect, useMemo, useState } from 'react'
import { AudioPlayer } from '@/components/AudioPlayer'
import { DropZone, type LocalAudioFile } from '@/components/DropZone'
import { RecordButton } from '@/components/RecordButton'
import { PromptCardEditor } from '@/components/PromptCardEditor'
import { ASRApi, type LLMOperation, type TranscribeResponse } from '@/services/api'
import { liveCaptionService } from '@/services/liveCaption'
import { recordingService, selectDeliveryText } from '@/services/recordingService'
import { useASRStore } from '@/store/useASRStore'

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
  const setCurrentResult = useASRStore((state) => state.setCurrentResult)
  const setError = useASRStore((state) => state.setError)
  const updateHistoryResult = useASRStore((state) => state.updateHistoryResult)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  // taskStartedAt/taskEndedAt live on the singleton so they survive navigation
  // and stay accurate even when this page is unmounted during recognition.
  const taskStartedAt = recordingService.taskStartedAt
  const taskEndedAt = recordingService.taskEndedAt
  const [llmStatus, setLlmStatus] = useState<LLMOperation | 'idle'>('idle')
  const [pendingFiles, setPendingFiles] = useState<LocalAudioFile[]>([])
  const [copied, setCopied] = useState(false)
  const backendReady = Boolean(settings.backendConfirmed && settings.serverUrl.trim())

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

  // NOTE: this page no longer cancels the recorder on unmount. Recognition is
  // owned by recordingService (a singleton) and must keep running across page
  // navigation ("执行语音识别的时候不影响其他操作"). App-level cleanup still
  // cancels speechRecorder on full app exit.
  useEffect(() => {
    return () => {
      // Only re-arm the mic if recognition is truly idle; never interrupt an
      // in-flight recording/transcription.
      const state = useASRStore.getState()
      if (state.recordStatus !== 'idle' || ['uploading', 'processing', 'polling'].includes(state.transcribeStatus)) return
      const latest = state.settings
      if (!liveCaptionService.isActive && latest.inputSource !== 'speaker' && latest.audioInputDeviceId !== '__speaker_loopback__') {
        recordingService.prepare()
      }
    }
  }, [])

  const handleFiles = (files: LocalAudioFile[]) => {
    setPendingFiles(files)
    setError('')
  }

  const confirmFiles = async () => {
    const files = pendingFiles
    if (!files.length) return
    if (!backendReady) {
      setError('未确认后端地址。请先在「设置」中输入后端 IP/地址并点击「确认」。')
      return
    }
    setPendingFiles([])
    for (const file of files) {
      await recordingService.runTranscription(file.blob, file.name, false)
    }
  }

  const toggleLiveCaption = async () => {
    if (liveCaptionStatus !== 'idle') {
      await liveCaptionService.stop()
      recordingService.taskEndedAt = new Date()
      return
    }

    if (!backendReady) {
      setError('未确认后端地址。请先在「设置」中输入后端 IP/地址并点击「确认」。')
      return
    }
    if (recordStatus !== 'idle' || transcribeStatus === 'uploading' || transcribeStatus === 'polling') return
    recordingService.taskStartedAt = new Date()
    recordingService.taskEndedAt = null
    try {
      await liveCaptionService.start()
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : '实时识别启动失败')
    }
  }

  const processCurrentText = async () => {
    if (!currentResult?.full_text.trim()) return
    const operation: LLMOperation = 'polish'
    const model = settings.llmModel
    const baseUrl = settings.llmBaseUrl
    const apiToken = settings.llmApiToken
    const provider = settings.llmProvider
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
        style: settings.llmStyle || undefined,
        prompt: settings.llmPolishPrompt || undefined
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

  const displayedResultText = currentResult ? selectDeliveryText(currentResult) : ''
  const copyDisplayedResult = () => {
    if (!displayedResultText) return
    setCopied(true)
    window.electronAPI?.textToClipboard(displayedResultText)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="page transcribe-page">
      <section className="panel recognition-control-panel">
        <div className="player-info">
          <span className="mini-wave large" aria-hidden="true" />
          <div>
            <strong>{liveCaptionStatus !== 'idle' ? liveStatusText : recordStatus === 'recording' ? '正在聆听...' : backendReady ? '准备识别' : '等待确认后端'}</strong>
            <small>{liveCaptionStatus !== 'idle' ? `实时识别：${liveCaptionStatus}` : recordStatus === 'recording' ? '点击结束并转写' : '离线录音和实时识别开关'}</small>
          </div>
        </div>
        <div className="recognition-actions">
          <RecordButton onToggle={() => void recordingService.toggle(false)} />
          <button type="button" className={liveCaptionStatus !== 'idle' ? 'primary' : ''} onClick={() => void toggleLiveCaption()}>
            {liveCaptionStatus === 'idle' ? '实时识别' : '停止识别'}
          </button>
          {(recordStatus !== 'idle' || liveCaptionStatus !== 'idle' || ['uploading', 'processing', 'polling'].includes(transcribeStatus)) && (
            <button type="button" className="force-stop-button" onClick={() => void recordingService.forceStop()}>强制停止</button>
          )}
        </div>
      </section>

      <div className="transcribe-layout">
        <div className="transcribe-main">
          <section className="panel preview-panel">
            <div className="section-head compact">
              <div>
                <h1>语音识别</h1>
                <p>离线录音、实时识别和文件识别共用当前模型设置。</p>
              </div>
              <span className="soft-badge">{transcribeStatus === 'idle' ? '待识别' : transcribeStatus}</span>
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
                {(currentResult.llm_outputs?.polish?.text || currentResult.llm_outputs?.translate?.text) && (
                  <article>
                    <time>LLM 处理</time>
                    <p>{currentResult.llm_outputs?.polish?.text || currentResult.llm_outputs?.translate?.text}</p>
                  </article>
                )}
              </div>
            ) : (
              <div className="preview-transcript" />
            )}
            <div className="preview-footer">
              <div className="preview-actions">
                <button type="button" disabled={!currentResult} onClick={copyDisplayedResult}>{copied ? '已复制' : '复制结果'}</button>
                <button type="button" disabled={!currentResult || llmStatus !== 'idle'} onClick={() => void processCurrentText()}>
                  {llmStatus !== 'idle' ? '处理中' : '使用当前 Prompt'}
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
              <button
                type="button"
                className={settings.llmAutoPolish || settings.llmAutoTranslate ? 'quick-tile active' : 'quick-tile'}
                onClick={() => {
                  const enabled = settings.llmAutoPolish || settings.llmAutoTranslate
                  updateSettings({ llmAutoPolish: !enabled, llmAutoTranslate: false })
                }}
              >
                <span>AI</span>
                <strong>LLM 处理</strong>
                <small>{settings.llmAutoPolish || settings.llmAutoTranslate ? settings.llmModel || '已开启' : '点击开启'}</small>
              </button>
            </div>
            <PromptCardEditor
              title="LLM Prompt 卡片"
              description="点击卡片立即切换自动与手动处理使用的 Prompt。"
              cards={settings.promptCards}
              activeCardId={settings.activePromptCardId}
              onChange={({ cards, activeCardId, prompt }) => updateSettings({ promptCards: cards, activePromptCardId: activeCardId, llmPolishPrompt: prompt })}
            />
          </section>
        </aside>
      </div>

      <section className="panel upload-panel file-recognition-panel">
        <div className="section-head">
          <div>
            <h2>文件识别</h2>
            <p>选择音频 / 视频文件后先确认，再开始识别，不会因拖放立即上传。</p>
          </div>
          <span className="soft-badge">文件 ASR</span>
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

      {error && <p className="error floating-error">{error}</p>}
    </div>
  )
}
