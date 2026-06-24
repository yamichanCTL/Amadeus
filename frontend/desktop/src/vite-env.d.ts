/// <reference types="vite/client" />

export type CaptionOverlayOptions = {
  fontSize: number
  color: string
  backgroundOpacity: number
  width: number
  height: number
  x: number | null
  y: number | null
}

export type ArchiveTranscriptionArgs = {
  archiveRoot?: string
  taskId: string
  filename: string
  audioBase64?: string
  audioExtension?: string
  metadata: Record<string, unknown>
}

declare global {
  interface Window {
    __amadeusE2EAudio?: () => Promise<unknown>
    // Exposed inside the status overlay window (status-overlay-preload.ts).
    statusOverlay?: {
      copyResult: (text: string) => void
      closeResult: () => void
      setMouseCapture: (capture: boolean) => void
    }
    electronAPI?: {
      minimize: () => void
      maximize: () => void
      close: () => void
      openAudioDialog: () => Promise<string[]>
      openDirectoryDialog: () => Promise<string>
      getDefaultArchiveDir: () => Promise<string>
      getUserId: () => Promise<string>
      saveUserId: (userId: string) => Promise<{ userId: string; path: string }>
      saveFileDialog: (name: string) => Promise<string>
      writeFile: (path: string, content: string) => Promise<boolean>
      readFileBase64: (path: string) => Promise<string>
      fileInfo: (path: string) => Promise<{ name: string; size: number; path: string }>
      archiveTranscription: (args: ArchiveTranscriptionArgs) => Promise<{ audio?: string; json: string }>
      openExternal: (url: string) => Promise<void>
      getTheme: () => Promise<'dark' | 'light'>
      setTheme: (theme: 'system' | 'light' | 'dark') => Promise<boolean>
      registerHotkey: (accelerator: string) => Promise<boolean>
      unregisterHotkey: () => Promise<boolean>
      onHotkeyTriggered: (callback: () => void) => () => void
      registerMouseButton: (button: string) => Promise<boolean>
      unregisterMouseButton: () => Promise<boolean>
      injectText: (text: string) => Promise<boolean>
      textToClipboard: (text: string) => Promise<boolean>
      showStatusOverlay: (status: string, level?: number, message?: string) => Promise<boolean>
      hideStatusOverlay: () => Promise<boolean>
      showCaptionOverlay: (text: string, options: CaptionOverlayOptions) => Promise<boolean>
      hideCaptionOverlay: () => Promise<boolean>
      onCaptionOverlayClosed: (callback: () => void) => () => void
      onCaptionOverlayStyleChanged: (callback: (bounds: Partial<CaptionOverlayOptions>) => void) => () => void
      onCaptionOverlaySettingsRequested: (callback: () => void) => () => void
      getAutoLaunch: () => Promise<boolean>
      setAutoLaunch: (enabled: boolean) => Promise<boolean>
      onLiveCaptionTrayToggle: (callback: () => void) => () => void
      notifyLiveCaptionState: (active: boolean) => void
    }
  }
}
