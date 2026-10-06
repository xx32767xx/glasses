package com.leion.lanrelay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 与电脑上的局域网转发进程通信。
 *
 * 只做五件事，和 relay/lan-relay.mjs 的五个端点一一对应：
 *   hello()      握手：验证共享密钥 + 取回显示预算（cols / lineBudget）
 *   长轮询循环     /frame?since=&lt;seq&gt;：有新字幕就回调；没有就挂住等
 *   sendText()   把识别出的文字 POST 给 /say（异步，不阻塞界面）
 *   sendAudio()  把一段录音 POST 给 /audio（**同步**，见下面的说明）
 *   status()     /status，诊断用
 *
 * 为什么 sendAudio 是同步的、而 sendText 是异步的：
 *   sendText 是用户点一下发一句，异步即可。而录音上传是每秒一块、连续不断，
 *   如果每块都新起一个线程，网络一慢就会堆出几十个线程互相抢带宽。
 *   所以录音那条路由调用方（MicUploader）在自己的后台线程里**阻塞**调用，
 *   天然形成背压：上传跟不上就少读一点音频，而不是无限制地堆线程。
 *   界面线程绝对不能直接调它。
 *
 * 为什么用长轮询而不是 WebSocket：安卓这边只需要一个普通 HTTP GET 循环，
 * 不用引任何第三方库，也不用处理 WebSocket 握手与重连。字幕本来就是低频事件，
 * 长轮询在没有新帧时是挂住的，不会空转。
 *
 * 注意：所有回调都发生在**后台线程**上，调用方（Activity）必须自己切回主线程。
 */
public class LanClient {

    /** 回调接口。实现方负责切回主线程。 */
    public interface Listener {
        /** 一条人类可读的状态/进度信息。 */
        void onStatus(String message);

        /** 握手成功：拿到了设备名与显示预算。 */
        void onHello(String device, int cols, int lineBudget);

        /**
         * 收到一帧新字幕。
         *
         * @param text       给佩戴者看的那一侧（已翻译好）；lines 是它按显示预算折好的行
         * @param source     原文（对方说的话，或佩戴者自己说的话）；没有就是空串
         * @param sourceLang 原文语种；未知是 "unknown"
         * @param partial    true = 这一帧还是流式增量（界面要打「生成中」并**原位更新**）
         *
         * 为什么 source 和 partial 都要：界面按"原文在上、译文在下"成对显示，
         * 并且要把"增量 → 定稿 → 校对修订"落到**同一条**片段上。
         * 少了这两个字段，手机只能靠猜（猜错的表现是字幕永远挂着「生成中」）。
         */
        void onFrame(String speaker, String lang, String[] lines, String text,
                     String source, String sourceLang, boolean partial);

        /** 出错了（网络不通、密钥错、被拒绝等）。 */
        void onError(String message);
    }

    private final String baseUrl;
    private final String secret;
    private final Listener listener;

    private volatile boolean running = false;
    private Thread pollThread;
    private long seq = 0;

    public LanClient(String baseUrl, String secret, Listener listener) {
        String trimmed = baseUrl == null ? "" : baseUrl.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        this.baseUrl = trimmed;
        this.secret = secret == null ? "" : secret.trim();
        this.listener = listener;
    }

    public void start() {
        if (running) {
            return;
        }
        running = true;
        pollThread = new Thread(this::pollLoop, "lan-poll");
        pollThread.setDaemon(true);
        pollThread.start();
    }

    public void stop() {
        running = false;
        if (pollThread != null) {
            pollThread.interrupt();
            pollThread = null;
        }
    }

    public boolean isRunning() {
        return running;
    }

