package com.leion.lanrelay;

import android.util.Log;

import org.json.JSONObject;

/**
 * RelayPipelineBackend —— 「把翻译官**当一场会**跑」这条路的实现（5.36，路线 B）。
 * ============================================================================
 * 它做的事情很朴素：**开一场会话 → 照会议那样上传音频 → 收服务端回来的字幕帧**。
 * 识别（whisper）与翻译（DeepSeek + 术语 + 校对）都在服务器上，和会议是同一套代码 ——
 * 所以这条后端**不需要在手机上放任何模型、任何 API Key**。
 *
 * 为什么选它做"初步接入"：
 * <ul>
 *   <li>翻译质量、术语一致性、校对行为**与会议完全相同**（同一个大脑进程在算）；</li>
 *   <li>不用新增 LLM 通路（relay 现在没有 LLM 客户端，见 docs/21 §5.36）；</li>
 *   <li>识别是整句出字（没有 partial），但"说完一句 ~1~2 秒出译文"对面对面场景够用。</li>
 * </ul>
 *
 * <p><b>与会议的唯一语义差别</b>：上传的音频是**对方**说的（`?lang=<对方语言>`），
 * 而我自己读的是另一门语言 —— 所以服务端**不会**用上传语种改写我的成员语言
 * （relay 里 `audioRoomKind()` 那一处判断）。
 *
 * <p>这一层刻意**不碰**麦克风：采集由 {@link MicUploader} 负责、租约由
 * {@link AudioCaptureArbiter} 管。本类只做"会话 + 帧"。
 */
public final class RelayPipelineBackend implements InterpreterAsrBackend {

    private static final String TAG = "LeionInterp";

    private final LanClient client;
    private final String userName;
    /** 我读的语言（译文目标）。 */
    private final String readLang;
    /** 对方说的语言（识别语种，随音频上报）。 */
    private final String speakLang;
    /**
     * 引擎偏好（5.39/5.40，来自 `asr-routes.json`）。
     *
     * <p>5.40 起它**会真的发给服务器**（会话创建时带上 `asrModels`）：
     * 识别进程按"房间覆盖 > 服务器模型表 > 默认"选模型，所以这张表确实能拿来做 A/B。
     * 但服务器可能没有这个模型 —— 那种情况识别进程会明确报"加载失败并跳过这一段"，
     * 不会偷偷换成别的模型（否则 A/B 的结论就是假的）。
     */
    private final String engine;

    /**
     * 引擎家族（5.58：`whisper` / `parakeet`…）。空 = 不指定，服务器用它缺省的那个。
     * 与 {@link #engine} 一起发给服务器（`asrEngines`），侧车里两个字段都能表达。
     */
    private final String asrEngine;

    private volatile boolean running = false;
    private volatile String sessionId = "";
    /** 这一场**真正**要识别的语种（5.64：以 `start(lang)` 传进来的为准，见 SessionLang）。 */
    private volatile String sessionSpeakLang = "";
    private Listener listener;

    public RelayPipelineBackend(LanClient client, String userName, String readLang, String speakLang) {
        this(client, userName, readLang, speakLang, "");
    }

    public RelayPipelineBackend(LanClient client, String userName, String readLang, String speakLang,
                                String engine) {
        this(client, userName, readLang, speakLang, engine, "");
    }

    public RelayPipelineBackend(LanClient client, String userName, String readLang, String speakLang,
                                String engine, String asrEngine) {
        this.client = client;
        this.userName = userName == null ? "" : userName;
        this.readLang = readLang == null || readLang.isEmpty() ? "zh-CN" : readLang;
        this.speakLang = speakLang == null || speakLang.isEmpty() ? "pt-BR" : speakLang;
        this.engine = engine == null ? "" : engine;
        this.asrEngine = asrEngine == null ? "" : asrEngine;
    }

    /** 模型偏好（给界面/日志用）。 */
    public String engine() {
        return engine;
    }

    /** 引擎家族偏好（给界面/日志用）。 */
    public String asrEngine() {
        return asrEngine;
    }

