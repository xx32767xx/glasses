package com.rokid.cxr.sample

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.Density
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.rokid.cxr.sample.navigation.LocalNavController
import com.rokid.cxr.sample.ui.hub.HubScreen
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Smoke test for HubScreen.
 * HubScreen 的冒烟测试。
 *
 * Verifies that HubScreen composes and renders without a session and shows the no-session prompt.
 * 验证 HubScreen 在无会话时能够组合、渲染，并展示无会话提示。
 */
@RunWith(AndroidJUnit4::class)
class HubScreenSmokeTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun hubScreenRendersWithoutSession() {
        composeRule.setContent {
            val navController = rememberNavController()
            val hubViewModel: SessionHubViewModel = viewModel()
            val baseDensity = LocalDensity.current
            CompositionLocalProvider(
                LocalDensity provides Density(
                    density = baseDensity.density,
                    fontScale = 1.0f,
                ),
                LocalNavController provides navController,
            ) {
                Box(modifier = Modifier.fillMaxSize()) {
                    HubScreen(hubViewModel = hubViewModel)
                }
            }
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithText("Session Hub", substring = true).assertIsDisplayed()
    }
}
