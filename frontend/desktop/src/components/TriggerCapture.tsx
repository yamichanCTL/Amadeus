import { useState } from 'react'

const mouseButtons = [
  ['mouse_left', '鼠标左键'],
  ['mouse_right', '鼠标右键'],
  ['mouse_middle', '鼠标中键'],
  ['mouse_x1', '鼠标侧键 1'],
  ['mouse_x2', '鼠标侧键 2']
]

export function TriggerCapture({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {mouseButtons.map(([id, label]) => (
        <option key={id} value={id}>{label}</option>
      ))}
    </select>
  )
}

export function HotkeyCapture({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [capturing, setCapturing] = useState(false)

  return (
    <button
      type="button"
      className={capturing ? 'capture active' : 'capture'}
      onClick={() => setCapturing(true)}
      onKeyDown={(event) => {
        if (!capturing) return
        event.preventDefault()
        if (event.code === 'AltRight') {
          onChange('AltRight')
          setCapturing(false)
          return
        }
        const parts: string[] = []
        if (event.ctrlKey) parts.push('Ctrl')
        if (event.altKey) parts.push('Alt')
        if (event.shiftKey) parts.push('Shift')
        const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key
        if (!['Control', 'Alt', 'Shift'].includes(event.key)) parts.push(key)
        onChange(parts.join('+'))
        setCapturing(false)
      }}
    >
      {capturing ? '按下快捷键' : value === 'AltRight' ? '右 Alt' : value}
    </button>
  )
}
