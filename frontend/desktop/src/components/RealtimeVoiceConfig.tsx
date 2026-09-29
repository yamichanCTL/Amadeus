import { useEffect, useState } from 'react'
import { useASRStore, type AgentRealtimeProvider, type AgentRealtimeOptions } from '@/store/useASRStore'

export type RealtimeVoiceProvider = {
  id: Exclude<AgentRealtimeProvider, 'off'>
  label: string
  model: string
  configured: boolean
  available: boolean
  unavailable_reason?: string
  default_voice: string
  voices: { id: string; name: string; gender: string; description?: string }[]
  supports_brain: boolean
}
export type RealtimeVoiceCatalog = {
  providers: RealtimeVoiceProvider[]
  config: { dashscope_workspace_id: string; dashscope_region: string }
  credential_status: Record<string, boolean>
  brain_available: boolean
}

const keyFields = [
  ['DASHSCOPE_API_KEY', '百炼 API Key'], ['GEMINI_API_KEY', 'Gemini API Key'],
  ['BOSON_API_KEY', 'Boson API Key'], ['XAI_API_KEY', 'xAI API Key'], ['OPENAI_API_KEY', 'OpenAI API Key'],
] as const
const providerFallbacks: { id: Exclude<AgentRealtimeProvider, 'off'>; label: string }[] = [
  { id: 'qwen', label: '千问 Audio 3.1 Realtime Plus' },
  { id: 'gemini_live', label: 'Gemini 3.8 Live' },
  { id: 'gemini_thinking', label: 'Gemini 3.8 Live Extended Thinking' },
  { id: 'higgs', label: 'Higgs Realtime' },
  { id: 'grok', label: 'Grok Voice Think Fast 2.0' },
  { id: 'openai', label: 'GPT Live（后续部署）' },
]

