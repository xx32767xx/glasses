package com.leion.lanrelay;

/**
 * InterpreterAsrBackend —— 翻译官的**识别后端**（5.31）。
 * ============================================================================
 * 为什么要有这层接口：识别到底走"本地 whisper 管线"还是"云端 fun-asr"，
 * 目前**还没拍板**（见 docs/23 §7）。而这件决定不该传染到界面、翻译、播报、采集——
 * 所以界面只认下面这组事件，后端换实现时上面的东西一行都不用改。
 *
 * 事件形状（与 docs/23 §3 一致）：
 * <pre>
 *   ready                     后端就绪，可以送音频了
 *   partial(id, text, lang)   边说边出（可能是空串；本地管线这条路不会发）
 *   final(id, text, lang)     这一句定了
 *   error(code, hint)         code 是机器码，hint 是人话（界面按三语自己翻）
 * </pre>
 *
 * 两条硬约定：
 * <ol>
 *   <li>**回调都在后台线程**——界面自己 post 回主线程，后端不碰 View；</li>
 *   <li>**`start()` 之前不许送音频**，`stop()` 之后也不要再回调（否则界面会收到幽灵帧）。</li>
 * </ol>
 */
public interface InterpreterAsrBackend {

    /** 给界面显示的后端名字，例如「演示回放」「本地识别」「云端识别」。 */
    String label();

    /**
     * 这条路要不要外网。界面上用来解释"为什么现在识别不了"
     * （云端后端在断网时只能报错；本地后端只要连得上 relay 就行）。
     */
    boolean requiresNetwork();

    /**
     * 这个后端**能识别哪些语言**（BCP-47，如 `zh-CN`）。
     *
     * @return 空数组 = **通用**（自己会判定语种，什么语言都能交；见 {@link #isUniversal()}）。
     *         非空 = 只接这几种，路由据此挑选（5.32「按语言选模型」）。
     */
    String[] languages();

    /** 是不是"通用后端"（`languages()` 为空）。通用后端只在没有语言匹配时兜底。 */
    default boolean isUniversal() {
        return languages().length == 0;
    }

    /**
     * 能不能识别这门语言。
     *
     * <p>匹配规则刻意**宽松**：先精确匹配（`zh-CN`），再按主语言匹配（`zh`）——
     * 因为各家的语种码并不统一（`zh` / `zh-CN` / `zh_cn`），要求逐字相同会让路由莫名其妙地失败。
     * 通用后端对任何语言都说"能"。
     */
    default boolean supports(String lang) {
        String[] owned = languages();
        if (owned.length == 0) return true;
        String wanted = normalizeLang(lang);
        if (wanted.isEmpty()) return false;
        for (String one : owned) {
            String mine = normalizeLang(one);
            if (mine.isEmpty()) continue;
            if (mine.equals(wanted)) return true;
            // 主语言相同就算（zh-CN 与 zh-TW 都算 zh）
            if (primary(mine).equals(primary(wanted))) return true;
        }
        return false;
    }

    /** 语种码归一：小写、下划线换横线、取前后空白。`ZH_cn ` → `zh-cn`。 */
    static String normalizeLang(String lang) {
        return lang == null ? "" : lang.trim().toLowerCase(java.util.Locale.ROOT).replace('_', '-');
    }

    /** 取主语言：`zh-cn` → `zh`。 */
    static String primary(String normalized) {
        int dash = normalized.indexOf('-');
        return dash <= 0 ? normalized : normalized.substring(0, dash);
    }

    /**
     * 开始一场识别。
     *
     * @param lang     **这一场要识别的语言**。5.32 起必须传：后端就是按语言挑出来的，
     *                 它需要这个参数去给识别器设语种（强制语种比自动判定又快又准）。
     *                 语义为 `""` 或 `"auto"` 时表示"你来判定"—— 只有通用后端该接这种情况，
     *                 专用后端应当回 {@code onError("asr-lang-mismatch", …)} 而不是硬猜。
     * @param listener 事件回调
     */
    void start(String lang, Listener listener);

    /**
     * 送一块 16k 单声道 PCM。
     *
     * <p>**允许随时丢**：队列满了、后端还没 ready、这段太旧 —— 都该直接返回而不是阻塞采集
     * （阻塞采集的后果是整条链路一起卡，用户看到的是"卡顿"而不是"少识别一句"）。
     */
    void sendAudio(byte[] pcm, int sampleRate);

    /** 结束一场（幂等）。 */
    void stop();

    /** 后端事件。实现方保证**只在 start 之后、stop 之前**回调。 */
    interface Listener {
        void onReady();

        void onPartial(String id, String text, String lang);

        void onFinal(String id, String text, String lang);

        /**
         * **可选**：这条路同时知道「原文」与「译文」时用它（5.36）。
         *
         * <p>为什么加这个而不改上面两个：识别与翻译**在同一端**完成的后端（例如
         * 「把翻译官当一场会跑」那条路，服务端返回的帧里两个文本都有）能一次把两样交给界面；
         * 而只做识别的后端只需实现 `onPartial/onFinal`，一行都不用改。
         * 默认实现就是退回原有那两个 —— 所以老实现方零改动。
         *
         * @param sourceText 原文（可能为空：这条路不认识原文时）
         * @param text       译文
         */
        default void onPair(String id, String sourceText, String text, String lang, boolean partial) {
            if (partial) {
                onPartial(id, text, lang);
            } else {
                onFinal(id, text, lang);
            }
        }

        /**
         * @param code 机器码（`asr-network` / `asr-auth` / `asr-busy` …），界面据此选文案
         * @param hint 人话（后端尽量给，界面没有对应文案时兜底显示它）
         */
        void onError(String code, String hint);
    }
}
