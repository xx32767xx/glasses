package com.rokid.cxr.sample.navigation

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * Callback-driven navigation command stream.
 * 回调驱动的导航指令流。
 *
 * When Hub ends the session or closes abnormally (CloseReason), this stream notifies [CxrNavGraph] to return to setup_graph.
 * SharedFlow is used so that NavHost does not re-consume old commands after configuration changes.
 *
 * 当 Hub 结束会话或异常关闭（CloseReason）时，该流通知 [CxrNavGraph] 返回 setup_graph。
 * 使用 SharedFlow 确保配置变化后 NavHost 不会重新消费旧指令。
 */
object CxrSceneNavigation {

    private val _commands = MutableSharedFlow<HubNavCommand>(extraBufferCapacity = 1)
    val commands: SharedFlow<HubNavCommand> = _commands.asSharedFlow()

/**
     * Emits the command to return to setup_graph.
     * 发出返回 setup_graph 的指令。
     *
     * Non-suspending, safe to call from SDK callback threads (Java callback threads).
     * 非挂起，可从 SDK 回调线程（Java 回调线程）安全调用。
     */
    fun requestToSetup() {
        _commands.tryEmit(HubNavCommand.ToSetup)
    }
}

/**
 * Navigation commands related to Hub.
 * 与 Hub 相关的导航指令。
 */
sealed class HubNavCommand {
    /** Return to setup_graph to recreate the session. 返回 setup_graph 以重新创建会话。 */
    data object ToSetup : HubNavCommand()
}
