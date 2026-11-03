package com.rokid.cxr.sample.util

import com.rokid.cxr.sample.R
import com.rokid.cxr.session.CloseReason
import com.rokid.cxr.session.PausedReason
import com.rokid.cxr.session.SessionErrorCode
import com.rokid.cxr.session.TerminatingReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the SDK reason / error enum → string resource mapping layer.
 * SDK reason / error 枚举 → 字符串资源映射层的单元测试。
 *
 * Verifies that the mapping layer returns valid string resource ids instead of raw enum names.
 * 验证映射层返回有效的字符串资源 id，而不是原始枚举名。
 */
class SessionReasonMappingTest {

    @Test
    fun `pausedReason for all reasons returns a valid string resource`() {
        PausedReason.values().forEach { reason ->
            val resId = SessionReasonMapping.pausedReason(reason)
            assertNotEquals("pausedReason for $reason should return a valid resource", 0, resId)
            assertFalse("pausedReason for $reason should not be an enum name", resId == reason.name.hashCode())
        }
    }

    @Test
    fun `closeReasonPair for all reasons returns valid cause and action resources`() {
        CloseReason.values().forEach { reason ->
            val (causeRes, actionRes) = SessionReasonMapping.closeReasonPair(reason)
            assertNotEquals("closeReasonPair cause for $reason should be valid", 0, causeRes)
            assertNotEquals("closeReasonPair action for $reason should be valid", 0, actionRes)
        }
    }

    @Test
    fun `closeReason for all reasons returns a valid string resource`() {
        CloseReason.values().forEach { reason ->
            val resId = SessionReasonMapping.closeReason(reason)
            assertNotEquals("closeReason for $reason should return a valid resource", 0, resId)
        }
    }

    @Test
    fun `terminatingReason for all reasons returns a valid string resource`() {
        TerminatingReason.values().forEach { reason ->
            val resId = SessionReasonMapping.terminatingReason(reason)
            assertNotEquals("terminatingReason for $reason should return a valid resource", 0, resId)
        }
    }

    @Test
    fun `errorCode for all codes returns a valid string resource`() {
        SessionErrorCode.values().forEach { code ->
            val resId = SessionReasonMapping.errorCode(code)
            assertNotEquals("errorCode for $code should return a valid resource", 0, resId)
        }
    }

    @Test
    fun `errorCode for null returns a valid fallback resource`() {
        assertNotEquals(0, SessionReasonMapping.errorCode(null))
    }

    @Test
    fun `CHAIN_TORN maps to the humanized close reason resource`() {
        assertEquals(R.string.reason_close_chain_torn, SessionReasonMapping.closeReason(CloseReason.CHAIN_TORN))
        val (causeRes, actionRes) = SessionReasonMapping.closeReasonPair(CloseReason.CHAIN_TORN)
        assertEquals(R.string.reason_close_chain_torn, causeRes)
        assertEquals(R.string.reason_close_chain_torn_action, actionRes)
    }
}
