package com.leion.lanrelay;

import java.util.Map;
import java.util.Set;

/**
 * AsrRouteTable —— 「哪门语言交给哪个识别函数」这张表的**判定逻辑**（5.39）。
 * ============================================================================
 * 表本身是一个 JSON 文件（`assets/asr-routes.json`），改它不用改代码。
 * 这个类只做三件事：**读出来的表怎么判、判不出怎么说、判出来的理由怎么摊开**。
 *
 * <p>为什么判定逻辑单独一个纯 Java 类（不碰 Android、不碰 org.json）：
 * 它要能被直接编译执行的测试钉住（{@code tests/java/AsrRouteTableCheck.java}）。
 * 这类"配置表"最危险的错误是**静默兜底** —— JSON 里写错一个 backend 名字，
 * 界面照样出字幕，只是用的不是你以为的那个引擎。守这种东西只能靠测试。
 *
 * <p>三条硬规矩（都是"错就要说出来"）：
 * <ol>
 *   <li>语言在表里没有、且没有 `default` → <b>报错</b>，不猜一个后端顶上；</li>
 *   <li>`backend` 指向一个**没实现**的后端 → <b>报错</b>并说明是哪个 id 没有实现；</li>
 *   <li>能判出来时，`reason` 里写清"按哪一条判的"，日志和界面都用它 ——
 *       用户问"为什么这句用这个引擎"时，答案必须来自表，不是来自我的猜测。</li>
 * </ol>
 *
 * <p>表的形状（与 JSON 一一对应，由 {@link AsrRouteLoader} 解析后传进来）：
 * <pre>
 *   defaults            = {"backend": "relay", "engine": "server-default"}
 *   languages["zh-CN"]  = {"backend": "relay", "engine": "server-default", "note": "…"}
 *   backends["relay"]   = {"available": "true", "desc": "…"}
 * </pre>
 */
public final class AsrRouteTable {

    /** 一条路由：落到哪个后端、引擎偏好、以及**为什么是它**（judgement 的结果）。 */
    public static final class Route {
        /** 后端 id（`relay` / `scripted` / …）；不可用时为空串。 */
        public final String backendId;
        /** 引擎偏好（现在只是**记录**：服务器还不支持按语言切引擎，见 docs/21 §5.39）。 */
        public final String engine;
        /** 这条路由给人看的一句话（表里的 note，可空）。 */
        public final String note;
        /** 判定理由（"按 languages.zh-CN" / "按 default" / "没有 default" …）。 */
        public final String reason;
        /** 非空 = 这条路由**不可用**，内容是给用户看的原因。 */
        public final String problem;

        Route(String backendId, String engine, String note, String reason, String problem) {
            this.backendId = backendId == null ? "" : backendId;
            this.engine = engine == null ? "" : engine;
            this.note = note == null ? "" : note;
            this.reason = reason == null ? "" : reason;
            this.problem = problem == null ? "" : problem;
        }

        /** 能真的开始识别吗。 */
        public boolean ok() {
            return problem.isEmpty() && !backendId.isEmpty();
        }
    }

    private AsrRouteTable() {
    }

    /**
     * 判定某门语言该用哪个后端。
     *
     * @param defaults  表里的 `default`（可为空 Map，表示"没有兜底"）
     * @param languages 语言 → 该语言那一条（value 是字段表）
     * @param backends  后端 id → 该后端那一条（要读 `available`）
     * @param lang      要识别的语言（`zh-CN` / `pt-BR` / `en-US`；认不出的写法会被归一化）
     */
    public static Route resolve(Map<String, String> defaults,
                                Map<String, Map<String, String>> languages,
                                Map<String, Map<String, String>> backends,
                                String lang) {
        Map<String, Map<String, String>> table = languages == null ? java.util.Collections.emptyMap() : languages;
        Map<String, Map<String, String>> known = backends == null ? java.util.Collections.emptyMap() : backends;
        String wanted = InterpreterLang.normalize(lang);

        Map<String, String> entry = null;
        String source = "";
        if (!wanted.isEmpty()) {
            entry = table.get(wanted);
            if (entry != null) source = "languages." + wanted;
        }
        if (entry == null) {
            // 语言认不出（`""` / `ja-JP`）也走 default —— 但理由要如实写"语言认不出"
            entry = defaults;
            source = wanted.isEmpty() ? "default（语言认不出）" : "default（languages 里没有 " + wanted + "）";
        }
        if (entry == null) {
            return new Route("", "", "", source,
                    wanted.isEmpty()
                            ? "路由表里没有 default，并且语言认不出：不知道该用哪个识别后端"
                            : "路由表里没有 " + wanted + " 这一条，也没有 default");
        }

        String backendId = value(entry, "backend");
        String engine = value(entry, "engine");
        String note = value(entry, "note");
        if (backendId.isEmpty()) {
            return new Route("", engine, note, source,
                    "路由表这一条没写 backend（" + source + "）");
        }
        // 后端是否存在 / 是否可用：表里没登记就当作"没实现"，别让它悄悄跑到别处
        Map<String, String> backend = known.get(backendId);
        if (backend == null) {
            return new Route(backendId, engine, note, source,
                    "路由表把 " + (wanted.isEmpty() ? "这门语言" : wanted) + " 指到后端 `" + backendId
                            + "`，但 backends 里没有登记它（写错名字了？）");
        }
        if (!"true".equalsIgnoreCase(value(backend, "available"))) {
            String desc = value(backend, "desc");
            return new Route(backendId, engine, note, source,
                    "路由表把 " + (wanted.isEmpty() ? "这门语言" : wanted) + " 指到 `" + backendId + "`，"
                            + "但这个后端**还没实现**" + (desc.isEmpty() ? "" : "（" + desc + "）"));
        }
        return new Route(backendId, engine, note, source, "");
    }

    /** 一句话摊开整张表（启动日志用）：每门语言 → 后端 / 引擎 / 理由。 */
    public static String describe(Map<String, String> defaults,
                                  Map<String, Map<String, String>> languages,
                                  Map<String, Map<String, String>> backends) {
        StringBuilder text = new StringBuilder();
        java.util.List<String> order = new java.util.ArrayList<>();
        for (String lang : InterpreterLang.ALL) {
            order.add(lang);
        }
        for (String lang : (languages == null ? java.util.Collections.<String>emptySet() : languages.keySet())) {
            if (!order.contains(lang)) order.add(lang);
        }
        for (String lang : order) {
            Route route = resolve(defaults, languages, backends, lang);
            if (text.length() > 0) text.append("；");
            text.append(lang).append("→").append(route.ok() ? route.backendId : "（不可用）");
            if (route.ok() && !route.engine.isEmpty()) text.append("[").append(route.engine).append("]");
        }
        return text.length() == 0 ? "（路由表是空的）" : text.toString();
    }

    /** 表里登记了哪些后端 id（诊断用；顺序保持 JSON 里的顺序不在这里保证）。 */
    public static Set<String> backendIds(Map<String, Map<String, String>> backends) {
        return backends == null ? java.util.Collections.<String>emptySet() : backends.keySet();
    }

    private static String value(Map<String, String> entry, String key) {
        if (entry == null) return "";
        String raw = entry.get(key);
        return raw == null ? "" : raw.trim();
    }
}
