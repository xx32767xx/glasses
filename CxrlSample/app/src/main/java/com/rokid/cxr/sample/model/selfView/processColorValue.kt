package com.rokid.cxr.sample.model.selfView

/**
 * Processes color value and keeps only green channel if format is valid.
 * 处理颜色值；格式合法时只保留绿色通道。
 */
fun processColorValue(color: String): String {
    // Check valid ARGB format (#AARRGGBB). 检查合法 ARGB 格式（#AARRGGBB）。
    if (color.matches(Regex("#[0-9a-fA-F]{8}"))) {
        // Parse ARGB channels. 解析 ARGB 通道。
        val alpha = color.substring(1, 3)
        val red = color.substring(3, 5)
        val green = color.substring(5, 7)
        val blue = color.substring(7, 9)

        // Return color with green channel only; red and blue channels become 00. 返回仅保留绿色通道的颜色；红蓝通道置为 00。
        return "#$alpha${"00"}$green${"00"}"
    }
    // Check valid RGB format (#RRGGBB). 检查合法 RGB 格式（#RRGGBB）。
    else if (color.matches(Regex("#[0-9a-fA-F]{6}"))) {
        // Parse RGB channels. 解析 RGB 通道。
        val red = color.substring(1, 3)
        val green = color.substring(3, 5)
        val blue = color.substring(5, 7)

        // Return color with green channel only; red and blue channels become 00. 返回仅保留绿色通道的颜色；红蓝通道置为 00。
        return "#FF${"00"}$green${"00"}"
    }
    // Throw if color format is invalid. 颜色格式不合法时抛出异常。
    else {
        throw IllegalArgumentException("Invalid color format: $color")
    }
}

/**
 * Converts color to grayscale and then maps it to green channel.
 * 将颜色转为灰度，再映射到绿色通道。
 */
fun processColorToGrayToGreen(color: String): String {
    if (color.matches(Regex("#[0-9a-fA-F]{8}"))){
        val alpha = color.substring(1,3)
        val red = color.substring(3,5)
        val green = color.substring(5,7)
        val blue = color.substring(7,9)
        val gray = (red.toInt(16) * 0.299 + green.toInt(16) * 0.587 + blue.toInt(16) * 0.114).toInt()
        return "#$alpha${"00"}${String.format("%02x", gray)}${String.format("%02x", gray)}"
    }else if (color.matches(Regex("#[0-9a-fA-F]{6}"))){
        val red = color.substring(1,3)
        val green = color.substring(3,5)
        val blue = color.substring(5,7)
        val gray = (red.toInt(16) * 0.299 + green.toInt(16) * 0.587 + blue.toInt(16) * 0.114).toInt()
        return "#${"FF"}${String.format("%02x", gray)}${String.format("%02x", gray)}"
    }else{
        throw IllegalArgumentException("Invalid color format: $color")
    }
}
