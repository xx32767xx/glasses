package com.rokid.cxr.sample.viewmodel

import android.app.Activity
import android.app.Application
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import android.util.Log
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.model.CONSTANT
import com.rokid.cxr.sample.model.GlassAppAssets
import com.rokid.cxr.sample.model.SessionConfigPolicy
import com.rokid.cxr.sample.model.SessionLaunchRequest
import com.rokid.cxr.sample.navigation.CxrSceneNavigation
import com.rokid.cxr.sample.navigation.HubNavCommand
import com.rokid.cxr.sample.util.TokenRedactor
import com.rokid.cxr.session.AiInterceptMode
import com.rokid.cxr.session.AuthResult
import com.rokid.cxr.session.CxrSessionManager
import com.rokid.cxr.session.GlassPermission
import com.rokid.cxr.session.RokidAppStatus
import com.rokid.cxr.session.SessionConfig
import com.rokid.cxr.session.SessionTimeouts
import com.rokid.cxr.session.SessionType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Three-step onboarding state machine: InstallCompanion → Authorize → SelectScene.
 * 三步 onboarding 状态机：安装 companion → 授权 → 选择场景。
 *
 * - Environment checks and authorization results are kept only in in-memory StateFlows;
 *   the token is not persisted and is never logged in plain text.
 * - SessionConfig editing fields are used in the SelectScene step; creation parameters are
 *   temporarily stored in [SessionLaunchRequest], and the actual creation is performed by the
 *   Hub ([com.rokid.cxr.sample.viewmodel.SessionHubViewModel]) after entering the session hub.
 *
 * - 环境检查与授权结果仅保存在内存 StateFlow 中；token 不落盘，也绝不会以明文记录。
 * - SessionConfig 编辑字段用于“选择场景”步骤；创建参数临时存放在 [SessionLaunchRequest] 中，
 *   真正的创建由进入会话中心后的 Hub（[com.rokid.cxr.sample.viewmodel.SessionHubViewModel]）执行。
 */
enum class HomeFlowStep {
    InstallCompanion,
    Authorize,
    SelectScene,
}

class SetupViewModel(application: Application) : AndroidViewModel(application) {

    private val manager: CxrSessionManager =
        CxrSessionManager.getInstance(application.applicationContext)

    // ---------- Environment checks 环境检查 ----------

    private val _appInstalled = MutableStateFlow(false)
    val appInstalled: StateFlow<Boolean> = _appInstalled.asStateFlow()

    private val _appStatus = MutableStateFlow<RokidAppStatus?>(null)
    val appStatus: StateFlow<RokidAppStatus?> = _appStatus.asStateFlow()

/**
     * Whether the environment is ready.
     * 环境是否就绪。
     *
     * Semantics: the Rokid AI App is installed and the version is compatible. This flag is also
     * used to derive [currentStep], so the UI stays on [HomeFlowStep.InstallCompanion] until ready.
     *
     * 语义：Rokid AI App 已安装且版本兼容。该标志也用于推导 [currentStep]，因此 UI 在就绪前停留在 [HomeFlowStep.InstallCompanion]。
     *
     * Note: the glasses Bluetooth connection state is maintained by the Hub
     * ([com.rokid.cxr.sample.viewmodel.SessionHubViewModel]) only after the session is created;
     * it is not checked during the onboarding phase.
     *
     * 注意：眼镜蓝牙连接状态仅在会话创建后由 Hub（[com.rokid.cxr.sample.viewmodel.SessionHubViewModel]）维护；
     * onboarding 阶段不检查蓝牙。
     */
    private val _envChecked = MutableStateFlow(false)
    val envChecked: StateFlow<Boolean> = _envChecked.asStateFlow()

    // ---------- Authorization 授权 ----------

    private val _authState = MutableStateFlow<AuthResult?>(null)
    val authState: StateFlow<AuthResult?> = _authState.asStateFlow()

    /** Authorization token kept only in memory; it is not persisted and is never logged. 授权 token 仅保存在内存中；不落盘、不记录日志。 */
    private var authToken: String? = null

    // ---------- SessionConfig editing SessionConfig 编辑 ----------

    private val _sessionType = MutableStateFlow(SessionType.CUSTOM_VIEW)

    /** True once the built-in sample glasses app has been auto-filled (per setup session). 内置示例眼镜应用已自动预填的标志（每个引导流程一次）。 */
    private var autoFilledBuiltIn = false
    val sessionType: StateFlow<SessionType> = _sessionType.asStateFlow()

