package com.leion.lanrelay;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * JoinRoomActivity —— 「加入同传会议」专用表单（5.04）。
 * ============================================================================
 *
 * <p>与创建页**同一套视觉与字段风格**，只是第一项从"会议主题"换成"邀请码"：
 *
 * <pre>
 *   邀请码 / 我的参会方式 / 我的参会语言
 * </pre>
 *
 * <p>三项都指定之后「加入会议」才可点（{@link #refreshSubmit()}）。
 * 邀请码是 6 位数字（布局里 `inputType=number` + `maxLength=6`），不是房间 id。
 *
 * <p>参会方式与创建页同一套取值（`onsite` / `remote`），服务端记在 `room_members.mode`。
 * 面对面"不许外放声音"属于设备连接那一层，本轮只记选择（见 docs/21 §5.04）。
 */
public class JoinRoomActivity extends android.app.Activity {

    private final Handler ui = new Handler(Looper.getMainLooper());
    private SharedPreferences prefs;
    private LanClient client;
    private SessionGuard guard;

    private EditText codeInput;
    private Button submitButton;
    private TextView hint;

    private String speakLang = "";
    private String attendMode = "";

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
        setContentView(R.layout.page_join_room);

        prefs = getSharedPreferences("leion", MODE_PRIVATE);
        codeInput = findViewById(R.id.joinCode);
        submitButton = findViewById(R.id.joinSubmit);
        hint = findViewById(R.id.joinHint);

        findViewById(R.id.joinBack).setOnClickListener(v -> finish());
        findViewById(R.id.joinModeOnsite).setOnClickListener(v -> setAttendMode("onsite"));
        findViewById(R.id.joinModeRemote).setOnClickListener(v -> setAttendMode("remote"));
        findViewById(R.id.joinLangZh).setOnClickListener(v -> setSpeakLang("zh-CN"));
        findViewById(R.id.joinLangPt).setOnClickListener(v -> setSpeakLang("pt-BR"));
        findViewById(R.id.joinLangEn).setOnClickListener(v -> setSpeakLang("en-US"));

        // 语言沿用上次选择；参会方式不预置（面对面/远程决定收音方式，猜错更贵）
        String savedLang = prefs.getString("speakLang", "zh-CN");
        setSpeakLang(savedLang == null || savedLang.isEmpty() ? "zh-CN" : savedLang);
        setAttendMode("");

        codeInput.addTextChangedListener(new android.text.TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) { }

            @Override
            public void afterTextChanged(android.text.Editable s) {
                refreshSubmit();
            }
        });
        submitButton.setOnClickListener(v -> joinRoom());
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
    }

    @Override
    protected void onDestroy() {
        if (guard != null) {
            guard.stop();
            guard = null;
        }
        super.onDestroy();
    }

    private void setSpeakLang(String lang) {
        speakLang = lang == null ? "" : lang;
        prefs.edit().putString("speakLang", speakLang).apply();
        stylePills(R.id.joinLangZh, R.string.rooms_speak_zh, R.string.rooms_speak_zh_on, "zh-CN".equals(speakLang));
        stylePills(R.id.joinLangPt, R.string.rooms_speak_pt, R.string.rooms_speak_pt_on, "pt-BR".equals(speakLang));
        stylePills(R.id.joinLangEn, R.string.rooms_speak_en, R.string.rooms_speak_en_on, "en-US".equals(speakLang));
        refreshSubmit();
    }

    private void setAttendMode(String mode) {
        attendMode = mode == null ? "" : mode;
        stylePills(R.id.joinModeOnsite, R.string.attend_mode_onsite, R.string.attend_mode_onsite_on,
                "onsite".equals(attendMode));
        stylePills(R.id.joinModeRemote, R.string.attend_mode_remote, R.string.attend_mode_remote_on,
                "remote".equals(attendMode));
        refreshSubmit();
    }

    /** 三项都指定之后才允许加入。 */
    private void refreshSubmit() {
        if (submitButton == null) return;
        boolean ready = codeInput != null && codeInput.getText().toString().trim().length() >= 6
                && !speakLang.isEmpty() && !attendMode.isEmpty();
        submitButton.setEnabled(ready);
        submitButton.setAlpha(ready ? 1f : 0.45f);
    }

    private void stylePills(int viewId, int offText, int onText, boolean on) {
        TextView pill = findViewById(viewId);
        if (pill == null) return;
        pill.setText(getString(on ? onText : offText));
        pill.setBackgroundResource(on ? R.drawable.bg_pill_active : R.drawable.bg_pill);
        pill.setTextColor(getColor(on ? R.color.on_brand : R.color.ink));
    }

    private void joinRoom() {
        final String code = codeInput.getText().toString().trim();
        if (code.length() < 6 || speakLang.isEmpty() || attendMode.isEmpty()) {
            hint.setText(getString(R.string.join_need_all));
            return;
        }
        submitButton.setEnabled(false);
        hint.setText("");
        new Thread(() -> {
            JSONObject body = null;
            String error = "";
            try {
                body = client.orgJoinRoom(code, speakLang, attendMode);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject result = body;
            final String failure = error;
            ui.post(() -> {
                refreshSubmit();
                if (result == null || !result.optBoolean("ok", false)) {
                    hint.setText(getString(R.string.st_join_failed,
                            ServerText.from(this, result, failure)));
                    return;
                }
                JSONObject room = result.optJSONObject("room");
                if (room == null) {
                    hint.setText(getString(R.string.st_join_no_room));
                    return;
                }
                // 记录发起者是谁（房间页的锁定按钮要靠它判定权限）
                prefs.edit().putString("roomHost", room.optString("host", "")).apply();
                enter(room.optString("id", ""), room.optString("name", ""));
            });
        }, "join-room").start();
    }

    private void enter(String roomId, String roomName) {
        if (roomId == null || roomId.isEmpty()) {
            hint.setText(getString(R.string.st_room_id_empty));
            return;
        }
        Intent intent = new Intent(this, RoomActivity.class);
        intent.putExtra(RoomActivity.EXTRA_ROOM, roomId);
        intent.putExtra(RoomActivity.EXTRA_NAME, roomName);
        startActivity(intent);
        finish();
    }
}
