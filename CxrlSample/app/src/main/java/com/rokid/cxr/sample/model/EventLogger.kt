package com.rokid.cxr.sample.model

import android.content.Context
import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogItem
import com.rokid.cxr.sample.util.TokenRedactor
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/**
 * In-memory event log builder, formatter, and exporter.
 * 内存事件日志构建器、格式化器与导出器。
 *
 * Automatically redacts credentials via [TokenRedactor] before storing or exporting.
 * 在存储与导出前通过 [TokenRedactor] 自动脱敏凭据。
 */
object EventLogger {
    const val MAX_MEMORY_ENTRIES = 200
    const val MAX_EXPORT_FILES = 5

    private val idGenerator = AtomicLong(1L)
    private val exportIdGenerator = AtomicLong(1L)
    private val zoneId = ZoneId.systemDefault()
    private val entryFormat = DateTimeFormatter
        .ofPattern("HH:mm:ss.SSS", Locale.getDefault())
        .withZone(zoneId)
    private val fileFormat = DateTimeFormatter
        .ofPattern("yyyyMMdd-HHmmss-SSS", Locale.getDefault())
        .withZone(zoneId)

    fun create(
        category: EventCategory,
        sdkApi: String,
        stateBefore: String,
        stateAfter: String,
        event: String,
        reason: String? = null,
        errorCode: String? = null,
        suggestedAction: String? = null,
    ): EventLogItem {
        return EventLogItem(
            id = idGenerator.getAndIncrement(),
            timestampMillis = System.currentTimeMillis(),
            category = category,
            sdkApi = TokenRedactor.redact(sdkApi).orEmpty(),
            stateBefore = TokenRedactor.redact(stateBefore).orEmpty(),
            stateAfter = TokenRedactor.redact(stateAfter).orEmpty(),
            event = TokenRedactor.redact(event).orEmpty(),
            reason = TokenRedactor.redact(reason),
            errorCode = TokenRedactor.redact(errorCode),
            suggestedAction = TokenRedactor.redact(suggestedAction),
        )
    }

    fun formatTimestamp(item: EventLogItem): String {
        return entryFormat.format(Instant.ofEpochMilli(item.timestampMillis))
    }

    fun append(entries: List<EventLogItem>, item: EventLogItem): List<EventLogItem> {
        return buildList(capacity = minOf(entries.size + 1, MAX_MEMORY_ENTRIES)) {
            add(item)
            addAll(entries.take(MAX_MEMORY_ENTRIES - 1))
        }
    }

    @Synchronized
    fun export(context: Context, entries: List<EventLogItem>): File {
        val dir = File(context.cacheDir, "event-logs").apply { mkdirs() }
        val timestamp = fileFormat.format(Instant.now())
        var file = nextExportFile(dir, timestamp)
        while (file.exists()) {
            file = nextExportFile(dir, timestamp)
        }
        file.writeText(
            buildString {
                entries.forEach { item ->
                    append(formatTimestamp(item))
                    append(" | ")
                    append(item.category)
                    append(" | ")
                    append(TokenRedactor.redact(item.sdkApi))
                    append(" | ")
                    append(TokenRedactor.redact(item.stateBefore))
                    append(" -> ")
                    append(TokenRedactor.redact(item.stateAfter))
                    append(" | ")
                    append(TokenRedactor.redact(item.event))
                    append(" | reason=")
                    append(TokenRedactor.redact(item.reason) ?: "-")
                    append(" | errorCode=")
                    append(TokenRedactor.redact(item.errorCode) ?: "-")
                    append(" | suggestedAction=")
                    append(TokenRedactor.redact(item.suggestedAction) ?: "-")
                    appendLine()
                }
            },
        )
        pruneExports(dir)
        return file
    }

    fun clearExports(context: Context) {
        File(context.cacheDir, "event-logs").deleteRecursively()
    }

    private fun nextExportFile(dir: File, timestamp: String): File {
        val suffix = exportIdGenerator.getAndIncrement().toString().padStart(6, '0')
        return File(dir, "cxr-log-$timestamp-$suffix.txt")
    }

    private fun pruneExports(dir: File) {
        val exports = dir.listFiles { file ->
            file.isFile && file.name.startsWith("cxr-log-") && file.extension == "txt"
        }.orEmpty().sortedWith(compareBy<File>({ it.lastModified() }, { it.name }))

        exports.dropLast(MAX_EXPORT_FILES).forEach(File::delete)
    }
}
