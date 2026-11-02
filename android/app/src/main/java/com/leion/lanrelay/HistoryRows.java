package com.leion.lanrelay;

import android.app.Activity;
import android.content.Intent;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * HistoryRows —— 一条历史记录怎么显示（5.37 抽出来的一份实现）。
 * ============================================================================
 * 为什么要有它：同传翻译官页里的「历史」块和底部导航的「历史」页显示的是**同一种记录**
 * （5.35：两类记录同表同结构），只是取数范围不同。以前这份排版只有一处，现在要两处 ——
 * 复制一份的话，将来"时长怎么显示 / 语言怎么写"一改就会漂。
 *
 * <p>分工刻意这样切：
 * <ul>
 *   <li>{@link #create} / {@link #bind}：**只负责**填字 + 点进详情（两处完全一样）；</li>
 *   <li>长按删除留在历史页自己那一层 —— 翻译官页里那块是"最近几场"的速览，
 *       删除的入口统一放在历史页，免得同一份数据有两个删除路径。</li>
 * </ul>
 */
final class HistoryRows {

    private HistoryRows() {
    }

    /** 建一行并填好（父容器只是用来拿 LayoutParams）。 */
    static View create(Activity activity, LinearLayout parent, JSONObject item) {
        View row = LayoutInflater.from(activity).inflate(R.layout.item_history, parent, false);
        bind(activity, row, item);
        return row;
    }

    /** 把一条记录填进这一行（含"点进详情"）。 */
    static void bind(final Activity activity, View row, final JSONObject item) {
        TextView nameView = row.findViewById(R.id.itemName);
        TextView kindView = row.findViewById(R.id.itemKind);
        TextView metaView = row.findViewById(R.id.itemMeta);
        TextView langsView = row.findViewById(R.id.itemLangs);

        String name = item.optString("name", "");
        nameView.setText(name.isEmpty() ? activity.getString(R.string.hist_unknown_name) : name);
        kindView.setText(kindLabel(activity, item.optString("kind", "meeting")));

        String when = formatDate(item.optString("createdAt", ""));
        String duration = formatDuration(activity, item.optInt("durationSeconds", 0));
        String people = peopleLabel(activity, item.optInt("members", 0));
        StringBuilder meta = new StringBuilder();
        meta.append(when).append(" · ").append(duration).append(" · ").append(people);
        if (item.optBoolean("active", false)) {
            meta.append(" · ").append(activity.getString(R.string.hist_active));
        }
        metaView.setText(meta.toString());
        langsView.setText(langsLabel(activity, item.optJSONArray("langs")));

        row.setOnClickListener(v -> {
            Intent intent = new Intent(activity, HistoryDetailActivity.class);
            intent.putExtra(HistoryDetailActivity.EXTRA_JSON, item.toString());
            activity.startActivity(intent);
        });
    }

    /** 类型标签：只有两种含义（会议 / 同传翻译官），别往里塞场景。 */
    static String kindLabel(Activity activity, String kind) {
        if ("interpreter".equals(kind)) return activity.getString(R.string.hist_type_interpreter);
        return activity.getString(R.string.hist_type_meeting);
    }

    private static String peopleLabel(Activity activity, int members) {
        if (members <= 1) return activity.getString(R.string.hist_only_me);
        return activity.getString(R.string.hist_members, members);
    }

    /** 服务端给的是 ISO-8601（2026-10-29T08:17:38.625Z）；卡片上只要到分钟。 */
    private static String formatDate(String iso) {
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

    private static String formatDuration(Activity activity, int seconds) {
        if (seconds < 60) return activity.getString(R.string.hist_duration_short);
        int minutes = seconds / 60;
        if (minutes < 60) return activity.getString(R.string.hist_duration_minutes, minutes);
        return activity.getString(R.string.hist_duration_hours, minutes / 60, minutes % 60);
    }

    /**
     * 参与语言：把语种码换成当前界面语言的名字，组成"中文 ↔ 巴西葡语"。
     *
     * <p>两两互译（最常见）仍走 {@code hist_langs} 那条本地化文案；
     * 三种语言同时出现时退回用「↔」串起来（那时没有现成的一句话可用）。
     */
    private static String langsLabel(Activity activity, JSONArray langs) {
        if (langs == null || langs.length() == 0) return activity.getString(R.string.hist_langs_unknown);
        StringBuilder zh = new StringBuilder();
        StringBuilder pt = new StringBuilder();
        StringBuilder en = new StringBuilder();
        for (int i = 0; i < langs.length(); i++) {
            String code = langs.optString(i, "");
            if (code.startsWith("zh")) {
                if (zh.length() > 0) zh.append(" / ");
                zh.append(activity.getString(R.string.lang_zh_short));
            } else if (code.startsWith("pt")) {
                if (pt.length() > 0) pt.append(" / ");
                pt.append(activity.getString(R.string.lang_pt_short));
            } else if (code.startsWith("en")) {
                if (en.length() > 0) en.append(" / ");
                en.append(activity.getString(R.string.lang_en_short));
            }
        }
        if (zh.length() > 0 && pt.length() > 0 && en.length() == 0) {
            return activity.getString(R.string.hist_langs, zh.toString(), pt.toString());
        }
        StringBuilder out = new StringBuilder();
        for (CharSequence part : new CharSequence[] { zh, pt, en }) {
            if (part.length() == 0) continue;
            if (out.length() > 0) out.append(" ↔ ");
            out.append(part);
        }
        return out.length() == 0 ? activity.getString(R.string.hist_langs_unknown) : out.toString();
    }
}
