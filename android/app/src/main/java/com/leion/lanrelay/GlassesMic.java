package com.leion.lanrelay;

import android.content.Context;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import com.llvision.glxss.common.service.GlassServiceManager;
import com.llvision.glxss.common.service.audio.GlassAudioService;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * GlassesMic —— 从**眼镜的麦克风**取音并分块上传给电脑
 * ============================================================================
 *
 * <p><b>为什么要从手机挪到眼镜</b>：手机揣在兜里或放在桌上时，录到的是环境噪声，
 * 说话人离手机可能一两米；而眼镜戴在说话人脸上，离嘴只有十几厘米 ——
 * 信噪比完全不是一个量级。识别准确率对信噪比极其敏感（见 {@code docs/04}），
 * 所以同样的模型、同样的网络，换成眼镜取音就能明显好一截。
 *
 * <p><b>眼镜的麦克风在系统里是 USB 音频输入设备</b>（SDK 里有
 * {@code UsbAudioInputDevicePolicy} 专门判断 {@code TYPE_USB_DEVICE} /
 * {@code TYPE_USB_HEADSET}）。所以它**只在眼镜连着的时候存在**，
 * 拔掉就没有了 —— 调用方要先确认眼镜已连接。
 *
 * <p><b>采样率是 44.1 kHz，不是 16 kHz</b>（{@code GlassAudioService.AUDIO_SAMPLE_RATE}）。
 * 这一点很关键，但**下游早就准备好了**：
 * <ul>
 *   <li>转发进程的 {@code ALLOWED_RATES} 里本来就有 44100；</li>
 *   <li>{@code bridge/whisper_stream.py} 会按 {@code audio-in.rate} 旁文件重采样到 16 kHz，
 *       而且是**跨块保持相位连续**的（避免块接缝处出现咔哒声）。</li>
 * </ul>
 * 所以我们只负责"如实上报真实采样率"——**猜错采样率会让识别全是乱码**，
 * 而这件事手机侧完全有责任说清楚。
 *
 * <p><b>为什么用直接类型调用而不是像 {@link GlassesSdk} 那样反射</b>：
 * 反射是当初"没法编译、只能靠猜签名"时的权宜之计，代价是四处签名错误、
 * 赔了四轮真机往返（见 {@code docs/09} 第 3 节）。现在编译环境是通的，
 * AAR 也在编译期依赖里，直接调用能让**编译器**替我们验签名 —— 这是严格更安全的做法。
 *
 * <p><b>线程模型（重要）</b>：{@code onAudioData} 是在 SDK 的**音频回调线程**上来的。
 * 在那里做 HTTP 上传会把采集卡住（录到的音频会成段丢失），所以：
 * <pre>
 *   音频线程：只做「攒够 1 秒 → 丢进有界队列」（纯内存操作，微秒级）
 *   上传线程：从队列取块 → 阻塞式 POST
 * </pre>
 * 队列**有界**（{@link #MAX_QUEUED_CHUNKS} 秒）：网络卡住时丢弃最旧的块并计数，
 * 而不是无限堆积内存、也不是把音频线程堵死。丢了多少会如实报到界面上。
 */
public class GlassesMic implements AudioSource {

    private static final String TAG = "GlassesMic";

    /** 攒够多久上传一次。与手机麦克风那条路保持一致（1 秒）。 */
    private static final int CHUNK_MS = 1000;

    /** 队列上限（秒）。超过就丢最旧的 —— 宁可丢音频，也不能把音频线程堵死。 */
    private static final int MAX_QUEUED_CHUNKS = 8;

    /** 电平上报的间隔（毫秒）。与手机那条路一致：约 100ms 一次。 */
    private static final int LEVEL_MS = 100;

    /** 拿不到 binder 时，等一会儿再试一次（服务可能正在启动）。 */
    private static final long BIND_RETRY_MS = 500;

    private final Context context;
    private final LanClient client;
    /** 复用手机那条路的回调接口：界面不必为两个音源各写一套。 */
    private final MicUploader.Listener listener;

    private GlassAudioService service;
    private GlassAudioService.GlassAudioConsumer consumer;

    private volatile boolean running = false;
    private volatile String language = "pt-BR";
    private int sampleRate = GlassAudioService.AUDIO_SAMPLE_RATE;
    private int bytesPerChunk = GlassAudioService.AUDIO_SAMPLE_RATE * 2 * CHUNK_MS / 1000;

    private final ArrayBlockingQueue<byte[]> queue =
            new ArrayBlockingQueue<>(MAX_QUEUED_CHUNKS);
    private Thread uploadThread;

    /** 攒块的缓冲区。只被音频线程碰，不需要同步。 */
    private byte[] pending;
    private int pendingLength = 0;
    /** 电平统计的采样计数（音频线程私有）。 */
    private int levelBytes = 0;
    private long droppedChunks = 0;
    private long uploadedBytes = 0;
    private boolean firstChunk = true;

    public GlassesMic(Context context, LanClient client, MicUploader.Listener listener) {
        this.context = context.getApplicationContext();
        this.client = client;
        this.listener = listener;
    }

    public boolean isRunning() {
        return running;
    }

    @Override
    public String name() {
        return "眼镜麦克风";
    }

    /** 实际用上的采样率（眼镜一般是 44100）。 */
    @Override
    public int getSampleRate() {
        return sampleRate;
    }

    /** 当前在听哪种语言。录音中调用安全：下一块音频就带上新语种。 */
    @Override
    public void setLanguage(String lang) {
        if (lang != null && !lang.isEmpty()) this.language = lang;
    }

    /**
     * 开始从眼镜取音并上传。
     *
     * @return null 表示成功；否则是一条人类可读的失败原因
     */
    @Override
    public String start() {
        if (running) return null;
        String failure = attach();
        if (failure != null) return failure;

        running = true;
        firstChunk = true;
        droppedChunks = 0;
        uploadedBytes = 0;
        queue.clear();

        uploadThread = new Thread(this::uploadLoop, "glasses-mic-upload");
        uploadThread.setDaemon(true);
        uploadThread.start();

        try {
            service.startAudioRecord();
        } catch (Throwable error) {
            running = false;
            detach();
            return "启动眼镜录音失败：" + describe(error);
        }

        if (sampleRate != 16000) {
            listener.onUploadStatus("从眼镜取音：" + sampleRate
                    + " Hz（电脑侧会自动重采样到 16 kHz）");
        }
        Log.i(TAG, "开始从眼镜取音 @" + sampleRate + " Hz");
        return null;
    }

    /**
     * 接上音频服务并注册消费者。
     *
     * @return null = 成功
     */
    private String attach() {
        IBinder binder = GlassServiceManager.getBinder(GlassServiceManager.GLASS_AUDIO_SERVICE);
        if (binder == null) {
            // 服务可能还没起来（SDK 的 initAllServices 有 3 秒延迟）。
            // 主动起一次是安全的：起过的服务再 start 不会重复创建。
            try {
                GlassServiceManager.startGlassAudioService(context);
            } catch (Throwable error) {
                Log.w(TAG, "startGlassAudioService 失败", error);
            }
            sleep(BIND_RETRY_MS);
            binder = GlassServiceManager.getBinder(GlassServiceManager.GLASS_AUDIO_SERVICE);
        }
        if (binder == null) {
            return "拿不到眼镜音频服务的 binder（眼镜没连上？或 SDK 还没初始化完）";
        }
        if (!(binder instanceof GlassAudioService.Binder)) {
            // 类型不符说明 SDK 版本变了 —— 如实报出来，别硬转
            return "音频服务的 binder 类型不对：" + binder.getClass().getName();
        }
        service = ((GlassAudioService.Binder) binder).getService();
        if (service == null) return "音频服务拿到了但 getService() 返回 null";

        // 采样率以**服务实际用的**为准，常量只是兜底。
        // 上报错的采样率会让识别全是乱码，所以这里宁可多问一次。
        try {
            int actual = service.getSampleRate();
            if (actual > 0) sampleRate = actual;
        } catch (Throwable error) {
            Log.i(TAG, "getSampleRate 失败，用常量 " + sampleRate, error);
        }
        sampleRate = nearestAllowedRate(sampleRate);
        bytesPerChunk = Math.max(2, sampleRate * 2 * CHUNK_MS / 1000);
        pending = new byte[bytesPerChunk];

        consumer = new GlassAudioService.GlassAudioConsumer() {
            @Override
            public void onStartAudioRecord(int rate, boolean arg1, int arg2) {
                // 真实采样率在这里也能拿到，再确认一次
                if (rate > 0 && rate != sampleRate) {
                    Log.i(TAG, "onStartAudioRecord 报的采样率 " + rate + "，改用这个");
                    sampleRate = rate;
                    bytesPerChunk = Math.max(2, sampleRate * 2 * CHUNK_MS / 1000);
                    pending = new byte[bytesPerChunk];
                    pendingLength = 0;
                }
            }

            @Override
            public void onAudioData(byte[] data, int offset, int length) {
                onPcm(data, offset, length);
            }

            @Override
            public void onStopAudioRecord() {
                Log.i(TAG, "眼镜侧报告录音已停止");
            }
        };

        try {
            service.addAudioConsumer(consumer);
        } catch (Throwable error) {
            consumer = null;
            return "注册音频消费者失败：" + describe(error);
        }
        return null;
    }

    /**
     * 把采样率归到链路允许的三个值之一。
     *
     * <p>转发进程只接受 16000 / 44100 / 48000（{@code ALLOWED_RATES}），
     * 别的值会被 400 拒掉。与其让错误跑到那边才炸，不如这里当场纠正 ——
     * 而且**只有这三个**是有意义的：链路本来就是照它们设计的。
     *
     * <p>为什么是"归到最近的"而不是"不是就报错"：宁可音高稍微不对一点，
     * 也比整条链路收不到音频好；而且会打日志说清改成了什么。
     */
    private static int nearestAllowedRate(int rate) {
        int[] allowed = { 16000, 44100, 48000 };
        int best = allowed[0];
        int bestDiff = Math.abs(rate - best);
        for (int candidate : allowed) {
            int diff = Math.abs(rate - candidate);
            if (diff < bestDiff) {
                best = candidate;
                bestDiff = diff;
            }
        }
        if (best != rate) {
            Log.w(TAG, "服务报的采样率 " + rate + " 不在链路允许列表里，改用 " + best);
        }
        return best;
    }

    private void detach() {        if (service != null && consumer != null) {
            try {
                service.removeAudioConsumer(consumer);
            } catch (Throwable error) {
                Log.i(TAG, "removeAudioConsumer 失败", error);
            }
        }
        consumer = null;
    }

    /**
     * 停止取音。会把最后不足一块的音频也发出去。
     *
     * <p>刻意不 join：这个方法通常是主线程调的，join 会把界面卡住。
     * 上传线程自己会退出（队列取空 + running=false）。
     */
    @Override
    public void stop() {
        boolean wasRunning = running;        running = false;
        // 把尾巴交出去（在音频线程之外调用是安全的：running 已经置 false，
        // 音频线程不会再往 pending 里写 —— 它先检查 running 再写）
        flushPending();

        if (service != null) {
            // 先摘消费者再停录音：顺序反了会在停止过程中还往回调里打
            detach();
            try {
                if (service.isRecord()) service.stopAudioRecord();
            } catch (Throwable error) {
                Log.i(TAG, "stopAudioRecord 失败", error);
            }
        }
        Thread current = uploadThread;
        uploadThread = null;
        if (current != null) current.interrupt();
        if (wasRunning) Log.i(TAG, "已停止从眼镜取音");
    }

    // ── 音频线程：只攒块 + 入队 ─────────────────────────────────────────────

    /* ── 眼镜输入电平（2026-10-25 实测结论）──────────────────────────────
     *
     * 实测：眼镜麦克风的电平偏高 —— 原始录音底噪 RMS 0.043、语音 0.275、峰值顶到 1.0（削波），
     * 识别时末尾会多出一整句幻觉（"請不吝點贊訂閱…"），CER 40%。
     * 把同一段录音**软件降 12 dB** 后：幻觉整句消失、CER 降到 12.6%（比手机还好）。
     *
     * 硬件音量键在手机上已经到头了（再降一档语音只剩 0.014，低于静音闸门 0.02），
     * 所以缺的这 12 dB 在这里补：**上链之前**按样本乘系数（s16 + 饱和）。
     * 前提是"未削波"——削掉的部分软件补不回来，这也是为什么先让硬件别顶到满幅。
     *
     * 档位用 GAIN_DB 表示（负数=衰减）。设置页的滑条下一步接这里（setGainDb 已就绪）。
     */
    private static volatile float gainFactor = 0.2512f;     // 默认 −12 dB
    private static volatile float gainDb = -12f;

    /** 设置衰减量（dB，取值 ≤ 0）。同时更新线性系数。 */
    public static void setGainDb(float db) {
        float clamped = Math.max(-40f, Math.min(0f, db));
        gainDb = clamped;
        gainFactor = (float) Math.pow(10.0, clamped / 20.0);
        Log.i(TAG, "眼镜输入电平设为 " + clamped + " dB（系数 " + gainFactor + "）");
    }

    /** 当前衰减量（dB）。 */
    public static float getGainDb() { return gainDb; }

    /** 就地按系数缩放一段 s16le PCM，带饱和（不产生回绕噪声）。 */
    private static void applyGain(byte[] buffer, int length) {
        float factor = gainFactor;
        if (factor >= 0.999f) return;                       // 0 dB：零开销
        for (int i = 0; i + 1 < length; i += 2) {
            int sample = (short) ((buffer[i] & 0xFF) | (buffer[i + 1] << 8));
            int scaled = Math.round(sample * factor);
            if (scaled > 32767) scaled = 32767;
            else if (scaled < -32768) scaled = -32768;
            buffer[i] = (byte) (scaled & 0xFF);
            buffer[i + 1] = (byte) ((scaled >> 8) & 0xFF);
        }
    }

    private void onPcm(byte[] data, int offset, int length) {        if (!running || data == null || length <= 0) return;
        if (offset < 0 || offset + length > data.length) return;   // 防御：越界就别读了

        reportLevel(data, offset, length);

        int consumed = 0;
        while (consumed < length) {
            int take = Math.min(length - consumed, bytesPerChunk - pendingLength);
            System.arraycopy(data, offset + consumed, pending, pendingLength, take);
            pendingLength += take;
            consumed += take;
            if (pendingLength == bytesPerChunk) enqueue(pending, bytesPerChunk);
        }
    }

    /** 入队（拷贝一份）。队列满时丢**最旧**的块并计数 —— 不阻塞音频线程。 */
    private void enqueue(byte[] source, int length) {
        byte[] copy = new byte[length];
        System.arraycopy(source, 0, copy, 0, length);
        applyGain(copy, length);          // ← 上链之前统一调电平（见 GAIN_* 注释）
        pendingLength = 0;
        if (!queue.offer(copy)) {
            byte[] dropped = queue.poll();
            if (dropped != null) droppedChunks += 1;
            if (!queue.offer(copy)) {
                droppedChunks += 1;      // 极端情况：连丢带塞都没成功
            }
        }
        if (droppedChunks > 0 && droppedChunks % 4 == 0) {
            final long total = droppedChunks;
            post(() -> listener.onUploadStatus("网络跟不上，已丢弃 " + total + " 秒音频"));
        }
    }

    /** 把不足一块的尾巴也交出去。 */
    private void flushPending() {
        if (pendingLength <= 0 || pending == null) return;
        int length = pendingLength;
        pendingLength = 0;
        byte[] copy = new byte[length];
        System.arraycopy(pending, 0, copy, 0, length);
        queue.offer(copy);
    }

    /** 算并上报这一小段的 RMS 与峰值（与 {@link MicUploader} 同一套算法）。 */
    private void reportLevel(byte[] pcm, int offset, int length) {
        levelBytes += length;
        int threshold = Math.max(2, sampleRate * 2 * LEVEL_MS / 1000);
        if (levelBytes < threshold) return;
        levelBytes = 0;

        double sum = 0;
        int peak = 0;
        int count = length / 2;
        if (count <= 0) return;
        for (int index = 0; index < count; index++) {
            int lo = pcm[offset + index * 2] & 0xFF;
            int hi = pcm[offset + index * 2 + 1];
            int sample = (hi << 8) | lo;
            int abs = sample < 0 ? -sample : sample;
            if (abs > peak) peak = abs;
            sum += (double) sample * (double) sample;
        }
        float rms = (float) Math.sqrt(sum / count) / 32768f;
        float peakValue = peak / 32768f;
        post(() -> listener.onLevel(rms, peakValue));
    }

    // ── 上传线程：从队列取块并 POST ────────────────────────────────────────

    private void uploadLoop() {
        long started = System.currentTimeMillis();
        while (running || !queue.isEmpty()) {
            byte[] chunk;
            try {
                chunk = queue.poll(200, TimeUnit.MILLISECONDS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
            if (chunk == null) continue;
            try {
                // fresh：告诉电脑"这是新一段录音的开头"，与手机那条路一致
                client.sendAudio(chunk, sampleRate, firstChunk, language);
                firstChunk = false;
                uploadedBytes += chunk.length;
                final long seconds = uploadedBytes / 2 / Math.max(1, sampleRate);
                final long elapsed = (System.currentTimeMillis() - started) / 1000;
                post(() -> listener.onUploadStatus("眼镜取音上传中：" + seconds + "s 已上传"
                        + "（已录 " + elapsed + "s，采样率 " + sampleRate + " Hz）"));
            } catch (Exception error) {
                running = false;
                final String message = describe(error);
                post(() -> listener.onUploadError("上传音频失败：" + message));
                break;
            }
        }
    }

    // ── 小工具 ─────────────────────────────────────────────────────────────

    private final Handler main = new Handler(Looper.getMainLooper());

    private void post(Runnable action) {
        main.post(action);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static String describe(Throwable error) {
        String message = error == null ? null : error.getMessage();
        if (message == null || message.isEmpty()) {
            return error == null ? "未知错误" : error.getClass().getSimpleName();
        }
        return message;
    }
}
