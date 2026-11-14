package com.leion.lanrelay;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * MeetingMicService —— 息屏之后**继续收音**的前台服务（5.154）。
 * ============================================================================
 *
 * <p>用户报的问题：会议开着、正在说话，按一下电源键息屏，麦克风就停了 ——
 * 再点亮屏幕看，字幕已经断了一大段，而他其实一直在说。
 *
 * <p>根因有两层，缺一不可地解释这个现象：
 * <ol>
 *   <li>**我们自己的代码**：{@code RoomActivity.onStop()} 里无差别地
 *       {@code releaseAudio()}（5.28 立的规矩"退到后台就交还麦克风"）。
 *       息屏也会走 onStop，于是录音被主动停掉；</li>
 *   <li>**系统的策略**：targetSdk ≥ 30 之后，应用不在前台时**不能**采集麦克风
 *       （Android 11+ 直接静音或拒绝）。所以哪怕我们不释放，没有前台服务也拿不到声音。</li>
 * </ol>
 *
 * <p>所以这个服务干两件事：把自己标成 {@code foregroundServiceType="microphone"} 的
 * 前台服务（让"后台采集"这件事合法），并持一把 **PARTIAL_WAKE_LOCK**
 * （屏幕灭了 CPU 也会睡，睡下去录音线程就没人调度了 —— 表现为"录音还在、
 * 但时间戳断断续续"）。
 *
 * <p>⚠️ 只在**正在上传（我持麦）**期间存在：开麦时启动、放麦/退会/退出页面时停掉。
 * 常驻通知就是给用户的"现在还在收音"的凭据 —— 会议类应用不该偷偷录音，
 * 而这也是 Android 对前台服务的硬要求。
 */
public class MeetingMicService extends Service {

    private static final String TAG = "LeionMicService";
    private static final String CHANNEL_ID = "leion-meeting-mic";
    private static final int NOTIFICATION_ID = 4201;

    public static final String ACTION_START = "com.leion.lanrelay.action.MEETING_MIC_START";
    public static final String ACTION_STOP = "com.leion.lanrelay.action.MEETING_MIC_STOP";

    private PowerManager.WakeLock wakeLock;

    /**
     * 起服务（幂等）。**必须在还处于前台时调用**：Android 12+ 不允许从后台启动
     * 前台服务（会抛 {@code ForegroundServiceStartNotAllowedException}）。
     * 调用点是"开麦成功那一刻"，天然在前台。
     */
    public static void start(Context context) {
        if (context == null) return;
        Intent intent = new Intent(context, MeetingMicService.class);
        intent.setAction(ACTION_START);
        try {
            context.startForegroundService(intent);
        } catch (Exception error) {
            // 起不来不该把开会拖下水：收音已经在跑，只是"息屏后可能断"这一个降级
            Log.w(TAG, "启动前台服务失败（息屏后可能收不到音）：" + error);
        }
    }

    public static void stop(Context context) {
        if (context == null) return;
        try {
            context.stopService(new Intent(context, MeetingMicService.class));
        } catch (Exception error) {
            Log.w(TAG, "停止前台服务失败：" + error);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : String.valueOf(intent.getAction());
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // 5.201：这里必须包起来（不要在注释里写反引号，构建脚本会当成模板串）。
        // 实测 Xiaomi 2106118C / Android 14：建房后在房间页起这个前台服务，
        // 若 RECORD_AUDIO 还没授权（新装或用户拒过），startForeground 会抛 SecurityException
        // （Starting FGS with type microphone ... requires permissions）。
        // 而它是在 onStartCommand 里抛的：调用方的 try/catch 接不住，主线程直接崩 ——
        // 用户看到的就是"会议建好了但 App 闪退"。
        // 这个服务只是"息屏后别断"的降级手段，绝不能因为它把整个会开不成。
        if (!safeForeground()) {
            Log.w(TAG, "前台服务起不来（多半是没给麦克风权限）→ 放弃它，会议照常进行");
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireWakeLock();
        // 不被系统随手杀掉（杀了就等于息屏后又断了）；但**不**自动重启 ——
        // 会议是用户主动结束的，进程被杀后再自己爬起来录音是没人预期的事。
        return START_NOT_STICKY;
    }

    /**
     * 起前台服务；起不来就返回 false（由调用方降级），绝不往上抛。
     *
     * <p>为什么 catch Throwable 而不只是 Exception：这类系统调用在不同 ROM 上会抛出
     * 各种东西（SecurityException / ForegroundServiceStartNotAllowedException，
     * 个别 ROM 甚至抛 Error），而"一个可选的后台保活手段"不该有能力杀掉整个会。
     */
    private boolean safeForeground() {
        try {
            startForeground(NOTIFICATION_ID, buildNotification());
            return true;
        } catch (Throwable error) {
            try {
                Log.w(TAG, "startForeground 失败（" + error.getClass().getSimpleName() + "）：" + error);
            } catch (Throwable ignored) {
                // 连日志都打不出去也不能崩
            }
            return false;
        }
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        super.onDestroy();
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        try {
            PowerManager manager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (manager == null) return;
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "leion:meeting-mic");
            // 不加超时：由 onDestroy 释放。加超时反而会在长会议里悄悄失效（更难过）
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        } catch (Exception error) {
            Log.w(TAG, "获取唤醒锁失败（息屏后可能断音）：" + error);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception error) {
            Log.w(TAG, "释放唤醒锁失败：" + error);
        }
        wakeLock = null;
    }

    private Notification buildNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                    getString(R.string.mic_service_channel), NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.mic_service_channel_desc));
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        // 点通知回到会议页（没有可回的就什么都不做，不能崩）
        Intent open = new Intent(this, RoomActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent content = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_mic)
                .setContentTitle(getString(R.string.mic_service_title))
                .setContentText(getString(R.string.mic_service_text))
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(content);
        return builder.build();
    }
}
