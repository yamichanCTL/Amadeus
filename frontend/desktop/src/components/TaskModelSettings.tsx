import { useEffect, useRef, useState } from 'react'
import { ASRApi, type LLMModelsResult } from '@/services/api'
import { deepSeekOpenAIBaseUrl, getProviderPreset, llmConnectionFailureMessage, LLM_PROVIDER_PRESETS } from '@/services/llmProviders'
import { LEGACY_CONNECTION_ID, LLM_TASKS, resolveTaskLLM, TASK_MODEL_LABELS, type LLMTask, type ModelConnection } from '@/services/taskModels'
import { useASRStore } from '@/store/useASRStore'
import { ModelSelector } from './ModelSelector'
import './TaskModelSettings.css'

export type ModelSettingsTask = 'asr' | 'summary' | 'realtime'
const taskIds: Record<ModelSettingsTask, LLMTask> = {
  asr: 'asr_postprocess', summary: 'summary', realtime: 'agent',
}
const descriptions: Record<LLMTask, string> = {
  asr_postprocess: '用于语音识别后的纠错、润色和翻译。录音、文件转写和快捷键录音共用此配置。',
  summary: '主动与定时总结使用这里的模型，可以与识别后处理选择不同模型。',
  agent: '用于原有 Agent 的 API 大脑与工具推理。原生实时语音模型及密钥在实时语音配置中设置。',
}

