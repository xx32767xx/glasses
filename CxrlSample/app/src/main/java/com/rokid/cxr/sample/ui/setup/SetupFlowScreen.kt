package com.rokid.cxr.sample.ui.setup

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.model.CONSTANT
import com.rokid.cxr.sample.model.CustomViewJsonValidator
import com.rokid.cxr.sample.model.selfView.UpdateViewJson
import com.rokid.cxr.sample.model.selfView.UpdateViewJson.UpdateJson
import com.rokid.cxr.sample.model.selfView.add
import com.rokid.cxr.sample.model.selfView.set
import com.rokid.cxr.sample.navigation.LocalNavController
import com.rokid.cxr.sample.navigation.SetupRoutes
import com.rokid.cxr.sample.ui.components.CapabilityTile
import com.rokid.cxr.sample.ui.components.DevApiButton
import com.rokid.cxr.sample.ui.components.DevBadgeStatus
import com.rokid.cxr.sample.ui.components.DevProgressiveSectionSaveable
import com.rokid.cxr.sample.ui.components.DevSampleScaffold
import com.rokid.cxr.sample.ui.components.DevStatusBadge
import com.rokid.cxr.sample.ui.components.FlowStepIndicator
import com.rokid.cxr.sample.util.CapsFactory
import com.rokid.cxr.sample.viewmodel.HomeFlowStep
import com.rokid.cxr.sample.viewmodel.SetupViewModel
import com.rokid.cxr.session.RokidAppStatus
import com.rokid.cxr.session.SessionErrorCode
import com.rokid.cxr.session.SessionType

/**
 * Three-step onboarding screen: InstallCompanion → Authorize → SelectScene.
 * 三步 onboarding 屏幕：安装 companion → 授权 → 选择场景。
 *
 * Navigation relies on [LocalNavController], provided by [com.rokid.cxr.sample.navigation.CxrNavGraph].
 * 导航依赖 [LocalNavController]，由 [com.rokid.cxr.sample.navigation.CxrNavGraph] 提供。
 */
@Composable
fun SetupFlowScreen(
    setupViewModel: SetupViewModel,
    onSessionCreated: () -> Unit = {},
) {
    val currentStep by setupViewModel.currentStep.collectAsStateWithLifecycle()
    val sessionCreated by setupViewModel.sessionCreated.collectAsStateWithLifecycle()

    LaunchedEffect(sessionCreated) {
        if (sessionCreated) {
            onSessionCreated()
        }
    }

    DevSampleScaffold(
        title = stringResource(R.string.setup_title),
        subtitle = stringResource(R.string.setup_subtitle),
    ) {
        FlowStepIndicator(
            steps = listOf(
                stringResource(R.string.setup_step_install_companion),
                stringResource(R.string.setup_step_authorize),
                stringResource(R.string.setup_step_select_scene),
            ),
            currentIndex = currentStep.ordinal,
        )

        when (currentStep) {
            HomeFlowStep.InstallCompanion -> InstallCompanionStep(setupViewModel)
            HomeFlowStep.Authorize -> AuthorizeStep(setupViewModel)
            HomeFlowStep.SelectScene -> SelectSceneStep(setupViewModel)
        }

        Spacer(modifier = Modifier.height(8.dp))
    }
}

// ==================== InstallCompanion 安装 companion ====================

@Composable
private fun InstallCompanionStep(viewModel: SetupViewModel) {
    val context = LocalContext.current
    val appInstalled by viewModel.appInstalled.collectAsStateWithLifecycle()
    val appStatus by viewModel.appStatus.collectAsStateWithLifecycle()
    val navController = LocalNavController.current

    EnvironmentStatusCard(
        appInstalled = appInstalled,
        appStatus = appStatus,
        onOpenRokidApp = { openRokidAiApp(context, appStatus) },
    )

    DevApiButton(
        label = stringResource(R.string.setup_recheck_env),
        sdkMethod = "manager.isRokidAppInstalled(context) / manager.checkRokidAppCompatibility(context)",
        description = stringResource(R.string.setup_recheck_env_description),
        onClick = { viewModel.checkEnvironment() },
    )

    val environmentReady = appInstalled && appStatus is RokidAppStatus.Compatible
    DevApiButton(
        label = stringResource(R.string.setup_next_step),
        sdkMethod = "navController.navigate(\"authorize\")",
        description = stringResource(R.string.setup_next_step_description),
        enabled = environmentReady,
        unavailableReason = if (environmentReady) {
            ""
        } else {
            stringResource(R.string.setup_env_not_ready_hint_specific)
        },
        onClick = { navController?.navigate(SetupRoutes.AUTHORIZE) },
    )
}

