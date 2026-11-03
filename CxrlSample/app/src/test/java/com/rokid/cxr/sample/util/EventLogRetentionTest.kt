package com.rokid.cxr.sample.util

import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogItem
import com.rokid.cxr.sample.model.EventLogger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Unit tests for event log in-memory retention policy.
 * 事件日志内存保留策略的单元测试。
 */
class EventLogRetentionTest {
    @Test
    fun `adding item 201 keeps only the newest 200`() {
        val retained = (1L..201L).fold(emptyList<EventLogItem>()) { entries, id ->
            EventLogger.append(entries, event(id))
        }

        assertEquals(200, retained.size)
        assertEquals(201L, retained.first().id)
        assertEquals(2L, retained.last().id)
        assertFalse(retained.any { it.id == 1L })
    }

    private fun event(id: Long) = EventLogItem(
        id = id,
        timestampMillis = id,
        category = EventCategory.INFO,
        sdkApi = "test",
        stateBefore = "Idle",
        stateAfter = "Idle",
        event = "event-$id",
    )
}
