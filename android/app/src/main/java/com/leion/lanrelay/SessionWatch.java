package com.leion.lanrelay;

/**
 * SessionWatch —— 每隔几秒问一次"我还登录着吗"（4.41）。
 * ============================================================================
 *
 * <p><b>为什么需要</b>：单会话是刻意的（同一账号后登录的踢掉前一个），但被踢的那台手机
 * 只是「token 被吊销」——它自己不会知道。于是用户看到的是：另一台手机一登录，这一台
 * **静默地什么也没发生**，直到某次点按钮失败（用户 2026-10-27 报的）。
 *
 * <p>做法很朴素：每 {@link #INTERVAL_MS} 问一次 `/auth/whoami`。
 *   · 200 → 什么也不做（静默是常态，不能每 10 秒闪一下提示）；
 *   · 401 → 回调 {@link Listener#onKicked}，由界面提示并回登录页；
 *   · 网络失败 → **什么也不做**：连不上服务器不代表被踢了（4.33 的教训：
 *     网络抖动被当成掉登录，用户重登又把另一台真的踢掉，问题越滚越大）。
 *
 * <p>刻意不用 WS 通道推"被踢"：首页与大厅根本没连 WS，而这里要覆盖的正是"待在首页等着"
 * 的那台设备。轮询一个很轻的 GET 就够，且**兜底性最好**（任何入口都能用）。
 */
public class SessionWatch {

    /** 检查间隔。10 秒足够"当场发现"，又不至于把服务器问烦（960 次/天/设备）。 */
    static final long INTERVAL_MS = 10000L;

    /**
     * 推送通道（{@link SessionSocket}）活着时的间隔：60 秒。
     *
     * <p>为什么还要留着轮询：推送是"服务端说"、轮询是"我主动问"，两条独立的路。
     * WS 断了、服务端重启、代理把长连接掐了 —— 这些情况下推送是**静默失效**的，
     * 只有轮询能发现。但既然推送已经把延迟压到"一秒内"，兜底就不必跑那么勤。
     */
    static final long INTERVAL_SLOW_MS = 60000L;

    public interface Listener {
        /** 会话已失效（被别处登录顶掉 / token 过期）。回调在后台线程，界面自己切主线程。 */
        void onKicked(String message);
    }

    private final LanClient client;
    private final Listener listener;

    private volatile boolean running = false;
    private volatile long intervalMs = INTERVAL_MS;
    private Thread thread;

    /** 推送通道活着 → 放宽到 60 秒；断了 → 立刻回到 10 秒。 */
    public void setIntervalMs(long value) {
        intervalMs = value <= 0 ? INTERVAL_MS : value;
    }

    public SessionWatch(LanClient client, Listener listener) {
        this.client = client;
        this.listener = listener;
    }

    public void start() {
        if (running) return;
        running = true;
        thread = new Thread(this::loop, "session-watch");
        thread.setDaemon(true);
        thread.start();
    }

    public void stop() {
        running = false;
        Thread current = thread;
        thread = null;
        if (current != null) current.interrupt();
    }

    private void loop() {
        while (running) {
            try {
                client.checkSession();
            } catch (LanClient.SessionExpiredException expired) {
                if (!running) return;
                running = false;
                String message = expired.getMessage();
                listener.onKicked(message == null || message.isEmpty()
                        ? "登录已失效（账号可能在别处登录）" : message);
                return;
            } catch (Exception ignored) {
                // 连不上 / 服务端临时异常：**不当作掉登录**（见类注释）
            }
            try {
                Thread.sleep(intervalMs);
            } catch (InterruptedException stop) {
                return;
            }
        }
    }
}
