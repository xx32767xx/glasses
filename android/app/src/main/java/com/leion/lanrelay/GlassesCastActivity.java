package com.leion.lanrelay;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * GlassesCastActivity —— Rokid 眼镜的「投屏译文」开关（5.133）。
 * ============================================================================
 *
 * <p>为什么要有这一页：Rokid 投屏原来只有旧界面（MainActivity → overlay_glasses）里有入口，
 * 而新入口（HomeActivity）的设置页根本没有它 —— **用户拿到的 4.255 里没有任何地方能开始
 * Rokid 投屏**。这一页就是那个入口（设置 →「眼镜投屏」）。
 *
 * <p>这一页刻意**只做 Rokid**，且只有两件事：看状态、开始/停止投屏。
 * 亮亮那套的画布尺寸、排版自检、字号微调、投屏样例都不在这里 —— 它们的单位是画布 px，
 * 而 Rokid 那边是 `sp` 字号 + 镜片端自己排版，搬过来只会让人以为调了有用。
 *
 * <p>连接的三段（缺一段都连不上，状态行会逐条说出来）：
 * ① 手机装了 Rokid AI App 且版本够；② 眼镜在 **Rokid AI App 里**连上（系统蓝牙配对不够）；
 * ③ 授权拿到 token → 建 CUSTOM_VIEW 会话 → 之后每句译文一条增量更新。
 */
public class GlassesCastActivity extends Activity {

    /** 蓝牙运行时权限（Android 12+）：与 RokidGlasses.missingBluetoothPermissions 同一套。 */
    private static final int REQUEST_BLUETOOTH = 2001;
    /** 与 SettingsActivity / MainActivity 同一个偏好文件（"leion"）。 */
    private static final String PREFS = "leion";
    /** 字号偏好与步长（5.139：三种语言各自独立；上下界 10~44 由 RokidGlasses.clampFont 统一夹）。 */
    private static final String KEY_FONT_ZH = "rokiFontSpZh";
    private static final String KEY_FONT_EN = "rokiFontSpEn";
    private static final String KEY_FONT_PT = "rokiFontSpPt";
    private static final int FONT_STEP_SP = 2;

    /**
     * 三语 × 短/中/长 的测试句（5.138）。
     *
     * <p>刻意硬编码在这里、**不跟着界面语言走**：它们是"被显示的内容"，不是 UI 文案 ——
     * 葡语界面下也得能点中文测试句，否则验不了那种语言在镜片上的宽度与换行。
     * 长度按"一屏能放几行"的感觉取：短≈10 字以内、中≈30、长≈80+。
     */
    private static final String[] SAMPLES_ZH = {
            "今天下午三点开会。",
            "今天的会议改到下午三点，地点在十二楼的会议室。",
            "报告警告称，没有人能保证目前在伊拉克采取的任何行动能够阻止宗派战争、不断增长的暴力或走向混乱，"
                    + "因此各方应当尽快回到谈判桌前，而不是继续在战场上寻找答案。",
    };
    private static final String[] SAMPLES_EN = {
            "The meeting starts at three.",
            "The meeting has been moved to three in the afternoon, in the twelfth-floor room.",
            "The report warns that nobody can guarantee that any action taken in Iraq can stop the sectarian war, "
                    + "the growing violence, or the slide into chaos, so all sides should return to the table.",
    };
    private static final String[] SAMPLES_PT = {
            "A reunião é às três.",
            "A reunião mudou para as três da tarde, na sala do décimo segundo andar.",
            "O relatório adverte que ninguém pode garantir que qualquer ação tomada no Iraque consiga impedir "
                    + "a guerra sectária, a violência crescente ou o caminho para o caos.",
    };

    private RokidGlasses rokid = null;
    private TextView statusView = null;
    private Button toggleView = null;
    private android.content.SharedPreferences prefs = null;
    /** 本页的状态监听（摘掉时用，5.140）。 */
    private RokidGlasses.Listener castListener = null;
    /** 三行字号各自的数值显示（中/英/葡，5.139 独立可调）。 */
    private final java.util.Map<String, TextView> fontValueViews = new java.util.HashMap<>();
    /** 用户点了「开始投屏」但还差蓝牙权限：拿到权限后自动继续（免得再点一次）。 */
    private boolean pendingStart = false;

    @Override
    protected void attachBaseContext(android.content.Context base) {
        // 4.56：界面语言在这一层换（三套资源在 values-en / values-pt-rBR）
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        UiLang.trackShown(this);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_glasses_cast);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        statusView = findViewById(R.id.castStatus);
        toggleView = findViewById(R.id.castToggle);

        // 5.140：**应用级单例** —— 投屏要跨页面活着（离开本页不能把会话关掉）。
        // ⚠️ 先赋值、再使用（本仓库的 android-order 检查会盯这条）。
        rokid = RokidGlasses.shared(this);
        castListener = new RokidGlasses.Listener() {
            @Override
            public void onRokidStatus(String status, boolean casting) {
                render(status, casting);
            }
        };
        rokid.addListener(castListener);