@Composable
private fun EnvironmentStatusCard(
    appInstalled: Boolean,
    appStatus: RokidAppStatus?,
    onOpenRokidApp: () -> Unit,
) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                text = stringResource(R.string.setup_env_result_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )

            val appSummary: String
            val appBadge: DevBadgeStatus
            val appClickable: Boolean
            when (appStatus) {
                is RokidAppStatus.NotInstalled -> {
                    appSummary = stringResource(R.string.setup_app_not_installed)
                    appBadge = DevBadgeStatus.FAILED
                    appClickable = true
                }
                is RokidAppStatus.VersionTooLow -> {
                    appSummary = stringResource(
                        R.string.setup_app_version_low,
                        appStatus.installedVersion,
                        appStatus.minimumVersion,
                    )
                    appBadge = DevBadgeStatus.FAILED
                    appClickable = true
                }
                is RokidAppStatus.Compatible -> {
                    appSummary = stringResource(R.string.setup_app_compatible, appStatus.version)
                    appBadge = DevBadgeStatus.SUCCESS
                    appClickable = false
                }
                null -> {
                    appSummary = if (appInstalled) {
                        stringResource(R.string.setup_app_installed)
                    } else {
                        stringResource(R.string.setup_app_not_checked)
                    }
                    appBadge = if (appInstalled) DevBadgeStatus.SUCCESS else DevBadgeStatus.NOT_STARTED
                    appClickable = false
                }
            }

            EnvironmentRow(
                label = stringResource(R.string.setup_app_label),
                summary = appSummary,
                badgeStatus = appBadge,
                clickable = appClickable,
                onClick = onOpenRokidApp,
            )

            Text(
                text = stringResource(R.string.setup_bt_status_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun EnvironmentRow(
    label: String,
    summary: String,
    badgeStatus: DevBadgeStatus,
    clickable: Boolean = false,
    onClick: () -> Unit = {},
) {
    val content: @Composable ColumnScope.() -> Unit = {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    text = summary,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            DevStatusBadge(status = badgeStatus)
        }
    }

    if (clickable) {
        ElevatedCard(
            onClick = onClick,
            modifier = Modifier.fillMaxWidth(),
        ) {
            content()
        }
    } else {
        ElevatedCard(modifier = Modifier.fillMaxWidth()) {
            content()
        }
    }
}

private fun openRokidAiApp(context: Context, appStatus: RokidAppStatus?) {
    val launchIntent = CONSTANT.ROKID_AI_PACKAGES.firstNotNullOfOrNull { packageName ->
        context.packageManager.getLaunchIntentForPackage(packageName)
    }
    if (launchIntent != null) {
        context.startActivity(launchIntent)
        return
    }

    val downloadUrl = when (appStatus) {
        is RokidAppStatus.NotInstalled -> appStatus.downloadUrl
        is RokidAppStatus.VersionTooLow -> appStatus.downloadUrl
        else -> null
    }
    if (!downloadUrl.isNullOrBlank()) {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(downloadUrl)).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            },
        )
    }
}

// ==================== Authorize 授权 ====================

