import { AppPage, useASRStore } from '@/store/useASRStore'
import amadeusLogo from '../../../../img/Amadeus/amadeus.jpg'

const items: Array<{ page?: AppPage; label: string; icon: string }> = [
  { page: 'home', label: '首页', icon: '⌂' },
  { page: 'realtime', label: '实时对话', icon: '☏' },
  { page: 'transcribe', label: '语音识别', icon: '▤' },
  { page: 'history', label: '历史记录', icon: '◷' },
  { page: 'summary', label: '当日总结', icon: '☷' },
  { page: 'voice', label: '变声器/TTS', icon: '🎤' },
  { page: 'models', label: '模型管理', icon: '▣' },
  { page: 'debug', label: '开发调试台', icon: '⌁' },
  { page: 'settings', label: '设置', icon: '⚙' }
]

export function Sidebar() {
  const page = useASRStore((state) => state.page)
  const setPage = useASRStore((state) => state.setPage)
  const serverStatus = useASRStore((state) => state.serverStatus)

  return (
    <aside className="sidebar">
      <div className="brand-block">
        <img className="brand-logo" src={amadeusLogo} alt="Amadeus" />
        <div>
          <strong>Amadeus</strong>
        </div>
      </div>
      <nav>
        {items.map((item) => (
          <button
            key={`${item.label}-${item.page || 'visual'}`}
            type="button"
            className={item.page && page === item.page ? 'active' : ''}
            onClick={() => item.page && setPage(item.page)}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
      <div className={`server-pill ${serverStatus}`}>
        <span />
        <div>
          <strong>{serverStatus === 'connected' ? '服务已连接' : serverStatus === 'checking' ? '检查服务中' : '服务断开'}</strong>
          <small>后端连接状态</small>
        </div>
      </div>
    </aside>
  )
}
