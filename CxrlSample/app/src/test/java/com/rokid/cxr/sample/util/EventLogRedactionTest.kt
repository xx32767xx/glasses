package com.rokid.cxr.sample.util

import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Unit tests verifying credential redaction inside event log creation.
 * 验证事件日志创建过程中凭据脱敏的单元测试。
 */
class EventLogRedactionTest {
    @Test
    fun `create redacts credentials before storing the event`() {
        val fakeToken = "fake-credential-value"

        val item = EventLogger.create(
            category = EventCategory.ERROR,
            sdkApi = "session.connect(token)",
            stateBefore = "Idle",
            stateAfter = "Idle",
            event = "connect Token: $fakeToken",
            reason = "token=$fakeToken",
            errorCode = "TEST",
            suggestedAction = "Authorization: Bearer $fakeToken",
        )

        assertEquals("connect Token: ***", item.event)
        assertEquals("token=***", item.reason)
        assertEquals("Authorization: ***", item.suggestedAction)
        assertFalse(item.toString().contains(fakeToken))
    }
}
