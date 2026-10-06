import { useEffect, useRef, useState } from 'react'
import type { StorageState } from '@/services/storageTypes'
import { settingsAfterStorageChange } from '@/services/storageSettings'
import { useASRStore } from '@/store/useASRStore'
import './StorageLocations.css'

interface Props { disabled?: boolean; compact?: boolean; onBusyChange?: (busy: boolean) => void; onChanged?: () => Promise<void> }

export function StorageLocations({ disabled, compact, onBusyChange, onChanged }: Props) {
  const api = window.electronAPI
  const supported = typeof api?.storageStatus === 'function'
  const [state, setState] = useState<StorageState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => {
    let current = true
    alive.current = true
    if (supported) void api!.storageStatus().then((value) => { if (current && alive.current) setState(value) }).catch((reason) => { if (current && alive.current) setError(reason instanceof Error ? reason.message : '无法读取数据目录') })
    return () => { current = false; alive.current = false }
  }, [api, supported, disabled])
  if (!supported) return null

  const run = async (action: () => Promise<unknown>, update = false) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError(''); onBusyChange?.(true)
    try {
      await action()
      if (update) {
        const current = await api!.storageStatus()
        if (state) {
          const store = useASRStore.getState()
          const patch = settingsAfterStorageChange(store.settings, state, current)
          if (Object.keys(patch).length) store.updateSettings(patch)
        }
        if (alive.current) setState(current)
        await onChanged?.()
      }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '存储操作未完成') }
    finally { inFlight.current = false; if (alive.current) { setBusy(false); onBusyChange?.(false) } }
  }
  const locked = disabled || busy || state?.busy
  const paths = state ? [
    ['Python', state.pythonRoot], ['运行依赖', state.runtimeRoot], ['模型权重', state.modelsRoot],
    ['下载缓存', state.cacheRoot], ['临时文件', state.tempRoot], ['服务数据', state.backendDataRoot],
    ['角色模型', state.avatarRoot], ['录音与导出', state.archiveRoot],
  ] : []
  return <section className={`storage-locations${compact ? ' is-compact' : ''}`} aria-label="数据存储位置">
    <div className="storage-location-heading"><strong>数据存储位置</strong>{state && <span>{state.mode === 'managed' ? '集中存放' : state.mode === 'legacy' ? '沿用旧位置' : '待选择'}</span>}</div>
    <div className="storage-root"><code>{state?.root || '正在检查数据目录…'}</code><button type="button" disabled={locked || !state?.ready} onClick={() => void run(() => api!.storageOpenFolder())}>打开目录</button></div>
    {!compact && <><p className="storage-description">{state?.message || 'Python、依赖、模型和下载缓存由同一个数据目录管理。'}</p>
    <p className="storage-caution">{state?.mode === 'legacy' ? '旧环境仍在原位置。' : ''}选择新位置不会自动搬迁或删除旧文件，新环境需要重新安装；旧受管模型路径将恢复为默认位置。</p>
    <div className="storage-actions"><button type="button" disabled={locked || !state?.canChange} onClick={() => void run(() => api!.storageChooseDirectory(), true)}>选择数据位置</button><span>可选择其他磁盘；运行中的本机服务需先停止。</span></div></>}
    {error && <p role="alert" className="local-runtime-error">{error}</p>}
    {state?.error && <p role="alert" className="local-runtime-error">{state.error}</p>}
    {state?.cleanup && <p role="status" className={state.cleanup.status === 'failed' ? 'local-runtime-error' : 'storage-cleanup-result'}>{state.cleanup.message}</p>}
    {state && !compact && <details className="storage-details"><summary>查看目录明细与清理选项</summary>
      <dl>{paths.map(([name, folder]) => <div key={name}><dt>{name}</dt><dd><code>{folder}</code></dd></div>)}</dl>
      <p>界面偏好与数据位置记录仍保存在 <code>{state.configRoot}</code>。系统级驱动、其他软件的缓存不属于此目录。</p>
      <div className="storage-remove"><div><strong>清理当前受管数据</strong><p>删除此位置内的环境、模型、缓存和保存的数据。操作前会再次确认，卸载时也可以选择保留。</p></div><button type="button" className="danger" disabled={locked || !state.canClear} onClick={() => void run(() => api!.storageClearManagedData(), true)}>清理当前数据…</button></div>
      {state.legacyPaths.length > 0 && <div className="storage-retained"><h3>保留的旧位置</h3><p>切换位置不会自动删除这些文件。确认不再需要后，可分别清理。</p>{state.legacyPaths.map((item) => <article key={item.path}><strong>{item.label}</strong><code>{item.path}</code><div><button type="button" disabled={locked} onClick={() => void run(() => api!.storageOpenFolder(item.path))}>打开</button>{item.canClear && <button type="button" className="danger" disabled={locked} onClick={() => void run(() => api!.storageClearManagedData(item.path), true)}>清理此位置…</button>}</div>{item.reason && <p>{item.reason}</p>}</article>)}</div>}
    </details>}
  </section>
}
