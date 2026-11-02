package com.leion.lanrelay;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.util.Log;

import java.io.File;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * TtsSpeaker —— 把一段译文**念出来**（5.30）。
 * ============================================================================
 * 为什么先做手机自带的 TTS：零依赖、离线可用、首包快（本地合成通常 <200ms）。
 * 云端（qwen3-tts-flash）音质更好但要 Key + 外网，等它接上时**只换这一个类**，
 * 队列、路由、与实时传声的互斥都不用动（契约见 docs/23 §5）。
 *
 * 三个设计决定，都来自交接包踩过的坑：
 *
 * ① **合成到文件，再用 MediaPlayer 播**，而不是 `tts.speak()` 直接播。
 *    原因：`setPreferredDevice()` 只能在**播放器**上设。用 `speak()` 就选不了输出设备，
 *    于是"耳机/眼镜优先、禁手机外放"这条规则根本落不了地。
 *
 * ② **没有耳机/眼镜就拒绝**，不悄悄外放。会议里外放 = 对方的声音和译文一起喷出来，
 *    还会被麦克风录回去（自己的译文再被识别一次，死循环）。
 *
 * ③ **播报期间申请一下音频焦点（TRANSIENT）**：别的 App 在放音乐时该让路，
 *    播完立刻还回去（借用不还，是我们的实时传声被静音那类幽灵 bug 的来源）。
 */
public final class TtsSpeaker {

    private static final String TAG = "LeionTts";
    /** 单块合成+播放的最长等待：卡住就放弃这一块，别把整个队列堵死。 */
    private static final long CHUNK_TIMEOUT_MS = 60_000;

    /** 一次播报的结果：`ok=false` 时 `code` 是机器码（界面按语言翻），`error` 是兜底人话。 */
    public static final class Result {
        public final boolean ok;
        /** 机器码（见 {@link InterpreterErrorCodes}）；ok=true 时为空串。 */
        public final String code;
        public final String error;
        public final long firstAudioMs;

        Result(boolean ok, String code, String error, long firstAudioMs) {
            this.ok = ok;
            this.code = code == null ? "" : code;
            this.error = error == null ? "" : error;
            this.firstAudioMs = firstAudioMs;
        }
    }

    private final Context context;
    private final AudioManager audioManager;

    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private volatile String ttsProblem = "";
    private final CountDownLatch initLatch = new CountDownLatch(1);
    private boolean initStarted = false;

    private volatile MediaPlayer player;
    private volatile CountDownLatch playbackLatch;
    private volatile boolean stopped = false;

    public TtsSpeaker(Context context) {
        this.context = context.getApplicationContext();
        this.audioManager = (AudioManager) this.context.getSystemService(Context.AUDIO_SERVICE);
    }

    /**
     * 念一段文字（**阻塞**：调用方必须是后台线程，`TtsQueue` 就是）。
     *
     * @param text 译文（会按 {@link TtsChunker} 切块，第一块先播）
     * @param lang 目标语言（`zh-CN` / `pt-BR` / `en-US`）
     */
    public Result speak(String text, String lang) {
        stopped = false;
        List<String> chunks = TtsChunker.split(text, lang);
        if (chunks.isEmpty()) return new Result(true, "", "", 0);
        if (!ensureEngine(lang)) {
            return new Result(false, InterpreterErrorCodes.TTS_ENGINE,
                    ttsProblem.isEmpty() ? "这台设备没有可用的语音合成引擎" : ttsProblem, 0);
        }
        // 输出设备：**只接受近耳**（耳机/蓝牙/眼镜 USB），没有就不播
        AudioDeviceInfo output = preferredOutput();
        if (output == null) {
            return new Result(false, InterpreterErrorCodes.NO_EARPHONE, "没有耳机或眼镜，已取消朗读（会议里禁止外放）", 0);
        }
        AudioFocusRequest focus = requestFocus();
        long startedAt = System.currentTimeMillis();
        long firstAudioMs = 0;
        try {
            for (String chunk : chunks) {
                if (stopped) return new Result(true, "", "", firstAudioMs);
                File file = synthesize(chunk, lang);
                if (file == null) {
                    return new Result(false, InterpreterErrorCodes.TTS_FAILED, "语音合成失败（引擎没有返回音频）", firstAudioMs);
                }
                try {
                    boolean played = play(file, output);
                    if (firstAudioMs == 0) firstAudioMs = System.currentTimeMillis() - startedAt;
                    if (!played) {
                        return new Result(false, InterpreterErrorCodes.TTS_FAILED, "朗读被中断或播放失败", firstAudioMs);
                    }
                } finally {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                }
            }
            return new Result(true, "", "", firstAudioMs);
        } finally {
            abandonFocus(focus);
        }
    }

    /** 打断当前朗读（幂等）。队列里剩下的块会看到 `stopped` 后自己退出。 */
    public void stop() {
        stopped = true;
        MediaPlayer current = player;
        if (current != null) {
            try { current.stop(); } catch (Exception ignored) { }
            try { current.release(); } catch (Exception ignored) { }
            player = null;
        }
        CountDownLatch latch = playbackLatch;
        if (latch != null) latch.countDown();
    }

    /** 释放引擎（离开页面时调；下次用到会重新建）。 */
    public void shutdown() {
        stop();
        TextToSpeech engine = tts;
        tts = null;
        ttsReady = false;
        initStarted = false;
        if (engine != null) {
            try { engine.shutdown(); } catch (Exception ignored) { }
        }
    }

    // ── 内部 ──────────────────────────────────────────────────────────────

