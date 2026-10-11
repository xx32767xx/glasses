package com.leion.lanrelay;

import android.util.Log;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;

/**
 * 连接自检：把"连不上"拆成几个能分别判定的问题。
 *
 * <p><b>为什么需要它</b>：原来连不上时界面只显示一句"连不上"，
 * 而这四个原因的症状完全一样、修法完全不同：
 *
 * <ol>
 *   <li>网络根本不通（网段隔离、VPN 没开、地址填错）→ 连接**超时**</li>
 *   <li>网络通了但电脑没跑转发进程 / 端口不对 → 连接**被拒绝**</li>
 *   <li>都通了但密钥不对 → HTTP **401**</li>
 *   <li>全对 → HTTP **200**</li>
 * </ol>
 *
 * 在校园网 / 热点 / Tailscale 之间来回换环境时，这四种情况会轮流出，
 * 靠"连不上"三个字是分不出来的 —— 每一次都要重新猜。
 *
 * <p>这个类只做**诊断**，不改任何连接状态，也不依赖 LanClient：
 * 它自己发一个独立的 HTTP 请求。所以「自检通过但实际连不上」本身也是信息
 * （说明问题在应用层，不在链路层）。
 */
public final class SelfCheck {

    private static final String TAG = "SelfCheck";

    /** Tailscale（以及所有 CGNAT）用的地址段 100.64.0.0/10。 */
    private static final int CGNAT_FIRST = 100;
    private static final int CGNAT_SECOND_MIN = 64;
    private static final int CGNAT_SECOND_MAX = 127;

    private SelfCheck() {
    }

    /** 一个地址的概览。 */
    private static final class Iface {
        final String name;
        final String display;
        final String ip;

        Iface(String name, String display, String ip) {
            this.name = name;
            this.display = display;
            this.ip = ip;
        }

        boolean isTailscale() {
            return inCgnat(ip);
        }
    }

