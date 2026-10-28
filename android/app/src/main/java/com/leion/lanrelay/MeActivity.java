package com.leion.lanrelay;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * 「我的」页面（4.62，结构由用户给定）。
 *
 * <pre>
 *   页面标题「我的」
 *   蓝绿色渐变个人卡片：头像 / 姓名 / 组织（角色）/ 服务版本
 *   一张白卡里四行：我的设备 · 术语库管理 · 翻译服务及有效状态 · 帮助与反馈
 *   退出登录
 *   底部一级导航
 * </pre>
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
    private TextView serviceSummary;

    private String userName = "";
    private String host = "";
    /** 服务端说的账号状态与到期时间（4.62 加进 whoami；老服务端没有这两项）。 */
    private String accountStatus = "";
    private String accountExpiresAt = "";
    private boolean online = false;
    /** 服务端的校对开关：null = 还没读到。 */
    private Boolean proofread = null;

    @Override
    protected void attachBaseContext(android.content.Context base) {
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        UiLang.trackShown(this);
        refreshAll();     // 从设置页回来时，服务摘要可能变了
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
        serviceSummary = findViewById(R.id.meServiceSummary);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        userName = prefs.getString("termsUser", "");
        host = prefs.getString("host", "");
        if (host == null || host.isEmpty()) host = getString(R.string.default_server_url);

        String token = prefs.getString("accountToken", "");
        client = new LanClient(host, prefs.getString("secret", ""), null);
        if (token != null && !token.isEmpty()) client.setToken(token);

        findViewById(R.id.meRowDevice).setOnClickListener(v -> showDeviceDetail());
        findViewById(R.id.meRowTerms).setOnClickListener(v ->
                startActivity(new Intent(this, TermLibActivity.class)));
        findViewById(R.id.meRowService).setOnClickListener(v ->
                startActivity(new Intent(this, SettingsActivity.class)));
        findViewById(R.id.meRowHelp).setOnClickListener(v -> showHelp());
        findViewById(R.id.meLogout).setOnClickListener(v -> confirmLogout());

        // 底部导航：首页跳回去；历史还没有内容；我的就是这一页
        // 首页那颗：回到返回栈里已有的首页（没有才新开），否则来回点会叠出一串首页
        findViewById(R.id.homeNavHome).setOnClickListener(v -> {
            Intent intent = new Intent(this, HomeActivity.class);
            intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(intent);
            finish();
        });
        findViewById(R.id.homeNavMe).setOnClickListener(v -> { });
        NavTabs.apply(this, NavTabs.ME);

        refreshAll();
        fetchAccount();
        fetchProofread();
    }

    // ── 个人卡片 ────────────────────────────────────────────────────────
    private void refreshAll() {
        String shown = userName == null ? "" : userName;
        nameView.setText(shown);
        avatar.setText(firstChar(shown));
        orgView.setText(orgLabel());
        versionView.setText(getString(R.string.me_version, appVersion(),
                appVersionCode()));
        refreshDevice();
        refreshService();
    }

    /**
     * 组织那一行：服务端只告诉我们角色（admin / user / dev）。
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

    // ── 翻译服务及有效状态 ──────────────────────────────────────────────
    private void refreshService() {
        if (serviceSummary == null) return;
        String proof = proofread == null ? getString(R.string.me_service_proof_unknown)
                : getString(proofread ? R.string.me_service_proof_on : R.string.me_service_proof_off);
        serviceSummary.setText(getString(R.string.me_service_summary,
                host == null || host.isEmpty() ? getString(R.string.me_service_no_host) : host,
                proof, validityText()));
    }

    /** 有效期那句话：老服务端不返回 expiresAt → 明确说"未知"，不假装长期有效。 */
    private String validityText() {
        if ("disabled".equals(accountStatus)) return getString(R.string.me_service_disabled);
        if (accountExpiresAt == null || accountExpiresAt.isEmpty()) {
            return getString(R.string.me_service_unknown);
        }
        try {
            // 服务端给的是 ISO-8601（2026-11-05T10:00:00.000Z），只取日期部分给人看
            String date = accountExpiresAt;
            int cut = date.indexOf('T');
            if (cut > 0) date = date.substring(0, cut);
            return getString(R.string.me_service_expires, date);
        } catch (Exception error) {
            return getString(R.string.me_service_unknown);
        }
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
                    accountStatus = result.optString("status", "");
                    accountExpiresAt = result.optString("expiresAt", "");
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                            .putString("role", role).putString("termsUser", user).apply();
                    userName = user;
                }
                refreshAll();
            });
        }, "me-account").start();
    }

    private void fetchProofread() {
        new Thread(() -> {
            Boolean value = null;
            try {
                JSONObject body = client.settingsGet();
                if (body != null && body.optBoolean("ok", false)) {
                    value = body.optBoolean("proofread", false);
                }
            } catch (Exception ignored) {
                // 读不到就显示"未知"，不猜
            }
            final Boolean read = value;
            if (read == null) return;
            ui.post(() -> {
                proofread = read;
                refreshService();
            });
        }, "me-proofread").start();
    }

    // ── 帮助与反馈 ──────────────────────────────────────────────────────
    private void showHelp() {
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.me_help_title)
                .setMessage(getString(R.string.me_help_body,
                        appVersion(), host == null || host.isEmpty() ? "—" : host))
                .setPositiveButton(R.string.me_help_privacy, (dialog, which) ->
                        startActivity(new Intent(this, PrivacyActivity.class)))
                .setNegativeButton(R.string.common_close, null)
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
