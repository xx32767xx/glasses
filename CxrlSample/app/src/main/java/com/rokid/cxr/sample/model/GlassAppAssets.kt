package com.rokid.cxr.sample.model

import android.content.Context
import android.util.Log
import com.rokid.cxr.session.SessionConfig
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException

/**
 * Built-in glasses app asset helper.
 * 眼镜端内置示例应用资源辅助类。
 *
 * Teaching: when [SessionConfig.glassesApkPath] is non-null, the SDK connect flow for
 * CUSTOM_APP automatically checks whether the app is installed; if not, it uploads and
 * installs the APK via appUploadAndInstall(apkPath), then starts it via appStart(activityName).
 * 教学说明：当 [SessionConfig.glassesApkPath] 非空时，CUSTOM_APP 的 SDK connect 流程会自动检
 * 查应用是否已安装；未安装则通过 appUploadAndInstall(apkPath) 上传安装，再通过 appStart(activityName) 启动。
 */
object GlassAppAssets {

    private const val TAG = "GlassAppAssets"
    private const val ASSET_DIR = "glass_apps"
    private const val ASSET_NAME = "demo_glass_app.apk"
    private const val CACHE_DIR = "glass_apps"

    /**
     * Ensures the built-in glasses app APK is copied from assets to the app cache dir.
     * 确保内置眼镜端应用 APK 已从 assets 拷贝到应用缓存目录。
     *
     * Idempotency: if the destination file already exists and its length equals the asset
     * length, the copy is skipped; otherwise the file is overwritten.
     * 幂等性：若目标文件已存在且长度与 assets 资源一致，则跳过拷贝；否则覆盖写入。
     *
     * @return The absolute path of the copied APK, or null if the asset is not bundled.
     *         返回拷贝后的 APK 绝对路径；若未内置该资源则返回 null。
     */
    fun ensureBuiltInGlassApp(context: Context): String? {
        val assetPath = "$ASSET_DIR/$ASSET_NAME"
        val assetManager = context.assets

        val assetLength = try {
            assetManager.openFd(assetPath).use { it.length }
        } catch (e: FileNotFoundException) {
            Log.w(TAG, "Built-in glass app asset not found: $assetPath")
            return null
        } catch (e: IOException) {
            // Asset may be compressed; length is unknown, so always copy.
            // 资源可能被压缩，无法获取长度，回退为始终拷贝。
            Log.d(TAG, "openFd failed (asset may be compressed), fallback to copy: ${e.message}")
            -1L
        }

        val destDir = File(context.cacheDir, CACHE_DIR).apply { mkdirs() }
        val destFile = File(destDir, ASSET_NAME)

        if (destFile.exists() && assetLength >= 0 && destFile.length() == assetLength) {
            return destFile.absolutePath
        }

        return try {
            assetManager.open(assetPath).use { input ->
                destFile.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            destFile.absolutePath
        } catch (e: IOException) {
            null
        }
    }
}
