package com.leion.lanrelay;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * HearLangs —— 「我想看哪些语言的译文」这套取值的规则（5.55）。
 * ============================================================================
 * 为什么要有这个类：`speakLang`（我说什么语言）与 `hearLangs`（我想看哪些译文）
 * 是**两个不同的东西**。一个人说一种、想读多种是真实需求：我说葡语，但英文和中文的
 * 译文都想看。
 *
 * <p><b>本类唯一的硬规则</b>：`hearLangs` **永远包含 `speakLang`**。
 * 它的含义不是"我想看自己的原文"，而是**"别人说的话要按我读得懂的语言给我"** ——
 * 我的语言就是我的阅读语言。少了它，别人说的话就没有任何人为我翻译了。
 *
 * <p>写成纯 Java（不 import android）是为了能被直接编译执行地测试：
 * 这条规则写错的表现很安静（界面照常、字幕就是不来），只能靠测试钉住。
 */
public final class HearLangs {

    /** 支持的语种，顺序即界面与日志里的顺序（与服务器端 normalizeHearLangs 一致）。 */
    public static final String[] ALL = { InterpreterLang.ZH, InterpreterLang.PT, InterpreterLang.EN };

    private HearLangs() {
    }

    /**
     * 归一化一组语言：只留支持的、去重、按固定顺序，**并强制并入说话语言**。
     *
     * @param raw       选中的语言（可含非法值、重复值）
     * @param speakLang 我说什么语言（会被并入；空则不并）
     * @return 归一化后的列表（说话语言非空时**永远非空**）
     */
    public static List<String> normalize(Collection<String> raw, String speakLang) {
        Set<String> seen = new LinkedHashSet<>();
        if (raw != null) {
            for (String one : raw) {
                String tag = normalizeTag(one);
                if (tag != null) seen.add(tag);
            }
        }
        String speak = normalizeTag(speakLang);
        if (speak != null) seen.add(speak);
        List<String> out = new ArrayList<>();
        for (String one : ALL) {
            if (seen.contains(one)) out.add(one);
        }
        return out;
    }

    /** 逗号分隔的偏好值 → 列表（老配置可能是空串）。 */
    public static List<String> parse(String csv) {
        List<String> out = new ArrayList<>();
        if (csv == null) return out;
        for (String one : csv.split("[,;\\s]+")) {
            String tag = normalizeTag(one);
            if (tag != null && !out.contains(tag)) out.add(tag);
        }
        return out;
    }

    /** 列表 → 逗号分隔（给 prefs 与网络请求用）；顺序固定，便于比对。 */
    public static String join(Collection<String> langs, String speakLang) {
        return String.join(",", normalize(langs, speakLang));
    }

    /** 认得的语种标签；认不出返回 null（不硬猜）。大小写、下划线都容忍。 */
    public static String normalizeTag(String raw) {
        String value = raw == null ? "" : raw.trim().toLowerCase(java.util.Locale.ROOT).replace('_', '-');
        if (value.isEmpty()) return null;
        for (String one : ALL) {
            if (one.toLowerCase(java.util.Locale.ROOT).equals(value)) return one;
        }
        return null;
    }
}
