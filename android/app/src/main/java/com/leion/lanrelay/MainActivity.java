package com.leion.lanrelay;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Paint;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.TypedValue;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import java.util.ArrayList;

/**
 * 虚拟眼镜（开发者模式）。
 *
 * 界面上只有四样东西：一块"虚拟眼镜屏幕"、连接设置、一个听写大按钮、一行状态。
 *
 * 这块屏幕**故意做得像真眼镜**：严格按电脑端给的显示预算（默认 40 列 × 3 行）折行显示，
 * 字号也调到"40 个半角字符正好铺满面板宽度"。所以在拿到真眼镜之前，你看到的
 * **就是眼镜将来会显示的样子**——包括"这句话太长被截掉了"这种问题也能提前发现。
 *
 * 整条链路：
 *   麦克风 → 安卓自带语音识别 → POST /say → 电脑上的转发进程 → 收件箱文件
 *        → harness 里的插件（判语向 / 调大模型翻译 / 排版）→ 字幕总线文件
 *        → 转发进程 → GET /frame → 这块屏幕
 */
public class MainActivity extends Activity implements LanClient.Listener {

    private static final int REQUEST_RECORD_AUDIO = 1001;
    private static final String PREFS = "leion";
    private static final String KEY_HOST = "host";
    private static final String KEY_SECRET = "secret";
    private static final String KEY_LANG = "lang";

    private final Handler main = new Handler(Looper.getMainLooper());

    private TextView panel;
    private TextView panelCaption;
    private TextView status;
    private EditText host;
    private EditText secret;
    private Button connectButton;
    private Button langButton;
    private Button micButton;

    private LanClient client;
    private SpeechRecognizer recognizer;

    /**
     * 听写状态机。以前只有一个 boolean，结果踩了两个坑：
     *   1) cancel() 之后紧接着 startListening() —— 识别服务还没收尾，直接返回 ERROR_CLIENT；
     *   2) 取消后残留的 onError 回调会覆盖新一轮的状态文字。
     * 所以拆成三样东西：意图（wantListening）、状态（listenState）、代次（generation）。
     */
    private boolean wantListening = false;      // 用户的意图（按钮按下去了）
    private static final int STATE_IDLE = 0;
    private static final int STATE_STARTING = 1;
    private static final int STATE_LISTENING = 2;
    private int listenState = STATE_IDLE;
    /** 每开始/取消一轮就 +1；回调里对不上就丢弃（上一轮的残留回调不该影响这一轮）。 */
    private int generation = 0;
    private int retryCount = 0;

    private String listenLanguage = "pt-BR";
    private int cols = 40;
    private int lineBudget = 3;

    // ── 生命周期 ───────────────────────────────────────────────────────────

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        panel = findViewById(R.id.panel);
        panelCaption = findViewById(R.id.panelCaption);
        status = findViewById(R.id.status);
        host = findViewById(R.id.host);
        secret = findViewById(R.id.secret);
        connectButton = findViewById(R.id.connectButton);
        langButton = findViewById(R.id.langButton);
        micButton = findViewById(R.id.micButton);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        host.setText(prefs.getString(KEY_HOST, ""));
        secret.setText(prefs.getString(KEY_SECRET, ""));
        listenLanguage = prefs.getString(KEY_LANG, "pt-BR");
        updateLanguageLabel();

        connectButton.setOnClickListener(v -> toggleConnection());
        langButton.setOnClickListener(v -> toggleLanguage());
        micButton.setOnClickListener(v -> toggleListening());

