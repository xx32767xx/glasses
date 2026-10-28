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

    /** 会话推送通道（4.45）：把"被顶下线"的延迟从最多 10 秒压到一秒内。 */
    private SessionSocket sessionSocket;

    private LinearLayout loginBox;
    private LinearLayout homeBox;
    private LinearLayout serverBox;
    private EditText serverInput;
    private EditText secretInput;
    private EditText userInput;
    private EditText passInput;
    private EditText emailInput;
    private EditText codeInput;
    private TextView status;
    private Button loginButton;
    private Button sendCodeButton;
    private TextView whoLine;
    private TextView langZhButton;
    private TextView langPtButton;
    private TextView serverToggle;
    private android.widget.CheckBox agreeBox;
    private LinearLayout emailRow;
    private TextView registerToggle;

    /**
     * 当前是"注册"还是"登录"（4.50）。
     *
     * <p>为什么要这个开关：登录根本用不到邮箱和验证码，一直摆着只会让人以为"都要填"。
     * 原型虽然只有一个「注册／登录」按钮，但表单里那几项只在注册时有意义 ——
     * 所以做成**一个按钮 + 一个切换链接**：登录态只留 用户名/密码，注册态才放出邮箱与验证码。
     */
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
        sendCodeButton = findViewById(R.id.homeSendCode);
        whoLine = findViewById(R.id.homeWho);
        langZhButton = findViewById(R.id.homeLangZh);
        langPtButton = findViewById(R.id.homeLangPt);
        emailRow = findViewById(R.id.homeEmailRow);
        registerToggle = findViewById(R.id.homeRegisterToggle);
        serverToggle = findViewById(R.id.homeServerToggle);
        serverBox = findViewById(R.id.homeServerBox);
        agreeBox = findViewById(R.id.homeAgree);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // 出厂默认值（res/values/app_config.xml）：装了就能用，用户仍可在「服务器设置（高级）」里改
        String host = prefs.getString("host", "");
        if (host == null || host.isEmpty()) host = getString(R.string.default_server_url);
        String secret = prefs.getString("secret", "");
        if (secret == null || secret.isEmpty()) secret = getString(R.string.default_shared_secret);
        serverInput.setText(host);
        secretInput.setText(secret);
        client = new LanClient(host, secret, null);

        loginButton.setOnClickListener(v -> doLogin());
        sendCodeButton.setOnClickListener(v -> sendCode());
        findViewById(R.id.homeAgreeText).setOnClickListener(v ->
                startActivity(new Intent(this, PrivacyActivity.class)));
        serverToggle.setOnClickListener(v -> {
            serverBox.setVisibility(serverBox.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
        });
        langZhButton.setOnClickListener(v -> applySpeakLang("zh-CN"));
        langPtButton.setOnClickListener(v -> applySpeakLang("pt-BR"));
        registerToggle.setOnClickListener(v -> setRegisterMode(!registerMode));
        findViewById(R.id.homeCreate).setOnClickListener(v -> openRooms());
        findViewById(R.id.homeSettings).setOnClickListener(v ->
                startActivity(new Intent(this, SettingsActivity.class)));
        findViewById(R.id.homeLegacy).setOnClickListener(v ->
                startActivity(new Intent(this, MainActivity.class)));
        findViewById(R.id.homeLogout).setOnClickListener(v -> logout());

        refreshLangPills(prefs.getString("speakLang", "zh-CN"));
        setRegisterMode(false);   // 默认是登录态：登录不需要邮箱与验证码
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

    /**
     * 在「登录」与「注册」之间切换（4.50）。
     *
     * <p>登录：只要 用户名 + 密码；邮箱、验证码、获取验证码按钮**全部收起**。
     * <p>注册：放出 邮箱 + 验证码（服务端 /auth/register-email 要四样：邮箱、用户名、密码、验证码）。
     * <p>按钮文案跟着变 —— 一个按钮，但绝不让人猜"我现在点的是登录还是注册"。
     */
    private void setRegisterMode(boolean register) {
        registerMode = register;
        int emailVisibility = register ? View.VISIBLE : View.GONE;
        emailRow.setVisibility(emailVisibility);
        codeInput.setVisibility(emailVisibility);
        loginButton.setText(register ? "注册并登录" : "登录");
        registerToggle.setText(register ? "已有账号？用密码登录" : "没有账号？用邮箱验证码注册");
        passInput.setHint(register ? "设置密码" : "密码");
        // 收起邮箱时把内容清掉：留着会让"登录却要求验证码"这种困惑再次出现
        if (!register) {
            emailInput.setText("");
            codeInput.setText("");
        }
    }

    /**
     * 「我的语言」三颗胶囊的外观（原型：中文 / English / 巴西葡语）。
     *
     * <p>English 是**禁用**的：服务端 `LANGS` 只有 `zh-CN` / `pt-BR`，加了只会让用户选完发现翻不了。
     * 灰着显示比藏起来好 —— 让人知道"这个产品将来支持英文"，也知道"现在别选"。
     */
    private void applySpeakLang(String lang) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("speakLang", lang).apply();
        refreshLangPills(lang);
    }

    private void refreshLangPills(String lang) {
        boolean pt = "pt-BR".equals(lang);
        langZhButton.setBackgroundResource(pt ? R.drawable.bg_pill : R.drawable.bg_pill_active);
        langPtButton.setBackgroundResource(pt ? R.drawable.bg_pill_active : R.drawable.bg_pill);
        langZhButton.setTextColor(getColor(pt ? R.color.ink : R.color.on_brand));
        langPtButton.setTextColor(getColor(pt ? R.color.on_brand : R.color.ink));
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
        if (sessionSocket != null) sessionSocket.stop();
        sessionWatch = new SessionWatch(client, message -> ui.post(() -> {
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
            status.setText(message);
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .remove("accountToken").remove("termsUser").remove("roomHost").apply();
            client.setToken("");
            showLogin();
        }));
        sessionWatch.start();

        // 推送优先：连上后把轮询放宽到 60 秒；断了立刻回到 10 秒（推送是静默失效的，必须有兜底）
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        sessionSocket = new SessionSocket(
                prefs.getString("host", ""), prefs.getString("secret", ""),
                prefs.getString("accountToken", ""),
                new SessionSocket.Listener() {
                    @Override
                    public void onKicked(String reason) {
                        // ⚠️ 服务端只会踢"用旧 token 的连接"。但客户端这一侧仍要**核实**：
                        // 如果我手上的 token 还能通过 whoami，那被踢的只是一条陈旧连接
                        // （典型场景：注销后又登录、或服务端重启过），不该把我赶回登录页。
                        new Thread(() -> {
                            boolean reallyExpired;
                            try {
                                client.checkSession();
                                reallyExpired = false;
                            } catch (LanClient.SessionExpiredException expired) {
                                reallyExpired = true;
                            } catch (Exception other) {
                                // 连不上服务器：无法确认，按"不踢人"处理（4.33 的教训）
                                reallyExpired = false;
                            }
                            final boolean kick = reallyExpired;
                            ui.post(() -> {
                                if (sessionSocket != null) {
                                    sessionSocket.stop();
                                    sessionSocket = null;
                                }
                                if (!kick) {
                                    debugLine("收到 kicked，但 whoami 仍有效 —— 判为陈旧连接，忽略");
                                    return;
                                }
                                Toast.makeText(HomeActivity.this,
                                        "账号已在别处登录，这台设备的登录已失效", Toast.LENGTH_LONG).show();
                                status.setText("账号已在别处登录，请重新登录");
                                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                                        .remove("accountToken").remove("termsUser").remove("roomHost").apply();
                                client.setToken("");
                                if (sessionWatch != null) sessionWatch.stop();
                                showLogin();
                            });
                        }, "home-kick-verify").start();
                    }

                    @Override
                    public void onOnlineChanged(boolean online) {
                        if (sessionWatch != null) {
                            sessionWatch.setIntervalMs(online
                                    ? SessionWatch.INTERVAL_SLOW_MS : SessionWatch.INTERVAL_MS);
                        }
                    }
                });
        sessionSocket.start();
    }

    @Override
    protected void onDestroy() {
        if (sessionWatch != null) {
            sessionWatch.stop();
            sessionWatch = null;
        }
        if (sessionSocket != null) {
            sessionSocket.stop();
            sessionSocket = null;
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
        // M4：用户协议与录音隐私政策必须勾选才继续（注册/登录都要）
        if (agreeBox == null || !agreeBox.isChecked()) {
            status.setText("请先阅读并同意《用户协议》与《录音与隐私政策》");
            Toast.makeText(this, "请先勾选同意用户协议与录音隐私政策", Toast.LENGTH_LONG).show();
            return;
        }
        final String host = normalizeHost(serverInput.getText().toString());
        final String secret = secretInput.getText().toString().trim();
        if (host.isEmpty()) {
            status.setText("先填服务器地址，例如 http://117.50.180.93:8788（在「服务器设置（高级）」里）");
            Toast.makeText(this, "缺少服务器地址", Toast.LENGTH_SHORT).show();
            return;
        }
        if (secret.isEmpty()) {
            status.setText("先填共享密钥（服务器 start-all 横幅里打印的那串，在「服务器设置（高级）」里）");
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
        // 由「登录 / 注册」开关决定，不看"填了没"（4.50：以前靠字段推断，
        // 用户填了邮箱去登录会被当成注册，报错还看不懂）。
        final boolean isRegister = registerMode;
        if (isRegister && (email.isEmpty() || code.isEmpty())) {
            Toast.makeText(this, "注册需要邮箱和验证码（先点「获取验证码」）", Toast.LENGTH_LONG).show();
            return;
        }
        debugLine("tap login host=" + host + " secretLen=" + secret.length() + " user=" + user
                + (isRegister ? " (注册)" : " (登录)"));
        loginButton.setEnabled(false);
        status.setText(isRegister ? "注册中…" : "登录中…");
        new Thread(() -> {
            JSONObject body = null;
            String error = "";
            try {
                body = isRegister
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
                    status.setText((isRegister ? "注册失败：" : "登录失败：") + reason);
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
                // ⚠️ 4.50 修：注销时**必须**也断开会话推送。
                // 否则这条连接（用的还是刚才被吊销的 token）会一直挂在服务端的「该用户会话」上；
                // 下次登录时服务端会"通知别处登录"—— 通知的正是这台的陈旧连接，于是自己弹
                // 「账号已在别处登录」，服务端日志也会打出"被别处登录挤下线"。
                if (sessionSocket != null) {
                    sessionSocket.stop();
                    sessionSocket = null;
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
