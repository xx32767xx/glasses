package com.rokid.cxr.sample.model.selfView

/**
 * Compatibility extension for [UpdateViewJson] v1.0.4, added by the v1.1 sample.
 * 为 v1.0.4 的 [UpdateViewJson] 增加的 v1.1 示例兼容扩展。
 *
 * The original 1.0.4 class only exposes [updateList] and [UpdateViewJson.toJson];
 * it has no `add()`/`set()` methods. Existing UI/ViewModel call sites depend on
 * these methods, so we reuse the old API through extensions without modifying the
 * original class.
 * 原始 1.0.4 类只暴露 [updateList] 与 [UpdateViewJson.toJson]，没有 `add()`/`set()` 方法。
 * 现有 UI/ViewModel 调用点依赖这些方法，因此通过扩展复用旧 API，而不修改原类。
 */

/** Legal characters for a CustomView incremental-update node id: letters, digits, and underscores. CustomView 增量更新节点 id 的合法字符：字母、数字和下划线。 */
private val UPDATE_ID_PATTERN = Regex("[a-zA-Z0-9_]+")

/**
 * Whitelist of commonly used CustomView incremental-update property keys.
 * 常用 CustomView 增量更新属性键白名单。
 *
 * Corresponds to the `props` field of the SDK incremental-update JSON.
 * If you need to extend it later, check the SDK documentation before adding keys.
 * 对应 SDK 增量更新 JSON 的 `props` 字段。如需扩展，请先查阅 SDK 文档再添加键。
 */
private val UPDATE_ALLOWED_KEYS = setOf(
    "text",
    "textColor",
    "textSize",
    "textStyle",
    "name",
    "scaleType",
    "backgroundColor",
    "visibility",
    "src",
    "layout_width",
    "layout_height",
    "orientation",
)

/**
 * Add an incremental-update entry by id plus a property map.
 * 通过 id 与属性映射添加一条增量更新条目。
 */
fun UpdateViewJson.add(id: String, props: Map<String, String> = emptyMap()): UpdateViewJson {
    require(id.isNotBlank() && UPDATE_ID_PATTERN.matches(id)) {
        "CustomView node id must be non-blank and match $UPDATE_ID_PATTERN"
    }
    props.keys.forEach { key ->
        require(key in UPDATE_ALLOWED_KEYS) { "CustomView property key '$key' is not in the whitelist" }
    }
    updateList.add(UpdateViewJson.UpdateJson(id).apply { this.props.putAll(props) })
    return this
}

/**
 * Append a ready-built [UpdateViewJson.UpdateJson] directly.
 * 直接追加一个已构建好的 [UpdateViewJson.UpdateJson]。
 */
fun UpdateViewJson.add(item: UpdateViewJson.UpdateJson): UpdateViewJson {
    require(item.id.isNotBlank() && UPDATE_ID_PATTERN.matches(item.id)) {
        "CustomView node id must be non-blank and match $UPDATE_ID_PATTERN"
    }
    updateList.add(item)
    return this
}

/**
 * Set a property on [UpdateViewJson.UpdateJson]; [key] must be in the whitelist.
 * 在 [UpdateViewJson.UpdateJson] 上设置属性；[key] 必须在白名单中。
 */
operator fun UpdateViewJson.UpdateJson.set(key: String, value: String): UpdateViewJson.UpdateJson {
    require(key in UPDATE_ALLOWED_KEYS) { "CustomView property key '$key' is not in the whitelist" }
    props[key] = value
    return this
}
