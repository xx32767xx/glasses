package com.rokid.cxr.sample.util

import androidx.annotation.StringRes
import com.rokid.cxr.sample.R
import com.rokid.cxr.session.CloseReason
import com.rokid.cxr.session.PausedReason
import com.rokid.cxr.session.SessionErrorCode
import com.rokid.cxr.session.TerminatingReason

/**
 * SDK reason/error enum → user-facing string resource mapping layer.
 * SDK reason/error 枚举 → 面向用户的字符串资源映射层。
 *
 * Rule sources: N-P1-8 (event log mapping), N-K1 (CHAIN_TORN humanization), N-K6 (PausedReason branch text).
 * 规则来源：N-P1-8（事件日志映射）、N-K1（CHAIN_TORN 人性化）、N-K6（PausedReason 分支文案）。
 *
 * UI and EventLogger both output localized text through this layer; do not print enum names directly.
 * UI 与 EventLogger 都通过这一层输出本地化文案，禁止直接打印枚举名。
 */
object SessionReasonMapping {

    /** PausedReason → string resource (already includes recovery hint). PausedReason → 字符串资源（已包含恢复提示）。 */
    @StringRes
    fun pausedReason(reason: PausedReason): Int = when (reason) {
        PausedReason.BT_DISCONNECTED -> R.string.reason_paused_bt_disconnected
        PausedReason.AI_ASSIST -> R.string.reason_paused_ai_assist
    }

    /**
     * Maps CloseReason to (cause resource, action resource).
     * 将 CloseReason 映射为（原因资源，下一步操作建议资源）。
     */
    fun closeReasonPair(reason: CloseReason): Pair<Int, Int> = when (reason) {
        CloseReason.USER_CLOSED ->
            R.string.reason_close_user_closed to R.string.reason_close_user_closed_action
        CloseReason.CONNECT_FAILED ->
            R.string.reason_close_connect_failed to R.string.reason_close_connect_failed_action
        CloseReason.GLASSES_EXIT ->
            R.string.reason_close_glasses_exit to R.string.reason_close_glasses_exit_action
        CloseReason.LINK_LOST ->
            R.string.reason_close_link_lost to R.string.reason_close_link_lost_action
        CloseReason.CHAIN_TORN ->
            R.string.reason_close_chain_torn to R.string.reason_close_chain_torn_action
        CloseReason.FATAL_ERROR ->
            R.string.reason_close_fatal_error to R.string.reason_close_fatal_error_action
    }

    /** CloseReason single human-readable text (cause + action). CloseReason 单一可读文本（原因 + 操作建议）。 */
    @StringRes
    fun closeReason(reason: CloseReason): Int = when (reason) {
        CloseReason.USER_CLOSED -> R.string.reason_close_user_closed
        CloseReason.CONNECT_FAILED -> R.string.reason_close_connect_failed
        CloseReason.GLASSES_EXIT -> R.string.reason_close_glasses_exit
        CloseReason.LINK_LOST -> R.string.reason_close_link_lost
        CloseReason.CHAIN_TORN -> R.string.reason_close_chain_torn
        CloseReason.FATAL_ERROR -> R.string.reason_close_fatal_error
    }

    /** Maps TerminatingReason to a string resource. 将 TerminatingReason 映射为字符串资源。 */
    @StringRes
    fun terminatingReason(reason: TerminatingReason): Int = when (reason) {
        TerminatingReason.GLASSES_APP_EXIT -> R.string.reason_terminating_glasses_app_exit
        TerminatingReason.GLASSES_APP_CRASH -> R.string.reason_terminating_glasses_app_crash
        TerminatingReason.GLASSES_RESOURCE_RECLAIMED -> R.string.reason_terminating_glasses_resource_reclaimed
        TerminatingReason.LINK_CHAIN_TORN -> R.string.reason_terminating_link_chain_torn
        TerminatingReason.OTHER -> R.string.reason_terminating_other
    }

    /** Maps SessionErrorCode to a string resource. 将 SessionErrorCode 映射为字符串资源。 */
    @StringRes
    fun errorCode(code: SessionErrorCode?): Int = when (code) {
        SessionErrorCode.OK -> R.string.reason_error_ok
        SessionErrorCode.NOT_AUTHENTICATED -> R.string.reason_error_not_authenticated
        SessionErrorCode.TOKEN_EXPIRED -> R.string.reason_error_token_expired
        SessionErrorCode.ROKID_APP_NOT_INSTALLED -> R.string.reason_error_app_not_installed
        SessionErrorCode.ROKID_APP_VERSION_LOW -> R.string.reason_error_app_version_low
        SessionErrorCode.LINK_NOT_READY -> R.string.reason_error_link_not_ready
        SessionErrorCode.BT_NOT_CONNECTED -> R.string.reason_error_bt_not_connected
        SessionErrorCode.LINK_LOST -> R.string.reason_error_link_lost
        SessionErrorCode.LINK_TIMEOUT -> R.string.reason_error_link_timeout
        SessionErrorCode.SESSION_NOT_STARTED -> R.string.reason_error_session_not_started
        SessionErrorCode.SESSION_TERMINATING -> R.string.reason_error_session_terminating
        SessionErrorCode.SESSION_ALREADY_EXISTS -> R.string.reason_error_session_already_exists
        SessionErrorCode.CONNECT_FAILED -> R.string.reason_error_connect_failed
        SessionErrorCode.SCENE_OPEN_FAILED -> R.string.reason_error_scene_open_failed
        SessionErrorCode.RESOURCE_PREPARE_FAILED -> R.string.reason_error_resource_prepare_failed
        SessionErrorCode.SESSION_PAUSED -> R.string.reason_error_session_paused
        SessionErrorCode.DATA_NOT_READY -> R.string.reason_error_data_not_ready
        SessionErrorCode.INVALID_ARGUMENT -> R.string.reason_error_invalid_argument
        SessionErrorCode.OPERATION_IN_PROGRESS -> R.string.reason_error_operation_in_progress
        SessionErrorCode.OPERATION_CANCELLED -> R.string.reason_error_operation_cancelled
        SessionErrorCode.GLASSES_SIGNAL_TIMEOUT -> R.string.reason_error_glasses_signal_timeout
        SessionErrorCode.GLASSES_APP_NOT_FOUND -> R.string.reason_error_glasses_app_not_found
        SessionErrorCode.GLASSES_APP_INSTALL_FAILED -> R.string.reason_error_glasses_app_install_failed
        SessionErrorCode.GLASSES_MEMORY_PRESSURE -> R.string.reason_error_glasses_memory_pressure
        SessionErrorCode.GLASSES_CAMERA_ERROR -> R.string.reason_error_glasses_camera_error
        SessionErrorCode.GLASSES_AUDIO_ERROR -> R.string.reason_error_glasses_audio_error
        SessionErrorCode.INTERNAL_ERROR -> R.string.reason_error_internal_error
        SessionErrorCode.UNKNOWN -> R.string.reason_error_unknown
        null -> R.string.reason_error_unknown
        else -> R.string.reason_error_fallback
    }
}
