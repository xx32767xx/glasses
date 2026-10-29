package com.leion.lanrelay;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 历史记录的「本机删除」（4.71）。
 *
 * <p><b>它删的是什么</b>：只把这条记录从**这台设备**的历史列表里去掉。
 * 服务端的会议与字幕一律不动 —— 所以别人打开这条会议仍然看得见，
 * 换一台设备登录同一个账号也仍然看得见。这是用户要的语义（"本机删除"）。
 *
 * <p><b>为什么不做到服务端</b>：会议记录是**共享事实**（别人也在里面开过会），
 * 一个人删了，别人的历史就凭空少一场 —— 那是数据损坏，不是删除。真要"谁都别看"，
 * 应该走服务端的会议归档/清理策略，属于另一件事（而且需要权限）。
 *
 * <p><b>按账号隔离</b>：键是 {@code historyHidden:<用户名>}。同一台手机换账号登录时，
 * 不能把上一个人的隐藏记录带过去 —— 那会让人以为"我的会不见了"。
 *
 * <p><b>存储形态</b>：JSON 数组 {@code [{"id":"room-…","at":169…}]}，最多留
 * {@link #MAX_ENTRIES} 条（按时间保留最近的）。超出就丢最老的：这个表只是"眼不见"，
 * 丢一条最老的隐藏记录不会造成任何数据损失。
 */
public final class HistoryStore {

    private static final String PREFS = "leion";
    private static final String KEY_PREFIX = "historyHidden:";
    /** 上限：一台设备藏过 500 场会已经够用了；再多也只是省点流水账。 */
    static final int MAX_ENTRIES = 500;

    private HistoryStore() {
    }

    private static String key(String user) {
        String name = user == null ? "" : user.trim();
        return KEY_PREFIX + (name.isEmpty() ? "(anonymous)" : name);
    }

    /** 这台设备上，该账号隐藏掉的会议 id（按隐藏时间从新到旧）。 */
    public static Set<String> hiddenIds(Context ctx, String user) {
        Set<String> ids = new LinkedHashSet<>();
        for (String id : read(ctx, user)) ids.add(id);
        return ids;
    }

    /** 隐藏一条（幂等：重复隐藏不会写出两条）。 */
    public static void hide(Context ctx, String user, String roomId, long nowMs) {
        if (roomId == null || roomId.isEmpty()) return;
        List<Entry> entries = readEntries(ctx, user);
        entries.removeIf((one) -> one.id.equals(roomId));
        entries.add(0, new Entry(roomId, nowMs));      // 新的放最前
        if (entries.size() > MAX_ENTRIES) {
            entries = new ArrayList<>(entries.subList(0, MAX_ENTRIES));
        }
        write(ctx, user, entries);
    }

    /** 撤销隐藏（万一用户删错了：详情页或调试用）。 */
    public static void restore(Context ctx, String user, String roomId) {
        List<Entry> entries = readEntries(ctx, user);
        entries.removeIf((one) -> one.id.equals(roomId));
        write(ctx, user, entries);
    }

    /** 清空该账号在本机的隐藏列表（退出登录时不该清 —— 那是账号的偏好，不是会话状态）。 */
    public static void clearAll(Context ctx, String user) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(key(user)).apply();
    }

    // ── 内部：读写 ──────────────────────────────────────────────────────
    private static List<String> read(Context ctx, String user) {
        List<String> ids = new ArrayList<>();
        for (Entry entry : readEntries(ctx, user)) ids.add(entry.id);
        return ids;
    }

    private static List<Entry> readEntries(Context ctx, String user) {
        List<Entry> entries = new ArrayList<>();
        String raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key(user), "");
        if (raw == null || raw.isEmpty()) return entries;
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                JSONObject one = array.optJSONObject(i);
                if (one == null) continue;
                String id = one.optString("id", "");
                if (id.isEmpty()) continue;
                entries.add(new Entry(id, one.optLong("at", 0L)));
            }
        } catch (Exception ignored) {
            // 存坏了就当没藏过（宁可多显示一条，也不要让历史页整页报错）
        }
        return entries;
    }

    private static void write(Context ctx, String user, List<Entry> entries) {
        JSONArray array = new JSONArray();
        try {
            for (Entry entry : entries) {
                JSONObject one = new JSONObject();
                one.put("id", entry.id);
                one.put("at", entry.at);
                array.put(one);
            }
        } catch (Exception ignored) {
            return;                                   // 写不进去就保持原样，别把旧数据冲掉
        }
        SharedPreferences.Editor editor = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (array.length() == 0) editor.remove(key(user));
        else editor.putString(key(user), array.toString());
        editor.apply();
    }

    private static final class Entry {
        final String id;
        final long at;

        Entry(String id, long at) {
            this.id = id;
            this.at = at;
        }
    }
}
