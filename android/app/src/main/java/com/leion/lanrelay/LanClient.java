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
         * @param termsMissing 本句"提到了表内名字、但译文没写出规范写法"的中文名列表；
         *                     空数组 = 没有（docs/15 §17，只提示、不改字幕）
         *
         * 为什么 source 和 partial 都要：界面按"原文在上、译文在下"成对显示，
         * 并且要把"增量 → 定稿 → 校对修订"落到**同一条**片段上。
         * 少了这两个字段，手机只能靠猜（猜错的表现是字幕永远挂着「生成中」）。
         */
        void onFrame(String speaker, String lang, String[] lines, String text,
                     String source, String sourceLang, boolean partial, String[] termsMissing);

        /** 出错了（网络不通、密钥错、被拒绝等）。 */
        void onError(String message);
    }

    private final String baseUrl;
    private final String secret;
    private final Listener listener;

    private volatile boolean running = false;
    private Thread pollThread;
    private long seq = 0;
    /**
     * 热词表的用户名（docs/15 §8.3）。握手时随 `/hello?user=` 报给电脑，
     * 电脑据此决定"下一场同传读哪张表"。空 → 电脑侧回落 `default`。
     */
    private volatile String user = "";
    /**
     * 账户 token（登录/注册后拿到）。它的用途只有一个：说明"我是谁"。
     *
     * <p>为什么不再用用户名当身份：原来客户端自报 `user=wu`、服务端就信 ——
     * 改一个参数就能读写别人的表。现在服务端只认 token，用户名只是 token 的属性。
     */
    private volatile String token = "";

    public void setUser(String value) {
        this.user = value == null ? "" : value.trim();
    }

    public void setToken(String value) {
        this.token = value == null ? "" : value.trim();
    }

    public String getToken() {
        return token;
    }

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

    /**
     * 把一行"我这边实际做了什么"回传给电脑，打进同一份日志。
     *
     * <p><b>为什么需要它</b>：有些问题**只有把两边并排放才能定位**。
     * 比如"眼镜上显示 Ol…"：电脑端日志能证明它**发了**定稿帧，
     * 但手机收到之后有没有**应用**、应用成了什么，从电脑那边完全看不见 ——
     * 两边各自看都"正常"，合起来才是问题。
     *
     * <p><b>刻意做成 fire-and-forget</b>：在独立线程里发、失败**静默忽略**。
     * 诊断通道坏掉绝不能影响同传本身 —— 它是为了查问题，不是为了制造问题。
     */
    public void sendDiag(String line) {
        if (line == null || line.isEmpty()) return;
        final String baseUrl = this.baseUrl;
        final String secret = this.secret;
        Thread thread = new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("line", line);
                request("/diag", "POST", body, 4000);
            } catch (Throwable ignored) {
                // 诊断失败就失败：不报错、不影响主流程
            }
        }, "diag-send");
        thread.setDaemon(true);
        thread.start();
    }

    /** 诊断：把 /status 的计数读回来。 */
    public void fetchStatus() {        Thread thread = new Thread(() -> {            try {
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

    // ── 账户（注册 / 登录 / 注销 / 我是谁）──────────────────────────────────

    /** 注册账户，成功后拿 token（以后所有请求的身份凭据）。 */
    public JSONObject authRegister(String username, String password)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("username", username);
        body.put("password", password);
        body.put("label", "android");
        return requestWithCode("/auth/register", "POST", body, 12000);
    }

    /** 登录（服务端刻意不区分"用户不存在"与"密码错"）。 */
    public JSONObject authLogin(String username, String password)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("username", username);
        body.put("password", password);
        body.put("label", "android");
        return requestWithCode("/auth/login", "POST", body, 12000);
    }

    /** 注销当前 token（别的设备不受影响）。 */
    public JSONObject authLogout() throws IOException, org.json.JSONException {
        return requestWithCode("/auth/logout", "POST", null, 8000);
    }

    /** 用当前 token 问"我是谁"（失效时 401）。 */
    public JSONObject authWhoAmI() throws IOException, org.json.JSONException {
        return requestWithCode("/auth/whoami", "GET", null, 8000);
    }

    // ── 热词对照表（docs/15 阶段 1：只校验与存取，不做替换）─────────────────

    /**
     * 预校验：只让电脑判一遍，**不保存**。界面上可以反复点。
     *
     * <p>校验在电脑端做（`POST /terms/validate`），手机不自己判 ——
     * 否则会出现"手机上通过、真上传被拒"这种最难解释的情况。
     *
     * @return `{ code, json }`；`json.ok` 为 true 表示全部合法
     */
    public JSONObject termsValidate(org.json.JSONArray entries)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("entries", entries);
        return requestWithCode("/terms/validate", "POST", body, 8000);
    }

    /**
     * 上传：**全合法才整表替换**（一条不合法就整表不存，返回 400 + 逐条原因）。
     * @return `{ code, json }`
     */
    public JSONObject termsPut(org.json.JSONArray entries)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("entries", entries);
        return requestWithCode("/terms", "PUT", body, 12000);
    }

    /** 取电脑上当前生效的那张表（用来回填编辑框）。 */
    public JSONObject termsGet() throws IOException, org.json.JSONException {
        return requestWithCode("/terms", "GET", null, 8000);
    }

    /**
     * 一次请求，但**把非 2xx 也当正常返回**（返回 { code, json }）。
     *
     * <p>为什么热词表要这个：上传时"表里有一处写错"是**正常业务结果**，
     * 而它带着 400 与逐条原因（第几行、什么错）。用 request() 会把这段 JSON
     * 塞进异常消息里，界面就没法逐条显示了。其余端点继续用 request()。
     */
    private JSONObject requestWithCode(String path, String method, JSONObject body, int readTimeoutMs)
            throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setRequestProperty("X-Leion-Secret", secret);
            // 有 token 就带上：服务端据此确定"我是谁"（热词表只认它）
            if (!token.isEmpty()) connection.setRequestProperty("X-Leion-Token", token);
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
            JSONObject result = new JSONObject();
            result.put("code", code);
            org.json.JSONObject parsed;
            try {
                parsed = new org.json.JSONObject(text);
            } catch (org.json.JSONException error) {
                parsed = new org.json.JSONObject();
                parsed.put("error", text.length() > 300 ? text.substring(0, 300) : text);
            }
            result.put("json", parsed);
            return result;
        } catch (org.json.JSONException error) {
            throw new IOException("回包不是合法 JSON：" + error.getMessage());
        } finally {
            connection.disconnect();
        }
    }

    /**
     * 读电脑上的运行时设置（现在只有 `proofread`：校对开关）。
     *
     * <p>为什么以电脑为准：开关真正的效果发生在电脑侧（它决定排不排第二次模型调用）。
     * 手机如果只改本地偏好，就会变成"界面上关着、电脑上还在跑"——那是比没有开关更糟的事。
     */
    public JSONObject settingsGet() throws IOException, org.json.JSONException {
        return requestWithCode("/settings", "GET", null, 8000);
    }

    /** 把校对开关送到电脑。响应里 `effectiveAt` 会写 `next-session`。 */
    public JSONObject settingsPutProofread(boolean enabled) throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("proofread", enabled);
        return requestWithCode("/settings", "PUT", body, 8000);
    }

    // ── 内部 ──────────────────────────────────────────────────────────────

    private void pollLoop() {
        // 1) 握手：顺便验证密钥拿错没拿错
        try {
            // 顺手报上"我是谁"：电脑据此记下这一场用哪张热词表（报错了也不影响握手）
            String helloPath = "/hello";
            if (!user.isEmpty()) {
                try {
                    helloPath = "/hello?user=" + java.net.URLEncoder.encode(user, "UTF-8");
                } catch (java.io.UnsupportedEncodingException ignored) {
                    helloPath = "/hello";
                }
            }
            JSONObject hello = request(helloPath, "GET", null, 8000);
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
                        // 热词观测（docs/15 §17）：本句"提到了表内名字、但译文没写出规范写法"的条目。
                        // 电脑侧只给中文名（zh），提示文案由手机拼 —— 这样文案改起来不用改电脑。
                        JSONArray miss = frame.optJSONArray("termsMiss");
                        String[] missing = new String[miss == null ? 0 : miss.length()];
                        for (int i = 0; i < missing.length; i++) {
                            JSONObject item = miss.optJSONObject(i);
                            missing[i] = item == null ? "" : item.optString("zh", "");
                        }
                        listener.onFrame(
                                frame.optString("speaker", "them"),
                                frame.optString("lang", "?"),
                                out,
                                frame.optString("text", ""),
                                frame.optString("source", ""),
                                frame.optString("sourceLang", "unknown"),
                                frame.optBoolean("partial", false),
                                missing);
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
            // 有 token 就带上：服务端据此确定"我是谁"（热词表只认它）
            if (!token.isEmpty()) connection.setRequestProperty("X-Leion-Token", token);
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
