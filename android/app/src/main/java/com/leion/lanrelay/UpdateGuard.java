package com.leion.lanrelay;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageInfo;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * UpdateGuard —— **强制更新门禁**（5.26，用户要求）。
 * ============================================================================
 * 规则（用户 2026-11 定）：用户都用最新版 APP，版本不一致就是"不支持的状态"，
 * 所以发现不一致就**弹不可取消的对话框并要求更新客户端**，不让继续用。
 *
 * 三个设计决定，都是踩过坑的选择：
 *
 * ① **比 versionCode（数字），不比 versionName（字符串）。**
 *    `4.9` 与 `4.127` 按字符串比会得出"4.9 更大"；按整数比才是对的。
 *    versionCode 只保证"每次构建都比上一个大"，正好用来比大小。
 *
 * ② **客户端比服务端新时，不让用户去"更新客户端"。**
 *    那种情况是**服务器旧了**，让人重装 App 既没用又耽误事；
 *    对话框会明说"请联系管理员更新服务端"，但同样拦住使用（版本不一致就是不一致）。
 *
 * ③ **对话框不可取消、且只有一个按钮「我已更新，重试」。**
 *    按钮不是"我知道了"——那等于允许带着旧版本继续用。点了就重新问服务端：
 *    装好了就放行，没装就继续拦着。离线/连不上服务端时**不拦**
 *    （那时什么功能都用不了，弹一个"版本不对"的框只会误导）。
 */
public final class UpdateGuard {

    private static final String TAG = "LeionUpdate";

    /** 命中后的回调（当前为了日志与测试可读，界面自己不需要做事）。 */
    public interface OnBlocked {
        void onBlocked(String required, String mine);
    }

    private UpdateGuard() {
    }

    /** 本机 versionName（拿不到就返回空串，绝不抛给界面）。 */
    public static String versionName(Activity activity) {
        try {
            PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            return info.versionName == null ? "" : info.versionName;
        } catch (Exception error) {
            Log.w(TAG, "读 versionName 失败：" + error);
            return "";
        }
    }

    /** 本机 versionCode（拿不到返回 0）。 */
    @SuppressWarnings("deprecation")
    public static int versionCode(Activity activity) {
        try {
            PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            return info.versionCode;
        } catch (Exception error) {
            Log.w(TAG, "读 versionCode 失败：" + error);
            return 0;
        }
    }

    /**
     * 比一次版本：`required` 是服务端要的 versionCode。
     *
     * @return `ok` / `need-update`（客户端旧）/ `server-old`（服务端旧）/ `unknown`（缺数据，不拦）
     */
    public static String verdict(int mine, int required) {
        if (mine <= 0 || required <= 0) return "unknown";
        if (mine == required) return "ok";
        return mine < required ? "need-update" : "server-old";
    }

    /**
     * 拿 `/version` 的响应判一次；不一致就弹**不可取消**的对话框。
     *
     * @param response `/version` 的 JSON（可为 null = 没问到）
     * @param retry    点「我已更新，重试」时回调（由调用方重新发起检查）
     * @return true = 放行；false = 已经拦住了
     */
    public static boolean check(final Activity activity, final JSONObject response, final Runnable retry) {
        if (activity == null || activity.isFinishing()) return true;
        JSONObject app = response == null ? null : response.optJSONObject("appVersion");
        if (app == null) {
            // 老服务端没有这条接口：不拦（拿不到要求就不能冤枉用户）
            Log.i(TAG, "服务端没有 appVersion（旧版 relay），跳过版本门禁");
            return true;
        }
        final int required = app.optInt("code", 0);
        final String requiredName = app.optString("name", "");
        final int mine = versionCode(activity);
        final String mineName = versionName(activity);
        final String verdict = verdict(mine, required);
        if ("unknown".equals(verdict)) {
            Log.i(TAG, "版本信息不全（mine=" + mine + " required=" + required + "），跳过门禁");
            return true;
        }
        if ("ok".equals(verdict)) {
            Log.i(TAG, "客户端版本一致：" + mineName + "(" + mine + ")");
            return true;
        }
        Log.w(TAG, "版本不一致：" + mineName + "(" + mine + ") vs 要求 " + requiredName + "(" + required + ")");
        showBlockingDialog(activity, verdict, requiredName, required, mineName, retry);
        return false;
    }

    private static void showBlockingDialog(final Activity activity, String verdict,
                                          String requiredName, int required, String mineName,
                                          final Runnable retry) {
        String title = activity.getString(R.string.update_title);
        String body = "need-update".equals(verdict)
                ? activity.getString(R.string.update_body_need, mineName, requiredName)
                : activity.getString(R.string.update_body_server_old, requiredName, mineName);
        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle(title)
                .setMessage(body)
                // 不可取消：返回键与点外部都关不掉它 —— 这是"强制"的唯一实现方式
                .setCancelable(false)
                .setPositiveButton(R.string.update_retry, (d, which) -> {
                    Toast.makeText(activity, activity.getString(R.string.update_retrying),
                            Toast.LENGTH_SHORT).show();
                    if (retry != null) retry.run();
                })
                .create();
        dialog.setCanceledOnTouchOutside(false);
        dialog.show();
    }
}
