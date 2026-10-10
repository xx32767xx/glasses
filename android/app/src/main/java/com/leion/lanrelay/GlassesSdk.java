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
                                // code=10 是 FIRMWARE_NO_DEVICE：插拔眼镜时的瞬时提示，
                                // 样例里明确忽略（不影响连接）。这里也忽略，免得刷屏。
                                if (code != 10) {
                                    main.post(() -> report("眼镜 SDK 报错 " + code + "：" + message, false));
                                }
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
            int width = readInt(info, "resolutionWidth");
            int height = readInt(info, "resolutionHeight");
            if (width > 0 && height > 0) {
                Log.i(TAG, "眼镜分辨率 " + width + "×" + height);
                return new int[] { width, height };
            }
        } catch (Throwable error) {
            Log.i(TAG, "queryDisplaySize skipped: " + shortMessage(error));
        }
        return new int[] { 0, 0 };
    }

    /** 先试 getter，再试同名字段（Kotlin data class 两种写法都可能）。 */
    private static int readInt(Object target, String name) {
        String getter = "get" + Character.toUpperCase(name.charAt(0)) + name.substring(1);
        try {
            Object value = target.getClass().getMethod(getter).invoke(target);
            if (value instanceof Integer) return (Integer) value;
        } catch (Throwable ignored) {
            // 落到字段那条路
        }
        try {
            java.lang.reflect.Field field = target.getClass().getField(name);
            Object value = field.get(target);
            if (value instanceof Integer) return (Integer) value;
        } catch (Throwable ignored) {
            // 读不到就算了
        }
        return 0;
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
        report("眼镜已断开", false);
    }

    private void startServices() {
        if (device == null || destroyed) return;
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
        }
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
                Class<?> deviceClass = Class.forName(CLS_DEVICE);
                Method method = lcdClient.getClass().getMethod("getGlassDisplay", deviceClass);
                display = method.invoke(lcdClient, device);
            } catch (Throwable error) {
                reportWithStep("② getGlassDisplay 失败", error);
                return;
            }
            if (display == null) {
                report("② getGlassDisplay 返回 null（设备可能还没就绪，退后几秒重试）", true);
                return;
            }

            // ③ createCaptureScreen(activity, view)
            step = "③ createCaptureScreen";
            try {
                Method create = display.getClass()
                        .getMethod("createCaptureScreen", Activity.class, View.class);
                create.invoke(display, activity, view);
            } catch (NoSuchMethodException error) {
                // 单独给这条：说明方法签名与样例不一致，得看 API 探测结果
                report("③ 没有 createCaptureScreen(Activity, View) 这个方法 —— 看 API 探测", true);
                Log.w(TAG, "createCaptureScreen(Activity,View) not found", error);
                return;
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

    /** 报告时带上"卡在第几步"+ 最内层异常类型与消息。 */
    private void reportWithStep(String where, Throwable error) {
        String detail = shortMessage(error);
        lastError = where + "：" + detail;
        Log.w(TAG, where, error);
        if (listener != null) listener.onGlassesStatus(where + "：" + detail, device != null);
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
     * <p>用反射取静态常量而不是直接引用：常量名（LEFT_EYE_PORT / RIGHT_EYE_PORT /
     * DOUBLE_EYE_PORT）来自样例代码，但**我没验证过它们的实际值**。
     * 取不到就跳过 —— 大多数情况下默认就是双眼。
     */
    private void tryOpenBothEyes() {
        try {
            Object lcdClient = getLcdClient();
            if (lcdClient == null) return;
            Class<?> deviceClass = Class.forName(CLS_DEVICE);
            Method getDisplay = lcdClient.getClass().getMethod("getGlassDisplay", deviceClass);
            Object target = getDisplay.invoke(lcdClient, device);

            Class<?> displayClass = Class.forName("com.llvision.glass3.core.lcd.client.IGlassDisplay");
            int port = displayClass.getField("DOUBLE_EYE_PORT").getInt(null);
            Method setPort = displayClass.getMethod("setPort", int.class, boolean.class);
            setPort.invoke(target, port, true);
        } catch (Throwable error) {
            // 不是致命问题：默认通常就是双眼
            Log.i(TAG, "setPort(DOUBLE_EYE_PORT) skipped: " + shortMessage(error));
        }
    }

    private Object getLcdClient() throws Exception {
        Class<?> sdkClass = Class.forName(CLS_SDK);
        Object instance = sdkClass.getMethod("getInstance").invoke(null);
        // getGlass3Client(IGlass3Device.Glass3DeviceClient)
        Class<?> deviceClass = Class.forName(CLS_DEVICE);
        Class<?> clientEnum = Class.forName(CLS_DEVICE + "$Glass3DeviceClient");
        Object lcdEnum = null;
        for (Object constant : clientEnum.getEnumConstants()) {
            if ("LCD".equals(String.valueOf(constant))) { lcdEnum = constant; break; }
        }
        if (lcdEnum == null) return null;
        Method getClient = sdkClass.getMethod("getGlass3Client", clientEnum);
        return getClient.invoke(instance, lcdEnum);
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
        try {
            Class<?> clientEnum = Class.forName(CLS_DEVICE + "$Glass3DeviceClient");
            StringBuilder names = new StringBuilder();
            for (Object constant : clientEnum.getEnumConstants()) {
                names.append(constant).append(" ");
            }
            out.append("③ ✓ Glass3DeviceClient 常量：").append(names).append("\n");
        } catch (Throwable error) {
            out.append("③ ✗ 读 Glass3DeviceClient 枚举：").append(shortMessage(error)).append("\n");
        }

        // ④ LCD 客户端：真取一次，打印真实类名 + getGlassDisplay 的所有重载签名
        Object lcd = null;
        try {
            lcd = getLcdClient();
        } catch (Throwable error) {
            out.append("④ ✗ getGlass3Client(LCD)：").append(shortMessage(error)).append("\n");
        }
        if (lcd == null) {
            out.append("④ ✗ getGlass3Client(LCD) 返回 null（枚举常量名不对，或设备没就绪）\n");
        } else {
            out.append("④ ✓ LCD 客户端 ").append(lcd.getClass().getName()).append("\n");
            out.append("   getGlassDisplay 重载：\n")
               .append(signaturesOf(lcd.getClass(), "getGlassDisplay"));
        }

        // ⑤ display 对象
        Object target = null;
        if (lcd != null && device != null) {
            try {
                Class<?> deviceClass = Class.forName(CLS_DEVICE);
                Method getDisplay = lcd.getClass().getMethod("getGlassDisplay", deviceClass);
                target = getDisplay.invoke(lcd, device);
                out.append("⑤ ✓ getGlassDisplay(IGlass3Device) → ")
                   .append(target == null ? "null" : target.getClass().getName()).append("\n");
            } catch (Throwable error) {
                out.append("⑤ ✗ getGlassDisplay(IGlass3Device)：").append(shortMessage(error)).append("\n");
            }
        } else {
            out.append("⑤ ⏭ 跳过（device=").append(device == null ? "null" : "有")
               .append("）—— device 为 null 时投屏必然失败\n");
        }

        // ⑥ 投屏方法签名 —— 只查找不调用
        if (target != null) {
            out.append("   createCaptureScreen 重载：\n")
               .append(signaturesOf(target.getClass(), "createCaptureScreen"));
            boolean hasBoth = false;
            try {
                target.getClass().getMethod("createCaptureScreen", Activity.class, View.class);
                hasBoth = true;
            } catch (Throwable ignored) {
                // 没有就是没有，下面统一报
            }
            out.append("⑥ ").append(hasBoth ? "✓" : "✗")
               .append(" createCaptureScreen(Activity, View)")
               .append(hasBoth ? " 存在" : " 不存在 —— 用上面的重载对照，改 cast() 里的签名")
               .append("\n");
            out.append("   其他显示方法：\n")
               .append(signaturesOf(target.getClass(), "Capture", "Port", "Luminance", "BackLight"));
        }

        // ⑦ 双眼常量（取不到不影响投屏，默认通常就是双眼）
        try {
            Class<?> displayClass = Class.forName("com.llvision.glass3.core.lcd.client.IGlassDisplay");
            out.append("⑦ ✓ DOUBLE_EYE_PORT = ").append(displayClass.getField("DOUBLE_EYE_PORT").getInt(null))
               .append("\n");
        } catch (Throwable error) {
            out.append("⑦ ✗ 读 DOUBLE_EYE_PORT：").append(shortMessage(error)).append("\n");
        }

        out.append("device：").append(device == null ? "null" : device.getClass().getName()).append("\n");
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
