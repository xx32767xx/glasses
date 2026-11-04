package com.leion.lanrelay;

/**
 * 「这一场到底该用哪个识别语种」—— 一个**必须离线可测**的判据（5.64）。
 * ============================================================================
 *
 * 为什么单独抽出来：2026-11 实机验收时踩到一个很隐蔽的 bug ——
 * 手机写的模型侧车是 `{"zh-CN": {"model": "tiny"}}`，而识别实际按 `en-US` 跑，
 * 于是那一格永远匹配不上，日志里一直是 `模型 large-v3`，看起来"切换没生效"。
 *
 * 根因不在侧车，在**开会话时传的语种**：`InterpreterActivity` 按语言把三个
 * `RelayPipelineBackend` 实例都注册进路由器（`relay:zh-CN` / `relay:pt-BR` / `relay:en-US`），
 * 而这三个都是"通用后端"（`languages()` 为空）。`AsrRouter.resolve()` 对通用后端是
 * **兜底式**挑选 —— 谁先被遍历到就用谁。于是"这场要识别英语"完全可能落到那个
 * `speakLang` 字段写着 `zh-CN` 的实例上：会话语种报成中文、侧车键写成中文，
 * 而上传音频那边用的却是正确的 `partner`（英语）。两边不一致，切换自然不生效。
 *
 * 判据很简单，但**必须只有一处实现**：
 *   · `start(lang)` 给的语种（= 这一场真正要识别的语言）优先；
 *   · 它空着才退回实例自带的那个（历史行为，别把老路径打断）。
 */
public final class SessionLang {

    private SessionLang() {
    }

    /**
     * @param startLang 开跑时路由器告诉我们的"要识别的语言"（可能为空）
     * @param fallback  这个后端实例注册时带的语言（可能为空）
     * @return 归一化后的语种标签（小写、`_`→`-`）；两个都空就返回空串
     */
    public static String choose(String startLang, String fallback) {
        String wanted = InterpreterAsrBackend.normalizeLang(startLang);
        if (!wanted.isEmpty()) return wanted;
        return InterpreterAsrBackend.normalizeLang(fallback);
    }

    /**
     * 侧车（`asr-profiles/<room>.json`）的键该怎么写。
     *
     * <p>刻意写成**和识别侧同一套标签**：侧车是给识别进程按"这一段的语种"查的，
     * 键不一致就等于没写。所以这里不做任何"猜"（例如把 `en` 补成 `en-US`），
     * 只做归一化 —— 猜错比不补更糟。
     */
    public static String sidecarKey(String startLang, String fallback) {
        return choose(startLang, fallback);
    }
}
