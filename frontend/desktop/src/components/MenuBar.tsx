import { useASRStore } from '@/store/useASRStore'

export function MenuBar() {
  const setPage = useASRStore((state) => state.setPage)
  const currentResult = useASRStore((state) => state.currentResult)

  return (
    <div className="menubar">
      <button type="button" onClick={() => setPage('transcribe')}>新转写</button>
      <button type="button" onClick={() => setPage('history')}>历史记录</button>
      <button type="button" onClick={() => setPage('models')}>模型管理</button>
      <button type="button" disabled={!currentResult} onClick={() => window.electronAPI?.textToClipboard(currentResult?.full_text || '')}>
        复制结果
      </button>
    </div>
  )
}