    private val _gracePeriodMs = MutableStateFlow(5_000L)
    val gracePeriodMs: StateFlow<Long> = _gracePeriodMs.asStateFlow()

    private val _viewData = MutableStateFlow(CONSTANT.DEFAULT_VIEW_DATA)
    val viewData: StateFlow<String> = _viewData.asStateFlow()

    private val _glassesPackageName = MutableStateFlow("")
    val glassesPackageName: StateFlow<String> = _glassesPackageName.asStateFlow()

    private val _glassesActivityName = MutableStateFlow("")
    val glassesActivityName: StateFlow<String> = _glassesActivityName.asStateFlow()

    private val _glassesApkPath = MutableStateFlow("")
    val glassesApkPath: StateFlow<String> = _glassesApkPath.asStateFlow()

    private val _configError = MutableStateFlow<String?>(null)
    val configError: StateFlow<String?> = _configError.asStateFlow()

    // ---------- Create session 创建会话 ----------

    private val _sessionCreated = MutableStateFlow(false)
    val sessionCreated: StateFlow<Boolean> = _sessionCreated.asStateFlow()

    private val _createError = MutableStateFlow<String?>(null)
    val createError: StateFlow<String?> = _createError.asStateFlow()

    // ---------- Derive current step 推导当前步骤 ----------

    val currentStep: StateFlow<HomeFlowStep> = combine(
        envChecked,
        authState,
        sessionCreated,
    ) { ready, auth, created ->
        when {
            !ready -> HomeFlowStep.InstallCompanion
            auth?.isSuccess != true -> HomeFlowStep.Authorize
            !created -> HomeFlowStep.SelectScene
            else -> HomeFlowStep.SelectScene
        }
    }.stateIn(
        viewModelScope,
        SharingStarted.WhileSubscribed(5_000),
        HomeFlowStep.InstallCompanion,
    )

    init {
        checkEnvironment()
        // Reset creation state after a session ends so the user can create a new session within
        // the same authorization cycle (the auth token and config editing state are retained).
        // 会话结束后重置创建状态，让用户可在同一授权周期内新建会话（保留授权 token 与配置编辑状态）。
        viewModelScope.launch {
            CxrSceneNavigation.commands.collect { command ->
                if (command is HubNavCommand.ToSetup) {
                    _sessionCreated.value = false
                    _createError.value = null
                }
            }
        }
    }

/**
     * Refresh environment state: app installation and app compatibility.
     * 刷新环境状态：应用安装情况与兼容性。
     *
     * SDK methods:
     * - manager.isRokidAppInstalled(context)
     * - manager.checkRokidAppCompatibility(context)
     *
     * SDK 方法：
     * - manager.isRokidAppInstalled(context)
     * - manager.checkRokidAppCompatibility(context)
     */
    fun checkEnvironment() {
        val context = getApplication<Application>().applicationContext
        val installed = manager.isRokidAppInstalled(context)
        val status = manager.checkRokidAppCompatibility(context)
        _appInstalled.value = installed
        _appStatus.value = status
        _envChecked.value = installed && status is RokidAppStatus.Compatible
    }

/**
     * Request authorization from the Rokid AI App.
     * 向 Rokid AI App 请求授权。
     *
     * SDK method: manager.requestAuthorization(activity, permissions, callback)
     * SDK 方法：manager.requestAuthorization(activity, permissions, callback)
     *
     * @param permissions Fixed to CAMERA + MICROPHONE + MEDIA. 固定为 CAMERA + MICROPHONE + MEDIA。
     */
    fun requestAuthorization(activity: Activity) {
        manager.requestAuthorization(
            activity,
            listOf(
                GlassPermission.CAMERA,
                GlassPermission.MICROPHONE,
                GlassPermission.MEDIA,
            ),
        ) { result ->
            handleAuthResult(result)
        }
    }

/**
     * Handle the authorization result forwarded from onActivityResult.
     * 处理从 onActivityResult 转发过来的授权结果。
     *
     * SDK method: manager.parseAuthorizationResult(resultCode, data)
     * SDK 方法：manager.parseAuthorizationResult(resultCode, data)
     */
    fun handleAuthResult(resultCode: Int, data: Intent?) {
        handleAuthResult(manager.parseAuthorizationResult(resultCode, data))
    }

/**
     * Handle [AuthResult] uniformly; the token is kept only in memory and used for redacted display.
     * 统一处理 [AuthResult]；token 仅保存在内存中，并用于脱敏展示。
     */
    fun handleAuthResult(result: AuthResult) {
        authToken = if (result.isSuccess) result.token else null
        _authState.value = result
    }

