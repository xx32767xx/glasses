package com.leion.lanrelay;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 专给眼镜投屏用的字幕 View。
 *
 * <p>为什么单独做这一个 View，而不是把手机界面投上去：眼镜 SDK 的显示接口是
 * <b>投屏</b>（{@code IGlassDisplay.createCaptureScreen(activity, view)}），
 * 也就是说 <b>你给它什么 View，眼镜上就显示什么</b>。手机界面是给手指点的 ——
 * 小字号、浅色、一堆按钮；投到眼镜上（用户隔着一两米、还是透明叠加）根本看不清。
 * 所以这里按"戴在脸上看"的规矩重做一份：
 *
 * <ul>
 *   <li><b>黑底白字、高对比</b> —— 光波导在亮环境里本来对比度就低，浅色底会糊掉</li>
 *   <li><b>字号按屏幕高度算</b>，不写死 —— 眼镜分辨率和手机差很多，写死就废了</li>
 *   <li><b>只放译文</b>，不放原文/时间/按钮 —— 眼镜上空间极小，每多一样都在挤译文</li>
 * </ul>
 *
 * <p>⚠️ 投屏会按比例缩放，所以这个 View 的"版式比例"就是眼镜上看到的版式。
 * 不要用手机屏幕的宽高比去推眼镜上的效果。
 */
public class GlassesSubtitleView {

    /** 译文最多显示几行。超出就缩小字号（见 {@link #setSubtitle}），不截断。 */
    private static final int MAX_LINES = 4;

    /**
     * 投屏画面的宽高比（宽 : 高）。
     *
     * ⚠️ 这个值**必须**设，不能让它按手机屏幕的尺寸去采集。
     *    官方样例给投屏 View 明确设过宽高比：
     *      {@code setAspectRatio(8.0 / 5.0)} —— 说明 SDK 对采集尺寸有预期，
     *    尺寸不匹配时真机上报的是「数据越界」（SDK 按设备分辨率分配缓冲，
     *    却从一块尺寸对不上的 View 里取像素）。
     *
     * 0.75 = 3:4 竖屏，是光波导单片显示器的常见比例（480×640）。
     * ⚠️ **待真机确认**：拿到眼镜后从 {@code device.getDeviceInfo().getResolutionWidth()/Height()}
     *    读出真实值再改这里。注意那两个 getter 返回的是 **String**（见 {@code GlassesSdk.queryDisplaySize}）。
     */
    private static final float ASPECT_RATIO = 0.75f;

    private final FrameLayout root;
    private final TextView subtitle;
    private final TextView status;
    private final TextView hint;
    /** 待机提示（未开始同传时显示）。与字幕分开，这样"等待输入"不会被当成字幕更新掉。 */
    private final LinearLayout idleGroup;
    private final TextView idleTitle;
    private final TextView idleNote;
    /** 当前宽高比（见 ASPECT_RATIO） */
    private float aspectRatio = ASPECT_RATIO;

