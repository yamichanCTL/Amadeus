import { useEffect, useMemo, useState } from 'react'
import { AudioPlayer } from '@/components/AudioPlayer'
import { DropZone, type LocalAudioFile } from '@/components/DropZone'
import { RecordButton } from '@/components/RecordButton'
import { PromptTemplatePicker } from '@/components/PromptTemplatePicker'
import { FormalAsrNotice } from '@/components/FormalAsrNotice'
import { RecognitionTiming } from '@/components/RecognitionTiming'
import { TaskModelSettings } from '@/components/TaskModelSettings'
import { RecognitionModelQuickSettings } from '@/components/RecognitionModelQuickSettings'
import { ASR_ENGINE_LABELS } from '@/services/asrModels'
import { ModelsPage } from '@/pages/Models'
import { ASRApi, type LLMOperation, type TranscribeResponse } from '@/services/api'
import { liveCaptionService } from '@/services/liveCaption'
import { recordingService, selectDeliveryText } from '@/services/recordingService'
import { useASRStore } from '@/store/useASRStore'
import { resolveTaskLLM } from '@/services/taskModels'
import { copyText } from '@/services/export'
import './Transcribe.css'

type RecognitionView = 'record' | 'files' | 'live' | 'settings'
const views: Array<{ id: RecognitionView; title: string; description: string }> = [
  { id: 'record', title: '语音输入', description: '说完即转写，适合语音输入与口语整理。' },
  { id: 'files', title: '文件转写', description: '导入音频或视频，确认文件后开始转写。' },
  { id: 'live', title: '实时字幕', description: '边说边显示文字，使用独立的流式识别模型。' },
  { id: 'settings', title: '识别配置', description: '按类别管理模型、下载、热词与文本整理。' },
]

