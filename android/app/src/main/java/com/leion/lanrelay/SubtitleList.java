package com.leion.lanrelay;

import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * 字幕片段列表（同传页与全屏页共用）。
 *
 * 这个类只管三件规范里反复强调的事：
 *
 *  1. **同一片段的流式结果必须原位更新**，不能每收到一次增量就新增一条。
 *     做法：用**原文**当片段的身份 —— 一句话从"增量 → 定稿 → 校对修订"，
 *     它的原文始终不变，所以这三帧都会落到同一条上，屏幕上是"同一条字幕在变长/被改"。
 *     已知边角情况：连着说两句一模一样的话会被并成一条。这是个取舍 ——
 *     宁可偶尔并一条，也不要每 400ms 冒出一条新字幕（那才是真正没法读的）。
 *
 *  2. **默认跟随最新，用户向上翻之后就不再拉他回去**（规范原文）。
 *     判断方式是"滚动条是否停在底部附近"，而不是记住用户的意图 ——
 *     手指一动就暂停跟随，点「回到最新」再恢复。
 *
 *  3. 字号与"双语/仅译文"是**整体设置**，所以统一按比例缩放基准字号，
 *     不去改每个 TextView 的绝对值（避免设置改一次就要遍历所有历史片段）。
 */
public class SubtitleList {

    /** 一个片段。 */
    public static class Segment {
        public final String time;
        public final String source;
        public String target;
        public boolean partial;
        /** 5.54：这条译文是哪门语言（`中文` / `English`…）。空 = 老客户端没给（不显示标签）。 */
        public final String langLabel;
        public final View view;
        public final TextView sourceView;
        public final TextView targetView;
        public final TextView tagView;
        public final TextView noteView;
        public final TextView langView;

        Segment(String time, String source, String langLabel, View view, TextView sourceView,
                TextView targetView, TextView tagView, TextView noteView, TextView langView) {
            this.time = time;
            this.source = source;
            this.langLabel = langLabel == null ? "" : langLabel;
            this.view = view;
            this.sourceView = sourceView;
            this.targetView = targetView;
            this.tagView = tagView;
            this.noteView = noteView;
            this.langView = langView;
        }
    }

    /** 基准字号（item_subtitle.xml 里的值），缩放时以它为基准。 */
    private static final float BASE_SOURCE_SP = 16f;
    private static final float BASE_TARGET_SP = 22f;
    /**
     * 拉丁字母译文的字号（5.106）。
     *
     * <p>为什么同一张卡要按语种取两个值：同样 22sp，一串葡语/英语的**视觉体量明显大于**中文
     * ——汉字是方块、拉丁字母窄而矮，但词与词之间要留空格、且单词不能被拆开，
     * 于是同样宽度下拉丁文本占的行数更多、看着"更大更挤"。用户实测的原话是"译文太大"。
     * 降 2sp（约 9%）既能看清又不再顶格。
     */
    private static final float BASE_TARGET_SP_LATIN = 20f;
    private static final float BASE_TIME_SP = 11f;
    private static final float BASE_NOTE_SP = 12f;
    /** 「生成中」/语言标签：小胶囊，跟着字号缩放但不超过基准的 1.3 倍。 */
    private static final float BASE_CHIP_SP = 10f;

    private final LayoutInflater inflater;
    private final ScrollView scroll;
    private final LinearLayout list;
    private final TextView backToLatest;
    private final List<Segment> segments = new ArrayList<>();

    private boolean bilingual = true;
    private float scale = 1f;
    private boolean following = true;
    private boolean suppressScrollCallback = false;

