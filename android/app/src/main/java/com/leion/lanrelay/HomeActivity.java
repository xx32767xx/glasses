package com.leion.lanrelay;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * HomeActivity —— 新的 App 入口（P3.5）：① 登录/注册  →  ② 首页（建房/加入/设置）。
 *
 * 规则（用户 2026-10-27 定）：
 *   - **打开 App 先看到登录/注册**，登录之后才看到 App 本体；
 *   - 旧界面（MainActivity）保留但不再是入口，首页里给一个「旧版界面」按钮（方便对比/回退）。
 *
 * 设计取舍：先做成一个 Activity 内两态切换（登录态 / 已登录态），
 * 少一个 Activity 就少一处状态同步，稳定性优先。
 */
public class HomeActivity extends android.app.Activity {

    private static final String PREFS = "leion";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LanClient client;

    /** 会话监听（4.41）：被别处登录顶掉时当场提示，而不是静默。 */
    private SessionWatch sessionWatch;

    private LinearLayout loginBox;
    private LinearLayout homeBox;
    private EditText serverInput;
    private EditText secretInput;
    private EditText userInput;
    private EditText passInput;
    private EditText emailInput;
    private EditText codeInput;
    private TextView status;
    private Button loginButton;
    private Button registerButton;
    private Button sendCodeButton;
    private TextView whoLine;

