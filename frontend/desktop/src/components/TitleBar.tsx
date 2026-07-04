import { useState } from 'react'

export function TitleBar() {
  const [showCloseChoice, setShowCloseChoice] = useState(false)

  const closeWithAction = (action: 'hide' | 'quit') => {
    setShowCloseChoice(false)
    window.electronAPI?.closeWithAction(action)
  }

  return (
    <>
      <header className="titlebar">
        <div className="titlebar-drag">
          <strong>Amadeus</strong>
        </div>
        <div className="window-actions">
          <button type="button" title="最小化" onClick={() => window.electronAPI?.minimize()}>
            <span className="window-glyph minimize-glyph" aria-hidden="true" />
          </button>
          <button type="button" title="最大化" onClick={() => window.electronAPI?.maximize()}>
            <span className="window-glyph maximize-glyph" aria-hidden="true" />
          </button>
          <button type="button" title="关闭" className="danger" onClick={() => setShowCloseChoice(true)}>
            ×
          </button>
        </div>
      </header>
      {showCloseChoice && (
        <div className="close-choice-backdrop" role="presentation" onMouseDown={() => setShowCloseChoice(false)}>
          <section
            className="close-choice-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-choice-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="close-choice-icon" aria-hidden="true">A</span>
            <div>
              <h2 id="close-choice-title">关闭 Amadeus</h2>
              <p>选择本次关闭方式。后台运行会保留托盘、快捷键和实时服务。</p>
            </div>
            <div className="close-choice-actions">
              <button type="button" onClick={() => setShowCloseChoice(false)}>取消</button>
              <button type="button" onClick={() => closeWithAction('hide')}>保留后台</button>
              <button type="button" className="danger-button" onClick={() => closeWithAction('quit')}>完全退出</button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