    public GlassesSubtitleView(Context context) {
        root = new FrameLayout(context);
        root.setBackgroundColor(Color.BLACK);
        // 不放焦点、不吃触摸：它只是被投出去的画面，不该拦截手机上的操作
        root.setFocusable(false);
        root.setClickable(false);

        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(context, 24);
        column.setPadding(pad, pad, pad, pad);
        root.addView(column, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        // 顶部状态行：连接状态 + 时间。做得**很淡**，它只是"出问题时的线索"，
        // 正常情况下不该抢译文的注意力。
        LinearLayout topRow = new LinearLayout(context);
        topRow.setOrientation(LinearLayout.HORIZONTAL);
        topRow.setGravity(Gravity.CENTER_VERTICAL);

        status = new TextView(context);
        status.setTextColor(context.getColor(R.color.screen_ink_dim));
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        status.setSingleLine(true);
        topRow.addView(status, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        hint = new TextView(context);
        hint.setTextColor(context.getColor(R.color.screen_ink_dim));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        hint.setSingleLine(true);
        topRow.addView(hint);

        column.addView(topRow);

        subtitle = new TextView(context);
        subtitle.setTextColor(context.getColor(R.color.screen_ink));
        subtitle.setTypeface(Typeface.DEFAULT_BOLD);
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        subtitle.setLineSpacing(dp(context, 6), 1f);
        // 字幕会一个字一个字地更新，不能让它跳来跳去
        subtitle.setGravity(Gravity.START);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        params.topMargin = dp(context, 12);
        column.addView(subtitle, params);

        // ── 待机提示：连接上眼镜但还没开始同传时显示 ─────────────────────────────
        //  为什么单独做一块：用户要的是"投屏效果怎么验证" ——
        //  开同传之前就能看到东西，才能证明"投屏这条路是通的"。
        //  它和字幕是**两个状态**，用同一块 TextView 会互相覆盖。
        idleGroup = new LinearLayout(context);
        idleGroup.setOrientation(LinearLayout.VERTICAL);
        idleGroup.setGravity(Gravity.CENTER_HORIZONTAL);

        idleTitle = new TextView(context);
        idleTitle.setText("等待输入");
        idleTitle.setTextColor(context.getColor(R.color.screen_ink));
        idleTitle.setTypeface(Typeface.DEFAULT_BOLD);
        idleTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
        idleTitle.setGravity(Gravity.CENTER);
        idleGroup.addView(idleTitle);

        idleNote = new TextView(context);
        idleNote.setText("眼镜已连接 · 开始同传后这里显示字幕");
        idleNote.setTextColor(context.getColor(R.color.screen_ink_dim));
        idleNote.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        idleNote.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams noteParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        noteParams.topMargin = dp(context, 10);
        idleGroup.addView(idleNote, noteParams);

        LinearLayout.LayoutParams idleParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        idleParams.topMargin = dp(context, 12);
        column.addView(idleGroup, idleParams);

        // 投屏 View **必须有一个确定的尺寸**：SDK 要按宽高比采集画面。
        // 不设的话它按父容器（手机屏幕）的尺寸走，真机上会「数据越界」。
        setAspectRatio(ASPECT_RATIO);

        showIdle(true);
        setStatus("眼镜未连接", "");
    }

    /**
     * 给投屏画面定一个固定的宽高比，并**立刻**把尺寸定下来。
     *
     * <p>⚠️ 这里刻意**不用 {@code view.post()}**，而是同步算 + 主动 measure/layout。
     *    原因：这个 View 从不 attach 到窗口（它只是被 SDK 采样的一块画布），
     *    而 detached View 的 {@code post()} 会被排进 {@code HandlerActionQueue}，
     *    **要等 attach 才执行** —— 它永远不会 attach，于是那段代码永不执行，
     *    {@code setLayoutParams} 不生效、root 尺寸一直是 0×0。
     *    第一版就是这么写的，等于"设了宽高比"这件事根本没发生。
     *
     * <p>尺寸按屏幕宽度推、再由宽高比算高度；随后 `measure` + `layout` 一遍，
     * 保证 SDK 拿去 {@code draw()} 时 {@code getWidth()/getHeight()} 不为 0。
     */
    public void setAspectRatio(float ratio) {
        this.aspectRatio = ratio <= 0f ? ASPECT_RATIO : ratio;
        android.util.DisplayMetrics metrics = root.getResources().getDisplayMetrics();
        int width = Math.max(1, metrics.widthPixels);
        int height = Math.max(1, Math.round(width / this.aspectRatio));
        root.setLayoutParams(new ViewGroup.LayoutParams(width, height));
        root.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, width, height);
        log("投屏画布尺寸 " + width + "×" + height + "（比例 " + this.aspectRatio + "）");
    }

    /** 切换"待机提示 / 字幕"两种状态。有字幕了就把待机提示收起来。 */
    public void showIdle(boolean show) {
        idleGroup.setVisibility(show ? View.VISIBLE : View.GONE);
        subtitle.setVisibility(show ? View.GONE : View.VISIBLE);
    }

    /** 待机提示的文案（比如"等待输入" / "已暂停" / "等待连接电脑"）。 */
    public void setIdleText(String title, String note) {
        idleTitle.setText(title == null ? "" : title);
        idleNote.setText(note == null ? "" : note);
    }

    private void log(String message) {
        android.util.Log.i("GlassesSdk", "[GlassesView] " + message);
    }

    /** 交给 SDK 投屏用：{@code display.createCaptureScreen(activity, getView())} */
    public View getView() {
        return root;
    }

    /**
     * 更新字幕。这是唯一会被高频调用的方法（每次收到字幕帧一次）。
     *
     * <p>字号自适应：行数越多、字号越小，保证 {@link #MAX_LINES} 行以内放得下。
     * 为什么这么在意行数 —— 同传的译文经常比"3 行"长，而眼镜上**看不到就是没翻**，
     * 所以宁可缩小字号也不要截断（截断会把句尾丢掉，那通常是最关键的信息）。
     */
    public void setSubtitle(String text) {
        String value = text == null ? "" : text.trim();
        subtitle.setText(value);
        // 有内容就切到字幕态、收掉待机提示；空了就回到待机态。
        // 这样"还没开始同传"和"正在同传"两个状态不会互相覆盖。
        showIdle(value.isEmpty());
        if (value.isEmpty()) {
            subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
            return;
        }
        int lines = Math.max(1, countLines(value, 20));
        float size = lines <= 2 ? 34f : lines == 3 ? 28f : lines == 4 ? 23f : 19f;
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
    }

    /** 粗略估行数：按 20 列折行算（眼镜上大约就是这么宽）。只用来选字号，不需要精确。 */
    private static int countLines(String text, int cols) {
        int lines = 1;
        int width = 0;
        for (int index = 0; index < text.length(); index += 1) {
            char ch = text.charAt(index);
            if (ch == '\n') {
                lines += 1;
                width = 0;
                continue;
            }
            // 与插件那边同一套规则：汉字算 2 列
            int columns = ch < 0x2E80 ? 1 : 2;
            if (width + columns > cols) {
                lines += 1;
                width = 0;
            }
            width += columns;
        }
        return lines;
    }

    /**
     * 连接状态一行 + 右上角提示。
     *
     * <p>为什么要显示这个：眼镜连没连上、投屏成没成功，在手机上**看不出来** ——
     * 如果不写，出问题时只能靠猜（而这套 SDK 的失败大多是"什么都不显示"）。
     */
    public void setStatus(String left, String right) {
        status.setText(left == null ? "" : left);
        hint.setText(right == null ? "" : right);
    }

    /** 是不是还没有任何字幕（用来决定要不要显示"等对方说话"这类占位） */
    public boolean isSubtitleEmpty() {
        return subtitle.getText().length() == 0;
    }

    /** 当前有没有字幕内容（有就别用待机提示去盖它）。 */
    public boolean hasSubtitle() {
        return subtitle.getText().length() > 0;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
