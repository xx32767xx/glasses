package com.rokid.cxr.sample.viewmodel

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.provider.MediaStore
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.model.EventCategory
import com.rokid.cxr.sample.model.EventLogger
import com.rokid.cxr.sample.util.SessionReasonMapping
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel
import com.rokid.cxr.session.CxrSession
import com.rokid.cxr.session.IImageCallback
import com.rokid.cxr.session.SessionErrorCode
import com.rokid.cxr.session.SessionResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Photo feature page ViewModel.
 * 拍照功能页 ViewModel。
 *
 * - Does not hold a session reference; obtains it on demand via getter. Calls only, never closes.
 * - The session object is owned by the Hub; feature pages call only and do not close it.
 * - Calls [CxrSession.takePhoto] explicitly with width/height/quality parameters (A5).
 * - Decodes the ByteArray into a Bitmap through [IImageCallback.onImageReceived].
 * - Saves to the gallery using MediaStore.Images; on API 28, WRITE_EXTERNAL_STORAGE permission
 *   has already been requested by PhotoPage (TODO: verify on a real device).
 *
 * - 不持有会话引用；通过 getter 按需获取。只调用，不关闭。
 * - 会话对象归 Hub 所有；能力页面只调用，不关闭。
 * - 显式调用 [CxrSession.takePhoto] 并传入 width/height/quality 参数（A5）。
 * - 通过 [IImageCallback.onImageReceived] 将 ByteArray 解码为 Bitmap。
 * - 使用 MediaStore.Images 保存到相册；在 API 28 上，WRITE_EXTERNAL_STORAGE 权限已由 PhotoPage 请求（TODO：在真机上验证）。
 */
