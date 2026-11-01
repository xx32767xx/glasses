package com.leion.lanrelay;

import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * ScriptedAsrBackend —— **演示回放**用的假后端（5.31）。
 * ============================================================================
 * 它不是给用户用的功能，而是给"现在还没接 ASR"这段时间用的**验证工具**：
 *
 * <ul>
 *   <li>界面、字幕流、状态行、播报（TTS）、历史写入可以**端到端验**，不需要云端 Key、
 *       不需要那台跑 whisper 的服务器、不需要眼镜；</li>
 *   <li>节奏是**照真实会议调的**（partial 每 ~400ms 长一截、整句 ~2 秒定稿），
 *       所以"积压丢弃/过期不播/朗读时暂停原声"这些策略能在这里被真正压到；</li>
 *   <li>它**忽略送进来的 PCM**（不假装识别）：界面上明写「演示回放」，
 *       任何截图都不会被误当成"识别功能已经做好了"。</li>
 * </ul>
 *
 * <p>同一个剧本，中/葡/英三套，每套 6 句。剧本写在这里而不是资源里：
 * 它是**测试数据**，不是文案。
 */
public final class ScriptedAsrBackend implements InterpreterAsrBackend {

    private static final String TAG = "LeionAsrScript";
    /** 每句 partial 的推进间隔。 */
    private static final long PARTIAL_STEP_MS = 400;
    /** 一句说完到定稿的停顿。 */
    private static final long FINAL_GAP_MS = 900;

    private final String lang;
    private volatile boolean running = false;
    private Thread worker;
    private Listener listener;

    /**
     * @param lang 剧本用哪种语言（`zh-CN` / `pt-BR` / `en-US`）
     */
    public ScriptedAsrBackend(String lang) {
        this.lang = lang == null || lang.isEmpty() ? "zh-CN" : lang;
    }

    @Override
    public String label() {
        return "演示回放";
    }

    @Override
    public boolean requiresNetwork() {
        return false;
    }

    @Override
    public void start(Listener target) {
        if (running) return;
        this.listener = target;
        running = true;
        worker = new Thread(this::runScript, "asr-script");
        worker.setDaemon(true);
        worker.start();
    }

    @Override
    public void sendAudio(byte[] pcm, int sampleRate) {
        // 刻意什么都不做：这个后端不"识别"，只是按剧本出字
    }

    @Override
    public void stop() {
        running = false;
        Thread current = worker;
        worker = null;
        if (current != null) current.interrupt();
    }

    // ── 剧本 ──────────────────────────────────────────────────────────────

    private void runScript() {
        Listener target = listener;
        if (target == null) return;
        target.onReady();
        List<String> lines = scriptFor(lang);
        try {
            Thread.sleep(600);          // 假装"后端刚起来"
            for (int index = 0; index < lines.size(); index += 1) {
                if (!running) return;
                String sentence = lines.get(index);
                String id = "s" + (index + 1);
                // ① 逐段长出 partial（让界面真的走一次"原位更新同一张卡"）
                int step = Math.max(2, sentence.length() / 4);
                for (int cut = step; cut < sentence.length(); cut += step) {
                    if (!running) return;
                    Thread.sleep(PARTIAL_STEP_MS);
                    target.onPartial(id, sentence.substring(0, cut), lang);
                }
                // ② 定稿
                Thread.sleep(FINAL_GAP_MS);
                if (!running) return;
                target.onFinal(id, sentence, lang);
                Log.i(TAG, "🎬 回放定稿：" + sentence);
                Thread.sleep(700);      // 句间停顿
            }
            if (!running) return;
            // ③ 演完一行提示，别让人以为"卡住了"
            target.onFinal("s-end", "", lang);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    /** 三套剧本：内容取自我们验证句集里真实用过的句子（中葡对照是实测材料）。 */
    static List<String> scriptFor(String lang) {
        List<String> lines = new ArrayList<>();
        String code = lang == null ? "zh-CN" : lang.toLowerCase(java.util.Locale.ROOT);
        if (code.startsWith("pt")) {
            lines.add("Bom dia! A nossa reunião de hoje passou para as três da tarde.");
            lines.add("Vamos revisar o relatório de vendas do trimestre passado.");
            lines.add("Precisamos confirmar a data de entrega com o fornecedor.");
            lines.add("O orçamento aprovado cobre apenas a primeira fase do projeto.");
            lines.add("Por favor, envie os documentos até sexta-feira.");
            lines.add("Obrigado a todos pela participação na reunião de hoje.");
        } else if (code.startsWith("en")) {
            lines.add("Good morning! Today's meeting has been moved to three in the afternoon.");
            lines.add("Let's go through last quarter's sales report.");
            lines.add("We need to confirm the delivery date with the supplier.");
            lines.add("The approved budget only covers the first phase of the project.");
            lines.add("Please send the documents by Friday.");
            lines.add("Thank you all for joining today's meeting.");
        } else {
            lines.add("早上好！我们今天的会议改到了下午三点。");
            lines.add("我们先过一遍上个季度的销售报告。");
            lines.add("需要和供应商确认一下交付日期。");
            lines.add("批准的预算只覆盖项目的第一阶段。");
            lines.add("请在周五之前把文档发过来。");
            lines.add("感谢大家参加今天的会议。");
        }
        return lines;
    }
}
