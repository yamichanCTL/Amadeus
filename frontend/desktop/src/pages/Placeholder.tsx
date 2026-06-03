import { useASRStore, type AppPage } from '@/store/useASRStore'

const pageCopy: Record<'home' | 'realtime' | 'events', { title: string; body: string; action: string; target: AppPage }> = {
  home: {
    title: '首页',
    body: '集中查看转写、实时识别、历史记录和模型状态。',
    action: '开始文件转写',
    target: 'transcribe'
  },
  realtime: {
    title: '实时对话',
    body: '实时识别入口已接入文件转写工作台，可直接启动实时识别。',
    action: '进入实时识别',
    target: 'transcribe'
  },
  events: {
    title: '事件检测',
    body: '事件检测入口已开放，后续可接入关键词、异常声音和业务事件规则。',
    action: '查看历史记录',
    target: 'history'
  }
}

export function PlaceholderPage({ kind }: { kind: 'home' | 'realtime' | 'events' }) {
  const setPage = useASRStore((state) => state.setPage)
  const copy = pageCopy[kind]

  return (
    <div className="page placeholder-page">
      <section className="panel placeholder-panel">
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        <button type="button" className="primary" onClick={() => setPage(copy.target)}>{copy.action}</button>
      </section>
    </div>
  )
}
