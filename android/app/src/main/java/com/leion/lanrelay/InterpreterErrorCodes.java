package com.leion.lanrelay;

import android.content.Context;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * InterpreterErrorCodes —— 翻译官/朗读这一侧的**错误码注册表**（5.34）。
 * ============================================================================
 * 为什么要有它：失败时如果只 throw 一句话，会发生三件坏事——
 *   ① 界面切成英文/葡文，用户却看到一句中文（本项目被投诉过，见 4.58）；
 *   ② 程序没法判断"该自动重试"还是"该让用户去改设置"；
 *   ③ 日志里全是自由文本，统计不出"现场到底卡在哪一类"。
 *
 * 所以约定：**后端只报机器码 + 一条人话**，界面按码选自己语言的那句，
 * 找不到才退回人话，再找不到用一句通用话。语言由客户端决定，不由服务端决定。
 *
 * <h3>以后要加错误类型，只需要三步（别再改测试）</h3>
 * <ol>
 *   <li>下面加一个 `public static final String XXX = "asr-xxx";`（**小写 + 连字符**）；</li>
 *   <li>`MESSAGES` 里加一行 `put(XXX, R.string.err_asr_xxx)`；</li>
 *   <li>三套 `strings.xml`（`values` / `values-en` / `values-pt-rBR`）各加一条 `err_asr_xxx`。</li>
 * </ol>
 * 漏了第 3 步，`tests/tts-suite.mjs` 的"每个错误码都有三语文案"会**自动报红**——
 * 它遍历的是这张表，不是写死的清单，所以加码不用改测试。
 *
 * <p>码值一旦发布就**不许改**（它是协议的一部分）：改名字等于把老日志和老版本客户端
 * 的归类一起弄丢。要换说法就换文案，不要换码。
 */
public final class InterpreterErrorCodes {

    // ── 识别（ASR）────────────────────────────────────────────────────────
    /** 连不上识别服务（断网 / 服务器挂了 / 代理不通）。**可重试**。 */
    public static final String ASR_NETWORK = "asr-network";
    /** 服务端繁忙（并发上限、队列满、配额紧）。**可重试**，但要退避。 */
    public static final String ASR_BUSY = "asr-busy";
    /** 未授权（Key 缺失/无效、账号过期）。**不可重试**，要找管理员。 */
    public static final String ASR_AUTH = "asr-auth";
    /** 识别中途出错（上游返回了错误、流被断开）。**可重试**。 */
    public static final String ASR_FAILED = "asr-failed";
    /** 路由挑不到能识别这门语言的引擎。**不可重试**（要装/配引擎）。 */
    public static final String NO_ENGINE = "no-engine";
    /** 后端拿到的语言和它声明支持的不一致（配置错）。**不可重试**。 */
    public static final String ASR_LANG_MISMATCH = "asr-lang-mismatch";

    // ── 采集（麦克风）──────────────────────────────────────────────────────
    /** 没拿到麦克风（被别的页面/功能占着）。**可重试**（等它停了再点）。 */
    public static final String MIC_BUSY = "mic-busy";
    /** 没有录音权限。**不可重试**，要去设置里给。 */
    public static final String MIC_PERMISSION = "mic-permission";

    // ── 朗读（TTS）────────────────────────────────────────────────────────
    /** 没有耳机/眼镜（会议里禁止外放）。**不可重试**（插上再来）。 */
    public static final String NO_EARPHONE = "no-earphone";
    /** 这台设备没有可用的语音引擎/语音包。**不可重试**。 */
    public static final String TTS_ENGINE = "tts-engine";
    /** 语音合成或播放失败。**可重试**（下一句再试）。 */
    public static final String TTS_FAILED = "tts-failed";

    /** 码 → 文案资源。**这张表就是注册表**：加码只改这里 + 三套 strings.xml。 */
    private static final Map<String, Integer> MESSAGES = new LinkedHashMap<>();

    /** 可自动重试的码（其余都算"要人处理"）。 */
    private static final Map<String, Boolean> RETRYABLE = new LinkedHashMap<>();

    static {
        put(ASR_NETWORK, R.string.err_asr_network, true);
        put(ASR_BUSY, R.string.err_asr_busy, true);
        put(ASR_AUTH, R.string.err_asr_auth, false);
        put(ASR_FAILED, R.string.err_asr_failed, true);
        put(NO_ENGINE, R.string.err_no_engine, false);
        put(ASR_LANG_MISMATCH, R.string.err_asr_lang_mismatch, false);
        put(MIC_BUSY, R.string.err_mic_busy, true);
        put(MIC_PERMISSION, R.string.err_mic_permission, false);
        put(NO_EARPHONE, R.string.err_no_earphone, false);
        put(TTS_ENGINE, R.string.err_tts_engine, false);
        put(TTS_FAILED, R.string.err_tts_failed, true);
    }

    private static void put(String code, int resource, boolean retryable) {
        MESSAGES.put(code, resource);
        RETRYABLE.put(code, retryable);
    }

    private InterpreterErrorCodes() {
    }

    /** 所有已登记的码（测试用它遍历，所以**加码不用改测试**）。 */
    public static java.util.Set<String> all() {
        return Collections.unmodifiableSet(MESSAGES.keySet());
    }

    /** 这个码注册过吗（未知码要被发现，而不是悄悄当成通用错误）。 */
    public static boolean known(String code) {
        return code != null && MESSAGES.containsKey(code);
    }

    /** 能不能自动重试（界面据此决定"过一会儿再来一次"还是"叫人"）。 */
    public static boolean isRetryable(String code) {
        Boolean value = RETRYABLE.get(code);
        return value != null && value;
    }

    /**
     * 按码取当前界面语言的文案；没有这个码就退回后端给的人话；再没有就一句通用话。
     *
     * @param code 机器码（`asr-network` 等）；可以为未知值
     * @param hint 后端给的人话（中文/英文都行，仅作兜底）
     */
    public static String message(Context context, String code, String hint) {
        if (context == null) return hint == null ? "" : hint;
        Integer resource = code == null ? null : MESSAGES.get(code);
        if (resource != null) {
            try {
                return context.getString(resource);
            } catch (Exception ignored) {
                // 资源被删了之类：继续往下走兜底
            }
        }
        if (hint != null && !hint.trim().isEmpty()) return hint.trim();
        return context.getString(R.string.err_generic);
    }

    /** 中文摘要里带一句"这条能不能重试"，日志一眼看出是网络问题还是配置问题。 */
    public static String diagnostic(String code) {
        if (!known(code)) return code + "（未登记的错误码）";
        return code + (isRetryable(code) ? "（可重试）" : "（需人工处理）");
    }
}
