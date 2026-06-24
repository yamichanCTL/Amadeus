package com.asrapp.android.data

import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

class AppPrefs(context: Context, private val json: Json) {
    private val prefs = context.getSharedPreferences("asr_android_store", Context.MODE_PRIVATE)

    fun loadSettings(): AppSettings {
        val raw = prefs.getString("settings", null) ?: return AppSettings()
        val loaded = runCatching { json.decodeFromString<AppSettings>(raw) }.getOrDefault(AppSettings())
        val migrated = migrateSettings(loaded, raw)
        if (migrated != loaded) {
            saveSettings(migrated)
        }
        return migrated
    }

    fun saveSettings(settings: AppSettings) {
        prefs.edit().putString("settings", json.encodeToString(settings)).apply()
    }

    fun loadHistory(): List<HistoryItem> {
        val raw = prefs.getString("history", null) ?: return emptyList()
        return runCatching { json.decodeFromString<List<HistoryItem>>(raw) }.getOrDefault(emptyList())
    }

    fun saveHistory(history: List<HistoryItem>) {
        prefs.edit().putString("history", json.encodeToString(history.take(200))).apply()
    }

    private fun migrateSettings(settings: AppSettings, raw: String): AppSettings {
        val oldDefaultServers = setOf(
            "http://192.0.2.1:8001",
            "http://192.0.2.2:8001",
        )
        val legacy = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        var next = settings
        if (next.serverUrl.trim().trimEnd('/') in oldDefaultServers) {
            next = next.copy(serverUrl = DEFAULT_SERVER_URL)
        }
        val legacyOffline = legacy?.stringList("selectedEngines").orEmpty()
            .ifEmpty { legacy?.stringValue("defaultEngine")?.let(::listOf).orEmpty() }
        val legacyRealtime = legacy?.stringList("streamingEngines").orEmpty()
            .ifEmpty { legacy?.stringValue("streamingEngine")?.let(::listOf).orEmpty() }
        if (!legacy?.containsKey("offlineEngines").orFalse() && legacyOffline.isNotEmpty()) {
            next = next.copy(offlineEngines = legacyOffline.distinct())
        }
        if (!legacy?.containsKey("realtimeEngines").orFalse() && legacyRealtime.isNotEmpty()) {
            next = next.copy(realtimeEngines = legacyRealtime.distinct())
        }
        return next.copy(
            offlineEngines = next.offlineEngines.ifEmpty { listOf("fireredasr2") }.take(1),
            realtimeEngines = next.realtimeEngines.ifEmpty { listOf("sensevoice") }.take(1),
            llmProvider = next.llmProvider.ifBlank { "deepseek" },
            llmBaseUrl = next.llmBaseUrl.ifBlank { "https://api.deepseek.com" }.trim().trimEnd('/'),
            audioInputDeviceKey = next.audioInputDeviceKey.trim(),
            passiveSummaryFrequencyMin = next.passiveSummaryFrequencyMin.coerceIn(5, 1440),
            passiveSummaryUserId = next.passiveSummaryUserId.ifBlank { "dsm" },
            passiveSummaryCategory = next.passiveSummaryCategory.ifBlank { "实时转写" },
        )
    }

    private fun JsonObject.stringList(key: String): List<String> =
        (this[key] as? JsonArray)
            ?.jsonArray
            ?.mapNotNull { it.jsonPrimitive.contentOrNull?.takeIf(String::isNotBlank) }
            .orEmpty()

    private fun JsonObject.stringValue(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)

    private fun Boolean?.orFalse(): Boolean = this == true
}
