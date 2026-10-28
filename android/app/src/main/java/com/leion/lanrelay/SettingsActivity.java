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
    /** 界面语言（4.56）：只换界面文字，与上面那两颗「我说话用什么语言」无关。 */
    private Button uiLangZhButton;
    private Button uiLangPtButton;
    private Button uiLangEnButton;

    /** 服务端当前的校对开关（null = 还没读到）。 */
    private Boolean proofread = null;

    @Override
    protected void attachBaseContext(android.content.Context base) {
        // 4.56：界面语言必须在这里换（三套资源在 values-en / values-pt-rBR）
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        UiLang.trackShown(this);   // 别处改过界面语言，回到本页要跟上（会自己 recreate）
    }

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
        uiLangZhButton = findViewById(R.id.setAppUiLangZh);
        uiLangPtButton = findViewById(R.id.setAppUiLangPt);
        uiLangEnButton = findViewById(R.id.setAppUiLangEn);
        refreshUiLangButtons();

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
        uiLangZhButton.setOnClickListener(v -> applyUiLang(UiLang.ZH));
        uiLangPtButton.setOnClickListener(v -> applyUiLang(UiLang.PT));
        uiLangEnButton.setOnClickListener(v -> applyUiLang(UiLang.EN));
        langZhButton.setOnClickListener(v -> setSpeakLanguage("zh-CN"));
        langPtButton.setOnClickListener(v -> setSpeakLanguage("pt-BR"));
        proofreadButton.setOnClickListener(v -> toggleProofread());
        findViewById(R.id.setAppPrivacy).setOnClickListener(v ->
                startActivity(new android.content.Intent(this, PrivacyActivity.class)));
        findViewById(R.id.setAppClearRecords).setOnClickListener(v -> clearRecords());
        findViewById(R.id.setAppBack).setOnClickListener(v -> finish());

        TextView version = findViewById(R.id.setAppVersion);
        version.setText(appVersion());

        status.setText(getString(R.string.set_status_hint));
        fetchProofread();
    }

    /**
     * 换界面语言（4.56）：存下来再重建本页。
     *
     * <p>只在这一页生效是不够的 —— 别的页面回到前台时靠 {@code UiLang.trackShown()} 自己重建，
     * 所以用户从设置页切完语言再返回房间列表，列表也是新语言。
     */
    private void applyUiLang(String tag) {
        if (tag.equals(UiLang.saved(this))) return;
        UiLang.save(this, tag);
        recreate();
    }

    /** 当前生效的那颗用品牌色文字，其余用主色。 */
    private void refreshUiLangButtons() {
        String cur = UiLang.effective(this);
        String[] tags = {UiLang.ZH, UiLang.PT, UiLang.EN};
        Button[] buttons = {uiLangZhButton, uiLangPtButton, uiLangEnButton};
        for (int i = 0; i < buttons.length; i++) {
            if (buttons[i] == null) continue;
            boolean on = tags[i].equals(cur);
            buttons[i].setTextColor(getColor(on ? R.color.brand : R.color.ink));
            buttons[i].setTypeface(null, on ? android.graphics.Typeface.BOLD
                    : android.graphics.Typeface.NORMAL);
        }
    }

    private String appVersion() {
        try {
            android.content.pm.PackageInfo info =
                    getPackageManager().getPackageInfo(getPackageName(), 0);
            return getString(R.string.brand_version, info.versionName, info.versionCode);
        } catch (Exception error) {
            return getString(R.string.app_brand);
        }
    }

    // ── 连接 ────────────────────────────────────────────────────────────
    private void saveConnection() {
        String host = normalizeHost(serverInput.getText().toString());
        String secret = secretInput.getText().toString().trim();
        if (host.isEmpty()) {
            status.setText(getString(R.string.st_conn_empty));
            return;
        }
        if (secret.isEmpty()) {
            status.setText(getString(R.string.st_secret_empty));
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
                ? getString(R.string.st_saved_conn)
                : getString(R.string.st_saved_relogin));
        Toast.makeText(this, getString(R.string.st_saved), Toast.LENGTH_SHORT).show();
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
        status.setText(getString(R.string.st_set_to, "pt-BR".equals(lang)
                ? getString(R.string.rooms_speak_pt) : getString(R.string.rooms_speak_zh))
                + getString(R.string.suffix_next_meeting));
    }

    private void applyLanguageButtons(String lang) {
        boolean pt = "pt-BR".equals(lang);
        boolean zh = !pt;
        // 蓝 = 选中，深灰 = 未选。两个按钮都必须能点（不能把选中的那个禁掉，否则会"卡死"）
        langZhButton.setBackgroundResource(zh ? R.drawable.bg_pill_active : R.drawable.bg_pill);
        langPtButton.setBackgroundResource(pt ? R.drawable.bg_pill_active : R.drawable.bg_pill);
        langZhButton.setTextColor(getColor(zh ? R.color.on_brand : R.color.ink));
        langPtButton.setTextColor(getColor(pt ? R.color.on_brand : R.color.ink));
        langZhButton.setEnabled(true);
        langPtButton.setEnabled(true);
    }

    // ── 校对开关（以电脑端为准）────────────────────────────────────────
    private void fetchProofread() {
        proofreadButton.setText(getString(R.string.set_loading));
        new Thread(() -> {
            String text;
            Boolean value = null;
            try {
                JSONObject wrapper = client.settingsGet();
                JSONObject inner = unwrap(wrapper);
                if (inner != null && inner.has("proofread")) {
                    value = inner.optBoolean("proofread", false);
                    text = value ? getString(R.string.proof_on) : getString(R.string.proof_off);
                } else {
                    text = getString(R.string.proof_unread);
                }
            } catch (Exception error) {
                text = getString(R.string.proof_unread_reason, ServerText.of(this, brief(error)));
            }
            final String label = text;
            final Boolean read = value;
            ui.post(() -> {
                proofread = read;
                proofreadButton.setText(label);
                applyProofreadLook(read != null && read);
            });
        }, "settings-proofread-get").start();
    }

    private void toggleProofread() {
        if (proofread == null) {
            status.setText(getString(R.string.proof_need_conn));
            fetchProofread();
            return;
        }
        final boolean next = !proofread;
        proofreadButton.setEnabled(false);
        proofreadButton.setText(getString(R.string.set_writing));
        new Thread(() -> {
            String failure = "";
            Boolean applied = null;
            try {
                JSONObject wrapper = client.settingsPutProofread(next);
                JSONObject inner = unwrap(wrapper);
                int code = wrapper == null ? 0 : wrapper.optInt("code", 0);
                if (code >= 400 || inner == null || !inner.optBoolean("ok", false)) {
                    failure = inner == null ? ("HTTP " + code)
                            : ServerText.from(this, inner, getString(R.string.reason_rejected));
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
                    status.setText(getString(R.string.st_write_failed, ServerText.of(this, error)));
                    fetchProofread();
                    return;
                }
                proofread = result;
                proofreadButton.setText(result ? getString(R.string.proof_on) : getString(R.string.proof_off));
                applyProofreadLook(result);
                status.setText(getString(R.string.st_proof_set, result ? getString(R.string.proof_on_word) : getString(R.string.proof_off_word)));
            });
        }, "settings-proofread-put").start();
    }

    // ── 清空本机记录 ───────────────────────────────────────────────────
    private void clearRecords() {
        new android.app.AlertDialog.Builder(this)
                .setTitle(getString(R.string.clear_title))
                .setMessage(getString(R.string.clear_msg))
                .setNegativeButton(getString(R.string.common_cancel), null)
                .setPositiveButton(getString(R.string.clear_positive), (dialog, which) -> {
                    int removed = new Records(this).clearAll();
                    status.setText(removed > 0 ? getString(R.string.st_cleared, removed) : getString(R.string.st_no_records));
                    Toast.makeText(this, getString(R.string.toast_cleared), Toast.LENGTH_SHORT).show();
                })
                .show();
    }

    /** 校对按钮的外观：开着 = 主色实底（绿太跳，且语义是"已启用"不是"正常"）。 */
    private void applyProofreadLook(boolean enabled) {
        proofreadButton.setBackgroundResource(enabled ? R.drawable.bg_pill_active : R.drawable.tap_btn_secondary);
        proofreadButton.setTextColor(getColor(enabled ? R.color.on_brand : R.color.ink));
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
