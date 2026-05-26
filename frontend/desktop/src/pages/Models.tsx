import { useEffect, useMemo, useState } from 'react'
import { ASRApi, type ModelInfo } from '@/services/api'
import { useASRStore } from '@/store/useASRStore'

const builtInEngines = ['whisper', 'vosk', 'sherpa', 'fireredasr2', 'wenet']

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
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])

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

  const rows: ModelInfo[] = builtInEngines.map((engine) => models.find((model) => model.engine === engine) || {
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

  return (
    <div className="page models-page">
      <section className="panel">
        <div className="panel-head">
          <h1>模型管理</h1>
          <button type="button" onClick={refresh}>刷新</button>
        </div>
        {error && <p className="error">{error}</p>}
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
      </section>
    </div>
  )
}
