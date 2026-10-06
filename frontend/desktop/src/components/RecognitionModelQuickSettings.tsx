import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ASRApi, describeRequestError, isAbortError } from '@/services/api'
import { ASR_ENGINE_LABELS, asrLoadPayload, fallbackAsrConfig, getAsrModelModes, type AsrModelMode } from '@/services/asrModels'
import type { ModelDownloadCatalog } from '@/services/modelDownloads'
import { isSelectedLocalRuntime } from '@/services/localRuntimeConnection'
import type { LocalRuntimeState } from '@/services/localRuntimeTypes'
import { LEGACY_CONNECTION_ID, resolveTaskLLM } from '@/services/taskModels'
import { useASRStore } from '@/store/useASRStore'
import { deepSeekOpenAIBaseUrl, llmConnectionFailureMessage } from '@/services/llmProviders'
import './RecognitionModelQuickSettings.css'
import { ModelSelector } from './ModelSelector'

export function RecognitionModelQuickSettings({ mode, busy, onConfigure }: {
  mode: AsrModelMode; busy: boolean; onConfigure: (section: 'models' | 'downloads' | 'text') => void;
}) {
  const settings = useASRStore(state => state.settings)
  const models = useASRStore(state => state.models)
  const modelLoading = useASRStore(state => state.asrModelLoading)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [verifiedUrl, setVerifiedUrl] = useState('')
  const [loadingEngine, setLoadingEngine] = useState('')
  const [error, setError] = useState('')
  const [catalog, setCatalog] = useState<ModelDownloadCatalog | null>(null)
  const [runtime, setRuntime] = useState<LocalRuntimeState | null>(null)
  const [llmModels, setLlmModels] = useState<string[]>([])
  const [llmCatalogReady, setLlmCatalogReady] = useState(false)
  const [llmChecking, setLlmChecking] = useState(false)
  const [llmError, setLlmError] = useState('')
  const panelId = useId()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const refreshRef = useRef<AbortController | null>(null)
  const runtimeRef = useRef<LocalRuntimeState | null>(null)
  const mountedRef = useRef(true)
  const loadingRef = useRef(false)
  const llmRequestRef = useRef(0)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const backendReady = Boolean(settings.backendConfirmed && settings.serverUrl.trim())
  const paused = isSelectedLocalRuntime(runtime, settings.serverUrl) && ['stopping', 'installing', 'starting'].includes(runtime!.phase)
  const isPaused = () => {
    const value = runtimeRef.current
    return isSelectedLocalRuntime(value, useASRStore.getState().settings.serverUrl) && ['stopping', 'installing', 'starting'].includes(value!.phase)
  }
  const known = backendReady && verifiedUrl === settings.serverUrl && !paused
  const currentEngine = mode === 'offline' ? settings.offlineEngine : settings.streamingEngine
  const currentModel = known ? models.find(item => item.engine === currentEngine) : undefined
  const locked = busy || modelLoading
  const textModel = resolveTaskLLM(settings, 'asr_postprocess')
  const compatibleTextBaseUrl = deepSeekOpenAIBaseUrl(textModel.provider, textModel.baseUrl)
  const bindingId = settings.taskModels?.asr_postprocess?.connectionId ?? LEGACY_CONNECTION_ID
  const connections = settings.modelConnections?.length ? settings.modelConnections : [{
    id: LEGACY_CONNECTION_ID, name: '原有模型连接', provider: textModel.provider, baseUrl: textModel.baseUrl, apiToken: textModel.apiToken,
  }]
  const textConfigured = Boolean(textModel.model.trim() && textModel.baseUrl.trim() && textModel.apiToken.trim())

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; refreshRef.current?.abort(); llmRequestRef.current++ }
  }, [])

  useEffect(() => {
    const host = window.electronAPI
    if (!host?.localRuntimeStatus || !host.onLocalRuntimeState) return
    let active = true, receivedEvent = false
    const receive = (value: LocalRuntimeState) => {
      if (!active) return
      runtimeRef.current = value; setRuntime(value)
      if (isPaused()) { refreshRef.current?.abort(); setError(''); setVerifiedUrl('') }
    }
    const off = host.onLocalRuntimeState(value => { receivedEvent = true; receive(value) })
    void host.localRuntimeStatus().then(value => { if (!receivedEvent) receive(value) }).catch(() => {})
    return () => { active = false; off() }
  }, [])

  const refresh = useCallback(async (withCatalog = false) => {
    if (!backendReady || isPaused()) return
    refreshRef.current?.abort()
    const controller = new AbortController()
    refreshRef.current = controller
    const selectedUrl = settings.serverUrl
    setRefreshing(true); setError('')
    try {
      const next = await api.models({ signal: controller.signal, timeoutMs: 20_000 })
      if (controller.signal.aborted || !mountedRef.current || isPaused() || useASRStore.getState().settings.serverUrl !== selectedUrl) return
      useASRStore.getState().setModels(next); setVerifiedUrl(selectedUrl)
      if (withCatalog) {
        // Catalog failure must not prevent loading an engine advertised by the backend.
        const value = await api.modelDownloadCatalog(controller.signal).catch(() => null)
        if (!controller.signal.aborted && mountedRef.current && useASRStore.getState().settings.serverUrl === selectedUrl) setCatalog(value)
      }
    } catch (cause) {
      if (!controller.signal.aborted && mountedRef.current && !isPaused() && !isAbortError(cause)) {
        setVerifiedUrl(''); setError(describeRequestError(cause, '模型状态获取失败'))
      }
    } finally {
      if (refreshRef.current === controller && mountedRef.current) { refreshRef.current = null; setRefreshing(false) }
    }
  }, [api, backendReady, settings.serverUrl])

  useEffect(() => {
    setVerifiedUrl(''); setCatalog(null)
    if (!paused) void refresh(open)
    return () => refreshRef.current?.abort()
  }, [refresh, paused, open])

  useEffect(() => { setLlmModels([]); setLlmCatalogReady(false); setLlmError(''); setLlmChecking(false); llmRequestRef.current++ }, [bindingId, textModel.provider, textModel.baseUrl, textModel.apiToken, settings.serverUrl, backendReady, paused])

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const outside = (event: PointerEvent) => { if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false) }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); triggerRef.current?.focus() }
    }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard) }
  }, [open])

  const configure = (section: 'models' | 'downloads' | 'text') => { setOpen(false); onConfigure(section) }
  const selectEngine = (taskMode: AsrModelMode, engine: string) => {
    if (locked || loadingRef.current || isPaused()) return
    useASRStore.getState().updateSettings(taskMode === 'offline' ? { offlineEngine: engine } : { streamingEngine: engine })
  }
  const load = async (engine: string) => {
    if (busy || loadingRef.current || useASRStore.getState().asrModelLoading || !backendReady || isPaused()) return
    const selectedUrl = settings.serverUrl
    const latest = useASRStore.getState().settings
    loadingRef.current = true; setLoadingEngine(engine); useASRStore.setState({ asrModelLoading: true }); setError('')
    try {
      const config = latest.asrModelConfigs[engine] || fallbackAsrConfig(engine, models.find(item => item.engine === engine))
      await api.loadModel(engine, asrLoadPayload(engine, config))
      if (mountedRef.current && useASRStore.getState().settings.serverUrl === selectedUrl && !isPaused()) await refresh(open)
    } catch (cause) {
      if (mountedRef.current && useASRStore.getState().settings.serverUrl === selectedUrl && !isPaused()) {
        setError(cause instanceof Error ? cause.message : '模型加载失败，请检查模型权重与运行组件。')
      }
    } finally {
      loadingRef.current = false
      useASRStore.setState({ asrModelLoading: false })
      if (mountedRef.current) setLoadingEngine('')
    }
  }
  const setTextModel = (model: string, connectionId = bindingId) => {
    if (locked) return
    const latest = useASRStore.getState().settings
    useASRStore.getState().updateSettings({ taskModels: { ...latest.taskModels, asr_postprocess: { connectionId, model } } })
  }
  const listTextModels = async () => {
    if (locked || llmChecking || !backendReady || isPaused() || !textModel.baseUrl.trim() || !textModel.apiToken.trim()) return
    const request = ++llmRequestRef.current
    const requestedUrl = settings.serverUrl
    const requestedBinding = bindingId
    const requestedModel = { ...textModel }
    const currentRequest = () => {
      const latest = useASRStore.getState().settings
      const current = resolveTaskLLM(latest, 'asr_postprocess')
      return mountedRef.current && request === llmRequestRef.current && !isPaused()
        && latest.backendConfirmed && latest.serverUrl === requestedUrl
        && (latest.taskModels?.asr_postprocess?.connectionId ?? LEGACY_CONNECTION_ID) === requestedBinding
        && current.provider === requestedModel.provider && current.baseUrl === requestedModel.baseUrl && current.apiToken === requestedModel.apiToken
    }
    setLlmChecking(true); setLlmError(''); setLlmModels([]); setLlmCatalogReady(false)
    try {
      const value = await api.listLLMModels({ provider: textModel.provider, base_url: compatibleTextBaseUrl ?? textModel.baseUrl, api_token: textModel.apiToken })
      if (currentRequest()) {
        if (value.connected) { setLlmModels(value.models); setLlmCatalogReady(true) }
        else setLlmError(llmConnectionFailureMessage(value.status_code))
      }
    } catch {
      if (currentRequest()) setLlmError('获取模型失败，请在文本整理设置中检查服务连接。')
    } finally { if (currentRequest()) setLlmChecking(false) }
  }

  return <div className="recognition-model-shortcut" ref={wrapperRef}>
    <button ref={triggerRef} type="button" className="recognition-model-trigger" aria-label="模型快捷设置" aria-expanded={open} aria-haspopup="dialog" aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <span className="recognition-model-icon" aria-hidden="true">◇</span>
      <span><small>{mode === 'streaming' ? '实时字幕模型' : '录音 / 文件模型'}</small><strong>{ASR_ENGINE_LABELS[currentEngine] || currentEngine}</strong></span>
      <span className={`recognition-model-state ${currentModel?.is_loaded ? 'loaded' : ''}`}>{loadingEngine === currentEngine ? '加载中' : paused ? '环境安装中' : currentModel?.is_loaded ? '已加载' : known ? '待加载' : '待确认'}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <section id={panelId} className="recognition-model-popover" role="dialog" aria-modal="false" aria-label="识别模型快捷设置">
      <header><div><h2>本任务使用的模型</h2><p>为录音、文件与字幕选择模型，并在这里加载。</p></div><button ref={closeRef} type="button" className="recognition-model-close" aria-label="关闭模型快捷设置" onClick={() => { setOpen(false); triggerRef.current?.focus() }}>×</button></header>
      {busy && !loadingEngine && <p className="recognition-model-notice" role="status">当前任务正在运行，结束后可切换或加载模型。</p>}
      {paused && <p className="recognition-model-notice" role="status">{runtime!.message}，完成后自动刷新模型状态。</p>}
      {!backendReady && <p className="recognition-model-notice">请先在首页启动本机服务或连接已有后端。<button type="button" onClick={() => useASRStore.getState().setPage('home')}>前往首页</button></p>}
      {(['offline', 'streaming'] as const).map(taskMode => {
        const engine = taskMode === 'offline' ? settings.offlineEngine : settings.streamingEngine
        const choices = known ? models.filter(item => getAsrModelModes(item).includes(taskMode)) : []
        const model = choices.find(item => item.engine === engine)
        const runtimeMissing = catalog?.models.find(item => item.engine === engine)?.runtime.installed === false
        const isLoading = loadingEngine === engine
        return <div key={taskMode} className={`recognition-model-row ${mode === taskMode ? 'current' : ''}`}>
          <div className="recognition-model-row-heading"><strong>{taskMode === 'offline' ? '录音与文件转写' : '实时字幕'}</strong><span>{isLoading ? '正在加载…' : model?.is_loaded ? `已加载 · ${model.device || '设备未报告'}` : known ? '未加载' : '状态待确认'}</span></div>
          <div className="recognition-model-selection"><label><span className="sr-only">{taskMode === 'offline' ? '快捷离线模型' : '快捷流式模型'}</span><select aria-label={taskMode === 'offline' ? '快捷离线模型' : '快捷流式模型'} value={engine} disabled={locked || paused || !known || choices.length === 0} onChange={event => selectEngine(taskMode, event.target.value)}>
            {!choices.some(item => item.engine === engine) && <option value={engine}>{ASR_ENGINE_LABELS[engine] || engine}</option>}
            {choices.map(item => <option key={item.engine} value={item.engine}>{ASR_ENGINE_LABELS[item.engine] || item.engine}{item.is_loaded ? ' · 已加载' : ''}</option>)}
          </select></label><button type="button" className={model?.is_loaded ? '' : 'primary'} disabled={locked || paused || !backendReady || !model} onClick={() => void load(engine)}>{isLoading ? '加载中…' : model?.is_loaded ? '重新加载' : '加载'}</button></div>
          <small>{taskMode === 'offline' ? '录音结束后或导入文件时识别。' : '边说边识别；与离线模型独立选择。'}</small>
          {runtimeMissing && !model?.is_loaded && <p className="recognition-model-warning">缺少运行组件，请在模型下载中安装。<button type="button" onClick={() => configure('downloads')}>模型下载</button></p>}
        </div>
      })}
      <div className="recognition-model-row recognition-text-model">
        <div className="recognition-model-row-heading"><strong>识别后处理 · 文本大模型</strong><span>{settings.llmAutoPolish || settings.llmAutoTranslate ? textConfigured ? '自动整理已开启' : '待配置' : '自动整理未启用'}</span></div>
        <div className="recognition-text-selection"><label>服务连接<select aria-label="快捷文本服务连接" value={bindingId} disabled={locked} onChange={event => setTextModel('', event.target.value)}>
          {!connections.some(item => item.id === bindingId) && <option value={bindingId}>请选择已有连接</option>}
          {connections.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label><ModelSelector key={bindingId} label="快捷文本模型" value={textModel.model} models={llmModels} disabled={locked} placeholder="输入文本模型名称" onChange={setTextModel} catalogStatus={llmChecking ? 'loading' : llmError ? 'error' : llmCatalogReady ? 'ready' : 'idle'} /></div>
        <small>用于识别后的润色、纠错和翻译；复用已保存的连接。</small>
        {compatibleTextBaseUrl && <p className="recognition-model-notice">此处使用 OpenAI 兼容协议，DeepSeek 官方 Anthropic 地址会按兼容地址调用。可在文本整理设置中保存正确地址。</p>}
        <div className="recognition-text-actions"><button type="button" disabled={locked || llmChecking || paused || !backendReady || !textModel.baseUrl.trim() || !textModel.apiToken.trim()} onClick={() => void listTextModels()}>{llmChecking ? '正在获取…' : '获取可选模型'}</button><button type="button" onClick={() => configure('text')}>文本整理设置 ↗</button></div>
        {llmError && <p className="recognition-model-warning" role="alert">{llmError}</p>}
      </div>
      {error && <p className="recognition-model-warning" role="alert">{error}<button type="button" onClick={() => configure('downloads')}>检查模型与组件</button></p>}
      <footer><button type="button" disabled={refreshing || Boolean(loadingEngine) || paused || !backendReady} onClick={() => void refresh(true)}>{refreshing ? '刷新中…' : '刷新模型状态'}</button><button type="button" onClick={() => configure('models')}>设备与高级参数 ↗</button></footer>
    </section>}
  </div>
}
