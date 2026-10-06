import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ASRApi, isAbortError } from '@/services/api'
import { formatDownloadBytes, suggestedDownloadRegion, type DownloadableModel, type DownloadRegion, type DownloadSource, type ModelDownloadCatalog } from '@/services/modelDownloads'
import { DEFAULT_SETTINGS, useASRStore } from '@/store/useASRStore'
import { connectLocalRuntime, isSelectedLocalRuntime } from '@/services/localRuntimeConnection'
import type { LocalRuntimeState } from '@/services/localRuntimeTypes'
import { RuntimeInstallProgress } from './RuntimeInstallProgress'
import './ModelDownloads.css'

const regionKey = 'amadeus.modelDownload.region'
const sourceLabels: Record<string, string> = { auto: '智能选择（失败后自动换源）', modelscope: 'ModelScope · 国内仓库', huggingface: 'Hugging Face · 官方仓库', 'hf-mirror': 'HF Mirror · 第三方镜像', github: 'GitHub · 官方仓库' }
const jobLabels: Record<string, string> = { queued: '准备下载', downloading: '正在下载', verifying: '正在校验', completed: '下载完成', cancelled: '已暂停，可继续', error: '下载失败，可重试' }
const runningStates = ['queued', 'downloading', 'verifying']
const fileLabels = { pending: '等待处理', downloading: '下载中', verifying: '校验中', completed: '已校验' }

function initialRegion(): DownloadRegion {
  try { const saved = localStorage.getItem(regionKey); if (saved === 'mainland' || saved === 'global') return saved } catch { /* Use system suggestion. */ }
  return suggestedDownloadRegion()
}

