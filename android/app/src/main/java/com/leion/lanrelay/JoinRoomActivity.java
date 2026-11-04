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
    /** 5.55：我想看哪些语言的译文（永远包含 speakLang，见 {@link HearLangs}）。 */
    private final java.util.Set<String> hearLangs = new java.util.LinkedHashSet<>();

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
        // 5.55：我想看哪些译文（多选；自己那门锁定）
        findViewById(R.id.joinHearZh).setOnClickListener(v -> toggleHearLang("zh-CN"));
        findViewById(R.id.joinHearPt).setOnClickListener(v -> toggleHearLang("pt-BR"));
        findViewById(R.id.joinHearEn).setOnClickListener(v -> toggleHearLang("en-US"));

        // 语言沿用上次选择；参会方式不预置（面对面/远程决定收音方式，猜错更贵）
        String savedLang = prefs.getString("speakLang", "zh-CN");
        // 5.55：上次勾的"我想看"（没有就是只有自己那门）
        hearLangs.addAll(HearLangs.parse(prefs.getString("hearLangs", "")));
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
        // 5.55：换了"我说什么语言" → "我想看"里必须跟着含它（不能出现"我说葡语但只看中文"）
        hearLangs.add(speakLang);
        persistHearLangs();
        applyHearChips();
        refreshSubmit();
    }

    /**
     * 「我想看哪些语言的译文」——**多选**（5.55）。
     *
     * <p>自己说的那门**锁定勾选、不能取消**：它不是"想看自己的原文"，而是
     * "别人说的要按我读得懂的语言给我"。点它就是什么都不做（但给出提示，不静默）。
     */
    private void toggleHearLang(String lang) {
        if (lang == null || lang.isEmpty()) return;
        if (lang.equals(speakLang)) {
            android.widget.Toast.makeText(this, getString(R.string.rooms_hear_locked),
                    android.widget.Toast.LENGTH_SHORT).show();
            return;
        }
        if (!hearLangs.remove(lang)) hearLangs.add(lang);
        persistHearLangs();
        applyHearChips();
    }

    private void persistHearLangs() {
        prefs.edit().putString("hearLangs", HearLangs.join(hearLangs, speakLang)).apply();
    }

    /** 三颗胶囊的状态：勾选=品牌底，自己那门锁定并加锁标记。 */
    private void applyHearChips() {
        applyHearChip(R.id.joinHearZh, R.string.rooms_speak_zh, "zh-CN");
        applyHearChip(R.id.joinHearPt, R.string.rooms_speak_pt, "pt-BR");
        applyHearChip(R.id.joinHearEn, R.string.rooms_speak_en, "en-US");
    }

    private void applyHearChip(int viewId, int nameRes, String lang) {
        TextView pill = findViewById(viewId);
        if (pill == null) return;
        boolean on = hearLangs.contains(lang);
        boolean locked = lang.equals(speakLang);
        pill.setText(on ? getString(R.string.rooms_hear_on, getString(nameRes)) : getString(nameRes));
        pill.setBackgroundResource(on ? R.drawable.bg_pill_active : R.drawable.bg_pill);
        pill.setTextColor(getColor(on ? R.color.on_brand : R.color.ink));
        pill.setAlpha(locked ? 0.85f : 1f);
        pill.setClickable(!locked);
    }

    private void setAttendMode(String mode) {
        attendMode = mode == null ? "" : mode;
        // 5.07：记下来，房间页顶部那格「我说… · 面对面」要用（同 speakLang 的做法）
        if (!attendMode.isEmpty()) prefs.edit().putString("attendMode", attendMode).apply();
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
                body = client.orgJoinRoom(code, speakLang, attendMode,
                        HearLangs.join(hearLangs, speakLang));
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
