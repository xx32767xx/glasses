package com.rokid.cxr.sample.util

import com.rokid.cxr.Caps
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for CapsFactory.
 * CapsFactory 单元测试。
 *
 * Verifies usage of only the obfuscation-retained method set: constructor,
 * write(String), serialize(), and size().
 * 验证仅使用混淆保留的方法集：构造方法、write(String)、serialize() 与 size()。
 *
 * Note: serialize() is a native method. The real device shared library cannot be
 * loaded in a JVM unit test environment, so the serialization behavior of
 * [serializeForDisplay] must be verified in androidTest / on a real device. This
 * test only verifies method existence (via reflection / compile assertions) and
 * that buildPayload can construct a Caps object normally.
 *
 * 注意：serialize() 是 native 方法。真机共享库无法在 JVM 单元测试环境中加载，因此 [serializeForDisplay] 的序列化行为需在 androidTest / 真机上验证。
 * 本测试仅验证方法存在性（通过反射 / 编译断言）以及 buildPayload 能正常构造 Caps 对象。
 */
class CapsFactoryTest {

    @Test
    fun `buildPayload writes String into Caps`() {
        val payload = CapsFactory.buildPayload("hello cxr")
        assertNotNull(payload)
        assertTrue(payload.size() > 0)
    }

    @Test
    fun `serializeForDisplay exists and returns String`() {
        // Compile-time + reflection guarantees the factory method signature stays unchanged;
        // native execution is left for real-device / Instrumentation tests.
        val method = CapsFactory::class.java.getDeclaredMethod("serializeForDisplay", Caps::class.java)
        assertNotNull(method)
        assertEquals(String::class.java, method.returnType)
    }

    @Test
    fun `empty payload still produces Caps`() {
        val payload = CapsFactory.buildPayload("")
        assertNotNull(payload)
        assertTrue(payload.size() >= 0)
    }
}
