package com.rokid.cxr.sample

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.rokid.cxr.sample.model.CONSTANT
import com.rokid.cxr.sample.navigation.CxrNavGraph
import com.rokid.cxr.sample.viewmodel.SetupViewModel
import com.rokid.cxrlsamplev11.ui.theme.CxrlSampleV11Theme

class MainActivity : ComponentActivity() {

    private val setupViewModel: SetupViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            CxrlSampleV11Theme {
                CxrNavGraph(setupViewModel = setupViewModel)
            }
        }
    }

    @Suppress("DEPRECATION")
    @Deprecated("CXR-L current authorization flow relies on forwarding the result via onActivityResult.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        setupViewModel.handleAuthResult(resultCode, data)
    }

    /**
     * Try to launch the Rokid AI App in order of candidate package priority.
     * 按候选包优先级尝试启动 Rokid AI App。
     *
     * Candidate list (in priority order):
     * - com.rokid.sprite.aiapp
     * - com.rokid.sprite.global.aiapp
     * - com.rokid.uxr
     *
     * 候选列表（按优先级）：
     * - com.rokid.sprite.aiapp
     * - com.rokid.sprite.global.aiapp
     * - com.rokid.uxr
     *
     * If none are installed, fall back to the app-store download page
     * (via the downloadUrl returned by RokidAppStatus).
     * 若均未安装，则回退到应用商店下载页（通过 RokidAppStatus 返回的 downloadUrl）。
     *
     * Currently invoked from [com.rokid.cxr.sample.ui.setup.SetupFlowScreen];
     * MainActivity keeps this function as a fallback entry for reuse by the Hub page or other entries later.
     * 当前由 [com.rokid.cxr.sample.ui.setup.SetupFlowScreen] 调用；MainActivity 保留该函数作为后续 Hub 页或其他入口复用的回退入口。
     */
    fun openRokidAiApp() {
        val launchIntent = CONSTANT.ROKID_AI_PACKAGES.firstNotNullOfOrNull { packageName ->
            packageManager.getLaunchIntentForPackage(packageName)
        }
        if (launchIntent != null) {
            startActivity(launchIntent)
            return
        }

        // Fallback: try opening the official Rokid download page. 回退：尝试打开 Rokid 官方下载页。
        val fallbackUrl = "https://www.rokid.com"
        startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(fallbackUrl)).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            },
        )
    }
}
