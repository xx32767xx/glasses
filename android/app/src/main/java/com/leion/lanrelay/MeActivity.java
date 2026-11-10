package com.leion.lanrelay;

import android.content.Intent;
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
 * 「我的」页面（4.62 结构 → 5.145 重构）。
 *
 * <pre>
 *   页面标题「我的」
 *   蓝绿色渐变个人卡片：头像 / 姓名 / 角色 / 版本
 *   白卡一：我的设备 · 术语库管理 · 眼镜投屏 · 隐私政策 · 清空本机记录 · 开发者模式
 *   白卡二：服务器（地址 / 密钥 / 保存）
 *   退出登录
 *   底部一级导航
 * </pre>
 *
 * <p>5.145（用户要求）：原来点「翻译服务及有效状态」进的那一页设置，去掉
 * 「我在会里说哪种语言 / 界面语言 / 译文校对」三项与顶部状态白框之后，剩下的
 * （服务器、隐私、清空本机记录、开发者模式）**搬到了本页**，那个设置页随之删除。
 * 「帮助与反馈」那一行也删掉了 —— 里面的内容已经太旧（用户要求整段去掉）。
 *
 * <p>⚠️ 这里**不实现**任何"改库"能力：术语库只能提申请（见 {@link TermLibActivity}）。
 */
public class MeActivity extends android.app.Activity {

    private static final String PREFS = "leion";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LanClient client;

    private TextView avatar;
    private TextView nameView;
    private TextView orgView;
    private TextView versionView;
    private TextView deviceSummary;
    private TextView deviceState;
    private EditText serverInput;
    private EditText secretInput;
    private android.widget.Switch devSwitch;

    private String userName = "";
    private String host = "";
    private String secret = "";
    private boolean online = false;

    @Override
    protected void attachBaseContext(android.content.Context base) {
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        UiLang.trackShown(this);
        refreshAll();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_me);

        avatar = findViewById(R.id.meAvatar);
        nameView = findViewById(R.id.meName);
        orgView = findViewById(R.id.meOrg);
        versionView = findViewById(R.id.meVersion);
        deviceSummary = findViewById(R.id.meDeviceSummary);
        deviceState = findViewById(R.id.meDeviceState);
        serverInput = findViewById(R.id.meServer);
        secretInput = findViewById(R.id.meSecret);
        devSwitch = findViewById(R.id.meDevSwitch);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        userName = prefs.getString("termsUser", "");
        // 5.155：用户存过的优先，其次打包进 APK 的出厂值（唯一入口是 ServerPreset）
        host = ServerPreset.host(this);
        secret = ServerPreset.secret(this);
        serverInput.setText(host);
        secretInput.setText(secret);

        String token = prefs.getString("accountToken", "");
        client = new LanClient(host, secret, null);
        if (token != null && !token.isEmpty()) client.setToken(token);

        findViewById(R.id.meRowDevice).setOnClickListener(v -> showDeviceDetail());
        findViewById(R.id.meRowTerms).setOnClickListener(v ->
                startActivity(new Intent(this, TermLibActivity.class)));
        // 5.139：眼镜投屏入口（用户要求：眼镜属于"设备"，放在「我的」而不是设置里）
        findViewById(R.id.meRowGlasses).setOnClickListener(v ->
                startActivity(new Intent(this, GlassesCastActivity.class)));
        // 5.145：隐私 / 清空本机记录 / 开发者模式从设置页搬到这里
        findViewById(R.id.meRowPrivacy).setOnClickListener(v ->
                startActivity(new Intent(this, PrivacyActivity.class)));
        findViewById(R.id.meRowClear).setOnClickListener(v -> confirmClearRecords());
        applyDevSwitch(DevMode.enabled(this));
        findViewById(R.id.meRowDev).setOnClickListener(v -> {
            boolean next = DevMode.toggle(this);
            applyDevSwitch(next);
            Toast.makeText(this, getString(next ? R.string.settings_developer_on
                    : R.string.settings_developer_off), Toast.LENGTH_SHORT).show();
        });
        findViewById(R.id.meSaveServer).setOnClickListener(v -> saveConnection());
        findViewById(R.id.meLogout).setOnClickListener(v -> confirmLogout());

