package com.rokid.cxr.sample.model

import com.rokid.cxr.session.SessionType

/**
 * Capability access policy: decides which [CxrFeature]s are available for the current session
 * based on [SessionType].
 *
 * Rules:
 * - CUSTOM_VIEW → AUDIO, PHOTO, DEVICE_CONTROL
 * - CUSTOM_APP  → AUDIO, PHOTO, DEVICE_CONTROL, CUSTOM_CMD
 */
object CxrFeaturePolicy {

    fun allowedFeatures(sessionType: SessionType): List<CxrFeature> = when (sessionType) {
        SessionType.CUSTOM_VIEW -> listOf(
            CxrFeature.AUDIO,
            CxrFeature.PHOTO,
            CxrFeature.DEVICE_CONTROL,
        )
        SessionType.CUSTOM_APP -> listOf(
            CxrFeature.AUDIO,
            CxrFeature.PHOTO,
            CxrFeature.DEVICE_CONTROL,
            CxrFeature.CUSTOM_CMD,
        )
    }

    /**
     * Returns whether [feature] is allowed by [sessionType].
     */
    fun isFeatureAllowed(feature: CxrFeature, sessionType: SessionType): Boolean =
        feature in allowedFeatures(sessionType)

    /**
     * Returns whether [route] is allowed by [sessionType].
     */
    fun isRouteAllowed(route: String, sessionType: SessionType): Boolean =
        allowedFeatures(sessionType).any { it.route == route }
}
