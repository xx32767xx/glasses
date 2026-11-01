package com.leion.lanrelay;

import java.util.ArrayList;
import java.util.List;

/**
 * TtsChunker —— 把一句译文切成**适合逐段合成**的小块（5.30）。
 * ============================================================================
 * 为什么需要切：TTS 是**整段** API，不是流式输出。一句 60 个字一次性合成，
 * 就要等整段音频生成完才开始播；切成 2~3 块，第一块合成好就可以开口，
 * 剩下的边播边合成。用户听到的"第一声"因此早 0.5~1 秒。
 *
 * 规则（照抄交接包 `src/features/interpreter/core/ttsText.js` 的实测参数）：
 * <ul>
 *   <li>先按句末标点切（。！？!?；;），太长的句子再按逗号/顿号切；</li>
 *   <li>中文上限 80 字、其他语言 100 字（超了就切，别让一段音频太长）；</li>
 *   <li>太短的碎片与前一块合并（中文 < 6 字、其他 < 14 字）——
 *       为一个"好"字单独发一次合成请求，纯亏；</li>
 *   <li>硬上限 8 块：再长的段落也不能变成 20 次合成调用。</li>
 * </ul>
 *
 * <p>纯函数、不碰 Android API —— 所以它能被 `tests/java/TtsChunkerCheck.java`
 * 直接跑（那是本仓库第一个**可执行**的 Java 测试）。
 */
public final class TtsChunker {

    /** 硬上限：一段话最多合成几次（等比变大之后，合成次数比字数更贵）。 */
    public static final int MAX_CHUNKS = 8;
    public static final int MAX_CHARS_CJK = 80;
    public static final int MAX_CHARS_OTHER = 100;
    public static final int MIN_CHARS_CJK = 6;
    public static final int MIN_CHARS_OTHER = 14;

    private TtsChunker() {
    }

    /** 粗判"是不是中文类语言"：中文按字算，西文按词算，阈值不同。 */
    static boolean isCjk(String text, String lang) {
        if (lang != null && lang.toLowerCase(java.util.Locale.ROOT).startsWith("zh")) return true;
        String value = text == null ? "" : text;
        for (int i = 0; i < value.length(); i += 1) {
            char c = value.charAt(i);
            if (c >= '\u4e00' && c <= '\u9fff') return true;
        }
        return false;
    }

    /**
     * 切块。
     *
     * @param text 译文（可以为 null / 空白 → 返回空列表）
     * @param lang 目标语言（`zh-CN` / `pt-BR` / `en-US`），决定中文阈值
     * @return 按顺序的若干块，每块都已 trim 且非空
     */
    public static List<String> split(String text, String lang) {
        List<String> out = new ArrayList<>();
        String clean = text == null ? "" : text.replaceAll("\\s+", " ").trim();
        if (clean.isEmpty()) return out;

        boolean cjk = isCjk(clean, lang);
        int maxChars = cjk ? MAX_CHARS_CJK : MAX_CHARS_OTHER;
        int minChars = cjk ? MIN_CHARS_CJK : MIN_CHARS_OTHER;

        // ① 先按句末标点切
        List<String> sentences = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        for (int i = 0; i < clean.length(); i += 1) {
            char c = clean.charAt(i);
            current.append(c);
            if (isSentenceEnd(c) || isLatinPeriod(clean, i)) {
                sentences.add(current.toString().trim());
                current.setLength(0);
            }
        }
        if (current.toString().trim().length() > 0) sentences.add(current.toString().trim());

        // ② 太长的一句再按逗号/顿号切，然后按 maxChars 装箱
        List<String> parts = new ArrayList<>();
        for (String sentence : sentences) {
            if (sentence.isEmpty()) continue;
            if (sentence.length() <= maxChars) {
                parts.add(sentence);
                continue;
            }
            StringBuilder buffer = new StringBuilder();
            for (String piece : splitOnComma(sentence)) {
                String next = piece.trim();
                if (next.isEmpty()) continue;
                if (buffer.length() > 0 && buffer.length() + next.length() > maxChars) {
                    parts.add(buffer.toString().trim());
                    buffer.setLength(0);
                }
                buffer.append(next);
            }
            if (buffer.toString().trim().length() > 0) parts.add(buffer.toString().trim());
        }

        // ③ 太短的碎片并进前一块（不然一个"好"字也要一次合成往返）
        List<String> merged = new ArrayList<>();
        for (String part : parts) {
            if (!merged.isEmpty() && merged.get(merged.size() - 1).length() < minChars) {
                merged.set(merged.size() - 1, merged.get(merged.size() - 1) + part);
            } else {
                merged.add(part);
            }
        }

        // ④ 硬上限：超了就把尾巴并进最后一块
        while (merged.size() > MAX_CHUNKS) {
            String tail = merged.remove(merged.size() - 1);
            merged.set(merged.size() - 1, merged.get(merged.size() - 1) + tail);
        }

        for (String item : merged) {
            String value = item.trim();
            if (!value.isEmpty()) out.add(value);
        }
        return out;
    }

    private static boolean isSentenceEnd(char c) {
        return c == '\u3002' || c == '\uff01' || c == '\uff1f' || c == '!' || c == '?'
                || c == '\uff1b' || c == ';' || c == '\n';
    }

    /**
     * 半角句点算不算句末（5.30 加的，交接包里那条正则**没有**处理 `.`）。
     *
     * <p>为什么必须加：我们支持葡语/英语，而西文句子就是以 `.` 结尾的。
     * 不认 `.`，一段西文只能靠"超过 100 字"才被切开，第一声会晚很多。
     *
     * <p>为什么不无脑认：`3.5`、`v1.2`、`Dr. Silva` 里的点不是句末。
     * 判据用两条简单规则（不做 NLP）：
     * <ul>
     *   <li>点后面紧跟的是**数字** → 不是句末（小数/版本号）；</li>
     *   <li>点前面是**单个大写字母**（`A.` / 缩写）→ 不是句末。</li>
     * </ul>
     */
    private static boolean isLatinPeriod(String text, int index) {
        if (text.charAt(index) != '.') return false;
        int next = index + 1;
        while (next < text.length() && text.charAt(next) == ' ') next += 1;
        if (next < text.length() && Character.isDigit(text.charAt(next))) return false;
        int prev = index - 1;
        if (prev >= 0 && Character.isUpperCase(text.charAt(prev))
                && (prev == 0 || !Character.isLetter(text.charAt(prev - 1)))) {
            return false;
        }
        return true;
    }

    private static List<String> splitOnComma(String sentence) {
        List<String> pieces = new ArrayList<>();
        StringBuilder buffer = new StringBuilder();
        for (int i = 0; i < sentence.length(); i += 1) {
            char c = sentence.charAt(i);
            buffer.append(c);
            if (c == '\uff0c' || c == ',' || c == '\u3001' || c == '\uff1a' || c == ':') {
                pieces.add(buffer.toString());
                buffer.setLength(0);
            }
        }
        if (buffer.length() > 0) pieces.add(buffer.toString());
        return pieces;
    }
}
