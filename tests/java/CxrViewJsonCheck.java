import com.leion.lanrelay.CxrViewJson;

/**
 * CxrViewJsonCheck —— 镜片显示 JSON 的**可执行**验证（5.127 重写）。
 * ============================================================================
 * 为什么必须跑起来验：Rokid 那边拿到坏 JSON 的**唯一表现是"镜片上没有字"** ——
 * 没有异常、没有日志、没有错误码（官方 Sample 里也写着"多行缩进的 JSON 会让
 * customView_open 静默失败"）。所以协议形状只能靠这里逐条钉：
 *
 *   ① 打开视图的形状（LinearLayout 根 + 一个 TextView 子节点，id 固定）；
 *   ② 增量更新用**同一个 id**（对不上就永远更新不到）；
 *   ③ 转义（译文里出现引号/反斜线/换行时 JSON 不能坏）；
 *   ④ 协议只认字符串（尺寸 `32sp`、颜色 8 位 ARGB）；
 *   ⑤ 紧凑单行（任何裸换行都会让镜片端解析失败）。
 *
 * 只依赖纯 Java（CxrViewJson 不 import android），所以能直接编译执行。
 * 输出刻意 ASCII（Windows 的 Java 控制台是 GBK）。
 */
public final class CxrViewJsonCheck {

    private static int passed = 0;
    private static int failed = 0;

    public static void main(String[] args) {
        String view = CxrViewJson.openView("早上好，一切都还好吗？", "32sp");
        expectTrue("打开视图是 LinearLayout 根节点", view.contains("\"type\":\"LinearLayout\""), view);
        expectTrue("根节点带稳定 id", view.contains("\"id\":\"" + CxrViewJson.ROOT_ID + "\""), view);
        expectTrue("竖向排列", view.contains("\"orientation\":\"vertical\""), view);
        expectTrue("只有一个 TextView 子节点（这一版只投译文）",
            count(view, "\"type\":\"TextView\"") == 1, String.valueOf(count(view, "\"type\":\"TextView\"")));
        expectTrue("文字的节点 id 是固定那个（更新要用同一个）",
            view.contains("\"id\":\"" + CxrViewJson.TEXT_ID + "\""), view);
        expectTrue("译文编进去了", view.contains("早上好"), view);
        expectTrue("尺寸与颜色写成字符串（协议只认字符串）",
            view.contains("\"textSize\":\"32sp\"")
                && view.contains("\"textColor\":\"" + CxrViewJson.DEFAULT_TEXT_COLOR + "\""), view);
        expectTrue("颜色是绿通道量（镜片是绿光单色屏，样例也只给绿）",
            CxrViewJson.DEFAULT_TEXT_COLOR.matches("#FF00[0-9A-Fa-f]{2}00"),
            CxrViewJson.DEFAULT_TEXT_COLOR);
        expectTrue("JSON 结构平衡（括号数量一致）",
            count(view, '{') == count(view, '}') && count(view, '[') == count(view, ']'), view);
        expectTrue("整包是紧凑单行（多行缩进会让镜片端静默失败）",
            !view.contains("\n"), view);

        // 尺寸规整：纯数字自动补 sp；写坏退回缺省（宁可偏大偏小，也不能整包被拒）
        expectTrue("纯数字字号自动补 sp",
            CxrViewJson.openView("x", "40").contains("\"textSize\":\"40sp\""));
        expectTrue("写坏的字号退回缺省（不把坏值发给眼镜）",
            CxrViewJson.openView("x", "40px").contains("\"textSize\":\"" + CxrViewJson.DEFAULT_TEXT_SIZE + "\""));

        // ② 增量更新：形状 + 同一个 id + 只带 text
        String update = CxrViewJson.updateText("今天下午三点开会");
        expectTrue("更新用 action=update", update.contains("\"action\":\"update\""), update);
        expectTrue("更新打的 id 与打开视图一致",
            update.contains("\"id\":\"" + CxrViewJson.TEXT_ID + "\""), update);
        expectTrue("更新只带 text（不重发整份视图）",
            update.contains("\"props\":{\"text\":") && !update.contains("\"type\""), update);
        expectTrue("更新是数组（协议要求 [ … ]）",
            update.startsWith("[") && update.endsWith("]"), update);
        expectTrue("空串也发（空 = 清掉这一句；跳过会让镜片留着上一句）",
            CxrViewJson.clearText().contains("\"text\":\"\""), CxrViewJson.clearText());

        // ③ 转义：真实译文里一定有引号和换行
        String tricky = "He said \"OK\"\\done\nline2\ttab";
        String escaped = CxrViewJson.updateText(tricky);
        expectTrue("引号被转义", escaped.contains("\\\"OK\\\""), escaped);
        expectTrue("反斜线被转义", escaped.contains("\\\\done"), escaped);
        expectTrue("换行被转义成 \\n（不是裸换行）",
            escaped.contains("\\nline2") && !escaped.contains("\n"), escaped);
        expectTrue("制表被转义", escaped.contains("\\ttab"), escaped);
        expectTrue("控制字符被转义成 \\u00xx",
            CxrViewJson.updateText("a\u0001b").contains("\\u0001"), CxrViewJson.updateText("a\u0001b"));

        // 空值不炸（null 当空串处理）
        expectTrue("null 文字不会编出 JSON null",
            CxrViewJson.openView(null, null).contains("\"text\":\"\"")
                && CxrViewJson.updateText(null).contains("\"text\":\"\""));

        System.out.println("passed=" + passed + " failed=" + failed);
        if (failed != 0) System.exit(1);
    }

    private static int count(String text, char target) {
        int total = 0;
        for (int index = 0; index < text.length(); index += 1) {
            if (text.charAt(index) == target) total += 1;
        }
        return total;
    }

    private static int count(String text, String target) {
        int total = 0;
        int from = 0;
        while (true) {
            int at = text.indexOf(target, from);
            if (at < 0) return total;
            total += 1;
            from = at + target.length();
        }
    }

    private static void expectTrue(String what, boolean ok) {
        expectTrue(what, ok, "");
    }

    private static void expectTrue(String what, boolean ok, String detail) {
        if (ok) {
            passed += 1;
        } else {
            failed += 1;
            System.out.println("FAIL " + what + (detail.isEmpty() ? "" : " (" + detail + ")"));
        }
    }
}