type ConfigurationView = 'models' | 'downloads' | 'hotwords' | 'text'
const configurationViews: Array<{ id: ConfigurationView; number: string; title: string; hint: string; description: string }> = [
  { id: 'models', number: '01', title: '识别引擎', hint: '设备与高级参数', description: '调整加载设备、精度与模型路径。日常切换模型使用右上角快捷入口。' },
  { id: 'downloads', number: '02', title: '模型下载', hint: '权重与运行组件', description: '按需下载识别模型；已安装的基础环境会继续复用。' },
  { id: 'hotwords', number: '03', title: '热词纠错', hint: '专有名词与替换规则', description: '添加常用人名、术语和别名，改善离线识别文本。' },
  { id: 'text', number: '04', title: '文本整理', hint: '服务连接与处理模型', description: '配置识别后的处理模型；模板在语音输入或文件转写页直接选择。' },
]

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
  const [view, setView] = useState<RecognitionView>(() => useASRStore.getState().liveCaptionStatus !== 'idle' ? 'live' : 'record')
  const [configurationView, setConfigurationView] = useState<ConfigurationView>('models')
  const [configurationVisited, setConfigurationVisited] = useState(false)
  const configuration = configurationViews.find((item) => item.id === configurationView)!
  const selectView = (next: RecognitionView) => {
    if (next === 'settings') setConfigurationVisited(true)
    setView(next)
  }
  const fileBatchRunning = useASRStore((state) => state.fileBatchRunning)
  const modelLoading = useASRStore((state) => state.asrModelLoading)
  const backendReady = Boolean(settings.backendConfirmed && settings.serverUrl.trim())
  const processing = ['uploading', 'processing', 'polling'].includes(transcribeStatus) || recordStatus === 'processing'
  const liveActive = liveCaptionStatus !== 'idle'
  const taskBusy = processing || recordStatus === 'recording' || liveActive || fileBatchRunning
  const busy = taskBusy || modelLoading
  const textModel = resolveTaskLLM(settings, 'asr_postprocess')
  const activePromptCard = settings.promptCards.find((card) => card.id === settings.activePromptCardId)

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
      setError('未确认后端地址。请先在首页启动本机服务，或连接已有后端。')
      return
    }
    if (busy) return
    setPendingFiles([])
    await recordingService.runFileBatch(files)
  }

  const toggleLiveCaption = async () => {
    if (liveCaptionStatus !== 'idle') {
      await liveCaptionService.stop()
      recordingService.taskEndedAt = new Date()
      return
    }

    if (!backendReady) {
      setError('未确认后端地址。请先在首页启动本机服务，或连接已有后端。')
      return
    }
    if (recordStatus !== 'idle' || processing || fileBatchRunning || modelLoading) return
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
    const { model, baseUrl, apiToken, provider } = textModel
    if (!model.trim() || !baseUrl.trim() || !apiToken.trim()) {
      setError('请在「识别配置 → 文本整理」中确认识别后处理模型与服务连接。')
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
      if (useASRStore.getState().currentResult?.task_id === next.task_id) setCurrentResult(next)
      updateHistoryResult(next.task_id, { llm_outputs: next.llm_outputs, llm_error: null })
    } catch (processError) {
      if (useASRStore.getState().currentResult?.task_id === currentResult.task_id) {
        setError(processError instanceof Error ? processError.message : '大模型处理失败')
      }
    } finally {
      setLlmStatus('idle')
    }
  }

  const displayedResultText = currentResult ? selectDeliveryText(currentResult) : ''
  const copyDisplayedResult = async () => {
    if (!displayedResultText) return
    try {
      await copyText(displayedResultText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch { setError('复制失败，请重试。') }
  }

  const resultPanel = (
    <section className="panel preview-panel" aria-label="最近一次转写结果">
      <div className="section-head compact">
        <div><h2>最近一次转写结果</h2><p>录音与文件转写的结果会保存在历史记录中。</p></div>
        <span className="soft-badge">{processing ? '正在转写' : currentResult ? '已完成' : '等待输入'}</span>
      </div>
      <div className="preview-transcript">
        {currentResult ? <>
          <article><time>{taskStartedAt ? formatTime(taskStartedAt) : '--:--:--'}{taskEndedAt ? ` → ${formatTime(taskEndedAt)}` : ''} · 原始识别</time><p>{currentResult.full_text || '暂无文本'}</p></article>
          {(currentResult.llm_outputs?.polish?.text || currentResult.llm_outputs?.translate?.text) && <article><time>文本处理</time><p>{currentResult.llm_outputs?.polish?.text || currentResult.llm_outputs?.translate?.text}</p></article>}
        </> : <p className="recognition-empty">完成录音或导入文件后，识别文本会显示在这里。</p>}
      </div>
      {currentResult && <RecognitionTiming result={currentResult} />}
      <div className="preview-footer">
        <div className="preview-actions">
          <button type="button" disabled={!displayedResultText} onClick={copyDisplayedResult}>{copied ? '已复制' : '复制结果'}</button>
          <button type="button" disabled={!currentResult || llmStatus !== 'idle' || busy} onClick={() => void processCurrentText()}>{llmStatus !== 'idle' ? '处理中' : '使用当前 Prompt'}</button>
        </div>
        {currentResult && <AudioPlayer item={currentResult} />}
      </div>
    </section>
  )

  const ongoingView: RecognitionView = liveActive ? 'live' : fileBatchRunning ? 'files' : 'record'
  return (
    <div className="page transcribe-page">
      <header className="recognition-heading">
        <div><h1>语音识别</h1><p>从语音到文字，专注每一次表达。</p></div>
        <RecognitionModelQuickSettings mode={view === 'live' ? 'streaming' : 'offline'} busy={taskBusy || llmStatus !== 'idle'} onConfigure={(section) => { selectView('settings'); setConfigurationView(section) }} />
      </header>
      <div className="recognition-tabs" role="tablist" aria-label="语音识别任务">
        {views.map((item) => <button key={item.id} id={`recognition-tab-${item.id}`} type="button" role="tab"
          aria-label={item.title} aria-selected={view === item.id} aria-controls={`recognition-pane-${item.id}`} tabIndex={view === item.id ? 0 : -1}
          onClick={() => selectView(item.id)} onKeyDown={(event) => {
            const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
            if (!direction) return
            event.preventDefault()
            const next = views[(views.findIndex((candidate) => candidate.id === item.id) + direction + views.length) % views.length]
            selectView(next.id)
            document.getElementById(`recognition-tab-${next.id}`)?.focus()
          }}><strong>{item.title}</strong><small>{item.id === 'record' ? '说完即转写' : item.id === 'files' ? '音视频批量处理' : item.id === 'live' ? '边说边显示' : '模型与处理偏好'}</small>{item.id === 'files' && pendingFiles.length > 0 && <span>{pendingFiles.length}</span>}</button>)}
      </div>
      {taskBusy && <section className="recognition-running" role="status">
        <div><strong>{liveActive ? liveStatusText : recordStatus === 'recording' ? '正在录音' : '正在转写'}</strong><small>切换任务页面会保留当前识别。</small></div>
        <div>{view !== ongoingView && <button type="button" onClick={() => setView(ongoingView)}>返回进行中的任务</button>}
          <button type="button" className="force-stop-button" onClick={() => void recordingService.forceStop()}>停止当前任务</button></div>
      </section>}
      <div id={`recognition-pane-${view === 'settings' ? 'record' : view}`} role="tabpanel" aria-labelledby={`recognition-tab-${view === 'settings' ? 'record' : view}`} hidden={view === 'settings'} className="recognition-workspace">
        {view === 'record' && <>
          <section className="panel recognition-control-panel">
            <div className="player-info"><span className="mini-wave large" aria-hidden="true" /><div><h2>语音输入</h2><small>{views[0].description}</small><small>当前模型：{ASR_ENGINE_LABELS[settings.offlineEngine] || settings.offlineEngine}</small></div></div>
            <div className="recognition-actions"><RecordButton onToggle={() => { if (!fileBatchRunning) void recordingService.toggle(false) }} /></div>
          </section>
        </>}
        {view === 'files' && <>
          <section className="panel upload-panel file-recognition-panel">
            <div className="section-head"><div><h2>文件转写</h2><p>{views[1].description}</p><p>当前模型：{ASR_ENGINE_LABELS[settings.offlineEngine] || settings.offlineEngine}</p></div><span className="soft-badge">音频 / 视频</span></div>
            <DropZone onFiles={handleFiles} />
            {pendingFiles.length > 0 && <div className="pending-files" role="status">
              <div><strong>已选择 {pendingFiles.length} 个文件，等待确认</strong><span>{pendingFiles.map((file) => file.name).join('、')}</span></div>
              <button type="button" onClick={() => setPendingFiles([])}>取消选择</button>
              <button type="button" className="primary" disabled={busy} onClick={() => void confirmFiles()}>确认并开始识别</button>
            </div>}
          </section>
        </>}
        {view === 'live' && <>
          <section className="panel recognition-control-panel">
            <div className="player-info"><span className="mini-wave large" aria-hidden="true" /><div><h2>实时字幕</h2><small>{views[2].description}</small><small>当前流式模型：{settings.streamingEngine} · {liveStatusText}</small></div></div>
            <div className="recognition-actions"><button type="button" className={liveActive ? '' : 'primary'} disabled={!liveActive && (processing || recordStatus !== 'idle' || fileBatchRunning || modelLoading)} onClick={() => void toggleLiveCaption()}>{liveActive ? '停止实时字幕' : '开始实时字幕'}</button></div>
          </section>
        </>}
        <PromptTemplatePicker hidden={view === 'live'} cards={settings.promptCards} activeCardId={settings.activePromptCardId}
          autoProcessing={settings.llmAutoPolish || settings.llmAutoTranslate} textModelName={textModel.model}
          textModelReady={Boolean(textModel.model.trim() && textModel.baseUrl.trim() && textModel.apiToken.trim())}
          disabled={busy || llmStatus !== 'idle'}
          onChange={({ cards, activeCardId, prompt }) => updateSettings({ promptCards: cards, activePromptCardId: activeCardId, llmPolishPrompt: prompt })}
          onAutoProcessingChange={(enabled) => updateSettings({ llmAutoPolish: enabled, llmAutoTranslate: false })}
          onConfigureModel={() => { selectView('settings'); setConfigurationView('text') }} />
        {view === 'record' && settings.offlineEngine === 'formalasr' && <details className="recognition-model-explanation"><summary>FormalASR 输出与追加整理说明</summary><FormalAsrNotice /></details>}
        {(view === 'record' || view === 'files') && resultPanel}
        {view === 'live' && <>
          <section className="panel preview-panel" aria-label="实时字幕内容">
            <div className="section-head"><h2>字幕内容</h2><span className="soft-badge">{utterances.length} 段</span></div>
            <div className="preview-transcript">{utterances.length ? utterances.map((utterance, index) => <article key={index}><time>{formatTime(utterance.startedAt)} → {utterance.endedAt ? formatTime(utterance.endedAt) : '…'}</time><p>{utterance.text || '正在识别…'}</p></article>) : <p className="recognition-empty">{liveActive ? liveStatusText : '启动实时字幕后，文字会随说话持续更新。'}</p>}</div>
          </section>
        </>}
      </div>
      {(view === 'settings' || configurationVisited) && <div id="recognition-pane-settings" role="tabpanel" aria-labelledby="recognition-tab-settings" hidden={view !== 'settings'} className="recognition-config-shell">
        <aside className="recognition-config-sidebar">
          <div className="recognition-config-label">配置分类<small>按需选择，无须逐项完成</small></div>
          <div role="tablist" aria-label="识别配置分类" aria-orientation="vertical" className="recognition-config-nav">
            {configurationViews.map((item, index) => <button key={item.id} type="button" role="tab" id={`recognition-config-${item.id}`} aria-selected={configurationView === item.id} aria-controls="recognition-config-content" aria-label={`${item.number} ${item.title}`} tabIndex={configurationView === item.id ? 0 : -1} onClick={() => setConfigurationView(item.id)} onKeyDown={(event) => {
              const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
              if (!direction && event.key !== 'Home' && event.key !== 'End') return
              event.preventDefault()
              const next = configurationViews[event.key === 'Home' ? 0 : event.key === 'End' ? configurationViews.length - 1 : (index + direction + configurationViews.length) % configurationViews.length]
              setConfigurationView(next.id)
              document.getElementById(`recognition-config-${next.id}`)?.focus()
            }}><span className="recognition-config-number">{item.number}</span><span><strong>{item.title}</strong><small>{item.hint}</small></span></button>)}
          </div>
          <div className="recognition-environment-note"><span>共用本机环境</span><p>安装、启动与连接<br />统一在首页管理。</p><button type="button" onClick={() => useASRStore.getState().setPage('home')}>前往首页 <span aria-hidden="true">↗</span></button></div>
        </aside>
        <section className="recognition-config-content" id="recognition-config-content" role="tabpanel" aria-labelledby={`recognition-config-${configurationView}`}>
          <header className="recognition-config-heading"><div><h2>{configuration.title}</h2><p>{configuration.description}</p></div><span className="recognition-category-note">{configurationView === 'models' ? '录音 / 文件 / 字幕' : '可选配置'}</span></header>
          <ModelsPage initialTab="asr" allowedTabs={['asr']} embedded taskSelectionInShortcut asrSection={configurationView === 'text' ? 'none' : configurationView} />
          <section className="recognition-text-settings" hidden={configurationView !== 'text'}>
            <div className="recognition-template-location"><div><strong>当前模板：{activePromptCard?.name || '未选择'}</strong><p>模板选择与自动整理开关已移到任务页，语音输入、文件转写和快捷键录音共用。</p></div><button type="button" onClick={() => selectView('record')}>选择处理模板 ↗</button></div>
            <TaskModelSettings task="asr" disabled={llmStatus !== 'idle'} />
          </section>
        </section>
      </div>}
      {error && <div className="panel recognition-error" role="alert"><p className="error">{error}</p><button type="button" onClick={() => selectView('settings')}>查看识别配置</button><button type="button" onClick={() => setError('')}>关闭提示</button></div>}
    </div>
  )
}