    public SubtitleList(LayoutInflater inflater, ScrollView scroll, LinearLayout list,
                       TextView backToLatest) {
        this.inflater = inflater;
        this.scroll = scroll;
        this.list = list;
        this.backToLatest = backToLatest;

        // 手指一碰滚动区就认为"用户在自己看历史" → 暂停跟随。
        // 5.170：**跟随的判据改成"在不在底部"，而不是"有没有碰过屏幕"**。
        //
        // 原来是 ACTION_DOWN 就把 following 置 false —— 用户哪怕只是想点一下、或者
        // 轻轻一碰把列表停住，从此新字幕**再也不自动滚**了（用户实测："会议和翻译官
        // 界面都不能定位到最新字幕，要手动下翻"）。
        // 现在：松手时看位置 —— 停在底部就继续跟随，翻上去了才停；而且滚回底部会自动恢复。
        scroll.setOnTouchListener((v, event) -> {
            if (event.getAction() == android.view.MotionEvent.ACTION_UP
                    || event.getAction() == android.view.MotionEvent.ACTION_CANCEL) {
                following = isAtBottom();
                updateBackToLatest();
            }
            return false;
        });
        // 位置一变就重算（程序化滚动那一下不算：suppressScrollCallback 期间跳过）
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            scroll.setOnScrollChangeListener((v, x, y, oldX, oldY) -> {
                if (suppressScrollCallback) return;
                boolean atBottom = isAtBottom();
                if (atBottom != following) {
                    following = atBottom;
                    updateBackToLatest();
                }
            });
        }
        if (backToLatest != null) {
            backToLatest.setOnClickListener(v -> {
                following = true;
                updateBackToLatest();
                scrollToBottom();
            });
        }
    }

    public List<Segment> segments() {
        return segments;
    }

    public int size() {
        return segments.size();
    }

    public boolean isEmpty() {
        return segments.isEmpty();
    }

    public void setBilingual(boolean value) {
        bilingual = value;
        for (Segment segment : segments) {
            segment.sourceView.setVisibility(value ? View.VISIBLE : View.GONE);
        }
    }

    public boolean isBilingual() {
        return bilingual;
    }

    public float getScale() {
        return scale;
    }

    /** 按比例缩放整个列表（规范：提供字体大小调节）。 */
    public void setScale(float value) {
        scale = value;
        for (Segment segment : segments) {
            applyScale(segment);
        }
    }

    private void applyScale(Segment segment) {
        segment.sourceView.setTextSize(TypedValue.COMPLEX_UNIT_SP, BASE_SOURCE_SP * scale);
        // 5.106：译文按"有没有汉字"取字号 —— 拉丁文本同字号看起来更大（见 BASE_TARGET_SP_LATIN）
        segment.targetView.setTextSize(TypedValue.COMPLEX_UNIT_SP,
                targetBaseSp(segment.target) * scale);
        // 观测提示不跟着放大那么多：它是旁注，不该抢正文的注意力
        segment.noteView.setTextSize(TypedValue.COMPLEX_UNIT_SP, BASE_NOTE_SP * Math.min(scale, 1.2f));
        // 时间标记不跟着放大那么多，否则会喧宾夺主
        ((TextView) segment.view.findViewById(R.id.segTime))
                .setTextSize(TypedValue.COMPLEX_UNIT_SP, BASE_TIME_SP * Math.min(scale, 1.3f));
        // 5.106：小胶囊同理（它们是标签，不该跟正文一起变大）
        if (segment.langView != null) {
            segment.langView.setTextSize(TypedValue.COMPLEX_UNIT_SP,
                    BASE_CHIP_SP * Math.min(scale, 1.3f));
        }
        segment.tagView.setTextSize(TypedValue.COMPLEX_UNIT_SP,
                BASE_CHIP_SP * Math.min(scale, 1.3f));
    }

    /** 译文该用的基准字号：含汉字用中文那档，纯拉丁字母用略小一档。 */
    private static float targetBaseSp(String text) {
        return containsCjk(text) ? BASE_TARGET_SP : BASE_TARGET_SP_LATIN;
    }

    /** 这串文字里有没有汉字（与眼镜那边的判据同一套：码位 ≥ 0x2E80）。 */
    private static boolean containsCjk(String text) {
        if (text == null) return false;
        for (int index = 0; index < text.length(); index += 1) {
            if (text.charAt(index) >= 0x2E80) return true;
        }
        return false;
    }

    /** 清空（开始新的会话时用）。 */
    public void clear() {
        list.removeAllViews();
        segments.clear();
        following = true;
        updateBackToLatest();
    }

    /**
     * 收到一帧字幕：同一句原文就原位更新，新原文就新增一条。
     *
     * @param time     时间标记（mm:ss，由调用方按会话时钟给）
     * @param source   原文；空串表示这一帧没有原文可用
     * @param target   给佩戴者看的那一侧
     * @param partial  true = 还在生成（打「生成中」标签）
     * @param note     旁注（热词观测提示）；空串 = 不显示
     */
    public Segment submit(String time, String source, String target, boolean partial) {
        return submit(time, source, target, partial, "");
    }

    public Segment submit(String time, String source, String target, boolean partial, String note) {
        return submit(time, source, target, partial, note, "");
    }

    /**
     * 收到一帧字幕（5.54：多了"这门译文是哪种语言"）。
     *
     * <p>为什么语言标签会进"身份"：一个人可能同时看两种译文（我说葡语，英文和中文都想看），
     * 同一句原文会有**两条**译文。若仍按原文归并，第二条会把第一条覆盖掉 ——
     * 用户勾了两种、只看得到一种，而且不报错。所以身份 = 原文 + 语言标签。
     *
     * @param langLabel 这门译文语言的显示名（`中文` / `English` / `葡萄牙语`）；空 = 不显示标签
     */
    public Segment submit(String time, String source, String target, boolean partial, String note,
                          String langLabel) {
        String label = langLabel == null ? "" : langLabel.trim();
        Segment segment = find(source, label);
        if (segment == null) {
            segment = create(time, source, label);
            segments.add(segment);
            list.addView(segment.view);
        }
        segment.target = target;
        segment.partial = partial;
        segment.targetView.setText(target);
        // 热词观测旁注：跟着这一版译文走 —— 校对把名字补对时，提示会自动消失
        segment.noteView.setText(note == null ? "" : note);
        segment.noteView.setVisibility(
                note == null || note.isEmpty() ? View.GONE : View.VISIBLE);
        // 「生成中」用略浅的字色 + 小标签，定稿后恢复正常深色
        segment.targetView.setTextColor(segment.targetView.getResources()
                .getColor(partial ? R.color.ink_soft : R.color.ink, null));
        segment.targetView.setTypeface(null, partial ? Typeface.NORMAL : Typeface.NORMAL);
        segment.tagView.setVisibility(partial ? View.VISIBLE : View.GONE);
        if (!partial) {
            // 定稿了就把分隔线露出来（最后一条没有分隔线更干净）
            segment.view.findViewById(R.id.segDivider).setVisibility(View.VISIBLE);
        }
        applyScale(segment);
        if (following) scrollToBottom();
        else updateBackToLatest();
        return segment;
    }

    /**
     * 按 (原文, 语言标签) 找同一条片段。
     *
     * <p>原文为空时按"最后一条"处理（没有原文可认，只能续写）；此时也要求语言标签一致，
     * 否则"中文那份"和"英文那份"会互相续写到对方身上。
     */
    private Segment find(String source, String langLabel) {
        if (segments.isEmpty()) return null;
        String label = langLabel == null ? "" : langLabel.trim();
        if (source == null || source.isEmpty()) {
            Segment last = segments.get(segments.size() - 1);
            if (!last.partial) return null;
            return last.langLabel.equals(label) ? last : null;
        }
        for (int index = segments.size() - 1; index >= 0; index--) {
            Segment segment = segments.get(index);
            if (source.equals(segment.source) && segment.langLabel.equals(label)) return segment;
        }
        return null;
    }

    private Segment create(String time, String source, String langLabel) {
        View view = inflater.inflate(R.layout.item_subtitle, list, false);
        TextView sourceView = view.findViewById(R.id.segSource);
        TextView targetView = view.findViewById(R.id.segTarget);
        TextView tagView = view.findViewById(R.id.segTag);
        TextView noteView = view.findViewById(R.id.segNote);
        TextView langView = view.findViewById(R.id.segLang);
        TextView timeView = view.findViewById(R.id.segTime);
        timeView.setText(time);
        sourceView.setText(source);
        sourceView.setVisibility(bilingual ? View.VISIBLE : View.GONE);
        tagView.setVisibility(View.GONE);
        noteView.setVisibility(View.GONE);
        // 5.54：语言标签（空 = 不显示，老客户端行为不变）
        String label = langLabel == null ? "" : langLabel.trim();
        if (langView != null) {
            langView.setText(label);
            langView.setVisibility(label.isEmpty() ? View.GONE : View.VISIBLE);
        }
        // 5.106：语言标签与小胶囊在**最上面那行**（与时间同一行），译文拿整卡宽度 ——
        // 详见 item_subtitle.xml 顶部注释（挤在译文旁边时，多行文字会让胶囊看着"歪"）。
        return new Segment(time, source == null ? "" : source, label, view,
                sourceView, targetView, tagView, noteView, langView);
    }

    /**
     * 5.170：滚到最新一条。
     *
     * <p>`fullScroll(FOCUS_DOWN)` 在"刚 addView、还没完成布局"时**经常什么都不做**
     * （它靠焦点找目标，而字幕里的 TextView 不抢焦点）。所以改成直接滚到内容高度，
     * 并连做两次：第一次在布局后，第二次兜住"内容又长高了一点"的那种情况。
     */
    private void scrollToBottom() {
        suppressScrollCallback = true;
        Runnable toBottom = () -> {
            int height = list.getHeight();
            scroll.scrollTo(0, height);
        };
        scroll.post(toBottom);
        scroll.postDelayed(toBottom, 60);
        scroll.postDelayed(() -> {
            suppressScrollCallback = false;
            following = true;
            updateBackToLatest();
        }, 120);
    }

    /** 现在是不是停在底部（留一点容差：一两行的高度不算"翻上去了"）。 */
    private boolean isAtBottom() {
        if (scroll == null) return true;
        int content = list.getHeight();
        int visible = scroll.getHeight();
        if (content <= visible) return true;
        return scroll.getScrollY() + visible >= content - dp(48);
    }

    private int dp(int value) {
        return Math.round(scroll.getResources().getDisplayMetrics().density * value);
    }

    private void updateBackToLatest() {
        if (backToLatest == null) return;
        backToLatest.setVisibility(following ? View.GONE : View.VISIBLE);
    }

    /** 用户点过历史之后，把跟随恢复（比如切换会话）。 */
    public void resumeFollowing() {
        following = true;
        updateBackToLatest();
        scrollToBottom();
    }

    public boolean isFollowing() {
        return following;
    }
}
