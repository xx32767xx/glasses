package com.leion.lanrelay;

import android.util.Log;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * TtsQueue —— 播报队列（5.30）。
 * ============================================================================
 * 播报不是"来一句念一句"那么简单。会议里会同时出现三种情况，每一条都要有明确处理：
 *
 * ① **攒起来了**：网络抖动或对面说得快，队列涨到十几句。逐句念会让译文落后半分钟。
 *    → 超过 {@link #MAX_PENDING} 句就**丢最旧的**（用户宁可漏一句，也不要听 30 秒前的话）。
 * ② **已经过时了**：某句译文排到队尾时已经过去 12 秒。
 *    → 超过 {@link #MAX_AGE_MS} 就**不念了**（念一句 12 秒前的话，比不念更糟）。
 * ③ **被要求闭嘴**：用户关掉开关、离开房间、开始说话。
 *    → {@link #stop()} 立刻清空并打断当前朗读，且用一个**代次**（generation）作废在途任务，
 *      否则"已经关掉了却还在念最后一句"。
 *
 * <p>这三条不是我想出来的，是交接包里已经踩过的（`TTS_MAX_PENDING=3` / `TTS_MAX_AGE_MS=12000`）。
 * 抄的是**判断**，不是代码。
 *
 * <p>线程模型：一个后台线程负责合成+播放（`TtsSpeaker.speak` 是阻塞的），
 * 队列本身只做"进/出/作废"，都在本类内部加锁。
 */
public final class TtsQueue {

    /** 队列里最多留几句；超了丢最旧的。 */
    public static final int MAX_PENDING = 3;
    /** 译文超过这么久还没轮到，就不念了。 */
    public static final long MAX_AGE_MS = 12_000L;

    /** 播报状态的回调（界面上那行"正在朗读"靠它）。 */
    public interface Listener {
        /** @param text 正在念的那一小块（已切块），null = 空闲 */
        void onSpeaking(String text, boolean speaking);

        /** 播报失败/被拒绝（人话，直接显示）。 */
        void onProblem(String message);
    }

    private static final String TAG = "LeionTts";

    private final TtsSpeaker speaker;
    private final Deque<Item> pending = new ArrayDeque<>();
    private volatile Listener listener;
    private volatile boolean enabled;
    /** 代次：`stop()` 时 +1，在途任务发现代次变了就闭嘴。 */
    private volatile int generation = 0;
    private Thread worker;

    private static final class Item {
        final String text;
        final String lang;
        final long at;

        Item(String text, String lang, long at) {
            this.text = text;
            this.lang = lang;
            this.at = at;
        }
    }

    public TtsQueue(TtsSpeaker speaker) {
        this.speaker = speaker;
    }

    public void setListener(Listener value) {
        this.listener = value;
    }

    /** 开关（设置页那颗「朗读译文」）。关掉会立刻清空并停止。 */
    public void setEnabled(boolean value) {
        this.enabled = value;
        if (!value) stop();
    }

    public boolean isEnabled() {
        return enabled;
    }

    /** 当前排队几句（状态行/诊断用）。 */
    public synchronized int pendingCount() {
        return pending.size();
    }

    /**
     * 来了一句**定稿译文**，排进队。
     *
     * <p>只该在"这句话是给我读的那一版译文"时调用 —— 增量帧不念（半句话念出来很怪），
     * 原文帧也不念（那是源语言，读它的人不需要听）。
     */
    public void offer(String text, String lang) {
        if (!enabled) return;
        String value = text == null ? "" : text.trim();
        if (value.isEmpty()) return;
        synchronized (this) {
            // ① 积压：丢最旧的，别让译文越落越远
            while (pending.size() >= MAX_PENDING) {
                Item dropped = pending.pollFirst();
                if (dropped != null) {
                    Log.i(TAG, "🔈 队列积压，丢掉最旧的一句：" + shorten(dropped.text));
                }
            }
            pending.addLast(new Item(value, lang, System.currentTimeMillis()));
        }
        ensureWorker();
    }

    /** 立刻停止并清空（关开关、离开房间、开始说话、播报出错时都调）。 */
    public void stop() {
        generation += 1;
        synchronized (this) {
            pending.clear();
        }
        if (speaker != null) speaker.stop();
        Listener current = listener;
        if (current != null) current.onSpeaking(null, false);
    }

    /** 彻底关掉（离开页面）：停 + 释放引擎 + 结束线程。 */
    public void shutdown() {
        stop();
        Thread current = worker;
        worker = null;
        if (current != null) current.interrupt();
        if (speaker != null) speaker.shutdown();
    }

    private void ensureWorker() {
        synchronized (this) {
            if (worker != null && worker.isAlive()) return;
            worker = new Thread(this::runLoop, "tts-queue");
            worker.setDaemon(true);
            worker.start();
        }
    }

    private void runLoop() {
        while (true) {
            Item item;
            int recordedGeneration;
            synchronized (this) {
                item = pending.pollFirst();
                recordedGeneration = generation;
                if (item == null) {
                    worker = null;
                    return;
                }
            }
            if (!enabled || recordedGeneration != generation) continue;
            // ② 过时的译文不念
            long age = System.currentTimeMillis() - item.at;
            if (age > MAX_AGE_MS) {
                Log.i(TAG, "🔈 这句译文已经等了 " + (age / 1000) + " 秒，不再朗读：" + shorten(item.text));
                continue;
            }
            Listener current = listener;
            if (current != null) current.onSpeaking(item.text, true);
            TtsSpeaker.Result result = speaker == null
                    ? new TtsSpeaker.Result(false, "播报未初始化", 0)
                    : speaker.speak(item.text, item.lang);
            if (generation != recordedGeneration || !enabled) {
                // 播的过程中被关掉了：状态复位完就走
                if (current != null) current.onSpeaking(null, false);
                continue;
            }
            if (!result.ok) {
                Log.w(TAG, "🔈 播报失败：" + result.error);
                if (current != null) current.onProblem(result.error);
            }
            if (current != null) current.onSpeaking(null, false);
        }
    }

    private static String shorten(String text) {
        String value = text == null ? "" : text;
        return value.length() <= 24 ? value : value.substring(0, 24) + "…";
    }
}
