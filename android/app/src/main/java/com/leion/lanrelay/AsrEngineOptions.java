package com.leion.lanrelay;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 「这一场能用哪些识别引擎」的清单（5.58）。
 *
 * <p>为什么要有这个类，而不是在 Activity 里直接翻 JSON：
 * 选引擎这件事有三条**必须能离线测**的规则，埋在界面代码里就只能靠"点一遍看看"：
 * <ol>
 *   <li>清单里**没有**的东西不能被选中（选了服务器也不认，用户会以为生效了）；</li>
 *   <li>「当前用哪个」与「已保存哪个」不一致时，要能说清用哪个（默认取服务器算出来的那个）；</li>
 *   <li>本地没有/未确认的选项**照样列出来**，但要让人看得见风险 —— 藏起来会变成
 *       "明明报告里说这个模型更好，App 里却找不到"。</li>
 * </ol>
 *
 * <p>纯 Java、不碰 Android：JSON 解析留在 {@link LanClient}（那边本来就有 org.json），
 * 这里只放判据，所以 {@code tests/java/AsrEngineOptionsCheck.java} 能直接跑。
 */
public final class AsrEngineOptions {

    /** 一个可选项：服务器算出来的「引擎 + 模型」组合。 */
    public static final class Option {
        public final String strategy;
        public final String engine;
        public final String model;
        public final String label;
        /** `present` 本地已有 / `missing` 写了路径但不存在 / `unverified` 首次用会下载 */
        public final String available;
        public final String hint;
        public final boolean current;

        public Option(String strategy, String engine, String model, String label,
                      String available, String hint, boolean current) {
            this.strategy = strategy == null ? "" : strategy;
            this.engine = engine == null ? "" : engine;
            this.model = model == null ? "" : model;
            this.label = label == null || label.isEmpty() ? this.model : label;
            this.available = available == null ? "" : available;
            this.hint = hint == null ? "" : hint;
            this.current = current;
        }

        /** 本地确实有（选了就能跑）。只有 `present` 才算。 */
        public boolean ready() {
            return "present".equals(available);
        }

        /** 选了必然失败（服务器上那个路径不存在）。 */
        public boolean broken() {
            return "missing".equals(available);
        }

        /**
         * 要发给服务器的引擎名；`""` = 不指定。
         *
         * <p>whisper 故意**不发**：那是服务器的缺省引擎，发过去只会让侧车多写一个
         * 与表里相同的值，排障时反而看不出"这一项是不是用户选的"。
         */
        public String engineRequest() {
            return isWhisper() ? "" : engine;
        }

        /** 要发给服务器的模型名；`""` = 不指定（按服务器表里那一层）。 */
        public String modelRequest() {
            return model;
        }

        private boolean isWhisper() {
            return engine.isEmpty() || "whisper".equals(engine);
        }
    }

    private final List<Option> options;

    public AsrEngineOptions(List<Option> options) {
        this.options = options == null
                ? Collections.<Option>emptyList()
                : Collections.unmodifiableList(new ArrayList<>(options));
    }

    public static AsrEngineOptions empty() {
        return new AsrEngineOptions(Collections.<Option>emptyList());
    }

    public boolean isEmpty() {
        return options.isEmpty();
    }

    public int size() {
        return options.size();
    }

    public Option at(int index) {
        return index < 0 || index >= options.size() ? null : options.get(index);
    }

    public List<Option> all() {
        return options;
    }

    /** 服务器算出来的"当前"那一项（没有就返回 null）。 */
    public Option current() {
        for (Option option : options) {
            if (option.current) return option;
        }
        return null;
    }

    /**
     * 找「已保存的选择」。
     *
     * <p>⚠️ 找不到**就返回 null**，不要退回第一项 —— 那会让"服务器上把这个策略删了"
     * 变成"悄悄换成另一个模型继续跑"，而 A/B 的结论就假了。
     */
    public Option find(String strategy) {
        if (strategy == null || strategy.isEmpty()) return null;
        for (Option option : options) {
            if (strategy.equals(option.strategy)) return option;
        }
        return null;
    }

    /**
     * 最终用哪一项：
     * 已保存且在清单里 → 用它；否则用服务器算出来的当前项；清单为空 → null（按服务器默认）。
     */
    public Option pick(String savedStrategy) {
        Option saved = find(savedStrategy);
        if (saved != null) return saved;
        return current();
    }

    /** 给界面用的一行摘要（不含本地化文案时才用；正常路径由 Activity 用字符串资源拼）。 */
    public String summary(String savedStrategy) {
        Option picked = pick(savedStrategy);
        return picked == null ? "" : picked.label;
    }
}
