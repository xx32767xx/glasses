package com.rokid.cxr.sample.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.rokid.cxr.sample.model.EventLogItem
import com.rokid.cxr.sample.model.EventLogger

/**
 * Renders a single event log item.
 * 渲染单条事件日志条目。
 */
@Composable
fun EventLogEntry(
    item: EventLogItem,
    modifier: Modifier = Modifier,
) {
    ElevatedCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = "${EventLogger.formatTimestamp(item)} | ${item.category}",
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(text = item.sdkApi, style = MaterialTheme.typography.bodyMedium)
            Text(
                text = "${item.stateBefore} -> ${item.stateAfter}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(text = item.event, style = MaterialTheme.typography.bodySmall)
            item.reason?.let {
                Text(text = "reason: $it", style = MaterialTheme.typography.bodySmall)
            }
            item.errorCode?.let {
                Text(text = "errorCode: $it", style = MaterialTheme.typography.bodySmall)
            }
            item.suggestedAction?.let {
                Text(
                    text = "suggestedAction: $it",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}
