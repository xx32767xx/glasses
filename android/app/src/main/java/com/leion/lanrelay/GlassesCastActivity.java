package com.leion.lanrelay;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
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

    private RokidGlasses rokid = null;
    private TextView statusView = null;
    private Button toggleView = null;
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
        findViewById(R.id.castBack).setOnClickListener(v -> finish());
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
