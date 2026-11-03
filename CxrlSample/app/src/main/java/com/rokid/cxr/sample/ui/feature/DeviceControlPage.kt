package com.rokid.cxr.sample.ui.feature

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.navigation.LocalNavController
import com.rokid.cxr.sample.ui.components.DevApiButton
import com.rokid.cxr.sample.ui.components.DevSampleScaffold
import com.rokid.cxr.sample.ui.components.DevStatusCard
import com.rokid.cxr.sample.util.SessionReasonMapping
import com.rokid.cxr.sample.viewmodel.DeviceControlViewModel
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel
import kotlin.math.roundToInt

/**
 * Device-control feature page: brightness/volume sliders and device-info refresh.
 * 设备控制功能页：亮度/音量滑块与设备信息刷新。
 */
@Composable
fun DeviceControlPage(
    hubViewModel: SessionHubViewModel,
    deviceViewModel: DeviceControlViewModel,
) {
    val navController = LocalNavController.current

    val sessionState by hubViewModel.sessionState.collectAsStateWithLifecycle()
    val scenePhase by hubViewModel.scenePhase.collectAsStateWithLifecycle()
    val capabilitiesEnabled by hubViewModel.capabilitiesEnabled.collectAsStateWithLifecycle()
    val pausedReason by hubViewModel.pausedReason.collectAsStateWithLifecycle()
    val closeReason by hubViewModel.closeReason.collectAsStateWithLifecycle()

    val brightness by deviceViewModel.brightness.collectAsStateWithLifecycle()
    val volume by deviceViewModel.volume.collectAsStateWithLifecycle()
    val glassesInfo by deviceViewModel.glassesInfo.collectAsStateWithLifecycle()
    val errorMessage by deviceViewModel.errorMessage.collectAsStateWithLifecycle()

    DevSampleScaffold(
        title = stringResource(R.string.device_title),
        subtitle = stringResource(R.string.device_subtitle),
        showBack = true,
        onBack = { navController?.popBackStack() },
    ) {
        DevStatusCard(
            phase = scenePhase,
            sessionState = sessionState,
            pausedReason = pausedReason,
            closeReason = closeReason,
        )

        Text(
            text = stringResource(R.string.feature_expected_outcome_hint, stringResource(R.string.device_expected_outcome)),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
        )

        LevelSliderCard(
            label = stringResource(R.string.device_brightness_label),
            value = brightness,
            onValueChange = { deviceViewModel.setBrightness(it) },
            enabled = capabilitiesEnabled,
        )

        DevApiButton(
            label = stringResource(R.string.device_apply_brightness),
            sdkMethod = "CxrSession.setGlassBrightness(Int)",
            description = stringResource(R.string.device_brightness_description),
            unavailableReason = buildUnavailableReason(scenePhase, pausedReason),
            expectedOutcome = stringResource(R.string.device_brightness_expected),
            enabled = capabilitiesEnabled,
            onClick = { deviceViewModel.applyBrightness() },
        )

        LevelSliderCard(
            label = stringResource(R.string.device_volume_label),
            value = volume,
            onValueChange = { deviceViewModel.setVolume(it) },
            enabled = capabilitiesEnabled,
        )

        DevApiButton(
            label = stringResource(R.string.device_apply_volume),
            sdkMethod = "CxrSession.setGlassVolume(Int)",
            description = stringResource(R.string.device_volume_description),
            unavailableReason = buildUnavailableReason(scenePhase, pausedReason),
            expectedOutcome = stringResource(R.string.device_volume_expected),
            enabled = capabilitiesEnabled,
            onClick = { deviceViewModel.applyVolume() },
        )

        errorMessage?.let {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = androidx.compose.material3.CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer,
                ),
            ) {
                Text(
                    text = it,
                    modifier = Modifier.padding(12.dp),
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        DevApiButton(
            label = stringResource(R.string.device_refresh_info),
            sdkMethod = "CxrSession.queryGlassesInfo()",
            description = stringResource(R.string.device_refresh_info_description),
            unavailableReason = buildUnavailableReason(scenePhase, pausedReason),
            expectedOutcome = stringResource(R.string.device_refresh_info_expected),
            enabled = capabilitiesEnabled,
            onClick = { deviceViewModel.refreshInfo() },
        )

        ElevatedCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = stringResource(R.string.device_info_title),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                glassesInfo?.let { info ->
                    InfoLine(stringResource(R.string.device_os_version_label), info.osVersion)
                    InfoLine(
                        stringResource(R.string.device_battery_label, info.batteryPercent),
                        "",
                    )
                    InfoLine(
                        stringResource(R.string.device_free_memory_label, info.freeMemoryMb),
                        "",
                    )
                    InfoLine(
                        stringResource(R.string.device_charging_label),
                        if (info.isCharging) {
                            stringResource(R.string.status_yes)
                        } else {
                            stringResource(R.string.status_no)
                        },
                    )
                    InfoLine(
                        stringResource(R.string.device_resolution_label),
                        "${info.displayWidth} x ${info.displayHeight}",
                    )
                    InfoLine(
                        stringResource(R.string.device_screen_on_label),
                        if (info.screenOn) {
                            stringResource(R.string.status_yes)
                        } else {
                            stringResource(R.string.status_no)
                        },
                    )
                } ?: Text(
                    text = stringResource(R.string.device_no_info),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun LevelSliderCard(
    label: String,
    value: Int,
    onValueChange: (Int) -> Unit,
    enabled: Boolean,
) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = "$label：$value",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Slider(
                value = value.toFloat(),
                onValueChange = { onValueChange(it.roundToInt()) },
                valueRange = 0f..100f,
                steps = 99,
                enabled = enabled,
            )
        }
    }
}

@Composable
private fun InfoLine(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun buildUnavailableReason(
    phase: com.rokid.cxr.sample.model.CxrScenePhase?,
    pausedReason: com.rokid.cxr.session.PausedReason?,
): String {
    val context = androidx.compose.ui.platform.LocalContext.current
    if (phase == com.rokid.cxr.sample.model.CxrScenePhase.Paused && pausedReason != null) {
        return context.getString(
            R.string.feature_unavailable_paused,
            context.getString(SessionReasonMapping.pausedReason(pausedReason)),
        )
    }
    return context.getString(
        R.string.feature_unavailable_generic,
        phase?.name ?: context.getString(R.string.feature_no_session_phase),
    )
}