class PhotoViewModel(
    private val hub: SessionHubViewModel,
    private val appContext: Context,
) : ViewModel() {

    /** The session object is fetched on every access (getter) — feature pages do not hold a
     *  session reference, so nothing leaks after the session is closed. 每次访问都重新获取会话对象（getter）—— 能力页面不持有会话引用，会话关闭后不会泄漏。 */
    private val session: CxrSession? get() = hub.currentSession

    private val _width = MutableStateFlow(640)
    val width: StateFlow<Int> = _width.asStateFlow()

    private val _height = MutableStateFlow(480)
    val height: StateFlow<Int> = _height.asStateFlow()

    private val _quality = MutableStateFlow(80)
    val quality: StateFlow<Int> = _quality.asStateFlow()

    private val _photo = MutableStateFlow<Bitmap?>(null)
    val photo: StateFlow<Bitmap?> = _photo.asStateFlow()

    private val _isTaking = MutableStateFlow(false)
    val isTaking: StateFlow<Boolean> = _isTaking.asStateFlow()

    private val _errorMessage = MutableStateFlow<String?>(null)
    val errorMessage: StateFlow<String?> = _errorMessage.asStateFlow()

    private val _saveResult = MutableStateFlow<String?>(null)
    val saveResult: StateFlow<String?> = _saveResult.asStateFlow()

    private val imageCallback = object : IImageCallback {
        override fun onImageReceived(data: ByteArray) {
            _isTaking.value = false
            val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size)
            _photo.value = bitmap
            logCallback(
                sdkApi = "IImageCallback.onImageReceived",
                event = appContext.getString(
                    R.string.log_image_received,
                    data.size,
                    appContext.getString(
                        if (bitmap != null) R.string.log_decode_success else R.string.log_decode_failure,
                    ),
                ),
            )
        }

        override fun onImageError(errorCode: SessionErrorCode, v1ErrorCode: Int, v1ErrorMessage: String?) {
            _isTaking.value = false
            val reason = appContext.getString(SessionReasonMapping.errorCode(errorCode)) +
                (v1ErrorMessage?.let { "；$it" } ?: "")
            _errorMessage.value = reason
            logError(
                sdkApi = "IImageCallback.onImageError",
                event = appContext.getString(R.string.log_image_callback_error),
                reason = reason,
                errorCode = errorCode.name,
                suggestedAction = appContext.getString(R.string.log_suggestion_check_session_camera_permission),
            )
        }
    }

    /** Register the image callback; call when the page enters. 注册图像回调；页面进入时调用。 */
    fun registerImageCallback() {
        session?.addImageCallback(imageCallback)
    }

    /** Unregister the image callback; call when the page exits. 注销图像回调；页面退出时调用。 */
    fun unregisterImageCallback() {
        session?.removeImageCallback(imageCallback)
    }

    fun setWidth(value: Int) {
        _width.value = value.coerceAtLeast(1)
    }

    fun setHeight(value: Int) {
        _height.value = value.coerceAtLeast(1)
    }

    fun setQuality(value: Int) {
        _quality.value = value.coerceIn(1, 100)
    }

    /** Trigger a photo capture. 触发拍照。 */
    fun capture() {
        val current = session ?: run {
            _errorMessage.value = appContext.getString(R.string.feature_error_no_session)
            return
        }
        val w = _width.value
        val h = _height.value
        val q = _quality.value
        _isTaking.value = true
        _photo.value = null
        _errorMessage.value = null
        _saveResult.value = null
        logSdkCall("CxrSession.takePhoto($w, $h, $q)")
        viewModelScope.launch {
            handleResult(current.takePhoto(w, h, q), "takePhoto($w, $h, $q)")
        }
    }

    /** Save the current photo to the system gallery. 将当前照片保存到系统相册。 */
    fun saveToGallery() {
        val bitmap = _photo.value ?: run {
            _saveResult.value = appContext.getString(R.string.photo_no_photo_to_save)
            return
        }
        viewModelScope.launch {
            runCatching {
                val fileName = "cxr_photo_${System.currentTimeMillis()}.jpg"
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
                    put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        put(MediaStore.Images.Media.IS_PENDING, 1)
                    }
                }
                val uri = appContext.contentResolver.insert(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    values,
                ) ?: throw IllegalStateException("MediaStore insert returned null")
                appContext.contentResolver.openOutputStream(uri)?.use { out ->
                    bitmap.compress(Bitmap.CompressFormat.JPEG, _quality.value, out)
                } ?: throw IllegalStateException("Cannot open gallery output stream")
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    values.clear()
                    values.put(MediaStore.Images.Media.IS_PENDING, 0)
                    appContext.contentResolver.update(uri, values, null, null)
                }
                uri.toString()
            }.onSuccess { uri ->
                _saveResult.value = appContext.getString(R.string.photo_save_succeeded, uri)
                logCallback(
                    sdkApi = "PhotoViewModel.saveToGallery",
                    event = "Photo saved to gallery",
                )
            }.onFailure { e ->
                _saveResult.value = appContext.getString(R.string.photo_save_failed, e.message ?: "")
                logError(
                    sdkApi = "PhotoViewModel.saveToGallery",
                    event = "Save to gallery failed",
                    reason = e.message,
                    suggestedAction = appContext.getString(R.string.photo_save_permission_hint),
                )
            }
        }
    }

    /** Call when the save permission is denied. 保存权限被拒绝时调用。 */
    fun onSavePermissionDenied() {
        _saveResult.value = appContext.getString(R.string.photo_save_permission_denied)
    }

    fun clearPhoto() {
        _photo.value = null
        _errorMessage.value = null
        _saveResult.value = null
    }

    override fun onCleared() {
        super.onCleared()
        unregisterImageCallback()
    }

    private suspend fun <T> handleResult(
        result: SessionResult<T>,
        sdkApi: String,
    ) {
        if (result.isSuccess) {
            logSdkResult(sdkApi, true)
        } else {
            _isTaking.value = false
            val reason = appContext.getString(SessionReasonMapping.errorCode(result.code))
            _errorMessage.value = reason
            logError(
                sdkApi = "CxrSession.$sdkApi",
                event = appContext.getString(R.string.log_sdk_api_failure, sdkApi),
                reason = reason,
                errorCode = result.code?.name,
                suggestedAction = appContext.getString(R.string.log_suggestion_check_started_state),
            )
        }
    }

    private fun currentStateName(): String = hub.sessionState.value.name

    private fun logSdkCall(sdkApi: String) {
        hub.appendEventLog(
            EventLogger.create(
                category = EventCategory.SDK_CALL,
                sdkApi = sdkApi,
                stateBefore = currentStateName(),
                stateAfter = currentStateName(),
                event = appContext.getString(R.string.log_call_sdk_api, sdkApi),
            ),
        )
    }

    private fun logSdkResult(sdkApi: String, success: Boolean) {
        hub.appendEventLog(
            EventLogger.create(
                category = EventCategory.SDK_CALL,
                sdkApi = sdkApi,
                stateBefore = currentStateName(),
                stateAfter = currentStateName(),
                event = if (success) {
                    appContext.getString(R.string.log_sdk_api_success, sdkApi)
                } else {
                    appContext.getString(R.string.log_sdk_api_failure, sdkApi)
                },
            ),
        )
    }

    private fun logCallback(sdkApi: String, event: String) {
        hub.appendEventLog(
            EventLogger.create(
                category = EventCategory.CAPABILITY,
                sdkApi = sdkApi,
                stateBefore = currentStateName(),
                stateAfter = currentStateName(),
                event = event,
            ),
        )
    }

    private fun logError(
        sdkApi: String,
        event: String,
        reason: String? = null,
        errorCode: String? = null,
        suggestedAction: String? = null,
    ) {
        hub.appendEventLog(
            EventLogger.create(
                category = EventCategory.ERROR,
                sdkApi = sdkApi,
                stateBefore = currentStateName(),
                stateAfter = currentStateName(),
                event = event,
                reason = reason,
                errorCode = errorCode,
                suggestedAction = suggestedAction,
            ),
        )
    }
}
