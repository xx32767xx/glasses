package com.leion.lanrelay;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * RoomActivity — 房间内页（P3.2）：字幕流 + 开麦/锁定 + 右侧发言人状态。
 *
 * 设计取舍（稳定性优先）：
 *   ① **独立 Activity**，不改动 3900 行的 MainActivity；
 *   ② 只依赖 LanClient 已有的 start()/stop() 长轮询与新增的房间/发言权方法；
 *   ③ 轮询间隔固定（发言权 2 秒、持麦时 5 秒心跳），不引入额外线程管理。
 */
public class RoomActivity extends android.app.Activity implements LanClient.Listener {

    public static final String EXTRA_ROOM = "roomIdOrCode";
    public static final String EXTRA_NAME = "roomName";

    private static final long FLOOR_POLL_MS = 2000L;
    private static final long HEARTBEAT_MS = 5000L;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LanClient client;
    private String roomKey = "";
    private String myName = "";

    private TextView statusLine;
    private TextView mainLine;
    private TextView subLine;
    private TextView speakerBar;
    private TextView hintLine;
    private Button micButton;
    private Button lockButton;

    private boolean holding = false;
    private boolean locked = false;
    private boolean pollScheduled = false;
    private long lastHeartbeat = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_room);

        roomKey = getIntent().getStringExtra(EXTRA_ROOM);
        String roomName = getIntent().getStringExtra(EXTRA_NAME);
        if (roomKey == null || roomKey.isEmpty()) {
            finish();
            return;
        }

        statusLine = findViewById(R.id.roomStatus);
        mainLine = findViewById(R.id.roomMain);
        subLine = findViewById(R.id.roomSub);
        speakerBar = findViewById(R.id.roomSpeaker);
        hintLine = findViewById(R.id.roomHint);
        micButton = findViewById(R.id.roomMic);
        lockButton = findViewById(R.id.roomLock);

        statusLine.setText((roomName == null ? "房间" : roomName) + " · 连接中…");

        SharedPreferences prefs = getSharedPreferences("leion", MODE_PRIVATE);
        String host = prefs.getString("host", "");
        String secret = prefs.getString("secret", "");
        myName = prefs.getString("termsUser", "");
        String token = prefs.getString("accountToken", "");

        client = new LanClient(host, secret, this);
        if (token != null && !token.isEmpty()) client.setToken(token);
        if (myName != null && !myName.isEmpty()) client.setUser(myName);
        client.start();

        micButton.setOnClickListener(v -> toggleMic());
        lockButton.setOnClickListener(v -> toggleLock());
        lockButton.setEnabled(false);
        lockButton.setAlpha(0.5f);
        scheduleFloorPoll(0L);
    }

    @Override
    protected void onDestroy() {
        if (client != null) client.stop();
        ui.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    // ── 开麦 / 关麦 ──────────────────────────────────────────────────────
    private void toggleMic() {
        if (holding) {
            act("release");
        } else {
            act("take");
        }
    }

    private void toggleLock() {
        act(locked ? "unlock" : "lock");
    }

    private void act(String action) {
        micButton.setEnabled(false);
        new Thread(() -> {
            JSONObject result = null;
            String error = "";
            try {
                result = client.floorAction(roomKey, action);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject body = result;
            final String failure = error;
            ui.post(() -> {
                micButton.setEnabled(true);
                if (body == null) {
                    Toast.makeText(this, "请求失败：" + failure, Toast.LENGTH_LONG).show();
                    return;
                }
                int status = body.optInt("_status", 0);
                if (status >= 400 || body.optBoolean("ok", false) == false) {
                    // 409 = 被规则拒绝（别人锁定中），这是业务状态，不是网络错误
                    String reason = body.optString("error", "");
                    Toast.makeText(this, reason.isEmpty() ? ("操作被拒（HTTP " + status + "）") : reason,
                            Toast.LENGTH_LONG).show();
                    if (action.equals("take")) hintLine.setText(reason);
                    return;
                }
                String holder = body.optString("holder", "");
                takingChanged(holder, body.optBoolean("locked", false));
                if (body.optString("tookOver", "").length() > 0) {
                    hintLine.setText("你已接管麦克风 · " + body.optString("tookOver") + " 已被自动静音");
                }
            });
        }, "room-floor-" + action).start();
    }

    private void takingChanged(String holder, boolean isLocked) {
        holding = holder != null && holder.equals(myName) && !holder.isEmpty();
        locked = isLocked;
        boolean anyHolder = holder != null && !holder.isEmpty();
        micButton.setText(holding ? "正在发言 · 点此结束" : "点击开麦");
        micButton.setBackgroundColor(holding ? 0xFF2E7D32 : 0xFF37474F);
        lockButton.setText(isLocked ? "解锁" : "锁定发言");
        lockButton.setEnabled(holding || (anyHolder && myName.equals(hostName())));
        lockButton.setAlpha(lockButton.isEnabled() ? 1f : 0.5f);
        speakerBar.setText(anyHolder ? ("发言人：" + holder + (isLocked ? "（已锁定）" : "")) : "麦克风空闲");
    }

    private String hostName() {
        return getSharedPreferences("leion", MODE_PRIVATE).getString("roomHost", "");
    }

    // ── 发言权轮询 ───────────────────────────────────────────────────────
    private void scheduleFloorPoll(long delay) {
        if (pollScheduled) return;
        pollScheduled = true;
        ui.postDelayed(() -> {
            pollScheduled = false;
            new Thread(() -> {
                JSONObject state = null;
                try {
                    state = client.floorGet(roomKey);
                } catch (Exception ignored) {
                    // 网络抖动不弹框：下一轮继续
                }
                final JSONObject body = state;
                ui.post(() -> {
                    if (body != null && body.optBoolean("ok", false)) {
                        takingChanged(body.optString("holder", ""), body.optBoolean("locked", false));
                        if (holding) heartbeatIfDue();
                    }
                    if (!isFinishing()) scheduleFloorPoll(FLOOR_POLL_MS);
                });
            }, "room-floor-poll").start();
        }, delay);
    }

    private void heartbeatIfDue() {
        long now = System.currentTimeMillis();
        if (now - lastHeartbeat < HEARTBEAT_MS) return;
        lastHeartbeat = now;
        new Thread(() -> {
            try {
                client.floorAction(roomKey, "heartbeat");
            } catch (Exception ignored) {
                // 心跳失败不打扰用户；断线 15 秒后服务端会自动释放
            }
        }, "room-floor-heartbeat").start();
    }

    // ── LanClient.Listener ──────────────────────────────────────────────
    @Override
    public void onStatus(String message) {
        ui.post(() -> statusLine.setText(message));
    }

    @Override
    public void onHello(String device, int cols, int lineBudget) {
        // 手机-only：不需要设备名；只显示连接状态
        ui.post(() -> statusLine.setText("已连接 · " + cols + "×" + lineBudget));
    }

    @Override
    public void onFrame(String speaker, String lang, String[] lines, String text,
                        String source, String sourceLang, boolean partial, String[] termsMissing) {
        ui.post(() -> {
            String main = (text == null || text.isEmpty()) ? (lines == null ? "" : String.join("\n", lines)) : text;
            mainLine.setText(main == null ? "" : main);
            subLine.setText(source == null ? "" : source);
            if (partial) hintLine.setText("生成中…");
            else if (termsMissing != null && termsMissing.length > 0) {
                hintLine.setText("术语未按规范写法出现：" + String.join("、", termsMissing));
            } else hintLine.setText("");
        });
    }

    @Override
    public void onError(String message) {
        ui.post(() -> statusLine.setText("连接异常：" + message));
    }
}