export function ModelDownloads() {
  const settings = useASRStore(state => state.settings)
  const updateSettings = useASRStore(state => state.updateSettings)
  const api = useMemo(() => new ASRApi(settings.serverUrl), [settings.serverUrl])
  const backendReady = Boolean(settings.backendConfirmed && settings.serverUrl.trim())
  const [catalog, setCatalog] = useState<ModelDownloadCatalog | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [region, setRegion] = useState<DownloadRegion>(initialRegion)
  const [source, setSource] = useState<DownloadSource>('auto')
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [localRuntime, setLocalRuntime] = useState<LocalRuntimeState | null>(null)
  const pending = useRef(false)
  const alive = useRef(true)
  const chosen = catalog?.models.find(model => model.id === selectedId) || catalog?.models.find(model => model.engine === settings.offlineEngine) || catalog?.models[0]
  const job = chosen && (catalog?.jobs.find(item => item.id === chosen.id) || chosen.job)
  const downloading = !!job && runningStates.includes(job.status)
  const percent = job && Number.isFinite(job.total_bytes) && job.total_bytes > 0 ? Math.max(0, Math.min(100, job.downloaded_bytes / job.total_bytes * 100)) : undefined
  const managedBackend = localRuntime?.owned && localRuntime.url?.replace(/\/+$/, '') === settings.serverUrl.replace(/\/+$/, '')
  const anyDownloading = catalog?.jobs.some(item => runningStates.includes(item.status))
  const installingRuntime = isSelectedLocalRuntime(localRuntime, settings.serverUrl) && !!localRuntime && ['installing', 'starting', 'stopping'].includes(localRuntime.phase)

  useEffect(() => {
    const host = window.electronAPI
    if (!host?.localRuntimeStatus || !host.onLocalRuntimeState) return
    let active = true
    const off = host.onLocalRuntimeState(value => { if (active) setLocalRuntime(value) })
    void host.localRuntimeStatus().then(value => { if (active) setLocalRuntime(value) }).catch(() => {})
    return () => { active = false; off() }
  }, [])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await api.modelDownloadCatalog(signal)
    if (alive.current && !signal?.aborted) { setCatalog(result); setPollError('') }
  }, [api])

  useEffect(() => {
    alive.current = true
    if (!backendReady) { setCatalog(null); return () => { alive.current = false } }
    // Runtime installation intentionally stops the local backend. Preserve
    // its catalog and show installation progress while the service restarts.
    if (installingRuntime) { setPollError(''); return () => { alive.current = false } }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { await refresh(controller.signal) } catch (reason) {
        if (alive.current && !controller.signal.aborted && !isAbortError(reason)) setPollError(reason instanceof Error ? reason.message : '无法读取模型下载状态')
      } finally { if (!controller.signal.aborted) timer = setTimeout(poll, 1500) }
    }
    void poll()
    return () => { alive.current = false; controller.abort(); clearTimeout(timer) }
  }, [backendReady, refresh, installingRuntime])

  const act = async (action: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try { await action() } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '操作失败') }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }

  const setRegionChoice = (value: DownloadRegion) => {
    setRegion(value)
    try { localStorage.setItem(regionKey, value) } catch { /* Region still works for this page. */ }
  }

  const selectForRecognition = (model: DownloadableModel) => {
    const previous = settings.asrModelConfigs[model.engine]
    const defaults = DEFAULT_SETTINGS.asrModelConfigs[model.engine]
    updateSettings({
      [model.engine === 'x-asr' ? 'streamingEngine' : 'offlineEngine']: model.engine,
      asrModelConfigs: { ...settings.asrModelConfigs, [model.engine]: {
        modelName: model.model_name, device: previous?.device || defaults?.device || 'cuda',
        computeType: previous?.computeType ?? defaults?.computeType ?? '',
        ...(previous?.deviceConfigured ? { deviceConfigured: true } : {}),
        extraJson: JSON.stringify({ ...(previous ? JSON.parse(previous.extraJson || '{}') : {}), model_dir: model.weights.path }),
      } },
    })
    setNotice('已设为识别模型；本模型运行组件齐备后，可到“识别引擎”中加载。')
  }

  return <section className="model-downloads" aria-labelledby="model-download-title">
    <h3 id="model-download-title">下载本地模型</h3>
    {installingRuntime && <p role="status">{localRuntime!.message}</p>}
    {installingRuntime && localRuntime?.installProgress && <RuntimeInstallProgress value={localRuntime.installProgress} />}
    {!backendReady ? <p>请先在首页启动本机服务，或连接已有后端。</p> : <>
      <div className="model-download-choices">
        <label>模型<select aria-label="要下载的模型" value={chosen?.id || ''} disabled={busy || !catalog} onChange={event => { setSelectedId(event.target.value); setSource('auto'); setNotice('') }}>
          {!catalog && <option value="">读取模型列表…</option>}
          {catalog?.models.map(model => <option key={model.id} value={model.id}>{model.label}{model.weights.status === 'ready' ? ' · 已校验' : model.weights.status === 'existing' ? ' · 已有文件' : ''}</option>)}
        </select></label>
        <label>下载地区<select aria-label="模型下载地区" value={region} disabled={busy || downloading} onChange={event => setRegionChoice(event.target.value as DownloadRegion)}><option value="mainland">中国大陆</option><option value="global">其他地区</option></select></label>
        <label>下载来源<select aria-label="模型下载来源" value={source} disabled={busy || downloading} onChange={event => setSource(event.target.value as DownloadSource)}><option value="auto">{sourceLabels.auto}</option>{chosen?.sources.map(item => <option key={item.id} value={item.id}>{item.label || sourceLabels[item.id]}</option>)}</select></label>
      </div>
      {chosen && <>
        <div className="model-download-status">
          <strong>{chosen.weights.status === 'ready' ? '权重已下载并校验' : chosen.weights.status === 'existing' ? '检测到已有权重（未经下载器校验）' : '尚未下载权重'}</strong>
          <span>{chosen.runtime.installed ? '本模型运行组件已就绪' : '还需安装本模型运行组件'}</span>
          {!!chosen.estimated_size_bytes && <span>预计下载 {formatDownloadBytes(chosen.estimated_size_bytes)}</span>}
        </div>
        <p className="model-download-path">模型目录（后端）：<code>{chosen.weights.path}</code></p>
        {!chosen.runtime.installed && <p className="model-download-missing">缺少：<code>{chosen.runtime.missing_modules.join('、') || chosen.runtime.extra}</code></p>}
        {job && <div className="model-download-job" role="status" aria-live="polite"><strong>{jobLabels[job.status]}{job.source ? ` · ${chosen.sources.find(item => item.id === job.source)?.label || sourceLabels[job.source] || job.source}` : ''}</strong>
          {downloading && <progress max={100} value={percent} aria-label="模型权重下载进度" />}
          <div className="model-download-metrics"><span>已下载 {formatDownloadBytes(job.downloaded_bytes)}{percent !== undefined ? ` / ${formatDownloadBytes(job.total_bytes)} · ${(Math.floor(percent * 10) / 10).toFixed(1)}%` : ' · 总大小未知'}</span>{job.speed_bytes_per_second > 0 && <span>平均速度 {formatDownloadBytes(job.speed_bytes_per_second)}/s</span>}{!!job.total_files && <span>已校验文件 {job.completed_files ?? 0} / {job.total_files}</span>}</div>
          {percent === undefined && <small>{downloading ? '正在获取文件清单，总大小尚未取得，暂不显示百分比。' : '文件清单尚未取得，总大小未知。'}</small>}
          {job.current_file && <div className="model-download-current"><span>当前文件：<code>{job.current_file}</code></span>{job.current_file_downloaded_bytes !== undefined && <small>{formatDownloadBytes(job.current_file_downloaded_bytes)} / {job.current_file_total_bytes !== undefined ? formatDownloadBytes(job.current_file_total_bytes) : '大小未知'}</small>}</div>}
          {job.message && <small>{job.message}</small>}{job.error && <p className="error">{job.error}</p>}
        </div>}
        {!!job?.files?.length && <details className="model-download-files"><summary>文件清单（{job.files.length}）</summary><div className="model-download-file-table"><table><thead><tr><th scope="col">文件</th><th scope="col">大小</th><th scope="col">已下载</th><th scope="col">状态</th></tr></thead><tbody>{job.files.map(file => <tr key={file.path}><th scope="row"><code>{file.path}</code></th><td>{formatDownloadBytes(file.size)}</td><td>{formatDownloadBytes(file.downloaded_bytes)}</td><td>{fileLabels[file.status] || '等待处理'}</td></tr>)}</tbody></table></div></details>}
        <div className="model-download-actions">
          {downloading ? <button type="button" disabled={busy} onClick={() => void act(async () => { await api.cancelModelDownload(chosen.id); await refresh() })}>暂停下载</button>
            : <button type="button" className="primary" disabled={busy || chosen.weights.status === 'ready'} onClick={() => void act(async () => { await api.startModelDownload(chosen.id, region, source); await refresh() })}>{chosen.weights.status === 'ready' ? '已完成下载' : job?.status === 'cancelled' ? '继续下载' : job?.status === 'error' ? '重试下载' : chosen.weights.status === 'existing' ? '补全并校验' : source === 'auto' ? '智能下载' : '从此来源下载'}</button>}
          {chosen.weights.status !== 'missing' && <button type="button" disabled={busy || downloading} onClick={() => void act(async () => selectForRecognition(chosen))}>设为识别模型</button>}
          {!chosen.runtime.installed && managedBackend && window.electronAPI?.localRuntimeInstallExtra && <button type="button" disabled={busy || anyDownloading} onClick={() => void act(async () => {
            const result = await window.electronAPI!.localRuntimeInstallExtra(chosen.runtime.extra || chosen.runtime_extra || '')
            if (result.phase !== 'running') throw new Error(result.error || result.message)
            connectLocalRuntime(result, true)
            const refreshed = await new ASRApi(result.url!).modelDownloadCatalog()
            if (alive.current) { setCatalog(refreshed); setPollError('') }
            setNotice('本模型运行组件安装完成，后端已重新启动。')
          })}>安装本模型运行组件（会重启服务）</button>}
          <button type="button" disabled={busy} onClick={() => void act(() => refresh())}>刷新下载状态</button>
        </div>
        <details className="model-download-details">
          <summary>来源与下载说明</summary>
          {job?.staging_path && <p>续传缓存：<code>{job.staging_path}</code></p>}
          {job?.backup_path && <p>原模型备份：<code>{job.backup_path}</code></p>}
          <p>来源与网络：地区初始建议来自系统时区，可手动更改。{region === 'mainland' ? '大陆优先国内仓库或镜像。' : '其他地区优先官方 Hugging Face / GitHub。'}仅使用该模型已核实的来源。</p>
          {chosen.notes && <p>{Array.isArray(chosen.notes) ? chosen.notes.join('；') : chosen.notes}</p>}
          {!chosen.runtime.installed && <p>基础环境在首页安装一次，所有任务共用；这里按需补充本模型的运行组件。下载权重与安装组件分开进行；CUDA 驱动、第三方模型源码需按模型说明准备。{chosen.runtime.notes}</p>}
          {!!chosen.estimated_size_bytes && <p>预计下载量仅包含权重，运行组件和模型加载内存另计。</p>}
          <p>下载在后端进行，离开页面仍会继续。暂停会保留可续传文件；校验完成后才放入模型目录。更换已有权重会保留原目录备份。</p>
          <p>“已下载”包含本次来源可复用的续传数据，完成校验前不代表模型可用；平均速度只计算本次实际接收的数据。切换来源或丢弃损坏文件时进度可能回退。</p>
        </details>
      </>}
      {catalog?.jobs.some(item => item.id !== chosen?.id && runningStates.includes(item.status)) && <p className="model-download-hint">还有其他下载任务运行中，切换模型可查看进度。</p>}
    </>}
    {notice && <p role="status">{notice}</p>}{(error || pollError) && <p role="alert" className="error">{error || pollError}</p>}
  </section>
}
