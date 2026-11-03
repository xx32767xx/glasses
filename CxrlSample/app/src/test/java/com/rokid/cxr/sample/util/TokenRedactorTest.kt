package com.rokid.cxr.sample.util



import org.junit.Assert.assertEquals

import org.junit.Assert.assertFalse

import org.junit.Test



/**
 * Unit tests for token redaction and display helpers.
 * token 脱敏与展示辅助工具的单元测试。
 */
class TokenRedactorTest {

    companion object {
        private const val HIDDEN_LABEL = "已获取（已隐藏）"
    }

    @Test

    fun `empty token is shown as unavailable`() {

        assertEquals("-", TokenRedactor.forDisplay(null, HIDDEN_LABEL))

        assertEquals("-", TokenRedactor.forDisplay("", HIDDEN_LABEL))

        assertEquals("-", TokenRedactor.forDisplay("   ", HIDDEN_LABEL))

    }



    @Test

    fun `tokens of every length are fully hidden`() {

        listOf(

            "x",

            "abcde",

            "abcdefghij",

            "definitely-fake-long-token-value",

        ).forEach { token ->

            assertEquals(HIDDEN_LABEL, TokenRedactor.forDisplay(token, HIDDEN_LABEL))

            assertFalse(TokenRedactor.forDisplay(token, HIDDEN_LABEL).contains(token))

        }

    }



    @Test

    fun `authorization schemes and token fields are fully redacted`() {

        val bearerInput = "Authorization: Bearer fake-bearer-credential"

        val basicInput = "Authorization: Basic fake-basic-credential"



        assertEquals("Authorization: ***", TokenRedactor.redact(bearerInput))

        assertEquals("Authorization: ***", TokenRedactor.redact(basicInput))

        assertFalse(TokenRedactor.redact(bearerInput)!!.contains("fake-bearer-credential"))

        assertFalse(TokenRedactor.redact(basicInput)!!.contains("fake-basic-credential"))



        assertEquals("token=***", TokenRedactor.redact("token=fake-value"))

        assertEquals("access_token=***", TokenRedactor.redact("access_token=fake-value"))

        assertEquals("refresh_token=***", TokenRedactor.redact("refresh_token=fake-value"))

        assertEquals("id_token=***", TokenRedactor.redact("id_token=fake-value"))

        assertEquals("AcCeSs_ToKeN=***", TokenRedactor.redact("AcCeSs_ToKeN=fake-value"))

    }



    @Test

    fun `structured credential delimiters and ordinary text are preserved`() {

        assertEquals("reason token=*** failed", TokenRedactor.redact("reason token=fake-value failed"))

        assertEquals("Token: ***", TokenRedactor.redact("Token: fake-value"))

        assertEquals("TOKEN=***", TokenRedactor.redact("TOKEN=abcde"))

        assertEquals(

            """{"token":"***","other":"ok"}""",

            TokenRedactor.redact("""{"token":"fake-value","other":"ok"}"""),

        )

        assertEquals(

            "access_token=***&other=ok",

            TokenRedactor.redact("access_token=fake-value&other=ok"),

        )

        assertEquals(

            "refresh_token=*** next=value",

            TokenRedactor.redact("refresh_token=fake-value next=value"),

        )

        assertEquals(

            "id_token=***,other=ok",

            TokenRedactor.redact("id_token=fake-value,other=ok"),

        )

        assertEquals("", TokenRedactor.redact(""))

        assertEquals(null, TokenRedactor.redact(null))

        assertEquals("蓝牙连接失败", TokenRedactor.redact("蓝牙连接失败"))

    }



    @Test

    fun `bare credential tails after separators are fully redacted`() {

        // Contract: `,` `;` `|` without a following key= continue the credential value. 约定：`,` `;` `|` 后没有 key= 时，仍属于当前凭据值。

        // A following key=value field is preserved; bare secret-tail must not leak. 后续 key=value 字段应保留；裸秘密后缀不得泄漏。

        assertEquals(

            "token=*** next=value",

            TokenRedactor.redact("token=fake-part,secret-tail next=value"),

        )

        assertEquals(

            "access_token=*** next=value",

            TokenRedactor.redact("access_token=fake-part;secret-tail next=value"),

        )

        assertEquals(

            "refresh_token=*** next=value",

            TokenRedactor.redact("refresh_token=fake-part|secret-tail next=value"),

        )



        listOf(

            "token=fake-part,secret-tail next=value",

            "access_token=fake-part;secret-tail next=value",

            "refresh_token=fake-part|secret-tail next=value",

        ).forEach { input ->

            val output = TokenRedactor.redact(input)!!

            assertFalse(output.contains("fake-part"))

            assertFalse(output.contains("secret-tail"))

            assertEquals(true, output.contains("next=value"))

        }

    }

}


