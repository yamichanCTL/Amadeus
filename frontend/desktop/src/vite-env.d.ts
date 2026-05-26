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
    electronAPI?: {
      minimize: () => void
      maximize: () => void
      close: () => void
      openAudioDialog: () => Promise<string[]>
      openDirectoryDialog: () => Promise<string>
      getDefaultArchiveDir: () => Promise<string>
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
      showStatusOverlay: (status: string) => Promise<boolean>
      hideStatusOverlay: () => Promise<boolean>
      showCaptionOverlay: (text: string, options: CaptionOverlayOptions) => Promise<boolean>
      hideCaptionOverlay: () => Promise<boolean>
      onCaptionOverlayClosed: (callback: () => void) => () => void
      onCaptionOverlayStyleChanged: (callback: (bounds: Partial<CaptionOverlayOptions>) => void) => () => void
      onCaptionOverlaySettingsRequested: (callback: () => void) => () => void
    }
  }
}
