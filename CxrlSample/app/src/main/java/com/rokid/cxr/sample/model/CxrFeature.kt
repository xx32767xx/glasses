package com.rokid.cxr.sample.model

import androidx.annotation.StringRes
import com.rokid.cxr.sample.R

/**
 * Sample-layer capability enum.
 *
 * @param labelRes UI label for the capability.
 * @param route Corresponding navigation route, see [SceneRoutes].
 */
enum class CxrFeature(@StringRes val labelRes: Int, val route: String) {
    AUDIO(R.string.feature_audio_title, SceneRoutes.AUDIO),
    PHOTO(R.string.feature_photo_title, SceneRoutes.PHOTO),
    DEVICE_CONTROL(R.string.feature_device_control_title, SceneRoutes.DEVICE_CONTROL),
    CUSTOM_CMD(R.string.feature_custom_cmd_title, SceneRoutes.CMD),
    CUSTOM_VIEW(R.string.feature_custom_view_title, SceneRoutes.CUSTOM_VIEW),
}
