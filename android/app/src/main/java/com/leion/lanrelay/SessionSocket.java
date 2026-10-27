package com.leion.lanrelay;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;

import java.net.URI;
import java.net.URL;
import java.util.Locale;

/**
 * SessionSocket —— 「我被别处登录挤下线了」的**推送**通道（4.45）。
 * ============================================================================
 *
 * <p><b>为什么需要另一条连接</b>：`SessionWatch` 靠每 10 秒问一次 `/auth/whoami` 来判断
 * 自己还在不在线 —— 也就是说，被顶掉的那台最慢要 10 秒才知道，用户体感是"被踢了却不吭声"。
 * 而"另一个设备刚登录"这件事，**服务端当场就知道**（它就是在那一刻吊销旧 token 的）。
 *
 * <p>所以这里连一条很轻的 WS：`/ws?session=1`。服务端在那个账号被顶掉时推
 * `{type:'kicked', reason}`，然后关连接。延迟从"最多 10 秒"变成"一秒之内"。
 *
 * <p><b>为什么首页/大厅不直接复用房间通道</b>：房间通道要 `room`，而首页与大厅的人
 * 根本不在任何房间里 —— 恰恰这两个页面是最容易发生"另一台正在登录"的地方。
 *
 * <p><b>轮询不删</b>：推送只是加速。`SessionWatch` 仍在跑，只是当推送通道活着时把间隔
 * 从 10 秒放宽到 60 秒（见 {@link SessionWatch#setIntervalMs(long)}）。
 */
public class SessionSocket {

    public interface Listener {
        /** 被别处登录顶掉：界面提示并回登录页。回调在 WS 线程，调用方自己切主线程。 */
        void onKicked(String reason);

        /** 推送通道的可用性变了（true = 活着，可以把轮询放慢）。 */
        void onOnlineChanged(boolean online);
    }

    private final String baseUrl;
    private final String secret;
    private final String token;
    private final Listener listener;

    private Inner inner;
    private volatile boolean online = false;

    public SessionSocket(String baseUrl, String secret, String token, Listener listener) {
        this.baseUrl = baseUrl == null ? "" : baseUrl.trim();
        this.secret = secret == null ? "" : secret;
        this.token = token == null ? "" : token;
        this.listener = listener;
    }

    public boolean isOnline() {
        return online;
    }

    /** 异步连接；连不上不算错误（轮询会兜住）。 */
    public void start() {
        if (token == null || token.isEmpty()) return;
        URI uri;
        try {
            uri = wsUri();
        } catch (Exception error) {
            return;
        }
        inner = new Inner(uri);
        try {
            inner.setConnectionLostTimeout(30);
        } catch (Throwable ignored) {
            // 老版本库没有这个方法：不影响主流程
        }
        try {
            inner.connect();
        } catch (Exception ignored) {
            // 连不上就靠 SessionWatch 轮询
        }
    }

    public void stop() {
        online = false;
        if (inner != null) {
            try {
                inner.close();
            } catch (Exception ignored) {
                // 已经断了
            }
            inner = null;
        }
    }

    private URI wsUri() throws Exception {
        URL url = new URL(baseUrl);
        String scheme = baseUrl.toLowerCase(Locale.US).startsWith("https") ? "wss" : "ws";
        int port = url.getPort() == -1 ? url.getDefaultPort() : url.getPort();
        return new URI(scheme + "://" + url.getHost() + ":" + port + "/ws?session=1");
    }

    private void setOnline(boolean value) {
        if (online == value) return;
        online = value;
        listener.onOnlineChanged(value);
    }

    private final class Inner extends WebSocketClient {
        Inner(URI uri) {
            super(uri);
            if (secret != null && !secret.isEmpty()) addHeader("X-Leion-Secret", secret);
            if (token != null && !token.isEmpty()) addHeader("X-Leion-Token", token);
        }

        @Override
        public void onOpen(ServerHandshake handshake) {
            setOnline(true);
        }

        @Override
        public void onMessage(String message) {
            if (message == null || message.isEmpty()) return;
            JSONObject parsed;
            try {
                parsed = new JSONObject(message);
            } catch (Exception ignored) {
                return;
            }
            if ("kicked".equals(parsed.optString("type", ""))) {
                setOnline(false);
                listener.onKicked(parsed.optString("reason", "elsewhere-login"));
            }
        }

        @Override
        public void onClose(int code, String reason, boolean remote) {
            setOnline(false);
        }

        @Override
        public void onError(Exception error) {
            setOnline(false);
        }
    }
}
