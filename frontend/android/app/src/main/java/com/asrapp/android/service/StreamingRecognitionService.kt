package com.asrapp.android.service

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.ServiceCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit

class StreamingRecognitionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .writeTimeout(0, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private var audioRecord: AudioRecord? = null
    private var audioRouteController: AudioRouteController? = null
    private var recordJob: Job? = null
    private var reconnectJob: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var sessionWriter: WavSessionWriter? = null
    private var latestSessionId: String? = null
    private var currentParams: StreamParams? = null
    private var currentInputDeviceKey: String = ""
    private var stopping = false
    private val audioLock = Any()
    private val pendingAudio = ArrayDeque<ByteArray>()
    private var activeSocket: WebSocket? = null
    private var pendingAudioBytes = 0

    private data class StreamParams(
        val baseUrl: String,
        val engine: String,
        val finalEngine: String,
        val language: String,
        val userId: String,
        val category: String,
    )

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> requestStop()
            else -> startStreaming(intent)
        }
        return START_REDELIVER_INTENT
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        cleanup(closeSocket = true)
        scope.cancel()
        super.onDestroy()
    }

    private fun startStreaming(intent: Intent?) {
        if (recordJob?.isActive == true) return
        stopping = false
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            broadcastError("缺少麦克风权限")
            stopSelf()
            return
        }

        startMicForeground()
        acquireRuntimeLocks()
        currentInputDeviceKey = intent?.getStringExtra(EXTRA_INPUT_DEVICE_KEY).orEmpty()
        startAudioRouting()

        val params = StreamParams(
            baseUrl = intent?.getStringExtra(EXTRA_BASE_URL).orEmpty(),
            engine = intent?.getStringExtra(EXTRA_ENGINE).orEmpty().ifBlank { "sensevoice" },
            finalEngine = intent?.getStringExtra(EXTRA_FINAL_ENGINE).orEmpty().ifBlank { "fireredasr2" },
            language = intent?.getStringExtra(EXTRA_LANGUAGE).orEmpty().ifBlank { "zh" },
            userId = intent?.getStringExtra(EXTRA_USER_ID).orEmpty().ifBlank { "android" },
            category = intent?.getStringExtra(EXTRA_CATEGORY).orEmpty().ifBlank { "实时转录" },
        )
        currentParams = params
        closeSessionWriter()
        sessionWriter = WavSessionWriter.create(filesDir, SAMPLE_RATE)
        latestSessionId = null
        synchronized(audioLock) {
            activeSocket = null
            pendingAudio.clear()
            pendingAudioBytes = 0
        }
        startAudioLoop()
        connectWebSocket(params)
    }

    private fun connectWebSocket(params: StreamParams) {
        if (stopping) return
        broadcastStatus("connecting", "实时转录连接中")
        val request = Request.Builder().url(streamUrl(params.baseUrl)).build()
        webSocket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    reconnectJob?.cancel()
                    reconnectJob = null
                    val config = JSONObject()
                        .put("type", "config")
                        .put("engine", params.engine)
                        .put("final_engine", params.finalEngine)
                        .put("language", params.language)
                        .put("user_id", params.userId)
                        .put("category", params.category)
                        .put("sample_rate", SAMPLE_RATE)
                        .put("archive", true)
                    webSocket.send(config.toString())
                    activateSocketAfterFlushing(webSocket)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    broadcastJson(text)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    handleSocketLost(params, t.message ?: "WebSocket 连接失败")
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (stopping) {
                        broadcastType("done")
                        cleanup(closeSocket = false)
                    } else {
                        handleSocketLost(params, reason.ifBlank { "WebSocket 已断开" })
                    }
                }
            },
        )
    }

    private fun startAudioLoop() {
        if (recordJob?.isActive == true) return
        recordJob = scope.launch {
            val minBuffer = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            ).coerceAtLeast(SAMPLE_RATE / 10 * 2)
            val audioFormat = AudioFormat.Builder()
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .build()
            while (recordJob?.isActive == true && !stopping) {
                val route = audioRouteController?.prepareForRecording()
                    ?: AudioRouteSelection(null, AudioRouteController.audioSourceFor(null))
                val recorder = AudioRecord.Builder()
                    .setAudioSource(route.audioSource)
                    .setAudioFormat(audioFormat)
                    .setBufferSizeInBytes(minBuffer * 4)
                    .build()
                route.inputDevice?.let { runCatching { recorder.setPreferredDevice(it) } }
                audioRecord = recorder
                val buffer = ByteArray(minBuffer)
                var emptyReads = 0
                try {
                    recorder.startRecording()
                    val routedDevice = runCatching { recorder.routedDevice }.getOrNull()
                    broadcastStatus("audio_route", "音频输入：${AudioRouteController.label(routedDevice ?: route.inputDevice)}")
                    while (recordJob?.isActive == true && !stopping) {
                        val read = recorder.read(buffer, 0, buffer.size)
                        when {
                            read > 0 -> {
                                emptyReads = 0
                                val chunk = buffer.copyOf(read)
                                sessionWriter?.write(chunk)
                                sendOrBufferAudio(chunk)
                            }
                            read == 0 -> {
                                emptyReads += 1
                                if (emptyReads > 100) {
                                    throw IllegalStateException("锁屏后长时间未收到麦克风数据")
                                }
                                delay(20)
                            }
                            read == AudioRecord.ERROR_DEAD_OBJECT -> {
                                throw IllegalStateException("麦克风录音对象已失效")
                            }
                            else -> {
                                throw IllegalStateException("麦克风读取失败: $read")
                            }
                        }
                    }
                } catch (exc: Exception) {
                    if (recordJob?.isActive == true && !stopping) {
                        broadcastStatus("recording_restarting", exc.message ?: "录音恢复中")
                        delay(300)
                    }
                } finally {
                    runCatching { recorder.stop() }
                    recorder.release()
                    if (audioRecord === recorder) {
                        audioRecord = null
                    }
                }
            }
        }
    }

    private fun requestStop() {
        if (stopping) return
        stopping = true
        reconnectJob?.cancel()
        reconnectJob = null
        recordJob?.cancel()
        recordJob = null
        synchronized(audioLock) {
            activeSocket = null
            pendingAudio.clear()
            pendingAudioBytes = 0
        }
        runCatching { audioRecord?.stop() }
        audioRecord?.release()
        audioRecord = null
        stopAudioRouting()
        webSocket?.send(JSONObject().put("type", "end").toString())
    }

    private fun cleanup(closeSocket: Boolean) {
        reconnectJob?.cancel()
        reconnectJob = null
        recordJob?.cancel()
        recordJob = null
        synchronized(audioLock) {
            activeSocket = null
            pendingAudio.clear()
            pendingAudioBytes = 0
        }
        runCatching { audioRecord?.stop() }
        audioRecord?.release()
        audioRecord = null
        stopAudioRouting()
        if (closeSocket) {
            webSocket?.close(1000, "client stop")
        }
        webSocket = null
        runCatching { wakeLock?.release() }
        wakeLock = null
        runCatching { wifiLock?.release() }
        wifiLock = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        broadcastDone(closeSessionWriter())
        stopSelf()
    }

    private fun startAudioRouting() {
        if (audioRouteController != null) return
        audioRouteController = AudioRouteController(this, currentInputDeviceKey) { route ->
            runCatching { audioRecord?.setPreferredDevice(route.inputDevice) }
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

    private fun handleSocketLost(params: StreamParams, message: String) {
        if (stopping) return
        broadcastStatus("reconnecting", message)
        synchronized(audioLock) {
            activeSocket = null
        }
        webSocket = null
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(1000)
            connectWebSocket(params)
        }
    }

    private fun sendOrBufferAudio(chunk: ByteArray) {
        val socket = synchronized(audioLock) { activeSocket }
        if (socket != null && socket.send(chunk.toByteString())) {
            return
        }
        if (socket != null) {
            synchronized(audioLock) {
                if (activeSocket === socket) {
                    activeSocket = null
                }
            }
            socket.cancel()
        }
        synchronized(audioLock) {
            pendingAudio.addLast(chunk)
            pendingAudioBytes += chunk.size
            while (pendingAudioBytes > MAX_PENDING_AUDIO_BYTES && pendingAudio.isNotEmpty()) {
                pendingAudioBytes -= pendingAudio.removeFirst().size
            }
        }
    }

    private fun activateSocketAfterFlushing(socket: WebSocket) {
        while (!stopping) {
            if (!flushPendingAudio(socket)) return
            synchronized(audioLock) {
                if (pendingAudio.isEmpty()) {
                    activeSocket = socket
                    return
                }
            }
        }
    }

    private fun flushPendingAudio(socket: WebSocket): Boolean {
        while (!stopping) {
            val chunk = synchronized(audioLock) {
                pendingAudio.pollFirst()?.also { pendingAudioBytes -= it.size }
            } ?: return true
            if (!socket.send(chunk.toByteString())) {
                synchronized(audioLock) {
                    pendingAudio.addFirst(chunk)
                    pendingAudioBytes += chunk.size
                    if (activeSocket === socket) {
                        activeSocket = null
                    }
                }
                socket.cancel()
                return false
            }
        }
        return false
    }

    private fun startMicForeground() {
        val notification = notification("实时转录运行中")
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

    private fun acquireRuntimeLocks() {
        val power = getSystemService(POWER_SERVICE) as PowerManager
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ASRApp:StreamingRecognition").apply {
            setReferenceCounted(false)
            acquire()
        }
        val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        } else {
            @Suppress("DEPRECATION")
            WifiManager.WIFI_MODE_FULL_HIGH_PERF
        }
        wifiLock = wifi.createWifiLock(mode, "ASRApp:StreamingRecognitionWifi").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun broadcastJson(text: String) {
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
        latestSessionId = obj.optString("session_id").takeIf { it.isNotBlank() } ?: latestSessionId
        if (obj.optString("type") == "done") {
            stopping = true
            webSocket?.close(1000, "server done")
            cleanup(closeSocket = false)
            return
        }
        val intent = Intent(ACTION_EVENT).apply {
            setPackage(packageName)
            putExtra(EXTRA_TYPE, obj.optString("type"))
            putExtra(EXTRA_TEXT, obj.optString("text"))
            putExtra(EXTRA_SESSION_ID, obj.optString("session_id"))
            putExtra(EXTRA_JOB_ID, obj.optString("job_id"))
            putExtra(EXTRA_ENGINE, obj.optString("engine"))
            putExtra(EXTRA_LANGUAGE, obj.optString("language"))
            putExtra(EXTRA_MESSAGE, obj.optString("message"))
            putExtra(EXTRA_STABLE_TEXT, obj.optString("stable_text"))
            putExtra(EXTRA_UNSTABLE_TEXT, obj.optString("unstable_text"))
            putExtra(EXTRA_REAL_TIME_START, obj.optString("real_time_start"))
            putExtra(EXTRA_REAL_TIME_END, obj.optString("real_time_end"))
            obj.optJSONObject("archive")?.let { archive ->
                archive.optString("audio_path").takeIf { it.isNotBlank() }?.let {
                    putExtra(EXTRA_ARCHIVE_AUDIO_PATH, it)
                }
                archive.optString("json_path").takeIf { it.isNotBlank() }?.let {
                    putExtra(EXTRA_ARCHIVE_JSON_PATH, it)
                }
            }
            if (obj.has("at_ms")) putExtra(EXTRA_AT_MS, obj.optDouble("at_ms"))
            if (obj.has("pre_roll_ms")) putExtra(EXTRA_PRE_ROLL_MS, obj.optDouble("pre_roll_ms"))
            if (obj.has("duration_sec")) putExtra(EXTRA_DURATION, obj.optDouble("duration_sec"))
            if (obj.has("confidence")) putExtra(EXTRA_CONFIDENCE, obj.optDouble("confidence"))
        }
        sendBroadcast(intent)
    }

    private fun broadcastError(message: String) {
        sendBroadcast(Intent(ACTION_EVENT).apply {
            setPackage(packageName)
            putExtra(EXTRA_TYPE, "error")
            putExtra(EXTRA_MESSAGE, message)
        })
    }

    private fun broadcastStatus(type: String, message: String) {
        sendBroadcast(Intent(ACTION_EVENT).apply {
            setPackage(packageName)
            putExtra(EXTRA_TYPE, type)
            putExtra(EXTRA_MESSAGE, message)
        })
    }

    private fun broadcastType(type: String) {
        sendBroadcast(Intent(ACTION_EVENT).apply {
            setPackage(packageName)
            putExtra(EXTRA_TYPE, type)
        })
    }

    private fun broadcastDone(audioPath: String?) {
        sendBroadcast(Intent(ACTION_EVENT).apply {
            setPackage(packageName)
            putExtra(EXTRA_TYPE, "done")
            latestSessionId?.let { putExtra(EXTRA_SESSION_ID, it) }
            audioPath?.let { putExtra(EXTRA_AUDIO_PATH, it) }
        })
    }

    private fun closeSessionWriter(): String? {
        val writer = sessionWriter ?: return null
        sessionWriter = null
        return writer.close()
    }

    private fun notification(text: String) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("ASRApp")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "ASR streaming",
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun streamUrl(baseUrl: String): String {
        val clean = baseUrl.trim().trimEnd('/')
        return when {
            clean.startsWith("https://") -> "wss://" + clean.removePrefix("https://") + "/v1/stream"
            clean.startsWith("http://") -> "ws://" + clean.removePrefix("http://") + "/v1/stream"
            else -> "ws://$clean/v1/stream"
        }
    }

    private class WavSessionWriter private constructor(
        private val file: File,
        private val sampleRate: Int,
        private val raf: RandomAccessFile,
    ) {
        private var pcmSize = 0
        private var closed = false

        fun write(chunk: ByteArray) {
            if (closed || chunk.isEmpty()) return
            runCatching {
                raf.write(chunk)
                pcmSize += chunk.size
            }
        }

        fun close(): String? {
            if (closed) return file.absolutePath.takeIf { file.exists() }
            closed = true
            return runCatching {
                if (pcmSize <= 0) {
                    raf.close()
                    file.delete()
                    return null
                }
                raf.seek(0)
                writeHeader(raf, pcmSize, sampleRate)
                raf.close()
                file.absolutePath
            }.getOrElse {
                runCatching { raf.close() }
                runCatching { file.delete() }
                null
            }
        }

        companion object {
            fun create(filesDir: File, sampleRate: Int): WavSessionWriter? =
                runCatching {
                    val dir = File(filesDir, "history_audio").apply { mkdirs() }
                    val file = File(dir, "stream_${System.currentTimeMillis()}.wav")
                    val raf = RandomAccessFile(file, "rw")
                    writeHeader(raf, 0, sampleRate)
                    WavSessionWriter(file, sampleRate, raf)
                }.getOrNull()

            private fun writeHeader(raf: RandomAccessFile, pcmSize: Int, sampleRate: Int) {
                val byteRate = sampleRate * 2
                val totalSize = pcmSize + 36
                raf.write("RIFF".toByteArray(Charsets.US_ASCII))
                raf.writeIntLe(totalSize)
                raf.write("WAVE".toByteArray(Charsets.US_ASCII))
                raf.write("fmt ".toByteArray(Charsets.US_ASCII))
                raf.writeIntLe(16)
                raf.writeShortLe(1)
                raf.writeShortLe(1)
                raf.writeIntLe(sampleRate)
                raf.writeIntLe(byteRate)
                raf.writeShortLe(2)
                raf.writeShortLe(16)
                raf.write("data".toByteArray(Charsets.US_ASCII))
                raf.writeIntLe(pcmSize)
            }

            private fun RandomAccessFile.writeIntLe(value: Int) {
                write(
                    byteArrayOf(
                        (value and 0xff).toByte(),
                        ((value shr 8) and 0xff).toByte(),
                        ((value shr 16) and 0xff).toByte(),
                        ((value shr 24) and 0xff).toByte(),
                    )
                )
            }

            private fun RandomAccessFile.writeShortLe(value: Int) {
                write(byteArrayOf((value and 0xff).toByte(), ((value shr 8) and 0xff).toByte()))
            }
        }
    }

    companion object {
        const val ACTION_START = "com.asrapp.android.action.START_STREAMING"
        const val ACTION_STOP = "com.asrapp.android.action.STOP_STREAMING"
        const val ACTION_EVENT = "com.asrapp.android.action.STREAM_EVENT"
        const val EXTRA_BASE_URL = "base_url"
        const val EXTRA_ENGINE = "engine"
        const val EXTRA_FINAL_ENGINE = "final_engine"
        const val EXTRA_LANGUAGE = "language"
        const val EXTRA_USER_ID = "user_id"
        const val EXTRA_CATEGORY = "category"
        const val EXTRA_INPUT_DEVICE_KEY = "input_device_key"
        const val EXTRA_TYPE = "type"
        const val EXTRA_TEXT = "text"
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_JOB_ID = "job_id"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_STABLE_TEXT = "stable_text"
        const val EXTRA_UNSTABLE_TEXT = "unstable_text"
        const val EXTRA_REAL_TIME_START = "real_time_start"
        const val EXTRA_REAL_TIME_END = "real_time_end"
        const val EXTRA_AUDIO_PATH = "audio_path"
        const val EXTRA_ARCHIVE_AUDIO_PATH = "archive_audio_path"
        const val EXTRA_ARCHIVE_JSON_PATH = "archive_json_path"
        const val EXTRA_DURATION = "duration"
        const val EXTRA_AT_MS = "at_ms"
        const val EXTRA_PRE_ROLL_MS = "pre_roll_ms"
        const val EXTRA_CONFIDENCE = "confidence"
        private const val CHANNEL_ID = "asr_streaming"
        private const val NOTIFICATION_ID = 1001
        private const val SAMPLE_RATE = 16_000
        private const val MAX_PENDING_AUDIO_BYTES = SAMPLE_RATE * 2 * 8
    }
}
