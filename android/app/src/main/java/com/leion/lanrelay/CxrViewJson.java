package com.leion.lanrelay;

import java.util.ArrayList;
import java.util.List;

/**
 * CxrViewJson —— 把"要显示在 Rokid 眼镜镜片上的几行字"编成 CXR CustomView 的 JSON（5.51）。
 * ============================================================================
 * <b>背景（已确认的事实）</b>：Rokid 的 CXR SDK 只提供**设备协同 + 显示**，
 * **不提供 ASR，也不提供翻译**。所以分工是固定的：
 * <pre>
 *   眼镜麦克风（将来）→ 我们的服务器 whisper 识别 → 我们的大脑翻译 → 这几行字 → 眼镜显示
 *                                    ↑ 这两个环节 Rokid 不参与
 * </pre>
 *
 * 这个类只做最后一步：**把文字编成眼镜认识的 JSON**。它刻意是**纯 Java**（不 import android），
 * 因为协议形状错了在真机上只会表现成"镜片上什么都没有"，没有报错 —— 那种错误只能靠
 * 直接跑测试钉住（见 tests/java/CxrViewJsonCheck.java）。
 *
 * 协议形状（来自 Rokid CXR-L SDK 的 CustomView 示例）：
 * <pre>
 *   打开一页：{"type":"LinearLayout","props":{"id":…},"children":[{"type":"TextView","props":{…}}]}
 *   增量更新：[{"action":"update","id":"sub0","props":{"text":"…"}}]
 * </pre>
 * 两句都**只认字符串**，所以所有数字/颜色都要写成字符串（`"16sp"`、`"#FFFFFFFF"`）。
 */
public final class CxrViewJson {

    /** 镜片上最多显示几行（我们的手机端是 3 行预算，这里保持一致）。 */
    public static final int MAX_LINES = 3;
    /** 根容器 id（增量更新时按 id 找节点）。 */
    public static final String ROOT_ID = "leion_subtitle";
    /** 第 n 行的节点 id 前缀：sub0 / sub1 / sub2。 */
    public static final String LINE_ID_PREFIX = "sub";

    private CxrViewJson() {
    }

    /** 某一行的样式：原文用小字灰、译文用大字白（眼镜是单色屏也看得清的对比）。 */
    public static final class Line {
        public final String text;
        public final String textSize;
        public final String textColor;

        public Line(String text, String textSize, String textColor) {
            this.text = text == null ? "" : text;
            this.textSize = textSize == null ? "16sp" : textSize;
            this.textColor = textColor == null ? "#FFFFFFFF" : textColor;
        }
    }

    /**
     * 打开镜片上那一页：一个竖向 LinearLayout，里面每一行一个 TextView。
     *
     * <p>为什么固定三行而不是按内容动态增删节点：镜片上的视图树**反复增删节点**容易闪，
     * 而"固定三个槽位 + 只改文字"是最稳的形态（与手机端"同一句原位更新"同一个思路）。
     *
     * @param lines 要显示的行（最多 {@link #MAX_LINES} 行；空的会被略过）
     * @return 一页 CustomView 的 JSON
     */
    public static String openView(List<Line> lines) {
        StringBuilder json = new StringBuilder();
        json.append('{').append(quote("type")).append(':').append(quote("LinearLayout"))
            .append(',').append(quote("props")).append(":{")
            .append(quote("id")).append(':').append(quote(ROOT_ID)).append(',')
            .append(quote("layout_width")).append(':').append(quote("match_parent")).append(',')
            .append(quote("layout_height")).append(':').append(quote("match_parent")).append(',')
            .append(quote("orientation")).append(':').append(quote("vertical")).append(',')
            .append(quote("backgroundColor")).append(':').append(quote("#FF000000"))
            .append("},").append(quote("children")).append(":[");
        List<Line> shown = normalize(lines);
        for (int index = 0; index < shown.size(); index += 1) {
            if (index > 0) json.append(',');
            json.append(textNode(index, shown.get(index)));
        }
        json.append("]}");
        return json.toString();
    }

    /**
     * 增量更新：只发改动的文字（`action=update`）。
     *
     * @return `[{"action":"update","id":"sub0","props":{"text":"…"}}, …]`
     */
    public static String updateView(List<Line> lines) {
        StringBuilder json = new StringBuilder("[");
        List<Line> shown = normalize(lines);
        for (int index = 0; index < shown.size(); index += 1) {
            if (index > 0) json.append(',');
            json.append('{').append(quote("action")).append(':').append(quote("update")).append(',')
                .append(quote("id")).append(':').append(quote(LINE_ID_PREFIX + index)).append(',')
                .append(quote("props")).append(":{")
                .append(quote("text")).append(':').append(quote(shown.get(index).text))
                .append("}}");
        }
        json.append(']');
        return json.toString();
    }

    /** 第 n 行的节点 id（增量更新与打开视图必须用同一套 id，否则更新会落空）。 */
    public static String lineId(int index) {
        return LINE_ID_PREFIX + index;
    }

    private static String textNode(int index, Line line) {
        return '{' + quote("type") + ':' + quote("TextView") + ','
            + quote("props") + ":{"
            + quote("id") + ':' + quote(lineId(index)) + ','
            + quote("layout_width") + ':' + quote("match_parent") + ','
            + quote("layout_height") + ':' + quote("wrap_content") + ','
            + quote("text") + ':' + quote(line.text) + ','
            + quote("textSize") + ':' + quote(line.textSize) + ','
            + quote("textColor") + ':' + quote(line.textColor)
            + "}}";
    }

    /** 去掉空行、裁到 {@link #MAX_LINES}（**最新的在最后**，所以裁掉的是最旧的）。 */
    private static List<Line> normalize(List<Line> lines) {
        List<Line> kept = new ArrayList<>();
        if (lines != null) {
            for (Line line : lines) {
                if (line == null) continue;
                if (line.text.trim().isEmpty()) continue;
                kept.add(line);
            }
        }
        while (kept.size() > MAX_LINES) kept.remove(0);
        return kept;
    }

    /**
     * 把一段文字编成 JSON 字符串字面量。
     *
     * <p>为什么自己写而不是用 org.json：这个类要能在**没有 Android SDK 的机器上**
     * 编译执行（见 tests/java/CxrViewJsonCheck.java），而 desktop 的 org.json 是 stub。
     * 转义必须覆盖 `"`、`\`、换行、制表 —— 译文里出现引号很常见，漏了就整包 JSON 坏掉，
     * 而眼镜那边的表现只是"不显示"。
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
