package com.rokid.cxr.sample.util

import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogItem
import com.rokid.cxr.sample.model.EventLogger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.SimpleDateFormat
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Unit tests for event logger thread safety and timestamp formatting consistency.
 * 事件日志线程安全与时间戳格式一致性的单元测试。
 */
class EventLoggerThreadSafetyTest {
    @Test
    fun `timestamp formatting is immutable and consistent under concurrency`() {
        val item = EventLogItem(
            id = 1L,
            timestampMillis = 1_720_000_000_123L,
            category = EventCategory.INFO,
            sdkApi = "test",
            stateBefore = "Idle",
            stateAfter = "Idle",
            event = "timestamp",
        )
        val executor = Executors.newFixedThreadPool(8)

        val results = try {
            List(500) {
                executor.submit<String> { EventLogger.formatTimestamp(item) }
            }.map { future ->
                future.get(5, TimeUnit.SECONDS)
            }
        } finally {
            executor.shutdown()
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                executor.shutdownNow()
                assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
            }
        }

        assertTrue(results.all(String::isNotEmpty))
        assertEquals(1, results.toSet().size)
        assertFalse(
            "EventLogger must not share mutable SimpleDateFormat instances",
            EventLogger::class.java.declaredFields.any { it.type == SimpleDateFormat::class.java },
        )
    }
}
