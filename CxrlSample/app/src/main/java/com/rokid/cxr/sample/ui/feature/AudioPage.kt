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
import com.rokid.cxr.sample.viewmodel.AudioViewModel
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Audio feature page: start/stop audio stream and display the audio-event list.
 * 音频功能页：开始/停止音频流并展示音频事件列表。
 */
@Composable
fun AudioPage(
    hubViewModel: SessionHubViewModel,
    audioViewModel: AudioViewModel,
) {
    val navController = LocalNavController.current

    val sessionState by hubViewModel.sessionState.collectAsStateWithLifecycle()
    val scenePhase by hubViewModel.scenePhase.collectAsStateWithLifecycle()
    val capabilitiesEnabled by hubViewModel.capabilitiesEnabled.collectAsStateWithLifecycle()
    val pausedReason by hubViewModel.pausedReason.collectAsStateWithLifecycle()
    val closeReason by hubViewModel.closeReason.collectAsStateWithLifecycle()

    val isStreaming by audioViewModel.isStreaming.collectAsStateWithLifecycle()
    val audioEvents by audioViewModel.audioEvents.collectAsStateWithLifecycle()
    val errorMessage by audioViewModel.errorMessage.collectAsStateWithLifecycle()

    DisposableEffect(Unit) {
        audioViewModel.registerAudioCallback()
        onDispose { audioViewModel.unregisterAudioCallback() }
    }

    DevSampleScaffold(
        title = stringResource(R.string.audio_title),
        subtitle = stringResource(R.string.audio_subtitle),
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
            text = stringResource(R.string.feature_expected_outcome_hint, stringResource(R.string.audio_expected_outcome)),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
        )

        DevApiButton(
            label = if (isStreaming) {
                stringResource(R.string.audio_stop_stream)
            } else {
                stringResource(R.string.audio_start_stream)
            },
            sdkMethod = "CxrSession.startAudioStream()",
            description = stringResource(R.string.audio_start_description),
            unavailableReason = buildUnavailableReason(scenePhase, pausedReason),
            expectedOutcome = stringResource(R.string.audio_start_expected),
            enabled = capabilitiesEnabled,
            onClick = { audioViewModel.start() },
        )

        DevApiButton(
            label = stringResource(R.string.audio_stop_stream),
            sdkMethod = "CxrSession.stopAudioStream()",
            description = stringResource(R.string.audio_stop_description),
            unavailableReason = buildUnavailableReason(scenePhase, pausedReason),
            expectedOutcome = stringResource(R.string.audio_stop_expected),
            enabled = capabilitiesEnabled,
            onClick = { audioViewModel.stop() },
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
                        text = stringResource(R.string.audio_events_title, audioEvents.size),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Button(onClick = { audioViewModel.clearEvents() }) {
                        Text(stringResource(R.string.action_clear))
                    }
                }

                Column(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    audioEvents.forEach { event ->
                        AudioEventItem(event = event)
                    }
                }
            }
        }
    }
}

@Composable
private fun AudioEventItem(event: AudioViewModel.AudioEvent) {
    val time = rememberTimestamp(event.timestampMillis)
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = stringResource(R.string.audio_event_time, time),
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                text = stringResource(R.string.audio_event_bytes, event.bytes),
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                text = stringResource(
                    R.string.audio_event_stream_state,
                    if (event.isStreaming) {
                        stringResource(R.string.audio_stream_active)
                    } else {
                        stringResource(R.string.audio_stream_stopped)
                    },
                ),
                style = MaterialTheme.typography.bodySmall,
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
