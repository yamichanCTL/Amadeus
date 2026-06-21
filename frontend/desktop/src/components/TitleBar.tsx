export function TitleBar() {
  return (
    <header className="titlebar">
      <div className="titlebar-drag">
        <strong>Amadeus</strong>
        <span>智能语音工作台</span>
      </div>
      <div className="window-actions">
        <button type="button" title="最小化" onClick={() => window.electronAPI?.minimize()}>
          _
        </button>
        <button type="button" title="最大化" onClick={() => window.electronAPI?.maximize()}>
          □
        </button>
        <button type="button" title="关闭" className="danger" onClick={() => window.electronAPI?.close()}>
          ×
        </button>
      </div>
    </header>
  )
}