    @Override
    public String debugLabel() {
        return "服务器识别 + 翻译";
    }

    @Override
    public boolean requiresNetwork() {
        return true;
    }

    /**
     * 这条路**什么语言都能接**（真正的语种判定在服务器上，按分轨 `.lang` 强制解码）。
     * 所以它是通用后端；将来若接入"中文走本地、葡语走云端"，那些后端才是专用后端。
     */
    @Override
    public String[] languages() {
        return new String[0];
    }

    @Override
    public void start(String lang, Listener target) {
        if (running) return;
        // 5.64：语种以**路由器传来的**为准。三个通用实例可互换（AsrRouter 对通用后端是
        // 兜底式挑选），若沿用实例自带字段，开会话会把语种报成另一个语言 ——
        // 模型侧车的键就跟着写错，识别侧永远匹配不上（实测：侧车写 zh-CN、识别按 en-US）。
        sessionSpeakLang = SessionLang.choose(lang, speakLang);
        this.listener = target;
        running = true;
        new Thread(this::openSessionAndListen, "interp-session").start();
    }

    /** 这条路手机自己上传音频（见类注释），所以这个方法不会被用到。 */
    @Override
    public void sendAudio(byte[] pcm, int sampleRate) {
        // 刻意空实现：采集与上传由 MicUploader 独占（它也走仲裁器）
    }

    @Override
    public void stop() {
        running = false;
        if (client != null) client.stop();
    }

    /** 会话 id（界面/诊断用；空 = 还没开起来）。 */
    public String sessionId() {
        return sessionId;
    }

    /** 对方说的语言：`MicUploader` 上传时用它当 `?lang=`。 */
    public String speakLang() {
        return sessionSpeakLang.isEmpty() ? speakLang : sessionSpeakLang;
    }

    // ── 内部 ──────────────────────────────────────────────────────────────

    private void openSessionAndListen() {
        Listener target = listener;
        if (target == null) return;
        try {
            JSONObject created = client.orgInterpreterStart("同传翻译官", readLang, speakLang(),
                    engine, asrEngine);
            JSONObject session = created == null ? null : created.optJSONObject("session");
            String id = session == null ? "" : session.optString("id", "");
            // 服务器**实际收到**的模型请求（可能是空的：没指定/说了它不认识/写侧车失败）。
            // 这一句是 A/B 时唯一可信的"到底按哪个模型在跑"的依据，所以打进日志。
            JSONObject appliedModels = created == null ? null : created.optJSONObject("asrModels");
            Log.i(TAG, "🎛 模型请求：" + (engine.isEmpty() && asrEngine.isEmpty() ? "（没指定）"
                    : (asrEngine.isEmpty() ? "" : asrEngine + " / ") + (engine.isEmpty() ? "（模型不指定）" : engine))
                    + " → 服务器收到 " + (appliedModels == null ? "（无）" : appliedModels.toString()));
            if (id.isEmpty()) {
                target.onError(InterpreterErrorCodes.ASR_FAILED, "服务器没有返回会话 id");
                running = false;
                return;
            }
            sessionId = id;
            if (!running) {
                // 开完会话前用户就点了停止：直接收掉
                try { client.orgInterpreterEnd(id); } catch (Exception ignored) { }
                return;
            }
            Log.i(TAG, "🎬 会话已建：" + id + "（对方说 " + speakLang + "，我读 " + readLang + "）");
            // 只订阅这一场的字幕（与房间页同一条通道）
            client.setRoom(id);
            if (!userName.isEmpty()) client.setSpeaker(userName);
            client.start();
            target.onReady();
        } catch (Exception error) {
            Log.w(TAG, "建会话失败：" + error);
            running = false;
            target.onError(InterpreterErrorCodes.ASR_NETWORK, describe(error));
        }
    }

    private static String describe(Exception error) {
        String text = error == null ? "" : String.valueOf(error.getMessage());
        return text.isEmpty() ? "连不上服务器" : text;
    }
}