    /** 懒初始化引擎；第一次调用会等它就绪（最多 5 秒）。 */
    private boolean ensureEngine(String lang) {
        synchronized (this) {
            if (tts == null && !initStarted) {
                initStarted = true;
                tts = new TextToSpeech(context, status -> {
                    if (status == TextToSpeech.SUCCESS) {
                        ttsReady = true;
                    } else {
                        ttsProblem = "语音合成引擎初始化失败（这台设备可能没有安装 TTS）";
                    }
                    initLatch.countDown();
                });
            }
        }
        try {
            if (!initLatch.await(5, TimeUnit.SECONDS)) {
                ttsProblem = "语音合成引擎初始化超时";
                return false;
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        }
        if (!ttsReady) return false;
        Locale locale = localeOf(lang);
        try {
            int availability = tts.isLanguageAvailable(locale);
            if (availability < TextToSpeech.LANG_AVAILABLE) {
                ttsProblem = "这台设备没有 " + locale.getDisplayName() + " 的语音包";
                return false;
            }
            tts.setLanguage(locale);
        } catch (Exception error) {
            ttsProblem = "设置朗读语言失败：" + error.getMessage();
            return false;
        }
        return true;
    }

    private static Locale localeOf(String lang) {
        String code = lang == null ? "" : lang.trim().toLowerCase(Locale.ROOT);
        if (code.startsWith("zh")) return Locale.SIMPLIFIED_CHINESE;
        if (code.startsWith("pt")) return new Locale("pt", "BR");
        if (code.startsWith("en")) return Locale.US;
        return Locale.getDefault();
    }

    /** 合成一块到缓存文件；失败返回 null。 */
    private File synthesize(String chunk, String lang) {
        TextToSpeech engine = tts;
        if (engine == null) return null;
        File file = new File(context.getCacheDir(), "tts-" + System.nanoTime() + ".wav");
        try {
            android.os.Bundle params = new android.os.Bundle();
            params.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC);
            int code = engine.synthesizeToFile(chunk, params, file, "tts-" + System.nanoTime());
            if (code != TextToSpeech.SUCCESS) return null;
            // synthesizeToFile 是异步的：轮询"文件已写完"
            long deadline = System.currentTimeMillis() + CHUNK_TIMEOUT_MS;
            while (System.currentTimeMillis() < deadline) {
                if (stopped) return null;
                if (file.exists() && file.length() > 0 && synthesisDone(file)) return file;
                Thread.sleep(30);
            }
            return null;
        } catch (Exception error) {
            Log.w(TAG, "合成失败：" + error.getMessage());
            return null;
        }
    }

    /**
     * 文件是不是写完了。
     *
     * <p>没有回调就靠"大小连续两次不变"判断 —— TTS 引擎没有提供
     * `synthesizeToFile` 的完成回调（`UtteranceProgressListener` 在高版本才有
     * `onAudioAvailable`，而 `onDone` 在部分机型上不可靠）。稳定判据比"猜一个固定等待"稳。
     */
    private boolean synthesisDone(File file) throws InterruptedException {
        long first = file.length();
        Thread.sleep(60);
        return file.length() == first && first > 0;
    }

    /** 播放一块：走 MediaPlayer，这样才设得了输出设备。 */
    private boolean play(File file, AudioDeviceInfo output) {
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<String> failure = new AtomicReference<>();
        playbackLatch = latch;
        MediaPlayer created = new MediaPlayer();
        player = created;
        try {
            created.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                created.setPreferredDevice(output);
            }
            created.setDataSource(file.getAbsolutePath());
            created.setOnCompletionListener(mp -> latch.countDown());
            created.setOnErrorListener((mp, what, extra) -> {
                failure.set("播放出错 " + what + "/" + extra);
                latch.countDown();
                return true;
            });
            created.prepare();
            created.start();
            if (!latch.await(CHUNK_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                failure.set("朗读超时");
            }
            return failure.get() == null;
        } catch (Exception error) {
            Log.w(TAG, "播放失败：" + error.getMessage());
            return false;
        } finally {
            playbackLatch = null;
            player = null;
            try { created.release(); } catch (Exception ignored) { }
        }
    }

    /**
     * 挑一个**近耳**输出：眼镜（USB）→ 有线耳机 → 蓝牙 → null。
     *
     * <p>刻意**不返回** `TYPE_BUILTIN_SPEAKER`：会议里外放既是隐私问题，
     * 也会被麦克风录回去。
     */
    private AudioDeviceInfo preferredOutput() {
        if (audioManager == null) return null;
        AudioDeviceInfo usb = null;
        AudioDeviceInfo wired = null;
        AudioDeviceInfo bluetooth = null;
        for (AudioDeviceInfo device : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            switch (device.getType()) {
                case AudioDeviceInfo.TYPE_USB_HEADSET:
                case AudioDeviceInfo.TYPE_USB_DEVICE:
                    if (usb == null) usb = device;
                    break;
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                    if (wired == null) wired = device;
                    break;
                case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                case AudioDeviceInfo.TYPE_BLE_HEADSET:
                case AudioDeviceInfo.TYPE_HEARING_AID:
                    if (bluetooth == null) bluetooth = device;
                    break;
                default:
                    break;
            }
        }
        if (usb != null) return usb;
        if (wired != null) return wired;
        return bluetooth;
    }

    private AudioFocusRequest requestFocus() {
        if (audioManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null;
        try {
            AudioFocusRequest request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build())
                    .build();
            audioManager.requestAudioFocus(request);
            return request;
        } catch (Exception error) {
            Log.w(TAG, "申请音频焦点失败（继续播）：" + error.getMessage());
            return null;
        }
    }

    private void abandonFocus(AudioFocusRequest request) {
        if (request == null || audioManager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try { audioManager.abandonAudioFocusRequest(request); } catch (Exception ignored) { }
    }
}
