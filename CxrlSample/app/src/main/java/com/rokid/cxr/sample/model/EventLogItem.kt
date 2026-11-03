package com.rokid.cxr.sample.model

/**
 * Event log category.
 * 事件日志分类。
 */
enum class EventCategory {
    INFO,
    SDK_CALL,
    LIFECYCLE,
    CAPABILITY,
    EVENT,
    ERROR,
}

/**
 * A single redacted event log entry.
 * 一条已脱敏的事件日志条目。
 */
data class EventLogItem(
    val id: Long,
    val timestampMillis: Long,
    val category: EventCategory,
    val sdkApi: String,
    val stateBefore: String,
    val stateAfter: String,
    val event: String,
    val reason: String? = null,
    val errorCode: String? = null,
    val suggestedAction: String? = null,
)
