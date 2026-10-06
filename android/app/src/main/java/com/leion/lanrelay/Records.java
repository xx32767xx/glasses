package com.leion.lanrelay;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 会话记录（规范第 9 节）。
 *
 * 存储选型：一个 JSON 文件放在应用私有目录里。没上数据库，理由很直白 ——
 * 这个应用**零第三方依赖**，平台自带的 SQLite 能用但要多写一层；
 * 而这里的数据量是"每次同传一条、每条几百个片段"，一个文件完全够。
 * 真到几千条会话再换也不迟（结构已经是可迁移的）。
 *
 * 只存**文字**（原文、译文、会话信息）。是否保存原始音频是另一件事：
 * 规范明确要求两者不能混为一谈，而且当前根本没做音频留存，
 * 所以这里连字段都不放 —— 免得以后有人以为"保存了记录就等于有录音"。
 */
public class Records {

    /** 一条记录。 */
    public static class Session {
        public String id;
        public String title;
        public String direction = "";
        public String startedAt = "";
        public long durationMs;
        public boolean partial;                 // 部分结果未完成
        public final List<Line> lines = new ArrayList<>();

        public static class Line {
            public String time = "";
            public String source = "";
            public String target = "";
        }
    }

    private static final String FILE_NAME = "sessions.json";
    private static final int CAP = 200;          // 最多留 200 条，超了丢最旧的

    private final File file;

    public Records(Context context) {
        file = new File(context.getFilesDir(), FILE_NAME);
    }

    public List<Session> load() {
        List<Session> out = new ArrayList<>();
        if (!file.isFile()) return out;
        try {
            String text = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            JSONArray array = new JSONArray(text);
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.getJSONObject(i);
                Session session = new Session();
                session.id = item.optString("id", "");
                session.title = item.optString("title", "");
                session.direction = item.optString("direction", "");
                session.startedAt = item.optString("startedAt", "");
                session.durationMs = item.optLong("durationMs", 0);
                session.partial = item.optBoolean("partial", false);
                JSONArray lines = item.optJSONArray("lines");
                if (lines != null) {
                    for (int k = 0; k < lines.length(); k++) {
                        JSONObject line = lines.getJSONObject(k);
                        Session.Line entry = new Session.Line();
                        entry.time = line.optString("time", "");
                        entry.source = line.optString("source", "");
                        entry.target = line.optString("target", "");
                        session.lines.add(entry);
                    }
                }
                out.add(session);
            }
        } catch (Exception ignored) {
            // 文件坏了就当空的：一条坏记录不该让"记录"这一页打不开。
            // 不删文件 —— 万一用户想找回内容，留着还能手工修。
        }
        return out;
    }

    /** 新会话放在最前面（列表里最新一条在最上面）。 */
    public void save(Session session) {
        if (session.id == null || session.id.isEmpty()) {
            session.id = "s" + System.currentTimeMillis();
        }
        List<Session> all = load();
        for (int index = 0; index < all.size(); index++) {
            if (all.get(index).id.equals(session.id)) {
                all.remove(index);
                break;
            }
        }
        all.add(0, session);
        while (all.size() > CAP) all.remove(all.size() - 1);
        write(all);
    }

    public void remove(String id) {
        List<Session> all = load();
        for (int index = 0; index < all.size(); index++) {
            if (all.get(index).id.equals(id)) {
                all.remove(index);
                break;
            }
        }
        write(all);
    }

    public void rename(String id, String title) {
        List<Session> all = load();
        for (Session session : all) {
            if (session.id.equals(id)) {
                session.title = title;
                break;
            }
        }
        write(all);
    }

    private void write(List<Session> all) {
        try {
            JSONArray array = new JSONArray();
            for (Session session : all) {
                JSONObject item = new JSONObject();
                item.put("id", session.id);
                item.put("title", session.title);
                item.put("direction", session.direction);
                item.put("startedAt", session.startedAt);
                item.put("durationMs", session.durationMs);
                item.put("partial", session.partial);
                JSONArray lines = new JSONArray();
                for (Session.Line line : session.lines) {
                    JSONObject entry = new JSONObject();
                    entry.put("time", line.time);
                    entry.put("source", line.source);
                    entry.put("target", line.target);
                    lines.put(entry);
                }
                item.put("lines", lines);
                array.put(item);
            }
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(array.toString(2).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
            // 写失败不该让界面崩：记录丢了比应用崩掉好，而且下一句还会再试一次
        }
    }

    /** 按当前时间给个默认标题（规范：默认按日期和时间命名）。 */
    public static String defaultTitle(Date date) {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(date);
    }
}
