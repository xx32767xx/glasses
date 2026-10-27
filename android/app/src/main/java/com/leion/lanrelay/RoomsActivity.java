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
    private String myName = "";

    private EditText nameInput;
    private EditText codeInput;
    private TextView codeBox;
    private TextView hint;
    private Button createButton;
    private Button joinButton;

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

        createButton.setOnClickListener(v -> createRoom());
        joinButton.setOnClickListener(v -> joinRoom());
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
                body = client.orgCreateRoom(name);
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
                enter(id, room.optString("name", name));
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
                body = client.orgJoinRoom(code);
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