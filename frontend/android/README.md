# ASRApp Android

完整工具链、SDK 配置、构建与迁移说明见 [Android 环境指南](../../doc/asrapp/installation/ANDROID.md)。

Kotlin + Jetpack Compose Android client for the ASR backend.

## Features

- Connects to the ASR backend health, model, transcription, and task APIs.
- Picks local audio files and uploads them with multipart `file` + JSON `options`.
- Records microphone audio as AAC/M4A and submits it for transcription.
- Handles both synchronous short-audio responses and asynchronous long-audio task polling.
- Lists models, loads/unloads engines, selects default and multi-engine recognition.
- Streams microphone PCM to `WS /v1/stream` with a foreground service so lock-screen and long-running recognition can continue.
- Persists settings and local history with `SharedPreferences`.
- Copies or shares transcript text from current results and history.

Android does not implement the desktop-only Windows features such as tray mode, global mouse hooks, speaker loopback capture, desktop overlays, or automatic text injection. The mobile equivalents are file picking, microphone recording, copy, and share.

## Build

Open `frontend/android` in Android Studio, or run:

```bash
gradle :app:assembleDebug
```

The app allows cleartext HTTP because the existing backend defaults to `http://your-server-ip:18000`.

# vscode extension
Kotlin
Gradle for Java
Extension Pack for Java
Android iOS Emulator
ADB Interface
Logcat
XML Tools
