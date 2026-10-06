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
        public final View view;
        public final TextView sourceView;
        public final TextView targetView;
        public final TextView tagView;

        Segment(String time, String source, View view, TextView sourceView,
                TextView targetView, TextView tagView) {
            this.time = time;
            this.source = source;
            this.view = view;
            this.sourceView = sourceView;
            this.targetView = targetView;
            this.tagView = tagView;
        }
    }

    /** 基准字号（item_subtitle.xml 里的值），缩放时以它为基准。 */
    private static final float BASE_SOURCE_SP = 16f;
    private static final float BASE_TARGET_SP = 22f;
    private static final float BASE_TIME_SP = 11f;

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
        // 用 onTouchListener 而不是 onScrollChanged：后者在程序化滚动时也会触发，
        // 会把"自动跟随"自己关掉，表现成字幕出了几条之后就不再自动滚了。
        scroll.setOnTouchListener((v, event) -> {
            if (event.getAction() == android.view.MotionEvent.ACTION_DOWN) {
                following = false;
                updateBackToLatest();
            }
            return false;
        });
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
        segment.targetView.setTextSize(TypedValue.COMPLEX_UNIT_SP, BASE_TARGET_SP * scale);
        // 时间标记不跟着放大那么多，否则会喧宾夺主
        ((TextView) segment.view.findViewById(R.id.segTime))
                .setTextSize(TypedValue.COMPLEX_UNIT_SP, BASE_TIME_SP * Math.min(scale, 1.3f));
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
     */
    public Segment submit(String time, String source, String target, boolean partial) {
        Segment segment = find(source);
        if (segment == null) {
            segment = create(time, source);
            segments.add(segment);
            list.addView(segment.view);
        }
        segment.target = target;
        segment.partial = partial;
        segment.targetView.setText(target);
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

    /** 按原文找同一条片段。原文为空时按"最后一条"处理（没有原文可认，只能续写）。 */
    private Segment find(String source) {
        if (segments.isEmpty()) return null;
        if (source == null || source.isEmpty()) {
            Segment last = segments.get(segments.size() - 1);
            return last.partial ? last : null;
        }
        for (int index = segments.size() - 1; index >= 0; index--) {
            Segment segment = segments.get(index);
            if (source.equals(segment.source)) return segment;
        }
        return null;
    }

    private Segment create(String time, String source) {
        View view = inflater.inflate(R.layout.item_subtitle, list, false);
        TextView sourceView = view.findViewById(R.id.segSource);
        TextView targetView = view.findViewById(R.id.segTarget);
        TextView tagView = view.findViewById(R.id.segTag);
        TextView timeView = view.findViewById(R.id.segTime);
        timeView.setText(time);
        sourceView.setText(source);
        sourceView.setVisibility(bilingual ? View.VISIBLE : View.GONE);
        tagView.setVisibility(View.GONE);
        return new Segment(time, source == null ? "" : source, view, sourceView, targetView, tagView);
    }

    private void scrollToBottom() {
        suppressScrollCallback = true;
        scroll.post(() -> {
            scroll.fullScroll(View.FOCUS_DOWN);
            suppressScrollCallback = false;
            updateBackToLatest();
        });
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
