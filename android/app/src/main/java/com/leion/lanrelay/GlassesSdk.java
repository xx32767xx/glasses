package com.leion.lanrelay;

import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;

import java.lang.reflect.Method;

/**
 * 眼镜投屏：SDK 访问的唯一入口。
 * ============================================================================
 *
 * 设计上有两个刻意的选择，都是为了"出了问题能查"：
 *
 * <b>① 所有 SDK 调用都用反射。</b>
 * 官方样例不在我们仓库里，我**没有编译过**任何一处调用（本机 Gradle 之前的依赖
 * 缓存不全，见 {@code docs/09} 第 10 节）。反射的代价是少了编译期检查，
 * 换来的是：
 *   · 方法名/签名对不上时**能明确报出来是哪一处**（而不是整个 App 崩在启动）
 *   · 某几个可选调用（亮度、端口）失败**不影响主功能**（投屏）
 * 如果以后拿到了能编译的环境，应当把这些改成直接的强类型调用。
 *
 * <b>② 清理是硬要求，而且要幂等。</b>
 * SDK 的官方注释明确写着：不在进程退出前 destroy，**眼镜可能残留脏 fd 导致整机重启**。
 * 而且要**先 stopAllServices 再 destroy**。所以 {@link #destroy()} 里按这个顺序做，
 * 并且用 {@code destroyed} 标志挡住重复调用（Activity.onDestroy 与 onCleared 都可能调）。
 *
 * 依据：{@code LeionProDemo_SDK/samplecode/.../data/glass/GlassSdkBridgeImpl.kt}
 * 与 {@code docs/09-眼镜SDK接入.md}。
 */
public class GlassesSdk {

    private static final String TAG = "GlassesSdk";

    // SDK 的类名（点号形式，反射用）
    private static final String CLS_SDK = "com.llvision.glass3.platform.LLVisionGlass3SDK";
    private static final String CLS_SERVICE_MANAGER = "com.llvision.glxss.common.service.GlassServiceManager";
    private static final String CLS_DEVICE = "com.llvision.glass3.platform.IGlass3Device";
    /**
     * ⚠️ {@code ILCDClient.getGlassDisplay} 的参数类型是 {@code library.IGlassDevice}，
     * **不是** {@code platform.IGlass3Device}。
     *
     * <p>两者是继承关系（{@code platform.IGlass3Device extends library.IGlassDevice}），
     * 所以传进去的对象没问题，但**反射查找必须用声明时的那个类型** ——
     * 用子接口去 {@code getMethod} 会直接 NoSuchMethodException。
     * 我就是这么错的（`javap` 核对后才发现）。
     */
    private static final String CLS_LCD_DEVICE = "com.llvision.glass3.library.IGlassDevice";

    /**
     * ⚠️ {@code Glass3DeviceClient} 是 **{@code @IntDef} 注解接口，不是枚举**。
     *
     * <p>Kotlin 里 {@code IGlass3Device.Glass3DeviceClient.LCD} 的写法枚举和静态常量
     * 长得一模一样，我按枚举写成了 {@code getEnumConstants()} —— 结果是
     * {@code NullPointerException: Attempt to get length of null array}，
     * 于是永远取不到 LCD 客户端。
     *
     * <p>实际结构（{@code javap} 实测）：
     * <pre>
     * public interface IGlass3Device$Glass3DeviceClient extends java.lang.annotation.Annotation {
     *     public static final int CAMERA;  LCD;  SENSOR;  KEY;  AI;
     * }
     * </pre>
     * 对应方法是 {@code getGlass3Client(int)}。
     */
    private static final String CLS_DEVICE_CLIENT = CLS_DEVICE + "$Glass3DeviceClient";

    /** 样例里的延迟：设备连上后要等一会儿再拉服务（SERVICE_INIT_DELAY_MS = 3000L）。 */
    private static final long SERVICE_INIT_DELAY_MS = 3000L;

    /** 投屏需要 Activity（SDK 内部要用它做屏幕采集）。用 Activity 而不是 Context，避免强转失败。 */
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Listener listener;

    private Object sdk;
    private Object device;
    private Object display;
    private boolean destroyed;
    private boolean casting;
    /** init() 是否已经调用过（界面用它避免重复初始化，以及判断"从设置页回来要不要补跑"）。 */
    private boolean initialized;
    private String lastError = "";
    /**
     * 上一次投屏走到第几步（① 取客户端 / ② 取 display / ③ createCaptureScreen / ④ 双眼）。
     *
     * <p>投屏的四步都可能失败，而"点了没反应"在真机上无法区分是哪一步 ——
     * 界面需要把这个值显示出来，否则只能靠 adb（真机不一定能用）。
     */
    private String step = "";

