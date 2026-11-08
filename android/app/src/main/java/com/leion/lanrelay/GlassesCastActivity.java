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
    /** 字号偏好（sp）与步长/边界（5.138）。 */
    private static final String KEY_FONT_SP = "rokiFontSp";
    private static final int FONT_STEP_SP = 4;
    private static final int FONT_MIN_SP = 16;
    private static final int FONT_MAX_SP = 96;

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
    /** 用户手动调过的字号（0 = 没调过，按屏高自动算）。 */
    private int fontSp = 0;
    private android.content.SharedPreferences prefs = null;
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

        // ⚠️ 先构造、再使用（本仓库的 android-order 检查会盯这条）：
        //    `rokid.xxx` 只能出现在下面这行赋值之后。
        rokid = new RokidGlasses(this, (status, casting) -> {
            render(status, casting);
        });

        // 进来就把"为什么现在还投不了"说清楚，别让人对着按钮猜。
        render(rokid.isAppInstalled() ? rokid.status() : rokid.compatibilityNote(), false);

        toggleView.setOnClickListener(v -> toggle());
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

        // 5.138：字号 ± 与 三语×三档 测试句
        fontSp = prefs.getInt(KEY_FONT_SP, 0);
        if (fontSp > 0 && rokid != null) rokid.setFontSizeSp(fontSp);
        findViewById(R.id.castFontMinus).setOnClickListener(v -> nudgeFont(-FONT_STEP_SP));
        findViewById(R.id.castFontPlus).setOnClickListener(v -> nudgeFont(FONT_STEP_SP));
        buildSampleChips();
        renderFontValue();

        findViewById(R.id.castBack).setOnClickListener(v -> finish());
    }

    /** 调字号：写偏好 → 立刻用新字号把**当前这句**重推一次（投屏中马上能看到效果）。 */
    private void nudgeFont(int delta) {
        if (rokid == null) return;
        int next = Math.max(FONT_MIN_SP, Math.min(FONT_MAX_SP, rokid.fontSp() + delta));
        fontSp = next;
        prefs.edit().putInt(KEY_FONT_SP, next).apply();
        rokid.setFontSizeSp(next);
        renderFontValue();
        String last = rokid.lastPushedText();
        if (rokid.isCasting() && last != null && !last.isEmpty()) rokid.push(last);
    }

    private void renderFontValue() {
        TextView value = findViewById(R.id.castFontValue);
        if (value == null) return;
        int sp = rokid == null ? 32 : rokid.fontSp();
        value.setText(sp + "sp");
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
                { getString(R.string.lang_zh), SAMPLES_ZH[0], SAMPLES_ZH[1], SAMPLES_ZH[2] },
                { getString(R.string.lang_en), SAMPLES_EN[0], SAMPLES_EN[1], SAMPLES_EN[2] },
                { getString(R.string.lang_pt_native), SAMPLES_PT[0], SAMPLES_PT[1], SAMPLES_PT[2] },
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
            for (int index = 0; index < 3; index += 1) {
                String text = row[index + 1];
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
                    rokid.push(text);
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
        if (rokid != null) {
            rokid.close();
            rokid = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        View back = findViewById(R.id.castBack);
        if (back != null) back.performClick();
        finish();
    }
}
