package com.leion.lanrelay;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * RoomActivity — 房间内页（P3.2）：字幕流 + 开麦/锁定 + 右侧发言人状态。
 *
 * 设计取舍（稳定性优先）：
 *   ① **独立 Activity**，不改动 3900 行的 MainActivity；
 *   ② 只依赖 LanClient 已有的 start()/stop() 长轮询与新增的房间/发言权方法；
 *   ③ 轮询间隔固定（发言权 2 秒、持麦时 5 秒心跳），不引入额外线程管理。
 */
public class RoomActivity extends android.app.Activity implements LanClient.Listener {

    private static final int REQ_RECORD_AUDIO = 2001;
    /** 5.154：Android 13+ 的通知权限（前台服务的常驻通知）。被拒不影响开会与收音。 */
    private static final int REQ_NOTIFICATIONS = 2002;

    public static final String EXTRA_ROOM = "roomIdOrCode";
    public static final String EXTRA_NAME = "roomName";

    private static final long FLOOR_POLL_MS = 2000L;
    /** WS 推送通道活着时，轮询退化成"看门狗"：只防推送通道假死，不必跑那么勤。 */
    private static final long FLOOR_POLL_WATCHDOG_MS = 10000L;
    private static final long HEARTBEAT_MS = 5000L;
    /**
     * 顶部房间信息（人数 / 主题 / 角色）的刷新周期（5.143）。
     *
     * <p>为什么要单独一条：人数是**别人动作**的结果，没有推送可用；而 `loadRoomHeader`
     * 原来只在进房间时跑一次，于是"我先到、别人后进来"这种最常见的场景里，
     * 先进来的人永远看不到人数变化（抽屉里会刷新，顶部那一行不会）。
     * 5 秒一次的小 JSON 换来"人数是对的"，值得。
     */
    private static final long HEADER_TICK_MS = 5000L;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LanClient client;
    private String roomKey = "";
    private String myName = "";

    private TextView statusLine;
    private TextView speakerBar;
    private TextView hintLine;
    /** 5.148：开发者模式下显示"本场用哪套识别策略"（默认隐藏）。 */
    private TextView strategyView;
    private Button micButton;
    private android.widget.ImageButton lockButton;

    // ── 顶部会议信息（两行）──
    private TextView codeView;
    private TextView copyView;
    private TextView modeTag;
    private TextView roleTag;
    private TextView titleView;
    private TextView membersView;
    private TextView timerView;

    // ── 中央字幕流 ──
    private ScrollView subtitleScroll;
    private LinearLayout subtitleList;
    private TextView emptyView;

    // ── 右侧悬浮条与「人员与设备」抽屉 ──
    private TextView castState;
    /** 5.140：投屏状态监听（进页挂、退页摘）。 */
    private RokidGlasses.Listener rokidListener = null;
    private TextView audioState;
    private TextView micState;
    private LinearLayout infoBar;
    private LinearLayout drawer;
    private LinearLayout membersList;
    private TextView drawerDevices;

    // ── 底部：原文显示开关（M3，4.55 起是文字 + Switch）──
    private android.widget.Switch sourceSwitch;
    private boolean showSource = true;
    /** 防止 setChecked 触发监听又回头改一次（会来回抖）。 */
    private boolean syncingSwitch = false;

    /**
     * 最后一条字幕的身份：**原文**（source）。
     *
     * <p>⚠️ 5.121：这段判断已经整体换掉（见 {@link #renderSegment}）。原因是它只跟
     * "上一张卡"比，而多语会议里帧是**按语言交替**到的（增量 pt → 定稿 pt → 增量 en → 定稿 en），
     * 每一步都"和上一张不同"，于是每帧都新起一张卡 —— 用户实测一句话出现五条字幕。
     * 现在按"发言人 + 原文"认同一句（{@link #sentenceCards}），同一句的几种译文长在一张卡里。
     */
    /** 字幕卡最多留多少条：多了就丢最老的（防止一场会开两小时把内存吃掉）。 */
    private static final int MAX_SEGMENTS = 60;
    /** 同一句的译文在这段时间内到达都算同一句（超过就新起一张，避免把两句话并成一句）。 */
    private static final long SENTENCE_MERGE_MS = 15000L;
    /** 原文那一行 TextView 的标记（"原文显示"开关据此认出它，别用位置下标猜）。 */
    private static final String SOURCE_TAG = "leion-source";
    /**
     * 最近出现过的"一句话"（键 = 发言人 + 原文）。
     *
     * <p>它同时承担两件事：① 同一句的几种译文/增量帧**原位更新**成一张卡；
     * ② 卡片被挤出上限时连记录一起删，避免这张表越攒越大。
     */
    private final java.util.Map<String, SentenceCard> sentenceCards =
            new java.util.LinkedHashMap<>();
    /** 我从什么时候开始持麦（用来在按钮上显示"正在发言 00:12"）。 */
    private long holdingSinceMs = 0L;

    /** 我是不是发起者（决定抽屉里显不显示"移出成员/解除锁定"）。 */
    private boolean iAmHost = false;

    /** 抽屉打开期间的刷新间隔：成员变化没有推送，只能轮询，但只在抽屉开着时轮。 */
    private static final long DRAWER_REFRESH_MS = 2500L;
    private final Runnable drawerTick = new Runnable() {
        @Override
        public void run() {
            if (drawer.getVisibility() != View.VISIBLE || isFinishing()) return;
            loadRoomHeader();
            ui.postDelayed(this, DRAWER_REFRESH_MS);
        }
    };

    /** 会议计时（从进房那一刻算）。 */
    private long startedAtMs = 0L;
    private boolean timerRunning = false;

    private boolean holding = false;
    private boolean locked = false;
    private boolean pollScheduled = false;
    /**
     * 5.143：我（持麦者）被锁定这件事**是否已经提示过**。
     *
     * <p>为什么要一个开关：`takingChanged` 在每次推送/轮询都会跑一遍，不去重的话
     * 每 2 秒弹一次"发言已锁定"，比不提示还糟。
     */
    private boolean lockedSelfNotified = false;
    /**
     * 5.150：**"识别中…" 的超时兜底**。
     *
     * <p>为什么需要：那一行状态来自"这一帧是增量帧（partial）"。如果定稿帧永远没来
     * （大脑那边的流断在半路、进程被重启、或者这一句被过滤掉了），卡片就会**一直挂着
     * "识别中…"** —— 看起来像一直在干活，其实什么都不会再来了。
     *
     * <p>这里给每张卡定时：N 秒没等到定稿，就把状态改成"未定稿（超时）"并给一句人话。
     * **不删内容**：已经收到的译文照旧留着，只是不再假装还在进行中。
     */
    private static final long PARTIAL_TIMEOUT_MS = 20000L;
    private final java.util.Map<SentenceCard, Runnable> partialWatch = new java.util.HashMap<>();
    private MicUploader mic;
    /** 4.76：实时传声——播放别人的声音。 */
    private RoomAudioPlayer audioPlayer;

    /**
     * 5.30：译文朗读。`ttsQueue` 是队列+策略（积压丢弃/过期不播），
     * `TtsSpeaker` 负责合成与播放（耳机/眼镜优先、禁外放）。
     *
     * <p>5.152：**默认就是开着的**（老师要求）。要念的是译文还是原文，由底部那颗
     * {@code roomTtsSwitch} 决定（偏好 {@code ttsReadOriginal}）。
     */
    private TtsQueue ttsQueue;
    /** 5.152：念原文（true）还是念译文（false，默认）。 */
    private boolean ttsOriginal = false;
    /**
     * 5.152：`no-earphone` 这类"设备条件不满足"的提示**每场只说一次**。
     *
     * <p>为什么不能每句都说：朗读是每句一触发，「没戴耳机」就会跟着每句出现一次 ——
     * 提示行被反复改写、字幕被自己的提示打断，比不提示更烦。
     * 念成功过（或戴上耳机后念成功）就重新打开这道门。
     */
    private boolean ttsProblemShown = false;
    /**
     * 5.152：同一句话可能从**多条帧**到达（原文帧一次、每种语言的译文帧各一次），
     * 按「说话人 + 文本」在短时间窗口内去重 —— 否则同一句会念两三遍。
     */
    private String lastTtsKey = "";
    private long lastTtsAt = 0L;
    /** 去重窗口：一句话的几种帧几乎同时到，15 秒足够宽，又不会吞掉真的重复发言。 */
    private static final long TTS_DEDUPE_MS = 15_000L;
    /** 此刻是否正在朗读（实时传声据此让路，见 applyListenState）。 */
    private boolean speakingTranslation = false;
    /**
     * 5.154：正在退会（防止连按返回键 / 按钮与返回键同时按 → 发两次退会请求）。
     *
     * <p>退会请求发出后界面上要**立刻**无路可退：第二次调用直接返回，
     * 否则第二次请求可能在上一次已经把房间关掉之后到达，服务端回一句
     * "这场会已经结束"，用户看到红字提示——明明是他自己按了两次。
     */
    private boolean leaving = false;
    // 4.97：「正在听」胶囊按钮已删除（倾听全自动），所以不再需要这个引用
    /** 我是不是正在听（与服务端的 listen 开关保持一致）。 */
    private boolean listening = false;
    /**
     * 我**想不想**听（4.91）。
     *
     * <p>为什么要和 {@link #listening} 分开：自己说话时必须暂停播放（否则听到自己的回声），
     * 但"我想听"这个意图不该被抹掉 —— 说完要自动恢复。缺省**开**：
     * 会议里"听得到别人"是预期行为，不该让每个人每次都手动点一下。
     */
    private boolean listenWanted = true;
    /**
     * 当前持麦者（4.95）。
     *
     * <p>为什么要单独存一份：以前"谁在说话"是从**顶部那行文字**里反向解析出来的
     * （`speakerBar.getText()` 去掉前缀）—— 而没人在麦上时那行文字是「麦克风空闲」，
     * 解析出来就成了一个叫「麦克风空闲」的发言人。状态文字不能当数据用。
     */
    private String holderName = "";
    /**
     * 我**说**的语言（= 我的主语言，5.00）。
     *
     * <p>它曾经同时兼任"我读哪种语言" —— 于是"我说中文、但中文和葡语译文都想看"表达不出来。
     * 5.120 起"读"是一个**集合**（{@link #hearLangs}），这个字段只留作主语言：
     * TTS 的音色/语言、重连登记、以及"哪一份是主译文"仍以它为准。
     */
    private String hearLang = "";
    /**
     * 我**想看的全部译文语言**（5.120：多选）。
     *
     * <p>为什么必须是个集合：手机里勾了"中文 + 葡语 + 英语"，服务端就会为这一句产出多份译文帧，
     * 但它们**语言不同**。原来这里拿单个 `hearLang` 去比对，等于把多出来的那几份全丢掉 ——
     * 表现就是"勾了几种，屏幕上只有一种（而且正是我说的那种语言）"。
     *
     * <p>来源与 {@link #hearLangsOf} 一致：偏好里的多选 + 强制并入说话语言（见 {@code HearLangs}）。
     * 空集合 = 没登记（老配置）→ 不拦，宁可多显示也不吞字幕。
     */
    private final java.util.Set<String> hearLangs = new java.util.LinkedHashSet<>();
    /**
     * 上一次**已经登记到服务端**的参会语言（5.06）。
     *
     * <p>用户可以在设置页随时换语言，而服务端的 `room_members.lang` 是"入会那一刻"的值。
     * 一旦两者不一致：大脑的听众语言集合里没有新语言（**一句都不译**），
     * 按语言扇出时这台设备也收不到新语言的字幕。所以这里在计时循环里比对，
     * 变了就本地先切、再去服务端重新登记一次（见 {@link #syncSpokenLanguage()}）。
     */
    private String syncedSpeakLang = "";
    /** 邀请码（重新登记语言时要用它；来自房间详情） */
    private String roomCode = "";
    /** 提示行里当前是不是那句"服务器已满"（5.15：状态回到 running 时要把它清掉）。 */
    private boolean pipelineDenied = false;
    private Runnable pendingAfterPermission;
    private Button micUploadButton;
    private long lastHeartbeat = 0L;
    /** 轮询计数（4.46）：用来"每 5 轮"做一次房间状态兜底检查。 */
    private int pollTicks = 0;

    /** 发言权推送通道（4.35）。它只让"谁在说话"更快到达；断了就靠轮询。 */
    private FloorSocket floorSocket;
    private boolean wsOnline = false;

    @Override
    protected void attachBaseContext(android.content.Context base) {
        // 4.56：界面语言必须在这里换（三套资源在 values-en / values-pt-rBR）
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 4.56：换语言会 recreate 本页，而本顿重建会**打断正在进行的发言**。
        // 所以只有没开麦时才自检；开着麦就先用旧语言，等这一段说完再说。
        if (mic == null) UiLang.trackShown(this);
        // 5.140：回到本页时刷一次投屏状态，并挂上监听（投屏中途开始/停止也能实时反映）
        refreshCastState();
        // 5.143：回到本页立刻同步一次发言权与房间信息。WS 断线重连的空档里，
        // "谁拿着麦 / 锁没锁"可能已经变了，光靠 10 秒看门狗会让界面停在旧状态上。
        if (client != null) scheduleFloorPoll(0L);
        if (client != null) loadRoomHeader();
        if (rokidListener == null) {
            rokidListener = (status, casting) -> ui.post(this::refreshCastState);
            RokidGlasses.shared(this).addListener(rokidListener);
        }
    }