    /** Returns the redacted token text for display. 返回用于展示的脱敏 token 文本。 */
    fun displayToken(): String = TokenRedactor.forDisplay(
        authToken,
        getApplication<Application>().getString(R.string.token_hidden),
    )

    // ---------- SessionConfig editing setters SessionConfig 编辑 setter ----------

    fun updateSessionType(type: SessionType) {
        if (SessionConfigPolicy.isConfigLocked(_sessionCreated.value)) return
        _sessionType.value = type
        _configError.value = null
    }

    fun updateGracePeriodMs(value: Long) {
        if (SessionConfigPolicy.isConfigLocked(_sessionCreated.value)) return
        _gracePeriodMs.value = value.coerceIn(1_000L, 30_000L)
    }

    fun updateViewData(value: String) {
        if (SessionConfigPolicy.isConfigLocked(_sessionCreated.value)) return
        _viewData.value = value
        _configError.value = null
    }

    fun updateGlassesPackageName(value: String) {
        if (SessionConfigPolicy.isConfigLocked(_sessionCreated.value)) return
        _glassesPackageName.value = value
        _configError.value = null
    }

    fun updateGlassesActivityName(value: String) {
        if (SessionConfigPolicy.isConfigLocked(_sessionCreated.value)) return
        _glassesActivityName.value = value
    }

    fun updateGlassesApkPath(value: String) {
        if (SessionConfigPolicy.isConfigLocked(_sessionCreated.value)) return
        _glassesApkPath.value = value
    }

    /**
     * Auto-fill the built-in sample glasses app config when the user switches to CUSTOM_APP.
     * One-tap experience: selecting CUSTOM_APP is enough — no manual input required.
     * 切换到 CUSTOM_APP 时自动预填内置示例眼镜应用配置：选择即就绪，无需任何手动输入。
     *
     * Runs at most once per setup session (unless the user clears the fields manually).
     * 每个引导流程最多自动执行一次（用户手动清空字段后不再自动重填）。
     */
    fun maybeAutoFillBuiltIn() {
        if (_sessionType.value != SessionType.CUSTOM_APP) return
        if (SessionConfigPolicy.isConfigLocked(_sessionCreated.value)) return
        if (autoFilledBuiltIn) return
        if (_glassesPackageName.value.isNotBlank()) return // User already typed something.
        autoFilledBuiltIn = true
        useBuiltInGlassApp()
    }

