import { useEffect, useState } from 'react'
import type { RuntimeInstallProgress as InstallProgress, RuntimeInstallItem } from '@/services/localRuntimeTypes'
import './RuntimeInstallProgress.css'

const stageNames: Record<InstallProgress['stage'], string> = {
  preparing: '准备环境', python: '准备 Python', resolving: '解析依赖', downloading: '下载文件',
  extracting: '解压文件', building: '构建组件', installing: '安装依赖', verifying: '检查可用性',
  complete: '安装完成', failed: '安装未完成', cancelled: '已取消',
}
const itemNames: Record<RuntimeInstallItem['status'], string> = {
  downloading: '下载中', downloaded: '下载完成', extracting: '解压中', building: '构建中',
  prepared: '已准备', installed: '已安装', failed: '失败', cancelled: '已取消',
}
const finished = new Set<RuntimeInstallItem['status']>(['downloaded', 'prepared', 'installed'])

export function formatDownloadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** unit).toFixed(unit === 1 ? 0 : 1)} ${['B', 'KiB', 'MiB', 'GiB'][unit]}`
}
function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}
function DownloadItem({ item }: { item: RuntimeInstallItem }) {
  const hasBytes = typeof item.downloadedBytes === 'number'
  const knownTotal = typeof item.totalBytes === 'number' && item.totalBytes > 0
  const progress = knownTotal && hasBytes ? Math.min(item.downloadedBytes!, item.totalBytes!) : undefined
  return <li className="runtime-download-item" data-status={item.status}>
    <div className="runtime-download-name"><strong>{item.name}</strong>{item.version && <span>{item.version}</span>}<small>{item.kind === 'python' ? 'Python 运行时' : '依赖组件'}</small></div>
    <div className="runtime-download-size">{knownTotal ? `${item.totalBytesApproximate ? '约 ' : ''}${formatDownloadBytes(item.totalBytes!)}` : '大小待确认'}{hasBytes && <small>已下载 {formatDownloadBytes(item.downloadedBytes!)}</small>}</div>
    <div className="runtime-download-state"><span>{itemNames[item.status]}</span>{item.status === 'downloading' && <progress aria-label={`${item.name} 下载进度`} max={knownTotal ? item.totalBytes : 1} value={progress} />}{typeof item.bytesPerSecond === 'number' && <small>{formatDownloadBytes(item.bytesPerSecond)}/s</small>}</div>
  </li>
}

export function RuntimeInstallProgress({ value }: { value: InstallProgress }) {
  const [now, setNow] = useState(Date.now)
  const [showAll, setShowAll] = useState(false)
  const active = !['complete', 'failed', 'cancelled'].includes(value.stage)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  const ordered = [...value.items].sort((a, b) => Number(finished.has(a.status)) - Number(finished.has(b.status)))
  const shown = showAll ? ordered : ordered.slice(0, 5)
  const unknownNetworkProgress = value.items.some((item) => item.status === 'downloading' && item.downloadedBytes === undefined)
  const recentHeartbeat = active && now - value.updatedAt < 15_000
  const lastEventAge = now - value.lastEventAt
  return <section className="runtime-install-progress" aria-label="下载与安装明细">
    <header><div><span className={`runtime-progress-dot ${active ? 'is-active' : ''}`} /><strong>{stageNames[value.stage]}</strong></div><span>已用 {elapsed((active ? now : value.updatedAt) - value.startedAt)}</span></header>
    <div className="runtime-download-summary"><span>组件已就绪 <strong>{value.completedItems}</strong> / 已发现 {value.observedItems} 项</span>{value.resolvedPackages !== undefined && <span>依赖 {value.resolvedPackages} 项</span>}{value.installedPackages !== undefined && <span>已安装 {value.installedPackages} 项</span>}</div>
    {active && <p className="runtime-progress-note">下载清单会随依赖解析更新；下载、解压和安装分阶段进行。</p>}
    {shown.length ? <><div className="runtime-download-columns" aria-hidden="true"><span>组件</span><span>文件大小</span><span>当前状态</span></div><ul className="runtime-download-list">{shown.map((item) => <DownloadItem key={item.id} item={item} />)}</ul></> : <p className="runtime-progress-note">正在检查 Python 与依赖版本，获取文件信息后会在这里列出。</p>}
    {ordered.length > 5 && <button type="button" className="runtime-details-toggle" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? '收起清单' : `查看全部 ${ordered.length} 项`}</button>}
    {unknownNetworkProgress && <p className="runtime-progress-note">当前下载器未提供实时字节进度；文件完成后会更新状态，不显示估算百分比。</p>}
    {recentHeartbeat && lastEventAge > 30_000 && <p className="runtime-progress-note">安装进程仍在运行，上次文件事件在 {elapsed(lastEventAge)}前。较大的组件可能需要更长时间。</p>}
    {value.cache && <footer><span>缓存与 Python 磁盘占用</span><strong>{value.cache.partial ? '至少 ' : ''}{formatDownloadBytes(value.cache.bytes)}</strong><small>含已有缓存和解压文件，不代表本次下载流量。</small></footer>}
  </section>
}
