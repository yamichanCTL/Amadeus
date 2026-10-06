import { useEffect, useId, useState } from 'react'
import { useASRStore } from '@/store/useASRStore'
import './BackendConnectionSettings.css'

/** Shared backend connection; drafts do not affect running task requests. */
export function BackendConnectionSettings() {
  const serverUrl = useASRStore((state) => state.settings.serverUrl)
  const backendConfirmed = useASRStore((state) => state.settings.backendConfirmed)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const [draftServerUrl, setDraftServerUrl] = useState(serverUrl)
  const [status, setStatus] = useState<{ serverUrl: string; message: string } | null>(null)
  const inputId = useId()

  useEffect(() => {
    setDraftServerUrl(serverUrl)
  }, [serverUrl])

  const confirmServerUrl = () => {
    const trimmed = draftServerUrl.trim()
    if (trimmed && trimmed !== '/' && !/^https?:\/\//i.test(trimmed) && !/^\S+:\d+$/.test(trimmed)) {
      setStatus({ serverUrl, message: '地址格式无效，请填写形如 http://host:port 的地址' })
      return
    }
    updateSettings({ serverUrl: trimmed, backendConfirmed: Boolean(trimmed) })
    const confirmedUrl = useASRStore.getState().settings.serverUrl
    setStatus({ serverUrl: confirmedUrl, message: confirmedUrl ? `已确认后端地址：${confirmedUrl}` : '已清空后端地址，未设置不进行通信' })
  }

  return <section className="backend-connection-settings" aria-label="已有服务连接">
    <p>已有本机或其他电脑上的 Amadeus 服务，可在这里连接。所有任务共用此地址，只需确认一次。</p>
    <label htmlFor={inputId}>后端地址</label>
    <div className="inline-control">
      <input id={inputId} value={draftServerUrl} onChange={(event) => { setDraftServerUrl(event.target.value); setStatus(null) }} onKeyDown={(event) => { if (event.key === 'Enter') confirmServerUrl() }} placeholder="http://your-server-ip:18000" />
      <button type="button" onClick={confirmServerUrl}>确认</button>
    </div>
    <small role="status">{status?.serverUrl === serverUrl ? status.message : '输入只保存为草稿；点击确认后才开始连接后端。'}</small>
    {backendConfirmed && serverUrl && <small className="soft-badge">已确认：{serverUrl}</small>}
  </section>
}