@Composable
private fun AuthorizeStep(viewModel: SetupViewModel) {
    val context = LocalContext.current
    val authState by viewModel.authState.collectAsStateWithLifecycle()
    val navController = LocalNavController.current
    val activity = context as? Activity

    DevApiButton(
        label = stringResource(R.string.setup_request_auth),
        sdkMethod = "manager.requestAuthorization(activity, permissions, callback)",
        description = stringResource(R.string.setup_request_auth_description),
        enabled = activity != null,
        unavailableReason = if (activity != null) "" else stringResource(R.string.setup_need_activity_context),
        onClick = { activity?.let { viewModel.requestAuthorization(it) } },
    )

    authState?.let { result ->
        ElevatedCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = stringResource(R.string.setup_auth_result_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (result.isSuccess) {
                    Text(
                        text = stringResource(R.string.setup_auth_token_hidden),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    val code = result.errorCode
                    val errorText = code?.message ?: result.message ?: ""
                    Text(
                        text = stringResource(R.string.setup_auth_failed, errorText),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Text(
                        text = stringResource(authErrorSuggestion(code)),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }

    val authorized = authState?.isSuccess == true
    DevApiButton(
        label = stringResource(R.string.setup_next_step),
        sdkMethod = "navController.navigate(\"select_scene\")",
        description = stringResource(R.string.setup_next_step_description),
        enabled = authorized,
        unavailableReason = if (authorized) "" else stringResource(R.string.setup_need_activity_context),
        onClick = { navController?.navigate(SetupRoutes.SELECT_SCENE) },
    )
}

@StringRes
private fun authErrorSuggestion(code: SessionErrorCode?): Int = when (code) {
    SessionErrorCode.NOT_AUTHENTICATED -> R.string.setup_auth_error_not_authenticated
    SessionErrorCode.TOKEN_EXPIRED -> R.string.setup_auth_error_token_expired
    SessionErrorCode.ROKID_APP_NOT_INSTALLED -> R.string.setup_auth_error_app_not_installed
    SessionErrorCode.ROKID_APP_VERSION_LOW -> R.string.setup_auth_error_app_version_low
    SessionErrorCode.BT_NOT_CONNECTED -> R.string.setup_auth_error_bt_not_connected
    else -> R.string.setup_auth_error_default
}

// ==================== SelectScene 选择场景 ====================

@Composable
private fun SelectSceneStep(viewModel: SetupViewModel) {
    val context = LocalContext.current
    val sessionType by viewModel.sessionType.collectAsStateWithLifecycle()
    val viewData by viewModel.viewData.collectAsStateWithLifecycle()
    val packageName by viewModel.glassesPackageName.collectAsStateWithLifecycle()
    val activityName by viewModel.glassesActivityName.collectAsStateWithLifecycle()
    val apkPath by viewModel.glassesApkPath.collectAsStateWithLifecycle()
    val gracePeriodMs by viewModel.gracePeriodMs.collectAsStateWithLifecycle()
    val configError by viewModel.configError.collectAsStateWithLifecycle()
    val sessionCreated by viewModel.sessionCreated.collectAsStateWithLifecycle()
    val createError by viewModel.createError.collectAsStateWithLifecycle()

    // One-tap experience: selecting CUSTOM_APP auto-fills the built-in sample glasses app config.
    // 一键体验：选择 CUSTOM_APP 时自动预填内置示例眼镜应用配置，无需手动输入。
    LaunchedEffect(sessionType) {
        viewModel.maybeAutoFillBuiltIn()
    }

    Text(
        text = stringResource(R.string.setup_select_session_type),
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
    )

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        CapabilityTile(
            label = "CUSTOM_VIEW", // Keep SDK type names in English.
            enabled = true,
            onClick = { viewModel.updateSessionType(SessionType.CUSTOM_VIEW) },
            modifier = Modifier.weight(1f),
        )
        CapabilityTile(
            label = "CUSTOM_APP", // Keep SDK type names in English.
            enabled = true,
            onClick = { viewModel.updateSessionType(SessionType.CUSTOM_APP) },
            modifier = Modifier.weight(1f),
        )
    }

    Text(
        text = stringResource(R.string.setup_current_type, sessionType.name),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.setup_session_config_editor),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )

            OutlinedTextField(
                value = gracePeriodMs.toString(),
                onValueChange = { newValue ->
                    newValue.toLongOrNull()?.let { viewModel.updateGracePeriodMs(it) }
                },
                label = { Text(stringResource(R.string.setup_grace_period_label)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            when (sessionType) {
                SessionType.CUSTOM_VIEW -> {
                    val validation = remember(viewData) {
                        CustomViewJsonValidator.validateViewData(context::getString, viewData)
                    }
                    OutlinedTextField(
                        value = viewData,
                        onValueChange = { viewModel.updateViewData(it) },
                        label = { Text(stringResource(R.string.setup_view_data_label)) },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 8,
                        isError = validation.isFailure,
                        supportingText = {
                            validation.exceptionOrNull()?.message?.let { error ->
                                Text(
                                    text = stringResource(R.string.setup_error_custom_view_invalid_view_data, error),
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                        },
                    )
                }
                SessionType.CUSTOM_APP -> {
                    OutlinedTextField(
                        value = packageName,
                        onValueChange = { viewModel.updateGlassesPackageName(it) },
                        label = { Text(stringResource(R.string.setup_package_name_label)) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        isError = packageName.isBlank(),
                    )
                    OutlinedTextField(
                        value = activityName,
                        onValueChange = { viewModel.updateGlassesActivityName(it) },
                        label = { Text(stringResource(R.string.setup_activity_name_label)) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = apkPath,
                        onValueChange = { viewModel.updateGlassesApkPath(it) },
                        label = { Text(stringResource(R.string.setup_apk_path_label)) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                }
            }

            configError?.let { error ->
                Text(
                    text = error,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }

    DevApiButton(
        label = stringResource(R.string.setup_create_session),
        sdkMethod = "manager.create(SessionConfig(...))",
        description = stringResource(R.string.setup_create_session_description),
        enabled = !sessionCreated,
        unavailableReason = if (sessionCreated) {
            stringResource(R.string.setup_session_already_created)
        } else {
            ""
        },
        onClick = { viewModel.createSession() },
    )

    if (sessionCreated) {
        ElevatedCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
            ) {
                Text(
                    text = stringResource(R.string.setup_session_created),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.primary,
                )
                Text(
                    text = stringResource(R.string.setup_session_created_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    createError?.let { error ->
        ElevatedCard(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = error,
                modifier = Modifier.padding(16.dp),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }

    // N-P0-1: local capability demo when no real device is available. N-P0-1：无真实设备时的本地能力演示。
    DevProgressiveSectionSaveable(
        id = "local_preview",
        title = stringResource(R.string.setup_local_preview_title),
        summary = stringResource(R.string.setup_local_preview_summary),
    ) {
        LocalPreviewSection()
    }
}

@Composable
private fun LocalPreviewSection() {
    var previewJson by rememberSaveable { mutableStateOf("") }
    var textToggle by rememberSaveable { mutableIntStateOf(0) }
    val payload = remember(previewJson) {
        CapsFactory.buildPayload(previewJson.ifBlank { "{}" })
    }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            text = stringResource(R.string.custom_view_quick_example),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                previewJson = UpdateViewJson()
                    .add(UpdateJson("title_text").apply { set("text", "Hello CXR-L") })
                    .toJson()
            }) {
                Text(stringResource(R.string.setup_local_preview_text_example))
            }
            Button(onClick = {
                textToggle++
                previewJson = UpdateViewJson()
                    .add(
                        UpdateJson("subtitle_text").apply {
                            set("text", "Text update #$textToggle")
                        },
                    )
                    .toJson()
            }) {
                Text(stringResource(R.string.setup_local_preview_text_toggle))
            }
        }

        OutlinedTextField(
            value = previewJson,
            onValueChange = { previewJson = it },
            label = { Text(stringResource(R.string.setup_local_preview_update_json_label)) },
            modifier = Modifier.fillMaxWidth(),
            minLines = 3,
        )

        Text(
            text = stringResource(
                R.string.setup_local_preview_caps_result,
                CapsFactory.serializeForDisplay(payload),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
