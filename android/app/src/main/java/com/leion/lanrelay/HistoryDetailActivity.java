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
        TextView statDuration = findViewById(R.id.statDuration);
        TextView statLangs = findViewById(R.id.statLangs);
        TextView statSpeakers = findViewById(R.id.statSpeakers);
        /* 转写区：外框高度固定，里面是多张字幕卡（与会议中格式一致） */
        findViewById(R.id.detailBack).setOnClickListener(v -> finish());
        // 筛选入口：转写格式下一轮定，现在点了明说还没做（不做假的筛选面板）
        findViewById(R.id.transcriptFilter).setOnClickListener(v ->
                android.widget.Toast.makeText(this, getString(R.string.transcript_filter_soon),
                        android.widget.Toast.LENGTH_SHORT).show());

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
            statDuration.setText("—");
            statLangs.setText("—");
            statSpeakers.setText("—");
            showTranscriptEmpty();
            return;
        }

        // 从本机删除：与列表长按同一个动作（详情页给一个看得见的按钮，长按毕竟不显眼）
        final JSONObject recordForExport = record;
        findViewById(R.id.detailExport).setOnClickListener(v -> exportWord(recordForExport));

        final String roomId = record.optString("id", "");
        final String recordName = record.optString("name", "");
        findViewById(R.id.detailDelete).setOnClickListener(v ->
                new android.app.AlertDialog.Builder(this)
                        .setTitle(recordName.isEmpty() ? getString(R.string.hist_unknown_name) : recordName)
                        .setMessage(R.string.hist_delete_confirm)
                        .setNegativeButton(R.string.common_cancel, null)
                        .setPositiveButton(R.string.hist_delete_local, (dialog, which) ->
                                deleteOnServer(roomId))
                        .show());

        String name = record.optString("name", "");
        nameView.setText(name.isEmpty() ? getString(R.string.hist_unknown_name) : name);
        kindView.setText("interpreter".equals(record.optString("kind", "meeting"))
                ? getString(R.string.hist_type_interpreter) : getString(R.string.hist_type_meeting));

        // 三列统计：数值用主色（布局里定的），这里只填值。人数按"参加过的人"算。
        statDuration.setText(formatDuration(record.optInt("durationSeconds", 0)));
        statLangs.setText(langsCountLabel(record.optJSONArray("langs")));
        int members = record.optInt("members", 0);
        statSpeakers.setText(members <= 1 ? getString(R.string.hist_only_me)
                : String.valueOf(members));

        // 转写全文：去服务端拉这场会的转写，有几条画几张卡。
        loadTranscript(record.optString("id", ""));
    }

    /** 转写区没内容：显示一句话，并把空框收起来（不留一个大白框）。 */
    private void showTranscriptEmpty() {
        android.view.View scroll = findViewById(R.id.transcriptScroll);
        if (scroll != null) scroll.setVisibility(android.view.View.GONE);
        android.view.View empty = findViewById(R.id.transcriptEmpty);
        if (empty != null) empty.setVisibility(android.view.View.VISIBLE);
    }

    /**
     * 拉转写并渲染。
     *
     * <p>每条渲染成**一张字幕卡**，格式与会议中的一致（同一份 {@code item_subtitle_card}
     * 布局 + {@link SubtitleCard}）。外框高度固定，内容超出就在框内滑动。
     */
    private void loadTranscript(final String roomId) {
        if (roomId == null || roomId.isEmpty()) {
            showTranscriptEmpty();
            return;
        }
        final android.content.SharedPreferences prefs = getSharedPreferences("leion", MODE_PRIVATE);
        final String mineName = prefs.getString("termsUser", "");
        final LanClient client = new LanClient(prefs.getString("host", ""), prefs.getString("secret", ""), null);
        String token = prefs.getString("accountToken", "");
        if (token != null && !token.isEmpty()) client.setToken(token);
        new Thread(() -> {
            org.json.JSONArray lines = null;
            try {
                org.json.JSONObject body = client.orgHistoryTranscript(roomId);
                if (body != null && body.optBoolean("ok", false)) lines = body.optJSONArray("lines");
            } catch (Exception ignored) {
                // 拉不到就当没有：宁可显示"还没有转写内容"，也不让详情页报错
            }
            final org.json.JSONArray result = lines;
            runOnUiThread(() -> renderTranscript(result, mineName));
        }, "history-transcript").start();
    }

    private void renderTranscript(org.json.JSONArray lines, String mineName) {
        android.widget.LinearLayout list = findViewById(R.id.transcriptList);
        if (lines == null || lines.length() == 0) {
            showTranscriptEmpty();
            return;
        }
        list.removeAllViews();
        for (int i = 0; i < lines.length(); i++) {
            org.json.JSONObject one = lines.optJSONObject(i);
            if (one == null) continue;
            list.addView(SubtitleCard.render(list, one, mineName));
        }
        findViewById(R.id.transcriptScroll).setVisibility(android.view.View.VISIBLE);
        findViewById(R.id.transcriptEmpty).setVisibility(android.view.View.GONE);
    }

    /** 「使用语种」那一列只显示**数量**（详情页空间有限；具体语言在下面转写区再说）。 */
    private String langsCountLabel(JSONArray langs) {
        if (langs == null || langs.length() == 0) return "—";
        return String.valueOf(langs.length());
    }

    /**
     * 导出 Word（.docx）。
     *
     * <p>导出的内容**严格等于这条记录已有的历史内容**：概览 + 转写全文。
     * 不生成摘要、不生成行动项（会议纪要整块按建议砍掉了）。
     */
    private void exportWord(final JSONObject record) {
        try {
            String name = record.optString("name", "");
            String title = name.isEmpty() ? getString(R.string.hist_unknown_name) : name;
            java.util.List<String> lines = new java.util.ArrayList<>();
            lines.add(getString(R.string.doc_title));
            lines.add(formatDate(record.optString("createdAt", "")) + " · "
                    + formatDuration(record.optInt("durationSeconds", 0)) + " · "
                    + (record.optInt("members", 0) <= 1 ? getString(R.string.hist_only_me)
                       : getString(R.string.hist_members, record.optInt("members", 0))));
            lines.add(langsLabel(record.optJSONArray("langs")));
            lines.add("");
            lines.add(getString(R.string.transcript_title));
            lines.add(getString(R.string.transcript_empty));

            java.io.File dir = new java.io.File(getCacheDir(), "exports");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            String safe = title.replaceAll("[^\\w\\u4e00-\\u9fff-]", "_");
            java.io.File file = HistoryDocx.write(
                    new java.io.File(dir, safe + ".docx"), title, lines);

            android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", file);
            android.content.Intent share = new android.content.Intent(android.content.Intent.ACTION_SEND);
            share.setType("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            share.putExtra(android.content.Intent.EXTRA_STREAM, uri);
            share.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            android.widget.Toast.makeText(this, getString(R.string.export_done),
                    android.widget.Toast.LENGTH_LONG).show();
            startActivity(android.content.Intent.createChooser(share, getString(R.string.export_word)));
        } catch (Exception error) {
            android.widget.Toast.makeText(this,
                    getString(R.string.export_failed, String.valueOf(error.getMessage())),
                    android.widget.Toast.LENGTH_LONG).show();
        }
    }

    /** 按账号删除（服务端）：只影响自己的历史列表。 */
    private void deleteOnServer(final String roomId) {
        if (roomId == null || roomId.isEmpty()) return;
        android.content.SharedPreferences prefs = getSharedPreferences("leion", MODE_PRIVATE);
        final LanClient client = new LanClient(prefs.getString("host", ""), prefs.getString("secret", ""), null);
        String token = prefs.getString("accountToken", "");
        if (token != null && !token.isEmpty()) client.setToken(token);
        new Thread(() -> {
            String failure = "";
            try {
                org.json.JSONObject result = client.orgDeleteHistory(roomId);
                if (result == null || !result.optBoolean("ok", false)) {
                    failure = ServerText.from(this, result, "");
                }
            } catch (Exception error) {
                failure = error.getMessage() == null ? error.toString() : error.getMessage();
            }
            final String failed = failure;
            runOnUiThread(() -> {
                if (failed.isEmpty()) {
                    android.widget.Toast.makeText(this, getString(R.string.hist_deleted_local),
                            android.widget.Toast.LENGTH_SHORT).show();
                    finish();          // 回列表；列表 onResume 会重拉
                } else {
                    android.widget.Toast.makeText(this,
                            getString(R.string.hist_delete_failed, ServerText.of(this, failed)),
                            android.widget.Toast.LENGTH_LONG).show();
                }
            });
        }, "history-detail-delete").start();
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
