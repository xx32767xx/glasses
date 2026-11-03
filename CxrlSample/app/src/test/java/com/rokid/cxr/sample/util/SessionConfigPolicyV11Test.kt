package com.rokid.cxr.sample.util

import com.rokid.cxr.sample.model.SessionConfigPolicy
import com.rokid.cxr.session.SessionType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for SessionConfigPolicy v1.1 configuration validation.
 * SessionConfigPolicy v1.1 配置校验的单元测试。
 */
class SessionConfigPolicyV11Test {

    private val getString: (Int) -> String = { _ -> "" }

    @Test
    fun `CUSTOM_APP missing glassesPackageName is rejected`() {
        val result = SessionConfigPolicy.validateConfig(
            getString = getString,
            type = SessionType.CUSTOM_APP,
            gracePeriodMs = 5_000L,
            viewData = null,
            packageName = "   ",
        )
        assertTrue(result is SessionConfigPolicy.ConfigValidation.Invalid)
        assertEquals(
            SessionConfigPolicy.ConfigValidation.Invalid.Code.CUSTOM_APP_MISSING_PACKAGE_NAME,
            (result as SessionConfigPolicy.ConfigValidation.Invalid).code,
        )
    }

    @Test
    fun `gracePeriod out of range is rejected`() {
        val tooLow = SessionConfigPolicy.validateConfig(
            getString = getString,
            type = SessionType.CUSTOM_VIEW,
            gracePeriodMs = 999L,
            viewData = "{}",
            packageName = null,
        )
        val tooHigh = SessionConfigPolicy.validateConfig(
            getString = getString,
            type = SessionType.CUSTOM_VIEW,
            gracePeriodMs = 30_001L,
            viewData = "{}",
            packageName = null,
        )
        assertEquals(
            SessionConfigPolicy.ConfigValidation.Invalid.Code.GRACE_PERIOD_OUT_OF_RANGE,
            (tooLow as SessionConfigPolicy.ConfigValidation.Invalid).code,
        )
        assertEquals(
            SessionConfigPolicy.ConfigValidation.Invalid.Code.GRACE_PERIOD_OUT_OF_RANGE,
            (tooHigh as SessionConfigPolicy.ConfigValidation.Invalid).code,
        )
    }

    @Test
    fun `CUSTOM_VIEW invalid viewData JSON is rejected`() {
        val result = SessionConfigPolicy.validateConfig(
            getString = getString,
            type = SessionType.CUSTOM_VIEW,
            gracePeriodMs = 5_000L,
            viewData = "not a json",
            packageName = null,
        )
        assertTrue(result is SessionConfigPolicy.ConfigValidation.Invalid)
        assertEquals(
            SessionConfigPolicy.ConfigValidation.Invalid.Code.CUSTOM_VIEW_INVALID_VIEW_DATA,
            (result as SessionConfigPolicy.ConfigValidation.Invalid).code,
        )
    }

    @Test
    fun `CUSTOM_VIEW blank viewData is rejected`() {
        val result = SessionConfigPolicy.validateConfig(
            getString = getString,
            type = SessionType.CUSTOM_VIEW,
            gracePeriodMs = 5_000L,
            viewData = "   ",
            packageName = null,
        )
        assertEquals(
            SessionConfigPolicy.ConfigValidation.Invalid.Code.CUSTOM_VIEW_BLANK_VIEW_DATA,
            (result as SessionConfigPolicy.ConfigValidation.Invalid).code,
        )
    }

    @Test
    fun `valid CUSTOM_VIEW config passes`() {
        val result = SessionConfigPolicy.validateConfig(
            getString = getString,
            type = SessionType.CUSTOM_VIEW,
            gracePeriodMs = 5_000L,
            viewData = "{\"type\":\"TextView\",\"id\":\"t1\"}",
            packageName = null,
        )
        assertEquals(SessionConfigPolicy.ConfigValidation.Valid, result)
    }

    @Test
    fun `valid CUSTOM_APP config passes`() {
        val result = SessionConfigPolicy.validateConfig(
            getString = getString,
            type = SessionType.CUSTOM_APP,
            gracePeriodMs = 5_000L,
            viewData = null,
            packageName = "com.example.glassapp",
        )
        assertEquals(SessionConfigPolicy.ConfigValidation.Valid, result)
    }
}