        // 进来就把"为什么现在还投不了"说清楚，别让人对着按钮猜。
        render(rokid.isAppInstalled() ? rokid.status() : rokid.compatibilityNote(), false);

        toggleView.setOnClickListener(v -> toggle());
        // 5.145（用户要求）：本页**不受开发者模式影响**，测试项永远显示 ——
        // "镜片出不出字"是投屏功能的唯一判据，它不该被一个开关藏起来。
        // 5.261：投屏通了之后先验一句字 —— 不连电脑、不开会，把"会话/原生库"与"字幕链路"分开验。
        findViewById(R.id.castTest).setOnClickListener(v -> {
            if (rokid == null || !rokid.isCasting()) {
                render(getString(R.string.glasses_cast_need_cast_first), false);
                return;
            }
            String text = getString(R.string.glasses_cast_test_text);
            rokid.push(text);
            render(getString(R.string.glasses_cast_test_sent), false);
        });

        // 5.139：字号（中/英/葡各自独立）+ 三语×三档 测试句
        applySavedFonts();
        buildFontRows();
        buildSampleChips();

        findViewById(R.id.castBack).setOnClickListener(v -> finish());
    }

    /** 从偏好里恢复三种语言的字号（0 = 没设过，由 RokidGlasses 按屏高自动算）。 */
    private void applySavedFonts() {
        if (rokid == null) return;
        rokid.setFontSize("zh-CN", prefs.getInt(KEY_FONT_ZH, 0));
        rokid.setFontSize("en-US", prefs.getInt(KEY_FONT_EN, 0));
        rokid.setFontSize("pt-BR", prefs.getInt(KEY_FONT_PT, 0));
    }

    /**
     * 三行字号调节（中 / 英 / 葡，各一组 － 数值 ＋）。
     *
     * <p>为什么拆成三种语言：用户要求"像亮亮那样分开调"。真机上也确实需要 ——
     * 汉字是方块字、拉丁字母 x-height 小，同一 sp 下观感差一档。
     */
    private void buildFontRows() {
        LinearLayout host = findViewById(R.id.castFonts);
        if (host == null || rokid == null) return;
        host.removeAllViews();
        fontValueViews.clear();
        String[][] langs = {
                { getString(R.string.lang_zh), "zh-CN", KEY_FONT_ZH },
                { getString(R.string.lang_en), "en-US", KEY_FONT_EN },
                { getString(R.string.lang_pt_native), "pt-BR", KEY_FONT_PT },
        };
        for (String[] one : langs) {
            final String label = one[0];
            final String lang = one[1];
            final String key = one[2];
            LinearLayout line = new LinearLayout(this);
            line.setOrientation(LinearLayout.HORIZONTAL);
            line.setGravity(android.view.Gravity.CENTER_VERTICAL);
            line.setLayoutParams(new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

            TextView name = new TextView(this);
            name.setText(label);
            name.setTextSize(13f);
            name.setTextColor(getColor(R.color.ink_soft));
            line.addView(name, new LinearLayout.LayoutParams(0,
                    LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            Button minus = new Button(this);
            minus.setText(getString(R.string.glasses_font_minus));
            styleFontButton(minus);
            minus.setOnClickListener(v -> nudgeFont(lang, key, -FONT_STEP_SP));
            line.addView(minus);

            TextView value = new TextView(this);
            value.setMinWidth(dp(56));
            value.setGravity(android.view.Gravity.CENTER);
            value.setTextSize(13f);
            value.setTextColor(getColor(R.color.ink));
            line.addView(value);
            fontValueViews.put(lang, value);

            Button plus = new Button(this);
            plus.setText(getString(R.string.glasses_font_plus));
            styleFontButton(plus);
            plus.setOnClickListener(v -> nudgeFont(lang, key, FONT_STEP_SP));
            line.addView(plus);

            host.addView(line);
        }
        renderFontValues();
    }

    private void styleFontButton(Button button) {
        button.setTextColor(getColor(R.color.ink));
        button.setBackgroundResource(R.drawable.tap_btn_secondary);
        button.setPadding(0, 0, 0, 0);
        button.setLayoutParams(new LinearLayout.LayoutParams(dp(44), dp(44)));
    }

    private void renderFontValues() {
        if (rokid == null) return;
        for (java.util.Map.Entry<String, TextView> one : fontValueViews.entrySet()) {
            one.getValue().setText(rokid.fontSpFor(one.getKey()) + "sp");
        }
    }

    /** 调某门语言的字号：写偏好 → 立即用新字号把当前页重推（投屏中马上能看到效果）。 */
    private void nudgeFont(String lang, String key, int delta) {
        if (rokid == null) return;
        int next = RokidGlasses.clampFont(rokid.fontSpFor(lang) + delta);
        prefs.edit().putInt(key, next).apply();
        rokid.setFontSize(lang, next);
        renderFontValues();
        rokid.repush();
    }

    /**
     * 三语 × 短/中/长的测试句（点了就真的推上镜片）。
     *
     * <p>为什么这些句子**不跟着界面语言变**：它们是"被显示的内容"，不是 UI 文案 ——
     * 在葡语界面下也得能点中文测试句，否则验不了那种语言在镜片上的宽度与换行。
     */
    private void buildSampleChips() {
        LinearLayout host = findViewById(R.id.castSamples);
        if (host == null) return;
        host.removeAllViews();
        String[][] rows = {
                { getString(R.string.lang_zh), "zh-CN", SAMPLES_ZH[0], SAMPLES_ZH[1], SAMPLES_ZH[2] },
                { getString(R.string.lang_en), "en-US", SAMPLES_EN[0], SAMPLES_EN[1], SAMPLES_EN[2] },
                { getString(R.string.lang_pt_native), "pt-BR", SAMPLES_PT[0], SAMPLES_PT[1], SAMPLES_PT[2] },
        };
        String[] lengths = {
                getString(R.string.glasses_len_short),
                getString(R.string.glasses_len_mid),
                getString(R.string.glasses_len_long),
        };
        for (String[] row : rows) {
            LinearLayout line = new LinearLayout(this);
            line.setOrientation(LinearLayout.HORIZONTAL);
            line.setLayoutParams(new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            TextView lang = new TextView(this);
            lang.setText(row[0]);
            lang.setTextSize(13f);
            lang.setTextColor(getColor(R.color.ink_soft));
            lang.setWidth(dp(52));
            line.addView(lang);
            final String sampleLang = row[1];
            for (int index = 0; index < 3; index += 1) {
                String text = row[index + 2];
                Button chip = new Button(this);
                chip.setText(lengths[index]);
                chip.setTextSize(13f);
                chip.setAllCaps(false);
                chip.setTextColor(getColor(R.color.brand));
                chip.setBackgroundResource(R.drawable.tap_pill);
                chip.setPadding(dp(10), 0, dp(10), 0);
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, dp(40));
                if (index > 0) params.setMarginStart(dp(6));
                chip.setLayoutParams(params);
                chip.setOnClickListener(v -> {
                    if (rokid == null || !rokid.isCasting()) {
                        render(getString(R.string.glasses_cast_need_cast_first), false);
                        return;
                    }
                    rokid.push(text, sampleLang);
                    render(getString(R.string.glasses_cast_test_sent), false);
                });
                line.addView(chip);
            }
            host.addView(line);
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /** 开始 / 停止（同一个按钮）。 */
    private void toggle() {
        if (rokid == null) return;
        if (rokid.isCasting()) {
            rokid.stop();
            render(rokid.status(), false);
            return;
        }
        // 5.134：Android 12+ 先要蓝牙权限 —— 没权限时 SDK 查到的"眼镜连没连"永远是 false。
        String[] missingBt = rokid.missingBluetoothPermissions();
        if (missingBt.length > 0) {
            pendingStart = true;
            render(getString(R.string.glasses_cast_need_bt), false);
            requestPermissions(missingBt, REQUEST_BLUETOOTH);
            return;
        }
        rokid.start(this);
        // start() 是异步的（授权要跳 AI App），状态由回调推回来；这里先把"正在做什么"写上去
        render(rokid.status(), false);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_BLUETOOTH) return;
        boolean granted = grantResults.length > 0;
        for (int result : grantResults) {
            if (result != android.content.pm.PackageManager.PERMISSION_GRANTED) granted = false;
        }
        if (!granted) {
            pendingStart = false;
            render(getString(R.string.glasses_cast_need_bt), false);
            return;
        }
        if (pendingStart) {
            pendingStart = false;
            toggle();
        }
    }

    private void render(String status, boolean casting) {
        if (statusView != null && status != null && !status.isEmpty()) {
            statusView.setText(status);
            statusView.setTextColor(getColor(casting ? R.color.ok : R.color.ink_soft));
        }
        if (toggleView != null) {
            toggleView.setText(casting ? R.string.glasses_cast_stop : R.string.glasses_cast_start);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        // Rokid 的授权结果可能从这里回来（官方 Sample 也这么转发）。
        if (rokid != null && rokid.handleActivityResult(resultCode, data)) return;
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        // 谁创建谁关闭：不关会让 Rokid AI App 以为会话还在，下次 create 会 ALREADY_EXISTS。
        if (rokid != null && castListener != null) {
            // 只摘监听，**不停会话**：投屏要跨页面活着（会话由用户点「停止投屏」结束，
            // 或进程退出时由 MainActivity.onDestroy 收尾）。
            rokid.removeListener(castListener);
            castListener = null;
        }
        rokid = null;
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        View back = findViewById(R.id.castBack);
        if (back != null) back.performClick();
        finish();
    }
}
