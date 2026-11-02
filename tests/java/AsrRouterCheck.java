import com.leion.lanrelay.AsrRouter;
import com.leion.lanrelay.InterpreterAsrBackend;

/**
 * AsrRouterCheck —— 「按语言挑引擎」的规则，跑起来验（5.32）。
 *
 * <p>为什么这条必须能执行：路由规则错了**不会崩**，只会"这句用错了引擎"——
 * 表现是识别结果莫名其妙（中文句子被葡语模型转成乱码），而日志上看着一切正常。
 * 这种错靠读代码守不住。
 *
 * <p>由 `tests/tts-suite.mjs` 调 javac + java 执行；没有 JDK 或沙箱不让起子进程时**明确跳过**。
 */
public final class AsrRouterCheck {

    private static int passed = 0;
    private static int failed = 0;

    /** 一个只声明支持某些语言的假后端。 */
    private static final class Fake implements InterpreterAsrBackend {
        private final String label;
        private final String[] langs;
        private final boolean network;
        String startedWith = null;

        Fake(String label, String[] langs, boolean network) {
            this.label = label;
            this.langs = langs;
            this.network = network;
        }

        @Override
        public String debugLabel() {
            return label;
        }

        @Override
        public boolean requiresNetwork() {
            return network;
        }

        @Override
        public String[] languages() {
            return langs;
        }

        @Override
        public void start(String lang, Listener listener) {
            startedWith = lang;
        }

        @Override
        public void sendAudio(byte[] pcm, int sampleRate) {
        }

        @Override
        public void stop() {
        }
    }

    public static void main(String[] args) {
        // ① 精确语言：挑声明支持它的那个
        AsrRouter router = new AsrRouter();
        Fake localZh = new Fake("本地-zh", new String[]{ "zh-CN" }, false);
        Fake cloudPt = new Fake("云端-pt", new String[]{ "pt-BR" }, true);
        Fake universal = new Fake("通用", new String[0], false);
        router.register("local-zh", localZh);
        router.register("cloud-pt", cloudPt);
        router.register("universal", universal);

        expect("zh-CN 走本地", router.resolve("zh-CN").backend, localZh);
        expect("pt-BR 走云端", router.resolve("pt-BR").backend, cloudPt);
        // 理由里带的是**归一化后**的语言码（zh-cn），因为匹配本身就是这么做的
        expectTrue("理由里写清是按语言匹配的", router.resolve("zh-CN").reason.contains("zh-cn"));

        // ② 主语言匹配：zh / pt 这种简写也要认（各家语种码不统一）
        expect("zh 简写也认", router.resolve("zh").backend, localZh);
        expect("pt 简写也认", router.resolve("pt").backend, cloudPt);
        expect("大小写/下划线也认", router.resolve("ZH_cn").backend, localZh);

        // ③ 没有专用引擎 → 通用后端兜底，并且**说清是兜底**
        Fake onlyLocal = new Fake("本地-zh", new String[]{ "zh-CN" }, false);
        AsrRouter two = new AsrRouter();
        two.register("local-zh", onlyLocal);
        two.register("universal", universal);
        AsrRouter.Resolution enFallback = two.resolve("en-US");
        expect("英语没有专用引擎 → 通用兜底", enFallback.backend, universal);
        expectTrue("理由里写明是兜底", enFallback.reason.contains("通用"));

        // ④ 语言未知（"" / auto）→ 通用后端；没有通用就失败
        expect("空语言 → 通用", two.resolve("").backend, universal);
        expect("auto → 通用", two.resolve("auto").backend, universal);
        AsrRouter onlySpecial = new AsrRouter();
        onlySpecial.register("local-zh", new Fake("本地-zh", new String[]{ "zh-CN" }, false));
        AsrRouter.Resolution unknown = onlySpecial.resolve("");
        expectTrue("没有通用引擎时，语言未知要失败", unknown.ok() == false);
        expectTrue("失败原因说清是「语言未知」", unknown.problem.contains("语言未知"));

        // ⑤ 完全不支持的语言 → **失败**，绝不硬顶给别的语言
        AsrRouter.Resolution ja = onlySpecial.resolve("ja-JP");
        expectTrue("日语没有引擎 → 失败", ja.ok() == false);
        expectTrue("失败原因点名了语言", ja.problem.contains("ja-JP"));

        // ⑥ 空路由器也要给出可用的一句话，不炸
        AsrRouter empty = new AsrRouter();
        expectTrue("空路由器 resolve 不炸", empty.resolve("zh-CN").ok() == false);
        expectTrue("空路由器 describe 有内容", empty.describe().contains("没有注册"));

        // ⑦ describe 要把"谁支持什么、要不要外网"摊开（启动日志与诊断靠它）
        String described = router.describe();
        expectTrue("describe 里有 zhed 后端", described.contains("本地-zh"));
        expectTrue("describe 标出需要外网的那个", described.contains("需外网"));
        expectTrue("describe 标出通用后端", described.contains("通用"));

        // ⑧ start 时**语言必须传下去**（后端要靠它给识别器设语种）
        Fake probe = new Fake("探针", new String[]{ "pt-BR" }, false);
        probe.start("pt-BR", null);
        expect("会话语言传给了后端", probe.startedWith, "pt-BR");

        // ⑨ 语言归一化本身
        expect("归一化：ZH_CN → zh-cn", InterpreterAsrBackend.normalizeLang(" ZH_CN "), "zh-cn");
        expect("主语言：zh-cn → zh", InterpreterAsrBackend.primary("zh-cn"), "zh");
        expect("主语言：没有横线就整个是主语言", InterpreterAsrBackend.primary("pt"), "pt");

        System.out.println("AsrRouterCheck: passed=" + passed + " failed=" + failed);
        if (failed > 0) System.exit(1);
    }

    private static void expect(String name, Object actual, Object expected) {
        boolean same = actual == expected || (actual != null && actual.equals(expected));
        if (same) {
            passed += 1;
        } else {
            failed += 1;
            System.out.println("  FAIL " + name + ": expected=" + expected + " actual=" + actual);
        }
    }

    private static void expectTrue(String name, boolean value) {
        expect(name, value, true);
    }
}
