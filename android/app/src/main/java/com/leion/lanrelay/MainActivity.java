package com.leion.lanrelay;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 同传眼镜（安卓端）。
 *
 * 结构：一个 Activity + 三个一级页面（同传 / 记录 / 设置）+ 若干覆盖层
 * （连接电脑、语言选择、音频输出、全屏字幕、眼镜预览、会话总结、记录详情）。
 *
 * 三条设计约束，改这个文件前先读：
 *
 *  1. **零第三方依赖**（连 AndroidX 都不引）。所以没有 Material 组件、没有 Fragment、
 *     没有 ViewPager —— 页面切换是"inflate 进容器 + 切可见性"，底部弹层是覆盖层。
 *     "Material 3 风格"是靠 colors.xml / drawable / 间距字号落地的。
 *
 *  2. **界面不许说谎**。规范里反复强调这一点，本文件里体现在：
 *     · 音量条由**真实**麦克风电平驱动（MicUploader.onLevel），没讲话时如实说"等待讲话"
 *     · 没有朗读功能就不给"播放译文"做成可点；没有二维码就不放扫码入口
 *     · 连上了电脑 ≠ 服务可用：后者要看 /status 里 busSeen / inboxLines 的真实证据
 *     · 断连就停止采集，并明说"中断期间未录制音频"（这个版本没有音频缓存）
 *
 *  3. **手机只是终端**。切句、识别、翻译都在电脑上；这里只做三件事：
 *     收音上传、显示字幕、把状态如实呈现出来。
 */
public class MainActivity extends Activity implements LanClient.Listener, MicUploader.Listener {

    // ── 常量 ────────────────────────────────────────────────────────────────

    private static final int REQUEST_RECORD_AUDIO = 1001;
    /**
     * 眼镜 SDK 需要的运行时权限（CAMERA + 媒体访问）。
     * 与录音那条分开是因为它们是**两件事**：录音是同传功能，这条只是"让眼镜能连"。
     */
    private static final int REQUEST_GLASSES_PERMISSIONS = 1002;
    private static final String PREFS = "leion";
    private static final String KEY_HOST = "host";
    private static final String KEY_SECRET = "secret";
    private static final String KEY_RECENT = "recent";
    private static final String KEY_LANG = "lang";              // 源语言
    private static final String KEY_THEME = "theme";            // system / light / dark
    private static final String KEY_SCALE = "fontScale";
    private static final String KEY_BILINGUAL = "bilingual";
    /** 开发者模式：关掉时设置页不显示「实验」「诊断」。 */
    private static final String KEY_DEVELOPER = "developer";
    /**
     * 热词表的用户名：电脑按它区分"这是谁的表"（docs/15 §8.3）。
     * 留空 → 电脑侧回落到 `default`；之所以默认空而不是设备名，
     * 是因为"设备名"在日志里读起来是 `Leion Pro`，排查时分不出是谁。
     */
    private static final String KEY_USER = "termsUser";
    /**
     * 账户 token（登录/注册后拿到）。**热词表的身份就是它** ——
     * 原来存的是"用户名字符串"并由客户端自报，那等于没有权限。
     */
    private static final String KEY_TOKEN = "accountToken";
    /** 热词表编辑框的原始文本（一行一条）—— 存下来免得每次进来都从零开始填。 */
    private static final String KEY_TERMS_DRAFT = "termsDraft";

    /**
     * 判定"这一小段里有人在讲话"的**界面**门槛。
     *
     * 注意：这**只**用来决定界面上写"正在收音"还是"正在收音，等待讲话"。
     * 真正的语音判定在电脑上（自适应门槛 = 噪声底 × 4，见 docs/06）——
     * 手机这边不重复实现一套，否则两边标准不一致，用户看到的提示会和实际切句对不上。
     * 0.012 ≈ -38 dBFS：比正常说话（0.03~0.1）低不少，比安静房间的底噪（<0.003）高。
     */
    private static final float UI_SPEECH_RMS = 0.012f;
    /** 讲话结束后保持"正在收音"多久（毫秒），避免词与词之间提示来回跳。 */
    private static final long SPEECH_HOLD_MS = 900;

    private static final int METER_BARS = 18;

    // ── 状态 ────────────────────────────────────────────────────────────────

    private final Handler main = new Handler(Looper.getMainLooper());

    private SharedPreferences prefs;
    private LanClient client;
    private AudioSource uploader;
    private Records records;

    /** 已连接且握手成功的设备名；未连接为 null。 */
    private String deviceName = null;
    /** /status 的真实证据：大脑是否产出过字幕、识别侧是否写过收件箱。 */
    private boolean busSeen = false;
    private int inboxLines = 0;
    private int framesSeen = 0;
    private String lastError = "";
    /**
     * 电脑侧支持的能力（`/status` 的 `features`）。
     *
     * <p>用它来判断"对面是不是旧版进程"—— 旧版没有 `auth`，注册只会得到 404。
     * 与其让用户对着 not-found 猜，不如我们直接说"重启 start-all"。
     */
    private java.util.Set<String> relayFeatures = new java.util.HashSet<>();

    /** 热词表（电脑侧 /status 报的）：上传过几次、最近几条、最近是谁。 */
    private int termsSaved = 0;
    private int termsSavedEntries = 0;
    private String termsSavedUser = "";

    /** 会话（规范第 5、9 节）。null = 当前没有会话。 */
    private Session session = null;
    private boolean micGrantedPending = false;

    private String sourceLang = "pt-BR";
    private float fontScale = 1f;
    private boolean bilingual = true;
    private String themeMode = "system";

    /** 最近一帧的完整信息（诊断用；原本还给"模拟预览"面板用，那块已经删了）。 */
    private String lastFrameText = "";
    private String lastFrameSource = "";
    private String lastFrameSpeaker = "them";
    /** 最近一帧是不是"还在生成中"的流式增量（用来决定要不要在末尾加省略号）。 */
    private boolean lastFramePartial = false;

    /** 眼镜投屏（真眼镜，不是界面里那个"眼镜预览"面板）。见 GlassesSdk 与 docs/09。 */
    private GlassesSdk glasses = null;
    private GlassesSubtitleView glassesView = null;
    private String glassesStatus = "未初始化";
    private boolean glassesConnected = false;

    private long lastSpeechAt = 0;

    // ── 视图 ────────────────────────────────────────────────────────────────

    private FrameLayout pageHost;
    private FrameLayout overlayHost;
    private LinearLayout bottomNav;
    private View navLive;
    private View navRecords;
    private View navTerms;
    private View navSettings;

    // 同传页
    private View idleBlock;
    private View sessionBlock;
    private View connectCard;
    private View connectDot;
    private TextView connectTitle;
    private TextView connectSubtitle;
    private TextView connectAction;
    private TextView idleSourceLang;
    private TextView idleTargetLang;
    private TextView startReason;
    private View startButton;
    private TextView startLabel;
    private TextView sessionTitle;
    private TextView sessionTimer;
    private TextView sessionConn;
    private TextView liveDirection;
    private TextView liveLangHint;
    private LinearLayout meter;
    private TextView micState;
    private View pauseButton;
    private ImageView pauseIcon;
    private TextView pauseLabel;
    private TextView sessionNote;
    private SubtitleList subtitles;

    // 设置页
    private TextView settingsServerState;
    private TextView settingsOutputState;
    /** 校对开关：以**电脑侧**状态为准（`/status` 的 `settings.proofread`）。 */
    private Switch settingsProofreadSwitch;
    private TextView settingsProofreadState;
    /**
     * 电脑上校对现在开着没有。
     *
     * <p>缺省按 **true** 算：插件的默认值就是开启（`proofread: 'idle'`），
     * "读不到"不等于"关着"。早先写成 `Boolean null` 再当 false 用 ——
     * 电脑上还没有 settings.json 时开关永远显示关，点一下也立刻弹回去（用户报的现象）。
     */
    private boolean proofreadOnServer = true;
    /** 电脑侧设置接口能不能用（旧版接收进程没有 /settings，会 404）。 */
    private boolean proofreadApiAvailable = true;
    private TextView diagnosticsText;
    private TextView fontValue;
    private TextView themeSystemView;
    private TextView themeLightView;
    private TextView themeDarkView;
    private TextView modeBilingualView;
    private TextView modeTargetOnlyView;
    private Switch developerSwitch;
    private View developerRow;
    private View experimentsHeader;
    private View experimentsCard;
    private View diagnosticsHeader;
    private View diagnosticsCard;
    /** 开发者模式：关着时「实验」「诊断」两段整体隐藏。 */
    private boolean developerMode = false;

    // 记录页
    private LinearLayout recordsList;
    private View recordsEmpty;

    private final List<View> meterBars = new ArrayList<>();

    // ── 生命周期 ────────────────────────────────────────────────────────────

