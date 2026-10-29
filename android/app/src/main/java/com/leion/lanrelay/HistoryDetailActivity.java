package com.leion.lanrelay;

import android.os.Bundle;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 单条历史记录的详情（4.69 先搭骨架，内容下一轮）。
 *
 * <p>这一版只复述卡片上已有的信息 —— 点进来不该是一片空白，但也不该摆假的图表或按钮。
 * 逐句字幕等细节等用户下一轮给要求。
 */
public class HistoryDetailActivity extends android.app.Activity {

    /** 卡片把自己的 JSON 整个带过来：详情页要什么自己取，不必再请求一次。 */
    public static final String EXTRA_JSON = "record";

    @Override
    protected void attachBaseContext(android.content.Context base) {
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
        setContentView(R.layout.page_history_detail);

        TextView nameView = findViewById(R.id.detailName);
        TextView kindView = findViewById(R.id.detailKind);
        TextView metaView = findViewById(R.id.detailMeta);
        TextView langsView = findViewById(R.id.detailLangs);
        findViewById(R.id.detailBack).setOnClickListener(v -> finish());

        JSONObject record = null;
        String raw = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_JSON);
        if (raw != null && !raw.isEmpty()) {
            try {
                record = new JSONObject(raw);
            } catch (Exception ignored) {
                // 传参坏了就当没传：下面显示"未命名会议"，不崩
            }
        }

        if (record == null) {
            nameView.setText(getString(R.string.hist_unknown_name));
            kindView.setText(getString(R.string.hist_type_meeting));
            metaView.setText("");
            langsView.setText(getString(R.string.hist_langs_unknown));
            return;
        }

        // 从本机删除：与列表长按同一个动作（详情页给一个看得见的按钮，长按毕竟不显眼）
        final String roomId = record.optString("id", "");
        final String recordName = record.optString("name", "");
        findViewById(R.id.detailDelete).setOnClickListener(v ->
                new android.app.AlertDialog.Builder(this)
                        .setTitle(recordName.isEmpty() ? getString(R.string.hist_unknown_name) : recordName)
                        .setMessage(R.string.hist_delete_confirm)
                        .setNegativeButton(R.string.common_cancel, null)
                        .setPositiveButton(R.string.hist_delete_local, (dialog, which) -> {
                            String user = getSharedPreferences("leion", MODE_PRIVATE)
                                    .getString("termsUser", "");
                            HistoryStore.hide(this, user, roomId, System.currentTimeMillis());
                            android.widget.Toast.makeText(this, getString(R.string.hist_deleted_local),
                                    android.widget.Toast.LENGTH_SHORT).show();
                            finish();      // 回列表；列表 onResume 重新拉一次并过滤
                        })
                        .show());

        String name = record.optString("name", "");
        nameView.setText(name.isEmpty() ? getString(R.string.hist_unknown_name) : name);
        kindView.setText("interpreter".equals(record.optString("kind", "meeting"))
                ? getString(R.string.hist_type_interpreter) : getString(R.string.hist_type_meeting));

        String when = formatDate(record.optString("createdAt", ""));
        String duration = formatDuration(record.optInt("durationSeconds", 0));
        String people = record.optInt("members", 0) <= 1
                ? getString(R.string.hist_only_me)
                : getString(R.string.hist_members, record.optInt("members", 0));
        String extra = record.optBoolean("active", false) ? " · " + getString(R.string.hist_active) : "";
        metaView.setText(when + " · " + duration + " · " + people + extra);
        langsView.setText(langsLabel(record.optJSONArray("langs")));
    }

    private String formatDate(String iso) {
        if (iso == null || iso.isEmpty()) return "";
        try {
            String head = iso.length() > 19 ? iso.substring(0, 19) : iso;
            Date date = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).parse(head);
            if (date == null) return iso;
            return new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(date);
        } catch (Exception error) {
            return iso;
        }
    }

    private String formatDuration(int seconds) {
        if (seconds < 60) return getString(R.string.hist_duration_short);
        int minutes = seconds / 60;
        if (minutes < 60) return getString(R.string.hist_duration_minutes, minutes);
        return getString(R.string.hist_duration_hours, minutes / 60, minutes % 60);
    }

    private String langsLabel(JSONArray langs) {
        if (langs == null || langs.length() == 0) return getString(R.string.hist_langs_unknown);
        StringBuilder zh = new StringBuilder();
        StringBuilder pt = new StringBuilder();
        for (int i = 0; i < langs.length(); i++) {
            String code = langs.optString(i, "");
            if (code.startsWith("zh")) {
                if (zh.length() > 0) zh.append(" / ");
                zh.append(getString(R.string.lang_zh_short));
            } else if (code.startsWith("pt")) {
                if (pt.length() > 0) pt.append(" / ");
                pt.append(getString(R.string.lang_pt_short));
            }
        }
        if (zh.length() > 0 && pt.length() > 0) {
            return getString(R.string.hist_langs, zh.toString(), pt.toString());
        }
        if (zh.length() > 0) return zh.toString();
        if (pt.length() > 0) return pt.toString();
        return getString(R.string.hist_langs_unknown);
    }
}
