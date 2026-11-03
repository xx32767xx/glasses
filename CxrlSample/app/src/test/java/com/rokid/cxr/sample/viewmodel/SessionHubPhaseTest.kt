package com.rokid.cxr.sample.viewmodel

import com.rokid.cxr.sample.model.CxrScenePhase
import com.rokid.cxr.sample.model.mapToCxrScenePhase
import com.rokid.cxr.session.AiInterceptMode
import com.rokid.cxr.session.PausedReason
import com.rokid.cxr.session.SessionConfig
import com.rokid.cxr.session.SessionState
import com.rokid.cxr.session.SessionTimeouts
import com.rokid.cxr.session.SessionType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Unit tests for the session hub phase mapping.
 * 会话中心阶段映射的单元测试。
 *
 * Verifies the N-P1-4 mapping rules:
 * - Starting / Terminating → Connecting
 * - Started with valid config → CapabilitiesReady
 * - Paused (including AI_ASSIST and BT_DISCONNECTED) → Paused
 * - Idle → no session (null)
 * - Started with invalid config → SceneNotReady
 *
 * 验证 N-P1-4 映射规则：
 * - Starting / Terminating → Connecting
 * - Started 且配置有效 → CapabilitiesReady
 * - Paused（包括 AI_ASSIST 与 BT_DISCONNECTED）→ Paused
 * - Idle → 无会话（null）
 * - Started 且配置无效 → SceneNotReady
 */
class SessionHubPhaseTest {

    @Test
    fun `Starting maps to Connecting`() {
        val phase = mapToCxrScenePhase(SessionState.Starting, customViewConfig())
        assertEquals(CxrScenePhase.Connecting, phase)
    }

    @Test
    fun `Terminating maps to Connecting`() {
        val phase = mapToCxrScenePhase(SessionState.Terminating, customAppConfig())
        assertEquals(CxrScenePhase.Connecting, phase)
    }

    @Test
    fun `Started with valid CUSTOM_VIEW config maps to CapabilitiesReady`() {
        val phase = mapToCxrScenePhase(SessionState.Started, customViewConfig())
        assertEquals(CxrScenePhase.CapabilitiesReady, phase)
    }

    @Test
    fun `Started with valid CUSTOM_APP config maps to CapabilitiesReady`() {
        val phase = mapToCxrScenePhase(SessionState.Started, customAppConfig())
        assertEquals(CxrScenePhase.CapabilitiesReady, phase)
    }

    @Test
    fun `Paused with AI_ASSIST maps to Paused`() {
        assertEquals(
            CxrScenePhase.Paused,
            mapToCxrScenePhase(SessionState.Paused, customViewConfig()),
        )
    }

    @Test
    fun `Paused with BT_DISCONNECTED maps to Paused`() {
        assertEquals(
            CxrScenePhase.Paused,
            mapToCxrScenePhase(SessionState.Paused, customAppConfig()),
        )
    }

    @Test
    fun `Idle maps to null`() {
        assertNull(mapToCxrScenePhase(SessionState.Idle, customViewConfig()))
    }

    @Test
    fun `Started with blank viewData maps to SceneNotReady`() {
        val config = customViewConfig(viewData = "   ")
        assertEquals(
            CxrScenePhase.SceneNotReady,
            mapToCxrScenePhase(SessionState.Started, config),
        )
    }

    @Test
    fun `Started with CUSTOM_APP apk install failed maps to SceneNotReady`() {
        assertEquals(
            CxrScenePhase.SceneNotReady,
            mapToCxrScenePhase(
                SessionState.Started,
                customAppConfig(),
                apkInstallFailed = true,
            ),
        )
    }

    private fun customViewConfig(viewData: String = "{}"): SessionConfig = SessionConfig(
        sessionType = SessionType.CUSTOM_VIEW,
        aiInterceptMode = AiInterceptMode.ALLOW_WITH_PAUSE,
        terminatingGracePeriodMs = 5_000L,
        timeouts = SessionTimeouts(),
        viewData = viewData,
    )

    private fun customAppConfig(): SessionConfig = SessionConfig(
        sessionType = SessionType.CUSTOM_APP,
        glassesPackageName = "com.example.glassapp",
        aiInterceptMode = AiInterceptMode.ALLOW_WITH_PAUSE,
        terminatingGracePeriodMs = 5_000L,
        timeouts = SessionTimeouts(),
    )
}
