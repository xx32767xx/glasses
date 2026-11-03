package com.rokid.cxr.sample.model

import com.rokid.cxr.sample.R

/**
 * Local validator for CustomView JSON.
 * CustomView JSON 本地校验器。
 *
 * Performs format and required-field checks before handing
 * [com.rokid.cxr.session.SessionConfig.viewData] or incremental-update JSON to the SDK, avoiding
 * meaningless upstream calls.
 * 在将 [com.rokid.cxr.session.SessionConfig.viewData] 或增量更新 JSON 交给 SDK 之前做格式与必填字段检查，避免无意义的上游调用。
 *
 * Note: this validator only performs lightweight structural checks; full JSON syntax validation
 * happens on the device/at runtime.
 * 注意：本校验器只做轻量级结构检查，完整 JSON 语法校验在设备端/运行时进行。
 */
object CustomViewJsonValidator {

    /** Four root component types supported by CustomView. */
    private val VALID_VIEW_TYPES = setOf("LinearLayout", "RelativeLayout", "TextView", "ImageView")

    /** Valid characters for id: letters, digits, and underscores. */
    private val ID_PATTERN = Regex("[a-zA-Z0-9_]+")

    /**
     * Extracts the first non-empty value of the specified string field from JSON text (without full
     * JSON parsing).
     * 从 JSON 文本中提取指定字符串字段的第一个非空值（不做完整 JSON 解析）。
     *
     * In the CustomView template, `id` is inside `props`, so matching all `"id"` fields in order of
     * appearance and taking the first non-empty value covers both root and child node scenarios.
     * 在 CustomView 模板中，`id` 位于 `props` 内，因此按出现顺序匹配所有 `"id"` 字段并取第一个非空值，可覆盖根节点和子节点场景。
     *
     * Used only for structural validation; complex escape/nested scenarios are handled by the full
     * runtime parser.
     * 仅用于结构校验；复杂转义/嵌套场景由完整运行时解析器处理。
     */
    private fun extractStringField(json: String, field: String): String? {
        val regex = Regex(""""$field"\s*:\s*"([^"]*)""")
        return regex.findAll(json)
            .map { it.groupValues[1] }
            .firstOrNull { it.isNotBlank() }
    }

    /**
     * Validates viewData (full CustomView JSON).
     * 校验 viewData（完整 CustomView JSON）。
     *
     * Rules:
     * - Root node must be an object starting with `{` and ending with `}`
     * - Root node must contain `type` and `id`
     * - `type` must be in the component whitelist
     *
     * 规则：
     * - 根节点必须是对象（以 `{` 开头、`}` 结尾）
     * - 根节点必须包含 `type` 和 `id`
     * - `type` 必须在组件白名单中
     *
     * Note: full JSON syntax validation happens on the device/at runtime.
     * 注意：完整 JSON 语法校验在设备端/运行时进行。
     *
     * @param getString String resolver so the validator can stay Context-free.
     *                  字符串解析器，使校验器无需依赖 Context。
     */
    fun validateViewData(getString: (Int) -> String, json: String): Result<Unit> {
        val trimmed = json.trim()
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
            return Result.failure(IllegalArgumentException(getString(R.string.custom_view_json_root_must_be_object)))
        }

        val type = extractStringField(trimmed, "type")
            ?: return Result.failure(IllegalArgumentException(getString(R.string.custom_view_json_root_missing_type)))
        if (type !in VALID_VIEW_TYPES) {
            return Result.failure(
                IllegalArgumentException(
                    String.format(
                        getString(R.string.custom_view_json_root_invalid_type),
                        type,
                        VALID_VIEW_TYPES,
                    ),
                ),
            )
        }

        val id = extractStringField(trimmed, "id")
            ?: return Result.failure(IllegalArgumentException(getString(R.string.custom_view_json_root_missing_id)))
        if (id.isBlank() || !ID_PATTERN.matches(id)) {
            return Result.failure(IllegalArgumentException(getString(R.string.custom_view_json_root_invalid_id)))
        }

        return Result.success(Unit)
    }

    /**
     * Validates incremental-update JSON (parameter for
     * [com.rokid.cxr.session.CxrSession.customViewUpdate]).
     * 校验增量更新 JSON（[com.rokid.cxr.session.CxrSession.customViewUpdate] 的参数）。
     *
     * Rules:
     * - Must be an array starting with `[` and ending with `]`
     * - Must contain `action="update"` and a valid `id`
     * - Must contain the `props` field
     *
     * 规则：
     * - 必须是数组（以 `[` 开头、`]` 结尾）
     * - 必须包含 `action="update"` 与有效 `id`
     * - 必须包含 `props` 字段
     *
     * Note: full JSON syntax validation happens on the device/at runtime.
     * 注意：完整 JSON 语法校验在设备端/运行时进行。
     *
     * @param getString String resolver so the validator can stay Context-free.
     *                  字符串解析器，使校验器无需依赖 Context。
     */
    fun validateUpdateJson(getString: (Int) -> String, json: String): Result<Unit> {
        val trimmed = json.trim()
        if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
            return Result.failure(IllegalArgumentException(getString(R.string.custom_view_update_json_must_be_array)))
        }
        if (trimmed.length <= 2) {
            return Result.failure(IllegalArgumentException(getString(R.string.custom_view_update_json_empty_array)))
        }

        val actions = extractAllStringFields(trimmed, "action")
        if (actions.isEmpty() || actions.any { it != "update" }) {
            return Result.failure(IllegalArgumentException(getString(R.string.custom_view_update_action_must_be_update)))
        }

        val ids = extractAllStringFields(trimmed, "id")
        if (ids.isEmpty() || ids.any { it.isBlank() || !ID_PATTERN.matches(it) }) {
            return Result.failure(IllegalArgumentException(getString(R.string.custom_view_update_id_invalid)))
        }

        if (!trimmed.contains("\"props\"")) {
            return Result.failure(IllegalArgumentException(getString(R.string.custom_view_update_missing_props)))
        }

        return Result.success(Unit)
    }

    private fun extractAllStringFields(json: String, field: String): List<String> {
        val regex = Regex(""""$field"\s*:\s*"([^"]*)""")
        return regex.findAll(json).map { it.groupValues[1] }.toList()
    }
}
