package com.leion.lanrelay;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
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
    /** 我读的语言（5.37 起翻译官有自己的偏好，不再跟会议的「说话语言」共用一个键）。 */
    private static final String PREF_READ = "interpReadLang";
    /** 对方说的语言（`""`/`auto` = 按 {@link InterpreterLang#defaultPartner(String)} 推）。 */
    private static final String PREF_PARTNER = "interpPartnerLang";
    /**
     * 历史那一块一次读多少条（服务端的 `limit`）。
     *
     * <p>为什么不是"全部"：这一块是"我最近几场同传"，翻旧账有底部导航那个「历史」页。
     * 50 条足够覆盖任何一天的使用，也不至于让这一页一次拉几百条记录。
     */
    private static final int HISTORY_LIMIT = 50;

    private final Handler ui = new Handler(Looper.getMainLooper());

    private TextView statusView;
    private TextView metaView;
    private TextView emptyView;
    private ScrollView scroll;
    private LinearLayout list;
    /**
     * 5.48：字幕流交给**房间页同一个** {@link SubtitleList}（按原文归并）。
     * 以前这里自己维护 `cardIds`/`cards`，用"每帧一个新 id"画卡片 ——
     * 于是同一句的原文帧、增量译文帧、定稿译文帧各占一张，屏幕上重复+闪烁。
     */
    private SubtitleList subtitles;
    /** 本场开始的时刻（字幕的时间标记用 mm:ss）。 */
    private long startedAt = System.currentTimeMillis();
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
    /** 我读的语言（= 译文语言，也是朗读语言）。默认跟设置页的「我说什么语言」走。 */
    private String lang = InterpreterLang.ZH;
    /** 对方说的语言（= 识别语种）。由 {@link InterpreterLang} 的规则推出/校验。 */
    private String partner = InterpreterLang.PT;
    /** 同一个 id 的 partial 要**原位更新**同一张卡，不要新起一条。 */
    // ── 三块（5.37）：配置 / 收听 / 历史 ────────────────────────────────────
    /** 现在看的是哪一块（0 配置 / 1 收听 / 2 历史）。 */
    private int tab = TAB_LIVE;
    private static final int TAB_CONFIG = 0;
    private static final int TAB_LIVE = 1;
    private static final int TAB_HISTORY = 2;
    private View configPanel;
    private View livePanel;
    private View historyPanel;
    private TextView tabConfig;
    private TextView tabLive;
    private TextView tabHistory;
    private TextView whereView;
    private Switch ttsSwitch;
    private LinearLayout historyList;
    private ScrollView historyScroll;
    private TextView historyHint;
    private TextView historyEmpty;
    /** 历史只读一次（除非在这页里结束了一场，见 {@link #stopInterpreting()}）。 */
    private boolean historyLoaded = false;
    /** 5.39：「哪门语言用哪个识别函数」的表（`assets/asr-routes.json`）。 */
    private AsrRouteLoader.Table routeTable = AsrRouteLoader.Table.broken("");
    /** 5.39：每门语言**不能**用的原因（表指向未实现的后端 / 没填服务器地址）。 */
    private final java.util.Map<String, String> routeProblems = new java.util.LinkedHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_interpreter);

        statusView = findViewById(R.id.interpStatus);
        metaView = findViewById(R.id.interpMeta);
        emptyView = findViewById(R.id.interpEmpty);
        scroll = findViewById(R.id.interpScroll);
        list = findViewById(R.id.interpSubtitles);
        // 5.48：与房间页共用的字幕列表（按原文归并、自动跟随、手指上滑暂停跟随）
        subtitles = new SubtitleList(getLayoutInflater(), scroll, list, null);
        subtitles.setBilingual(true);
        toggleButton = findViewById(R.id.interpToggle);
        configPanel = findViewById(R.id.interpConfigPanel);
        livePanel = findViewById(R.id.interpLivePanel);
        historyPanel = findViewById(R.id.interpHistoryPanel);
        tabConfig = findViewById(R.id.interpTabConfig);
        tabLive = findViewById(R.id.interpTabLive);
        tabHistory = findViewById(R.id.interpTabHistory);
        whereView = findViewById(R.id.interpWhere);
        ttsSwitch = findViewById(R.id.interpTtsSwitch);
        historyList = findViewById(R.id.interpHistoryList);
        historyScroll = findViewById(R.id.interpHistoryScroll);
        historyHint = findViewById(R.id.interpHistoryHint);
        historyEmpty = findViewById(R.id.interpHistoryEmpty);

        // 5.37：两种语言都**过一遍规则**（见 InterpreterLang）：旧配置、手改的偏好、
        // 或者"读语言与对方语言相同"这种死局，都不能带进一场翻译里。
        android.content.SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String storedRead = prefs.getString(PREF_READ, "");
        if (storedRead == null || storedRead.isEmpty()) {
            // 第一次进来：跟设置页的「我说什么语言」走（翻译官默认就是"我说什么就读什么"）
            storedRead = prefs.getString("speakLang", "");
        }
        lang = InterpreterLang.resolveRead(storedRead);
        partner = InterpreterLang.resolvePartner(prefs.getString(PREF_PARTNER, ""), lang);

        // 朗读：与房间页共用同一套策略（队列/耳机优先/禁外放/过期不播）
        // 5.38：整层先停用（{@link TtsFeature}：用户定的「先不使用」）。
        // 关着时不建队列、也不显示配置里那一行 —— 播报对这套场景不是必需品，字幕就够用。
        if (TtsFeature.enabled()) {
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
            ttsQueue.setEnabled(prefs.getBoolean("ttsRead", false));
        } else {
            View ttsBlock = findViewById(R.id.interpConfigTtsBlock);
            if (ttsBlock != null) ttsBlock.setVisibility(View.GONE);
        }

        // 5.36：**路线 B** —— 翻译官当"一场会"跑：会话 + 上传音频 + 收服务端字幕帧。
        // 识别与翻译都在服务器上（和会议同一套），所以手机不需要模型也不需要 Key。
        // 5.39：**哪门语言用哪个识别函数**先读表（`assets/asr-routes.json`），再按表注册后端。
        routeTable = AsrRouteLoader.load(this);
        if (!routeTable.problem.isEmpty()) {
            Log.w("LeionInterp", "🧾 路由表有问题：" + routeTable.problem);
            statusView.setText(routeTable.problem);
        }
        rebuildRouter();

        applyConfig();
        wireTabs();
        wireConfig();
        findViewById(R.id.interpHistoryAll).setOnClickListener(v -> openAllHistory());

        findViewById(R.id.interpBack).setOnClickListener(v -> finish());
        toggleButton.setOnClickListener(v -> {
            if (running) {
                stopInterpreting();
            } else {
                startInterpreting();
            }
        });
        showTab(TAB_LIVE);
    }

    /**
     * 按**当前配置 + 路由表**重建后端（5.37 / 5.39）。
     *
     * <p>为什么不在 onCreate 里只建一次：用户可能刚去设置页改了服务器地址/密钥再回来。
     * 那时候还拿着旧客户端，"点开始"会连到旧地址 —— 而且不报错，只是"怎么还是不通"。
     * 所以每次**开跑之前**都按当时的配置重建一次（代价是一次对象构造，不连网）。
     *
     * <p>5.39 起"哪门语言用哪个后端"**不再写死在代码里**，而是读 `assets/asr-routes.json`：
     * 每门语言查一次表，能用的就按表注册，不能用（指向未实现的后端 / 没填服务器地址）
     * 就把**原因**记下来 —— 选到那门语言时页面直接把原因说出来，绝不悄悄换一个后端顶上。
     */
    private void rebuildRouter() {
        LanClient relay = buildClient();
        client = relay;
        router = new AsrRouter();
        routeProblems.clear();
        java.util.LinkedHashSet<String> langs = new java.util.LinkedHashSet<>();
        for (String one : InterpreterLang.ALL) langs.add(one);
        langs.addAll(routeTable.languages.keySet());
        for (String one : langs) {
            AsrRouteTable.Route route = AsrRouteTable.resolve(
                    routeTable.defaults, routeTable.languages, routeTable.backends, one);
            if (!route.ok()) {
                routeProblems.put(one, route.problem);
                continue;
            }
            InterpreterAsrBackend built = buildBackend(route, one, relay);
            if (built == null) {
                routeProblems.put(one, getString(R.string.interp_route_no_client, route.backendId));
                continue;
            }
            router.register(route.backendId + ":" + one, built);
        }
        Log.i("LeionInterp", "🧭 路由表 → " + router.describe() + "（我读 " + lang + "，对方说 " + partner + "）");
        refreshMeta();
        refreshWhere();
        // 第一句提示要说**这一场实际会怎么跑**，而不是一句写死的文案
        AsrRouter.Resolution first = router.resolve(partner);
        boolean hasRelay = first != null && first.ok() && first.backend instanceof RelayPipelineBackend;
        if (statusView != null) {
            statusView.setText(getString(hasRelay ? R.string.interp_hint_relay : R.string.interp_status_hint));
        }
    }

    /**
     * 按路由表里那一行造一个后端（5.39）。
     *
     * <p>这张"id → 实现"的映射就是"提前准备好的识别函数"清单：
     * <ul>
     *   <li>`relay` → 服务器 whisper + 大脑（手机不跑模型）；</li>
     *   <li>`scripted` → 演示回放（按剧本出字，页面会明写不是真识别）；</li>
     *   <li>其它 id（例如表里预留的 `on-device`）→ 返回 null，由调用方把"还没实现"说出来。</li>
     * </ul>
     *
     * @param speakLang 这一路要识别的语言（= 对方说的语言；relay 会把它当 `?lang=` 上报）
     */
    private InterpreterAsrBackend buildBackend(AsrRouteTable.Route route, String speakLang, LanClient relay) {
        if ("relay".equals(route.backendId)) {
            if (relay == null) return null;
            // 5.69：「这一场用哪个模型」**不再由手机决定**（见 docs/21 §5.69）——
            // 归服务器管：`scripts/asr-model-switch.mjs` 改表即生效（5.108 起房间侧车已整层删除，表是唯一决定点）。
            // 手机这边只保留路由表那一列（`asr-routes.json` 的 engine，默认 `server-default`
            // 表示"不指定"），它仍然会作为 asrModels 报给服务器 —— 一个可用的逃生口。
            return new RelayPipelineBackend(relay, myName(), lang, speakLang, route.engine);
        }
        if ("scripted".equals(route.backendId)) {
            return new ScriptedAsrBackend(speakLang);
        }
        return null;
    }

    /** 这门语言的路由不可用时，给用户看的那句话（能自动跟随配置变化）。 */
    private String routeProblemOf(String speakLang) {
        String recorded = routeProblems.get(speakLang);
        if (recorded != null && !recorded.isEmpty()) return recorded;
        AsrRouter.Resolution picked = router == null ? null : router.resolve(speakLang);
        return picked == null || !picked.ok() ? (picked == null ? "" : picked.problem) : "";
    }

    @Override
    protected void attachBaseContext(android.content.Context base) {
        // 5.37：界面语言（4.56 的那套机制）—— 不接这里，英文/葡语界面下本页会说中文
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        UiLang.trackShown(this);
        // 从设置页回来：服务器地址/密钥可能改了 —— 没在跑就按新配置重建后端（在跑就别动）
        if (!running) rebuildRouter();
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

    // ── 三块（配置 / 收听 / 历史）──────────────────────────────────────────

    /**
     * 切到某一块（5.37）。
     *
     * <p>为什么是**同一页里的三段**而不是三个 Activity：这三块共用同一份状态
     * （我读的语言、对方语言、正在跑的那一场）。分开就会变成"配置页存偏好 → 收听页读偏好 →
     * 中途改了要不要重开"这种跨页同步问题，而它对我们毫无价值。
     *
     * <p>⚠️ 切到别的块时**不会**停掉正在跑的那一场：用户去配置看一眼语言、
     * 或者去翻一条历史，都不该把同传停掉（停掉是他按「停止」或离开本页时的事）。
     */
    private void showTab(int next) {
        tab = next;
        configPanel.setVisibility(next == TAB_CONFIG ? View.VISIBLE : View.GONE);
        livePanel.setVisibility(next == TAB_LIVE ? View.VISIBLE : View.GONE);
        historyPanel.setVisibility(next == TAB_HISTORY ? View.VISIBLE : View.GONE);
        styleTab(tabConfig, next == TAB_CONFIG);
        styleTab(tabLive, next == TAB_LIVE);
        styleTab(tabHistory, next == TAB_HISTORY);
        if (next == TAB_HISTORY && !historyLoaded) loadHistory();
        if (next == TAB_CONFIG) applyConfig();
    }

    private void styleTab(TextView view, boolean on) {
        view.setBackgroundResource(on ? R.drawable.bg_pill_active : R.drawable.bg_chip);
        view.setTextColor(getColor(on ? R.color.on_brand : R.color.ink_soft));
    }

    private void wireTabs() {
        tabConfig.setOnClickListener(v -> showTab(TAB_CONFIG));
        tabLive.setOnClickListener(v -> showTab(TAB_LIVE));
        tabHistory.setOnClickListener(v -> showTab(TAB_HISTORY));
    }

    // ── 配置 ──────────────────────────────────────────────────────────────

    private void wireConfig() {
        findViewById(R.id.interpReadZh).setOnClickListener(v -> setReadLang(InterpreterLang.ZH));
        findViewById(R.id.interpReadPt).setOnClickListener(v -> setReadLang(InterpreterLang.PT));
        findViewById(R.id.interpReadEn).setOnClickListener(v -> setReadLang(InterpreterLang.EN));
        findViewById(R.id.interpPartnerZh).setOnClickListener(v -> setPartnerLang(InterpreterLang.ZH));
        findViewById(R.id.interpPartnerPt).setOnClickListener(v -> setPartnerLang(InterpreterLang.PT));
        findViewById(R.id.interpPartnerEn).setOnClickListener(v -> setPartnerLang(InterpreterLang.EN));
        findViewById(R.id.interpOpenSettings).setOnClickListener(v ->
                startActivity(new android.content.Intent(this, SettingsActivity.class)));
        if (TtsFeature.enabled() && ttsSwitch != null) {
            ttsSwitch.setChecked(getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("ttsRead", false));
            ttsSwitch.setOnCheckedChangeListener((button, checked) -> {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("ttsRead", checked).apply();
                if (ttsQueue != null) ttsQueue.setEnabled(checked);
                refreshMeta();
            });
        }
    }

    /**
     * 改「我读的语言」。对方语言若因此变得非法（例如读葡语时对方不能也是葡语），
     * 按规则重新推一个 —— 绝不留下"原文与译文同语言"这种死局。
     * <p>5.106：合法集合是"除我读的那门以外的两种"，所以读葡语时对方可以是中文**或英语**。
     */
    private void setReadLang(String next) {
        String read = InterpreterLang.resolveRead(next);
        if (read.equals(lang)) return;
        lang = read;
        partner = InterpreterLang.resolvePartner(partner, lang);
        persistLangs();
        applyConfig();
        afterLanguageChange();
    }

    private void setPartnerLang(String next) {
        String picked = InterpreterLang.resolvePartner(next, lang);
        if (picked.equals(partner)) return;
        partner = picked;
        persistLangs();
        applyConfig();
        afterLanguageChange();
    }

    private void persistLangs() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(PREF_READ, lang)
                .putString(PREF_PARTNER, partner)
                .apply();
    }

    /**
     * 语言变了之后（5.37）：正在跑的那一场**必须重开** —— 它用的是旧语言开会话、
     * 上传时带的是旧的识别语种。悄悄继续跑，用户看到的是"语言改了但译文没变"。
     */
    private void afterLanguageChange() {
        refreshMeta();
        if (!running) {
            statusView.setText(getString(R.string.interp_lang_changed, langText(partner)));
            return;
        }
        stopInterpreting();
        statusView.setText(getString(R.string.interp_lang_changed, langText(partner)));
    }

    /** 把配置块的现状画出来：胶囊的高亮、不可选项的禁用、只读摘要。 */
    private void applyConfig() {
        styleChip(findViewById(R.id.interpReadZh), InterpreterLang.ZH.equals(lang), true);
        styleChip(findViewById(R.id.interpReadPt), InterpreterLang.PT.equals(lang), true);
        styleChip(findViewById(R.id.interpReadEn), InterpreterLang.EN.equals(lang), true);

        // 对方语言的选项集合由「我读的语言」决定：除我读的那门以外的两种都合法
        // （5.106：读葡语/英语时也能选英语/葡语 —— 以前这里只给中文一个选项）
        String[] options = InterpreterLang.partnerOptions(lang);
        styleChip(findViewById(R.id.interpPartnerZh), InterpreterLang.ZH.equals(partner), allows(options, InterpreterLang.ZH));
        styleChip(findViewById(R.id.interpPartnerPt), InterpreterLang.PT.equals(partner), allows(options, InterpreterLang.PT));
        styleChip(findViewById(R.id.interpPartnerEn), InterpreterLang.EN.equals(partner), allows(options, InterpreterLang.EN));

        refreshMeta();
        refreshWhere();
    }

    private static boolean allows(String[] options, String one) {
        for (String option : options) {
            if (option.equals(one)) return true;
        }
        return false;
    }

    /**
     * 一颗语言胶囊的状态：`on` = 选中（品牌底色）；`enabled` = 可选（不可选的画淡，
     * 并且点了不响应 —— 但**留着**，因为"为什么不能选"本身就是信息）。
     */
    private void styleChip(View view, boolean on, boolean enabled) {
        if (view == null) return;
        view.setBackgroundResource(on ? R.drawable.bg_pill_active : R.drawable.bg_chip);
        if (view instanceof TextView) {
            ((TextView) view).setTextColor(getColor(on ? R.color.on_brand : R.color.ink_soft));
        }
        view.setAlpha(enabled ? 1f : 0.35f);
        view.setEnabled(enabled);
    }

    private void refreshWhere() {
        if (whereView == null) return;
        // 5.39：这里说的必须是**表判出来的**结果，不是猜测：「对方说 X」会交给谁，
        // 以及不可用时到底为什么不满足（未实现的后端 / 没填服务器地址 / 表里没这一条）。
        String problem = routeProblemOf(partner);
        AsrRouter.Resolution picked = router == null ? null : router.resolve(partner);
        boolean relay = picked != null && picked.ok() && picked.backend instanceof RelayPipelineBackend;
        if (!problem.isEmpty()) {
            whereView.setText(getString(R.string.interp_where_unavailable, langText(partner), problem));
            return;
        }
        if (relay) {
            RelayPipelineBackend backendRelay = (RelayPipelineBackend) picked.backend;
            String engine = backendRelay.engine().isEmpty() ? "" : backendRelay.engine();
            whereView.setText(getString(engine.isEmpty() ? R.string.interp_where
                    : R.string.interp_where_engine, serverUrl(), backendText(picked.backend), engine));
        } else {
            whereView.setText(getString(R.string.interp_where_demo));
        }
    }

    // ── 历史 ──────────────────────────────────────────────────────────────

    /**
     * 读「历史」那一块（5.37）：只列 `kind='interpreter'` 的会话。
     *
     * <p>为什么只列翻译官：这里是翻译官页里的历史，混进会议记录会让用户以为
     * 点错了地方。全部记录仍在底部导航那个「历史」页（它列两种）。
     */
    private void loadHistory() {
        historyLoaded = true;
        historyHint.setVisibility(View.VISIBLE);
        historyEmpty.setVisibility(View.GONE);
        historyHint.setText(getString(R.string.interp_hist_loading));
        LanClient read = newClient(new LanClient.Listener() {
            @Override
            public void onStatus(String message) { }

            @Override
            public void onHello(String device, int cols, int lineBudget) { }

            @Override
            public void onFrame(String speaker, String langTag, String[] lines, String text,
                                String source, String sourceLang, boolean partial, String[] termsMissing,
                                String speakerName, String notice) { }

            @Override
            public void onError(String message) { }
        });
        if (read == null) {
            historyHint.setText(getString(R.string.interp_hist_failed, getString(R.string.interp_where_demo)));
            return;
        }
        new Thread(() -> {
            try {
                org.json.JSONObject body = read.orgHistory(HISTORY_LIMIT);
                ui.post(() -> renderHistory(body, null));
            } catch (Exception error) {
                ui.post(() -> renderHistory(null, error));
            }
        }, "interp-history").start();
    }

    private void renderHistory(org.json.JSONObject body, Exception error) {
        if (error != null) {
            historyHint.setVisibility(View.VISIBLE);
            historyHint.setText(getString(R.string.interp_hist_failed, describe(error)));
            return;
        }
        org.json.JSONArray items = body == null ? null : body.optJSONArray("items");
        historyList.removeAllViews();
        int shown = 0;
        if (items != null) {
            for (int i = 0; i < items.length(); i += 1) {
                org.json.JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                if (!"interpreter".equals(item.optString("kind", "meeting"))) continue;
                historyList.addView(historyCard(item));
                shown += 1;
            }
        }
        historyHint.setVisibility(View.GONE);
        historyEmpty.setVisibility(shown == 0 ? View.VISIBLE : View.GONE);
        historyScroll.setVisibility(shown == 0 ? View.GONE : View.VISIBLE);
        Log.i("LeionInterp", "🗂 翻译官历史 " + shown + " 条");
    }

    /** 一行历史：**同一份**排版实现（{@link HistoryRows}），与底部导航的「历史」页看起来一样。 */
    private View historyCard(org.json.JSONObject item) {
        return HistoryRows.create(this, historyList, item);
    }

    /** 「查看全部」：交给历史页，但只用 kind 过滤（同一份代码，不写第二套）。 */
    private void openAllHistory() {
        android.content.Intent intent = new android.content.Intent(this, HistoryActivity.class);
        intent.putExtra(HistoryActivity.EXTRA_KIND, "interpreter");
        startActivity(intent);
    }

    private static String describe(Exception error) {
        String text = error == null ? null : error.getMessage();
        return text == null || text.isEmpty() ? "" : text;
    }

    // ── 开始 / 停止 ────────────────────────────────────────────────────────

    private void startInterpreting() {
        // 5.32：先问路由"**对方那门语言**用谁"；问不到就**如实报错并停下**，
        // 绝不"随便找个引擎硬顶"（中文音频塞给葡语模型 = 整段乱码，比没识别更难查）。
        // ⚠️ 问的是 `partner`（识别语种），不是 `lang`（我读的语言）——
        // 路由是按"被识别的音频是什么语言"挑引擎的（5.37 修）。
        // 开跑前按**当前配置**重建一次（设置页可能刚改过服务器地址）。
        rebuildRouter();
        AsrRouter.Resolution picked = router.resolve(partner);
        if (!picked.ok()) {
            // 5.39：说不出来的原因来自**路由表判定**（未实现的后端 / 表里没这条 / 没填地址），
            // 不是"没有可用后端"这种含糊话
            String problem = routeProblemOf(partner);
            statusView.setText(problem.isEmpty() ? picked.problem : problem);
            Log.w("LeionInterp", "🧭 这一路不可用：" + (problem.isEmpty() ? picked.problem : problem));
            return;
        }
        backend = picked.backend;
        Log.i("LeionInterp", "🧭 这一场用 " + backend.debugLabel() + "（" + picked.reason + "）");
        running = true;
        // 5.37：开跑之后就离开「配置」那一块，否则用户在配置页看不到字幕，
        // 会以为"点了开始没反应"。要改语言再回来点一下就行。
        showTab(TAB_LIVE);
        toggleButton.setText(getString(R.string.interp_stop));
        statusView.setText(getString(R.string.interp_starting) + " · " + backendText(backend));
        clearCards();
        // 每一场的时间标记从 0 开始（与房间页一致：时间相对本场开始）
        startedAt = System.currentTimeMillis();
        backend.start(partner, new Callbacks());
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
        uploader.setLanguage(partner);
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
        // 5.37：这一场刚结束 → 历史里多了一条。让下次进「历史」时重新读，
        // 否则用户结束一场再翻历史会看不到它（那一块是懒加载、只读一次的）。
        historyLoaded = false;
    }

    /** 建客户端（用设置页里那套 host/secret/token）。拿不到配置就返回 null。 */
    private LanClient buildClient() {
        client = newClient(new FrameSink());
        return client;
    }

    /**
     * 建一个**独立**的客户端（读历史用）。
     *
     * <p>为什么不复用 {@link #buildClient()}：那个会把 {@link #client} 换成新的，
     * 而正在跑的那一场的结束调用（`orgInterpreterEnd`）走的就是它 ——
     * 翻一眼历史不该动到正在进行的会话。配置来源只有一处（{@link #serverUrl()} 与密钥）。
     */
    private LanClient newClient(LanClient.Listener listener) {
        android.content.SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String host = serverUrl();
        String secret = prefs.getString("secret", "");
        if (secret == null || secret.isEmpty()) secret = getString(R.string.default_shared_secret);
        if (host.isEmpty()) return null;
        LanClient built = new LanClient(host, secret, listener);
        String token = prefs.getString("accountToken", "");
        if (token != null && !token.isEmpty()) built.setToken(token);
        // ⚠️ 5.43 修的真实问题：这里**必须**把自己这一版的 versionCode 报上去。
        // 服务端的强制更新门禁认的是纯数字 versionCode；不带这个参数会被判成"版本过旧"
        // 直接 426 —— 于是"我明明装的是 4.148，却被要求更新到 4.148"。
        // （房间页一直有这一行，翻译官页是后来接的，漏了。）
        built.setAppVersionCode(String.valueOf(UpdateGuard.versionCode(this)));
        return built;
    }

    /** 当前生效的服务器地址（设置页优先，其次是出厂默认值）。 */
    private String serverUrl() {
        String host = getSharedPreferences(PREFS, MODE_PRIVATE).getString("host", "");
        if (host == null || host.isEmpty()) host = getString(R.string.default_server_url);
        return host;
    }

    private String myName() {
        String name = getSharedPreferences(PREFS, MODE_PRIVATE).getString("termsUser", "");
        return name == null ? "" : name;
    }

    /** 语言的三字母标签（界面上的「中文 / 葡萄牙语 / 英语」）。 */
    private String langText(String one) {
        if (InterpreterLang.PT.equals(one)) return getString(R.string.rooms_speak_pt);
        if (InterpreterLang.EN.equals(one)) return getString(R.string.rooms_speak_en);
        if (InterpreterLang.ZH.equals(one)) return getString(R.string.rooms_speak_zh);
        return one == null ? "" : one;
    }

    /**
     * 「收听」块上那行现状（5.37）：我读什么、对方说什么、朗读开没开。
     * 徽标按**识别语种**（对方说的语言）挑后端 —— 那才是"哪门语言交给谁识别"。
     */
    private void refreshMeta() {
        boolean ttsOn = TtsFeature.enabled()
                && getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("ttsRead", false);
        if (TtsFeature.enabled()) {
            metaView.setText(getString(R.string.interp_meta, langText(lang), langText(partner),
                    getString(ttsOn ? R.string.st_tts_on : R.string.st_tts_off)));
        } else {
            // 5.38：播报整层停用时不提"朗读"——提了就是在暗示一个并不存在的功能
            metaView.setText(getString(R.string.interp_meta_plain, langText(lang), langText(partner)));
        }
        if (ttsSwitch != null && TtsFeature.enabled()) ttsSwitch.setChecked(ttsOn);
    }

    /**
     * 后端在**界面上**的名字（5.36）。
     *
     * <p>为什么不用 {@link InterpreterAsrBackend#debugLabel()}：那个返回值是给日志用的
     * （中文就够、排查时读着顺），而界面上的字必须是**三语资源** ——
     * 混用会出现"英文界面里冒出中文徽标"。
     */
    private String backendText(InterpreterAsrBackend target) {
        if (target instanceof RelayPipelineBackend) return getString(R.string.interp_backend_relay);
        if (target instanceof ScriptedAsrBackend) return getString(R.string.interp_backend_scripted);
        return target.debugLabel();
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
                // 5.48：**交给房间页同一个 SubtitleList**（按原文归并）。
                // 之前这里用"每次 self-made 一个新 id"画卡片，于是同一句会收到好几帧
                // （原文帧 + 增量译文帧 + 定稿译文帧）→ 屏幕上冒出好几张卡、还互相闪烁。
                // SubtitleList 的规则是：**原文相同就是同一条**，增量→定稿→校对都在原位更新。
                submitCard(src, translated, partial, langTag);
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
            ui.post(() -> submitCard("", text, true));
        }

        @Override
        public void onFinal(String id, String text, String langTag) {
            ui.post(() -> {
                submitCard("", text, false);
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
     * 落一条字幕（5.48：改用房间页那套 {@link SubtitleList}，不再自己造卡片）。
     *
     * <p><b>为什么必须换</b>：一句话会来**好几帧** —— 原文帧（en-US，无译文）、
     * 译文的增量帧（可能好几次）、译文定稿帧。以前这里给每一帧都算一个新 id
     * （由行数组和译文文本拼出来），于是同一句在屏幕上变成两三张卡、
     * 互相闪烁。用户看到的就是"定稿帧和增量帧一起发过来"。
     *
     * <p>{@link SubtitleList} 的身份规则是**原文**：原文相同 → 同一条卡片原位更新；
     * 原文为空（增量译文帧常不带原文）→ 续写到上一条未定稿的卡片上。
     * 这与房间页完全是同一套显示逻辑，两页行为一致。
     */
    private void submitCard(String source, String text, boolean partial) {
        submitCard(source, text, partial, "");
    }

    /**
     * 落一条字幕（5.54：多了"这门译文是哪种语言"）。
     *
     * <p>同时看两种译文时，同一句原文会有两条卡片，靠语言标签区分；只有一种时不加标签，
     * 版面与之前完全一样。身份 = 原文 + 语言标签（见 {@link SubtitleList#submit}）。
     */
    private void submitCard(String source, String text, boolean partial, String langTag) {
        String src = source == null ? "" : source.trim();
        String target = text == null ? "" : text;
        if (src.isEmpty() && target.isEmpty()) return;
        subtitles.submit(elapsedLabel(), src, target, partial, "", langLabelOf(langTag));
        emptyView.setVisibility(View.GONE);
        scroll.setVisibility(View.VISIBLE);
    }

    /** 译文语言名（用当前界面语言的写法；认不出就不加标签）。 */
    private String langLabelOf(String langTag) {
        String tag = langTag == null ? "" : langTag.trim().toLowerCase(java.util.Locale.ROOT);
        if (tag.startsWith("zh")) return getString(R.string.lang_zh_short);
        if (tag.startsWith("pt")) return getString(R.string.lang_pt_short);
        if (tag.startsWith("en")) return getString(R.string.lang_en_short);
        return "";
    }

    /** 本场从开始到现在的时间标记（与房间页的写法一致：mm:ss）。 */
    private String elapsedLabel() {
        long seconds = Math.max(0, (System.currentTimeMillis() - startedAt) / 1000L);
        return String.format(java.util.Locale.US, "%d:%02d", seconds / 60, seconds % 60);
    }

    private void clearCards() {
        subtitles.clear();
        emptyView.setVisibility(View.VISIBLE);
        scroll.setVisibility(View.GONE);
        Log.i("LeionInterp", "🗒 清空字幕流");
    }
}
