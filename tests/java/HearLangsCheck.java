import com.leion.lanrelay.HearLangs;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * HearLangsCheck —— 「我想看哪些译文」这套规则的**可执行**验证（5.55）。
 * ============================================================================
 * 为什么必须跑起来验：这条规则写错的表现极其安静 —— 界面照常、胶囊照样高亮，
 * 只是**别人说的话不会翻译给我**（或翻译成我不读的语言）。没有任何报错。
 *
 * 钉住四件事：
 *   ① **说话语言永远在"我想看"里**（它不是"看自己的原文"，而是"别人的话译给我"）；
 *   ② 换说话语言后，旧的那门仍可保留（用户没说要去掉）；
 *   ③ 脏输入（未知标签、重复、大小写）要归一化，顺序固定；
 *   ④ 空输入 + 空说话语言 → 空列表（不硬塞一个莫名的语言）。
 *
 * 只依赖纯 Java（HearLangs 不 import android）。输出刻意 ASCII。
 */
public final class HearLangsCheck {

    private static int passed = 0;
    private static int failed = 0;

    public static void main(String[] args) {
        // ① 强制包含说话语言（老师的场景：我说葡语，但英文和中文的译文都想看）
        List<String> alice = HearLangs.normalize(Arrays.asList("en-US", "zh-CN"), "pt-BR");
        eqList("说葡语、想看中英 → 三语都在（含自己说的葡语）", alice,
                Arrays.asList("zh-CN", "pt-BR", "en-US"));

        // ② 只勾了别的语言、说话语言仍被并入
        List<String> onlyEn = HearLangs.normalize(Arrays.asList("en-US"), "pt-BR");
        eqList("只勾英文时，说话语言仍被并进去", onlyEn, Arrays.asList("pt-BR", "en-US"));

        // ③ 脏输入：大小写、短码、重复、未知标签
        List<String> dirty = HearLangs.normalize(
                Arrays.asList("zh-cn", "ZH-CN", "ja-JP", "en_US"), "pt-BR");
        eqList("脏输入被归一化（大小写/短码/重复/未知）", dirty,
                Arrays.asList("zh-CN", "pt-BR", "en-US"));

        // ④ 顺序固定（与服务器 normalizeHearLangs 一致：中 → 葡 → 英）
        eqList("顺序固定为中/葡/英", HearLangs.normalize(Arrays.asList("en-US", "zh-CN"), "pt-BR"),
                Arrays.asList("zh-CN", "pt-BR", "en-US"));

        // ⑤ 空输入：说话语言在 → 只有它；两者都空 → 空列表
        eqList("没有说话语言、也没勾 → 只有勾的", HearLangs.normalize(Arrays.asList("en-US"), ""),
                Arrays.asList("en-US"));
        eqList("都没有 → 空列表（不硬塞语言）", HearLangs.normalize(new ArrayList<>(), ""),
                new ArrayList<>());

        // ⑥ parse / join 往返
        eqList("parse 逗号分隔", HearLangs.parse("zh-CN, en-US ), xx"),
                Arrays.asList("zh-CN", "en-US"));
        eq("join 输出固定顺序", HearLangs.join(Arrays.asList("en-US", "zh-CN"), "pt-BR"),
                "zh-CN,pt-BR,en-US");
        eq("join 空输入 + 说话语言 → 只有它",
                HearLangs.join(new ArrayList<>(), "en-US"), "en-US");

        // ⑦ normalizeTag 只认三种（认不出返回 null，不猜）
        eq("zh_Cn 认成 zh-CN", HearLangs.normalizeTag("zh_Cn"), "zh-CN");
        expectTrue("ja-JP 认不出 → null", HearLangs.normalizeTag("ja-JP") == null);
        expectTrue("空串 → null", HearLangs.normalizeTag("") == null);

        System.out.println("passed=" + passed + " failed=" + failed);
        if (failed != 0) System.exit(1);
    }

    private static void eqList(String what, List<String> actual, List<String> expected) {
        if (expected.equals(actual)) {
            passed += 1;
        } else {
            failed += 1;
            System.out.println("FAIL " + what + ": expected " + expected + " got " + actual);
        }
    }

    private static void eq(String what, String actual, String expected) {
        if (expected.equals(actual)) {
            passed += 1;
        } else {
            failed += 1;
            System.out.println("FAIL " + what + ": expected <" + expected + "> got <" + actual + ">");
        }
    }

    private static void expectTrue(String what, boolean ok) {
        if (ok) {
            passed += 1;
        } else {
            failed += 1;
            System.out.println("FAIL " + what);
        }
    }
}
