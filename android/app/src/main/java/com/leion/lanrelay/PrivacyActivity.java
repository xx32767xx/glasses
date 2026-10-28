package com.leion.lanrelay;

import android.os.Bundle;

/**
 * PrivacyActivity —— 隐私政策（4.39，A2）。
 *
 * <p>为什么要有这一页：这套系统会录会议音频、会存文字记录，用户**有权知道**它们去哪、
 * 留多久、谁能看到。文案在 `res/layout/page_privacy.xml` 里，逐条对应代码的真实行为：
 *   · 音频去向 → relay 的 `/audio` 落盘 + 4.38 的轮转；
 *   · 文字保留 → 服务器 7 天清理（4.36）+ 手机本机 200 条上限（Records.CAP）；
 *   · 公网明文 → docs/10 §4.3 的 TLS 尚未启用。
 *
 * <p>刻意做成**静态页面**：隐私政策不该有"动态渲染失败就白屏"的可能。
 */
public class PrivacyActivity extends android.app.Activity {
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
        setContentView(R.layout.page_privacy);
        findViewById(R.id.privacyBack).setOnClickListener(v -> finish());
    }
}