    /**
     * 侧边栏里那两处「投屏」到底写什么 —— **按真实状态**（5.140）。
     *
     * <p>只问一件事：Rokid 会话在不在投屏。在 = 写「Rokid 眼镜」，不在 = 写「手机屏」。
     * 亮亮那套是 USB 采样 View、属于 MainActivity 的实例，本页看不到它，所以这里只报 Rokid；
     * 真要两套都报，就该把亮亮也挪成应用级单例（那是另一件事，先别混进来）。
     */
    private void refreshCastState() {
        if (castState == null) return;
        RokidGlasses glasses = RokidGlasses.shared(this);
        boolean casting = glasses.isCasting();
        castState.setText(getString(casting ? R.string.room_cast_rokid : R.string.room_cast_phone));
        if (drawerDevices != null) {
            drawerDevices.setText(getString(casting ? R.string.room_devices_rokid : R.string.room_devices_detail));
        }
    }
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_room);

        roomKey = getIntent().getStringExtra(EXTRA_ROOM);
        String roomName = getIntent().getStringExtra(EXTRA_NAME);
        if (roomKey == null || roomKey.isEmpty()) {
            finish();
            return;
        }

        statusLine = findViewById(R.id.roomStatus);
        speakerBar = findViewById(R.id.roomSpeaker);
        hintLine = findViewById(R.id.roomHint);
        strategyView = findViewById(R.id.roomStrategy);
        micButton = findViewById(R.id.roomMic);
        lockButton = findViewById(R.id.roomLock);

        codeView = findViewById(R.id.roomCode);
        copyView = findViewById(R.id.roomCopy);
        modeTag = findViewById(R.id.roomModeTag);
        roleTag = findViewById(R.id.roomRoleTag);
        titleView = findViewById(R.id.roomTitle);
        membersView = findViewById(R.id.roomMembers);
        timerView = findViewById(R.id.roomTimer);

        subtitleScroll = findViewById(R.id.roomSubtitleScroll);
        subtitleList = findViewById(R.id.roomSubtitles);
        emptyView = findViewById(R.id.roomEmpty);

        castState = findViewById(R.id.roomCastState);
        audioState = findViewById(R.id.roomAudioState);
        micState = findViewById(R.id.roomMicState);
        infoBar = findViewById(R.id.roomInfoBar);
        drawer = findViewById(R.id.roomDrawer);
        membersList = findViewById(R.id.roomMembersList);
        drawerDevices = findViewById(R.id.roomDrawerDevices);
        sourceSwitch = findViewById(R.id.roomSourceSwitch);

        copyView.setOnClickListener(v -> copyInvite());
        infoBar.setOnClickListener(v -> toggleDrawer());
        findViewById(R.id.roomDrawerClose).setOnClickListener(v -> toggleDrawer());
        sourceSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (syncingSwitch) return;
            showSource = isChecked;
            syncSourceVisibility();
            addSystemEvent(isChecked ? getString(R.string.sys_source_on) : getString(R.string.sys_source_off));
        });

        addSystemEvent(getString(R.string.sys_meeting_started));

        // 外设（投屏/扩声）：**按真实状态写**，不写死。
        // 5.140：原来这里写死"手机屏 / 未接入"—— 用户开了 Rokid 投屏，侧边栏还显示手机，
        //        原因是它压根没去问投屏状态（也拿不到：Rokid 实例以前是每页各建一个）。
        audioState.setText(getString(R.string.room_audio_none));
        micState.setText(getString(R.string.room_mic_phone));
        refreshCastState();
        startedAtMs = System.currentTimeMillis();
        startTimer();
        updateMicButton();
        // 5.26：进房间再查一次版本 —— 用户可能是从通知/最近任务直接进来的，
        // 也可能在首页停留期间服务端升级了。版本不一致就拦在这里，别等说出第一句话才发现。
        checkAppVersion();
        syncSourceVisibility();  // 把「原文」开关刷成与 showSource 一致

        statusLine.setText("");

        SharedPreferences prefs = getSharedPreferences("leion", MODE_PRIVATE);
        // 5.155：同一套取值（用户存过的 → 打包进 APK 的出厂值）。原来这里只读偏好，
        // 于是"没在首页/我的页保存过"的设备进房间会拿着空地址 —— 界面上什么都不说
        // （连接直接失败）。首页启动时已经落过一次，这里再兜一次底，成本是两次 getString。
        ServerPreset.seedInto(this);
        String host = ServerPreset.host(this);
        String secret = ServerPreset.secret(this);
        myName = prefs.getString("termsUser", "");
        // 5.00：这台设备读哪种语言的字幕 = 入会时登记的说话语言。
        // 纯听众（从不开麦）也要有值，否则三语会议里会收到两种语言的帧、都显示出来。
        hearLang = prefs.getString("speakLang", "");
        if (hearLang == null) hearLang = "";
        // 5.120：真正决定"显示哪几份译文"的是**集合**（偏好里的多选 + 强制并入说话语言）。
        // 只有主语言 `hearLang` 的话，勾了几种也只显示一种 —— 这就是用户报的那个 bug。
        hearLangs.clear();
        hearLangs.addAll(hearLangsOf(prefs));
        // 5.06：会中换语言时用它比对（见 syncSpokenLanguage）
        syncedSpeakLang = hearLang;
        String token = prefs.getString("accountToken", "");

        client = new LanClient(host, secret, this);
        // 5.27：把本机 versionCode 报给服务端（版本门禁用它；不带会被当成旧版本拒掉）
        client.setAppVersionCode(String.valueOf(UpdateGuard.versionCode(this)));
        // 4.74：告诉轮询「我在哪个房间」。多场会并发时，
        // 字幕才不会把别的房间的句子画到这里来。
        client.setRoom(roomKey);
        // 5.55：告诉轮询"我要看哪几种语言的译文"。一个人可能同时看两种（我说葡语、
        // 英文和中文都想看），服务端会按语言各存一份帧；不带就只有自己那门。
        // ⚠️ 这里必须**过滤成支持的标签**：prefs 里的值可能是老版本写的脏数据。
        client.setHearLangs(HearLangs.join(hearLangsOf(prefs), prefs.getString("speakLang", "")));
        // 4.96：上传音频时自报发言人（服务端用它给字幕落名字，不再猜"现在谁持麦"）
        client.setSpeaker(myName);
        getSharedPreferences("leion", MODE_PRIVATE).edit().putString("roomId", roomKey).apply();
        if (token != null && !token.isEmpty()) client.setToken(token);
        if (myName != null && !myName.isEmpty()) client.setUser(myName);
        client.start();
        startFloorSocket(host, secret, token);

        // ⚠️ 4.53 修：**必须**在 client 建好之后才拉房间详情。
        // 原来这行写在 client = new LanClient(...) 之前，于是线程里 NPE、被 catch 静默吞掉，
        // 表现就是顶部一直是「#------」占位、角色永远显示「参与者」。
        loadRoomHeader();
        // 5.143：进房间后**定时**再拉一次（人数会变，而它没有推送可用）。
        scheduleHeaderTick();

        // 5.07：顶部那一行「#邀请码 复制邀请 我说中文 发起者」里的**语言标签原来永远是中文** ——
        // 布局里写死的缺省值（`@string/rooms_speak_zh`），而 `modeTag` 拿到之后从没被赋过值。
        // 于是选葡语、选英语，那一格都一直显示「我说中文」（用户实测报的，是个老 bug）。
        updateModeTag();

        micUploadButton = findViewById(R.id.roomUpload);
        // 4.76 的实时传声播放器；4.97 起**没有**手动开关（那颗胶囊已从底部删掉）——
        // 倾听全自动：进房间就听、自己说话时暂停防回声、说完恢复、重连重新订阅（见 applyListenState）。
        audioPlayer = new RoomAudioPlayer();
        // 5.152：朗读（TTS）—— 老师要求加上，所以 5.38 的总开关已经打开
        // （{@link TtsFeature#enabled()}）。队列策略（积压丢弃/过期不播/关掉立刻闭嘴）
        // 与"只在耳机上播"这些规矩一条没动 —— 它们本来就是这层做对的。
        // 念**译文**还是**原文**由底部那颗开关决定（ttsReadOriginal）。
        if (TtsFeature.enabled()) {
            ttsQueue = new TtsQueue(new TtsSpeaker(this));
            ttsQueue.setListener(new TtsQueue.Listener() {
                @Override
                public void onSpeaking(String text, boolean speaking) {
                    ui.post(() -> {
                        speakingTranslation = speaking;
                        // 念出来了就说明这次没问题：把"只提示一次"的门重新打开
                        if (speaking) ttsProblemShown = false;
                        if (hintLine != null && speaking) hintLine.setText(getString(R.string.st_tts_speaking));
                        applyListenState();
                    });
                }

                @Override
                public void onProblem(String code, String hint) {
                    ui.post(() -> {
                        // 5.152：没有耳机这类问题**每场只说一次**。否则每来一句都要把提示行
                        // 改写成同一句话 —— 用户看到的是"提示一闪一闪"，字幕也被打断。
                        if (InterpreterErrorCodes.NO_EARPHONE.equals(code)) {
                            if (ttsProblemShown) return;
                            ttsProblemShown = true;
                            addSystemEvent(InterpreterErrorCodes.message(RoomActivity.this, code, hint));
                        }
                        // 5.34：按机器码取当前界面语言的那句（"没有耳机"这种提示不能只给中文）
                        if (hintLine != null) {
                            hintLine.setText(InterpreterErrorCodes.message(RoomActivity.this, code, hint));
                        }
                    });
                }
            });
            // 5.152：朗读**默认开**（老师要求），不再由设置页那颗 ttsRead 管着 ——
            // 那颗开关所在的设置页 5.145 已经并进"我的"，而"要不要念"现在由下面那颗切。
            ttsQueue.setEnabled(true);
            ttsOriginal = prefs.getBoolean("ttsReadOriginal", false);
            bindTtsSwitch();
        }
        // 隐藏的「开始同传」：原型里没有它，开麦即开始上传；这里只留一个落点备用
        micUploadButton.setOnClickListener(v -> toggleMic());
        updateUploadButton();
        micButton.setOnClickListener(v -> toggleMic());
        lockButton.setOnClickListener(v -> toggleLock());
        findViewById(R.id.roomLeave).setOnClickListener(v -> leaveRoom());
        lockButton.setEnabled(false);
        lockButton.setAlpha(0.5f);
        scheduleFloorPoll(0L);
        scheduleHeartbeatTick();
    }

    /**
     * 心跳与"状态推送"**解耦**（4.35）：WS 活着时轮询退成 10 秒看门狗，
     * 而服务端租约是 15 秒 —— 只靠轮询顺带续租，余量太薄（网络抖一下就掉麦）。
     * 所以心跳自己按 5 秒走，不看有没有消息进来。
     */
    private void scheduleHeartbeatTick() {
        ui.postDelayed(() -> {
            if (isFinishing()) return;
            if (holding) heartbeatIfDue();
            scheduleHeartbeatTick();
        }, HEARTBEAT_MS);
    }

    @Override
    protected void onDestroy() {
        // 5.140：本页只是"看投屏状态"，走的时候把监听摘掉（会话本身要留着跨页面）
        if (rokidListener != null) {
            RokidGlasses.shared(this).removeListener(rokidListener);
            rokidListener = null;
        }
        // 5.28：退出房间的**唯一**音频收口（见 releaseAudio 的说明）
        releaseAudio();
        // 5.30：朗读引擎也要放掉（否则 TTS 服务会跟着进程活很久）
        if (ttsQueue != null) {
            ttsQueue.shutdown();
            ttsQueue = null;
        }
        timerRunning = false;
        stopDrawerRefresh();
        if (floorSocket != null) {
            floorSocket.stop();
            floorSocket = null;
        }
        if (client != null) client.stop();
        // 5.150：把"识别中"的超时表也清掉（否则 Activity 销毁后回调里还在碰 View）
        for (Runnable pending : partialWatch.values()) ui.removeCallbacks(pending);
        partialWatch.clear();
        ui.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    /**
     * 5.28：**退到后台就交还麦克风**（用户要求"退出房间时自动释放音频资源"的完整版）。
     *
     * <p>为什么放在 `onStop` 而不是只有 `onDestroy`：按 Home 键、跳到别的页面时
     * Activity **不会销毁**，原来那种写法会让 `AudioRecord` 一直挂着。Android 12+
     * 会把后台录音静音，于是"界面看着正常、其实一句都没录进去"，而且麦克风会话被占着——
     * 翻译官之类的第二个功能再也开不了麦。
     *
     * <p>5.154：**息屏不算"离开"**。用户报的是"会议开着、人一直在说，按一下电源键
     * 屏幕黑了，麦克风就断了"。所以这里分两种情况：
     * <ul>
     *   <li>屏幕**还亮着**（按 Home / 切到别的 App）→ 照旧释放：这是"我离开这个页面了"，
     *       停就是停，不偷偷在后台录；</li>
     *   <li>屏幕**已经灭了**（按电源键 / 超时黑屏）且**我正在上传**→ 保持收音。
     *       {@link MeetingMicService} 已经把这一场标成麦克风类型的前台服务，
     *       后台采集在系统看来是合法的；它同时持一把 PARTIAL_WAKE_LOCK，
     *       否则屏幕灭了 CPU 睡下去，录音线程一样会被打断。</li>
     * </ul>
     */
    @Override
    protected void onStop() {
        boolean uploading = mic != null || AudioCaptureArbiter.isRecording();
        if (uploading && !isScreenOn()) {
            // 息屏继续收：不释放音频，也不停前台服务（它本来就在跑）
            android.util.Log.i("LeionRoom", "🌙 屏幕熄灭但仍在收音（前台服务保活），不释放麦克风");
            super.onStop();
            return;
        }
        boolean wasRecording = uploading;
        releaseAudio();
        if (wasRecording && hintLine != null) {
            hintLine.setText(getString(R.string.st_audio_released));
        }
        super.onStop();
    }

    /**
     * 屏幕现在是不是亮着（5.154）。
     *
     * <p>用 `PowerManager.isInteractive()` 而不是自己收 SCREEN_ON/OFF 广播：
     * 广播要在 onResume 注册、onPause 注销，还要处理"注册之前就息屏"的竞态；
     * 而 onStop 那一刻问一句"屏幕亮着吗"正好够用，也没有状态要维护。
     */
    private boolean isScreenOn() {
        try {
            android.os.PowerManager power = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            return power == null || power.isInteractive();
        } catch (Exception error) {
            // 查不到就按"亮着"处理 —— 保守：宁可回到老行为（释放），也不偷偷录音
            return true;
        }
    }

    /**
     * 5.154：**系统返回键 = 退出会议**。
     *
     * <p>用户报的问题：建完会直接按手机的返回键，人看着是"离开了这个页面"，
     * 但服务端那边**我还是会里的成员**（发起者尤其致命：整场会议继续存在，
     * 别人还能进来，字幕也还在写）。原因是原来没有任何地方拦返回键，
     * 系统默认行为只是 `finish()` 这个 Activity —— 我们只断了本地连接，没退会。
     *
     * <p>所以这里直接走与「退出」按钮**同一个**出口（{@link #leaveRoom()}）：
     * 一条退出路径，不会出现"点按钮会退会、按返回键不会"这种分叉。
     */
    @Override
    public void onBackPressed() {
        if (isFinishing() || leaving) return;
        leaveRoom();
    }

    /**
     * 5.28：**音频资源的唯一出口**。
     *
     * <p>这里以前是六处各自写的 `if (mic != null) { mic.stop(); mic = null; }`
     * （退出房间、散会、被顶下线、上传出错、关麦、onDestroy）。那种"每一处都记得停"
     * 的约定，漏一处就是"退出了还在录音"，而且下一个功能（翻译官）还要再记一遍。
     * 现在全部走这一个方法，静态测试也钉着"别处不许直接停麦"。
     *
     * <p>它做三件事：交还仲裁器的租约（真的把采集停掉）→ 停实时传声 → 刷新按钮。
     * 幂等：重复调用、没开麦时调用都安全。
     */
    private void releaseAudio() {
        // ① 仲裁器：只在自己持有租约时才真的停（不会误停别人的采集）
        boolean released = AudioCaptureArbiter.release(AudioCaptureArbiter.OWNER_ROOM);
        // ② 兜底：万一某条老路径没经过仲裁器就开了麦（例如权限回调中途失败）
        if (!released && mic != null) {
            mic.stop();
        }
        mic = null;
        // ⑤ 5.154：收音停了，前台服务也要停 —— 那条常驻通知就是"现在还在录"的凭据，
        //    早停一秒会让用户以为还在录，晚停一秒会让系统继续为一次已经结束的采集供能。
        MeetingMicService.stop(this);
        // ③ 说话时加的"保持屏幕常亮"要撤掉（听而不说时不额外耗电）
        if (getWindow() != null) {
            getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        // ④ 输出侧：实时传声与播报都属于"音频资源"，一起放掉
        if (ttsQueue != null) ttsQueue.stop();
        if (audioPlayer != null) {
            audioPlayer.stop();
        }
        listening = false;
        if (micButton != null) updateMicButton();
        Log.i("LeionRoom", "🔇 音频已释放（" + AudioCaptureArbiter.describe() + "）");
    }

    /**
     * 发言权推送通道（4.35）：让"谁在说话"一推即到，不再是 2 秒轮询。
     *
     * <p>没登录（没有 token）就不连 —— 服务端要用 token 才知道"我是房间里的谁"。
     * 连不上 / 掉线都只是一行状态：2 秒轮询一直在跑，WS 只负责更快。
     */
    private void startFloorSocket(String host, String secret, String token) {
        if (host == null || host.isEmpty() || token == null || token.isEmpty()) {
            return;
        }
        floorSocket = new FloorSocket(host, secret, token, roomKey, new FloorSocket.Listener() {
            @Override
            public void onFloor(JSONObject state) {
                final JSONObject body = state;
                ui.post(() -> {
                    String released = body.optString("released", "");
                    if (!released.isEmpty() && !"null".equals(released)) {
                        String message = getString(R.string.sys_dropped, released)
                                + (body.optBoolean("releasedLocked", false) ? getString(R.string.sys_locked_suffix) : "");
                        hintLine.setText(message);
                        Toast.makeText(RoomActivity.this, message, Toast.LENGTH_SHORT).show();
                    }
                    applyFloorState(holderOf(body), body.optBoolean("locked", false));
                });
            }

            @Override
            public void onFrame(final JSONObject message) {
                final JSONObject frame = message == null ? null : message.optJSONObject("frame");
                if (frame == null) return;
                ui.post(() -> {
                    org.json.JSONArray linesArray = frame.optJSONArray("lines");
                    String[] lines = null;
                    if (linesArray != null) {
                        lines = new String[linesArray.length()];
                        for (int i = 0; i < lines.length; i++) lines[i] = linesArray.optString(i, "");
                    }
                    org.json.JSONArray missArray = frame.optJSONArray("termsMiss");
                    String[] missing = null;
                    if (missArray != null) {
                        missing = new String[missArray.length()];
                        for (int i = 0; i < missing.length; i++) missing[i] = missArray.optString(i, "");
                    }
                    applyFrame(frame.optString("text", ""), lines, frame.optString("source", ""),
                            // 5.123：源语言要传下去 —— 用来判"这一帧是不是我自己那句话的译文"
                            frame.optString("sourceLang", ""),
                            frame.optBoolean("partial", false), missing,
                            // 4.96：用 LanClient.speakerNameOf —— 它把 JSON null 当成"没有"，
                            // 不然 optString 会返回字符串 "null"，界面上就出现一个叫 null 的发言人
                            LanClient.speakerNameOf(frame),
                            // 5.00：这一帧是译成哪种语言的那一份
                            frame.isNull("lang") ? "" : frame.optString("lang", ""),
                            // 5.12：附带提示（"本场语言相同 · 无需翻译"）
                            LanClient.noticeOf(frame));
                });
            }

            @Override
            public void onRoomClosed(String reason) {
                ui.post(() -> leaveBecauseClosed(reason));
            }

            @Override
            public void onRemoved(String reason) {
                ui.post(() -> leaveBecauseRemoved());
            }

            @Override
            public void onState(String message) {
                // 4.53：这些是**调试**信息（"发言权推送已连上/断开"），不该占用户的状态行。
                // 真正需要用户知道的事（连接失败、被顶替、会议结束）走 onError / showKicked /
                // leaveBecauseClosed 三条通道。这里只留一行 logcat，方便排查。
                android.util.Log.i("LeionRoom", "floor-socket: " + message);
            }

            @Override
            public void onOnlineChanged(boolean online) {
                ui.post(() -> {
                    wsOnline = online;
                    // 4.91：**重连之后必须重新订阅**。服务端的 listen 开关是挂在**连接**上的
                    // （`conn.listen`），reconnect 就是一条新连接 —— 不重发的话，
                    // 界面还显示"在听"，服务端却已经不发一块音频了（症状：声音突然没了）。
                    if (online && listenWanted) {
                        if (floorSocket != null) floorSocket.sendListen(true);
                        if (audioPlayer != null && listening) audioPlayer.start();
                    }
                });
            }

            @Override
            public void onAudioRate(int rate) {
                // 服务端告诉我们这一路音频的采样率（4.91）：手机录音可能降到 44.1k，
                // 播放器按 16k 硬放会变成快放/慢放，所以这里跟着改。
                ui.post(() -> {
                    if (audioPlayer != null) audioPlayer.setSampleRate(rate);
                });
            }

            @Override
            public void onAudio(byte[] chunk) {
                // 网络线程上：只往队列里放，不碰界面
                if (audioPlayer != null && listening) audioPlayer.offer(chunk);
            }
        });
        floorSocket.start();
    }

    // ── 开麦 / 关麦 ──────────────────────────────────────────────────────
    /**
     * 底部主按钮：**开麦**（原型只有一个"开麦/关麦"）。
     *
     * <p>它同时管两件事：抢发言权 + 开始/停止上传音频。
     * 以前这是两个按钮（开麦 + 开始同传），对用户是同一个动作却要点两下，
     * 而且"开了麦却没上传"会表现成"我说话了但没有字幕"。
     */
    private void toggleMic() {
        if (mic != null || holding) {
            // 关麦：停上传 + 放发言权（顺序反过来会让服务端把人顶掉再收到释放）
            // 5.28：停麦走 releaseAudio（唯一出口），见它的说明
            releaseAudio();
            hintLine.setText(getString(R.string.st_speaking_done));
            new Thread(() -> {
                try {
                    client.floorAction(roomKey, "release");
                } catch (Exception ignored) {
                    // 服务端 15 秒租约兜底
                }
            }, "room-release").start();
            return;
        }
        ensureRecordPermission(this::takeFloorThenUpload);
    }

    /** 开麦按钮的外观：空闲=蓝绿胶囊，发言中=红色胶囊+呼吸；文案带秒数。 */
    private void updateMicButton() {
        boolean live = mic != null || holding;
        micButton.setBackgroundResource(live ? R.drawable.btn_mic_live : R.drawable.btn_mic_idle);
        micButton.setTextColor(getColor(R.color.on_brand));
        if (live) {
            long seconds = holdingSinceMs > 0 ? (System.currentTimeMillis() - holdingSinceMs) / 1000 : 0;
            micButton.setText(getString(R.string.room_speaking_timer,
                    String.format(java.util.Locale.US, "%02d:%02d", seconds / 60, seconds % 60)));
            if (micButton.getAnimation() == null) {
                micButton.startAnimation(android.view.animation.AnimationUtils.loadAnimation(this, R.anim.mic_pulse));
            }
        } else {
            micButton.setText(getString(R.string.room_mic_idle));
            micButton.clearAnimation();
        }
        micButton.setEnabled(true);
    }

    private void toggleLock() {
        act(locked ? "unlock" : "lock");
    }

    private void act(String action) {
        micButton.setEnabled(false);
        new Thread(() -> {
            JSONObject result = null;
            String error = "";
            try {
                result = client.floorAction(roomKey, action);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject body = result;
            final String failure = error;
            ui.post(() -> {
                micButton.setEnabled(true);
                if (body == null) {
                    Toast.makeText(this, getString(R.string.toast_request_failed, failure), Toast.LENGTH_LONG).show();
                    return;
                }
                int status = body.optInt("_status", 0);
                if (status == 401) {
                    showKicked(ServerText.from(this, body, ""));
                    return;
                }
                if (status >= 400 || body.optBoolean("ok", false) == false) {
                    // 409 = 被规则拒绝（别人锁定中），这是业务状态，不是网络错误
                    String reason = ServerText.from(this, body, "");
                    Toast.makeText(this, reason.isEmpty() ? getString(R.string.st_rejected_http, status) : reason,
                            Toast.LENGTH_LONG).show();
                    if (action.equals("take")) hintLine.setText(reason);
                    return;
                }
                String holder = holderOf(body);
                takingChanged(holder, body.optBoolean("locked", false));
                if ("lock".equals(action)) addSystemEvent(holder.isEmpty() ? getString(R.string.sys_lock_self) : getString(R.string.sys_lock_other, holder));
                if ("unlock".equals(action)) addSystemEvent(getString(R.string.sys_unlocked));
                if ("force-release".equals(action)) addSystemEvent(getString(R.string.sys_force_released));
                if (body.optString("tookOver", "").length() > 0) {
                    hintLine.setText(getString(R.string.st_took_over, body.optString("tookOver")));
                }
                // 点「开麦」再点回来 = 结束发言：正在上传的话必须跟着停，
                // 否则会出现"麦已经放了、音频还在往识别流里灌"（4.34 修）
                if (!holding && mic != null) {
                    stopUpload(getString(R.string.st_stop_takeover));
                }
            });
        }, "room-floor-" + action).start();
    }

    /** JSON 里 holder 可能是 null，optString 会返回字面量 "null" —— 统一归一成空串。 */
    private static String holderOf(JSONObject body) {
        if (body == null || body.isNull("holder")) {
            return "";
        }
        String value = body.optString("holder", "");
        return "null".equals(value) ? "" : value;
    }
    private void takingChanged(String holder, boolean isLocked) {
        holderName = holder == null ? "" : holder.trim();
        holding = !holderName.isEmpty() && holderName.equals(myName);
        locked = isLocked;
        boolean anyHolder = holder != null && !holder.isEmpty();
        boolean iAmHost = myName.equals(hostName());
        if (holding && holdingSinceMs == 0L) holdingSinceMs = System.currentTimeMillis();
        // 4.77 / 4.91：自己开麦时不能放音（手机就在嘴边，放出来就是回声）。
        //
        // ⚠️ 4.91 修掉的那个 bug 就在这里：原来写的是 `if (holding && listening) stopListening()`，
        // 于是**说完话之后倾听再也没打开** —— 而两个人开会本来就是"你说完我说"，
        // 结果每个人一开口就把自己的耳朵关掉了，看起来就像"音频传不到对方"。
        // 现在把"我想听"（listenWanted）与"此刻在放"（listening）分开：
        // 说话时暂停播放但**记得意图**，说完自动恢复。
        applyListenState();
        if (!holding) holdingSinceMs = 0L;
        // 外观统一交给 updateMicButton（4.52：胶囊 + 发言中红色 + 呼吸）
        updateMicButton();

        // 锁定按钮的文案必须与"我能不能按"一致（4.44 修）。
        //
        // 原来的写法是所有人统一 `isLocked ? "解锁" : "锁定发言"`，于是：A（发起者）锁了麦，
        // B 那边明明按不动，按钮却写着「解锁」—— 用户会以为自己也握着这把锁，
        // 点了没反应就更困惑。规则应该是：
        //   · 持麦者：自己锁自己 / 自己解自己      → 解锁 / 锁定发言
        //   · 发起者：可以解**他人**的锁           → 解锁（他人）/ 锁定发言（他人）
        //   · 其他人：不能动锁，只显示状态          → 发言已锁定 / 锁定发言（灰）
        // 4.55：改成图标按钮（上锁 / 解锁），不再写文字。
        // 能不能按还是由权限决定：持麦者能锁自己，发起者能解他人，其他人只能看。
        boolean canLock = holding || (anyHolder && iAmHost);
        boolean showUnlockIcon = isLocked && canLock;
        lockButton.setImageResource(showUnlockIcon ? R.drawable.ic_unlock : R.drawable.ic_lock);
        lockButton.setContentDescription(showUnlockIcon ? getString(R.string.cd_unlock_speak)
                : (isLocked ? getString(R.string.cd_locked) : getString(R.string.cd_lock_speak)));
        lockButton.setEnabled(canLock);
        lockButton.setAlpha(canLock ? 1f : 0.5f);
        speakerBar.setText(anyHolder ? (getString(R.string.room_speaker_prefix) + holder
                + (isLocked ? getString(R.string.room_locked_suffix) : "")) : getString(R.string.room_no_speaker));

        // 5.143：锁定状态必须**一眼看得见**（用户报的：A 锁了正在说话的 B，B 的界面还像没锁）。
        //
        // 之前唯一的信号是图标（上锁 ↔ 解锁）与发言条末尾的「（已锁定）」——
        // 图标一换，持麦者只会以为"这个按钮现在叫解锁"，完全读不出"我被锁了"。
        // 现在加三样，且都只在**真的变化**时才动（不然每 2 秒弹一次）：
        //   ① 图标染色（锁着 = 品牌色）；
        //   ② 提示行写清楚"谁锁了、你能不能自己解"；
        //   ③ 第一次变成"我被锁"时弹一次 Toast。
        if (lockButton != null) {
            lockButton.setImageTintList(isLocked
                    ? android.content.res.ColorStateList.valueOf(getColor(R.color.brand))
                    : null);
        }
        boolean lockedMine = isLocked && holding;
        if (lockedMine && !lockedSelfNotified) {
            lockedSelfNotified = true;
            String note = getString(R.string.st_locked_self);
            if (hintLine != null) hintLine.setText(note);
            Toast.makeText(this, note, Toast.LENGTH_SHORT).show();
        } else if (!isLocked) {
            lockedSelfNotified = false;
        }
    }

    /**
     * 兜底：问一次"这场还在吗"（4.46）。
     *
     * <p>为什么要有：WS 的 `closed` 推送需要**新服务端**；老服务端不会推，而
     * `/floor` 对已结束的会议照样返回状态 —— 于是屋里的人一脸茫然地留着。
     * 房间详情从 4.46 起带 `closed`，这是老服务端也能用的唯一信号。
     */
    private void checkRoomStillOpen() {
        new Thread(() -> {
            JSONObject info = null;
            try {
                info = client.orgRoomInfo(roomKey);
            } catch (Exception ignored) {
                return;                       // 网络抖动不算"散会"
            }
            if (info == null) return;
            JSONObject room = info.optJSONObject("room");
            boolean closed = (room != null && room.optBoolean("closed", false))
                    || info.optBoolean("closed", false);
            if (closed) {
                ui.post(() -> leaveBecauseClosed(getString(R.string.st_host_closed)));
                return;
            }
            // 4.55：被移出的人**不在成员列表里**了。WS 的 removed 推送通常会先到，
            // 这条是兜底（WS 断线时）。注意只在"确实拉到了成员数组"时才判，
            // 空数组不能当成"我不在了"（否则一次网络抖动就会把人踢出房间）。
            org.json.JSONArray members = info.optJSONArray("members");
            if (members != null && members.length() > 0 && myName != null && !myName.isEmpty()) {
                boolean stillHere = false;
                for (int i = 0; i < members.length(); i++) {
                    JSONObject one = members.optJSONObject(i);
                    String name = one == null ? members.optString(i, "") : one.optString("username", "");
                    if (myName.equals(name)) { stillHere = true; break; }
                }
                if (!stillHere) {
                    ui.post(this::leaveBecauseRemoved);
                }
            }
        }, "room-still-open").start();
    }

    /**
     * 被发起者移出这场会议（4.55）。
     *
     * <p>两条发现路径：WS 的 `removed` 推送（秒级）、轮询时"我不在成员列表里"（兜底）。
     * 无论哪条先到，处理都一样：停上传、说清原因、退出房间。
     */
    private void leaveBecauseRemoved() {
        if (isFinishing()) return;
        Toast.makeText(this, getString(R.string.st_removed), Toast.LENGTH_LONG).show();
        hintLine.setText(getString(R.string.st_removed));
        releaseAudio();
        ui.postDelayed(this::finish, 1200);
    }

    /**
     * 抽屉打开期间的**实时刷新**（4.55）。
     *
     * <p>用户报的问题：抽屉里的人数/成员要重新打开才变。原因是成员变化没有任何推送，
     * 而我只在"打开抽屉"那一刻拉了一次。现在抽屉开着就每 2.5 秒拉一次，
     * 关掉就停（不打开的人不为它付流量）。
     */
    private void startDrawerRefresh() {
        ui.removeCallbacks(drawerTick);
        ui.postDelayed(drawerTick, DRAWER_REFRESH_MS);
    }

    private void stopDrawerRefresh() {
        ui.removeCallbacks(drawerTick);
    }

    /**
     * 会议结束了（发起者退出）：提示原因并退出房间（4.44）。
     *
     * <p>以前发起者一退，服务端把房间标成 closed，但屋里的人什么都不知道 ——
     * 界面照旧、按钮照旧，直到某次操作失败。现在服务端会主动推送并断开连接，
     * 轮询那条路也判 `closed`/410 作为兜底。
     */
    private void leaveBecauseClosed(String reason) {
        if (isFinishing()) return;
        // 4.58：reason 可能是机器码（WS 推送的 host-left）或服务端中文句子，先翻成当前语言。
        // 以前这里直接把 reason 拼进括号，用户看到的是"会议已结束（host-left），已退出房间"。
        String why = ServerText.of(this, reason);
        String message = (why.isEmpty() ? getString(R.string.st_meeting_closed) : why)
                + getString(R.string.st_left_room_tail);
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        hintLine.setText(message);
        releaseAudio();
        ui.postDelayed(this::finish, 1200);
    }

    /**
     * 会话被顶掉（单会话的另一面）：提示、清本地 token、退出房间。
     *
     * <p>为什么退出房间而不是留在原地：这张牌桌上的身份已经失效，任何操作都会失败；
     * 留在这里只会让用户以为是"网络卡了"。退出后首页的会话监听会把界面带回登录页。
     */
    private void showKicked(String hint) {
        if (isFinishing()) return;
        String extra = hint == null || hint.isEmpty() ? "" : ("：" + hint);
        String message = getString(R.string.st_login_expired_extra, extra);
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        hintLine.setText(message);
        statusLine.setText(message);
        // 5.28：身份失效了就别再占着麦克风（以前要等 1.5 秒后的 finish 才停）
        releaseAudio();
        getSharedPreferences("leion", MODE_PRIVATE).edit()
                .remove("accountToken").remove("termsUser").remove("roomHost").apply();
        ui.postDelayed(this::finish, 1500);
    }

    /**
     * 按"要不要听 + 我此刻没在说话"决定really要不要收音频（4.91，4.97 起没有手动开关）。
     *
     * <p>幂等：状态没变就什么都不做（避免每次发言权刷新都重启播放器和重发一条 WS 消息）。
     *
     * <p>4.97：底部那颗「正在听」胶囊删掉了（按钮太多，小屏挤），所以这里不再刷任何按钮，
     * 只剩"放还是不放"这一个决定。要临时静音直接把系统音量按下去即可。
     */
    private void applyListenState() {
        // 5.30：正在朗读译文时**不放对方原声**（方案 1 二选一）。
        // 两条一起放，听到的是"葡语原声 + 中文朗读"叠在一起，谁说的话都听不清。
        boolean shouldPlay = listenWanted && !holding && !speakingTranslation;
        if (shouldPlay == listening) return;
        listening = shouldPlay;
        if (floorSocket != null) floorSocket.sendListen(shouldPlay);
        if (audioPlayer != null) {
            if (shouldPlay) {
                audioPlayer.start();
            } else {
                audioPlayer.stop();
            }
        }
    }

    /** 停止收音频 + 停止播放（也告诉服务器不要再发）。只在内部状态需要时用。 */
    private void stopListening() {
        listenWanted = false;
        if (!listening) return;
        listening = false;
        if (floorSocket != null) floorSocket.sendListen(false);
        if (audioPlayer != null) audioPlayer.stop();
    }

    private String hostName() {
        return getSharedPreferences("leion", MODE_PRIVATE).getString("roomHost", "");
    }

    /** 退出房间：发起者退出会让整场结束（服务端规则）。 */
    private void leaveRoom() {
        // 5.154：退出只走一次。连按两次返回键 / 按钮 + 返回键同时按，不该发两次退会请求
        if (leaving || isFinishing()) return;
        leaving = true;
        micButton.setEnabled(false);
        new Thread(new Runnable() {
            public void run() {
                String error = "";
                try {
                    client.orgLeaveRoom(roomKey);
                } catch (Exception e) {
                    error = e.getMessage() == null ? e.toString() : e.getMessage();
                }
                final String failure = error;
                ui.post(new Runnable() {
                    public void run() {
                        if (!failure.isEmpty()) {
                            Toast.makeText(RoomActivity.this,
                                    getString(R.string.toast_leave_error, ServerText.of(RoomActivity.this, failure)),
                                    Toast.LENGTH_SHORT).show();
                        }
                        finish();
                    }
                });            }
        }, "room-leave").start();
    }
    /** 先抢麦，成功才上传（M1/M3 之后这是"开麦"的唯一实现）。 */
    private void takeFloorThenUpload() {
        final MicUploader.Listener listener = new MicUploader.Listener() {
            @Override
            public void onUploadStatus(String message) {
                ui.post(() -> hintLine.setText(message));
            }

            @Override
            public void onUploadError(String message) {
                ui.post(() -> {
                    // 4.59：MicUploader 给的就是完整句子（已按界面语言），这里不再套「上传出错：」
                    hintLine.setText(message);
                    // 5.28：出错也别占着麦克风 —— 走唯一出口
                    releaseAudio();
                });
            }

            @Override
            public void onLevel(float rms, float peak) {
                // 电平只做静默反馈（不刷界面，避免每帧刷新拖慢字幕）
            }
        };
        // 发言权互斥：**先抢麦，再上传**。否则"没人占麦却在上传"，对面永远显示空闲。
        new Thread(new Runnable() {
            public void run() {
                JSONObject body = null;
                String failure = "";
                try {
                    body = client.floorAction(roomKey, "take");
                } catch (Exception e) {
                    failure = e.getMessage() == null ? e.toString() : e.getMessage();
                }
                final JSONObject result = body;
                final String error = failure;
                ui.post(new Runnable() {
                    public void run() {
                        if (result == null || result.optInt("_status", 0) >= 400 || !result.optBoolean("ok", false)) {
                            String reason = ServerText.from(RoomActivity.this, result, error);
                            hintLine.setText(getString(R.string.st_cant_speak,
                        reason.isEmpty() ? getString(R.string.reason_rejected) : reason));
                            micUploadButton.setEnabled(true);
                            return;
                        }
                        takingChanged(holderOf(result), result.optBoolean("locked", false));
                        startUpload(listener);
                    }
                });
            }
        }, "room-take-floor").start();
    }

    /** 没有录音权限就先申请；授予后再回来继续（新界面不再依赖旧界面的授权流程）。 */
    /** 先抢麦再上传（开麦按钮走这条）。 */
    private void ensureRecordPermission() {
        ensureRecordPermission(this::takeFloorThenUpload);
    }

    private void ensureRecordPermission(Runnable then) {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            then.run();
            return;
        }
        pendingAfterPermission = then;
        requestPermissions(new String[] { android.Manifest.permission.RECORD_AUDIO }, REQ_RECORD_AUDIO);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // 5.154：通知权限被拒**不拦任何事** —— 只是"正在收音"那条常驻通知不显示，
        // 收音本身与前台服务照旧（Android 13/14 允许通知被隐藏时服务继续跑）。
        if (requestCode == REQ_NOTIFICATIONS) return;
        if (requestCode != REQ_RECORD_AUDIO) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
        Runnable after = pendingAfterPermission;
        pendingAfterPermission = null;
        if (!granted) {
            hintLine.setText(getString(R.string.st_no_mic_permission));
            return;
        }
        if (after != null) {
            after.run();
        }
    }

    /**
     * 5.154：Android 13+ 通知权限（前台服务的常驻通知要用它）。
     *
     * <p>**尽力而为**：被拒也不影响开会与收音，只是那条"正在收音"的通知不显示。
     * 所以不拦流程、不弹二次解释 —— 一条 `requestPermissions`，之后各走各的。
     */
    private void ensureNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < 33) return;
        try {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                return;
            }
            requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, REQ_NOTIFICATIONS);
        } catch (Exception error) {
            android.util.Log.w("LeionRoom", "申请通知权限失败（不影响收音）：" + error);
        }
    }

    private void startUpload(MicUploader.Listener listener) {        // 5.30：**要说话就别再念译文**。否则自己的 TTS 被自己的麦克风录进去，
        // 识别出"译文的中文"，再翻译一遍 —— 一个自激循环（他们用 asrSuspendedForTts 处理同一件事）。
        if (ttsQueue != null) ttsQueue.stop();
        // 5.28：**先向仲裁器申请麦克风**。手机上录音会话是整机一份的资源，
        // 翻译官/眼镜那边可能正占着；抢不到就当场说清楚，绝不"看着开了麦、其实一句没录"。
        String denied = AudioCaptureArbiter.request(AudioCaptureArbiter.OWNER_ROOM);
        if (!denied.isEmpty()) {
            hintLine.setText(denied);
            updateUploadButton();
            return;
        }
        mic = new MicUploader(this, client, listener);
        AudioCaptureArbiter.attach(AudioCaptureArbiter.OWNER_ROOM, mic);
        // 我在会里说的语言（建房/加入时选的）决定识别方向，别再用默认值
        String speak = getSharedPreferences("leion", MODE_PRIVATE).getString("speakLang", "zh-CN");
        if (speak != null && !speak.isEmpty()) {
            mic.setLanguage(speak);
            // 5.00：这台设备"读"的语言 = 我说的语言（三语会议只显示自己那份译文）
            hearLang = speak;
        }
        String error = mic.start();
        if (error == null) {
            // 5.28：说话时**保持屏幕常亮**。否则"屏幕超时自动锁屏"会走 onStop →
            // 现在会释放麦克风 → 用户还在说话却突然没人听得见，而且界面上看不出原因。
            // 只在开麦期间加这个 flag，关麦立刻去掉（听而不说时不额外耗电）。
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            // 5.154：开麦的同时把这一场标成"麦克风类型的前台服务"。
            // 两个作用：① 用户按电源键息屏后，系统仍允许采音（targetSdk≥30 的硬策略）；
            //          ② 那条常驻通知就是"现在还在收音"的凭据（会议应用不该偷偷录）。
            // 必须在**前台**时启动（Android 12+ 不允许从后台起前台服务），这里正好是。
            MeetingMicService.start(this);
            ensureNotificationPermission();
            updateUploadButton();
            hintLine.setText(getString(R.string.st_uploading_mic));
        } else {
            mic = null;
            // 起不来就把租约还回去，否则别人（翻译官）会被一条"幽灵录音"挡住
            AudioCaptureArbiter.release(AudioCaptureArbiter.OWNER_ROOM);
            updateUploadButton();
            hintLine.setText(error);
        }
    }

    // ── 发言权轮询 ───────────────────────────────────────────────────────
    //
    // ⚠️ 这一圈不只是"刷新谁在说话"：**被顶替时必须立刻停止上传**（4.34 修）。
    // 旧版只改了按钮文字，于是 A 被 B 抢麦后：界面显示发言人是 B，可 A 的麦克风还在
    // 往同一个识别流里灌音频 —— 两路音频交错，字幕错乱，而界面上看着"一切正常"。
    private void scheduleFloorPoll(long delay) {
        if (pollScheduled) return;
        pollScheduled = true;
        ui.postDelayed(() -> {
            pollScheduled = false;
            new Thread(() -> {
                JSONObject state = null;
                try {
                    state = client.floorGet(roomKey);
                } catch (Exception ignored) {
                    // 网络抖动不弹框：下一轮继续
                }
                final JSONObject body = state;
                ui.post(() -> {
                    // 兜底：每 5 轮问一次"这场还在不在"（4.46）。
                    // 为什么需要它：老服务端的 /floor 对已结束的会议照样返回状态，
                    // 客户端没有任何信号可用 —— 而房间详情里有 closed 字段。
                    pollTicks += 1;
                    if (pollTicks % 5 == 0) checkRoomStillOpen();
                    // 单会话：被别处登录顶掉时，房间里的轮询是最早能发现的地方
                    // （点按钮才发现的话，用户已经对着"没反应"愣了几秒）
                    if (body != null && body.optInt("httpStatus", 0) == 401) {
                        showKicked(ServerText.from(this, body, ""));
                        return;
                    }
                    // 会议已结束（发起者退出）：WS 那条路会立刻收到 closed，
                    // 这里是兜底 —— WS 断了的时候靠轮询也能发现，不能把人留在空屋里。
                    if (body != null && (body.optBoolean("closed", false)
                            || body.optInt("httpStatus", 0) == 410)) {
                        leaveBecauseClosed(ServerText.from(this, body, getString(R.string.st_meeting_closed)));
                        return;
                    }
                    if (body != null && body.optBoolean("ok", false)) {
                        String released = body.optString("released", "");
                        if (!released.isEmpty() && !"null".equals(released)) {
                            // 服务端把"锁着麦但人已经不在"的那位清掉了（4.42）
                            String message = getString(R.string.sys_dropped, released)
                                    + (body.optBoolean("releasedLocked", false) ? getString(R.string.sys_locked_suffix) : "");
                            hintLine.setText(message);
                            Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
                        }
                        applyFloorState(holderOf(body), body.optBoolean("locked", false));
                    }
                    // 推送通道活着 → 轮询只当看门狗，别白跑那么勤；断了 → 立刻回到 2 秒
                    if (!isFinishing()) scheduleFloorPoll(wsOnline ? FLOOR_POLL_WATCHDOG_MS : FLOOR_POLL_MS);
                });
            }, "room-floor-poll").start();
        }, delay);
    }

    /**
     * 上传状态变了 → 刷新**开麦按钮**（4.52 起上传与开麦合成一个按钮）。
     *
     * <p>保留这个函数名，是因为它被"被顶替/掉线/出错"好几处调用；
     * 现在它只负责把外观同步过去，隐藏的 roomUpload 不再参与显示。
     */
    private void updateUploadButton() {
        updateMicButton();
    }

    /**
     * 一份发言权状态到了 —— **轮询和 WS 推送走同一条路**（4.35）。
     *
     * 两处入口必须共用这段，否则就会出现"推送很快，但忘了停上传"这类不对称的 bug：
     * 界面上 B 在说话、A 的麦克风还在传，正是 4.34 修的那个故障。
     */
    private void applyFloorState(String holder, boolean isLocked) {
        boolean wasHolding = holding;
        takingChanged(holder, isLocked);
        if (holding) {
            heartbeatIfDue();
        } else if (wasHolding || mic != null) {
            // 我已经不是持麦者：被别人顶替 / 被强制收回 / 租约过期
            onFloorLost(holder);
        }
    }

    /** 拉一次房间详情：房间号、主题、成员数、我是不是发起者（4.52 顶部两行要用）。 */
    private void loadRoomHeader() {
        if (client == null) return;      // 4.55：抽屉轮询也可能在 client 建好前触发
        new Thread(() -> {
            JSONObject info = null;
            try {
                info = client.orgRoomInfo(roomKey);
            } catch (Exception ignored) {
                return;
            }
            if (info == null) return;
            final JSONObject room = info.optJSONObject("room");
            final org.json.JSONArray members = info.optJSONArray("members");
            final org.json.JSONObject pipeline =
                    info.isNull("pipeline") ? null : info.optJSONObject("pipeline");
            final org.json.JSONObject strategy =
                    info.isNull("strategy") ? null : info.optJSONObject("strategy");
            ui.post(() -> {
                if (room != null) {
                    String code = room.optString("code", "");
                    if (!code.isEmpty()) codeView.setText("#" + code);
                    // 5.06：记下来 —— 会中换语言时要用邀请码把自己重新登记一次
                    roomCode = code;
                    String name = room.optString("name", "");
                    if (!name.isEmpty()) titleView.setText(name);
                    String host = room.optString("host", "");
                    iAmHost = myName != null && myName.equals(host);
                    roleTag.setText(iAmHost ? getString(R.string.room_role_host) : getString(R.string.room_role_member));
                    roleTag.setBackgroundResource(iAmHost ? R.drawable.bg_chip_brand : R.drawable.bg_chip);
                    roleTag.setTextColor(getColor(iAmHost ? R.color.brand : R.color.ink_soft));
                }
                if (members != null) {
                    membersView.setText(getString(R.string.room_members_count, members.length()));
                    renderMembers(members);
                }
                // 5.15：这一场到底有没有在翻译？被 `--max-rooms` 挡住时要**明说**，
                // 否则手机上就是"说了半天什么都没出来"，看起来像坏了。
                applyPipelineState(pipeline);
                // 5.148：开发者模式才显示"本场用哪套识别策略"（冻结快照优先）
                renderStrategy(strategy);
            });
        }, "room-header").start();
    }

    /**
     * 5.148：**开发者模式**下显示这一场实际用哪套识别策略（按语言一行）。
     *
     * <p>为什么值得占一行：换了模型之后"字幕风格变了 / 变慢了"这类问题，
     * 第一个要回答的就是"这场到底跑的是哪个模型"。服务端给的是**冻结快照**
     * （`source=room-strategy`）或**当前全局表**（`source=asr-models.json`）——
     * 两者必须能分清，否则又变成"日志说假话"。
     */
    private void renderStrategy(org.json.JSONObject strategy) {
        if (strategyView == null) return;
        if (!DevMode.enabled(this) || strategy == null) {
            strategyView.setVisibility(View.GONE);
            return;
        }
        org.json.JSONObject languages = strategy.optJSONObject("languages");
        if (languages == null) {
            strategyView.setVisibility(View.GONE);
            return;
        }
        StringBuilder out = new StringBuilder(getString(R.string.room_strategy_label));
        out.append('\n');
        int rows = 0;
        for (final String lang : new String[]{"zh-CN", "en-US", "pt-BR"}) {
            org.json.JSONObject one = languages.optJSONObject(lang);
            if (one == null) continue;
            if (rows > 0) out.append('\n');
            rows += 1;
            out.append(langLabelOf(lang)).append("  ")
                    .append(one.optString("engine", "?"))
                    .append(" / ").append(one.optString("model", "?"));
            String compute = one.optString("compute_type", "");
            if (!compute.isEmpty()) out.append(" / ").append(compute);
        }
        String lockedAt = strategy.optString("lockedAt", "");
        if (rows > 0) {
            out.append('\n').append(lockedAt.isEmpty()
                    ? getString(R.string.room_strategy_live)
                    : getString(R.string.room_strategy_locked, shortTime(lockedAt)));
        }
        strategyView.setText(out.toString());
        strategyView.setVisibility(rows > 0 ? View.VISIBLE : View.GONE);
    }

    /** `2026-11-09T09:12:33.482Z` → `09:12`（只给人看个先后，不追求完整时间）。 */
    private static String shortTime(String iso) {
        int cut = iso.indexOf('T');
        if (cut < 0 || iso.length() < cut + 6) return iso;
        return iso.substring(cut + 1, cut + 6);
    }

    /**
     * 顶部房间信息的**定时**刷新（5.143）。
     *
     * <p>修的是用户报的那个 bug：「一个人之后新来的，新来的显示正常，但**一开始在的那个人**
     * 界面里人数不变」。根因很简单 —— 人数只在进房间（以及打开抽屉）时拉过一次，没有任何东西
     * 会再问一次；而服务端不推"成员变化"（它推的是发言权与字幕帧）。
     *
     * <p>为什么用 5 秒轮询而不是加一条 WS 消息：成员变化是**低频、无实时要求**的信息，
     * 一个几 KB 的 GET 已经足够；加协议面的代价（服务端、老客户端兼容、断线重连）比这大得多。
     * 抽屉开着时本来就有 2 秒刷新，这条只管顶部那一行与语言/角色。
     */
    private void scheduleHeaderTick() {
        ui.postDelayed(() -> {
            if (isFinishing() || client == null) return;   // 已退出：别再问
            loadRoomHeader();
            scheduleHeaderTick();
        }, HEADER_TICK_MS);
    }

    /**
     * 按"管线状态"更新提示行（5.15）。
     *
     * <p>状态由 `start-multi`（看门人）写在 `<data-dir>/room-pipeline/<房间>.json`，
     * relay 把它放进房间详情。三种可能：
     * <ul>
     *   <li>`denied`：服务器并发满了（`--max-rooms`），这一场**没有在翻译** —— 必须说出来；</li>
     *   <li>`running`：正常在跑（顺手把之前那句"服务器已满"清掉）；</li>
     *   <li>null：单房间 `start-all`，或还没起管线 —— 什么都别说（不制造噪音）。</li>
     * </ul>
     */
    private void applyPipelineState(org.json.JSONObject pipeline) {
        if (pipeline == null) {
            if (pipelineDenied) {
                pipelineDenied = false;
                hintLine.setText("");
            }
            return;
        }
        String state = pipeline.isNull("state") ? "" : pipeline.optString("state", "");
        if ("denied".equals(state)) {
            pipelineDenied = true;
            hintLine.setText(getString(R.string.st_pipeline_denied, pipeline.optInt("maxRooms", 0)));
            return;
        }
        if (pipelineDenied) {
            pipelineDenied = false;
            hintLine.setText("");
        }
    }

    /**
     * 抽屉里的成员列表：头像首字 + 姓名 +（发起者才有的）管理操作。
     *
     * <p>管理者能做的两件事对应两处真实能力：
     *   · 「移出」→ `POST /org/rooms/:id/members/remove`（服务端会顺手释放他占着的麦）；
     *   · 「解除锁定」→ 现有 `force-release`（只对当前持麦者出现，且仅发起者可见）。
     */
    private void renderMembers(org.json.JSONArray members) {
        if (membersList == null || members == null) return;
        membersList.removeAllViews();
        for (int i = 0; i < members.length(); i++) {
            JSONObject one = members.optJSONObject(i);
            String name = one == null ? members.optString(i, "") : one.optString("username", "");
            if (name.isEmpty()) continue;

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(android.view.Gravity.CENTER_VERTICAL);
            int pad = dp(4);
            row.setPadding(0, pad, 0, pad);

            TextView avatar = new TextView(this);
            avatar.setText(firstChar(name));
            avatar.setGravity(android.view.Gravity.CENTER);
            avatar.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11);
            avatar.setTextColor(getColor(R.color.brand));
            avatar.setBackgroundResource(R.drawable.bg_avatar);
            int dot = dp(22);
            row.addView(avatar, new LinearLayout.LayoutParams(dot, dot));

            TextView label = new TextView(this);
            String suffix = name.equals(myName) ? getString(R.string.room_me_suffix) : "";
            // 4.95：正在说话的人就在他的名字后面标出来。
            // 这是抽屉里唯一需要"谁在说"的地方，而以前它只能靠顶部那行文字反解 ——
            // 于是没人在麦上时，抽屉里也显示着一个叫「麦克风空闲」的发言人。
            String speaking = name.equals(holderName) ? getString(R.string.room_speaking_suffix) : "";
            label.setText(name + suffix + speaking);
            label.setTextColor(getColor(R.color.ink));
            label.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
            LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            labelParams.leftMargin = dp(8);
            row.addView(label, labelParams);

            // 管理者操作：只对"别人"显示移出（移自己要走退出，那是结束会议）
            if (iAmHost && !name.equals(myName)) {
                TextView remove = new TextView(this);
                remove.setText(getString(R.string.btn_remove));
                remove.setTextColor(getColor(R.color.err));
                remove.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11);
                remove.setPadding(dp(8), dp(4), dp(4), dp(4));
                remove.setOnClickListener(v -> confirmRemove(name));
                row.addView(remove, new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            }
            membersList.addView(row);
        }

        // 当前持麦者 + 已锁定时，发起者可以"解除锁定"（复用 force-release）
        if (iAmHost && locked && holder() != null && !holder().isEmpty()) {
            TextView force = new TextView(this);
            force.setText(getString(R.string.btn_force_release, holder()));
            force.setTextColor(getColor(R.color.brand));
            force.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11);
            force.setPadding(0, dp(6), 0, dp(6));
            force.setOnClickListener(v -> act("force-release"));
            membersList.addView(force);
        }
    }

    /** 当前持麦者（4.95：读字段，不再从状态文字里反解 —— 那会解出「麦克风空闲」这种"人名"）。 */
    private String holder() {
        return holderName == null ? "" : holderName;
    }

    /** 移出成员要二次确认：这是个不可撤销（对方视角）的动作。 */
    private void confirmRemove(final String name) {
        new android.app.AlertDialog.Builder(this)
                .setTitle(getString(R.string.remove_dialog_title, name))
                .setMessage(getString(R.string.remove_dialog_msg1)
                        + getString(R.string.remove_dialog_msg2))
                .setNegativeButton(getString(R.string.common_cancel), null)
                .setPositiveButton(getString(R.string.btn_remove), (dialog, which) -> doRemove(name))
                .show();
    }

    private void doRemove(final String name) {
        new Thread(() -> {
            JSONObject result = null;
            String failure = "";
            try {
                result = client.orgRemoveMember(roomKey, name);
            } catch (Exception e) {
                failure = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject body = result;
            final String error = failure;
            ui.post(() -> {
                if (body == null || !body.optBoolean("ok", false)) {
                    String reason = ServerText.from(this, body, error);
                    Toast.makeText(this, getString(R.string.st_remove_failed, reason), Toast.LENGTH_LONG).show();
                    return;
                }
                addSystemEvent(getString(R.string.sys_removed, name));
                org.json.JSONArray members = body.optJSONArray("members");
                if (members != null) {
                    membersView.setText(getString(R.string.room_members_count, members.length()));
                    renderMembers(members);
                }
                loadRoomHeader();
            });
        }, "room-remove-member").start();
    }

    /** 复制邀请码（对方凭它入会）。 */
    private void copyInvite() {
        String text = codeView.getText() == null ? "" : codeView.getText().toString();
        text = text.replace("#", "").trim();
        if (text.isEmpty()) {
            Toast.makeText(this, getString(R.string.toast_no_invite), Toast.LENGTH_SHORT).show();
            return;
        }
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText(getString(R.string.clip_invite_label), text));
        }
        Toast.makeText(this, getString(R.string.toast_invite_copied, text), Toast.LENGTH_SHORT).show();
    }

    /** 「人员与设备」抽屉：点右侧悬浮条开，再点一次/点关闭收。 */
    private void toggleDrawer() {
        boolean open = drawer.getVisibility() == View.VISIBLE;
        drawer.setVisibility(open ? View.GONE : View.VISIBLE);
        if (open) {
            stopDrawerRefresh();
            return;
        }
        loadRoomHeader();
        startDrawerRefresh();   // 打开期间实时刷新（4.55）
    }

    /**
     * 5.26：强制更新门禁（进房再查一次，见 {@link UpdateGuard}）。
     *
     * <p>被拦时就**停掉一切输入**：关麦、停上传、关倾听 —— 带着旧版本继续开会，
     * 出问题的形态是"字幕莫名其妙不对"，而那时候没人会想到是版本。
     */
    private void checkAppVersion() {
        final String mine = UpdateGuard.versionName(this);
        new Thread(() -> {
            org.json.JSONObject response = null;
            try {
                response = client.appVersion(mine);
            } catch (Exception error) {
                android.util.Log.i("LeionRoom", "版本检查跳过（连不上/旧服务端）：" + error);
            }
            final org.json.JSONObject got = response;
            runOnUiThread(() -> {
                if (UpdateGuard.check(this, got, this::checkAppVersion) == true) return;
                // 5.28：版本不一致时整条音频链都要停（唯一的音频出口）
                releaseAudio();
                if (hintLine != null) hintLine.setText(getString(R.string.update_title));
                if (micButton != null) micButton.setEnabled(false);
                if (micUploadButton != null) micUploadButton.setEnabled(false);
            });
        }, "room-version").start();
    }

    /** 会议计时：进房开始走，退出即停。 */
    private void startTimer() {        timerRunning = true;
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (!timerRunning || isFinishing()) return;
                long seconds = (System.currentTimeMillis() - startedAtMs) / 1000;
                timerView.setText(String.format(java.util.Locale.US, "%02d:%02d",
                        seconds / 60, seconds % 60));
                // 5.06：每秒顺手看一眼"我会中是不是换了语言"（改一次就生效，不用重进房间）
                syncSpokenLanguage();
                ui.postDelayed(this, 1000);
            }
        });
    }

    /**
     * 会中换语言要**当场生效**（5.06）。
     *
     * <p>两件事必须一起做，少一件都会出问题：
     * <ol>
     *   <li><b>本地</b>：`hearLang` 换成新语言 —— 存量的按语言过滤/去重都看它；</li>
     *   <li><b>服务端</b>：用自己的邀请码重新 `POST /org/rooms/join {code, lang}`，
     *       把 `room_members.lang` 更新掉。不更新的话，大脑算出来的"听众语言集合"里
     *       没有这门语言 —— 它**一句都不会译**，而按语言扇出时这台设备也收不到。</li>
     * </ol>
     * 入会时已经登记过一次，所以"进房后的第一次"只同步本地、不重复打服务端。
     */
    private void syncSpokenLanguage() {
        final String want = getSharedPreferences("leion", MODE_PRIVATE).getString("speakLang", "");
        if (want == null || want.isEmpty() || want.equals(syncedSpeakLang)) return;
        final boolean changed = !syncedSpeakLang.isEmpty();
        syncedSpeakLang = want;
        hearLang = want;
        // 5.120：换了说话语言，"我想看"的集合也要跟着含它（HearLangs 的硬规则），
        // 否则切到葡语说话之后，葡语那份译文会被自己的过滤器挡掉。
        String wantTag = HearLangs.normalizeTag(want);
        if (wantTag != null) hearLangs.add(wantTag);
        if (mic != null) mic.setLanguage(want);
        // 5.07：顶部那格「我说…」跟着换（它以前永远显示中文）
        updateModeTag();
        if (!changed || roomCode.isEmpty()) return;
        hintLine.setText(getString(R.string.st_lang_now, langLabelOf(want)));
        final String langs = HearLangs.join(hearLangs, want);
        // 轮询那边也要跟着换，否则它还在按旧的集合收发
        if (client != null) client.setHearLangs(langs);
        new Thread(() -> {
            try {
                // 5.120：连 `hearLangs` 一起报，服务端才知道"这台设备要看哪几门"。
                client.orgJoinRoom(roomCode, want, null, langs);
            } catch (Exception ignored) {
                // 网络不通就算了：下一次开麦上传时服务端还会用 &lang= 校正一次
            }
        }, "room-lang-sync").start();
    }

    private String langLabelOf(String lang) {
        if ("pt-BR".equals(lang)) return getString(R.string.rooms_speak_pt);
        if ("en-US".equals(lang)) return getString(R.string.rooms_speak_en);
        return getString(R.string.rooms_speak_zh);
    }

    /**
     * 顶部那一格「我说…」到底是什么（5.07）。
     *
     * <p>它原来只是布局里的缺省文案（中文），Java 侧拿到控件后**从没赋过值** ——
     * 选葡语、选英语都照旧显示「我说中文」。这类"静态文案冒充状态"的 bug 很难从日志发现，
     * 只有盯着界面看才会觉得不对（用户就是这么发现的）。
     *
     * <p>现在按**实际的两个选择**渲染：参会语言（我在会里说/读哪种）· 参会方式（面对面/远程）。
     * 参会方式在 5.04 才收集，所以老数据可能没有 —— 那就只显示语言，不硬编一个方式。
     */
    private void updateModeTag() {
        if (modeTag == null) return;
        SharedPreferences prefs = getSharedPreferences("leion", MODE_PRIVATE);
        String lang = prefs.getString("speakLang", "");
        String mode = prefs.getString("attendMode", "");
        String langText = langLabelOf(lang == null ? "" : lang);
        String modeText = "remote".equals(mode) ? getString(R.string.attend_mode_remote)
                : ("onsite".equals(mode) ? getString(R.string.attend_mode_onsite) : "");
        // 5.146：建/入会页的语言胶囊已去掉"我说"前缀（用户要求），
        // 所以这里靠格式化文案把"我说…"补回来 —— 否则顶部那格只剩"中文 · 面对面"。
        modeTag.setText(modeText.isEmpty()
                ? getString(R.string.rooms_mode_tag_lang, langText)
                : getString(R.string.rooms_mode_tag, langText, modeText));
    }

    /**
     * 停止上传并刷新按钮；`hint` 为空则保留当前提示。
     *
     * <p>5.28：内部改成走 {@link #releaseAudio()}（唯一的音频出口），
     * 保留这个方法只是因为很多路径还要"顺带说一句人话"。
     */
    private void stopUpload(String hint) {
        releaseAudio();
        lastHeartbeat = 0L;
        updateUploadButton();
        if (hint != null && !hint.isEmpty()) {
            hintLine.setText(hint);
        }
    }

    /**
     * 发言权不再在我手上。**必须自己把麦克风停掉** —— 服务端只负责裁决"谁是持麦者"，
     * 它不知道我这边还在录音；不主动停，两路音频就会混进同一个识别流。
     */
    private void onFloorLost(String holder) {
        boolean wasUploading = mic != null;
        String who = holder == null ? "" : holder;
        String message;
        if (!who.isEmpty()) {
            message = wasUploading ? getString(R.string.st_took_over_sys, who) : getString(R.string.st_took_over_sys_plain, who);
        } else {
            message = wasUploading ? getString(R.string.st_mic_released_sys) : "";
        }
        if (message.isEmpty()) {
            updateUploadButton();
            return;
        }
        stopUpload(message);
        addSystemEvent(message);
        // 字幕流会不断改写 hint 行，所以这条提示再用 Toast 说一次（否则一闪就没了）
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private void heartbeatIfDue() {
        long now = System.currentTimeMillis();
        if (now - lastHeartbeat < HEARTBEAT_MS) return;
        lastHeartbeat = now;
        new Thread(() -> {
            JSONObject reply = null;
            try {
                reply = client.floorAction(roomKey, "heartbeat");
            } catch (Exception ignored) {
                // 网络抖动：交给 2 秒轮询与服务端 15 秒租约兜底
                return;
            }
            final JSONObject body = reply;
            if (body != null && !body.optBoolean("ok", false)) {
                // 服务端说"不是持麦者"：别再等下一轮轮询，那一秒的音频会混进识别流
                ui.post(() -> {
                    holding = false;
                    stopUpload(getString(R.string.st_not_holder));
                });
            }
        }, "room-floor-heartbeat").start();
    }

    // ── LanClient.Listener ──────────────────────────────────────────────
    @Override
    public void onStatus(String message) {
        ui.post(() -> statusLine.setText(message));
    }

    @Override
    public void onHello(String device, int cols, int lineBudget) {
        // 手机-only：不需要设备名；只显示连接状态。
        // 4.46：服务端版本老的时候要**说出来** —— 老服务端不会推"会议结束"，
        // 用户会以为是"点了没反应"，而不是"服务器没更新"。
        ui.post(() -> {
            // 连上了就把状态行清空（"已连接 · 40×3"是开发期信息，用户不需要看）。
            statusLine.setText("");
            // 但"服务端版本较旧"是**会影响功能**的，必须说，而且要说清后果。
            if (!client.hasFeature("room-closed-push")) {
                statusLine.setText(getString(R.string.st_old_server));
            }
        });
    }

    @Override
    public void onFrame(String speaker, String lang, String[] lines, String text,
                        String source, String sourceLang, boolean partial, String[] termsMissing,
                        String speakerName, String notice) {
        // 5.00：这里的 `lang` 就是"这一帧译成哪种语言"（relay 的帧字段），直接传给 applyFrame
        ui.post(() -> applyFrame(text, lines, source, sourceLang, partial, termsMissing,
                speakerName, lang, notice));
    }

    /**
     * 渲染一帧字幕。**长轮询与 WS 推送都走这里**（4.43），否则两条路各写一份，
     * 迟早出现"长轮询能显示、WS 显示不出来"这种只在一半设备上出现的分裂。
     *
     * @param speakerName 这一句**是谁说的**（4.95：服务端随帧给出；空串 = 未知）
     * @param lang        这一帧是**译成哪种语言**的（5.120：三语会议里同一句会产出多份帧，
     *                    勾了的每一份都显示，见 {@link #hearLangs}；空串 = 老服务端，照旧显示）
     */
    private void applyFrame(String text, String[] lines, String source, String sourceLang, boolean partial,
                            String[] termsMissing, String speakerName, String lang, String notice) {
        String target = (text == null || text.isEmpty())
                ? (lines == null ? "" : String.join("\n", lines)) : text;
        String frameLang = lang == null ? "" : lang.trim();
        // ── 5.123：**我自己说的那句话，只给我原文** ────────────────────────────────
        //
        // 这是产品早就定下的规矩，不是"实现得不够好"：A 说英语、同时想看英语+葡语时，
        // A 自己的那句话只该显示原文；"英语→葡语"那份译文是**给别人**的。
        // 服务端也按同一条规矩不发（ws-hub 的 exceptUser），这里再拦一道：
        // 长轮询那条路拿不到请求者身份，只能靠本机知道"我是谁"。
        //
        // 判据：带译文的帧（`lang` 与源语言不同、且有译文内容）+ 发言人就是我自己。
        // 原文帧（echo）的 `lang` 等于源语言、译文为空，因此不受影响 —— 那正是我该看到的。
        String fromLang = sourceLang == null ? "" : sourceLang.trim();
        // ── 5.152：念**原文**时必须在语言过滤**之前**取 ──────────────────────────────
        //
        // 原文帧（echo）的 `lang` 就是**源语言**（对方说的葡语），下面「我读哪几种语言」
        // 那层过滤会把它挡掉 —— 而念原文恰恰不吃那层过滤：我要听的就是对方原话。
        // 所以这一句只能写在这里；只取定稿帧（增量帧是半句话，念出来很怪）。
        if (!partial && ttsOriginal) {
            offerTts(source, fromLang, speakerName);
        }
        if (!target.isEmpty() && !frameLang.isEmpty() && !fromLang.isEmpty()
                && !frameLang.equals(fromLang)
                && myName != null && !myName.isEmpty()
                && speakerName != null && speakerName.trim().equals(myName)) {
            return;
        }
        // 5.120：按**集合**拦，不是按单个主语言。三语会议里同一句会产出多份译文
        // （中/葡/英各一份），勾了的每一份都该显示 —— 原来拿单个 `hearLang` 比对，
        // 等于把用户勾的其他语种全部丢掉（"勾了几种只显示一种"就是这么来的）。
        // 帧语言缺失（老服务端/无语言）时照旧显示 —— 宁可多显示，也不能吞掉字幕。
        if (!frameLang.isEmpty() && !hearLangs.isEmpty() && !wantsFrameLanguage(frameLang)) {
            return;
        }
        // 5.12：这一帧带了提示（例如"本场语言相同 · 无需翻译"）—— 写在提示行，
        // 让人知道"没译文"是设计如此，不是坏了。
        if (notice != null && !notice.isEmpty()) {
            // 5.151：服务端给的是**机器码**，按界面语言翻成人话（别把 code 直接甩到界面上）。
            hintLine.setText(noticeText(notice));
        }
        renderSegment(target == null ? "" : target, source == null ? "" : source, partial,
                speakerName == null ? "" : speakerName.trim(), frameLang);
        // 5.152：念译文的地方**只剩** renderSegment 里那一处。
        // 这里原来还有一处「把 target 入队」，与 renderSegment 里的主语言判断同时满足 ——
        // 于是同一句会被念两遍（功能关着的时候没人发现）。
        // 念译文/念原文的开关与去重都在 offerTts 里。
        if (partial) {
            hintLine.setText(getString(R.string.st_generating));
        } else if (termsMissing != null && termsMissing.length > 0) {
            hintLine.setText(getString(R.string.st_terms_missing,
                    String.join(getString(R.string.list_separator), termsMissing)));
        } else if (notice == null || notice.isEmpty()) {
            hintLine.setText("");
        }
    }

    /**
     * 服务端的 notice 机器码 → 界面语言下的人话（5.151）。
     *
     * <p>为什么必须映射：same-language / translation-interrupted 这类是**协议里的码**，
     * 直接显示就等于把内部字段名甩给用户；未知码原样显示 —— 至少能贴进日志排障。
     */
    private String noticeText(String code) {
        if ("same-language".equals(code)) return getString(R.string.st_same_language);
        if ("translation-interrupted".equals(code)) return getString(R.string.st_trans_interrupted);
        return code;
    }

    /**
     * 5.152：底部那颗「朗读 · 译文 / 原文」开关。
     *
     * <p>关 = 念原文、开 = 念译文（布局里 {@code textOff/textOn} 就是这两个词）。
     * 切换时**立刻闭嘴**：否则切到"念原文"之后，上一句译文还会被念完 ——
     * 用户听到的是"我明明切了，它还在念中文"。
     */
    private void bindTtsSwitch() {
        android.widget.Switch toggle = findViewById(R.id.roomTtsSwitch);
        if (toggle == null) return;
        toggle.setChecked(ttsOriginal);
        toggle.setOnCheckedChangeListener((buttonView, isChecked) -> {
            ttsOriginal = isChecked;
            getSharedPreferences("leion", MODE_PRIVATE).edit()
                    .putBoolean("ttsReadOriginal", isChecked).apply();
            lastTtsKey = "";
            if (ttsQueue != null) ttsQueue.stop();
            if (hintLine != null) hintLine.setText("");
        });
    }

    /**
     * 5.152：**所有**朗读请求的唯一入口（念译文、念原文都走这里）。
     *
     * <p>三个判断都在这里，因为三条都是"漏一条就出问题"的：
     * <ol>
     *   <li>**不念自己说的话**：自己刚说完的话再被机器念一遍，纯噪音；</li>
     *   <li>**同一句只念一次**：一句话会从多条帧到达（原文帧一次、每种语言的译文帧各一次），
     *       不去重就会连念两三遍；</li>
     *   <li>**空文本不念**（译文帧可能只带原文，例如"语言相同"那种帧）。</li>
     * </ol>
     */
    private void offerTts(String text, String lang, String speakerName) {
        if (ttsQueue == null) return;
        String value = text == null ? "" : text.trim();
        if (value.isEmpty()) return;
        String who = speakerName == null ? "" : speakerName.trim();
        if (myName != null && !myName.isEmpty() && !who.isEmpty() && who.equals(myName)) return;
        String key = who + '\u0001' + value;
        long now = System.currentTimeMillis();
        if (key.equals(lastTtsKey) && now - lastTtsAt < TTS_DEDUPE_MS) return;
        lastTtsKey = key;
        lastTtsAt = now;
        ttsQueue.offer(value, lang == null || lang.isEmpty() ? hearLang : lang);
    }

    /**
     * 「我想看哪些译文」的**唯一取值点**（5.120）：偏好里的多选 + 强制并入说话语言。
     *
     * <p>会议页与建房页必须用同一套规则，否则"勾的时候三种、显示的时候一种"，
     * 而且不会有任何报错 —— 只能靠这里统一（见 {@code HearLangs}）。
     */
    private java.util.List<String> hearLangsOf(SharedPreferences prefs) {
        SharedPreferences store = prefs == null ? getSharedPreferences("leion", MODE_PRIVATE) : prefs;
        return HearLangs.normalize(HearLangs.parse(store.getString("hearLangs", "")),
                store.getString("speakLang", ""));
    }

    /** 这一帧的译文语言在不在「我想看」的集合里（认不出的标签不拦，宁可多显示）。 */
    private boolean wantsFrameLanguage(String frameLang) {
        String tag = HearLangs.normalizeTag(frameLang);
        if (tag == null) return true;
        return hearLangs.contains(tag);
    }

    /**
     * 把一帧字幕落到中央字幕流里（M1）。
     *
     * <p>两条规矩，都是从旧界面的 `SubtitleList` 学来的：
     * <ol>
     *   <li><b>partial 帧原位更新</b>：同一个片段在"生成中 → 定稿"之间只占一张卡。
     *       新起一条会让同一句话出现两次，用户会以为翻译重复了。</li>
     *   <li><b>新句从下往上推</b>：追加后自动滚到底，读到的是最新的那句话。</li>
     * </ol>
     */
    private void renderSegment(String target, String source, boolean partial, String speakerName,
                               String lang) {
        if (target.isEmpty() && source.isEmpty()) return;
        if (emptyView.getVisibility() == View.VISIBLE) emptyView.setVisibility(View.GONE);

        // 4.95：**这一句是谁说的**。
        //
        // 原来写的是 `mine = … && holding` —— 用的是"我此刻是否持麦"，而不是"这句话是谁说的"。
        // 结果：没人在麦上时每张卡片的发言人都显示「麦克风空闲」，而且永远显示"对方"。
        // 现在按帧里带的 `speakerName` 判；服务端没给（老服务端）时退回"当前持麦者"，
        // 再退不回就显示「对方」——**绝不再把状态文字当成发言人名字**。
        String who = speakerName;
        if (who.isEmpty()) who = holderName;
        boolean mine = myName != null && !myName.isEmpty() && who.equals(myName);
        String whoLabel = who.isEmpty() ? getString(R.string.room_other) : who;

        String langKey = lang == null ? "" : lang;
        // ── 同一句判定（5.121：一句话 = 一张卡，几种译文各占一行）──────────────
        //
        // 旧实现只跟"上一张卡"比，于是：增量(pt) → 定稿(pt) → 增量(en) → 定稿(en)
        // 这种**按语言交替**到达的顺序，每一步都"和上一张不同"，每帧都新起一张卡 ——
        // 用户实测：一句话出现五条字幕（葡语三条、英语两条）。它要的是**一条**。
        //
        // 现在按"发言人 + 原文"认同一句：同一句的几种语言、增量与定稿都长在同一张卡上，
        // 每种语言单独一行。原文一致就够——增量帧带的原文是**这整句**（不是逐字变长的），
        // 定稿帧与 echo 帧带的也是同一句原文。
        String sentenceKey = sentenceKeyOf(whoLabel, source, target);
        SentenceCard card = findSentenceCard(sentenceKey);
        if (card == null) card = createSentenceCard(sentenceKey, mine, whoLabel, source);
        else if (!source.isEmpty() && !source.contentEquals(card.source.getText())) {
            card.source.setText(source);
            card.source.setVisibility(showSource ? View.VISIBLE : View.GONE);
        }
        card.key = sentenceKey;
        card.at = System.currentTimeMillis();
        card.partial = partial;

        // 这一门语言的译文：没有就加一行，有就原地换（增量 → 定稿）。
        if (!target.isEmpty()) {
            TextView line = card.lines.get(langKey);
            if (line == null) {
                line = new TextView(this);
                line.setTextColor(getColor(R.color.ink));
                line.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15);
                line.setTypeface(line.getTypeface(), android.graphics.Typeface.BOLD);
                line.setLineSpacing(dp(4), 1f);
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                params.topMargin = dp(6);
                card.translations.addView(line, params);
                card.lines.put(langKey, line);
            }
            line.setTag(target);           // 原始译文；标签前缀由 refreshTranslationLabels 统一加
            line.setVisibility(View.VISIBLE);
            refreshTranslationLabels(card);
        }
        boolean anyPartial = partial;
        card.state.setText(anyPartial ? getString(R.string.st_recognizing) : getString(R.string.st_done));
        card.state.setTextColor(getColor(anyPartial ? R.color.accent : R.color.ok));
        watchPartial(card, anyPartial);
        scrollToBottom();

        // 5.30：**定稿译文**才朗读（增量帧是半句话，念出来很怪）。
        // 5.121：只念**主语言**那一份 —— 勾了两种译文时，两种都念等于把同一句话念两遍。
        // 5.152：这是念译文**唯一**的触发点（applyFrame 里那处重复的已删）；念原文时不走这里。
        if (!partial && !ttsOriginal && !target.isEmpty() && isPrimaryLang(langKey)) {
            offerTts(target, langKey.isEmpty() ? hearLang : langKey, speakerName);
        }
    }

    /**
     * 5.150：增量帧来了就起表，定稿来了就撤表。
     *
     * <p>撤表必须跟着一起做，否则"先增量、后定稿"的句子上，超时那一下仍会在 20 秒后
     * 把状态改回"未定稿"—— 明明已经定稿了。
     */
    private void watchPartial(SentenceCard card, boolean partial) {
        Runnable pending = partialWatch.remove(card);
        if (pending != null) ui.removeCallbacks(pending);
        if (!partial) return;
        Runnable timer = () -> {
            partialWatch.remove(card);
            if (card.state == null) return;
            if (!getString(R.string.st_recognizing).contentEquals(card.state.getText())) return;
            card.state.setText(getString(R.string.st_no_final));
            card.state.setTextColor(getColor(R.color.ink_faint));
            if (hintLine != null) hintLine.setText(getString(R.string.st_no_final_hint));
            android.util.Log.w("LeionRoom", "⏱ 这一句 " + (PARTIAL_TIMEOUT_MS / 1000) + "s 没等到定稿（卡片 " + card.key + "）");
        };
        partialWatch.put(card, timer);
        ui.postDelayed(timer, PARTIAL_TIMEOUT_MS);
    }

    /** 一句话的卡片（5.121）：同一句的几种译文都长在这张卡里。 */
    private static final class SentenceCard {
        View root;
        TextView source;
        LinearLayout translations;
        TextView state;
        /** 语种 → 那一行译文。 */
        final java.util.Map<String, TextView> lines = new java.util.LinkedHashMap<>();
        String key = "";
        long at = 0L;
        boolean partial = false;
    }

    /** 一句话的"身份"：发言人 + 原文（原文缺失时退回译文本身）。 */
    private String sentenceKeyOf(String whoLabel, String source, String target) {
        String origin = source == null || source.isEmpty() ? target : source;
        return whoLabel + "\n" + (origin == null ? "" : origin);
    }

    /**
     * 找这句话已经在屏幕上的那张卡；顺带把过期的丢掉。
     *
     * <p>为什么要过期：同一个人连说两句一模一样的话（"对。"、"对。"）会被认成一句 ——
     * 那是"合并"的代价。用时间窗限制：只有 {@link #SENTENCE_MERGE_MS} 内出现过的同一句
     * 才会被并进同一张卡，隔得久了就老老实实新起一张。
     */
    private SentenceCard findSentenceCard(String key) {
        long now = System.currentTimeMillis();
        java.util.Iterator<java.util.Map.Entry<String, SentenceCard>> it = sentenceCards.entrySet().iterator();
        while (it.hasNext()) {
            java.util.Map.Entry<String, SentenceCard> entry = it.next();
            if (now - entry.getValue().at > SENTENCE_MERGE_MS) it.remove();
        }
        return sentenceCards.get(key);
    }

    /** 建一张新卡（头部 + 原文 + 译文容器），并按上限丢掉最老的。 */
    private SentenceCard createSentenceCard(String key, boolean mine, String whoLabel, String source) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(mine ? R.drawable.bg_subtitle_self : R.drawable.bg_card);
        int pad = dp(12);
        card.setPadding(pad, pad, pad, pad);
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardParams.bottomMargin = dp(8);
        card.setLayoutParams(cardParams);

        // 卡片头部：头像 + 姓名 + 说话人标记 + 状态标签
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(android.view.Gravity.CENTER_VERTICAL);

        TextView avatar = new TextView(this);
        avatar.setText(mine ? getString(R.string.room_me_my) : firstChar(whoLabel));
        avatar.setGravity(android.view.Gravity.CENTER);
        avatar.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
        avatar.setTextColor(getColor(R.color.brand));
        avatar.setBackgroundResource(R.drawable.bg_avatar);
        int dot = dp(24);
        head.addView(avatar, new LinearLayout.LayoutParams(dot, dot));

        TextView name = new TextView(this);
        name.setText(mine ? getString(R.string.room_me_my) : whoLabel);
        name.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
        name.setTextColor(getColor(R.color.ink_soft));
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nameParams.leftMargin = dp(8);
        head.addView(name, nameParams);

        TextView langTag = new TextView(this);
        langTag.setText(mine ? getString(R.string.room_i_said) : getString(R.string.room_other));
        langTag.setBackgroundResource(R.drawable.bg_chip);
        langTag.setTextColor(getColor(R.color.ink_faint));
        langTag.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10);
        langTag.setPadding(dp(6), dp(2), dp(6), dp(2));
        LinearLayout.LayoutParams langParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        langParams.leftMargin = dp(8);
        head.addView(langTag, langParams);

        View spacer = new View(this);
        head.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1f));

        final TextView state = new TextView(this);
        state.setText(getString(R.string.st_recognizing));
        state.setTextColor(getColor(R.color.accent));
        state.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10);
        head.addView(state, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        card.addView(head);

        // 原文（小字、次要色）——受"原文显示"开关控制
        final TextView sourceLine = new TextView(this);
        sourceLine.setText(source);
        sourceLine.setTextColor(getColor(R.color.ink_soft));
        sourceLine.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
        sourceLine.setTag(SOURCE_TAG);
        sourceLine.setVisibility(!showSource || source.isEmpty() ? View.GONE : View.VISIBLE);
        LinearLayout.LayoutParams sourceParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        sourceParams.topMargin = dp(6);
        card.addView(sourceLine, sourceParams);

        // 译文容器：一句话可能有几种译文，一种一行（5.121）
        LinearLayout translations = new LinearLayout(this);
        translations.setOrientation(LinearLayout.VERTICAL);
        card.addView(translations, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        subtitleList.addView(card);

        SentenceCard made = new SentenceCard();
        made.root = card;
        made.source = sourceLine;
        made.translations = translations;
        made.state = state;
        made.key = key;
        sentenceCards.put(key, made);

        // 超过上限就丢最老的那张（连带它的记录，避免表越攒越大）
        while (subtitleList.getChildCount() > MAX_SEGMENTS + 1) {   // +1 是 roomEmpty
            View oldest = subtitleList.getChildAt(1);
            if (oldest == null || oldest == card) break;
            subtitleList.removeViewAt(1);
            java.util.Iterator<java.util.Map.Entry<String, SentenceCard>> it = sentenceCards.entrySet().iterator();
            while (it.hasNext()) {
                if (it.next().getValue().root == oldest) { it.remove(); break; }
            }
        }
        return made;
    }

    /**
     * 一句里有**多种译文**时，每行前面加语种标签（`〔葡〕`/`〔英〕`/`〔中〕`），
     * 一眼能分清哪一行是哪门语言；只有一种译文时不加（标了反而啰嗦）。
     */
    private void refreshTranslationLabels(SentenceCard card) {
        boolean many = card.lines.size() > 1;
        for (java.util.Map.Entry<String, TextView> entry : card.lines.entrySet()) {
            Object raw = entry.getValue().getTag();
            String text = raw == null ? "" : raw.toString();
            entry.getValue().setText(many && !entry.getKey().isEmpty()
                    ? getString(R.string.room_translation_line, langLabelOf(entry.getKey()), text)
                    : text);
        }
    }

    /** 这一门语言是不是"我的主语言"（TTS 只念它，不把两种译文各念一遍）。 */
    private boolean isPrimaryLang(String langKey) {
        if (langKey.isEmpty()) return true;
        return hearLang != null && !hearLang.isEmpty() && langKey.equals(hearLang);
    }


    /**
     * 系统事件行（原型：以**弱化的居中文字**出现在字幕流里）。
     *
     * <p>它与字幕卡片的区别是刻意的：事件不是"谁说了什么"，所以不带头像、不加边框、
     * 用次要色居中 —— 扫读字幕时它退到背景里，需要时又能看到。
     */
    private void addSystemEvent(String text) {
        if (text == null || text.isEmpty()) return;
        if (emptyView.getVisibility() == View.VISIBLE) emptyView.setVisibility(View.GONE);
        TextView event = new TextView(this);
        event.setText("— " + text + " —");
        event.setGravity(android.view.Gravity.CENTER);
        event.setTextColor(getColor(R.color.ink_faint));
        event.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11);
        event.setPadding(0, dp(6), 0, dp(6));
        subtitleList.addView(event);
        scrollToBottom();
    }

    private void scrollToBottom() {
        subtitleScroll.post(() -> subtitleScroll.fullScroll(View.FOCUS_DOWN));
    }

    /**
     * 「谁在说话」的**数据**来源（4.95）。
     *
     * <p>以前这里是"从 speakerBar 的文字里反向解析"：没人在麦上时那行是「麦克风空闲」，
     * 解析结果就成了一个叫「麦克风空闲」的发言人（用户看到的就是这个）。
     * 现在直接读 {@link #holderName}（由发言权状态写入），并且**只返回名字或空串**，
     * 状态文字一律不进这一层 —— 空串由调用方决定怎么显示。
     */
    private String speakerBarName() {
        return holderName == null ? "" : holderName;
    }

    private static String firstChar(String text) {
        return text == null || text.isEmpty() ? "?" : text.substring(0, 1);
    }

    /** dip → px（布局里能用 @dimen，代码里这两处间距就地换算，别到处塞 token）。 */
    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    /**
     * M3：把「原文显示」的状态同步到**已画出来的卡片**（开关本身由 Switch 负责）。
     *
     * <p>4.55 起底部是一个真正的 Switch（原型：原文后面跟一个可点开关），
     * 所以这个函数不再"翻转"，只按 `showSource` 同步外观与可见性。
     */
    private void syncSourceVisibility() {
        if (sourceSwitch != null) {
            syncingSwitch = true;
            sourceSwitch.setChecked(showSource);
            syncingSwitch = false;
        }
        for (int i = 0; i < subtitleList.getChildCount(); i++) {
            View child = subtitleList.getChildAt(i);
            if (!(child instanceof LinearLayout)) continue;
            LinearLayout card = (LinearLayout) child;
            for (int j = 0; j < card.getChildCount(); j++) {
                View view = card.getChildAt(j);
                // 按**标记**认原文那一行（5.121：卡片里现在是"头 + 原文 + 译文容器"，
                // 容器里还有每种译文一行，用下标猜位置迟早出错）
                if (!(view instanceof TextView) || !SOURCE_TAG.equals(view.getTag())) continue;
                TextView line = (TextView) view;
                boolean hasText = line.getText() != null && line.getText().length() > 0;
                line.setVisibility(showSource && hasText ? View.VISIBLE : View.GONE);
            }
        }
    }

    @Override
    public void onError(String message) {
        ui.post(() -> statusLine.setText(getString(R.string.st_conn_error, message)));
    }
}