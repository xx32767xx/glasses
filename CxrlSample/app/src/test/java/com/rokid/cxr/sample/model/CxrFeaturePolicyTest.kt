package com.rokid.cxr.sample.model

import com.rokid.cxr.session.SessionType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the capability gate policy.
 * 能力门控策略的单元测试。
 *
 * Verifies the allowed feature sets and routing rules for CUSTOM_VIEW and CUSTOM_APP.
 * 验证 CUSTOM_VIEW 与 CUSTOM_APP 的允许能力集合及路由规则。
 */
class CxrFeaturePolicyTest {

    @Test
    fun `CUSTOM_VIEW allowed features are AUDIO PHOTO DEVICE_CONTROL without CUSTOM_CMD`() {
        val features = CxrFeaturePolicy.allowedFeatures(SessionType.CUSTOM_VIEW)
        assertEquals(
            listOf(CxrFeature.AUDIO, CxrFeature.PHOTO, CxrFeature.DEVICE_CONTROL),
            features,
        )
        assertFalse(features.contains(CxrFeature.CUSTOM_CMD))
    }

    @Test
    fun `CUSTOM_APP allowed features include all four capabilities`() {
        val features = CxrFeaturePolicy.allowedFeatures(SessionType.CUSTOM_APP)
        assertEquals(
            listOf(
                CxrFeature.AUDIO,
                CxrFeature.PHOTO,
                CxrFeature.DEVICE_CONTROL,
                CxrFeature.CUSTOM_CMD,
            ),
            features,
        )
    }

    @Test
    fun `isRouteAllowed matches allowed feature routes`() {
        assertTrue(
            CxrFeaturePolicy.isRouteAllowed(SceneRoutes.AUDIO, SessionType.CUSTOM_VIEW),
        )
        assertTrue(
            CxrFeaturePolicy.isRouteAllowed(SceneRoutes.PHOTO, SessionType.CUSTOM_VIEW),
        )
        assertTrue(
            CxrFeaturePolicy.isRouteAllowed(SceneRoutes.DEVICE_CONTROL, SessionType.CUSTOM_VIEW),
        )
        assertFalse(
            CxrFeaturePolicy.isRouteAllowed(SceneRoutes.CMD, SessionType.CUSTOM_VIEW),
        )
        assertTrue(
            CxrFeaturePolicy.isRouteAllowed(SceneRoutes.CMD, SessionType.CUSTOM_APP),
        )
    }
}
