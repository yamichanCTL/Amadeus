package com.asrapp.android.service

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class RecordingService : Service() {
    private var recorder: MediaRecorder? = null
    private var audioRouteController: AudioRouteController? = null
    private var recordFile: File? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopRecording()
            else -> startRecording(intent)
        }
        return START_REDELIVER_INTENT
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        cleanup()
        super.onDestroy()
    }

    private fun startRecording(intent: Intent?) {
        if (recorder != null) return
        currentInputDeviceKey = intent?.getStringExtra(EXTRA_INPUT_DEVICE_KEY).orEmpty()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            broadcastError("缺少麦克风权限")
            stopSelf()
            return
        }

        startMicForeground()
        acquireWakeLock()
        startAudioRouting()

        val file = File(cacheDir, "recording_${timestamp()}.m4a")
        runCatching {
            val mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(this)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }
            val route = audioRouteController?.prepareForRecording()
                ?: AudioRouteSelection(null, MediaRecorder.AudioSource.VOICE_RECOGNITION)
            mediaRecorder.setAudioSource(route.audioSource)
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            mediaRecorder.setAudioSamplingRate(16_000)
            mediaRecorder.setAudioEncodingBitRate(96_000)
            route.inputDevice?.let { mediaRecorder.setPreferredDevice(it) }
            mediaRecorder.setOutputFile(file.absolutePath)
            mediaRecorder.prepare()
            mediaRecorder.start()
            recorder = mediaRecorder
            recordFile = file
            val routedDevice = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                runCatching { mediaRecorder.routedDevice }.getOrNull()
            } else {
                null
            }
            broadcastStatus("recording_started", "正在使用${AudioRouteController.label(routedDevice ?: route.inputDevice)}")
        }.onFailure { err ->
            broadcastError(err.message ?: "无法开始录音")
            cleanup()
            stopSelf()
        }
    }

    private fun stopRecording() {
        val mediaRecorder = recorder
        val file = recordFile
        recorder = null
        recordFile = null

        val stopError = runCatching {
            mediaRecorder?.stop()
        }.exceptionOrNull()
        runCatching { mediaRecorder?.release() }

        if (stopError != null) {
            broadcastError(stopError.message ?: "录音结束失败")
            cleanup()
            stopSelf()
            return
        }
        if (file == null || !file.exists() || file.length() == 0L) {
            broadcastError("录音为空，请录制更长一点的音频")
            cleanup()
            stopSelf()
            return
        }

        sendBroadcast(Intent(ACTION_EVENT).apply {
            setPackage(packageName)
            putExtra(EXTRA_TYPE, "recording_done")
            putExtra(EXTRA_PATH, file.absolutePath)
            putExtra(EXTRA_FILENAME, file.name)
            putExtra(EXTRA_MIME, "audio/mp4")
        })
        cleanup()
        stopSelf()
    }

    private fun cleanup() {
        runCatching { recorder?.stop() }
        runCatching { recorder?.release() }
        recorder = null
        recordFile = null
        stopAudioRouting()
        runCatching { wakeLock?.release() }
        wakeLock = null
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        }
    }

    private fun startAudioRouting() {
        if (audioRouteController != null) return
        val inputDeviceKey = intentDeviceKey()
        audioRouteController = AudioRouteController(this, inputDeviceKey) { route ->
            runCatching { recorder?.setPreferredDevice(route.inputDevice) }
            broadcastStatus("audio_route", "音频输入：${AudioRouteController.label(route.inputDevice)}")
        }.also { controller ->
            val route = controller.start()
            broadcastStatus("audio_route", "音频输入：${AudioRouteController.label(route.inputDevice)}")
        }
    }

    private fun stopAudioRouting() {
        audioRouteController?.stop()
        audioRouteController = null
    }

    private fun startMicForeground() {
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("ASRApp")
            .setContentText("正在录音")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun acquireWakeLock() {
        val power = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ASRApp:Recording").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "ASR recording",
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun broadcastStatus(type: String, message: String) {
        sendBroadcast(Intent(ACTION_EVENT).apply {
            setPackage(packageName)
            putExtra(EXTRA_TYPE, type)
            putExtra(EXTRA_MESSAGE, message)
        })
    }

    private fun broadcastError(message: String) {
        sendBroadcast(Intent(ACTION_EVENT).apply {
            setPackage(packageName)
            putExtra(EXTRA_TYPE, "recording_error")
            putExtra(EXTRA_MESSAGE, message)
        })
    }

    private fun timestamp(): String =
        SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())

    companion object {
        const val ACTION_START = "com.asrapp.android.action.START_RECORDING"
        const val ACTION_STOP = "com.asrapp.android.action.STOP_RECORDING"
        const val ACTION_EVENT = "com.asrapp.android.action.RECORDING_EVENT"
        const val EXTRA_TYPE = "type"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_PATH = "path"
        const val EXTRA_FILENAME = "filename"
        const val EXTRA_MIME = "mime"
        const val EXTRA_INPUT_DEVICE_KEY = "input_device_key"
        private const val CHANNEL_ID = "asr_recording"
        private const val NOTIFICATION_ID = 1002
    }

    private var currentInputDeviceKey: String = ""

    private fun intentDeviceKey(): String = currentInputDeviceKey
}
