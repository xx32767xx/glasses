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
    /** 首页顶部问候（「晚上好，张三」）。 */
    private TextView greetingView;
    /** 问候下面那行摘要：界面语言 · 设备 · 在线状态。 */
    private TextView summaryView;
    /** 顶部的界面语言入口（显示当前语言，点开三选一）。 */
    private TextView langEntry;
    /** 底部一级导航（登录后才出现）。 */
    private View bottomNav;
    /** 登录态抬头（品牌 / 标语 / 我的语言）：进首页就收起。 */
    private View loginHeader;
    /** 当前这台设备是否连着服务器（只用于首页摘要那一行）。 */
    private boolean serverOnline = false;
    /**
     * 「我的语言」三颗胶囊 —— **界面语言**（4.59 澄清）。
     *
     * <p>它改的只是按钮/标题用哪种语言文字，与"我说话用哪种语言"无关：后者（{@code speakLang}）
     * 在建会议那一步选（房间列表页），因为那才是它真正影响识别方向的时候。
     */
    private TextView langZhButton;
    private TextView langEnButton;
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

    /**
     * 状态行：**只在有话说的时候出现**（4.56）。
     *
     * <p>原来它是一块永远存在的卡片，空文本时也画出一个带边框的空条 —— 用户看到的就是
     * 登录页顶上那行莫名其妙的小横条（注销后还写着「已注销」）。现在空字符串直接整块隐藏。
     */
    private void setStatus(String msg) {
        if (status == null) return;
        boolean show = msg != null && !msg.isEmpty();
        status.setText(show ? msg : "");
        status.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    @Override
    protected void attachBaseContext(android.content.Context base) {
        // 4.56：界面语言必须在这里换 —— 每个界面都要，否则只有先建的那个生效
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        UiLang.trackShown(this);   // 4.56：从设置页改完界面语言回来，本页要跟上
    }

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
        greetingView = findViewById(R.id.homeGreeting);
        summaryView = findViewById(R.id.homeSummary);
        langEntry = findViewById(R.id.homeLangEntry);
        bottomNav = findViewById(R.id.homeBottomNav);
        loginHeader = findViewById(R.id.homeLoginHeader);
        langZhButton = findViewById(R.id.homeLangZh);
        langEnButton = findViewById(R.id.homeLangEn);
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
        langZhButton.setOnClickListener(v -> applyUiLang(UiLang.ZH));
        langEnButton.setOnClickListener(v -> applyUiLang(UiLang.EN));
        langPtButton.setOnClickListener(v -> applyUiLang(UiLang.PT));
        registerToggle.setOnClickListener(v -> setRegisterMode(!registerMode));
        // 首页三张卡：创建 / 加入是同级入口（只是进到房间列表的对应一半），
        // 同传翻译官那一张**故意没有点击监听** —— 它还没做，点了不该有任何反应。
        findViewById(R.id.homeCardCreate).setOnClickListener(v -> openRooms("create"));
        findViewById(R.id.homeCardJoin).setOnClickListener(v -> openRooms("join"));
        langEntry.setOnClickListener(v -> showUiLangPicker());
        // 首页这颗已经在这儿了，点了什么都不做（导航项本身要可点，否则看着像坏了）
        findViewById(R.id.homeNavHome).setOnClickListener(v -> { });
        // 4.93：底部导航统一走 NavTabs.go —— 交叉淡化换页，不用默认的"从右侧推入覆盖"
        findViewById(R.id.homeNavHistory).setOnClickListener(v -> NavTabs.go(this, NavTabs.HISTORY));
        findViewById(R.id.homeNavMe).setOnClickListener(v -> NavTabs.go(this, NavTabs.ME));
        findViewById(R.id.homeLegacy).setOnClickListener(v ->
                startActivity(new Intent(this, MainActivity.class)));
        findViewById(R.id.homeLogout).setOnClickListener(v -> logout());

        refreshUiLangPills();
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
                    serverOnline = false;
                    showHome(user, "");
                    setStatus(getString(R.string.st_offline_keep, error));
                    debugLine("restore offline: " + error);
                    return;
                }
                int code = body.optInt("_status", 0);
                if (body.optBoolean("ok", false)) {
                    serverOnline = true;
                    showHome(body.optString("user", user), body.optString("role", ""));
                    return;
                }
                if (code == 401) {
                    String hint = ServerText.from(this, body, "");
                    prefs.edit().remove("accountToken").remove("termsUser").remove("roomHost").apply();
                    client.setToken("");
                    showLogin();
                    setStatus(hint.isEmpty() ? getString(R.string.st_session_expired)
                            : getString(R.string.st_session_expired_hint, hint));
                    debugLine("restore 401: " + hint);
                    return;
                }
                // 其他非 2xx：服务端有问题，但**不一定**是会话失效 —— 同样不动登录态
                showHome(user, "");
                setStatus(getString(R.string.st_unknown_keep, code));
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
        loginButton.setText(getString(register ? R.string.btn_register_login : R.string.btn_login));
        registerToggle.setText(getString(register ? R.string.home_toggle_login : R.string.home_toggle_register));
        passInput.setHint(getString(register ? R.string.home_hint_pass_set : R.string.home_hint_pass));
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
    /**
     * 换界面语言（4.56）：存下来 + 重建本页。
     *
     * <p>为什么必须重建：已经画出来的文字不会自己变；{@code recreate()} 之后
     * {@code attachBaseContext} 会用新的 Configuration 重新取资源。
     */
    private void applyUiLang(String tag) {
        if (tag.equals(UiLang.saved(this))) return;     // 点了当前这颗，什么都不做
        UiLang.save(this, tag);
        recreate();
    }

    /** 当前生效的那颗：品牌色底 + 白字，其余白底主色 —— 一眼看出现在是哪种语言。 */
    private void refreshUiLangPills() {
        String cur = UiLang.effective(this);
        TextView[] pills = {langZhButton, langEnButton, langPtButton};
        String[] tags = {UiLang.ZH, UiLang.EN, UiLang.PT};
        for (int i = 0; i < pills.length; i++) {
            if (pills[i] == null) continue;
            boolean on = tags[i].equals(cur);
            pills[i].setBackgroundResource(on ? R.drawable.bg_pill_active : R.drawable.bg_pill);
            pills[i].setTextColor(getColor(on ? R.color.on_brand : R.color.ink));
        }
    }

    private void showLogin() {
        loginBox.setVisibility(View.VISIBLE);
        homeBox.setVisibility(View.GONE);
        if (loginHeader != null) loginHeader.setVisibility(View.VISIBLE);
        if (bottomNav != null) bottomNav.setVisibility(View.GONE);
    }

    private void showHome(String user, String role) {
        loginBox.setVisibility(View.GONE);
        homeBox.setVisibility(View.VISIBLE);
        // 首页有自己的问候与语言入口，登录页那套抬头要收起来，否则一屏两个"标题"（4.60）
        if (loginHeader != null) loginHeader.setVisibility(View.GONE);
        if (bottomNav != null) NavTabs.apply(this, NavTabs.HOME);
        greetingView.setText(greetingFor(user));
        refreshHomeSummary();
        setStatus("");
        startSessionWatch();
    }

    /**
     * 问候语按当前时段给：早上好 / 下午好 / 晚上好。
     *
     * <p>为什么不写死「你好」：原型首页第一行就是问候，它承担"这屏是首页"的定位；
     * 一句话就够，不需要额外的大标题。
     */
    private String greetingFor(String user) {
        int hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY);
        int res = hour < 12 ? R.string.greet_morning
                : (hour < 18 ? R.string.greet_afternoon : R.string.greet_evening);
        return getString(res, user == null ? "" : user);
    }

    /**
     * 首页摘要那一行：**界面语言 · 设备 · 在线状态**。
     *
     * <p>为什么把"界面语言"也写在这：用户刚在右上角切过语言，这行是他能马上核对的地方；
     * 设备与在线状态则是"我现在能不能开会"的最短回答。
     */
    private void refreshHomeSummary() {
        if (summaryView == null) return;
        String lang = UiLang.nativeLabel(UiLang.effective(this));
        String state = getString(serverOnline ? R.string.state_online : R.string.state_offline);
        String device = getString(R.string.audio_source_phone);
        summaryView.setText(lang + " · " + device + " · " + state);
        if (langEntry != null) langEntry.setText(lang);
    }

    /** 右上角的界面语言入口：点开三选一（语言名一律用它自己的语言写）。 */
    private void showUiLangPicker() {
        final String[] tags = {UiLang.ZH, UiLang.PT, UiLang.EN};
        final String[] names = new String[tags.length];
        for (int i = 0; i < tags.length; i++) names[i] = UiLang.nativeLabel(tags[i]);
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.ui_lang_title)
                .setItems(names, (dialog, which) -> applyUiLang(tags[which]))
                .show();
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
            setStatus(message);
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
                                        getString(R.string.st_kicked_other), Toast.LENGTH_LONG).show();
                                setStatus(getString(R.string.st_kicked_relogin));
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
            Toast.makeText(this, getString(R.string.toast_need_email), Toast.LENGTH_SHORT).show();
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
                    setStatus(code.isEmpty() ? getString(R.string.st_code_sent)
                            : getString(R.string.st_code_dev, code));
                } else {
                    setStatus(getString(R.string.st_code_failed,
                            ServerText.from(this, result, failure)));
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
                setStatus(sb.toString());
            }
        });
    }

    private void doLogin() {
        // M4：用户协议与录音隐私政策必须勾选才继续（注册/登录都要）
        if (agreeBox == null || !agreeBox.isChecked()) {
            setStatus(getString(R.string.st_need_agree_links));
            Toast.makeText(this, getString(R.string.toast_need_agree), Toast.LENGTH_LONG).show();
            return;
        }
        final String host = normalizeHost(serverInput.getText().toString());
        final String secret = secretInput.getText().toString().trim();
        if (host.isEmpty()) {
            setStatus(getString(R.string.st_fill_server));
            Toast.makeText(this, getString(R.string.toast_missing_server), Toast.LENGTH_SHORT).show();
            return;
        }
        if (secret.isEmpty()) {
            setStatus(getString(R.string.st_fill_secret));
            Toast.makeText(this, getString(R.string.toast_missing_secret), Toast.LENGTH_SHORT).show();
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
            Toast.makeText(this, getString(R.string.toast_need_user_pass), Toast.LENGTH_SHORT).show();
            return;
        }
        // 由「登录 / 注册」开关决定，不看"填了没"（4.50：以前靠字段推断，
        // 用户填了邮箱去登录会被当成注册，报错还看不懂）。
        final boolean isRegister = registerMode;
        if (isRegister && (email.isEmpty() || code.isEmpty())) {
            Toast.makeText(this, getString(R.string.toast_need_email_code), Toast.LENGTH_LONG).show();
            return;
        }
        debugLine("tap login host=" + host + " secretLen=" + secret.length() + " user=" + user
                + getString(isRegister ? R.string.debug_suffix_register : R.string.debug_suffix_login));
        loginButton.setEnabled(false);
        setStatus(getString(isRegister ? R.string.st_registering : R.string.st_logging_in));
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
                    // 4.58：服务端说的是中文（hint / error），按当前界面语言翻过来再显示
                    String reason = ServerText.from(this, result, failure);
                    setStatus(getString(isRegister ? R.string.st_register_failed : R.string.st_login_failed, reason));
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
                serverOnline = true;
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
                setStatus("");            // 4.56：注销后不再挂一行「已注销」
            });
        }, "home-logout").start();
    }

    /**
     * 首页两个入口各进**各自那一页**（5.04）。
     *
     * <p>原来是两件事进同一个大厅页、靠"聚焦到哪一半"来区分 —— 用户当场指出
     * "无论我点加入会议还是创建会议 弹出的内容都是一样的"。字段本来就不一样
     * （创建要主题+术语库，加入要邀请码），所以现在分成两页：
     * 创建 → {@link CreateRoomActivity}，加入 → {@link JoinRoomActivity}。
     */
    private void openRooms(String focus) {
        Class<?> target = "join".equals(focus) ? JoinRoomActivity.class : CreateRoomActivity.class;
        startActivity(new Intent(this, target));
    }
}
