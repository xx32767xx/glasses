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
    /**
     * 只看某一类记录（5.37）：`"interpreter"` = 只列同传翻译官会话。
     *
     * <p>为什么用过滤而不是另写一页：两类记录**同表同结构**（5.35），列表的取数、排版、
     * 长按删除、详情跳转全在同一个文件里。多一个 kind 参数就够了，复制一页只会漂。
     * 不传（底部导航进来）= 全部。
     */
    public static final String EXTRA_KIND = "historyKindFilter";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LanClient client;

    private TextView retentionView;
    private TextView emptyView;
    private TextView hintView;
    private LinearLayout list;
    /** 当前账号（只用来填确认对话框的副标题）。 */
    private String userName = "";
    /** 只看这一类（空 = 全部）。来自 {@link #EXTRA_KIND}，翻译官页的「查看全部」用它。 */
    private String kindFilter = "";

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
        // 5.37：只列某一类时（翻译官页的「查看全部」传 interpreter）
        android.content.Intent from = getIntent();
        String wanted = from == null ? "" : from.getStringExtra(EXTRA_KIND);
        kindFilter = wanted == null ? "" : wanted.trim();

        // 底部导航（4.93）：统一走 NavTabs.go —— 交叉淡化换页，不用默认的"从右侧推入覆盖"
        findViewById(R.id.homeNavHome).setOnClickListener(v -> NavTabs.go(this, NavTabs.HOME));
        findViewById(R.id.homeNavMe).setOnClickListener(v -> NavTabs.go(this, NavTabs.ME));
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

    /**
     * 返回键也走同一套淡化（4.93）：否则点导航是淡化、按返回是"从右侧推回"，
     * 同一件事两种动画，看着像两个机制在抢。
     */
    @Override
    public void onBackPressed() {
        super.onBackPressed();
        overridePendingTransition(R.anim.nav_fade_in, R.anim.nav_fade_out);
    }

    /** 回到首页（4.93 起只是转调 {@link NavTabs#go}，动画与底部导航完全一致）。
     *
     * <p>保留这个薄壳是因为它被别的路径用到（详情页返回、空状态引导），
     * 而"回首页"的行为只能有一处实现 —— 分散写就会各用各的动画。
     */
    private void goHome() {
        NavTabs.go(this, NavTabs.HOME);
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
        // 5.37：只列翻译官时，空态说"还没有同传记录"（说"还没有会议记录"会让人以为点错了地方）
        emptyView.setText(kindFilter.isEmpty() ? getString(R.string.hist_empty) : getString(R.string.interp_hist_empty));
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
            // 5.37：带了 kind 过滤就跳过别的类型（判断与客户端别处一致：缺省当会议）
            if (!kindFilter.isEmpty() && !kindFilter.equals(item.optString("kind", "meeting"))) continue;
            list.addView(card(inflater, item));
            shown += 1;
        }
        emptyView.setVisibility(shown == 0 ? View.VISIBLE : View.GONE);
        hintView.setVisibility(shown == 0 ? View.GONE : View.VISIBLE);
        if (shown > 0) hintView.setText(getString(R.string.hist_long_press_hint));
    }

    /** 长按 = 删除这条历史（**按账号**，不影响别人）。为什么用长按：
     * 卡片本身要能点进详情，再挂一个删除按钮会把列表弄乱。
     *
     * <p>5.37：卡片的填字与"点进详情"收在 {@link HistoryRows}（翻译官页的「历史」块也用那一份）；
     * 只有删除留在这里 —— 那是**历史页**才有的操作。
     */
    private View card(LayoutInflater inflater, final JSONObject item) {
        View row = HistoryRows.create(this, list, item);
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

    // 类型标签 / 日期 / 时长 / 语种 / 人数的显示规则收在 HistoryRows（5.37）：
    // 翻译官页的「历史」块用的是同一份实现，复制在这里就会两处各自漂。
}
