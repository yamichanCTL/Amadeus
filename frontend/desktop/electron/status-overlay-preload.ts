import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('statusOverlay', {
  copyResult: (text: string) => ipcRenderer.send('statusOverlay:copyResult', text),
  closeResult: () => ipcRenderer.send('statusOverlay:closeResult'),
  cancelRecognition: () => ipcRenderer.send('statusOverlay:cancelRecognition'),
  submitRecognition: () => ipcRenderer.send('statusOverlay:submitRecognition'),
})
