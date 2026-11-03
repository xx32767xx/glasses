package com.rokid.cxr.sample.viewmodel

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.model.CONSTANT
import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogger
import com.rokid.cxr.sample.util.CapsFactory
import com.rokid.cxr.sample.util.SessionReasonMapping
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel
import com.rokid.cxr.session.CxrSession
import com.rokid.cxr.session.ICustomCmdSessionCallback
import com.rokid.cxr.session.SessionResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Custom command feature page ViewModel (only available for CUSTOM_APP).
 * 自定义命令功能页 ViewModel（仅 CUSTOM_APP 可用）。
 *
 * - Does not hold a session reference; obtains it on demand via getter. Calls only, never closes.
 * - The session object is owned by the Hub; feature pages call only and do not close it.
 * - channelKey defaults to [CONSTANT.DEFAULT_CHANNEL_KEY]; only responses matching the input
 *   channelKey are displayed (N-P1-6).
 * - payload is wrapped by [CapsFactory.buildPayload]; an empty stream string becomes [ByteArray](0).
 * - In-page note: cmd = the command name registered by the glasses-side app.
 *
 * - 不持有会话引用；通过 getter 按需获取。只调用，不关闭。
 * - 会话对象归 Hub 所有；能力页面只调用，不关闭。
 * - channelKey 默认 [CONSTANT.DEFAULT_CHANNEL_KEY]；只显示与输入 channelKey 匹配的响应（N-P1-6）。
 * - payload 由 [CapsFactory.buildPayload] 包装；空 stream 字符串转为 [ByteArray](0)。
 * - 页面说明：cmd = 眼镜端应用注册的命令名。
 */
class CustomCmdViewModel(
    private val hub: SessionHubViewModel,
    appContext: Context,
) : ViewModel() {

    /** The session object is fetched on every access (getter) — feature pages do not hold a
     *  session reference, so nothing leaks after the session is closed. 每次访问都重新获取会话对象（getter）—— 能力页面不持有会话引用，会话关闭后不会泄漏。 */
    private val session: CxrSession? get() = hub.currentSession

    private val appContext = appContext.applicationContext

    /** A single custom command response. 单个自定义命令响应。 */
    data class CmdResponse(
        val timestampMillis: Long,
        val channelKey: String,
        val dataSize: Int,
        val preview: String,
    )

    private val _cmd = MutableStateFlow("rk_custom_client")
    val cmd: StateFlow<String> = _cmd.asStateFlow()

    private val _channelKey = MutableStateFlow(CONSTANT.DEFAULT_CHANNEL_KEY)
    val channelKey: StateFlow<String> = _channelKey.asStateFlow()

    private val _payload = MutableStateFlow("hello")
    val payload: StateFlow<String> = _payload.asStateFlow()

    private val _stream = MutableStateFlow("")
    val stream: StateFlow<String> = _stream.asStateFlow()

    private val _responses = MutableStateFlow<List<CmdResponse>>(emptyList())
    val responses: StateFlow<List<CmdResponse>> = _responses.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private val customCmdCallback = object : ICustomCmdSessionCallback {
        override fun onCustomCmdResult(channelKey: String, data: ByteArray?) {
            if (channelKey != _channelKey.value) {
                // N-P1-6: Only display responses matching the input channelKey. N-P1-6：只显示与输入 channelKey 匹配的响应。
                return
            }
            val preview = data?.let { bytes ->
                appContext.getString(
                    R.string.custom_cmd_response_preview,
                    bytes.size,
                    bytes.take(64).joinToString(", ") { "0x%02X".format(it) },
                )
            } ?: appContext.getString(R.string.custom_cmd_response_empty)
            val response = CmdResponse(
                timestampMillis = System.currentTimeMillis(),
                channelKey = channelKey,
                dataSize = data?.size ?: 0,
                preview = preview,
            )
            _responses.value = listOf(response) + _responses.value.take(MAX_RESPONSES - 1)
            logCallback(
                sdkApi = "ICustomCmdSessionCallback.onCustomCmdResult",
                event = appContext.getString(
                    R.string.log_custom_cmd_result,
                    channelKey,
                    data?.size ?: 0,
                ),
            )
        }
    }

    /** Register the custom command callback; call when the page enters. 注册自定义命令回调；页面进入时调用。 */
    fun registerCustomCmdCallback() {
        session?.addCustomCmdCallback(customCmdCallback)
    }

    /** Unregister the custom command callback; call when the page exits. 注销自定义命令回调；页面退出时调用。 */
    fun unregisterCustomCmdCallback() {
        session?.removeCustomCmdCallback(customCmdCallback)
    }

    fun setCmd(value: String) {
        _cmd.value = value
    }

    fun setChannelKey(value: String) {
        _channelKey.value = value
    }

    fun setPayload(value: String) {
        _payload.value = value
    }

    fun setStream(value: String) {
        _stream.value = value
    }

    /** Send a custom command. 发送自定义命令。 */
    fun send() {
        val current = session ?: run {
            _errorMessage.value = appContext.getString(R.string.feature_error_no_session)
            return
        }
        val cmdValue = _cmd.value
        val payloadValue = _payload.value
        val streamBytes = _stream.value.encodeToByteArray()
        logSdkCall("CxrSession.sendCustomCmd($cmdValue, Caps, byte[${streamBytes.size}])")
        viewModelScope.launch {
            val result = current.sendCustomCmd(
                cmdValue,
                CapsFactory.buildPayload(payloadValue),
                streamBytes,
            )
            if (result.isSuccess) {
                logSdkResult("sendCustomCmd", true)
            } else {
                val reason = appContext.getString(SessionReasonMapping.errorCode(result.code))
                _errorMessage.value = reason
                logError(
                    sdkApi = "CxrSession.sendCustomCmd",
                    event = appContext.getString(R.string.log_sdk_api_failure, "sendCustomCmd"),
                    reason = reason,
                    errorCode = result.code?.name,
                    suggestedAction = appContext.getString(R.string.log_suggestion_check_started_custom_app),
                )
            }
        }
    }

    fun clearResponses() {
        _responses.value = emptyList()
        _errorMessage.value = null
    }

    override fun onCleared() {
        super.onCleared()
        unregisterCustomCmdCallback()
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

    private fun logCallback(sdkApi: String, event: String) {
        hub.appendEventLog(
            EventLogger.create(
                category = EventCategory.CAPABILITY,
                sdkApi = sdkApi,
                stateBefore = currentStateName(),
                stateAfter = currentStateName(),
                event = event,
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

    companion object {
        private const val MAX_RESPONSES = 20
    }
}
