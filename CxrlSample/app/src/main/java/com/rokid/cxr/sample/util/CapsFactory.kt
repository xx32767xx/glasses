package com.rokid.cxr.sample.util

import com.rokid.cxr.Caps

/**
 * Safe wrapper around the Caps obfuscation-keep method set.
 * 针对 Caps 混淆保留方法集的安全包装。
 *
 * Only uses methods confirmed to be kept in the client-l AAR:
 * - Construction: [Caps]
 * - Write: [Caps.write] ([String] / [ByteArray])
 * - Serialization: [Caps.serialize]
 * - Length: [Caps.size]
 *
 * 只使用已确认在 client-l AAR 中被保留的方法：
 * - 构造：[Caps]
 * - 写入：[Caps.write]（[String] / [ByteArray]）
 * - 序列化：[Caps.serialize]
 * - 长度：[Caps.size]
 *
 * Do NOT use unconfirmed APIs such as `putString` / `putInt` / `writeVoid`.
 * 不要使用未确认 API，例如 `putString` / `putInt` / `writeVoid`。
 */
object CapsFactory {

/**
     * Writes a text payload into Caps.
     * 将文本载荷写入 Caps。
     *
     * Corresponds to the SDK call: `session.sendCustomCmd(cmd, payload: Caps, stream: ByteArray)`.
     * 对应 SDK 调用：`session.sendCustomCmd(cmd, payload: Caps, stream: ByteArray)`。
     */
    fun buildPayload(text: String): Caps = Caps().apply {
        write(text)
    }

/**
     * Converts the Caps serialization result to a demo display string.
     * 将 Caps 序列化结果转换为演示展示字符串。
     *
     * Return format: `size=<byteCount>, firstByte=0x<firstByteHex>`.
     * 返回格式：`size=<byteCount>, firstByte=0x<firstByteHex>`。
     *
     * Does not return the full serialized bytes, avoiding binary noise in logs/UI; for local demo only when no session is active.
     * 不返回完整序列化字节，避免日志/UI 中出现二进制噪音；仅用于无会话时的本地演示。
     */
    fun serializeForDisplay(caps: Caps): String {
        val bytes = caps.serialize()
        val firstByte = bytes.firstOrNull()?.let { String.format("0x%02X", it) } ?: "N/A"
        return "size=${caps.size()}, firstByte=$firstByte"
    }
}
