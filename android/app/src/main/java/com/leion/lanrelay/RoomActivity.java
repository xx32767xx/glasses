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

    private static final int REQ_RECORD_AUDIO = 2001;

    public static final String EXTRA_ROOM = "roomIdOrCode";
    public static final String EXTRA_NAME = "roomName";

    private static final long FLOOR_POLL_MS = 2000L;
    /** WS 推送通道活着时，轮询退化成"看门狗"：只防推送通道假死，不必跑那么勤。 */
    private static final long FLOOR_POLL_WATCHDOG_MS = 10000L;
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
    private MicUploader mic;
    private Runnable pendingAfterPermission;
    private Button micUploadButton;
    private long lastHeartbeat = 0L;
    /** 发言权推送通道（4.35）。它只让"谁在说话"更快到达；断了就靠轮询。 */
    private FloorSocket floorSocket;
    private boolean wsOnline = false;

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
        startFloorSocket(host, secret, token);

        micUploadButton = findViewById(R.id.roomUpload);
        micUploadButton.setOnClickListener(v -> toggleUpload());
        updateUploadButton();
        micButton.setOnClickListener(v -> toggleMic());
        lockButton.setOnClickListener(v -> toggleLock());
        findViewById(R.id.roomLeave).setOnClickListener(v -> leaveRoom());
        lockButton.setEnabled(false);
        lockButton.setAlpha(0.5f);
        scheduleFloorPoll(0L);
        scheduleHeartbeatTick();
    }

    /**
     * 心跳与"状态推送"**解耦**（4.35）：WS 活着时轮询退成 10 秒看门狗，
     * 而服务端租约是 15 秒 —— 只靠轮询顺带续租，余量太薄（网络抖一下就掉麦）。
     * 所以心跳自己按 5 秒走，不看有没有消息进来。
     */
    private void scheduleHeartbeatTick() {
        ui.postDelayed(() -> {
            if (isFinishing()) return;
            if (holding) heartbeatIfDue();
            scheduleHeartbeatTick();
        }, HEARTBEAT_MS);
    }

    @Override
    protected void onDestroy() {
        if (floorSocket != null) {
            floorSocket.stop();
            floorSocket = null;
        }
        if (mic != null) {
            mic.stop();
            mic = null;
        }
        if (client != null) client.stop();
        ui.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    /**
     * 发言权推送通道（4.35）：让"谁在说话"一推即到，不再是 2 秒轮询。
     *
     * <p>没登录（没有 token）就不连 —— 服务端要用 token 才知道"我是房间里的谁"。
     * 连不上 / 掉线都只是一行状态：2 秒轮询一直在跑，WS 只负责更快。
     */
    private void startFloorSocket(String host, String secret, String token) {
        if (host == null || host.isEmpty() || token == null || token.isEmpty()) {
            return;
        }
        floorSocket = new FloorSocket(host, secret, token, roomKey, new FloorSocket.Listener() {
            @Override
            public void onFloor(JSONObject state) {
                final JSONObject body = state;
                ui.post(() -> {
                    String released = body.optString("released", "");
                    if (!released.isEmpty() && !"null".equals(released)) {
                        String message = released + " 掉线，麦克风已释放"
                                + (body.optBoolean("releasedLocked", false) ? "（含锁定）" : "");
                        hintLine.setText(message);
                        Toast.makeText(RoomActivity.this, message, Toast.LENGTH_SHORT).show();
                    }
                    applyFloorState(holderOf(body), body.optBoolean("locked", false));
                });
            }

            @Override
            public void onState(String message) {
                ui.post(() -> statusLine.setText(message));
            }

            @Override
            public void onOnlineChanged(boolean online) {
                ui.post(() -> wsOnline = online);
            }
        });
        floorSocket.start();
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
                if (status == 401) {
                    showKicked(body.optString("hint", body.optString("error", "")));
                    return;
                }
                if (status >= 400 || body.optBoolean("ok", false) == false) {
                    // 409 = 被规则拒绝（别人锁定中），这是业务状态，不是网络错误
                    String reason = body.optString("error", "");
                    Toast.makeText(this, reason.isEmpty() ? ("操作被拒（HTTP " + status + "）") : reason,
                            Toast.LENGTH_LONG).show();
                    if (action.equals("take")) hintLine.setText(reason);
                    return;
                }
                String holder = holderOf(body);
                takingChanged(holder, body.optBoolean("locked", false));
                if (body.optString("tookOver", "").length() > 0) {
                    hintLine.setText("你已接管麦克风 · " + body.optString("tookOver") + " 已被自动静音");
                }
                // 点「开麦」再点回来 = 结束发言：正在上传的话必须跟着停，
                // 否则会出现"麦已经放了、音频还在往识别流里灌"（4.34 修）
                if (!holding && mic != null) {
                    stopUpload("已结束发言 · 已停止同传");
                }
            });
        }, "room-floor-" + action).start();
    }

    /** JSON 里 holder 可能是 null，optString 会返回字面量 "null" —— 统一归一成空串。 */
    private static String holderOf(JSONObject body) {
        if (body == null || body.isNull("holder")) {
            return "";
        }
        String value = body.optString("holder", "");
        return "null".equals(value) ? "" : value;
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

    /**
     * 会话被顶掉（单会话的另一面）：提示、清本地 token、退出房间。
     *
     * <p>为什么退出房间而不是留在原地：这张牌桌上的身份已经失效，任何操作都会失败；
     * 留在这里只会让用户以为是"网络卡了"。退出后首页的会话监听会把界面带回登录页。
     */
    private void showKicked(String hint) {
        if (isFinishing()) return;
        String extra = hint == null || hint.isEmpty() ? "" : ("：" + hint);
        String message = "登录已失效" + extra + "（账号可能在别处登录），请重新登录";
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        hintLine.setText(message);
        statusLine.setText(message);
        getSharedPreferences("leion", MODE_PRIVATE).edit()
                .remove("accountToken").remove("termsUser").remove("roomHost").apply();
        ui.postDelayed(this::finish, 1500);
    }

    private String hostName() {
        return getSharedPreferences("leion", MODE_PRIVATE).getString("roomHost", "");
    }

    /** 退出房间：发起者退出会让整场结束（服务端规则）。 */
    private void leaveRoom() {
        micButton.setEnabled(false);
        new Thread(new Runnable() {
            public void run() {
                String error = "";
                try {
                    client.orgLeaveRoom(roomKey);
                } catch (Exception e) {
                    error = e.getMessage() == null ? e.toString() : e.getMessage();
                }
                final String failure = error;
                ui.post(new Runnable() {
                    public void run() {
                        if (!failure.isEmpty()) {
                            Toast.makeText(RoomActivity.this, "退出时出错：" + failure, Toast.LENGTH_SHORT).show();
                        }
                        finish();
                    }
                });
            }
        }, "room-leave").start();
    }
    // ── 音频上传（开始同传）──────────────────────────────────────────────
    private void toggleUpload() {
        if (mic != null) {
            mic.stop();
            mic = null;
            updateUploadButton();
            hintLine.setText("已停止上传");
            new Thread(new Runnable() {
                public void run() {
                    try {
                        client.floorAction(roomKey, "release");
                    } catch (Exception ignored) {
                        // 释放失败由服务端 15 秒租约兜底
                    }
                }
            }, "room-release-floor").start();
            return;
        }
        final MicUploader.Listener listener = new MicUploader.Listener() {
            public void onUploadStatus(String message) {
                ui.post(new Runnable() {
                    public void run() {
                        hintLine.setText(message);
                    }
                });
            }

            public void onUploadError(String message) {
                ui.post(new Runnable() {
                    public void run() {
                        hintLine.setText("上传出错：" + message);
                        if (mic != null) {
                            mic.stop();
                            mic = null;
                        }
                        updateUploadButton();
                    }
                });
            }

            public void onLevel(float rms, float peak) {
                // 电平只做静默反馈，不刷界面（避免每帧刷新拖慢字幕）
            }
        };
        ensureRecordPermission(() -> takeFloorThenUpload(listener));
    }

    /** 先抢麦，成功才上传。 */
    private void takeFloorThenUpload(final MicUploader.Listener listener) {
        // 发言权互斥：**先抢麦，再上传**。否则"没人占麦却在上传"，对面永远显示空闲。
        new Thread(new Runnable() {
            public void run() {
                JSONObject body = null;
                String failure = "";
                try {
                    body = client.floorAction(roomKey, "take");
                } catch (Exception e) {
                    failure = e.getMessage() == null ? e.toString() : e.getMessage();
                }
                final JSONObject result = body;
                final String error = failure;
                ui.post(new Runnable() {
                    public void run() {
                        if (result == null || result.optInt("_status", 0) >= 400 || !result.optBoolean("ok", false)) {
                            String reason = result == null ? error : result.optString("error", error);
                            hintLine.setText("无法开麦：" + (reason.isEmpty() ? "被拒绝" : reason));
                            micUploadButton.setEnabled(true);
                            return;
                        }
                        takingChanged(holderOf(result), result.optBoolean("locked", false));
                        startUpload(listener);
                    }
                });
            }
        }, "room-take-floor").start();
    }

    /** 没有录音权限就先申请；授予后再回来继续（新界面不再依赖旧界面的授权流程）。 */
    private void ensureRecordPermission(Runnable then) {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            then.run();
            return;
        }
        pendingAfterPermission = then;
        requestPermissions(new String[] { android.Manifest.permission.RECORD_AUDIO }, REQ_RECORD_AUDIO);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_RECORD_AUDIO) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
        Runnable after = pendingAfterPermission;
        pendingAfterPermission = null;
        if (!granted) {
            hintLine.setText("没有麦克风权限：请在系统设置里给「译连 TransLink」录音权限，然后再点开始同传");
            return;
        }
        if (after != null) {
            after.run();
        }
    }

    private void startUpload(MicUploader.Listener listener) {
        mic = new MicUploader(client, listener);
        // 我在会里说的语言（建房/加入时选的）决定识别方向，别再用默认值
        String speak = getSharedPreferences("leion", MODE_PRIVATE).getString("speakLang", "zh-CN");
        if (speak != null && !speak.isEmpty()) {
            mic.setLanguage(speak);
        }
        String error = mic.start();
        if (error == null) {
            updateUploadButton();
            hintLine.setText("正在上传麦克风，说话会被识别");
        } else {
            mic = null;
            updateUploadButton();
            hintLine.setText(error);
        }
    }

    // ── 发言权轮询 ───────────────────────────────────────────────────────
    //
    // ⚠️ 这一圈不只是"刷新谁在说话"：**被顶替时必须立刻停止上传**（4.34 修）。
    // 旧版只改了按钮文字，于是 A 被 B 抢麦后：界面显示发言人是 B，可 A 的麦克风还在
    // 往同一个识别流里灌音频 —— 两路音频交错，字幕错乱，而界面上看着"一切正常"。
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
                    // 单会话：被别处登录顶掉时，房间里的轮询是最早能发现的地方
                    // （点按钮才发现的话，用户已经对着"没反应"愣了几秒）
                    if (body != null && body.optInt("httpStatus", 0) == 401) {
                        showKicked(body.optString("hint", body.optString("error", "")));
                        return;
                    }
                    if (body != null && body.optBoolean("ok", false)) {
                        String released = body.optString("released", "");
                        if (!released.isEmpty() && !"null".equals(released)) {
                            // 服务端把"锁着麦但人已经不在"的那位清掉了（4.42）
                            String message = released + " 掉线，麦克风已释放"
                                    + (body.optBoolean("releasedLocked", false) ? "（含锁定）" : "");
                            hintLine.setText(message);
                            Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
                        }
                        applyFloorState(holderOf(body), body.optBoolean("locked", false));
                    }
                    // 推送通道活着 → 轮询只当看门狗，别白跑那么勤；断了 → 立刻回到 2 秒
                    if (!isFinishing()) scheduleFloorPoll(wsOnline ? FLOOR_POLL_WATCHDOG_MS : FLOOR_POLL_MS);
                });
            }, "room-floor-poll").start();
        }, delay);
    }

    /** 上传按钮的文字与颜色：**蓝 = 正在上传**，灰 = 空闲。被顶替时必须回到灰色。 */
    private void updateUploadButton() {
        boolean uploading = mic != null;
        micUploadButton.setText(uploading ? "停止同传" : "开始同传");
        micUploadButton.setBackgroundColor(uploading ? 0xFF1565C0 : 0xFF263238);
        micUploadButton.setEnabled(true);
    }

    /**
     * 一份发言权状态到了 —— **轮询和 WS 推送走同一条路**（4.35）。
     *
     * 两处入口必须共用这段，否则就会出现"推送很快，但忘了停上传"这类不对称的 bug：
     * 界面上 B 在说话、A 的麦克风还在传，正是 4.34 修的那个故障。
     */
    private void applyFloorState(String holder, boolean isLocked) {
        boolean wasHolding = holding;
        takingChanged(holder, isLocked);
        if (holding) {
            heartbeatIfDue();
        } else if (wasHolding || mic != null) {
            // 我已经不是持麦者：被别人顶替 / 被强制收回 / 租约过期
            onFloorLost(holder);
        }
    }

    /** 停止上传并刷新按钮；`hint` 为空则保留当前提示。 */
    private void stopUpload(String hint) {
        if (mic != null) {
            mic.stop();
            mic = null;
            lastHeartbeat = 0L;
        }
        updateUploadButton();
        if (hint != null && !hint.isEmpty()) {
            hintLine.setText(hint);
        }
    }

    /**
     * 发言权不再在我手上。**必须自己把麦克风停掉** —— 服务端只负责裁决"谁是持麦者"，
     * 它不知道我这边还在录音；不主动停，两路音频就会混进同一个识别流。
     */
    private void onFloorLost(String holder) {
        boolean wasUploading = mic != null;
        String who = holder == null ? "" : holder;
        String message;
        if (!who.isEmpty()) {
            message = wasUploading ? (who + " 接管了麦克风 · 已自动停止同传") : (who + " 接管了麦克风");
        } else {
            message = wasUploading ? "麦克风已释放 · 已自动停止同传" : "";
        }
        if (message.isEmpty()) {
            updateUploadButton();
            return;
        }
        stopUpload(message);
        // 字幕流会不断改写 hint 行，所以这条提示再用 Toast 说一次（否则一闪就没了）
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private void heartbeatIfDue() {
        long now = System.currentTimeMillis();
        if (now - lastHeartbeat < HEARTBEAT_MS) return;
        lastHeartbeat = now;
        new Thread(() -> {
            JSONObject reply = null;
            try {
                reply = client.floorAction(roomKey, "heartbeat");
            } catch (Exception ignored) {
                // 网络抖动：交给 2 秒轮询与服务端 15 秒租约兜底
                return;
            }
            final JSONObject body = reply;
            if (body != null && !body.optBoolean("ok", false)) {
                // 服务端说"不是持麦者"：别再等下一轮轮询，那一秒的音频会混进识别流
                ui.post(() -> {
                    holding = false;
                    stopUpload("你已不是持麦者 · 已自动停止同传");
                });
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