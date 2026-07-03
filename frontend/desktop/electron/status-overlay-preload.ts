import { clipboard, contextBridge, ipcRenderer } from 'electron'
import { copyOverlayResultNonBlocking } from './status-overlay-copy'

contextBridge.exposeInMainWorld('statusOverlay', {
  copyResult: (text: string) => {
    // Run the native clipboard call in this small overlay renderer instead of
    // Electron's main process. A slow Windows clipboard owner can no longer
    // freeze the main window, tray, audio IPC and status updates together.
    return copyOverlayResultNonBlocking(
      text,
      (value) => clipboard.writeText(value),
      (value) => ipcRenderer.send('statusOverlay:copyResultDone', value),
    )
  },
  closeResult: () => ipcRenderer.send('statusOverlay:closeResult'),
  cancelRecognition: () => ipcRenderer.send('statusOverlay:cancelRecognition'),
  submitRecognition: () => ipcRenderer.send('statusOverlay:submitRecognition'),
})
