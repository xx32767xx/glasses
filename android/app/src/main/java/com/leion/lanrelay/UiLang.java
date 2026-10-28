package com.leion.lanrelay;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;

import java.util.Locale;

/**
 * 界面语言（4.56）：中文 / 巴西葡语 / 英文三套资源。
 *
 * <p>⚠️ 这里的“语言”和 {@code speakLang} 是**两件事**，不要混：
 * <ul>
 *   <li>{@code speakLang}（zh-CN / pt-BR）= 我说话用哪种语言，决定识别与翻译方向；</li>
 *   <li>{@code uiLang}（本类）= 按钮和标题用哪种语言写，纯显示。</li>
 * </ul>
 * 用户明确要求的是后者，所以界面上两者分开摆（登录页右上角 vs 表单里的「我说…」）。
 *
 * <p>三套文案分布在 {@code res/values{,-en,-pt-rBR}/strings.xml}，键名完全一致 ——
 * {@code tests/android-order-suite.mjs} 里有断言把三份键集合逐个比对，漏译会红。
 *
 * <p>“没选过”不等于“中文”：存的是空串时直接把 base 原样返回，让 Android 自己按系统
 * 语言挑（英文手机开机就是英文）。只有用户显式选过才强制覆盖。
 */
public final class UiLang {

    /** 与各 Activity 共用的 prefs 文件名。 */
    private static final String PREFS = "leion";
    /** 存的是 BCP-47 标签；空串 = 跟随系统。 */
    public static final String KEY = "uiLang";

    /** 跟随系统（不覆盖 Configuration）。 */
    public static final String AUTO = "";
    public static final String ZH = "zh";
    public static final String PT = "pt-BR";
    public static final String EN = "en";

    private UiLang() {
    }

    /** 三个可选项，顺序即界面上的顺序。 */
    public static final String[] TAGS = {ZH, PT, EN};

    /** 选项在**它自己那种语言**里怎么写（语言选择器不该用你还没选的语言写）。 */
    public static String nativeLabel(String tag) {
        if (PT.equals(tag)) return "Português";
        if (EN.equals(tag)) return "English";
        return "中文";
    }

    /** 用户选过的值；空串表示跟随系统。 */
    public static String saved(Context ctx) {
        if (ctx == null) return AUTO;
        String tag = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, AUTO);
        return tag == null ? AUTO : tag;
    }

    /** 持久化（不负责重建界面，调用方自己 {@code recreate()}）。 */
    public static void save(Context ctx, String tag) {
        String value = tag == null ? AUTO : tag;
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, value).apply();
    }

    /**
     * 当前**实际生效**的标签：选过就是选的，没选过就按系统语言落一个。
     *
     * <p>用途只有一个 —— 高亮选择器。真正的资源切换是 {@code wrap()} 干的。
     */
    public static String effective(Context ctx) {
        String tag = saved(ctx);
        if (!tag.isEmpty()) return tag;
        Locale sys = systemLocale(ctx);
        String lang = sys == null ? "zh" : sys.getLanguage();
        if ("pt".equals(lang)) return PT;
        if ("en".equals(lang)) return EN;
        return ZH;
    }

    /**
     * 记住每个界面「画出来时」用的是哪种语言；回到前台发现变了就 {@code recreate()}。
     *
     * <p>为什么需要：语言是在设置页改的，但房间列表、房间页已经在返回栈上了 ——
     * 它们不会因为别人改了偏好就自动重画。Android 官方的 per-app language 也是这么做的。
     */
    private static final java.util.WeakHashMap<android.app.Activity, String> SHOWN =
            new java.util.WeakHashMap<>();

    public static void trackShown(android.app.Activity activity) {
        if (activity == null) return;
        String now = effective(activity);
        String was = SHOWN.put(activity, now);
        if (was != null && !was.equals(now)) activity.recreate();
    }

    private static Locale systemLocale(Context ctx) {
        try {
            Configuration cfg = ctx.getResources().getConfiguration();
            if (cfg.getLocales() != null && !cfg.getLocales().isEmpty()) return cfg.getLocales().get(0);
        } catch (Throwable ignored) {
            // 极老的 ROM 上 getLocales 可能不给东西，退回默认值
        }
        return Locale.getDefault();
    }

    /**
     * 让这个 Context 用选中的界面语言取文案。
     *
     * <p>每个界面都要在 {@code attachBaseContext} 里走一趟，否则只有先创建的那个界面生效 ——
     * 这是 Android 上最常见的“语言只改了一半”的原因。
     */
    public static Context wrap(Context base) {
        if (base == null) return null;
        String tag = saved(base);
        if (tag.isEmpty()) return base;                  // 跟随系统：交给 Android 自己挑
        Locale locale = Locale.forLanguageTag(tag);
        if (locale.getLanguage().isEmpty()) return base;
        Locale.setDefault(locale);                       // 让 DateFormat 之类也跟上
        Configuration cfg = new Configuration(base.getResources().getConfiguration());
        cfg.setLocale(locale);
        return base.createConfigurationContext(cfg);
    }
}
