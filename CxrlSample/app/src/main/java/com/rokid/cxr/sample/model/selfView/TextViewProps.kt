package com.rokid.cxr.sample.model.selfView

/**
 * TextView node property model.
 * TextView 节点属性模型。
 *
 * Validates field values and serializes into protocol JSON.
 * 校验字段值并序列化为协议 JSON。
 */
class TextViewProps {
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
    var layout_height: String = "wrap_content"
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
    var text: String = "NONE"

    var textColor: String? = null
        set(value) {
            field = if (value == null) {
                value
            } else {
                processColorToGrayToGreen(value)
            }
        }

    var textSize: String? = null
        set(value) {
            field = if (value == null || value.matches(Regex("[0-9]+sp"))) {
                value
            } else if (value.matches(Regex("[0-9]+"))) {
                value + "sp"
            } else {
                throw IllegalArgumentException("textSize must be a valid size")
            }
        }
    var gravity: String? = null
        set(value) {
            field = when (value) {
                "center", "center_vertical", "center_horizontal", "start", "end", "top", "bottom" -> value
                else -> throw IllegalArgumentException("gravity must be one of the following: center, center_vertical, center_horizontal, start, end, top, bottom")
            }
        }
    var textStyle: String? = null
        set(value) {
            field = when (value) {
                "bold", "italic", "bold_italic" -> value
                else -> throw IllegalArgumentException("textStyle must be one of the following: bold, italic, bold_italic")
            }
        }
    var paddingStart: String? = null
        set(value) {
            field = if (value == null || value.matches(Regex("[0-9]+dp"))) {
                value
            } else if (value.matches(Regex("[0-9]+"))) {
                value + "dp"
            } else {
                throw IllegalArgumentException("paddingStart must be a valid size")
            }
        }
    var paddingEnd: String? = null
        set(value) {
            field = if (value == null || value.matches(Regex("[0-9]+dp"))) {
                value
            } else if (value.matches(Regex("[0-9]+"))) {
                value + "dp"
            } else {
                throw IllegalArgumentException("paddingEnd must be a valid size")
            }
        }
    var paddingTop: String? = null
        set(value) {
            field = if (value == null || value.matches(Regex("[0-9]+dp"))) {
                value
            } else if (value.matches(Regex("[0-9]+"))) {
                value + "dp"
            } else {
                throw IllegalArgumentException("paddingTop must be a valid size")
            }
        }
    var paddingBottom: String? = null
        set(value) {
            field = if (value == null || value.matches(Regex("[0-9]+dp"))) {
                value
            } else if (value.matches(Regex("[0-9]+"))) {
                value + "dp"
            } else {
                throw IllegalArgumentException("paddingBottom must be a valid size")
            }
        }
    var marginStart: String? = null
        set(value) {
            field = if (value == null || value.matches(Regex("[0-9]+dp"))) {
                value
            } else if (value.matches(Regex("[0-9]+"))) {
                value + "dp"
            } else {
                throw IllegalArgumentException("marginStart must be a valid size")
            }
        }
    var marginEnd: String? = null
        set(value) {
            field = if (value == null || value.matches(Regex("[0-9]+dp"))) {
                value
            } else if (value.matches(Regex("[0-9]+"))) {
                value + "dp"
            } else {
                throw IllegalArgumentException("marginEnd must be a valid size")
            }
        }
    var marginTop: String? = null
        set(value) {
            field = if (value == null || value.matches(Regex("[0-9]+dp"))) {
                value
            } else if (value.matches(Regex("[0-9]+"))) {
                value + "dp"
            } else {
                throw IllegalArgumentException("marginTop must be a valid size")
            }
        }
    var marginBottom: String? = null
        set(value) {
            field = if (value == null || value.matches(Regex("[0-9]+dp"))) {
                value
            } else if (value.matches(Regex("[0-9]+"))) {
                value + "dp"
            } else {
                throw IllegalArgumentException("marginBottom must be a valid size")
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
            val sb: StringBuilder = StringBuilder("{")
                .append("\"id\":\"$id\"")
                .append(",\"layout_width\":\"$layout_width\"")
                .append(",\"layout_height\":\"$layout_height\"")
                .append(",\"text\":\"$text\"")
            if (textColor != null)
                sb.append(",\"textColor\":\"$textColor\"")
            if (textSize != null)
                sb.append(",\"textSize\":\"$textSize\"")
            if (gravity != null)
                sb.append(",\"gravity\":\"$gravity\"")
            if (textStyle != null)
                sb.append(",\"textStyle\":\"$textStyle\"")
            if (paddingStart != null)
                sb.append(",\"paddingStart\":\"$paddingStart\"")
            if (paddingEnd != null)
                sb.append(",\"paddingEnd\":\"$paddingEnd\"")
            if (paddingTop != null)
                sb.append(",\"paddingTop\":\"$paddingTop\"")
            if (paddingBottom != null)
                sb.append(",\"paddingBottom\":\"$paddingBottom\"")
            if (marginStart != null)
                sb.append(",\"marginStart\":\"$marginStart\"")
            if (marginEnd != null)
                sb.append(",\"marginEnd\":\"$marginEnd\"")
            if (marginTop != null)
                sb.append(",\"marginTop\":\"$marginTop\"")
            if (marginBottom != null)
                sb.append(",\"marginBottom\":\"$marginBottom\"")
            sb.append("}").toString()
        }
    }
}