    /**
     * LCD 服务是否已经拉起来（{@code GlassServiceManager.initAllServices} 回来）。
     *
     * <p>为什么要这个标志：投屏依赖 LCD 服务。样例里连接之后要**等 3 秒**
     * （{@code SERVICE_INIT_DELAY_MS}）才拉服务，抢在它前面投屏，
     * 第 ② 步 {@code getGlassDisplay} 就会拿到 null。
     * 所以"想投屏"和"能投屏"必须分开 —— 见 {@link #requestCast(View)}。
     */
    private boolean servicesReady;
    /** 界面交来的"想投屏"的 View，等服务就绪后再真的投。 */
    private View pendingCast;
    /** 兜底：万一服务一直没回报，到点也强行试一次（不能让人对着按钮干等）。 */
    private final Runnable pendingCastFallback = () -> {
        if (pendingCast != null && !casting) {
            Log.w(TAG, "服务就绪回报超时，仍然尝试投屏");
            tryPendingCast(true);
        }
    };

    public interface Listener {
        /** 状态变化（连接、投屏、错误）。每条都会带上"发生了什么"，界面直接显示。 */
        void onGlassesStatus(String status, boolean connected);
    }

    public GlassesSdk(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
    }

    public boolean isConnected() {
        return device != null;
    }

    /** init() 调用过了吗。**幂等**：重复调用直接返回，不会重复注册回调。 */
    public boolean isInitialized() {
        return initialized;
    }

    /**
     * 当前 SDK 认出几个眼镜设备。
     *
     * <p>诊断用：<b>0 就是"没认出设备"</b>，那 USB 授权、投屏全都无从谈起 ——
     * 真机上 adb 不一定能用，所以要让 App 自己把这个数字显示出来。
     */
    public int getDeviceCount() {
        try {
            Class<?> sdkClass = Class.forName(CLS_SDK);
            Object instance = sdkClass.getMethod("getInstance").invoke(null);
            Object list = sdkClass.getMethod("getGlass3DeviceList").invoke(instance);
            if (list instanceof java.util.List) return ((java.util.List<?>) list).size();
        } catch (Throwable error) {
            Log.i(TAG, "getDeviceCount skipped: " + shortMessage(error));
        }
        return -1;
    }

    public boolean isCasting() {
        return casting;
    }

    public String getLastError() {
        return lastError;
    }

    /** 上一次投屏走到哪一步（界面诊断行显示它，用来定位"点了没反应"）。 */
    public String getStep() {
        return step;
    }

    /** LCD 服务拉起来了吗（界面诊断行显示它 —— 没就绪时投屏是排队等待，不是没反应）。 */
    public boolean isServicesReady() {
        return servicesReady;
    }

    // ── 初始化 ─────────────────────────────────────────────────────────────

    /**
     * 初始化平台 SDK 并注册连接回调。
     *
     * <p>整个调用包在 try/catch 里：SDK 内部会去枚举 USB 设备、起服务，
     * 在没有眼镜插着的时候也可能抛异常 —— 那种情况不能让 App 崩，
     * 只该显示"眼镜未连接"。
     */
    public void init() {
        if (initialized || destroyed) return;
        initialized = true;
        main.post(() -> {
            try {
                Class<?> sdkClass = Class.forName(CLS_SDK);
                Method getInstance = sdkClass.getMethod("getInstance");
                sdk = getInstance.invoke(null);

                Class<?> listenerClass = Class.forName(
                        "com.llvision.glass3.platform.ConnectionStatusListener");

                Object connectionListener = java.lang.reflect.Proxy.newProxyInstance(
                        listenerClass.getClassLoader(),
                        new Class<?>[] { listenerClass },
                        (proxy, method, args) -> {
                            String name = method.getName();
                            if ("onDeviceConnect".equals(name)) {
                                Object connected = args != null && args.length > 0 ? args[0] : null;
                                main.post(() -> onDeviceConnected(connected));
                            } else if ("onDeviceDisconnect".equals(name)) {
                                main.post(() -> onDeviceDisconnected());
                            } else if ("onServiceDisconnected".equals(name)) {
                                main.post(() -> {
                                    device = null;
                                    report("眼镜服务已断开", false);
                                });
                            } else if ("onError".equals(name)) {
                                int code = args != null && args.length > 0 && args[0] instanceof Integer
                                        ? (Integer) args[0] : -1;
                                String message = args != null && args.length > 1
                                        ? String.valueOf(args[1]) : "";
                                main.post(() -> onSdkError(code, message));
                            }
                            return null;
                        });

                // init(Context, ConnectionStatusListener)
                Method init = sdkClass.getMethod("init", Context.class, listenerClass);
                init.invoke(sdk, activity.getApplicationContext(), connectionListener);

                // ⚠️ 补查一次"已经插着的"设备。
                //    只在 onDeviceConnect 回调里投屏会漏一种常见情况：
                //    **眼镜先插着、再打开 App** —— 那时"插入"这个事件早就过去了，
                //    回调不会再触发，于是永远不会开始投屏，而界面上什么都不显示。
                //    样例里有 queryHasConnectedDevice()（也是它的"连接状态"初始化方式）。
                if (queryHasConnectedDevice(sdkClass)) {
                    report("眼镜已连接（启动时就在）", true);
                    onDeviceConnected(null);
                } else {
                    report("眼镜未连接（等插上眼镜）", false);
                }
            } catch (Throwable error) {
                report("眼镜 SDK 初始化失败：" + shortMessage(error), false);
                Log.w(TAG, "init failed", error);
            }
        });
    }

