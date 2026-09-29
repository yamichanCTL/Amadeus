import { useEffect, useState } from 'react'
import type { LocalAvatarStatus } from '../vite-env'
import { watchLocalAvatar } from '../services/localAvatar'
import './LocalAvatarPanel.css'

export function LocalAvatarPanel({ compact = false }: { compact?: boolean }) {
  const api = window.electronAPI
  const supported = Boolean(api?.localAvatarImport)
  const [status, setStatus] = useState<LocalAvatarStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!api?.localAvatarStatus) return
    return watchLocalAvatar(api, setStatus)
  }, [api])

  const change = async (clear = false) => {
    if (!api || busy) return
    setBusy(true)
    setError('')
    try {
      const result = clear ? await api.localAvatarClear() : await api.localAvatarImport()
      if (!('cancelled' in result && result.cancelled)) setStatus(result)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '导入模型失败，请换一个 GLB 文件重试。')
    } finally { setBusy(false) }
  }
  return <section className={`local-avatar-panel${compact ? ' compact' : ''}`} aria-label="本地 3D 模型">
    <strong>{status?.available ? status.name || '已导入本地模型' : '导入你的 3D 模型'}</strong>
    {!compact && <p>选择包含贴图的 GLB 文件，主窗口和桌宠会同步更新。文件只保存在本机，不会上传。</p>}
    {!status?.available && <p>安装包不附带角色模型。{compact ? '请选择本机 GLB 文件。' : '普通 GLB 可显示；口型与动作需要模型包含对应的形变和骨骼。'}</p>}
    <div className="local-avatar-actions">
      <button type="button" disabled={!supported || busy} onClick={() => void change()}>
        {busy ? '正在处理模型……' : status?.available ? '更换本地模型' : '导入本地 GLB'}
      </button>
      {!compact && status?.available && <button type="button" className="secondary" disabled={busy} onClick={() => void change(true)}>移除本机模型</button>}
    </div>
    {!supported && <p>请在 Windows 桌面版中导入本地模型。</p>}
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
  </section>
}
