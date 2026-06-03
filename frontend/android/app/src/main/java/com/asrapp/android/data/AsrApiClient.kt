package com.asrapp.android.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalSerializationApi::class)
class AsrApiClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = false
        explicitNulls = false
    }

    suspend fun health(baseUrl: String): HealthResponse = get(baseUrl, "/v1/health")

    suspend fun models(baseUrl: String): ModelsListResponse = get(baseUrl, "/v1/models")

    suspend fun listLlmModels(baseUrl: String, request: LlmModelsRequest): LlmModelsResult =
        postJson(baseUrl, "/v1/llm/models", json.encodeToString(request))

    suspend fun summarizeArchive(baseUrl: String, request: ArchiveSummaryRequest): ArchiveSummaryResult =
        postJson(baseUrl, "/v1/llm/archive-summary", json.encodeToString(request))

    suspend fun summarizeArchiveStream(
        baseUrl: String,
        request: ArchiveSummaryRequest,
        onMeta: suspend (sourceCount: Int, inputChars: Int, estimatedInputTokens: Int, timeRange: String?) -> Unit,
        onStatus: suspend (String) -> Unit,
        onDelta: suspend (String) -> Unit,
        onResult: suspend (ArchiveSummaryResult) -> Unit,
    ) = withContext(Dispatchers.IO) {
        val httpRequest = Request.Builder()
            .url(endpoint(baseUrl, "/v1/llm/archive-summary/stream"))
            .post(json.encodeToString(request).toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(httpRequest).execute().use { response ->
            if (!response.isSuccessful) {
                val text = response.body?.string().orEmpty()
                throw IllegalStateException("HTTP ${response.code}: ${text.ifBlank { response.message }}")
            }
            val source = response.body?.source() ?: return@use
            while (true) {
                val line = source.readUtf8Line() ?: break
                if (line.isBlank()) continue
                val obj = json.parseToJsonElement(line).jsonObject
                when (obj["type"]?.jsonPrimitive?.contentOrNull) {
                    "meta" -> onMeta(
                        obj["source_count"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
                        obj["input_chars"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
                        obj["estimated_input_tokens"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
                        obj["time_range"]?.jsonPrimitive?.contentOrNull,
                    )
                    "status" -> obj["message"]?.jsonPrimitive?.contentOrNull?.let { onStatus(it) }
                    "delta" -> obj["text"]?.jsonPrimitive?.contentOrNull?.let { onDelta(it) }
                    "done" -> obj["result"]?.let { onResult(json.decodeFromJsonElement(ArchiveSummaryResult.serializer(), it)) }
                    "error" -> throw IllegalStateException(obj["message"]?.jsonPrimitive?.contentOrNull ?: "总结失败")
                }
            }
        }
    }

    suspend fun saveArchiveSummary(baseUrl: String, request: ArchiveSummarySaveRequest): ArchiveSummarySaveResult =
        postJson(baseUrl, "/v1/llm/archive-summary/save", json.encodeToString(request))

    suspend fun listTasks(baseUrl: String): TaskListResponse = get(baseUrl, "/v1/tasks?limit=50&offset=0")

    suspend fun pollTask(baseUrl: String, taskId: String): TaskStatusResponse =
        get(baseUrl, "/v1/tasks/$taskId")

    suspend fun cancelTask(baseUrl: String, taskId: String): TaskStatusResponse =
        postJson(baseUrl, "/v1/tasks/$taskId/cancel", "{}")

    suspend fun loadModel(
        baseUrl: String,
        engine: String,
        modelName: String?,
        device: String?,
        computeType: String?,
    ): ModelInfo {
        val body = buildJsonObject {
            modelName?.takeIf { it.isNotBlank() }?.let { put("model_name", it) }
            device?.takeIf { it.isNotBlank() }?.let { put("device", it) }
            computeType?.takeIf { it.isNotBlank() }?.let { put("compute_type", it) }
        }
        return postJson(baseUrl, "/v1/models/$engine/load", json.encodeToString(body))
    }

    suspend fun unloadModel(baseUrl: String, engine: String): String {
        val obj: JsonObject = postJson(baseUrl, "/v1/models/$engine/unload", "{}")
        return obj["message"]?.jsonPrimitive?.contentOrNull ?: "Model unloaded."
    }

    suspend fun transcribe(
        baseUrl: String,
        bytes: ByteArray,
        filename: String,
        mimeType: String,
        options: TranscribeOptions,
    ): SubmitResult = withContext(Dispatchers.IO) {
        val fileBody = bytes.toRequestBody(mimeType.toMediaTypeOrNull())
        val multipart = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", filename, fileBody)
            .addFormDataPart("options", json.encodeToString(options))
            .build()
        val request = Request.Builder()
            .url(endpoint(baseUrl, "/v1/transcribe"))
            .post(multipart)
            .build()
        val text = execute(request)
        val tree = json.parseToJsonElement(text) as JsonObject
        if (tree.containsKey("full_text")) {
            SubmitResult.Sync(json.decodeFromString<TranscribeResponse>(text))
        } else {
            SubmitResult.Async(json.decodeFromString<TranscribeAsyncResponse>(text))
        }
    }

    private suspend inline fun <reified T> get(baseUrl: String, path: String): T =
        withContext(Dispatchers.IO) {
            val request = Request.Builder().url(endpoint(baseUrl, path)).get().build()
            json.decodeFromString(execute(request))
        }

    private suspend inline fun <reified T> postJson(baseUrl: String, path: String, body: String): T =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(endpoint(baseUrl, path))
                .post(body.toRequestBody("application/json".toMediaType()))
                .build()
            json.decodeFromString(execute(request))
        }

    private fun execute(request: Request): String {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw IllegalStateException("HTTP ${response.code}: ${text.ifBlank { response.message }}")
            }
            return text
        }
    }

    private fun endpoint(baseUrl: String, path: String): String =
        baseUrl.trim().trimEnd('/') + path
}
