package com.rokid.cxr.sample.ui.components

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.model.CxrFeature
import com.rokid.cxr.sample.model.CxrFeaturePolicy
import com.rokid.cxr.sample.model.CxrScenePhase
import com.rokid.cxr.sample.util.SessionReasonMapping
import com.rokid.cxr.session.CloseReason
import com.rokid.cxr.session.PausedReason
import com.rokid.cxr.session.SessionState
import com.rokid.cxr.session.SessionType

/**
 * v1.1 Sample design system.
 * v1.1 示例设计系统。
 *
 * Composables in this file take String parameters; copy is provided by callers via [stringResource].
 * 本文件中的 Composable 接收 String 参数；文案由调用方通过 [stringResource] 提供。
 */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevSampleScaffold(
    title: String,
    subtitle: String? = null,
    showBack: Boolean = false,
    onBack: () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(title, style = MaterialTheme.typography.titleLarge)
                        subtitle?.let {
                            Text(
                                text = it,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                navigationIcon = {
                    if (showBack) {
                        IconButton(onClick = onBack) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = stringResource(R.string.action_back_content_description),
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 20.dp, vertical = 16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
        Spacer(modifier = Modifier.height(8.dp))
    }
}

/**
 * Status card: shows the current phase, the five-state badge, reasons, and recovery hints.
 * 状态卡片：展示当前阶段、五态标识、原因与恢复提示。
 *
 * @param phase Current scene phase; null means no session. 当前场景阶段；null 表示无会话。
 * @param sessionState SDK five-state value. SDK 五态值。
 * @param pausedReason Pause reason; non-null only when [SessionState.Paused]. 暂停原因；仅在 [SessionState.Paused] 时非空。
 * @param closeReason Most recent close reason; optional. 最近的关闭原因；可选。
 * @param statusMessage Additional status description. 额外状态说明。
 */
@Composable
fun DevStatusCard(
    phase: CxrScenePhase?,
    sessionState: SessionState,
    pausedReason: PausedReason? = null,
    closeReason: CloseReason? = null,
    statusMessage: String? = null,
    modifier: Modifier = Modifier,
) {
    ElevatedCard(modifier = modifier.fillMaxWidth()) {
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
                    text = stringResource(R.string.status_card_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                DevStatusBadge(status = sessionState.toBadgeStatus())
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = stringResource(
                        R.string.status_card_phase_label,
                        phase?.let { stringResource(it.labelRes()) }
                            ?: stringResource(R.string.phase_none),
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    text = stringResource(
                        R.string.status_card_sdk_state_label,
                        sessionState.name,
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            pausedReason?.let {
                Text(
                    text = pausedReasonMessage(it),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onTertiaryContainer,
                )
            }

            closeReason?.let {
                Text(
                    text = stringResource(
                        R.string.status_card_close_reason_label,
                        closeReasonLabel(it),
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (!statusMessage.isNullOrBlank()) {
                Text(
                    text = statusMessage,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * Capability API button.
 * 能力 API 按钮。
 *
 * @param label Primary button label. 主按钮文案。
 * @param sdkMethod SDK method name shown as subtitle. 作为副标题展示的 SDK 方法名。
 * @param description Capability description. 能力描述。
 * @param unavailableReason Prerequisite explanation shown when disabled. 禁用时展示的前提说明。
 * @param expectedOutcome Expected-result copy (what the user will see on success). 预期结果文案（成功时用户将看到的内容）。
 * @param enabled Whether the button is clickable. 按钮是否可点击。
 */
@Composable
fun DevApiButton(
    label: String,
    sdkMethod: String,
    description: String = "",
    unavailableReason: String = "",
    expectedOutcome: String = "",
    enabled: Boolean = true,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                DevStatusBadge(
                    status = if (enabled) DevBadgeStatus.SUCCESS else DevBadgeStatus.BLOCKED,
                )
            }

            Text(
                text = sdkMethod,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.outline,
            )

            if (description.isNotBlank()) {
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (expectedOutcome.isNotBlank()) {
                Text(
                    text = stringResource(R.string.feature_expected_outcome_hint, expectedOutcome),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }

            if (!enabled && unavailableReason.isNotBlank()) {
                Text(
                    text = stringResource(R.string.feature_prerequisite_prefix, unavailableReason),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Button(
                onClick = onClick,
                enabled = enabled,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .testTag("api_button_$sdkMethod")
                    .semantics {
                        contentDescription = "$label; SDK $sdkMethod"
                    },
            ) {
                Text(text = label)
            }
        }
    }
}

/**
 * Semantic status badge.
 * 语义状态标识。
 *
 * Status semantics:
 * - [DevBadgeStatus.NOT_STARTED] Not started.
 * - [DevBadgeStatus.IN_PROGRESS] In progress.
 * - [DevBadgeStatus.SUCCESS] Success / available.
 * - [DevBadgeStatus.BLOCKED] Blocked / unavailable.
 * - [DevBadgeStatus.FAILED] Failed.
 *
 * 状态语义：
 * - [DevBadgeStatus.NOT_STARTED] 未开始。
 * - [DevBadgeStatus.IN_PROGRESS] 进行中。
 * - [DevBadgeStatus.SUCCESS] 成功 / 可用。
 * - [DevBadgeStatus.BLOCKED] 阻塞 / 不可用。
 * - [DevBadgeStatus.FAILED] 失败。
 */
enum class DevBadgeStatus {
    NOT_STARTED,
    IN_PROGRESS,
    SUCCESS,
    BLOCKED,
    FAILED,
}

@Composable
fun DevStatusBadge(
    status: DevBadgeStatus,
    modifier: Modifier = Modifier,
) {
    val (text, backgroundColor, contentColor) = when (status) {
        DevBadgeStatus.NOT_STARTED -> Triple(
            stringResource(R.string.status_not_started),
            MaterialTheme.colorScheme.surfaceVariant,
            MaterialTheme.colorScheme.onSurfaceVariant,
        )
        DevBadgeStatus.IN_PROGRESS -> Triple(
            stringResource(R.string.status_in_progress),
            MaterialTheme.colorScheme.tertiaryContainer,
            MaterialTheme.colorScheme.onTertiaryContainer,
        )
        DevBadgeStatus.SUCCESS -> Triple(
            stringResource(R.string.status_available),
            MaterialTheme.colorScheme.primaryContainer,
            MaterialTheme.colorScheme.onPrimaryContainer,
        )
        DevBadgeStatus.BLOCKED -> Triple(
            stringResource(R.string.status_blocked),
            MaterialTheme.colorScheme.surfaceVariant,
            MaterialTheme.colorScheme.onSurfaceVariant,
        )
        DevBadgeStatus.FAILED -> Triple(
            stringResource(R.string.status_failed),
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
        )
    }
    Surface(
        modifier = modifier,
        color = backgroundColor,
        shape = MaterialTheme.shapes.small,
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelSmall,
            color = contentColor,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
fun CapabilityTile(
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = if (enabled) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            },
        ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.titleSmall,
                color = if (enabled) {
                    MaterialTheme.colorScheme.onPrimaryContainer
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
            DevStatusBadge(status = if (enabled) DevBadgeStatus.SUCCESS else DevBadgeStatus.BLOCKED)
        }
    }
}

@Composable
fun PrerequisiteHint(
    message: String,
    modifier: Modifier = Modifier,
) {
    OutlinedCard(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.outlinedCardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Text(
            text = message,
            modifier = Modifier.padding(12.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
fun FlowStepIndicator(
    steps: List<String>,
    currentIndex: Int,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        steps.forEachIndexed { index, label ->
            FilterChip(
                selected = index == currentIndex,
                onClick = {},
                enabled = false,
                label = { Text(label, style = MaterialTheme.typography.labelMedium) },
            )
        }
    }
}

/**
 * Collapsible teaching-section item.
 * 可折叠教学区域项。
 *
 * This is a controlled component; use [DevProgressiveSectionSaveable] if you need internal expanded-state management.
 * 受控组件；如需内部展开状态管理，请使用 [DevProgressiveSectionSaveable]。
 */
@Composable
fun DevProgressiveSection(
    id: String,
    title: String,
    summary: String,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    ElevatedCard(
        modifier = modifier
            .fillMaxWidth()
            .testTag("progressive_section_$id"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            if (!expanded) {
                Text(
                    text = summary,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("progressive_summary_$id"),
                )
                TextButton(
                    onClick = { onExpandedChange(true) },
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .testTag("progressive_expand_$id"),
                ) {
                    Text(stringResource(R.string.action_expand))
                }
            } else {
                content()
                TextButton(
                    onClick = { onExpandedChange(false) },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(stringResource(R.string.action_collapse))
                }
            }
        }
    }
}

/**
 * Collapsible teaching-section item that uses [rememberSaveable] internally to manage its expanded state.
 * 使用 [rememberSaveable] 内部管理展开状态的可折叠教学区域项。
 */
@Composable
fun DevProgressiveSectionSaveable(
    id: String,
    title: String,
    summary: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    DevProgressiveSection(
        id = id,
        title = title,
        summary = summary,
        expanded = expanded,
        onExpandedChange = { expanded = it },
        modifier = modifier,
        content = content,
    )
}

/**
 * Session-type banner: shows the current session type and allowed capability entries.
 * 会话类型横幅：展示当前会话类型与允许的能力入口。
 *
 * @param sessionType Current session type. 当前会话类型。
 * @param sessionTypeLabel Display copy for the session type. 会话类型的展示文案。
 */
@Composable
fun SessionTypeBanner(
    sessionType: SessionType,
    sessionTypeLabel: String,
    modifier: Modifier = Modifier,
) {
    val features = CxrFeaturePolicy.allowedFeatures(sessionType)
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.primaryContainer,
        shape = MaterialTheme.shapes.medium,
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = sessionTypeLabel,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
                fontWeight = FontWeight.SemiBold,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                features.forEach { feature ->
                    AssistChip(
                        onClick = {},
                        enabled = false,
                        label = { Text(text = stringResource(feature.labelRes)) },
                    )
                }
            }
            Text(
                text = stringResource(R.string.hub_allowed_features_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
    }
}

// ---------- Internal helpers 内部辅助方法 ----------

private fun SessionState.toBadgeStatus(): DevBadgeStatus = when (this) {
    SessionState.Idle -> DevBadgeStatus.NOT_STARTED
    SessionState.Starting -> DevBadgeStatus.IN_PROGRESS
    SessionState.Started -> DevBadgeStatus.SUCCESS
    SessionState.Paused -> DevBadgeStatus.BLOCKED
    SessionState.Terminating -> DevBadgeStatus.IN_PROGRESS
}

@StringRes
private fun CxrScenePhase.labelRes(): Int = when (this) {
    CxrScenePhase.Connecting -> R.string.phase_connecting
    CxrScenePhase.SceneNotReady -> R.string.phase_scene_not_ready
    CxrScenePhase.Paused -> R.string.phase_paused
    CxrScenePhase.CapabilitiesReady -> R.string.phase_capabilities_ready
}

@Composable
private fun pausedReasonMessage(reason: PausedReason): String {
    val context = LocalContext.current
    return context.getString(SessionReasonMapping.pausedReason(reason))
}

@Composable
private fun closeReasonLabel(reason: CloseReason): String {
    val context = LocalContext.current
    return context.getString(SessionReasonMapping.closeReason(reason))
}
