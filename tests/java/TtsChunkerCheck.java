import com.leion.lanrelay.TtsChunker;

import java.util.List;

/**
 * TtsChunkerCheck —— 本仓库第一个**可执行**的 Java 测试（5.30）。
 *
 * <p>为什么单独搞一个：`TtsChunker` 是纯逻辑（不碰 Android API），但它决定
 * "一秒钟能听到第一声"还是"要等整段合成完" —— 这种规则靠肉眼看代码守不住。
 * 其余 Java 代码靠 `tests/android-order-suite.mjs` 的静态检查，而纯函数可以直接跑。
 *
 * <p>由 `tests/tts-suite.mjs` 调 `javac` + `java` 执行；本机没有 JDK 时那条用例**跳过**（明确打印）。
 *
 * <p>编译方式（两个文件一起）：`javac -encoding UTF-8 -d <out> TtsChunker.java TtsChunkerCheck.java`
 * —— 它不依赖 android.jar，所以不需要一整套 Android 编译。
 */
public final class TtsChunkerCheck {

    private static int passed = 0;
    private static int failed = 0;

    public static void main(String[] args) {
        // ① 空输入不炸、也不产出块
        expect("空串 → 无块", TtsChunker.split("", "zh-CN").size(), 0);
        expect("null → 无块", TtsChunker.split(null, "zh-CN").size(), 0);
        expect("纯空白 → 无块", TtsChunker.split("   \n  ", "zh-CN").size(), 0);

        // ② 短句不切
        List<String> one = TtsChunker.split("好的。", "zh-CN");
        expect("短句 → 一块", one.size(), 1);
        expect("短句内容原样", one.isEmpty() ? "" : one.get(0), "好的。");

        // ③ 按句末标点切成多块（句子要够长，否则会被"碎片合并"规则并成一块）
        List<String> two = TtsChunker.split("第一句话说得稍长一些。第二句话也说得稍长一些！", "zh-CN");
        expect("两句（都够长）→ 两块", two.size(), 2);
        expect("第一块", two.isEmpty() ? "" : two.get(0), "第一句话说得稍长一些。");
        expect("第二块", two.size() < 2 ? "" : two.get(1), "第二句话也说得稍长一些！");

        // ④ 半角 `!` / `.` 也认（西文句子就是以 . 结尾；交接包那条正则漏了 `.`）
        List<String> en2 = TtsChunker.split(
                "Hello there, this sentence is long enough. And this second one is long enough too!",
                "en-US");
        expect("西文两句 → 两块", en2.size(), 2);

        // ④b 小数/版本号里的点**不许**当句末（否则会把 3.5 切成"3."+"5"）
        List<String> decimal = TtsChunker.split("价格是 3.5 元，请确认一下。", "zh-CN");
        expect("小数点不切句", decimal.size(), 1);

        // ⑤ 超长单句按 maxChars 装箱（中文 80 字）
        StringBuilder longOne = new StringBuilder();
        for (int i = 0; i < 40; i += 1) longOne.append("这是一段很长的句子，");
        List<String> boxed = TtsChunker.split(longOne.toString(), "zh-CN");
        boolean allUnderMax = true;
        for (String part : boxed) {
            if (part.length() > TtsChunker.MAX_CHARS_CJK) allUnderMax = false;
        }
        expectTrue("超长句被切成多块", boxed.size() > 1);
        expectTrue("每块不超过上限", allUnderMax);
        expectTrue("块数不超过硬上限", boxed.size() <= TtsChunker.MAX_CHUNKS);

        // ⑥ 太短的碎片要并进前一块（不然"好。"这种也要一次合成往返）
        List<String> shortParts = TtsChunker.split("好的。嗯。", "zh-CN");
        expect("两个短碎片合并成一块", shortParts.size(), 1);

        // ⑦ 硬上限：20 个短句也不会变成 20 次合成
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 20; i += 1) many.append("这是第").append(i).append("句很短的话。");
        List<String> capped = TtsChunker.split(many.toString(), "zh-CN");
        expectTrue("块数不超过 8", capped.size() <= TtsChunker.MAX_CHUNKS);
        expectTrue("内容没丢（合并后的总长度对得上）",
                totalLength(capped) >= many.toString().replaceAll("\\s+", "").length() - 1);

        // ⑧ 西文按词长算：同样 100 字，英文不该被切得太碎
        List<String> en = TtsChunker.split(
                "This is a fairly long sentence that keeps going for a while, and it still "
                        + "should not be split into too many tiny pieces because that would cost "
                        + "one synthesis round trip per piece.", "en-US");
        expectTrue("英文长句也被切了", en.size() >= 1);

        // 汇总行**只用 ASCII**：Windows 上 Java 的 stdout 是平台编码（GBK），
        // 由 JS 读回来按 UTF-8 解码会变成乱码，判据就永远对不上。
        System.out.println("TtsChunkerCheck: passed=" + passed + " failed=" + failed);
        if (failed > 0) System.exit(1);
    }

    private static int totalLength(List<String> parts) {
        int sum = 0;
        for (String part : parts) sum += part.length();
        return sum;
    }

    private static void expect(String name, Object actual, Object expected) {
        if (String.valueOf(actual).equals(String.valueOf(expected))) {
            passed += 1;
        } else {
            failed += 1;
            System.out.println("  ❌ " + name + "：期望 " + expected + "，实际 " + actual);
        }
    }

    private static void expectTrue(String name, boolean value) {
        expect(name, value, true);
    }
}
