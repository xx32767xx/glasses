package com.leion.lanrelay;

import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 播放房间里别人的实时声音（4.76）。
 *
 * <p>为什么手写：安卓没有"播放一段 PCM"的现成组件，而 {@link AudioTrack} 就是干这个的 ——
 * 平台自带，不违反"零第三方依赖"。
 *
 * <p>几个关键取舍：
 * <ul>
 *   <li><b>流模式</b>（{@code MODE_STREAM}）而不是静态模式：声音是一块一块来的；</li>
 *   <li><b>小块缓冲 + 队列</b>：网络抖动时先攒一点再播（{@link #QUEUE_CHUNKS} 块），
 *       抖完了能追上；攒太多反而延迟大，所以队列满了就丢旧块（宁可丢一小段，也不要越播越晚）；</li>
 *   <li><b>不重采样</b>：发端统一 16 kHz 单声道，这里也按 16 kHz 开；设备不支持时才退到 44.1 k。</li>
 * </ul>
 *
 * <p>⚠️ 回声：说话的人自己不播（客户端不开倾听），否则他会听到自己。
 */
public final class RoomAudioPlayer {

    /** 队列长度：16000Hz × 2 字节 × 1 秒 / 块大小… 这里按"块"算，约 0.5–1 秒的弹性。 */
    private static final int QUEUE_CHUNKS = 32;
    private static final int SAMPLE_RATE = 16000;
    /** 队列里超过这个块数就说明延迟在累积，丢最旧的。 */
    private static final int MAX_BACKLOG = QUEUE_CHUNKS;

    private AudioTrack track;
    private Thread worker;
    private volatile boolean running = false;
    private final ArrayBlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(QUEUE_CHUNKS);
    private volatile long droppedChunks = 0;

    public boolean isRunning() {
        return running;
    }

    /** 实际丢掉了多少块（队列满时）。给界面/调试看"网络是不是跟不上"。 */
    public long droppedChunks() {
        return droppedChunks;
    }

    /** 开始播放。已在播就什么都不做。 */
    public void start() {
        if (running) return;
        int minBuffer = AudioTrack.getMinBufferSize(SAMPLE_RATE,
                AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuffer <= 0) minBuffer = SAMPLE_RATE;      // 兜底，避免 getMinBufferSize 返回错误码
        final int bufferSize = Math.max(minBuffer * 2, SAMPLE_RATE);
        track = new AudioTrack(AudioManager.STREAM_MUSIC, SAMPLE_RATE,
                AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
                bufferSize, AudioTrack.MODE_STREAM);
        if (track.getState() != AudioTrack.STATE_INITIALIZED) {
            track.release();
            track = null;
            running = false;
            return;
        }
        running = true;
        queue.clear();
        track.play();
        worker = new Thread(this::loop, "room-audio-play");
        worker.setDaemon(true);
        worker.start();
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
            track.release();
            track = null;
        }
        queue.clear();
    }

    /** 收到一块音频（WS 二进制帧）。队列满了丢最旧的：延迟比丢一点声音更难受。 */
    public void offer(byte[] chunk) {
        if (!running || chunk == null || chunk.length == 0) return;
        while (queue.size() >= MAX_BACKLOG && queue.poll() != null) {
            droppedChunks += 1;
        }
        if (!queue.offer(chunk)) droppedChunks += 1;
    }

    private void loop() {
        while (running) {
            try {
                byte[] chunk = queue.poll(250, TimeUnit.MILLISECONDS);
                if (chunk == null) continue;
                if (track == null) break;
                track.write(chunk, 0, chunk.length);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception error) {
                // 播放失败就停，别在后台无限报错
                break;
            }
        }
    }
}
