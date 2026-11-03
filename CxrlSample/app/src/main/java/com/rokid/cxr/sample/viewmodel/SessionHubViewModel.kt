package com.rokid.cxr.sample.viewmodel

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.model.CxrScenePhase
import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogItem
import com.rokid.cxr.sample.model.EventLogger
import com.rokid.cxr.sample.model.SessionLaunchRequest
import com.rokid.cxr.sample.model.mapToCxrScenePhase
import com.rokid.cxr.sample.navigation.CxrSceneNavigation
import com.rokid.cxr.sample.util.SessionReasonMapping
import com.rokid.cxr.session.CloseReason
import com.rokid.cxr.session.CxrSession
import com.rokid.cxr.session.CxrSessionManager
import com.rokid.cxr.session.GlassesInfo
import com.rokid.cxr.session.IAudioCallback
import com.rokid.cxr.session.ICustomCmdSessionCallback
import com.rokid.cxr.session.IGlassesEventListener
import com.rokid.cxr.session.IImageCallback
import com.rokid.cxr.session.ISessionLifecycleCbk
import com.rokid.cxr.session.PausedReason
import com.rokid.cxr.session.SessionConfig
import com.rokid.cxr.session.SessionErrorCode
import com.rokid.cxr.session.SessionState
import com.rokid.cxr.session.TerminatingReason
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Session hub ViewModel: receives all 5 kinds of SDK callbacks in one place, derives the scene
 * phase and capability gating, and manages the event log export.
 * 会话中心 ViewModel：在一处接收全部 5 类 SDK 回调，推导场景阶段与能力门控，并管理事件日志导出。
 *
 * Session lifecycle in three stages:
 * 1. Create: the Hub reads parameters from [SessionLaunchRequest] → [CxrSessionManager.create] →
 *    register callbacks → [CxrSession.connect].
 * 2. Use: capability pages read-only call APIs through the shared VM's [currentSession]; they do
 *    not close the session.
 * 3. Release: [onCleared] calls [CxrSession.close]; who creates must destroy.
 *
 * 会话生命周期分三个阶段：
 * 1. 创建：Hub 从 [SessionLaunchRequest] 读取参数 → [CxrSessionManager.create] → 注册回调 → [CxrSession.connect]。
 * 2. 使用：能力页面只通过共享 ViewModel 的 [currentSession] 只读调用 API，不关闭会话。
 * 3. 释放：[onCleared] 调用 [CxrSession.close]；谁创建谁销毁。
 */