export function TaskModelSettings({ task, disabled = false }: { task: ModelSettingsTask; disabled?: boolean }) {
  const settings = useASRStore((state) => state.settings)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const scope = taskIds[task]
  const config = resolveTaskLLM(settings, scope)
  const binding = settings.taskModels?.[scope]
  const connectionId = binding?.connectionId ?? LEGACY_CONNECTION_ID
  const connections = settings.modelConnections?.length ? settings.modelConnections : [{
    id: LEGACY_CONNECTION_ID, name: '原有模型连接', provider: config.provider, baseUrl: config.baseUrl, apiToken: config.apiToken,
  }]
  const connection = connections.find((item) => item.id === connectionId) || {
    id: connectionId, name: '请选择服务连接', provider: 'custom', baseUrl: '', apiToken: '',
  }
  const preset = getProviderPreset(config.provider)
  const [catalog, setCatalog] = useState<LLMModelsResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [normalizedConnection, setNormalizedConnection] = useState('')
  const requestRef = useRef(0)
  const requestIdentityRef = useRef<{ scope: LLMTask; backend: string; id: string; provider: string; baseUrl: string; apiToken: string } | null>(null)
  const mountedRef = useRef(true)
  const backendReady = Boolean(settings.backendConfirmed && settings.serverUrl.trim())
  const users = LLM_TASKS.filter((item) => settings.taskModels?.[item]?.connectionId === connection.id)
  const compatibleBaseUrl = deepSeekOpenAIBaseUrl(connection.provider, connection.baseUrl)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; requestRef.current++ }
  }, [])

  useEffect(() => {
    // Saving the official compatible address is part of the same check. Keep
    // its result even when a fast response completes before React's effect.
    const identity = requestIdentityRef.current
    if (identity?.scope === scope && identity.backend === settings.serverUrl && identity.id === connection.id
      && identity.provider === connection.provider && identity.baseUrl === connection.baseUrl && identity.apiToken === connection.apiToken) return
    requestIdentityRef.current = null
    requestRef.current++; setCatalog(null); setError(''); setChecking(false)
  }, [scope, settings.serverUrl, connection.id, connection.provider, connection.baseUrl, connection.apiToken])

  const setModel = (model: string, id = connection.id) => {
    if (disabled) return
    const latest = useASRStore.getState().settings
    updateSettings({ taskModels: { ...latest.taskModels, [scope]: { connectionId: id, model } } })
  }
  const updateConnection = (patch: Partial<ModelConnection>) => {
    if (disabled) return
    const current = useASRStore.getState().settings.modelConnections
    updateSettings({ modelConnections: (current.length ? current : connections).map((item) => item.id === connection.id ? { ...item, ...patch } : item) })
  }
  const useCompatibleAddress = () => {
    if (disabled || !compatibleBaseUrl) return
    updateConnection({ baseUrl: compatibleBaseUrl }); setNormalizedConnection(connection.id)
  }
  const newConnection = () => {
    const id = `connection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    updateSettings({
      modelConnections: [...connections, { id, name: `新连接 ${connections.length + 1}`, provider: 'custom', baseUrl: '', apiToken: '' }],
      taskModels: { ...settings.taskModels, [scope]: { connectionId: id, model: '' } },
    })
  }
  const check = async () => {
    if (disabled || checking || !backendReady || !connection.baseUrl.trim()) return
    const request = ++requestRef.current
    setChecking(true); setCatalog(null); setError('')
    const requested = { provider: connection.provider, base_url: compatibleBaseUrl || connection.baseUrl, api_token: connection.apiToken }
    const requestedId = connection.id
    const selectedBackend = settings.serverUrl
    requestIdentityRef.current = { scope, backend: selectedBackend, id: requestedId, provider: requested.provider, baseUrl: requested.base_url, apiToken: requested.api_token }
    if (compatibleBaseUrl) useCompatibleAddress()
    const isCurrent = () => {
      const latest = useASRStore.getState().settings
      const current = latest.modelConnections.find(item => item.id === requestedId)
      return mountedRef.current && request === requestRef.current && latest.serverUrl === selectedBackend
        && (latest.taskModels[scope]?.connectionId ?? LEGACY_CONNECTION_ID) === requestedId
        && current?.provider === requested.provider && current.baseUrl === requested.base_url && current.apiToken === requested.api_token
    }
    try {
      const result = await new ASRApi(selectedBackend).listLLMModels(requested)
      if (isCurrent()) {
        setCatalog(result)
        if (!result.connected) setError(llmConnectionFailureMessage(result.status_code))
      }
    } catch {
      // Do not surface arbitrary upstream responses which may repeat credentials.
      if (isCurrent()) setError('连接检查失败，请检查后端、接口地址和 API Key。')
    } finally { if (isCurrent()) setChecking(false) }
  }

  return <section className="task-model-settings" aria-label={`${TASK_MODEL_LABELS[scope]}模型配置`}>
    <div className="task-model-heading"><h3>{TASK_MODEL_LABELS[scope]}模型</h3><span>独立任务配置</span></div>
    <p>{descriptions[scope]}</p>
    <div className="task-model-grid">
      <label>服务连接<select aria-label={`${TASK_MODEL_LABELS[scope]}服务连接`} value={connection.id} disabled={disabled} onChange={(event) => setModel('', event.target.value)}>
        {!connections.some(item => item.id === connection.id) && <option value={connection.id}>请选择服务连接</option>}
        {connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <ModelSelector key={`${scope}:${connection.id}`} label={`${TASK_MODEL_LABELS[scope]}模型`} value={config.model} models={catalog?.connected ? catalog.models : []} disabled={disabled} placeholder={preset.modelPlaceholder} onChange={setModel}
        catalogStatus={checking ? 'loading' : error || catalog?.connected === false ? 'error' : catalog ? 'ready' : 'idle'} />
    </div>
    <details className="task-connection-editor">
      <summary>连接与 API Key · {connection.name}</summary>
      <p>同一连接可被多个任务复用；每个任务的模型单独保存。修改此连接的地址或密钥，会用于 {users.length ? users.map((item) => TASK_MODEL_LABELS[item]).join('、') : TASK_MODEL_LABELS[scope]}。</p>
      <div className="task-model-grid">
        <label>连接名称<input aria-label="连接名称" value={connection.name} disabled={disabled} onChange={(event) => updateConnection({ name: event.target.value })} /></label>
        <label>服务商<select aria-label="连接服务商" value={connection.provider} disabled={disabled} onChange={(event) => {
          const next = getProviderPreset(event.target.value)
          updateConnection({ provider: event.target.value, baseUrl: event.target.value === 'custom' ? connection.baseUrl : next.baseUrl })
        }}>{LLM_PROVIDER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>接口地址<input aria-label="连接接口地址" value={connection.baseUrl} disabled={disabled} placeholder="https://example.com/v1" onChange={(event) => updateConnection({ baseUrl: event.target.value })} /></label>
        <label>API Key<input aria-label="连接 API Key" type="password" autoComplete="new-password" value={connection.apiToken} disabled={disabled} placeholder="仅保存在本机配置中" onChange={(event) => updateConnection({ apiToken: event.target.value })} /></label>
      </div>
      {compatibleBaseUrl && <div className="task-protocol-note" role="note">
        <p>当前地址是 DeepSeek 的 Anthropic 协议入口；本模块使用 OpenAI 兼容协议。检查连接时会改用官方兼容地址，保留 API Key 和任务模型。</p>
        <button type="button" disabled={disabled || checking} onClick={useCompatibleAddress}>使用 OpenAI 兼容地址</button>
      </div>}
      {normalizedConnection === connection.id && connection.provider === 'deepseek' && connection.baseUrl === 'https://api.deepseek.com' && <p role="status">已使用 OpenAI 兼容地址：https://api.deepseek.com</p>}
      <div className="task-model-actions">
        <button type="button" disabled={disabled || connections.length >= 40} onClick={newConnection}>新建服务连接</button>
        <button type="button" disabled={disabled || checking || !backendReady || !connection.baseUrl.trim()} onClick={() => void check()}>{checking ? '正在检查…' : '检查连接 / 获取模型'}</button>
      </div>
      {!backendReady && <small>启动并连接后端后可检查连接；当前设置会先保存在本机。</small>}
      {catalog?.connected && <p role="status">连接成功 · {catalog.models.length} 个可用模型</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </details>
  </section>
}
