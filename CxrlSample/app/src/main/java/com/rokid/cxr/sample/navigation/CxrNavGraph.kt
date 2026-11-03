package com.rokid.cxr.sample.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.navigation
import androidx.navigation.compose.rememberNavController
import com.rokid.cxr.sample.ui.feature.AudioPage
import com.rokid.cxr.sample.ui.feature.CustomCmdPage
import com.rokid.cxr.sample.ui.feature.CustomViewPage
import com.rokid.cxr.sample.ui.feature.DeviceControlPage
import com.rokid.cxr.sample.ui.feature.PhotoPage
import com.rokid.cxr.sample.ui.hub.EventLogPage
import com.rokid.cxr.sample.ui.hub.HubScreen
import com.rokid.cxr.sample.ui.setup.SetupFlowScreen
import com.rokid.cxr.sample.viewmodel.AudioViewModel
import com.rokid.cxr.sample.viewmodel.CustomCmdViewModel
import com.rokid.cxr.sample.viewmodel.CustomViewViewModel
import com.rokid.cxr.sample.viewmodel.DeviceControlViewModel
import com.rokid.cxr.sample.viewmodel.PhotoViewModel
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel
import com.rokid.cxr.sample.viewmodel.SetupViewModel
import com.rokid.cxr.session.SessionState

/**
 * v1.1 Sample two-level navigation graph.
 * v1.1 示例双层导航图。
 *
 * - setup_graph: install_companion -> authorize -> select_scene (no session onboarding)
 * - hub_graph: hub -> feature/{audio,photo,device,custom_cmd,custom_view} / event_log (session created)
 *
 * - setup_graph：install_companion -> authorize -> select_scene（无会话 onboarding）
 * - hub_graph：hub -> feature/{audio,photo,device,custom_cmd,custom_view} / event_log（会话已创建）
 *
 * Route guards:
 * 1. Before entering hub, check the shared Hub VM's [SessionHubViewModel.currentSession]; if null, go back to setup_graph.
 * 2. When [SessionState.Idle] and [SessionHubViewModel.currentSession] is null, go back to setup_graph.
 *
 * 路由守卫：
 * 1. 进入 hub 前，检查共享 Hub VM 的 [SessionHubViewModel.currentSession]；若为空则返回 setup_graph。
 * 2. 当 [SessionState.Idle] 且 [SessionHubViewModel.currentSession] 为空时，返回 setup_graph。
 *
 * Feature page ViewModels receive the shared [SessionHubViewModel] through a custom factory;
 * the session object is held by Hub and fetched on demand inside feature pages, so feature pages do not keep a session reference.
 * Business callbacks (audio/image/customCmd) are registered when the page enters and unregistered when it exits (paired on A12).
 *
 * 功能页 ViewModel 通过自定义工厂接收共享的 [SessionHubViewModel]；会话对象由 Hub 持有，功能页内部按需获取，因此不保留会话引用。
 * 业务回调（audio/image/customCmd）在页面进入时注册、退出时注销（A12 成对）。
 *
 * The navigation-compose 2.9.4 dependency has been added by the Team Lead in app/build.gradle.kts.
 * navigation-compose 2.9.4 依赖已由 Team Lead 在 app/build.gradle.kts 中添加。
 */

/** CompositionLocal used internally by [SetupFlowScreen], [HubScreen], and feature pages for navigation. [SetupFlowScreen]、[HubScreen] 与功能页内部用于导航的 CompositionLocal。 */
internal val LocalNavController = compositionLocalOf<NavHostController?> { null }

/** Route constants for setup_graph. setup_graph 的路由常量。 */
object SetupRoutes {
    const val INSTALL_COMPANION = "install_companion"
    const val AUTHORIZE = "authorize"
    const val SELECT_SCENE = "select_scene"
}

/** Route constants for hub_graph. hub_graph 的路由常量。 */
object HubRoutes {
    const val HUB = "hub"
    const val AUDIO = "feature/audio"
    const val PHOTO = "feature/photo"
    const val DEVICE_CONTROL = "feature/device_control"
    const val CMD = "feature/cmd"
    const val CUSTOM_VIEW = "feature/custom_view"
    const val EVENT_LOG = "event_log"
}

private const val SETUP_GRAPH = "setup_graph"
private const val HUB_GRAPH = "hub_graph"

