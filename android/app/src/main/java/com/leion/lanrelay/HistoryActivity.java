package com.leion.lanrelay;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 历史记录（4.69）。
 *
 * <p>数据来自 {@code GET /org/history}：服务端只返回**我参加过**的会议，按时间倒序，
 * 每条带卡片要的六样（名称 / 类型 / 时间 / 时长 / 人数 / 语言），另外给一个
 * {@code retentionDays} 用来写顶部的"记录保存 N 天"——那个值由服务端定，客户端不编。
 *
 * <p>⚠️ 类型（标签）只有两种：**同传会议** / **同传翻译官**。
 * 不拿"面对面 / 远程"当类型：那是场景，不是记录种类，混进标签里会让同一件事有两种分类方式。
 */
public class HistoryActivity extends android.app.Activity {

    private static final String PREFS = "leion";
    private static final int PAGE_LIMIT = 50;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LanClient client;

    private TextView retentionView;
    private TextView emptyView;
    private TextView hintView;
    private LinearLayout list;
    /** 当前账号（只用来填确认对话框的副标题）。 */
    private String userName = "";

    @Override
    protected void attachBaseContext(android.content.Context base) {
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        UiLang.trackShown(this);
        NavTabs.apply(this, NavTabs.HISTORY);
        load();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_history);

        retentionView = findViewById(R.id.historyRetention);
        emptyView = findViewById(R.id.historyEmpty);
        hintView = findViewById(R.id.historyHint);
        list = findViewById(R.id.historyList);

