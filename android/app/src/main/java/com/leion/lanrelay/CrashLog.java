package com.leion.lanrelay;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 把未捕获异常的堆栈落到文件里，下次打开 App 能看见。
 *
 * <p><b>为什么必须有这个</b>：眼镜这条线上真机 adb 不一定能用
 * （开发沙箱里 adb 服务端起不来，用户手上也不一定有电脑），而"APP 闪退"
 * 如果没有堆栈就完全无法定位 —— 只能靠猜，猜一次就是一轮真机往返。
 *
 * <p>做法就是 {@link Thread#setDefaultUncaughtExceptionHandler}：进程要死之前
 * 先把堆栈写进 {@code files/last-crash.txt}，然后**把原来的处理器接力调回去**。
 * 接力这一步很关键：吞掉异常会让系统的崩溃上报失效，也会让进程卡在一个
 * 半死状态里不退出。
 *
 * <p>刻意不引第三方崩溃库：这里只需要"留下一段文本"，
 * 而每多一个依赖就多一层眼镜 AAR 版本冲突的风险（见 {@code app/build.gradle.kts}
 * 里那一大段 resolutionStrategy）。
 */
public final class CrashLog {

    private static final String TAG = "CrashLog";
    private static final String FILE_NAME = "last-crash.txt";

    private CrashLog() {
    }

    /** 装一次即可（重复调用是安全的）。放在 Application/Activity.onCreate 最前面。 */
    public static void install(final Context context) {
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                write(context, thread, error);
            } catch (Throwable ignored) {
                // 写日志本身失败绝不能盖掉原异常 —— 那会让排查更难
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    private static void write(Context context, Thread thread, Throwable error) {
        StringWriter buffer = new StringWriter();
        buffer.append("时间：").append(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
                .format(new Date())).append('\n');
        buffer.append("线程：").append(thread == null ? "?" : thread.getName()).append('\n');
        buffer.append("异常：").append(error == null ? "?" : error.getClass().getName()).append('\n');
        buffer.append('\n');
        if (error != null) error.printStackTrace(new PrintWriter(buffer));

        Log.e(TAG, "未捕获异常已记录\n" + buffer);
        try (java.io.FileOutputStream out = context.openFileOutput(FILE_NAME, Context.MODE_PRIVATE)) {
            out.write(buffer.toString().getBytes("UTF-8"));
        } catch (Throwable failure) {
            Log.w(TAG, "写崩溃日志失败", failure);
        }
    }

    /** 上一次崩溃的文本；没有就返回空串。 */
    public static String last(Context context) {
        File file = new File(context.getFilesDir(), FILE_NAME);
        if (!file.exists()) return "";
        try (java.io.FileInputStream in = context.openFileInput(FILE_NAME)) {
            byte[] bytes = new byte[(int) file.length()];
            int read = in.read(bytes);
            return read <= 0 ? "" : new String(bytes, 0, read, "UTF-8");
        } catch (Throwable error) {
            return "";
        }
    }

    /** 看过了就删掉，免得每次打开都弹同一个旧崩溃。 */
    public static void clear(Context context) {
        new File(context.getFilesDir(), FILE_NAME).delete();
    }
}
