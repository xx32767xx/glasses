package com.leion.lanrelay;

import android.util.Log;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * AudioCaptureArbiter —— **麦克风的"插座管理员"**（5.28）。
 * ============================================================================
 * 为什么需要它：手机上的录音会话是**整机一份**的资源，不是"每个页面各自一份"。
 * 现在房间页、眼镜（SDK 的 UAC）、以及将来的"翻译官"都想录音；谁先开谁占着，
 * 第二个 `startRecording()` 在多数机型上失败或"成功但一直静音"，
 * 而**静音是最难查的那种失败**：界面上按钮是亮的，数据库里一条字幕都没有。
 *
 * 所以定一条结构性的规矩：**同一时刻只有一个持有者，且只能在这里申请**。
 * 页面不许自己记得"用完要停" —— 那件事今天散落在 6 个地方，漏一处就是漏洞。
 *
 * 三条设计决定：
 *
 * ① **`release()` 不阻塞 UI 线程。** 录音线程可能正卡在一次上传里（我们刻意
 *    给它最多 2 秒把尾音发完，见 `MicUploader.stop()`），在这里 wait 会把界面卡住。
 *    所以 release 只是"交还租约 + 叫它停"，随后 `request()` 若发现上一个还没停下，
 *    就**明确拒绝**（"房间正在停止录音，请稍后再试"），而不是抢着开第二个。
 *
 * ② **失败要说人话。** `request()` 返回**空串 = 成功**，非空 = 给用户看的原因。
 *    静默失败是这个项目里反复踩过的坑（静默降级比崩溃难查得多）。
 *
 * ③ **能自述状态。** `describe()` 给界面/日志用：现在谁拿着麦克风、在不在录。
 *    出问题时不用猜，看一眼就知道。
 *
 * <p>它**不创建**任何录音对象：`MicUploader`（手机麦）和 `GlassesMic`（眼镜 SDK）
 * 各自管自己的实现，这里只管"谁有权开"。
 */
public final class AudioCaptureArbiter {

    private static final String TAG = "LeionAudio";

    /** 谁在申请。字符串常量集中在这里，免得各处写字面量写错对不上。 */
    public static final String OWNER_ROOM = "room";
    public static final String OWNER_INTERPRETER = "interpreter";
    public static final String OWNER_LEGACY = "legacy";

    /** 当前持有者（null = 空闲）。 */
    private static String holder = null;
    /** 当前持有者的采集器（用来判断"真的停了没有"）。 */
    private static AudioSource holderSource = null;
    /**
     * 上一次交还、但**还没收尾完**的采集器。
     *
     * <p>为什么单独记：`stop()` 是"叫它停"（`MicUploader` 会给录音线程最多 2 秒发尾音）。
     * 这段时间里底层 `AudioRecord` 还占着，要是有新申请立刻放行，下一个采集器就会撞墙。
     * 所以收尾期间**明确拒绝**，让用户看到"稍后再试"，而不是一个莫名其妙的启动失败。
     */
    private static AudioSource windingDown = null;
    /** 谁在等（只有诊断价值，不排队：同一时刻只允许一个等待者也无意义）。 */
    private static final Map<String, Long> waiters = new LinkedHashMap<>();

    private AudioCaptureArbiter() {
    }

    /**
     * 申请麦克风。
     *
     * @param owner {@link #OWNER_ROOM} 之类
     * @return **空串表示拿到**；非空是给用户看的原因（调用方直接显示，别再套前缀）
     */
    public static synchronized String request(String owner) {
        String who = owner == null ? "" : owner.trim();
        if (who.isEmpty()) return "内部错误：没有说明谁要录音";
        if (who.equals(holder)) {
            // 幂等：同一个页面重复申请，直接放行（它本来就持有）
            return "";
        }
        if (holder != null) {
            // 上一任还在录（或还没停干净）→ 明确拒绝，别抢
            boolean stillRecording = holderSource != null && holderSource.isRunning();
            waiters.put(who, System.currentTimeMillis());
            Log.w(TAG, "🎤 拒绝 " + who + "：" + holder + " 还占着麦克风"
                    + (stillRecording ? "（正在录音）" : "（正在停止）"));
            return describeDenied(holder, stillRecording);
        }
        // 没有人持有，但上一段的设备可能还没退干净
        if (windingDown != null) {
            if (windingDown.isWindingDown()) {
                Log.w(TAG, "🎤 拒绝 " + who + "：上一段录音还在收尾");
                return "上一段录音还在收尾，请稍后再试";
            }
            windingDown = null;
        }
        holder = who;
        holderSource = null;
        waiters.remove(who);
        Log.i(TAG, "🎤 麦克风租给 " + who);
        return "";
    }

    /** 把采集器登记給当前持有者：之后 {@link #release(String)} 才能真的把它停下。 */
    public static synchronized void attach(String owner, AudioSource source) {
        if (holder == null || source == null) return;
        if (holder.equals(owner == null ? "" : owner.trim())) {
            holderSource = source;
        }
    }

    /**
     * 交还麦克风（**幂等**：没拿到也调用一百遍都没事）。
     *
     * <p>只允许持有者交还：别人调用不会把房间正在用的麦克风停掉。
     *
     * @return true = 确实由这次调用释放了
     */
    public static synchronized boolean release(String owner) {
        String who = owner == null ? "" : owner.trim();
        if (holder == null || !holder.equals(who)) return false;
        AudioSource source = holderSource;
        holder = null;
        holderSource = null;
        if (source != null) {
            try {
                // stop() 是"叫它停"，不是"等它停"（见类注释①）
                source.stop();
                // 记下它，收尾期间拒绝新申请（见 windingDown 的注释）
                windingDown = source.isWindingDown() ? source : null;
            } catch (Exception error) {
                Log.w(TAG, "🎤 停采集时抛异常（已忽略）：" + error.getMessage());
                windingDown = null;
            }
        }
        Log.i(TAG, "🎤 " + who + " 已交还麦克风");
        return true;
    }

    /** 现在是谁拿着麦克风（null = 空闲）。界面与日志都用它，别各自猜。 */
    public static synchronized String holder() {
        return holder;
    }

    /** 采集是否真的在跑（持有者登记了采集器且它自报在录）。 */
    public static synchronized boolean isRecording() {
        return holder != null && holderSource != null && holderSource.isRunning();
    }

    /** 一句话状态：`空闲` / `room·录音中` / `room·启动中` —— 日志与状态行用。 */
    public static synchronized String describe() {
        if (holder == null) return "空闲";
        if (holderSource == null) return holder + "·启动中";
        return holder + (holderSource.isRunning() ? "·录音中" : "·停止中");
    }

    /** 测试用：把状态清回空闲（真机上不会调用）。 */
    static synchronized void resetForTest() {
        holder = null;
        holderSource = null;
        windingDown = null;
        waiters.clear();
    }

    /**
     * 拒绝原因按**持有者**说，不用内部代号 —— 用户看到的是"房间"，不是 "room"。
     * 这样这条消息可以直接显示在状态行上，不需要界面再翻译一遍。
     */
    private static String describeDenied(String owner, boolean stillRecording) {
        String label = OWNER_ROOM.equals(owner) ? "会议房间"
                : OWNER_INTERPRETER.equals(owner) ? "同传翻译官"
                    : OWNER_LEGACY.equals(owner) ? "旧版界面"
                        : owner;
        return label + (stillRecording ? "正在录音" : "正在停止录音") + "，请稍后再试";
    }
}
