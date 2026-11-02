package com.leion.lanrelay;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * AsrRouter —— **按语言挑识别后端**（5.32）。
 * ============================================================================
 * 架构（用户 2026-11 定）：识别不再"一个 App 一个引擎"，而是**一门语言配一个引擎**。
 * 理由很实际：不同语种在不同引擎上的表现差得远（中文本地 whisper 很稳，
 * 巴葡在云端可能更好），而把语种绑死在一个引擎上就等于放弃这种选择权。
 *
 * <p>这一层只做一件事：**给定语言，返回该用哪个后端；给不出就说清原因**。
 * 它不碰网络、不碰线程、不碰 Android —— 所以能被直接编译执行（见 tests/java/AsrRouterCheck.java），
 * "哪门语言分给了谁"这种规则靠看代码守不住。
 *
 * 挑选顺序（每一档都记录原因，日志里能一眼看出"这句为什么用这个引擎"）：
 * <ol>
 *   <li><b>精确/主语言匹配</b>：后端声明支持 `zh-CN`（或 `zh`）就接这门语言；</li>
 *   <li><b>通用后端</b>（`languages()` 为空的，例如"自己会判定语种"的那种）—— 只在没有语言匹配时兜底；</li>
 *   <li><b>语言未知</b>（`""` / `auto`）：也交给通用后端；没有通用后端就**如实失败**；</li>
 *   <li>都没有 → **失败**，带一条人话原因（绝不"用别的语言硬顶"：那会把中文音频塞给葡语模型，
 *       结果是一整段乱码，比没有识别更难查）。</li>
 * </ol>
 *
 * <p>同档多个候选时按**注册顺序取第一个**（先注册者优先）—— 顺序由调用方
 * （`InterpreterActivity` / 房间）显式决定，并且 `describe()` 会把它摊开，不靠"碰巧"。
 */
public final class AsrRouter {

    /** 路由结果：拿到后端 + 一句"为什么是它"（日志与状态行都用这句）。 */
    public static final class Resolution {
        public final InterpreterAsrBackend backend;
        public final String reason;
        /** 真正的失败原因（`backend == null` 时才有意义，给人看）。 */
        public final String problem;

        private Resolution(InterpreterAsrBackend backend, String reason, String problem) {
            this.backend = backend;
            this.reason = reason;
            this.problem = problem;
        }

        public boolean ok() {
            return backend != null;
        }
    }

    /** 语言 → 后端（保持注册顺序，便于"先注册者优先"与 describe 输出稳定）。 */
    private final Map<String, InterpreterAsrBackend> registered = new LinkedHashMap<>();

    /**
     * 注册一个后端。
     *
     * @param id 给日志/诊断看的短名字（例如 `local-zh` / `cloud-pt`）
     */
    public synchronized void register(String id, InterpreterAsrBackend backend) {
        if (id == null || id.isEmpty() || backend == null) return;
        registered.put(id, backend);
    }

    /** 现在注册了几个（诊断用）。 */
    public synchronized int size() {
        return registered.size();
    }

    /**
     * 按语言挑后端。
     *
     * @param lang 这一场要识别的语言（`zh-CN` / `pt-BR` / `""` 表示未知）
     */
    public synchronized Resolution resolve(String lang) {
        String wanted = InterpreterAsrBackend.normalizeLang(lang);

        // ① 语言明确：先找声明支持它的专用后端
        if (!wanted.isEmpty() && !"auto".equals(wanted)) {
            for (Map.Entry<String, InterpreterAsrBackend> entry : registered.entrySet()) {
                InterpreterAsrBackend backend = entry.getValue();
                if (backend.isUniversal()) continue;      // 通用后端留到第 ② 档
                if (backend.supports(wanted)) {
                    return new Resolution(backend,
                            "按语言匹配：" + idOf(entry) + " 支持 " + wanted, "");
                }
            }
            // ② 没有专用后端 → 通用后端兜底
            for (Map.Entry<String, InterpreterAsrBackend> entry : registered.entrySet()) {
                if (entry.getValue().isUniversal()) {
                    return new Resolution(entry.getValue(),
                            "没有专用于 " + wanted + " 的引擎，交给通用后端：" + idOf(entry), "");
                }
            }
            return new Resolution(null, "",
                    "没有能识别 " + lang + " 的引擎（已注册 " + registered.size() + " 个，都不支持这门语言）");
        }

        // ③ 语言未知：同样走通用后端（它自己会判定）；专用后端不该硬猜
        for (Map.Entry<String, InterpreterAsrBackend> entry : registered.entrySet()) {
            if (entry.getValue().isUniversal()) {
                return new Resolution(entry.getValue(),
                        "语言未知，交给通用后端自行判定：" + idOf(entry), "");
            }
        }
        return new Resolution(null, "", "语言未知，且没有能自行判定语种的引擎");
    }

    /** 一句话摊开"谁支持什么"（启动日志与诊断用）。 */
    public synchronized String describe() {
        if (registered.isEmpty()) return "（没有注册任何识别后端）";
        List<String> parts = new ArrayList<>();
        for (Map.Entry<String, InterpreterAsrBackend> entry : registered.entrySet()) {
            InterpreterAsrBackend backend = entry.getValue();
            String langs = backend.isUniversal()
                    ? "通用（自判语种）"
                    : String.join("/", backend.languages());
            parts.add(idOf(entry) + "=" + backend.label() + "[" + langs + "]"
                    + (backend.requiresNetwork() ? "·需外网" : ""));
        }
        return String.join("；", parts);
    }

    /** 清空（测试/切换架构时用；运行期不该调）。 */
    synchronized void clear() {
        registered.clear();
    }

    private static String idOf(Map.Entry<String, InterpreterAsrBackend> entry) {
        return entry.getKey();
    }
}
