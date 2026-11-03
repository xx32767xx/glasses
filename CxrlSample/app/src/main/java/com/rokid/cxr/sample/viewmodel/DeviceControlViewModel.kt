package com.rokid.cxr.sample.viewmodel

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogger
import com.rokid.cxr.sample.util.SessionReasonMapping
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel
import com.rokid.cxr.session.CxrSession
import com.rokid.cxr.session.GlassesInfo
import com.rokid.cxr.session.SessionResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Device control feature page ViewModel.
 * 设备控制功能页 ViewModel。
 *
 * - Does not hold a session reference; obtains it on demand via getter. Calls only, never closes.
 * - The session object is owned by the Hub; feature pages call only and do not close it.
 * - Brightness/volume slider range is 0..100 (A7).
 * - Calls [CxrSession.setGlassBrightness] / [CxrSession.setGlassVolume].
 * - Obtains device info through [CxrSession.queryGlassesInfo].
 *
 * - 不持有会话引用；通过 getter 按需获取。只调用，不关闭。
 * - 会话对象归 Hub 所有；能力页面只调用，不关闭。
 * - 亮度/音量滑块范围为 0..100（A7）。
 * - 调用 [CxrSession.setGlassBrightness] / [CxrSession.setGlassVolume]。
 * - 通过 [CxrSession.queryGlassesInfo] 获取设备信息。
 */
class DeviceControlViewModel(
    private val hub: SessionHubViewModel,
    appContext: Context,
) : ViewModel() {

    /** The session object is fetched on every access (getter) — feature pages do not hold a
     *  session reference, so nothing leaks after the session is closed. 每次访问都重新获取会话对象（getter）—— 能力页面不持有会话引用，会话关闭后不会泄漏。 */
    private val session: CxrSession? get() = hub.currentSession

    private val appContext = appContext.applicationContext

    private val _brightness = MutableStateFlow(50)
    val brightness: StateFlow<Int> = _brightness.asStateFlow()

    private val _volume = MutableStateFlow(50)
    val volume: StateFlow<Int> = _volume.asStateFlow()

    private val _glassesInfo = MutableStateFlow<GlassesInfo?>(null)
    val glassesInfo: StateFlow<GlassesInfo?> = _glassesInfo.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    fun setBrightness(level: Int) {
        _brightness.value = level.coerceIn(0, 100)
    }

    fun setVolume(level: Int) {
        _volume.value = level.coerceIn(0, 100)
    }

    /** Apply the brightness setting. 应用亮度设置。 */
    fun applyBrightness() {
        val current = session ?: run {
            _errorMessage.value = appContext.getString(R.string.feature_error_no_session)
            return
        }
        val level = _brightness.value
        logSdkCall("CxrSession.setGlassBrightness($level)")
        viewModelScope.launch {
            handleResult(current.setGlassBrightness(level), "setGlassBrightness($level)")
        }
    }

    /** Apply the volume setting. 应用音量设置。 */
    fun applyVolume() {
        val current = session ?: run {
            _errorMessage.value = appContext.getString(R.string.feature_error_no_session)
            return
        }
        val level = _volume.value
        logSdkCall("CxrSession.setGlassVolume($level)")
        viewModelScope.launch {
            handleResult(current.setGlassVolume(level), "setGlassVolume($level)")
        }
    }

    /** Refresh glasses information. 刷新眼镜信息。 */
    fun refreshInfo() {
        val current = session ?: run {
            _errorMessage.value = appContext.getString(R.string.feature_error_no_session)
            return
        }
        logSdkCall("CxrSession.queryGlassesInfo()")
        viewModelScope.launch {
            val result = current.queryGlassesInfo()
            if (result.isSuccess) {
                _glassesInfo.value = result.data
                logSdkResult("queryGlassesInfo()", true)
            } else {
                val reason = appContext.getString(SessionReasonMapping.errorCode(result.code))
                _errorMessage.value = reason
                logError(
                    sdkApi = "CxrSession.queryGlassesInfo()",
                    event = appContext.getString(R.string.log_sdk_api_failure, "queryGlassesInfo()"),
                    reason = reason,
                    errorCode = result.code?.name,
                    suggestedAction = appContext.getString(R.string.log_suggestion_check_started_state),
                )
            }
        }
    }

    fun clearError() {
        _errorMessage.value = null
    }

    private suspend fun <T> handleResult(
        result: SessionResult<T>,
        sdkApi: String,
    ) {
        if (result.isSuccess) {
            logSdkResult(sdkApi, true)
        } else {
            val reason = appContext.getString(SessionReasonMapping.errorCode(result.code))
            _errorMessage.value = reason
            logError(
                sdkApi = "CxrSession.$sdkApi",
                event = appContext.getString(R.string.log_sdk_api_failure, sdkApi),
                reason = reason,
                errorCode = result.code?.name,
                suggestedAction = appContext.getString(R.string.log_suggestion_check_started_state),
            )
        }
    }

    private fun currentStateName(): String = hub.sessionState.value.name

    private fun logSdkCall(sdkApi: String) {
        hub.appendEventLog(
            EventLogger.create(
                category = EventCategory.SDK_CALL,
                sdkApi = sdkApi,
                stateBefore = currentStateName(),
                stateAfter = currentStateName(),
                event = appContext.getString(R.string.log_call_sdk_api, sdkApi),
            ),
        )
    }

    private fun logSdkResult(sdkApi: String, success: Boolean) {
        hub.appendEventLog(
            EventLogger.create(
                category = EventCategory.SDK_CALL,
                sdkApi = sdkApi,
                stateBefore = currentStateName(),
                stateAfter = currentStateName(),
                event = if (success) {
                    appContext.getString(R.string.log_sdk_api_success, sdkApi)
                } else {
                    appContext.getString(R.string.log_sdk_api_failure, sdkApi)
                },
            ),
        )
    }

    private fun logError(
        sdkApi: String,
        event: String,
        reason: String? = null,
        errorCode: String? = null,
        suggestedAction: String? = null,
    ) {
        hub.appendEventLog(
            EventLogger.create(
                category = EventCategory.ERROR,
                sdkApi = sdkApi,
                stateBefore = currentStateName(),
                stateAfter = currentStateName(),
                event = event,
                reason = reason,
                errorCode = errorCode,
                suggestedAction = suggestedAction,
            ),
        )
    }
}
