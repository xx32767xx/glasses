package com.rokid.cxr.sample.ui.feature

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding

import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
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
import com.rokid.cxr.sample.viewmodel.CustomCmdViewModel
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Custom-command feature page (CUSTOM_APP only).
 * 自定义命令功能页（仅 CUSTOM_APP）。
 */
@Composable
fun CustomCmdPage(
    hubViewModel: SessionHubViewModel,
    customCmdViewModel: CustomCmdViewModel,
) {
    val navController = LocalNavController.current

    val sessionState by hubViewModel.sessionState.collectAsStateWithLifecycle()
    val scenePhase by hubViewModel.scenePhase.collectAsStateWithLifecycle()
    val capabilitiesEnabled by hubViewModel.capabilitiesEnabled.collectAsStateWithLifecycle()
    val pausedReason by hubViewModel.pausedReason.collectAsStateWithLifecycle()
    val closeReason by hubViewModel.closeReason.collectAsStateWithLifecycle()
    val sessionConfig by hubViewModel.sessionConfig.collectAsStateWithLifecycle()

    val cmd by customCmdViewModel.cmd.collectAsStateWithLifecycle()
    val channelKey by customCmdViewModel.channelKey.collectAsStateWithLifecycle()
    val payload by customCmdViewModel.payload.collectAsStateWithLifecycle()
    val stream by customCmdViewModel.stream.collectAsStateWithLifecycle()
    val responses by customCmdViewModel.responses.collectAsStateWithLifecycle()
    val errorMessage by customCmdViewModel.errorMessage.collectAsStateWithLifecycle()

    DisposableEffect(Unit) {
        customCmdViewModel.registerCustomCmdCallback()
        onDispose { customCmdViewModel.unregisterCustomCmdCallback() }
    }

    val sessionType = sessionConfig?.sessionType
    val isCustomApp = sessionType == com.rokid.cxr.session.SessionType.CUSTOM_APP

    DevSampleScaffold(
        title = stringResource(R.string.custom_cmd_title),
        subtitle = stringResource(R.string.custom_cmd_subtitle),
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
            text = stringResource(R.string.custom_cmd_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Text(
            text = stringResource(R.string.feature_expected_outcome_hint, stringResource(R.string.custom_cmd_expected_outcome)),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
        )

        if (!isCustomApp) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = androidx.compose.material3.CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer,
                ),
            ) {
                Text(
                    text = stringResource(R.string.custom_cmd_not_custom_app),
                    modifier = Modifier.padding(12.dp),
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        ElevatedCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = stringResource(R.string.custom_cmd_params_title),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                OutlinedTextField(
                    value = cmd,
                    onValueChange = { customCmdViewModel.setCmd(it) },
                    label = { Text("cmd") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = channelKey,
                    onValueChange = { customCmdViewModel.setChannelKey(it) },
                    label = { Text("channelKey") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = payload,
                    onValueChange = { customCmdViewModel.setPayload(it) },
                    label = { Text(stringResource(R.string.custom_cmd_payload_label)) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = stream,
                    onValueChange = { customCmdViewModel.setStream(it) },
                    label = { Text(stringResource(R.string.custom_cmd_stream_label)) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
            }
        }

        DevApiButton(
            label = stringResource(R.string.custom_cmd_send),
            sdkMethod = "CxrSession.sendCustomCmd(String, Caps, ByteArray)",
            description = stringResource(R.string.custom_cmd_send_description),
            unavailableReason = buildUnavailableReason(scenePhase, pausedReason),
            expectedOutcome = stringResource(R.string.custom_cmd_send_expected),
            enabled = capabilitiesEnabled && isCustomApp,
            onClick = { customCmdViewModel.send() },
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

        ElevatedCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = stringResource(R.string.custom_cmd_responses_title),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Button(onClick = { customCmdViewModel.clearResponses() }) {
                        Text(stringResource(R.string.action_clear))
                    }
                }

                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    responses.forEach { response ->
                        CmdResponseItem(response = response)
                    }
                }

                if (responses.isEmpty()) {
                    Text(
                        text = stringResource(R.string.custom_cmd_no_responses),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun CmdResponseItem(response: CustomCmdViewModel.CmdResponse) {
    val time = rememberTimestamp(response.timestampMillis)
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = stringResource(R.string.custom_cmd_response_time, time),
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                text = stringResource(R.string.custom_cmd_response_channel_key, response.channelKey),
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                text = stringResource(R.string.custom_cmd_response_data_size, response.dataSize),
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                text = response.preview,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun rememberTimestamp(timestampMillis: Long): String {
    return remember(timestampMillis) {
        SimpleDateFormat("HH:mm:ss.SSS", Locale.getDefault())
            .format(timestampMillis)
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
