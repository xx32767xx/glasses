package com.rokid.cxr.sample.model.selfView

/**
 * LinearLayout node property model.
 * LinearLayout 节点属性模型。
 *
 * Provides validation for common layout fields
 * and supports protocol JSON output.
 * 提供常见布局字段校验并支持协议 JSON 输出。
 */
class LinearLayoutProps {

    var id: String = ""
        set(value) {
            field = if (value.matches(Regex("[a-zA-Z0-9_]+"))) {
                value
            } else {
                throw IllegalArgumentException("id must be a valid identifier")
            }
        }

    var layout_width: String = "match_parent"
        set(value) {
            field =
                if (value == "match_parent" || value == "wrap_content" || value.endsWith("dp")) {
                    value
                } else if (value.matches(Regex("\\d+"))) {
                    // If only a number is provided, append dp automatically. 若只输入数字，自动追加 dp。
                    "${value}dp"
                } else {
                    throw IllegalArgumentException("layout_width must be 'match_parent', 'wrap_content', or a value ending with 'dp'")
                }
        }

    var layout_height: String = "match_parent"
        set(value) {
            field =
                if (value == "match_parent" || value == "wrap_content" || value.endsWith("dp")) {
                    value
                } else if (value.matches(Regex("\\d+"))) {
                    // If only a number is provided, append dp automatically. 若只输入数字，自动追加 dp。
                    "${value}dp"
                } else {
                    throw IllegalArgumentException("layout_height must be 'match_parent', 'wrap_content', or a value ending with 'dp'")
                }
        }
    var orientation: String = "vertical"
        set(value) {
            field = when (value) {
                "vertical", "horizontal" -> value
                else -> throw IllegalArgumentException("orientation must be 'vertical' or 'horizontal'")
            }
        }
    var gravity: String? = null
        set(value) {
            field = when (value) {
                "center", "center_vertical", "center_horizontal", "top", "bottom", "start", "end" -> value
                else -> throw IllegalArgumentException("gravity must be 'center', 'center_vertical', 'center_horizontal', 'top', 'bottom', 'left', or 'right'")
            }
        }

    var layout_gravity: String? = null
        set(value) {
            field = when (value) {
                "center", "center_vertical", "center_horizontal", "top", "bottom", "start", "end" -> value
                else -> throw IllegalArgumentException("layout_gravity must be 'center', 'center_vertical', 'center_horizontal', 'top', 'bottom', 'left', or 'right'")
            }
        }
    var paddingTop: String? = null
        set(value) {
            field = if (value == null || value.endsWith("dp")) {
                value
            } else if (value.matches(Regex("\\d+"))) {
                // If only a number is provided, append dp automatically.
                "${value}dp"
            } else {
                throw IllegalArgumentException("paddingTop must be null or a value ending with 'dp'")
            }
        }
    var paddingBottom: String? = null
        set(value) {
            field = if (value == null || value.endsWith("dp")) {
                value
            } else if (value.matches(Regex("\\d+"))) {
                // If only a number is provided, append dp automatically.
                "${value}dp"
            } else {
                throw IllegalArgumentException("paddingBottom must be null or a value ending with 'dp'")
            }
        }
    var paddingStart: String? = null
        set(value) {
            field = if (value == null || value.endsWith("dp")) {
                value
            } else if (value.matches(Regex("\\d+"))) {
                // If only a number is provided, append dp automatically.
                "${value}dp"
            } else {
                throw IllegalArgumentException("paddingStart must be a value ending with 'dp'")
            }
        }
    var paddingEnd: String? = null
        set(value) {
            field = if (value == null || value.endsWith("dp")) {
                value
            } else if (value.matches(Regex("\\d+"))) {
                // If only a number is provided, append dp automatically.
                "${value}dp"
            } else {
                throw IllegalArgumentException("paddingEnd must be a value ending with 'dp'")
            }
        }

    // Background color is converted to grayscale-biased green channel for current display style. 背景色转换为灰度偏绿的绿色通道，以适配当前显示风格。
    var backgroundColor: String? = null
        set(value) {
            field = if (value == null) {
                null
            } else {
                processColorToGrayToGreen(value)
            }
        }

    var marginStart: String? = null
        set(value) {
            field = if (value == null || value.endsWith("dp")) {
                value
            } else if (value.matches(Regex("\\d+"))) {
                // If only a number is provided, append dp automatically.
                "${value}dp"
            } else {
                throw IllegalArgumentException("marginStart must be null or a value ending with 'dp'")
            }
        }

    var marginEnd: String? = null
        set(value) {
            field = if (value == null || value.endsWith("dp")) {
                value
            } else if (value.matches(Regex("\\d+"))) {
                // If only a number is provided, append dp automatically.
                "${value}dp"
            } else {
                throw IllegalArgumentException("marginEnd must be null or a value ending with 'dp'")
            }
        }

    var marginTop: String? = null
        set(value) {
            field = if (value == null || value.endsWith("dp")) {
                value
            } else if (value.matches(Regex("\\d+"))) {
                // If only a number is provided, append dp automatically.
                "${value}dp"
            } else {
                throw IllegalArgumentException("marginTop must be null or a value ending with 'dp'")
            }
        }

    var marginBottom: String? = null
        set(value) {
            field = if (value == null || value.endsWith("dp")) {
                value
            } else if (value.matches(Regex("\\d+"))) {
                // If only a number is provided, append dp automatically.
                "${value}dp"
            } else {
                throw IllegalArgumentException("marginBottom must be null or a value ending with 'dp'")
            }
        }

/**
     * Serializes into `props` JSON used by custom-view protocol.
     * 序列化为自定义视图协议使用的 `props` JSON。
     */
    fun toJson(): String {
        return if (id.isEmpty()) {
            throw IllegalArgumentException("id can not be empty")
        } else {
            val sb: StringBuilder = StringBuilder().append("{\"id\":\"$id\"")
                .append(",\"layout_width\":\"$layout_width\"")
                .append(",\"layout_height\":\"$layout_height\"")
                .append(",\"orientation\":\"$orientation\"")
            if (gravity != null) {
                sb.append(",\"gravity\":\"$gravity\"")
            }
            if (layout_gravity != null) {
                sb.append(",\"layout_gravity\":\"$layout_gravity\"")
            }
            if (paddingTop != null) {
                sb.append(",\"paddingTop\":\"$paddingTop\"")
            }
            if (paddingBottom != null) {
                sb.append(",\"paddingBottom\":\"$paddingBottom\"")
            }
            if (paddingStart != null) {
                sb.append(",\"paddingLeft\":\"$paddingStart\"")
            }
            if (paddingEnd != null) {
                sb.append(",\"paddingRight\":\"$paddingEnd\"")
            }
            if (backgroundColor != null) {
                sb.append(",\"backgroundColor\":\"$backgroundColor\"")
            }
            if (marginStart != null) {
                sb.append(",\"marginStart\":\"$marginStart\"")
            }
            if (marginEnd != null) {
                sb.append(",\"marginEnd\":\"$marginEnd\"")
            }
            if (marginTop != null) {
                sb.append(",\"marginTop\":\"$marginTop\"")
            }
            if (marginBottom != null) {
                sb.append(",\"marginBottom\":\"$marginBottom\"")
            }
            sb.append("}").toString()
        }
    }
}
