package com.leion.lanrelay;

/**
 * InterpreterLang —— 翻译官的「两种语言」以及它们之间的约束（5.37）。
 * ============================================================================
 * 翻译官是**单向**的：对方说一门语言、我读另一门语言。所以界面上不是两个自由选择的
 * 下拉框，而是"我读的语言" + "对方说的语言"，两者**不许相同**（相同就没有可翻译的东西，
 * 服务端也会把这一句当成不需要译文，用户看到的是"说话了但一个字幕都没有"）。
 *
 * <p>为什么单独一个类、不塞进 Activity：
 * <ul>
 *   <li>这组规则（默认值、可选集合、归一化）要能被**直接编译执行**的测试钉住 ——
 *       见 {@code tests/java/InterpreterLangCheck.java}。这类规则靠人眼审查守不住：</li>
 *   <li>"读中文时对方可能是葡语**或**英语"这件事只有三语场景才暴露，写错的表现是
 *       "对方说英语，界面却按葡语解码"——一段乱码，比不识别更难查。</li>
 * </ul>
 *
 * <p>与服务端的对应关系：`lib/rooms.mjs` 的 `interpreterPartnerLang()` 是同一张表的
 * 另一种写法（那边是"没上报语种时的兜底"）。两边必须一致 —— 否则同一段音频在
 * 手机上说一种语言、在服务器上按另一种解码。
 */
public final class InterpreterLang {

    /** 中文（简体）。 */
    public static final String ZH = "zh-CN";
    /** 巴西葡语。 */
    public static final String PT = "pt-BR";
    /** 英语（美式）。 */
    public static final String EN = "en-US";

    /**
     * 对方语言的"自动"取值：交给 {@link #defaultPartner(String)} 推。
     * 为什么需要它：界面上要有一个"不用想"的默认项，但用户又必须能改
     * （读中文时对方可能是葡语也可能是英语，这件事推不出唯一答案）。
     */
    public static final String AUTO = "auto";

    private InterpreterLang() {
    }

    /** 是不是我们支持的语言（只认这三个精确值）。 */
    public static boolean supported(String lang) {
        return ZH.equals(lang) || PT.equals(lang) || EN.equals(lang);
    }

    /** 英文名/短码归一化：`zh` / `pt` / `en` / `zh_CN` 都收，认不出返回空串（不硬猜）。 */
    public static String normalize(String raw) {
        String value = raw == null ? "" : raw.trim().toLowerCase(java.util.Locale.ROOT).replace('_', '-');
        if (value.isEmpty()) return "";
        int dash = value.indexOf('-');
        String primary = dash <= 0 ? value : value.substring(0, dash);
        if ("zh".equals(primary)) return ZH;
        if ("pt".equals(primary)) return PT;
        if ("en".equals(primary)) return EN;
        return "";
    }

    /**
     * 「对方说的语言」的默认值：读中文默认对方是葡语（巴西场景最常见），
     * 读葡语/英语默认对方是中文。与 `lib/rooms.mjs` 的 `interpreterPartnerLang()` 一致。
     *
     * @return 认不出的读语言 → 空串（调用方据此提示"请先选语言"）
     */
    public static String defaultPartner(String readLang) {
        String read = normalize(readLang);
        if (ZH.equals(read)) return PT;
        if (PT.equals(read) || EN.equals(read)) return ZH;
        return "";
    }

    /**
     * 「对方说的语言」的**可选集合**：读中文时是葡/英两种；读葡语或英语时只有中文一种。
     *
     * <p>刻意**永不包含**读语言自己：那会让"原文与译文同语言"，服务端认定不需要译文 →
     * 用户说完了却一条字幕都看不到。这个不变量也有测试钉着。
     */
    public static String[] partnerOptions(String readLang) {
        String read = normalize(readLang);
        if (ZH.equals(read)) return new String[] { PT, EN };
        if (PT.equals(read) || EN.equals(read)) return new String[] { ZH };
        return new String[0];
    }

    /**
     * 把存储值钉成"合法组合"：读语言不认识就回中文；对方语言不认识/等于读语言/AUTO
     * 就回默认值。**每次启动都过一遍**，免得旧配置或手改的偏好把一场翻译带进死胡同。
     */
    public static String resolveRead(String storedRead) {
        String read = normalize(storedRead);
        return supported(read) ? read : ZH;
    }

    /** 见 {@link #resolveRead(String)}。 */
    public static String resolvePartner(String storedPartner, String readLang) {
        String read = resolveRead(readLang);
        String partner = normalize(storedPartner);
        if (partner.isEmpty() || partner.equals(read)) return defaultPartner(read);
        // 读中文时对方允许葡/英；其余情况只有中文合法
        for (String one : partnerOptions(read)) {
            if (one.equals(partner)) return partner;
        }
        return defaultPartner(read);
    }
}
