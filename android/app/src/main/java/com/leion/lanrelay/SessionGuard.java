package com.leion.lanrelay;

import android.content.SharedPreferences;

/**
 * SessionGuard —— 「我在这台手机上还是登录状态吗」的共用一段（5.04）。
 * ============================================================================
 *
 * <p><b>为什么抽出来</b>：创建页与加入页都是"填表 → 发请求"的短流程，但用户可能在这里
 * 停留很久（在想会议主题、在等对方发邀请码），而<b>另一台设备登录</b>随时可能把他顶掉。
 * 这段逻辑原来只写在旧的大厅页里，现在两个页面都需要 ——
 * 复制两份必然漂（一处改了另一处忘，问题还只在某一个入口出现）。
 *
 * <p><b>两条路一起走</b>（与 4.45 一致，理由见 {@link SessionSocket}）：
 *   · {@link SessionSocket}：服务端当场推 `kicked`，一秒内到达；
 *   · {@link SessionWatch}：每 10 秒问一次，兜住"推送静默失效"（WS 断了/服务端重启）。
 *
 * <p><b>被踢之后做什么</b>：清本地登录态并回调，由页面决定怎么收场
 * （两页都是"提示 + 关页面回首页"，不在本类里硬编码界面动作）。
 */
final class SessionGuard {

    interface Listener {
        /** 被别处登录顶掉 / 登录已失效。回调在主线程。 */
        void onKicked(String message);
    }

    private final LanClient client;
    private final SharedPreferences prefs;
    private final Listener listener;

    private SessionWatch watch;
    private SessionSocket socket;
    private boolean fired = false;

    SessionGuard(LanClient client, SharedPreferences prefs, Listener listener) {
        this.client = client;
        this.prefs = prefs;
        this.listener = listener;
    }

    /** 开始盯着。`host` / `secret` / `token` 都取自当前登录态。 */
    void start(String host, String secret, String token) {
        if (client == null) return;

        watch = new SessionWatch(client, message -> fire(message));
        watch.start();

        if (token == null || token.isEmpty()) return;
        socket = new SessionSocket(host, secret, token, new SessionSocket.Listener() {
            @Override
            public void onKicked(String reason) {
                fire(reason);
            }

            @Override
            public void onOnlineChanged(boolean online) {
                // 推送活着 → 轮询放慢（两条路不必都跑得那么勤）
                if (watch != null) {
                    watch.setIntervalMs(online ? SessionWatch.INTERVAL_SLOW_MS : SessionWatch.INTERVAL_MS);
                }
            }
        });
        socket.start();
    }

    /** 只触发一次：轮询与推送可能同时发现，不能让用户看到两遍提示。 */
    private void fire(String message) {
        if (fired) return;
        fired = true;
        // 清本地登录态（token / 用户名 / 房间发起者标记），否则下一页会拿失效 token 再撞一次
        prefs.edit().remove("accountToken").remove("termsUser").remove("roomHost").apply();
        if (client != null) client.setToken("");
        listener.onKicked(message == null || message.isEmpty()
                ? "登录已失效（账号可能在别处登录）" : message);
    }

    void stop() {
        if (watch != null) {
            watch.stop();
            watch = null;
        }
        if (socket != null) {
            socket.stop();
            socket = null;
        }
    }
}
