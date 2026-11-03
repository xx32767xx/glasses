package com.rokid.cxr.sample.model.selfView

import kotlin.collections.iterator

/**
 * Custom-view update protocol model.
 * CustomView 增量更新协议模型。
 *
 * Describes one or multiple node delta updates in a single request.
 * 描述一次请求中一个或多个节点的增量更新。
 */
class UpdateViewJson {
    // A single update call can carry incremental updates for multiple nodes. 一次更新调用可携带多个节点的增量更新。
    val updateList = mutableListOf<UpdateJson>()
    /**
     * Update item for a single node.
     * 单个节点的更新项。
     *
     * @property id Target node id. 目标节点 id。
     */
    class UpdateJson(val id: String){
        // This sample only uses "update", distinct from open/close actions. 本示例只使用 "update"，与 open/close 动作区分。
        val action = "update"
        // Include changed fields only to avoid re-sending full node payload. 仅包含变更字段，避免重复发送完整节点载荷。
        var props: HashMap<String, String> = HashMap()
    }

    /**
     * Serializes to update JSON array required by SDK.
     * 序列化为 SDK 所需的增量更新 JSON 数组。
     */
    fun toJson(): String {
        // Output format: [{"action":"update","id":"textView","props":{"text":"..."}}] 输出格式：...
        val sb: StringBuilder = StringBuilder("[")

        for (update in updateList) {
            sb.append("{")
            sb.append("\"action\":\"${update.action}\",")
            sb.append("\"id\":\"${update.id}\",")
            sb.append("\"props\":{")

            for ((key, value) in update.props) {
                sb.append("\"$key\":\"$value\",")
            }

            sb.deleteCharAt(sb.length - 1)
            sb.append("}")
            sb.append("},")
        }
        sb.deleteCharAt(sb.length - 1)

        sb.append("]")
        return sb.toString()
    }
}