@Composable
fun CxrNavGraph(
    navController: NavHostController = rememberNavController(),
    setupViewModel: SetupViewModel,
) {
    CompositionLocalProvider(LocalNavController provides navController) {
        // Globally listen for callback-driven navigation commands (CloseReason / endSession). 全局监听回调驱动的导航指令（CloseReason / endSession）。
        LaunchedEffect(Unit) {
            CxrSceneNavigation.commands.collect { command ->
                when (command) {
                    is HubNavCommand.ToSetup -> {
                        // Deduplication: only return to setup_graph when currently in hub_graph (including feature sub-pages). 去重：仅当前位于 hub_graph（包括功能子页）时才返回 setup_graph。
                        // endSession() and onSessionClosed may emit ToSetup one after another; by the time the second one arrives,
                        // the current destination has already switched to setup_graph, so the parent route is no longer HUB_GRAPH and it is naturally skipped.
                        // endSession() 与 onSessionClosed 可能连续发出 ToSetup；当第二个到达时，当前目的地已切到 setup_graph，父路由不再是 HUB_GRAPH，自然被跳过。
                        if (navController.currentDestination?.parent?.route == HUB_GRAPH) {
                            navController.navigate(SETUP_GRAPH) {
                                popUpTo(HUB_GRAPH) { inclusive = true }
                            }
                        }
                    }
                }
            }
        }

        NavHost(
            navController = navController,
            startDestination = SETUP_GRAPH,
        ) {
            navigation(
                route = SETUP_GRAPH,
                startDestination = SetupRoutes.INSTALL_COMPANION,
            ) {
                composable(SetupRoutes.INSTALL_COMPANION) {
                    SetupFlowScreen(
                        setupViewModel = setupViewModel,
                        onSessionCreated = {
                            navController.navigate(HubRoutes.HUB) {
                                popUpTo(SETUP_GRAPH) { inclusive = true }
                            }
                        },
                    )
                }
                composable(SetupRoutes.AUTHORIZE) {
                    SetupFlowScreen(
                        setupViewModel = setupViewModel,
                        onSessionCreated = {
                            navController.navigate(HubRoutes.HUB) {
                                popUpTo(SETUP_GRAPH) { inclusive = true }
                            }
                        },
                    )
                }
                composable(SetupRoutes.SELECT_SCENE) {
                    SetupFlowScreen(
                        setupViewModel = setupViewModel,
                        onSessionCreated = {
                            navController.navigate(HubRoutes.HUB) {
                                popUpTo(SETUP_GRAPH) { inclusive = true }
                            }
                        },
                    )
                }

            }

            navigation(
                route = HUB_GRAPH,
                startDestination = HubRoutes.HUB,
            ) {
                composable(HubRoutes.HUB) { backStackEntry ->
                    val hubViewModel: SessionHubViewModel = viewModel(backStackEntry)
                    val sessionState by hubViewModel.sessionState.collectAsStateWithLifecycle()

                    // Route guard: return to setup_graph when there is no session. 路由守卫：无会话时返回 setup_graph。
                    LaunchedEffect(Unit) {
                        if (hubViewModel.currentSession == null) {
                            navController.navigate(SETUP_GRAPH) {
                                popUpTo(HUB_GRAPH) { inclusive = true }
                            }
                        }
                    }

                    // Automatically return to setup_graph when the session becomes Idle and has been released. 会话变为 Idle 且已释放时自动返回 setup_graph。
                    // Note: we cannot only check sessionState == Idle—the Hub ViewModel's stateFlow initial value is Idle,
                    // so right after session creation (before Starting/Started is emitted) it would be misjudged as "closed" and kick the user back to the onboarding page.
                    // 注意：不能只判断 sessionState == Idle——Hub ViewModel 的 stateFlow 初始值就是 Idle，
                    // 会话刚创建时（还未发出 Starting/Started）会被误判为“已关闭”并踢回 onboarding 页。
                    LaunchedEffect(sessionState) {
                        if (sessionState == SessionState.Idle && hubViewModel.currentSession == null) {
                            navController.navigate(SETUP_GRAPH) {
                                popUpTo(HUB_GRAPH) { inclusive = true }
                            }
                        }
                    }

                    HubScreen(hubViewModel = hubViewModel)
                }

                composable(HubRoutes.EVENT_LOG) { backStackEntry ->
                    // Shares the same SessionHubViewModel with hub to ensure logs come from the same source. 与 hub 共享同一个 SessionHubViewModel，确保日志来源一致。
                    val hubViewModel = hubViewModel(navController, backStackEntry)
                    val entries by hubViewModel.eventLog.collectAsStateWithLifecycle()
                    EventLogPage(
                        entries = entries,
                        onClearLog = { hubViewModel.clearEventLog() },
                        onExportLog = { hubViewModel.exportEventLog() },
                    )
                }

                composable(HubRoutes.AUDIO) { backStackEntry ->
                    val hubViewModel = hubViewModel(navController, backStackEntry)
                    val appContext = LocalContext.current.applicationContext
                    val audioViewModel: AudioViewModel = featureViewModel(backStackEntry, hubViewModel) {
                        AudioViewModel(hubViewModel, appContext)
                    }
                    AudioPage(
                        hubViewModel = hubViewModel,
                        audioViewModel = audioViewModel,
                    )
                }

                composable(HubRoutes.PHOTO) { backStackEntry ->
                    val hubViewModel = hubViewModel(navController, backStackEntry)
                    val appContext = LocalContext.current.applicationContext
                    val photoViewModel: PhotoViewModel = featureViewModel(backStackEntry, hubViewModel) {
                        PhotoViewModel(hubViewModel, appContext)
                    }
                    PhotoPage(
                        hubViewModel = hubViewModel,
                        photoViewModel = photoViewModel,
                    )
                }

                composable(HubRoutes.DEVICE_CONTROL) { backStackEntry ->
                    val hubViewModel = hubViewModel(navController, backStackEntry)
                    val appContext = LocalContext.current.applicationContext
                    val deviceViewModel: DeviceControlViewModel = featureViewModel(backStackEntry, hubViewModel) {
                        DeviceControlViewModel(hubViewModel, appContext)
                    }
                    DeviceControlPage(
                        hubViewModel = hubViewModel,
                        deviceViewModel = deviceViewModel,
                    )
                }

                composable(HubRoutes.CMD) { backStackEntry ->
                    val hubViewModel = hubViewModel(navController, backStackEntry)
                    val appContext = LocalContext.current.applicationContext
                    val customCmdViewModel: CustomCmdViewModel = featureViewModel(backStackEntry, hubViewModel) {
                        CustomCmdViewModel(hubViewModel, appContext)
                    }
                    CustomCmdPage(
                        hubViewModel = hubViewModel,
                        customCmdViewModel = customCmdViewModel,
                    )
                }

                composable(HubRoutes.CUSTOM_VIEW) { backStackEntry ->
                    val hubViewModel = hubViewModel(navController, backStackEntry)
                    val appContext = LocalContext.current.applicationContext
                    val customViewViewModel: CustomViewViewModel = featureViewModel(backStackEntry, hubViewModel) {
                        CustomViewViewModel(hubViewModel, appContext)
                    }
                    CustomViewPage(
                        hubViewModel = hubViewModel,
                        customViewViewModel = customViewViewModel,
                    )
                }
            }
        }
    }
}

