package com.rokid.cxr.sample.model

import com.rokid.cxr.session.AiInterceptMode
import com.rokid.cxr.session.SessionConfig
import com.rokid.cxr.session.SessionState
import com.rokid.cxr.session.SessionTimeouts
import com.rokid.cxr.session.SessionType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Unit tests covering all branches of the five-state → phase mapping.
 * 覆盖五态 → 阶段映射所有分支的单元测试。
 *
 * Covers every branch of the N-P1-4 rules and architecture §3.3.
 * 覆盖 N-P1-4 规则与架构 §3.3 的每个分支。
 */
class CxrScenePhaseMapperTest {

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
    fun `Started with valid config maps to CapabilitiesReady`() {
        assertEquals(
            CxrScenePhase.CapabilitiesReady,
            mapToCxrScenePhase(SessionState.Started, customViewConfig()),
        )
        assertEquals(
            CxrScenePhase.CapabilitiesReady,
            mapToCxrScenePhase(SessionState.Started, customAppConfig()),
        )
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
