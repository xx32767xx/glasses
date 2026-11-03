package com.rokid.cxr.sample.util



object TokenRedactor {

    private const val HIDDEN_TOKEN = "***"



    // Credential value charset for log tokens. Bare tails after , ; | continue the
    // credential unless the next segment looks like a key=value field.
    // 日志 token 的凭据值字符集；若 , ; | 后不是 key=value 字段，则继续属于当前凭据值。
    private const val VALUE_CHARS = """[A-Za-z0-9._~+/%=-]+"""
    private const val BARE_TAIL = """[,;|](?![A-Za-z_][\w]*=)$VALUE_CHARS"""



    private val jsonCredential = Regex(

        pattern = "(?i)(\"(?:token|access_token|refresh_token|id_token|authorization)\"\\s*:\\s*)" +
            "\"(?:\\\\.|[^\"\\\\])*\"",

    )
    private val authorizationAssignment = Regex(

        pattern = """(?i)(\bauthorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?$VALUE_CHARS(?:$BARE_TAIL)*""",

    )
    private val tokenAssignment = Regex(

        pattern = """(?i)(\b(?:access_token|refresh_token|id_token|token)\s*[:=]\s*)$VALUE_CHARS(?:$BARE_TAIL)*""",

    )



    /**
     * Returns a display string for a token: [hiddenLabel] when present, otherwise "-".
     * 返回 token 的展示文本：有值时显示调用方传入的 [hiddenLabel]，否则显示 "-"。
     */
    fun forDisplay(token: String?, hiddenLabel: String): String {
        return if (token.isNullOrBlank()) "-" else hiddenLabel
    }



    fun redact(value: String?): String? {

        if (value == null) return null

        return value

            .replace(jsonCredential) { match ->

                "${match.groupValues[1]}\"$HIDDEN_TOKEN\""

            }

            .replace(authorizationAssignment) { match ->

                "${match.groupValues[1]}$HIDDEN_TOKEN"

            }

            .replace(tokenAssignment) { match ->

                "${match.groupValues[1]}$HIDDEN_TOKEN"

            }

    }

}