    /** SDK: {@code getGlass3DeviceList()?.isNotEmpty()} —— 不依赖回调判断"现在插着没有"。 */
    private boolean queryHasConnectedDevice(Class<?> sdkClass) {
        try {
            Object list = sdkClass.getMethod("getGlass3DeviceList").invoke(sdk);
            if (list instanceof java.util.List) {
                java.util.List<?> devices = (java.util.List<?>) list;
                if (!devices.isEmpty()) {
                    // 顺手把设备对象留下 —— 后面投屏要用它
                    if (device == null) device = devices.get(0);
                    return true;
                }
            }
        } catch (Throwable error) {
            Log.i(TAG, "getGlass3DeviceList skipped: " + shortMessage(error));
        }
        return false;
    }

    /**
     * 读眼镜的真实分辨率（{@code deviceInfo.resolutionWidth / resolutionHeight}）。
     *
     * <p>为什么要读而不是写死：投屏画面**必须按眼镜的宽高比**来，否则真机上报
     * 「数据越界」（SDK 按设备分辨率分配缓冲，却从一块尺寸对不上的 View 取像素）。
     * 我第一版写死了 3:4（0.75），那是**猜的** —— 这里改成从设备信息读真实值。
     *
     * <p>{@code DeviceInfo} 是 Kotlin data class，getter 名字可能是
     * {@code getResolutionWidth()} 也可能是字段 {@code resolutionWidth}，
     * 所以两种都试一遍（读不到就返回 0，由调用方退回保守缺省）。
     *
     * @return {width, height}；读不到返回 {0, 0}
     */
    public int[] queryDisplaySize() {
        if (device == null) return new int[] { 0, 0 };
        try {
            Object info = device.getClass().getMethod("getDeviceInfo").invoke(device);
            if (info == null) return new int[] { 0, 0 };
            // ⚠️ DeviceInfo.getResolutionWidth()/Height() 返回的是 **String**，不是 int
            //    （javap 实测）。按 int 读会静默拿到 0，于是"分辨率读到了"变成"没读到"。
            int width = parseSize(info, "getResolutionWidth");
            int height = parseSize(info, "getResolutionHeight");
            if (width > 0 && height > 0) {
                Log.i(TAG, "眼镜分辨率 " + width + "×" + height);
                return new int[] { width, height };
            }
            Log.i(TAG, "分辨率读到 " + width + "×" + height + "（不合法，退回缺省）");
        } catch (Throwable error) {
            Log.i(TAG, "queryDisplaySize skipped: " + shortMessage(error));
        }
        return new int[] { 0, 0 };
    }

