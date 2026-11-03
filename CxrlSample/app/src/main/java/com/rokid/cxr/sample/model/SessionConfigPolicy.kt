package com.rokid.cxr.sample.model

import com.rokid.cxr.session.SessionType

object SessionConfigPolicy {

    /** Configuration validation result. */
    sealed class ConfigValidation {
        object Valid : ConfigValidation()
        data class Invalid(
            val code: Code,
            val detail: String? = null,
        ) : ConfigValidation() {
            enum class Code {
                GRACE_PERIOD_OUT_OF_RANGE,
                CUSTOM_VIEW_BLANK_VIEW_DATA,
                CUSTOM_VIEW_INVALID_VIEW_DATA,
                CUSTOM_APP_MISSING_PACKAGE_NAME,
            }
        }
    }

    fun effectiveSessionType(
        editingType: SessionType,
        createdType: SessionType?,
        isSessionCreated: Boolean,
    ): SessionType {
        return if (isSessionCreated && createdType != null) createdType else editingType
    }

    fun isConfigLocked(isSessionCreated: Boolean): Boolean = isSessionCreated

    /**
     * v1.1 local configuration validation.
     * v1.1 本地配置校验。
     *
     * @param getString String resolver used to localize validator error messages.
     *                  用于本地化校验器错误消息的字符串解析器。
     * @return [ConfigValidation.Valid] or [ConfigValidation.Invalid] with an error code.
     *         返回 [ConfigValidation.Valid] 或带错误码的 [ConfigValidation.Invalid]。
     */
    fun validateConfig(
        getString: (Int) -> String,
        type: SessionType,
        gracePeriodMs: Long,
        viewData: String?,
        packageName: String?,
    ): ConfigValidation {
        if (gracePeriodMs !in 1_000L..30_000L) {
            return ConfigValidation.Invalid(
                ConfigValidation.Invalid.Code.GRACE_PERIOD_OUT_OF_RANGE,
            )
        }
        if (type == SessionType.CUSTOM_VIEW) {
            if (viewData.isNullOrBlank()) {
                return ConfigValidation.Invalid(
                    ConfigValidation.Invalid.Code.CUSTOM_VIEW_BLANK_VIEW_DATA,
                )
            }
            CustomViewJsonValidator.validateViewData(getString, viewData).onFailure { error ->
                return ConfigValidation.Invalid(
                    ConfigValidation.Invalid.Code.CUSTOM_VIEW_INVALID_VIEW_DATA,
                    detail = error.message,
                )
            }
        }
        if (type == SessionType.CUSTOM_APP && packageName.isNullOrBlank()) {
            return ConfigValidation.Invalid(
                ConfigValidation.Invalid.Code.CUSTOM_APP_MISSING_PACKAGE_NAME,
            )
        }
        return ConfigValidation.Valid
    }
}
