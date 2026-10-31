package com.leion.lanrelay;

import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.util.Log;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 播放房间里别人的实时声音（4.76，4.91 加固）。
 *
 * <p>为什么手写：安卓没有"播放一段 PCM"的现成组件，而 {@link AudioTrack} 就是干这个的 ——
 * 平台自带，不违反"零第三方依赖"。
 *
 * <p>几个关键取舍：
 * <ul>
 *   <li><b>流模式</b>（{@code MODE_STREAM}）而不是静态模式：声音是一块一块来的；</li>
 *   <li><b>小块缓冲 + 队列</b>：网络抖动时先攒一点再播（{@link #QUEUE_CHUNKS} 块），
 *       抖完了能追上；攒太多反而延迟大，所以队列满了就丢旧块（宁可丢一小段，也不要越播越晚）；</li>
 *   <li><b>采样率跟服务端走</b>（4.91）：手机录音可能降级到 44.1 kHz，硬按 16 kHz 放会快放/慢放。
 *       服务端在开关切换与采样率变化时先发一帧 {@code audio-meta{rate}}，这里据此重建 AudioTrack；</li>
 *   <li><b>失败要留痕</b>（4.91）：以前 {@code AudioTrack} 建不起来是**静默**返回的，
 *       症状是"别人说话我什么都听不到"，而 logcat 里一个字都没有 —— 这类问题最难查。
 *       现在用 {@code Log.w("RoomAudio", …)} 记下失败原因与丢弃块数。</li>
 * </ul>
 *
 * <p>⚠️ 回声：说话的人自己不播（客户端不开倾听、服务端也兜底排除持麦者）。
 */
public final class RoomAudioPlayer {

    private static final String TAG = "RoomAudio";

    /** 队列长度：约 0.5–1 秒的弹性。 */
    private static final int QUEUE_CHUNKS = 32;
    /** 服务端没告诉采样率时的默认值（4.76 起的约定）。 */
    private static final int DEFAULT_SAMPLE_RATE = 16000;

    private AudioTrack track;
    private Thread worker;
    private volatile boolean running = false;
    private final ArrayBlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(QUEUE_CHUNKS);
    private volatile long droppedChunks = 0;
    private volatile int sampleRate = DEFAULT_SAMPLE_RATE;
    private volatile String lastError = "";

    public boolean isRunning() {
        return running;
    }

    /** 队列满时丢掉了多少块。播放器"有声音但断断续续"时先看这个数。 */
    public long droppedChunks() {
        return droppedChunks;
    }

    /** 播放器起不来时的那句原因（空串 = 一切正常）。 */
    public String lastError() {
        return lastError;
    }

    public int sampleRate() {
        return sampleRate;
    }

    /**
     * 换采样率（服务端 {@code audio-meta} 来的）。
     *
     * <p>只有**正在播**的时候才需要重建；否则记下来，下次 start() 直接用。
     * 重建时把队列里的旧块倒掉 —— 它们是用旧采样率采的，接着放会"变调"。
     */
    public void setSampleRate(int rate) {
        if (rate <= 0) return;
        if (rate == sampleRate) return;
        sampleRate = rate;
        if (!running) return;
        Log.i(TAG, "采样率变为 " + rate + " Hz，重建播放器");
        restart();
    }

    /** 开始播放。已在播就什么都不做。 */
    public void start() {
        if (running) return;
        int minBuffer = AudioTrack.getMinBufferSize(sampleRate,
                AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuffer <= 0) {
            // getMinBufferSize 会返回错误码（如 -2 表示采样率不支持）：先说清楚，再兜底
            Log.w(TAG, "getMinBufferSize 返回 " + minBuffer + "（采样率 " + sampleRate + "），用兜底缓冲");
            minBuffer = sampleRate;                 // 约 0.5 秒，够用
        }
        final int bufferSize = Math.max(minBuffer * 2, sampleRate);
        try {
            track = new AudioTrack(AudioManager.STREAM_MUSIC, sampleRate,
                    AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    bufferSize, AudioTrack.MODE_STREAM);
        } catch (Exception error) {
            lastError = "AudioTrack 创建失败：" + error;
            Log.w(TAG, lastError);
            track = null;
            running = false;
            return;
        }
        if (track.getState() != AudioTrack.STATE_INITIALIZED) {
            lastError = "AudioTrack 未初始化（可能是这个采样率 " + sampleRate + " 不被支持）";
            Log.w(TAG, lastError);
            try {
                track.release();
            } catch (Exception ignored) {
                // 已经坏了
            }
            track = null;
            running = false;
            return;
        }
        lastError = "";
        running = true;
        queue.clear();
        try {
            track.play();
        } catch (Exception error) {
            lastError = "AudioTrack.play() 失败：" + error;
            Log.w(TAG, lastError);
            running = false;
            try {
                track.release();
            } catch (Exception ignored) {
                // 已经坏了
            }
            track = null;
            return;
        }
        Log.i(TAG, "开始播放（" + sampleRate + " Hz 单声道 16bit）");
        worker = new Thread(this::loop, "room-audio-play");
        worker.setDaemon(true);
        worker.start();
    }

    /** 停一会儿再按当前（可能变了的）采样率重开 —— 采样率变了才用得上。 */
    private void restart() {
        stop();
        start();
    }

    /** 停止并释放。可以反复 start/stop。 */
    public void stop() {
        running = false;
        if (worker != null) {
            worker.interrupt();
            worker = null;
        }
        if (track != null) {
            try {
                track.pause();
                track.flush();
            } catch (Exception ignored) {
                // 已经坏了
            }
            try {
                track.release();
            } catch (Exception ignored) {
                // 已经坏了
            }
            track = null;
        }
        queue.clear();
        if (droppedChunks > 0) {
            Log.i(TAG, "本次共丢弃 " + droppedChunks + " 块（队列满：网络跟不上或播放被卡住）");
            droppedChunks = 0;
        }
    }

    /** 收到一块音频（WS 二进制帧）。队列满了丢最旧的：延迟比丢一点声音更难受。 */
    public void offer(byte[] chunk) {
        if (!running || chunk == null || chunk.length == 0) return;
        while (queue.size() >= QUEUE_CHUNKS && queue.poll() != null) {
            droppedChunks += 1;
        }
        if (!queue.offer(chunk)) droppedChunks += 1;
    }

    private void loop() {
        int consecutiveErrors = 0;
        while (running) {
            try {
                byte[] chunk = queue.poll(250, TimeUnit.MILLISECONDS);
                if (chunk == null) continue;
                AudioTrack target = track;
                if (target == null) break;
                target.write(chunk, 0, chunk.length);
                consecutiveErrors = 0;
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception error) {
                // 播放失败就停，别在后台无限报错；但**要留一行**，否则"没声音"没有任何线索。
                consecutiveErrors += 1;
                lastError = "写入失败（第 " + consecutiveErrors + " 次）：" + error;
                Log.w(TAG, lastError);
                break;
            }
        }
    }
}
