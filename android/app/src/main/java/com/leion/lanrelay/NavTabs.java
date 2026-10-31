package com.leion.lanrelay;

import android.app.Activity;
import android.content.Intent;
import android.graphics.PorterDuff;
import android.view.View;
import android.widget.ImageView;
import android.widget.TextView;

/**
 * 底部一级导航：高亮当前项（4.62）+ **统一负责切换**（4.93）。
 *
 * <p>为什么单独写一个：导航是 {@code inc_bottom_nav} 抽出来的公共片段，首页/历史/我的都要用它；
 * 高亮与切换逻辑复制三份一定会漂（一处改了另两处忘）。
 *
 * <p><b>4.93 修的是"切换不平滑"</b>：原来三个页面各自 {@code startActivity(new Intent(...))}，
 * 走的是 Activity 默认转场 —— 也就是"打开下一层：从右侧推入、把旧页盖住"。
 * 底部导航是**平级切换**，用户心智是"换了一页"，不是"进去了"，
 * 所以现在统一走 {@link #go(Activity, int)}：交叉淡化（120ms，无水平位移）+ 复用已有实例。
 */
public final class NavTabs {

    /** 首页。 */
    public static final int HOME = 0;
    /** 历史。 */
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
        style(activity, R.id.homeNavHistoryIcon, R.id.homeNavHistoryLabel, active == HISTORY);
        style(activity, R.id.homeNavMeIcon, R.id.homeNavMeLabel, active == ME);
    }

    /**
     * 切到某一页（底部导航的唯一入口）。
     *
     * <p>两条规则：
     * <ol>
     *   <li><b>不复用旧实例吗？要复用</b>：{@code FLAG_ACTIVITY_REORDER_TO_FRONT} 让已经在任务里的
     *       那一页直接提到前台，不重建、不重新拉数据（重建会闪一下，还会重复发请求）；</li>
     *   <li><b>栈不越叠越高</b>：从「我的/历史」切走时把当前页关掉，所以栈里最多是
     *       「首页 + 当前标签页」，返回键回到首页 —— 而不是三页互相压着。</li>
     * </ol>
     *
     * <p>首页那一页用 {@code CLEAR_TOP|SINGLE_TOP}：任务里已经有首页就直接回到它，
     * 不新建（否则回来回去会叠出好几个首页）。
     */
    public static void go(Activity from, int tab) {
        Class<?> target = classOf(tab);
        if (target == null || from == null) return;
        if (from.getClass() == target) return;          // 点当前这一页：什么都不做

        Intent intent = new Intent(from, target);
        if (tab == HOME) {
            intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        } else {
            intent.setFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        }
        from.startActivity(intent);

        // 交叉淡化（无水平位移）：底部导航是换页，不是"进去了"
        from.overridePendingTransition(R.anim.nav_fade_in, R.anim.nav_fade_out);

        // 从标签页切走时关掉自己：栈里只留「首页 + 当前页」，返回键的语义才是确定的。
        // ⚠️ 首页例外 —— 它是栈底，留着才有"返回到首页"可回。
        if (tab != HOME && from.getClass() != HomeActivity.class) {
            from.finish();
        }
    }

    /** 直接以首页为底的"返回"（返回键与左上角返回都用它，动画一致）。 */
    public static void backHome(Activity from) {
        go(from, HOME);
    }

    private static Class<?> classOf(int tab) {
        if (tab == HOME) return HomeActivity.class;
        if (tab == HISTORY) return HistoryActivity.class;
        if (tab == ME) return MeActivity.class;
        return null;
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
