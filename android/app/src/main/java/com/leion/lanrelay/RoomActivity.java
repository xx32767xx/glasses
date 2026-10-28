package com.leion.lanrelay;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
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
    private TextView speakerBar;
    private TextView hintLine;
    private Button micButton;
    private Button lockButton;

    // ── 顶部会议信息（两行）──
    private TextView codeView;
    private TextView copyView;
    private TextView modeTag;
    private TextView roleTag;
    private TextView titleView;
    private TextView membersView;
    private TextView timerView;

    // ── 中央字幕流 ──
    private ScrollView subtitleScroll;
    private LinearLayout subtitleList;
    private TextView emptyView;

    // ── 右侧悬浮条与「人员与设备」抽屉 ──
    private TextView castState;
    private TextView audioState;
    private TextView micState;
    private LinearLayout infoBar;
    private LinearLayout drawer;
    private LinearLayout membersList;
    private TextView drawerDevices;

    // ── 底部：原文显示开关（M3）──
    private TextView sourceToggle;
    private boolean showSource = true;

    /**
     * 最后一条字幕的身份：**原文**（source）。
     *
     * <p>为什么用原文而不是"是不是增量帧"：一句话在产线上会来**三帧** ——
     * 增量帧（partial）、定稿帧、校对修订帧。它们共用同一句原文，只有原文相同才算同一段。
     * 之前只按 `partial` 判断，于是定稿帧被当成新的一句 → 同一句话叠成三张卡，
     * 其中一张还停在"识别中"，并且只显示半句译文（4.53 修）。
     */
    private String lastSegmentKey = null;
    private boolean lastWasPartial = false;

    /** 当前这一条字幕（用于同一段的**原位更新**，而不是新起一条）。 */
    private View lastSegmentView;
    private TextView lastSegmentSource;
    private TextView lastSegmentTarget;
    private TextView lastSegmentState;
    /** 字幕卡最多留多少条：多了就丢最老的（防止一场会开两小时把内存吃掉）。 */
    private static final int MAX_SEGMENTS = 60;
    /** 我从什么时候开始持麦（用来在按钮上显示"正在发言 00:12"）。 */
    private long holdingSinceMs = 0L;

    /** 我是不是发起者（决定抽屉里显不显示"移出成员/解除锁定"）。 */
    private boolean iAmHost = false;

    /** 会议计时（从进房那一刻算）。 */
    private long startedAtMs = 0L;
    private boolean timerRunning = false;

    private boolean holding = false;
    private boolean locked = false;
    private boolean pollScheduled = false;
    private MicUploader mic;
    private Runnable pendingAfterPermission;
    private Button micUploadButton;
    private long lastHeartbeat = 0L;
    /** 轮询计数（4.46）：用来"每 5 轮"做一次房间状态兜底检查。 */
    private int pollTicks = 0;

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
        speakerBar = findViewById(R.id.roomSpeaker);
        hintLine = findViewById(R.id.roomHint);
        micButton = findViewById(R.id.roomMic);
        lockButton = findViewById(R.id.roomLock);

        codeView = findViewById(R.id.roomCode);
        copyView = findViewById(R.id.roomCopy);
        modeTag = findViewById(R.id.roomModeTag);
        roleTag = findViewById(R.id.roomRoleTag);
        titleView = findViewById(R.id.roomTitle);
        membersView = findViewById(R.id.roomMembers);
        timerView = findViewById(R.id.roomTimer);

        subtitleScroll = findViewById(R.id.roomSubtitleScroll);
        subtitleList = findViewById(R.id.roomSubtitles);
        emptyView = findViewById(R.id.roomEmpty);

        castState = findViewById(R.id.roomCastState);
        audioState = findViewById(R.id.roomAudioState);
        micState = findViewById(R.id.roomMicState);
        infoBar = findViewById(R.id.roomInfoBar);
        drawer = findViewById(R.id.roomDrawer);
        membersList = findViewById(R.id.roomMembersList);
        drawerDevices = findViewById(R.id.roomDrawerDevices);
        sourceToggle = findViewById(R.id.roomSourceToggle);

        copyView.setOnClickListener(v -> copyInvite());
        infoBar.setOnClickListener(v -> toggleDrawer());
        findViewById(R.id.roomDrawerClose).setOnClickListener(v -> toggleDrawer());
        sourceToggle.setOnClickListener(v -> toggleSource());

        addSystemEvent("会议开始 · 发言权互斥已启用：同一时刻仅一人开麦");

        // 外设（投屏/扩声）**还没接入**：这里只把事实写清楚，不做假开关。
        castState.setText("手机屏");
        audioState.setText("未接入");
        micState.setText("手机麦");
        drawerDevices.setText("扩展屏（眼镜 / 投屏器）：未接入\n外放（耳机 / 音箱）：未接入\n麦克风：手机麦克风（在用）");
        startedAtMs = System.currentTimeMillis();
        startTimer();
        updateMicButton();
        toggleSource();          // 先把"原文 开/关"的外观刷成与 showSource 一致
        showSource = true;       // toggleSource 会翻转，这里翻回来
        sourceToggle.setText("原文 开");
        sourceToggle.setBackgroundResource(R.drawable.bg_pill_active);
        sourceToggle.setTextColor(getColor(R.color.on_brand));

        statusLine.setText("");

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

        // ⚠️ 4.53 修：**必须**在 client 建好之后才拉房间详情。
        // 原来这行写在 client = new LanClient(...) 之前，于是线程里 NPE、被 catch 静默吞掉，
        // 表现就是顶部一直是「#------」占位、角色永远显示「参与者」。
        loadRoomHeader();

        micUploadButton = findViewById(R.id.roomUpload);
        // 隐藏的「开始同传」：原型里没有它，开麦即开始上传；这里只留一个落点备用
        micUploadButton.setOnClickListener(v -> toggleMic());
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
        timerRunning = false;
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
            public void onFrame(final JSONObject message) {
                final JSONObject frame = message == null ? null : message.optJSONObject("frame");
                if (frame == null) return;
                ui.post(() -> {
                    org.json.JSONArray linesArray = frame.optJSONArray("lines");
                    String[] lines = null;
                    if (linesArray != null) {
                        lines = new String[linesArray.length()];
                        for (int i = 0; i < lines.length; i++) lines[i] = linesArray.optString(i, "");
                    }
                    org.json.JSONArray missArray = frame.optJSONArray("termsMiss");
                    String[] missing = null;
                    if (missArray != null) {
                        missing = new String[missArray.length()];
                        for (int i = 0; i < missing.length; i++) missing[i] = missArray.optString(i, "");
                    }
                    applyFrame(frame.optString("text", ""), lines, frame.optString("source", ""),
                            frame.optBoolean("partial", false), missing);
                });
            }

            @Override
            public void onRoomClosed(String reason) {
                ui.post(() -> leaveBecauseClosed(reason));
            }

            @Override
            public void onState(String message) {
                // 4.53：这些是**调试**信息（"发言权推送已连上/断开"），不该占用户的状态行。
                // 真正需要用户知道的事（连接失败、被顶替、会议结束）走 onError / showKicked /
                // leaveBecauseClosed 三条通道。这里只留一行 logcat，方便排查。
                android.util.Log.i("LeionRoom", "floor-socket: " + message);
            }

            @Override
            public void onOnlineChanged(boolean online) {
                ui.post(() -> wsOnline = online);
            }
        });
        floorSocket.start();
    }

    // ── 开麦 / 关麦 ──────────────────────────────────────────────────────
    /**
     * 底部主按钮：**开麦**（原型只有一个"开麦/关麦"）。
     *
     * <p>它同时管两件事：抢发言权 + 开始/停止上传音频。
     * 以前这是两个按钮（开麦 + 开始同传），对用户是同一个动作却要点两下，
     * 而且"开了麦却没上传"会表现成"我说话了但没有字幕"。
     */
    private void toggleMic() {
        if (mic != null || holding) {
            // 关麦：停上传 + 放发言权（顺序反过来会让服务端把人顶掉再收到释放）
            if (mic != null) {
                mic.stop();
                mic = null;
            }
            updateMicButton();
            hintLine.setText("已结束发言");
            new Thread(() -> {
                try {
                    client.floorAction(roomKey, "release");
                } catch (Exception ignored) {
                    // 服务端 15 秒租约兜底
                }
            }, "room-release").start();
            return;
        }
        ensureRecordPermission(this::takeFloorThenUpload);
    }

    /** 开麦按钮的外观：空闲=蓝绿胶囊，发言中=红色胶囊+呼吸；文案带秒数。 */
    private void updateMicButton() {
        boolean live = mic != null || holding;
        micButton.setBackgroundResource(live ? R.drawable.btn_mic_live : R.drawable.btn_mic_idle);
        micButton.setTextColor(getColor(R.color.on_brand));
        if (live) {
            long seconds = holdingSinceMs > 0 ? (System.currentTimeMillis() - holdingSinceMs) / 1000 : 0;
            micButton.setText(String.format(java.util.Locale.US, "正在发言 %02d:%02d", seconds / 60, seconds % 60));
            if (micButton.getAnimation() == null) {
                micButton.startAnimation(android.view.animation.AnimationUtils.loadAnimation(this, R.anim.mic_pulse));
            }
        } else {
            micButton.setText("点击开麦");
            micButton.clearAnimation();
        }
        micButton.setEnabled(true);
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
                if ("lock".equals(action)) addSystemEvent((holder.isEmpty() ? "发言" : holder + " 的发言") + "已锁定");
                if ("unlock".equals(action)) addSystemEvent("发言已解锁");
                if ("force-release".equals(action)) addSystemEvent("发起者收回了发言权");
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
        boolean iAmHost = myName.equals(hostName());
        if (holding && holdingSinceMs == 0L) holdingSinceMs = System.currentTimeMillis();
        if (!holding) holdingSinceMs = 0L;
        // 外观统一交给 updateMicButton（4.52：胶囊 + 发言中红色 + 呼吸）
        updateMicButton();

        // 锁定按钮的文案必须与"我能不能按"一致（4.44 修）。
        //
        // 原来的写法是所有人统一 `isLocked ? "解锁" : "锁定发言"`，于是：A（发起者）锁了麦，
        // B 那边明明按不动，按钮却写着「解锁」—— 用户会以为自己也握着这把锁，
        // 点了没反应就更困惑。规则应该是：
        //   · 持麦者：自己锁自己 / 自己解自己      → 解锁 / 锁定发言
        //   · 发起者：可以解**他人**的锁           → 解锁（他人）/ 锁定发言（他人）
        //   · 其他人：不能动锁，只显示状态          → 发言已锁定 / 锁定发言（灰）
        boolean canLock = holding || (anyHolder && iAmHost);
        if (holding) {
            lockButton.setText(isLocked ? "解锁" : "锁定发言");
        } else if (anyHolder && iAmHost) {
            lockButton.setText(isLocked ? "解锁（他人）" : "锁定他人");
        } else if (isLocked) {
            lockButton.setText("发言已锁定");
        } else {
            lockButton.setText("锁定发言");
        }
        lockButton.setEnabled(canLock);
        lockButton.setAlpha(canLock ? 1f : 0.5f);
        speakerBar.setText(anyHolder ? ("发言人：" + holder + (isLocked ? "（已锁定）" : "")) : "麦克风空闲");
    }

    /**
     * 兜底：问一次"这场还在吗"（4.46）。
     *
     * <p>为什么要有：WS 的 `closed` 推送需要**新服务端**；老服务端不会推，而
     * `/floor` 对已结束的会议照样返回状态 —— 于是屋里的人一脸茫然地留着。
     * 房间详情从 4.46 起带 `closed`，这是老服务端也能用的唯一信号。
     */
    private void checkRoomStillOpen() {
        new Thread(() -> {
            JSONObject info = null;
            try {
                info = client.orgRoomInfo(roomKey);
            } catch (Exception ignored) {
                return;                       // 网络抖动不算"散会"
            }
            if (info == null) return;
            JSONObject room = info.optJSONObject("room");
            boolean closed = (room != null && room.optBoolean("closed", false))
                    || info.optBoolean("closed", false);
            if (closed) {
                ui.post(() -> leaveBecauseClosed("发起者已结束这场会议"));
            }
        }, "room-still-open").start();
    }

    /**
     * 会议结束了（发起者退出）：提示原因并退出房间（4.44）。
     *
     * <p>以前发起者一退，服务端把房间标成 closed，但屋里的人什么都不知道 ——
     * 界面照旧、按钮照旧，直到某次操作失败。现在服务端会主动推送并断开连接，
     * 轮询那条路也判 `closed`/410 作为兜底。
     */
    private void leaveBecauseClosed(String reason) {
        if (isFinishing()) return;
        String message = "会议已结束"
                + (reason == null || reason.isEmpty() ? "" : "（" + reason + "）")
                + "，已退出房间";
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        hintLine.setText(message);
        stopUpload(null);
        if (mic != null) { mic.stop(); mic = null; }
        ui.postDelayed(this::finish, 1200);
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
    /** 先抢麦，成功才上传（M1/M3 之后这是"开麦"的唯一实现）。 */
    private void takeFloorThenUpload() {
        final MicUploader.Listener listener = new MicUploader.Listener() {
            @Override
            public void onUploadStatus(String message) {
                ui.post(() -> hintLine.setText(message));
            }

            @Override
            public void onUploadError(String message) {
                ui.post(() -> {
                    hintLine.setText("上传出错：" + message);
                    if (mic != null) {
                        mic.stop();
                        mic = null;
                    }
                    updateMicButton();
                });
            }

            @Override
            public void onLevel(float rms, float peak) {
                // 电平只做静默反馈（不刷界面，避免每帧刷新拖慢字幕）
            }
        };
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
    /** 先抢麦再上传（开麦按钮走这条）。 */
    private void ensureRecordPermission() {
        ensureRecordPermission(this::takeFloorThenUpload);
    }

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
                    // 兜底：每 5 轮问一次"这场还在不在"（4.46）。
                    // 为什么需要它：老服务端的 /floor 对已结束的会议照样返回状态，
                    // 客户端没有任何信号可用 —— 而房间详情里有 closed 字段。
                    pollTicks += 1;
                    if (pollTicks % 5 == 0) checkRoomStillOpen();
                    // 单会话：被别处登录顶掉时，房间里的轮询是最早能发现的地方
                    // （点按钮才发现的话，用户已经对着"没反应"愣了几秒）
                    if (body != null && body.optInt("httpStatus", 0) == 401) {
                        showKicked(body.optString("hint", body.optString("error", "")));
                        return;
                    }
                    // 会议已结束（发起者退出）：WS 那条路会立刻收到 closed，
                    // 这里是兜底 —— WS 断了的时候靠轮询也能发现，不能把人留在空屋里。
                    if (body != null && (body.optBoolean("closed", false)
                            || body.optInt("httpStatus", 0) == 410)) {
                        leaveBecauseClosed(body.optString("error", "会议已结束"));
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

    /**
     * 上传状态变了 → 刷新**开麦按钮**（4.52 起上传与开麦合成一个按钮）。
     *
     * <p>保留这个函数名，是因为它被"被顶替/掉线/出错"好几处调用；
     * 现在它只负责把外观同步过去，隐藏的 roomUpload 不再参与显示。
     */
    private void updateUploadButton() {
        updateMicButton();
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

    /** 拉一次房间详情：房间号、主题、成员数、我是不是发起者（4.52 顶部两行要用）。 */
    private void loadRoomHeader() {
        new Thread(() -> {
            JSONObject info = null;
            try {
                info = client.orgRoomInfo(roomKey);
            } catch (Exception ignored) {
                return;
            }
            if (info == null) return;
            final JSONObject room = info.optJSONObject("room");
            final org.json.JSONArray members = info.optJSONArray("members");
            ui.post(() -> {
                if (room != null) {
                    String code = room.optString("code", "");
                    if (!code.isEmpty()) codeView.setText("#" + code);
                    String name = room.optString("name", "");
                    if (!name.isEmpty()) titleView.setText(name);
                    String host = room.optString("host", "");
                    iAmHost = myName != null && myName.equals(host);
                    roleTag.setText(iAmHost ? "发起者" : "参与者");
                    roleTag.setBackgroundResource(iAmHost ? R.drawable.bg_chip_brand : R.drawable.bg_chip);
                    roleTag.setTextColor(getColor(iAmHost ? R.color.brand : R.color.ink_soft));
                }
                if (members != null) {
                    membersView.setText(members.length() + " 人");
                    renderMembers(members);
                }
            });
        }, "room-header").start();
    }

    /**
     * 抽屉里的成员列表：头像首字 + 姓名 +（发起者才有的）管理操作。
     *
     * <p>管理者能做的两件事对应两处真实能力：
     *   · 「移出」→ `POST /org/rooms/:id/members/remove`（服务端会顺手释放他占着的麦）；
     *   · 「解除锁定」→ 现有 `force-release`（只对当前持麦者出现，且仅发起者可见）。
     */
    private void renderMembers(org.json.JSONArray members) {
        if (membersList == null || members == null) return;
        membersList.removeAllViews();
        for (int i = 0; i < members.length(); i++) {
            JSONObject one = members.optJSONObject(i);
            String name = one == null ? members.optString(i, "") : one.optString("username", "");
            if (name.isEmpty()) continue;

            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(android.view.Gravity.CENTER_VERTICAL);
            int pad = dp(4);
            row.setPadding(0, pad, 0, pad);

            TextView avatar = new TextView(this);
            avatar.setText(firstChar(name));
            avatar.setGravity(android.view.Gravity.CENTER);
            avatar.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11);
            avatar.setTextColor(getColor(R.color.brand));
            avatar.setBackgroundResource(R.drawable.bg_avatar);
            int dot = dp(22);
            row.addView(avatar, new LinearLayout.LayoutParams(dot, dot));

            TextView label = new TextView(this);
            String suffix = name.equals(myName) ? "（我）" : "";
            label.setText(name + suffix);
            label.setTextColor(getColor(R.color.ink));
            label.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
            LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            labelParams.leftMargin = dp(8);
            row.addView(label, labelParams);

            // 管理者操作：只对"别人"显示移出（移自己要走退出，那是结束会议）
            if (iAmHost && !name.equals(myName)) {
                TextView remove = new TextView(this);
                remove.setText("移出");
                remove.setTextColor(getColor(R.color.err));
                remove.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11);
                remove.setPadding(dp(8), dp(4), dp(4), dp(4));
                remove.setOnClickListener(v -> confirmRemove(name));
                row.addView(remove, new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            }
            membersList.addView(row);
        }

        // 当前持麦者 + 已锁定时，发起者可以"解除锁定"（复用 force-release）
        if (iAmHost && locked && holder() != null && !holder().isEmpty()) {
            TextView force = new TextView(this);
            force.setText("解除 " + holder() + " 的锁定");
            force.setTextColor(getColor(R.color.brand));
            force.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11);
            force.setPadding(0, dp(6), 0, dp(6));
            force.setOnClickListener(v -> act("force-release"));
            membersList.addView(force);
        }
    }

    private String holder() {
        String text = speakerBar.getText() == null ? "" : speakerBar.getText().toString();
        if (!text.startsWith("发言人：")) return "";
        text = text.substring("发言人：".length());
        int cut = text.indexOf('（');
        return cut > 0 ? text.substring(0, cut) : text;
    }

    /** 移出成员要二次确认：这是个不可撤销（对方视角）的动作。 */
    private void confirmRemove(final String name) {
        new android.app.AlertDialog.Builder(this)
                .setTitle("移出 " + name)
                .setMessage("他会立刻离开这场会议；如果他正在发言，麦克风会被释放。"
                        + "（他仍可以凭邀请码重新加入）")
                .setNegativeButton("取消", null)
                .setPositiveButton("移出", (dialog, which) -> doRemove(name))
                .show();
    }

    private void doRemove(final String name) {
        new Thread(() -> {
            JSONObject result = null;
            String failure = "";
            try {
                result = client.orgRemoveMember(roomKey, name);
            } catch (Exception e) {
                failure = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final JSONObject body = result;
            final String error = failure;
            ui.post(() -> {
                if (body == null || !body.optBoolean("ok", false)) {
                    String reason = body == null ? error : body.optString("error", error);
                    Toast.makeText(this, "移出失败：" + reason, Toast.LENGTH_LONG).show();
                    return;
                }
                addSystemEvent(name + " 已被移出会议");
                org.json.JSONArray members = body.optJSONArray("members");
                if (members != null) {
                    membersView.setText(members.length() + " 人");
                    renderMembers(members);
                }
                loadRoomHeader();
            });
        }, "room-remove-member").start();
    }

    /** 复制邀请码（对方凭它入会）。 */
    private void copyInvite() {
        String text = codeView.getText() == null ? "" : codeView.getText().toString();
        text = text.replace("#", "").trim();
        if (text.isEmpty()) {
            Toast.makeText(this, "还没拿到邀请码", Toast.LENGTH_SHORT).show();
            return;
        }
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("邀请码", text));
        }
        Toast.makeText(this, "邀请码已复制：" + text, Toast.LENGTH_SHORT).show();
    }

    /** 「人员与设备」抽屉：点右侧悬浮条开，再点一次/点关闭收。 */
    private void toggleDrawer() {
        boolean open = drawer.getVisibility() == View.VISIBLE;
        drawer.setVisibility(open ? View.GONE : View.VISIBLE);
        if (!open) loadRoomHeader();
    }

    /** 会议计时：进房开始走，退出即停。 */
    private void startTimer() {
        timerRunning = true;
        ui.post(new Runnable() {
            @Override
            public void run() {
                if (!timerRunning || isFinishing()) return;
                long seconds = (System.currentTimeMillis() - startedAtMs) / 1000;
                timerView.setText(String.format(java.util.Locale.US, "%02d:%02d",
                        seconds / 60, seconds % 60));
                ui.postDelayed(this, 1000);
            }
        });
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
        addSystemEvent(message);
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
        // 手机-only：不需要设备名；只显示连接状态。
        // 4.46：服务端版本老的时候要**说出来** —— 老服务端不会推"会议结束"，
        // 用户会以为是"点了没反应"，而不是"服务器没更新"。
        ui.post(() -> {
            // 连上了就把状态行清空（"已连接 · 40×3"是开发期信息，用户不需要看）。
            statusLine.setText("");
            // 但"服务端版本较旧"是**会影响功能**的，必须说，而且要说清后果。
            if (!client.hasFeature("room-closed-push")) {
                statusLine.setText("服务端版本较旧：会议结束时不会主动通知");
            }
        });
    }

    @Override
    public void onFrame(String speaker, String lang, String[] lines, String text,
                        String source, String sourceLang, boolean partial, String[] termsMissing) {
        ui.post(() -> applyFrame(text, lines, source, partial, termsMissing));
    }

    /**
     * 渲染一帧字幕。**长轮询与 WS 推送都走这里**（4.43），否则两条路各写一份，
     * 迟早出现"长轮询能显示、WS 显示不出来"这种只在一半设备上出现的分裂。
     */
    private void applyFrame(String text, String[] lines, String source, boolean partial, String[] termsMissing) {
        String target = (text == null || text.isEmpty())
                ? (lines == null ? "" : String.join("\n", lines)) : text;
        renderSegment(target == null ? "" : target, source == null ? "" : source, partial);
        if (partial) {
            hintLine.setText("正在生成…");
        } else if (termsMissing != null && termsMissing.length > 0) {
            hintLine.setText("术语未按规范写法出现：" + String.join("、", termsMissing));
        } else {
            hintLine.setText("");
        }
    }

    /**
     * 把一帧字幕落到中央字幕流里（M1）。
     *
     * <p>两条规矩，都是从旧界面的 `SubtitleList` 学来的：
     * <ol>
     *   <li><b>partial 帧原位更新</b>：同一个片段在"生成中 → 定稿"之间只占一张卡。
     *       新起一条会让同一句话出现两次，用户会以为翻译重复了。</li>
     *   <li><b>新句从下往上推</b>：追加后自动滚到底，读到的是最新的那句话。</li>
     * </ol>
     */
    private void renderSegment(String target, String source, boolean partial) {
        if (target.isEmpty() && source.isEmpty()) return;
        if (emptyView.getVisibility() == View.VISIBLE) emptyView.setVisibility(View.GONE);

        boolean mine = myName != null && !myName.isEmpty() && holding;

        // ── 同一段判定（4.53）────────────────────────────────────────
        // 一句话会来三帧：增量 / 定稿 / 校对修订。它们的**原文相同**，
        // 所以"原文相同"就是同一段；原文缺失时退化成"上一条还是增量态"也算同一段。
        String key = source.isEmpty() ? null : source;
        boolean sameSegment = lastSegmentView != null && (
                // ① 上一帧还是增量态 → 这一帧一定是它的定稿/校对修订。
                //    这条最硬：产线是**逐句串行**的，一句话的增量之后不可能突然变成另一句。
                //    为什么不能只靠原文：增量帧的原文是**流式不完整**的，定稿帧才是完整原文，
                //    两者不相等 —— 只按原文判，恰好会把"增量 + 定稿"拆成两条（用户报的现象）。
                lastWasPartial
                        // ② 原文一致 → 同一句（校对修订帧走这条，它带的原文与定稿相同）
                        || (key != null && key.equals(lastSegmentKey))
                        // ③ 增量帧没带原文、且上一张就是它
                        || (key == null && partial));
        if (sameSegment) {
            lastSegmentTarget.setText(target);
            if (!source.isEmpty()) lastSegmentSource.setText(source);
            boolean hasSource = lastSegmentSource.getText() != null && lastSegmentSource.getText().length() > 0;
            lastSegmentSource.setVisibility(showSource && hasSource ? View.VISIBLE : View.GONE);
            lastSegmentState.setText(partial ? "识别中…" : "已完成");
            lastSegmentState.setTextColor(getColor(partial ? R.color.accent : R.color.ok));
            if (key != null) lastSegmentKey = key;
            lastWasPartial = partial;
            scrollToBottom();
            return;
        }

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(mine ? R.drawable.bg_subtitle_self : R.drawable.bg_card);
        int pad = dp(12);
        card.setPadding(pad, pad, pad, pad);
        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardParams.bottomMargin = dp(8);
        card.setLayoutParams(cardParams);

        // 卡片头部：头像 + 姓名 + 源语言标签 + 状态标签
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(android.view.Gravity.CENTER_VERTICAL);

        TextView avatar = new TextView(this);
        avatar.setText(mine ? "我" : firstChar(speakerBarName()));
        avatar.setGravity(android.view.Gravity.CENTER);
        avatar.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
        avatar.setTextColor(getColor(R.color.brand));
        avatar.setBackgroundResource(R.drawable.bg_avatar);
        int dot = dp(24);
        head.addView(avatar, new LinearLayout.LayoutParams(dot, dot));

        TextView name = new TextView(this);
        name.setText(speakerBarName());
        name.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
        name.setTextColor(getColor(R.color.ink_soft));
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nameParams.leftMargin = dp(8);
        head.addView(name, nameParams);

        TextView langTag = new TextView(this);
        langTag.setText(mine ? "我说的话" : "对方");
        langTag.setBackgroundResource(R.drawable.bg_chip);
        langTag.setTextColor(getColor(R.color.ink_faint));
        langTag.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10);
        langTag.setPadding(dp(6), dp(2), dp(6), dp(2));
        LinearLayout.LayoutParams langParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        langParams.leftMargin = dp(8);
        head.addView(langTag, langParams);

        View spacer = new View(this);
        head.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1f));

        final TextView state = new TextView(this);
        state.setText(partial ? "识别中…" : "已完成");
        state.setTextColor(getColor(partial ? R.color.accent : R.color.ok));
        state.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 10);
        head.addView(state, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        card.addView(head);

        // 原文（小字、次要色）——受"原文显示"开关控制
        final TextView sourceLine = new TextView(this);
        sourceLine.setText(source);
        sourceLine.setTextColor(getColor(R.color.ink_soft));
        sourceLine.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
        sourceLine.setVisibility(!showSource || source.isEmpty() ? View.GONE : View.VISIBLE);
        LinearLayout.LayoutParams sourceParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        sourceParams.topMargin = dp(6);
        card.addView(sourceLine, sourceParams);

        // 译文（大字、加粗）
        final TextView targetLine = new TextView(this);
        targetLine.setText(target);
        targetLine.setTextColor(getColor(R.color.ink));
        targetLine.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15);
        targetLine.setTypeface(targetLine.getTypeface(), android.graphics.Typeface.BOLD);
        targetLine.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams targetParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        targetParams.topMargin = dp(6);
        card.addView(targetLine, targetParams);

        subtitleList.addView(card);
        lastSegmentView = card;
        lastSegmentSource = sourceLine;
        lastSegmentTarget = targetLine;
        lastSegmentState = state;
        lastSegmentKey = key != null ? key : target;
        lastWasPartial = partial;

        // 超过上限就丢最老的那张（连同它的引用）
        while (subtitleList.getChildCount() > MAX_SEGMENTS + 1) {   // +1 是 roomEmpty
            View oldest = subtitleList.getChildAt(1);
            if (oldest == null || oldest == lastSegmentView) break;
            subtitleList.removeViewAt(1);
        }
        scrollToBottom();
    }

    /**
     * 系统事件行（原型：以**弱化的居中文字**出现在字幕流里）。
     *
     * <p>它与字幕卡片的区别是刻意的：事件不是"谁说了什么"，所以不带头像、不加边框、
     * 用次要色居中 —— 扫读字幕时它退到背景里，需要时又能看到。
     */
    private void addSystemEvent(String text) {
        if (text == null || text.isEmpty()) return;
        if (emptyView.getVisibility() == View.VISIBLE) emptyView.setVisibility(View.GONE);
        TextView event = new TextView(this);
        event.setText("— " + text + " —");
        event.setGravity(android.view.Gravity.CENTER);
        event.setTextColor(getColor(R.color.ink_faint));
        event.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11);
        event.setPadding(0, dp(6), 0, dp(6));
        subtitleList.addView(event);
        scrollToBottom();
    }

    private void scrollToBottom() {
        subtitleScroll.post(() -> subtitleScroll.fullScroll(View.FOCUS_DOWN));
    }

    private String speakerBarName() {
        String text = speakerBar.getText() == null ? "" : speakerBar.getText().toString();
        if (text.startsWith("发言人：")) {
            text = text.substring("发言人：".length());
        }
        int cut = text.indexOf('（');
        if (cut > 0) text = text.substring(0, cut);
        return text.isEmpty() ? "对方" : text;
    }

    private static String firstChar(String text) {
        return text == null || text.isEmpty() ? "?" : text.substring(0, 1);
    }

    /** dip → px（布局里能用 @dimen，代码里这两处间距就地换算，别到处塞 token）。 */
    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    /** M3：原文显示开关。已经画出来的卡片也要跟着变。 */
    private void toggleSource() {
        showSource = !showSource;
        sourceToggle.setText(showSource ? "原文 开" : "原文 关");
        sourceToggle.setBackgroundResource(showSource ? R.drawable.bg_pill_active : R.drawable.bg_pill);
        sourceToggle.setTextColor(getColor(showSource ? R.color.on_brand : R.color.ink));
        for (int i = 0; i < subtitleList.getChildCount(); i++) {
            View child = subtitleList.getChildAt(i);
            if (!(child instanceof LinearLayout)) continue;
            LinearLayout card = (LinearLayout) child;
            if (card.getChildCount() < 3) continue;
            View sourceView = card.getChildAt(1);   // 头、原文、译文
            if (sourceView instanceof TextView && sourceView != lastSegmentTarget) {
                TextView line = (TextView) sourceView;
                boolean hasText = line.getText() != null && line.getText().length() > 0;
                line.setVisibility(showSource && hasText ? View.VISIBLE : View.GONE);
            }
        }
    }

    @Override
    public void onError(String message) {
        ui.post(() -> statusLine.setText("连接异常：" + message));
    }
}