        // 底部导航（4.93）：统一走 NavTabs.go —— 交叉淡化换页，栈里最多留「首页 + 当前页」。
        findViewById(R.id.homeNavHome).setOnClickListener(v -> NavTabs.go(this, NavTabs.HOME));
        findViewById(R.id.homeNavMe).setOnClickListener(v -> { });
        findViewById(R.id.homeNavHistory).setOnClickListener(v -> NavTabs.go(this, NavTabs.HISTORY));
        NavTabs.apply(this, NavTabs.ME);

        refreshAll();
        fetchAccount();
    }

    private void applyDevSwitch(boolean enabled) {
        if (devSwitch != null) devSwitch.setChecked(enabled);
    }

    // ── 个人卡片 ────────────────────────────────────────────────────────
    /**
     * 返回键也走同一套淡化（4.93）：点导航切页是淡化，按返回键却还是"从右侧推回"，
     * 同一件事两种动画，看着像两个不同的机制在抢。
     */
    @Override
    public void onBackPressed() {
        super.onBackPressed();
        overridePendingTransition(R.anim.nav_fade_in, R.anim.nav_fade_out);
    }

    private void refreshAll() {
        String shown = userName == null ? "" : userName;
        nameView.setText(shown);
        avatar.setText(firstChar(shown));
        orgView.setText(orgLabel());
        versionView.setText(getString(R.string.me_version, appVersion(),
                appVersionCode()));
        refreshDevice();
    }

    /**
     * 角色那一行：服务端只告诉我们角色（admin / user / dev）。
     *
     * <p>为什么不显示"某某公司"：这套系统里没有组织信息，编一个组织名等于骗人。
     * 角色 + 账号类型是真实有的信息。
     */
    private String orgLabel() {
        String role = getSharedPreferences(PREFS, MODE_PRIVATE).getString("role", "");
        if ("admin".equals(role)) return getString(R.string.me_org_role_admin);
        if ("dev".equals(role)) return getString(R.string.me_org_role_dev);
        return getString(R.string.me_org_role_user);
    }

    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception error) {
            return "?";
        }
    }

    private int appVersionCode() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception error) {
            return 0;
        }
    }

    // ── 我的设备 ────────────────────────────────────────────────────────
    private String deviceName() {
        String brand = android.os.Build.MANUFACTURER == null ? "" : android.os.Build.MANUFACTURER.trim();
        String model = android.os.Build.MODEL == null ? "" : android.os.Build.MODEL.trim();
        // 很多国产 ROM 的 MODEL 已经自带品牌名（"Redmi Note 12"），别拼成 "Xiaomi Redmi Note 12"
        String name = model.isEmpty() ? brand : model;
        if (!brand.isEmpty() && !model.toLowerCase(java.util.Locale.ROOT).startsWith(brand.toLowerCase(java.util.Locale.ROOT))) {
            name = brand + " " + model;
        }
        return name.trim().isEmpty() ? getString(R.string.me_device_unknown) : name.trim();
    }

    private void refreshDevice() {
        deviceSummary.setText(getString(R.string.me_device_summary, deviceName(),
                android.os.Build.VERSION.RELEASE == null ? "?" : android.os.Build.VERSION.RELEASE));
        deviceState.setText(getString(online ? R.string.state_online : R.string.state_offline));
        deviceState.setTextColor(getColor(online ? R.color.ok : R.color.ink_faint));
        deviceState.setBackgroundResource(online ? R.drawable.bg_chip_brand : R.drawable.bg_chip);
    }

    private void showDeviceDetail() {
        String state = getString(online ? R.string.state_online : R.string.state_offline);
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.me_device_detail_title)
                .setMessage(getString(R.string.me_device_detail, deviceName(),
                        android.os.Build.VERSION.RELEASE == null ? "?" : android.os.Build.VERSION.RELEASE,
                        host, state))
                .setPositiveButton(R.string.common_close, null)
                .show();
    }

    private void fetchAccount() {
        new Thread(() -> {
            JSONObject body = null;
            try {
                body = client.authWhoAmI();
            } catch (Exception ignored) {
                // 连不上：保持"离线"，别把界面刷成红色报错
            }
            final JSONObject result = body;
            ui.post(() -> {
                online = result != null && result.optBoolean("ok", false);
                if (online) {
                    String role = result.optString("role", "");
                    String user = result.optString("user", userName);
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                            .putString("role", role).putString("termsUser", user).apply();
                    userName = user;
                }
                refreshAll();
            });
        }, "me-account").start();
    }

    // ── 服务器（5.145：从设置页搬来）─────────────────────────────────────
    private void saveConnection() {
        String nextHost = normalizeHost(serverInput.getText().toString());
        String nextSecret = secretInput.getText().toString().trim();
        if (nextHost.isEmpty()) {
            Toast.makeText(this, getString(R.string.st_conn_empty), Toast.LENGTH_SHORT).show();
            return;
        }
        if (nextSecret.isEmpty()) {
            Toast.makeText(this, getString(R.string.st_secret_empty), Toast.LENGTH_SHORT).show();
            return;
        }
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        boolean changedHost = !nextHost.equals(prefs.getString("host", ""));
        prefs.edit().putString("host", nextHost).putString("secret", nextSecret).apply();
        host = nextHost;
        secret = nextSecret;
        // 客户端是按"地址 + 密钥"建出来的，换了就必须重建，否则还在用旧的
        client = new LanClient(nextHost, nextSecret, null);
        String token = prefs.getString("accountToken", "");
        if (token != null && !token.isEmpty()) client.setToken(token);
        Toast.makeText(this, getString(changedHost ? R.string.st_saved_relogin : R.string.st_saved),
                Toast.LENGTH_SHORT).show();
        fetchAccount();
    }

    private static String normalizeHost(String raw) {
        String text = raw == null ? "" : raw.trim();
        if (text.isEmpty()) return "";
        if (!text.startsWith("http://") && !text.startsWith("https://")) {
            text = "http://" + text;
        }
        while (text.endsWith("/")) {
            text = text.substring(0, text.length() - 1);
        }
        return text;
    }

    // ── 清空本机记录（5.145：从设置页搬来）──────────────────────────────
    private void confirmClearRecords() {
        new android.app.AlertDialog.Builder(this)
                .setTitle(getString(R.string.clear_title))
                .setMessage(getString(R.string.clear_msg))
                .setNegativeButton(getString(R.string.common_cancel), null)
                .setPositiveButton(getString(R.string.clear_positive), (dialog, which) -> {
                    int removed = new Records(this).clearAll();
                    Toast.makeText(this, removed > 0
                            ? getString(R.string.st_cleared, removed)
                            : getString(R.string.st_no_records), Toast.LENGTH_SHORT).show();
                })
                .show();
    }

    // ── 退出登录 ────────────────────────────────────────────────────────
    private void confirmLogout() {
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.home_logout)
                .setMessage(R.string.me_logout_confirm)
                .setNegativeButton(R.string.common_cancel, null)
                .setPositiveButton(R.string.home_logout, (dialog, which) -> doLogout())
                .show();
    }

    private void doLogout() {
        final String token = getSharedPreferences(PREFS, MODE_PRIVATE).getString("accountToken", "");
        new Thread(() -> {
            try {
                client.authLogout();
            } catch (Exception ignored) {
                // 注销失败也要清本地（否则用户卡在"以为注销了"）
            }
            ui.post(() -> {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .remove("accountToken").remove("termsUser")
                        .remove("roomHost").remove("role").apply();
                client.setToken("");
                Toast.makeText(this, getString(R.string.me_logged_out), Toast.LENGTH_SHORT).show();
                // 直接回首页：那里会自动落到登录页
                Intent intent = new Intent(this, HomeActivity.class);
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                startActivity(intent);
                finish();
            });
        }, "me-logout").start();
    }

    private String firstChar(String raw) {
        if (raw == null || raw.isEmpty()) return "?";
        return raw.substring(0, 1).toUpperCase(java.util.Locale.ROOT);
    }
}
