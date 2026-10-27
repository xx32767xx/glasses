package com.leion.lanrelay;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * SettingsActivity —— 新入口的「设置」（4.39，A2）。
 * ============================================================================
 *
 * <p>为什么要有它：服务器地址与共享密钥原来**只能在登录页填**，改一次就得先退出登录；
 * 语言与校对开关藏在旧界面（MainActivity）的底部导航里，新入口（HomeActivity）根本进不去。
 * 这一页把"每天会动的那几项"放在一起。
 *
 * <p>旧界面那一页（page_settings.xml）**不删也不复用**：它的 id 与文案都绑在旧导航上
 * （主题/字号/显示模式/开发者模式），而旧界面将来要下掉。这一页只留新链路需要的。
 *
 * <p>校对开关的形状特别注意：真正生效的是**电脑端**的设置，手机只是遥控器 —
 * 所以这里是"读一次、点一下写一次、以服务端回执为准"，不做本地自嗨的偏好。
 */
public class SettingsActivity extends android.app.Activity {

    private static final String PREFS = "leion";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LanClient client;

    private TextView status;
    private EditText serverInput;
    private EditText secretInput;
    private Button langZhButton;
    private Button langPtButton;
    private Button proofreadButton;

    /** 服务端当前的校对开关（null = 还没读到）。 */
    private Boolean proofread = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_settings_app);

        status = findViewById(R.id.setAppStatus);
        serverInput = findViewById(R.id.setAppServer);
        secretInput = findViewById(R.id.setAppSecret);
        langZhButton = findViewById(R.id.setAppLangZh);
        langPtButton = findViewById(R.id.setAppLangPt);
        proofreadButton = findViewById(R.id.setAppProofread);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverInput.setText(prefs.getString("host", ""));
        secretInput.setText(prefs.getString("secret", ""));
        applyLanguageButtons(prefs.getString("speakLang", "zh-CN"));

        client = new LanClient(
                prefs.getString("host", ""), prefs.getString("secret", ""), null);
        String token = prefs.getString("accountToken", "");
        if (token != null && !token.isEmpty()) {
            client.setToken(token);
        }

        findViewById(R.id.setAppSave).setOnClickListener(v -> saveConnection());
        langZhButton.setOnClickListener(v -> setSpeakLanguage("zh-CN"));
        langPtButton.setOnClickListener(v -> setSpeakLanguage("pt-BR"));
        proofreadButton.setOnClickListener(v -> toggleProofread());
        findViewById(R.id.setAppPrivacy).setOnClickListener(v ->
                startActivity(new android.content.Intent(this, PrivacyActivity.class)));
        findViewById(R.id.setAppClearRecords).setOnClickListener(v -> clearRecords());
        findViewById(R.id.setAppBack).setOnClickListener(v -> finish());

        TextView version = findViewById(R.id.setAppVersion);
        version.setText(appVersion());

        status.setText("服务器地址与密钥改了要保存；校对开关以电脑端为准。");
        fetchProofread();
    }

    private String appVersion() {
        try {
            android.content.pm.PackageInfo info =
                    getPackageManager().getPackageInfo(getPackageName(), 0);
            return "译连 TransLink · v" + info.versionName + "(" + info.versionCode + ")";
        } catch (Exception error) {
            return "译连 TransLink";
        }
    }

    // ── 连接 ────────────────────────────────────────────────────────────
    private void saveConnection() {
        String host = normalizeHost(serverInput.getText().toString());
        String secret = secretInput.getText().toString().trim();
        if (host.isEmpty()) {
            status.setText("服务器地址不能为空，例如 http://117.50.180.93:8788");
            return;
        }
        if (secret.isEmpty()) {
            status.setText("共享密钥不能为空（在服务器 start-all 的横幅里）");
            return;
        }
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String oldHost = prefs.getString("host", "");
        prefs.edit().putString("host", host).putString("secret", secret).apply();

        // 客户端是按"地址 + 密钥"建出来的，换了就必须重建，否则还在用旧的
        client = new LanClient(host, secret, null);
        String token = prefs.getString("accountToken", "");
        if (token != null && !token.isEmpty()) {
            client.setToken(token);
        }
        status.setText(oldHost.equals(host)
                ? "已保存连接设置"
                : "已保存。换了服务器后需要重新登录（登录页用同一账号）");
        Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show();
        fetchProofread();
    }

    private static String normalizeHost(String raw) {
        String host = raw == null ? "" : raw.trim();
        if (host.isEmpty()) return "";
        if (!host.startsWith("http://") && !host.startsWith("https://")) {
            host = "http://" + host;
        }
        while (host.endsWith("/")) {
            host = host.substring(0, host.length() - 1);
        }
        return host;
    }

    // ── 我说什么语言 ──────────────────────────────────────────────────
    private void setSpeakLanguage(String lang) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("speakLang", lang).apply();
        applyLanguageButtons(lang);
        status.setText("已设为：" + ("pt-BR".equals(lang) ? "我说葡语" : "我说中文")
                + "（下一场同传生效）");
    }

    private void applyLanguageButtons(String lang) {
        boolean pt = "pt-BR".equals(lang);
        boolean zh = !pt;
        // 蓝 = 选中，深灰 = 未选。两个按钮都必须能点（不能把选中的那个禁掉，否则会"卡死"）
        langZhButton.setBackgroundColor(zh ? 0xFF1565C0 : 0xFF263238);
        langPtButton.setBackgroundColor(pt ? 0xFF1565C0 : 0xFF263238);
        langZhButton.setEnabled(true);
        langPtButton.setEnabled(true);
    }

    // ── 校对开关（以电脑端为准）────────────────────────────────────────
    private void fetchProofread() {
        proofreadButton.setText("读取中…");
        new Thread(() -> {
            String text;
            Boolean value = null;
            try {
                JSONObject wrapper = client.settingsGet();
                JSONObject inner = unwrap(wrapper);
                if (inner != null && inner.has("proofread")) {
                    value = inner.optBoolean("proofread", false);
                    text = value ? "校对：开（点一下关掉）" : "校对：关（点一下打开）";
                } else {
                    text = "读不到校对开关（未连接或未登录）";
                }
            } catch (Exception error) {
                text = "读不到校对开关：" + brief(error);
            }
            final String label = text;
            final Boolean read = value;
            ui.post(() -> {
                proofread = read;
                proofreadButton.setText(label);
                proofreadButton.setBackgroundColor(
                        read != null && read ? 0xFF2E7D32 : 0xFF263238);
            });
        }, "settings-proofread-get").start();
    }

    private void toggleProofread() {
        if (proofread == null) {
            status.setText("还没读到校对开关，先确认服务器与登录状态");
            fetchProofread();
            return;
        }
        final boolean next = !proofread;
        proofreadButton.setEnabled(false);
        proofreadButton.setText("写入中…");
        new Thread(() -> {
            String failure = "";
            Boolean applied = null;
            try {
                JSONObject wrapper = client.settingsPutProofread(next);
                JSONObject inner = unwrap(wrapper);
                int code = wrapper == null ? 0 : wrapper.optInt("code", 0);
                if (code >= 400 || inner == null || !inner.optBoolean("ok", false)) {
                    failure = inner == null ? ("HTTP " + code) : inner.optString("error", "被拒绝");
                } else if (inner.has("proofread")) {
                    applied = inner.optBoolean("proofread", next);
                } else {
                    applied = next;
                }
            } catch (Exception error) {
                failure = brief(error);
            }
            final String error = failure;
            final Boolean result = applied;
            ui.post(() -> {
                proofreadButton.setEnabled(true);
                if (result == null) {
                    status.setText("校对开关设置失败：" + error);
                    fetchProofread();
                    return;
                }
                proofread = result;
                proofreadButton.setText(result ? "校对：开（点一下关掉）" : "校对：关（点一下打开）");
                proofreadButton.setBackgroundColor(result ? 0xFF2E7D32 : 0xFF263238);
                status.setText("校对已" + (result ? "打开" : "关闭") + "（下一场同传生效）");
            });
        }, "settings-proofread-put").start();
    }

    // ── 清空本机记录 ───────────────────────────────────────────────────
    private void clearRecords() {
        new android.app.AlertDialog.Builder(this)
                .setTitle("清空本机记录")
                .setMessage("会删掉手机里保存的全部历史记录（原文与译文）。服务器上的字幕不受影响。")
                .setNegativeButton("取消", null)
                .setPositiveButton("清空", (dialog, which) -> {
                    int removed = new Records(this).clearAll();
                    status.setText(removed > 0 ? ("已清空 " + removed + " 条本机记录") : "本机没有记录");
                    Toast.makeText(this, "已清空", Toast.LENGTH_SHORT).show();
                })
                .show();
    }

    // ── 小工具 ─────────────────────────────────────────────────────────
    /** `{ code, json }` 外壳 → 正文；已经是正文就原样返回。 */
    private static JSONObject unwrap(JSONObject raw) {
        if (raw == null) return null;
        if (raw.has("json")) {
            JSONObject inner = raw.optJSONObject("json");
            if (inner != null) return inner;
        }
        return raw;
    }

    private static String brief(Exception error) {
        String message = error.getMessage();
        return message == null ? error.getClass().getSimpleName() : message;
    }
}
