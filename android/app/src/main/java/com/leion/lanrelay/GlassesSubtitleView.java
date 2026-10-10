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
     * 投屏画布尺寸（= 眼镜的真实分辨率）。0 表示还不知道。
     *
     * <p><b>为什么要跟眼镜一致，而不是用手机屏幕尺寸</b>：
     * SDK 的 LCD 传输按**设备分辨率**分配缓冲，再从这块 View 里取像素。
     * 尺寸给大了就是「数据越界」（真机上还见过直接闪退）。
     *
     * <p>⚠️ 第一版我按**手机屏幕宽度**（1080）算画布，比例虽然对，但像素尺寸差了一倍多 ——
     *    这正是「数据越界」的来源。现在改成从 {@code DeviceInfo} 读真实分辨率。
     *
     * <p>读不到时（= 0）不去猜：退回**官方样例的写法**（MATCH_PARENT、不自己 measure），
     * 把测量交给 SDK。样例的 overlay 就是这么做的，已知可用。
     */
    private int canvasWidth = 0;
    private int canvasHeight = 0;

    private final FrameLayout root;
    private final TextView subtitle;
    private final TextView status;
    private final TextView hint;
    /** 待机提示（未开始同传时显示）。与字幕分开，这样"等待输入"不会被当成字幕更新掉。 */
    private final LinearLayout idleGroup;
    private final TextView idleTitle;
    private final TextView idleNote;
    /** 当前宽高比残留字段已删除：尺寸现在由 setDisplaySize 给的真实分辨率决定。 */
    private final android.widget.LinearLayout column;

    public GlassesSubtitleView(Context context) {
        root = new FrameLayout(context);
        root.setBackgroundColor(Color.BLACK);
        // 不放焦点、不吃触摸：它只是被投出去的画面，不该拦截手机上的操作
        root.setFocusable(false);
        root.setClickable(false);

        column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_VERTICAL);
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
        status.setSingleLine(true);
        topRow.addView(status, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        hint = new TextView(context);
        hint.setTextColor(context.getColor(R.color.screen_ink_dim));
        hint.setSingleLine(true);
        topRow.addView(hint);

        column.addView(topRow);

        subtitle = new TextView(context);
        subtitle.setTextColor(context.getColor(R.color.screen_ink));
        subtitle.setTypeface(Typeface.DEFAULT_BOLD);
        // 字幕会一个字一个字地更新，不能让它跳来跳去
        subtitle.setGravity(Gravity.START);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
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
        idleTitle.setGravity(Gravity.CENTER);
        idleGroup.addView(idleTitle);

        idleNote = new TextView(context);
        idleNote.setText("眼镜已连接 · 开始同传后这里显示字幕");
        idleNote.setTextColor(context.getColor(R.color.screen_ink_dim));
        idleNote.setGravity(Gravity.CENTER);
        idleGroup.addView(idleNote);

        LinearLayout.LayoutParams idleParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        column.addView(idleGroup, idleParams);

        // 尺寸还不知道 → 先按官方样例的写法（MATCH_PARENT），等 setDisplaySize 给真实分辨率
        applyCanvasSize();

        showIdle(true);
        setStatus("眼镜未连接", "");
    }

    /**
     * 设定投屏画布的像素尺寸（= 眼镜真实分辨率，从 {@code DeviceInfo} 读）。
     *
     * <p>必须在 {@code createCaptureScreen} **之前**调用 —— SDK 是在投屏那一刻
     * 把这块 View 采样成画面的，之后再改尺寸已经晚了。
     *
     * @param width  眼镜分辨率宽；&lt;= 0 表示没读到
     * @param height 眼镜分辨率高；&lt;= 0 表示没读到
     */
    public void setDisplaySize(int width, int height) {
        this.canvasWidth = width;
        this.canvasHeight = height;
        applyCanvasSize();
    }

    /**
     * 按当前已知尺寸重排：定 LayoutParams、定字号、必要时自己 measure。
     *
     * <p>两个分支都是刻意的：
     * <ul>
     *   <li><b>知道分辨率</b>：把 LayoutParams 定成那个像素尺寸，并且自己 measure + layout。
     *       这样即使 SDK 不测量直接 draw，{@code getWidth()/getHeight()} 也是对的。</li>
     *   <li><b>不知道分辨率</b>：只用 MATCH_PARENT，**不自己 measure** ——
     *       完全照官方样例（样例的 overlay 就是一个没有 LayoutParams 的 FrameLayout）。
     *       猜一个尺寸反而会「数据越界」，那比不投还糟。</li>
     * </ul>
     *
     * <p>字号统一用 **PX 并按画布尺寸算**：这个 View 的 density 是**手机**的，
     * 用 SP 的话在 480×640 的眼镜画布上会被放大成没法看的字号
     * （手机 density 2.75 → 34sp ≈ 93px，画布才 480 宽）。
     */
    private void applyCanvasSize() {
        boolean known = canvasWidth > 0 && canvasHeight > 0;
        if (!known) {
            root.setLayoutParams(new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
            log("画布尺寸未知 → 交给 SDK 测量（官方样例写法）");
            return;
        }

        root.setLayoutParams(new ViewGroup.LayoutParams(canvasWidth, canvasHeight));
        root.measure(
                View.MeasureSpec.makeMeasureSpec(canvasWidth, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(canvasHeight, View.MeasureSpec.EXACTLY));
        root.layout(0, 0, canvasWidth, canvasHeight);

        int pad = Math.round(canvasWidth * 0.05f);
        column.setPadding(pad, pad, pad, pad);
        // 顶部状态行做得很淡、很小 —— 它只是线索，不该抢译文
        setPx(status, canvasHeight * 0.028f);
        setPx(hint, canvasHeight * 0.028f);
        setPx(idleTitle, canvasHeight * 0.10f);
        setPx(idleNote, canvasHeight * 0.038f);
        applySubtitleSize(1);
        log("投屏画布尺寸 " + canvasWidth + "×" + canvasHeight + "（按眼镜真实分辨率）");
    }

    private static void setPx(TextView view, float px) {
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, Math.max(1f, px));
    }

    /** 按行数选字号：字号 = 画布高度的比例。行数越多字号越小，不截断。 */
    private void applySubtitleSize(int lines) {
        if (canvasHeight <= 0) {
            // 尺寸未知：退回 SP（只能在手机 density 下近似，等知道分辨率再纠正）
            float sp = lines <= 2 ? 34f : lines == 3 ? 28f : lines == 4 ? 23f : 19f;
            subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
            return;
        }
        float ratio = lines <= 1 ? 0.095f : lines == 2 ? 0.085f
                : lines == 3 ? 0.068f : lines == 4 ? 0.056f : 0.046f;
        setPx(subtitle, canvasHeight * ratio);
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
            applySubtitleSize(1);
            return;
        }
        int lines = Math.max(1, countLines(value, columnsPerLine()));
        applySubtitleSize(lines);
    }

    /** 画布一行大约放得下几个汉字 —— 按画布宽度和字号粗估，只用来选字号。 */
    private int columnsPerLine() {
        if (canvasWidth <= 0 || canvasHeight <= 0) return 20;
        float fontPx = canvasHeight * 0.085f;           // 取中间档字号估
        int usable = Math.round(canvasWidth * 0.9f);    // 扣掉左右留白
        return Math.max(6, Math.round(usable / Math.max(1f, fontPx)));
    }

    /** 粗略估行数：按当前画布能放多少列来折行算。只用来选字号，不需要精确。 */
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
