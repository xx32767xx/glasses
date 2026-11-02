package com.leion.lanrelay;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * AsrRouteLoader —— 把 `assets/asr-routes.json` 读成 {@link AsrRouteTable} 判定用的结构（5.39）。
 * ============================================================================
 * 只干一件事：**JSON → 两层 Map**。判定逻辑全在 {@link AsrRouteTable}（纯 Java，可测），
 * 这样"表长什么样"和"表怎么判"分开，改表不用改代码，改判定不用碰 JSON。
 *
 * <p>读失败（文件缺了、JSON 坏了、字段类型不对）时**不抛异常、也不假装成功**：
 * 返回一张空表 + 一句人话原因。空表会让 {@link AsrRouteTable} 判出"没有 default"——
 * 而页面上会把这句话显示出来，用户和我都能立刻看出"表坏了"，而不是"奇怪，怎么没识别"。
 */
public final class AsrRouteLoader {

    private static final String TAG = "LeionInterp";
    public static final String ASSET = "asr-routes.json";

    /** 读出来的表：判定要用的三块 + 一句"读的时候有什么问题"（空 = 没问题）。 */
    public static final class Table {
        public final Map<String, String> defaults;
        public final Map<String, Map<String, String>> languages;
        public final Map<String, Map<String, String>> backends;
        /** 非空 = 表没读好（给用户看的人话）。 */
        public final String problem;

        Table(Map<String, String> defaults, Map<String, Map<String, String>> languages,
              Map<String, Map<String, String>> backends, String problem) {
            this.defaults = defaults;
            this.languages = languages;
            this.backends = backends;
            this.problem = problem;
        }

        public static Table broken(String problem) {
            return new Table(new LinkedHashMap<String, String>(),
                    new LinkedHashMap<String, Map<String, String>>(),
                    new LinkedHashMap<String, Map<String, String>>(),
                    problem == null ? "" : problem);
        }
    }

    private AsrRouteLoader() {
    }

    /** 从 assets 读表。任何失败都变成 `problem`，绝不抛异常打断页面。 */
    public static Table load(Context context) {
        String raw = readAsset(context);
        if (raw == null) {
            return Table.broken("读不到 " + ASSET + "（安装包里少了这张表？）");
        }
        return parse(raw);
    }

    /** 解析 JSON 文本（单独抽出来，便于日后加"从服务器下发表"这类覆盖来源）。 */
    public static Table parse(String raw) {
        Map<String, String> defaults = new LinkedHashMap<>();
        Map<String, Map<String, String>> languages = new LinkedHashMap<>();
        Map<String, Map<String, String>> backends = new LinkedHashMap<>();
        try {
            JSONObject root = new JSONObject(raw);
            defaults.putAll(flat(root.optJSONObject("default")));
            JSONObject langs = root.optJSONObject("languages");
            if (langs != null) {
                for (String key : keysOf(langs)) {
                    String normalized = InterpreterLang.normalize(key);
                    // 语言写法必须是我们认识的那三种；`zh` / `zh_CN` 归一到 `zh-CN`，
                    // 归一后仍认不出（`ja-JP`）就**留着**，让判定层报"这门外语没有后端"
                    languages.put(normalized.isEmpty() ? key : normalized, flat(langs.optJSONObject(key)));
                }
            }
            JSONObject impls = root.optJSONObject("backends");
            if (impls != null) {
                for (String key : keysOf(impls)) {
                    backends.put(key, flat(impls.optJSONObject(key)));
                }
            }
            Log.i(TAG, "🧾 路由表：" + AsrRouteTable.describe(defaults, languages, backends));
            return new Table(defaults, languages, backends, "");
        } catch (Exception error) {
            Log.w(TAG, "路由表解析失败：" + error);
            return Table.broken(ASSET + " 不是合法 JSON：" + error.getMessage());
        }
    }

    private static Map<String, String> flat(JSONObject object) {
        Map<String, String> out = new LinkedHashMap<>();
        if (object == null) return out;
        for (String key : keysOf(object)) {
            Object value = object.opt(key);
            if (value == null || value == JSONObject.NULL) continue;
            String text = String.valueOf(value);
            out.put(key, text);
        }
        return out;
    }

    private static List<String> keysOf(JSONObject object) {
        List<String> keys = new ArrayList<>();
        java.util.Iterator<String> it = object.keys();
        while (it.hasNext()) keys.add(it.next());
        return keys;
    }

    private static String readAsset(Context context) {
        try {
            AssetManager assets = context.getAssets();
            InputStream stream = assets.open(ASSET);
            try {
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[8192];
                int read;
                while ((read = stream.read(chunk)) > 0) buffer.write(chunk, 0, read);
                return buffer.toString("UTF-8");
            } finally {
                stream.close();
            }
        } catch (Exception error) {
            Log.w(TAG, "读 " + ASSET + " 失败：" + error);
            return null;
        }
    }
}
