import com.leion.lanrelay.InterpreterLang;

/**
 * InterpreterLangCheck —— 「我读的语言 / 对方说的语言」这组规则的**可执行**验证（5.37）。
 * ============================================================================
 * 为什么这类规则要单独跑：三条不变量都是**静默失败**型的，界面上看不出来：
 *
 *   ① 对方语言永远不等于我读的语言 —— 否则原文与译文同语言，服务端认定不需要译文，
 *      用户说完了却一条字幕都没有（不是报错，是"什么都没发生"）；
 *   ② 读中文时对方**可能是两种**（葡语/英语）—— 这是三语场景才暴露的，写死一种就会
 *      "对方说英语，界面按葡语解码"，一整段乱码比不识别更难查；
 *   ③ 存储值可能来自旧版本或被手改 —— 每次启动都要钉回合法组合，不能带进会话里。
 *
 * 只依赖纯 Java（InterpreterLang 不 import android.*），所以能直接编译执行。
 * 输出刻意是 ASCII（`passed=N failed=0`）：Windows 的 Java 控制台编码会把中文打成乱码，
 * 而这一行要被测试脚本用正则读。
 */
public final class InterpreterLangCheck {

    private static int passed = 0;
    private static int failed = 0;

    public static void main(String[] args) {
        // ① 默认镜像：读什么 → 对方说什么（与 lib/rooms.mjs 的 interpreterPartnerLang 一致）
        eq("读中文 → 对方默认葡语", InterpreterLang.defaultPartner(InterpreterLang.ZH), "pt-BR");
        eq("读葡语 → 对方默认中文", InterpreterLang.defaultPartner(InterpreterLang.PT), "zh-CN");
        eq("读英语 → 对方默认中文", InterpreterLang.defaultPartner(InterpreterLang.EN), "zh-CN");
        eq("认不出的读语言 → 空串（不硬猜）", InterpreterLang.defaultPartner("ja-JP"), "");
        eq("空串 → 空串", InterpreterLang.defaultPartner(null), "");

        // ② 对方语言的候选集合：除我读的那门以外都合法；永远不含读语言自己（不变量 ②）
        //    ⚠️ 5.106 改过这里：原来"读葡语/英语时只有中文一种"，把**葡语↔英语**这一对
        //    排除掉了 —— 用户实测就是"读葡语时对方只能选简体中文"，想选英语没有按钮。
        String[] zhOptions = InterpreterLang.partnerOptions(InterpreterLang.ZH);
        expect("读中文时对方有两种可能", zhOptions.length == 2, String.valueOf(zhOptions.length));
        contains("读中文时可选葡语", zhOptions, "pt-BR");
        contains("读中文时可选英语", zhOptions, "en-US");
        String[] ptOptions = InterpreterLang.partnerOptions(InterpreterLang.PT);
        expect("读葡语时对方也有两种可能（中/英）", ptOptions.length == 2,
                String.valueOf(ptOptions.length));
        contains("读葡语时可选中文", ptOptions, "zh-CN");
        contains("读葡语时可选英语", ptOptions, "en-US");
        String[] enOptions = InterpreterLang.partnerOptions(InterpreterLang.EN);
        expect("读英语时对方也有两种可能（中/葡）", enOptions.length == 2,
                String.valueOf(enOptions.length));
        contains("读英语时可选中文", enOptions, "zh-CN");
        contains("读英语时可选葡语", enOptions, "pt-BR");
        for (String read : new String[] { "zh-CN", "pt-BR", "en-US" }) {
            boolean self = false;
            for (String one : InterpreterLang.partnerOptions(read)) {
                if (one.equals(read)) self = true;
            }
            expect("候选里不含读语言自己（" + read + "）", self == false, "");
        }
        expect("认不出的读语言 → 没有候选（不瞎给按钮）",
                InterpreterLang.partnerOptions("ja-JP").length == 0, "");

        // ③ 归一化：短码/大写下划线都要收（各家客户端上报的形状不一样）
        eq("zh 归一成 zh-CN", InterpreterLang.normalize("zh"), "zh-CN");
        eq("zh_CN 归一成 zh-CN", InterpreterLang.normalize("zh_CN"), "zh-CN");
        eq("PT-br 归一成 pt-BR", InterpreterLang.normalize("PT-br"), "pt-BR");
        eq("en-US 原样", InterpreterLang.normalize("en-US"), "en-US");
        eq("日语认不出 → 空", InterpreterLang.normalize("ja-JP"), "");
        eq("null → 空", InterpreterLang.normalize(null), "");
        expect("supported 只认三种", InterpreterLang.supported("zh-CN")
                && InterpreterLang.supported("pt-BR") && InterpreterLang.supported("en-US")
                && !InterpreterLang.supported("zh"), "only three tags");

        // ④ 存储值钉正（不变量 ③）
        eq("旧值认不出 → 回中文", InterpreterLang.resolveRead("klingon"), "zh-CN");
        eq("读语言空 → 回中文", InterpreterLang.resolveRead(""), "zh-CN");
        eq("对方语言空 → 按读语言推", InterpreterLang.resolvePartner("", "zh-CN"), "pt-BR");
        eq("对方语言等于读语言 → 换成默认", InterpreterLang.resolvePartner("zh-CN", "zh-CN"), "pt-BR");
        eq("读葡语却存了葡语 → 换成中文", InterpreterLang.resolvePartner("pt-BR", "pt-BR"), "zh-CN");
        eq("读中文存英语 → 保留（合法）", InterpreterLang.resolvePartner("en-US", "zh-CN"), "en-US");
        eq("读中文存葡语 → 保留（合法）", InterpreterLang.resolvePartner("pt-BR", "zh-CN"), "pt-BR");
        eq("读葡语存英语 → 合法（5.106 起允许葡英互译）",
                InterpreterLang.resolvePartner("en-US", "pt-BR"), "en-US");
        eq("读英语存葡语 → 合法（同上）", InterpreterLang.resolvePartner("pt-BR", "en-US"), "pt-BR");
        eq("读英语存英语 → 换成默认中文", InterpreterLang.resolvePartner("en-US", "en-US"), "zh-CN");

        // ⑤ AUTO 常量的语义：界面上"不用想"的那一项（存 auto ≠ 存了一个语言）
        expect("AUTO 常量不与任何语言相等", !InterpreterLang.AUTO.equals(InterpreterLang.ZH)
                && !InterpreterLang.AUTO.equals(InterpreterLang.PT)
                && !InterpreterLang.AUTO.equals(InterpreterLang.EN), "AUTO=" + InterpreterLang.AUTO);
        eq("存 auto → 按读语言推", InterpreterLang.resolvePartner(InterpreterLang.AUTO, "zh-CN"), "pt-BR");

        System.out.println("passed=" + passed + " failed=" + failed);
        if (failed != 0) System.exit(1);
    }

    private static void eq(String what, String actual, String expected) {
        if (expected.equals(actual)) {
            passed += 1;
        } else {
            failed += 1;
            System.out.println("FAIL " + what + ": expected <" + expected + "> got <" + actual + ">");
        }
    }

    private static void expect(String what, boolean ok, String detail) {
        if (ok) {
            passed += 1;
        } else {
            failed += 1;
            System.out.println("FAIL " + what + (detail.isEmpty() ? "" : " (" + detail + ")"));
        }
    }

    private static void contains(String what, String[] values, String wanted) {
        boolean found = false;
        for (String one : values) {
            if (one.equals(wanted)) found = true;
        }
        expect(what, found, wanted);
    }
}
