package com.rokid.cxr.sample

import android.content.pm.ApplicationInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for app-level configuration.
 * 应用级配置的仪器测试。
 *
 * Verifies package name, backup policy, and MainActivity creation.
 * 验证包名、备份策略与 MainActivity 创建。
 */
@RunWith(AndroidJUnit4::class)
class AppConfigurationInstrumentedTest {
    @Test
    fun packageNameAndBackupPolicyAreCorrect() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        assertEquals("com.rokid.cxr.sample", context.packageName)
        assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
    }

    @Test
    fun mainScreenActivityCanBeCreated() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertFalse(activity.isFinishing)
            }
        }
    }
}
