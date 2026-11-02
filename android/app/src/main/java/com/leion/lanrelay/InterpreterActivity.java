package com.leion.lanrelay;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * InterpreterActivity —— 同传翻译官（5.31 起的真入口）。
 * ============================================================================
 * 这一版只做**骨架**，但骨架是能跑通的：
 *
 * <pre>
 *   首页卡片 → 本页 → 点「开始」→ 回放后端按剧本出字 → 字幕上屏
 *                                          → （若开了朗读且在房间外）译文被念出来
 * </pre>
 *
 * 三个刻意的选择：
 *
 * ① **后端是可换的**（{@link InterpreterAsrBackend}）。现在接的是
 *    {@link ScriptedAsrBackend}（演示回放），页面上明写「演示回放」。
 *    等识别路线拍板，只换后端的实现，本页不动。
 *
 * ② **不假装识别已做好**：卡片徽标写「演示回放」，状态行也写。
 *    我们这条线上"看着能用其实没接"是最贵的错误。
 *
 * ③ **朗读复用房间那套**（{@link TtsQueue}）：队列策略、耳机优先、禁外放、
 *    过期不播全部一致 —— 用户在两个页面听到的行为应该一样。
 *    区别只有一条：翻译官没有"对方原声"，所以不需要二选一。
 */
public class InterpreterActivity extends android.app.Activity {

    private static final String PREFS = "leion";

    private final Handler ui = new Handler(Looper.getMainLooper());

    private TextView statusView;
    private TextView metaView;
    private TextView emptyView;
    private ScrollView scroll;
    private LinearLayout list;
    private Button toggleButton;

