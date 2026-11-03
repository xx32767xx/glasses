import com.leion.lanrelay.CxrViewJson;

import java.util.ArrayList;
import java.util.List;

/**
 * CxrViewJsonCheck —— 镜片显示 JSON 的**可执行**验证（5.51）。
 * ============================================================================
 * 为什么必须跑起来验：眼镜那边拿到坏 JSON 的**唯一表现是"镜片上没有字"** ——
 * 没有异常、没有日志、没有错误码。所以协议形状只能靠这里逐条钉：
 *
 *   ① 打开视图的形状（type/props/children 三层，且每行 id 稳定）；
 *   ② 增量更新用的是**同一套 id**（对不上就永远更新不到）；
 *   ③ 转义（译文里出现引号/反斜线/换行时 JSON 不能坏）；
 *   ④ 行数上限与"最新在最后"（眼镜只有三行预算）。
 *
 * 只依赖纯 Java（CxrViewJson 不 import android），所以能直接编译执行。
 * 输出刻意 ASCII（Windows 的 Java 控制台是 GBK）。
 */
public final class CxrViewJsonCheck {

    private static int passed = 0;
    private static int failed = 0;

    public static void main(String[] args) {
        List<CxrViewJson.Line> lines = new ArrayList<>();
        lines.add(new CxrViewJson.Line("Bom dia, tudo bem?", "12sp", "#FFAAAAAA"));
        lines.add(new CxrViewJson.Line("早上好，一切都还好吗？", "16sp", "#FFFFFFFF"));

        String view = CxrViewJson.openView(lines);
        expectTrue("打开视图是 LinearLayout 根节点", view.contains("\"type\":\"LinearLayout\""), view);
        expectTrue("根节点带稳定 id", view.contains("\"id\":\"" + CxrViewJson.ROOT_ID + "\""), view);
        expectTrue("竖向排列", view.contains("\"orientation\":\"vertical\""), view);
        expectTrue("两行都编进去了",
            view.contains("\"id\":\"sub0\"") && view.contains("\"id\":\"sub1\""), view);
        expectTrue("原文与译文都在", view.contains("Bom dia") && view.contains("早上好"), view);
        expectTrue("尺寸与颜色写成字符串（协议只认字符串）",
            view.contains("\"textSize\":\"12sp\"") && view.contains("\"textColor\":\"#FFFFFFFF\""), view);
        expectTrue("JSON 结构平衡（括号数量一致）",
            count(view, '{') == count(view, '}') && count(view, '[') == count(view, ']'), view);

        String update = CxrViewJson.updateView(lines);
        expectTrue("更新用 action=update", update.contains("\"action\":\"update\""), update);
        expectTrue("更新打的 id 与打开视图一致（sub0 / sub1）",
            update.contains("\"id\":\"sub0\"") && update.contains("\"id\":\"sub1\"") , update);
        expectTrue("更新只带 text（不重发整份视图）",
            update.contains("\"props\":{\"text\":") && !update.contains("\"type\""), update);

        // ③ 转义：真实译文里一定有引号和换行
        List<CxrViewJson.Line> tricky = new ArrayList<>();
        tricky.add(new CxrViewJson.Line("He said \"OK\"\\done\nline2\ttab", "16sp", "#FFFFFFFF"));
        String escaped = CxrViewJson.openView(tricky);
        expectTrue("引号被转义", escaped.contains("\\\"OK\\\""), escaped);
        expectTrue("反斜线被转义", escaped.contains("\\\\done"), escaped);
        expectTrue("换行被转义成 \\n（不是裸换行）",
            escaped.contains("\\nline2") && !escaped.contains("\n"), escaped);
        expectTrue("制表被转义", escaped.contains("\\ttab"), escaped);

        // ④ 行数上限：眼镜只有三行
        List<CxrViewJson.Line> many = new ArrayList<>();
        for (int index = 0; index < 6; index += 1) {
            many.add(new CxrViewJson.Line("line" + index, "16sp", "#FFFFFFFF"));
        }
        String capped = CxrViewJson.openView(many);
        expectTrue("最多三行（超出的裁掉）", count(capped, "\"type\":\"TextView\"") == CxrViewJson.MAX_LINES,
            String.valueOf(count(capped, "\"type\":\"TextView\"")));
        expectTrue("裁掉的是最旧的（留下 line3/4/5）",
            capped.contains("line5") && !capped.contains("line0"), capped);

        // 空行不进视图（否则镜片上留一条空白，看起来像渲染坏了）
        List<CxrViewJson.Line> withBlank = new ArrayList<>();
        withBlank.add(new CxrViewJson.Line("   ", "16sp", "#FFFFFFFF"));
        withBlank.add(new CxrViewJson.Line("only", "16sp", "#FFFFFFFF"));
        expectTrue("纯空白行被略过",
            count(CxrViewJson.openView(withBlank), "\"type\":\"TextView\"") == 1);

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