    private boolean registerMode = false;
    /** 屏幕调试行（无 adb 时靠它定位） */
    private final java.util.ArrayDeque<String> debugLines = new java.util.ArrayDeque<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_home);

        loginBox = findViewById(R.id.homeLoginBox);
        homeBox = findViewById(R.id.homeMainBox);
        serverInput = findViewById(R.id.homeServer);
        secretInput = findViewById(R.id.homeSecret);
        userInput = findViewById(R.id.homeUser);
        passInput = findViewById(R.id.homePass);
        emailInput = findViewById(R.id.homeEmail);
        codeInput = findViewById(R.id.homeCode);
        status = findViewById(R.id.homeStatus);
        loginButton = findViewById(R.id.homeLogin);
        registerButton = findViewById(R.id.homeRegisterToggle);
        sendCodeButton = findViewById(R.id.homeSendCode);
        whoLine = findViewById(R.id.homeWho);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverInput.setText(prefs.getString("host", ""));
        secretInput.setText(prefs.getString("secret", ""));
        client = new LanClient(prefs.getString("host", ""), prefs.getString("secret", ""), null);

        loginButton.setOnClickListener(v -> doLogin());
        registerButton.setOnClickListener(v -> toggleRegisterMode());
        sendCodeButton.setOnClickListener(v -> sendCode());
        findViewById(R.id.homeCreate).setOnClickListener(v -> openRooms());
        findViewById(R.id.homeSettings).setOnClickListener(v ->
                startActivity(new Intent(this, SettingsActivity.class)));
        findViewById(R.id.homeLegacy).setOnClickListener(v ->
                startActivity(new Intent(this, MainActivity.class)));
        findViewById(R.id.homeLogout).setOnClickListener(v -> logout());

        // 版本号显示在状态行，便于确认"装的是不是最新构建"
        applyMode();
        restoreSession();
    }

    /**
     * 有 token 且 whoami 还认它 → 直接进已登录态（省一次登录）。
     *
     * <p><b>三种结果必须分开处理（4.33 修）</b>：
     * <pre>
     *   200 + ok:true   → 认；进首页
     *   401             → **真的**失效（在别处登录 / 会话被吊销）：清本地 token，回登录页并说清原因
     *   连不上服务器    → **不许**当掉登录：网络抖一下就踢回登录页，用户会以为"莫名其妙掉登录"，
     *                     而重新登录又会吊销另一台手机的 token（单会话），把问题扩大成两台都掉
     * </pre>
     * 旧版把"连不上"和"401"混成了一个 false，所以启动时几乎必然判成未登录。
     */
    private void restoreSession() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        final String token = prefs.getString("accountToken", "");
        final String user = prefs.getString("termsUser", "");
        if (token == null || token.isEmpty() || user == null || user.isEmpty()) {
            showLogin();
            return;
        }
        client.setToken(token);
        new Thread(() -> {
            JSONObject who = null;
            String failure = "";
            try {
                who = client.authWhoAmI();          // 已拆包，含 _status
            } catch (Exception e) {
                failure = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject body = who;
            final String error = failure;
            ui.post(() -> {
                if (body == null) {
                    // 连不上服务器：保留登录态，先按已登录进首页；真正的失效会在下一次请求里暴露
                    showHome(user, "");
                    status.setText("离线：连不上服务器（" + error + "），登录状态先保留");
                    debugLine("restore offline: " + error);
                    return;
                }
                int code = body.optInt("_status", 0);
                if (body.optBoolean("ok", false)) {
                    showHome(body.optString("user", user), body.optString("role", ""));
                    return;
                }
                if (code == 401) {
                    String hint = body.optString("hint", body.optString("error", ""));
                    prefs.edit().remove("accountToken").remove("termsUser").remove("roomHost").apply();
                    client.setToken("");
                    showLogin();
                    status.setText("登录已失效，请重新登录"
                            + (hint.isEmpty() ? "" : ("（" + hint + "）")));
                    debugLine("restore 401: " + hint);
                    return;
                }
                // 其他非 2xx：服务端有问题，但**不一定**是会话失效 —— 同样不动登录态
                showHome(user, "");
                status.setText("无法确认登录状态（HTTP " + code + "），登录状态先保留");
                debugLine("restore unexpected: " + body);
            });
        }, "home-restore").start();
    }

    private void applyMode() {
        emailInput.setVisibility(registerMode ? View.VISIBLE : View.GONE);
        codeInput.setVisibility(registerMode ? View.VISIBLE : View.GONE);
        sendCodeButton.setVisibility(registerMode ? View.VISIBLE : View.GONE);
        loginButton.setText(registerMode ? "注册并登录" : "登录");
        registerButton.setText(registerMode ? "已有账号？去登录" : "注册新账号");
        if (debugLines.isEmpty()) {
            status.setText(registerMode ? "注册需要邮箱 + 验证码（点击获取验证码）" : "用用户名 + 密码登录");
        }
    }

    private void toggleRegisterMode() {
        registerMode = !registerMode;
        // 版本号显示在状态行，便于确认"装的是不是最新构建"
        applyMode();
    }

    private void showLogin() {
        loginBox.setVisibility(View.VISIBLE);
        homeBox.setVisibility(View.GONE);
    }

    private void showHome(String user, String role) {
        loginBox.setVisibility(View.GONE);
        homeBox.setVisibility(View.VISIBLE);
        whoLine.setText(user + (role.isEmpty() ? "" : " · " + role));
        status.setText("已登录");
        startSessionWatch();
    }

    /**
     * 开始盯着"我这台还登录着吗"（4.41）。
     *
     * <p>为什么必须在首页也盯着：单会话下，另一台一登录这台就被吊销 token，
     * 而它如果正停在首页等着，**永远不会知道**（用户 2026-10-27 报的静默）。
     */
    private void startSessionWatch() {
        if (sessionWatch != null) sessionWatch.stop();
        sessionWatch = new SessionWatch(client, message -> ui.post(() -> {
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
            status.setText(message);
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .remove("accountToken").remove("termsUser").remove("roomHost").apply();
            client.setToken("");
            showLogin();
        }));
        sessionWatch.start();
    }

    @Override
    protected void onDestroy() {
        if (sessionWatch != null) {
            sessionWatch.stop();
            sessionWatch = null;
        }
        super.onDestroy();
    }

    private void sendCode() {
        final String email = emailInput.getText().toString().trim();
        if (email.isEmpty()) {
            Toast.makeText(this, "先填邮箱", Toast.LENGTH_SHORT).show();
            return;
        }
        sendCodeButton.setEnabled(false);
        new Thread(() -> {
            JSONObject body = null;
            String error = "";
            try {
                body = client.authRequestCode(email);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject result = unwrapLogin(body);
            final String failure = error;
            ui.post(() -> {
                sendCodeButton.setEnabled(true);
                if (result != null && result.optBoolean("ok", false)) {
                    String code = result.optString("code", "");
                    status.setText(code.isEmpty() ? "验证码已发送到邮箱" : ("验证码：" + code + "（开发环境直接返回）"));
                } else {
                    status.setText("获取验证码失败：" + (result == null ? failure : result.optString("error", failure)));
                }
            });
        }, "home-code").start();
    }

    /** 规整服务器地址：没写协议就补 http://（`no protocol: /auth/login` 就是这么来的）。 */
    private static String normalizeHost(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return "";
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        return value;
    }

    /** requestWithCode 返回的是 {code, json} 包一层；登录/注册要的是里面那层。 */
    private static JSONObject unwrapLogin(JSONObject raw) {
        if (raw == null) {
            return null;
        }
        if (raw.has("code") && raw.has("json")) {
            JSONObject inner = raw.optJSONObject("json");
            if (inner != null) {
                return inner;
            }
        }
        return raw;
    }
    /** 状态区追加一行调试信息（同时写 logcat），没有 adb 也能看到。 */
    private void debugLine(final String text) {
        String stamp = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(new java.util.Date());
        Log.i("LeionHome", text);
        runOnUiThread(new Runnable() {
            public void run() {
                debugLines.addLast(stamp + " " + text);
                while (debugLines.size() > 7) {
                    debugLines.removeFirst();
                }
                StringBuilder sb = new StringBuilder();
                for (String line : debugLines) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(line);
                }
                status.setText(sb.toString());
            }
        });
    }

    private void doLogin() {
        final String host = normalizeHost(serverInput.getText().toString());
        final String secret = secretInput.getText().toString().trim();
        if (host.isEmpty()) {
            status.setText("先填服务器地址，例如 http://117.50.180.93:8788");
            Toast.makeText(this, "缺少服务器地址", Toast.LENGTH_SHORT).show();
            return;
        }
        if (secret.isEmpty()) {
            status.setText("先填共享密钥（服务器 start-all 横幅里打印的那串）");
            Toast.makeText(this, "缺少共享密钥", Toast.LENGTH_SHORT).show();
            return;
        }
        // 地址或密钥变了 → 重建客户端（否则还在用启动时那份空配置）
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("host", host).putString("secret", secret).apply();
        if (client == null || !host.equals(client.getBaseUrl()) || !secret.equals(client.getSecret())) {
            String token = getSharedPreferences(PREFS, MODE_PRIVATE).getString("accountToken", "");
            client = new LanClient(host, secret, null);
            if (token != null && !token.isEmpty()) client.setToken(token);
        }
        final String user = userInput.getText().toString().trim();
        final String pass = passInput.getText().toString();
        final String email = emailInput.getText().toString().trim();
        final String code = codeInput.getText().toString().trim();
        if (user.isEmpty() || pass.isEmpty()) {
            Toast.makeText(this, "用户名和密码都要填", Toast.LENGTH_SHORT).show();
            return;
        }
        if (registerMode && (email.isEmpty() || code.isEmpty())) {
            Toast.makeText(this, "注册需要邮箱和验证码", Toast.LENGTH_SHORT).show();
            return;
        }
        debugLine("tap login host=" + host + " secretLen=" + secret.length() + " user=" + user);
        loginButton.setEnabled(false);
        status.setText(registerMode ? "注册中…" : "登录中…");
        new Thread(() -> {
            JSONObject body = null;
            String error = "";
            try {
                body = registerMode
                        ? client.authRegisterEmail(email, user, pass, code)
                        : client.authLogin(user, pass);
            } catch (Throwable e) {
                error = e.getClass().getSimpleName() + ": " + (e.getMessage() == null ? "" : e.getMessage());
                Log.e("LeionHome", "login failed", e);
            }
            final JSONObject result = unwrapLogin(body);
            final String failure = error;
            ui.post(() -> {
                loginButton.setEnabled(true);
                debugLine(result == null ? ("exception " + failure) : ("response ok=" + result.optBoolean("ok", false)));
                Log.i("LeionHome", "login result=" + result + " failure=" + failure);
                if (result == null || !result.optBoolean("ok", false)) {
                    String reason = failure;
                    if (result != null) {
                        String hint = result.optString("hint", "");
                        reason = hint.isEmpty() ? result.optString("error", failure) : hint;
                    }
                    status.setText((registerMode ? "注册失败：" : "登录失败：") + reason);
                    Toast.makeText(this, reason, Toast.LENGTH_LONG).show();
                    debugLine("fail: " + reason);
                    return;
                }
                String token = result.optString("token", "");
                String name = result.optString("user", user);
                String role = result.optString("role", "");
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString("accountToken", token)
                        .putString("termsUser", name)
                        .apply();
                client.setToken(token);
                showHome(name, role);
            });
        }, "home-login").start();
    }

    private void logout() {
        new Thread(() -> {
            try {
                client.authLogout();
            } catch (Exception ignored) {
                // 注销失败也要清本地，否则用户卡在"以为注销了"
            }
            ui.post(() -> {
                if (sessionWatch != null) {
                    sessionWatch.stop();
                    sessionWatch = null;
                }
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .remove("accountToken").remove("termsUser").remove("roomHost").apply();
                client.setToken("");
                showLogin();
                status.setText("已注销");
            });
        }, "home-logout").start();
    }

    private void openRooms() {
        startActivity(new Intent(this, RoomsActivity.class));
    }
}
