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

    private boolean listening = false;
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
            recognizer.destroy();
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
        if (listening) {
            stopListening();
            startListening();
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
        if (listening) {
            stopListening();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_RECORD_AUDIO);
            return;
        }
        startListening();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_RECORD_AUDIO) {
            return;
        }
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startListening();
        } else {
            setStatus("没有麦克风权限，无法听写。到系统设置里给这个应用开权限。");
        }
    }

    private void startListening() {
        if (client == null || !client.isRunning()) {
            setStatus("先点「连接」，连上电脑再开始听写。");
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            setStatus("这台手机没有可用的语音识别服务（很多国产 ROM 需要装 Google 语音服务，"
                    + "或者在系统设置里打开「语音输入」）。");
            return;
        }
        if (recognizer == null) {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            recognizer.setRecognitionListener(recognitionListener);
        }

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, listenLanguage);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);

        listening = true;
        micButton.setText(R.string.stop_listen);
        setStatus("正在听（" + ("pt-BR".equals(listenLanguage) ? "葡语" : "中文") + "）…说完一句就自动送走");
        recognizer.startListening(intent);
    }

    private void stopListening() {
        listening = false;
        micButton.setText(R.string.start_listen);
        if (recognizer != null) {
            recognizer.stopListening();
            recognizer.cancel();
        }
        setStatus("已停止听写。");
    }

    private void restartSoon() {
        if (!listening) {
            return;
        }
        main.postDelayed(() -> {
            if (listening) {
                startListening();
            }
        }, 400);
    }

    private final RecognitionListener recognitionListener = new RecognitionListener() {
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
            restartSoon();
        }

        @Override
        public void onError(int error) {
            // SPEECH_TIMEOUT / NO_MATCH 是正常的"这句没听清"，继续听就行，不该刷屏报错
            if (error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                    && error != SpeechRecognizer.ERROR_NO_MATCH) {
                setStatus("识别出错（代码 " + error + "），自动重试中…");
            }
            restartSoon();
        }

        @Override
        public void onReadyForSpeech(Bundle params) { }

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
