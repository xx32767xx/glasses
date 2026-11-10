package com.leion.lanrelay;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * ServerPreset —— 「装完即用」的服务器地址与共享密钥（4.49 起，5.155 收口）
 * ============================================================================
 *
 * <p>三个取值层次，**优先级从高到低**：
 * <ol>
 *   <li>用户在「我的 → 服务器」里存过的（{@code SharedPreferences} 的 {@code host} / {@code secret}）——
 *       现场要换服务器时改这里，重装都不用；</li>
 *   <li>**打包进 APK 的出厂值**（{@code res/values/app_config.xml} 的
 *       {@code default_server_url} / {@code default_shared_secret}）；</li>
 *   <li>都没有 → 空串（界面提示用户自己填）。</li>
 * </ol>
 *
 * <p>为什么要有第 2 层：老师要求「打包时把服务器地址和密钥一起打进去，装完就能用」。
 * 这个文件是那件事的**唯一入口** —— 写值用 {@code node scripts/build-preset.mjs}，
 * 不要在代码里散着写死地址（散着写就必然出现"某页用了新地址、某页还在旧地址"）。
 *
 * <p>⚠️ 关于安全：密钥进 APK 就等于公开（反编译几分钟就能看到）。这是我们**知情的取舍**
 * （内部使用）。真要对外发，就别打包密钥，改成每台设备一枚凭据 —— 那时动的是这一层，
 * 而不是每个页面。
 *
 * <p>⚠️ 而 **账号 token 永远不打包**：那是身份，泄漏等于别人能用你的账号。
 */
public final class ServerPreset {

    private ServerPreset() {
    }

    /** 出厂服务器地址（APK 里打包的值；没打包就是空串）。 */
    public static String packagedHost(Context context) {
        if (context == null) return "";
        return safe(context.getString(R.string.default_server_url));
    }

    /** 出厂共享密钥（APK 里打包的值；没打包就是空串）。 */
    public static String packagedSecret(Context context) {
        if (context == null) return "";
        return safe(context.getString(R.string.default_shared_secret));
    }

    /** 这个包里到底有没有内置服务器（地址与密钥都得有，缺一个就不算"装完即用"）。 */
    public static boolean packaged(Context context) {
        return !packagedHost(context).isEmpty() && !packagedSecret(context).isEmpty();
    }

    /** 实际要用的地址：用户存过的优先，其次出厂值。 */
    public static String host(Context context) {
        String stored = stored(context, "host");
        return stored.isEmpty() ? packagedHost(context) : stored;
    }

    /** 实际要用的密钥：用户存过的优先，其次出厂值。 */
    public static String secret(Context context) {
        String stored = stored(context, "secret");
        return stored.isEmpty() ? packagedSecret(context) : stored;
    }

    /**
     * 把出厂值**落进偏好**（只在对应项为空时写）。
     *
     * <p>为什么要落：房间页、历史页、翻译官页都是从偏好里直接读 {@code host}/{@code secret} 的
     * （它们不该各自再学一遍"出厂值"这套规则）。启动时落一次，后面所有页面就都一样了；
     * 而"只在空时写"保证了用户自己改过的值不会被启动覆盖。
     *
     * @return 是否真的写了（诊断用）
     */
    public static boolean seedInto(Context context) {
        if (context == null) return false;
        String host = packagedHost(context);
        String secret = packagedSecret(context);
        if (host.isEmpty() && secret.isEmpty()) return false;
        SharedPreferences prefs = context.getSharedPreferences("leion", Context.MODE_PRIVATE);
        String storedHost = safe(prefs.getString("host", ""));
        String storedSecret = safe(prefs.getString("secret", ""));
        boolean writeHost = host.isEmpty() == false && storedHost.isEmpty();
        boolean writeSecret = secret.isEmpty() == false && storedSecret.isEmpty();
        if (!writeHost && !writeSecret) return false;
        SharedPreferences.Editor editor = prefs.edit();
        if (writeHost) editor.putString("host", host);
        if (writeSecret) editor.putString("secret", secret);
        editor.apply();
        return true;
    }

    private static String stored(Context context, String key) {
        if (context == null) return "";
        try {
            SharedPreferences prefs = context.getSharedPreferences("leion", Context.MODE_PRIVATE);
            return safe(prefs.getString(key, ""));
        } catch (Exception error) {
            return "";
        }
    }

    /** getString 在资源是空串时返回空串，但在极老的设备上可能给 null —— 统一成空串。 */
    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }
}
