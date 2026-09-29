import { useEffect, useRef, useState } from 'react'
import { useASRStore } from '@/store/useASRStore'
import { connectLocalRuntime } from '@/services/localRuntimeConnection'
import type { LocalRuntimeState } from '@/services/localRuntimeTypes'
import './LocalRuntimePanel.css'

const phaseNames: Record<LocalRuntimeState['phase'], string> = {
  missing: '尚未安装', installing: '正在安装', ready: '已安装', starting: '正在启动',
  running: '运行中', stopping: '正在停止', error: '需要处理',
}

export function LocalRuntimePanel() {
  const [state, setState] = useState<LocalRuntimeState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const aliveRef = useRef(true)
  const serverUrl = useASRStore((store) => store.settings.serverUrl)
  const backendConfirmed = useASRStore((store) => store.settings.backendConfirmed)
  const setPage = useASRStore((store) => store.setPage)
  const api = window.electronAPI
  const supported = typeof api?.localRuntimeStatus === 'function' && typeof api.localRuntimeInstall === 'function' && typeof api.onLocalRuntimeState === 'function'
  const changing = busy || ['installing', 'starting', 'stopping'].includes(state?.phase || '')
  const connected = state?.phase === 'running' && backendConfirmed && serverUrl.replace(/\/+$/, '') === state.url?.replace(/\/+$/, '')

  useEffect(() => {
    aliveRef.current = true
    if (!supported || !api) return () => { aliveRef.current = false }
    let receivedEvent = false
    const off = api.onLocalRuntimeState((value) => {
      receivedEvent = true
      if (aliveRef.current) { setState(value); setError('') }
    })
    void api.localRuntimeStatus().then((value) => {
      if (aliveRef.current && !receivedEvent) setState(value)
    }).catch((reason: unknown) => {
      if (aliveRef.current) setError(reason instanceof Error ? reason.message : '无法检查本机环境')
    })
    return () => { aliveRef.current = false; off() }
  }, [api, supported])

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try { await action() } catch (reason) {
      if (aliveRef.current) setError(reason instanceof Error ? reason.message : '操作失败，请查看安装日志后重试')
    } finally {
      busyRef.current = false
      if (aliveRef.current) setBusy(false)
    }
  }

  const accept = (value: LocalRuntimeState) => {
    if (aliveRef.current) setState(value)
    if (value.phase === 'error') throw new Error(value.error || value.message || '本机环境操作失败')
    return value
  }

  const install = async (start: boolean) => {
    if (!api) return
    const installed = accept(await api.localRuntimeInstall())
    if (!installed.installed) throw new Error('环境尚未安装完成，请查看安装日志后重试')
    if (start) connectLocalRuntime(accept(await api.localRuntimeStart()), true)
  }

  const start = async () => {
    if (api) connectLocalRuntime(accept(await api.localRuntimeStart()), true)
  }

  const readyToStart = state?.installed && state.phase !== 'running'
  const needsInstall = state && !state.installed && state.phase !== 'running'
  const displayedError = error || state?.error

  return (
    <section className="panel local-runtime-panel" aria-labelledby="local-runtime-heading">
      <div className="section-head">
        <div><h2 id="local-runtime-heading">在这台电脑上运行</h2><p>安装一次，之后可一键启动或随应用自动启动。</p></div>
        {state && <span className={`soft-badge ${state.phase === 'running' ? 'success' : ''}`}>{phaseNames[state.phase]}</span>}
      </div>
      <p className="local-runtime-intro">自动准备 Windows 本机服务环境。界面已随应用安装，无需准备 Linux、Python 或 Node.js。首次安装需要联网下载，之后无需重复安装。</p>
      <ol className="local-runtime-steps" aria-label="开始使用步骤">
        <li><span>1</span>安装本机环境</li><li><span>2</span>启动服务</li><li><span>3</span>选择语音模型</li>
      </ol>
      {!supported ? <p className="local-runtime-hint">请使用 Windows 桌面版安装本机环境。已有服务可在下方填写后端地址。</p> : <>
        <p className="local-runtime-status" role="status" aria-live="polite">{state?.message || (error ? '环境检查失败，可以重试。' : '正在检查本机环境…')}</p>
        {changing && <progress max={100} value={typeof state?.progress === 'number' ? Math.min(100, Math.max(0, state.progress)) : undefined} aria-label="本机环境安装和启动进度" />}
        {displayedError && <p className="local-runtime-error" role="alert">{displayedError}</p>}
        <div className="local-runtime-actions">
          {needsInstall && <>
            <button className="primary" type="button" disabled={changing} onClick={() => void run(() => install(true))}>{state.phase === 'error' ? '重试安装并启动' : '一键安装并启动'}</button>
            <button type="button" disabled={changing} onClick={() => void run(() => install(false))}>只安装环境</button>
          </>}
          {readyToStart && <>
            <button className="primary" type="button" disabled={changing} onClick={() => void run(start)}>{state.phase === 'error' ? '重试启动本机服务' : '启动本机服务'}</button>
            <button type="button" disabled={changing} onClick={() => void run(() => install(false))}>修复环境</button>
          </>}
          {state?.phase === 'running' && <>
            {!connected && <button className="primary" type="button" disabled={changing} onClick={() => connectLocalRuntime(state, true)}>连接此服务</button>}
            {connected && <button className="primary" type="button" onClick={() => setPage('realtime')}>进入实时语音对话</button>}
            <button type="button" disabled={changing || !state.owned} title={state.owned ? undefined : '该服务由其他程序启动，请在原程序中停止'} onClick={() => void run(async () => { if (api) accept(await api.localRuntimeStop()) })}>停止本机服务</button>
          </>}
          <button type="button" disabled={changing} onClick={() => void run(async () => { if (api) accept(await api.localRuntimeStatus()) })}>重新检查</button>
          {state?.logPath && <button type="button" onClick={() => void run(async () => { await api?.localRuntimeOpenLogs() })}>查看日志</button>}
        </div>
        {state && <label className="local-runtime-auto"><input type="checkbox" checked={state.autoStart} disabled={changing} onChange={(event) => { const enabled = event.target.checked; void run(async () => { if (api) accept(await api.localRuntimeSetAutoStart(enabled)) }) }} />打开 Amadeus 时自动启动</label>}
        {state?.url && <p className="local-runtime-address">本机服务：<code>{state.url}</code>{connected && <span className="soft-badge success">当前已连接</span>}{state.phase === 'running' && !state.owned && <span>由其他程序启动</span>}</p>}
        {state?.phase === 'running' && !connected && serverUrl && <p className="local-runtime-hint">当前仍连接 {serverUrl}，点击“连接此服务”可切换到本机。</p>}
        {state?.root && <details className="local-runtime-details"><summary>安装位置与日志</summary><p>环境目录：<code>{state.root}</code></p><p>日志：<code>{state.logPath}</code></p><button type="button" onClick={() => void run(async () => { await api?.localRuntimeOpenFolder() })}>打开环境目录</button></details>}
      </>}
      <p className="local-runtime-hint">基础环境支持实时语音 API 与 3D 数字人。安装完成后，在“实时语音对话”中配置模型密钥。本地 ASR 的模型权重和 GPU 环境按需另行安装。</p>
    </section>
  )
}
