package com.asrapp.android.ui

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.core.content.ContextCompat
import com.asrapp.android.data.AppPrefs
import com.asrapp.android.data.AppSettings
import com.asrapp.android.data.AsrApiClient
import com.asrapp.android.data.HistoryItem
import com.asrapp.android.data.ModelInfo
import com.asrapp.android.data.SubmitResult
import com.asrapp.android.data.TaskStatusResponse
import com.asrapp.android.data.TranscribeOptions
import com.asrapp.android.data.TranscribeResponse
import com.asrapp.android.service.RecordingService
import com.asrapp.android.service.StreamingRecognitionService
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

enum class AppPage(val title: String) {
    Transcribe("录音识别"),
    FileTranscribe("文件转写"),
    Models("模型"),
    History("历史"),
    Settings("设置"),
}

enum class WorkStatus {
    Idle,
    Checking,
    Uploading,
    Polling,
    Done,
    Error,
    Recording,
    Streaming,
    Processing,
}

data class AppUiState(
    val page: AppPage = AppPage.Transcribe,
    val settings: AppSettings = AppSettings(),
    val serverConnected: Boolean = false,
    val serverMessage: String = "未检查",
    val status: WorkStatus = WorkStatus.Idle,
    val statusMessage: String = "就绪",
    val models: List<ModelInfo> = emptyList(),
    val backendDefaultEngine: String = "fireredasr2",
    val history: List<HistoryItem> = emptyList(),
    val currentResult: HistoryItem? = null,
    val currentTaskId: String? = null,
    val streamCommittedText: String = "",
    val streamPartialText: String = "",
    val error: String? = null,
)

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val api = AsrApiClient()
    private val prefs = AppPrefs(app, api.json)
    private var pollJob: Job? = null
    private var streamSpeechStartSec: Double? = null
    private var streamPlaybackCursorSec = 0.0
    private val pendingAudio = mutableMapOf<String, PendingAudio>()
    private val recordingReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            handleRecordingEvent(intent)
        }
    }
    private val streamReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            handleStreamEvent(intent)
        }
    }

    var uiState by mutableStateOf(
        AppUiState(
            settings = prefs.loadSettings(),
            history = prefs.loadHistory(),
        )
    )
        private set

    init {
        val recordingFilter = IntentFilter(RecordingService.ACTION_EVENT)
        ContextCompat.registerReceiver(
            app,
            recordingReceiver,
            recordingFilter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        val streamFilter = IntentFilter(StreamingRecognitionService.ACTION_EVENT)
        ContextCompat.registerReceiver(
            app,
            streamReceiver,
            streamFilter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        checkServer()
        refreshModels()
    }

    override fun onCleared() {
        val app = getApplication<Application>()
        runCatching { app.unregisterReceiver(recordingReceiver) }
        runCatching { app.unregisterReceiver(streamReceiver) }
        super.onCleared()
    }

    fun selectPage(page: AppPage) {
        uiState = uiState.copy(page = page)
    }

    fun updateSettings(settings: AppSettings) {
        val offlineEngine = settings.offlineEngines.firstOrNull() ?: "fireredasr2"
        val bounceEngine = settings.realtimeEngines.firstOrNull() ?: "sensevoice"
        val clean = settings.copy(
            serverUrl = settings.serverUrl.trim().trimEnd('/'),
            offlineEngines = listOf(offlineEngine),
            realtimeEngines = listOf(bounceEngine),
        )
        prefs.saveSettings(clean)
        uiState = uiState.copy(settings = clean)
    }

    fun setError(message: String?) {
        uiState = uiState.copy(error = message, status = if (message == null) uiState.status else WorkStatus.Error)
    }

    fun checkServer() {
        viewModelScope.launch {
            uiState = uiState.copy(status = WorkStatus.Checking, serverMessage = "连接中")
            runCatching { api.health(uiState.settings.serverUrl) }
                .onSuccess { health ->
                    uiState = uiState.copy(
                        serverConnected = true,
                        serverMessage = "已连接 ${health.uptimeSec?.let { "${it}s" } ?: ""}".trim(),
                        status = WorkStatus.Idle,
                        statusMessage = "后端可用",
                        error = null,
                    )
                }
                .onFailure { err ->
                    uiState = uiState.copy(
                        serverConnected = false,
                        serverMessage = "连接失败",
                        status = WorkStatus.Error,
                        statusMessage = "后端不可用",
                        error = err.message,
                    )
                }
        }
    }

    fun refreshModels() {
        viewModelScope.launch {
            runCatching { api.models(uiState.settings.serverUrl) }
                .onSuccess { result ->
                    uiState = uiState.copy(
                        models = result.engines,
                        backendDefaultEngine = result.defaultEngine,
                        error = null,
                    )
                }
                .onFailure { err -> uiState = uiState.copy(error = err.message) }
        }
    }

    fun selectOfflineEngine(engine: String) {
        updateSettings(uiState.settings.copy(offlineEngines = listOf(engine)))
    }

    fun selectRealtimeEngine(engine: String) {
        updateSettings(uiState.settings.copy(realtimeEngines = listOf(engine)))
    }

    fun updateModelRecognitionConfig(
        language: String,
        whisperModel: String,
        enablePunctuation: Boolean,
        enableDiarize: Boolean,
    ) {
        updateSettings(
            uiState.settings.copy(
                defaultLanguage = language.trim(),
                whisperModel = whisperModel.trim(),
                enablePunctuation = enablePunctuation,
                enableDiarize = enableDiarize,
            )
        )
    }

    fun loadModel(engine: String, modelName: String?, device: String?, computeType: String?) {
        viewModelScope.launch {
            uiState = uiState.copy(status = WorkStatus.Processing, statusMessage = "加载模型 $engine")
            runCatching {
                api.loadModel(uiState.settings.serverUrl, engine, modelName, device, computeType)
            }.onSuccess {
                uiState = uiState.copy(status = WorkStatus.Idle, statusMessage = "模型已加载", error = null)
                refreshModels()
            }.onFailure { err ->
                uiState = uiState.copy(status = WorkStatus.Error, statusMessage = "模型加载失败", error = err.message)
            }
        }
    }

    fun unloadModel(engine: String) {
        viewModelScope.launch {
            uiState = uiState.copy(status = WorkStatus.Processing, statusMessage = "卸载模型 $engine")
            runCatching { api.unloadModel(uiState.settings.serverUrl, engine) }
                .onSuccess {
                    uiState = uiState.copy(status = WorkStatus.Idle, statusMessage = it, error = null)
                    refreshModels()
                }
                .onFailure { err ->
                    uiState = uiState.copy(status = WorkStatus.Error, statusMessage = "模型卸载失败", error = err.message)
                }
        }
    }

    fun transcribeUri(uri: Uri) {
        val context = getApplication<Application>()
        viewModelScope.launch {
            runCatching {
                val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
                val filename = displayName(uri) ?: "audio_${timestamp()}.m4a"
                val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: error("无法读取音频文件")
                val audioPath = persistAudio(bytes, filename)
                submitAudio(
                    bytes = bytes,
                    filename = filename,
                    mime = mime,
                    metadata = PendingAudio(
                        category = CATEGORY_FILE,
                        audioPath = audioPath,
                        audioUri = uri.toString(),
                        resultKind = "选择音频",
                    ),
                )
            }.onFailure { err ->
                uiState = uiState.copy(status = WorkStatus.Error, statusMessage = "读取文件失败", error = err.message)
            }
        }
    }

    fun startRecording() {
        val context = getApplication<Application>()
        val intent = Intent(context, RecordingService::class.java).apply {
            action = RecordingService.ACTION_START
        }
        ContextCompat.startForegroundService(context, intent)
        uiState = uiState.copy(status = WorkStatus.Recording, statusMessage = "录音中", error = null)
    }

    fun stopRecordingAndTranscribe() {
        val context = getApplication<Application>()
        val intent = Intent(context, RecordingService::class.java).apply {
            action = RecordingService.ACTION_STOP
        }
        context.startService(intent)
        uiState = uiState.copy(status = WorkStatus.Processing, statusMessage = "正在结束录音")
    }

    fun startStreamingRecognition() {
        val settings = uiState.settings
        val partialEngine = streamPartialEngine(settings)
        val finalEngine = streamFinalEngine(settings)
        val context = getApplication<Application>()
        val intent = Intent(context, StreamingRecognitionService::class.java).apply {
            action = StreamingRecognitionService.ACTION_START
            putExtra(StreamingRecognitionService.EXTRA_BASE_URL, settings.serverUrl)
            putExtra(StreamingRecognitionService.EXTRA_ENGINE, partialEngine)
            putExtra(StreamingRecognitionService.EXTRA_FINAL_ENGINE, finalEngine)
            putExtra(StreamingRecognitionService.EXTRA_LANGUAGE, settings.defaultLanguage)
            putExtra(StreamingRecognitionService.EXTRA_USER_ID, settings.streamUserId.ifBlank { "android" })
            putExtra(StreamingRecognitionService.EXTRA_CATEGORY, CATEGORY_STREAM)
        }
        ContextCompat.startForegroundService(context, intent)
        streamSpeechStartSec = null
        streamPlaybackCursorSec = 0.0
        uiState = uiState.copy(
            status = WorkStatus.Streaming,
            statusMessage = "实时转录中",
            streamCommittedText = "",
            streamPartialText = "",
            currentResult = HistoryItem(
                taskId = "streaming",
                filename = "实时识别",
                createdAt = System.currentTimeMillis(),
                fullText = "",
                category = CATEGORY_STREAM,
                resultKind = "实时转写",
                engineUsed = "$partialEngine+$finalEngine",
            ),
            error = null,
        )
    }

    fun stopStreamingRecognition() {
        val context = getApplication<Application>()
        val intent = Intent(context, StreamingRecognitionService::class.java).apply {
            action = StreamingRecognitionService.ACTION_STOP
        }
        context.startService(intent)
        uiState = uiState.copy(status = WorkStatus.Processing, statusMessage = "正在结束实时转录")
    }

    fun cancelCurrentTask() {
        val taskId = uiState.currentTaskId ?: return
        viewModelScope.launch {
            pollJob?.cancel()
            runCatching { api.cancelTask(uiState.settings.serverUrl, taskId) }
                .onSuccess {
                    uiState = uiState.copy(
                        status = WorkStatus.Idle,
                        statusMessage = "任务已取消",
                        currentTaskId = null,
                        error = null,
                    )
                }
                .onFailure { err -> uiState = uiState.copy(error = err.message) }
        }
    }

    fun deleteHistory(item: HistoryItem) {
        val next = uiState.history.filterNot { it.taskId == item.taskId }
        prefs.saveHistory(next)
        uiState = uiState.copy(history = next, currentResult = uiState.currentResult?.takeIf { it.taskId != item.taskId })
    }

    fun clearHistory() {
        prefs.saveHistory(emptyList())
        uiState = uiState.copy(history = emptyList(), currentResult = null)
    }

    fun showHistory(item: HistoryItem) {
        uiState = uiState.copy(currentResult = item, page = AppPage.Transcribe)
    }

    fun clearCurrentResult() {
        if (uiState.status == WorkStatus.Streaming || uiState.status == WorkStatus.Recording) return
        uiState = uiState.copy(
            currentResult = null,
            streamCommittedText = "",
            streamPartialText = "",
            status = WorkStatus.Idle,
            statusMessage = "就绪",
            currentTaskId = null,
        )
    }

    private suspend fun submitAudio(bytes: ByteArray, filename: String, mime: String, metadata: PendingAudio) {
        pollJob?.cancel()
        uiState = uiState.copy(
            status = WorkStatus.Uploading,
            statusMessage = "上传并转写 $filename",
            currentTaskId = null,
            error = null,
        )
        val result = runCatching {
            api.transcribe(uiState.settings.serverUrl, bytes, filename, mime, buildOptions(metadata.category))
        }.getOrElse { err ->
            uiState = uiState.copy(status = WorkStatus.Error, statusMessage = "转写失败", error = err.message)
            return
        }
        when (result) {
            is SubmitResult.Sync -> finishResult(historyFrom(result.response, filename, metadata))
            is SubmitResult.Async -> {
                pendingAudio[result.response.taskId] = metadata
                pollTask(result.response.taskId, filename)
            }
        }
    }

    private fun pollTask(taskId: String, filename: String) {
        pollJob = viewModelScope.launch {
            uiState = uiState.copy(
                status = WorkStatus.Polling,
                statusMessage = "后端处理中",
                currentTaskId = taskId,
            )
            val start = System.currentTimeMillis()
            val timeoutMs = uiState.settings.timeoutSec.coerceAtLeast(0) * 1000L
            while (true) {
                val task = runCatching { api.pollTask(uiState.settings.serverUrl, taskId) }
                    .getOrElse { err ->
                        uiState = uiState.copy(status = WorkStatus.Error, statusMessage = "轮询失败", error = err.message)
                        return@launch
                    }
                when (task.status) {
                    "success" -> {
                        finishResult(historyFrom(task, filename, pendingAudio.remove(taskId) ?: PendingAudio(category = CATEGORY_FILE)))
                        return@launch
                    }
                    "failed", "cancelled" -> {
                        uiState = uiState.copy(
                            status = WorkStatus.Error,
                            statusMessage = "任务${task.status}",
                            currentTaskId = null,
                            error = task.errorMessage ?: task.status,
                        )
                        return@launch
                    }
                }
                if (timeoutMs > 0 && System.currentTimeMillis() - start > timeoutMs) {
                    uiState = uiState.copy(
                        status = WorkStatus.Error,
                        statusMessage = "转写超时",
                        error = "任务 $taskId 超过 ${uiState.settings.timeoutSec}s 未完成",
                    )
                    return@launch
                }
                delay(1500)
            }
        }
    }

    private fun finishResult(item: HistoryItem) {
        val next = (listOf(item) + uiState.history.filterNot { it.taskId == item.taskId }).take(200)
        prefs.saveHistory(next)
        uiState = uiState.copy(
            status = WorkStatus.Done,
            statusMessage = "转写完成",
            history = next,
            currentResult = item,
            currentTaskId = null,
            error = null,
        )
    }

    private fun buildOptions(category: String): TranscribeOptions {
        val settings = uiState.settings
        val engines = offlineEngines(settings)
        return TranscribeOptions(
            engines = engines,
            language = settings.defaultLanguage.takeIf { it.isNotBlank() },
            whisperModel = settings.whisperModel.takeIf { engines.contains("whisper") && it.isNotBlank() },
            enablePunctuation = settings.enablePunctuation,
            enableDiarize = settings.enableDiarize,
            mergeStrategy = "first",
            allowServerDataCollection = settings.allowServerDataCollection,
            archiveCategory = category,
        )
    }

    private fun handleRecordingEvent(intent: Intent) {
        when (intent.getStringExtra(RecordingService.EXTRA_TYPE).orEmpty()) {
            "recording_started" -> {
                uiState = uiState.copy(
                    status = WorkStatus.Recording,
                    statusMessage = intent.getStringExtra(RecordingService.EXTRA_MESSAGE) ?: "录音中",
                    error = null,
                )
            }
            "audio_route" -> {
                uiState = uiState.copy(
                    status = WorkStatus.Recording,
                    statusMessage = intent.getStringExtra(RecordingService.EXTRA_MESSAGE) ?: "录音中",
                    error = null,
                )
            }
            "recording_done" -> {
                val path = intent.getStringExtra(RecordingService.EXTRA_PATH)
                val filename = intent.getStringExtra(RecordingService.EXTRA_FILENAME) ?: "recording_${timestamp()}.m4a"
                val mime = intent.getStringExtra(RecordingService.EXTRA_MIME) ?: "audio/mp4"
                val file = path?.let(::File)
                if (file == null || !file.exists() || file.length() == 0L) {
                    uiState = uiState.copy(status = WorkStatus.Error, statusMessage = "录音为空", error = "请录制更长一点的音频")
                    return
                }
                viewModelScope.launch {
                    val bytes = file.readBytes()
                    val audioPath = persistAudio(bytes, filename)
                    submitAudio(
                        bytes = bytes,
                        filename = filename,
                        mime = mime,
                        metadata = PendingAudio(
                            category = CATEGORY_RECORDING,
                            audioPath = audioPath,
                            resultKind = "开始录音",
                        ),
                    )
                }
            }
            "recording_error" -> {
                uiState = uiState.copy(
                    status = WorkStatus.Error,
                    statusMessage = "录音失败",
                    error = intent.getStringExtra(RecordingService.EXTRA_MESSAGE),
                )
            }
        }
    }

    private fun handleStreamEvent(intent: Intent) {
        val type = intent.getStringExtra(StreamingRecognitionService.EXTRA_TYPE).orEmpty()
        when (type) {
            "ready", "configured" -> {
                uiState = uiState.copy(status = WorkStatus.Streaming, statusMessage = "实时转录中", error = null)
            }
            "speech_start" -> {
                val atMs = intent.getDoubleExtra(StreamingRecognitionService.EXTRA_AT_MS, Double.NaN)
                val preRollMs = intent.getDoubleExtra(StreamingRecognitionService.EXTRA_PRE_ROLL_MS, 0.0)
                if (!atMs.isNaN()) {
                    streamSpeechStartSec = ((atMs - preRollMs).coerceAtLeast(0.0)) / 1000.0
                }
                uiState = uiState.copy(status = WorkStatus.Streaming, statusMessage = "实时转录中", error = null)
            }
            "partial" -> {
                val text = streamPartialText(intent)
                val item = uiState.currentResult ?: HistoryItem(
                    taskId = "streaming",
                    filename = "实时识别",
                    createdAt = System.currentTimeMillis(),
                    fullText = "",
                    category = CATEGORY_STREAM,
                    resultKind = "实时转写",
                )
                val liveText = limitLiveStreamText(joinStreamText(uiState.streamCommittedText, text))
                uiState = uiState.copy(
                    status = WorkStatus.Streaming,
                    statusMessage = "正在识别",
                    streamPartialText = text,
                    currentResult = item.copy(fullText = liveText),
                )
            }
            "final" -> {
                val text = intent.getStringExtra(StreamingRecognitionService.EXTRA_TEXT).orEmpty()
                val sessionId = intent.getStringExtra(StreamingRecognitionService.EXTRA_SESSION_ID) ?: "stream"
                val jobId = intent.getStringExtra(StreamingRecognitionService.EXTRA_JOB_ID) ?: System.currentTimeMillis().toString()
                val realTimeStart = intent.getStringExtra(StreamingRecognitionService.EXTRA_REAL_TIME_START)
                val realTimeEnd = intent.getStringExtra(StreamingRecognitionService.EXTRA_REAL_TIME_END)
                val archiveAudioPath = intent.getStringExtra(StreamingRecognitionService.EXTRA_ARCHIVE_AUDIO_PATH)
                val archiveAudioUri = archiveAudioUrl(uiState.settings.serverUrl, archiveAudioPath)
                val durationSec = intent.getDoubleExtra(StreamingRecognitionService.EXTRA_DURATION, Double.NaN).takeIf { !it.isNaN() }
                val playbackStartSec = streamSpeechStartSec ?: streamPlaybackCursorSec
                val playbackEndSec = durationSec?.let { playbackStartSec + it }
                if (playbackEndSec != null) {
                    streamPlaybackCursorSec = maxOf(streamPlaybackCursorSec, playbackEndSec)
                }
                streamSpeechStartSec = null
                val line = timestampedStreamLine(realTimeStart, realTimeEnd, text)
                val committed = appendStreamText(uiState.streamCommittedText, line)
                val item = HistoryItem(
                    taskId = "$sessionId-$jobId",
                    filename = "实时识别_${timestamp()}.wav",
                    createdAt = System.currentTimeMillis(),
                    fullText = line,
                    category = CATEGORY_STREAM,
                    resultKind = "实时转写",
                    language = intent.getStringExtra(StreamingRecognitionService.EXTRA_LANGUAGE),
                    engineUsed = intent.getStringExtra(StreamingRecognitionService.EXTRA_ENGINE),
                    confidence = intent.getDoubleExtra(StreamingRecognitionService.EXTRA_CONFIDENCE, Double.NaN).takeIf { !it.isNaN() },
                    durationSec = durationSec,
                    realTimeStart = realTimeStart,
                    realTimeEnd = realTimeEnd,
                    audioUri = archiveAudioUri,
                    playbackStartSec = if (archiveAudioUri == null) playbackStartSec else null,
                    playbackEndSec = if (archiveAudioUri == null) playbackEndSec else null,
                )
                val next = (listOf(item) + uiState.history).take(200)
                prefs.saveHistory(next)
                uiState = uiState.copy(
                    status = WorkStatus.Streaming,
                    statusMessage = "已生成一句",
                    history = next,
                    streamCommittedText = committed,
                    streamPartialText = "",
                    currentResult = item.copy(fullText = committed),
                    error = null,
                )
            }
            "done" -> {
                val audioPath = intent.getStringExtra(StreamingRecognitionService.EXTRA_AUDIO_PATH)
                val sessionId = intent.getStringExtra(StreamingRecognitionService.EXTRA_SESSION_ID)
                val nextHistory = if (audioPath.isNullOrBlank() || sessionId.isNullOrBlank()) {
                    uiState.history
                } else {
                    uiState.history.map { item ->
                        if (item.taskId.startsWith("$sessionId-") && item.audioPath.isNullOrBlank() && item.audioUri.isNullOrBlank()) {
                            item.copy(audioPath = audioPath)
                        } else {
                            item
                        }
                    }
                }
                if (nextHistory !== uiState.history) {
                    prefs.saveHistory(nextHistory)
                }
                val nextCurrent = uiState.currentResult?.let { item ->
                    if (!audioPath.isNullOrBlank() && !sessionId.isNullOrBlank() && item.taskId.startsWith("$sessionId-") && item.audioPath.isNullOrBlank() && item.audioUri.isNullOrBlank()) {
                        item.copy(audioPath = audioPath)
                    } else {
                        item
                    }
                }
                uiState = uiState.copy(
                    status = WorkStatus.Idle,
                    statusMessage = "实时转录已停止",
                    history = nextHistory,
                    currentResult = nextCurrent,
                )
            }
            "recording_restarting" -> {
                uiState = uiState.copy(
                    status = WorkStatus.Streaming,
                    statusMessage = "录音恢复中",
                    error = null,
                )
            }
            "audio_route" -> {
                uiState = uiState.copy(
                    status = WorkStatus.Streaming,
                    statusMessage = intent.getStringExtra(StreamingRecognitionService.EXTRA_MESSAGE) ?: "实时转录中",
                    error = null,
                )
            }
            "connecting" -> {
                uiState = uiState.copy(
                    status = WorkStatus.Streaming,
                    statusMessage = "实时转录连接中",
                    error = null,
                )
            }
            "reconnecting" -> {
                uiState = uiState.copy(
                    status = WorkStatus.Streaming,
                    statusMessage = "连接恢复中",
                    error = null,
                )
            }
            "error" -> {
                uiState = uiState.copy(
                    status = WorkStatus.Error,
                    statusMessage = "实时转录失败",
                    error = intent.getStringExtra(StreamingRecognitionService.EXTRA_MESSAGE),
                )
            }
        }
    }

    private fun historyFrom(response: TranscribeResponse, filename: String, metadata: PendingAudio): HistoryItem =
        HistoryItem(
            taskId = response.taskId,
            filename = filename,
            createdAt = System.currentTimeMillis(),
            fullText = response.fullText,
            category = metadata.category,
            audioPath = metadata.audioPath,
            audioUri = metadata.audioUri,
            resultKind = metadata.resultKind,
            segments = response.segments,
            language = response.language,
            engineUsed = response.engineUsed,
            confidence = response.confidence,
            durationSec = response.durationSec,
            elapsedSec = response.elapsedSec,
            engineResults = response.engineResults,
        )

    private fun historyFrom(task: TaskStatusResponse, filename: String, metadata: PendingAudio): HistoryItem =
        HistoryItem(
            taskId = task.id,
            filename = task.filename ?: filename,
            createdAt = System.currentTimeMillis(),
            fullText = task.fullText.orEmpty(),
            category = metadata.category,
            audioPath = metadata.audioPath,
            audioUri = metadata.audioUri,
            resultKind = metadata.resultKind,
            segments = task.segments.orEmpty(),
            language = task.language,
            engineUsed = task.engineUsed,
            confidence = task.confidence,
            durationSec = task.durationSec,
            elapsedSec = task.elapsedSec,
        )

    private fun displayName(uri: Uri): String? {
        val app = getApplication<Application>()
        if (uri.scheme == "content") {
            app.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0 && cursor.moveToFirst()) return cursor.getString(idx)
            }
        }
        return uri.lastPathSegment
    }

    private fun persistAudio(bytes: ByteArray, filename: String): String {
        val app = getApplication<Application>()
        val dir = File(app.filesDir, "history_audio").apply { mkdirs() }
        val cleanName = filename.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "audio.m4a" }
        val file = File(dir, "${timestamp()}_$cleanName")
        file.writeBytes(bytes)
        return file.absolutePath
    }

