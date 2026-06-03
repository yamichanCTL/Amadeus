package com.asrapp.android.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

const val DEFAULT_SERVER_URL = "http://112.124.13.120:18000"

@Serializable
data class AppSettings(
    val serverUrl: String = DEFAULT_SERVER_URL,
    val defaultLanguage: String = "zh",
    val offlineEngines: List<String> = listOf("fireredasr2"),
    val realtimeEngines: List<String> = listOf("sensevoice"),
    val streamUserId: String = "android",
    val whisperModel: String = "base",
    val enablePunctuation: Boolean = false,
    val enableDiarize: Boolean = false,
    val timeoutSec: Int = 60,
    val allowServerDataCollection: Boolean = true,
    val audioInputDeviceKey: String = "",
    val llmProvider: String = "deepseek",
    val llmBaseUrl: String = "https://api.deepseek.com",
    val llmModel: String = "",
    val llmApiToken: String = "",
    val llmStyle: String = "",
    val passiveSummaryEnabled: Boolean = false,
    val passiveSummaryFrequencyMin: Int = 60,
    val passiveSummaryUserId: String = "dsm",
    val passiveSummaryCategory: String = "实时转写",
    val passiveSummaryStartTime: String = "",
    val passiveSummaryEndTime: String = "",
    val passiveSummaryAutoCloudSave: Boolean = false,
    val passiveSummaryLastRunMillis: Long = 0L,
)

@Serializable
data class HealthResponse(
    val status: String,
    @SerialName("uptime_sec") val uptimeSec: Double? = null,
)

@Serializable
data class ModelsListResponse(
    val engines: List<ModelInfo> = emptyList(),
    @SerialName("default_engine") val defaultEngine: String,
)

@Serializable
data class LlmModelsRequest(
    @SerialName("base_url") val baseUrl: String,
    @SerialName("api_token") val apiToken: String,
    val provider: String? = null,
)

@Serializable
data class LlmModelsResult(
    val connected: Boolean = false,
    val models: List<String> = emptyList(),
    val provider: String? = null,
    @SerialName("base_url") val baseUrl: String = "",
    @SerialName("status_code") val statusCode: Int? = null,
    val message: String? = null,
    @SerialName("elapsed_sec") val elapsedSec: Double? = null,
)

@Serializable
data class ArchiveSummaryRequest(
    val date: String,
    @SerialName("user_id") val userId: String? = null,
    val category: String? = null,
    @SerialName("start_time") val startTime: String? = null,
    @SerialName("end_time") val endTime: String? = null,
    val provider: String? = null,
    val model: String,
    @SerialName("base_url") val baseUrl: String,
    @SerialName("api_token") val apiToken: String,
    val prompt: String? = null,
    val style: String? = null,
    @SerialName("max_input_chars") val maxInputChars: Int? = null,
)

@Serializable
data class ArchiveSummaryResult(
    val summary: String,
    val model: String,
    val provider: String? = null,
    @SerialName("elapsed_sec") val elapsedSec: Double? = null,
    @SerialName("source_count") val sourceCount: Int = 0,
    @SerialName("input_chars") val inputChars: Int = 0,
    @SerialName("estimated_input_tokens") val estimatedInputTokens: Int = 0,
    @SerialName("chunk_count") val chunkCount: Int = 0,
    val truncated: Boolean = false,
    val date: String,
    @SerialName("time_range") val timeRange: String? = null,
)

@Serializable
data class ArchiveSummarySaveRequest(
    val summary: ArchiveSummaryResult,
    @SerialName("user_id") val userId: String? = null,
    val category: String? = null,
)

@Serializable
data class ArchiveSummarySaveResult(
    val saved: Boolean,
    val path: String,
)

@Serializable
data class ModelInfo(
    val engine: String,
    @SerialName("model_name") val modelName: String,
    @SerialName("is_loaded") val isLoaded: Boolean,
    val device: String? = null,
    @SerialName("compute_type") val computeType: String? = null,
    val languages: List<String> = emptyList(),
    val extra: Map<String, JsonElement> = emptyMap(),
)

@Serializable
data class TranscriptSegment(
    val start: Double,
    val end: Double,
    val text: String,
    val speaker: String? = null,
    val confidence: Double? = null,
)

@Serializable
data class EngineResult(
    val engine: String,
    @SerialName("full_text") val fullText: String,
    val segments: List<TranscriptSegment> = emptyList(),
    val language: String? = null,
    val confidence: Double? = null,
)

@Serializable
data class TranscribeOptions(
    val engines: List<String>,
    val language: String? = null,
    @SerialName("whisper_model") val whisperModel: String? = null,
    @SerialName("whisper_task") val whisperTask: String = "transcribe",
    @SerialName("enable_punctuation") val enablePunctuation: Boolean? = null,
    @SerialName("enable_diarize") val enableDiarize: Boolean? = null,
    @SerialName("merge_strategy") val mergeStrategy: String = "first",
    @SerialName("allow_server_data_collection") val allowServerDataCollection: Boolean = true,
    @SerialName("archive_category") val archiveCategory: String? = null,
)

@Serializable
data class TranscribeResponse(
    @SerialName("task_id") val taskId: String,
    val status: String,
    @SerialName("full_text") val fullText: String,
    val segments: List<TranscriptSegment> = emptyList(),
    val language: String? = null,
    @SerialName("engine_used") val engineUsed: String,
    val confidence: Double? = null,
    @SerialName("duration_sec") val durationSec: Double? = null,
    @SerialName("elapsed_sec") val elapsedSec: Double? = null,
    @SerialName("engine_results") val engineResults: List<EngineResult>? = null,
)

@Serializable
data class TranscribeAsyncResponse(
    @SerialName("task_id") val taskId: String,
    val status: String,
    val message: String = "",
)

@Serializable
data class TaskStatusResponse(
    val id: String,
    val status: String,
    val engines: String? = null,
    val filename: String? = null,
    @SerialName("duration_sec") val durationSec: Double? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("finished_at") val finishedAt: String? = null,
    @SerialName("elapsed_sec") val elapsedSec: Double? = null,
    @SerialName("error_message") val errorMessage: String? = null,
    @SerialName("full_text") val fullText: String? = null,
    val segments: List<TranscriptSegment>? = null,
    val language: String? = null,
    @SerialName("engine_used") val engineUsed: String? = null,
    val confidence: Double? = null,
)

@Serializable
data class TaskListResponse(
    val tasks: List<TaskStatusResponse> = emptyList(),
    val total: Int = 0,
    val limit: Int = 20,
    val offset: Int = 0,
)

@Serializable
data class HistoryItem(
    val taskId: String,
    val filename: String,
    val createdAt: Long,
    val fullText: String,
    val category: String? = null,
    val audioPath: String? = null,
    val audioUri: String? = null,
    val resultKind: String? = null,
    val segments: List<TranscriptSegment> = emptyList(),
    val language: String? = null,
    val engineUsed: String? = null,
    val confidence: Double? = null,
    val durationSec: Double? = null,
    val elapsedSec: Double? = null,
    val realTimeStart: String? = null,
    val realTimeEnd: String? = null,
    val playbackStartSec: Double? = null,
    val playbackEndSec: Double? = null,
    val engineResults: List<EngineResult>? = null,
)

sealed interface SubmitResult {
    data class Sync(val response: TranscribeResponse) : SubmitResult
    data class Async(val response: TranscribeAsyncResponse) : SubmitResult
}
