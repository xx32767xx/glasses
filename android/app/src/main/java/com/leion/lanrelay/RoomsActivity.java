package com.leion.lanrelay;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * RoomsActivity — 房间大厅（P3.3）：建房（显示 6 位邀请码）/ 凭码加入。
 *
 * 稳定性取舍：先做成**独立入口**（临时加一个启动图标），不改 MainActivity。
 * 等 P3.5 把登录/设置页做完，再把它接成首页里的一个入口。
 */
public class RoomsActivity extends android.app.Activity {

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LanClient client;

    /** 会话监听（4.41）：在大厅等着的时候也要能发现被顶下线。 */
    private SessionWatch sessionWatch;

    /** 会话推送（4.45）：让"被顶下线"一秒内到达，而不是等 10 秒轮询。 */
    private SessionSocket sessionSocket;
    private String myName = "";

    private EditText nameInput;
    private EditText codeInput;
    private TextView codeBox;
    private TextView hint;
    private Button createButton;
    private Button joinButton;
    /** 我在会议里说什么语言（zh-CN / pt-BR） */
    private String speakLang = "zh-CN";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_rooms);

        nameInput = findViewById(R.id.roomsName);
        codeInput = findViewById(R.id.roomsCode);
        codeBox = findViewById(R.id.roomsCodeBox);
        hint = findViewById(R.id.roomsHint);
        createButton = findViewById(R.id.roomsCreate);
        joinButton = findViewById(R.id.roomsJoin);

        SharedPreferences prefs = getSharedPreferences("leion", MODE_PRIVATE);
        myName = prefs.getString("termsUser", "");
        if (myName == null || myName.isEmpty()) {
            hint.setText("还没登录：请先在主界面用账号登录（房间需要用户名）");
            createButton.setEnabled(false);
            joinButton.setEnabled(false);
            return;
        }
        hint.setText("当前账号：" + myName);

        client = new LanClient(prefs.getString("host", ""), prefs.getString("secret", ""), null);
        String token = prefs.getString("accountToken", "");
        if (token != null && !token.isEmpty()) client.setToken(token);

        // 在大厅等着的时候也要能发现"被别处登录顶下线"（4.41）
        sessionWatch = new SessionWatch(client, message -> ui.post(() -> {
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
            getSharedPreferences("leion", MODE_PRIVATE).edit()
                    .remove("accountToken").remove("termsUser").remove("roomHost").apply();
            client.setToken("");
            finish();
        }));
        sessionWatch.start();

        sessionSocket = new SessionSocket(
                prefs.getString("host", ""), prefs.getString("secret", ""), token,
                new SessionSocket.Listener() {
                    @Override
                    public void onKicked(String reason) {
                        ui.post(() -> {
                            Toast.makeText(RoomsActivity.this,
                                    "账号已在别处登录，这台设备的登录已失效", Toast.LENGTH_LONG).show();
                            getSharedPreferences("leion", MODE_PRIVATE).edit()
                                    .remove("accountToken").remove("termsUser").remove("roomHost").apply();
                            client.setToken("");
                            finish();
                        });
                    }

                    @Override
                    public void onOnlineChanged(boolean online) {
                        if (sessionWatch != null) {
                            sessionWatch.setIntervalMs(online
                                    ? SessionWatch.INTERVAL_SLOW_MS : SessionWatch.INTERVAL_MS);
                        }
                    }
                });
        sessionSocket.start();

        createButton.setOnClickListener(v -> createRoom());
        joinButton.setOnClickListener(v -> joinRoom());
        findViewById(R.id.roomsLangZh).setOnClickListener(v -> setSpeakLang("zh-CN"));
        findViewById(R.id.roomsLangPt).setOnClickListener(v -> setSpeakLang("pt-BR"));
        String savedLang = prefs.getString("speakLang", "zh-CN");
        setSpeakLang(savedLang == null || savedLang.isEmpty() ? "zh-CN" : savedLang);
    }

    @Override
    protected void onDestroy() {
        if (sessionWatch != null) {
            sessionWatch.stop();
            sessionWatch = null;
        }
        if (sessionSocket != null) {
            sessionSocket.stop();
            sessionSocket = null;
        }
        super.onDestroy();
    }

    /** 选择我在会里说的语言，并记住（下次默认用它）。 */
    private void setSpeakLang(String lang) {
        speakLang = lang;
        getSharedPreferences("leion", MODE_PRIVATE).edit().putString("speakLang", lang).apply();
        // ⚠️ 4.51：这一对在布局里是 **TextView**（4.47 的胶囊改的），原来按 Button 取会
        // 在 onCreate 里抛 ClassCastException —— 编译能过、一进大厅就崩。
        TextView zh = findViewById(R.id.roomsLangZh);
        TextView pt = findViewById(R.id.roomsLangPt);
        boolean isZh = "zh-CN".equals(lang);
        zh.setText(isZh ? "我说中文 ✓" : "我说中文");
        pt.setText(isZh ? "我说葡语" : "我说葡语 ✓");
        zh.setBackgroundResource(isZh ? R.drawable.bg_pill_active : R.drawable.bg_pill);
        pt.setBackgroundResource(isZh ? R.drawable.bg_pill : R.drawable.bg_pill_active);
        zh.setTextColor(getColor(isZh ? R.color.on_brand : R.color.ink));
        pt.setTextColor(getColor(isZh ? R.color.ink : R.color.on_brand));
    }

    private void createRoom() {
        final String name = nameInput.getText().toString().trim();
        if (name.isEmpty()) {
            Toast.makeText(this, "先填房间名", Toast.LENGTH_SHORT).show();
            return;
        }
        createButton.setEnabled(false);
        new Thread(() -> {
            JSONObject body = null;
            String error = "";
            try {
                body = client.orgCreateRoom(name, speakLang);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject result = body;
            final String failure = error;
            ui.post(() -> {
                createButton.setEnabled(true);
                if (result == null || !result.optBoolean("ok", false)) {
                    String reason = failure;
                    if (result != null) reason = result.optString("error", failure);
                    hint.setText("建房失败：" + reason);
                    return;
                }
                JSONObject room = result.optJSONObject("room");
                if (room == null) {
                    hint.setText("建房失败：返回里没有 room");
                    return;
                }
                String code = room.optString("code", "");
                String id = room.optString("id", "");
                codeBox.setText("邀请码 " + code + "（告诉对方这 6 位数字）");
                codeBox.setVisibility(View.VISIBLE);
                getSharedPreferences("leion", MODE_PRIVATE).edit()
                        .putString("roomHost", myName).apply();
                // 邀请码只在这几秒里"新鲜"：Toast 会盖在紧接着弹出的选库对话框**上面**，
                // 让用户不用先关掉对话框才看得到（用户 2026-10-27 报的"来不及看"）。
                Toast.makeText(this, "本场邀请码：" + code, Toast.LENGTH_LONG).show();
                chooseLibsAfterCreate(id, room.optString("name", name), code);
            });
        }, "rooms-create").start();
    }

    private void joinRoom() {
        final String code = codeInput.getText().toString().trim();
        if (code.isEmpty()) {
            Toast.makeText(this, "先填邀请码", Toast.LENGTH_SHORT).show();
            return;
        }
        joinButton.setEnabled(false);
        new Thread(() -> {
            JSONObject body = null;
            String error = "";
            try {
                body = client.orgJoinRoom(code, speakLang);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject result = body;
            final String failure = error;
            ui.post(() -> {
                joinButton.setEnabled(true);
                if (result == null || !result.optBoolean("ok", false)) {
                    String reason = failure;
                    if (result != null) reason = result.optString("error", failure);
                    hint.setText("加入失败：" + reason);
                    return;
                }
                JSONObject room = result.optJSONObject("room");
                if (room == null) {
                    hint.setText("加入失败：返回里没有 room");
                    return;
                }
                // 记录发起者是谁（RoomActivity 的锁定按钮要靠它判定权限）
                getSharedPreferences("leion", MODE_PRIVATE).edit()
                        .putString("roomHost", room.optString("host", "")).apply();
                enter(room.optString("id", ""), room.optString("name", ""));
            });
        }, "rooms-join").start();
    }

    /** 建房后立刻选本场术语库（按用户要求：选库放在创建会议这一步，而不是进房后再点按钮）。 */
    private void chooseLibsAfterCreate(final String roomId, final String roomName, final String code) {
        new Thread(new Runnable() {
            public void run() {
                JSONObject body = null;
                String error = "";
                try {
                    body = client.orgLibraries();
                } catch (Exception e) {
                    error = e.getMessage() == null ? e.toString() : e.getMessage();
                }
                final JSONObject result = body;
                final String failure = error;
                ui.post(new Runnable() {
                    public void run() {
                        if (result == null) {
                            hint.setText("读不到术语库（可先不选，进房后仍可补选）：" + failure);
                            enter(roomId, roomName);
                            return;
                        }
                        org.json.JSONArray list = result.optJSONArray("libraries");
                        if (list == null || list.length() == 0) {
                            hint.setText("服务端还没有术语库，本场先不用术语");
                            enter(roomId, roomName);
                            return;
                        }
                        showLibraryPicker(roomId, roomName, code, list);
                    }
                });
            }
        }, "rooms-libs").start();
    }

    /**
     * 选本场术语库。
     *
     * <p>标题与正文里都写上**邀请码**：这一步是建房后紧接着弹的对话框，会盖住页面上的
     * 邀请码显示 —— 用户还没来得及抄，就先看到选库框了（用户 2026-10-27 报的）。
     * 把码放进对话框里，两个需求就同时满足了：选库仍在建房这一步，邀请码也不会被错过。
     */
    private void showLibraryPicker(final String roomId, final String roomName,
                                   final String code, org.json.JSONArray libraries) {
        final java.util.List<String> ids = new java.util.ArrayList<>();
        final java.util.List<String> labels = new java.util.ArrayList<>();
        for (int i = 0; i < libraries.length(); i++) {
            JSONObject item = libraries.optJSONObject(i);
            if (item == null) {
                continue;
            }
            ids.add(item.optString("id", ""));
            org.json.JSONArray entries = item.optJSONArray("entries");
            int count = entries != null ? entries.length() : item.optInt("entries", 0);
            labels.add(item.optString("name", item.optString("id", "")) + "（" + count + " 条）");
        }
        final boolean[] checked = new boolean[labels.size()];
        String codeLine = (code == null || code.isEmpty()) ? "" : ("邀请码 " + code + " · ");
        // ⚠️ 这里**不能**再调 setMessage（4.44 修）：AlertDialog 同时给了 message 与
        // multiChoiceItems 时，AppCompat 会把列表挤掉 —— 表现就是"选库框弹出来了、但里面
        // 一个库都没有"。邀请码只在**标题**里写一次（标题不会被列表挤掉），
        // 另外建房那一刻还有一条长 Toast 报码。
        new android.app.AlertDialog.Builder(this)
                .setTitle(codeLine + "本场术语库（会中不可改）")
                .setMultiChoiceItems(labels.toArray(new String[0]), checked,
                        (dialog, which, isChecked) -> checked[which] = isChecked)
                .setNegativeButton("先不选，直接进房", (dialog, which) -> enter(roomId, roomName))
                .setPositiveButton("确定并进入", (dialog, which) -> saveLibsThenEnter(roomId, roomName, ids, checked))
                .show();
    }

    private void saveLibsThenEnter(final String roomId, final String roomName,
                                   final java.util.List<String> ids, final boolean[] checked) {
        final org.json.JSONArray selected = new org.json.JSONArray();
        for (int i = 0; i < checked.length && i < ids.size(); i++) {
            if (checked[i]) {
                selected.put(ids.get(i));
            }
        }
        new Thread(new Runnable() {
            public void run() {
                JSONObject body = null;
                String error = "";
                try {
                    body = client.orgSetRoomLibraries(roomId, selected);
                } catch (Exception e) {
                    error = e.getMessage() == null ? e.toString() : e.getMessage();
                }
                final JSONObject result = body;
                final String failure = error;
                ui.post(new Runnable() {
                    public void run() {
                        if (result != null && result.optBoolean("ok", false)) {
                            hint.setText("本场术语已冻结：" + result.optInt("entries", 0) + " 条");
                        } else {
                            hint.setText("术语库保存失败（可进房后补）："
                                    + (result == null ? failure : result.optString("error", failure)));
                        }
                        enter(roomId, roomName);
                    }
                });
            }
        }, "rooms-save-libs").start();
    }
    private void enter(String roomIdOrCode, String roomName) {
        if (roomIdOrCode == null || roomIdOrCode.isEmpty()) {
            hint.setText("房间标识为空，无法进入");
            return;
        }
        Intent intent = new Intent(this, RoomActivity.class);
        intent.putExtra(RoomActivity.EXTRA_ROOM, roomIdOrCode);
        intent.putExtra(RoomActivity.EXTRA_NAME, roomName);
        startActivity(intent);
    }
}