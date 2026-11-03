package com.rokid.cxr.sample.viewmodel

import android.app.Application
import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.model.CustomViewJsonValidator
import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogger
import com.rokid.cxr.sample.model.selfView.UpdateViewJson
import com.rokid.cxr.sample.model.selfView.add
import com.rokid.cxr.sample.util.SessionReasonMapping
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel
import com.rokid.cxr.session.CxrSession
import com.rokid.cxr.session.SessionResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Custom View feature page ViewModel (only for CUSTOM_VIEW).
 * 自定义视图功能页 ViewModel（仅 CUSTOM_VIEW 可用）。
 *
 * - Does not hold a session reference; obtains it on demand via getter. Calls only, never closes.
 * - The session object is owned by the Hub; feature pages call only and do not close it.
 * - Quick example: increment a counter and update the title_text label.
 * - Free editing: manually enter incremental update JSON; after validation by
 *   [CustomViewJsonValidator], call [CxrSession.customViewUpdate].
 * - CustomView has no standalone callback interface, so no business callback registration is needed.
 *
 * - 不持有会话引用；通过 getter 按需获取。只调用，不关闭。
 * - 会话对象归 Hub 所有；能力页面只调用，不关闭。
 * - 快速示例：递增计数器并更新 title_text 标签。
 * - 自由编辑：手动输入增量更新 JSON；经 [CustomViewJsonValidator] 校验后调用 [CxrSession.customViewUpdate]。
 * - CustomView 没有独立回调接口，因此无需注册业务回调。
 */
class CustomViewViewModel(
    private val hub: SessionHubViewModel,
    appContext: Context,
) : ViewModel() {

    /** The session object is fetched on every access (getter) — feature pages do not hold a
     *  session reference, so nothing leaks after the session is closed. 每次访问都重新获取会话对象（getter）—— 能力页面不持有会话引用，会话关闭后不会泄漏。 */
    private val session: CxrSession? get() = hub.currentSession

    private val appContext = appContext.applicationContext

    private val _updateJson = MutableStateFlow("")
    val updateJson: StateFlow<String> = _updateJson.asStateFlow()

    private val _previewJson = MutableStateFlow("")
    val previewJson: StateFlow<String> = _previewJson.asStateFlow()

    private val _quickCounter = MutableStateFlow(0)
    val quickCounter: StateFlow<Int> = _quickCounter.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private val _lastSentResult = MutableStateFlow<String?>(null)
    val lastSentResult: StateFlow<String?> = _lastSentResult.asStateFlow()

    fun setUpdateJson(value: String) {
        _updateJson.value = value
    }

    /** Generate the quick-example JSON and update the preview area at the same time. 生成快速示例 JSON，并同步更新预览区。 */
    fun generateQuickExample() {
        val counter = _quickCounter.value + 1
        _quickCounter.value = counter
        val json = UpdateViewJson()
            .add("title_text", mapOf("text" to "Hello CXR-L #$counter"))
            .toJson()
        _updateJson.value = json
        _previewJson.value = json
        _errorMessage.value = null
    }

    /** Validate the current editor content and call the SDK. 校验当前编辑器内容并调用 SDK。 */
    fun update() {
        val current = session ?: run {
            _errorMessage.value = appContext.getString(R.string.feature_error_no_session)
            return
        }
        val json = _updateJson.value
        val validation = CustomViewJsonValidator.validateUpdateJson(appContext::getString, json)
        if (validation.isFailure) {
            _errorMessage.value = validation.exceptionOrNull()?.message
                ?: appContext.getString(R.string.custom_view_last_sent_failed, "")
            return
        }
        _errorMessage.value = null
        _lastSentResult.value = null
        logSdkCall("CxrSession.customViewUpdate(json)")
        viewModelScope.launch {
            handleResult(current.customViewUpdate(json), "customViewUpdate(json)")
        }
    }

    /** Validate and update the preview area only, without calling the SDK (demo without a session). 仅校验并更新预览区，不调用 SDK（无会话演示）。 */
    fun preview() {
        val json = _updateJson.value
        val validation = CustomViewJsonValidator.validateUpdateJson(appContext::getString, json)
        if (validation.isFailure) {
            _errorMessage.value = validation.exceptionOrNull()?.message
                ?: appContext.getString(R.string.custom_view_last_sent_failed, "")
            return
        }
        _previewJson.value = json
        _errorMessage.value = null
    }

    fun clear() {
        _updateJson.value = ""
        _previewJson.value = ""
        _errorMessage.value = null
        _lastSentResult.value = null
    }

    private suspend fun <T> handleResult(
        result: SessionResult<T>,
        sdkApi: String,
    ) {
        if (result.isSuccess) {
            _lastSentResult.value = appContext.getString(R.string.custom_view_last_sent_success)
            logSdkResult(sdkApi, true)
        } else {
            val reason = appContext.getString(SessionReasonMapping.errorCode(result.code))
            _errorMessage.value = reason
            _lastSentResult.value = appContext.getString(R.string.custom_view_last_sent_failed, reason)
            logError(
                sdkApi = "CxrSession.$sdkApi",
                event = appContext.getString(R.string.log_sdk_api_failure, sdkApi),
                reason = reason,
                errorCode = result.code?.name,
                suggestedAction = appContext.getString(R.string.log_suggestion_check_started_custom_view),
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
