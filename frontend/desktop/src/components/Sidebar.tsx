import { AppPage, useASRStore } from '@/store/useASRStore'

const items: Array<{ page?: AppPage; label: string; icon: string }> = [
  { page: 'home', label: '首页', icon: '⌂' },
  { page: 'realtime', label: '实时对话', icon: '☏' },
  { page: 'transcribe', label: '文件转写', icon: '▤' },
  { page: 'history', label: '历史记录', icon: '◷' },
  { page: 'summary', label: '当日总结', icon: '☷' },
  { page: 'voice', label: '变声器/TTS', icon: '🎤' },
  { page: 'models', label: '模型管理', icon: '▣' },
  { page: 'settings', label: '设置', icon: '⚙' }
]

export function Sidebar() {
  const page = useASRStore((state) => state.page)
  const setPage = useASRStore((state) => state.setPage)
  const serverStatus = useASRStore((state) => state.serverStatus)

  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div>
          <strong>ASRAPP</strong>
          <small>智能语音识别助手</small>
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
          <strong>{serverStatus === 'connected' ? '网络良好' : serverStatus === 'checking' ? '检查服务中' : '服务断开'}</strong>
          <small>{serverStatus === 'connected' ? '延迟 18ms' : '后端连接状态'}</small>
        </div>
      </div>
    </aside>
  )
}
