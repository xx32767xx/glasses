package com.leion.lanrelay;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
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

    /**
     * 字号倍率。真机反馈"字太小"之后加的，缺省比原来的比例大一档。
     *
     * <p>为什么做成**可调**而不是直接改死一个数：眼镜上的实际观感取决于
     * 光波导的放大率、佩戴位置、环境亮度 —— 这些我在电脑上推不出来。
     * 而投屏是**实时采样这块 View** 的，所以调完立刻能在眼镜上看到效果，
     * 不需要重新投屏、也不需要重新打包。
     */
    private float fontScale = 1.35f;

    /**
     * 右侧留白（占画布宽度的百分比）。
     *
     * <p>真机反馈"投射在右眼上，过于靠右的内容看不清" —— 单目右眼显示时，
     * 画面右缘可能落在**眼盒（eyebox）之外**，或者被镜框挡住。
     * 所以字幕块不应该铺满整个画布宽度，右边要留出安全区。
     *
     * <p>为什么是"可调"：到底留多少只有戴上才知道。缺省先给一个偏保守的值，
     * 用户在眼镜上往回调到舒服为止。
     */
    private int marginRightPercent = 22;

    /** 左侧留白（百分比）—— 和右侧分开，因为可见区不一定居中。 */
    private int marginLeftPercent = 4;

    /** 边界标尺（真机校准用）。 */
    private RulerView ruler;

    /**
     * 显示/隐藏**边界标尺**（真机校准用）。
     *
     * <p>为什么需要它：用户反馈"过于靠右的内容看不清"，而"看不清"有几种完全不同的
     * 成因 —— 右缘落在眼盒之外、被镜框挡住、或者画布本身比可见区宽。
     * 这三种修法不一样，而**只有戴着眼镜的人能分辨**，靠来回描述要猜好几轮。
     *
     * <p>标尺屏画三样东西：外框（画布真实边界）、内框（当前留白构成的"安全区"）、
     * 顶部百分比刻度。用户在眼镜上看一眼就能说出"右边到 80% 还能看清"，
     * 一句话就把问题定死了。
     */
    public void setRulerVisible(boolean show) {
        if (ruler == null) {
            ruler = new RulerView(root.getContext());
            ruler.setVisibility(View.GONE);
            root.addView(ruler, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT));
        }
        if (show) {
            ruler.setMargins(marginLeftPercent, marginRightPercent);
            ruler.invalidate();
        }
        ruler.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    public boolean isRulerVisible() {
        return ruler != null && ruler.getVisibility() == View.VISIBLE;
    }

    /**
     * 标尺：外框 = 画布边界，内框 = 安全区，顶上一排百分比刻度。
     *
     * <p>用自绘而不是拼一堆 TextView：刻度要精确对齐百分比位置，
     * 用布局拼会因为字号与内边距产生偏差，而"偏差几像素"正好是这里最不能有的东西。
     */
    private static final class RulerView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private int marginLeftPercent = 4;
        private int marginRightPercent = 22;

        RulerView(Context context) {
            super(context);
            setBackgroundColor(Color.BLACK);
            paint.setTypeface(Typeface.MONOSPACE);
        }

        void setMargins(int leftPercent, int rightPercent) {
            this.marginLeftPercent = leftPercent;
            this.marginRightPercent = rightPercent;
        }

        @Override
        protected void onDraw(Canvas canvas) {
            int width = getWidth();
            int height = getHeight();
            if (width <= 0 || height <= 0) return;

            // 外框：画布**真实边界**。看到它就知道画布有没有超出可见区。
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(Math.max(2f, height * 0.006f));
            paint.setColor(Color.WHITE);
            canvas.drawRect(1, 1, width - 1, height - 1, paint);

            // 内框：当前留白构成的"安全区"——字幕实际只会落在这里面
            float left = width * (marginLeftPercent / 100f);
            float right = width * (1f - marginRightPercent / 100f);
            paint.setColor(Color.parseColor("#FFD24A"));
            canvas.drawRect(left, 1, right, height - 1, paint);

            // 顶部百分比刻度：每 10% 一根，50% 那根更长
            float textSize = Math.max(10f, height * 0.045f);
            paint.setTextSize(textSize);
            paint.setStyle(Paint.Style.FILL);
            for (int percent = 0; percent <= 100; percent += 10) {
                float x = width * (percent / 100f);
                boolean major = percent % 50 == 0;
                paint.setColor(major ? Color.WHITE : Color.parseColor("#8A8A8A"));
                float tick = major ? height * 0.06f : height * 0.03f;
                canvas.drawRect(Math.min(x, width - 3f), 1f,
                        Math.min(x, width - 3f) + Math.max(2f, width * 0.004f), 1f + tick, paint);
                if (major) {
                    canvas.drawText(percent + "%", Math.min(x + width * 0.012f, width - textSize * 2.6f),
                            1f + tick + textSize, paint);
                }
            }

            // 四角标记：哪个不见了，就说明那个方向超出可见区
            paint.setColor(Color.WHITE);
            float pad = height * 0.02f;
            canvas.drawText("T", width / 2f - textSize * 0.3f, 1f + height * 0.12f + textSize, paint);
            canvas.drawText("B", width / 2f - textSize * 0.3f, height - pad - textSize * 0.2f, paint);
            canvas.drawText("L", pad, height / 2f, paint);
            canvas.drawText("R", width - pad - textSize, height / 2f, paint);

            // 一行示例字：直接判断"这个字号够不够大"
            paint.setTextSize(Math.max(12f, height * 0.10f * 1.35f));
            canvas.drawText("字号示例 Ag", pad, height / 2f - textSize, paint);
        }
    }

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
     * 设置显示微调（真机上才调得出来）。
     *
     * <p>投屏是对这块 View 的实时采样，所以调完**立刻**在眼镜上生效，
     * 不用重新投屏。界面把值存进 prefs，下次启动沿用。
     *
     * @param fontScale          字号倍率（0.6–3.0）
     * @param marginRightPercent 右侧留白百分比（0–60）
     * @param marginLeftPercent  左侧留白百分比（0–60）
     */
    public void setTuning(float fontScale, int marginRightPercent, int marginLeftPercent) {
        this.fontScale = clamp(fontScale, 0.6f, 3.0f);
        this.marginRightPercent = (int) clamp(marginRightPercent, 0, 60);
        this.marginLeftPercent = (int) clamp(marginLeftPercent, 0, 60);
        applyCanvasSize();
    }

    private static float clamp(float value, float low, float high) {
        return Math.max(low, Math.min(high, value));
    }

    public float getFontScale() {
        return fontScale;
    }

    public int getMarginRightPercent() {
        return marginRightPercent;
    }

    public int getMarginLeftPercent() {
        return marginLeftPercent;
    }

    /**
     * 当前实际可用的画布尺寸。
     *
     * <p>比 {@code canvasWidth/canvasHeight} 多一层**自愈**：如果 SDK 还没告诉我们
     * 分辨率（0×0），但 SDK 已经把这棵 View 测量过了（{@code getWidth() > 0}），
     * 那就把测出来的尺寸当成画布尺寸 —— 那是**真实**的像素数，比按手机 density
     * 猜 SP 准得多。
     *
     * <p>这条自愈很关键：尺寸未知时按 SP 算，46sp 在 density 2.75 的手机上
     * ≈ 126px，而眼镜画布只有几百像素宽 —— 一行只放得下 4 个字符，
     * 真机上表现为字幕被"截断"成 "Qual"（用户实际报的问题）。
     */
    private int effectiveWidth() {
        if (canvasWidth > 0) return canvasWidth;
        int measured = root.getWidth();
        return measured > 0 ? measured : 0;
    }

    private int effectiveHeight() {
        if (canvasHeight > 0) return canvasHeight;
        int measured = root.getHeight();
        return measured > 0 ? measured : 0;
    }

    /** 左右留白之后真正能放字的宽度。 */
    private int usableWidthPx() {
        int width = effectiveWidth();
        if (width <= 0) return 0;
        float leftPct = Math.max(0.04f, marginLeftPercent / 100f);
        float rightPct = Math.max(0.04f, marginRightPercent / 100f);
        return Math.max(1, Math.round(width * (1f - leftPct - rightPct)));
    }

    /**
     * 按当前已知尺寸重排：定 LayoutParams、定边距、定字号，必要时自己 measure。
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
            // ⚠️ 必须用 **FrameLayout.LayoutParams**，不能用裸的 ViewGroup.LayoutParams。
            //    见下面那段注释 —— 这是真机闪退的根因。
            root.setLayoutParams(new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT));
            // 尺寸未知时也要能调字号 —— 否则真机上发现字小就完全没得救
            applyTextSizes();
            log("画布尺寸未知 → 交给 SDK 测量（官方样例写法）");
            return;
        }

        // 🔴 这里曾经写的是 `new ViewGroup.LayoutParams(w, h)`，**真机上闪退**：
        //
        //   ClassCastException: ViewGroup$LayoutParams cannot be cast to
        //                       ViewGroup$MarginLayoutParams
        //     at ViewGroup.measureChildWithMargins(ViewGroup.java:7074)
        //     at FrameLayout.onMeasure(FrameLayout.java:194)
        //     ... ViewRootImpl.performTraversals
        //
        //   原因：FrameLayout 在测量子 View 时走 measureChildWithMargins，
        //   那里会把子 View 的 LayoutParams **强转成 MarginLayoutParams**。
        //   而裸 ViewGroup.LayoutParams 不是 MarginLayoutParams 的子类 → 崩。
        //
        //   为什么"直到调字号才崩"：设置画布尺寸只在**投屏前**跑过一次，
        //   那时这块 View 还没被 SDK 收进它的容器、不在任何遍历里，所以没事。
        //   而调字号会再跑一次 applyCanvasSize —— 这时 View 已经在 SDK 的容器里，
        //   下一次窗口遍历就会去 measure 它 → 当场崩。
        //
        //   教训：**给自己造的 View 设 LayoutParams 时，类型必须和父容器匹配。**
        //   父容器是 FrameLayout 就用 FrameLayout.LayoutParams（它是
        //   MarginLayoutParams 的子类），别图省事用基类。
        root.setLayoutParams(new FrameLayout.LayoutParams(canvasWidth, canvasHeight));

        // 只有**还没被谁收养**时才自己去 measure/layout。
        //
        // 为什么加这个判断：投屏开始后这块 View 会被 SDK 收进它的容器，
        // 那时我们再手动 measure/layout 就是和父容器的遍历打架。
        // 父容器在的时候不需要我们操心 —— LayoutParams 对了它自己会摆好。
        if (root.getParent() == null) {
            root.measure(
                    View.MeasureSpec.makeMeasureSpec(canvasWidth, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(canvasHeight, View.MeasureSpec.EXACTLY));
            root.layout(0, 0, canvasWidth, canvasHeight);
        }

        // 左右分开留白：单目显示时可见区**不一定居中**，所以两边分开调
        int padLeft = Math.round(canvasWidth * Math.max(0.04f, marginLeftPercent / 100f));
        int padRight = Math.round(canvasWidth * Math.max(0.04f, marginRightPercent / 100f));
        int padY = Math.round(canvasHeight * 0.05f);
        column.setPadding(padLeft, padY, padRight, padY);
        // 标尺的内框要跟着留白一起动 —— 否则用户拖着滑块、黄框却不动，
        // 就分不清"我调了没有"和"调了没用"
        if (ruler != null) {
            ruler.setMargins(marginLeftPercent, marginRightPercent);
            ruler.invalidate();
        }
        applyTextSizes();
        log("投屏画布 " + canvasWidth + "×" + canvasHeight
            + " · 字号×" + fontScale + " · 留白 左" + marginLeftPercent + "%/右" + marginRightPercent + "%");
    }

    /** 按画布尺寸与当前微调把各处字号算一遍。 */
    private void applyTextSizes() {
        // 顶部状态行不跟着放大：它只是线索，放大后会挤掉译文。
        // 用 effectiveHeight() 而不是 canvasHeight —— 尺寸未知时靠"已测量到的尺寸"自愈。
        int height = effectiveHeight();
        float base = height > 0 ? height : 640f;
        setPx(status, base * 0.026f);
        setPx(hint, base * 0.026f);
        setPx(idleTitle, base * 0.10f * fontScale);
        setPx(idleNote, base * 0.036f * fontScale);
        // 字号/留白变了要按**当前这一句**重排（行数与翻页状态都跟着变）。
        // 只调 applySubtitleSize 的话，翻页状态会跟新的字号对不上。
        if (lastText != null && !lastText.isEmpty()) {
            applySubtitleLayout(lastText);
        } else {
            applySubtitleSize(lastLines);
        }
    }

    private static void setPx(TextView view, float px) {
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, Math.max(1f, px));
    }

    /** 上一次的字幕行数（微调字号时要按同一个行数重算，不能跳回 1 行）。 */
    private int lastLines = 1;

    /** 按行数选字号（**兜底路径**：尺寸完全未知、连测量都没有时才会用到）。 */
    private void applySubtitleSize(int lines) {
        this.lastLines = Math.max(1, lines);
        int height = effectiveHeight();
        if (height <= 0) {
            // 尺寸完全未知（连测量都没有）：退回 SP，
            // 但**压低缺省** —— 原来那档（34sp × 倍率）在手机 density 2.75 下能到 126px，
            // 在几百像素宽的眼镜画布上一行只放得下 4 个字符，反而是不可用的。
            float sp = (lines <= 2 ? 16f : lines == 3 ? 13f : 11f) * fontScale;
            subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
            return;
        }
        float ratio = lines <= 1 ? 0.095f : lines == 2 ? 0.085f
                : lines == 3 ? 0.068f : lines == 4 ? 0.056f : 0.046f;
        setPx(subtitle, height * ratio * fontScale);
    }

    /**
     * 按**整句**重新选字号：从"一行放少数字"往"一行放多数字"试，
     * 取第一个能在 {@link #MAX_LINES} 行内放下、且纵向也放得下的字号。
     *
     * <p>为什么必须按整句来选：原来的顺序是"先估行数 → 再按行数选字号"，
     * 而估行数用的是**上一次**的字号。两句长度差很多时就会估错：
     * 短句之后来一个长句，字号还按短句的大档算 → 长句换行数超出可见高度 → 被截断。
     * 现在反过来：拿真实文本去试，试到放得下为止。
     *
     * <p>列宽用**半角字符**为单位（和 {@code countLines} 一致，汉字算 2 列）。
     * 字号与列宽的关系：{@code font = 2 * usableWidth / cols}
     * （半角字符宽约 0.5em，cols 个正好铺满可用宽度）。
     */
    private void fitSubtitleToText(String text) {
        applySubtitleLayout(text);
    }

    /**
     * 按**整句**排一次版：选字号、定行数、必要时**翻页**。
     *
     * <p>三件事，顺序不能反：
     *
     * <p><b>① 选字号</b>：从"一行放少数字"往"一行放多数字"试，取第一个能在
     * {@link #MAX_LINES} 行内放下的字号。必须按整句真实文本试 —— 用"上一次的字号"
     * 去估行数，短句后来个长句就会估错，字号偏大 → 换行超出可见高度 → 被截断。
     *
     * <p><b>② 字号下限</b>：真机算过，如果不设下限，220 字符的句子会被压到 16.9px
     * （画布宽的 2.6%），在光波导上基本等于看不见。"放下"不等于"看得清"，
     * 所以到下限就不再缩 —— 改为第 ③ 步。
     *
     * <p><b>③ 翻页</b>：放不下就分两页。**第一页显示开头**（人是从头开始读的），
     * 延迟之后**停在最后一页 = 结尾**。万一只看了一眼，留下的也是句尾那个"重点" ——
     * 这和插件自己的取舍一致（{@code fitSubtitle} 只保留最后 N 行，
     * 理由是"读者永远在追最新那句话"）。
     *
     * <p>另外把 {@code maxLines} 与 {@code ellipsize} 也设上：原来两个都没设，
     * 内容超出视图高度时会被**静默裁掉**（没有省略号、没有任何提示），
     * 佩戴者不知道自己漏了内容 —— 那比"显示得难看"严重得多。
     */
    private void applySubtitleLayout(String text) {
        int usableWidth = usableWidthPx();
        int usableHeight = effectiveHeight();
        if (usableWidth <= 0 || usableHeight <= 0 || text == null || text.isEmpty()) {
            applySubtitleSize(lastLines);
            return;
        }
        int heightBudget = Math.round(usableHeight * 0.85f);
        // ⚠️ 字号倍率必须参与"一行放多少个"的决定，不能在算完字号之后再乘：
        //    字号是从"可用宽度 ÷ 每行字符数"反推的，算完再放大一行就装不下，
        //    正好退回"被截断"。倍率的作用是：倍率越大 → 一行放得越少 → 字越大。
        int startCols = (int) clamp(Math.round(14f / fontScale), 6, 44);
        float minFont = Math.max(8f, usableHeight * minFontRatio);

        float chosen = 0f;
        int chosenCols = 0;
        for (int cols = startCols; cols <= 120; cols += 2) {
            float font = 2f * usableWidth / cols;
            if (font < minFont) break;              // 到下限了：不再缩，交给翻页
            int lines = countLines(text, cols);
            if (lines > MAX_LINES) continue;
            if (lines * font * 1.35f > heightBudget) continue;
            chosen = font;
            chosenCols = cols;
            break;
        }
        if (chosen <= 0f) {
            chosen = minFont;
            chosenCols = Math.max(4, Math.round(2f * usableWidth / minFont));
        }
        // 上限：两行别把整屏占满
        chosen = Math.min(chosen, usableHeight / 2.2f);
        setPx(subtitle, chosen);

        int linesNeeded = countLines(text, chosenCols);
        int displayLines = Math.max(1, Math.min(MAX_LINES,
                (int) (heightBudget / (chosen * 1.35f))));
        subtitle.setMaxLines(displayLines);
        lastLines = Math.max(1, Math.min(linesNeeded, displayLines));

        if (linesNeeded <= displayLines) {
            cancelPaging();
            // 单页也给一个省略号作为**安全网**：行数是按"汉字算 2 列"这个模型估的，
            // 而安卓按真实字形排版，模型偏乐观时真实行数会更多。
            // 设了 ellipsize，这种情况就变成"看得见的省略号"而不是**静默裁掉** ——
            // 后者会让佩戴者以为自己听全了。
            subtitle.setEllipsize(TextUtils.TruncateAt.END);
            subtitle.setText(text);
            return;
        }

        // 需要翻页。
        //
        // ⚠️ 这里**不能只切"开头 + 结尾"两页**：如果整句超过两页，
        //    中间那一段就凭空消失了 —— 而且是静默消失，比不翻页更糟。
        //    所以：恰好两页时用「开头 / 结尾」（两页都是满的，且互相重叠，读起来连贯）；
        //    超过两页时按顺序切成若干页，保证**每一列都出现在某一页上**。
        int totalColumns = columnsOf(text);
        int colsPerPage = Math.max(1, displayLines * chosenCols);
        pages.clear();
        if (totalColumns <= 2 * colsPerPage) {
            pages.add(sliceColumns(text, 0, colsPerPage));
            pages.add(sliceColumns(text, Math.max(0, totalColumns - colsPerPage), colsPerPage));
        } else {
            for (int start = 0; start < totalColumns; start += colsPerPage) {
                pages.add(sliceColumns(text, start, colsPerPage));
            }
        }
        pageCount = pages.size();
        cancelPagingTimerOnly();
        showPage(0);
        pageHandler.postDelayed(pageAdvance, pageDelayMs);
    }

    /** 整串文本占多少列（汉字算 2 列）。 */
    private static int columnsOf(String text) {
        int width = 0;
        int index = 0;
        while (index < text.length()) {
            int codePoint = text.codePointAt(index);
            width += codePoint < 0x2E80 ? 1 : 2;
            index += Character.charCount(codePoint);
        }
        return width;
    }

    /**
     * 取 [startColumn, startColumn + maxColumns) 这一段（汉字算 2 列）。
     *
     * <p>头部、尾部、中间切片全都由它一个函数完成 —— 三个各自实现的话，
     * "列宽怎么算"这件事就会有三份，很容易只改到其中一份。
     */
    private static String sliceColumns(String text, int startColumn, int maxColumns) {
        StringBuilder out = new StringBuilder();
        int width = 0;
        int taken = 0;
        int index = 0;
        while (index < text.length()) {
            int codePoint = text.codePointAt(index);
            int count = Character.charCount(codePoint);
            int w = codePoint < 0x2E80 ? 1 : 2;
            int next = width + w;
            if (next > startColumn && taken + w <= maxColumns) {
                out.appendCodePoint(codePoint);
                taken += w;
            }
            width = next;
            if (width >= startColumn + maxColumns) break;
            index += count;
        }
        return out.toString();
    }

    // ── 翻页 ────────────────────────────────────────────────────────────────

    private final Handler pageHandler = new Handler(Looper.getMainLooper());
    private final java.util.List<String> pages = new java.util.ArrayList<>();
    private int currentPage = 0;
    private int pageCount = 1;

    /** 翻页回调（界面用它打诊断行，确认"翻页真的发生了"）。 */
    public interface PageListener {
        void onPage(int page, int pageCount, int lines);
    }

    private PageListener pageListener;

    public void setPageListener(PageListener listener) {
        this.pageListener = listener;
    }

    private final Runnable pageAdvance = () -> {
        if (pageCount > 1 && currentPage < pageCount - 1) showPage(currentPage + 1);
    };

    private void showPage(int page) {
        if (page < 0 || page >= pages.size()) return;
        currentPage = page;
        boolean last = page == pages.size() - 1;
        // 最后一页是结尾：万一还是放不下，砍**开头** —— 这就是"留结尾"的取舍。
        // 前面的页是开头方向的内容，放不下就砍结尾（后面还有页接着）。
        subtitle.setEllipsize(last ? TextUtils.TruncateAt.START : TextUtils.TruncateAt.END);
        subtitle.setText(pages.get(page));
        // ★ 翻页之后必须补一次重绘：投屏是"变化时推一串帧"，
        //   漏掉一次变化画面就会**永久**停在旧内容上（真机上踩过，见 docs/09 §12）
        forceRedraw();
        if (pageListener != null) pageListener.onPage(page, pageCount, lastLines);
    }

    private void cancelPagingTimerOnly() {
        pageHandler.removeCallbacks(pageAdvance);
    }

    private void cancelPaging() {
        cancelPagingTimerOnly();
        currentPage = 0;
        pageCount = 1;
        pages.clear();
    }

    /** 翻页间隔（毫秒），真机上可调。 */
    private int pageDelayMs = 1600;

    public void setPageDelayMs(int value) {
        this.pageDelayMs = Math.max(400, Math.min(8000, value));
    }

    public int getPageDelayMs() {
        return pageDelayMs;
    }

    /**
     * 字号下限（占画布高度的比例）。低于它就不再缩小，改为翻页。
     *
     * <p><b>这个数字是戴上之后定的，不是推出来的。</b>
     *
     * <p>定标过程：按"字号随句子长度自动缩小"跑一遍，把每档的字号算出来，让用户戴着眼镜看
     * 哪一档开始看不清 —— 结论是 **120 字符 → 31.6px（画布宽的 4.9%）还是能看清，
     * 再小就不行了**。画布高 400px，所以 31.6/400 ≈ 0.079。
     *
     * <p>为什么不能靠"能放下"来定：不设下限时，220 字符的句子会被压到 16.9px，
     * 数学上确实"放下了"，但那是 2.6% 画布宽 —— 在光波导上等于没显示。
     * <b>"放得下"和"看得清"是两回事</b>，下限就是这条界线。
     *
     * <p>它**不随 {@link #fontScale} 缩放**：倍率是"平时想要多大"，下限是"最小能看多小"，
     * 是两件事 —— 用户把整体调小，也不该让长句小到看不见。
     */
    private float minFontRatio = 0.079f;

    /** 当前这一句分了几页（1 = 没翻页）。界面诊断用。 */
    public int getPageCount() {
        return pageCount;
    }

    /** 切换"待机提示 / 字幕"两种状态。有字幕了就把待机提示收起来。 */
    public void showIdle(boolean show) {
        idleGroup.setVisibility(show ? View.VISIBLE : View.GONE);
        subtitle.setVisibility(show ? View.GONE : View.VISIBLE);
    }

    /**
     * 强制这块被采样的 View 重新走一次布局 + 绘制。
     *
     * <p><b>为什么需要这个</b>：真机上出现过"手机明明把定稿推上去了，眼镜上却还停在
     * 增量帧的『Ol…』"——日志两侧都对得上（`[手机] 投屏：定稿 → Olá Olá Olá`），
     * 可画面就是旧的。而用户点一下界面上的按钮（触发一次窗口重绘）它又自己好了。
     *
     * <p>这个现象指向的是：**投屏是跟着视图重绘来采样的**，两次内容更新隔得太近时，
     * 后一次的重绘被**合并**掉了，于是画面停在先渲染出来的那一帧，
     * 直到下一次无关的重绘才被纠正。
     *
     * <p>所以推完字幕之后隔一小会儿再"戳"一下，让最终状态一定被采样到。
     * 这个操作是幂等的：内容没变时重绘一遍没有任何副作用。
     */
    public void forceRedraw() {
        subtitle.requestLayout();
        column.requestLayout();
        root.requestLayout();
        subtitle.invalidate();
        column.invalidate();
        root.invalidate();
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
        // 换了一句就把上一句的翻页取消 —— 否则旧句的"第二页"会盖到新句上
        cancelPaging();
        lastText = value;
        subtitle.setText(value);
        // 有内容就切到字幕态、收掉待机提示；空了就回到待机态。
        // 这样"还没开始同传"和"正在同传"两个状态不会互相覆盖。
        showIdle(value.isEmpty());
        if (value.isEmpty()) {
            applySubtitleSize(1);
            return;
        }
        // ★ 按**这一句的真实文本**排版：选字号、定行数、必要时翻页。
        fitSubtitleToText(value);
    }

    /** 当前这一句（微调字号/留白之后要按它重排，翻页状态也要跟着重算）。 */
    private String lastText = "";

    /** 有没有正在翻页（界面诊断用）。 */
    public boolean isPaging() {
        return pageCount > 1;
    }

    /**
     * 画布一行大约放得下几个半角字符 —— 只用来给 {@link #fitSubtitleToText} 兜底。
     */
    private int columnsPerLine() {
        int usable = usableWidthPx();
        if (usable <= 0) return 20;
        int height = effectiveHeight();
        float fontPx = height > 0 ? Math.max(1f, height * 0.085f * fontScale) : 32f;
        return Math.max(5, Math.round((float) usable / (fontPx / 2f)));
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
