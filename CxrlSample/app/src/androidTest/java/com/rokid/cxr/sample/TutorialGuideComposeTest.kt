package com.rokid.cxr.sample

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.Density
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.rokid.cxr.sample.navigation.LocalNavController
import com.rokid.cxr.sample.ui.setup.SetupFlowScreen
import com.rokid.cxr.sample.viewmodel.SetupViewModel
import com.rokid.cxr.session.AuthResult
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Basic Compose tests for the new [SetupFlowScreen].
 * 新版 [SetupFlowScreen] 的基础 Compose 测试。
 *
 * Test cases related to the old SampleScreen / TutorialGuideCard / ProgressiveSection were removed in B-R2b;
 * more complete SetupViewModel state-driven test cases will be added in B-R5.
 *
 * 与旧 SampleScreen / TutorialGuideCard / ProgressiveSection 相关的测试用例已在 B-R2b 中移除；
 * 更完整的 SetupViewModel 状态驱动测试用例将在 B-R5 中添加。
 */
@RunWith(AndroidJUnit4::class)
class TutorialGuideComposeTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun setupFlowShowsThreeStepIndicator() {
        setScreen()

        composeRule.onNodeWithText("安装 companion", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("授权", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("选择场景", substring = true).assertIsDisplayed()
    }

    @Test
    fun installCompanionStepShowsEnvironmentCard() {
        setScreen()

        composeRule.onNodeWithText("环境检查结果", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Rokid AI App", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("蓝牙连接状态将在创建会话后于会话中心查看", substring = true)
            .assertIsDisplayed()
    }

    @Test
    fun installCompanionStepShowsRecheckAndNextButtons() {
        setScreen()

        composeRule.onNodeWithTag(
            "api_button_manager.isRokidAppInstalled(context) / " +
                "manager.checkRokidAppCompatibility(context)",
        ).assertIsDisplayed()

        composeRule.onNodeWithTag("api_button_navController.navigate(\"authorize\")")
            .assertIsDisplayed()
            .assertIsNotEnabled()
    }

    @Test
    fun setupFlowShowsLocalPreviewSection() {
        setScreen()

        composeRule.onNodeWithTag("progressive_section_local_preview")
            .assertIsDisplayed()
    }

    @Test
    fun authorizeStepShowsRequestAuthorizationButton() {
        setScreen()
        forceEnvChecked(viewModel, true)
        composeRule.waitForIdle()

        composeRule.onNodeWithTag(
            "api_button_manager.requestAuthorization(activity, permissions, callback)",
        ).assertIsDisplayed()
    }

    @Test
    fun selectSceneStepShowsSessionTypeTiles() {
        setScreen()
        forceEnvChecked(viewModel, true)
        forceAuthSuccess(viewModel)
        composeRule.waitForIdle()

        composeRule.onNodeWithText("CUSTOM_VIEW", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("CUSTOM_APP", substring = true).assertIsDisplayed()
    }

    private lateinit var viewModel: SetupViewModel

    private fun setScreen(fontScale: Float = 1.0f) {
        composeRule.setContent {
            val navController = rememberNavController()
            val vm = viewModel<SetupViewModel>()
            viewModel = vm
            val baseDensity = LocalDensity.current
            CompositionLocalProvider(
                LocalDensity provides Density(
                    density = baseDensity.density,
                    fontScale = fontScale,
                ),
                LocalNavController provides navController,
            ) {
                Box(modifier = Modifier.fillMaxSize()) {
                    SetupFlowScreen(setupViewModel = vm)
                }
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun forceEnvChecked(viewModel: SetupViewModel, checked: Boolean) {
        val field = SetupViewModel::class.java.getDeclaredField("_envChecked")
        field.isAccessible = true
        val flow = field.get(viewModel) as MutableStateFlow<Boolean>
        flow.value = checked
    }

    @Suppress("UNCHECKED_CAST")
    private fun forceAuthSuccess(viewModel: SetupViewModel) {
        val field = SetupViewModel::class.java.getDeclaredField("_authState")
        field.isAccessible = true
        val flow = field.get(viewModel) as MutableStateFlow<AuthResult?>
        flow.value = AuthResult(true, "dummy-token-for-test", null, null)
    }
}
