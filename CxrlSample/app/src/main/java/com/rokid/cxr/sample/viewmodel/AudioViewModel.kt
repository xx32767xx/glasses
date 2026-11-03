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
import com.rokid.cxr.session.IAudioCallback
import com.rokid.cxr.session.SessionResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Audio feature page ViewModel.
 * 音频功能页 ViewModel。
 *
 * - Does not hold a session reference; obtains it on demand via getter. Calls only, never closes.
 * - The session object is owned by the Hub; feature pages call only and do not close it.
 * - SDK calls and callbacks are synchronized to the event log through [SessionHubViewModel].
 * - Callbacks are registered when the page enters and unregistered when it exits (A12 pair).
 *
 * - 不持有会话引用；通过 getter 按需获取。只调用，不关闭。
 * - 会话对象归 Hub 所有；能力页面只调用，不关闭。
 * - SDK 调用与回调通过 [SessionHubViewModel] 同步到事件日志。
 * - 页面进入时注册回调，退出时注销（A12 成对）。
 */
class AudioViewModel(
    private val hub: SessionHubViewModel,
    appContext: Context,
) : ViewModel() {

    /** The session object is fetched on every access (getter) — feature pages do not hold a
     *  session reference, so nothing leaks after the session is closed. 每次访问都重新获取会话对象（getter）—— 能力页面不持有会话引用，会话关闭后不会泄漏。 */
    private val session: CxrSession? get() = hub.currentSession

    private val appContext = appContext.applicationContext

    /** A single audio event. 单个音频事件。 */
    data class AudioEvent(
        val timestampMillis: Long,
        val bytes: Int,
        val isStreaming: Boolean,
    )

    private val _audioEvents = MutableStateFlow<List<AudioEvent>>(emptyList())
    val audioEvents: StateFlow<List<AudioEvent>> = _audioEvents.asStateFlow()

    private val _isStreaming = MutableStateFlow(false)
    val isStreaming: StateFlow<Boolean> = _isStreaming.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private val audioCallback = object : IAudioCallback {
        override fun onAudioReceived(data: ByteArray) {
            val event = AudioEvent(
                timestampMillis = System.currentTimeMillis(),
                bytes = data.size,
                isStreaming = _isStreaming.value,
            )
            _audioEvents.value = listOf(event) + _audioEvents.value.take(MAX_EVENTS - 1)
            logCallback(
                sdkApi = "IAudioCallback.onAudioReceived",
                event = appContext.getString(R.string.log_audio_received, data.size),
            )
        }

        override fun onAudioError(errorCode: Int, errorMessage: String?) {
            _errorMessage.value = errorMessage ?: appContext.getString(R.string.audio_error_default, errorCode)
            logError(
                sdkApi = "IAudioCallback.onAudioError",
                event = appContext.getString(R.string.log_audio_callback_error),
                reason = errorMessage ?: "errorCode=$errorCode",
                errorCode = "$errorCode",
                suggestedAction = appContext.getString(R.string.log_suggestion_check_bluetooth_session),
            )
        }

        override fun onAudioStreamStateChanged(isStreaming: Boolean) {
            _isStreaming.value = isStreaming
            logCallback(
                sdkApi = "IAudioCallback.onAudioStreamStateChanged",
                event = appContext.getString(R.string.log_audio_stream_state_changed, isStreaming.toString()),
            )
        }
    }

    /** Register the audio callback; call when the page enters. 注册音频回调；页面进入时调用。 */
    fun registerAudioCallback() {
        session?.addAudioCallback(audioCallback)
    }

    /** Unregister the audio callback; call when the page exits. 注销音频回调；页面退出时调用。 */
    fun unregisterAudioCallback() {
        session?.removeAudioCallback(audioCallback)
    }

    /** Start the audio stream. 开始音频流。 */
    fun start() {
        val current = session ?: run {
            _errorMessage.value = appContext.getString(R.string.feature_error_no_session)
            return
        }
        logSdkCall("CxrSession.startAudioStream()")
        viewModelScope.launch {
            handleResult(current.startAudioStream(), "startAudioStream")
        }
    }

    /** Stop the audio stream. 停止音频流。 */
    fun stop() {
        val current = session ?: run {
            _errorMessage.value = appContext.getString(R.string.feature_error_no_session)
            return
        }
        logSdkCall("CxrSession.stopAudioStream()")
        viewModelScope.launch {
            handleResult(current.stopAudioStream(), "stopAudioStream")
        }
    }

    /** Clear the displayed audio events. 清空显示的音频事件。 */
    fun clearEvents() {
        _audioEvents.value = emptyList()
        _errorMessage.value = null
    }

    override fun onCleared() {
        super.onCleared()
        unregisterAudioCallback()
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
        private const val MAX_EVENTS = 50
    }
}
