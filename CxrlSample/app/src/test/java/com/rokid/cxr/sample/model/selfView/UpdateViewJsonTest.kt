package com.rokid.cxr.sample.model.selfView

import com.rokid.cxr.sample.model.selfView.UpdateViewJson.UpdateJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the CustomView incremental update JSON builder.
 * CustomView 增量更新 JSON 构建器的单元测试。
 *
 * The original [UpdateViewJson] class in version 1.0.4 only exposes [updateList]
 * and [UpdateViewJson.toJson]. This test reuses the v1.1 calling style through
 * [UpdateViewJsonExt] extension methods, and asserts:
 * - Output array structure `[{"action":"update","id":"...","props":{...}}]`
 * - id is valid
 * - props keys are within the whitelist
 *
 * 原始 1.0.4 版本的 [UpdateViewJson] 类只暴露 [updateList] 与 [UpdateViewJson.toJson]。
 * 本测试通过 [UpdateViewJsonExt] 扩展方法复用 v1.1 调用风格，并断言：
 * - 输出数组结构 `[{"action":"update","id":"...","props":{...}}]`
 * - id 合法
 * - props 键在白名单内
 */
class UpdateViewJsonTest {

    @Test
    fun `toJson produces update array with action id and props`() {
        val json = UpdateViewJson()
            .add("title_text", mapOf("text" to "Hello"))
            .toJson()

        assertEquals(
            """[{"action":"update","id":"title_text","props":{"text":"Hello"}}]""",
            json,
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun `invalid id is rejected`() {
        UpdateViewJson().add("title-text", mapOf("text" to "Hello"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `props key outside whitelist is rejected`() {
        UpdateViewJson().add("title_text", mapOf("illegalKey" to "value"))
    }

    @Test
    fun `multiple updates preserve order`() {
        val json = UpdateViewJson()
            .add("a", mapOf("text" to "A"))
            .add("b", mapOf("text" to "B"))
            .toJson()

        assertEquals(
            """[{"action":"update","id":"a","props":{"text":"A"}},{"action":"update","id":"b","props":{"text":"B"}}]""",
            json,
        )
    }

    @Test
    fun `setter rejects non-whitelist key`() {
        val update = UpdateJson("title_text")
        var failed = false
        try {
            update["illegalKey"] = "value"
        } catch (e: IllegalArgumentException) {
            failed = true
        }
        assertTrue(failed)
    }
}