        renderPanel(new String[] { "（等待字幕…）" });
        applyPanelMetrics();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (client != null) {
            client.stop();
        }
        if (recognizer != null) {
            // 先让在途回调失效，再销毁
            generation += 1;
            listenState = STATE_IDLE;
            wantListening = false;
            try {
                recognizer.destroy();
            } catch (Exception ignored) { /* 进程都要结束了，忽略 */ }
            recognizer = null;
        }
    }

    // ── 连接 ───────────────────────────────────────────────────────────────

    private void toggleConnection() {
        if (client != null && client.isRunning()) {
            client.stop();
            client = null;
            connectButton.setText(R.string.connect);
            panelCaption.setText("未连接");
            setStatus("已断开。");
            return;
        }

        String url = host.getText().toString().trim();
        String key = secret.getText().toString().trim();
        if (url.isEmpty()) {
            setStatus("先填电脑地址，例如 http://192.168.1.108:8788（转发进程启动时会打印）");
            return;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
            host.setText(url);
        }
        if (url.contains(":") && url.lastIndexOf(':') < url.indexOf("//") + 3) {
            setStatus("地址要带端口，例如 http://192.168.1.108:8788");
            return;
        }

        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(KEY_HOST, url)
                .putString(KEY_SECRET, key)
                .apply();

        client = new LanClient(url, key, this);
        connectButton.setText(R.string.disconnect);
        panelCaption.setText("连接中…");
        setStatus("正在连接 " + url + " …");
        client.start();
    }

    private void toggleLanguage() {
        listenLanguage = "pt-BR".equals(listenLanguage) ? "zh-CN" : "pt-BR";
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_LANG, listenLanguage).apply();
        updateLanguageLabel();
        if (wantListening) {
            // 不能"停下立刻重启"：识别服务需要时间收尾，紧接着 startListening()
            // 会得到一个 ERROR_CLIENT（就是"代码 5"最常见的来源）。
            // 所以取消、作废在途回调，等一小会儿再开始新的一轮。
            restartSessionAfter(700);
        }
    }

    private void updateLanguageLabel() {
        langButton.setText("pt-BR".equals(listenLanguage) ? "听葡语" : "听中文");
        String hint = "pt-BR".equals(listenLanguage)
                ? "对方说葡语 → 眼镜上显示中文字幕"
                : "你说中文 → 译成巴葡（眼镜上只做回显，对方需要 TTS 才能听到）";
        panelCaption.setText(hint);
    }

    // ── 听写 ───────────────────────────────────────────────────────────────

    private void toggleListening() {
        if (wantListening) {
            stopListening("已停止听写。");
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            wantListening = true;                  // 记住意图，授权回来接着开始
            updateMicButton();
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_RECORD_AUDIO);
            return;
        }
        wantListening = true;
        retryCount = 0;
        startListening();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_RECORD_AUDIO) {
            return;
        }
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            if (wantListening) {
                startListening();
            }
        } else {
            wantListening = false;
            updateMicButton();
            setStatus("没有麦克风权限，无法听写。到系统设置里给这个应用开权限。");
        }
    }

    private void startListening() {
        if (listenState != STATE_IDLE) {
            return;                         // 已经有一轮在跑，防重入
        }
        if (client == null || !client.isRunning()) {
            wantListening = false;
            updateMicButton();
            setStatus("先点「连接」，连上电脑再开始听写。");
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            wantListening = false;
            updateMicButton();
            setStatus("这台手机没有可用的语音识别服务（很多国产 ROM 需要装 Google 语音服务，"
                    + "或者在系统设置里打开「语音输入」）。");
            return;
        }
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(recognitionListener);
        }

        generation += 1;
        listenState = STATE_STARTING;
        updateMicButton();
        setStatus("正在启动识别（" + langLabel() + "）…");
        try {
            recognizer.startListening(buildIntent());
        } catch (Exception error) {
            // startListening 本身抛异常（少见但存在）：按不可重试处理，别把状态卡住。
            listenState = STATE_IDLE;
            wantListening = false;
            updateMicButton();
            setStatus("启动识别失败：" + error.getClass().getSimpleName()
                    + "。把语言切到另一种再试；或重启本应用。");
        }
    }

    private Intent buildIntent() {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, listenLanguage);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        return intent;
    }

    /** 用户主动停止（或不打算继续了）。 */
    private void stopListening(String reason) {
        wantListening = false;
        generation += 1;                    // 作废在途回调
        listenState = STATE_IDLE;
        retryCount = 0;
        if (recognizer != null) {
            try {
                recognizer.cancel();
            } catch (Exception ignored) {
                // cancel 失败无所谓，反正我们不再关心这一轮的结果
            }
        }
        updateMicButton();
        setStatus(reason);
    }

    /**
     * 取消当前这一轮，过一会儿再开始新的。
     * 用于"换语言"：绝不能 cancel 完立刻 start（那是 ERROR_CLIENT 的经典成因）。
     */
    private void restartSessionAfter(long delayMs) {
        generation += 1;
        listenState = STATE_IDLE;
        if (recognizer != null) {
            try {
                recognizer.cancel();
            } catch (Exception ignored) { /* 同上 */ }
        }
        final long delay = delayMs;
        setStatus("切换中…（" + langLabel() + "）");
        main.postDelayed(() -> {
            if (wantListening) {
                retryCount = 0;
                startListening();
            }
        }, delay);
    }

    /** 一轮识别自然结束（出了结果或出错）之后的收尾：决定要不要继续听。 */
    private void onSessionEnded(long delayMs) {
        listenState = STATE_IDLE;
        if (!wantListening) {
            updateMicButton();
            return;
        }
        // 递增退避：以前固定 400ms，遇到持续性错误会变成"立刻出错→立刻重试→立刻出错"的死循环。
        retryCount += 1;
        long delay = Math.min(delayMs * retryCount, 3000L);
        main.postDelayed(() -> {
            if (wantListening) {
                startListening();
            }
        }, delay);
    }

    private String langLabel() {
        return "pt-BR".equals(listenLanguage) ? "葡语" : "中文";
    }

    private void updateMicButton() {
        micButton.setText(wantListening ? R.string.stop_listen : R.string.start_listen);
    }

    private final RecognitionListener recognitionListener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
            listenState = STATE_LISTENING;
            retryCount = 0;                       // 真的开始收音了，退避计数归零
            if (wantListening) {
                setStatus("正在听（" + langLabel() + "）…说完一句就自动送走");
            }
        }

        @Override
        public void onResults(Bundle results) {
            ArrayList<String> texts = results == null
                    ? null
                    : results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (texts != null && !texts.isEmpty()) {
                String text = texts.get(0) == null ? "" : texts.get(0).trim();
                if (!text.isEmpty() && client != null) {
                    client.sendText(text, listenLanguage);
                }
            }
            onSessionEnded(200);
        }

        @Override
        public void onError(int error) {
            // 我们自己 cancel() 之后，识别服务常常会回一个 ERROR_CLIENT。
            // 那时已经没有会话在跑了（STATE_IDLE），这种回声必须丢掉 —— 否则会一路刷屏，
            // 而且看起来就像"一按就开始出错"。
            if (listenState == STATE_IDLE) {
                return;
            }

            if (error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                    || error == SpeechRecognizer.ERROR_NO_MATCH) {
                // 正常的"这段时间没人说话 / 没听清"，安静地继续听
                onSessionEnded(200);
                return;
            }

            String label = errorName(error) + "（代码 " + error + "）";
            if (!isRetryable(error)) {
                // 不可重试的错误：停下来说清楚，不要死循环重试
                wantListening = false;
                listenState = STATE_IDLE;
                retryCount = 0;
                if (recognizer != null) {
                    try {
                        recognizer.cancel();
                    } catch (Exception ignored) { /* 忽略 */ }
                }
                updateMicButton();
                setStatus("听写已停止：" + label + "\n" + errorHint(error)
                        + "\n（本次请求的语种是 " + listenLanguage + "）");
                return;
            }

            setStatus("识别出错 " + label + "，正在重试…\n" + errorHint(error));
            onSessionEnded(600);
        }

        @Override
        public void onBeginningOfSpeech() { }

        @Override
        public void onRmsChanged(float rmsdB) { }

        @Override
        public void onBufferReceived(byte[] buffer) { }

        @Override
        public void onEndOfSpeech() { }

        @Override
        public void onPartialResults(Bundle partialResults) { }

        @Override
        public void onEvent(int eventType, Bundle params) { }
    };

    // ── 语音识别错误码 → 人话 ─────────────────────────────────────────────────
    //
    // 以前只显示"代码 5"，没人看得懂。这些码是 Android 定义的标准值，
    // 名字比数字有用得多：ERROR_CLIENT 一眼就知道是"App 侧调用问题"，不是网络也不是没听清。

    private static String errorName(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "ERROR_NETWORK_TIMEOUT";
            case SpeechRecognizer.ERROR_NETWORK: return "ERROR_NETWORK";
            case SpeechRecognizer.ERROR_AUDIO: return "ERROR_AUDIO";
            case SpeechRecognizer.ERROR_SERVER: return "ERROR_SERVER";
            case SpeechRecognizer.ERROR_CLIENT: return "ERROR_CLIENT";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "ERROR_SPEECH_TIMEOUT";
            case SpeechRecognizer.ERROR_NO_MATCH: return "ERROR_NO_MATCH";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "ERROR_RECOGNIZER_BUSY";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "ERROR_INSUFFICIENT_PERMISSIONS";
            case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS: return "ERROR_TOO_MANY_REQUESTS";
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED: return "ERROR_SERVER_DISCONNECTED";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED: return "ERROR_LANGUAGE_NOT_SUPPORTED";
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: return "ERROR_LANGUAGE_UNAVAILABLE";
            case SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT: return "ERROR_CANNOT_CHECK_SUPPORT";
            default: return "未知错误";
        }
    }

    private static String errorHint(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_CLIENT:
                return "这是「App 调用识别服务的方式」出了问题，不是网络、也不是没听清。"
                        + "常见原因：上一次识别还没收尾就又启动了一次（本版本已修），"
                        + "或者这台设备的识别服务本身状态异常（重启手机/换一台设备可排除）。";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "没有麦克风权限。到 系统设置 → 应用 → 本应用 → 权限 里打开麦克风。";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                return "这台手机没有该语种的语音数据。到 设置 → 系统 → 语言和输入法 → 语音输入 "
                        + "里下载对应语言包；或把语言切回另一种先跑通。";
            case SpeechRecognizer.ERROR_AUDIO:
                return "麦克风被别的应用占着，或录音出错。关掉其它录音类应用再试。";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "网络问题 —— 部分机型的语音识别要联网。检查手机的网络。";
            case SpeechRecognizer.ERROR_SERVER:
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
                return "识别服务端出问题（多数是设备自带识别服务的云端不可用）。";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "上一个识别还没结束，等一下会自动继续。";
            case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS:
                return "请求太频繁，稍等一会儿再开始。";
            default:
                return "把这条信息截图发出来，可以照着错误名去查。";
        }
    }

    /** 值得重试的错误；ERROR_CLIENT / 权限 / 语种缺失 一律不重试（重试只会重复报同一个错）。 */
    private static boolean isRetryable(int code) {
        switch (code) {
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return true;
            default:
                return false;
        }
    }

    // ── 来自 LanClient 的回调（都在后台线程，必须切回主线程） ────────────────

    @Override
    public void onStatus(final String message) {
        main.post(() -> setStatus(message));
    }

    @Override
    public void onHello(final String device, final int serverCols, final int serverLineBudget) {
        main.post(() -> {
            cols = serverCols > 0 ? serverCols : 40;
            lineBudget = serverLineBudget > 0 ? serverLineBudget : 3;
            panelCaption.setText("已连接 " + device + " · " + cols + " 列 × " + lineBudget + " 行");
            applyPanelMetrics();
        });
    }

    @Override
    public void onFrame(final String speaker, final String lang, final String[] lines) {
        main.post(() -> {
            renderPanel(lines);
            String who = "me".equals(speaker)
                    ? "佩戴者说的 → 出站给对方"
                    : "对方说的 → 译给佩戴者读";
            panelCaption.setText("[" + speaker + " / " + lang + "] " + who);
        });
    }

    @Override
    public void onError(final String message) {
        main.post(() -> {
            setStatus(message);
            // 连接类错误：把按钮恢复成"连接"，让用户能重试
            if (message.startsWith("连接失败") || message.startsWith("握手失败")) {
                if (client != null) {
                    client.stop();
                    client = null;
                }
                connectButton.setText(R.string.connect);
            }
        });
    }

    // ── 渲染 ───────────────────────────────────────────────────────────────

    /**
     * 画到"虚拟眼镜"上。
     * 只做一件事：把行数补齐到 lineBudget 行（宁可留白也不要让面板高度跳动）。
     * **绝不重排文字** —— 折行是电脑端按真实显示预算做的，重排就失真了。
     */
    private void renderPanel(String[] lines) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < lineBudget; i++) {
            if (i > 0) {
                builder.append('\n');
            }
            if (lines != null && i < lines.length && lines[i] != null) {
                builder.append(lines[i]);
            }
        }
        panel.setText(builder.toString());
    }

    /**
     * 把字号调到"cols 个半角字符正好铺满面板宽度"，让它看起来像一块固定宽度的设备屏幕。
     * 等宽字体下 CJK 正好占两格，与电脑端"汉字算 2 列"的算法一致。
     */
    private void applyPanelMetrics() {
        panel.post(() -> {
            int available = panel.getWidth() - panel.getPaddingLeft() - panel.getPaddingRight();
            if (available <= 0) {
                return;
            }
            Paint paint = panel.getPaint();
            float current = panel.getTextSize();
            float oneChar = paint.measureText("M");
            if (oneChar <= 0f) {
                return;
            }
            float desired = available / (float) cols;
            float target = current * desired / oneChar;
            // 夹住上下限：太长的行别把字号压到看不见，短屏也别撑得巨大
            target = Math.max(8f, Math.min(target, current * 1.6f));
            panel.setTextSize(TypedValue.COMPLEX_UNIT_PX, target);
        });
    }

    private void setStatus(String message) {
        status.setText(message);
    }
}
