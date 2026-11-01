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

    /** 开始一场识别。 */
    void start(Listener listener);

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
         * @param code 机器码（`asr-network` / `asr-auth` / `asr-busy` …），界面据此选文案
         * @param hint 人话（后端尽量给，界面没有对应文案时兜底显示它）
         */
        void onError(String code, String hint);
    }
}
