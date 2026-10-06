import { useId, useMemo, useState } from 'react'
import './ModelSelector.css'

export type ModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Selection is explicit: receiving a catalog never changes the saved model. */
export function ModelSelector({ label, value, models, onChange, disabled = false, placeholder = '填写模型名称', catalogStatus = 'idle' }: {
  label: string; value: string; models: readonly string[]; onChange: (model: string) => void;
  disabled?: boolean; placeholder?: string; catalogStatus?: ModelCatalogStatus;
}) {
  const id = useId()
  const [manual, setManual] = useState(false)
  const options = useMemo(() => Array.from(new Set(models.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))), [models])
  const index = options.indexOf(value)
  // Internal values cannot collide with a provider's actual model IDs.
  const selected = manual ? 'manual' : index >= 0 ? `model:${index}` : value ? 'saved' : 'empty'
  const hint = catalogStatus === 'loading' ? '正在获取模型列表，当前选择保持不变。'
    : catalogStatus === 'error' ? '列表获取失败，当前模型保留；也可手动填写。'
      : catalogStatus === 'ready' && !options.length ? '服务未返回可选模型，可手动填写模型名称。'
        : catalogStatus === 'ready' ? `${options.length} 个可选模型；也可手动填写。`
          : '获取模型列表后可选择，也可直接手动填写。'

  return <div className="model-selector">
    <label htmlFor={id}>本任务模型</label>
    <select id={id} aria-label={label} aria-describedby={`${id}-hint`} value={selected} disabled={disabled} onChange={event => {
      if (disabled) return
      const choice = event.target.value
      if (choice === 'manual') { setManual(true); return }
      setManual(false)
      if (choice === 'empty') onChange('')
      else if (choice.startsWith('model:')) {
        const next = options[Number(choice.slice(6))]
        if (next !== undefined) onChange(next)
      }
    }}>
      <option value="empty">请选择模型</option>
      {value && index < 0 && <option value="saved">{value} · 当前配置</option>}
      {options.map((model, optionIndex) => <option key={model} value={`model:${optionIndex}`}>{model}</option>)}
      <option value="manual">手动填写模型…</option>
    </select>
    {manual && <label className="model-selector-manual">模型名称
      <input aria-label={`${label}（手动填写）`} value={value} disabled={disabled} placeholder={placeholder} autoComplete="off" spellCheck={false} onChange={event => { if (!disabled) onChange(event.target.value) }} />
    </label>}
    <small id={`${id}-hint`} className="model-selector-hint">{hint}</small>
  </div>
}
