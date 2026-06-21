import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('captionOverlay', {
  close: () => ipcRenderer.send('captionOverlay:closeRequested'),
  openSettings: () => ipcRenderer.send('captionOverlay:settingsRequested')
})
