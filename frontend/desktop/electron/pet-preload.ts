import { contextBridge, ipcRenderer } from 'electron'
import type { PetAudioFrame } from './pet-audio'

contextBridge.exposeInMainWorld('desktopPet', {
  localAvatarStatus: () => ipcRenderer.invoke('avatar:status'),
  localAvatarRead: () => ipcRenderer.invoke('avatar:read'),
  onLocalAvatarChanged: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on('avatar:changed', listener)
    return () => ipcRenderer.removeListener('avatar:changed', listener)
  },
  setInteractive: (interactive: boolean) => ipcRenderer.send('pet:interactive', interactive),
  dragStart: () => ipcRenderer.send('pet:dragStart'),
  dragMove: () => ipcRenderer.send('pet:dragMove'),
  dragEnd: () => ipcRenderer.send('pet:dragEnd'),
  moveBy: (dx: number, dy: number) => ipcRenderer.send('pet:moveBy', dx, dy),
  command: (type: 'open' | 'voice' | 'text', text = '') => ipcRenderer.send('pet:command', { type, text }),
  onAudioFrame: (callback: (frame: PetAudioFrame) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, frame: PetAudioFrame) => callback(frame)
    ipcRenderer.on('pet:audioFrame', listener)
    return () => ipcRenderer.removeListener('pet:audioFrame', listener)
  },
  onState: (callback: (state: Record<string, string>) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Record<string, string>) => callback(state)
    ipcRenderer.on('pet:state', listener)
    return () => ipcRenderer.removeListener('pet:state', listener)
  }
})
