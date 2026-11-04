/**
 * AsrEngineOptionsCheck.java —— 「这一场能用哪些识别引擎」的判据（可执行断言）
 * ============================================================================
 *
 * 为什么要跑起来验而不是看代码：这个类里全是**容易看起来很对**的规则 ——
 * 「已保存的优先」「找不到就用服务器算的当前项」「whisper 不显式上报」。
 * 它们错一个的后果都不是崩溃，而是 **A/B 结论是假的**：
 * 用户以为在跑 turbo，实际还是 large-v3，然后得出「两个模型一样」。
 *
 * 用 javac + java 直接跑（不依赖 Android / JUnit）：
 *   javac -encoding UTF-8 -d out AsrEngineOptions.java AsrEngineOptionsCheck.java
 *   java -cp out AsrEngineOptionsCheck
 *
 * ⚠️ 输出只用 ASCII（Windows 控制台是 GBK，中文会变成乱码，断言串就看不清了）。
 */

import com.leion.lanrelay.AsrEngineOptions;

import java.util.ArrayList;
import java.util.List;

public final class AsrEngineOptionsCheck {

    private static int passed = 0;
    private static int failed = 0;

    private static void check(String label, boolean ok) {
        check(label, ok, "");
    }

    private static void check(String label, boolean ok, String detail) {
        if (ok) {
            passed += 1;
        } else {
            failed += 1;
            System.out.println("FAIL: " + label + (detail.isEmpty() ? "" : "  [" + detail + "]"));
        }
    }

    private static AsrEngineOptions.Option option(String strategy, String engine, String model,
                                                  String label, String available, boolean current) {
        return new AsrEngineOptions.Option(strategy, engine, model, label, available, "", current);
    }

    public static void main(String[] args) {
        // ── 1. 空清单：不替用户猜 ────────────────────────────────────────────
        AsrEngineOptions empty = AsrEngineOptions.empty();
        check("空清单 pick 返回 null（= 按服务器默认，而不是随便挑一个）",
                empty.pick("") == null && empty.pick("en-turbo") == null);
        check("空清单 isEmpty/size 一致", empty.isEmpty() && empty.size() == 0);
        check("空清单 at(0) 不越界（界面拿不到东西时不能崩）", empty.at(0) == null);

        // ── 2. 没保存过：用服务器算出来的当前项 ──────────────────────────────
        List<AsrEngineOptions.Option> raw = new ArrayList<>();
        raw.add(option("default", "whisper", "large-v3", "large-v3", "present", true));
        raw.add(option("en-turbo", "whisper", "large-v3-turbo", "large-v3-turbo", "unverified", false));
        raw.add(option("en-buzzasr", "whisper", "/models/buzzasr", "", "missing", false));
        AsrEngineOptions options = new AsrEngineOptions(raw);

        check("没保存过 → 用服务器算的当前项",
                options.pick("") != null && "default".equals(options.pick("").strategy),
                options.pick("") == null ? "null" : options.pick("").strategy);
        check("current() 找的是 current 那一项",
                options.current() != null && "large-v3".equals(options.current().model));

        // ── 3. 保存过的选择优先 ─────────────────────────────────────────────
        check("保存过的策略优先于当前项",
                "en-turbo".equals(options.pick("en-turbo").strategy),
                options.pick("en-turbo") == null ? "null" : options.pick("en-turbo").strategy);
        check("find 找得到就是那一项", options.find("en-turbo") != null
                && "large-v3-turbo".equals(options.find("en-turbo").model));

        // ── 4. 保存的策略已经没了：**不许**静默换一个顶上 ────────────────────
        check("find 找不到返回 null（不退回第一项）", options.find("en-parakeet") == null);
        check("策略被删掉时 pick 退回服务器当前项（而不是乱挑一个）",
                "default".equals(options.pick("en-parakeet").strategy),
                options.pick("en-parakeet") == null ? "null" : options.pick("en-parakeet").strategy);

        // ── 5. 可用性三态：只有 present 才算"能跑" ─────────────────────────
        check("present → ready()", options.find("default").ready()
                && !options.find("default").broken());
        check("unverified 不算 ready（首次会下载，不能假装已就绪）",
                !options.find("en-turbo").ready() && !options.find("en-turbo").broken());
        check("missing → broken()（选了必然失败，界面要能提前说）",
                options.find("en-buzzasr").broken());

        // ── 6. 上报什么：whisper 不显式报引擎，别的引擎要报 ────────────────
        check("whisper 的引擎上报是空串（缺省引擎不必写进侧车）",
                options.find("default").engineRequest().isEmpty(),
                options.find("default").engineRequest());
        AsrEngineOptions.Option parakeet = option("en-parakeet", "parakeet", "tdt-0.6b", "parakeet", "present", false);
        check("非 whisper 引擎会真的上报", "parakeet".equals(parakeet.engineRequest()));
        check("模型名原样上报（不去猜、不改写）",
                "large-v3-turbo".equals(options.find("en-turbo").modelRequest()));

        // ── 7. label 兜底与 null 规整 ───────────────────────────────────────
        check("label 为空时用 model 兜底（界面上不会出现空白行）",
                "large-v3".equals(options.at(0).label));
        check("model 为空时 label 用策略名兜底",
                "buzzasr".equals(option("buzzasr", "whisper", "", "buzzasr", "missing", false).label));
        AsrEngineOptions.Option nulls = new AsrEngineOptions.Option(null, null, null, null, null, null, false);
        check("null 字段一律规整成空串（界面层不用到处判空）",
                nulls.strategy.isEmpty() && nulls.engine.isEmpty() && nulls.model.isEmpty()
                        && nulls.available.isEmpty() && nulls.hint.isEmpty());

        // ── 8. 不可变：传进来的 list 后来被改，不该影响已建好的清单 ─────────
        List<AsrEngineOptions.Option> mutable = new ArrayList<>();
        mutable.add(option("default", "whisper", "large-v3", "large-v3", "present", true));
        AsrEngineOptions snapshot = new AsrEngineOptions(mutable);
        mutable.clear();
        check("清单是快照（外部 list 变了不影响它）", snapshot.size() == 1);

        // ── 9. 越界访问返回 null ────────────────────────────────────────────
        check("at(-1) 与 at(size) 都返回 null", options.at(-1) == null && options.at(options.size()) == null);
        check("summary 在没有选中项时返回空串（界面自己决定显示什么）",
                AsrEngineOptions.empty().summary("").isEmpty());

        System.out.println("passed=" + passed + " failed=" + failed);
        if (failed > 0) System.exit(1);
    }
}
