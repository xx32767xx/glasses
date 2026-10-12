package com.leion.lanrelay;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;

/**
 * MicUploader —— 录音并把音频分块上传给电脑
 * ============================================================================
 * 为什么要有这个类：
 *   这台设备的系统语音识别服务不可用（已诊断过，不是我们的代码问题），
 *   所以"手机上对着说话 → 出字幕"只能换一条路：**手机只当麦克风**，
 *   把原始音频传给电脑，识别在电脑上用 Whisper 跑。
 *   好处是识别质量与手机型号无关；代价是必须连着电脑（同传本来也要连）。
 *
 * 几个刻意的决定（都是踩过或想过才这么定的）：
 *   · 采样率**优先 16 kHz，失败依次降级到 44.1k / 48k**。
 *     Whisper 要 16 kHz，但安卓并不保证每台设备都能以 16 kHz 打开录音。
 *     降级后会把真实采样率如实上报，电脑侧负责重采样 —— 猜错采样率会让识别全是乱码。
 *   · 音频源用 MIC 而不是 VOICE_RECOGNITION。
 *     VOICE_RECOGNITION 会做 AGC/降噪，那是给云端识别器调优的；Whisper 是在
 *     相对原始的音频上训练的，手机自带的"美化"反而会削掉它依赖的细节。
 *   · 读到的数据先攒够约 1 秒再传，不是读一点传一点。
 *     每秒一个请求在局域网上很便宜，而且块太碎会让电脑侧的切句更难做。
 *   · 上传是**阻塞**的（在当前线程里等请求返回），不是每块新起线程。
 *     网络慢的时候这会自然形成背压；如果每块一个线程，网络一卡就会堆出几十个线程。
 *   · 停止时会**把最后不足 1 秒的部分也发出去**，否则最后半句话会被丢掉。
 */
public class MicUploader implements AudioSource {

    /** 回调。实现方负责切回主线程。 */
    public interface Listener {
        /** 一行进度（"已上传 3.0 秒"之类）。 */
        void onUploadStatus(String message);

        /** 出错了，录音已经停下。 */
        void onUploadError(String message);

        /**
         * 每一次读取（约 100ms）报一次**真实电平**，用来驱动界面上的音量条。
         *
         * 为什么必须是真的：界面上放一根永远在动的假波形，会让人以为麦克风正常，
         * 而实际上什么都没录到 —— 这个项目已经栽过一次（手机上录到的几乎全是静音，
         * RMS 0.0012，而界面看起来一切正常）。所以宁可显示一条**不动**的条。
         *
         * @param rms  这一段采样的均方根（0~1）
         * @param peak 这一段采样的峰值（0~1）
         */
        void onLevel(float rms, float peak);
    }

    /** 优先尝试的采样率：Whisper 要 16k；后两个是安卓上的常见降级值。 */
    private static final int[] CANDIDATE_RATES = { 16000, 44100, 48000 };

    /** 每次 read 的粒度。100ms 足够细，又不至于把 CPU 叫醒太频繁。 */
    private static final int READ_MS = 100;

    /** 攒够多久就上传一次。 */
    private static final int CHUNK_MS = 1000;

    private final LanClient client;
    private final Listener listener;

    private volatile boolean running = false;
    private Thread thread;
    private AudioRecord record;
    private int sampleRate;

    /**
     * 当前在听哪种语言（由 Activity 在切换按钮时更新）。
     * volatile：录音线程每块都读它，主线程随时可能改。
     */
    private volatile String language = "pt-BR";

    public MicUploader(LanClient client, Listener listener) {
        this.client = client;
        this.listener = listener;
    }

    /** 设置当前语种。录音中调用也安全：下一块音频就会带上新语种。 */
    @Override
    public void setLanguage(String lang) {
        if (lang != null && !lang.isEmpty()) {
            this.language = lang;
        }
    }

    public boolean isRunning() {
        return running;
    }

    @Override
    public String name() {
        return "手机麦克风";
    }

    /** 实际用上的采样率（启动后才有意义）。 */
    @Override
    public int getSampleRate() {
        return sampleRate;
    }