/**
 * Obtains the [SessionHubViewModel] shared with the hub destination.
 * 获取与 hub 目的地共享的 [SessionHubViewModel]。
 */
@Composable
private fun hubViewModel(navController: NavHostController, key: NavBackStackEntry): SessionHubViewModel {
    return viewModel(remember(key) { navController.getBackStackEntry(HubRoutes.HUB) })
}

/**
 * Common factory for creating feature page ViewModels.
 * 创建功能页 ViewModel 的通用工厂。
 *
 * The session object is held by Hub; feature pages fetch it on demand through a getter and do not hold a session reference.
 * 会话对象由 Hub 持有；功能页通过 getter 按需获取，不保留会话引用。
 *
 * @param backStackEntry The back stack entry of the feature page destination, used to scope the ViewModel lifecycle.
 *                       功能页目的地的返回栈条目，用于限定 ViewModel 生命周期。
 * @param factory Receives the application [android.content.Context] and returns a ViewModel instance.
 *                接收应用 [android.content.Context] 并返回 ViewModel 实例。
 */
@Composable
private inline fun <reified VM : ViewModel> featureViewModel(
    backStackEntry: NavBackStackEntry,
    hubViewModel: SessionHubViewModel,
    crossinline factory: (android.content.Context) -> VM,
): VM {
    val appContext = LocalContext.current.applicationContext
    return viewModel(
        viewModelStoreOwner = backStackEntry,
        factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                return factory(appContext) as T
            }
        },
    )
}
