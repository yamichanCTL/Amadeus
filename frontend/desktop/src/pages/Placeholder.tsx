import { useASRStore, type AppPage } from '@/store/useASRStore'

const pageCopy: Record<'home' | 'realtime', { title: string; body: string; action: string; target: AppPage }> = {
  home: {
    title: '首页',
    body: '集中查看转写、实时识别、历史记录和模型状态。',
    action: '开始语音识别',
    target: 'transcribe'
  },
  realtime: {
    title: '实时对话',
    body: '实时识别入口已接入语音识别工作台，可直接启动实时识别。',
    action: '进入实时识别',
    target: 'transcribe'
  }
}

export function PlaceholderPage({ kind }: { kind: 'home' | 'realtime' }) {
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
