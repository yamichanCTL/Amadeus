import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('statusOverlay', {
  copyResult: (text: string) => ipcRenderer.send('statusOverlay:copyResult', text),
  closeResult: () => ipcRenderer.send('statusOverlay:closeResult'),
  // Toggle click-through so the drag handle can take over the mouse for
  // native frameless dragging.
  setMouseCapture: (capture: boolean) => ipcRenderer.send('statusOverlay:setMouseCapture', capture),
})