    /**
     * 开始录音上传。
     * @return null 表示成功；否则是一条人类可读的失败原因
     */
    @Override
    public String start() {
        if (running) {
            return null;
        }
        // 上一次的录音线程可能还在收尾（它自己负责释放 AudioRecord）。
        // 这时候再开一个，两块 AudioRecord 抢同一个麦克风，行为不可预期，所以挡掉。
        Thread previous = thread;
        if (previous != null && previous.isAlive()) {
            return "上一次录音还在收尾，稍等一下再点";
        }
        // 1) 挑一个能用的采样率。必须逐个真开一次才算数 ——
        //    getMinBufferSize 返回合法值不代表 AudioRecord 一定能初始化成功。
        AudioRecord candidate = null;
        int chosen = 0;
        int minBuffer = 0;
        StringBuilder tried = new StringBuilder();
        for (int rate : CANDIDATE_RATES) {
            int buffer = AudioRecord.getMinBufferSize(
                    rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (buffer <= 0) {
                tried.append(rate).append("(不支持) ");
                continue;
            }
            AudioRecord probe = null;
            try {
                probe = new AudioRecord(MediaRecorder.AudioSource.MIC, rate,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buffer * 2);
                if (probe.getState() == AudioRecord.STATE_INITIALIZED) {
                    candidate = probe;
                    chosen = rate;
                    minBuffer = buffer;
                    break;
                }
                tried.append(rate).append("(初始化失败) ");
            } catch (Exception error) {
                tried.append(rate).append("(").append(error.getClass().getSimpleName()).append(") ");
            } finally {
                if (candidate == null && probe != null) {
                    try {
                        probe.release();
                    } catch (Exception ignored) { /* 已经废了 */ }
                }
            }
        }
        if (candidate == null) {
            return "麦克风打不开（试过：" + tried.toString().trim() + "）。"
                    + "检查是否给了录音权限，或这台设备有没有麦克风";
        }

        record = candidate;
        sampleRate = chosen;
        final int bytesPerChunk = Math.max(2, chosen * 2 * CHUNK_MS / 1000);
        final int readBytes = Math.max(2, chosen * 2 * READ_MS / 1000);
        running = true;

        if (chosen != 16000) {
            listener.onUploadStatus("注意：这台设备不支持 16 kHz 录音，改用 " + chosen
                    + " Hz（电脑侧会自动重采样）");
        }

        thread = new Thread(() -> loop(readBytes, bytesPerChunk), "mic-upload");
        thread.setDaemon(true);
        thread.start();
        return null;
    }

    /**
     * 停止录音上传。会把最后不足一块的音频也发出去。
     *
     * 刻意**不在这里 join**：这个方法是主线程调的，join 会把界面卡住。
     * 只置标志 + 打断；AudioRecord 的释放交给录音线程自己的 finally 收尾
     * （它那一刻最多再 read 一次，100ms 内就结束了）。
     */
    public void stop() {
        running = false;
        Thread current = thread;
        thread = null;
        if (current != null) {
            current.interrupt();
        }
    }

    private void releaseRecord() {
        AudioRecord current = record;
        record = null;
        if (current != null) {
            try {
                if (current.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    current.stop();
                }
            } catch (Exception ignored) { /* 下面照样要 release */ }
            try {
                current.release();
            } catch (Exception ignored) { /* 进程可能都要结束了 */ }
        }
    }

    /**
     * 算并上报这一小段（约 100ms）的 RMS 与峰值。
     *
     * 只在录音线程里调用，所以不需要额外同步。开销可忽略（1600 个采样）。
     */
    private void reportLevel(byte[] pcm, int length) {
        if (pcm == null || length < 2) return;
        double sum = 0;
        int peak = 0;
        int count = length / 2;
        for (int i = 0; i < count; i++) {
            // 16-bit 小端
            int lo = pcm[i * 2] & 0xFF;
            int hi = pcm[i * 2 + 1];
            int sample = (hi << 8) | lo;
            int abs = sample < 0 ? -sample : sample;
            if (abs > peak) peak = abs;
            sum += (double) sample * (double) sample;
        }
        float rms = (float) Math.sqrt(sum / count) / 32768f;
        float peakValue = peak / 32768f;
        post(() -> listener.onLevel(rms, peakValue));
    }

    private void loop(int readBytes, int bytesPerChunk) {        AudioRecord current = record;
        if (current == null) {
            running = false;
            return;
        }
        byte[] buffer = new byte[bytesPerChunk];
        int filled = 0;
        long totalBytes = 0;
        long started = System.currentTimeMillis();
        boolean first = true;

        try {
            current.startRecording();
        } catch (Exception error) {
            running = false;
            releaseRecord();
            post(() -> listener.onUploadError("开始录音失败：" + describe(error)));
            return;
        }

        try {
            byte[] slice = new byte[readBytes];
            while (running) {
                int read = current.read(slice, 0, slice.length);
                if (read <= 0) {
                    if (read == AudioRecord.ERROR_DEAD_OBJECT) {
                        // 音频设备被系统收走了（比如别的 App 抢了麦克风）。
                        // 必须 break：负值 continue 会让这个循环 100% 占着 CPU 空转。
                        throw new IllegalStateException("录音设备已失效（可能被其它应用占用），请重新开始");
                    }
                    if (read == AudioRecord.ERROR_INVALID_OPERATION || read == AudioRecord.ERROR_BAD_VALUE) {
                        throw new IllegalStateException("录音读取失败（代码 " + read + "）");
                    }
                    continue;
                }
                // 每读一次就报一次真实电平（约 100ms 一次），驱动界面上的音量条。
                // 注意：这里**只**用于界面提示"有没有在讲话"；
                // 真正的语音判定在电脑上（自适应门槛 = 噪声底 × 4），手机不重复实现一套。
                reportLevel(slice, read);
                int offset = 0;
                while (offset < read) {
                    int take = Math.min(read - offset, buffer.length - filled);
                    System.arraycopy(slice, offset, buffer, filled, take);
                    filled += take;
                    offset += take;
                    if (filled == buffer.length) {                        if (!upload(buffer, filled, first)) {
                            return;         // upload 里已经报过错
                        }
                        first = false;
                        totalBytes += filled;
                        filled = 0;
                        final long seconds = totalBytes / 2 / sampleRate;
                        final long elapsed = (System.currentTimeMillis() - started) / 1000;
                        post(() -> listener.onUploadStatus("录音上传中：" + seconds + "s 已上传"
                                + "（已录 " + elapsed + "s，采样率 " + sampleRate + " Hz）"));
                    }
                }
            }

            // 收尾：把不到一块的尾巴也发出去，否则最后半句会被丢掉
            if (filled > 0) {
                upload(buffer, filled, first);
            }
        } catch (Exception error) {
            if (running) {
                final String message = describe(error);
                post(() -> listener.onUploadError("录音中断：" + message));
            }
        } finally {
            running = false;
            releaseRecord();
        }
    }

    /** @return true = 继续；false = 已经报错并停止 */
    private boolean upload(byte[] data, int length, boolean fresh) {
        byte[] payload = new byte[length];
        System.arraycopy(data, 0, payload, 0, length);
        try {
            // 回执里带"累计秒数"，需要时可用来做界面显示；这里确认没抛异常就够
            client.sendAudio(payload, sampleRate, fresh, language);
            return true;
        } catch (Exception error) {
            running = false;
            final String message = describe(error);
            post(() -> listener.onUploadError("上传音频失败：" + message));
            return false;
        }
    }

    /**
     * 复用同一个 Handler。
     * 电平回调现在是每 100ms 一次（10 次/秒），每次 new 一个 Handler 是白白的分配。
     */
    private final Handler main = new Handler(Looper.getMainLooper());

    private void post(Runnable action) {
        main.post(action);
    }

    private static String describe(Exception error) {
        String message = error.getMessage();
        if (message == null || message.isEmpty()) {
            return error.getClass().getSimpleName();
        }
        return message;
    }
}
