package com.leion.lanrelay;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * DevMode —— 「开发者模式」开关（5.142）。
 * ============================================================================
 *
 * <p><b>为什么要有它</b>：App 里散布着一批**只为验证而存在**的控件 ——
 * 投屏页的「推送一句测试文字」、三语 × 短/中/长的测试句、旧界面的「眼镜显示预览」
 * 与「诊断」段。它们对日常使用者只是噪音（看到会以为是自己点错了地方），
 * 对排障的人又是必需品。所以用一个开关把它们整体藏起来，默认**关**。
 *
 * <p><b>为什么是"藏"不是"删"</b>：这些控件是排障手段。删掉之后，"镜片不出字"这种
 * 问题就只能靠开会复现，成本高得多。
 *
 * <p><b>为什么存在 SharedPreferences 而不是服务端</b>：它是**这台设备的调试开关**，
 * 不是会议室的状态。服务端不需要知道谁的手机开了开发者模式。
 *
 * <p>开关入口在「我的 → 翻译服务及有效状态 → 设置」页（{@link SettingsActivity}）。
 */
public final class DevMode {

    /** 与 SettingsActivity / MainActivity 同一个偏好文件。 */
    private static final String PREFS = "leion";
    /** 键名：`devMode`（boolean，缺省 false = 关）。 */
    public static final String KEY = "devMode";

    private DevMode() { }

    /** 这台设备当前开没开开发者模式。读不到偏好 = 关。 */
    public static boolean enabled(Context context) {
        if (context == null) return false;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return prefs.getBoolean(KEY, false);
    }

    /** 写开关。返回写进去的值（写失败也返回目标值，调用方不必再读一次）。 */
    public static boolean set(Context context, boolean enabled) {
        if (context == null) return enabled;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY, enabled).apply();
        return enabled;
    }

    /** 取反并返回新值（点一下整行用的就是它）。 */
    public static boolean toggle(Context context) {
        return set(context, !enabled(context));
    }
}