class SessionHubViewModel(application: Application) : AndroidViewModel(application),
    ISessionLifecycleCbk, IAudioCallback, IImageCallback, ICustomCmdSessionCallback,
    IGlassesEventListener {

    private val manager: CxrSessionManager =
        CxrSessionManager.getInstance(application.applicationContext)

    private val appContext get() = getApplication<Application>().applicationContext

    // ---------- SDK five states and reasons SDK 五态与原因 ----------

    private val _sessionState = MutableStateFlow(SessionState.Idle)
    val sessionState: StateFlow<SessionState> = _sessionState.asStateFlow()

    private val _pausedReason = MutableStateFlow<PausedReason?>(null)
    val pausedReason: StateFlow<PausedReason?> = _pausedReason.asStateFlow()

    private val _closeReason = MutableStateFlow<CloseReason?>(null)
    val closeReason: StateFlow<CloseReason?> = _closeReason.asStateFlow()

    private val _terminatingReason = MutableStateFlow<TerminatingReason?>(null)
    val terminatingReason: StateFlow<TerminatingReason?> = _terminatingReason.asStateFlow()

    // ---------- Config and phase 配置与阶段 ----------

    private val _sessionConfig = MutableStateFlow<SessionConfig?>(null)
    val sessionConfig: StateFlow<SessionConfig?> = _sessionConfig.asStateFlow()

    /** The active session held by the Hub; capability pages are read-only and must not close it. Hub 持有的活动会话；能力页面只读，禁止关闭。 */
    private var session: CxrSession? = null
    val currentSession: CxrSession? get() = session

    /** CUSTOM_APP scenario: whether the APK installation failed (used for SceneNotReady detection). CUSTOM_APP 场景：APK 安装是否失败（用于 SceneNotReady 检测）。 */
    private val _apkInstallFailed = MutableStateFlow(false)

    private val _btConnected = MutableStateFlow(false)
    val btConnected: StateFlow<Boolean> = _btConnected.asStateFlow()

/**
     * Scene phase: derived by combining the SDK five states + config + Bluetooth state.
     * 场景阶段：由 SDK 五态 + 配置 + 蓝牙状态组合推导。
     *
     * Note: per N-P1-4, any Paused state (including BT) maps to [CxrScenePhase.Paused];
     * [CxrScenePhase.SceneNotReady] is only used when Started but the config is abnormal.
     *
     * 注意：根据 N-P1-4，任何 Paused 状态（包括蓝牙）都映射为 [CxrScenePhase.Paused]；
     * [CxrScenePhase.SceneNotReady] 只在 Started 但配置异常时使用。
     */
    val scenePhase: StateFlow<CxrScenePhase?> = combine(
        _sessionState,
        _sessionConfig,
        _apkInstallFailed,
        _btConnected,
    ) { state, config, apkFailed, _ ->
        // btConnected is already part of the aggregation; the SDK five states already express
        // Bluetooth disconnection (Paused/BT_DISCONNECTED).
        // btConnected 已是聚合的一部分；SDK 五态已表达蓝牙断开（Paused/BT_DISCONNECTED）。
        mapToCxrScenePhase(state, config, apkFailed)
    }.stateIn(
        viewModelScope,
        SharingStarted.WhileSubscribed(5_000),
        mapToCxrScenePhase(_sessionState.value, _sessionConfig.value, _apkInstallFailed.value),
    )

    /** Whether capability APIs are available: enabled only when [CxrScenePhase.CapabilitiesReady]. 能力 API 是否可用：仅在 [CxrScenePhase.CapabilitiesReady] 时启用。 */
    val capabilitiesEnabled: StateFlow<Boolean> = scenePhase
        .map { it == CxrScenePhase.CapabilitiesReady }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

    // ---------- Event log 事件日志 ----------

    private val _eventLog = MutableStateFlow<List<EventLogItem>>(emptyList())
    val eventLog: StateFlow<List<EventLogItem>> = _eventLog.asStateFlow()

    // ---------- Glasses events (A15: callbacks fire in any state, including Idle) 眼镜事件（A15：回调在任意状态都会触发，包括 Idle） ----------

    private val _glassesEvents = MutableStateFlow<List<String>>(emptyList())
    val glassesEvents: StateFlow<List<String>> = _glassesEvents.asStateFlow()

    // ---------- Callback implementation (the Hub directly implements SDK interfaces and delegates to existing callback objects) 回调实现（Hub 直接实现 SDK 接口并委托给现有回调对象） ----------

    private val lifecycleCallback = object : ISessionLifecycleCbk {
        override fun onSessionStarted() {
            _pausedReason.value = null
            _terminatingReason.value = null
            logLifecycle(
                sdkApi = "ISessionLifecycleCbk.onSessionStarted",
                stateBefore = _sessionState.value.name,
                stateAfter = _sessionState.value.name,
                event = appContext.getString(R.string.log_session_started),
                suggestedAction = appContext.getString(R.string.log_session_started_suggestion),
            )
        }

        override fun onSessionPaused(reason: PausedReason) {
            _pausedReason.value = reason
            logLifecycle(
                sdkApi = "ISessionLifecycleCbk.onSessionPaused",
                stateBefore = _sessionState.value.name,
                stateAfter = SessionState.Paused.name,
                event = appContext.getString(R.string.log_session_paused),
                reason = appContext.getString(SessionReasonMapping.pausedReason(reason)),
                suggestedAction = appContext.getString(R.string.log_session_paused_suggestion),
            )
        }

        override fun onSessionResumed() {
            _pausedReason.value = null
            logLifecycle(
                sdkApi = "ISessionLifecycleCbk.onSessionResumed",
                stateBefore = _sessionState.value.name,
                stateAfter = _sessionState.value.name,
                event = appContext.getString(R.string.log_session_resumed),
                suggestedAction = appContext.getString(R.string.log_session_resumed_suggestion),
            )
        }

        override fun onSessionTerminating(reason: TerminatingReason, gracePeriodMs: Long) {
            _terminatingReason.value = reason
            logLifecycle(
                sdkApi = "ISessionLifecycleCbk.onSessionTerminating",
                stateBefore = _sessionState.value.name,
                stateAfter = SessionState.Terminating.name,
                event = appContext.getString(R.string.log_session_terminating, gracePeriodMs),
                reason = appContext.getString(SessionReasonMapping.terminatingReason(reason)),
                suggestedAction = appContext.getString(R.string.log_session_terminating_suggestion),
            )
        }

        override fun onSessionClosed(reason: CloseReason) {
            val (reasonRes, actionRes) = SessionReasonMapping.closeReasonPair(reason)
            _closeReason.value = reason
            _pausedReason.value = null
            logLifecycle(
                sdkApi = "ISessionLifecycleCbk.onSessionClosed",
                stateBefore = _sessionState.value.name,
                stateAfter = SessionState.Idle.name,
                event = appContext.getString(R.string.log_session_closed),
                reason = appContext.getString(reasonRes),
                suggestedAction = appContext.getString(actionRes),
            )
            CxrSceneNavigation.requestToSetup()
        }

        override fun onConnectResult(success: Boolean, errorCode: SessionErrorCode?) {
            if (success) {
                logLifecycle(
                    sdkApi = "ISessionLifecycleCbk.onConnectResult",
                    stateBefore = _sessionState.value.name,
                    stateAfter = _sessionState.value.name,
                    event = appContext.getString(R.string.log_connect_success),
                )
            } else {
                logError(
                    sdkApi = "ISessionLifecycleCbk.onConnectResult",
                    event = appContext.getString(R.string.log_connect_failure),
                    reason = appContext.getString(SessionReasonMapping.errorCode(errorCode)),
                    errorCode = errorCode?.name,
                    suggestedAction = appContext.getString(R.string.log_connect_failure_suggestion),
                )
            }
        }
    }

    override fun onSessionStarted() = lifecycleCallback.onSessionStarted()
    override fun onSessionPaused(reason: PausedReason) = lifecycleCallback.onSessionPaused(reason)
    override fun onSessionResumed() = lifecycleCallback.onSessionResumed()
    override fun onSessionTerminating(reason: TerminatingReason, gracePeriodMs: Long) =
        lifecycleCallback.onSessionTerminating(reason, gracePeriodMs)

    override fun onSessionClosed(reason: CloseReason) {
        // Clear the reference first, then run the original logging and navigation logic to avoid leaks. 先清空引用，再执行日志与导航逻辑，避免泄漏。
        session = null
        lifecycleCallback.onSessionClosed(reason)
    }

    override fun onConnectResult(success: Boolean, errorCode: SessionErrorCode?) {
        // On failure the SDK handles the session state through onSessionClosed; we only log here. 失败时 SDK 通过 onSessionClosed 处理会话状态；此处只做日志记录。
        lifecycleCallback.onConnectResult(success, errorCode)
    }

    private val audioCallback = object : IAudioCallback {
        override fun onAudioReceived(data: ByteArray) {
            logCapability(
                sdkApi = "IAudioCallback.onAudioReceived",
                event = appContext.getString(R.string.log_audio_received, data.size),
            )
        }

        override fun onAudioError(errorCode: Int, errorMessage: String?) {
            logError(
                sdkApi = "IAudioCallback.onAudioError",
                event = appContext.getString(R.string.log_audio_callback_error),
                reason = errorMessage ?: "errorCode=$errorCode",
                errorCode = "$errorCode",
            )
        }

        override fun onAudioStreamStateChanged(isStreaming: Boolean) {
            logCapability(
                sdkApi = "IAudioCallback.onAudioStreamStateChanged",
                event = appContext.getString(R.string.log_audio_stream_state_changed, isStreaming.toString()),
            )
        }
    }

    override fun onAudioReceived(data: ByteArray) = audioCallback.onAudioReceived(data)
    override fun onAudioError(errorCode: Int, errorMessage: String?) =
        audioCallback.onAudioError(errorCode, errorMessage)
    override fun onAudioStreamStateChanged(isStreaming: Boolean) =
        audioCallback.onAudioStreamStateChanged(isStreaming)

    private val imageCallback = object : IImageCallback {
        override fun onImageReceived(data: ByteArray) {
            logCapability(
                sdkApi = "IImageCallback.onImageReceived",
                event = appContext.getString(R.string.log_image_received, data.size, appContext.getString(R.string.log_decode_success)),
            )
        }

        override fun onImageError(errorCode: SessionErrorCode, v1ErrorCode: Int, v1ErrorMessage: String?) {
            logError(
                sdkApi = "IImageCallback.onImageError",
                event = appContext.getString(R.string.log_image_callback_error),
                reason = appContext.getString(SessionReasonMapping.errorCode(errorCode)) +
                    (v1ErrorMessage?.let { "；$it" } ?: ""),
                errorCode = errorCode.name,
            )
        }
    }

    override fun onImageReceived(data: ByteArray) = imageCallback.onImageReceived(data)
    override fun onImageError(errorCode: SessionErrorCode, v1ErrorCode: Int, v1ErrorMessage: String?) =
        imageCallback.onImageError(errorCode, v1ErrorCode, v1ErrorMessage)

    private val customCmdCallback = object : ICustomCmdSessionCallback {
        override fun onCustomCmdResult(channelKey: String, data: ByteArray?) {
            logCapability(
                sdkApi = "ICustomCmdSessionCallback.onCustomCmdResult",
                event = appContext.getString(R.string.log_custom_cmd_result, channelKey, data?.size ?: 0),
            )
        }
    }

    override fun onCustomCmdResult(channelKey: String, data: ByteArray?) =
        customCmdCallback.onCustomCmdResult(channelKey, data)

    private val glassesCallback = object : IGlassesEventListener {
        override fun onGlassesAppResumed() = logGlassesEvent(
            appContext.getString(R.string.log_glasses_app_resumed),
        )
        override fun onGlassesAppPaused() = logGlassesEvent(
            appContext.getString(R.string.log_glasses_app_paused),
        )
        override fun onWearingStatusChanged(wearing: Boolean) = logGlassesEvent(
            appContext.getString(R.string.log_wearing_status_changed, wearing.toString()),
        )
        override fun onDeviceInfoChanged(info: GlassesInfo) = logGlassesEvent(
            appContext.getString(R.string.log_device_info_changed, info.toString()),
        )
        override fun onScreenOff() = logGlassesEvent(
            appContext.getString(R.string.log_screen_off),
        )
        override fun onScreenOn() = logGlassesEvent(
            appContext.getString(R.string.log_screen_on),
        )
        override fun onLauncherResumed() = logGlassesEvent(
            appContext.getString(R.string.log_launcher_resumed),
        )
        override fun onAiWake() = logGlassesEvent(
            appContext.getString(R.string.log_ai_wake),
        )
        override fun onAiInterruptChanged(interruptWake: Boolean) = logGlassesEvent(
            appContext.getString(R.string.log_ai_interrupt_changed, interruptWake.toString()),
        )
    }

    override fun onGlassesAppResumed() = glassesCallback.onGlassesAppResumed()
    override fun onGlassesAppPaused() = glassesCallback.onGlassesAppPaused()
    override fun onWearingStatusChanged(wearing: Boolean) = glassesCallback.onWearingStatusChanged(wearing)
    override fun onDeviceInfoChanged(info: GlassesInfo) = glassesCallback.onDeviceInfoChanged(info)
    override fun onScreenOff() = glassesCallback.onScreenOff()
    override fun onScreenOn() = glassesCallback.onScreenOn()
    override fun onLauncherResumed() = glassesCallback.onLauncherResumed()
    override fun onAiWake() = glassesCallback.onAiWake()
    override fun onAiInterruptChanged(interruptWake: Boolean) =
        glassesCallback.onAiInterruptChanged(interruptWake)

    init {
        createSessionFromRequest()
    }

/**
     * Create and connect the session from [SessionLaunchRequest].
     * 从 [SessionLaunchRequest] 创建并连接会话。
     *
     * Critical order: register callbacks before [CxrSession.connect] so SDK callbacks can be
     * received from the very first moment.
     * 关键顺序：在 [CxrSession.connect] 之前注册回调，确保从第一刻起就能收到 SDK 回调。
     *
     * Immediately call [SessionLaunchRequest.clear] after reading the request to avoid token residue.
     * 读取请求后立即调用 [SessionLaunchRequest.clear]，避免 token 残留。
     */
    private fun createSessionFromRequest() {
        _btConnected.value = manager.isGlassesBtConnected()

        val config = SessionLaunchRequest.config
        val token = SessionLaunchRequest.token
        SessionLaunchRequest.clear()

        if (config == null || token == null) {
            logInfo(
                sdkApi = "SessionHubViewModel.createSessionFromRequest",
                event = appContext.getString(R.string.log_no_launch_params),
            )
            return
        }

        val created = try {
            manager.create(config)
        } catch (e: IllegalStateException) {
            logError(
                sdkApi = "CxrSessionManager.create",
                event = appContext.getString(R.string.log_create_session_failed),
                reason = e.message,
                suggestedAction = appContext.getString(R.string.log_create_session_failed_suggestion),
            )
            resetSessionState()
            return
        }

        created.addLifecycleCallback(this)
        created.addAudioCallback(this)
        created.addImageCallback(this)
        created.addCustomCmdCallback(this)
        created.addGlassesEventListener(this)

        session = created
        _sessionConfig.value = config

        try {
            created.connect(token)
        } catch (e: Exception) {
            logError(
                sdkApi = "CxrSession.connect",
                event = appContext.getString(R.string.log_connect_session_failed),
                reason = e.message,
                suggestedAction = appContext.getString(R.string.log_connect_session_failed_suggestion),
            )
            runCatching { created.close() }
            session = null
            resetSessionState()
            return
        }

        viewModelScope.launch {
            created.stateFlow
                .onEach { _sessionState.value = it }
                .takeWhile {
                    // Stop collecting once Idle and the session reference is already released. 当状态为 Idle 且会话引用已释放时停止收集。
                    !(it == SessionState.Idle && currentSession == null)
                }
                .collect { }
        }
    }

    private fun resetSessionState() {
        _sessionState.value = SessionState.Idle
        _sessionConfig.value = null
    }

/**
     * Refresh the Bluetooth connection state (for manual UI triggers).
     * 刷新蓝牙连接状态（用于手动 UI 触发）。
     */
    fun refreshBtConnected() {
        _btConnected.value = manager.isGlassesBtConnected()
    }

/**
     * End the session: close the session, clear the reference, and request navigation back to
     * setup_graph.
     * 结束会话：关闭会话、清空引用，并请求导航回 setup_graph。
     *
     * [onSessionClosed] will also trigger the same navigation command; CxrNavGraph deduplicates it.
     * [onSessionClosed] 也会触发相同导航指令；CxrNavGraph 会进行去重。
     */
    fun endSession() {
        session?.close()
        session = null
        CxrSceneNavigation.requestToSetup()
    }

/**
     * Append an item to the event log (used by feature pages to sync capability call results into
     * the Hub log stream).
     * 追加一条事件日志（供能力页面将能力调用结果同步到 Hub 日志流）。
     */
    fun appendEventLog(item: EventLogItem) {
        _eventLog.value = EventLogger.append(_eventLog.value, item)
    }

/**
     * Clear the in-memory event log.
     * 清空内存中的事件日志。
     */
    fun clearEventLog() {
        _eventLog.value = emptyList()
    }

/**
     * Export the event log to the cache directory (auto-redacted + 200-item cap + file count cap).
     * 将事件日志导出到缓存目录（自动脱敏 + 200 条上限 + 文件数量上限）。
     */
    fun exportEventLog(): String? {
        val context = getApplication<Application>().applicationContext
        return runCatching {
            EventLogger.export(context, _eventLog.value).absolutePath
        }.getOrNull()
    }

    override fun onCleared() {
        super.onCleared()
        // ViewModel destroyed = session end: the only release point (who creates must destroy).
        // ViewModel 销毁 = 会话结束的唯一释放点（谁创建谁销毁）。
        session?.close()
    }

    // ---------- Logging helpers 日志辅助方法 ----------

    private fun logLifecycle(
        sdkApi: String,
        stateBefore: String,
        stateAfter: String,
        event: String,
        reason: String? = null,
        errorCode: String? = null,
        suggestedAction: String? = null,
    ) {
        appendEventLog(
            EventLogger.create(
                category = EventCategory.LIFECYCLE,
                sdkApi = sdkApi,
                stateBefore = stateBefore,
                stateAfter = stateAfter,
                event = event,
                reason = reason,
                errorCode = errorCode,
                suggestedAction = suggestedAction,
            ),
        )
    }

    private fun logInfo(
        sdkApi: String,
        event: String,
        reason: String? = null,
    ) {
        appendEventLog(
            EventLogger.create(
                category = EventCategory.INFO,
                sdkApi = sdkApi,
                stateBefore = _sessionState.value.name,
                stateAfter = _sessionState.value.name,
                event = event,
                reason = reason,
            ),
        )
    }

    private fun logCapability(
        sdkApi: String,
        event: String,
        reason: String? = null,
    ) {
        appendEventLog(
            EventLogger.create(
                category = EventCategory.CAPABILITY,
                sdkApi = sdkApi,
                stateBefore = _sessionState.value.name,
                stateAfter = _sessionState.value.name,
                event = event,
                reason = reason,
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
        appendEventLog(
            EventLogger.create(
                category = EventCategory.ERROR,
                sdkApi = sdkApi,
                stateBefore = _sessionState.value.name,
                stateAfter = _sessionState.value.name,
                event = event,
                reason = reason,
                errorCode = errorCode,
                suggestedAction = suggestedAction,
            ),
        )
    }

    private fun logGlassesEvent(event: String) {
        val timestamp = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
            .format(System.currentTimeMillis())
        val line = "[$timestamp] $event"
        _glassesEvents.value = listOf(line) + _glassesEvents.value.take(GLASSES_EVENT_MAX - 1)
        appendEventLog(
            EventLogger.create(
                category = EventCategory.EVENT,
                sdkApi = "IGlassesEventListener",
                stateBefore = _sessionState.value.name,
                stateAfter = _sessionState.value.name,
                event = appContext.getString(R.string.log_glasses_event_note, event),
            ),
        )
    }

    companion object {
        private const val GLASSES_EVENT_MAX = 10
    }
}
