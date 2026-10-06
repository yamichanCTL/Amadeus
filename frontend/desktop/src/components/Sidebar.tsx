import { AppPage, useASRStore } from '@/store/useASRStore'
import { AppIcon, type AppIconName } from './AppIcon'
const items: Array<{ page: AppPage; label: string; icon: AppIconName }> = [
  { page: 'home', label: '首页', icon: 'home' },
  { page: 'realtime', label: '实时对话', icon: 'chat' },
  { page: 'transcribe', label: '语音识别', icon: 'mic' },
  { page: 'voice', label: '语音合成', icon: 'audio' },
  { page: 'history', label: '历史记录', icon: 'history' },
  { page: 'summary', label: '总结', icon: 'summary' },
]
export function Sidebar({ collapsed = false, onToggle }: { collapsed?: boolean; onToggle?: () => void }) {
  const page = useASRStore((s) => s.page)
  const setPage = useASRStore((s) => s.setPage)
  const serverStatus = useASRStore((s) => s.serverStatus)
  const button = (item: typeof items[number]) => <button key={item.page} type="button" aria-label={item.label} title={item.label} aria-current={page === item.page ? 'page' : undefined} className={page === item.page ? 'active' : ''} onClick={() => setPage(item.page)}><AppIcon name={item.icon} /><span className="nav-label">{item.label}</span></button>
  return <aside className="sidebar">
    <div className="sidebar-brand"><span className="app-monogram" aria-hidden="true">A</span><strong className="nav-label">Amadeus</strong><button className="sidebar-toggle" aria-expanded={!collapsed} aria-controls="app-primary-navigation" aria-label={collapsed ? '展开导航' : '折叠导航'} title={collapsed ? '展开导航' : '折叠导航'} onClick={onToggle}><AppIcon name="menu" /></button></div>
    <nav id="app-primary-navigation" aria-label="主导航">{items.map(button)}</nav>
    <div className="sidebar-bottom"><nav aria-label="应用管理">{button({page:'settings',label:'设置',icon:'settings'})}<details className="sidebar-advanced"><summary title="高级工具"><AppIcon name="code" /><span className="nav-label">高级工具</span></summary>{button({page:'debug',label:'开发调试台',icon:'code'})}</details></nav>
      <button className={`connection-indicator ${serverStatus}`} title="在首页管理服务连接" onClick={() => setPage('home')}><i /><span className="nav-label">{serverStatus === 'connected' ? '服务已连接' : serverStatus === 'checking' ? '正在连接' : '服务未连接'}</span></button>
    </div>
  </aside>
}
