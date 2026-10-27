package com.leion.lanrelay;

import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import org.json.JSONObject;

import java.net.URI;
import java.net.URL;
import java.util.Locale;

/**
 * FloorSocket —— 发言权推送通道（relay 的 `/ws`，见 lib/ws-hub.mjs）。
 * ============================================================================
 *
 * <p><b>为什么要有它</b>：发言权原来靠"每 2 秒 GET 一次 /floor"。被顶替的那一方最多要
 * 2 秒才知道自己被静音了 —— 而这段时间里它的麦克风还在传（4.34 修的正是它照做的问题，
 * 这条通道解决的是"**知都不知道**"）。改成 WS 推送后是**一推即到**。
 *
 * <p><b>它推两件事</b>：谁在说话（低频）与**新字幕帧**（4.43 起）。
 * 长轮询 `/frame` 仍然保留作兜底 —— WS 断了好歹还能收到字幕。
 * 音频不走这里（目前只有"手机→电脑"一个方向）。
 *
 * <p><b>断了不影响功能</b>：`RoomActivity` 里 2 秒轮询一直在跑，WS 只是让它更快。
 * 所以这里连不上、掉了、服务端没这个端点（老版本 relay）都**只记一行状态**，不弹框。
 *
 * <p>协议（都是 JSON 文本帧）：
 * <pre>
 *   服务端 → 客户端  {type:'floor', holder, locked, leaseMs, roomId, at}
 *   客户端 → 服务端  {type:'ping'} / {type:'snapshot'}
 * </pre>
 * 连上立刻会收到一条 floor，不需要客户端再问一次。
 */
public class FloorSocket {

    /** 回调都在 **WebSocket 自己的线程** 上，调用方（Activity）必须自己切回主线程。 */
    public interface Listener {
        /** 收到一份完整的发言权状态（整条替换，不做增量）。 */
        void onFloor(JSONObject state);

        /**
         * 收到一帧新字幕（4.43 起也是推过来的，不再是每帧一次 HTTP 长轮询）。
         *
         * <p>参数就是服务端那条消息本体（含 `seq` 与 `frame`）：
         * 界面自己决定怎么渲染，这条通道只负责"来了一帧、别等了"。
         */
        void onFrame(JSONObject message);

        /** 连接层的一行状态（连上 / 断开 / 出错）。失败不是错误，轮询会兜住。 */
        void onState(String message);

        /** 连接可用性变了：true = 推送通道活着（轮询可以放慢）。 */
        void onOnlineChanged(boolean online);
    }

    private final String baseUrl;
    private final String secret;
    private final String token;
    private final String roomKey;
    private final Listener listener;

    private Inner inner;
    private volatile boolean online = false;

    public FloorSocket(String baseUrl, String secret, String token, String roomKey, Listener listener) {
        this.baseUrl = baseUrl == null ? "" : baseUrl.trim();
        this.secret = secret == null ? "" : secret;
        this.token = token == null ? "" : token;
        this.roomKey = roomKey == null ? "" : roomKey;
        this.listener = listener;
    }

    public boolean isOnline() {
        return online;
    }

    /** 异步连接（不阻塞界面线程）。失败只是一行状态。 */
    public void start() {
        URI uri;
        try {
            uri = wsUri();
        } catch (Exception error) {
            listener.onState("发言权推送地址不合法：" + describe(error));
            return;
        }
        inner = new Inner(uri);
        // 手机进电梯/切网很常见：让库自己发现死连接，别等我们超时
        try {
            inner.setConnectionLostTimeout(30);
        } catch (Throwable ignored) {
            // 老版本库没有这个方法：不影响主流程
        }
        try {
            inner.connect();
        } catch (Exception error) {
            listener.onState("发言权推送连不上：" + describe(error));
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

    /**
     * http://ip:8788 → ws://ip:8788/ws?room=&token=&secret=
     *
     * <p>密钥与 token 走请求头（Java-WebSocket 支持自定义头），房间走 query ——
     * 服务端两种都认（`lib/ws-hub.mjs` 的 handshake），这样浏览器里试也能用。
     */
    private URI wsUri() throws Exception {
        URL url = new URL(baseUrl);
        String scheme = baseUrl.toLowerCase(Locale.US).startsWith("https") ? "wss" : "ws";
        int port = url.getPort() == -1 ? url.getDefaultPort() : url.getPort();
        String host = url.getHost();
        String path = "/ws?room=" + encode(roomKey);
        String built = scheme + "://" + host + ":" + port + path;
        return new URI(built);
    }

    private static String encode(String text) {
        try {
            return java.net.URLEncoder.encode(text == null ? "" : text, "UTF-8");
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String describe(Exception error) {
        String message = error.getMessage();
        return message == null ? error.getClass().getSimpleName() : message;
    }

    private void setOnline(boolean value) {
        if (online == value) {
            return;
        }
        online = value;
        listener.onOnlineChanged(value);
    }

    private final class Inner extends WebSocketClient {
        Inner(URI uri) {
            super(uri);
            if (!secret.isEmpty()) {
                addHeader("X-Leion-Secret", secret);
            }
            if (!token.isEmpty()) {
                addHeader("X-Leion-Token", token);
            }
        }

        @Override
        public void onOpen(ServerHandshake handshake) {
            setOnline(true);
            listener.onState("发言权推送已连上");
            // 连上服务端会立刻推一条 floor；这里再要一次只是保险（老服务端可能不主动推）
            try {
                send("{\"type\":\"snapshot\"}");
            } catch (Exception ignored) {
                // 发不出去就算了，轮询会兜住
            }
        }

        @Override
        public void onMessage(String message) {
            if (message == null || message.isEmpty()) {
                return;
            }
            JSONObject parsed;
            try {
                parsed = new JSONObject(message);
            } catch (Exception error) {
                return;   // 不是 JSON 就当没看见：别因为一句话断掉整条通道
            }
            String type = parsed.optString("type", "");
            if ("floor".equals(type)) {
                listener.onFloor(parsed);
            } else if ("frame".equals(type)) {
                listener.onFrame(parsed);
            }
        }

        @Override
        public void onClose(int code, String reason, boolean remote) {
            setOnline(false);
            listener.onState("发言权推送断开（" + code
                    + (reason == null || reason.isEmpty() ? "" : "·" + reason)
                    + "），已回落到 2 秒轮询");
        }

        @Override
        public void onError(Exception error) {
            setOnline(false);
            listener.onState("发言权推送出错：" + describe(error) + "（轮询仍在跑）");
        }
    }
}
