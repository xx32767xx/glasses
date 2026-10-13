package com.leion.lanrelay;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.text.Layout;
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

    /**
     * 每页最多几行的**防呆上限**。
     *
     * <p>⚠️ 它不是"设计上只想显示 4 行"，而是"防止画布异常高时一页冒出几十行"。
     *    真正决定一页几行的是**可用高度**（见 {@link #applySubtitleLayout}）。
     *
     * <p>原来这里叫 {@code MAX_LINES = 4}，而且被当成硬上限用 —— 结果是
     * 小字号明明能放下 7 行却只显示 4 行，下面一片空白还多翻一页。
     * 改名 + 改大是为了让"它只是防呆，不是设计意图"这件事写在名字里。
     */
    private static final int MAX_LINES_ABS = 14;

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
    /**
     * 中文字幕的字号（px）。
     *
     * <p><b>为什么改成"固定字号 + 按语种分开"，而不是按句子长度自动缩放</b>：
     * 自动缩放那条路走过，问题不是"不好看"，而是**不可预期**：
     * 同一块屏上短句 95px、长句 32px，相差 3 倍，佩戴者**每句话都要重新适应字号**，
     * 而规则他既看不见也预测不了；每页行数还随字号变，翻页节奏也没法预期。
     * 对"边听边读"这件事来说，稳定比"尽量大"更值钱。
     *
     * <p><b>为什么中文和葡语要分开两个数</b>：密度差 2 倍以上 ——
     * 一个汉字占一格，而葡语一个词平均 5~6 个字符。
     * 同一个字号不可能两边都好：按中文调舒服了，看葡语会每行字太少、翻页频繁；
     * 按葡语调舒服了，看中文又嫌小。
     */
    private float fontPxZh = 40f;

    /** 葡语字幕的字号（px）。默认略大于中文 —— 拉丁字母的 x-height 只有约 0.5em，
     *  同样 px 下看起来比汉字小，等观感需要更大的数值。 */
    private float fontPxPt = 44f;

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
     * @param fontZh             中文字幕字号（px，20–120）
     * @param fontPt             葡语字幕字号（px，20–120）
     * @param marginRightPercent 右侧留白百分比（0–60）
     * @param marginLeftPercent  左侧留白百分比（0–60）
     */
    public void setTuning(float fontZh, float fontPt, int marginRightPercent, int marginLeftPercent) {
        this.fontPxZh = clamp(fontZh, 20f, 120f);
        this.fontPxPt = clamp(fontPt, 20f, 120f);
        this.marginRightPercent = (int) clamp(marginRightPercent, 0, 60);
        this.marginLeftPercent = (int) clamp(marginLeftPercent, 0, 60);
        applyCanvasSize();
    }

    private static float clamp(float value, float low, float high) {
        return Math.max(low, Math.min(high, value));
    }

    public float getFontPxZh() {
        return fontPxZh;
    }

    public float getFontPxPt() {
        return fontPxPt;
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
            + " · 字号 中" + Math.round(fontPxZh) + "px/葡" + Math.round(fontPxPt) + "px"
            + " · 留白 左" + marginLeftPercent + "%/右" + marginRightPercent + "%");
    }

    /** 按画布尺寸与当前微调把各处字号算一遍。 */
    private void applyTextSizes() {
        // 附属文字**按字幕字号派生**，不再各自乘一个"画布高度比例 × 倍率"：
        // 字幕是主角，它的字号定了，其余的相对关系就定了。
        // 这样也少一个旋钮（原来的 fontScale 只影响这些派生值，容易让人以为它管字幕）。
        float base = fontPxZh;
        setPx(status, base * 0.30f);
        setPx(hint, base * 0.30f);
        setPx(idleTitle, base * 1.15f);
        setPx(idleNote, base * 0.42f);
        // 字号/留白变了要按**当前这一句**重排（行数与翻页状态都跟着变）。
        if (lastText != null && !lastText.isEmpty()) {
            applySubtitleLayout(lastText);
        } else {
            applySubtitleSize(lastLines);
        }
    }

    private static void setPx(TextView view, float px) {
        view.setTextSize(TypedValue.COMPLEX_UNIT_PX, Math.max(1f, px));
    }

    /** 上一次的字幕行数（微调之后要按同一个行数重算，不能跳回 1 行）。 */
    private int lastLines = 1;

    /** 兜底：尺寸完全未知（连测量都没有）时按行数给一个大致的 SP 字号。 */
    private void applySubtitleSize(int lines) {
        this.lastLines = Math.max(1, lines);
        int height = effectiveHeight();
        if (height <= 0) {
            float sp = lines <= 2 ? 16f : lines == 3 ? 13f : 11f;
            subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
            return;
        }
        // 尺寸已知：直接用配置的固定字号（与语种无关，反正只是兜底）
        setPx(subtitle, containsCjk(lastText) ? fontPxZh : fontPxPt);
    }

    /**
     * 按**整句**重新选字号：从"一行放少数字"往"一行放多数字"试，
     * 取第一个能在**可用高度内**放下（且不低于字号下限）的字号。
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
     * <p><b>① 选字号</b>：从"一行放少数字"往"一行放多数字"试，取第一个
     * **纵向放得下**的字号（唯一的约束是高度，不再有"最多 4 行"的硬上限）。
     * 必须按整句真实文本、真的排一遍来试 —— 用"上一次的字号"去估行数，
     * 短句后来个长句就会估错，字号偏大 → 换行超出可见高度 → 被截断。
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

        // ── 字号：**固定值，按语种取**，不再随句子长度缩放 ────────────────────
        //
        // 怎么判断用哪个：**看要显示的这串字里有没有汉字**。
        // 为什么不用帧里的 lang：这里要排的是"将要显示的那串文字"，
        // 直接看它自己最准（中英混说时也会落到中文档，而汉字的字面本来就更大）。
        float chosen = containsCjk(text) ? fontPxZh : fontPxPt;

        subtitle.setMaxLines(Integer.MAX_VALUE);
        subtitle.setEllipsize(null);
        subtitle.setText(text);
        setPx(subtitle, chosen);
        Layout layout = measureLayout(usableWidth);

        int totalLines = layout == null ? 1 : Math.max(1, layout.getLineCount());
        int lineHeight = lineHeightOf(layout, chosen);
        // 每页放几行：按可用高度算。ABS 上限只是防呆（画布异常高时别一页几十行）。
        int displayLines = Math.max(1, Math.min(MAX_LINES_ABS, heightBudget / lineHeight));
        lastRealLines = totalLines;
        lastLines = Math.max(1, Math.min(totalLines, displayLines));
        subtitle.setMaxLines(displayLines);

        if (totalLines <= displayLines) {
            cancelPaging();
            // 单页仍然留一个省略号当**安全网**：万一真实排版还是超了（字体替换、
            // 极端宽字符等），至少给出"看得见的省略号"而不是静默裁掉。
            subtitle.setEllipsize(TextUtils.TruncateAt.END);
            subtitle.setText(text);
            return;
        }

        // 需要翻页：**按真实行切片**。每一页正好是"整行"，
        // 所以重新排版时换行位置一致，不会一页里冒出半行。
        pages.clear();
        for (int start = 0; start < totalLines; start += displayLines) {
            int end = Math.min(totalLines, start + displayLines);
            int from = Math.max(0, layout.getLineStart(start));
            int to = Math.min(text.length(), Math.max(from, layout.getLineEnd(end - 1)));
            pages.add(text.substring(from, to).trim());
        }
        pageCount = pages.size();
        cancelPagingTimerOnly();
        showPage(0);
        pageHandler.postDelayed(pageAdvance, pageDelayMs);
    }

    /** 这串文字里有没有汉字（用来决定用中文字号还是葡语字号）。 */
    private static boolean containsCjk(String text) {
        if (text == null) return false;
        for (int index = 0; index < text.length(); index += 1) {
            if (text.charAt(index) >= 0x2E80) return true;
        }
        return false;
    }

    /** 真实行高（从 Layout 里取，取不到才退回按字号估）。 */
    private static int lineHeightOf(Layout layout, float font) {
        if (layout != null && layout.getLineCount() > 0) {
            int height = layout.getLineBottom(0) - layout.getLineTop(0);
            if (height > 0) return height;
        }
        return Math.max(1, Math.round(font * 1.35f));
    }

    /**
     * 按给定宽度把当前文本**真的排一遍**，把 Layout 要回来。
     *
     * <p>为什么必须真的排：行数、行高、每行的字符区间，只有安卓自己算得准 ——
     * 用"汉字算 2 列"那种模型去估，遇到葡语的宽字母就会低估行数，
     * 结果是"判成放得下、实际放不下"，多出来的词被省略号吃掉。
     *
     * <p>只调用 {@code measure}，不影响真实布局：下一次父容器的布局遍历会
     * 用真实规格重新测量它（{@code measure} 本身不改变视图树结构）。
     */
    private Layout measureLayout(int width) {
        subtitle.measure(
                View.MeasureSpec.makeMeasureSpec(Math.max(1, width), View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        return subtitle.getLayout();
    }

    /** 诊断用：上一次排版**真实**排了几行（不是估算）。 */
    private int lastRealLines = 0;

    public int getRealLines() {
        return lastRealLines;
    }

    /**
     * 排版自检：用**当前字号与当前画布**，把给进来的样例各排一遍，报出真实数字。
     *
     * <p><b>为什么需要它</b>：决定字号时我算过一张"字号 → 每行几个字"的表，但那是
     * **模型估的**（中文 ≈1em、拉丁 ≈0.5em/字符）。而葡语的宽字母（m/w/大写/带音标）
     * 比 0.5em 宽，真实每行字数比表里少 —— 上一轮"几个词被省略号吃掉"就是这个偏差。
     * 所以**别拿估算当判据**：这个自检在设备上真的排一遍，给的是实况。
     *
     * <p>样例由调用方给（`MainActivity` 从生成的资源数组里取）——
     * 这样"点开看的句子"和"量数字的句子"是同一批，不会各说各话。
     *
     * <p>用一个**临时 TextView** 量，不动正在显示的那一个 —— 自检不该有副作用。
     */
    public String selfCheck(java.util.List<String> zhSamples, java.util.List<String> ptSamples) {
        // 画布未知时不自检 —— 排出来的行数会是假的（宽度按 1px 算，一行一个字）。
        // 与其给一个会误导人的数字，不如说清楚"现在量不了、还差什么"。
        if (usableWidthPx() <= 0 || effectiveHeight() <= 0) {
            return "画布尺寸还不知道（" + effectiveWidth() + "×" + effectiveHeight() + "），量不了。\n"
                    + "先用「投屏到眼镜」连上，让 SDK 报出真实分辨率，再回来点这个自检。";
        }
        StringBuilder out = new StringBuilder();
        out.append("画布 ").append(effectiveWidth()).append("×").append(effectiveHeight())
           .append(" · 可用宽 ").append(usableWidthPx()).append("px")
           .append("（左右留白 ").append(marginLeftPercent).append("%/")
           .append(marginRightPercent).append("%）\n")
           .append("字号 中文 ").append(Math.round(fontPxZh)).append("px / 葡语 ")
           .append(Math.round(fontPxPt)).append("px\n");
        reportSamples(out, "中文", zhSamples, fontPxZh);
        reportSamples(out, "葡语", ptSamples, fontPxPt);
        return out.toString();
    }

    private void reportSamples(StringBuilder out, String label,
                              java.util.List<String> samples, float fontPx) {
        if (samples == null || samples.isEmpty()) return;
        out.append("\n══ ").append(label).append("（").append(Math.round(fontPx)).append("px）══\n");
        for (String sample : samples) {
            if (sample == null || sample.isEmpty()) continue;
            out.append(measureSample(sample, fontPx));
        }
    }

    /** 这串文字里有没有汉字（`MainActivity` 也要用，用来决定用户输的那句归哪一档）。 */
    public boolean containsCjkText(String text) {
        return containsCjk(text);
    }

    private String measureSample(String sample, float fontPx) {
        // 临时 TextView：只用来量，不加入视图树、不影响显示中的那一块
        TextView probe = new TextView(root.getContext());
        probe.setTypeface(Typeface.DEFAULT_BOLD);
        probe.setTextSize(TypedValue.COMPLEX_UNIT_PX, Math.max(1f, fontPx));
        probe.setMaxLines(Integer.MAX_VALUE);
        probe.setText(sample);
        int width = Math.max(1, usableWidthPx());
        probe.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
        Layout layout = probe.getLayout();
        int lines = layout == null ? 0 : layout.getLineCount();
        int lineHeight = lineHeightOf(layout, fontPx);
        int heightBudget = Math.round(effectiveHeight() * 0.85f);
        int displayLines = Math.max(1, Math.min(MAX_LINES_ABS, heightBudget / Math.max(1, lineHeight)));
        int pages = lines <= 0 ? 0 : (lines + displayLines - 1) / displayLines;

        // 每行的字符数。**为什么要最长的那一行、而不是第 1 行**：
        // 这是真机上量出来的教训。葡语例子 40px 下第 1 行只有 18 个字符，
        // 但那一行是 "A Universidade de " —— 因为下一个词 Aeronáutica（11 字符）
        // 塞不进去，**整词挪到了下一行**。所以第 1 行短并不代表放不下，
        // 它只是"碰巧断在了一个长词前面"。
        // 最长的行才是最接近"一行到底能放多少"的那个数。
        // （中文可以任意位置断行，所以对中文两者差不多；葡语差别很大。）
        int maxLineChars = 0;
        int firstLineChars = 0;
        if (layout != null && lines > 0) {
            for (int index = 0; index < lines; index += 1) {
                int count = layout.getLineEnd(index) - layout.getLineStart(index);
                if (count > maxLineChars) maxLineChars = count;
            }
            firstLineChars = layout.getLineEnd(0) - layout.getLineStart(0);
        }

        StringBuilder out = new StringBuilder();
        out.append("· ").append(sample).append('\n');
        out.append("  ").append(lines).append(" 行 · 行高 ").append(lineHeight)
           .append("px · 每页 ").append(displayLines).append(" 行 → ")
           .append(pages <= 1
                   ? "一页放下"
                   : ("翻 " + pages + " 页（每 " + (pageDelayMs / 1000f) + "s 一次，共 "
                           + String.format(java.util.Locale.US, "%.1f", pages * pageDelayMs / 1000f) + "s）"))
           .append('\n');
        if (lines > 0) {
            out.append("  最长一行 ").append(maxLineChars).append(" 字符")
               .append("（第 1 行 ").append(firstLineChars).append("，含空格与标点）\n");
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
        /**
         * @param page      当前第几页（从 0 起）
         * @param pageCount 这一句共几页
         * @param lines     每页最多几行
         * @param text      这一页**实际显示的文字** —— 界面会把它末尾几个字打进日志，
         *                  这样"结尾那几个词有没有丢"在日志里就直接看得见，
         *                  不必靠盯着眼镜猜。
         */
        void onPage(int page, int pageCount, int lines, String text);
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
        if (pageListener != null) pageListener.onPage(page, pageCount, lastLines, pages.get(page));
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
     * 字号**下界**（像素）：比这个再小，戴在脸上就看不清了。
     *
     * <p><b>这个数字是戴上之后量出来的，不是推出来的。</b>所以它写进代码、并由界面强制，
     * 而不是留给用户自己试错 —— 试错的代价是"看了一整场却没看清"，而那不会有人来报错。
     *
     * <p>定标过程：按"字号随句子长度自动缩小"跑一遍，把每档字号算出来，让用户戴着眼镜看
     * 哪一档开始看不清 —— 结论是 **120 字符 → 31.6px 还能看清，再小就不行了**。
     * 画布高 400px，31.6/400 ≈ 7.9%。（"120 字符 31.6px 4.9% 作为下界，
     * 不然太小的看不清"。）
     *
     * <p>为什么不能靠"放得下"来定：不设下界时 220 字符的句子会被压到 16.9px，
     * 数学上确实"放下了"，但在光波导上等于没显示。
     * <b>"放得下"和"看得清"是两回事</b>，下界就是这条界线。
     *
     * <p>⚠️ 它曾经是 {@code minFontRatio}（一个比例），配合"按句子长度自动缩放"用。
     * 现在字号改成了**固定值、不随句子缩放**，比例就没有意义了 —— 但这条下界的
     * 证据仍然有效，只是角色变了：从"缩放的停止线"变成"用户能调到多小"。
     * 所以改成绝对值 px 保留下来，并真的用上（见 {@code MainActivity} 的加减档）。
     */
    public static final float FONT_FLOOR_PX = 31.6f;

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
     * <p>字号是**固定的**（中文一个值、葡语一个值），不随句子长度缩放；
     * 内容超出一页高度才翻页。为什么不再自适应：见 {@link #applySubtitleLayout}
     * 上面那段 —— 简言之"每句都变字号"会让佩戴者一直在重新适应。
     *
     * <p>眼镜上**看不到就是没翻**，所以宁可翻页，也不要截断
     * （截断会把句尾丢掉，那通常是最关键的信息）。
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
     * ⚠️ 这里原来有几个"列宽模型"的辅助函数（{@code countLines} / {@code columnsOf} /
     * {@code sliceColumns} / {@code columnsPerLine}）—— 全部**删掉了**。
     *
     * <p>它们算的是"汉字 2 列、其他 1 列"的估算值，而翻页/截断的判据现在一律用
     * 安卓**真实排版**的结果（见 {@link #applySubtitleLayout} 与 {@link #measureLayout}）。
     * 留着它们只会让人误以为"判定还在用这个模型" —— 那正是上一版出问题的地方。
     *
     * <p>相关背景：用户的怀疑（"是不是我调了字号/留白导致判断偏差"）是对的。
     * 模型的偏差随字号与可用宽度放大，所以他一改参数，偏差就从"无所谓"变成
     * "几个词被吃掉"。
     */

    /**
     * 连接状态一行 + 右上角提示。
     *
     * <p>为什么要显示这个：眼镜连没连上、投屏成没成，在手机上**看不出来** ——
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
