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

        // 5.32：识别后端**按语言**注册。现在只有一个"通用演示回放"；
        // 将来是「中文→本地 whisper」「葡语→云端 fun-asr」这样一门语言一条。
        // 页面不认识任何具体引擎，只向 router 要"这一场用谁"。
        router = new AsrRouter();
        router.register("scripted", new ScriptedAsrBackend(lang));
        Log.i("LeionInterp", "🧭 识别后端：" + router.describe());

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
    }

    private void stopInterpreting() {
        if (!running) return;
        running = false;
        if (backend != null) backend.stop();
        if (ttsQueue != null) ttsQueue.stop();
        toggleButton.setText(getString(R.string.interp_start));
        statusView.setText(getString(R.string.interp_stopped));
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

    private final class Callbacks implements InterpreterAsrBackend.Listener {
        @Override
        public void onReady() {
            ui.post(() -> {
                if (statusView != null) statusView.setText(getString(R.string.interp_ready));
            });
        }

        @Override
        public void onPartial(String id, String text, String langTag) {
            ui.post(() -> renderCard(id, text, true));
        }

        @Override
        public void onFinal(String id, String text, String langTag) {
            ui.post(() -> {
                renderCard(id, text, false);
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
                    statusView.setText(hint == null || hint.isEmpty()
                            ? getString(R.string.interp_failed, code) : hint);
                }
            });
        }
    }

    // ── 字幕流（与房间页同一套规矩：同 id 原位更新、新句往下推、自动滚到底）──

    private void renderCard(String id, String text, boolean partial) {
        if (text == null || text.isEmpty()) {
            if (id != null && id.endsWith("-end")) {
                statusView.setText(getString(R.string.interp_finished));
            }
            return;
        }
        emptyView.setVisibility(View.GONE);
        scroll.setVisibility(View.VISIBLE);

        int index = cardIds.indexOf(id);
        TextView card;
        if (index >= 0) {
            // 原位更新：同一句的 partial → 定稿只占一张卡
            card = (TextView) cards.get(index);
        } else {
            card = new TextView(this);
            card.setBackgroundResource(R.drawable.bg_card);
            int pad = Math.round(getResources().getDisplayMetrics().density * 12);
            card.setPadding(pad, pad, pad, pad);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            params.bottomMargin = pad / 2;
            card.setLayoutParams(params);
            card.setTextColor(getColor(R.color.ink));
            card.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,
                    getResources().getDimension(R.dimen.text_body));
            list.addView(card);
            cardIds.add(id);
            cards.add(card);
        }
        // 未定稿的句子画成浅色：一眼看出"这句还在成形"
        card.setTextColor(getColor(partial ? R.color.ink_soft : R.color.ink));
        card.setText(text);
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
