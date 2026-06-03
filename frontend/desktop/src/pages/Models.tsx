import { useEffect, useMemo, useState } from 'react'
import { ASRApi, type LLMModelsResult, type ModelInfo } from '@/services/api'
import { getProviderPreset, LLM_PROVIDER_PRESETS, type LLMProvider } from '@/services/llmProviders'
import { useASRStore } from '@/store/useASRStore'

const builtInEngines = ['whisper', 'vosk', 'sherpa', 'fireredasr2', 'wenet']
type ModelTab = 'asr' | 'llm' | 'translate'

const defaultPayloads: Record<string, Record<string, unknown>> = {
  whisper: { model_name: 'base', device: 'cuda', compute_type: 'int8' },
  fireredasr2: { model_name: 'FireRedASR2-AED', device: 'cuda' },
  wenet: { model_name: 'FireRed-Wenet-1B', device: 'cuda', extra: { decode_mode: 'ctc_greedy_search', dtype: 'fp32', is_1b: true } }
}

export function ModelsPage() {
  const settings = useASRStore((state) => state.settings)
  const models = useASRStore((state) => state.models)
  const setModels = useASRStore((state) => state.setModels)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const [activeTab, setActiveTab] = useState<ModelTab>('asr')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [llmModels, setLlmModels] = useState<LLMModelsResult | null>(null)
  const [translationModels, setTranslationModels] = useState<LLMModelsResult | null>(null)
  const [modelProbe, setModelProbe] = useState<'llm' | 'translate' | ''>('')
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const llmPreset = getProviderPreset(settings.llmProvider)
  const translationPreset = getProviderPreset(settings.translationProvider)

  const refresh = async () => {
    try {
      setError('')
      setModels(await api.models())
    } catch (modelError) {
      setError(modelError instanceof Error ? modelError.message : '模型列表获取失败')
    }
  }

  useEffect(() => {
    void refresh()
  }, [api])

  useEffect(() => {
    if (activeTab !== 'llm') return
    if (!settings.llmBaseUrl.trim() || settings.llmApiToken.trim().length < 6) {
      setLlmModels(null)
      return
    }
    const timer = window.setTimeout(() => {
      void checkRemoteModels('llm')
    }, 650)
    return () => window.clearTimeout(timer)
  }, [activeTab, settings.llmProvider, settings.llmBaseUrl, settings.llmApiToken, api])

  useEffect(() => {
    if (activeTab !== 'translate') return
    const token = settings.translationApiToken.trim() || settings.llmApiToken.trim()
    if (!settings.translationBaseUrl.trim() || token.length < 6) {
      setTranslationModels(null)
      return
    }
    const timer = window.setTimeout(() => {
      void checkRemoteModels('translate')
    }, 650)
    return () => window.clearTimeout(timer)
  }, [
    activeTab,
    settings.translationProvider,
    settings.translationBaseUrl,
    settings.translationApiToken,
    settings.llmApiToken,
    api
  ])

  const modelList = Array.isArray(models) ? models : []
  const rows: ModelInfo[] = builtInEngines.map((engine) => modelList.find((model) => model.engine === engine) || {
    engine,
    model_name: defaultPayloads[engine]?.model_name as string || engine,
    is_loaded: false,
    device: null,
    compute_type: null,
    languages: [],
    extra: {}
  })

  const load = async (engine: string) => {
    setBusy(engine)
    try {
      await api.loadModel(engine, defaultPayloads[engine] || {})
      await refresh()
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '模型加载失败')
    } finally {
      setBusy('')
    }
  }

  const unload = async (engine: string) => {
    setBusy(engine)
    try {
      await api.unloadModel(engine)
      await refresh()
    } catch (unloadError) {
      setError(unloadError instanceof Error ? unloadError.message : '模型卸载失败')
    } finally {
      setBusy('')
    }
  }

  const chooseLLMProvider = (provider: LLMProvider) => {
    const preset = getProviderPreset(provider)
    updateSettings({
      llmProvider: provider,
      llmBaseUrl: provider === 'custom' ? settings.llmBaseUrl : preset.baseUrl
    })
  }

  const chooseTranslationProvider = (provider: LLMProvider) => {
    const preset = getProviderPreset(provider)
    updateSettings({
      translationProvider: provider,
      translationBaseUrl: provider === 'custom' ? settings.translationBaseUrl : preset.baseUrl
    })
  }

  const checkRemoteModels = async (kind: 'llm' | 'translate') => {
    const isTranslate = kind === 'translate'
    const baseUrl = isTranslate ? settings.translationBaseUrl : settings.llmBaseUrl
    const apiToken = isTranslate
      ? settings.translationApiToken.trim() || settings.llmApiToken.trim()
      : settings.llmApiToken
    const provider = isTranslate ? settings.translationProvider : settings.llmProvider
    if (!baseUrl.trim() || !apiToken.trim()) {
      const empty: LLMModelsResult = {
        connected: false,
        models: [],
        provider,
        base_url: baseUrl,
        message: '请先填写接口地址和 API Token'
      }
      if (isTranslate) setTranslationModels(empty)
      else setLlmModels(empty)
      return
    }
    setModelProbe(kind)
    try {
      const result = await api.listLLMModels({
        base_url: baseUrl,
        api_token: apiToken,
        provider
      })
      if (isTranslate) setTranslationModels(result)
      else setLlmModels(result)
    } catch (probeError) {
      const failed: LLMModelsResult = {
        connected: false,
        models: [],
        provider,
        base_url: baseUrl,
        message: probeError instanceof Error ? probeError.message : '模型连接检测失败'
      }
      if (isTranslate) setTranslationModels(failed)
      else setLlmModels(failed)
    } finally {
      setModelProbe('')
    }
  }

  const chooseRemoteModel = (kind: 'llm' | 'translate', model: string) => {
    if (kind === 'translate') updateSettings({ translationModel: model })
    else updateSettings({ llmModel: model })
  }

  const renderProviderProbe = (kind: 'llm' | 'translate', result: LLMModelsResult | null) => {
    const isChecking = modelProbe === kind
    const hasToken = kind === 'translate'
      ? Boolean(settings.translationApiToken.trim() || settings.llmApiToken.trim())
      : Boolean(settings.llmApiToken.trim())
    return (
      <div className={result?.connected ? 'provider-status connected' : 'provider-status'}>
        <div>
          <strong>{isChecking ? '正在连接官方接口' : result?.connected ? '连接成功' : '未连接'}</strong>
          <span>{result?.message || (hasToken ? '等待检测' : '填写 API Token 后自动检测')}</span>
        </div>
        <button type="button" disabled={isChecking} onClick={() => void checkRemoteModels(kind)}>
          {isChecking ? '检测中' : '刷新模型'}
        </button>
        {result?.models.length ? (
          <div className="remote-model-list">
            <select
              value={kind === 'translate' ? settings.translationModel : settings.llmModel}
              onChange={(event) => chooseRemoteModel(kind, event.target.value)}
            >
              <option value="">选择可用模型</option>
              {result.models.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
            {result.models.map((model) => (
              <button key={model} type="button" onClick={() => chooseRemoteModel(kind, model)}>
                {model}
              </button>
            ))}
          </div>
        ) : (
          <p className="empty">暂无可选模型。</p>
        )}
      </div>
    )
  }

  return (
    <div className="page models-page">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h1>模型管理</h1>
            <p>集中管理 ASR、本地模型和 OpenAI 兼容模型配置。</p>
          </div>
          <button type="button" onClick={refresh}>刷新</button>
        </div>
        <div className="model-tabs">
          <button type="button" className={activeTab === 'asr' ? 'active' : ''} onClick={() => setActiveTab('asr')}>ASR 模型设置</button>
          <button type="button" className={activeTab === 'llm' ? 'active' : ''} onClick={() => setActiveTab('llm')}>大模型设置</button>
          <button type="button" className={activeTab === 'translate' ? 'active' : ''} onClick={() => setActiveTab('translate')}>翻译模型设置</button>
        </div>
        {error && <p className="error">{error}</p>}
        {activeTab === 'asr' && (
          <div className="model-section">
            <div className="model-settings-grid">
              <label>
                默认 ASR 引擎
                <select value={settings.defaultEngine} onChange={(event) => updateSettings({ defaultEngine: event.target.value, selectedEngines: [event.target.value] })}>
                  {builtInEngines.map((engine) => <option key={engine} value={engine}>{engine}</option>)}
                </select>
              </label>
              <label>
                默认语言
                <select value={settings.defaultLanguage} onChange={(event) => updateSettings({ defaultLanguage: event.target.value })}>
                  <option value="zh">中文</option>
                  <option value="en">英文</option>
                  <option value="auto">自动</option>
                </select>
              </label>
              <label>
                合并策略
                <select value={settings.mergeStrategy} onChange={(event) => updateSettings({ mergeStrategy: event.target.value as typeof settings.mergeStrategy })}>
                  <option value="first">优先首个引擎</option>
                  <option value="vote">投票合并</option>
                  <option value="concat">拼接结果</option>
                </select>
              </label>
              <label>
                Whisper 模型
                <input value={settings.whisperModel} onChange={(event) => updateSettings({ whisperModel: event.target.value })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.multiEngine} onChange={(event) => updateSettings({ multiEngine: event.target.checked })} />
                启用多 ASR 引擎
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.enablePunctuation} onChange={(event) => updateSettings({ enablePunctuation: event.target.checked })} />
                标点恢复
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.enableDiarize} onChange={(event) => updateSettings({ enableDiarize: event.target.checked })} />
                说话人分离
              </label>
            </div>
            <div className="model-table">
              {rows.map((model) => (
                <article key={model.engine} className="model-row">
                  <div>
                    <strong>{model.engine}</strong>
                    <span>{model.model_name}</span>
                  </div>
                  <span className={model.is_loaded ? 'loaded' : 'unloaded'}>{model.is_loaded ? '已加载' : '未加载'}</span>
                  <span>{model.device || '-'}</span>
                  <span>{model.compute_type || '-'}</span>
                  <div className="row-actions">
                    <button type="button" onClick={() => updateSettings({ defaultEngine: model.engine, selectedEngines: [model.engine] })}>
                      {settings.defaultEngine === model.engine ? '默认' : '设默认'}
                    </button>
                    {model.is_loaded ? (
                      <button type="button" disabled={busy === model.engine} onClick={() => unload(model.engine)}>卸载</button>
                    ) : (
                      <button type="button" disabled={busy === model.engine} onClick={() => load(model.engine)}>加载</button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
        {activeTab === 'llm' && (
          <div className="model-section">
            <div className="model-settings-grid">
              <label>
                厂商
                <select value={settings.llmProvider} onChange={(event) => chooseLLMProvider(event.target.value as LLMProvider)}>
                  {LLM_PROVIDER_PRESETS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                </select>
              </label>
              <label>
                接口地址
                <input value={settings.llmBaseUrl} placeholder={llmPreset.baseUrl || 'https://example.com/v1'} onChange={(event) => updateSettings({ llmBaseUrl: event.target.value })} />
              </label>
              <label>
                模型
                <input value={settings.llmModel} placeholder={llmPreset.modelPlaceholder} onChange={(event) => updateSettings({ llmModel: event.target.value })} />
              </label>
              <label>
                API Token
                <input type="password" value={settings.llmApiToken} placeholder={`${llmPreset.tokenPlaceholder}，仅保存在本机`} onChange={(event) => updateSettings({ llmApiToken: event.target.value })} />
              </label>
              <div className="wide">
                {renderProviderProbe('llm', llmModels)}
              </div>
              <label className="wide">
                润色 / 总结风格
                <input value={settings.llmStyle} placeholder="例如：正式、简洁、会议纪要风格" onChange={(event) => updateSettings({ llmStyle: event.target.value })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.llmAutoPolish} onChange={(event) => updateSettings({ llmAutoPolish: event.target.checked })} />
                转写完成后自动润色
              </label>
            </div>
          </div>
        )}
        {activeTab === 'translate' && (
          <div className="model-section">
            <div className="model-settings-grid">
              <label>
                厂商
                <select value={settings.translationProvider} onChange={(event) => chooseTranslationProvider(event.target.value as LLMProvider)}>
                  {LLM_PROVIDER_PRESETS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                </select>
              </label>
              <label>
                接口地址
                <input value={settings.translationBaseUrl} placeholder={translationPreset.baseUrl || settings.llmBaseUrl} onChange={(event) => updateSettings({ translationBaseUrl: event.target.value })} />
              </label>
              <label>
                翻译模型
                <input value={settings.translationModel} placeholder={translationPreset.modelPlaceholder} onChange={(event) => updateSettings({ translationModel: event.target.value })} />
              </label>
              <label>
                API Token
                <input type="password" value={settings.translationApiToken} placeholder={`${translationPreset.tokenPlaceholder}，留空则使用大模型 Token`} onChange={(event) => updateSettings({ translationApiToken: event.target.value })} />
              </label>
              <div className="wide">
                {renderProviderProbe('translate', translationModels)}
              </div>
              <label>
                目标语言
                <input value={settings.llmTargetLanguage} onChange={(event) => updateSettings({ llmTargetLanguage: event.target.value })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={settings.llmAutoTranslate} onChange={(event) => updateSettings({ llmAutoTranslate: event.target.checked })} />
                转写完成后自动翻译
              </label>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
