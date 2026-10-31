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

    /** 首页「创建 / 加入」两张卡带过来的意图：指向要聚焦的那一半（4.60）。 */
    public static final String EXTRA_FOCUS = "focus";

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
    /** 我在会议里说什么语言（zh-CN / pt-BR / en-US）：**这就是"我读得懂哪种语言"**，
     *  服务端按房间里所有人的这个值决定每句话译成几份、发给谁（docs/21 §5.01）。 */
    private String speakLang = "zh-CN";

    @Override
    protected void attachBaseContext(android.content.Context base) {
        // 4.56：界面语言必须在这里换（三套资源在 values-en / values-pt-rBR）
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        UiLang.trackShown(this);   // 别处改过界面语言，回到本页要跟上（会自己 recreate）
    }

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
            hint.setText(getString(R.string.st_rooms_need_login));
            createButton.setEnabled(false);
            joinButton.setEnabled(false);
            return;
        }
        hint.setText(getString(R.string.st_current_account, myName));

        // 4.60：首页的「创建同传会议 / 加入同传会议」是同一页的两个入口 ——
        // 进来之后直接把光标放到对应那半，省得用户再自己找。
        String focus = getIntent() == null ? null : getIntent().getStringExtra(EXTRA_FOCUS);
        if ("create".equals(focus)) {
            nameInput.requestFocus();
        } else if ("join".equals(focus)) {
            codeInput.requestFocus();
        }

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
                                    getString(R.string.st_kicked_other), Toast.LENGTH_LONG).show();
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
        // 5.00：中/英/葡任意两种互译 —— 英语也能当说话语言
        findViewById(R.id.roomsLangEn).setOnClickListener(v -> setSpeakLang("en-US"));
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
        stylePills(R.id.roomsLangZh, R.string.rooms_speak_zh, R.string.rooms_speak_zh_on, "zh-CN".equals(lang));
        stylePills(R.id.roomsLangPt, R.string.rooms_speak_pt, R.string.rooms_speak_pt_on, "pt-BR".equals(lang));
        stylePills(R.id.roomsLangEn, R.string.rooms_speak_en, R.string.rooms_speak_en_on, "en-US".equals(lang));
    }

    /** 一组胶囊的选中样式（三个语种共用，避免三份几乎一样的代码各改各的）。 */
    private void stylePills(int viewId, int offText, int onText, boolean on) {
        TextView pill = findViewById(viewId);
        if (pill == null) return;
        pill.setText(getString(on ? onText : offText));
        pill.setBackgroundResource(on ? R.drawable.bg_pill_active : R.drawable.bg_pill);
        pill.setTextColor(getColor(on ? R.color.on_brand : R.color.ink));
    }

    private void createRoom() {
        final String name = nameInput.getText().toString().trim();
        if (name.isEmpty()) {
            Toast.makeText(this, getString(R.string.toast_need_room_name), Toast.LENGTH_SHORT).show();
            return;
        }
        createButton.setEnabled(false);
        new Thread(() -> {
            JSONObject body = null;
            String error = "";
            try {
                // 5.03：**不传目标语言** —— 这一场译成什么，由每位成员入会时选的
                // 「我说中文/葡语/英语」决定（服务端按听众语言集合决定译几份、发给谁）。
                // 用户原话："我不是说了根据用户的选择自动翻译成对应结果吗"。
                body = client.orgCreateRoom(name, speakLang);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject result = body;
            final String failure = error;
            ui.post(() -> {
                createButton.setEnabled(true);
                if (result == null || !result.optBoolean("ok", false)) {
                    String reason = ServerText.from(this, result, failure);
                    hint.setText(getString(R.string.st_create_failed, reason));
                    return;
                }
                JSONObject room = result.optJSONObject("room");
                if (room == null) {
                    hint.setText(getString(R.string.st_create_no_room));
                    return;
                }
                String code = room.optString("code", "");
                String id = room.optString("id", "");
                codeBox.setText(getString(R.string.st_invite_line, code));
                codeBox.setVisibility(View.VISIBLE);
                getSharedPreferences("leion", MODE_PRIVATE).edit()
                        .putString("roomHost", myName).apply();
                // 邀请码只在这几秒里"新鲜"：Toast 会盖在紧接着弹出的选库对话框**上面**，
                // 让用户不用先关掉对话框才看得到（用户 2026-10-27 报的"来不及看"）。
                Toast.makeText(this, getString(R.string.toast_invite, code), Toast.LENGTH_LONG).show();
                chooseLibsAfterCreate(id, room.optString("name", name), code);
            });
        }, "rooms-create").start();
    }

    private void joinRoom() {
        final String code = codeInput.getText().toString().trim();
        if (code.isEmpty()) {
            Toast.makeText(this, getString(R.string.toast_need_code), Toast.LENGTH_SHORT).show();
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
                    String reason = ServerText.from(this, result, failure);
                    hint.setText(getString(R.string.st_join_failed, reason));
                    return;
                }
                JSONObject room = result.optJSONObject("room");
                if (room == null) {
                    hint.setText(getString(R.string.st_join_no_room));
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
                            hint.setText(getString(R.string.st_terms_read_failed, ServerText.of(RoomsActivity.this, failure)));
                            enter(roomId, roomName);
                            return;
                        }
                        org.json.JSONArray list = result.optJSONArray("libraries");
                        if (list == null || list.length() == 0) {
                            hint.setText(getString(R.string.st_terms_none));
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
            labels.add(getString(R.string.terms_item,
                    item.optString("name", item.optString("id", "")), count));
        }
        final boolean[] checked = new boolean[labels.size()];
        String codeLine = (code == null || code.isEmpty()) ? "" : getString(R.string.terms_code_prefix, code);
        // ⚠️ 这里**不能**再调 setMessage（4.44 修）：AlertDialog 同时给了 message 与
        // multiChoiceItems 时，AppCompat 会把列表挤掉 —— 表现就是"选库框弹出来了、但里面
        // 一个库都没有"。邀请码只在**标题**里写一次（标题不会被列表挤掉），
        // 另外建房那一刻还有一条长 Toast 报码。
        new android.app.AlertDialog.Builder(this)
                .setTitle(codeLine + getString(R.string.terms_dialog_title))
                .setMultiChoiceItems(labels.toArray(new String[0]), checked,
                        (dialog, which, isChecked) -> checked[which] = isChecked)
                .setNegativeButton(getString(R.string.terms_dialog_skip), (dialog, which) -> enter(roomId, roomName))
                .setPositiveButton(getString(R.string.terms_dialog_ok), (dialog, which) -> saveLibsThenEnter(roomId, roomName, ids, checked))
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
                            hint.setText(getString(R.string.st_terms_frozen, result.optInt("entries", 0)));
                        } else {
                            hint.setText(getString(R.string.st_terms_save_failed,
                                    ServerText.of(RoomsActivity.this, failure)));
                        }
                        enter(roomId, roomName);
                    }
                });
            }
        }, "rooms-save-libs").start();
    }
    private void enter(String roomIdOrCode, String roomName) {
        if (roomIdOrCode == null || roomIdOrCode.isEmpty()) {
            hint.setText(getString(R.string.st_room_id_empty));
            return;
        }
        Intent intent = new Intent(this, RoomActivity.class);
        intent.putExtra(RoomActivity.EXTRA_ROOM, roomIdOrCode);
        intent.putExtra(RoomActivity.EXTRA_NAME, roomName);
        startActivity(intent);
    }
}