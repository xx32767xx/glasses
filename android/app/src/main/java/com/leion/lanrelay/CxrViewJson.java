package com.leion.lanrelay;

/**
 * CxrViewJson —— 把"要显示在 Rokid 眼镜镜片上的那一句译文"编成 CXR-L CustomView 的 JSON（5.127）。
 * ============================================================================
 * <b>背景（已确认的事实，来自官方 Sample 与 AAR 字节码）</b>：Rokid 的 CXR-L SDK 提供
 * **设备协同 + 显示**，**不提供 ASR、也不提供翻译**。所以分工是固定的：
 * <pre>
 *   手机麦克风/眼镜麦克风 → 我们的服务器 whisper 识别 → 我们的大脑翻译 → 这句译文 → 眼镜显示
 *                                    ↑ 这两个环节 Rokid 不参与
 * </pre>
 *
 * 这个类只做最后一步：**把文字编成眼镜认识的 JSON**。它刻意是**纯 Java**（不 import android），
 * 因为协议形状错了在真机上只会表现成"镜片上什么都没有"，没有报错 —— 那种错误只能靠
 * 直接跑测试钉住（见 tests/java/CxrViewJsonCheck.java）。
 *
 * 协议形状（逐字取自官方 Sample 的 `SelfViewJson` / `UpdateViewJson` / `TextViewProps`）：
 * <pre>
 *   打开一页：{"type":"LinearLayout","props":{"id":…},"children":[{"type":"TextView","props":{…}}]}
 *   增量更新：[{"action":"update","id":"subtitle_text","props":{"text":"…"}}]
 * </pre>
 * 四条硬约束（每一条都写错了就"镜片上没字"，而且不报错）：
 * <ol>
 *   <li><b>只认字符串</b>：尺寸要 `"40sp"`、颜色要 8 位 ARGB `"#FF00FF00"`、宽高要
 *       `"match_parent"` / `"wrap_content"` / `"240dp"`。给数字会被眼镜端拒绝。</li>
 *   <li><b>JSON 必须是紧凑单行</b>：官方 Sample 注释写明"多行缩进的 JSON 会让
 *       `customView_open` **静默失败**"（1.0.4 真机验证过的差异）。这里的拼接天然是单行。</li>
 *   <li><b>id 只能字母/数字/下划线</b>，且在 `props` 里（不是与 `type` 平级）。</li>
 *   <li><b>颜色只需要绿通道</b>：官方 Sample 的 `processColorToGrayToGreen` 把任何颜色转成
 *       灰度再塞进绿通道 —— 镜片是**绿光单色屏**。所以这里直接给绿通道量（`#FF00GG00`），
 *       避免"给了白色、镜片上却是暗的"。</li>
 * </ol>
 *
 * <p><b>为什么只有一行字</b>：这一版只做「投屏译文」。官方 Sample 里 `TextView` 会按
 * `layout_width=match_parent` 自动换行，行数由**文字长度**决定 —— 比在代码里估"几行"可靠。
 * 需要原文+译文两行时，照同样的形状再加一个 TextView 即可（id 换一个）。
 */
public final class CxrViewJson {

    /** 根容器 id（增量更新时按 id 找节点）。 */
    public static final String ROOT_ID = "leion_root";
    /** 那一行译文的节点 id。更新时**必须**用同一个 id，否则永远更新不到。 */
    public static final String TEXT_ID = "subtitle_text";
    /** 缺省字号（sp，字符串）。16sp 是官方缺省；镜片上偏小，这里从 32 起。 */
    public static final String DEFAULT_TEXT_SIZE = "32sp";
    /**
     * 缺省文字颜色：绿通道最亮（`#FF00FF00`）。
     *
     * <p>不写白色：官方 Sample 会把颜色转成灰度再塞进绿通道（镜片是绿光单色屏），
     * 直接给"绿通道量"少一层转义歧义 —— 见类注释第 ④ 条。
     */
    public static final String DEFAULT_TEXT_COLOR = "#FF00FF00";
    /** 背景：纯黑（不遮住透视的真实世界；镜片上也只剩绿字）。 */
    public static final String BACKGROUND_COLOR = "#FF000000";

    private CxrViewJson() {
    }

