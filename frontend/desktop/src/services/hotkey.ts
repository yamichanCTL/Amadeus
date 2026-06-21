const keyboardMap: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Esc',
  Control: 'Ctrl',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right'
}

export function keyboardEventToAccelerator(event: KeyboardEvent) {
  if (event.code === 'AltRight') return 'AltRight'
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')
  const key = keyboardMap[event.key] || event.key.toUpperCase()
  if (!['CTRL', 'ALT', 'SHIFT', 'SUPER'].includes(key)) parts.push(key)
  return parts.join('+')
}

export async function registerTrigger(triggerType: 'keyboard' | 'mouse', triggerKey: string) {
  const api = window.electronAPI
  if (!api) return false
  await api.unregisterHotkey()
  await api.unregisterMouseButton()
  return triggerType === 'keyboard' ? api.registerHotkey(triggerKey) : api.registerMouseButton(triggerKey)
}

export async function unregisterTrigger() {
  const api = window.electronAPI
  if (!api) return false
  await api.unregisterHotkey()
  await api.unregisterMouseButton()
  return true
}
