import com.leion.lanrelay.AsrRouteTable;
import com.leion.lanrelay.InterpreterLang;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * AsrRouteTableCheck —— 「哪门语言用哪个识别函数」这张表的**可执行**判定测试（5.39）。
 * ============================================================================
 * 为什么这类"配置表"必须跑起来验：它的错误全是**静默**的 ——
 * JSON 里把 backend 名字写错一个字母，界面照样出字幕，只是用的不是你以为的那个引擎，
 * 而且没有任何报错。所以这里钉的是三类"说不出来"的情形：
 *
 *   ① 语言在表里没有、也没有 default      → 必须报错（不许猜一个后端顶上）；
 *   ② backend 指向一个没实现的后端        → 必须报错，并指出是哪个 id；
 *   ③ 判定成功时 reason 要写清按哪一条判的（用户问"为什么用这个引擎"时答案来自表）。
 *
 * 只依赖纯 Java（AsrRouteTable 不 import android.*），所以能直接编译执行。
 * 输出刻意是 ASCII（`passed=N failed=0`）：Windows 的 Java 控制台编码会把中文打成乱码，
 * 而这一行要被测试脚本用正则读。
 */
public final class AsrRouteTableCheck {

    private static int passed = 0;
    private static int failed = 0;

    public static void main(String[] args) {
        Map<String, String> defaults = row("backend", "relay", "engine", "server-default");
        Map<String, Map<String, String>> languages = new LinkedHashMap<>();
        languages.put("zh-CN", row("backend", "relay", "engine", "server-default"));
        languages.put("pt-BR", row("backend", "relay", "engine", "whisper-large-v3"));
        languages.put("en-US", row("backend", "on-device"));

        Map<String, Map<String, String>> backends = new LinkedHashMap<>();
        backends.put("relay", row("available", "true", "desc", "server"));
        backends.put("scripted", row("available", "true"));
        backends.put("on-device", row("available", "false", "desc", "not wired yet"));

        // ① 正常命中：语言 → 表里那一行
        AsrRouteTable.Route zh = AsrRouteTable.resolve(defaults, languages, backends, "zh-CN");
        expectTrue("zh-CN 可用", zh.ok());
        eq("zh-CN → relay", zh.backendId, "relay");
        eq("zh-CN 带出引擎偏好", zh.engine, "server-default");
        expectTrue("zh-CN 的理由写清按哪条判", zh.reason.contains("languages.zh-CN"), zh.reason);

        // ② 每门语言可以有**不同**的引擎偏好（表的意义就在这里）
        AsrRouteTable.Route pt = AsrRouteTable.resolve(defaults, languages, backends, "pt-BR");
        eq("pt-BR 自己的引擎偏好", pt.engine, "whisper-large-v3");
        expectTrue("pt-BR 可用", pt.ok());

        // ③ 指向未实现的后端：必须报错，并指出 id（不许悄悄换一个）
        AsrRouteTable.Route en = AsrRouteTable.resolve(defaults, languages, backends, "en-US");
        expectTrue("en-US 不可用（on-device 没实现）", !en.ok());
        expectTrue("原因里点名 on-device", en.problem.contains("on-device"), en.problem);
        expectTrue("原因里说了「还没实现」", en.problem.contains("还没实现"), en.problem);
        eq("不可用时 backendId 仍然记下来（诊断用）", en.backendId, "on-device");

        // ④ 表里没这门语言 → 走 default，且理由写清是 default
        //    ⚠️ 两种"没有"要分开说：语言**认不出**（ja-JP）和 语言认识但**表里缺这一条**。
        //       `InterpreterLang.normalize("ja-JP")` 是空串，所以它落到"认不出"那一路。
        AsrRouteTable.Route unknownLang = AsrRouteTable.resolve(defaults, languages, backends, "ja-JP");
        expectTrue("语言认不出时 default 兜住了", unknownLang.ok());
        eq("走 default 的后端", unknownLang.backendId, "relay");
        expectTrue("理由写清「语言认不出」", unknownLang.reason.contains("语言认不出"), unknownLang.reason);

        Map<String, Map<String, String>> partial = new LinkedHashMap<>(languages);
        partial.remove("zh-CN");
        AsrRouteTable.Route missingRow = AsrRouteTable.resolve(defaults, partial, backends, "zh-CN");
        expectTrue("表里缺 zh-CN 时 default 兜住", missingRow.ok());
        expectTrue("理由写清「languages 里没有 zh-CN」",
                missingRow.reason.contains("languages 里没有 zh-CN"), missingRow.reason);

        // ⑤ 连 default 都没有 → 报错（这是最容易写成"随便挑一个"的地方）
        AsrRouteTable.Route nothing = AsrRouteTable.resolve(null, languages, backends, "ja-JP");
        expectTrue("没有 default 就报错", !nothing.ok());
        expectTrue("并且说清缺什么", nothing.problem.contains("default"), nothing.problem);

        // ⑥ backend 名字写错（表里有这条语言，但 backends 里没有这个 id）
        Map<String, Map<String, String>> typoLang = new LinkedHashMap<>();
        typoLang.put("zh-CN", row("backend", "relai"));
        AsrRouteTable.Route typo = AsrRouteTable.resolve(defaults, typoLang, backends, "zh-CN");
        expectTrue("名字写错要报错", !typo.ok());
        expectTrue("原因里点名那个写错的 id", typo.problem.contains("relai"), typo.problem);

        // ⑦ 语言写法容错：`zh` / `zh_CN` 都当 zh-CN
        AsrRouteTable.Route shortCode = AsrRouteTable.resolve(defaults, languages, backends, "zh_CN");
        eq("zh_CN 归一成 zh-CN", shortCode.engine, "server-default");

        // ⑧ describe 要把三种语言都摊开（启动日志靠它）
        String described = AsrRouteTable.describe(defaults, languages, backends);
        for (String lang : InterpreterLang.ALL) {
            expectTrue("describe 里有 " + lang, described.contains(lang), described);
        }
        expectTrue("describe 标出不可用的那门", described.contains("不可用"), described);

        // ⑨ 缺字段的容错：空 backend → 报错而不是用空串当后端
        Map<String, Map<String, String>> blankLang = new LinkedHashMap<>();
        blankLang.put("zh-CN", row("engine", "x"));
        AsrRouteTable.Route blank = AsrRouteTable.resolve(defaults, blankLang, backends, "zh-CN");
        expectTrue("没写 backend 要报错", !blank.ok());
        expectTrue("原因里说了没写 backend", blank.problem.contains("backend"), blank.problem);

        System.out.println("passed=" + passed + " failed=" + failed);
        if (failed != 0) System.exit(1);
    }

    private static Map<String, String> row(String... pairs) {
        Map<String, String> out = new LinkedHashMap<>();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            out.put(pairs[i], pairs[i + 1]);
        }
        return out;
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