    /**
     * 打开镜片上那一页：黑色竖向容器 + 一行自动换行的 TextView。
     *
     * @param text     初始文字（可以是空串：空 = 镜片上只有黑底，等第一句译文）
     * @param textSize 字号，字符串形态（`"32sp"`）；给纯数字会自动补 `sp`
     * @return 一页 CustomView 的 JSON（紧凑单行）
     */
    public static String openView(String text, String textSize) {
        String size = normalizeSize(textSize);
        return '{'
                + quote("type") + ':' + quote("LinearLayout") + ','
                + quote("props") + ":{"
                + quote("id") + ':' + quote(ROOT_ID) + ','
                + quote("layout_width") + ':' + quote("match_parent") + ','
                + quote("layout_height") + ':' + quote("match_parent") + ','
                + quote("orientation") + ':' + quote("vertical") + ','
                + quote("backgroundColor") + ':' + quote(BACKGROUND_COLOR)
                + "},"
                + quote("children") + ":["
                + textNode(text, size)
                + "]}";
    }

    /**
     * 增量更新：只发改动的文字（`action=update`）。
     *
     * <p><b>空串也要发</b>：空串表示"这一句清掉"，是正常的收尾动作；
     * 反过来"跳过空串"会让镜片上一直留着上一句 —— 那比不显示更糟。
     */
    public static String updateText(String text) {
        return updateText(text, null);
    }

    /**
     * 增量更新：文字 + 字号（5.138：字号要能手动调，调完**下一句立刻**按新字号渲染）。
     *
     * <p>为什么不重建会话去改字号：会话一旦建立，镜片端那份视图就固定了；
     * 而 `props` 本来就可以只带变化的字段 —— 把 `textSize` 一起发过去最省也最快。
     *
     * @param textSize 形如 `"40sp"`；null/空 = 只更新文字（不动字号）
     */
    public static String updateText(String text, String textSize) {
        String size = textSize == null || textSize.trim().isEmpty() ? "" : normalizeSize(textSize);
        return "["
                + '{' + quote("action") + ':' + quote("update") + ','
                + quote("id") + ':' + quote(TEXT_ID) + ','
                + quote("props") + ":{"
                + quote("text") + ':' + quote(nullToEmpty(text))
                + (size.isEmpty() ? "" : ',' + quote("textSize") + ':' + quote(size))
                + "}}"
                + "]";
    }

    /** 一句现成的更新 JSON（给"清屏"用：文字为空）。 */
    public static String clearText() {
        return updateText("");
    }

    /** 那一行译文的节点（自动换行：宽度铺满、高度随内容）。 */
    private static String textNode(String text, String size) {
        return '{'
                + quote("type") + ':' + quote("TextView") + ','
                + quote("props") + ":{"
                + quote("id") + ':' + quote(TEXT_ID) + ','
                + quote("layout_width") + ':' + quote("match_parent") + ','
                + quote("layout_height") + ':' + quote("wrap_content") + ','
                + quote("text") + ':' + quote(nullToEmpty(text)) + ','
                + quote("textSize") + ':' + quote(size) + ','
                + quote("textColor") + ':' + quote(DEFAULT_TEXT_COLOR)
                + "}}";
    }

    /**
     * 把字号规整成协议要的形状：`"32sp"`。
     *
     * <p>纯数字补 `sp`；已经是 `NNsp` 的原样；其它（写错成 `"32px"` / `"big"`）退回缺省 ——
     * 这里的取舍是"宁可偏大/偏小，也不要整包 JSON 被拒"（被拒的表现同样是镜片上没字）。
     */
    static String normalizeSize(String textSize) {
        String raw = textSize == null ? "" : textSize.trim();
        if (raw.matches("[0-9]+")) return raw + "sp";
        if (raw.matches("[0-9]+sp")) return raw;
        return DEFAULT_TEXT_SIZE;
    }

    private static String nullToEmpty(String text) {
        return text == null ? "" : text;
    }

    /**
     * 把一段文字编成 JSON 字符串字面量。
     *
     * <p>为什么自己写而不是用 org.json：这个类要能在**没有 Android SDK 的机器上**
     * 编译执行（见 tests/java/CxrViewJsonCheck.java），而 desktop 的 org.json 是 stub。
     * 转义必须覆盖 `"`、`\`、换行、制表与控制字符 —— 译文里出现引号很常见，
     * 漏了就整包 JSON 坏掉，而眼镜那边的表现只是"不显示"。
     */
    public static String quote(String raw) {
        StringBuilder out = new StringBuilder(raw == null ? 2 : raw.length() + 2);
        out.append('"');
        for (int index = 0; index < (raw == null ? 0 : raw.length()); index += 1) {
            char one = raw.charAt(index);
            switch (one) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (one < 0x20) {
                        out.append(String.format(java.util.Locale.US, "\\u%04x", (int) one));
                    } else {
                        out.append(one);
                    }
            }
        }
        out.append('"');
        return out.toString();
    }
}