    /**
     * 跑一遍自检。<b>会阻塞</b>（做网络请求），必须放在后台线程调用。
     *
     * @param host   用户填的地址（可带 http:// 前缀、可带端口）
     * @param secret 配对码
     * @return 多行文本，直接显示给用户
     */
    public static String run(String host, String secret) {
        StringBuilder out = new StringBuilder();
        out.append("═══ 手机的网络 ═══\n");
        List<Iface> ifaces = interfaces();
        if (ifaces.isEmpty()) {
            out.append("· 没有任何可用网络接口（WiFi 没连？）\n");
        }
        boolean tailscaleUp = false;
        for (Iface iface : ifaces) {
            if (iface.isTailscale()) tailscaleUp = true;
            out.append("· ").append(iface.name)
               .append("  ").append(iface.ip)
               .append(iface.isTailscale() ? "  ← Tailscale" : "")
               .append('\n');
        }
        out.append('\n');

        // ── 解析地址 ──────────────────────────────────────────────────────
        Target target = Target.parse(host);
        out.append("═══ 目标地址 ═══\n");
        if (target == null) {
            out.append("· 地址为空或格式不对，填不了\n");
            return out.toString();
        }
        out.append("· ").append(target.host).append(':').append(target.port)
           .append("（").append(target.scheme).append("）\n");

        out.append('\n');
        out.append("═══ 逐项检查 ═══\n");
        if (target.hostIsIp) {
            out.append("· 地址是 IP，" )       // 走 IP 就不需要 DNS
               .append(inCgnat(target.ip) ? "属于 Tailscale 段(100.64/10)\n" : "不是 Tailscale 段\n");
        } else {
            out.append("· 地址是主机名，需要 DNS 解析\n");
        }

        // Tailscale 一致性判断：这是换到 Tailscale 之后最常见的坑
        if (inCgnat(target.ip) && !tailscaleUp) {
            out.append("· ❌ 目标是 Tailscale 地址，但手机上**没有** 100.x 地址\n")
               .append("     → Tailscale 没开、没登录，或 VPN 权限被别的 App 占了\n");
        } else if (inCgnat(target.ip) && tailscaleUp) {
            out.append("· ✅ 目标和我们都在 Tailscale 网里\n");
        }

        // ── 解析出真正的 IP（主机名才会用到） ────────────────────────────
        String resolvedIp = target.ip;
        if (!target.hostIsIp) {
            long started = System.currentTimeMillis();
            try {
                InetAddress address = InetAddress.getByName(target.host);
                resolvedIp = address.getHostAddress();
                out.append("· ✅ DNS 解析 → ").append(resolvedIp)
                   .append("（").append(System.currentTimeMillis() - started).append(" ms）\n");
            } catch (Throwable error) {
                out.append("· ❌ DNS 解析失败：").append(error.getClass().getSimpleName())
                   .append(' ').append(String.valueOf(error.getMessage())).append('\n')
                   .append("     → 主机名写错了，或者当前网络没有 DNS\n");
                return out.toString();
            }
        }

        // ── TCP 连接 ─────────────────────────────────────────────────────
        long started = System.currentTimeMillis();
        boolean tcpOk = false;
        String tcpReason = "";
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(resolvedIp, target.port), 4000);
            tcpOk = true;
        } catch (java.net.SocketTimeoutException error) {
            tcpReason = "超时（4 秒没响应）";
        } catch (java.net.ConnectException error) {
            tcpReason = "被拒绝：" + error.getMessage();
        } catch (Throwable error) {
            tcpReason = error.getClass().getSimpleName() + "：" + error.getMessage();
        }
        long tcpMs = System.currentTimeMillis() - started;

        out.append("· TCP ").append(resolvedIp).append(':').append(target.port).append(" → ");
        if (tcpOk) {
            out.append("✅ 通（").append(tcpMs).append(" ms）\n");
        } else {
            out.append("❌ ").append(tcpReason).append("（").append(tcpMs).append(" ms）\n");
            if (tcpReason.startsWith("超时")) {
                out.append("     → **包没到电脑**。可能：两机不在互通网络里（校园网客户端隔离）、\n")
                   .append("       Tailscale 没开、地址填错、或电脑防火墙挡了入站\n");
            } else if (tcpReason.startsWith("被拒绝")) {
                out.append("     → **到了电脑但没人听这个端口**：转发进程没启动，或端口不是 ")
                   .append(target.port).append('\n');
            }
            return out.toString();
        }

        // ── HTTP /status ────────────────────────────────────────────────
        // 用一个**不需要额外状态**的只读接口，既能验证链路也能验证密钥。
        String url = target.scheme + "://" + resolvedIp + ":" + target.port
                + "/status?secret=" + java.net.URLEncoder.encode(secret == null ? "" : secret);
        started = System.currentTimeMillis();
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(4000);
            connection.setReadTimeout(4000);
            connection.setRequestMethod("GET");
            int code = connection.getResponseCode();
            long ms = System.currentTimeMillis() - started;
            out.append("· HTTP /status → ").append(code).append("（").append(ms).append(" ms）\n");
            if (code == 200) {
                out.append("     ✅ **链路和密钥都对** —— 手机会话应该能连上\n");
                String body = read(connection.getInputStream());
                out.append("     电脑那边：").append(summarize(body)).append('\n');
            } else if (code == 401) {
                out.append("     ⚠ 链路是通的（包到了电脑），但**配对码不对**\n")
                   .append("     → 去电脑上跑 npm run start，它会在启动时打印配对码\n");
            } else {
                out.append("     ⚠ 链路通，但服务返回了 ").append(code).append("，看电脑端日志\n");
            }
        } catch (Throwable error) {
            out.append("· HTTP /status → ❌ ").append(error.getClass().getSimpleName())
               .append('：').append(String.valueOf(error.getMessage())).append('\n');
        }
        return out.toString();
    }

    /** 从 /status 的 JSON 里挑几个最能让用户确认"电脑看见我了没有"的字段。 */
    private static String summarize(String body) {
        if (body == null) return "（没有响应体）";
        StringBuilder out = new StringBuilder();
        for (String key : new String[] { "connections", "sockets", "frames", "inboxLines" }) {
            String value = jsonValue(body, key);
            if (value != null) {
                if (out.length() > 0) out.append(" · ");
                out.append(key).append('=').append(value);
            }
        }
        return out.length() == 0 ? "（解析不出字段）" : out.toString();
    }

    /** 极简 JSON 取值 —— 只为显示几个数字，不引 JSON 库（见 app/build.gradle.kts 的依赖约束）。 */
    private static String jsonValue(String body, String key) {
        int at = body.indexOf('"' + key + '"');
        if (at < 0) return null;
        int colon = body.indexOf(':', at);
        if (colon < 0) return null;
        int start = colon + 1;
        while (start < body.length() && Character.isWhitespace(body.charAt(start))) start += 1;
        int end = start;
        while (end < body.length() && ",}\n".indexOf(body.charAt(end)) < 0) end += 1;
        return body.substring(start, end).trim();
    }

    private static String read(InputStream in) {
        if (in == null) return null;
        try (InputStream stream = in) {
            byte[] buffer = new byte[4096];
            int read = stream.read(buffer);
            return read <= 0 ? null : new String(buffer, 0, read, "UTF-8");
        } catch (Throwable error) {
            return null;
        }
    }

    /** 列出所有有 IPv4 的、非回环的接口。 */
    private static List<Iface> interfaces() {
        List<Iface> result = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> all = NetworkInterface.getNetworkInterfaces();
            if (all == null) return result;
            for (NetworkInterface ni : Collections.list(all)) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress address : Collections.list(ni.getInetAddresses())) {
                    if (!(address instanceof Inet4Address)) continue;
                    String ip = address.getHostAddress();
                    // 169.254.x.x 是"没拿到 DHCP"的自动地址，不算有用信息但值得显示
                    result.add(new Iface(ni.getName(), ni.getDisplayName(), ip));
                }
            }
        } catch (Throwable error) {
            Log.w(TAG, "枚举网络接口失败", error);
        }
        return result;
    }

    /** 100.64.0.0/10 —— Tailscale 与运营商级 NAT 共用的段。 */
    private static boolean inCgnat(String ip) {
        if (ip == null || ip.isEmpty()) return false;
        String[] parts = ip.split("\\.");
        if (parts.length != 4) return false;
        try {
            int first = Integer.parseInt(parts[0]);
            int second = Integer.parseInt(parts[1]);
            return first == CGNAT_FIRST && second >= CGNAT_SECOND_MIN && second <= CGNAT_SECOND_MAX;
        } catch (NumberFormatException error) {
            return false;
        }
    }

    /** 把用户填的一串东西拆成 scheme / host / port。 */
    private static final class Target {
        final String scheme;
        final String host;
        final int port;
        final String ip;
        final boolean hostIsIp;

        private Target(String scheme, String host, int port, String ip, boolean hostIsIp) {
            this.scheme = scheme;
            this.host = host;
            this.port = port;
            this.ip = ip;
            this.hostIsIp = hostIsIp;
        }

        static Target parse(String raw) {
            if (raw == null) return null;
            String text = raw.trim();
            if (text.isEmpty()) return null;
            String scheme = "http";
            if (text.startsWith("https://")) {
                scheme = "https";
                text = text.substring(8);
            } else if (text.startsWith("http://")) {
                text = text.substring(7);
            }
            // 去掉路径
            int slash = text.indexOf('/');
            if (slash >= 0) text = text.substring(0, slash);
            String host = text;
            int port = "https".equals(scheme) ? 443 : 8788;   // 缺省端口 = 转发进程的缺省
            int colon = text.lastIndexOf(':');
            if (colon > 0) {
                String portText = text.substring(colon + 1);
                try {
                    port = Integer.parseInt(portText);
                    host = text.substring(0, colon);
                } catch (NumberFormatException ignored) {
                    // 不是端口，当整体是主机名（IPv6 字面量也会走到这里，暂不支持）
                }
            }
            if (host.isEmpty() || port <= 0 || port > 65535) return null;
            boolean isIp = host.matches("\\d+\\.\\d+\\.\\d+\\.\\d+");
            return new Target(scheme, host, port, isIp ? host : null, isIp);
        }

        @Override
        public String toString() {
            return String.format(Locale.US, "%s://%s:%d", scheme, host, port);
        }
    }
}
