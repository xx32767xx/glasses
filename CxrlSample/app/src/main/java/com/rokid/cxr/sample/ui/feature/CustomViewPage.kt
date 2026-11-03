package com.rokid.cxr.sample.ui.feature

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import com.rokid.cxr.sample.viewmodel.CustomViewViewModel
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel

/**
 * Custom-view feature page (CUSTOM_VIEW only).
 * 自定义视图功能页（仅 CUSTOM_VIEW）。
 */
@Composable
fun CustomViewPage(
    hubViewModel: SessionHubViewModel,
    customViewViewModel: CustomViewViewModel,
) {
    val navController = LocalNavController.current

    val sessionState by hubViewModel.sessionState.collectAsStateWithLifecycle()
    val scenePhase by hubViewModel.scenePhase.collectAsStateWithLifecycle()
    val capabilitiesEnabled by hubViewModel.capabilitiesEnabled.collectAsStateWithLifecycle()
    val pausedReason by hubViewModel.pausedReason.collectAsStateWithLifecycle()
    val closeReason by hubViewModel.closeReason.collectAsStateWithLifecycle()
    val sessionConfig by hubViewModel.sessionConfig.collectAsStateWithLifecycle()

    val updateJson by customViewViewModel.updateJson.collectAsStateWithLifecycle()
    val previewJson by customViewViewModel.previewJson.collectAsStateWithLifecycle()
    val quickCounter by customViewViewModel.quickCounter.collectAsStateWithLifecycle()
    val errorMessage by customViewViewModel.errorMessage.collectAsStateWithLifecycle()
    val lastSentResult by customViewViewModel.lastSentResult.collectAsStateWithLifecycle()

    val sessionType = sessionConfig?.sessionType
    val isCustomView = sessionType == com.rokid.cxr.session.SessionType.CUSTOM_VIEW

    DevSampleScaffold(
        title = stringResource(R.string.custom_view_title),
        subtitle = stringResource(R.string.custom_view_subtitle),
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
            text = stringResource(R.string.custom_view_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Text(
            text = stringResource(R.string.feature_expected_outcome_hint, stringResource(R.string.custom_view_expected_outcome)),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
        )

        if (!isCustomView) {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = androidx.compose.material3.CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer,
                ),
            ) {
                Text(
                    text = stringResource(R.string.custom_view_not_custom_view),
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
                    text = stringResource(R.string.custom_view_quick_example),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = stringResource(R.string.custom_view_quick_example_description),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(
                    onClick = { customViewViewModel.generateQuickExample() },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.custom_view_generate_example, quickCounter))
                }
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
                    text = stringResource(R.string.custom_view_free_edit),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                OutlinedTextField(
                    value = updateJson,
                    onValueChange = { customViewViewModel.setUpdateJson(it) },
                    label = { Text(stringResource(R.string.custom_view_update_json_label)) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 120.dp),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(
                        onClick = { customViewViewModel.preview() },
                        modifier = Modifier.weight(1f),
                    ) {
                        Text(stringResource(R.string.custom_view_validate_preview))
                    }
                    Button(
                        onClick = { customViewViewModel.clear() },
                        modifier = Modifier.weight(1f),
                    ) {
                        Text(stringResource(R.string.action_clear))
                    }
                }
            }
        }

        DevApiButton(
            label = stringResource(R.string.custom_view_update),
            sdkMethod = "CxrSession.customViewUpdate(String)",
            description = stringResource(R.string.custom_view_update_description),
            unavailableReason = buildUnavailableReason(scenePhase, pausedReason),
            expectedOutcome = stringResource(R.string.custom_view_update_expected),
            enabled = capabilitiesEnabled && isCustomView,
            onClick = { customViewViewModel.update() },
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

        lastSentResult?.let {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = androidx.compose.material3.CardDefaults.cardColors(
                    containerColor = if (it.startsWith(stringResource(R.string.custom_view_last_sent_failed, "").trim())) {
                        MaterialTheme.colorScheme.errorContainer
                    } else {
                        MaterialTheme.colorScheme.primaryContainer
                    },
                ),
            ) {
                Text(
                    text = it,
                    modifier = Modifier.padding(12.dp),
                    color = if (it.startsWith(stringResource(R.string.custom_view_last_sent_failed, "").trim())) {
                        MaterialTheme.colorScheme.onErrorContainer
                    } else {
                        MaterialTheme.colorScheme.onPrimaryContainer
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        if (previewJson.isNotBlank()) {
            ElevatedCard(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = stringResource(R.string.custom_view_local_preview),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = previewJson,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState()),
                    )
                }
            }
        }
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
