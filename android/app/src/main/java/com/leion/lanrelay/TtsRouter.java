package com.leion.lanrelay;

/**
 * TtsRouter —— 「这门语言该用哪条合成链路」（5.157）
 * ============================================================================
 *
 * <p>两条链路都留着（用户明确要求：本地那条不删，开关控制走哪条，也当备份与对比用）：
 *
 * <table>
 *   <tr><th>语言</th><th>默认走哪</th><th>为什么</th></tr>
 *   <tr><td>zh-CN</td><td>**服务器**（5.164 起；原来本地）</td>
 *       <td>部分机型没有中文语音包，且第三方引擎音色不受控 —— 统一走服务器少一个变量</td></tr>
 *   <tr><td>pt-BR / en-US</td><td>**服务器 piper**</td>
 *       <td>手机基本没装这两门语言的语音包（实测巴葡没有），本地引擎直接"念不出来"</td></tr>
 * </table>
 *
 * <p>偏好 `ttsUseServer`（「我的 → 语音合成」那颗开关，缺省开）：
 * 关掉之后**全部**走手机本地 —— 既是"服务器挂了还有声音"的备份，也是两条链路对比的入口
 * （对比时要控制变量，所以它必须是一个开关，而不是藏在代码里的常量）。
 *
 * <p>为什么单独成类：这个判断将来会长（比如"英语回本地""按音色挑引擎"），
 * 而它必须**可测**（纯 Java、不碰 Android），`tests/tts-suite.mjs` 会拿它当规则表验证。
 */
public final class TtsRouter {

    /** 「我的」里那颗开关的偏好键（缺省 true = 用服务器）。 */
    public static final String PREF_USE_SERVER = "ttsUseServer";

    private TtsRouter() {
    }

    /**
     * 这一门语言**是否优先走服务器**（只看语言本身，不看用户开关）。
     *
     * <p>中文恒为 false：即使开了服务器，中文也走本地。理由写在类注释的表格里。
     */
    public static boolean prefersServer(String lang) {
        String code = lang == null ? "" : lang.trim().toLowerCase(java.util.Locale.ROOT);
        if (code.isEmpty()) return false;
        // 5.164：**三门语言都走服务器**（原来中文留在手机本地）。
        // 理由：部分机型根本没有中文语音包（或只有第三方引擎，音色/稳定性都不受我们控制），
        // 而服务器上的 piper 是同一套音色与同一套行为 —— 现场出问题时少一个变量。
        // 手机本地那条路仍然保留，由「我的 → 语音合成」那颗开关整体切回去（备份 + 对比）。
        return code.startsWith("zh") || code.startsWith("pt") || code.startsWith("en");
    }

    /**
     * 最终决定：这门语言现在该走服务器吗。
     *
     * @param lang      目标语言（zh-CN / pt-BR / en-US）
     * @param useServer 用户在「我的」里选的（true = 允许走服务器）
     */
    public static boolean serverFor(String lang, boolean useServer) {
        if (!useServer) return false;
        return prefersServer(lang);
    }
}