private fun timestamp(): String =
    SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())

private fun archiveAudioUrl(baseUrl: String, archiveAudioPath: String?): String? {
    val path = archiveAudioPath?.takeIf { it.isNotBlank() } ?: return null
    val cleanBase = baseUrl.trim().trimEnd('/').takeIf { it.isNotBlank() } ?: return null
    val encodedPath = URLEncoder.encode(path, "UTF-8")
    return "$cleanBase/v1/records/audio?path=$encodedPath"
}

    private fun appendStreamText(base: String, next: String): String =
        limitLiveStreamText(joinStreamText(base, next).trim())

    private fun joinStreamText(base: String, next: String): String {
        val cleanBase = base.trim()
        val cleanNext = next.trim()
        if (cleanBase.isEmpty()) return cleanNext
        if (cleanNext.isEmpty()) return cleanBase
        return "$cleanBase\n$cleanNext"
    }

    private fun limitLiveStreamText(text: String): String {
        if (text.length <= MAX_LIVE_STREAM_TEXT_CHARS) return text
        return "...\n" + text.takeLast(MAX_LIVE_STREAM_TEXT_CHARS)
    }

    private fun streamPartialText(intent: Intent): String {
        val stable = intent.getStringExtra(StreamingRecognitionService.EXTRA_STABLE_TEXT).orEmpty()
        val unstable = intent.getStringExtra(StreamingRecognitionService.EXTRA_UNSTABLE_TEXT).orEmpty()
        val combined = (stable + unstable).trim()
        return combined.ifBlank { intent.getStringExtra(StreamingRecognitionService.EXTRA_TEXT).orEmpty() }
    }

    private fun timestampedStreamLine(realTimeStart: String?, realTimeEnd: String?, text: String): String {
        val startLabel = realTimeStart?.takeIf { it.isNotBlank() }?.let { formatIsoTime(it) } ?: formatClockTime(System.currentTimeMillis())
        val endLabel = realTimeEnd?.takeIf { it.isNotBlank() }?.let { formatIsoTime(it) }
        val label = if (endLabel.isNullOrBlank()) startLabel else "$startLabel-$endLabel"
        return "[$label] $text"
    }

    private fun formatIsoTime(value: String): String =
        value.substringAfter('T', value).take(8).ifBlank { value }

    private fun formatClockTime(timeMillis: Long): String =
        SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(timeMillis))

    private fun offlineEngines(settings: AppSettings): List<String> =
        settings.offlineEngines.ifEmpty { listOf("fireredasr2") }

    private fun streamPartialEngine(settings: AppSettings): String =
        settings.realtimeEngines.firstOrNull() ?: "sensevoice"

    private fun streamFinalEngine(settings: AppSettings): String =
        offlineEngines(settings).firstOrNull() ?: "fireredasr2"

    private data class PendingAudio(
        val category: String,
        val audioPath: String? = null,
        val audioUri: String? = null,
        val resultKind: String? = null,
    )

    companion object {
        private const val CATEGORY_FILE = "选择音频"
        private const val CATEGORY_RECORDING = "开始录音"
        private const val CATEGORY_STREAM = "实时转写"
        private const val MAX_LIVE_STREAM_TEXT_CHARS = 60_000
    }
}
