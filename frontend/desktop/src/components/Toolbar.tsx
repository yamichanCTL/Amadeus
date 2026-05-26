import { useASRStore } from '@/store/useASRStore'

const engines = ['whisper', 'vosk', 'sherpa', 'fireredasr2', 'wenet']

export function Toolbar({ onCancel }: { onCancel: () => void }) {
  const settings = useASRStore((state) => state.settings)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const activeTaskId = useASRStore((state) => state.activeTaskId)

  const toggleEngine = (engine: string) => {
    const exists = settings.selectedEngines.includes(engine)
    const selectedEngines = exists ? settings.selectedEngines.filter((item) => item !== engine) : [...settings.selectedEngines, engine]
    updateSettings({ selectedEngines: selectedEngines.length ? selectedEngines : [engine], defaultEngine: engine })
  }

  return (
    <div className="toolbar">
      <label>
        默认引擎
        <select value={settings.defaultEngine} onChange={(event) => updateSettings({ defaultEngine: event.target.value, selectedEngines: [event.target.value] })}>
          {engines.map((engine) => (
            <option key={engine} value={engine}>{engine}</option>
          ))}
        </select>
      </label>
      <label>
        语言
        <select value={settings.defaultLanguage} onChange={(event) => updateSettings({ defaultLanguage: event.target.value })}>
          <option value="zh">中文</option>
          <option value="en">English</option>
          <option value="auto">自动</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.enablePunctuation} onChange={(event) => updateSettings({ enablePunctuation: event.target.checked })} />
        标点
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.multiEngine} onChange={(event) => updateSettings({ multiEngine: event.target.checked })} />
        多引擎
      </label>
      {settings.multiEngine && (
        <div className="engine-chips">
          {engines.map((engine) => (
            <button key={engine} type="button" className={settings.selectedEngines.includes(engine) ? 'active' : ''} onClick={() => toggleEngine(engine)}>
              {engine}
            </button>
          ))}
        </div>
      )}
      <button type="button" className="danger" disabled={!activeTaskId} onClick={onCancel}>取消识别</button>
    </div>
  )
}
