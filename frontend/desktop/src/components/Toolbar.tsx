import { useASRStore } from '@/store/useASRStore'

const engines = ['fireredasr2', 'sensevoice', 'qwen3asr', 'whisper']

export function Toolbar({ onCancel }: { onCancel: () => void }) {
  const settings = useASRStore((state) => state.settings)
  const updateSettings = useASRStore((state) => state.updateSettings)
  const activeTaskId = useASRStore((state) => state.activeTaskId)

  return (
    <div className="toolbar">
      <label>
        离线识别模型
        <select value={settings.offlineEngine} onChange={(event) => updateSettings({ offlineEngine: event.target.value })}>
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
      <button type="button" className="danger" disabled={!activeTaskId} onClick={onCancel}>取消识别</button>
    </div>
  )
}
