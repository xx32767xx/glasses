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
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
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
    private MicUploader uploader;
    private Records records;

    /** 已连接且握手成功的设备名；未连接为 null。 */
    private String deviceName = null;
    /** /status 的真实证据：大脑是否产出过字幕、识别侧是否写过收件箱。 */
    private boolean busSeen = false;
    private int inboxLines = 0;
    private int framesSeen = 0;
    private String lastError = "";

    /** 会话（规范第 5、9 节）。null = 当前没有会话。 */
    private Session session = null;
    private boolean micGrantedPending = false;

    private String sourceLang = "pt-BR";
    private float fontScale = 1f;
    private boolean bilingual = true;
    private String themeMode = "system";

    /** 最近一帧的完整信息，供眼镜预览用。 */
    private String lastFrameText = "";
    private String lastFrameSource = "";
    private String lastFrameSpeaker = "them";
    /** 最近一帧是不是"还在生成中"的流式增量（用来决定要不要在末尾加省略号）。 */
    private boolean lastFramePartial = false;
    private int panelCols = 40;
    private int panelLines = 3;

    /** 眼镜投屏（真眼镜，不是界面里那个"眼镜预览"面板）。见 GlassesSdk 与 docs/09。 */
    private GlassesSdk glasses = null;
    private GlassesSubtitleView glassesView = null;
    private String glassesStatus = "眼镜未初始化";
    private boolean glassesConnected = false;

    private long lastSpeechAt = 0;

    // ── 视图 ────────────────────────────────────────────────────────────────

    private FrameLayout pageHost;
    private FrameLayout overlayHost;
    private LinearLayout bottomNav;
    private View navLive;
    private View navRecords;
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
        navSettings = findViewById(R.id.navSettings);

        buildLivePage();
        buildSettingsPage();
        buildRecordsPage();

        navLive.setOnClickListener(v -> showPage(Page.LIVE));
        navRecords.setOnClickListener(v -> showPage(Page.RECORDS));
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
        glassesView = new GlassesSubtitleView(this);
        // 先把上次调好的显示参数用上 —— 否则每次重启都回到缺省，
        // 用户会以为"又变小了"，然后重调一遍
        glassesView.setTuning(glassesFontScale(), glassesMarginRight(), glassesMarginLeft());
        glasses = new GlassesSdk(this, (status, connected) -> {
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
                applyGlassesCanvasSize();
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
        });

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
        if (glasses == null || glassesView == null) return;
        int[] size = glasses.queryDisplaySize();
        glassesView.setDisplaySize(size[0], size[1]);
        if (size[0] > 0 && size[1] > 0) {
            glassesCanvasNote = "画布 " + size[0] + "×" + size[1];
        } else {
            glassesCanvasNote = "画布尺寸未知（交给 SDK 测量）";
        }
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
            glassesStatus = "等待眼镜权限（还差 " + missing.size() + " 项）";
            renderGlassesRealStatus();
            requestPermissions(missing.toArray(new String[0]), REQUEST_GLASSES_PERMISSIONS);
            return;
        }
        afterRuntimePermissions();
    }

    /** 运行时权限这一关过了 → 再看悬浮窗（官方把它并列为前置条件）。 */
    private void afterRuntimePermissions() {
        if (Build.VERSION.SDK_INT >= 23 && Settings.canDrawOverlays(this) == false) {
            glassesStatus = "还需要「显示在其他应用上层」权限";
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
                        glassesStatus = "缺悬浮窗权限，眼镜可能连不上";
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
        glassesStatus = "正在初始化眼镜 SDK…";
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

    private enum Page { LIVE, RECORDS, SETTINGS }

    private Page currentPage = Page.LIVE;
    private View livePage;
    private View settingsPage;
    private View recordsPage;

    private void showPage(Page page) {
        currentPage = page;
        livePage.setVisibility(page == Page.LIVE ? View.VISIBLE : View.GONE);
        recordsPage.setVisibility(page == Page.RECORDS ? View.VISIBLE : View.GONE);
        settingsPage.setVisibility(page == Page.SETTINGS ? View.VISIBLE : View.GONE);
        if (page == Page.RECORDS) renderRecords();
        if (page == Page.SETTINGS) refreshSettingsPage();
        paintNav();
    }

    /** 导航项选中态：图标与文字变主色，底色是淡主色胶囊。 */
    private void paintNav() {
        paintNavItem(navLive, currentPage == Page.LIVE);
        paintNavItem(navRecords, currentPage == Page.RECORDS);
        paintNavItem(navSettings, currentPage == Page.SETTINGS);
    }

    private void paintNavItem(View item, boolean selected) {
        ImageView icon = item.findViewById(item == navLive ? R.id.navLiveIcon
                : item == navRecords ? R.id.navRecordsIcon : R.id.navSettingsIcon);
        TextView label = item.findViewById(item == navLive ? R.id.navLiveLabel
                : item == navRecords ? R.id.navRecordsLabel : R.id.navSettingsLabel);
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
            panelCols = serverCols > 0 ? serverCols : 40;
            panelLines = serverLineBudget > 0 ? serverLineBudget : 3;
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
                        final boolean partial) {
        main.post(() -> {
            framesSeen += 1;
            busSeen = true;
            lastFrameText = text;
            lastFrameSource = source;
            lastFrameSpeaker = speaker;
            lastFramePartial = partial;
            if (glassesPanel != null) renderGlassesPanel();
            // ★ 真眼镜：把这一帧投上去。
            //
            //   注意这里投的是**手机该显示的那一侧**（和 renderGlassesPanel 用的同一份），
            //   不是原始译文：如果佩戴者在看对方的字幕，那一侧就是译文；
            //   如果这一帧是"佩戴者自己说的话"（出站给对方），投上去的是它对应的显示侧。
            //   这样眼镜上的内容和手机面板永远一致，不会出现"眼镜和手机显示不同语言"。
            pushToGlasses(text, source);
            if (session != null && session.active) {
                String time = elapsedLabel();
                SubtitleList.Segment segment = subtitles.submit(time, source, text, partial);
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
                    fullscreenList.submit(time, source, text, partial);
                }
            } else if (text != null && !text.isEmpty()) {
                // 没在会话里也收到字幕（电脑侧自己在跑）→ 只更新眼镜预览，不污染记录
                showNote(getString(R.string.processing));
            }
        });
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
        if (uploader == null) uploader = new MicUploader(client, this);
        uploader.setLanguage(sourceLang);
        String problem = uploader.start();
        if (problem != null) showNote(problem);
    }

    private void stopCapture() {
        if (uploader != null && uploader.isRunning()) uploader.stop();
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
            main.postDelayed(this, 500);
        }
    };

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
        overlayHost.removeAllViews();
        overlayHost.setVisibility(View.GONE);
        overlayRoot = null;
        overlayConnectProgress = null;
        glassesPanel = null;
        fullscreenList = null;
    }

    // ── 连接电脑页 ──────────────────────────────────────────────────────────

    private LinearLayout overlayConnectProgress;
    private TextView overlayConnectProgressText;
    private View overlayConnectProgressDot;

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

        // 自检：只做只读探测，不改连接状态。
        // 与"测试连接"分开，是为了能在"会话已经坏了"的时候单独跑诊断。
        view.findViewById(R.id.connectSelfCheck).setOnClickListener(v -> {
            final String address = hostField.getText().toString().trim();
            final String key = secretField.getText().toString().trim();
            showConnectProgress(getString(R.string.connect_selfcheck_running), R.color.warn);
            runSelfCheck(address, key);
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

    /**
     * 跑连接自检并弹结果。
     *
     * <p>必须在**后台线程**跑：{@link SelfCheck#run} 会做 TCP 连接和 HTTP 请求，
     * 主线程上会直接 NetworkOnMainThreadException。
     */
    private void runSelfCheck(String address, String key) {
        final String shownAddress = address.isEmpty() ? host() : address;
        final String shownKey = key.isEmpty() ? secret() : key;
        new Thread(() -> {
            String report;
            try {
                report = SelfCheck.run(shownAddress, shownKey);
            } catch (Throwable error) {
                report = "自检本身出错了：" + error.getClass().getSimpleName()
                        + "：" + error.getMessage();
            }
            final String text = report;
            runOnUiThread(() -> {
                showConnectProgress(getString(R.string.connect_selfcheck_done), R.color.brand);
                showTextDialog("连接自检", text);
            });
        }, "self-check").start();
    }

    /** 等宽、可滚动、可复制的长文本弹窗（自检报告 / SDK 探测都用它）。 */
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
            ((TextView) row.findViewById(R.id.recMeta)).setText(session.startedAt
                    + " · " + session.direction + " · " + formatDuration(session.durationMs));
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

    private void buildSettingsPage() {
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
        text.append("采样率：").append(uploader != null && uploader.isRunning()
                ? uploader.getSampleRate() + " Hz" : "未录音").append('\n');
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

    private TextView glassesPanel = null;
    /** 真眼镜的状态行与投屏开关（只有打开这个预览页时才有）。 */
    private TextView glassesRealStatus = null;
    private TextView glassesRealToggle = null;
    /** 诊断行：权限差几项 / 悬浮窗 / SDK / 设备数 / 投屏 —— 哪一步是 0 就是卡在哪。 */
    private TextView glassesRealDiag = null;
    /** 上一次检查时缺了几项眼镜权限（诊断用）。 */
    private int glassesPermMissing = 0;
    /** 当前投屏画布用了什么尺寸（诊断用）：读到真实分辨率、还是交给 SDK 测量。 */
    private String glassesCanvasNote = "画布未定";

    // ── 眼镜显示微调（真机上才调得出来）─────────────────────────────────────
    //
    // 这两组值来自真机反馈："字太小"、"投射在右眼上，过于靠右的内容看不清"。
    // 眼镜上的实际观感取决于光波导放大率、佩戴位置、环境亮度 —— 在电脑上推不出来。
    // 而投屏是**实时采样那块 View**，所以调完立刻在眼镜上生效：
    // 用户戴着眼镜按加减，当场就能调到顺眼，不用重新打包。
    private static final String KEY_GLASSES_FONT = "glassesFontScale";
    private static final String KEY_GLASSES_MARGIN_R = "glassesMarginRight";
    private static final String KEY_GLASSES_MARGIN_L = "glassesMarginLeft";
    /** 缺省值：字号放大一档、右侧留 22%（单目右眼时右缘常在可见区外）。 */
    private static final float DEFAULT_GLASSES_FONT = 1.35f;
    private static final int DEFAULT_GLASSES_MARGIN_R = 22;
    private static final int DEFAULT_GLASSES_MARGIN_L = 4;

    private float glassesFontScale() {
        return prefs.getFloat(KEY_GLASSES_FONT, DEFAULT_GLASSES_FONT);
    }

    private int glassesMarginRight() {
        return prefs.getInt(KEY_GLASSES_MARGIN_R, DEFAULT_GLASSES_MARGIN_R);
    }

    private int glassesMarginLeft() {
        return prefs.getInt(KEY_GLASSES_MARGIN_L, DEFAULT_GLASSES_MARGIN_L);
    }

    /** 把当前微调应用到眼镜那块 View，并刷新数值显示。 */
    private void applyGlassesTuning() {
        if (glassesView != null) {
            glassesView.setTuning(glassesFontScale(), glassesMarginRight(), glassesMarginLeft());
        }
        TextView font = overlayRoot == null ? null : overlayRoot.findViewById(R.id.glassesFontValue);
        TextView right = overlayRoot == null ? null : overlayRoot.findViewById(R.id.glassesRightValue);
        TextView left = overlayRoot == null ? null : overlayRoot.findViewById(R.id.glassesLeftValue);
        if (font != null) font.setText(String.format(Locale.US, "×%.2f", glassesFontScale()));
        if (right != null) right.setText(glassesMarginRight() + "%");
        if (left != null) left.setText(glassesMarginLeft() + "%");
    }

    /**
     * 调一个微调值并立刻生效。
     *
     * <p>投屏是实时采样，所以**不需要重新投屏** —— 眼镜上直接变。
     * 这也意味着用户在眼镜上一边看一边按，能很快找到合适的值。
     */
    private void nudgeGlassesTuning(String key, float delta) {
        if (KEY_GLASSES_FONT.equals(key)) {
            float next = Math.max(0.6f, Math.min(3.0f,
                    Math.round((glassesFontScale() + delta) * 100f) / 100f));
            prefs.edit().putFloat(KEY_GLASSES_FONT, next).apply();
        } else {
            int current = KEY_GLASSES_MARGIN_R.equals(key) ? glassesMarginRight() : glassesMarginLeft();
            int next = Math.max(0, Math.min(60, current + Math.round(delta)));
            prefs.edit().putInt(key, next).apply();
        }
        applyGlassesTuning();
    }

    private void openGlassesPreview() {
        View view = pushOverlay(R.layout.overlay_glasses);
        glassesPanel = view.findViewById(R.id.glassesPanel);
        glassesRealStatus = view.findViewById(R.id.glassesRealStatus);
        glassesRealToggle = view.findViewById(R.id.glassesRealToggle);
        glassesRealDiag = view.findViewById(R.id.glassesRealDiag);
        // 每次打开都重新问一遍权限状态 —— 用户可能刚去设置里开过
        glassesPermMissing = 0;
        for (String permission : glassesPermissions()) {
            if (ContextCompat.checkSelfPermission(this, permission)
                    != PackageManager.PERMISSION_GRANTED) {
                glassesPermMissing += 1;
            }
        }
        view.findViewById(R.id.glassesBack).setOnClickListener(v -> closeOverlay());
        glassesRealToggle.setOnClickListener(v -> toggleGlassesCast());
        // 长按诊断行 → API 探测（真机上 adb 不一定能用，只能靠 App 自己说）
        if (glassesRealDiag != null) {
            glassesRealDiag.setOnLongClickListener(v -> {
                showGlassesApiProbe();
                return true;
            });
        }
        // 标题上带**版本号**：真机验证时第一件要确认的事是"装的到底是不是新版"。
        //  没有这个，很容易出现"改了但装的是旧包，然后一起怀疑代码"。
        TextView title = view.findViewById(R.id.glassesTitle);
        if (title != null) title.setText(getString(R.string.glasses_preview_title) + " · v" + appVersion());
        TextView caption = view.findViewById(R.id.glassesCaption);
        if (caption != null) caption.setText(R.string.glasses_real_caption);

        // 显示微调：调完立刻在眼镜上生效（投屏是实时采样）
        view.findViewById(R.id.glassesFontMinus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_FONT, -0.05f));
        view.findViewById(R.id.glassesFontPlus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_FONT, 0.05f));
        view.findViewById(R.id.glassesRightMinus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_MARGIN_R, -2));
        view.findViewById(R.id.glassesRightPlus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_MARGIN_R, 2));
        view.findViewById(R.id.glassesLeftMinus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_MARGIN_L, -2));
        view.findViewById(R.id.glassesLeftPlus).setOnClickListener(v ->
                nudgeGlassesTuning(KEY_GLASSES_MARGIN_L, 2));
        // 边界标尺：戴上眼镜看一眼就知道哪一部分看不见
        view.findViewById(R.id.glassesRulerToggle).setOnClickListener(v -> {
            if (glassesView == null) return;
            boolean next = !glassesView.isRulerVisible();
            glassesView.setRulerVisible(next);
            TextView label = overlayRoot.findViewById(R.id.glassesRulerLabel);
            if (label != null) {
                label.setText(next ? R.string.glasses_tune_ruler_on : R.string.glasses_tune_ruler);
            }
        });
        applyGlassesTuning();

        renderGlassesPanel();
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

    /** 手动开始/停止投屏。连接是自动的（插上就有回调），但投屏允许手动重试。 */
    private void toggleGlassesCast() {
        // 三条分支都必须**留下可见反馈**。原来 glassesView == null 时是静默 return ——
        // 那正是"点了没反应"最典型的成因：代码什么都没做，界面也什么都不说。
        if (glasses == null || glassesView == null) {
            glassesStatus = "眼镜模块还没就绪（等待权限/悬浮窗）";
        } else if (glasses.isCasting()) {
            glasses.stopCast();
        } else if (glasses.isConnected()) {
            glassesStatus = "正在投屏…";
            applyGlassesCanvasSize();
            glasses.requestCast(glassesView.getView());
        } else {
            // 设备列表和连接状态分开报：这两个数字对不上才是真正要查的问题
            glassesStatus = "眼镜未连接（设备列表 " + glasses.getDeviceCount() + " 个）——重插一下眼镜";
        }
        renderGlassesRealStatus();
    }

    /**
     * 把真眼镜的状态画到状态行上。没有这一行，出问题只能靠猜。
     *
     * <p>现在这里会带**诊断信息**（权限差几项、悬浮窗有没有、SDK 有没有初始化、
     * 认出几个设备、投屏状态）。加这些是因为真机上 adb 不一定能用
     * （沙箱里 adb 服务端起不来），所以**得让 App 自己把卡在哪一步说出来**。
     */
    private void renderGlassesRealStatus() {
        if (glassesRealStatus == null) return;
        boolean casting = glasses != null && glasses.isCasting();
        boolean inited = glasses != null && glasses.isInitialized();
        String dot = glassesConnected ? "● " : "○ ";
        glassesRealStatus.setText(dot + glassesStatus);

        // 诊断行：每一步单独可见，哪一步是 0 / false 就是卡在哪
        StringBuilder diag = new StringBuilder();
        diag.append("权限差 ").append(glassesPermMissing).append(" 项")
            .append(" · 悬浮窗 ").append(canDrawOverlaysNow() ? "有" : "无")
            .append(" · SDK ").append(inited ? "已初始化" : "未初始化")
            .append(" · 设备 ").append(glasses == null ? "?" : glasses.getDeviceCount()).append(" 个")
            .append(" · 服务 ").append(glasses == null ? "?" : (glasses.isServicesReady() ? "就绪" : "启动中"))
            .append(" · ").append(casting ? "投屏中" : "未投屏");
        diag.append("\n").append(glassesCanvasNote);
        if (glasses != null && casting) {
            // 投屏中：帧数与 LCD 状态是"为什么看不见"的两个关键数字
            diag.append(" · ").append(glasses.getFrameInfo());
            String lcdInfo = glasses.queryLcdInfo();
            if (lcdInfo.length() > 0) diag.append("\n").append(lcdInfo);
        }
        if (glasses != null && glasses.getPrepareNote().length() > 0) {
            diag.append("\n投屏前准备：").append(glasses.getPrepareNote());
        }
        if (glasses != null && glasses.getStep().length() > 0) {
            diag.append("\n投屏步：").append(glasses.getStep());
        }
        if (glasses != null && glasses.getLastError().length() > 0) {
            diag.append("\n最近错误：").append(glasses.getLastError());
        }
        // 上次崩溃的堆栈：真机 adb 不一定能用，只能让 App 自己把话留下
        String crash = CrashLog.last(this);
        if (crash.length() > 0) {
            diag.append("\n⚠ 上次闪退：").append(firstLines(crash, 3));
        }
        diag.append("\n（长按本行看 API 探测）");
        glassesRealDiag.setText(diag.toString());

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

    private boolean canDrawOverlaysNow() {
        return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this);
    }

    /** 取一段文本的前几行（诊断行空间有限，只显示开头）。 */
    private static String firstLines(String text, int count) {
        String[] lines = text.split("\n");
        StringBuilder out = new StringBuilder();
        for (int index = 0; index < lines.length && index < count; index += 1) {
            if (index > 0) out.append(" / ");
            out.append(lines[index].trim());
        }
        return out.toString();
    }

    /**
     * 长按诊断行 → 弹出 SDK 的 API 探测结果。
     *
     * <p>为什么要一个弹窗而不是写在诊断行里：探测结果是几十行方法签名，
     * 挤在那一行里没法看。用等宽字体 + 可滚动，是为了让签名里的逗号、
     * 包名能一眼对齐 —— 反射只认**精确签名**，差一个参数类型就找不到方法。
     */
    private void showGlassesApiProbe() {
        if (glasses == null) return;
        StringBuilder text = new StringBuilder();
        // 崩溃堆栈放最前面 —— 它是当前最想知道的东西
        String crash = CrashLog.last(this);
        if (crash.length() > 0) {
            text.append("═══ 上次闪退堆栈 ═══\n").append(crash).append('\n');
            CrashLog.clear(this);          // 看过就清，免得下次又弹同一个旧的
        }
        text.append("═══ SDK 探测 ═══\n")
            .append(GlassesSdk.probeAvailability()).append("\n\n")
            .append(glasses.probeApi());

        showTextDialog("眼镜 SDK API 探测", text.toString());
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
     * 把当前这一帧推到**真眼镜**上（手机界面里那个"眼镜预览"面板是另一回事，见本文件里的
     * {@code glassesPanel} —— 那个只是给用户看"眼镜上大概长什么样"的模拟）。
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
        if (lastFramePartial) show = show + "…";
        glassesView.setSubtitle(show);
    }

    /**
     * 按"cols 个半角字符正好铺满面板宽度"算字号，让预览看起来就是一块固定宽度的设备屏幕。
     * 等宽字体下 CJK 正好占两格，与电脑端"汉字算 2 列"的算法一致。
     */
    private void renderGlassesPanel() {
        if (glassesPanel == null) return;
        String[] lines = new String[panelLines];
        if (lastFrameText.isEmpty() && lastFrameSource.isEmpty()) {
            // ⚠️ 这里原来写死显示「（还没有收到字幕）」，于是**看不到投屏的真实内容** ——
            //    用户没法用它在手机上判断"眼镜上现在到底是什么"。
            //    现在改成显示**真正会投到眼镜上的那块待机画面**：
            //    眼镜连着就显示"等待输入"（与 GlassesSubtitleView 的待机文案一致），
            //    没连就说明没连。这样手机上的预览和眼镜上的画面是同一回事。
            String idleTitle = session != null && session.active ? "等待输入" : "等待开始同传";
            glassesPanel.setText(glassesConnected ? idleTitle : "（眼镜未连接）");
        } else {
            String text = lastFrameText == null || lastFrameText.isEmpty()
                    ? lastFrameSource : lastFrameText;
            String[] wrapped = wrap(text, panelCols);
            for (int index = 0; index < panelLines; index++) {
                lines[index] = index < wrapped.length ? wrapped[index] : "";
            }
            glassesPanel.setText(String.join("\n", lines));
        }
        TextView badge = overlayRoot.findViewById(R.id.glassesBadge);
        if (badge != null) {
            badge.setText("眼镜显示 · " + panelCols + " 列 × " + panelLines + " 行");
        }
        glassesPanel.post(() -> {
            int available = glassesPanel.getWidth()
                    - glassesPanel.getPaddingLeft() - glassesPanel.getPaddingRight();
            if (available <= 0) return;
            Paint paint = glassesPanel.getPaint();
            float oneChar = paint.measureText("M");
            if (oneChar <= 0f) return;
            float desired = available / (float) panelCols;
            float target = glassesPanel.getTextSize() * desired / oneChar;
            target = Math.max(8f, Math.min(target, glassesPanel.getTextSize() * 1.6f));
            glassesPanel.setTextSize(TypedValue.COMPLEX_UNIT_PX, target);
        });
    }

    /** 简版折行：和插件那边的 fitSubtitle 同一套规则（汉字算 2 列）。 */
    private static String[] wrap(String text, int cols) {
        List<String> out = new ArrayList<>();
        StringBuilder line = new StringBuilder();
        int width = 0;
        for (char ch : text.toCharArray()) {
            if (ch == '\n') {
                out.add(line.toString());
                line.setLength(0);
                width = 0;
                continue;
            }
            int w = ch < 0x2E80 ? 1 : 2;
            if (width + w > cols) {
                out.add(line.toString());
                line.setLength(0);
                width = 0;
            }
            line.append(ch);
            width += w;
        }
        out.add(line.toString());
        return out.toArray(new String[0]);
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
                glassesStatus = "眼镜权限被拒（相机/媒体），眼镜连不上";
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
