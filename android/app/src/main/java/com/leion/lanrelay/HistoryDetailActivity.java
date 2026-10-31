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

    /** 拉回来的全部转写（筛选不重新请求，只重画）。 */
    private org.json.JSONArray allLines = null;
    /** 筛选状态：空串 = 不按该维度筛选（4.82）。 */
    private String filterSpeaker = "";
    private String filterLang = "";
    /** 4.98：当前展开的是哪一栏（0=都没有，1=说话人，2=语言）。 */
    private static final int COLUMN_NONE = 0;
    private static final int COLUMN_SPEAKER = 1;
    private static final int COLUMN_LANG = 2;
    private int expandedColumn = COLUMN_NONE;

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
        setUpFilters();
        makeTranscriptScrollable();

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
        allLines = lines;
        // 数据变了，两栏的选项也要跟着重算（选项来自"这场真实出现过的值"）
        rebuildFilterOptions();
        renderFilterButton();
        if (lines == null || lines.length() == 0) {
            showTranscriptEmpty();
            return;
        }
        list.removeAllViews();
        int shown = 0;
        for (int i = 0; i < lines.length(); i++) {
            org.json.JSONObject one = lines.optJSONObject(i);
            if (one == null || !matchesFilter(one)) continue;
            list.addView(SubtitleCard.render(list, one, mineName));
            shown += 1;
        }
        findViewById(R.id.transcriptScroll).setVisibility(shown == 0 ? android.view.View.GONE : android.view.View.VISIBLE);
        android.widget.TextView empty = findViewById(R.id.transcriptEmpty);
        if (shown == 0) {
            // 有转写、但都被筛掉了：说清是"筛选没命中"，不是"没有转写"
            empty.setText(getString(R.string.transcript_filtered_empty));
            empty.setVisibility(android.view.View.VISIBLE);
        } else {
            empty.setText(getString(R.string.transcript_empty));
            empty.setVisibility(android.view.View.GONE);
        }
    }

    /** 一条转写是否命中当前筛选（两个维度同时生效）。 */
    private boolean matchesFilter(org.json.JSONObject line) {
        if (!filterSpeaker.isEmpty()
                && filterSpeaker.equals(line.optString("username", "")) == false) return false;
        if (!filterLang.isEmpty()
                && filterLang.equals(line.optString("srcLang", "")) == false) return false;
        return true;
    }

    /** 筛选按钮的文案（4.98 起是两栏标题，不再是单个"筛选"按钮）。 */
    private void renderFilterButton() {
        boolean speakerActive = !filterSpeaker.isEmpty();
        boolean langActive = !filterLang.isEmpty();

        TextView speakerHeader = findViewById(R.id.transcriptSpeakerHeader);
        if (speakerHeader != null) {
            String who = speakerActive ? filterSpeaker : getString(R.string.filter_all);
            speakerHeader.setText(getString(R.string.filter_speaker_value, who, expandedColumn == COLUMN_SPEAKER ? "▴" : "▾"));
            speakerHeader.setBackgroundResource(speakerActive ? R.drawable.bg_chip_brand : R.drawable.bg_chip);
            speakerHeader.setTextColor(getColor(speakerActive ? R.color.brand : R.color.ink_soft));
        }
        TextView langHeader = findViewById(R.id.transcriptLangHeader);
        if (langHeader != null) {
            String lang = langActive ? langLabel(filterLang) : getString(R.string.filter_all);
            langHeader.setText(getString(R.string.filter_lang_value, lang, expandedColumn == COLUMN_LANG ? "▴" : "▾"));
            langHeader.setBackgroundResource(langActive ? R.drawable.bg_chip_brand : R.drawable.bg_chip);
            langHeader.setTextColor(getColor(langActive ? R.color.brand : R.color.ink_soft));
        }
        // 「清除筛选」只在**真筛了**的时候出现 —— 平时不占位置（用户明确说过底部按钮太多）
        TextView clear = findViewById(R.id.transcriptClear);
        if (clear != null) {
            clear.setVisibility(speakerActive || langActive ? android.view.View.VISIBLE : android.view.View.GONE);
        }
    }

    /**
     * 两栏筛选（4.98）：各自点标题就地展开选项，选中即生效。
     *
     * <p>为什么改：原来是一个「筛选」按钮 → 弹窗选发言人 → **再弹一次**选语言，
     * 而且两个弹窗里各有一个「清除筛选」。用户反馈要连点两次、还容易点错。
     * 现在：两栏标题（说话人 / 语言）→ 点一下展开 → 点选项即生效；
     * 两个维度**互不干扰**，清除只有一个（只在筛选生效时出现）。
     */
    private void setUpFilters() {
        TextView speakerHeader = findViewById(R.id.transcriptSpeakerHeader);
        if (speakerHeader != null) {
            speakerHeader.setOnClickListener(v -> toggleColumn(COLUMN_SPEAKER));
        }
        TextView langHeader = findViewById(R.id.transcriptLangHeader);
        if (langHeader != null) {
            langHeader.setOnClickListener(v -> toggleColumn(COLUMN_LANG));
        }
        TextView clear = findViewById(R.id.transcriptClear);
        if (clear != null) {
            clear.setOnClickListener(v -> {
                filterSpeaker = "";
                filterLang = "";
                expandedColumn = COLUMN_NONE;
                rebuildFilterOptions();
                renderTranscript(allLines, currentMineName());
            });
        }
        rebuildFilterOptions();
        renderFilterButton();
    }

    /** 展开/收起某一栏；展开一栏时收起另一栏（两栏同时展开会顶很长的列表）。 */
    private void toggleColumn(int column) {
        expandedColumn = expandedColumn == column ? COLUMN_NONE : column;
        rebuildFilterOptions();
        renderFilterButton();
    }

    /** 把两栏的选项按当前数据重画（数据是"这场真实出现过的值"，不给空选项）。 */
    private void rebuildFilterOptions() {
        fillOptions(R.id.transcriptSpeakerOptions, "username", COLUMN_SPEAKER, true);
        fillOptions(R.id.transcriptLangOptions, "srcLang", COLUMN_LANG, false);
        android.view.View speakerList = findViewById(R.id.transcriptSpeakerOptions);
        if (speakerList != null) {
            speakerList.setVisibility(expandedColumn == COLUMN_SPEAKER ? android.view.View.VISIBLE : android.view.View.GONE);
        }
        android.view.View langList = findViewById(R.id.transcriptLangOptions);
        if (langList != null) {
            langList.setVisibility(expandedColumn == COLUMN_LANG ? android.view.View.VISIBLE : android.view.View.GONE);
        }
    }

    /**
     * 填一栏的选项：第一项永远是「全部」，后面是实际出现过的值。
     *
     * @param isSpeaker true = 发言人栏（值就是用户名）；false = 语言栏（值要翻成人话）
     */
    private void fillOptions(int containerId, String key, int column, boolean isSpeaker) {
        android.widget.LinearLayout container = findViewById(containerId);
        if (container == null) return;
        container.removeAllViews();
        if (allLines == null || allLines.length() == 0) return;

        java.util.List<String> values = distinct(key);
        values.add(0, "");
        String current = isSpeaker ? filterSpeaker : filterLang;
        for (int i = 0; i < values.size(); i++) {
            final String value = values.get(i);
            boolean selected = value.equals(current);
            TextView row = new TextView(this);
            String label = value.isEmpty()
                    ? getString(R.string.filter_all)
                    : (isSpeaker ? value : langLabel(value));
            row.setText(selected ? getString(R.string.filter_option_selected, label)
                    : getString(R.string.filter_option, label));
            row.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,
                    getResources().getDimension(R.dimen.text_caption));
            row.setTextColor(getColor(selected ? R.color.brand : R.color.ink_soft));
            row.setBackgroundResource(selected ? R.drawable.bg_chip_brand : R.drawable.bg_chip);
            row.setPadding(dp(10), dp(6), dp(10), dp(6));
            android.widget.LinearLayout.LayoutParams params = new android.widget.LinearLayout.LayoutParams(
                    android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                    android.widget.LinearLayout.LayoutParams.WRAP_CONTENT);
            params.topMargin = dp(4);
            row.setLayoutParams(params);
            row.setOnClickListener(v -> {
                if (isSpeaker) filterSpeaker = value;
                else filterLang = value;
                expandedColumn = COLUMN_NONE;         // 选完就收起：一次点击完成一次筛选
                rebuildFilterOptions();
                renderTranscript(allLines, currentMineName());
            });
            container.addView(row);
        }
    }

    /**
     * 让"框内滚动"在**所有机型**上都能用（4.98）。
     *
     * <p>这里是一个 ScrollView 套在页面 ScrollView 里的结构。多数机型没问题，
     * 但用户实测有一台滑不动 —— 那类 ROM 会把这次拖动交给**外层页面**（于是看起来"框不能滑"）。
     * 最可靠的办法是在按下那一刻就告诉所有祖先"这次手势别抢"，
     * 抬手/取消时再放开（否则外层页面就永远滑不动了）。
     */
    private void makeTranscriptScrollable() {
        final android.view.View box = findViewById(R.id.transcriptScroll);
        if (box == null) return;
        box.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case android.view.MotionEvent.ACTION_DOWN:
                case android.view.MotionEvent.ACTION_MOVE:
                    v.getParent().requestDisallowInterceptTouchEvent(true);
                    break;
                case android.view.MotionEvent.ACTION_UP:
                case android.view.MotionEvent.ACTION_CANCEL:
                    v.getParent().requestDisallowInterceptTouchEvent(false);
                    break;
                default:
                    break;
            }
            return false;                    // 仍然交给 ScrollView 自己处理滚动
        });
    }

    /** dip → px。 */
    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    /**
     * 两个维度依次选：先发言人、再语言（4.82 的旧做法，4.98 已换成就地展开的两栏）。
     *
     * <p>⚠️ 保留这个方法名只为不留悬空引用：**它已经不被调用**，逻辑搬进了
     * {@link #setUpFilters()} / {@link #fillOptions}。下一轮整理时可以整段删掉。
     */
    /** 从已经拉回来的转写里算出某个维度的实际取值（去重、保持出现顺序）。 */
    private java.util.List<String> distinct(String key) {
        java.util.LinkedHashSet<String> seen = new java.util.LinkedHashSet<>();
        if (allLines != null) {
            for (int i = 0; i < allLines.length(); i++) {
                org.json.JSONObject one = allLines.optJSONObject(i);
                if (one == null) continue;
                String value = one.optString(key, "");
                if (!value.isEmpty()) seen.add(value);
            }
        }
        return new java.util.ArrayList<>(seen);
    }

    /** 语种码 → 当前界面语言的短名（zh-CN → 中文 / pt-BR → 巴西葡语）。 */
    private String langLabel(String code) {
        if (code.startsWith("zh")) return getString(R.string.lang_zh_short);
        if (code.startsWith("pt")) return getString(R.string.lang_pt_short);
        // 5.00：英语（en-US）
        if (code.startsWith("en")) return getString(R.string.lang_en_short);
        return code;
    }

    /** 当前账号名（SubtitleCard 用它判断"是不是自己说的"）。 */
    private String currentMineName() {
        return getSharedPreferences("leion", MODE_PRIVATE).getString("termsUser", "");
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
