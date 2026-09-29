/// <reference types="vite/client" />
import type { LocalRuntimeState } from './services/localRuntimeTypes'

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
  archiveCategory?: string
  taskId: string
  filename: string
  audioBase64?: string
  audioExtension?: string
  metadata: Record<string, unknown>
}

export type SummaryLogArgs = {
  archiveRoot?: string
  date: string
  filename?: string
  content: string
}

export type SummaryLogEntry = {
  name: string
  path: string
  modifiedAt: string
  content: string
}

export type LocalAvatarStatus = {
  available: boolean
  name: string | null
  size: number
  revision: string | null
  error?: string
}

declare global {
  interface Window {
    __amadeusE2EAudio?: () => Promise<unknown>
    // Exposed inside the status overlay window (status-overlay-preload.ts).
    statusOverlay?: {
      copyResult: (text: string) => void
      closeResult: () => void
      cancelRecognition: () => void
      submitRecognition: () => void
    }
    electronAPI?: {
      localAvatarStatus: () => Promise<LocalAvatarStatus>
      localAvatarRead: () => Promise<ArrayBuffer | null>
      localAvatarImport: () => Promise<LocalAvatarStatus & { cancelled?: boolean }>
      localAvatarClear: () => Promise<LocalAvatarStatus>
      onLocalAvatarChanged: (callback: (status: LocalAvatarStatus) => void) => () => void
      localRuntimeStatus: () => Promise<LocalRuntimeState>
      localRuntimeInstall: () => Promise<LocalRuntimeState>
      localRuntimeInstallExtra: (extra: string) => Promise<LocalRuntimeState>
      localRuntimeStart: () => Promise<LocalRuntimeState>
      localRuntimeStop: () => Promise<LocalRuntimeState>
      localRuntimeSetAutoStart: (enabled: boolean) => Promise<LocalRuntimeState>
      localRuntimeOpenLogs: () => Promise<void>
      localRuntimeOpenFolder: () => Promise<void>
      onLocalRuntimeState: (callback: (state: LocalRuntimeState) => void) => () => void
      minimize: () => void
      maximize: () => void
      close: () => void
      closeWithAction: (action: 'hide' | 'quit') => void
      setKeepRunningInBackground: (enabled: boolean) => void
      openAudioDialog: () => Promise<string[]>
      openDirectoryDialog: () => Promise<string>
      getDefaultArchiveDir: () => Promise<string>
      getUserId: () => Promise<string>
      saveUserId: (userId: string) => Promise<{ userId: string; path: string }>
      saveFileDialog: (name: string) => Promise<string>
      writeFile: (path: string, content: string) => Promise<boolean>
      readFileBase64: (path: string) => Promise<string>
      fileInfo: (path: string) => Promise<{ name: string; size: number; path: string }>
      extractAudioForUpload?: (path: string) => Promise<{ extracted: boolean; path: string; name: string; originalPath: string }>
      archiveTranscription: (args: ArchiveTranscriptionArgs) => Promise<{ audio?: string; json: string }>
      saveSummaryLog: (args: SummaryLogArgs) => Promise<{ saved: boolean; path: string }>
      listSummaryLogs: (args: { archiveRoot?: string; date: string }) => Promise<SummaryLogEntry[]>
      openExternal: (url: string) => Promise<void>
      getTheme: () => Promise<'dark' | 'light'>
      setTheme: (theme: 'system' | 'light' | 'dark') => Promise<boolean>
      registerHotkey: (accelerator: string) => Promise<boolean>
      unregisterHotkey: () => Promise<boolean>
      onHotkeyTriggered: (callback: () => void) => () => void
      registerMouseButton: (button: string) => Promise<boolean>
      unregisterMouseButton: () => Promise<boolean>
      captureTextTarget: () => Promise<boolean>
      injectText: (text: string) => Promise<boolean>
      textToClipboard: (text: string) => boolean
      showStatusOverlay: (status: string, level?: number, message?: string) => Promise<boolean>
      hideStatusOverlay: () => Promise<boolean>
      onStatusResultCopied: (callback: (text: string) => void) => () => void
      onStatusResultClosed: (callback: () => void) => () => void
      onStatusRecognitionCancelled: (callback: () => void) => () => void
      onStatusRecognitionSubmitted: (callback: () => void) => () => void
      showCaptionOverlay: (text: string, options: CaptionOverlayOptions) => Promise<boolean>
      hideCaptionOverlay: () => Promise<boolean>
      onCaptionOverlayClosed: (callback: () => void) => () => void
      onCaptionOverlayStyleChanged: (callback: (bounds: Partial<CaptionOverlayOptions>) => void) => () => void
      onCaptionOverlaySettingsRequested: (callback: () => void) => () => void
      getAutoLaunch: () => Promise<boolean>
      setAutoLaunch: (enabled: boolean) => Promise<boolean>
      onLiveCaptionTrayToggle: (callback: () => void) => () => void
      notifyLiveCaptionState: (active: boolean) => void
      setPetEnabled: (enabled: boolean) => Promise<boolean>
      getWorkToken: () => Promise<string>
      publishPetState: (state: { status: string; emotion: string; action: string; reply: string; error: string; gesture: string; gestureId: string }) => void
      publishPetAudioFrame: (frame: import('./services/liveVoiceTypes').LiveAvatarAudioFrame) => void
      onPetEnabledChanged: (callback: (enabled: boolean) => void) => () => void
      onPetCommand: (callback: (command: { id: number; type: 'open' | 'voice' | 'text'; text?: string }) => void) => () => void
    }
  }
}
