package com.leion.lanrelay;

import android.graphics.PorterDuff;
import android.view.View;
import android.widget.ImageView;
import android.widget.TextView;

/**
 * 底部一级导航的"当前在哪一页"高亮（4.62）。
 *
 * <p>为什么单独写一个：导航是 {@code inc_bottom_nav} 抽出来的公共片段，首页与「我的」都要用它；
 * 高亮逻辑复制两份一定会漂（一处改了另一处忘）。历史那一项永远是灰的 —— 它还没做。
 */
public final class NavTabs {

    /** 首页。 */
    public static final int HOME = 0;
    /** 历史（还没有内容，永远不高亮）。 */
    public static final int HISTORY = 1;
    /** 我的。 */
    public static final int ME = 2;

    private NavTabs() {
    }

    /** 显示导航并把 active 那一项高亮。 */
    public static void apply(android.app.Activity activity, int active) {
        View bar = activity.findViewById(R.id.homeBottomNav);
        if (bar != null) bar.setVisibility(View.VISIBLE);
        style(activity, R.id.homeNavHomeIcon, R.id.homeNavHomeLabel, active == HOME);
        // 4.69 起历史有页面了，这一项跟其它两项一样可点亮（之前是永远灰的占位）。
        style(activity, R.id.homeNavHistoryIcon, R.id.homeNavHistoryLabel, active == HISTORY);
        style(activity, R.id.homeNavMeIcon, R.id.homeNavMeLabel, active == ME);
    }

    private static void style(android.app.Activity activity, int iconId, int labelId, boolean on) {
        int color = activity.getColor(on ? R.color.brand : R.color.ink_faint);
        View icon = activity.findViewById(iconId);
        if (icon instanceof ImageView) {
            ((ImageView) icon).setColorFilter(color, PorterDuff.Mode.SRC_IN);
        }
        View label = activity.findViewById(labelId);
        if (label instanceof TextView) ((TextView) label).setTextColor(color);
    }
}