    /**
     * 深色模式的实现方式：把配置**覆写**成"夜间/非夜间"，而不是准备两套布局。
     *
     * 这样 values-night/colors.xml 会自动生效，所有 @color/... 一起变 ——
     * 布局与 drawable 一行都不用改，也就不会漏掉某个控件。
     * 必须在 attachBaseContext 里做：setContentView 之后再改配置会抛异常。
     */
    @Override
    protected void attachBaseContext(Context base) {
        prefs = base.getSharedPreferences(PREFS, MODE_PRIVATE);
        themeMode = prefs.getString(KEY_THEME, "system");
        if ("system".equals(themeMode)) {
            super.attachBaseContext(base);
            return;
        }
        Configuration override = new Configuration(base.getResources().getConfiguration());
        int night = "dark".equals(themeMode)
                ? Configuration.UI_MODE_NIGHT_YES
                : Configuration.UI_MODE_NIGHT_NO;
        override.uiMode = (override.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | night;
        super.attachBaseContext(base.createConfigurationContext(override));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme("dark".equals(themeMode) ? R.style.AppTheme_Dark : R.style.AppTheme);
        super.onCreate(savedInstanceState);
        // 装在最早：后面任何一步崩了都要留下堆栈。
        // 真机上 adb 不一定能用，而"闪退"没有堆栈就只能靠猜。
        CrashLog.install(getApplicationContext());
        setContentView(R.layout.activity_main);

        records = new Records(this);
        sourceLang = prefs.getString(KEY_LANG, "pt-BR");
        fontScale = prefs.getFloat(KEY_SCALE, 1f);
        bilingual = prefs.getBoolean(KEY_BILINGUAL, true);
        developerMode = prefs.getBoolean(KEY_DEVELOPER, false);

        pageHost = findViewById(R.id.pageHost);
        overlayHost = findViewById(R.id.overlayHost);
        bottomNav = findViewById(R.id.bottomNav);
        navLive = findViewById(R.id.navLive);
        navRecords = findViewById(R.id.navRecords);
        navTerms = findViewById(R.id.navTerms);
        navSettings = findViewById(R.id.navSettings);

        buildLivePage();
        buildSettingsPage();
        buildRecordsPage();
        buildTermsPage();

        navLive.setOnClickListener(v -> showPage(Page.LIVE));
        navRecords.setOnClickListener(v -> showPage(Page.RECORDS));
        navTerms.setOnClickListener(v -> showPage(Page.TERMS));
        navSettings.setOnClickListener(v -> showPage(Page.SETTINGS));

        showPage(Page.LIVE);
        applyLanguageLabels();
        renderConnectionCard();
        refreshDiagnostics();
        setupGlasses();
    }

    /**
     * 眼镜：**先要权限、再初始化 SDK**。
     *
     * <p>这一步照官方样例的顺序来（{@code GlassMainViewModel.onHostReady} 的注释：
     * 「权限与悬浮窗就绪后，由界面调用以初始化 Glass SDK（仅调用一次）」）。
     * 官方还有一道 `GlassPermissionFlow` 权限门禁，要求
     * CAMERA + RECORD_AUDIO + READ_MEDIA_* 全给、并且能画悬浮窗，才往下走。
     *
     * <p>⚠️ 顺序不能省。之前我在 onCreate 里**直接 init SDK**，而且把 CAMERA /
     * 媒体 / 悬浮窗权限都删了 —— 真机上的表现是**插上眼镜完全不弹「允许访问眼镜吗」**，
     * 而官方 App 会弹。原因就是 SDK 的前提（权限 + 悬浮窗）没满足，
     * 它根本走不到请求 USB 授权那一步。见 docs/09 第 5 节。
     *
     * <p>这里**不做成官方那种"不给权限就不让用"的门禁**：手机端的同传功能
     * （录音上传、字幕显示）和眼镜是两件事，不该因为眼镜没授权就把整个 App 拦住。
     * 所以只请求眼镜需要的那几条，拿到了才 init；没拿到就在状态行里说清楚。
     */
    private void setupGlasses() {
        // ⚠️ 顺序约定：**先把对象建出来，再配置它**。
        //    这一版我违反过一次：把 glasses.setCameraPreviewBackground(...) 写在了
        //    `glasses = new GlassesSdk(...)` 之前，编译能过、一打开 App 就空指针。
        //    编译通过不等于能跑 —— 凡是本方法里的 `glasses.xxx`，
        //    都必须出现在下面那行赋值**之后**。
        glassesView = new GlassesSubtitleView(this);
        // 先把上次调好的显示参数用上 —— 否则每次重启都回到缺省，
        // 用户会以为"又变小了"，然后重调一遍
        glassesView.setTuning(
                glassesFontZh(), glassesFontPt(),
                glassesMarginRight(), glassesMarginLeft());
        glassesView.setPageDelayMs(glassesPageDelayMs());
        // 翻页打个诊断行：长句到底有没有翻页、翻到第几页，日志里要看得见。
        // （"翻页没发生"和"翻页了但没上屏"是两回事，日志必须能分开。）
        glassesView.setPageListener((page, pageCount, lines, pageText) -> {
            if (client == null) return;
            boolean last = page == pageCount - 1;
            // 把每一页的**首尾几个字**都打出来。
            // 为什么要这个：翻页有没有发生、末页有没有把结尾那几个词带上，
            // 光看"第几/共几页"是答不了的 —— 而那正是要验证的东西。
            // （未页的结尾就是整句的结尾，丢了会一眼看出来。）
            String head = pageText.length() > 14 ? pageText.substring(0, 14) + "…" : pageText;
            String tail = pageText.length() > 14
                    ? "…" + pageText.substring(pageText.length() - 14) : "";
            client.sendDiag("投屏：翻页 " + (page + 1) + "/" + pageCount
                    + (last ? "（末页）" : "") + " 每页≤" + lines + "行  ["
                    + head + tail + "]");
        });
        glasses = new GlassesSdk(this, new GlassesSdk.Listener() {
            @Override
            public void onGlassesStatus(String status, boolean connected) {
                // ⚠️ 顺序：先判断"这次回调是不是一次真正的**新**连接"，再更新字段。
                //    只有 connected 从 false 变 true 那一次才算新连接。
                boolean justConnected = connected && !glassesConnected;
                glassesStatus = status;
                glassesConnected = connected;
                if (glassesView != null) {
                    glassesView.setStatus(
                            connected ? "● " + status : "○ " + status,
                            glasses != null && glasses.isCasting() ? "投屏中" : "");
                }
                // 眼镜一连上就自动试投屏 —— 但**只在刚连上那一次**。
                //
                // 这里原来写的是 `if (connected && isConnected() && !isCasting())`，是个死循环：
                // 投屏失败时 reportWithStep 也带着 connected=true 回调 listener，
                // listener 又看到"没在投屏"就再投一次 —— 失败 → 回调 → 再投，无限循环，
                // 主线程被自己的 post 塞满。真机上"点了开始投屏没反应"就是它。
                if (justConnected && glasses != null && glasses.isConnected() && !glasses.isCasting()) {
                    // 这里**不**设画布尺寸：此刻 DeviceInfo 还没读回来（会拿到 0×0）。
                    // 尺寸由下面的 onGlassesBeforeCast 负责 —— 那才是正确的时机。
                    glasses.requestCast(glassesView.getView());
                }
                // 投屏一旦成功，先给一个**待机画面**。
                // 为什么要这个：不开同传时眼镜上也得有东西，否则没法判断
                // "投屏到底成没成" —— 黑屏和投屏失败在眼镜上看起来一模一样。
                if (glasses != null && glasses.isCasting()) {
                    glassesView.showIdle(true);
                    glassesView.setIdleText("等待输入", idleNoteText());
                }
                renderGlassesRealStatus();
            }

            /**
             * 投屏即将开始（LCD 服务已就绪）—— **这里才是设画布尺寸的正确时机**。
             *
             * <p>原来是在"设备刚连上"时读分辨率，那时 {@code DeviceInfo} 还没从设备读回来，
             * 拿到的是 0×0。而 0×0 的后果很隐蔽：画布尺寸未知 → 退回去按**手机 density**
             * 算字号（46sp ≈ 126px）→ 一行只放得下 4 个字符 →
             * 真机上表现为字幕被"截断"成 "Qual"。
             */
            @Override
            public void onGlassesBeforeCast(int width, int height) {
                applyGlassesCanvasSize(width, height);
            }
        });

        // **建完之后**才能配置它（见方法开头的顺序约定）。
        // 相机预览背景的偏好在每次投屏前都会重新同步一次，
        // 免得用户切了之后重启 App、或重新投屏时又回到缺省值。
        glasses.setCameraPreviewBackground(glassesCameraBackground());

        requestGlassesPermissions();
    }

    /**
     * 按**眼镜的真实分辨率**定投屏画布大小。
     *
     * <p>必须在 {@code requestCast} 之前调 —— SDK 是在投屏那一刻把 View 采样成画面的。
     *
     * <p>⚠️ 这里曾经按**手机屏幕宽度**算画布（1080×1440）。比例虽然对，但像素尺寸
     * 比眼镜大了一倍多，而 SDK 按设备分辨率分配缓冲、再从这块 View 取像素 ——
     * 真机上报「数据越界」，严重时直接闪退。
     * 现在从 {@code DeviceInfo} 读真实分辨率；读不到就交给 SDK 测量（官方样例写法），
     * **不猜尺寸**。
     */
    private void applyGlassesCanvasSize() {
        if (glasses == null) return;
        int[] size = glasses.queryDisplaySize();
        applyGlassesCanvasSize(size[0], size[1]);
    }

    /**
     * 用给定尺寸定投屏画布。
     *
     * @param width  眼镜分辨率宽；&lt;= 0 表示没读到（此时**不猜**，
     *               让 GlassesSubtitleView 用"SDK 已测量到的尺寸"自愈）
     */
    private void applyGlassesCanvasSize(int width, int height) {
        if (glassesView == null) return;
        glassesView.setDisplaySize(width, height);
        if (width > 0 && height > 0) {
            glassesCanvasNote = "画布 " + width + "×" + height;
        } else {
            glassesCanvasNote = "画布尺寸未知";
            if (glasses != null) {
                String raw = glasses.getRawResolution();
                if (raw.length() > 0) glassesCanvasNote += " 原始:" + raw;
            }
        }
        renderGlassesRealStatus();
    }

    /** 眼镜 SDK 需要的那几条运行时权限（照官方 glassRuntimePermissions() 的分档）。 */
    private String[] glassesPermissions() {
        List<String> wanted = new ArrayList<>();
        wanted.add(Manifest.permission.CAMERA);
        wanted.add(Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 34) {
            wanted.add("android.permission.READ_MEDIA_IMAGES");
            wanted.add("android.permission.READ_MEDIA_VIDEO");
            wanted.add("android.permission.READ_MEDIA_AUDIO");
            wanted.add("android.permission.READ_MEDIA_VISUAL_USER_SELECTED");
        } else if (Build.VERSION.SDK_INT >= 33) {
            wanted.add("android.permission.READ_MEDIA_IMAGES");
            wanted.add("android.permission.READ_MEDIA_VIDEO");
            wanted.add("android.permission.READ_MEDIA_AUDIO");
        }
        return wanted.toArray(new String[0]);
    }

    private void requestGlassesPermissions() {
        List<String> missing = new ArrayList<>();
        for (String permission : glassesPermissions()) {
            // ⚠️ 用 ContextCompat 而不是 Context.checkSelfPermission：
            //    后者是 API 23+ 才有的方法。虽然 minSdk 是 24（够），
            //    但真机上曾出现"看起来该给都给了却什么都没发生"的情况，
            //    而权限检查是整条链的第一步 —— 这一步判错，后面全静默。
            //    ContextCompat 是 AndroidX 的兼容封装，行为确定，不会再踩这个。
            if (ContextCompat.checkSelfPermission(this, permission)
                    != PackageManager.PERMISSION_GRANTED) {
                missing.add(permission);
            }
        }
        glassesPermMissing = missing.size();
        if (!missing.isEmpty()) {
            glassesStatus = "等待权限：还差 " + missing.size() + " 项";
            renderGlassesRealStatus();
            requestPermissions(missing.toArray(new String[0]), REQUEST_GLASSES_PERMISSIONS);
            return;
        }
        afterRuntimePermissions();
    }

    /** 运行时权限这一关过了 → 再看悬浮窗（官方把它并列为前置条件）。 */
    private void afterRuntimePermissions() {
        if (Build.VERSION.SDK_INT >= 23 && Settings.canDrawOverlays(this) == false) {
            glassesStatus = "需要悬浮窗权限";
            renderGlassesRealStatus();
            new AlertDialog.Builder(this)
                    .setTitle("眼镜需要悬浮窗权限")
                    .setMessage("眼镜 SDK 要求「显示在其他应用上层」才肯连接。\n\n"
                            + "点「去开启」后在列表里找到本应用并打开开关，回来就会自动连接。\n"
                            + "（这条与上架审核无关，是正常权限。）")
                    .setPositiveButton("去开启", (dialog, which) -> {
                        try {
                            startActivity(new Intent(
                                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                    Uri.parse("package:" + getPackageName())));
                        } catch (Exception error) {
                            // 部分 ROM 不支持按包名直达，退回应用详情页
                            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                    Uri.parse("package:" + getPackageName())));
                        }
                    })
                    .setNegativeButton("稍后", (dialog, which) -> {
                        glassesStatus = "缺少悬浮窗权限";
                        renderGlassesRealStatus();
                    })
                    .show();
            return;
        }
        startGlassesSdk();
    }

    /** 权限与悬浮窗都就绪 —— 这才初始化 SDK（官方也是在这里才 init）。 */
    private void startGlassesSdk() {
        if (glasses == null) return;
        glassesStatus = "正在初始化…";
        renderGlassesRealStatus();
        glasses.init();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 从"悬浮窗设置页"回来时补一次 —— 用户去开了权限，这里要接着往下走
        if (glasses != null && glassesSdkStarted() == false) {
            requestGlassesPermissions();
        }
    }

    /** SDK 已经开始初始化了吗（init 里没法直接问） */
    private boolean glassesSdkStarted() {
        return glasses != null && glasses.isInitialized();
    }

    @Override
    protected void onStop() {
        // 能走到这里 = 刚才那些"危险动作"（改被投屏的 View 尺寸等）没有把进程搞死。
        // 所以把面包屑清掉，免得下次启动误报"上次崩在调字号"。
        CrashLog.endAction(this);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        // ⚠️ 眼镜 SDK 必须在进程退出前销毁，否则可能残留脏 fd 导致**眼镜整机重启**。
        //    顺序也是硬性的：destroy() 内部先 stopAllServices 再 destroy。
        if (glasses != null) {
            glasses.destroy();
            glasses = null;
        }
        super.onDestroy();
        // 录音线程先停：它持有麦克风与 AudioRecord，退出前不释放会留个坏状态
        if (uploader != null) {
            uploader.stop();
            uploader = null;
        }
        if (client != null) {
            client.stop();
            client = null;
        }
    }

    @Override
    public void onBackPressed() {
        // 覆盖层优先：先关掉最上面那一层，而不是直接退出应用
        if (overlayHost.getVisibility() == View.VISIBLE) {
            closeOverlay();
            return;
        }
        if (session != null && session.active) {
            endSession();
            return;
        }
        if (currentPage != Page.LIVE) {
            showPage(Page.LIVE);
            return;
        }
        super.onBackPressed();
    }

    // ── 页面切换 ────────────────────────────────────────────────────────────

    private enum Page { LIVE, RECORDS, TERMS, SETTINGS }

    private Page currentPage = Page.LIVE;
    private View livePage;
    private View settingsPage;
    private View recordsPage;
    private View termsPage;

    private void showPage(Page page) {
        currentPage = page;
        // ⚠️ 每个页面都先判空。这不是防御性洁癖：4.4 崩过一次 ——
        //    buildTermsPage() 忘了被调用，而 showPage 在这里直接 setVisibility，
        //    于是**打开 App 就闪退**（NullPointerException），报错点在从没见过的 589 行。
        //    一个"忘了建页面"的疏漏不该让整个 App 起不来。
        showOnly(livePage, page == Page.LIVE);
        showOnly(recordsPage, page == Page.RECORDS);
        showOnly(termsPage, page == Page.TERMS);
        showOnly(settingsPage, page == Page.SETTINGS);
        if (page == Page.RECORDS) renderRecords();
        if (page == Page.TERMS) onTermsPageShown();
        if (page == Page.SETTINGS) refreshSettingsPage();
        paintNav();
    }

    /** 页面没被创建出来时跳过（并在日志里留一句，便于发现"忘了 build"）。 */
    private void showOnly(View view, boolean visible) {
        if (view == null) {
            if (visible) consoleNoteMissingPage(currentPage);
            return;
        }
        view.setVisibility(visible ? View.VISIBLE : View.GONE);
    }

    private void consoleNoteMissingPage(Page page) {
        System.out.println("[leion] 页面 " + page + " 还没被创建出来（忘了调 buildXxxPage？）");
    }

    /** 导航项选中态：图标与文字变主色，底色是淡主色胶囊。 */
    private void paintNav() {
        paintNavItem(navLive, currentPage == Page.LIVE);
        paintNavItem(navRecords, currentPage == Page.RECORDS);
        paintNavItem(navTerms, currentPage == Page.TERMS);
        paintNavItem(navSettings, currentPage == Page.SETTINGS);
    }

    private void paintNavItem(View item, boolean selected) {
        ImageView icon = item.findViewById(item == navLive ? R.id.navLiveIcon
                : item == navRecords ? R.id.navRecordsIcon
                    : item == navTerms ? R.id.navTermsIcon : R.id.navSettingsIcon);
        TextView label = item.findViewById(item == navLive ? R.id.navLiveLabel
                : item == navRecords ? R.id.navRecordsLabel
                    : item == navTerms ? R.id.navTermsLabel : R.id.navSettingsLabel);
        int color = getColor(selected ? R.color.brand : R.color.ink_faint);
        icon.setColorFilter(color);
        label.setTextColor(color);
        item.setBackgroundTintList(ColorStateList.valueOf(
                getColor(selected ? R.color.brand_soft : android.R.color.transparent)));
    }

    /** 正在同传时隐藏底部导航，把底部空间让给音频控制（规范第 3 节）。 */
    private void setNavVisible(boolean visible) {
        bottomNav.setVisibility(visible ? View.VISIBLE : View.GONE);
    }

    // ── 同传页 ──────────────────────────────────────────────────────────────

    private void buildLivePage() {
        livePage = LayoutInflater.from(this).inflate(R.layout.page_live, pageHost, false);
        pageHost.addView(livePage);

        idleBlock = livePage.findViewById(R.id.idleBlock);
        sessionBlock = livePage.findViewById(R.id.sessionBlock);
        connectCard = livePage.findViewById(R.id.connectCard);
        connectDot = livePage.findViewById(R.id.connectDot);
        connectTitle = livePage.findViewById(R.id.connectTitle);
        connectSubtitle = livePage.findViewById(R.id.connectSubtitle);
        connectAction = livePage.findViewById(R.id.connectAction);
        idleSourceLang = livePage.findViewById(R.id.idleSourceLang);
        idleTargetLang = livePage.findViewById(R.id.idleTargetLang);
        startReason = livePage.findViewById(R.id.startReason);
        startButton = livePage.findViewById(R.id.startButton);
        startLabel = livePage.findViewById(R.id.startLabel);
        sessionTitle = livePage.findViewById(R.id.sessionTitle);
        sessionTimer = livePage.findViewById(R.id.sessionTimer);
        sessionConn = livePage.findViewById(R.id.sessionConn);
        liveDirection = livePage.findViewById(R.id.liveDirection);
        liveLangHint = livePage.findViewById(R.id.liveLangHint);
        meter = livePage.findViewById(R.id.meter);
        micState = livePage.findViewById(R.id.micState);
        pauseButton = livePage.findViewById(R.id.pauseButton);
        pauseIcon = livePage.findViewById(R.id.pauseIcon);
        pauseLabel = livePage.findViewById(R.id.pauseLabel);
        sessionNote = livePage.findViewById(R.id.sessionNote);

        subtitles = new SubtitleList(LayoutInflater.from(this),
                livePage.findViewById(R.id.subtitleScroll),
                livePage.findViewById(R.id.subtitleList),
                livePage.findViewById(R.id.backToLatest));
        subtitles.setBilingual(bilingual);
        subtitles.setScale(fontScale);

        livePage.findViewById(R.id.idleSettingsButton).setOnClickListener(v -> showPage(Page.SETTINGS));
        connectCard.setOnClickListener(v -> openConnectPage());
        // 语言方向条整条都能点：点哪一侧就换哪一侧（和常见翻译应用一致）
        idleSourceLang.setOnClickListener(v -> openLanguageSheet(true));
        idleTargetLang.setOnClickListener(v -> openLanguageSheet(false));
        livePage.findViewById(R.id.idleSwap).setOnClickListener(v -> swapLanguages());
        livePage.findViewById(R.id.toolMode).setOnClickListener(v -> toggleBilingual());
        livePage.findViewById(R.id.toolFontDown).setOnClickListener(v -> stepFontScale(-1));
        livePage.findViewById(R.id.toolFontUp).setOnClickListener(v -> stepFontScale(1));
        livePage.findViewById(R.id.toolFullscreen).setOnClickListener(v -> openFullscreen());
        livePage.findViewById(R.id.outputButton).setOnClickListener(v -> openOutputSheet());
        pauseButton.setOnClickListener(v -> togglePause());
        livePage.findViewById(R.id.endButton).setOnClickListener(v -> endSession());
        startButton.setOnClickListener(v -> onStartClicked());

        buildMeter();
    }

    private void buildMeter() {
        meter.removeAllViews();
        meterBars.clear();
        for (int index = 0; index < METER_BARS; index++) {
            View bar = new View(this);
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.MATCH_PARENT, 1f);
            params.setMarginEnd(index == METER_BARS - 1 ? 0 : dp(2));
            bar.setLayoutParams(params);
            bar.setBackgroundResource(R.drawable.meter_bar);
            meter.addView(bar);
            meterBars.add(bar);
        }
        updateMeter(0f, 0f);
    }

    /**
     * 按真实电平点亮音量条。
     * 用**峰值**而不是 RMS：RMS 在正常说话时只有峰值的 1/3 左右，
     * 直接用会让条子永远只亮两三格。开方是为了压一下动态范围（人耳也是对数感）。
     */
    private void updateMeter(float rms, float peak) {
        float level = (float) Math.sqrt(Math.max(0f, Math.min(1f, peak)));
        int lit = Math.round(level * meterBars.size());
        for (int index = 0; index < meterBars.size(); index++) {
            boolean on = index < lit;
            meterBars.get(index).setBackgroundTintList(ColorStateList.valueOf(
                    getColor(on ? R.color.meter_on : R.color.meter_track)));
        }
    }

    // ── 连接 ────────────────────────────────────────────────────────────────

    private String host() {
        return prefs.getString(KEY_HOST, "");
    }

    private String secret() {
        return prefs.getString(KEY_SECRET, "");
    }

    private boolean online() {
        return client != null && client.isRunning() && deviceName != null;
    }

    /**
     * 连上电脑 ≠ 服务可用。
     * 这里用的都是 /status 里的**真实证据**：大脑有没有产出过字幕、收件箱里有没有行。
     * 两个都没有时如实说"模型准备中…"—— 因为我们确实还不知道它能不能干活。
     */
    private boolean serviceWorking() {
        return online() && (busSeen || inboxLines > 0 || framesSeen > 0);
    }

    private void renderConnectionCard() {
        int dot;
        if (!online()) {
            connectTitle.setText(R.string.not_connected);
            connectSubtitle.setText(R.string.not_connected_hint);
            connectAction.setText(R.string.connect_computer);
            dot = R.color.idle;
        } else if (serviceWorking()) {
            connectTitle.setText(getString(R.string.connect_ok, deviceName));
            connectSubtitle.setText(R.string.service_ready);
            connectAction.setText(R.string.change_connection);
            dot = R.color.ok;
        } else {
            connectTitle.setText(getString(R.string.connect_ok, deviceName));
            connectSubtitle.setText(R.string.service_loading);
            connectAction.setText(R.string.change_connection);
            dot = R.color.warn;
        }
        connectDot.setBackgroundTintList(ColorStateList.valueOf(getColor(dot)));

        boolean canStart = online();
        startButton.setAlpha(canStart ? 1f : 0.45f);
        startButton.setClickable(true);       // 仍然可点：点了给出原因，而不是毫无反应
        startReason.setText(canStart ? "" : getString(R.string.reason_need_connection));
        startReason.setVisibility(canStart ? View.GONE : View.VISIBLE);

        if (settingsServerState != null) {
            settingsServerState.setText(online()
                    ? getString(R.string.connect_ok, deviceName)
                    : getString(R.string.not_connected));
        }
    }

    private void connect(String address, String pairing) {
        if (client != null) {
            client.stop();
            client = null;
        }
        deviceName = null;
        busSeen = false;
        inboxLines = 0;
        framesSeen = 0;
        prefs.edit().putString(KEY_HOST, address).putString(KEY_SECRET, pairing).apply();

        client = new LanClient(address, pairing, this);
        // 身份 = token（登录得到的）。握手时带上，电脑据此记下"这一场读哪张热词表"。
        client.setToken(accountToken());
        client.start();
        renderConnectionCard();
    }

    /** 握手之后去问 /status：这一步才是"服务可用吗"的依据。 */
    private void probeService(final Runnable whenDone) {
        final LanClient current = client;
        if (current == null) return;
        new Thread(() -> {
            try {
                JSONObject status = current.status();
                main.post(() -> {
                    busSeen = status.optBoolean("busSeen", false);
                    inboxLines = status.optInt("inboxLines", 0);
                    framesSeen = status.optInt("frames", 0);
                    // 热词表：电脑侧刚上传过几张、最近是谁 —— 设置页那一行的小字用它
                    org.json.JSONArray features = status.optJSONArray("features");
                    java.util.Set<String> next = new java.util.HashSet<>();
                    if (features != null) {
                        for (int index = 0; index < features.length(); index += 1) {
                            next.add(String.valueOf(features.opt(index)));
                        }
                    }
                    relayFeatures = next;
                    termsSaved = status.optInt("termsSaves", 0);
                    termsSavedEntries = status.optInt("termsEntries", 0);
                    termsSavedUser = status.optString("termsUser", "");
                    // 校对开关：以电脑上的实际状态为准（手机不自己猜）
                    org.json.JSONObject settings = status.optJSONObject("settings");
                    if (settings != null && settings.has("proofread")) {
                        proofreadOnServer = settings.optBoolean("proofread", true);
                        proofreadApiAvailable = true;
                        renderProofread(proofreadOnServer, false);
                    }
                    renderConnectionCard();
                    refreshDiagnostics();
                    if (whenDone != null) whenDone.run();
                });
            } catch (Exception error) {
                main.post(() -> {
                    if (whenDone != null) whenDone.run();
                });
            }
        }, "lan-probe").start();
    }

    @Override
    public void onStatus(final String message) {
        main.post(() -> {
            lastError = "";
            // 状态行只在没有会话时用来提示；进行中用它会被字幕淹没
            if (session == null || !session.active) showNote(message);
        });
    }

    @Override
    public void onHello(final String device, final int serverCols, final int serverLineBudget) {
        main.post(() -> {
            deviceName = device;
            // ⚠️ 连接页那一行必须在这里更新。原来只在**失败**时更新，
            //    于是连上以后它永远停在"正在连接电脑…"（用户报的遗留问题）。
            if (overlayConnectProgress != null) {
                showConnectProgress(getString(R.string.connect_ok, device), R.color.ok);
            }
            // ⚠️ serverCols / serverLineBudget（电脑那边的 40 列 × 3 行预算）这里**故意不用**。
            //    它们只对电脑端"把译文排成 40×3"有意义；手机这块早就改成按真实分辨率投屏、
            //    由安卓真实排版决定行数了。原来它们被用来渲染"模拟预览"面板 ——
            //    那块面板已删（它按列数模型画，而真实投屏不是那个模型，会误导校准）。
            renderConnectionCard();
            // 连上电脑了 → 眼镜上的待机提示也要跟着变（"已连接电脑 · 点开始同传"）
            refreshGlassesIdle();
            // 服务是否真的在工作，进一步去问 /status（握手成功只说明继电器在）
            probeService(null);
            rememberRecent(host());
        });
    }

    @Override
    public void onFrame(final String speaker, final String lang, final String[] lines,
                        final String text, final String source, final String sourceLang,
                        final boolean partial, final String[] termsMissing) {
        main.post(() -> {
            framesSeen += 1;
            busSeen = true;
            lastFrameText = text;
            lastFrameSource = source;
            lastFrameSpeaker = speaker;
            lastFramePartial = partial;
            // 热词观测（docs/15 §17）：电脑侧发现"这句提到了表内名字、但译文里没写出规范写法"，
            // 就随帧带一个中文名列表过来。这里只在**定稿帧**上拼一行小提示：
            // 增量帧还在一句一句变长，挂提示只会闪；而且它本来就不该被评判。
            final String watchNote = watchNote(partial, termsMissing);
            // ★ 真眼镜：把这一帧投上去。
            //
            //   眼镜上投的是**手机该显示的那一侧**，不是原始译文：如果佩戴者在看对方的字幕，
            //   那一侧就是译文；如果这一帧是"佩戴者自己说的话"（出站给对方），
            //   投上去的是它对应的显示侧。这样眼镜上的内容和手机永远一致，
            //   不会出现"眼镜和手机显示不同语言"。
            pushToGlasses(text, source);
            if (session != null && session.active) {
                String time = elapsedLabel();
                SubtitleList.Segment segment = subtitles.submit(time, source, text, partial, watchNote);
                if (segment != null) {
                    // 同一片段（同原文）的增量/定稿/校对修订都落到同一条记录行上，
                    // 这样导出的记录里也是一条一句，而不是每次增量一行。
                    Records.Session.Line line = session.segmentOf.get(segment);
                    if (line == null) {
                        line = new Records.Session.Line();
                        line.time = time;
                        line.source = source == null ? "" : source;
                        session.lines.add(line);
                        session.segmentOf.put(segment, line);
                    }
                    line.target = text == null ? "" : text;
                }
                if (fullscreenList != null) {
                    fullscreenList.submit(time, source, text, partial, watchNote);
                }
            } else if (text != null && !text.isEmpty()) {
                // 没在会话里也收到字幕（电脑侧自己在跑）→ 只更新眼镜预览，不污染记录
                showNote(getString(R.string.processing));
            }
        });
    }

    /** 把"本句提到的表内名字"拼成一行小提示；没有就返回空串。 */
    private String watchNote(boolean partial, String[] termsMissing) {
        if (partial || termsMissing == null || termsMissing.length == 0) return "";
        StringBuilder names = new StringBuilder();
        for (String name : termsMissing) {
            if (name == null || name.isEmpty()) continue;
            if (names.length() > 0) names.append('、');
            names.append(name);
        }
        if (names.length() == 0) return "";
        return getString(R.string.terms_watch_hint, names.toString());
    }

    @Override
    public void onError(final String message) {
        main.post(() -> {
            lastError = message;
            if (message.startsWith("连接失败") || message.startsWith("握手失败")) {
                if (client != null) {
                    client.stop();
                    client = null;
                }
                deviceName = null;
                renderConnectionCard();
                if (overlayConnectProgress != null) showConnectProgress(message, R.color.err);
            } else if (session != null && session.active) {
                // 处理中出现断连：停止采集（这个版本没有音频缓存），并如实说明
                stopCapture();
                session.paused = true;
                renderSessionState();
                showNote(getString(R.string.err_disconnected) + " " + getString(R.string.err_disconnected_note));
            }
            showNote(message);
        });
    }

    // ── 电平与收音状态 ──────────────────────────────────────────────────────

    @Override
    public void onUploadStatus(final String message) {
        // 上传进度只进诊断区：界面上的"正在收音"由真实电平驱动，比"已上传 N 秒"更有用
        main.post(() -> {
            uploadProgress = message;
            refreshDiagnostics();
        });
    }

    private String uploadProgress = "";

    @Override
    public void onUploadError(final String message) {
        main.post(() -> {
            if (uploader != null) uploader.stop();
            renderSessionState();
            showNote(message);
        });
    }

    @Override
    public void onLevel(final float rms, final float peak) {
        main.post(() -> {
            updateMeter(rms, peak);
            if (rms >= UI_SPEECH_RMS) lastSpeechAt = System.currentTimeMillis();
            if (session != null && session.active && !session.paused) renderMicState();
        });
    }

    private void renderMicState() {
        if (session == null) return;
        if (session.paused || uploader == null || !uploader.isRunning()) {
            micState.setText(R.string.mic_stopped);
            return;
        }
        boolean speaking = System.currentTimeMillis() - lastSpeechAt < SPEECH_HOLD_MS;
        micState.setText(speaking ? R.string.mic_listening : R.string.mic_waiting);
    }

    // ── 会话 ────────────────────────────────────────────────────────────────

    /** 一次同传会话的全部状态。 */
    private static class Session {
        final Date startedAt = new Date();
        final List<Records.Session.Line> lines = new ArrayList<>();
        /** 片段 → 记录行的映射，用于"流式更新同一条"时也同步记录。 */
        final java.util.Map<SubtitleList.Segment, Records.Session.Line> segmentOf =
                new java.util.IdentityHashMap<>();
        long startedMs = System.currentTimeMillis();
        boolean active = false;
        boolean paused = false;
        boolean partial = false;
        String direction = "";

        /**
         * 这一场**实际**用的是哪个输入设备（安卓报的实况）。
         *
         * <p>为什么要有：同传进行中底部导航是隐藏的（规范第 3 节），
         * 进不到设置里的诊断面板 —— 而这件事恰恰**必须在录的时候才知道**。
         * 所以跟着计时器每 500ms 采一次存在这里，结束后进总结页与记录。
         *
         * <p>这是"眼镜收音 vs 手机收音"对比实验能不能站住脚的唯一凭据：
         * 如果实际用的是手机麦克风，"眼镜更好"这个结论就是假的。
         */
        String audioInput = "";
        /** 有没有出现过"两路录音同时在跑"（音频会混在一起，那一场数据不可用）。 */
        boolean audioMixed = false;
    }

    private void onStartClicked() {
        if (!online()) {
            showNote(getString(R.string.reason_need_connection));
            openConnectPage();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            micGrantedPending = true;
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_RECORD_AUDIO);
            return;
        }
        beginSession();
    }

    private void beginSession() {
        micGrantedPending = false;
        session = new Session();
        session.active = true;
        session.direction = directionLabel();
        subtitles.clear();
        // 眼镜上从"等待开始同传"变成"等待输入"
        refreshGlassesIdle();
        subtitles.setBilingual(bilingual);
        subtitles.setScale(fontScale);
        idleBlock.setVisibility(View.GONE);
        sessionBlock.setVisibility(View.VISIBLE);
        setNavVisible(false);
        liveDirection.setText(directionLabel());
        liveLangHint.setVisibility(View.VISIBLE);
        startCapture();
        renderSessionState();
        startTimer();
    }

    private void startCapture() {
        if (client == null || !client.isRunning()) {
            showNote(getString(R.string.err_disconnected));
            return;
        }
        // ⚠️ **先把上一个音源停掉**，再起新的。
        //
        // 不这么做会出现"两个音源同时在跑"：转发进程只有一个 audio-in.pcm，
        // 两条流交错写进去 → 音频直接变成噪声，而且**从任何留档里都看不出发生过**。
        // 这一条在做"眼镜 vs 手机"对比实验时尤其致命：你以为在测眼镜，
        // 实际上手机麦克风也在往里灌。
        if (uploader != null && uploader.isRunning()) {
            uploader.stop();
            Log.i("MainActivity", "起新音源前先停掉：" + uploader.name());
        }
        uploader = startBestSource();
    }

    /**
     * 选一个音源并启动：**优先眼镜，失败退回手机**。
     *
     * <p>为什么优先眼镜：眼镜戴在说话人脸上、离嘴十几厘米；手机常在兜里或桌上，
     * 一两米开外。识别准确率对信噪比极其敏感（{@code docs/04}），
     * 所以同样的模型与网络，换音源就能明显好一截。
     *
     * <p>为什么要**自动退回**而不是"眼镜失败就不录"：眼镜是 USB 设备，
     * 偶发掉线、服务还没起来、固件忙都会让它一时不可用。
     * 那种情况下"整场同传没声音"比"音质差一点"糟糕得多 ——
     * 所以退回手机麦克风，并在界面上说清"退回的原因"。
     */
    private AudioSource startBestSource() {
        if (preferGlassesMic() && glasses != null && glasses.isConnected()) {
            GlassesMic candidate = new GlassesMic(this, client, this);
            candidate.setLanguage(sourceLang);
            String problem = candidate.start();
            if (problem == null) return candidate;
            candidate.stop();
            Log.w("MainActivity", "眼镜取音失败，改用手机麦克风：" + problem);
            showNote("眼镜取音失败，已切换为手机麦克风：" + problem);
        }
        MicUploader phone = new MicUploader(client, this);
        phone.setLanguage(sourceLang);
        String problem = phone.start();
        if (problem != null) showNote(problem);
        return phone;
    }

    private void stopCapture() {
        if (uploader != null && uploader.isRunning()) uploader.stop();
    }

    /**
     * 是否优先用眼镜麦克风。
     *
     * <p>缺省**是**（用户要的就是把取音挪到眼镜上）。留一个开关是因为
     * 做识别评测时需要 A/B 对比同一个模型在两种音源下的差别 ——
     * 而"能不能用眼镜麦克风"这种结论只能靠同一次实验里两侧都测才能说清。
     */
    private boolean preferGlassesMic() {
        return prefs.getBoolean(KEY_MIC_SOURCE, true);
    }

    private void togglePause() {
        if (session == null || !session.active) return;
        if (session.paused) {
            session.paused = false;
            startCapture();
            showNote("");
        } else {
            stopCapture();
            session.paused = true;
            // 暂停期间可能还有结果在回来，所以这句话要等最后一条定稿后才换成"已暂停收音"
            showNote(getString(R.string.paused_finishing));
        }
        renderSessionState();
    }

    private void renderSessionState() {
        boolean paused = session != null && session.paused;
        sessionTitle.setText(paused ? R.string.paused : R.string.interpreting);
        pauseIcon.setImageResource(paused ? R.drawable.ic_play : R.drawable.ic_pause);
        pauseLabel.setText(paused ? R.string.resume : R.string.pause);
        // 规范：录音过程中暂时禁用语言切换，并提示"暂停后可切换语言"
        idleSourceLang.setEnabled(true);
        liveLangHint.setVisibility(paused ? View.GONE : View.VISIBLE);
        liveDirection.setText(directionLabel());
        sessionConn.setText(online()
                ? getString(R.string.connect_ok, deviceName)
                : getString(R.string.err_disconnected));
        renderMicState();
    }

    private void endSession() {
        if (session == null || !session.active) return;
        stopCapture();
        session.active = false;
        session.paused = true;
        renderSessionState();
        // 同传结束 → 眼镜上回到待机提示（而不是继续挂着最后一句字幕）。
        //  ⚠️ 这里刻意**清掉字幕**：会话结束了还挂着最后一句，会让人以为还在同传。
        if (glassesView != null) glassesView.setSubtitle("");
        refreshGlassesIdle();

        // 还有流式片段没收尾时，等一会儿再进总结页 —— 让人看到"正在完成最后一段翻译…"
        boolean waiting = subtitles.size() > 0 && isLastSegmentPartial();
        pendingFinalWait = waiting;
        if (waiting) {
            showNote(getString(R.string.summary_finishing));
            final long deadline = System.currentTimeMillis() + 3500;
            final Runnable poll = new Runnable() {
                @Override
                public void run() {
                    if (!isLastSegmentPartial() || System.currentTimeMillis() > deadline) {
                        // 超时还没等到 → 如实标记"部分结果未完成"，照样允许保存
                        session.partial = isLastSegmentPartial();
                        pendingFinalWait = false;
                        openSummary();
                        return;
                    }
                    main.postDelayed(this, 200);
                }
            };
            main.postDelayed(poll, 200);
        } else {
            // 一条都没收到也算"部分结果未完成"：说明这段确实没出结果
            session.partial = subtitles.isEmpty();
            openSummary();
        }
    }

    /** 结束会话时是否还在等最后一段的定稿（决定总结页要不要显示"正在完成…"）。 */
    private boolean pendingFinalWait = false;

    private boolean isLastSegmentPartial() {
        List<SubtitleList.Segment> all = subtitles.segments();
        if (all.isEmpty()) return false;
        return all.get(all.size() - 1).partial;
    }

    private void openSummary() {
        stopTimer();
        setNavVisible(true);
        View view = pushOverlay(R.layout.page_summary);
        TextView title = view.findViewById(R.id.sumTitle);
        TextView finishing = view.findViewById(R.id.sumFinishing);
        TextView direction = view.findViewById(R.id.sumDirection);
        TextView started = view.findViewById(R.id.sumStarted);
        TextView duration = view.findViewById(R.id.sumDuration);
        TextView segments = view.findViewById(R.id.sumSegments);
        TextView partialNote = view.findViewById(R.id.sumPartialNote);

        final Records.Session draft = buildRecordDraft();
        title.setText(draft.title);
        direction.setText(getString(R.string.summary_direction) + "：" + draft.direction);
        started.setText(getString(R.string.summary_started) + "：" + draft.startedAt);
        duration.setText(getString(R.string.summary_duration) + "：" + formatDuration(draft.durationMs));
        segments.setText(getString(R.string.summary_segments) + "：" + draft.lines.size()
                + (draft.lines.isEmpty() ? "" : "（" + draft.lines.get(draft.lines.size() - 1).time + "）"));
        finishing.setVisibility(pendingFinalWait ? View.VISIBLE : View.GONE);
        partialNote.setVisibility(draft.partial ? View.VISIBLE : View.GONE);

        // ★ 本场实际用的输入设备。
        //   放在总结页是因为**同传进行中进不到设置页**（底部导航被隐藏，规范第 3 节），
        //   所以"这一场到底是不是眼镜收音"只能在结束后回答 —— 那就把它放在这里，
        //   并且一并存进记录。
        TextView inputView = view.findViewById(R.id.sumAudioInput);
        if (inputView != null) {
            if (draft.audioInput.isEmpty()) {
                inputView.setText("本场输入设备：未知");
            } else {
                inputView.setText("本场输入设备：" + draft.audioInput
                        + (draft.audioMixed ? "\n⚠ 期间出现过两路同时录音，本场音频可能被污染" : ""));
            }
            // 结论是坏的时候用醒目色 —— 这一场的数据不能拿去下结论
            boolean bad = draft.audioInput.startsWith("✗")
                    || draft.audioInput.startsWith("⚠")
                    || draft.audioInput.startsWith("?")
                    || (draft.audioInput.isEmpty() && !draft.lines.isEmpty());
            inputView.setTextColor(getColor(bad ? R.color.err : R.color.ink_soft));
        }

        view.findViewById(R.id.sumSave).setOnClickListener(v -> {
            records.save(draft);
            toast(getString(R.string.record_saved));
            closeOverlay();
            leaveSession();
            showPage(Page.RECORDS);
        });
        view.findViewById(R.id.sumBack).setOnClickListener(v -> {
            closeOverlay();
            leaveSession();
            showPage(Page.LIVE);
        });
    }

    private boolean waitingForFirstFrame_unused = false;

    /** 从当前字幕片段造一条待保存的记录（还没写盘）。 */
    private Records.Session buildRecordDraft() {
        Records.Session draft = new Records.Session();
        draft.title = Records.defaultTitle(session == null ? new Date() : session.startedAt);
        draft.direction = session == null ? directionLabel() : session.direction;
        draft.startedAt = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
                .format(session == null ? new Date() : session.startedAt);
        draft.durationMs = session == null ? 0 : System.currentTimeMillis() - session.startedMs;
        draft.partial = session != null && session.partial;
        // 把"这一场实际用的是哪个输入设备"带进记录。
        // 这是"眼镜收音 vs 手机收音"对比实验能不能站住脚的唯一留档 ——
        // 音频一旦离开手机就没有来源信息了，事后再也补不回来。
        draft.audioInput = session == null ? "" : session.audioInput;
        draft.audioMixed = session != null && session.audioMixed;
        for (SubtitleList.Segment segment : subtitles.segments()) {
            Records.Session.Line line = new Records.Session.Line();
            line.time = segment.time;
            line.source = segment.source;
            line.target = segment.target == null ? "" : segment.target;
            draft.lines.add(line);
        }
        return draft;
    }

    private void leaveSession() {
        session = null;
        sessionBlock.setVisibility(View.GONE);
        idleBlock.setVisibility(View.VISIBLE);
        setNavVisible(true);
        subtitles.clear();
        renderConnectionCard();
        showNote("");
    }

    private void startTimer() {
        stopTimer();
        timerTick.run();
    }

    private final Runnable timerTick = new Runnable() {
        @Override
        public void run() {
            if (session == null || !session.active) return;
            sessionTimer.setText(elapsedLabel());
            sampleAudioInput();
            main.postDelayed(this, 500);
        }
    };

    /**
     * 采样"这一场实际用的是哪个输入设备"，记进会话。
     *
     * <p><b>为什么要在会话进行中采样</b>：诊断面板在设置页，而同传时底部导航是隐藏的
     * （规范第 3 节：把底部空间让给音频控制）—— **中途根本进不去看**。
     * 而这件事恰恰必须在录的时候看：等录完了，谁也说不清刚才那场是哪个麦克风。
     *
     * <p>所以在这里每 500ms 采一次（顺便跟着已有的计时器走，不另起轮询），
     * 存进会话、并在结束后的总结页与记录里显示。这样"这一场到底是不是眼镜收音"
     * 就从"当时没看见、事后说不清"变成了留档里的一行字。
     *
     * <p>只保留**最坏**的那个结论：一旦发现"两路同时在录"或"用的是手机麦克风"，
     * 就不被后面正常的采样覆盖掉 —— 那一场的数据本来就已经被污染了。
     */
    private void sampleAudioInput() {
        if (session == null) return;
        AudioManager manager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        String verdict = AudioDevices.verdict(manager);
        if (verdict.isEmpty() || "未在录音".equals(verdict)) return;
        if (verdict.startsWith("⚠")) session.audioMixed = true;
        // 只保留**最坏**的那条：一旦确认过"两路在录"或"用的是手机"，
        // 就不该被后面某次正常采样洗白 —— 那一场的数据本来就已经被污染了。
        if (inputSeverity(verdict) > inputSeverity(session.audioInput)) {
            session.audioInput = verdict;
        }
    }

    /** 结论的严重程度：坏消息权重高，用来实现"只保留最坏"。 */
    private static int inputSeverity(String verdict) {
        if (verdict == null || verdict.isEmpty()) return 0;
        if (verdict.startsWith("✗") || verdict.startsWith("⚠")) return 3;   // 数据不可用
        if (verdict.startsWith("?")) return 2;                               // 无法确认
        if (verdict.startsWith("✓")) return 1;                               // 确认是眼镜
        return 0;
    }

    private void stopTimer() {
        main.removeCallbacks(timerTick);
    }

    /** 会话经过时间（规范：计时规则保持一致，显示会话经过时间）。 */
    private String elapsedLabel() {
        if (session == null) return "00:00";
        long seconds = (System.currentTimeMillis() - session.startedMs) / 1000;
        return String.format(Locale.US, "%02d:%02d", seconds / 60, seconds % 60);
    }

    private static String formatDuration(long millis) {
        long seconds = millis / 1000;
        if (seconds < 60) return seconds + " 秒";
        return (seconds / 60) + " 分 " + (seconds % 60) + " 秒";
    }

    // ── 语言 ────────────────────────────────────────────────────────────────

    private String targetLang() {
        return "pt-BR".equals(sourceLang) ? "zh-CN" : "pt-BR";
    }

    private String directionLabel() {
        return shortDirection();
    }

    private String shortDirection() {
        return "pt-BR".equals(sourceLang) ? "葡萄牙语 → 简体中文" : "简体中文 → 葡萄牙语";
    }

    private void applyLanguageLabels() {
        boolean listeningPt = "pt-BR".equals(sourceLang);
        idleSourceLang.setText(listeningPt ? R.string.lang_pt_short : R.string.lang_zh_short);
        idleTargetLang.setText(listeningPt ? R.string.lang_zh_short : R.string.lang_pt_short);
        // 高亮"源语言"那一侧：它才是这段话说出来的语言
        idleSourceLang.setBackgroundResource(R.drawable.tap_pill_active);
        idleTargetLang.setBackgroundResource(R.drawable.tap_pill);
        idleSourceLang.setTextColor(getColor(R.color.on_brand));
        idleTargetLang.setTextColor(getColor(R.color.ink));
        liveDirection.setText(shortDirection());
    }

    private void swapLanguages() {
        sourceLang = "pt-BR".equals(sourceLang) ? "zh-CN" : "pt-BR";
        prefs.edit().putString(KEY_LANG, sourceLang).apply();
        applyLanguageLabels();
        if (uploader != null) uploader.setLanguage(sourceLang);
    }

    // ── 覆盖层 ──────────────────────────────────────────────────────────────

    private View overlayRoot = null;

    private View pushOverlay(int layoutRes) {
        overlayHost.removeAllViews();
        View view = LayoutInflater.from(this).inflate(layoutRes, overlayHost, false);
        overlayHost.addView(view);
        overlayHost.setVisibility(View.VISIBLE);
        overlayRoot = view;
        return view;
    }

    private void closeOverlay() {
        glassesRealStatus = null;
        glassesRealToggle = null;
        overlayHost.removeAllViews();
        overlayHost.setVisibility(View.GONE);
        overlayRoot = null;
        overlayConnectProgress = null;
        glassesSampleNote = null;
        fullscreenList = null;
    }

    // ── 连接电脑页 ──────────────────────────────────────────────────────────

    private LinearLayout overlayConnectProgress;
    private TextView overlayConnectProgressText;
    private View overlayConnectProgressDot;

    // 热词表是**页面**（底部导航第 4 栏），不再是覆盖层 —— 见 buildTermsPage()。



    private void openConnectPage() {
        View view = pushOverlay(R.layout.overlay_connect);
        final EditText hostField = view.findViewById(R.id.connectHost);
        final EditText secretField = view.findViewById(R.id.connectSecret);
        hostField.setText(host());
        hostField.setHint(R.string.connect_address_hint);
        secretField.setText(secret());
        view.findViewById(R.id.connectBack).setOnClickListener(v -> closeOverlay());

        overlayConnectProgress = view.findViewById(R.id.connectProgress);
        overlayConnectProgressText = view.findViewById(R.id.connectProgressText);
        overlayConnectProgressDot = view.findViewById(R.id.connectProgressDot);

        final View testButton = view.findViewById(R.id.connectTest);
        testButton.setOnClickListener(v -> {
            String address = hostField.getText().toString().trim();
            if (address.isEmpty()) {
                showConnectProgress(getString(R.string.connect_address) + " 不能为空", R.color.err);
                return;
            }
            if (!address.startsWith("http://") && !address.startsWith("https://")) {
                address = "http://" + address;
                hostField.setText(address);
            }
            showConnectProgress(getString(R.string.connect_progress_connecting), R.color.warn);
            // 失败时不清空输入（规范：保留用户输入，提供重试）
            connect(address, secretField.getText().toString().trim());
        });


        View detail = view.findViewById(R.id.connectDetail);
        detail.setVisibility(online() ? View.VISIBLE : View.GONE);
        if (online()) {
            ((TextView) view.findViewById(R.id.detailDevice)).setText(deviceName);
            ((TextView) view.findViewById(R.id.detailAddress)).setText(host());
        }
        renderRecent(view.findViewById(R.id.recentList), view.findViewById(R.id.recentEmpty));
    }

    private void showConnectProgress(String text, int colorRes) {
        if (overlayConnectProgress == null) return;
        overlayConnectProgress.setVisibility(View.VISIBLE);
        overlayConnectProgressText.setText(text);
        overlayConnectProgressDot.setBackgroundTintList(
                ColorStateList.valueOf(getColor(colorRes)));
    }


    /** 等宽、可滚动、可复制的长文本弹窗（排版自检报告用）。 */
    private void showTextDialog(String title, String text) {
        TextView box = new TextView(this);
        box.setText(text);
        box.setTextSize(11f);
        box.setTypeface(Typeface.MONOSPACE);
        box.setTextIsSelectable(true);
        box.setPadding(dp(16), dp(12), dp(16), dp(12));

        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);

        new AlertDialog.Builder(this)
                .setTitle(title)
                .setView(scroll)
                .setPositiveButton("关闭", null)
                .show();
    }

    private void rememberRecent(String address) {
        if (address == null || address.isEmpty()) return;
        String stored = prefs.getString(KEY_RECENT, "");
        List<String> items = new ArrayList<>();
        items.add(address);
        for (String item : stored.split("\n")) {
            if (!item.isEmpty() && !item.equals(address) && items.size() < 5) items.add(item);
        }
        prefs.edit().putString(KEY_RECENT, String.join("\n", items)).apply();
    }

    private void renderRecent(LinearLayout list, View empty) {
        list.removeAllViews();
        String stored = prefs.getString(KEY_RECENT, "");
        String[] items = stored.isEmpty() ? new String[0] : stored.split("\n");
        empty.setVisibility(items.length == 0 ? View.VISIBLE : View.GONE);
        for (String item : items) {
            View row = LayoutInflater.from(this).inflate(R.layout.item_recent, list, false);
            ((TextView) row.findViewById(R.id.recentAddress)).setText(item);
            ((TextView) row.findViewById(R.id.recentWhen)).setText("");
            row.setOnClickListener(v -> {
                // 点最近连接 = 直接重试这个地址（配对码沿用已保存的）
                EditText hostField = overlayRoot.findViewById(R.id.connectHost);
                if (hostField != null) hostField.setText(item);
                showConnectProgress(getString(R.string.connect_progress_connecting), R.color.warn);
                connect(item, secret());
            });
            list.addView(row);
        }
    }

    // ── 记录页 ──────────────────────────────────────────────────────────────

    private void buildRecordsPage() {
        recordsPage = LayoutInflater.from(this).inflate(R.layout.page_records, pageHost, false);
        recordsPage.setVisibility(View.GONE);
        pageHost.addView(recordsPage);
        recordsList = recordsPage.findViewById(R.id.recordsList);
        recordsEmpty = recordsPage.findViewById(R.id.recordsEmpty);
    }

    private void renderRecords() {
        List<Records.Session> all = records.load();
        recordsList.removeAllViews();
        recordsEmpty.setVisibility(all.isEmpty() ? View.VISIBLE : View.GONE);
        for (Records.Session session : all) {
            View row = LayoutInflater.from(this).inflate(R.layout.item_record, recordsList, false);
            ((TextView) row.findViewById(R.id.recTitle)).setText(session.title);
            // 列表里带一个**音源标记**：做对比实验时一眼就能挑出"哪几场是眼镜收的音"，
            // 不用逐条点进去看。结论是坏的（用了手机/两路混录）要显眼。
            String inputTag = "";
            if (session.audioInput.startsWith("✓")) inputTag = " · 🎤眼镜";
            else if (session.audioInput.startsWith("✗")) inputTag = " · ⚠手机收音";
            else if (session.audioInput.startsWith("⚠")) inputTag = " · ⚠音源混录";
            else if (session.audioInput.startsWith("?")) inputTag = " · ?音源未确认";
            else if (!session.lines.isEmpty()) inputTag = " · ?音源未采集";
            ((TextView) row.findViewById(R.id.recMeta)).setText(session.startedAt
                    + " · " + session.direction + " · " + formatDuration(session.durationMs)
                    + inputTag);
            String excerpt = session.lines.isEmpty() ? ""
                    : session.lines.get(0).target;
            ((TextView) row.findViewById(R.id.recExcerpt)).setText(excerpt);
            row.findViewById(R.id.recPartial).setVisibility(session.partial ? View.VISIBLE : View.GONE);
            row.setOnClickListener(v -> openRecordDetail(session));
            recordsList.addView(row);
        }
    }

    private void openRecordDetail(final Records.Session record) {
        View view = pushOverlay(R.layout.page_record_detail);
        ((TextView) view.findViewById(R.id.detailTitle)).setText(record.title);
        ((TextView) view.findViewById(R.id.detailMeta)).setText(record.startedAt
                + " · " + record.direction + " · " + formatDuration(record.durationMs));
        LinearLayout list = view.findViewById(R.id.detailList);
        for (Records.Session.Line line : record.lines) {
            View row = LayoutInflater.from(this).inflate(R.layout.item_subtitle, list, false);
            ((TextView) row.findViewById(R.id.segTime)).setText(line.time);
            ((TextView) row.findViewById(R.id.segSource)).setText(line.source);
            ((TextView) row.findViewById(R.id.segTarget)).setText(line.target);
            row.findViewById(R.id.segTag).setVisibility(View.GONE);
            row.findViewById(R.id.segSource).setVisibility(bilingual ? View.VISIBLE : View.GONE);
            list.addView(row);
        }
        view.findViewById(R.id.detailBack).setOnClickListener(v -> closeOverlay());
        view.findViewById(R.id.detailRename).setOnClickListener(v -> promptRename(record));
        view.findViewById(R.id.detailCopy).setOnClickListener(v -> {
            StringBuilder text = new StringBuilder();
            for (Records.Session.Line line : record.lines) {
                if (bilingual && !line.source.isEmpty()) text.append(line.source).append('\n');
                text.append(line.target).append('\n');
            }
            android.content.ClipboardManager clipboard =
                    (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("字幕", text.toString()));
            toast(getString(R.string.record_copied));
        });
        view.findViewById(R.id.detailDelete).setOnClickListener(v -> new AlertDialog.Builder(this)
                .setMessage(R.string.record_delete_confirm)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.record_delete, (dialog, which) -> {
                    records.remove(record.id);
                    closeOverlay();
                    renderRecords();
                })
                .show());
    }

    private void promptRename(final Records.Session record) {
        final EditText field = new EditText(this);
        field.setText(record.title);
        field.setSelection(field.getText().length());
        new AlertDialog.Builder(this)
                .setTitle(R.string.record_rename)
                .setView(field)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.confirm, (dialog, which) -> {
                    String title = field.getText().toString().trim();
                    if (!title.isEmpty()) {
                        records.rename(record.id, title);
                        closeOverlay();
                        renderRecords();
                    }
                })
                .show();
    }

    // ── 设置页 ──────────────────────────────────────────────────────────────

    /**
     * 切换「校对（第二遍）」，并把结果**送到电脑**。
     *
     * <p>为什么必须送到电脑：开关的效果发生在电脑侧（它决定排不排第二次模型调用）。
     * 只改本地会造出"界面上关着、电脑上还在每句多花一次调用"的状态 —— 那比没有开关更糟。
     *
     * <p>失败时界面退回**电脑上的真实状态**（不是退回 false），并把原因说出来：
     * 原来这里用 `null → false`，于是电脑上还没写过 settings.json 时，
     * 用户点一下开关就立刻弹回"关闭"—— 那是 4.3 报上来的第二个问题。
     */
    private void toggleProofread() {
        if (client == null) {
            showNote(getString(R.string.settings_proofread_need_connect));
            return;
        }
        final boolean next = !proofreadOnServer;
        renderProofread(next, true);          // 先显示"正在…"，避免看起来没反应
        final LanClient current = client;
        new Thread(() -> {
            String note = null;
            boolean ok = false;
            boolean value = next;
            boolean apiAvailable = true;
            try {
                org.json.JSONObject result = current.settingsPutProofread(next);
                org.json.JSONObject json = result.optJSONObject("json");
                int code = result.optInt("code", 0);
                if (code == 200) {
                    ok = true;
                    value = json != null && json.optJSONObject("settings") != null
                            ? json.optJSONObject("settings").optBoolean("proofread", next) : next;
                    note = getString(R.string.settings_proofread_saved, value ? "已打开" : "已关闭");
                } else if (code == 404) {
                    apiAvailable = false;
                    note = "电脑上的接收进程是旧版（没有这个接口）—— 重启 start-all 后可用";
                } else {
                    note = getString(R.string.settings_proofread_failed,
                            json == null ? ("HTTP " + code) : json.optString("hint", "HTTP " + code));
                }
            } catch (Exception error) {
                note = getString(R.string.settings_proofread_failed, String.valueOf(error.getMessage()));
            }
            final boolean finalOk = ok;
            final boolean finalValue = value;
            final boolean finalApi = apiAvailable;
            final String finalNote = note;
            main.post(() -> {
                if (finalOk) {
                    proofreadOnServer = finalValue;
                    proofreadApiAvailable = true;
                    renderProofread(finalValue, false);
                } else {
                    proofreadApiAvailable = finalApi;
                    renderProofread(proofreadOnServer, false);      // 退回电脑的真实状态
                }
                showNote(finalNote);
            });
        }, "proofread-toggle").start();
    }

    /** 渲染校对开关：`pending` = 正在送电脑，此时不说"已完成"。 */
    private void renderProofread(boolean on, boolean pending) {
        if (settingsProofreadSwitch != null) settingsProofreadSwitch.setChecked(on);
        if (settingsProofreadState == null) return;
        if (pending) {
            settingsProofreadState.setText(on ? "正在打开…" : "正在关闭…");
            return;
        }
        if (proofreadApiAvailable == false) {
            settingsProofreadState.setText("电脑端版本过低，缺少设置接口");
            return;
        }
        settingsProofreadState.setText(proofreadOnServer
                ? R.string.settings_proofread_on : R.string.settings_proofread_off);
    }

    // ── 账户（注册 / 登录）：热词表的身份来源 ────────────────────────────────

    private TextView settingsAccountState;
    private TextView accountStateView;
    private EditText accountUsernameField;
    private EditText accountPasswordField;
    private TextView accountTokenTitleView;
    private TextView accountTokenView;
    private TextView accountStatusView;
    private View accountLogoutView;

    private String accountToken() {
        String value = prefs.getString(KEY_TOKEN, "");
        return value == null ? "" : value.trim();
    }

    private String accountUser() {
        String value = prefs.getString(KEY_USER, "");
        return value == null ? "" : value.trim();
    }

    private boolean loggedIn() {
        return accountToken().isEmpty() == false;
    }

    // 邮箱 + 验证码登录（docs/19）。刻意**不动**旧的用户名+密码入口：
    // 老的 anqi/test 账号就是那么建的，留着能继续登；新用户走上面这条。
    private EditText accountEmailField;
    private EditText accountCodeField;
    private TextView accountGetCodeView;
    private TextView accountEmailLoginView;

    private void openAccountPage() {
        View view = pushOverlay(R.layout.overlay_account);
        accountStateView = view.findViewById(R.id.accountState);
        accountUsernameField = view.findViewById(R.id.accountUsername);
        accountPasswordField = view.findViewById(R.id.accountPassword);
        accountTokenTitleView = view.findViewById(R.id.accountTokenTitle);
        accountTokenView = view.findViewById(R.id.accountToken);
        accountStatusView = view.findViewById(R.id.accountStatus);
        accountLogoutView = view.findViewById(R.id.accountLogout);

        view.findViewById(R.id.accountBack).setOnClickListener(v -> closeOverlay());
        view.findViewById(R.id.accountRegister).setOnClickListener(v -> runAccountAction("register"));
        view.findViewById(R.id.accountLogin).setOnClickListener(v -> runAccountAction("login"));
        accountLogoutView.setOnClickListener(v -> runAccountAction("logout"));

        // 邮箱 + 验证码（推荐路径）
        accountEmailField = view.findViewById(R.id.accountEmail);
        accountCodeField = view.findViewById(R.id.accountCode);
        accountGetCodeView = view.findViewById(R.id.accountGetCode);
        accountEmailLoginView = view.findViewById(R.id.accountEmailLogin);
        accountGetCodeView.setOnClickListener(v -> requestEmailCode());
        accountEmailLoginView.setOnClickListener(v -> registerWithEmailCode());

        accountUsernameField.setText(accountUser());
        renderAccount();
    }

    /** 电脑侧是不是支持账户接口（旧版没有）。null 概念上等于"还不知道"，按支持处理。 */
    private boolean relaySupportsAuth() {
        if (relayFeatures.isEmpty()) return true;      // 还没读到能力清单 → 不冤枉它
        return relayFeatures.contains("auth");
    }

    /** 渲染账户页：当前是谁、token 要不要露出来、注销按钮显不显示。 */
    private void renderAccount() {
        boolean in = loggedIn();
        if (accountStatusView != null && relaySupportsAuth() == false) {
            accountStatusView.setText("电脑端版本过低，缺少账户接口");
            accountStatusView.setTextColor(getColor(R.color.err));
        }
        if (accountStateView != null) {
            accountStateView.setText(in
                    ? getString(R.string.account_state_some, accountUser().isEmpty() ? "?" : accountUser())
                    : getString(R.string.account_state_none));
        }
        if (accountTokenTitleView != null) {
            accountTokenTitleView.setVisibility(in ? View.VISIBLE : View.GONE);
        }
        if (accountTokenView != null) {
            accountTokenView.setVisibility(in ? View.VISIBLE : View.GONE);
            if (in) accountTokenView.setText(accountToken());
        }
        if (accountLogoutView != null) {
            accountLogoutView.setVisibility(in ? View.VISIBLE : View.GONE);
        }
        if (settingsAccountState != null) {
            settingsAccountState.setText(in
                    ? getString(R.string.account_state_some, accountUser().isEmpty() ? "?" : accountUser())
                    : getString(R.string.settings_account_none));
        }
    }

    /**
     * 取验证码。码**打印在电脑端 start-all 的窗口里**（本机工具不接邮件服务），
     * 局域网模式下接口也会把码回给手机，于是这里顺手自动填入 —— 省一次手抄。
     * 公网模式（--public）服务端不会回码，那时只能看电脑窗口。
     */
    private void requestEmailCode() {
        final LanClient lan = client;
        if (lan == null) {
            if (accountStatusView != null) accountStatusView.setText(R.string.account_need_connect);
            return;
        }
        final String email = accountEmailField == null ? "" : accountEmailField.getText().toString().trim();
        if (email.isEmpty()) {
            if (accountStatusView != null) accountStatusView.setText(R.string.account_email_need);
            return;
        }
        if (accountStatusView != null) accountStatusView.setText(R.string.terms_status_working);
        new Thread(() -> {
            String status;
            int color = R.color.brand;
            String code = "";
            try {
                JSONObject result = lan.authRequestCode(email);
                if (result.optBoolean("ok", false)) {
                    code = result.optString("code", "");
                    status = code.isEmpty()
                            ? getString(R.string.account_code_sent)
                            : getString(R.string.account_code_sent) + "（已自动填入）";
                } else {
                    status = getString(R.string.account_failed, result.optString("error", "未知原因"));
                    color = R.color.err;
                }
            } catch (Exception error) {
                status = getString(R.string.account_failed, describeError(error));
                color = R.color.err;
            }
            final String finalStatus = status;
            final int finalColor = color;
            final String finalCode = code;
            main.post(() -> {
                if (!finalCode.isEmpty() && accountCodeField != null) {
                    accountCodeField.setText(finalCode);
                }
                if (accountStatusView != null) {
                    accountStatusView.setText(finalStatus);
                    accountStatusView.setTextColor(getColor(finalColor));
                }
            });
        }, "email-code").start();
    }

    /**
     * 注册：邮箱 + 用户名 + 密码 + 验证码（docs/19）。
     * <p>用户名与密码取下面那两个既有输入框 —— 不另开一对，免得用户在两处填同样的东西。
     * <p>登录不走这里：登录是「用户名 + 密码」，点下面的「登录」按钮（/auth/login）。
     */
    private void registerWithEmailCode() {
        final LanClient lan = client;
        if (lan == null) {
            if (accountStatusView != null) accountStatusView.setText(R.string.account_need_connect);
            return;
        }
        final String email = accountEmailField == null ? "" : accountEmailField.getText().toString().trim();
        final String code = accountCodeField == null ? "" : accountCodeField.getText().toString().trim();
        final String username = accountUsernameField == null ? "" : accountUsernameField.getText().toString().trim();
        final String password = accountPasswordField == null ? "" : accountPasswordField.getText().toString();
        if (email.isEmpty() || code.isEmpty() || username.isEmpty() || password.isEmpty()) {
            if (accountStatusView != null) accountStatusView.setText(R.string.account_need_fields);
            return;
        }
        if (accountStatusView != null) accountStatusView.setText(R.string.terms_status_working);
        new Thread(() -> {
            String status;
            int color = R.color.brand;
            String token = null;
            String user = null;
            String role = "";
            try {
                JSONObject json = lan.authRegisterEmail(email, username, password, code);
                if (json.optBoolean("ok", false)) {
                    token = json.optString("token", "");
                    user = json.optString("user", username);
                    role = json.optString("role", "");
                    status = getString(R.string.account_ok, "注册成功：" + user
                            + (role.isEmpty() ? "" : "（" + role + "）"));
                } else {
                    status = getString(R.string.account_failed, json.optString("error", "未知原因"));
                    color = R.color.err;
                }
            } catch (Exception error) {
                status = getString(R.string.account_failed, describeError(error));
                color = R.color.err;
            }
            final String finalStatus = status;
            final int finalColor = color;
            final String finalToken = token;
            final String finalUser = user;
            main.post(() -> {
                if (finalToken != null && !finalToken.isEmpty()) {
                    prefs.edit().putString(KEY_TOKEN, finalToken).putString(KEY_USER, finalUser).apply();
                    if (client != null) client.setToken(finalToken);
                    if (accountCodeField != null) accountCodeField.setText("");
                    if (accountPasswordField != null) accountPasswordField.setText("");
                    renderAccount();
                }
                if (accountStatusView != null) {
                    accountStatusView.setText(finalStatus);
                    accountStatusView.setTextColor(getColor(finalColor));
                }
            });
        }, "email-register").start();
    }

    /** 注册 / 登录 / 注销：都要经过电脑（账户存在电脑上）。 */
    private void runAccountAction(final String action) {
        if (client == null) {
            if (accountStatusView != null) accountStatusView.setText(R.string.account_need_connect);
            return;
        }
        if (relaySupportsAuth() == false) {
            // 已经知道对面是旧版：不发请求，直接说人话（省一次 404 往返，也省得用户猜）
            if (accountStatusView != null) {
                accountStatusView.setText("电脑端版本过低，缺少账户接口");
                accountStatusView.setTextColor(getColor(R.color.err));
            }
            return;
        }
        final String username = accountUsernameField == null ? "" : accountUsernameField.getText().toString().trim();
        final String password = accountPasswordField == null ? "" : accountPasswordField.getText().toString();

        if ("logout".equals(action) == false) {
            if (username.isEmpty() || password.isEmpty()) {
                if (accountStatusView != null) accountStatusView.setText(R.string.account_need_fields);
                return;
            }
        }
        if (accountStatusView != null) accountStatusView.setText(R.string.terms_status_working);

        final LanClient current = client;
        new Thread(() -> {
            String status;
            int color = R.color.brand;
            String token = null;
            String user = null;
            try {
                if ("logout".equals(action)) {
                    current.setToken(accountToken());
                    org.json.JSONObject result = current.authLogout();
                    if (result.optInt("code", 0) == 200) {
                        // 注销成功：本地也清掉（否则界面说注销了、token 还在用）
                        prefs.edit().remove(KEY_TOKEN).apply();
                        current.setToken("");
                        status = "已注销这台设备的登录";
                    } else if (result.optInt("code", 0) == 401) {
                        // token 早就失效了：直接清本地，别让用户卡在"注销不了"
                        prefs.edit().remove(KEY_TOKEN).apply();
                        current.setToken("");
                        status = "本地登录已清除（电脑上那个 token 早就失效了）";
                    } else {
                        status = getString(R.string.account_failed, accountError(result));
                        color = R.color.err;
                    }
                } else {
                    org.json.JSONObject result = "register".equals(action)
                            ? current.authRegister(username, password)
                            : current.authLogin(username, password);
                    org.json.JSONObject json = result.optJSONObject("json");
                    int code = result.optInt("code", 0);
                    if (code == 200 && json != null) {
                        token = json.optString("token", "");
                        user = json.optString("user", username);
                        status = getString(R.string.account_ok,
                                ("register".equals(action) ? "注册成功：" : "登录成功：") + user);
                    } else {
                        status = getString(R.string.account_failed, accountError(result));
                        color = R.color.err;
                    }
                }
            } catch (Exception error) {
                status = getString(R.string.account_failed, String.valueOf(error.getMessage()));
                color = R.color.err;
            }
            final String finalStatus = status;
            final int finalColor = color;
            final String finalToken = token;
            final String finalUser = user;
            main.post(() -> {
                if (finalToken != null && finalToken.isEmpty() == false) {
                    prefs.edit().putString(KEY_TOKEN, finalToken).putString(KEY_USER, finalUser).apply();
                    if (client != null) client.setToken(finalToken);
                    if (accountPasswordField != null) accountPasswordField.setText("");
                    renderAccount();
                } else {
                    renderAccount();
                }
                if (accountStatusView != null) {
                    accountStatusView.setText(finalStatus);
                    accountStatusView.setTextColor(getColor(finalColor));
                }
            });
        }, "account-action").start();
    }

    /**
     * 从 `{code, json}` 里取一句能看懂的失败原因。
     *
     * <p>⚠️ 404 单独处理：它几乎总是"电脑上的接收进程还是旧版"（没有 `/auth/*` 端点），
     * 而不是"注册写错了"。原来的实现只显示 `not-found`，用户根本猜不到要重启什么。
     */
    private static String accountError(org.json.JSONObject result) {
        org.json.JSONObject json = result == null ? null : result.optJSONObject("json");
        int code = result == null ? 0 : result.optInt("code", 0);
        if (code == 404) {
            return "电脑上的接收进程是旧版（没有账户接口）—— 重启 node scripts/start-all.mjs 后可用";
        }
        if (json == null) return "HTTP " + code;
        String hint = json.optString("hint", "");
        String error = json.optString("error", "");
        if ("not-found".equals(error)) {
            return "电脑上的接收进程是旧版（没有账户接口）—— 重启 node scripts/start-all.mjs 后可用";
        }
        String text = error.isEmpty() ? hint : (hint.isEmpty() ? error : error + "：" + hint);
        return text.isEmpty() ? ("HTTP " + code) : text;
    }

    // ── 热词表页（底部导航第 4 栏，表格形式）─────────────────────────────────

    private TextView termsCountView;
    private LinearLayout termsRowsBox;
    private TextView termsEmptyView;
    private TextView termsStatusText;
    private TextView termsWarnTitleView;
    private TextView termsWarnBodyView;
    private TextView termsRejectTitleView;
    private TextView termsRejectBodyView;

    // ── 库与申请（docs/19：用户只能"选库"和"提申请"，不能改库内容）──────────────
    //
    // 为什么单机会话用一个固定 meeting id：现在还只有"一场同传"（没有房间概念），
    // 选库本来就是"这一次同传用哪些库"。等房间模块上来，把这里换成真实 roomId 即可 ——
    // 服务端接口形状不变（都带 meetingId）。
    private static final String ORG_MEETING_ID = "current";

    private LinearLayout termsLibrariesBox;
    private LinearLayout termsRequestsBox;
    private TextView termsLibStatusView;
    private TextView termsLibHintView;

    /** 库列表（服务端返回的摘要）+ 本次勾选了哪些。 */
    private final List<OrgLibrary> orgLibraries = new ArrayList<>();
    private final java.util.Set<String> orgPicked = new java.util.LinkedHashSet<>();

    /** 库摘要：只留界面要用的字段（避免把整份 JSON 到处传）。 */
    private static final class OrgLibrary {
        final String id;
        final String name;
        final String categoryName;
        final int priority;
        final int entries;

        OrgLibrary(String id, String name, String categoryName, int priority, int entries) {
            this.id = id;
            this.name = name;
            this.categoryName = categoryName;
            this.priority = priority;
            this.entries = entries;
        }
    }

    /**
     * 表格里的数据：每项 `{zh, pt}`。
     *
     * <p>为什么用内存列表 + 动态加行，而不是让用户按分隔符手打一段文本：
     * 用户手上的表在 Excel/Word/微信里，让他重录一遍必然出错；而格式错（少个等号、
     * 用了中文逗号、全角空格）最后表现为"校验失败"，他又看不出错在哪。
     * 表格的好处是**每一格都能各自编辑、每一行都能删**，错了立刻看得见。
     */
    private final java.util.List<String[]> termsRowsData = new java.util.ArrayList<>();

    /** 自动校验的防抖句柄：连续输入时只跑最后一次。 */
    private final android.os.Handler termsValidateHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());
    private Runnable termsValidateTick = null;

    /**
     * 安排一次自动校验（防抖 500ms）。
     *
     * <p>为什么要防抖：每敲一个字就发一次请求，既刷屏又慢；而**逐字校验也没有意义**
     * ——"高通"打到一半叫"高"，本来就还没填完。
     */
    private void scheduleAutoValidate() {
        if (termsValidateTick != null) termsValidateHandler.removeCallbacks(termsValidateTick);
        termsValidateTick = () -> runAutoValidate();
        termsValidateHandler.postDelayed(termsValidateTick, 500);
    }

    /**
     * 自动校验：**先本地看明显的错，再问电脑**。
     *
     * <p>两层是刻意的：
     *  · 本地这层只查"肉眼可见"的（空着一侧、葡语列写中文、太长），
     *    好处是**没连电脑时也能立刻看到红字**，而且不用等网络；
     *  · 电脑那层才是权威（拒绝码、重复、别名冲突、方向装反都在它那儿），
     *    因为"什么算合法"必须只有一套实现，不能手机一套、电脑一套。
     */
    private void runAutoValidate() {
        org.json.JSONArray entries = collectTermEntries();
        String local = localTermProblems(entries);
        if (local != null) {
            showTermsReport(getString(R.string.terms_status_local_invalid), R.color.err, null, local);
            return;
        }
        if (entries.length() == 0) {
            showTermsReport(getString(R.string.terms_status_idle), R.color.ink_soft, null, null);
            return;
        }
        if (client == null) {
            // 没连电脑：本地这关过了就先说"格式没问题"，别让用户以为校验没生效
            showTermsReport(getString(R.string.terms_status_local_ok, entries.length()), R.color.brand, null, null);
            return;
        }
        if (loggedIn() == false) {
            showTermsReport(getString(R.string.terms_need_login), R.color.err, null, null);
            return;
        }
        client.setToken(accountToken());
        final LanClient current = client;
        new Thread(() -> {
            String status;
            int color = R.color.brand;
            org.json.JSONObject warnings = null;
            org.json.JSONObject rejected = null;
            try {
                org.json.JSONObject result = current.termsValidate(entries);
                org.json.JSONObject json = result.optJSONObject("json");
                int code = result.optInt("code", 0);
                warnings = json;
                if (code == 200) {
                    status = getString(R.string.terms_status_valid, entries.length());
                } else {
                    int bad = json == null || json.optJSONArray("rejected") == null
                            ? 0 : json.optJSONArray("rejected").length();
                    status = getString(R.string.terms_status_invalid, Math.max(bad, 1));
                    color = R.color.err;
                    rejected = json;
                }
            } catch (Exception error) {
                status = getString(R.string.terms_status_failed, String.valueOf(error.getMessage()));
                color = R.color.err;
            }
            final String finalStatus = status;
            final int finalColor = color;
            final org.json.JSONObject finalWarnings = warnings;
            final org.json.JSONObject finalRejected = rejected;
            main.post(() -> showTermsReport(finalStatus, finalColor,
                    termProblems(finalWarnings, "warnings", java.util.Collections.emptyList()),
                    termProblems(finalRejected, "rejected", java.util.Collections.emptyList())));
        }, "terms-validate").start();
    }

    /**
     * 本地能看出来的问题（**不是权威校验**，只是"不用等网络的红字"）。
     *
     * <p>三条都直接来自被反馈的坑：
     *  ① 一侧空着；
     *  ② **葡语列写中文**（用户当场试出来的：葡语那栏能填中文，而原先只有上传才会被拒）；
     *  ③ 太长（>200 字符，电脑也会拒，这里提前说）。
     *
     * @return null = 没看出问题
     */
    private String localTermProblems(org.json.JSONArray entries) {
        StringBuilder out = new StringBuilder();
        for (int index = 0; index < entries.length(); index += 1) {
            org.json.JSONObject entry = entries.optJSONObject(index);
            if (entry == null) continue;
            String zh = entry.optString("zh", "");
            String pt = entry.optString("pt", "");
            String problem = null;
            if (zh.isEmpty() || pt.isEmpty()) {
                problem = "中文和葡语都要填";
            } else if (pt.matches(".*[\\u4e00-\\u9fa5].*")) {
                problem = "葡语这一栏写的是中文 —— 两栏可能填反了";
            } else if (zh.length() > 200 || pt.length() > 200) {
                problem = "字数超过 200";
            }
            if (problem == null) continue;
            if (out.length() > 0) out.append('\n');
            out.append("第 ").append(index + 1).append(" 条：").append(problem);
        }
        return out.length() == 0 ? null : out.toString();
    }

    /** 热词表的用户名（留空 → 电脑侧回落到 default）。 */
    private String termsUser() {
        String value = prefs.getString(KEY_USER, "");
        return value == null ? "" : value.trim();
    }

    private void buildTermsPage() {
        termsPage = LayoutInflater.from(this).inflate(R.layout.page_terms, pageHost, false);
        termsPage.setVisibility(View.GONE);
        pageHost.addView(termsPage);

        termsCountView = termsPage.findViewById(R.id.termsCount);
        termsRowsBox = termsPage.findViewById(R.id.termsRows);
        termsEmptyView = termsPage.findViewById(R.id.termsEmpty);
        termsStatusText = termsPage.findViewById(R.id.termsStatus);
        termsWarnTitleView = termsPage.findViewById(R.id.termsWarnTitle);
        termsWarnBodyView = termsPage.findViewById(R.id.termsWarnBody);
        termsRejectTitleView = termsPage.findViewById(R.id.termsRejectTitle);
        termsRejectBodyView = termsPage.findViewById(R.id.termsRejectBody);

        termsPage.findViewById(R.id.termsAdd).setOnClickListener(v -> showAddTermDialog());
        termsPage.findViewById(R.id.termsBatch).setOnClickListener(v -> showBatchImportDialog());

        // 库与申请（docs/19）
        termsLibrariesBox = termsPage.findViewById(R.id.termsLibraries);
        termsRequestsBox = termsPage.findViewById(R.id.termsRequests);
        termsLibStatusView = termsPage.findViewById(R.id.termsLibStatus);
        termsLibHintView = termsPage.findViewById(R.id.termsLibHint);
        termsPage.findViewById(R.id.termsLibRefresh).setOnClickListener(v -> refreshOrgLibraries());
        termsPage.findViewById(R.id.termsLibSave).setOnClickListener(v -> saveOrgSelection());
        termsPage.findViewById(R.id.termsReqNew).setOnClickListener(v -> showNewRequestDialog());
        // ⚠️ 没有「校验」按钮了：校验在**改完 / 上传前**自动跑（用户要求）。
        //    留一个按钮等于逼用户记得点它 —— 而校验本来就是"随时该有的反馈"。
        termsPage.findViewById(R.id.termsUpload).setOnClickListener(v -> runTermsAction("upload"));
        termsPage.findViewById(R.id.termsLoad).setOnClickListener(v -> runTermsAction("load"));

        loadTermsDraft();
        renderTermsTable();
    }

    // ── 库与申请（docs/19）─────────────────────────────────────────────────────
    //
    // 三条设计约束：
    //   ① 用户**不能改库**：这里只有"勾选 + 保存"和"提申请"，没有编辑条目；
    //   ② 选库是**会议级**的（`PUT /org/meeting/<id>/libraries`），空选择就是空表；
    //   ③ 申请人不从界面传：服务端按 token 认定，界面就算传了也会被忽略。

    private void setLibStatus(String text) {
        if (termsLibStatusView != null) termsLibStatusView.setText(text);
    }

    private static String describeError(Exception error) {
        String message = error == null ? "" : String.valueOf(error.getMessage());
        return message.isEmpty() ? "（没有更多信息）" : message;
    }

    /** 拉库列表 + 这一场已选哪些（两个请求都成功才刷新界面，避免显示半份状态）。 */
    private void refreshOrgLibraries() {
        final LanClient lan = client;
        if (lan == null) {
            setLibStatus(getString(R.string.terms_status_need_connect));
            return;
        }
        setLibStatus("正在读取库…");
        new Thread(() -> {
            try {
                JSONObject libraries = lan.orgLibraries();
                // ⚠️ 关键：服务端失败（401 未登录 / 404 旧版 relay 没有 /org 路由 / 403）时
                //    返回的是 `{ok:false, error}`，**不是**空列表。
                //    第一版没查 ok 就把"没有 libraries 字段"当成"还没建库"，
                //    于是旧 relay 上永远显示"（电脑上还没有库）"—— 看着像数据问题，其实是路由不存在。
                if (!libraries.optBoolean("ok", false)) {
                    String reason = libraries.optString("error", "");
                    String hint = libraries.optString("hint", "");
                    int httpStatus = libraries.optInt("httpStatus", 0);
                    StringBuilder text = new StringBuilder("读取库失败：");
                    text.append(reason.isEmpty() ? "未知原因" : reason);
                    if (httpStatus > 0) text.append("（HTTP ").append(httpStatus).append("）");
                    if (!hint.isEmpty()) text.append("（").append(hint).append("）");
                    if (reason.contains("not-found")) text.append("\n→ 电脑上的 relay 是旧版：重启一次 start-all");
                    if (reason.contains("auth") || reason.contains("登录")) text.append("\n→ 先在「设置 → 账户」登录");
                    main.post(() -> setLibStatus(text.toString()));
                    return;
                }
                JSONObject selection = lan.orgMeetingLibraries(ORG_MEETING_ID);
                org.json.JSONArray picked = selection.optJSONArray("libraryIds");
                java.util.Set<String> pickedIds = new java.util.LinkedHashSet<>();
                if (picked != null) {
                    for (int i = 0; i < picked.length(); i += 1) pickedIds.add(picked.optString(i));
                }
                List<OrgLibrary> loaded = new ArrayList<>();
                org.json.JSONArray array = libraries.optJSONArray("libraries");
                if (array != null) {
                    for (int i = 0; i < array.length(); i += 1) {
                        JSONObject item = array.optJSONObject(i);
                        if (item == null) continue;
                        loaded.add(new OrgLibrary(
                                item.optString("id"), item.optString("name"),
                                item.optString("categoryName", ""),
                                item.optInt("priority", 0), item.optInt("entries", 0)));
                    }
                }
                main.post(() -> {
                    orgLibraries.clear();
                    orgLibraries.addAll(loaded);
                    orgPicked.clear();
                    orgPicked.addAll(pickedIds);
                    renderOrgLibraries();
                    setLibStatus(loaded.isEmpty()
                            ? getString(R.string.terms_libs_empty)
                            : ("已选 " + orgPicked.size() + " / " + loaded.size() + " 个库"));
                });
            } catch (Exception error) {
                main.post(() -> setLibStatus("读取库失败：" + describeError(error)));
            }
        }).start();
    }

    private void renderOrgLibraries() {
        if (termsLibrariesBox == null) return;
        termsLibrariesBox.removeAllViews();
        for (final OrgLibrary library : orgLibraries) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(0, dp(2), 0, dp(2));
            // 整行可点：点开看这个库里具体有哪些词条（只读）
            row.setBackgroundResource(R.drawable.tap_pill);
            row.setClickable(true);
            row.setOnClickListener(v -> showLibraryEntries(library));

            final android.widget.CheckBox box = new android.widget.CheckBox(this);
            box.setChecked(orgPicked.contains(library.id));
            box.setOnCheckedChangeListener((button, checked) -> {
                if (checked) orgPicked.add(library.id);
                else orgPicked.remove(library.id);
                setLibStatus("已选 " + orgPicked.size() + " / " + orgLibraries.size() + " 个库（记得保存）");
            });
            row.addView(box);

            TextView label = new TextView(this);
            // ⚠️ 分类可能没有：Android 的 optString 遇到 JSONObject.NULL 会返回字符串 "null"，
            //    直接拼进界面就显示成"null · 8 条"。服务端已经改成给空串，这里再兜一层。
            String category = library.categoryName;
            if (category == null || category.isEmpty() || "null".equals(category)) category = "未分类";
            String meta = category + " · " + library.entries + " 条 · 优先级 " + library.priority
                    + "（点击查看词条）";
            label.setText(library.name + "\n" + meta);
            label.setTextSize(13f);
            label.setTextColor(ContextCompat.getColor(this, R.color.ink));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            params.setMarginStart(dp(4));
            label.setLayoutParams(params);
            row.addView(label);

            termsLibrariesBox.addView(row);
        }
    }

    /** 点开一个库：列出里面的条目（只读，不能改 —— 改库是管理员的事）。 */
    private void showLibraryEntries(final OrgLibrary library) {
        final LanClient lan = client;
        if (lan == null) {
            toast(getString(R.string.terms_status_need_connect));
            return;
        }
        setLibStatus("正在读取「" + library.name + "」的词条…");
        new Thread(() -> {
            try {
                JSONObject detail = lan.orgLibrary(library.id);
                if (!detail.optBoolean("ok", false)) {
                    main.post(() -> setLibStatus("读取词条失败：" + detail.optString("error", "未知原因")));
                    return;
                }
                JSONObject body = detail.optJSONObject("library");
                org.json.JSONArray entries = body == null ? null : body.optJSONArray("entries");
                main.post(() -> {
                    setLibStatus("已选 " + orgPicked.size() + " / " + orgLibraries.size() + " 个库");
                    showEntriesDialog(library, entries);
                });
            } catch (Exception error) {
                main.post(() -> setLibStatus("读取词条失败：" + describeError(error)));
            }
        }).start();
    }

    private void showEntriesDialog(OrgLibrary library, org.json.JSONArray entries) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), dp(10), dp(16), dp(6));
        if (entries == null || entries.length() == 0) {
            TextView empty = new TextView(this);
            empty.setText("这个库还没有词条");
            empty.setTextSize(13f);
            box.addView(empty);
        } else {
            for (int i = 0; i < entries.length(); i += 1) {
                JSONObject entry = entries.optJSONObject(i);
                if (entry == null) continue;
                StringBuilder line = new StringBuilder();
                line.append(i + 1).append(". ").append(entry.optString("zh")).append("  →  ")
                        .append(entry.optString("pt"));
                org.json.JSONArray approved = entry.optJSONArray("approved");
                if (approved != null && approved.length() > 0) {
                    StringBuilder forms = new StringBuilder();
                    for (int k = 0; k < approved.length(); k += 1) {
                        String form = approved.optString(k);
                        if (form.isEmpty() || form.equals(entry.optString("pt"))) continue;
                        if (forms.length() > 0) forms.append("、");
                        forms.append(form);
                    }
                    if (forms.length() > 0) line.append("\n     可接受写法：").append(forms);
                }
                org.json.JSONArray variants = entry.optJSONArray("variants");
                if (variants != null && variants.length() > 0) {
                    StringBuilder forms = new StringBuilder();
                    for (int k = 0; k < variants.length(); k += 1) {
                        String form = variants.optString(k);
                        if (form.isEmpty()) continue;
                        if (forms.length() > 0) forms.append("、");
                        forms.append(form);
                    }
                    if (forms.length() > 0) line.append("\n     中文变体：").append(forms);
                }
                TextView item = new TextView(this);
                item.setText(line);
                item.setTextSize(13f);
                item.setTextColor(ContextCompat.getColor(this, R.color.ink));
                item.setPadding(0, dp(6), 0, dp(6));
                box.addView(item);
            }
        }
        ScrollView scroll = new ScrollView(this);
        scroll.addView(box);
        new AlertDialog.Builder(this)
                .setTitle(library.name + "（" + (entries == null ? 0 : entries.length()) + " 条，只读）")
                .setView(scroll)
                .setPositiveButton(android.R.string.ok, null)
                .show();
    }

    /** 保存"这一场启用哪些库"。空选择是合法状态（= 不启用术语库）。 */
    private void saveOrgSelection() {
        final LanClient lan = client;
        if (lan == null) {
            setLibStatus(getString(R.string.terms_status_need_connect));
            return;
        }
        new Thread(() -> {
            try {
                // JSONArray.put 会抛 JSONException（受检异常），所以整段放进 try
                org.json.JSONArray ids = new org.json.JSONArray();
                for (String id : orgPicked) ids.put(id);
                JSONObject result = lan.orgSaveMeetingLibraries(ORG_MEETING_ID, ids);
                if (!result.optBoolean("ok", false)) {
                    main.post(() -> setLibStatus("保存失败：" + result.optString("error", "未知原因")));
                    return;
                }
                main.post(() -> setLibStatus(getString(R.string.terms_libs_saved, ids.length())));
                // 选库变了 → 立刻让服务端发布一份"当前会议术语"（插件下一句就用上）；
                // 失败不影响选择本身：每次开始同传时 relay 也会自动发布一次。
                try {
                    JSONObject published = lan.orgPublishMeetingTerms();
                    if (published.optBoolean("ok", false)) {
                        main.post(() -> setLibStatus(getString(R.string.terms_libs_saved, ids.length())
                                + " · 本场会议术语 " + published.optInt("entries", 0) + " 条"));
                    }
                } catch (Exception ignored) {
                    // 下一场开始前还会再发布一次；这里不打扰用户
                }
            } catch (Exception error) {
                main.post(() -> setLibStatus("保存失败：" + describeError(error)));
            }
        }).start();
    }

    private void refreshMyRequests() {
        final LanClient lan = client;
        if (lan == null || termsRequestsBox == null) return;
        new Thread(() -> {
            try {
                JSONObject result = lan.orgMyRequests();
                org.json.JSONArray array = result.optJSONArray("requests");
                main.post(() -> {
                    termsRequestsBox.removeAllViews();
                    if (array == null || array.length() == 0) {
                        TextView empty = new TextView(this);
                        empty.setText(R.string.terms_req_empty);
                        empty.setTextSize(12f);
                        empty.setTextColor(ContextCompat.getColor(this, R.color.ink_soft));
                        termsRequestsBox.addView(empty);
                        return;
                    }
                    for (int i = 0; i < array.length(); i += 1) {
                        JSONObject item = array.optJSONObject(i);
                        if (item == null) continue;
                        JSONObject entry = item.optJSONObject("entry");
                        String zh = entry != null ? entry.optString("zh") : item.optString("targetKey");
                        String pt = entry != null ? entry.optString("pt") : "（删除）";
                        String status = item.optString("status", "pending");
                        TextView line = new TextView(this);
                        line.setText(typeLabel(item.optString("type")) + "「" + zh + "」→ " + pt
                                + " · " + statusLabel(status));
                        line.setTextSize(12.5f);
                        line.setTextColor(ContextCompat.getColor(this, R.color.ink));
                        line.setPadding(0, dp(3), 0, dp(3));
                        termsRequestsBox.addView(line);
                    }
                });
            } catch (Exception error) {
                main.post(() -> {
                    TextView line = new TextView(this);
                    line.setText("读取申请失败：" + describeError(error));
                    line.setTextSize(12f);
                    line.setTextColor(ContextCompat.getColor(this, R.color.err));
                    termsRequestsBox.removeAllViews();
                    termsRequestsBox.addView(line);
                });
            }
        }).start();
    }

    private String typeLabel(String type) {
        if ("update".equals(type)) return "修改";
        if ("delete".equals(type)) return "删除";
        return "新增";
    }

    private String statusLabel(String status) {
        if ("approved".equals(status)) return getString(R.string.terms_req_status_approved);
        if ("rejected".equals(status)) return getString(R.string.terms_req_status_rejected);
        if ("withdrawn".equals(status)) return getString(R.string.terms_req_status_withdrawn);
        return getString(R.string.terms_req_status_pending);
    }

    /** 提申请：只做"新增一条"（修改/删除等有真实需求再加，避免一上来堆三个表单）。 */
    private void showNewRequestDialog() {
        final LanClient lan = client;
        if (lan == null) {
            toast(getString(R.string.terms_status_need_connect));
            return;
        }
        if (orgLibraries.isEmpty()) {
            toast("先刷新库列表：申请要落到某个库里");
            return;
        }
        if (orgPicked.isEmpty()) {
            toast("先勾选一个库：申请要说明加到哪个库");
            return;
        }
        final String libraryId = orgPicked.iterator().next();

        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(16), dp(8), dp(16), dp(4));
        final EditText zhField = new EditText(this);
        zhField.setHint(R.string.terms_col_zh);
        final EditText ptField = new EditText(this);
        ptField.setHint(R.string.terms_col_pt);
        final EditText reasonField = new EditText(this);
        reasonField.setHint(R.string.terms_req_reason);
        form.addView(zhField);
        form.addView(ptField);
        form.addView(reasonField);

        new AlertDialog.Builder(this)
                .setTitle(R.string.terms_req_dialog_title)
                .setView(form)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.terms_req_submit, (dialog, which) -> {
                    submitOrgRequest(lan, libraryId, zhField.getText().toString().trim(),
                            ptField.getText().toString().trim(), reasonField.getText().toString().trim());
                })
                .show();
    }

    private void submitOrgRequest(final LanClient lan, final String libraryId,
                                  final String zh, final String pt, final String reason) {
        if (zh.isEmpty() || pt.isEmpty() || reason.isEmpty()) {
            toast("中文名、目标写法、理由都要填");
            return;
        }
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("type", "add");
                body.put("libraryId", libraryId);
                body.put("zh", zh);
                body.put("pt", pt);
                body.put("reason", reason);
                JSONObject result = lan.orgCreateRequest(body);
                main.post(() -> {
                    if (result.optBoolean("ok", false)) {
                        toast(getString(R.string.terms_req_ok));
                        refreshMyRequests();
                    } else {
                        toast("提交失败：" + result.optString("error", "未知原因"));
                    }
                });
            } catch (Exception error) {
                main.post(() -> toast("提交失败：" + describeError(error)));
            }
        }).start();
    }

    /** 切到这一页时：先把本地草稿画出来，再**静默拉一次电脑上的现表**（以电脑为准）。 */
    private void onTermsPageShown() {
        renderAccount();
        renderTermsTable();
        if (client == null) {
            showTermsReport(getString(R.string.terms_status_need_connect), R.color.err, null, null);
            setLibStatus(getString(R.string.terms_status_need_connect));
            return;
        }
        if (loggedIn() == false) {
            showTermsReport(getString(R.string.terms_need_login), R.color.err, null, null);
            // 没登录时**明确说出来**，别让"看不到库"被误读成"还没有库"
            setLibStatus("未登录：先到「设置 → 账户」用邮箱验证码登录，再回来刷新");
            return;
        }
        runTermsAction("load");
        // 库与申请：和旧热词表并排显示（旧的"自己编辑上传"已隐藏，迁移期保留代码）
        refreshOrgLibraries();
        refreshMyRequests();
    }

    // ── 表格渲染 ────────────────────────────────────────────────────────────

    private void renderTermsTable() {
        if (termsRowsBox == null) return;
        termsRowsBox.removeAllViews();
        for (int index = 0; index < termsRowsData.size(); index += 1) {
            termsRowsBox.addView(buildTermRow(index));
        }
        boolean empty = termsRowsData.isEmpty();
        if (termsEmptyView != null) termsEmptyView.setVisibility(empty ? View.VISIBLE : View.GONE);
        if (termsCountView != null) {
            termsCountView.setText(getString(R.string.terms_count, termsRowsData.size()));
        }
    }

    /** 造一行：中文输入框 + 葡语输入框 + 删除。 */
    private View buildTermRow(final int index) {
        final String[] pair = termsRowsData.get(index);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(android.view.Gravity.TOP);
        row.setPadding(0, dp(4), 0, dp(4));

        final EditText zhField = makeTermCell(pair[0], R.string.terms_col_zh);
        LinearLayout.LayoutParams zhParams = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        zhParams.setMarginEnd(dp(6));
        zhField.setLayoutParams(zhParams);
        // 每敲一个字就同步进内存 —— 原来只在**失焦**时才同步，
        // 于是"改完直接点上传"读到的还是旧值（用户报的"改了不起作用"就是这个）。
        zhField.addTextChangedListener(termCellWatcher(pair, 0, zhField));

        final EditText ptField = makeTermCell(pair[1], R.string.terms_col_pt);
        LinearLayout.LayoutParams ptParams = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        ptField.setLayoutParams(ptParams);
        ptField.addTextChangedListener(termCellWatcher(pair, 1, ptField));

        TextView remove = new TextView(this);
        remove.setText("×");
        remove.setTextSize(18f);
        remove.setTextColor(getColor(R.color.ink_soft));
        remove.setGravity(android.view.Gravity.CENTER);
        remove.setClickable(true);
        remove.setFocusable(true);
        LinearLayout.LayoutParams removeParams = new LinearLayout.LayoutParams(dp(36), dp(36));
        removeParams.setMarginStart(dp(6));
        removeParams.topMargin = dp(10);
        remove.setLayoutParams(removeParams);
        remove.setOnClickListener(v -> {
            if (index < termsRowsData.size()) termsRowsData.remove(index);
            saveTermsDraft();
            renderTermsTable();
            scheduleAutoValidate();
        });

        row.addView(zhField);
        row.addView(ptField);
        row.addView(remove);
        return row;
    }

    /**
     * 造一个单元格：**文字居中 + 过长自动换行**（按用户要求）。
     *
     * <p>为什么不单行：名字（尤其机构名、带型号的产品名）本来就长，
     * 单行会把后半截截掉 —— 而用户看不到自己填的字，就没法判断有没有填错。
     * 所以这里允许最多 4 行；再长的内容会滚动，
     * 因为一张表里塞一整段描述本身就不合适（该用备注字段，不在本期）。
     */
    private EditText makeTermCell(String text, int hintRes) {
        EditText field = new EditText(this);
        field.setText(text);
        field.setHint(hintRes);
        field.setTextSize(14f);
        field.setGravity(android.view.Gravity.CENTER);
        field.setSingleLine(false);
        field.setMinLines(1);
        field.setMaxLines(4);
        field.setHorizontallyScrolling(false);
        field.setBackgroundResource(R.drawable.bg_card);
        field.setPadding(dp(8), dp(8), dp(8), dp(8));
        return field;
    }

    /** 单元格改动 → 立刻写进内存 + 存草稿 + 触发防抖自动校验。 */
    private android.text.TextWatcher termCellWatcher(final String[] pair, final int column, final EditText field) {
        return new android.text.TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) { }

            @Override
            public void afterTextChanged(android.text.Editable s) {
                pair[column] = field.getText().toString().trim();
                saveTermsDraft();
                scheduleAutoValidate();
            }
        };
    }

    /** 「新增」：弹一个两格的小表格式对话框（不是让用户记分隔符）。 */
    private void showAddTermDialog() {
        final LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(8), dp(20), 0);

        final EditText zhField = new EditText(this);
        zhField.setHint(R.string.terms_col_zh);
        zhField.setTextSize(14f);
        box.addView(zhField);

        final EditText ptField = new EditText(this);
        ptField.setHint(R.string.terms_col_pt);
        ptField.setTextSize(14f);
        box.addView(ptField);

        new AlertDialog.Builder(this)
                .setTitle(R.string.terms_add_title)
                .setView(box)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.confirm, (dialog, which) -> {
                    String zh = zhField.getText().toString().trim();
                    String pt = ptField.getText().toString().trim();
                    if (zh.isEmpty() || pt.isEmpty()) {
                        showNote(getString(R.string.terms_add_both));
                        return;
                    }
                    termsRowsData.add(new String[] { zh, pt });
                    saveTermsDraft();
                    renderTermsTable();
                    showTermsReport(getString(R.string.terms_count, termsRowsData.size()), R.color.brand, null, null);
                })
                .show();
    }

    /**
     * 「批量导入」：一个多行框，直接粘贴。
     *
     * <p>为什么支持 Tab / 逗号 / 等号三种分隔：用户从 Excel 复制出来是 Tab，
     * 从微信/记事本是空格或等号。**不要求他统一格式**，我们认；认不出的行会明说。
     */
    private void showBatchImportDialog() {
        final EditText input = new EditText(this);
        input.setHint(R.string.terms_batch_hint);
        input.setMinLines(6);
        input.setGravity(android.view.Gravity.TOP | android.view.Gravity.START);
        input.setTextSize(13f);
        input.setTypeface(Typeface.MONOSPACE);

        new AlertDialog.Builder(this)
                .setTitle(R.string.terms_batch_title)
                .setView(input)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.confirm, (dialog, which) -> {
                    int added = importTermLines(input.getText().toString());
                    saveTermsDraft();
                    renderTermsTable();
                    if (added == 0) showNote(getString(R.string.terms_batch_none));
                    else {
                        showTermsReport(getString(R.string.terms_batch_done, added), R.color.brand, null, null);
                        // 导完立刻自动校验一遍：这是"有没有认错列"最该被看见的时刻
                        scheduleAutoValidate();
                    }
                })
                .show();
    }

    /**
     * 解析粘贴进来的文本并追加到表格。
     *
     * <p>每行按 **Tab → 逗号（半角/全角）→ 等号（半角/全角）→ 多个空格** 的顺序找第一个分隔符。
     * 只认两列；多出来的部分并进第二列（避免把葡语里的逗号切开）。
     * 空行与 `#` 开头的行跳过。
     *
     * @return 实际导入的条数
     */
    private int importTermLines(String text) {
        if (text == null) return 0;
        int added = 0;
        for (String raw : text.split("\n")) {
            String line = raw.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            String[] parts = splitTermLine(line);
            if (parts == null) continue;
            termsRowsData.add(parts);
            added += 1;
        }
        return added;
    }

    /** 把一行拆成 {中文, 葡语}；拆不出来返回 null。 */
    private static String[] splitTermLine(String line) {
        final char[] separators = { '\t', ',', '，', '=', '＝', '→' };
        for (char separator : separators) {
            int at = line.indexOf(separator);
            if (at <= 0) continue;
            String left = line.substring(0, at).trim();
            String right = line.substring(at + 1).trim();
            if (left.isEmpty() || right.isEmpty()) continue;
            return new String[] { left, right };
        }
        // 最后再试"两个以上空格"当分隔（从 Word 里粘过来常见）
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\\s{2,}").matcher(line);
        if (matcher.find() && matcher.start() > 0) {
            String left = line.substring(0, matcher.start()).trim();
            String right = line.substring(matcher.end()).trim();
            if (!left.isEmpty() && !right.isEmpty()) return new String[] { left, right };
        }
        return null;
    }

    // ── 草稿存取 ────────────────────────────────────────────────────────────

    private void saveTermsDraft() {
        org.json.JSONArray array = new org.json.JSONArray();
        for (String[] pair : termsRowsData) {
            if (pair[0].isEmpty() && pair[1].isEmpty()) continue;
            org.json.JSONArray row = new org.json.JSONArray();
            row.put(pair[0]);
            row.put(pair[1]);
            array.put(row);
        }
        prefs.edit().putString(KEY_TERMS_DRAFT, array.toString()).apply();
    }

    private void loadTermsDraft() {
        termsRowsData.clear();
        String raw = prefs.getString(KEY_TERMS_DRAFT, "");
        if (raw == null || raw.isEmpty()) return;
        try {
            org.json.JSONArray array = new org.json.JSONArray(raw);
            for (int index = 0; index < array.length(); index += 1) {
                org.json.JSONArray row = array.optJSONArray(index);
                if (row == null) continue;
                termsRowsData.add(new String[] { row.optString(0, ""), row.optString(1, "") });
            }
        } catch (org.json.JSONException error) {
            // 草稿坏了就当没有：它只是"上次改到一半的东西"，绝不能影响使用
            termsRowsData.clear();
        }
    }

    // ── 三个动作：校验 / 上传 / 从电脑拉取 ──────────────────────────────────

    /**
     * 把表格变成条目数组（空行跳过）。
     *
     * <p>**不在手机上判合法性**：校验一律由电脑做（`POST /terms/validate`），
     * 否则会出现"手机上通过、真上传被拒"这种最难解释的情况。
     */
    private org.json.JSONArray collectTermEntries() {
        org.json.JSONArray entries = new org.json.JSONArray();
        for (String[] pair : termsRowsData) {
            String zh = pair[0] == null ? "" : pair[0].trim();
            String pt = pair[1] == null ? "" : pair[1].trim();
            if (zh.isEmpty() && pt.isEmpty()) continue;
            try {
                org.json.JSONObject entry = new org.json.JSONObject();
                entry.put("zh", zh);
                entry.put("pt", pt);
                entries.put(entry);
            } catch (org.json.JSONException ignored) {
                // 理论上不会发生；真发生了就跳过这一行，不中断整体
            }
        }
        return entries;
    }

    private void runTermsAction(final String action) {
        // 身份 = token（由「设置 → 账户」登录得到），不再让这一页填用户名
        if (client != null) client.setToken(accountToken());

        // 上传前先跑一遍本地检查：明显不合法的直接说清楚，不发请求（也就不会白等一次往返）
        if ("upload".equals(action)) {
            String local = localTermProblems(collectTermEntries());
            if (local != null) {
                showTermsReport(getString(R.string.terms_status_local_invalid), R.color.err, null, local);
                return;
            }
        }

        if (client == null) {
            showTermsReport(getString(R.string.terms_status_need_connect), R.color.err, null, null);
            return;
        }
        if (loggedIn() == false) {
            showTermsReport(getString(R.string.terms_need_login), R.color.err, null, null);
            return;
        }
        final org.json.JSONArray entries = collectTermEntries();
        showTermsReport(getString(R.string.terms_status_working), R.color.warn, null, null);

        new Thread(() -> {
            String status;
            int color = R.color.brand;
            org.json.JSONObject warnings = null;
            org.json.JSONObject rejected = null;
            String loadedRows = null;
            try {
                if ("load".equals(action)) {
                    org.json.JSONObject result = client.termsGet();
                    org.json.JSONObject json = result.optJSONObject("json");
                    int code = result.optInt("code", 0);
                    if (code != 200) {
                        status = getString(R.string.terms_status_failed, describeTermsError(json, code));
                        color = R.color.err;
                    } else {
                        org.json.JSONArray rows = json == null ? null : json.optJSONArray("entries");
                        int count = rows == null ? 0 : rows.length();
                        loadedRows = rows == null ? "" : rows.toString();
                        status = getString(R.string.terms_status_loaded, count);
                    }
                } else {
                    org.json.JSONObject result = client.termsPut(entries);
                    org.json.JSONObject json = result.optJSONObject("json");
                    int code = result.optInt("code", 0);
                    if (code == 200 && json != null && json.optBoolean("ok", false)) {
                        int previous = json.optInt("previousEntries", 0);
                        status = json.optBoolean("overwritten", false)
                                ? getString(R.string.terms_status_uploaded_overwrite, entries.length(), previous)
                                : getString(R.string.terms_status_uploaded, entries.length());
                        warnings = json;
                    } else {
                        int bad = json == null || json.optJSONArray("rejected") == null ? 0 : json.optJSONArray("rejected").length();
                        status = getString(R.string.terms_status_invalid, Math.max(bad, 1));
                        color = R.color.err;
                        rejected = json;
                    }
                }
            } catch (Exception error) {
                status = getString(R.string.terms_status_failed, String.valueOf(error.getMessage()));
                color = R.color.err;
                loadedRows = null;
            }
            final String finalStatus = status;
            final int finalColor = color;
            final org.json.JSONObject finalWarnings = warnings;
            final org.json.JSONObject finalRejected = rejected;
            final String finalRows = loadedRows;
            main.post(() -> {
                if (finalRows != null) applyLoadedRows(finalRows);
                showTermsReport(finalStatus, finalColor,
                        termProblems(finalWarnings, "warnings", java.util.Collections.emptyList()),
                        termProblems(finalRejected, "rejected", java.util.Collections.emptyList()));
            });
        }, "terms-action").start();
    }

    /** 把电脑上的条目填回表格（拉取后**直接覆盖**本地草稿：以电脑为准）。 */
    private void applyLoadedRows(String rowsJson) {
        try {
            org.json.JSONArray rows = new org.json.JSONArray(rowsJson);
            termsRowsData.clear();
            for (int index = 0; index < rows.length(); index += 1) {
                org.json.JSONObject row = rows.optJSONObject(index);
                if (row == null) continue;
                termsRowsData.add(new String[] { row.optString("zh", ""), row.optString("pt", "") });
            }
            saveTermsDraft();
            renderTermsTable();
        } catch (org.json.JSONException error) {
            showNote("读取电脑端数据失败：" + error.getMessage());
        }
    }

    /**
     * 把服务端返回的 `warnings` / `rejected` 渲染成给人看的几行。
     *
     * <p>`index` 是**条目下标**（0 起），用户看的是表格第几行 —— 所以这里统一按
     * "第 N 条"说，并在界面上把条数显示出来，让他对得上。
     */
    private static String termProblems(org.json.JSONObject payload, String key, java.util.List<Integer> badLines) {
        StringBuilder out = new StringBuilder();
        org.json.JSONArray items = payload == null ? null : payload.optJSONArray(key);
        if (items != null) {
            for (int index = 0; index < items.length(); index += 1) {
                org.json.JSONObject item = items.optJSONObject(index);
                if (item == null) continue;
                int at = item.optInt("index", -1);
                if (out.length() > 0) out.append('\n');
                out.append(at >= 0 ? ("第 " + (at + 1) + " 条：") : "").append(item.optString("reason", ""));
            }
        }
        for (Integer line : badLines) {
            if (out.length() > 0) out.append('\n');
            out.append("第 ").append(line).append(" 行看不懂");
        }
        return out.length() == 0 ? null : out.toString();
    }

    private static String describeTermsError(org.json.JSONObject json, int code) {
        if (json == null) return "HTTP " + code;
        String hint = json.optString("hint", "");
        String error = json.optString("error", "");
        String text = error.isEmpty() ? hint : (hint.isEmpty() ? error : error + "：" + hint);
        return text.isEmpty() ? ("HTTP " + code) : text;
    }

    /** 渲染结果区：状态行 + 提醒 + 拒绝原因。三块各自可空。 */
    private void showTermsReport(String status, int colorRes, String warnings, String rejected) {
        if (termsStatusText != null) {
            termsStatusText.setText(status);
            termsStatusText.setTextColor(getColor(colorRes));
        }
        if (termsWarnTitleView != null && termsWarnBodyView != null) {
            boolean show = warnings != null && !warnings.isEmpty();
            termsWarnTitleView.setVisibility(show ? View.VISIBLE : View.GONE);
            termsWarnBodyView.setVisibility(show ? View.VISIBLE : View.GONE);
            if (show) termsWarnBodyView.setText(warnings);
        }
        if (termsRejectTitleView != null && termsRejectBodyView != null) {
            boolean show = rejected != null && !rejected.isEmpty();
            termsRejectTitleView.setVisibility(show ? View.VISIBLE : View.GONE);
            termsRejectBodyView.setVisibility(show ? View.VISIBLE : View.GONE);
            if (show) termsRejectBodyView.setText(rejected);
        }
    }

    private void buildSettingsPage() {
        // 注意：账户那一行要等 settingsPage 建好、且 showPage 时再刷一遍（见 refreshSettingsPage）
        settingsPage = LayoutInflater.from(this).inflate(R.layout.page_settings, pageHost, false);
        settingsPage.setVisibility(View.GONE);
        pageHost.addView(settingsPage);

        settingsServerState = settingsPage.findViewById(R.id.settingsServerState);
        settingsOutputState = settingsPage.findViewById(R.id.settingsOutputState);
        diagnosticsText = settingsPage.findViewById(R.id.diagnosticsText);
        fontValue = settingsPage.findViewById(R.id.fontValue);
        themeSystemView = settingsPage.findViewById(R.id.themeSystem);
        themeLightView = settingsPage.findViewById(R.id.themeLight);
        themeDarkView = settingsPage.findViewById(R.id.themeDark);
        modeBilingualView = settingsPage.findViewById(R.id.modeBilingual);
        modeTargetOnlyView = settingsPage.findViewById(R.id.modeTargetOnly);

        settingsPage.findViewById(R.id.settingsConnectRow).setOnClickListener(v -> openConnectPage());
        settingsPage.findViewById(R.id.settingsOutputRow).setOnClickListener(v -> openOutputSheet());
        settingsPage.findViewById(R.id.settingsGlassesRow).setOnClickListener(v -> openGlassesPreview());
        settingsPage.findViewById(R.id.settingsTypeRow).setOnClickListener(v -> promptManualText());
        settingsAccountState = settingsPage.findViewById(R.id.settingsAccountState);
        settingsPage.findViewById(R.id.settingsAccountRow).setOnClickListener(v -> openAccountPage());
        settingsProofreadSwitch = settingsPage.findViewById(R.id.settingsProofreadSwitch);
        settingsProofreadState = settingsPage.findViewById(R.id.settingsProofreadState);
        // 整行可点：Switch 本身只有 48dp 宽，点行更省事（和开发者开关同一套做法）
        settingsProofreadSwitch.setClickable(false);
        settingsPage.findViewById(R.id.settingsProofreadRow)
                .setOnClickListener(v -> toggleProofread());
        themeSystemView.setOnClickListener(v -> setThemeMode("system"));
        themeLightView.setOnClickListener(v -> setThemeMode("light"));
        themeDarkView.setOnClickListener(v -> setThemeMode("dark"));
        settingsPage.findViewById(R.id.fontDown).setOnClickListener(v -> stepFontScale(-1));
        settingsPage.findViewById(R.id.fontUp).setOnClickListener(v -> stepFontScale(1));
        modeBilingualView.setOnClickListener(v -> setBilingual(true));
        modeTargetOnlyView.setOnClickListener(v -> setBilingual(false));

        developerSwitch = settingsPage.findViewById(R.id.developerSwitch);
        developerRow = settingsPage.findViewById(R.id.developerRow);
        experimentsHeader = settingsPage.findViewById(R.id.experimentsHeader);
        experimentsCard = settingsPage.findViewById(R.id.settingsTypeRow);
        diagnosticsHeader = settingsPage.findViewById(R.id.diagnosticsHeader);
        diagnosticsCard = settingsPage.findViewById(R.id.diagnosticsCard);
        developerSwitch.setChecked(developerMode);
        // 整个卡片都能点：Switch 本身只有 48dp 宽，点卡片更省事，也更好按
        developerRow.setOnClickListener(v -> setDeveloperMode(!developerSwitch.isChecked()));
        developerSwitch.setOnCheckedChangeListener((button, checked) -> setDeveloperMode(checked));
        applyDeveloperMode();
    }

    /**
     * 开发者模式开关：只有打开时才显示「实验」与「诊断」。
     *
     * 为什么不干脆一直显示：那两段是排障用的（手输一句话绕过语音识别、
     * 连接与管道的原始计数），日常使用时看到只会困惑；
     * 而它们又必须留着 —— 出问题时"是不是语音那一环坏了"这个问题，
     * 只有靠手输通道才能一秒回答。
     */
    private void setDeveloperMode(boolean enabled) {
        developerMode = enabled;
        prefs.edit().putBoolean(KEY_DEVELOPER, enabled).apply();
        if (developerSwitch.isChecked() != enabled) developerSwitch.setChecked(enabled);
        applyDeveloperMode();
    }

    private void applyDeveloperMode() {
        int visibility = developerMode ? View.VISIBLE : View.GONE;
        experimentsHeader.setVisibility(visibility);
        experimentsCard.setVisibility(visibility);
        diagnosticsHeader.setVisibility(visibility);
        diagnosticsCard.setVisibility(visibility);
    }

    private void refreshSettingsPage() {
        settingsServerState.setText(online()
                ? getString(R.string.connect_ok, deviceName)
                : getString(R.string.not_connected));
        settingsOutputState.setText(R.string.output_subtitle_only);
        fontValue.setText(Math.round(fontScale * 100) + "%");
        paintChoice(themeSystemView, "system".equals(themeMode));
        paintChoice(themeLightView, "light".equals(themeMode));
        paintChoice(themeDarkView, "dark".equals(themeMode));
        paintChoice(modeBilingualView, bilingual);
        paintChoice(modeTargetOnlyView, !bilingual);
        // 账户那一行：每次进设置页都刷一遍（用户可能刚在账户页登录或注销）
        renderAccount();
        refreshDiagnostics();
    }

    private void paintChoice(TextView view, boolean selected) {
        view.setBackgroundResource(selected ? R.drawable.tap_pill_active : R.drawable.tap_pill);
        view.setTextColor(getColor(selected ? R.color.on_brand : R.color.ink));
    }

    private void setThemeMode(String mode) {
        if (mode.equals(themeMode)) return;
        themeMode = mode;
        prefs.edit().putString(KEY_THEME, mode).apply();
        // 配置变了要重建 Activity 才会重新解析资源（深色值是资源限定符决定的）
        recreate();
    }

    private void stepFontScale(int direction) {
        float next = Math.round((fontScale + direction * 0.1f) * 10f) / 10f;
        next = Math.max(0.8f, Math.min(1.6f, next));
        if (next == fontScale) return;
        fontScale = next;
        prefs.edit().putFloat(KEY_SCALE, fontScale).apply();
        subtitles.setScale(fontScale);
        if (fullscreenList != null) fullscreenList.setScale(fontScale);
        if (fontValue != null) fontValue.setText(Math.round(fontScale * 100) + "%");
    }

    private void setBilingual(boolean value) {
        bilingual = value;
        prefs.edit().putBoolean(KEY_BILINGUAL, value).apply();
        subtitles.setBilingual(value);
        if (fullscreenList != null) fullscreenList.setBilingual(value);
        if (settingsPage != null) {
            paintChoice(modeBilingualView, value);
            paintChoice(modeTargetOnlyView, !value);
        }
        if (livePage != null) {
            ((TextView) livePage.findViewById(R.id.toolMode))
                    .setText(value ? R.string.mode_bilingual : R.string.mode_translation_only);
        }
    }

    private void toggleBilingual() {
        setBilingual(!bilingual);
    }

    private void refreshDiagnostics() {
        if (diagnosticsText == null) return;
        StringBuilder text = new StringBuilder();
        text.append("电脑：").append(host().isEmpty() ? "（未配置）" : host()).append('\n');
        text.append("连接：").append(online() ? "已握手" : "未连接").append('\n');
        text.append("服务证据：字幕 ").append(framesSeen).append(" 帧");
        text.append(busSeen ? "（总线见过）" : "（还没见过总线）");
        text.append(" · 收件箱 ").append(inboxLines).append(" 行\n");
        // 音源要显示出来：出问题时第一个要回答的就是"声音到底从哪儿来的"。
        // 没在录时显示**配置**（下一次会用哪个），在录时显示**实际在用的那个**。
        text.append("音源：").append(uploader != null && uploader.isRunning()
                ? uploader.name() : (preferGlassesMic() ? "眼镜麦克风（下次用）" : "手机麦克风（下次用）"))
            .append('\n');
        text.append("采样率：").append(uploader != null && uploader.isRunning()
                ? uploader.getSampleRate() + " Hz" : "未录音").append('\n');
        // ★ 安卓报的**实际**输入设备。这一行是"眼镜收音"这个结论的唯一硬证据：
        //   SDK 内部到底选了眼镜还是手机内置麦克风，从我们的代码里看不出来，
        //   只能问系统。做对比实验时必须看这一行。
        AudioManager audioManager =
                (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        String verdict = AudioDevices.verdict(audioManager);
        if (!verdict.isEmpty()) text.append("实际输入：").append(verdict).append('\n');
        text.append("录音设备：").append(AudioDevices.activeInputs(audioManager)).append('\n');
        text.append("USB 输入：").append(AudioDevices.usbInputs(audioManager)).append('\n');
        if (!uploadProgress.isEmpty()) text.append(uploadProgress).append('\n');
        text.append("已保存记录：").append(records.load().size()).append(" 条\n");
        text.append("麦克风门槛（仅界面提示）：").append(UI_SPEECH_RMS).append('\n');
        if (!lastError.isEmpty()) text.append("最近错误：").append(lastError).append('\n');
        text.append("\n（切句、识别、翻译都在电脑上；手机上只做收音与显示）");
        diagnosticsText.setText(text.toString());
    }

    private void promptManualText() {
        final EditText field = new EditText(this);
        field.setHint(R.string.settings_type_text);
        new AlertDialog.Builder(this)
                .setTitle(R.string.settings_type_text)
                .setView(field)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.settings_send, (dialog, which) -> {
                    String text = field.getText().toString().trim();
                    if (text.isEmpty()) return;
                    if (!online()) {
                        toast(getString(R.string.reason_need_connection));
                        return;
                    }
                    client.sendText(text, sourceLang);
                })
                .show();
    }

    // ── 底部弹层 ────────────────────────────────────────────────────────────

    /** 简单弹层：半透明遮罩 + 底部内容。点遮罩关闭。 */
    private void showSheet(int layoutRes) {
        overlayHost.removeAllViews();
        FrameLayout wrapper = new FrameLayout(this);
        wrapper.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        View scrim = new View(this);
        scrim.setBackgroundColor(0x99000000);
        scrim.setOnClickListener(v -> closeOverlay());
        wrapper.addView(scrim, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        View sheet = LayoutInflater.from(this).inflate(layoutRes, wrapper, false);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.gravity = Gravity.BOTTOM;
        wrapper.addView(sheet, params);
        overlayHost.addView(wrapper);
        overlayHost.setVisibility(View.VISIBLE);
        overlayRoot = sheet;
    }

    private void openLanguageSheet(final boolean forSource) {
        showSheet(R.layout.sheet_language);
        ((TextView) overlayRoot.findViewById(R.id.langSheetTitle))
                .setText(forSource ? R.string.pick_source_lang : R.string.pick_target_lang);
        ((TextView) overlayRoot.findViewById(R.id.langSheetNote))
                .setText(R.string.lang_supported_note);
        LinearLayout list = overlayRoot.findViewById(R.id.langSheetList);
        // 服务支持的语言就是这两种 —— 不编造更多语种来撑场面
        addLanguageRow(list, "pt-BR", R.string.lang_pt_full, R.string.lang_pt_note, forSource);
        addLanguageRow(list, "zh-CN", R.string.lang_zh_full, R.string.lang_zh_note, forSource);
    }

    private void addLanguageRow(LinearLayout list, final String code, int nameRes, int noteRes,
                                final boolean forSource) {
        View row = LayoutInflater.from(this).inflate(R.layout.item_language, list, false);
        ((TextView) row.findViewById(R.id.langName)).setText(nameRes);
        ((TextView) row.findViewById(R.id.langNote)).setText(noteRes);
        boolean selected = forSource ? code.equals(sourceLang) : code.equals(targetLang());
        row.findViewById(R.id.langCheck).setVisibility(selected ? View.VISIBLE : View.GONE);
        row.findViewById(R.id.langCheck).setAlpha(1f);
        ((ImageView) row.findViewById(R.id.langCheck))
                .setColorFilter(getColor(R.color.brand));
        row.setOnClickListener(v -> {
            if (forSource) sourceLang = code;
            prefs.edit().putString(KEY_LANG, sourceLang).apply();
            applyLanguageLabels();
            if (uploader != null) uploader.setLanguage(sourceLang);
            if (session != null && session.active) renderSessionState();
            closeOverlay();
        });
        list.addView(row);
    }

    private void openOutputSheet() {
        showSheet(R.layout.sheet_output);
        // 只有"仅字幕"是可选项：当前服务不提供译文语音，所以"播放译文"保持禁用
        overlayRoot.findViewById(R.id.outputSubtitleOnly).setOnClickListener(v -> closeOverlay());
        overlayRoot.findViewById(R.id.outputCheck).setAlpha(1f);
        ((ImageView) overlayRoot.findViewById(R.id.outputCheck))
                .setColorFilter(getColor(R.color.brand));
        ((TextView) overlayRoot.findViewById(R.id.outputDeviceName))
                .setText(R.string.output_phone_speaker);
        overlayRoot.findViewById(R.id.outputWarning).setVisibility(View.VISIBLE);
        overlayRoot.findViewById(R.id.outputPlayTranslation).setEnabled(false);
    }

    // ── 全屏字幕 ────────────────────────────────────────────────────────────

    private SubtitleList fullscreenList;

    private void openFullscreen() {
        View view = pushOverlay(R.layout.overlay_fullscreen);
        fullscreenList = new SubtitleList(LayoutInflater.from(this),
                view.findViewById(R.id.fsScroll),
                view.findViewById(R.id.fsList),
                view.findViewById(R.id.fsBackToLatest));
        fullscreenList.setBilingual(bilingual);
        fullscreenList.setScale(fontScale);
        // 把已有片段搬过去（同一个会话，两边看到的内容必须一致）
        for (SubtitleList.Segment segment : subtitles.segments()) {
            fullscreenList.submit(segment.time, segment.source, segment.target, segment.partial);
        }
        view.findViewById(R.id.fsExit).setOnClickListener(v -> closeOverlay());
        view.findViewById(R.id.fsPause).setOnClickListener(v -> {
            togglePause();
            renderFullscreenStatus(view);
        });
        renderFullscreenStatus(view);
    }

    private void renderFullscreenStatus(View view) {
        boolean paused = session != null && session.paused;
        ((TextView) view.findViewById(R.id.fsStatus)).setText(paused
                ? R.string.paused : R.string.interpreting);
        ((ImageView) view.findViewById(R.id.fsPauseIcon))
                .setImageResource(paused ? R.drawable.ic_play : R.drawable.ic_pause);
        ((TextView) view.findViewById(R.id.fsPauseLabel))
                .setText(paused ? R.string.resume : R.string.pause);
    }

    // ── 眼镜预览（开发者用途）────────────────────────────────────────────────

    /** 「投屏样例」下面那行提示（没投屏 / 已投屏 N 行 N 页 / 同传在跑）。 */
    private TextView glassesSampleNote = null;
    /** 上一次检查时缺了几项眼镜权限（诊断用）。 */
    private int glassesPermMissing = 0;

    /**
     * 真眼镜那一行：状态文字 + 「投屏 / 停止投屏」按钮。
     * <p>页面关着时是 null —— 所有写入都要先判空，否则在别的页面收到状态回调会 NPE。
     */
    private TextView glassesRealStatus = null;
    private TextView glassesRealToggle = null;
    /** 当前投屏画布用了什么尺寸（诊断用）：读到真实分辨率、还是交给 SDK 测量。 */
    private String glassesCanvasNote = "画布未定";

    // ── 眼镜显示微调（真机上才调得出来）─────────────────────────────────────
    //
    // 这组值来自真机反馈："字太小"、"投射在右眼上，过于靠右的内容看不清"。
    // 眼镜上的实际观感取决于光波导放大率、佩戴位置、环境亮度 —— 在电脑上推不出来。
    // 而投屏是**实时采样那块 View**，所以调完立刻在眼镜上生效：
    // 用户戴着眼镜按加减，当场就能调到顺眼，不用重新打包。
    //
    // ⚠️ 字号从"一个倍率"改成了"两个绝对值（像素）"，**中葡分开**。
    //    为什么不再用倍率：倍率是相对某个基准算的，而基准本身（画布高度、
    //    行高系数）在不同的眼镜/分辨率下会变 —— 用户调到一个顺眼的 ×1.35，
    //    换台设备就不是同一个视觉大小了。绝对值 px 才是"看到多大就是多大"。
    //    为什么中葡分开：汉字是方块字、葡语是拉丁字母，同样 px 下葡语的
    //    x-height 只有约 0.5em，观感明显偏小；两者要各自一个数才对得上。
    private static final String KEY_GLASSES_FONT_ZH = "glassesFontZh";
    private static final String KEY_GLASSES_FONT_PT = "glassesFontPt";
    private static final String KEY_GLASSES_MARGIN_R = "glassesMarginRight";
    private static final String KEY_GLASSES_MARGIN_L = "glassesMarginLeft";
    /** 音源：true=优先眼镜麦克风（缺省），false=始终用手机麦克风。 */
    private static final String KEY_MIC_SOURCE = "useGlassesMic";
    /** 长句翻页间隔（毫秒）。真机上可调 —— 多快换页只有戴上才知道。 */
    private static final String KEY_GLASSES_PAGE_DELAY = "glassesPageDelay";
    private static final int DEFAULT_GLASSES_PAGE_DELAY = 1600;
    /**
     * 相机预览背景：把摄像头画面垫在字幕底下。
     *
     * <p>缺省**关**（样例里三处用法全传 false，而且眼镜是透视的，真实世界本来就看得见）。
     * 但"开着是不是效果更好"只有戴上才知道，所以做成开关让用户自己验证。
     */
    private static final String KEY_GLASSES_CAMERA_BG = "glassesCameraBackground";

    private boolean glassesCameraBackground() {
        return prefs.getBoolean(KEY_GLASSES_CAMERA_BG, false);
    }

    private int glassesPageDelayMs() {
        return prefs.getInt(KEY_GLASSES_PAGE_DELAY, DEFAULT_GLASSES_PAGE_DELAY);
    }

    /** 调翻页间隔并立刻生效。 */
    private void nudgePageDelay(int deltaMs) {
        int next = Math.max(400, Math.min(8000, glassesPageDelayMs() + deltaMs));
        prefs.edit().putInt(KEY_GLASSES_PAGE_DELAY, next).apply();
        if (glassesView != null) glassesView.setPageDelayMs(next);
        renderTuningValues();
    }
    /**
     * 缺省字号（像素，投屏画布上的绝对大小）。
     *
     * <p>缺省值不是拍脑袋来的：眼镜分辨率 640×400，去掉左右留白后可用宽约 474px，
     * 可用高约 340px。**下界 31.6px**（见 {@link GlassesSubtitleView#FONT_FLOOR_PX}）
     * 是戴过之后给的结论：再小就看不清了。所以缺省取 40px，落在"看得清"那一侧，
     * 用户嫌大可以往下调到 32 附近。
     *
     * <p><b>为什么中葡缺省一样是 40px</b>（原来给葡语 44px，理由是"拉丁 x-height 只有
     * 约 0.5em，同 px 看着更小"）—— 那条理由本身没错，但它只管"看着多大"，
     * 而真正把葡语卡住的是**翻页**：葡语一行放的字更多，可它**按单词换行**，
     * 每行末尾都要浪费几个字符的宽度。拿真实那句译文（88 字符）手算：
     *
     * <pre>
     *   字号    每行约几个字符   实际排几行   一页几行   结果
     *   44px   21              6            5         要翻页  ← 一句普通句子就翻页
     *   40px   23              5            6         一页放下
     *   36px   26              5            6         一页放下
     * </pre>
     *
     * <p>一句普通句子的译文就撞上翻页，代价太大 —— 而且用户此前专门查过
     * "为什么只剩几个词也要翻页"，说明翻页本身就是要尽量避开的。
     * 所以葡语也取 40px：**可读性上它仍然高于中文字号的下界**
     * （中文下界 31.6px 是"笔画密的方块字刚能看清"，拉丁 40px 的 cap height 约 29px，
     * 远比那宽松），同时把常见的单句译文留在了一页之内。
     *
     * <p>两个旋钮仍然分开：字"看着够不够大"和"一页放不放得下"是两件事，
     * 佩戴者可能想把葡语调大、同时把中文调小。上面的数字只是**起点**，
     * 真正的判据是那两句样例在真机上的「排版自检」结果。
     */
    private static final float DEFAULT_GLASSES_FONT_ZH = 40f;
    private static final float DEFAULT_GLASSES_FONT_PT = 40f;
    private static final int DEFAULT_GLASSES_MARGIN_R = 22;
    private static final int DEFAULT_GLASSES_MARGIN_L = 4;

    /**
     * 把字号夹在 [下界, 上界] 里。**这是字号进入 App 的唯一入口** ——
     * 读偏好、按加减、将来加"直接输入"都要过这一道，
     * 这样"上界/下界"是**一个事实**，而不是散在各个调用点上的一条约定。
     *
     * <p>为什么要夹在**读**的时候、而不只是夹在"按加减"的时候：
     * 之前把上界写成 110px，如果谁存过一个更大的值（或者以后改了上界），
     * 那个值会一直被用下去，界面上还显示得好好的。夹在入口就堵住了这种陈旧值。
     */
    private float clampGlassesFont(float px) {
        return Math.max(GlassesSubtitleView.FONT_FLOOR_PX,
                Math.min(GlassesSubtitleView.FONT_CEIL_PX, px));
    }

    private float glassesFontZh() {
        return clampGlassesFont(prefs.getFloat(KEY_GLASSES_FONT_ZH, DEFAULT_GLASSES_FONT_ZH));
    }

    private float glassesFontPt() {
        return clampGlassesFont(prefs.getFloat(KEY_GLASSES_FONT_PT, DEFAULT_GLASSES_FONT_PT));
    }

    private int glassesMarginRight() {
        return prefs.getInt(KEY_GLASSES_MARGIN_R, DEFAULT_GLASSES_MARGIN_R);
    }

    private int glassesMarginLeft() {
        return prefs.getInt(KEY_GLASSES_MARGIN_L, DEFAULT_GLASSES_MARGIN_L);
    }

    /**
     * 把当前微调应用到眼镜那块 View，并刷新数值显示。
     *
     * <p>**实时生效**，不需要停投屏、不需要重投 —— 投屏本来就是持续采样这块 View，
     * 改字号/留白/可见性都会在下一帧反映到眼镜上。用户在眼镜上一边看一边按即可。
     *
     * <p>⚠️ 这里曾经绕了一大圈：真机上"调字号闪退"，我按"抓不到 Java 堆栈 =
     * 原生崩溃"推断是**改被采样的 View 有数据竞争**，于是加了
     * "停投屏 → 等 400ms → 改 → 重投"（还配了 700ms 防抖）。
     * 后来拿到真正的堆栈才发现**推断错了**，真实原因是
     * {@code root} 的 LayoutParams 用了裸的 {@code ViewGroup.LayoutParams}，
     * 而父容器是 FrameLayout —— 见 {@link GlassesSubtitleView} 里那段长注释。
     *
     * <p>既然是那个原因，停投屏/重投就是多余的，而且让校准变得很难用
     * （每按一下黑一秒，而校准恰恰需要连续微调）。所以撤掉了。
     * 教训：**先拿到证据再改设计**；"没有堆栈"只能推出"不是 Java 崩溃"，
     * 推不出"是数据竞争"。
     */
    private void applyGlassesTuning() {
        if (glassesView != null) {
            glassesView.setTuning(
                    glassesFontZh(), glassesFontPt(),
                    glassesMarginRight(), glassesMarginLeft());
        }
        renderTuningValues();
    }

    /**
     * 调一个微调值，立刻生效。
     *
     * @param key   {@link #KEY_GLASSES_FONT_ZH} / {@link #KEY_GLASSES_FONT_PT}
     *              / {@link #KEY_GLASSES_MARGIN_R} / {@link #KEY_GLASSES_MARGIN_L}
     * @param delta 增量（字号是像素步进，留白是百分点）
     */
    private void nudgeGlassesTuning(String key, float delta) {
        CrashLog.beginAction(this, "调整眼镜显示参数");
        if (KEY_GLASSES_FONT_ZH.equals(key) || KEY_GLASSES_FONT_PT.equals(key)) {
            boolean zh = KEY_GLASSES_FONT_ZH.equals(key);
            float current = zh ? glassesFontZh() : glassesFontPt();
            // 下界用**戴出来的那条**（31.6px），不是随手拍的 24px：
            // 用户自己在真机上量过"再小就看不清了"，那就不该让他能调下去 ——
            // 调下去的结果不是"报错"，而是"整场没看清"，没人会来报。
            // 上下界都在 GlassesSubtitleView 里定义、并各有注释说明来历：
            // 下界 31.6px 是**戴上量出来的**，上界 64px 是**算出来的**（防呆 + 保底体验）。
            // 这里只负责"用它们"，不重新定值 —— 免得两个地方各写一个数。
            float next = clampGlassesFont(Math.round(current + delta));
            prefs.edit().putFloat(key, next).apply();
        } else {
            int current = KEY_GLASSES_MARGIN_R.equals(key) ? glassesMarginRight() : glassesMarginLeft();
            int next = Math.max(0, Math.min(60, current + Math.round(delta)));
            prefs.edit().putInt(key, next).apply();
        }
        applyGlassesTuning();
        CrashLog.endAction(this);
    }

    /** 刷新相机预览背景那一行的文案。 */
    private void renderCameraLabel() {
        if (overlayRoot == null) return;
        TextView label = overlayRoot.findViewById(R.id.glassesCameraLabel);
        if (label == null) return;
        label.setText(glassesCameraBackground()
                ? R.string.glasses_camera_bg_on : R.string.glasses_camera_bg);
    }

    /** 刷新音源那一行的文案。 */
    private void renderMicSourceLabel() {
        if (overlayRoot == null) return;
        TextView label = overlayRoot.findViewById(R.id.glassesMicLabel);
        if (label == null) return;
        boolean glassesFirst = preferGlassesMic();
        label.setText(glassesFirst
                ? R.string.glasses_mic_source : R.string.glasses_mic_source_phone);
    }

    /** 只刷新"当前值"那几个数字。 */
    private void renderTuningValues() {
        if (overlayRoot == null) return;
        TextView fontZh = overlayRoot.findViewById(R.id.glassesFontZhValue);
        TextView fontPt = overlayRoot.findViewById(R.id.glassesFontPtValue);
        TextView right = overlayRoot.findViewById(R.id.glassesRightValue);
        TextView left = overlayRoot.findViewById(R.id.glassesLeftValue);
        TextView page = overlayRoot.findViewById(R.id.glassesPageValue);
        // 到底了就把"下限"写出来 —— 按了没反应会让人以为坏了，
        // 写出来才知道"是系统不让，不是按钮坏了"。
        if (fontZh != null) fontZh.setText(fontLabel(glassesFontZh()));
        if (fontPt != null) fontPt.setText(fontLabel(glassesFontPt()));
        if (right != null) right.setText(glassesMarginRight() + "%");
        if (left != null) left.setText(glassesMarginLeft() + "%");
        if (page != null) {
            page.setText(String.format(Locale.US, "%.1fs", glassesPageDelayMs() / 1000f));
        }
    }

    /** 字号那一格的文案（在上下界上就标出来）。 */
    private String fontLabel(float px) {
        String base = String.format(Locale.US, "%.0fpx", px);
        if (px <= GlassesSubtitleView.FONT_FLOOR_PX + 0.01f) return base + "（下限）";
        if (px >= GlassesSubtitleView.FONT_CEIL_PX - 0.01f) return base + "（上限）";
        return base;
    }

    private void openGlassesPreview() {
        View view = pushOverlay(R.layout.overlay_glasses);
        glassesSampleNote = view.findViewById(R.id.glassesSampleNote);
        // 每次打开都重新问一遍权限状态 —— 用户可能刚去设置里开过
        glassesPermMissing = 0;
        for (String permission : glassesPermissions()) {
            if (ContextCompat.checkSelfPermission(this, permission)
                    != PackageManager.PERMISSION_GRANTED) {
                glassesPermMissing += 1;
            }
        }
        view.findViewById(R.id.glassesBack).setOnClickListener(v -> closeOverlay());
        // 标题上带**版本号**：真机验证时第一件要确认的事是"装的到底是不是新版"。
        //  没有这个，很容易出现"改了但装的是旧包，然后一起怀疑代码"。
        TextView title = view.findViewById(R.id.glassesTitle);
        if (title != null) title.setText(getString(R.string.glasses_preview_title) + " · v" + appVersion());

        // 显示微调：调完立刻在眼镜上生效（投屏是实时采样）
        view.findViewById(R.id.glassesFontZhMinus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_FONT_ZH, -2f));
        view.findViewById(R.id.glassesFontZhPlus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_FONT_ZH, 2f));
        view.findViewById(R.id.glassesFontPtMinus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_FONT_PT, -2f));
        view.findViewById(R.id.glassesFontPtPlus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_FONT_PT, 2f));
        // 排版自检：真机上真的排一遍，把"一行几个字/一页几行"报出来
        view.findViewById(R.id.glassesSelfCheck).setOnClickListener(v -> showGlassesSelfCheck());

        // 真眼镜状态行 + 手动投屏开关
        glassesRealStatus = view.findViewById(R.id.glassesRealStatus);
        glassesRealToggle = view.findViewById(R.id.glassesRealToggle);
        glassesRealToggle.setOnClickListener(v -> toggleGlassesCast());

        // ── 投屏样例 ───────────────────────────────────────────────────────
        // 点例句 → 走**真实投屏路径**推到眼镜上。这样"改了字号 → 眼镜上什么样"
        // 是同一个事实，中间没有模型去近似。理由见 overlay_glasses.xml 里那段注释。
        buildSampleChips(view.findViewById(R.id.glassesSamplesZh),
                R.array.glasses_sample_zh_label, R.array.glasses_sample_zh);
        buildSampleChips(view.findViewById(R.id.glassesSamplesPt),
                R.array.glasses_sample_pt_label, R.array.glasses_sample_pt);
        view.findViewById(R.id.glassesSampleSend).setOnClickListener(v -> {
            EditText input = view.findViewById(R.id.glassesSampleInput);
            String typed = input == null ? "" : input.getText().toString().trim();
            if (typed.isEmpty()) {
                setSampleNote(getString(R.string.glasses_sample_need_text), true);
                return;
            }
            pushSample(typed);
        });
        setSampleNote(getString(R.string.glasses_sample_hint), false);
        view.findViewById(R.id.glassesRightMinus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_MARGIN_R, -2));
        view.findViewById(R.id.glassesRightPlus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_MARGIN_R, 2));
        view.findViewById(R.id.glassesLeftMinus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_MARGIN_L, -2));
        view.findViewById(R.id.glassesLeftPlus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_MARGIN_L, 2));
        view.findViewById(R.id.glassesPageMinus).setOnClickListener(v -> nudgePageDelay(-400));
        view.findViewById(R.id.glassesPagePlus).setOnClickListener(v -> nudgePageDelay(400));
        // 边界标尺：戴上眼镜看一眼就知道哪一部分看不见。
        // 立刻生效 —— 和微调一样，投屏是持续采样的。
        view.findViewById(R.id.glassesRulerToggle).setOnClickListener(v -> {
            if (glassesView == null) return;
            CrashLog.beginAction(this, "开关边界标尺");
            boolean next = !glassesView.isRulerVisible();
            glassesView.setRulerVisible(next);
            TextView label = overlayRoot.findViewById(R.id.glassesRulerLabel);
            if (label != null) {
                label.setText(next ? R.string.glasses_tune_ruler_on : R.string.glasses_tune_ruler);
            }
            CrashLog.endAction(this);
        });
        // 音源切换：眼镜麦克风 / 手机麦克风。改的是**下一次开始同传**用哪个，
        // 正在录的那一场不动（中途换音源会让切句器看到两段不同采样率的音频）。
        view.findViewById(R.id.glassesMicToggle).setOnClickListener(v -> {
            boolean next = !preferGlassesMic();
            prefs.edit().putBoolean(KEY_MIC_SOURCE, next).apply();
            renderMicSourceLabel();
            showNote(next ? "下次开始同传将使用眼镜麦克风" : "下次开始同传将使用手机麦克风");
        });
        // 相机预览背景开关：立刻在当前投屏上生效，并记进偏好（下次投屏也按它来）。
        // 刻意**不**走"停投屏→改→重投"那套：它是显示端的独立设置，
        // 而且用户要的正是"当场来回切、对比两种效果"。
        view.findViewById(R.id.glassesCameraToggle).setOnClickListener(v -> {
            boolean next = !glassesCameraBackground();
            prefs.edit().putBoolean(KEY_GLASSES_CAMERA_BG, next).apply();
            if (glasses != null) {
                glasses.setCameraPreviewBackground(next);
                String note = glasses.applyCameraPreviewBackground();
                CrashLog.beginAction(this, "切换相机预览背景");
                glassesStatus = note;
                CrashLog.endAction(this);
            }
            renderCameraLabel();
            renderGlassesRealStatus();
        });
        renderCameraLabel();
        renderMicSourceLabel();
        applyGlassesTuning();
        renderGlassesRealStatus();
    }

    /** 待机提示下面那行小字：说清"为什么现在没字幕"，比只显示"等待输入"有用。 */
    private String idleNoteText() {
        if (client == null || !connectedForReal()) return "未连接电脑 · 请先连接电脑";
        if (session != null && session.active) return "同传中 · 等对方说话";
        return "已连接电脑 · 点开始同传后这里显示字幕";
    }

    /** 是否真的连上了电脑（deviceName 是握手成功后才有的）。 */
    private boolean connectedForReal() {
        return deviceName != null;
    }

    /** 眼镜上那屏待机提示要不要跟着状态变（连电脑前后、开始同传前后）。 */
    private void refreshGlassesIdle() {
        if (glasses == null || glassesView == null || !glasses.isCasting()) return;
        if (glassesView.hasSubtitle()) return;   // 正在显示字幕，别拿待机提示盖掉它
        glassesView.setIdleText(
                session != null && session.active ? "等待输入" : "等待开始同传",
                idleNoteText());
    }



    /**
     * 手动开始/停止投屏。连接是自动的（插上就有回调），但投屏**允许手动**重来一次 ——
     * 自动投屏失败后（比如眼镜刚插上还没就绪）没有手动入口，用户就只能拔插或重启 App。
     *
     * <p>三条分支都必须**留下可见反馈**。原来 `glassesView == null` 时是静默 return ——
     * 那正是"点了没反应"最典型的成因：代码什么都没做，界面也什么都不说。
     */
    private void toggleGlassesCast() {
        if (glasses == null || glassesView == null) {
            glassesStatus = "模块未就绪";
        } else if (glasses.isCasting()) {
            glasses.stopCast();
            glassesStatus = "已停止投屏";
        } else if (glasses.isConnected()) {
            glassesStatus = "正在投屏";
            applyGlassesCanvasSize();
            glasses.requestCast(glassesView.getView());
        } else {
            // 设备列表和连接状态分开报：这两个数字对不上才是真正要查的问题
            glassesStatus = "眼镜未连接（检测到 " + glasses.getDeviceCount() + " 个设备）";
        }
        renderGlassesRealStatus();
    }

    /**
     * 把真眼镜的状态画到状态行上，并同步「投屏 / 停止投屏」按钮的文案与颜色。
     *
     * <p>之前这里还写了一整块诊断信息（权限差几项、悬浮窗、SDK、设备数、帧数、LCD、服务、
     * 投屏步骤、最近错误、上次崩溃）。那块随界面清理一起删了 —— 它只在接真机那阵子有用，
     * 现在排障走 `relay.log` 与 `GlassesSdk.getStep()/getFrameInfo()`。
     * **但状态行和投屏开关本身留着**：自动投屏失败时，用户需要一个能自己重试的入口。
     */
    private void renderGlassesRealStatus() {
        if (glassesRealStatus == null) return;
        boolean casting = glasses != null && glasses.isCasting();
        String dot = glassesConnected ? "● " : "○ ";
        glassesRealStatus.setText(dot + glassesStatus);
        glassesRealStatus.setTextColor(getColor(
                glassesConnected ? (casting ? R.color.ok : R.color.brand) : R.color.ink_soft));
        if (glassesRealToggle != null) {
            glassesRealToggle.setText(casting ? R.string.glasses_real_stop : R.string.glasses_real_cast);
            // 没连眼镜时按钮暗着，但**不禁用**：点了会明确说"眼镜未连接"，
            // 而不是让人对着一个点不动的按钮猜
            glassesRealToggle.setTextColor(getColor(
                    glassesConnected ? R.color.brand : R.color.ink_faint));
        }
    }

    /**
     * 「排版自检」：在当前字号下把**全部投屏样例**真的排一遍，把实况数字弹出来。
     *
     * <p>为什么要有这个按钮：选字号的时候我算过一张"字号 → 每行几个字"的表，
     * 但那是**模型估的**（中文 ≈1em、拉丁 ≈0.5em/字符）。葡语的宽字母
     * （m / w / 大写 / 带音标）比 0.5em 宽，估算偏乐观 —— 真机上就表现为
     * 句尾几个词被省略号吃掉。教训是**别拿估算当判据**，所以这个按钮
     * 不计算、不换算，直接把安卓的排版结果念出来。
     *
     * <p>量的是**同一批句子**，就是「投屏样例」里点的那几句 ——
     * 这样"点开看"和"看数字"说的是同一件事；用户自己输的那句也一起量，
     * 因为他用的一定是他最关心的那句。
     *
     * <p>顺带把结果写一行进 relay 日志，这样"用户报的问题"和"用户当时的
     * 字号"能对上号，不用来回问。
     */
    private void showGlassesSelfCheck() {
        if (glassesView == null) return;
        java.util.List<String> zh = new ArrayList<>(java.util.Arrays.asList(
                getResources().getStringArray(R.array.glasses_sample_zh)));
        java.util.List<String> pt = new ArrayList<>(java.util.Arrays.asList(
                getResources().getStringArray(R.array.glasses_sample_pt)));
        // 用户自己输的那句也量 —— 那是他最关心的
        if (overlayRoot != null) {
            EditText input = overlayRoot.findViewById(R.id.glassesSampleInput);
            String typed = input == null ? "" : input.getText().toString().trim();
            if (!typed.isEmpty()) {
                (glassesView.containsCjkText(typed) ? zh : pt).add(typed);
            }
        }
        CrashLog.beginAction(this, "排版自检");
        String report;
        try {
            report = glassesView.selfCheck(zh, pt);
        } catch (Throwable error) {
            report = "自检本身出错了：" + error.getClass().getSimpleName()
                    + "：" + error.getMessage();
        }
        CrashLog.endAction(this);
        // 一行版塞进 relay 日志，完整版给弹窗
        String oneLine = report.replace('\n', ' ');
        if (oneLine.length() > 180) oneLine = oneLine.substring(0, 180) + "…";
        if (client != null) client.sendDiag("排版自检 " + oneLine);
        showTextDialog("排版自检（当前字号下的真实排版）", report);
    }

    /** 当前安装的版本名 —— 印在眼镜预览页标题上，用来确认"装的是不是新版"。 */
    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception error) {
            return "?";
        }
    }

    /**
     * 把当前这一帧推到**真眼镜**上。
     *
     * <p>SDK 的投屏是**持续采集你给的那个 View**，所以这里只要改 View 的文字，
     * 眼镜上的画面就会跟着变 —— 不需要每次重新 createCaptureScreen。
     *
     * <p>两个细节：
     * <ul>
     *   <li><b>没在投屏就什么都不做</b>：没连眼镜时这条路径完全是空转，不能影响手机端</li>
     *   <li><b>还在生成的增量帧加省略号</b>：和手机面板一样给佩戴者一个"还没说完"的提示</li>
     * </ul>
     */
    private void pushToGlasses(String text, String source) {
        if (glasses == null || glassesView == null) return;
        if (!glasses.isCasting()) return;

        String show = text == null || text.isEmpty() ? source : text;
        if (show == null) show = "";
        boolean partial = lastFramePartial;

        // ★ 增量帧**不推给眼镜**。
        //
        //   为什么：真机日志显示每个增量帧都只有 1~3 个字符（"Ol" / "V" / "S" / "Na"）。
        //   原因是节流 —— partialThrottleMs=400，而短句的翻译在 400ms 内就完成了，
        //   所以每句只来得及发出**第一个 token**。
        //   结果是眼镜上每句话都先闪一下「首字母 + 省略号」，然后才是完整句子：
        //   在手机大屏上这勉强算"生成中"的提示，在眼镜那块小屏上就是**纯噪声**，
        //   还顺带制造了"卡在开头"这个 bug。
        //
        //   所以眼镜只显示定稿；手机上的渐进显示保持不变（那边空间大、也不会卡）。
        //   如果以后确实要在大屏上做渐进显示，这里可以按长度放行（比如 ≥ 20 字才推）。
        if (partial) {
            if (client != null) {
                client.sendDiag("投屏：增量**跳过**（眼镜只显示定稿）→ "
                        + (show.length() > 40 ? show.substring(0, 40) + "…" : show));
            }
            return;
        }

        glassesView.setSubtitle(show);
        scheduleGlassesRefresh();

        // 把"我实际投上去的是什么"回传给电脑，和"电脑发了什么"放进同一份日志。
        //
        // 为什么必须两边并排：电脑端日志能证明它发了定稿帧，但手机有没有**应用**、
        // 应用成了什么，从那边完全看不见 —— 两边各自看都正常，合起来才是问题。
        if (client != null) {
            client.sendDiag("投屏：定稿 → "
                    + (show.length() > 80 ? show.substring(0, 80) + "…" : show));
        }
    }

    /**
     * 推完字幕之后隔一小会儿再强制重绘一次那块被采样的 View。
     *
     * <p>针对真机上"定稿推上去了、画面却停在增量帧"那个现象：
     * 投屏跟着视图重绘采样，两次更新隔太近时后一次会被合并掉。
     * 补一次重绘，保证最终状态一定被采样到（幂等，内容没变也没有副作用）。
     */
    private void scheduleGlassesRefresh() {
        glassesRefreshHandler.removeCallbacks(glassesRefreshTask);
        glassesRefreshHandler.postDelayed(glassesRefreshTask, 200);
    }

    private final Handler glassesRefreshHandler = new Handler(Looper.getMainLooper());
    private final Runnable glassesRefreshTask = () -> {
        if (glassesView != null && glasses != null && glasses.isCasting()) {
            glassesView.forceRedraw();
        }
    };

    /**
     * 按资源数组生成「投屏样例」的按钮（一句一个）。
     *
     * <p>为什么在代码里生成而不是写死在布局里：句子来自
     * `lib/display-samples.mjs` → 生成 `res/values/display_samples.xml`。
     * 布局写死的话，改句集就得同时改布局；在代码里按数组生成，
     * **改句集只需重新 generate**，界面自动跟着变。
     */
    private void buildSampleChips(LinearLayout row, int labelArrayId, int textArrayId) {
        if (row == null) return;
        row.removeAllViews();
        String[] labels = getResources().getStringArray(labelArrayId);
        String[] texts = getResources().getStringArray(textArrayId);
        for (int index = 0; index < texts.length; index += 1) {
            final String text = texts[index];
            String label = index < labels.length ? labels[index] : ("#" + (index + 1));
            TextView chip = new TextView(this);
            chip.setText(label);
            chip.setTextSize(13f);
            chip.setTextColor(getColor(R.color.brand));
            chip.setBackgroundResource(R.drawable.tap_pill);
            chip.setClickable(true);
            chip.setFocusable(true);
            chip.setGravity(Gravity.CENTER);
            chip.setPadding(dp(12), dp(8), dp(12), dp(8));
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT);
            if (index > 0) params.setMarginStart(dp(8));
            chip.setLayoutParams(params);
            chip.setOnClickListener(v -> pushSample(text));
            row.addView(chip);
        }
    }

    /**
     * 把一个样例句子**真的投到眼镜上**，然后在提示行写下这一句的真实排版结果。
     *
     * <p>走的是同传那条**同一条路径**（{@link GlassesSubtitleView#setSubtitle}），
     * 不是另做一套渲染 —— 否则"样例好看"和"真字幕好看"就是两回事了。
     *
     * <p>为什么要把行数/页数也写出来：眼镜戴在脸上，手机这边看不见；
     * 而"这句话翻不翻页、翻几页"正是校准时最想知道的事。
     */
    private void pushSample(String text) {
        // ⚠️ 顺序：先确认能投，再动视图。
        if (glassesView == null || glasses == null) {
            setSampleNote(getString(R.string.glasses_sample_need_cast), true);
            return;
        }
        if (!glasses.isCasting()) {
            setSampleNote(getString(R.string.glasses_sample_need_cast), true);
            return;
        }
        CrashLog.beginAction(this, "投屏样例");
        glassesView.setSubtitle(text);
        scheduleGlassesRefresh();
        CrashLog.endAction(this);

        // 取**真实排版结果**（setSubtitle 里已经排过一遍了）
        int lines = glassesView.getRealLines();
        int pages = glassesView.getPageCount();
        setSampleNote(getString(R.string.glasses_sample_sent, text.length(), lines, pages), false);
        // 同传在跑的话，真实字幕下一帧就会盖掉这个样例 —— 先说明，别让人以为是坏了
        boolean busy = session != null && session.active;
        if (busy) {
            setSampleNote(getString(R.string.glasses_sample_sent, text.length(), lines, pages)
                    + "\n" + getString(R.string.glasses_sample_busy), true);
        }

        if (client != null) {
            client.sendDiag("投屏样例：" + text.length() + " 字 → " + lines + " 行 / " + pages + " 页"
                    + "（字号 中" + Math.round(glassesFontZh()) + "px 葡"
                    + Math.round(glassesFontPt()) + "px）"
                    + "｜" + (text.length() > 60 ? text.substring(0, 60) + "…" : text));
        }
    }

    /** 写「投屏样例」下面那行提示。warn=true 用醒目一点的语气（但仍然是同一行文字）。 */
    private void setSampleNote(String message, boolean warn) {
        if (glassesSampleNote == null) return;
        glassesSampleNote.setText(message);
        glassesSampleNote.setTextColor(getColor(warn ? R.color.warn : R.color.ink_faint));
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────

    private void showNote(String message) {
        if (sessionNote == null) return;
        sessionNote.setText(message == null ? "" : message);
        sessionNote.setVisibility(message == null || message.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // 眼镜 SDK 的权限（相机 + 媒体）：拿到就继续初始化 SDK，没拿到就在眼镜状态行里说明。
        // 与录音那条**分开处理**：它们是两件事（录音是同传功能，这条只是"让眼镜能连"），
        // 而且眼镜没授权**不该拦住整个 App** 的同传功能。
        if (requestCode == REQUEST_GLASSES_PERMISSIONS) {
            boolean allGranted = grantResults.length > 0;
            for (int result : grantResults) {
                if (result != PackageManager.PERMISSION_GRANTED) allGranted = false;
            }
            if (allGranted) {
                afterRuntimePermissions();
            } else {
                glassesStatus = "权限被拒";
                renderGlassesRealStatus();
            }
            return;
        }
        if (requestCode != REQUEST_RECORD_AUDIO) return;
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            if (micGrantedPending) beginSession();
            return;
        }
        micGrantedPending = false;
        // 规范：永久拒绝后要提供系统设置入口，而不是反复弹同一个请求
        boolean permanent = !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO);
        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle(R.string.err_mic_permission)
                .setMessage(permanent ? R.string.err_mic_permission_settings : R.string.err_mic_permission)
                .setNegativeButton(R.string.cancel, null);
        if (permanent) {
            builder.setPositiveButton(R.string.open_settings, (dialog, which) -> {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.fromParts("package", getPackageName(), null));
                startActivity(intent);
            });
        } else {
            builder.setPositiveButton(R.string.grant, (dialog, which) -> {
                micGrantedPending = true;
                requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO },
                        REQUEST_RECORD_AUDIO);
            });
        }
        builder.show();
        showNote(getString(R.string.err_mic_permission));
    }
}
