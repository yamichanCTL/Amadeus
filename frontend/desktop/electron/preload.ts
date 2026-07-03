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
  setKeepRunningInBackground: (enabled: boolean) => ipcRenderer.send('app:keepRunningInBackground:set', enabled),
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
  saveSummaryLog: (args: unknown) => ipcRenderer.invoke('archive:summaryLog', args),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme: string) => ipcRenderer.invoke('theme:set', theme),
  registerHotkey: (accelerator: string) => ipcRenderer.invoke('hotkey:register', accelerator),
  unregisterHotkey: () => ipcRenderer.invoke('hotkey:unregister'),
  onHotkeyTriggered: (callback: () => void) => on('hotkey:triggered', callback),
  registerMouseButton: (button: string) => ipcRenderer.invoke('mouse:register', button),
  unregisterMouseButton: () => ipcRenderer.invoke('mouse:unregister'),
  captureTextTarget: () => ipcRenderer.invoke('text:captureTarget'),
  injectText: (text: string) => ipcRenderer.invoke('text:inject', text),
  textToClipboard: (text: string) => {
    const write = globalThis.navigator?.clipboard?.writeText(text)
    if (write) void write.catch(() => ipcRenderer.send('text:toClipboard', text))
    else ipcRenderer.send('text:toClipboard', text)
    return true
  },
  showStatusOverlay: (status: string, level = 0, message = '') => ipcRenderer.invoke('statusOverlay:show', status, level, message),
  hideStatusOverlay: () => ipcRenderer.invoke('statusOverlay:hide'),
  onStatusResultCopied: (callback: (text: string) => void) => on('statusOverlay:resultCopied', callback),
  onStatusResultClosed: (callback: () => void) => on('statusOverlay:resultClosed', callback),
  onStatusRecognitionCancelled: (callback: () => void) => on('statusOverlay:cancelRecognition', callback),
  onStatusRecognitionSubmitted: (callback: () => void) => on('statusOverlay:submitRecognition', callback),
  showCaptionOverlay: (text: string, options: unknown) => ipcRenderer.invoke('captionOverlay:show', text, options),
  hideCaptionOverlay: () => ipcRenderer.invoke('captionOverlay:hide'),
  onCaptionOverlayClosed: (callback: () => void) => on('captionOverlay:closedByUser', callback),
  onCaptionOverlayStyleChanged: (callback: (payload: unknown) => void) => on('captionOverlay:styleChanged', callback),
  onCaptionOverlaySettingsRequested: (callback: () => void) => on('captionOverlay:settingsRequested', callback),
  getAutoLaunch: () => ipcRenderer.invoke('app:autoLaunch:get'),
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke('app:autoLaunch:set', enabled),
  onLiveCaptionTrayToggle: (callback: () => void) => on('liveCaption:trayToggle', callback),
  notifyLiveCaptionState: (active: boolean) => ipcRenderer.send('liveCaption:stateChanged', active)
})
