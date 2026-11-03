package com.rokid.cxr.sample.ui.hub

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.model.CxrFeature
import com.rokid.cxr.sample.model.CxrFeaturePolicy
import com.rokid.cxr.sample.model.CxrScenePhase
import com.rokid.cxr.sample.navigation.HubRoutes
import com.rokid.cxr.sample.navigation.LocalNavController
import com.rokid.cxr.sample.ui.components.CapabilityTile
import com.rokid.cxr.sample.ui.components.DevApiButton
import com.rokid.cxr.sample.ui.components.DevSampleScaffold
import com.rokid.cxr.sample.ui.components.DevStatusCard
import com.rokid.cxr.sample.ui.components.EventLogEntry
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel
import com.rokid.cxr.session.CloseReason
import com.rokid.cxr.session.PausedReason
import com.rokid.cxr.session.SessionState
import com.rokid.cxr.session.SessionType

/**
 * Session hub: status card, phase, capability entries, event-log summary, glasses-event display, and end-session action.
 * 会话中心：状态卡片、阶段、能力入口、事件日志摘要、眼镜事件展示与结束会话操作。
 */
@Composable
fun HubScreen(
    hubViewModel: SessionHubViewModel,
) {
    val navController = LocalNavController.current

    val sessionState by hubViewModel.sessionState.collectAsStateWithLifecycle()
    val scenePhase by hubViewModel.scenePhase.collectAsStateWithLifecycle()
    val capabilitiesEnabled by hubViewModel.capabilitiesEnabled.collectAsStateWithLifecycle()
    val pausedReason by hubViewModel.pausedReason.collectAsStateWithLifecycle()
    val closeReason by hubViewModel.closeReason.collectAsStateWithLifecycle()
    val btConnected by hubViewModel.btConnected.collectAsStateWithLifecycle()
    val eventLog by hubViewModel.eventLog.collectAsStateWithLifecycle()
    val glassesEvents by hubViewModel.glassesEvents.collectAsStateWithLifecycle()
    val sessionConfig by hubViewModel.sessionConfig.collectAsStateWithLifecycle()

    val sessionType = sessionConfig?.sessionType ?: SessionType.CUSTOM_VIEW

    DevSampleScaffold(
        title = stringResource(R.string.hub_title),
        subtitle = stringResource(R.string.hub_subtitle),
    ) {
        DevStatusCard(
            phase = scenePhase,
            sessionState = sessionState,
            pausedReason = pausedReason,
            closeReason = closeReason,
            statusMessage = buildStatusMessage(
                phase = scenePhase,
                btConnected = btConnected,
            ),
        )

        com.rokid.cxr.sample.ui.components.SessionTypeBanner(
            sessionType = sessionType,
            sessionTypeLabel = stringResource(R.string.hub_session_type_label, sessionType.name),
        )

        Text(
            text = stringResource(R.string.hub_feature_entry_title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
        )

        CapabilityGrid(
            sessionType = sessionType,
            capabilitiesEnabled = capabilitiesEnabled,
            onFeatureClick = { route ->
                navController?.navigate(route)
            },
        )

        EventLogSummaryCard(
            entries = eventLog,
            onViewAll = { navController?.navigate(HubRoutes.EVENT_LOG) },
        )

        GlassesEventCard(events = glassesEvents)

        DevApiButton(
            label = stringResource(R.string.hub_end_session),
            sdkMethod = "CxrSession.close()",
            description = stringResource(R.string.hub_end_session_description),
            enabled = sessionState != SessionState.Idle,
            unavailableReason = if (sessionState == SessionState.Idle) {
                stringResource(R.string.hub_no_session)
            } else {
                ""
            },
            onClick = { hubViewModel.endSession() },
        )

        Spacer(modifier = Modifier.height(8.dp))
    }
}

/**
 * Builds the extra status line shown below [DevStatusCard].
 * 构建 [DevStatusCard] 下方展示的额外状态行。
 *
 * Note: pausedReason / closeReason are already displayed by [DevStatusCard] through its internal
 * Chinese mapping layer, so here we only add Bluetooth status and the no-session hint to avoid duplication.
 *
 * 注意：pausedReason / closeReason 已由 [DevStatusCard] 通过其内部中文映射层展示，因此这里只补充蓝牙状态与无会话提示，避免重复。
 */
@Composable
private fun buildStatusMessage(
    phase: CxrScenePhase?,
    btConnected: Boolean,
): String {
    val sb = StringBuilder()
    if (phase == null) {
        sb.append(stringResource(R.string.hub_no_session))
    }
    if (!btConnected && phase != null && phase != CxrScenePhase.Paused) {
        if (sb.isNotEmpty()) sb.append("；")
        sb.append(stringResource(R.string.hub_bt_not_connected))
    }
    return sb.toString()
}

@Composable
private fun CapabilityGrid(
    sessionType: SessionType,
    capabilitiesEnabled: Boolean,
    onFeatureClick: (String) -> Unit,
) {
    val features = CxrFeaturePolicy.allowedFeatures(sessionType)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        features.chunked(2).forEach { rowFeatures ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                rowFeatures.forEach { feature ->
                    CapabilityTile(
                        label = stringResource(feature.labelRes),
                        enabled = capabilitiesEnabled,
                        onClick = { onFeatureClick(feature.route) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun EventLogSummaryCard(
    entries: List<com.rokid.cxr.sample.model.EventLogItem>,
    onViewAll: () -> Unit,
) {
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
                    text = stringResource(R.string.hub_event_log_summary),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                androidx.compose.material3.TextButton(onClick = onViewAll) {
                    Text(stringResource(R.string.action_view_all))
                }
            }

            if (entries.isEmpty()) {
                Text(
                    text = stringResource(R.string.hub_no_event_logs),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                entries.take(3).forEach { item ->
                    EventLogEntry(item = item)
                }
            }
        }
    }
}

@Composable
private fun GlassesEventCard(
    events: List<String>,
) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = stringResource(R.string.hub_glasses_events_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = stringResource(R.string.hub_glasses_events_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (events.isEmpty()) {
                Text(
                    text = stringResource(R.string.hub_no_glasses_events),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                events.take(5).forEach { event ->
                    Text(
                        text = event,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}