        findViewById(R.id.homeNavHome).setOnClickListener(v -> goHome());
        findViewById(R.id.homeNavMe).setOnClickListener(v ->
                startActivity(new Intent(this, MeActivity.class)));
        findViewById(R.id.homeNavHistory).setOnClickListener(v -> { });

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        userName = prefs.getString("termsUser", "");
        client = new LanClient(prefs.getString("host", ""), prefs.getString("secret", ""), null);
        String token = prefs.getString("accountToken", "");
        if (token == null || token.isEmpty()) {
            hintView.setVisibility(View.VISIBLE);
            hintView.setText(getString(R.string.hist_need_login));
            emptyView.setVisibility(View.VISIBLE);
            return;
        }
        client.setToken(token);
        load();
    }

    /** 首页那颗：回到返回栈里已有的首页（没有才新开），别叠出一串。 */
    private void goHome() {
        Intent intent = new Intent(this, HomeActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
    }

    private void load() {
        final String token = getSharedPreferences(PREFS, MODE_PRIVATE).getString("accountToken", "");
        if (token == null || token.isEmpty()) return;
        new Thread(() -> {
            JSONObject body = null;
            String failure = "";
            try {
                body = client.orgHistory(PAGE_LIMIT);
            } catch (Exception error) {
                failure = error.getMessage() == null ? error.toString() : error.getMessage();
            }
            final JSONObject result = body;
            final String error = failure;
            ui.post(() -> render(result, error));
        }, "history-load").start();
    }

    private void render(JSONObject body, String error) {
        list.removeAllViews();
        if (error != null && !error.isEmpty()) {
            hintView.setVisibility(View.VISIBLE);
            hintView.setText(getString(R.string.hist_load_failed, ServerText.of(this, error)));
        } else {
            hintView.setVisibility(View.GONE);
        }
        int retentionDays = body == null ? 0 : body.optInt("retentionDays", 0);
        if (retentionDays > 0) {
            retentionView.setText(getString(R.string.hist_retention, retentionDays));
        } else {
            retentionView.setText("");
        }
        JSONArray items = body == null ? null : body.optJSONArray("items");
        if (items == null || items.length() == 0) {
            emptyView.setVisibility(View.VISIBLE);
            return;
        }
        LayoutInflater inflater = LayoutInflater.from(this);
        int shown = 0;
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            list.addView(card(inflater, item));
            shown += 1;
        }
        emptyView.setVisibility(shown == 0 ? View.VISIBLE : View.GONE);
        hintView.setVisibility(shown == 0 ? View.GONE : View.VISIBLE);
        if (shown > 0) hintView.setText(getString(R.string.hist_long_press_hint));
    }

    private View card(LayoutInflater inflater, final JSONObject item) {
        View row = inflater.inflate(R.layout.item_history, list, false);
        TextView nameView = row.findViewById(R.id.itemName);
        TextView kindView = row.findViewById(R.id.itemKind);
        TextView metaView = row.findViewById(R.id.itemMeta);
        TextView langsView = row.findViewById(R.id.itemLangs);

        String name = item.optString("name", "");
        nameView.setText(name.isEmpty() ? getString(R.string.hist_unknown_name) : name);
        kindView.setText(kindLabel(item.optString("kind", "meeting")));

        String when = formatDate(item.optString("createdAt", ""));
        String duration = formatDuration(item.optInt("durationSeconds", 0));
        String people = peopleLabel(item.optInt("members", 0));
        StringBuilder meta = new StringBuilder();
        meta.append(when).append(" · ").append(duration).append(" · ").append(people);
        if (item.optBoolean("active", false)) {
            meta.append(" · ").append(getString(R.string.hist_active));
        }
        metaView.setText(meta.toString());
        langsView.setText(langsLabel(item.optJSONArray("langs")));

        row.setOnClickListener(v -> {
            Intent intent = new Intent(this, HistoryDetailActivity.class);
            intent.putExtra(HistoryDetailActivity.EXTRA_JSON, item.toString());
            startActivity(intent);
        });
        // 长按 = 删除这条历史（**按账号**，不影响别人）。为什么用长按：
        // 卡片本身要能点进详情，再挂一个删除按钮会把列表弄乱。
        row.setOnLongClickListener(v -> {
            confirmDelete(item.optString("id", ""), item.optString("name", ""));
            return true;
        });
        return row;
    }

    /** 删除这条历史：先确认，并且把"只影响自己这个账号"说清楚。 */
    private void confirmDelete(final String roomId, String name) {
        if (roomId == null || roomId.isEmpty()) return;
        String title = name == null || name.isEmpty() ? getString(R.string.hist_unknown_name) : name;
        new android.app.AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(R.string.hist_delete_confirm)
                .setNegativeButton(R.string.common_cancel, null)
                .setPositiveButton(R.string.hist_delete_local, (dialog, which) -> deleteOnServer(roomId))
                .show();
    }

    /** 真正删除：叫服务端把这条从**我这个账号的**历史里去掉。 */
    private void deleteOnServer(final String roomId) {
        if (roomId == null || roomId.isEmpty()) return;
        new Thread(() -> {
            String failure = "";
            try {
                JSONObject result = client.orgDeleteHistory(roomId);
                if (result == null || !result.optBoolean("ok", false)) {
                    failure = ServerText.from(this, result, "");
                }
            } catch (Exception error) {
                failure = error.getMessage() == null ? error.toString() : error.getMessage();
            }
            final String failed = failure;
            ui.post(() -> {
                if (failed.isEmpty()) {
                    Toast.makeText(this, getString(R.string.hist_deleted_local),
                            Toast.LENGTH_SHORT).show();
                    load();                     // 重拉：服务端已经不返回这条了
                } else {
                    Toast.makeText(this, getString(R.string.hist_delete_failed,
                            ServerText.of(this, failed)), Toast.LENGTH_LONG).show();
                }
            });
        }, "history-delete").start();
    }

    /** 类型标签：只有两种含义（同传会议 / 同传翻译官），别往里塞场景。 */
    private String kindLabel(String kind) {
        if ("interpreter".equals(kind)) return getString(R.string.hist_type_interpreter);
        return getString(R.string.hist_type_meeting);
    }

    private String peopleLabel(int members) {
        if (members <= 1) return getString(R.string.hist_only_me);
        return getString(R.string.hist_members, members);
    }

    /** 服务端给的是 ISO-8601（2026-10-29T08:17:38.625Z）；卡片上只要到分钟。 */
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

    /** 掺与语言：把服务端给的语种码换成当前界面语言的名字，组成"中文 ↔ 巴西葡语"。 */
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
