import { clipboard, contextBridge, ipcRenderer } from 'electron'

const on = <T>(channel: string, callback: (payload: T) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('electronAPI', {
  localAvatarStatus: () => ipcRenderer.invoke('avatar:status'),
  localAvatarRead: () => ipcRenderer.invoke('avatar:read'),
  localAvatarImport: () => ipcRenderer.invoke('avatar:import'),
  localAvatarClear: () => ipcRenderer.invoke('avatar:clear'),
  onLocalAvatarChanged: (callback: (state: unknown) => void) => on('avatar:changed', callback),
  localRuntimeStatus: () => ipcRenderer.invoke('runtime:status'),
  localRuntimeInstall: () => ipcRenderer.invoke('runtime:install'),
  localRuntimeInstallExtra: (extra: string) => ipcRenderer.invoke('runtime:installExtra', extra),
  localRuntimeStart: () => ipcRenderer.invoke('runtime:start'),
  localRuntimeStop: () => ipcRenderer.invoke('runtime:stop'),
  localRuntimeSetAutoStart: (enabled: boolean) => ipcRenderer.invoke('runtime:autoStart', enabled),
  localRuntimeOpenLogs: () => ipcRenderer.invoke('runtime:openLogs'),
  localRuntimeOpenFolder: () => ipcRenderer.invoke('runtime:openFolder'),
  onLocalRuntimeState: (callback: (state: unknown) => void) => on('runtime:state', callback),
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  closeWithAction: (action: 'hide' | 'quit') => ipcRenderer.send('win:closeWithAction', action),
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
  extractAudioForUpload: (filePath: string) => ipcRenderer.invoke('media:extractAudioForUpload', filePath),
  archiveTranscription: (args: unknown) => ipcRenderer.invoke('archive:transcription', args),
  saveSummaryLog: (args: unknown) => ipcRenderer.invoke('archive:summaryLog', args),
  listSummaryLogs: (args: unknown) => ipcRenderer.invoke('archive:summaryLogs:list', args),
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
    if (write) void write.catch(() => globalThis.setTimeout(() => clipboard.writeText(text), 0))
    else globalThis.setTimeout(() => clipboard.writeText(text), 0)
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
  notifyLiveCaptionState: (active: boolean) => ipcRenderer.send('liveCaption:stateChanged', active),
  setPetEnabled: (enabled: boolean) => ipcRenderer.invoke('pet:setEnabled', enabled),
  getWorkToken: () => ipcRenderer.invoke('agent:getWorkToken'),
  publishPetState: (state: unknown) => ipcRenderer.send('pet:state', state),
  publishPetAudioFrame: (frame: unknown) => ipcRenderer.send('pet:audioFrame', frame),
  onPetEnabledChanged: (callback: (enabled: boolean) => void) => on('pet:enabledChanged', callback),
  onPetCommand: (callback: (command: { id: number; type: 'open' | 'voice' | 'text'; text?: string }) => void) => on('pet:command', callback)
})
