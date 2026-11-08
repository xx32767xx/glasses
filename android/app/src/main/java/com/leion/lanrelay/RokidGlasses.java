package com.leion.lanrelay;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import com.rokid.cxr.session.AiInterceptMode;
import com.rokid.cxr.session.AuthResult;
import com.rokid.cxr.session.CloseReason;
import com.rokid.cxr.session.CxrSession;
import com.rokid.cxr.session.CxrSessionManager;
import com.rokid.cxr.session.GlassPermission;
import com.rokid.cxr.session.GlassesInfo;
import com.rokid.cxr.session.ISessionLifecycleCbk;
import com.rokid.cxr.session.PausedReason;
import com.rokid.cxr.session.RokidAppStatus;
import com.rokid.cxr.session.SessionConfig;
import com.rokid.cxr.session.SessionErrorCode;
import com.rokid.cxr.session.SessionResult;
import com.rokid.cxr.session.SessionTimeouts;
import com.rokid.cxr.session.SessionType;
import com.rokid.cxr.session.TerminatingReason;

import java.util.Arrays;

import kotlin.Unit;
import kotlin.jvm.functions.Function1;

/**
 * RokidGlasses —— Rokid CXR-L 眼镜的**投屏译文**（5.127）。
 * ============================================================================
 * 与亮亮那套（{@link GlassesSdk} + {@link GlassesSubtitleView}）的根本区别：
 * <pre>
 *   亮亮：SDK 没有文字 API → 我们做一个 View → 「投屏」把这个 View 采样成画面
 *   Rokid：SDK 这就是「CustomView」协议 → 我们发 **JSON** 描述界面，镜片端自己渲染
 * </pre>
 * 所以这一边**没有 View、没有画布尺寸、没有帧率** —— 只有两件事：
 * 「建会话（连同第一版界面 JSON）」和「之后每次只发一行字的增量更新」。
 *
 * <h3>接入顺序（照官方 Sample 的 Setup → Hub 两步）</h3>
 * <ol>
 *   <li>环境：手机装了 Rokid AI App 且版本兼容（{@code isRokidAppInstalled} /
 *       {@code checkRokidAppCompatibility}）；眼镜必须在**Rokid AI App 里**连上
 *       （系统蓝牙配对不够，{@code isGlassesBtConnected}）。</li>
 *   <li>授权：{@code requestAuthorization(activity, 权限, 回调)} → 拿 token
 *       （结果也可能从 {@code onActivityResult} 回来，那条路走 {@code parseAuthorizationResult}）。</li>
 *   <li>建会话：<b>界面 JSON 建会话时就给</b>（{@link SessionConfig#viewData}），
 *       类型 {@code SessionType.CUSTOM_VIEW}。</li>
 *   <li>之后每句译文一条 {@code customViewUpdate(json)}。</li>
 *   <li>退出：{@code session.close()}（谁创建谁关闭）。</li>
 * </ol>
 *
 * <h3>为什么方法签名敢这么写（而不是反射）</h3>
 * <p>这些签名是**从 AAR 字节码 javap 出来的**（`client-l-1.1.2`），不是照 Sample 猜的 ——
 * 亮亮那次"四处签名全错、赔了四轮真机往返"就是因为靠推理（见 docs/09 §3）。
 * 关键三条：
 * <ul>
 *   <li>{@code CxrSessionManager.Companion.getInstance(Context)}（Kotlin 伴生对象，Java 侧走静态字段 Companion）；</li>
 *   <li>{@code customViewUpdate(String)} 返回 {@code SessionResult<Unit>}，**同步**，不是挂起函数；</li>
 *   <li>{@code connect(String token)} / {@code close()} 返回 void，状态靠 {@code ISessionLifecycleCbk} 回调。</li>
 * </ul>
 *
 * <h3>与亮亮那套的关系</h3>
 * <p>两套可以同时编译进 App，但**同一时刻只用一套**：{@link MainActivity#toggleGlassesCast()}
 * 先看亮亮（USB 插着就用它），否则看 Rokid（装了 Rokid AI App 就用它）。理由：两条链路
 * 的"投屏"是两种完全不同的机制，同时开只会让"镜片上到底是什么"说不清。
 */
public final class RokidGlasses {

    /** 语音/相机/媒体权限：照官方 Sample（它对这三项是固定要的）。 */
    private static final String STATUS_IDLE = "Rokid：未连接";

