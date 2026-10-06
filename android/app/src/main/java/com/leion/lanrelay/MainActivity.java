package com.leion.lanrelay;

import android.Manifest;
import android.app.Activity;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Paint;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * 虚拟眼镜（开发者模式）。
 *
 * 界面上只有四样东西：一块"虚拟眼镜屏幕"、连接设置、一个听写大按钮、一行状态。
 *
 * 这块屏幕**故意做得像真眼镜**：严格按电脑端给的显示预算（默认 40 列 × 3 行）折行显示，
 * 字号也调到"40 个半角字符正好铺满面板宽度"。所以在拿到真眼镜之前，你看到的
 * **就是眼镜将来会显示的样子**——包括"这句话太长被截掉了"这种问题也能提前发现。
 *
 * 整条链路（两条，互为备份）：
 *
 *   ① 录音上传（**推荐，本机上唯一真能用的那条**）
 *      麦克风 → AudioRecord 录成裸 PCM → 每秒一块 POST /audio → 电脑上的转发进程落盘
 *           → 电脑上的 Whisper 尾随该文件做识别 → 桥写收件箱
 *           → harness 里的插件（判语向 / 调大模型翻译 / 排版）→ 字幕总线文件
 *           → 转发进程 → GET /frame → 这块屏幕
 *      为什么走这条：**这台设备的系统语音识别服务不可用**（已诊断确认，不是我们的代码问题）。
 *      把识别放到电脑上，质量与手机型号无关，还能顺手用上 GPU。
 *
 *   ② 系统语音识别（保留，但本机不可用）
 *      麦克风 → 安卓自带语音识别 → POST /say → …后面同上
 */
public class MainActivity extends Activity implements LanClient.Listener, MicUploader.Listener {

    private static final int REQUEST_RECORD_AUDIO = 1001;
    private static final String PREFS = "leion";
    private static final String KEY_HOST = "host";
    private static final String KEY_SECRET = "secret";
    private static final String KEY_LANG = "lang";

    private final Handler main = new Handler(Looper.getMainLooper());

    private TextView panel;
    private TextView panelCaption;
    private TextView panelBadge;
    private TextView status;
    private TextView connChip;
    private TextView recordLabel;
    private TextView pillThem;
    private TextView pillMe;
    private TextView settingsToggle;
    private View statusDot;
    private LinearLayout settingsBox;
    private EditText host;
    private EditText secret;
    private EditText manualText;
    private Button connectButton;
    private ImageButton langButton;
    private ImageButton recordButton;
    private Button sendButton;

    private LanClient client;
    private MicUploader uploader;

    /** 录音上传的意图（授权回调回来时靠它知道该不该接着开始）。 */
    private boolean wantRecording = false;

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
        panelBadge = findViewById(R.id.panelBadge);
        status = findViewById(R.id.status);
        connChip = findViewById(R.id.connChip);
        recordLabel = findViewById(R.id.recordLabel);
        pillThem = findViewById(R.id.pillThem);
        pillMe = findViewById(R.id.pillMe);
        settingsToggle = findViewById(R.id.settingsToggle);
        statusDot = findViewById(R.id.statusDot);
        settingsBox = findViewById(R.id.settingsBox);
        host = findViewById(R.id.host);
        secret = findViewById(R.id.secret);
        manualText = findViewById(R.id.manualText);
        connectButton = findViewById(R.id.connectButton);
        langButton = findViewById(R.id.langButton);
        recordButton = findViewById(R.id.recordButton);
        sendButton = findViewById(R.id.sendButton);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        host.setText(prefs.getString(KEY_HOST, ""));
        secret.setText(prefs.getString(KEY_SECRET, ""));
        listenLanguage = prefs.getString(KEY_LANG, "pt-BR");
        updateLanguageLabel();

        connectButton.setOnClickListener(v -> toggleConnection());
        // 语言方向条整条都能点：点哪一侧就切到哪一侧（和 Google 翻译一样）
        langButton.setOnClickListener(v -> toggleLanguage());
        pillThem.setOnClickListener(v -> toggleLanguage());
        pillMe.setOnClickListener(v -> toggleLanguage());
        recordButton.setOnClickListener(v -> toggleRecording());
        sendButton.setOnClickListener(v -> sendManualText());
        settingsToggle.setOnClickListener(v -> toggleSettings());

