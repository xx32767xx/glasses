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

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * CreateRoomActivity —— 「创建同传会议」专用表单（5.04）。
 * ============================================================================
 *
 * <p><b>为什么单独一页</b>：原来点「创建会议」和「加入会议」进的是**同一个大厅页**，
 * 两边内容完全一样（用户原话："无论我点加入会议还是创建会议 弹出的内容都是一样的"）。
 * 现在两件事各一页、字段各是各的：
 *
 * <pre>
 *   创建：会议主题 / 我的参会方式 / 我的参会语言 / 术语库（点开勾选）
 *   加入：邀请码   / 我的参会方式 / 我的参会语言
 * </pre>
 *
 * <p><b>前三个是必填</b>：没填完时「创建会议」按钮是灰的（{@link #refreshSubmit()}）。
 * 术语库是<em>选填</em>，做法是点那一行弹出一个可勾选的列表 —— 不让用户记库 id。
 *
 * <p><b>术语库为什么能在建房前选</b>：库选择在服务端是按**房间**存的
 * （`POST /org/rooms/&lt;id&gt;/libraries`），所以顺序是"先建房 → 立刻把选好的库贴上去 →
 * 再进房间"。这样用户在建房页一次就把事情做完，不会像以前那样被一个对话框挡住邀请码。
 *
 * <p><b>参会方式只做选择</b>：面对面意味着"不能外放声音"（会啸叫，要走眼镜/耳机收音），
 * 但那属于**设备连接**那一层，本轮不做；这里把选择记进 `room_members.mode`，
 * 等设备那条线接上就能直接用它（见 docs/21 §5.04）。
 */
public class CreateRoomActivity extends android.app.Activity {

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private LanClient client;
    private SessionGuard guard;

    private EditText topicInput;
    private Button submitButton;
    private TextView hint;
    private TextView libsValue;
    private TextView libsHint;

    /** 我在会里说/读的语言（zh-CN / pt-BR / en-US）。 */
    private String speakLang = "";
    /** 我的参会方式（onsite 面对面 / remote 远程）；空串 = 还没选。 */
    private String attendMode = "";

    /** 电脑上可选的库：id 与"名字（N 条）"，与勾选状态一一对应。 */
    private final List<String> libIds = new ArrayList<>();
    private final List<String> libLabels = new ArrayList<>();
    private final List<Boolean> libChecked = new ArrayList<>();
    private boolean libsLoaded = false;

    @Override
    protected void attachBaseContext(android.content.Context base) {
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        UiLang.trackShown(this);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_create_room);

        prefs = getSharedPreferences("leion", MODE_PRIVATE);
        topicInput = findViewById(R.id.createTopic);
        submitButton = findViewById(R.id.createSubmit);
        hint = findViewById(R.id.createHint);
        libsValue = findViewById(R.id.createLibsValue);
        libsHint = findViewById(R.id.createLibsHint);

        findViewById(R.id.createBack).setOnClickListener(v -> finish());
        findViewById(R.id.createModeOnsite).setOnClickListener(v -> setAttendMode("onsite"));
        findViewById(R.id.createModeRemote).setOnClickListener(v -> setAttendMode("remote"));
        findViewById(R.id.createLangZh).setOnClickListener(v -> setSpeakLang("zh-CN"));
        findViewById(R.id.createLangPt).setOnClickListener(v -> setSpeakLang("pt-BR"));
        findViewById(R.id.createLangEn).setOnClickListener(v -> setSpeakLang("en-US"));
        findViewById(R.id.createLibsRow).setOnClickListener(v -> pickLibraries());

        // 语言沿用上次的选择（它同时是"我读哪种语言"，重复选没有意义）；
        // 参会方式**不给默认值**：面对面/远程对应的是不同的收音方式，猜错比多问一句糟。
        String savedLang = prefs.getString("speakLang", "zh-CN");
        setSpeakLang(savedLang == null || savedLang.isEmpty() ? "zh-CN" : savedLang);
        setAttendMode("");

        topicInput.addTextChangedListener(new android.text.TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) { }

            @Override
            public void afterTextChanged(android.text.Editable s) {
                refreshSubmit();
            }
        });
        submitButton.setOnClickListener(v -> createRoom());
        refreshSubmit();

        client = new LanClient(prefs.getString("host", ""), prefs.getString("secret", ""), null);
        String token = prefs.getString("accountToken", "");
        if (token != null && !token.isEmpty()) client.setToken(token);

        String myName = prefs.getString("termsUser", "");
        if (myName == null || myName.isEmpty()) {
            hint.setText(getString(R.string.st_rooms_need_login));
            submitButton.setEnabled(false);
            return;
        }

        guard = new SessionGuard(client, prefs, message -> ui.post(() -> {
            Toast.makeText(this, message, Toast.LENGTH_LONG).show();
            finish();
        }));
        guard.start(prefs.getString("host", ""), prefs.getString("secret", ""), token);

        loadLibraries();
    }

    @Override
    protected void onDestroy() {
        if (guard != null) {
            guard.stop();
            guard = null;
        }
        super.onDestroy();
    }

    // ── 三个必填项 ──────────────────────────────────────────────────────────
    private void setSpeakLang(String lang) {
        speakLang = lang == null ? "" : lang;
        prefs.edit().putString("speakLang", speakLang).apply();
        stylePills(R.id.createLangZh, R.string.rooms_speak_zh, R.string.rooms_speak_zh_on, "zh-CN".equals(speakLang));
        stylePills(R.id.createLangPt, R.string.rooms_speak_pt, R.string.rooms_speak_pt_on, "pt-BR".equals(speakLang));
        stylePills(R.id.createLangEn, R.string.rooms_speak_en, R.string.rooms_speak_en_on, "en-US".equals(speakLang));
        refreshSubmit();
    }

    private void setAttendMode(String mode) {
        attendMode = mode == null ? "" : mode;
        // 5.07：记下来 —— 房间页顶部那格「我说… · 面对面」要显示它，
        // 而房间页与这里不是一个页面，只能靠 prefs 传（同一套做法见 speakLang）。
        if (!attendMode.isEmpty()) prefs.edit().putString("attendMode", attendMode).apply();
        stylePills(R.id.createModeOnsite, R.string.attend_mode_onsite, R.string.attend_mode_onsite_on,
                "onsite".equals(attendMode));
        stylePills(R.id.createModeRemote, R.string.attend_mode_remote, R.string.attend_mode_remote_on,
                "remote".equals(attendMode));
        // 面对面那一条要当场说清"不外放声音"，否则用户会以为选了没反应
        TextView modeHint = findViewById(R.id.createModeHint);
        if (modeHint != null && "onsite".equals(attendMode)) {
            modeHint.setText(getString(R.string.attend_onsite_no_speaker));
        } else if (modeHint != null) {
            modeHint.setText(getString(R.string.attend_mode_hint));
        }
        refreshSubmit();
    }

    /** 前三个都指定之后才允许创建（用户明确要求的门禁）。 */
    private void refreshSubmit() {
        if (submitButton == null) return;
        boolean ready = topicInput != null && topicInput.getText().toString().trim().length() > 0
                && !speakLang.isEmpty() && !attendMode.isEmpty();
        submitButton.setEnabled(ready);
        // 灰按钮要看得出来是灰的（有些 ROM 上 tap_btn_primary 的 disabled 态几乎看不出）
        submitButton.setAlpha(ready ? 1f : 0.45f);
    }

    private void stylePills(int viewId, int offText, int onText, boolean on) {
        TextView pill = findViewById(viewId);
        if (pill == null) return;
        pill.setText(getString(on ? onText : offText));
        pill.setBackgroundResource(on ? R.drawable.bg_pill_active : R.drawable.bg_pill);
        pill.setTextColor(getColor(on ? R.color.on_brand : R.color.ink));
    }

    // ── 术语库（选填）：点一行 → 弹勾选列表 ─────────────────────────────────
    private void loadLibraries() {
        new Thread(() -> {
            JSONObject body = null;
            String error = "";
            try {
                body = client.orgLibraries();
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject result = body;
            final String failure = error;
            ui.post(() -> {
                if (result == null || !result.optBoolean("ok", false)) {
                    // 读不到库**不影响开会**：这一项本来就是选填
                    libsHint.setText(getString(R.string.create_libs_read_failed,
                            ServerText.of(this, failure)));
                    return;
                }
                JSONArray list = result.optJSONArray("libraries");
                libIds.clear();
                libLabels.clear();
                libChecked.clear();
                if (list != null) {
                    for (int i = 0; i < list.length(); i++) {
                        JSONObject item = list.optJSONObject(i);
                        if (item == null) continue;
                        libIds.add(item.optString("id", ""));
                        libLabels.add(getString(R.string.terms_item,
                                item.optString("name", item.optString("id", "")),
                                item.optInt("entries", 0)));
                        libChecked.add(Boolean.FALSE);
                    }
                }
                libsLoaded = true;
                if (libIds.isEmpty()) {
                    libsHint.setText(getString(R.string.create_libs_empty));
                }
                renderLibsValue();
            });
        }, "create-libs").start();
    }

    private void renderLibsValue() {
        int checked = 0;
        for (Boolean one : libChecked) {
            if (Boolean.TRUE.equals(one)) checked += 1;
        }
        libsValue.setText(checked == 0
                ? getString(R.string.create_libs_none)
                : getString(R.string.create_libs_count, checked));
    }

    private void pickLibraries() {
        if (libsLoaded == false) {
            Toast.makeText(this, getString(R.string.create_libs_empty), Toast.LENGTH_SHORT).show();
            return;
        }
        if (libIds.isEmpty()) {
            Toast.makeText(this, getString(R.string.create_libs_empty), Toast.LENGTH_SHORT).show();
            return;
        }
        final boolean[] checked = new boolean[libChecked.size()];
        for (int i = 0; i < checked.length; i++) checked[i] = Boolean.TRUE.equals(libChecked.get(i));
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.terms_dialog_title)
                .setMultiChoiceItems(libLabels.toArray(new String[0]), checked,
                        (dialog, which, isChecked) -> checked[which] = isChecked)
                .setNegativeButton(R.string.common_cancel, null)
                .setPositiveButton(R.string.terms_dialog_ok, (dialog, which) -> {
                    for (int i = 0; i < checked.length; i++) {
                        libChecked.set(i, Boolean.valueOf(checked[i]));
                    }
                    renderLibsValue();
                })
                .show();
    }

    // ── 建房 ────────────────────────────────────────────────────────────────
    private void createRoom() {
        final String topic = topicInput.getText().toString().trim();
        if (topic.isEmpty()) {
            hint.setText(getString(R.string.create_need_topic));
            return;
        }
        if (speakLang.isEmpty() || attendMode.isEmpty()) {
            hint.setText(getString(R.string.join_need_all));
            return;
        }
        submitButton.setEnabled(false);
        hint.setText("");
        new Thread(() -> {
            JSONObject body = null;
            String error = "";
            try {
                // 5.03：**不传目标语言** —— 译成什么由每位成员入会时选的语言决定
                // 5.04：参会方式随建房一起给（服务端存 room_members.mode）
                body = client.orgCreateRoom(topic, speakLang, "", attendMode);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject created = body;
            final String failure = error;
            JSONObject room = created == null ? null : created.optJSONObject("room");
            final String roomId = room == null ? "" : room.optString("id", "");
            final String roomName = room == null ? topic : room.optString("name", topic);
            final String code = room == null ? "" : room.optString("code", "");
            final List<String> selected = selectedLibIds();
            JSONObject libsResult = null;
            String libsError = "";
            if (roomId.isEmpty() == false && selected.isEmpty() == false) {
                try {
                    libsResult = client.orgSetRoomLibraries(roomId, new JSONArray(selected));
                } catch (Exception e) {
                    libsError = e.getMessage() == null ? e.toString() : e.getMessage();
                }
            }
            final JSONObject libs = libsResult;
            final String libsFailure = libsError;
            ui.post(() -> {
                submitButton.setEnabled(true);
                refreshSubmit();
                if (created == null || !created.optBoolean("ok", false) || roomId.isEmpty()) {
                    hint.setText(getString(R.string.st_create_failed,
                            ServerText.from(this, created, failure)));
                    return;
                }
                // 邀请码要在**这一页**说一次：进房之后房间页顶部也有，但用户往往当场就要发出去
                Toast.makeText(this, getString(R.string.toast_invite, code), Toast.LENGTH_LONG).show();
                if (libs != null && libs.optBoolean("ok", false) == false) {
                    hint.setText(getString(R.string.st_terms_save_failed, ServerText.of(this, libsFailure)));
                }
                prefs.edit().putString("roomHost", prefs.getString("termsUser", "")).apply();
                enter(roomId, roomName);
            });
        }, "create-room").start();
    }

    private List<String> selectedLibIds() {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < libIds.size() && i < libChecked.size(); i++) {
            if (Boolean.TRUE.equals(libChecked.get(i))) out.add(libIds.get(i));
        }
        return out;
    }

    private void enter(String roomId, String roomName) {
        Intent intent = new Intent(this, RoomActivity.class);
        intent.putExtra(RoomActivity.EXTRA_ROOM, roomId);
        intent.putExtra(RoomActivity.EXTRA_NAME, roomName);
        startActivity(intent);
        finish();
    }
}