    /**
     * Use the built-in sample glasses app: copy the APK from assets to cache and pre-fill the
     * CUSTOM_APP config fields.
     * 使用内置示例眼镜应用：将 APK 从 assets 拷贝到缓存，并预填 CUSTOM_APP 配置字段。
     *
     * Teaching: after the path is written to SessionConfig.glassesApkPath, the SDK connect flow
     * automatically checks appIsInstalled → appUploadAndInstall(apkPath) → appStart(activityName).
     * 教学说明：路径写入 SessionConfig.glassesApkPath 后，SDK connect 流程会自动执行
     * appIsInstalled → appUploadAndInstall(apkPath) → appStart(activityName)。
     */
    fun useBuiltInGlassApp() {
        if (SessionConfigPolicy.isConfigLocked(_sessionCreated.value)) {
            _createError.value = getApplication<Application>().getString(R.string.setup_session_already_created)
            return
        }
        if (_sessionType.value != SessionType.CUSTOM_APP) {
            return
        }
        val context = getApplication<Application>().applicationContext
        val path = GlassAppAssets.ensureBuiltInGlassApp(context)
        if (path == null) {
            _createError.value = getApplication<Application>().getString(R.string.setup_no_builtin_glass_app)
            return
        }
        _glassesPackageName.value = "com.rokid.cxr.custom.demo"
        _glassesActivityName.value = "com.rokid.cxr.custom.demo.MainActivity"
        _glassesApkPath.value = path
        _configError.value = null
        _createError.value = null
        Log.i("SetupViewModel", getApplication<Application>().getString(R.string.setup_glass_app_copied, path))
    }

/**
     * Build a [SessionConfig] from the current editing fields and perform sample-level local validation.
     * 根据当前编辑字段构建 [SessionConfig]，并执行示例层本地校验。
     *
     * Validation rules:
     * - terminatingGracePeriodMs is between 1000 and 30000
     * - For CUSTOM_VIEW, viewData is non-empty and passes
     *   [com.rokid.cxr.sample.model.CustomViewJsonValidator.validateViewData]
     * - For CUSTOM_APP, glassesPackageName is non-empty
     *
     * 校验规则：
     * - terminatingGracePeriodMs 在 1000 到 30000 之间
     * - CUSTOM_VIEW 的 viewData 非空且通过 [com.rokid.cxr.sample.model.CustomViewJsonValidator.validateViewData]
     * - CUSTOM_APP 的 glassesPackageName 非空
     *
     * @return A valid config, or null if invalid. The failure reason is exposed through [configError].
     *         返回有效配置，若无效则返回 null。失败原因通过 [configError] 暴露。
     */
    fun buildConfig(): SessionConfig? {
        _configError.value = null
        val type = _sessionType.value
        val grace = _gracePeriodMs.value
        val viewDataValue = _viewData.value
        val packageName = _glassesPackageName.value.trim()

        val validation = SessionConfigPolicy.validateConfig(
            getString = getApplication<Application>().applicationContext::getString,
            type = type,
            gracePeriodMs = grace,
            viewData = viewDataValue,
            packageName = packageName,
        )
        if (validation is SessionConfigPolicy.ConfigValidation.Invalid) {
            _configError.value = resolveConfigError(validation)
            return null
        }

        return try {
            SessionConfig(
                sessionType = type,
                glassesPackageName = packageName.takeIf { it.isNotBlank() },
                aiInterceptMode = AiInterceptMode.ALLOW_WITH_PAUSE,
                terminatingGracePeriodMs = grace,
                timeouts = SessionTimeouts(),
                viewData = viewDataValue.takeIf { type == SessionType.CUSTOM_VIEW },
                glassesActivityName = _glassesActivityName.value.takeIf { it.isNotBlank() },
                glassesApkPath = _glassesApkPath.value.takeIf { it.isNotBlank() },
            )
        } catch (e: IllegalArgumentException) {
            _configError.value = e.message
            null
        }
    }

    private fun resolveConfigError(
        validation: SessionConfigPolicy.ConfigValidation.Invalid,
    ): String = when (validation.code) {
        SessionConfigPolicy.ConfigValidation.Invalid.Code.GRACE_PERIOD_OUT_OF_RANGE ->
            getApplication<Application>().getString(R.string.setup_error_grace_period_out_of_range)
        SessionConfigPolicy.ConfigValidation.Invalid.Code.CUSTOM_VIEW_BLANK_VIEW_DATA ->
            getApplication<Application>().getString(R.string.setup_error_custom_view_blank_view_data)
        SessionConfigPolicy.ConfigValidation.Invalid.Code.CUSTOM_VIEW_INVALID_VIEW_DATA ->
            getApplication<Application>().getString(
                R.string.setup_error_custom_view_invalid_view_data,
                validation.detail ?: "",
            )
        SessionConfigPolicy.ConfigValidation.Invalid.Code.CUSTOM_APP_MISSING_PACKAGE_NAME ->
            getApplication<Application>().getString(R.string.setup_error_custom_app_missing_package_name)
    }

/**
     * Prepare the session: write the config and token into [SessionLaunchRequest]; the UI shows
     * "session created" and navigates to the Hub.
     * 准备会话：将配置与 token 写入 [SessionLaunchRequest]；UI 显示“会话已创建”并导航到 Hub。
     *
     * Only parameters are prepared here; the actual creation is done by the Hub after entering the
     * session hub (callbacks require the Hub to be on screen).
     * 此处仅准备参数；真正的创建由进入会话中心后的 Hub 完成（回调需要 Hub 处于可见状态）。
     */
    fun createSession() {
        if (SessionConfigPolicy.isConfigLocked(_sessionCreated.value)) {
            _createError.value = getApplication<Application>().getString(R.string.setup_session_already_created)
            return
        }
        val token = authToken ?: run {
            _createError.value = getApplication<Application>().getString(R.string.setup_create_session_auth_required)
            return
        }
        val config = buildConfig() ?: return
        _createError.value = null
        SessionLaunchRequest.config = config
        SessionLaunchRequest.token = token
        _sessionCreated.value = true
        _createError.value = null
    }
}