        // 设置区默认收起，把界面让给字幕；但**没配过地址时必须展开** ——
        // 否则第一次打开的人只看到一块空屏幕和一个点不动的按钮，不知道该干什么。
        settingsBox.setVisibility(host.getText().toString().trim().isEmpty()
                ? View.VISIBLE : View.GONE);

        renderPanel(new String[] { getString(R.string.panel_placeholder) });
        applyPanelMetrics();
        setDot(R.color.idle);
    }

    private void toggleSettings() {
        settingsBox.setVisibility(settingsBox.getVisibility() == View.VISIBLE
                ? View.GONE : View.VISIBLE);
    }

    /** 顶栏那颗小圆点：一眼看出"没连 / 连上 / 正在录 / 出错"。 */
    private void setDot(int colorRes) {
        statusDot.setBackgroundTintList(ColorStateList.valueOf(getColor(colorRes)));
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        // 录音线程必须先停：它持有麦克风与 AudioRecord，进程退出前不释放会留个坏状态
        if (uploader != null) {
            uploader.stop();
            uploader = null;
        }
        if (client != null) {
            client.stop();
        }
    }

    // ── 连接 ───────────────────────────────────────────────────────────────

    private void toggleConnection() {
        if (client != null && client.isRunning()) {
            client.stop();
            client = null;
            connectButton.setText(R.string.connect);
            connChip.setText(R.string.state_offline);
            setDot(R.color.idle);
            setStatus("已断开。");
            return;
        }

        String url = host.getText().toString().trim();
        String key = secret.getText().toString().trim();
        if (url.isEmpty()) {
            settingsBox.setVisibility(View.VISIBLE);      // 缺地址就把设置摊开，别让人干瞪眼
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
        connChip.setText(R.string.state_connecting);
        setDot(R.color.warn);
        setStatus("正在连接 " + url + " …");
        client.start();
    }

    /**
     * 切换"听哪种语言"。
     *
     * 这个选择会随每一块音频一起发给电脑（`/audio?lang=`），电脑侧的识别进程跟着改语种。
     * 所以录音上传进行中切换是**立刻生效**的：不用停止再开始。
     */
    private void toggleLanguage() {
        listenLanguage = "pt-BR".equals(listenLanguage) ? "zh-CN" : "pt-BR";
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_LANG, listenLanguage).apply();
        updateLanguageLabel();
        if (uploader != null) {
            uploader.setLanguage(listenLanguage);
            if (uploader.isRunning()) {
                setStatus("已切换成「" + langLabel() + "」—— 下一句就按新语种识别（不用停止录音）。");
            }
        }
    }

    private void updateLanguageLabel() {
        boolean listeningPt = "pt-BR".equals(listenLanguage);
        // 高亮"正在听谁说"的那一侧。整条都能点，点哪边就切到哪边。
        pillThem.setBackgroundResource(listeningPt ? R.drawable.tap_pill_active : R.drawable.tap_pill);
        pillMe.setBackgroundResource(listeningPt ? R.drawable.tap_pill : R.drawable.tap_pill_active);
        pillThem.setTextColor(getColor(listeningPt ? R.color.on_brand : R.color.ink));
        pillMe.setTextColor(getColor(listeningPt ? R.color.ink : R.color.on_brand));
        panelCaption.setText(listeningPt
                ? "对方说葡语 → 眼镜上显示中文字幕"
                : "你说中文 → 译成巴葡（眼镜上只做回显，对方需要 TTS 才能听到）");
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_RECORD_AUDIO) {
            return;
        }
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            if (wantRecording) {
                startUpload();
            }
        } else {
            wantRecording = false;
            updateRecordButton();
            setStatus("没有麦克风权限，无法录音上传。到系统设置里给这个应用开权限。");
        }
    }

    // ── 录音上传（把识别放到电脑上做）───────────────────────────────────────

    /**
     * 为什么要有这条路：
     *   这台设备的系统语音识别服务不可用（已诊断确认），所以「开始听写」在本机是死的。
     *   录音上传让手机只当麦克风，识别交给电脑上的 Whisper —— 于是"对着说话出字幕"
     *   在这台设备上才真的能用。代价是必须连着电脑，而同传本来就要连。
     */
    private void toggleRecording() {
        if (uploader != null && uploader.isRunning()) {
            uploader.stop();
            updateRecordButton();
            setStatus("已停止录音上传。已上传的音频仍会被电脑识别成字幕。");
            return;
        }
        if (client == null || !client.isRunning()) {
            setStatus("先点「连接」，连上电脑再录音上传（音频要传给电脑识别）。");
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            wantRecording = true;                  // 记住意图，授权回来接着开始
            updateRecordButton();
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_RECORD_AUDIO);
            return;
        }
        startUpload();
    }

    private void startUpload() {
        if (client == null || !client.isRunning()) {
            wantRecording = false;
            updateRecordButton();
            setStatus("连上电脑才能录音上传。");
            return;
        }
        if (uploader == null) {
            uploader = new MicUploader(client, this);
        }
        uploader.setLanguage(listenLanguage);
        String problem = uploader.start();
        if (problem != null) {
            wantRecording = false;
            updateRecordButton();
            setStatus(problem);
            return;
        }
        updateRecordButton();
        setStatus("录音上传中：对着手机说话，电脑识别后字幕会出现在上面（采样率 "
                + uploader.getSampleRate() + " Hz）。");
    }

    private void updateRecordButton() {
        boolean active = uploader != null && uploader.isRunning();
        boolean online = client != null && client.isRunning();
        // 一个圆钮承担两种状态：麦克风（待机）↔ 方块（录音中），颜色也跟着换。
        // 这样"正在录"在余光里就能看出来 —— 走路时看手机不方便。
        recordButton.setImageResource(active ? R.drawable.ic_stop : R.drawable.ic_mic);
        recordButton.setBackgroundResource(active ? R.drawable.tap_mic_active : R.drawable.tap_mic_idle);
        recordButton.setContentDescription(getString(
                active ? R.string.stop_record : R.string.start_record));
        recordLabel.setText(active ? R.string.stop_record : R.string.start_record);
        setDot(active ? R.color.rec : (online ? R.color.ok : R.color.idle));
    }

    @Override
    public void onUploadStatus(final String message) {
        main.post(() -> setStatus(message));
    }

    @Override
    public void onUploadError(final String message) {
        main.post(() -> {
            updateRecordButton();
            setStatus(message);
        });
    }

    private String langLabel() {
        return "pt-BR".equals(listenLanguage) ? "葡语" : "中文";
    }
    /**
     * 手输一句话直接送走 —— 刻意不经过语音识别。
     *
     * 为什么需要它：语音识别是这条链路上最容易受设备环境影响的环节（国产 ROM 缺服务、
     * 缺语种数据、被别的应用占麦克风…）。有了这个入口，"手机 → 电脑 → 翻译 → 字幕"
     * 这条主链路的验证就与语音识别解耦了：语音坏了也能确认后面全是好的。
     *
     * 送出的语种按当前选择（听葡语 → 当葡语原文；听中文 → 当中文原文）。
     */
    private void sendManualText() {
        String text = manualText.getText().toString().trim();
        if (text.isEmpty()) {
            setStatus("先在手输框里写一句话。");
            return;
        }
        if (client == null || !client.isRunning()) {
            setStatus("先点「连接」，连上电脑再发送。");
            return;
        }
        client.sendText(text, listenLanguage);
        manualText.setText("");
        setStatus("已送走（当作「" + langLabel() + "」原文）：" + text);
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
            connChip.setText("已连接");
            panelBadge.setText("眼镜显示 · " + cols + " 列 × " + lineBudget + " 行");
            setDot(uploader != null && uploader.isRunning() ? R.color.rec : R.color.ok);
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
                connChip.setText(R.string.state_offline);
                setDot(R.color.warn);
                // 连不上通常是地址/密钥写错了，直接把设置摊开
                settingsBox.setVisibility(View.VISIBLE);
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