    /** 状态回调：给界面那一行用（不要在里面做 SDK 调用）。 */
    public interface Listener {
        /**
         * @param status  人话状态（会原样显示在「真眼镜」那一行）
         * @param casting 是否正在投屏（= 会话已 Started）
         */
        void onRokidStatus(String status, boolean casting);
    }

    private final Context appContext;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());

    private CxrSessionManager manager = null;
    private CxrSession session = null;
    private String token = "";
    private boolean started = false;
    private String status = STATUS_IDLE;
    private String lastText = null;
    /** 上一次推送用的字号（判"同一句 + 新字号要不要重发"）。 */
    private int pushedAtFontSp = 0;
    /** 镜片字号（sp，5.138 起手动可调；默认按屏高算出来）。 */
    private int fontSizeSp = 0;

    public RokidGlasses(Context context, Listener listener) {
        this.appContext = context.getApplicationContext();
        this.listener = listener;
        // ⚠️ 构造**不许抛**：它在 MainActivity.setupGlasses() 里被调，一抛就是"App 打不开"。
        //    取不到管理器就当"这台机器不支持"，由 status/isAppInstalled 把原因说出来。
        try {
            this.manager = CxrSessionManager.Companion.getInstance(appContext);
        } catch (Throwable error) {
            this.manager = null;
            this.status = "Rokid SDK 初始化失败（" + error.getClass().getSimpleName() + "）";
        }
    }

    /** 手机装没装 Rokid AI App（没装就谈不上投屏；这是环境检查，不涉及投屏状态）。 */
    public boolean isAppInstalled() {
        if (manager == null) return false;
        try {
            return manager.isRokidAppInstalled(appContext);
        } catch (Throwable error) {
            return false;
        }
    }

    /**
     * 蓝牙权限（5.134）：**Android 12+ 必须运行时申请**，否则查到的"眼镜连没连"永远是 false。
     *
     * <p>真机现场就是这条：AI App 里眼镜明明已连接，我们却报「没在 Rokid AI App 里连上」。
     * 根因不是 AI App，也不是 SDK —— 是我们的清单里**一条蓝牙权限都没有**，
     * 于是 `isGlassesBtConnected()` 拿到的是 false（或直接抛 SecurityException 被我们吞成 false）。
     *
     * @return 还需要申请的权限（空数组 = 齐了 / 老系统不需要）
     */
    public String[] missingBluetoothPermissions() {
        if (Build.VERSION.SDK_INT < 31) return new String[0];
        java.util.List<String> missing = new java.util.ArrayList<>();
        for (String name : new String[] {
                android.Manifest.permission.BLUETOOTH_CONNECT,
                android.Manifest.permission.BLUETOOTH_SCAN,
        }) {
            if (appContext.checkSelfPermission(name) != PackageManager.PERMISSION_GRANTED) {
                missing.add(name);
            }
        }
        return missing.toArray(new String[0]);
    }

    /** 兼容性一句话结论（装没装、版本够不够；只读，不发起任何会话）。 */
    public String compatibilityNote() {
        if (manager == null) return "Rokid SDK 未就绪";
        try {
            RokidAppStatus appStatus = manager.checkRokidAppCompatibility(appContext);
            if (appStatus instanceof RokidAppStatus.Compatible) {
                return "Rokid AI App 已安装（" + ((RokidAppStatus.Compatible) appStatus).getVersion() + "）";
            }
            if (appStatus instanceof RokidAppStatus.VersionTooLow) {
                RokidAppStatus.VersionTooLow low = (RokidAppStatus.VersionTooLow) appStatus;
                return "Rokid AI App 版本过低（" + low.getInstalledVersion()
                        + " < " + low.getMinimumVersion() + "）";
            }
            if (appStatus instanceof RokidAppStatus.NotInstalled) {
                return "没装 Rokid AI App（需要 ≥ "
                        + ((RokidAppStatus.NotInstalled) appStatus).getMinimumVersion() + "）";
            }
            return "Rokid AI App 状态未知";
        } catch (Throwable error) {
            return "Rokid AI App 检查失败：" + error.getClass().getSimpleName();
        }
    }

    /** 是否正在投屏（会话已 Started）。和亮亮的 isCasting() 同义，只是机制不同。 */
    public boolean isCasting() {
        return started;
    }

    /** 当前状态文字（给界面那一行）。 */
    public String status() {
        return status;
    }

    /** 镜片分辨率（会话起来之后才有；用来决定字号）。读不到给 0×0。 */
    public int[] displaySize() {
        if (session == null) return new int[] { 0, 0 };
        try {
            SessionResult<GlassesInfo> info = session.queryGlassesInfo();
            if (info != null && info.isSuccess() && info.getData() != null) {
                GlassesInfo glasses = info.getData();
                return new int[] { glasses.getDisplayWidth(), glasses.getDisplayHeight() };
            }
        } catch (Throwable ignored) {
            // 读不到分辨率不算错：字号有缺省值
        }
        return new int[] { 0, 0 };
    }

    /**
     * 开始投屏：环境检查 → （授权）→ 建会话 → 连接。
     *
     * <p>授权是**异步**的：回调里才拿得到 token。所以这个方法会立刻返回，
     * 真正的"开始"发生在回调里 —— 界面只认 {@link Listener} 推来的状态。
     *
     * @param activity 用于拉起 Rokid AI App 的授权页面（必须是 Activity）
     */
    public void start(Activity activity) {
        if (manager == null) {
            report("Rokid SDK 未就绪", false);
            return;
        }
        if (!isAppInstalled()) {
            report("Rokid：" + compatibilityNote(), false);
            return;
        }
        if (!compatible()) {
            report("Rokid：" + compatibilityNote(), false);
            return;
        }
        // 5.134：先看蓝牙权限（Android 12+ 是运行时权限）。
        String[] missingBt = missingBluetoothPermissions();
        if (missingBt.length > 0) {
            report("Rokid：缺蓝牙权限（Android 12+ 的「附近的设备」）—— 已在弹授权，允许后再点开始投屏",
                    false);
            return;
        }
        // ⚠️⚠️ 5.135：**不要**在这里用 `manager.isGlassesBtConnected()` 当闸门。
        //
        //    反编译看得很清楚（`javap -c` 的字节码）：
        //      CxrSessionManagerImpl.isGlassesBtConnected() =
        //          session == null ? false : session.isGlassesBtConnected()
        //      而 session 那次实现是 ExternalAppClient.isGlassBtConnected() —— 客户端在
        //      **create()/connect() 之后**才被建出来。
        //    所以**还没建会话时它一定是 false**。拿它做前置检查 = 永远拦住自己，
        //    并且把"还没开始连"错报成"蓝牙没连上"（真机现场就卡在这，用户说 AI App 里明明能用）。
        //    官方 Sample 也只会在**会话起来之后**（Hub 页）才刷新这个值。
        //
        //    正确做法：直接建会话 → connect；连接失败时由 `onConnectResult` 带着
        //    SessionErrorCode（BT_NOT_CONNECTED / LINK_NOT_READY / …）说清是哪一层。
        if (started) return;
        if (token != null && !token.isEmpty()) {
            openSession();
            return;
        }
        report("Rokid：正在请求授权…", false);
        try {
            manager.requestAuthorization(activity, Arrays.asList(
                            GlassPermission.CAMERA, GlassPermission.MICROPHONE, GlassPermission.MEDIA),
                    new Function1<AuthResult, Unit>() {
                        @Override
                        public Unit invoke(AuthResult result) {
                            onAuthResult(result);
                            return Unit.INSTANCE;
                        }
                    });
        } catch (Throwable error) {
            report("Rokid：授权请求抛错：" + error.getClass().getSimpleName(), false);
        }
    }

    /**
     * 把 {@code onActivityResult} 转给 SDK（有些机型/版本授权结果从 activity 回来）。
     *
     * @return true = 这次结果属于 Rokid 授权（调用方不必再往下传）
     */
    public boolean handleActivityResult(int resultCode, Intent data) {
        if (manager == null) return false;
        try {
            AuthResult result = manager.parseAuthorizationResult(resultCode, data);
            if (result == null) return false;
            onAuthResult(result);
            return true;
        } catch (Throwable error) {
            return false;
        }
    }

    private void onAuthResult(AuthResult result) {
        if (result != null && result.isSuccess()) {
            token = result.getToken() == null ? "" : result.getToken();
            openSession();
            return;
        }
        String code = result == null ? "?" : codeName(result.getErrorCode());
        report("Rokid：授权失败（" + code + "）", false);
    }

    private boolean compatible() {
        try {
            return manager.checkRokidAppCompatibility(appContext) instanceof RokidAppStatus.Compatible;
        } catch (Throwable error) {
            return false;
        }
    }

    /**
     * 建会话并连接。
     *
     * <p>界面 JSON 在**建会话时**就给（{@code SessionConfig.viewData}）—— 镜片端的
     * CustomView 是"会话的一部分"，不是连上之后另开一个页面。
     */
    private void openSession() {
        if (started) return;
        closeSession();   // 上一次的会话必须先收：同一个 manager 上第二次 create 会报 ALREADY_EXISTS
        try {
            int fontSize = fontSp();
            SessionConfig config = new SessionConfig(
                    SessionType.CUSTOM_VIEW,
                    null,                                   // 不做 CUSTOM_APP
                    AiInterceptMode.ALLOW_WITH_PAUSE,       // 眼镜的 AI 助手可以打断（官方缺省）
                    5000L,                                  // 终止宽限期：1~30 秒
                    new SessionTimeouts(),
                    CxrViewJson.openView("", fontSize + "sp"),
                    null,                                   // viewIconData：不用图标
                    null,                                   // glassesActivityName：CUSTOM_VIEW 不用
                    null);                                  // glassesApkPath：CUSTOM_VIEW 不用
            session = manager.create(config);
            if (session == null) {
                report("Rokid：会话创建失败", false);
                return;
            }
            session.addLifecycleCallback(lifecycle);
            report("Rokid：正在连接…", false);
            session.connect(token);
        } catch (Throwable error) {
            report("Rokid：建会话抛错：" + error.getClass().getSimpleName(), false);
            session = null;
        }
    }

    /** 一句译文：只发一行字的增量更新（始终带上当前字号，见 5.138）。 */
    public void push(String text) {
        if (!started || session == null) return;
        String show = text == null ? "" : text;
        // 同一句、同一字号不发两次：CustomView 的更新会走一趟蓝牙链路，重复发只是白耗。
        // （调过字号之后 lastText 会被清空，所以"同一句 + 新字号"能立刻重发一次。）
        if (show.equals(lastText) && pushedAtFontSp == fontSp()) return;
        lastText = show;
        pushedAtFontSp = fontSp();
        try {
            SessionResult<Unit> result = session.customViewUpdate(
                    CxrViewJson.updateText(show, fontSp() + "sp"));
            if (result != null && !result.isSuccess()) {
                report("Rokid：更新失败（" + codeName(result.getCode()) + "）", started);
            }
        } catch (Throwable error) {
            report("Rokid：更新抛错：" + error.getClass().getSimpleName(), started);
        }
    }

    /** 停止投屏（关会话）。可重复调用。 */
    public void stop() {
        if (session == null) {
            started = false;
            report(STATUS_IDLE, false);
            return;
        }
        closeSession();
        report("Rokid：已停止投屏", false);
    }

    /** 进程退出前调（幂等）。 */
    public void close() {
        closeSession();
    }

    private void closeSession() {
        CxrSession old = session;
        session = null;
        started = false;
        lastText = null;
        if (old != null) {
            try {
                old.removeLifecycleCallback(lifecycle);
            } catch (Throwable ignored) {
                // 会话已经没了也无所谓
            }
            try {
                old.close();
            } catch (Throwable ignored) {
                // 同上
            }
        }
    }

    /**
     * 镜片上的字号（sp）。
     *
     * <p>5.138：支持**手动调**（用户要求"像亮亮那样能调字号"）。取值优先级：
     * 手动设过的（{@link #setFontSizeSp}）→ 按屏高 1/10 推一个 → 32sp。
     *
     * <p>为什么可以只有一个值（亮亮那边是中/葡分开）：亮亮的字号是**画布 px**，
     * 和手机密度、画布尺寸强相关；而 sp 已经被系统归一过，镜片端又是它自己排版 ——
     * 中葡在同一 sp 下的观感差异比亮亮小得多。真机上如果某种语言明显偏小，再拆也不迟。
     */
    public int fontSp() {
        if (fontSizeSp > 0) return fontSizeSp;
        int[] size = displaySize();
        int height = size[1];
        if (height <= 0) return 32;
        int guess = Math.round(height / 10f);
        return Math.max(24, Math.min(64, guess));
    }

    /** 设字号（5.138）。投屏中改也立刻生效：下一条推送会带上新字号（不必重建会话）。 */
    public void setFontSizeSp(int sp) {
        fontSizeSp = Math.max(16, Math.min(96, sp));
    }

    /** 镜片上一次显示的文字（调字号后可以原样再推一次，立刻看到效果）。 */
    public String lastPushedText() {
        return lastText;
    }

    private String codeName(SessionErrorCode code) {
        return code == null ? "?" : code.name();
    }

    /**
     * 把连接失败的错误码翻成"下一步去干什么"（5.135）。
     *
     * <p>为什么要翻：`onConnectResult(false, CODE)` 的 CODE 才是"卡在哪一层"的唯一判据。
     * 原来只打枚举名，用户看到 `LINK_NOT_READY` 不知道该动哪里。
     */
    static String describeConnectError(SessionErrorCode code) {
        if (code == null) return "原因未知（SDK 没给错误码）";
        switch (code) {
            case ROKID_APP_NOT_INSTALLED:
                return "手机没装 Rokid AI App";
            case ROKID_APP_VERSION_LOW:
                return "Rokid AI App 版本过低，请升级";
            case BT_NOT_CONNECTED:
                return "AI App 里眼镜还没连上（系统蓝牙配对不算）——去 AI App 主界面确认眼镜显示已连接";
            case LINK_NOT_READY:
                return "AI App 的链路还没就绪 —— 把 Rokid AI App 切到前台停一两秒，再回来重试";
            case LINK_LOST:
                return "跟 AI App 的链路断了 —— 重开 AI App 再试";
            case LINK_TIMEOUT:
                return "跟 AI App 握手超时 —— 重开 AI App 再试";
            case NOT_AUTHENTICATED:
            case TOKEN_EXPIRED:
                return "授权失效 —— 重新点「开始投屏」授权一次";
            case CONNECT_FAILED:
                return "连接失败（AI App 或眼镜侧拒绝）—— 拔插眼镜后重试";
            case SCENE_OPEN_FAILED:
                return "界面被镜片端拒了（CustomView 的 JSON 有问题）—— 把这条报给维护者";
            case RESOURCE_PREPARE_FAILED:
                return "眼镜侧资源准备失败 —— 拔插眼镜后重试";
            case SESSION_ALREADY_EXISTS:
                return "已经有一个会话在（上一次没关干净）—— 退出本页再进来";
            case SESSION_PAUSED:
                return "会话被暂停了（眼镜的 AI 助手插了一句）—— 等它说完会自动恢复";
            case UNKNOWN:
            case INTERNAL_ERROR:
                return "SDK 内部错误 —— 记下这次现象报给维护者";
            default:
                return code.name();
        }
    }

    /** 状态只从主线程往界面推（SDK 回调在哪个线程来是不保证的）。 */
    private void report(String text, boolean casting) {
        status = text;
        if (listener == null) return;
        main.post(new Runnable() {
            @Override
            public void run() {
                listener.onRokidStatus(text, casting);
            }
        });
    }

    /** 会话生命周期：只用来维护"我到底在不在投屏"这一个事实。 */
    private final ISessionLifecycleCbk lifecycle = new ISessionLifecycleCbk() {
        @Override
        public void onSessionStarted() {
            started = true;
            report("Rokid：投屏中", true);
        }

        @Override
        public void onSessionPaused(PausedReason reason) {
            // 暂停不是关闭：眼镜可能只是抬起来了 / AI 助手插了一句。
            started = false;
            String why = reason == null ? "?" : reason.name();
            report("Rokid：暂停（" + why + "）", false);
        }

        @Override
        public void onSessionResumed() {
            started = true;
            report("Rokid：投屏中", true);
        }

        @Override
        public void onSessionTerminating(TerminatingReason reason, long gracePeriodMs) {
            started = false;
            String why = reason == null ? "?" : reason.name();
            report("Rokid：正在结束（" + why + "，宽限 " + gracePeriodMs + "ms）", false);
        }

        @Override
        public void onSessionClosed(CloseReason reason) {
            started = false;
            session = null;
            lastText = null;
            String why = reason == null ? "?" : reason.name();
            report("Rokid：会话已关闭（" + why + "）", false);
        }

        @Override
        public void onConnectResult(boolean success, SessionErrorCode errorCode) {
            if (success) {
                report("Rokid：已连接（等会话就绪）", false);
            } else {
                // 5.135：错误码是"卡在哪一层"的唯一判据，翻成人话再说下一步（别只丢枚举名）
                report("Rokid：连接失败（" + codeName(errorCode) + "）—— "
                        + describeConnectError(errorCode), false);
            }
        }
    };
}