    /** 把手写/识别出的一句话交给电脑。整个过程在后台线程里做，界面不会卡。 */
    public void sendText(final String text, final String from) {
        if (text == null || text.trim().isEmpty()) {
            return;
        }
        Thread thread = new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("text", text.trim());
                if (from != null && !from.isEmpty()) {
                    body.put("from", from);
                }
                JSONObject response = request("/say", "POST", body, 8000);
                listener.onStatus("已送到电脑：" + text.trim()
                        + "（收件箱第 " + response.optInt("inboxLines", 0) + " 行）");
            } catch (Exception error) {
                listener.onError("发送失败：" + describe(error));
            }
        }, "lan-say");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * 上传一块录音（**同步**，必须在后台线程里调）。
     *
     * @param pcm        裸 PCM，16-bit 小端、单声道
     * @param sampleRate 采样率。安卓不保证都能用 16 kHz，所以如实上报，
     *                   电脑侧的识别进程会按这个数字重采样（猜错会让识别全乱）
     * @param fresh      true = 这是一次新录音的第一块，让继电器先把旧音频清掉
     * @param lang       当前在听哪种语言（zh-CN / pt-BR）。每块都发，
     *                   所以录音中切换语种下一句就生效
     * @return 继电器的回执，含累计秒数（界面用它显示"已上传多久"）
     */
    public JSONObject sendAudio(byte[] pcm, int sampleRate, boolean fresh, String lang)
            throws IOException, org.json.JSONException {
        StringBuilder path = new StringBuilder("/audio?rate=").append(sampleRate);
        if (fresh) {
            path.append("&fresh=1");
        }
        if (lang != null && !lang.isEmpty()) {
            path.append("&lang=").append(lang);
        }
        return requestRaw(path.toString(), pcm, 10000);
    }

    /**
     * 同步读一次 /status，返回原始 JSON（**要在后台线程调**）。
     *
     * 为什么需要它、而不只是 fetchStatus() 那条文字：
     * 界面必须区分"连上了电脑"和"同传服务真的在工作"。这不是靠猜 ——
     * /status 里有真实证据：
     *   · busSeen    继电器有没有见过字幕总线（= 大脑至少产出过一帧字幕）
     *   · inboxLines 收件箱里已经有几行（= 识别那一侧在写东西）
     * 两个都是 0 说明"管道通了但还没流过水"，此时说"服务可用"是过度承诺。
     */
    public JSONObject status() throws IOException, org.json.JSONException {
        return request("/status", "GET", null, 8000);
    }

    /** 诊断：把 /status 的计数读回来。 */
    public void fetchStatus() {        Thread thread = new Thread(() -> {
            try {
                JSONObject json = request("/status", "GET", null, 8000);
                listener.onStatus("电脑侧：字幕 " + json.optInt("frames", 0)
                        + " 帧 / 收到 " + json.optInt("says", 0)
                        + " 句 / 收件箱 " + json.optInt("inboxLines", 0)
                        + " 行（拒绝 " + json.optInt("rejected", 0) + " 次）");
            } catch (Exception error) {
                listener.onError("取状态失败：" + describe(error));
            }
        }, "lan-status");
        thread.setDaemon(true);
        thread.start();
    }

    // ── 内部 ──────────────────────────────────────────────────────────────

    private void pollLoop() {
        // 1) 握手：顺便验证密钥拿错没拿错
        try {
            JSONObject hello = request("/hello", "GET", null, 8000);
            int cols = hello.optInt("cols", 40);
            int lineBudget = hello.optInt("lineBudget", 3);
            seq = hello.optLong("seq", 0);
            listener.onHello(hello.optString("device", "?"), cols, lineBudget);
            listener.onStatus("已连接：" + hello.optString("device", "?")
                    + " · " + cols + " 列 × " + lineBudget + " 行");
        } catch (Exception error) {
            running = false;
            listener.onError("连接失败：" + describe(error));
            return;
        }

        // 2) 长轮询：没有新帧时服务端会把请求挂住（约 25 秒），所以这不是忙等
        while (running) {
            try {
                JSONObject response = request("/frame?since=" + seq, "GET", null, 35000);
                long serverSeq = response.optLong("seq", seq);
                // 序号重置（转发进程重启过）：把本地序号拉回服务端的值。
                // 不做这一步的话，我们记的序号会永远大于服务端，之后每一轮都只能收到
                // "没有新帧"，字幕再也不会上屏 —— 而且完全不会报错，最难查。
                if (serverSeq < seq) {
                    seq = serverSeq;
                }
                if (response.optBoolean("reset", false)) {
                    listener.onStatus("电脑侧序号已重置（转发进程重启过），已自动跟随");
                }
                if (response.optBoolean("changed", false)) {
                    seq = serverSeq;
                    JSONObject frame = response.optJSONObject("frame");
                    if (frame != null) {
                        JSONArray lines = frame.optJSONArray("lines");
                        int count = lines == null ? 0 : lines.length();
                        String[] out = new String[count];
                        for (int i = 0; i < count; i++) {
                            out[i] = lines.optString(i, "");
                        }
                        listener.onFrame(
                                frame.optString("speaker", "them"),
                                frame.optString("lang", "?"),
                                out,
                                frame.optString("text", ""),
                                frame.optString("source", ""),
                                frame.optString("sourceLang", "unknown"),
                                frame.optBoolean("partial", false));
                    }
                }
            } catch (Exception error) {
                if (!running) {
                    break;
                }
                listener.onError("取字幕失败：" + describe(error));
                try {
                    Thread.sleep(2000);
                } catch (InterruptedException ignored) {
                    break;
                }
            }
        }
    }

    /** 一次请求。非 2xx 一律抛异常（把服务端的错误正文带出来，便于排查）。 */
    private JSONObject request(String path, String method, JSONObject body, int readTimeoutMs)
            throws IOException, org.json.JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setRequestProperty("X-Leion-Secret", secret);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(readTimeoutMs);
            connection.setUseCaches(false);

            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(bytes);
                }
            }

            int code = connection.getResponseCode();
            InputStream stream = (code >= 200 && code < 300)
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String text = readAll(stream);

            if (code < 200 || code >= 300) {
                String hint = "";
                if (code == 401) {
                    hint = "（共享密钥不对）";
                }
                throw new IOException("HTTP " + code + hint + " " + text);
            }
            return new JSONObject(text);
        } finally {
            connection.disconnect();
        }
    }

    /**
     * 一次"请求体是原始字节"的请求（音频上传用）。
     * 与上面那个分开写，是因为音频不是 JSON，而且**必须设 Content-Type: application/octet-stream**
     * 并用固定长度 —— 让服务端能直接按字节收，不必去猜编码。
     */
    private JSONObject requestRaw(String path, byte[] payload, int readTimeoutMs)
            throws IOException, org.json.JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setRequestProperty("X-Leion-Secret", secret);
            connection.setRequestProperty("Content-Type", "application/octet-stream");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(readTimeoutMs);
            connection.setUseCaches(false);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(payload);
            }

            int code = connection.getResponseCode();
            InputStream stream = (code >= 200 && code < 300)
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String text = readAll(stream);
            if (code < 200 || code >= 300) {
                String hint = (code == 401) ? "（共享密钥不对）" : (code == 413 ? "（音频块太大）" : "");
                throw new IOException("HTTP " + code + hint + " " + text);
            }
            return new JSONObject(text);
        } finally {
            connection.disconnect();
        }
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) {
            return "";
        }
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int read;
        while ((read = stream.read(chunk)) > 0) {
            buffer.write(chunk, 0, read);
        }
        stream.close();
        return buffer.toString("UTF-8");
    }

    private static String describe(Exception error) {
        String message = error.getMessage();
        if (message == null || message.isEmpty()) {
            return error.getClass().getSimpleName();
        }
        return message;
    }
}
