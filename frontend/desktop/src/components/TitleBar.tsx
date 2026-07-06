import { useState } from 'react'
import { useASRStore } from '@/store/useASRStore'

export function TitleBar() {
  const [showCloseChoice, setShowCloseChoice] = useState(false)
  const [rememberChoice, setRememberChoice] = useState(false)
  const settings = useASRStore((state) => state.settings)
  const updateSettings = useASRStore((state) => state.updateSettings)

  const closeWithAction = (action: 'hide' | 'quit') => {
    setShowCloseChoice(false)
    if (rememberChoice) {
      updateSettings({ keepRunningInBackground: action === 'hide', rememberCloseAction: true })
      window.electronAPI?.setKeepRunningInBackground?.(action === 'hide')
    }
    window.electronAPI?.closeWithAction(action)
  }

  const requestClose = () => {
    if (settings.rememberCloseAction) {
      window.electronAPI?.closeWithAction(settings.keepRunningInBackground ? 'hide' : 'quit')
      return
    }
    setRememberChoice(false)
    setShowCloseChoice(true)
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
          <button type="button" title="关闭" className="danger" onClick={requestClose}>
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
            <label className="close-choice-remember"><input type="checkbox" checked={rememberChoice} onChange={(event) => setRememberChoice(event.target.checked)} />记住选择</label>
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
