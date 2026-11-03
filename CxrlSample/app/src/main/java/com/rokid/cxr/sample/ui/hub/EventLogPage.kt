package com.rokid.cxr.sample.ui.hub

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogItem
import com.rokid.cxr.sample.ui.components.EventLogEntry

/**
 * Event-log page.
 * 事件日志页。
 *
 * @param entries List of log entries. 日志条目列表。
 * @param eventFilter Current filter; null means ALL. 当前筛选器；null 表示全部。
 * @param onFilterChange Callback when the filter changes. 筛选器变化时的回调。
 * @param lastExportPath Path of the most recent export. 最近一次导出的路径。
 * @param onClearLog Callback to clear the log. 清空日志的回调。
 * @param onExportLog Callback to export the log. 导出日志的回调。
 */
@Composable
fun EventLogPage(
    entries: List<EventLogItem>,
    eventFilter: EventCategory? = null,
    onFilterChange: (EventCategory?) -> Unit = {},
    lastExportPath: String? = null,
    onClearLog: () -> Unit = {},
    onExportLog: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var expanded by remember { mutableStateOf(false) }
    val filteredEntries = entries.filter { item ->
        eventFilter == null || item.category == eventFilter
    }
    ElevatedCard(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                stringResource(R.string.event_log_page_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Column {
                OutlinedButton(onClick = { expanded = true }) {
                    Text(
                        stringResource(
                            R.string.event_log_filter,
                            eventFilter?.name ?: "ALL",
                        ),
                    )
                }
                DropdownMenu(
                    expanded = expanded,
                    onDismissRequest = { expanded = false },
                ) {
                    DropdownMenuItem(
                        text = { Text("ALL") },
                        onClick = {
                            expanded = false
                            onFilterChange(null)
                        },
                    )
                    EventCategory.values().forEach { category ->
                        DropdownMenuItem(
                            text = { Text(category.name) },
                            onClick = {
                                expanded = false
                                onFilterChange(category)
                            },
                        )
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onClearLog) { Text(stringResource(R.string.event_log_clear)) }
                OutlinedButton(onClick = onExportLog) { Text(stringResource(R.string.event_log_export)) }
            }
            Text(
                text = stringResource(R.string.event_log_last_export, lastExportPath ?: "-"),
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                text = stringResource(R.string.event_log_export_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (filteredEntries.isEmpty()) {
                Text(
                    stringResource(R.string.event_log_empty),
                    style = MaterialTheme.typography.bodySmall,
                )
            } else {
                filteredEntries.forEach { item ->
                    EventLogEntry(item = item)
                }
            }
        }
    }
}
