package com.rokid.cxr.sample

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Instrumented tests for EventLogger export behavior.
 * EventLogger 导出行为的仪器测试。
 *
 * Verifies redaction, unique file names, retention, and cleanup on an Android device.
 * 在 Android 设备上验证脱敏、唯一文件名、保留策略与清理行为。
 */
@RunWith(AndroidJUnit4::class)
class EventLoggerInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @After
    fun cleanUp() {
        EventLogger.clearExports(context)
    }

    @Test
    fun exportRedactsCredentialsAndUsesUniqueNames() {
        val fakeToken = "fake-export-credential"
        val event = EventLogger.create(
            category = EventCategory.INFO,
            sdkApi = "test",
            stateBefore = "Idle",
            stateAfter = "Idle",
            event = "export",
            reason = "token=$fakeToken",
        )

        val first = EventLogger.export(context, listOf(event))
        val second = EventLogger.export(context, listOf(event))

        assertNotEquals(first.name, second.name)
        assertFalse(first.readText().contains(fakeToken))
        assertFalse(second.readText().contains(fakeToken))
    }

    @Test
    fun sixthExportKeepsOnlyNewestFive() {
        val exports = List(6) {
            EventLogger.export(context, emptyList())
        }

        assertEquals(5, exportDirectory().listFiles()?.size)
        assertFalse(exports.first().exists())
        exports.drop(1).forEach { file ->
            assertTrue("${file.name} should still exist", file.exists())
        }
    }

    @Test
    fun clearExportsDeletesOnlyEventLogDirectoryContents() {
        val outsideFile = File(context.cacheDir, "must-remain.txt").apply {
            writeText("keep")
        }
        EventLogger.export(context, emptyList())

        EventLogger.clearExports(context)

        assertTrue(outsideFile.exists())
        assertTrue(exportDirectory().listFiles().isNullOrEmpty())
        outsideFile.delete()
    }

    private fun exportDirectory() = File(context.cacheDir, "event-logs")
}
