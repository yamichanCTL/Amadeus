import { contextBridge, ipcRenderer } from 'electron'

const on = <T>(channel: string, callback: (payload: T) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  openAudioDialog: () => ipcRenderer.invoke('dialog:openAudio'),
  openDirectoryDialog: () => ipcRenderer.invoke('dialog:openDirectory'),
  getDefaultArchiveDir: () => ipcRenderer.invoke('app:defaultArchiveDir'),
  getUserId: () => ipcRenderer.invoke('app:userId:get'),
  saveUserId: (userId: string) => ipcRenderer.invoke('app:userId:set', userId),
  saveFileDialog: (name: string) => ipcRenderer.invoke('dialog:saveFile', name),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  readFileBase64: (filePath: string) => ipcRenderer.invoke('fs:readFileBase64', filePath),
  fileInfo: (filePath: string) => ipcRenderer.invoke('fs:fileInfo', filePath),
  archiveTranscription: (args: unknown) => ipcRenderer.invoke('archive:transcription', args),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme: string) => ipcRenderer.invoke('theme:set', theme),
  registerHotkey: (accelerator: string) => ipcRenderer.invoke('hotkey:register', accelerator),
  unregisterHotkey: () => ipcRenderer.invoke('hotkey:unregister'),
  onHotkeyTriggered: (callback: () => void) => on('hotkey:triggered', callback),
  registerMouseButton: (button: string) => ipcRenderer.invoke('mouse:register', button),
  unregisterMouseButton: () => ipcRenderer.invoke('mouse:unregister'),
  injectText: (text: string) => ipcRenderer.invoke('text:inject', text),
  textToClipboard: (text: string) => ipcRenderer.invoke('text:toClipboard', text),
  showStatusOverlay: (status: string, level = 0, message = '') => ipcRenderer.invoke('statusOverlay:show', status, level, message),
  hideStatusOverlay: () => ipcRenderer.invoke('statusOverlay:hide'),
  showCaptionOverlay: (text: string, options: unknown) => ipcRenderer.invoke('captionOverlay:show', text, options),
  hideCaptionOverlay: () => ipcRenderer.invoke('captionOverlay:hide'),
  onCaptionOverlayClosed: (callback: () => void) => on('captionOverlay:closedByUser', callback),
  onCaptionOverlayStyleChanged: (callback: (payload: unknown) => void) => on('captionOverlay:styleChanged', callback),
  onCaptionOverlaySettingsRequested: (callback: () => void) => on('captionOverlay:settingsRequested', callback)
})