    private InterpreterAsrBackend backend;
    /** 5.32：按语言挑后端 —— 页面只跟它要"这一场用谁"，不认识具体引擎。 */
    private AsrRouter router;
    private TtsQueue ttsQueue;
    /** 5.36：路线 B 的采集/上传器（与房间页同一套 MicUploader）。 */
    private MicUploader uploader;
    /** 5.36：路线 B 的服务器客户端（会话 + 帧）。 */
    private LanClient client;
    private boolean running = false;
    /** 读哪种语言（= 入会/设置里选的说话语言；翻译官里它同时也是"朗读哪种译文"）。 */
    private String lang = "zh-CN";
    /** 同一个 id 的 partial 要**原位更新**同一张卡，不要新起一条。 */
    private final List<String> cardIds = new ArrayList<>();
    private final List<View> cards = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_interpreter);

        statusView = findViewById(R.id.interpStatus);
        metaView = findViewById(R.id.interpMeta);
        emptyView = findViewById(R.id.interpEmpty);
        scroll = findViewById(R.id.interpScroll);
        list = findViewById(R.id.interpSubtitles);
        toggleButton = findViewById(R.id.interpToggle);

        String stored = getSharedPreferences(PREFS, MODE_PRIVATE).getString("speakLang", "");
        if (stored != null && !stored.isEmpty()) lang = stored;

        // 朗读：与房间页共用同一套策略（队列/耳机优先/禁外放/过期不播）
        ttsQueue = new TtsQueue(new TtsSpeaker(this));
        ttsQueue.setListener(new TtsQueue.Listener() {
            @Override
            public void onSpeaking(String text, boolean speaking) {
                ui.post(() -> {
                    if (speaking) statusView.setText(getString(R.string.st_tts_speaking));
                });
            }

            @Override
            public void onProblem(String code, String hint) {
                ui.post(() -> {
                    // 5.34：按机器码取当前界面语言的那句；未知码才退回后端人话
                    statusView.setText(InterpreterErrorCodes.message(
                            InterpreterActivity.this, code, hint));
                });
            }
        });
        ttsQueue.setEnabled(getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("ttsRead", false));

        // 5.36：**路线 B** —— 翻译官当"一场会"跑：会话 + 上传音频 + 收服务端字幕帧。
        // 识别与翻译都在服务器上（和会议同一套），所以手机不需要模型也不需要 Key。
        // 「演示回放」保留为**兜底**：连不上服务器时用它跑 UI，并在状态行**明说**不是真翻译。
        LanClient relay = buildClient();
        RelayPipelineBackend pipeline = relay == null ? null
                : new RelayPipelineBackend(relay, myName(), lang, partnerLang());
        router = new AsrRouter();
        if (pipeline != null) router.register("relay", pipeline);
        router.register("scripted", new ScriptedAsrBackend(lang));
        Log.i("LeionInterp", "🧭 识别后端：" + router.describe() + "（对方说 " + partnerLang() + "）");

        refreshMeta();

        findViewById(R.id.interpBack).setOnClickListener(v -> finish());
        toggleButton.setOnClickListener(v -> {
            if (running) {
                stopInterpreting();
            } else {
                startInterpreting();
            }
        });
        statusView.setText(getString(R.string.interp_status_hint));
    }

    @Override
    protected void onStop() {
        // 与房间页同样的规矩：退到前台之外就停（不偷偷占着麦克风/TTS）
        stopInterpreting();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        stopInterpreting();
        if (ttsQueue != null) {
            ttsQueue.shutdown();
            ttsQueue = null;
        }
        ui.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    // ── 开始 / 停止 ────────────────────────────────────────────────────────

    private void startInterpreting() {
        // 5.32：先问路由"这门语言用谁"；问不到就**如实报错并停下**，
        // 绝不"随便找个引擎硬顶"（中文音频塞给葡语模型 = 整段乱码，比没识别更难查）。
        AsrRouter.Resolution picked = router.resolve(lang);
        if (!picked.ok()) {
            statusView.setText(picked.problem);
            Log.w("LeionInterp", "🧭 没有可用后端：" + picked.problem);
            return;
        }
        backend = picked.backend;
        Log.i("LeionInterp", "🧭 这一场用 " + backend.label() + "（" + picked.reason + "）");
        running = true;
        toggleButton.setText(getString(R.string.interp_stop));
        statusView.setText(getString(R.string.interp_starting) + " · " + backend.label());
        clearCards();
        backend.start(lang, new Callbacks());
        // ⚠️ 这里**不立刻开麦**（5.36）：路线 B 要先有会话 id 才能把音频归属到这一场。
        // 会话建好会回调 onReady，那时再开麦（见 Callbacks.onReady）。
        // 提前开麦的第一秒音频会落到"没有房间"的全局文件里 —— 既不属于这场，
        // 也不会被这场的识别进程读到，等于把用户开口的第一句丢了。
    }

    /**
     * 开麦 + 上传（只在「服务器识别」这条路里用）。
     *
     * <p>与房间页一样：**先向仲裁器申请**，抢不到就把原因显示出来；上传时把
     * **对方的语言**当 `?lang=` 报上去（识别按它解码），而成员语言（我读的语言）保持不变 ——
     * 服务端那边对 `kind='interpreter'` 专门跳过了"用上传语种改写成员语言"。
     */
    private void startUpload() {
        String denied = AudioCaptureArbiter.request(AudioCaptureArbiter.OWNER_INTERPRETER);
        if (!denied.isEmpty()) {
            statusView.setText(denied);
            stopInterpreting();
            return;
        }
        uploader = new MicUploader(this, client, new MicUploader.Listener() {
            @Override
            public void onUploadStatus(String message) {
                ui.post(() -> hintLineStatus(message));
            }

            @Override
            public void onUploadError(String message) {
                ui.post(() -> {
                    statusView.setText(message);
                    stopInterpreting();
                });
            }

            @Override
            public void onLevel(float rms, float peak) {
                // 电平不刷界面（每帧刷新会把字幕拖慢），房间页也是这么做的
            }
        });
        AudioCaptureArbiter.attach(AudioCaptureArbiter.OWNER_INTERPRETER, uploader);
        uploader.setLanguage(partnerLang());
        String problem = uploader.start();
        if (problem != null) {
            uploader = null;
            AudioCaptureArbiter.release(AudioCaptureArbiter.OWNER_INTERPRETER);
            statusView.setText(problem);
            stopInterpreting();
        }
    }

    private void stopUpload() {
        AudioCaptureArbiter.release(AudioCaptureArbiter.OWNER_INTERPRETER);
        if (uploader != null) {
            uploader.stop();
            uploader = null;
        }
    }

    private void hintLineStatus(String message) {
        if (statusView != null && message != null && !message.isEmpty()) statusView.setText(message);
    }

    private void stopInterpreting() {
        if (!running) return;
        running = false;
        stopUpload();
        if (backend instanceof RelayPipelineBackend) {
            String id = ((RelayPipelineBackend) backend).sessionId();
            if (!id.isEmpty()) {
                // 结束会话：定格时长（历史里那条记录才不会一直显示"进行中"）
                new Thread(() -> {
                    try { client.orgInterpreterEnd(id); } catch (Exception ignored) { }
                }, "interp-end").start();
            }
        }
        if (backend != null) backend.stop();
        if (ttsQueue != null) ttsQueue.stop();
        toggleButton.setText(getString(R.string.interp_start));
        statusView.setText(getString(R.string.interp_stopped));
    }

    /** 建客户端（用设置页里那套 host/secret/token）。拿不到配置就返回 null。 */
    private LanClient buildClient() {
        android.content.SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String host = prefs.getString("host", "");
        String secret = prefs.getString("secret", "");
        if (host == null || host.isEmpty()) host = getString(R.string.default_server_url);
        if (secret == null || secret.isEmpty()) secret = getString(R.string.default_shared_secret);
        if (host.isEmpty()) return null;
        LanClient built = new LanClient(host, secret, new FrameSink());
        String token = prefs.getString("accountToken", "");
        if (token != null && !token.isEmpty()) built.setToken(token);
        client = built;
        return built;
    }

    private String myName() {
        String name = getSharedPreferences(PREFS, MODE_PRIVATE).getString("termsUser", "");
        return name == null ? "" : name;
    }

    /** 对方说的语言（识别语种）。默认与"我读的语言"互为镜像：中↔葡、中↔英。 */
    private String partnerLang() {
        String mine = getSharedPreferences(PREFS, MODE_PRIVATE).getString("speakLang", "");
        String read = mine == null || mine.isEmpty() ? "zh-CN" : mine;
        // 面对面最常见的是"对方说葡语/英语、我读中文"；反过来同样成立
        if ("zh-CN".equals(read)) return "pt-BR";
        return "zh-CN";
    }

    private void refreshMeta() {
        String langText = "pt-BR".equals(lang) ? getString(R.string.rooms_speak_pt)
                : ("en-US".equals(lang) ? getString(R.string.rooms_speak_en) : getString(R.string.rooms_speak_zh));
        boolean ttsOn = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("ttsRead", false);
        metaView.setText(getString(R.string.interp_meta, langText,
                getString(ttsOn ? R.string.st_tts_on : R.string.st_tts_off)));
        // 5.32：把"这门语言会被谁识别"直接摊在界面上（找不到时也要说清）
        AsrRouter.Resolution picked = router == null ? null : router.resolve(lang);
        TextView badge = findViewById(R.id.interpBackend);
        if (badge != null) {
            if (picked != null && picked.ok()) {
                badge.setText(picked.backend.label());
                badge.setVisibility(View.VISIBLE);
            } else {
                badge.setText(getString(R.string.interp_no_backend));
                badge.setVisibility(View.VISIBLE);
            }
        }
    }

    // ── 后端回调（后台线程）──────────────────────────────────────────────

    /**
     * 路线 B 的帧入口（5.36）：服务端回来的每一帧字幕直接变成一张卡。
     *
     * <p>与房间页同一个 Listener 契约，所以"原文在上、译文在下 + 增量原位更新"
     * 这套显示逻辑完全一样 —— 这正是把翻译官当一场会跑的好处。
     */
    private final class FrameSink implements LanClient.Listener {
        @Override
        public void onStatus(String message) {
            ui.post(() -> hintLineStatus(message));
        }

        @Override
        public void onHello(String device, int cols, int lineBudget) {
            // 显示预算暂不用（本页按自己的布局排）
        }

        @Override
        public void onFrame(String speaker, String langTag, String[] lines, String text,
                            String source, String sourceLang, boolean partial, String[] termsMissing,
                            String speakerName, String notice) {
            ui.post(() -> {
                String translated = text == null || text.isEmpty()
                        ? (lines == null ? "" : String.join("\n", lines)) : text;
                String src = source == null ? "" : source;
                if (translated.isEmpty() && src.isEmpty()) return;
                renderCard("frame-" + (partial ? "p" : "f") + "-" + System.identityHashCode(lines)
                        + "-" + translated.hashCode(), src, translated, partial);
                // 只朗读**定稿且非空**的译文；partial 是半句，念出来很怪（与房间页一致）
                if (!partial && ttsQueue != null && !translated.isEmpty()) {
                    ttsQueue.offer(translated, langTag == null || langTag.isEmpty() ? lang : langTag);
                }
                if (notice != null && !notice.isEmpty() && "same-language".equals(notice)) {
                    statusView.setText(getString(R.string.st_same_language));
                }
            });
        }

        @Override
        public void onError(String message) {
            ui.post(() -> hintLineStatus(message));
        }
    }

    private final class Callbacks implements InterpreterAsrBackend.Listener {
        @Override
        public void onReady() {
            ui.post(() -> {
                if (statusView != null) statusView.setText(getString(R.string.interp_ready));
                // 5.36：会话已经在服务器上建好、客户端也订阅上这一场了，**现在**才开麦 ——
                // 这个顺序保证每一块音频都带着房间 id（否则第一句会落进没人读的全局文件）。
                if (running && backend instanceof RelayPipelineBackend && uploader == null) {
                    startUpload();
                }
            });
        }

        @Override
        public void onPartial(String id, String text, String langTag) {
            ui.post(() -> renderCard(id, "", text, true));
        }

        @Override
        public void onFinal(String id, String text, String langTag) {
            ui.post(() -> {
                renderCard(id, "", text, false);
                // 只朗读**定稿且非空**的译文（尾部那句空串是"演完了"的信号，不念）
                if (ttsQueue != null && text != null && !text.isEmpty()) {
                    ttsQueue.offer(text, lang);
                }
            });
        }

        @Override
        public void onError(String code, String hint) {
            ui.post(() -> {
                if (statusView != null) {
                    statusView.setText(InterpreterErrorCodes.message(
                            InterpreterActivity.this, code, hint));
                }
            });
        }
    }

    // ── 字幕流（与房间页同一套规矩：同 id 原位更新、新句往下推、自动滚到底）──

    /**
     * 落一张卡（5.36：多了 `source` 参数）。
     *
     * <p>为什么带原文：路线 B 的帧里**同时有原文和译文**（服务端都算好了），
     * 而"原文在上、译文在下"是房间页已经在用的显示方式 —— 本页照同一套排，
     * 用户不用学两套版式。纯识别后端（演示回放）没有原文，传空串即可。
     */
    private void renderCard(String id, String source, String text, boolean partial) {
        String src = source == null ? "" : source.trim();
        if ((text == null || text.isEmpty()) && src.isEmpty()) {
            if (id != null && id.endsWith("-end")) {
                statusView.setText(getString(R.string.interp_finished));
            }
            return;
        }
        emptyView.setVisibility(View.GONE);
        scroll.setVisibility(View.VISIBLE);

        int index = cardIds.indexOf(id);
        View card;
        TextView main;
        TextView sub;
        if (index >= 0) {
            // 原位更新：同一句的 partial → 定稿只占一张卡
            card = cards.get(index);
            main = (TextView) card.findViewWithTag("main");
            sub = (TextView) card.findViewWithTag("sub");
        } else {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setBackgroundResource(R.drawable.bg_card);
            int pad = Math.round(getResources().getDisplayMetrics().density * 12);
            box.setPadding(pad, pad, pad, pad);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            params.bottomMargin = pad / 2;
            box.setLayoutParams(params);

            sub = new TextView(this);
            sub.setTag("sub");
            sub.setTextColor(getColor(R.color.ink_soft));
            sub.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,
                    getResources().getDimension(R.dimen.text_secondary));
            sub.setVisibility(View.GONE);
            box.addView(sub);

            main = new TextView(this);
            main.setTag("main");
            main.setTextColor(getColor(R.color.ink));
            main.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,
                    getResources().getDimension(R.dimen.text_body));
            box.addView(main);

            list.addView(box);
            cardIds.add(id);
            cards.add(box);
            card = box;
        }
        if (card == null || main == null) return;
        // 原文（小字、灰）在上；译文（大字）在下 —— 与房间页一致
        if (sub != null) {
            sub.setText(src);
            sub.setVisibility(src.isEmpty() ? View.GONE : View.VISIBLE);
        }
        // 未定稿的句子画成浅色：一眼看出"这句还在成形"
        main.setTextColor(getColor(partial ? R.color.ink_soft : R.color.ink));
        main.setText(text == null ? "" : text);
        scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }

    private void clearCards() {
        list.removeAllViews();
        cardIds.clear();
        cards.clear();
        emptyView.setVisibility(View.VISIBLE);
        scroll.setVisibility(View.GONE);
        Log.i("LeionInterp", "🗒 清空字幕流");
    }
}
