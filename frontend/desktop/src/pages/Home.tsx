import { useState } from 'react'
import { AppIcon, type AppIconName } from '@/components/AppIcon'
import { BackendConnectionSettings } from '@/components/BackendConnectionSettings'
import { LocalRuntimePanel } from '@/components/LocalRuntimePanel'
import { resolveTaskLLM } from '@/services/taskModels'
import { useASRStore, type AppPage } from '@/store/useASRStore'
import './Home.css'

export function HomePage() {
  const settings = useASRStore((state) => state.settings)
  const history = useASRStore((state) => state.history)
  const serverStatus = useASRStore((state) => state.serverStatus)
  const setPage = useASRStore((state) => state.setPage)
  const tasks: Array<{ page: AppPage; icon: AppIconName; title: string; description: string; model: string }> = [
    { page: 'transcribe', icon: 'mic', title: '语音识别', description: '录音、文件转写与实时字幕，各有独立工作区。', model: settings.offlineEngine },
    { page: 'realtime', icon: 'chat', title: '实时对话', description: '选择实时语音模型，配置对话大脑与工具。', model: settings.agentRealtimeProvider !== 'off' ? settings.agentRealtimeProvider : settings.agentBackend === 'codex' ? `Codex · ${settings.codexModel}` : resolveTaskLLM(settings, 'agent').model || '待配置' },
    { page: 'summary', icon: 'summary', title: '总结', description: '整理记录，使用独立的总结模型生成纪要。', model: resolveTaskLLM(settings, 'summary').model || '待配置' },
    { page: 'voice', icon: 'audio', title: '语音合成', description: '文字转语音、语音转换与实时播报。', model: settings.higgsTtsProvider === 'boson' ? settings.higgsTtsRemoteModel || '待配置' : '本地 Higgs TTS' },
  ]
  const connected = serverStatus === 'connected'
  const [lastTask] = useState(() => { try { return localStorage.getItem('amadeus.ui.lastTask') || '' } catch { return '' } })
  const previous = tasks.find((task) => task.page === lastTask)
  const environment = <div className="home-environment"><LocalRuntimePanel /><details className="home-connection-settings"><summary>已有后端 / 手动连接</summary><p>本机服务启动后会自动填写地址。连接一次后，各任务共用。</p><BackendConnectionSettings /></details></div>
  return <div className="page home-workspace">
    <header className="page-heading home-heading"><div><span className="eyebrow">AMADEUS WORKSPACE</span><h1>你的语音工作台</h1><p>对话、记录、创作，从这里开始。</p></div><span className={`soft-badge ${connected ? 'success' : ''}`}>{connected ? '服务已就绪' : serverStatus === 'checking' ? '正在检查连接' : '先准备运行环境'}</span></header>
    {!connected && <section className="home-setup" aria-label="首次准备与服务连接">{environment}</section>}
    <section className="home-start panel"><div className="home-start-copy"><span className="eyebrow">{previous ? '继续使用' : '快速开始'}</span><h2>{previous ? previous.title : '与 Amadeus 聊一聊'}</h2><p>{previous ? previous.description : '选择你的实时语音模型，开始自然对话。'}</p></div><div className="home-start-art" aria-hidden="true">{[18, 30, 45, 63, 81, 57, 36, 66, 90, 70, 43, 26, 15].map((height, index) => <i key={index} style={{ height }} />)}</div><button className="primary" onClick={() => setPage(previous?.page || 'realtime')}>{previous ? '继续上次任务' : '进入实时对话'}<AppIcon name="arrow" /></button></section>
    <div className="home-task-grid">{tasks.map((task) => <button type="button" key={task.page} data-task={task.page} className="panel home-task-card" onClick={() => setPage(task.page)}><div className="home-task-title"><span className="home-task-icon"><AppIcon name={task.icon} /></span><h2>{task.title}</h2><AppIcon name="arrow" /></div><p>{task.description}</p><small>当前模型：{task.model}</small><span className="sr-only">进入任务</span></button>)}</div>
    <section className="home-records panel"><div><h2>最近记录</h2><p>{history.length ? `已保存 ${history.length} 条记录 · 最近：${history[0].filename}` : '完成一次录音或文件转写后，结果会保存在这里。'}</p></div><button type="button" onClick={() => setPage('history')}>查看记录</button></section>
    {connected && <details className="home-ready-environment panel"><summary><span><i />服务已连接</span><span>环境与连接管理</span></summary>{environment}</details>}
  </div>
}
