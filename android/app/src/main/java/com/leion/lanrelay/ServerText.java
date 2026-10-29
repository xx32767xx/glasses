package com.leion.lanrelay;

import android.content.Context;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 服务端返回的 error / hint 是**服务端语言**（中文），不能直接甩给葡语或英语用户（4.58）。
 *
 * <p>为什么放在客户端而不是改成服务端返回错误码：服务端已经在正式服上跑，改协议要先发版、
 * 再让运维重启 relay，中间那段时间界面还是中文；而这份映射表**对老服务端也生效**。
 * 服务端后来返回了机器码（{@code auth-required} / {@code removed-by-host} 这类）时同样认。
 *
 * <p>三层查表，先精确、后前缀、最后机器码：
 * <ol>
 *   <li>{@link #EXACT}：服务端原话 → 文案键（一次对一整句）；</li>
 *   <li>{@link #PREFIX}：带变量的句子（「张三 不在这个房间里」）→ 文案键，变量丢掉 ——
 *       客户端自己的外框已经说清了上下文，再嵌一个人名只会更难读；</li>
 *   <li>{@link #CODES}：WS 推送与部分接口用的机器码（{@code host-left} 等）→ 文案键。</li>
 * </ol>
 *
 * <p>都查不到时的规矩（很重要，不然等于白做）：
 * <ul>
 *   <li>界面是中文 → 原样显示（对中文用户，服务端原话比"未知错误"有用）；</li>
 *   <li>界面是英文 / 巴葡 → **不许出现中文**，给一句本语言的通用说明，原文写 logcat；</li>
 *   <li>技术英文（{@code Connection refused} / {@code timeout}）→ 原样保留，那种不该翻译。</li>
 * </ul>
 *
 * <p>⚠️ 维护：服务端新增错误文案后要在这里加一条，否则非中文用户看到的是一句通用说明。
 * {@code tests/android-order-suite.mjs} 有一轮断言把服务端源码里的中文错误串与这张表做差集，
 * 漏加会直接红。
 */
public final class ServerText {

    /** 服务端原话（整句）→ 文案键。 */
    private static final Map<String, Integer> EXACT = new LinkedHashMap<>();
    /** 带变量的句子按前缀认（变量部分直接丢弃）。 */
    private static final Map<String, Integer> PREFIX = new LinkedHashMap<>();
    /** 变量在**前面**的句子（「张三 不在这个房间里」）→ 文案键。 */
    private static final Map<String, Integer> SUFFIX = new LinkedHashMap<>();
    /** 机器码（WS 推送的 reason、接口的 error 字段）→ 文案键。 */
    private static final Map<String, Integer> CODES = new LinkedHashMap<>();

    private static final Pattern CJK = Pattern.compile("[\\u4e00-\\u9fff]");

    static {
        // ── 账号与登录 ────────────────────────────────────────────────
        CODES.put("auth-required", R.string.srv_auth_required);
        CODES.put("auth-failed", R.string.srv_auth_failed);
        CODES.put("bad-user", R.string.srv_bad_user);
        CODES.put("bad-email", R.string.srv_bad_email);
        CODES.put("register-failed", R.string.srv_register_failed);
        CODES.put("bad-settings", R.string.srv_bad_settings);
        CODES.put("unauthorized", R.string.srv_unauthorized);
        CODES.put("too-many-requests", R.string.srv_too_many);
        CODES.put("too-much-audio", R.string.srv_audio_too_big);
        CODES.put("audio-storage-full", R.string.srv_audio_full);
        CODES.put("invalid-entries", R.string.srv_invalid_entries);
        CODES.put("bad-url", R.string.srv_bad_request);
        CODES.put("not-found", R.string.srv_no_route);
        // WS 推送的三类 reason（4.55 起是机器码，界面上不该出现 host-left 这种字面）
        CODES.put("removed-by-host", R.string.st_removed);
        CODES.put("host-left", R.string.st_host_closed);
        CODES.put("closed", R.string.st_meeting_closed);
        CODES.put("elsewhere-login", R.string.st_kicked_other);

        put("用户名或密码不对", R.string.srv_auth_failed);
        put("验证码不对或已过期", R.string.srv_code_wrong);
        put("验证码已打印在电脑端的 relay 控制台", R.string.srv_code_on_console);
        put("这个用户名已经被注册了（换一个，或者用登录）", R.string.srv_user_taken);
        put("这个用户名已经存在了", R.string.srv_user_taken);
        put("用户名不能为空", R.string.srv_user_empty);
        put("这个账号已经过期（测试账号有有效期），请让管理员续期", R.string.srv_account_expired);
        put("这个测试账号已过期（请联系管理员续期）", R.string.srv_account_expired);
        put("这个账号已被停用，请联系管理员", R.string.srv_account_disabled);
        put("这个账户已停用", R.string.srv_account_disabled);
        put("这个 token 不存在或已注销", R.string.srv_token_invalid);
        put("token 无效或已注销", R.string.srv_token_invalid);
        put("需要登录（缺少有效 token）", R.string.srv_auth_required);
        put("这台电脑上已经有账户了，先登录拿 token（请求头 X-Leion-Token）", R.string.srv_computer_has_account);
        put("请求头要带 X-Leion-Secret", R.string.srv_need_secret);
        put("邮箱不能为空", R.string.srv_email_empty);
        put("邮箱太长", R.string.srv_email_too_long);
        put("邮箱格式不对（需要形如 name@example.com）", R.string.srv_email_format);
        put("这个邮箱已经建过账户了", R.string.srv_email_taken);
        put("这个邮箱已经绑过账号了", R.string.srv_email_taken);
        put("需要 { \"proofread\": true/false }", R.string.srv_need_proofread_body);
        put("请求体过大", R.string.srv_bad_request);
        put("请求体不是合法 JSON", R.string.srv_bad_request);

        // ── 房间与发言权 ──────────────────────────────────────────────
        put("房间名不能为空", R.string.srv_room_name_empty);
        put("邀请码分配失败（连续冲突）", R.string.srv_code_alloc_failed);
        put("邀请码无效，或这场会已经结束", R.string.srv_code_invalid);
        put("缺少用户名", R.string.srv_missing_username);
        put("缺少 roomId 或 username", R.string.srv_missing_ids);
        put("房间不存在", R.string.srv_room_missing);
        put("只有发起者可以移出成员", R.string.srv_host_only_remove);
        put("发起者不能移出自己（要结束会议请用退出）", R.string.srv_cannot_remove_self);
        put("不是你在发言", R.string.srv_not_your_floor);
        put("当前没人发言，无法锁定", R.string.srv_nobody_speaking);
        put("不是持麦者", R.string.srv_not_holder);
        put("只有发起者可以强制收回发言权", R.string.srv_host_only_force);
        put("这个会议已经结束", R.string.st_meeting_closed);
        put("会议已结束（发起者已退出）", R.string.st_host_closed);
        put("会议已结束", R.string.st_meeting_closed);
        put("只支持 POST", R.string.srv_bad_request);

        // ── 术语库申请（4.64 起也纳入门禁：之前这几句没人译，非中文界面只能回一句通用话）──
        put("必须写申请理由（审批要看得懂为什么改）", R.string.srv_req_need_reason);
        put("这个中文名在库里已经有了（应走「修改」申请）", R.string.srv_req_add_exists);
        put("要修改的条目在库里不存在（应走「新增」申请）", R.string.srv_req_update_missing);
        put("删除申请必须给出要删的条目（中文名）", R.string.srv_req_need_target);
        put("要删除的条目在库里不存在", R.string.srv_req_delete_missing);
        put("库里已经有这个中文名了（申请过期，请让用户重新提交）", R.string.srv_req_stale_add);
        put("只能撤回自己的申请", R.string.srv_only_own_request);
        put("只能删除自己的申请", R.string.srv_only_own_request);
        put("待审批的申请请先撤回（不能被删除）", R.string.srv_pending_withdraw_first);
        prefix("申请类型只能是", R.string.srv_req_type_invalid);
        prefix("理由最多", R.string.srv_req_reason_long);
        prefix("库不存在：", R.string.srv_no_library);
        prefix("条目不合法：", R.string.srv_entry_invalid);
        prefix("待审申请太多", R.string.srv_req_too_many);
        prefix("已经有一条同样的待审申请", R.string.srv_req_duplicate);
        prefix("没有这条申请", R.string.srv_request_missing);
        prefix("这条申请已经是", R.string.srv_request_already_decided);
        prefix("要修改的条目已不在库里", R.string.srv_req_stale_update);
        prefix("要删除的条目已不在库里", R.string.srv_req_stale_delete);
        prefix("写库失败：", R.string.srv_write_failed);
        // 4.68：服务端库结构跟不上代码（例：刚加的 hidden_at 列还没补）。
        // SQLite 报的是 no such column: xxx，直接翻过去对用户没意义，说清“重启 relay”才有用。
        prefix("no such column", R.string.srv_db_outdated);
        prefix("has no column named", R.string.srv_db_outdated);

        // ── 术语库 ────────────────────────────────────────────────────
        put("还没有任何一场会议术语（手机开始同传后会自动生成）", R.string.srv_no_terms);
        put("没有这个库", R.string.srv_no_library);
        put("整张表没有保存（一条不合法就整表不落盘），按 rejected 里的 index 改完再传", R.string.srv_terms_rejected);

        // ── 带变量的句子：变量丢掉 ────────────────────────────────────
        suffix(" 不在这个房间里", R.string.srv_not_in_room);
        suffix(" 正在发言（发言已锁定）", R.string.srv_busy_locked);
        suffix(" 正在发言，只有发起者可以解除他人的锁定", R.string.srv_busy_host_only);
        prefix("当前角色（", R.string.srv_role_cannot);
        prefix("有库不存在：", R.string.srv_libs_missing);
        prefix("没有这个接口：", R.string.srv_no_route);
        prefix("HTTP ", R.string.srv_no_reason);
        prefix("每个 IP 每分钟最多", R.string.srv_too_many);
        prefix("音频块过大", R.string.srv_audio_too_big);
        prefix("音频文件已达上限", R.string.srv_audio_full);
        prefix("这个邮箱已经绑过账号了（用户名：", R.string.srv_email_taken);
        prefix("用户名只能包含", R.string.srv_user_charset);
        prefix("用户名最多", R.string.srv_user_too_long);
        prefix("密码至少", R.string.srv_pass_short);
        prefix("密码最多", R.string.srv_pass_long);
        prefix("room not found", R.string.srv_room_missing);
    }

    private ServerText() {
    }

    private static void put(String raw, int resId) {
        EXACT.put(raw, resId);
    }

    private static void prefix(String head, int resId) {
        PREFIX.put(head, resId);
    }

    private static void suffix(String tail, int resId) {
        SUFFIX.put(tail, resId);
    }

    /**
     * 把一条服务端文本翻成当前界面语言。
     *
     * @param raw 服务端的 {@code error} / {@code hint} / WS 的 {@code reason}；可为空
     * @return 可以直接显示的文本（永不返回 null）
     */
    public static String of(Context ctx, String raw) {
        if (raw == null) return "";
        String text = raw.trim();
        if (text.isEmpty()) return "";

        // 「当前角色（dev）不能做 request.create」这种句子，光回一句"没有权限"没法排查。
        // 把角色与动作抠出来，用户才知道是自己账号的问题还是功能的问题（4.63 用户实测踩到）。
        String forbidden = forbiddenDetail(ctx, text);
        if (forbidden != null) return forbidden;

        Integer id = lookup(text);
        if (id != null) return ctx.getString(id);

        if (CJK.matcher(text).find()) {
            // 没收录的服务端原话：中文界面照原样给（比"未知错误"有用）；
            // 其它语言绝不把中文甩给用户，给一句本语言的通用说明，原文留给 logcat / 调试行。
            if (UiLang.ZH.equals(UiLang.effective(ctx))) return text;
            android.util.Log.w("LeionServerText", "unmapped server text: " + text);
            return ctx.getString(R.string.srv_unknown);
        }
        return text;      // Connection refused / timeout 这类技术英文不翻译
    }

    /**
     * 从一个 JSON 响应里取最合适的那句：{@code hint} 比 {@code error} 具体，优先用它。
     *
     * @param body     服务端响应；可以为 null
     * @param fallback 连 error/hint 都没有时用什么（通常是本地异常文本，可为空）
     */
    public static String from(Context ctx, org.json.JSONObject body, String fallback) {
        if (body != null) {
            // 权限拒绝（4.63）：服务端给了 code/role/action，直接拼一句说清"谁不能做什么"
            if ("forbidden".equals(body.optString("code", ""))) {
                return ctx.getString(R.string.srv_role_cannot_role,
                        body.optString("role", ""), body.optString("action", ""));
            }
            String hint = body.optString("hint", "").trim();
            if (!hint.isEmpty()) return of(ctx, hint);
            String error = body.optString("error", "").trim();
            if (!error.isEmpty()) return of(ctx, error);
        }
        return of(ctx, fallback);
    }

    /**
     * 解析服务端的 403 原话：{@code 当前角色（dev）不能做 request.create}。
     *
     * <p>新服务端会直接给 {@code code:'forbidden'} + {@code role}/{@code action}（见
     * {@link #from});这里兼容**老服务端**只有一句中文的情况 —— 反正格式是固定的。
     */
    private static String forbiddenDetail(Context ctx, String text) {
        if (!text.startsWith("当前角色（")) return null;
        int close = text.indexOf('）');
        if (close < 0) return null;
        String role = text.substring("当前角色（".length(), close);
        String rest = text.substring(close + 1);
        String action = rest.startsWith("不能做") ? rest.substring("不能做".length()).trim() : rest.trim();
        return ctx.getString(R.string.srv_role_cannot_role, role, action);
    }

    private static Integer lookup(String text) {
        Integer id = EXACT.get(text);
        if (id != null) return id;
        id = CODES.get(text);
        if (id != null) return id;
        for (Map.Entry<String, Integer> entry : PREFIX.entrySet()) {
            if (text.startsWith(entry.getKey())) return entry.getValue();
        }
        for (Map.Entry<String, Integer> entry : SUFFIX.entrySet()) {
            if (text.endsWith(entry.getKey())) return entry.getValue();
        }
        return null;
    }
}