export function RealtimeVoiceConfig({ disabled, onCatalog }: {
  disabled: boolean
  onCatalog: (catalog: RealtimeVoiceCatalog | null) => void
}) {
  const settings = useASRStore((state) => state.settings)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const [catalog, setCatalog] = useState<RealtimeVoiceCatalog | null>(null)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  // Never put credentials in the global/persisted settings store.
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [workspace, setWorkspace] = useState('')
  const [region, setRegion] = useState('cn-beijing')
  const ready = settings.backendConfirmed && Boolean(settings.serverUrl.trim())
  const provider = catalog?.providers.find((item) => item.id === settings.agentRealtimeProvider)
  const options = settings.agentRealtimeOptions?.[settings.agentRealtimeProvider] || {}
  const voice = provider?.voices.some((item) => item.id === options.voice) ? options.voice : provider?.default_voice || ''
  const setOption = (patch: AgentRealtimeOptions) => {
    updateSettings({ agentRealtimeOptions: {
      ...settings.agentRealtimeOptions,
      [settings.agentRealtimeProvider]: { ...options, ...patch },
    } })
  }

  useEffect(() => {
    let active = true
    setCatalog(null); onCatalog(null); setError('')
    if (!ready) { setLoading(false); return }
    setLoading(true)
    void fetch(`${settings.serverUrl.replace(/\/$/, '')}/v1/live-voice/catalog`).then(async (response) => {
      if (!response.ok) throw new Error('无法读取实时语音配置，请检查后端连接。')
      const value = await response.json() as RealtimeVoiceCatalog
      if (!Array.isArray(value.providers)) throw new Error('后端尚未提供实时语音模型目录，请更新后端。')
      if (!active) return
      setCatalog(value); onCatalog(value)
      setWorkspace(value.config?.dashscope_workspace_id || '')
      setRegion(value.config?.dashscope_region || 'cn-beijing')
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : '实时语音配置读取失败') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [ready, settings.serverUrl, revision, onCatalog])

  useEffect(() => { setKeys({}); setMessage('') }, [settings.serverUrl])

  const save = async () => {
    if (!ready || saving || disabled) return
    const updates: Record<string, string> = { DASHSCOPE_WORKSPACE_ID: workspace.trim(), DASHSCOPE_REGION: region }
    for (const [name] of keyFields) if (keys[name]?.trim()) updates[name] = keys[name].trim()
    setSaving(true); setError(''); setMessage('')
    try {
      const response = await fetch(`${settings.serverUrl.replace(/\/$/, '')}/v1/live-voice/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Amadeus-Config': '1' },
        body: JSON.stringify(updates),
      })
      if (!response.ok) throw new Error('保存失败，请确认后端运行在本机并支持配置更新。')
      setKeys({}); setMessage('已保存到本机后端，密钥输入已清空。'); setRevision((value) => value + 1)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败') }
    finally { setSaving(false) }
  }

  return <div className="wide realtime-voice-config">
    <div className="agent-config-grid">
      <label>实时语音模型
        <select aria-label="实时语音通道" value={settings.agentRealtimeProvider} disabled={disabled} onChange={(event) => {
          updateSettings({ agentRealtimeProvider: event.target.value as AgentRealtimeProvider })
        }}>
          <option value="off">现有语音链路（Codex / 原有 Agent）</option>
          {providerFallbacks.map((fallback) => {
            const item = catalog?.providers.find((entry) => entry.id === fallback.id)
            return <option key={fallback.id} value={fallback.id}>{item?.label || fallback.label}{item ? item.available ? '' : ' · 暂不可用' : ''}</option>
          })}
        </select>
      </label>
      {settings.agentRealtimeProvider !== 'off' && <>
        <label>实时音色
          <select aria-label="实时音色" value={voice} disabled={disabled || !provider?.voices.length} onChange={(event) => setOption({ voice: event.target.value })}>
            {!provider?.voices.length && <option value="">等待音色目录</option>}
            {(['female', 'male', 'unknown'] as const).map((gender) => {
              const voices = provider?.voices.filter((item) => gender === 'unknown'
                ? !['female', 'male'].includes(item.gender) : item.gender === gender) || []
              return voices.length ? <optgroup key={gender} label={gender === 'female' ? '女声' : gender === 'male' ? '男声' : '性别未核实'}>
                {voices.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}{item.description ? ` · ${item.description}` : ''}</option>)}
              </optgroup> : null
            })}
          </select>
        </label>
        {provider?.id === 'qwen' && provider.supports_brain && <label>复杂任务大脑
          <select aria-label="实时语音大脑" value={options.brain || 'off'} disabled={disabled} onChange={(event) => setOption({ brain: event.target.value as 'off' | 'qwen3.7-plus' })}>
            <option value="off">语音模型自身回答</option>
            <option value="qwen3.7-plus" disabled={!catalog?.brain_available}>千问 3.7 Plus{catalog?.brain_available ? '' : '（尚不可用）'}</option>
          </select>
        </label>}
        {provider?.id === 'grok' && <label>原生思考
          <select aria-label="实时语音思考" value={options.reasoning || 'high'} disabled={disabled} onChange={(event) => setOption({ reasoning: event.target.value as 'high' | 'none' })}>
            <option value="high">开启思考</option><option value="none">关闭思考</option>
          </select>
        </label>}
        {provider?.id === 'gemini_thinking' && <label>原生思考强度
          <select aria-label="实时语音思考" value={options.reasoning || 'low'} disabled={disabled} onChange={(event) => setOption({ reasoning: event.target.value as 'low' | 'medium' | 'high' })}>
            <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
          </select>
        </label>}
        <p className="wide agent-live-config" aria-label="实时模型状态">{loading ? '正在读取模型配置…' : provider
          ? `${provider.model} · ${provider.available ? '可以连接' : provider.unavailable_reason || (provider.configured ? '已配置，暂不可用' : '尚未配置密钥')}`
          : '请连接本机后端后刷新模型目录。'}{disabled ? '结束当前会话后可切换模型和音色。' : ''}</p>
      </>}
    </div>
    <details>
      <summary>服务商密钥与百炼配置</summary>
      <p>密钥保存在本机后端；留空保留已有值。模型选择和音色可在上方切换。</p>
      <div className="agent-config-grid">
        {keyFields.map(([name, label]) => <label key={name}>{label}{catalog?.credential_status?.[name] ? '（已配置）' : '（未配置）'}
          <input aria-label={label} type="password" autoComplete="new-password" value={keys[name] || ''}
            disabled={saving || disabled || !ready} placeholder="留空保留已有密钥"
            onChange={(event) => setKeys((current) => ({ ...current, [name]: event.target.value }))} />
        </label>)}
        <label>百炼业务空间 ID<input aria-label="百炼业务空间 ID" value={workspace} disabled={saving || disabled || !ready} onChange={(event) => setWorkspace(event.target.value)} placeholder="默认业务空间可留空" /></label>
        <label>百炼地域<select aria-label="百炼地域" value={region} disabled={saving || disabled || !ready} onChange={(event) => setRegion(event.target.value)}>
          <option value="cn-beijing">北京</option><option value="ap-southeast-1">新加坡</option>
        </select></label>
      </div>
      <button type="button" disabled={!ready || disabled || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存实时语音配置'}</button>
    </details>
    <button type="button" disabled={!ready || disabled || loading || saving} onClick={() => setRevision((value) => value + 1)}>刷新语音配置</button>
    {message && <p role="status">{message}</p>}
    {error && <p className="error">{error}</p>}
  </div>
}
