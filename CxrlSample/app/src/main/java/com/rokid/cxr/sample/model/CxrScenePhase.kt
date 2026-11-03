package com.rokid.cxr.sample.model

import com.rokid.cxr.session.SessionConfig
import com.rokid.cxr.session.SessionState
import com.rokid.cxr.session.SessionType

/**
 * Sample-layer "scene phase": maps the SDK's five states + config + Bluetooth state into four
 * UI-oriented phases.
 *
 * See the glossary (N-K3) for the difference between phases and the five states.
 * 示例层“场景阶段”：将 SDK 的五态 + 配置 + 蓝牙状态映射为四个面向 UI 的阶段。
 *
 * 阶段与五态的区别详见词汇表（N-K3）。
 */
enum class CxrScenePhase {
    /** Link is being established or the scene is exiting. 连接建立中或场景正在退出。 */
    Connecting,

    /**
     * Already started, but the scene is not truly ready due to a configuration anomaly.
     * Only used for:
     * - CUSTOM_VIEW with blank [SessionConfig.viewData]
     * - CUSTOM_APP with [SessionConfig.glassesApkPath] specified but installation failed
     *
     * 已启动，但因配置异常场景尚未真正就绪。仅用于：
     * - CUSTOM_VIEW 且 [SessionConfig.viewData] 为空
     * - CUSTOM_APP 且指定了 [SessionConfig.glassesApkPath] 但安装失败
     */
    SceneNotReady,

    /** Session paused (AI assistant is occupying or BT disconnected); capability APIs are unavailable. 会话暂停（AI 助手占用或蓝牙断开）；能力 API 不可用。 */
    Paused,

    /** Session started and configuration is normal; capability APIs are available. 会话已启动且配置正常；能力 API 可用。 */
    CapabilitiesReady,
}

/**
 * Maps the SDK's five states to Sample phases.
 *
 * @param sessionState Current SDK five-state value 当前 SDK 五态值
 * @param config Configuration passed when creating the session 创建会话时传入的配置
 * @param apkInstallFailed CUSTOM_APP scenario only: whether APK installation failed (true = failed)
 *                       仅 CUSTOM_APP 场景：APK 安装是否失败（true 表示失败）
 * @return Corresponding [CxrScenePhase]; [SessionState.Idle] means no session and is handled by
 *         the navigation layer, so null is returned here
 *         对应的 [CxrScenePhase]；[SessionState.Idle] 表示无会话，由导航层处理，因此这里返回 null
 */
fun mapToCxrScenePhase(
    sessionState: SessionState,
    config: SessionConfig?,
    apkInstallFailed: Boolean = false,
): CxrScenePhase? = when (sessionState) {
    SessionState.Idle -> null
    SessionState.Starting,
    SessionState.Terminating -> CxrScenePhase.Connecting

    SessionState.Paused -> CxrScenePhase.Paused

    SessionState.Started -> {
        val configurationIncomplete = when (config?.sessionType) {
            SessionType.CUSTOM_VIEW -> config.viewData.isNullOrBlank()
            SessionType.CUSTOM_APP -> apkInstallFailed
            null -> true
        }
        if (configurationIncomplete) {
            CxrScenePhase.SceneNotReady
        } else {
            CxrScenePhase.CapabilitiesReady
        }
    }
}