    /** 读一个"字符串形式的尺寸"字段并转 int（读不到或不是数字都返回 0）。 */
    private static int parseSize(Object target, String getter) {
        try {
            Object value = target.getClass().getMethod(getter).invoke(target);
            if (value == null) return 0;
            // 可能是 String（实测），也可能是 Integer（换固件后），两种都认
            if (value instanceof Integer) return (Integer) value;
            String text = String.valueOf(value).trim();
            return text.isEmpty() ? 0 : Integer.parseInt(text);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    private void onDeviceConnected(Object connectedDevice) {
        // ⚠️ 不要无条件覆盖 device。
        //    启动时"眼镜先插着"那条路（init 里的 queryHasConnectedDevice）已经
        //    从 getGlass3DeviceList() 取到设备并存进 device，随后补调的
        //    onDeviceConnected(null) 会把**已经拿到的设备又清成 null** ——
        //    于是 isConnected() 变 false、startServices() 提前 return、
        //    界面上"设备 1 个"但点开始投屏什么都不发生。
        //    真机上遇到的就是这个：设备数与连接状态自相矛盾。
        if (connectedDevice != null) {
            device = connectedDevice;
        }
        report("眼镜已连接", true);
        // 连接后延迟拉服务 —— 立刻拉会失败（样例实测 3 秒）
        main.postDelayed(this::startServices, SERVICE_INIT_DELAY_MS);
    }

    private void onDeviceDisconnected() {
        device = null;
        display = null;
        casting = false;
        // 拔了眼镜，服务显然也不在了 —— 下次插上要重新等服务就绪再投屏
        servicesReady = false;
        pendingCast = null;
        main.removeCallbacks(pendingCastFallback);
        report("眼镜已断开", false);
    }

    private void startServices() {
        if (destroyed) return;
        if (device == null) {
            // 设备没了（拔了）—— 别再往下走了，但也不留一个永远不 ready 的标志
            servicesReady = true;
            return;
        }
        try {
            Class<?> manager = Class.forName(CLS_SERVICE_MANAGER);
            // initAllServices(Context, IGlass3Device)
            Class<?> deviceClass = Class.forName(CLS_DEVICE);
            Method initAll = manager.getMethod("initAllServices", Context.class, deviceClass);
            initAll.invoke(null, activity.getApplicationContext(), device);
        } catch (Throwable error) {
            // 服务拉不起来不一定是致命的：投屏可能仍然能用。记下来继续。
            Log.w(TAG, "initAllServices failed", error);
            report("眼镜服务启动异常（可能仍可投屏）：" + shortMessage(error), true);
        } finally {
            // ⚠️ 无论成功失败都置 ready。
            //    如果只在成功时置，失败就永远卡在"等服务就绪"，
            //    表现又变成"点了没反应" —— 那正是我们正在修的病。
            servicesReady = true;
        }
        // 服务就绪 → 把界面之前排队的投屏请求放行
        tryPendingCast(false);
    }

    /**
     * 界面说"我要投屏" → 记下来，等服务就绪后再真的投。
     *
     * <p>为什么不让界面直接调 {@link #cast(View)}：投屏依赖 LCD 服务，
     * 而服务在连接后 3 秒才拉起来。界面不知道这个时序，直接投就会在
     * 第 ② 步拿到 null。把时序**收进 SDK 内部**，界面只管说"我要投屏"。
     *
     * <p>同时挂一个兜底：万一服务就绪的回报一直不来，到点也强行试一次 ——
     * 不能让用户对着按钮干等（这是"点了没反应"最坏的一种）。
     */
    public void requestCast(View view) {
        if (view == null) return;
        pendingCast = view;
        main.removeCallbacks(pendingCastFallback);
        if (servicesReady) {
            tryPendingCast(false);
        } else {
            main.postDelayed(pendingCastFallback, SERVICE_INIT_DELAY_MS + 2000L);
        }
    }

    /**
     * @param force true = 服务还没回报也硬投（兜底路径）
     */
    private void tryPendingCast(boolean force) {
        if (pendingCast == null || destroyed || casting) return;
        if (!servicesReady && !force) return;
        if (device == null) return;
        View view = pendingCast;
        pendingCast = null;
        main.removeCallbacks(pendingCastFallback);
        cast(view);
    }

    // ── 投屏 ───────────────────────────────────────────────────────────────

    /**
     * 把某个 View 投到眼镜上。这是"往眼镜显示字幕"的全部实现 ——
     * SDK 没有推文字的接口，只有投屏（见 docs/09 第 1 节）。
     *
     * <p>⚠️ 四步**逐步报告**，不共用一个 try/catch。理由：真机上曾出现
     * "点了开始投屏没反应"，而笼统的"投屏失败"完全无法定位 ——
     * 这四步里任何一步的方法名/签名写错（反射没有编译期校验）都会失败，
     * 而它们失败的原因与修法**完全不同**。所以每一步都单独报。
     */
    public void cast(View view) {
        main.post(() -> {
            if (destroyed) return;
            if (device == null) {
                report("眼镜未连接，投屏失败", false);
                return;
            }
            casting = false;
            step = "";

            // ① 拿 LCD 客户端
            step = "① 取 LCD 客户端";
            Object lcdClient;
            try {
                lcdClient = getLcdClient();
            } catch (Throwable error) {
                reportWithStep("① 取 LCD 客户端失败", error);
                return;
            }
            if (lcdClient == null) {
                report("① 取不到 LCD 客户端（getGlass3Client(LCD) 返回 null）", true);
                return;
            }

            // ② getGlassDisplay(device)
            step = "② getGlassDisplay";
            try {
                display = getGlassDisplay(lcdClient);
            } catch (Throwable error) {
                reportWithStep("② getGlassDisplay 失败", error);
                return;
            }
            if (display == null) {
                report("② getGlassDisplay 返回 null（设备可能还没就绪，退后几秒重试）", true);
                return;
            }

            // ③ createCaptureScreen(Context, View)
            //
            // ⚠️ 是 **Context**，不是 Activity。样例里传的是 ComponentActivity，
            //    因为 Activity 是 Context 的子类所以看起来像传 Activity，
            //    但接口声明的是 Context —— 用 Activity.class 去 getMethod 会找不到方法。
            //    （这里之前就是这么错的，表现为③ NoSuchMethodException。）
            step = "③ createCaptureScreen";
            try {
                Method create = display.getClass()
                        .getMethod("createCaptureScreen", Context.class, View.class);
                create.invoke(display, activity, view);
            } catch (NoSuchMethodException error) {
                report("③ 没有 createCaptureScreen(Context, View) 这个方法 —— 看 API 探测", true);
                Log.w(TAG, "createCaptureScreen(Context,View) not found", error);
                return;
            } catch (IllegalArgumentException error) {
                // SDK 嫌画面尺寸不对时会抛 IllegalArgumentException（真机上表现为「数据越界」：
                // 它按设备分辨率分配缓冲，却从一块尺寸对不上的 View 里取像素）。
                // 兜底：改用带显式宽高的重载，把从 DeviceInfo 读到的真实分辨率报给它。
                if (!castWithExplicitSize(display, view)) {
                    reportWithStep("③ createCaptureScreen 抛异常（且显式尺寸兜底也失败）", error);
                    return;
                }
            } catch (Throwable error) {
                reportWithStep("③ createCaptureScreen 抛异常", error);
                return;
            }

            casting = true;
            step = "④ 已投屏";
            report("眼镜投屏中", true);

            // ④ 打开双眼（失败不影响投屏本身）
            tryOpenBothEyes();
        });
    }

    /**
     * SDK 的 {@code onError} 回调。三个码要区别对待。
     *
     * <p>码表来自 AAR 里的 {@code com.llvision.glass3.platform.ErrorCode}：
     * <pre>
     *  1 NOT_PERMISSION_STORAGE   2 NOT_PERMISSION_AUDIO    3 NOT_PERMISSION_OVERLAY
     *  4 NOT_PERMISSION_USB       5 SERVICE_OCCUPIED        6 SERVICE_NOT_BIND
     *  7 CLIENT_NOT_FOUND         8..14 FIRMWARE_*
     * 10 FIRMWARE_NO_DEVICE       15 DEVICE_NEED_REPLUG
     * </pre>
     *
     * <p><b>15 = DEVICE_NEED_REPLUG 是关键的一条。</b>官方样例的注释写得很清楚：
     * <blockquote>
     * 杀进程后眼镜仍停留在已连接脏态：平台层为避免打崩内核 USB 主控
     * 已主动放弃自动复位，回调 DEVICE_NEED_REPLUG。
     * </blockquote>
     * 也就是说 <b>进程被强杀（闪退、force-stop、install -r 装新包）时，
     * 眼镜会留在"以为自己还连着"的脏态，而且 SDK 不会自己修</b>。
     * 唯一解法是**拔掉再插上**。
     *
     * <p>这条值得单独处理，因为它的现象极容易被误判：设备列表变 0、连接状态没了、
     * 投屏必然失败，但报的错和"没插眼镜""驱动坏了"看起来一样 ——
     * 用户会去反复重装、重启手机，而正确动作只是拔插一次。
     */
    private void onSdkError(int code, String message) {
        if (code == 10) {
            // FIRMWARE_NO_DEVICE：插拔眼镜时固件模块先于设备枚举触发，
            // 属已知瞬时提示，不影响连接（样例明确忽略）。忽略，免得刷屏。
            Log.i(TAG, "onError ignored (benign): FIRMWARE_NO_DEVICE");
            return;
        }
        if (code == 15) {
            // DEVICE_NEED_REPLUG：脏态，SDK 不会自愈。清干净本地状态并明确要求拔插，
            // 否则后面每个操作都会以"没连接"失败，让人以为是别的问题。
            device = null;
            display = null;
            casting = false;
            servicesReady = false;
            pendingCast = null;
            main.removeCallbacks(pendingCastFallback);
            lastError = "眼镜处于脏态，需要拔掉重新插上（错误码 15 DEVICE_NEED_REPLUG）";
            if (listener != null) listener.onGlassesStatus(
                    "⚠ 请拔掉眼镜再插上（上次退出时眼镜被留在了连接状态）", false);
            return;
        }
        lastError = "SDK 报错 " + code + "：" + message;
        if (listener != null) {
            listener.onGlassesStatus("眼镜 SDK 报错 " + code + "：" + message, device != null);
        }
    }

    /** 报告时带上"卡在第几步"+ 最内层异常类型与消息。 */
    private void reportWithStep(String where, Throwable error) {
        String detail = shortMessage(error);
        lastError = where + "：" + detail;
        Log.w(TAG, where, error);
        if (listener != null) listener.onGlassesStatus(where + "：" + detail, device != null);
    }

    /**
     * 用**显式宽高**的重载投屏：{@code createCaptureScreen(Context, View, int, int)}。
     *
     * <p>只在 2 参重载因尺寸问题（{@code IllegalArgumentException}）失败时走这条路。
     * 宽高取 {@link #queryDisplaySize()} 从 {@code DeviceInfo} 读到的真实分辨率 ——
     * 「数据越界」的成因就是 SDK 按设备分辨率分配缓冲、而 View 的尺寸对不上，
     * 所以把真实分辨率**明确告诉它**是最直接的修法。
     *
     * <p>⚠️ 这两个 int 的语义我没能从 AAR 里确认（字节码里没有参数名，
     * 样例也没用过这个重载），所以我把它当作 width/height 用。
     * 真机上如果这条也失败，探测输出会把它记下来。
     *
     * @return 是否成功
     */
    private boolean castWithExplicitSize(Object display, View view) {
        int[] size = queryDisplaySize();
        if (size[0] <= 0 || size[1] <= 0) {
            Log.w(TAG, "显式尺寸兜底跳过：分辨率读不到");
            return false;
        }
        try {
            Method create = display.getClass()
                    .getMethod("createCaptureScreen", Context.class, View.class, int.class, int.class);
            create.invoke(display, activity, view, size[0], size[1]);
            Log.i(TAG, "改用显式尺寸投屏 " + size[0] + "×" + size[1]);
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "createCaptureScreen(Context,View,int,int) failed", error);
            return false;
        }
    }

    public void stopCast() {
        main.post(() -> {
            if (display == null || !casting) return;
            try {
                Method stop = display.getClass().getMethod("stopCaptureScreen");
                stop.invoke(display);
            } catch (Throwable error) {
                Log.w(TAG, "stopCaptureScreen failed", error);
            }
            casting = false;
            report("眼镜投屏已停止", device != null);
        });
    }

    /**
     * 打开双眼显示。
     *
     * <p>正确 API 是 {@code setDisplayPortNumber(int port, int on)}，
     * 对应样例 {@code g.setDisplayPortNumber(port, if (on) 1 else 0)}，
     * 返回值与 {@code ResultCode.SUCCESS}（= 0）比较。
     *
     * <p>⚠️ 我第一版写的是 {@code setPort(int, boolean)} —— 那个方法**根本不存在**
     * （{@code IGlassDisplay} 上只有 {@code setDisplayPortNumber}）。
     * 因为调用是包在 try/catch 里的，它一直静默失败，只在日志里留一行。
     *
     * <p>常量从 {@code IGlassDisplay.DOUBLE_EYE_PORT} 反射读，不写死具体数值。
     */
    private void tryOpenBothEyes() {
        try {
            Object target = getGlassDisplay(getLcdClient());
            if (target == null) return;
            Class<?> displayClass = Class.forName("com.llvision.glass3.core.lcd.client.IGlassDisplay");
            int port = displayClass.getField("DOUBLE_EYE_PORT").getInt(null);
            Method setPort = displayClass.getMethod("setDisplayPortNumber", int.class, int.class);
            Object result = setPort.invoke(target, port, 1);
            Log.i(TAG, "setDisplayPortNumber(DOUBLE_EYE_PORT=" + port + ", 1) → " + result);
        } catch (Throwable error) {
            // 不是致命问题：默认通常就是双眼
            Log.i(TAG, "setDisplayPortNumber skipped: " + shortMessage(error));
        }
    }

    /**
     * 取 LCD 客户端。
     *
     * <p>对应 Kotlin：{@code sdk.getGlass3Client(IGlass3Device.Glass3DeviceClient.LCD) as ILCDClient}
     *
     * <p>⚠️ 常量是 {@code int} 而不是枚举常量（见 {@link #CLS_DEVICE_CLIENT} 的注释），
     * 所以走 {@code getField("LCD").getInt(null)} + {@code getGlass3Client(int)}。
     */
    private Object getLcdClient() throws Exception {
        Class<?> sdkClass = Class.forName(CLS_SDK);
        Object instance = sdkClass.getMethod("getInstance").invoke(null);
        Class<?> clientKeys = Class.forName(CLS_DEVICE_CLIENT);
        int lcd = clientKeys.getField("LCD").getInt(null);
        Method getClient = sdkClass.getMethod("getGlass3Client", int.class);
        return getClient.invoke(instance, lcd);
    }

    /** 取 display（{@code ILCDClient.getGlassDisplay(device)}）。参数类型必须是 library.IGlassDevice。 */
    private Object getGlassDisplay(Object lcdClient) throws Exception {
        Class<?> deviceClass = Class.forName(CLS_LCD_DEVICE);
        Method method = lcdClient.getClass().getMethod("getGlassDisplay", deviceClass);
        return method.invoke(lcdClient, device);
    }

    // ── API 探测（反射调用没有编译期校验，用它确认方法名与签名）──────────────

    /**
     * 把 SDK 的真实结构打出来：每一步反射调用**当场试一遍**，成功打 ✓，失败打 ✗ 并给出原因。
     *
     * <p><b>为什么必须有这个</b>：我对 SDK 的每一处调用都是**反射**
     * （{@code platform-4.8.0.4-release.aar} 我只是把类名读出来，没有编译期校验），
     * 所以方法名与参数类型**从来没被编译器检查过**。一旦写错，真机上的表现
     * 就是"点了没反应"，而 adb 在真机上不一定能用 —— 只能让 App 自己说。
     *
     * <p>设计上刻意**不猜类名**：先把对象真的取出来，再打印它运行时的类名与方法签名。
     * 第一版我硬编码了 {@code ILCDClient} / {@code IGlassDisplay} 去猜，
     * 但反射要的是**精确签名**，猜类名毫无意义 —— 打印实际拿到的东西才可靠。
     *
     * <p>唯一的副作用：本方法只做 {@code getMethod} 查找，**不 invoke**
     * {@code createCaptureScreen}（那会真的开始投屏，探测不该改变状态）。
     *
     * @return 多行文本，按 ①②③… 编号，第一个 ✗ 就是卡住的位置
     */
    public String probeApi() {
        StringBuilder out = new StringBuilder();

        // ① SDK 单例
        Class<?> sdkClass = null;
        Object sdkInstance = null;
        try {
            sdkClass = Class.forName(CLS_SDK);
            sdkInstance = sdkClass.getMethod("getInstance").invoke(null);
            out.append("① ✓ SDK 单例 ").append(sdkInstance.getClass().getName()).append("\n");
        } catch (Throwable error) {
            out.append("① ✗ 取 SDK 单例失败：").append(shortMessage(error)).append("\n");
        }

        // ② 设备列表 + Glass3DeviceClient 枚举常量（LCD 这个常量名错了就取不到客户端）
        if (sdkClass != null) {
            try {
                Object list = sdkClass.getMethod("getGlass3DeviceList").invoke(sdkInstance);
                out.append("② ✓ getGlass3DeviceList() → ").append(describe(list)).append("\n");
            } catch (Throwable error) {
                out.append("② ✗ getGlass3DeviceList：").append(shortMessage(error)).append("\n");
            }
        }
        // ③ Glass3DeviceClient 的常量。
        //    ⚠️ 它是 @IntDef 注解接口而不是枚举 —— 第一版用 getEnumConstants() 拿到 null，
        //    报的是 NullPointerException，看不出"其实这不是枚举"。所以这里按**字段**读，
        //    并且把"它到底是什么类型"也打出来。
        try {
            Class<?> clientKeys = Class.forName(CLS_DEVICE_CLIENT);
            out.append("③ ✓ ").append(CLS_DEVICE_CLIENT)
               .append(clientKeys.isAnnotation() ? "（注解接口，不是枚举）" : "")
               .append("\n");
            StringBuilder keys = new StringBuilder();
            for (java.lang.reflect.Field field : clientKeys.getFields()) {
                keys.append(field.getName()).append("=").append(field.getInt(null)).append(" ");
            }
            out.append("   常量：").append(keys).append("\n");
            if (sdkClass != null) {
                out.append("   getGlass3Client 重载：\n")
                   .append(signaturesOf(sdkClass, "getGlass3Client"));
            }
        } catch (Throwable error) {
            out.append("③ ✗ 读 Glass3DeviceClient 常量：").append(shortMessage(error)).append("\n");
        }

        // ④ LCD 客户端：真取一次，打印真实类名 + getGlassDisplay 的所有重载签名
        Object lcd = null;
        try {
            lcd = getLcdClient();
        } catch (Throwable error) {
            out.append("④ ✗ getGlass3Client(LCD)：").append(shortMessage(error)).append("\n");
        }
        if (lcd == null) {
            out.append("④ ✗ getGlass3Client(LCD) 返回 null（设备没就绪？）\n");
        } else {
            out.append("④ ✓ LCD 客户端 ").append(lcd.getClass().getName()).append("\n");
            out.append("   getGlassDisplay 重载：\n")
               .append(signaturesOf(lcd.getClass(), "getGlassDisplay"));
        }

        // ⑤ display 对象
        Object target = null;
        if (lcd != null && device != null) {
            try {
                target = getGlassDisplay(lcd);
                out.append("⑤ ✓ getGlassDisplay(IGlassDevice) → ")
                   .append(target == null ? "null" : target.getClass().getName()).append("\n");
            } catch (Throwable error) {
                out.append("⑤ ✗ getGlassDisplay(IGlassDevice)：").append(shortMessage(error)).append("\n");
            }
        } else {
            // 分开报原因，别只说"跳过" —— 之前这里写死了"device 为 null"，
            // 而实际上卡在 lcd 上，日志自相矛盾（显示 device=有 却说 device 是 null）
            out.append("⑤ ⏭ 跳过（")
               .append(lcd == null ? "LCD 客户端没取到" : "device 是 null")
               .append("）\n");
        }

        // ⑥ 投屏方法签名 —— 只查找不调用
        if (target != null) {
            out.append("   createCaptureScreen 重载：\n")
               .append(signaturesOf(target.getClass(), "createCaptureScreen"));
            boolean hasBoth = false;
            try {
                target.getClass().getMethod("createCaptureScreen", Context.class, View.class);
                hasBoth = true;
            } catch (Throwable ignored) {
                // 没有就是没有，下面统一报
            }
            out.append("⑥ ").append(hasBoth ? "✓" : "✗")
               .append(" createCaptureScreen(Context, View)")
               .append(hasBoth ? " 存在" : " 不存在 —— 用上面的重载对照，改 cast() 里的签名")
               .append("\n");
            out.append("   其他显示方法：\n")
               .append(signaturesOf(target.getClass(), "Capture", "Port", "Luminance", "BackLight"));
        }

        // ⑦ 双眼常量（取不到不影响投屏，默认通常就是双眼）
        try {
            Class<?> displayClass = Class.forName("com.llvision.glass3.core.lcd.client.IGlassDisplay");
            int port = displayClass.getField("DOUBLE_EYE_PORT").getInt(null);
            boolean hasPort = false;
            try {
                displayClass.getMethod("setDisplayPortNumber", int.class, int.class);
                hasPort = true;
            } catch (Throwable ignored) {
                // 下面统一报
            }
            out.append("⑦ ✓ DOUBLE_EYE_PORT = ").append(port)
               .append(" · setDisplayPortNumber(int,int) ").append(hasPort ? "存在" : "不存在").append("\n");
        } catch (Throwable error) {
            out.append("⑦ ✗ 读 DOUBLE_EYE_PORT：").append(shortMessage(error)).append("\n");
        }

        // ⑧ 分辨率（DeviceInfo 里是 String，不是 int —— 按 int 读会静默拿到 0）
        int[] size = queryDisplaySize();
        out.append("⑧ ").append(size[0] > 0 ? "✓" : "✗").append(" 分辨率 ")
           .append(size[0]).append("×").append(size[1])
           .append(size[0] > 0 ? "" : "（读不到，投屏画布用缺省 3:4）").append("\n");

        out.append("device：").append(device == null ? "null" : device.getClass().getName()).append("\n");
        out.append("LCD 服务就绪：").append(servicesReady ? "是" : "否（投屏会排队等服务就绪）").append("\n");
        out.append("投屏步：").append(step.length() == 0 ? "（还没点过开始投屏）" : step).append("\n");
        return out.toString();
    }

    /** 打印某个类上所有方法名包含关键字的签名（反射只认精确签名，所以参数类型要全名）。 */
    private static String signaturesOf(Class<?> clazz, String... keywords) {
        StringBuilder out = new StringBuilder();
        int shown = 0;
        for (Method method : clazz.getMethods()) {
            String name = method.getName();
            boolean hit = false;
            for (String keyword : keywords) {
                if (name.contains(keyword)) {
                    hit = true;
                    break;
                }
            }
            if (!hit) continue;
            out.append("    ").append(name).append("(");
            Class<?>[] types = method.getParameterTypes();
            for (int index = 0; index < types.length; index += 1) {
                out.append(index == 0 ? "" : ", ").append(types[index].getName());
            }
            out.append(")\n");
            shown += 1;
        }
        if (shown == 0) out.append("    （没有匹配的方法 —— 类名/方法名可能不对）\n");
        return out.toString();
    }

    private static String describe(Object value) {
        if (value == null) return "null";
        if (value instanceof java.util.List) {
            return "List(size=" + ((java.util.List<?>) value).size() + ")";
        }
        return value.getClass().getName() + " = " + value;
    }

    // ── 清理（硬要求，见类注释）────────────────────────────────────────────

    /**
     * 销毁 SDK。<b>必须在进程退出前调用</b>，否则眼镜可能残留脏 fd 导致整机重启。
     *
     * <p>顺序是硬性的：<b>先 stopAllServices，再 destroy</b>。
     * 幂等：Activity.onDestroy 与 Instance 级清理都可能调到。
     */
    public void destroy() {
        if (destroyed) return;
        destroyed = true;
        main.removeCallbacksAndMessages(null);
        stopCast();

        // ① 先停服务
        try {
            Class<?> manager = Class.forName(CLS_SERVICE_MANAGER);
            Method stopAll = manager.getMethod("stopAllServices");
            stopAll.invoke(null);
        } catch (Throwable error) {
            Log.w(TAG, "stopAllServices failed", error);
        }

        // ② 再 destroy
        try {
            Class<?> sdkClass = Class.forName(CLS_SDK);
            Object instance = sdkClass.getMethod("getInstance").invoke(null);
            sdkClass.getMethod("destroy").invoke(instance);
        } catch (Throwable error) {
            Log.w(TAG, "destroy failed", error);
        }

        device = null;
        display = null;
        casting = false;
    }

    // ── 小工具 ─────────────────────────────────────────────────────────────

    private void report(String status, boolean connected) {
        lastError = connected ? "" : status;
        if (listener != null) listener.onGlassesStatus(status, connected);
    }

    /** 反射的异常一层套一层，这里剥到最里层的原因，日志才不会全是 InvocationTargetException。 */
    private static String shortMessage(Throwable error) {
        Throwable cause = error;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        String message = cause.getMessage();
        String name = cause.getClass().getSimpleName();
        return message == null ? name : name + ": " + message;
    }

    /** 给自检/日志用：当前环境能不能用 SDK（类在不在） */
    public static String probeAvailability() {
        try {
            Class.forName(CLS_SDK);
            return "SDK 类可见（" + CLS_SDK + "）";
        } catch (Throwable error) {
            return "SDK 类不可见：" + shortMessage(error);
        }
    }

    @SuppressWarnings("unused")
    private static String deviceSummary(Object device) {
        return device == null ? "-" : device.getClass().getName() + " / API " + Build.VERSION.SDK_INT;
    }
}
