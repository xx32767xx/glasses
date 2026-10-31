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
    private android.widget.ImageButton lockButton;

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

    // ── 底部：原文显示开关（M3，4.55 起是文字 + Switch）──
    private android.widget.Switch sourceSwitch;
    private boolean showSource = true;
    /** 防止 setChecked 触发监听又回头改一次（会来回抖）。 */
    private boolean syncingSwitch = false;

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

    /** 抽屉打开期间的刷新间隔：成员变化没有推送，只能轮询，但只在抽屉开着时轮。 */
    private static final long DRAWER_REFRESH_MS = 2500L;
    private final Runnable drawerTick = new Runnable() {
        @Override
        public void run() {
            if (drawer.getVisibility() != View.VISIBLE || isFinishing()) return;
            loadRoomHeader();
            ui.postDelayed(this, DRAWER_REFRESH_MS);
        }
    };

    /** 会议计时（从进房那一刻算）。 */
    private long startedAtMs = 0L;
    private boolean timerRunning = false;

    private boolean holding = false;
    private boolean locked = false;
    private boolean pollScheduled = false;
    private MicUploader mic;
    /** 4.76：实时传声——播放别人的声音。 */
    private RoomAudioPlayer audioPlayer;
    // 4.97：「正在听」胶囊按钮已删除（倾听全自动），所以不再需要这个引用
    /** 我是不是正在听（与服务端的 listen 开关保持一致）。 */
    private boolean listening = false;
    /**
     * 我**想不想**听（4.91）。
     *
     * <p>为什么要和 {@link #listening} 分开：自己说话时必须暂停播放（否则听到自己的回声），
     * 但"我想听"这个意图不该被抹掉 —— 说完要自动恢复。缺省**开**：
     * 会议里"听得到别人"是预期行为，不该让每个人每次都手动点一下。
     */
    private boolean listenWanted = true;
    /**
     * 当前持麦者（4.95）。
     *
     * <p>为什么要单独存一份：以前"谁在说话"是从**顶部那行文字**里反向解析出来的
     * （`speakerBar.getText()` 去掉前缀）—— 而没人在麦上时那行文字是「麦克风空闲」，
     * 解析出来就成了一个叫「麦克风空闲」的发言人。状态文字不能当数据用。
     */
    private String holderName = "";
    /**
     * 我**读**哪种语言的字幕（5.00）。
     *
     * <p>三语会议里同一句会产出两份译文（比如葡语一份、英语一份），这台设备只该显示自己那份。
     * 现在"说"和"读"是同一个值（入会时登记的 `speakLang`）—— 要分开（比如"我说中文但我能读葡语"）
     * 就得再加一个字段和一处 UI，那是下一轮的事，这里先把规则写明。
     */
    private String hearLang = "";
    /**
     * 上一次**已经登记到服务端**的参会语言（5.06）。
     *
     * <p>用户可以在设置页随时换语言，而服务端的 `room_members.lang` 是"入会那一刻"的值。
     * 一旦两者不一致：大脑的听众语言集合里没有新语言（**一句都不译**），
     * 按语言扇出时这台设备也收不到新语言的字幕。所以这里在计时循环里比对，
     * 变了就本地先切、再去服务端重新登记一次（见 {@link #syncSpokenLanguage()}）。
     */
    private String syncedSpeakLang = "";
    /** 邀请码（重新登记语言时要用它；来自房间详情） */
    private String roomCode = "";
    private Runnable pendingAfterPermission;
    private Button micUploadButton;
    private long lastHeartbeat = 0L;
    /** 轮询计数（4.46）：用来"每 5 轮"做一次房间状态兜底检查。 */
    private int pollTicks = 0;

    /** 发言权推送通道（4.35）。它只让"谁在说话"更快到达；断了就靠轮询。 */
    private FloorSocket floorSocket;
    private boolean wsOnline = false;

    @Override
    protected void attachBaseContext(android.content.Context base) {
        // 4.56：界面语言必须在这里换（三套资源在 values-en / values-pt-rBR）
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 4.56：换语言会 recreate 本页，而本顿重建会**打断正在进行的发言**。
        // 所以只有没开麦时才自检；开着麦就先用旧语言，等这一段说完再说。
        if (mic == null) UiLang.trackShown(this);
    }

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
        sourceSwitch = findViewById(R.id.roomSourceSwitch);

        copyView.setOnClickListener(v -> copyInvite());
        infoBar.setOnClickListener(v -> toggleDrawer());
        findViewById(R.id.roomDrawerClose).setOnClickListener(v -> toggleDrawer());
        sourceSwitch.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (syncingSwitch) return;
            showSource = isChecked;
            syncSourceVisibility();
            addSystemEvent(isChecked ? getString(R.string.sys_source_on) : getString(R.string.sys_source_off));
        });

        addSystemEvent(getString(R.string.sys_meeting_started));

        // 外设（投屏/扩声）**还没接入**：这里只把事实写清楚，不做假开关。
        castState.setText(getString(R.string.room_cast_value));
        audioState.setText(getString(R.string.room_audio_none));
        micState.setText(getString(R.string.room_mic_phone));
        drawerDevices.setText(getString(R.string.room_devices_detail));
        startedAtMs = System.currentTimeMillis();
        startTimer();
        updateMicButton();
        syncSourceVisibility();  // 把「原文」开关刷成与 showSource 一致

        statusLine.setText("");

        SharedPreferences prefs = getSharedPreferences("leion", MODE_PRIVATE);
        String host = prefs.getString("host", "");
        String secret = prefs.getString("secret", "");
        myName = prefs.getString("termsUser", "");
        // 5.00：这台设备读哪种语言的字幕 = 入会时登记的说话语言。
        // 纯听众（从不开麦）也要有值，否则三语会议里会收到两种语言的帧、都显示出来。
        hearLang = prefs.getString("speakLang", "");
        if (hearLang == null) hearLang = "";
        // 5.06：会中换语言时用它比对（见 syncSpokenLanguage）
        syncedSpeakLang = hearLang;
        String token = prefs.getString("accountToken", "");

        client = new LanClient(host, secret, this);
        // 4.74：告诉轮询「我在哪个房间」。多场会并发时，
        // 字幕才不会把别的房间的句子画到这里来。
        client.setRoom(roomKey);
        // 4.96：上传音频时自报发言人（服务端用它给字幕落名字，不再猜"现在谁持麦"）
        client.setSpeaker(myName);
        getSharedPreferences("leion", MODE_PRIVATE).edit().putString("roomId", roomKey).apply();
        if (token != null && !token.isEmpty()) client.setToken(token);
        if (myName != null && !myName.isEmpty()) client.setUser(myName);
        client.start();
        startFloorSocket(host, secret, token);

        // ⚠️ 4.53 修：**必须**在 client 建好之后才拉房间详情。
        // 原来这行写在 client = new LanClient(...) 之前，于是线程里 NPE、被 catch 静默吞掉，
        // 表现就是顶部一直是「#------」占位、角色永远显示「参与者」。
        loadRoomHeader();

        // 5.07：顶部那一行「#邀请码 复制邀请 我说中文 发起者」里的**语言标签原来永远是中文** ——
        // 布局里写死的缺省值（`@string/rooms_speak_zh`），而 `modeTag` 拿到之后从没被赋过值。
        // 于是选葡语、选英语，那一格都一直显示「我说中文」（用户实测报的，是个老 bug）。
        updateModeTag();

        micUploadButton = findViewById(R.id.roomUpload);
        // 4.76 的实时传声播放器；4.97 起**没有**手动开关（那颗胶囊已从底部删掉）——
        // 倾听全自动：进房间就听、自己说话时暂停防回声、说完恢复、重连重新订阅（见 applyListenState）。
        audioPlayer = new RoomAudioPlayer();
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
        if (audioPlayer != null) {
            audioPlayer.stop();
            audioPlayer = null;
        }
        listening = false;
        timerRunning = false;
        stopDrawerRefresh();
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
                        String message = getString(R.string.sys_dropped, released)
                                + (body.optBoolean("releasedLocked", false) ? getString(R.string.sys_locked_suffix) : "");
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
                            frame.optBoolean("partial", false), missing,
                            // 4.96：用 LanClient.speakerNameOf —— 它把 JSON null 当成"没有"，
                            // 不然 optString 会返回字符串 "null"，界面上就出现一个叫 null 的发言人
                            LanClient.speakerNameOf(frame),
                            // 5.00：这一帧是译成哪种语言的那一份
                            frame.isNull("lang") ? "" : frame.optString("lang", ""),
                            // 5.12：附带提示（"本场语言相同 · 无需翻译"）
                            LanClient.noticeOf(frame));
                });
            }

            @Override
            public void onRoomClosed(String reason) {
                ui.post(() -> leaveBecauseClosed(reason));
            }

            @Override
            public void onRemoved(String reason) {
                ui.post(() -> leaveBecauseRemoved());
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
                ui.post(() -> {
                    wsOnline = online;
                    // 4.91：**重连之后必须重新订阅**。服务端的 listen 开关是挂在**连接**上的
                    // （`conn.listen`），reconnect 就是一条新连接 —— 不重发的话，
                    // 界面还显示"在听"，服务端却已经不发一块音频了（症状：声音突然没了）。
                    if (online && listenWanted) {
                        if (floorSocket != null) floorSocket.sendListen(true);
                        if (audioPlayer != null && listening) audioPlayer.start();
                    }
                });
            }

            @Override
            public void onAudioRate(int rate) {
                // 服务端告诉我们这一路音频的采样率（4.91）：手机录音可能降到 44.1k，
                // 播放器按 16k 硬放会变成快放/慢放，所以这里跟着改。
                ui.post(() -> {
                    if (audioPlayer != null) audioPlayer.setSampleRate(rate);
                });
            }

            @Override
            public void onAudio(byte[] chunk) {
                // 网络线程上：只往队列里放，不碰界面
                if (audioPlayer != null && listening) audioPlayer.offer(chunk);
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
            hintLine.setText(getString(R.string.st_speaking_done));
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
            micButton.setText(getString(R.string.room_speaking_timer,
                    String.format(java.util.Locale.US, "%02d:%02d", seconds / 60, seconds % 60)));
            if (micButton.getAnimation() == null) {
                micButton.startAnimation(android.view.animation.AnimationUtils.loadAnimation(this, R.anim.mic_pulse));
            }
        } else {
            micButton.setText(getString(R.string.room_mic_idle));
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
                    Toast.makeText(this, getString(R.string.toast_request_failed, failure), Toast.LENGTH_LONG).show();
                    return;
                }
                int status = body.optInt("_status", 0);
                if (status == 401) {
                    showKicked(ServerText.from(this, body, ""));
                    return;
                }
                if (status >= 400 || body.optBoolean("ok", false) == false) {
                    // 409 = 被规则拒绝（别人锁定中），这是业务状态，不是网络错误
                    String reason = ServerText.from(this, body, "");
                    Toast.makeText(this, reason.isEmpty() ? getString(R.string.st_rejected_http, status) : reason,
                            Toast.LENGTH_LONG).show();
                    if (action.equals("take")) hintLine.setText(reason);
                    return;
                }
                String holder = holderOf(body);
                takingChanged(holder, body.optBoolean("locked", false));
                if ("lock".equals(action)) addSystemEvent(holder.isEmpty() ? getString(R.string.sys_lock_self) : getString(R.string.sys_lock_other, holder));
                if ("unlock".equals(action)) addSystemEvent(getString(R.string.sys_unlocked));
                if ("force-release".equals(action)) addSystemEvent(getString(R.string.sys_force_released));
                if (body.optString("tookOver", "").length() > 0) {
                    hintLine.setText(getString(R.string.st_took_over, body.optString("tookOver")));
                }
                // 点「开麦」再点回来 = 结束发言：正在上传的话必须跟着停，
                // 否则会出现"麦已经放了、音频还在往识别流里灌"（4.34 修）
                if (!holding && mic != null) {
                    stopUpload(getString(R.string.st_stop_takeover));
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
        holderName = holder == null ? "" : holder.trim();
        holding = !holderName.isEmpty() && holderName.equals(myName);
        locked = isLocked;
        boolean anyHolder = holder != null && !holder.isEmpty();
        boolean iAmHost = myName.equals(hostName());
        if (holding && holdingSinceMs == 0L) holdingSinceMs = System.currentTimeMillis();
        // 4.77 / 4.91：自己开麦时不能放音（手机就在嘴边，放出来就是回声）。
        //
        // ⚠️ 4.91 修掉的那个 bug 就在这里：原来写的是 `if (holding && listening) stopListening()`，
        // 于是**说完话之后倾听再也没打开** —— 而两个人开会本来就是"你说完我说"，
        // 结果每个人一开口就把自己的耳朵关掉了，看起来就像"音频传不到对方"。
        // 现在把"我想听"（listenWanted）与"此刻在放"（listening）分开：
        // 说话时暂停播放但**记得意图**，说完自动恢复。
        applyListenState();
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
        // 4.55：改成图标按钮（上锁 / 解锁），不再写文字。
        // 能不能按还是由权限决定：持麦者能锁自己，发起者能解他人，其他人只能看。
        boolean canLock = holding || (anyHolder && iAmHost);
        boolean showUnlockIcon = isLocked && canLock;
        lockButton.setImageResource(showUnlockIcon ? R.drawable.ic_unlock : R.drawable.ic_lock);
        lockButton.setContentDescription(showUnlockIcon ? getString(R.string.cd_unlock_speak)
                : (isLocked ? getString(R.string.cd_locked) : getString(R.string.cd_lock_speak)));
        lockButton.setEnabled(canLock);
        lockButton.setAlpha(canLock ? 1f : 0.5f);
        speakerBar.setText(anyHolder ? (getString(R.string.room_speaker_prefix) + holder
                + (isLocked ? getString(R.string.room_locked_suffix) : "")) : getString(R.string.room_no_speaker));
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
                ui.post(() -> leaveBecauseClosed(getString(R.string.st_host_closed)));
                return;
            }
            // 4.55：被移出的人**不在成员列表里**了。WS 的 removed 推送通常会先到，
            // 这条是兜底（WS 断线时）。注意只在"确实拉到了成员数组"时才判，
            // 空数组不能当成"我不在了"（否则一次网络抖动就会把人踢出房间）。
            org.json.JSONArray members = info.optJSONArray("members");
            if (members != null && members.length() > 0 && myName != null && !myName.isEmpty()) {
                boolean stillHere = false;
                for (int i = 0; i < members.length(); i++) {
                    JSONObject one = members.optJSONObject(i);
                    String name = one == null ? members.optString(i, "") : one.optString("username", "");
                    if (myName.equals(name)) { stillHere = true; break; }
                }
                if (!stillHere) {
                    ui.post(this::leaveBecauseRemoved);
                }
            }
        }, "room-still-open").start();
    }

    /**
     * 被发起者移出这场会议（4.55）。
     *
     * <p>两条发现路径：WS 的 `removed` 推送（秒级）、轮询时"我不在成员列表里"（兜底）。
     * 无论哪条先到，处理都一样：停上传、说清原因、退出房间。
     */
    private void leaveBecauseRemoved() {
        if (isFinishing()) return;
        Toast.makeText(this, getString(R.string.st_removed), Toast.LENGTH_LONG).show();
        hintLine.setText(getString(R.string.st_removed));
        stopUpload(null);
        if (mic != null) { mic.stop(); mic = null; }
        ui.postDelayed(this::finish, 1200);
    }

    /**
     * 抽屉打开期间的**实时刷新**（4.55）。
     *
     * <p>用户报的问题：抽屉里的人数/成员要重新打开才变。原因是成员变化没有任何推送，
     * 而我只在"打开抽屉"那一刻拉了一次。现在抽屉开着就每 2.5 秒拉一次，
     * 关掉就停（不打开的人不为它付流量）。
     */
    private void startDrawerRefresh() {
        ui.removeCallbacks(drawerTick);
        ui.postDelayed(drawerTick, DRAWER_REFRESH_MS);
    }

    private void stopDrawerRefresh() {
        ui.removeCallbacks(drawerTick);
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
        // 4.58：reason 可能是机器码（WS 推送的 host-left）或服务端中文句子，先翻成当前语言。
        // 以前这里直接把 reason 拼进括号，用户看到的是"会议已结束（host-left），已退出房间"。
        String why = ServerText.of(this, reason);
        String message = (why.isEmpty() ? getString(R.string.st_meeting_closed) : why)
                + getString(R.string.st_left_room_tail);
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
        String message = getString(R.string.st_login_expired_extra, extra);
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        hintLine.setText(message);
        statusLine.setText(message);
        getSharedPreferences("leion", MODE_PRIVATE).edit()
                .remove("accountToken").remove("termsUser").remove("roomHost").apply();
        ui.postDelayed(this::finish, 1500);
    }

    /**
     * 按"要不要听 + 我此刻没在说话"决定really要不要收音频（4.91，4.97 起没有手动开关）。
     *
     * <p>幂等：状态没变就什么都不做（避免每次发言权刷新都重启播放器和重发一条 WS 消息）。
     *
     * <p>4.97：底部那颗「正在听」胶囊删掉了（按钮太多，小屏挤），所以这里不再刷任何按钮，
     * 只剩"放还是不放"这一个决定。要临时静音直接把系统音量按下去即可。
     */
    private void applyListenState() {
        boolean shouldPlay = listenWanted && !holding;
        if (shouldPlay == listening) return;
        listening = shouldPlay;
        if (floorSocket != null) floorSocket.sendListen(shouldPlay);
        if (audioPlayer != null) {
            if (shouldPlay) {
                audioPlayer.start();
            } else {
                audioPlayer.stop();
            }
        }
    }

    /** 停止收音频 + 停止播放（也告诉服务器不要再发）。只在内部状态需要时用。 */
    private void stopListening() {
        listenWanted = false;
        if (!listening) return;
        listening = false;
        if (floorSocket != null) floorSocket.sendListen(false);
        if (audioPlayer != null) audioPlayer.stop();
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
                            Toast.makeText(RoomActivity.this,
                                    getString(R.string.toast_leave_error, ServerText.of(RoomActivity.this, failure)),
                                    Toast.LENGTH_SHORT).show();
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
                    // 4.59：MicUploader 给的就是完整句子（已按界面语言），这里不再套「上传出错：」
                    hintLine.setText(message);
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
                            String reason = ServerText.from(RoomActivity.this, result, error);
                            hintLine.setText(getString(R.string.st_cant_speak,
                        reason.isEmpty() ? getString(R.string.reason_rejected) : reason));
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
            hintLine.setText(getString(R.string.st_no_mic_permission));
            return;
        }
        if (after != null) {
            after.run();
        }
    }

    private void startUpload(MicUploader.Listener listener) {
        mic = new MicUploader(this, client, listener);
        // 我在会里说的语言（建房/加入时选的）决定识别方向，别再用默认值
        String speak = getSharedPreferences("leion", MODE_PRIVATE).getString("speakLang", "zh-CN");
        if (speak != null && !speak.isEmpty()) {
            mic.setLanguage(speak);
            // 5.00：这台设备"读"的语言 = 我说的语言（三语会议只显示自己那份译文）
            hearLang = speak;
        }
        String error = mic.start();
        if (error == null) {
            updateUploadButton();
            hintLine.setText(getString(R.string.st_uploading_mic));
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
                        showKicked(ServerText.from(this, body, ""));
                        return;
                    }
                    // 会议已结束（发起者退出）：WS 那条路会立刻收到 closed，
                    // 这里是兜底 —— WS 断了的时候靠轮询也能发现，不能把人留在空屋里。
                    if (body != null && (body.optBoolean("closed", false)
                            || body.optInt("httpStatus", 0) == 410)) {
                        leaveBecauseClosed(ServerText.from(this, body, getString(R.string.st_meeting_closed)));
                        return;
                    }
                    if (body != null && body.optBoolean("ok", false)) {
                        String released = body.optString("released", "");
                        if (!released.isEmpty() && !"null".equals(released)) {
                            // 服务端把"锁着麦但人已经不在"的那位清掉了（4.42）
                            String message = getString(R.string.sys_dropped, released)
                                    + (body.optBoolean("releasedLocked", false) ? getString(R.string.sys_locked_suffix) : "");
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
        if (client == null) return;      // 4.55：抽屉轮询也可能在 client 建好前触发
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
                    // 5.06：记下来 —— 会中换语言时要用邀请码把自己重新登记一次
                    roomCode = code;
                    String name = room.optString("name", "");
                    if (!name.isEmpty()) titleView.setText(name);
                    String host = room.optString("host", "");
                    iAmHost = myName != null && myName.equals(host);
                    roleTag.setText(iAmHost ? getString(R.string.room_role_host) : getString(R.string.room_role_member));
                    roleTag.setBackgroundResource(iAmHost ? R.drawable.bg_chip_brand : R.drawable.bg_chip);
                    roleTag.setTextColor(getColor(iAmHost ? R.color.brand : R.color.ink_soft));
                }
                if (members != null) {
                    membersView.setText(getString(R.string.room_members_count, members.length()));
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
            String suffix = name.equals(myName) ? getString(R.string.room_me_suffix) : "";
            // 4.95：正在说话的人就在他的名字后面标出来。
            // 这是抽屉里唯一需要"谁在说"的地方，而以前它只能靠顶部那行文字反解 ——
            // 于是没人在麦上时，抽屉里也显示着一个叫「麦克风空闲」的发言人。
            String speaking = name.equals(holderName) ? getString(R.string.room_speaking_suffix) : "";
            label.setText(name + suffix + speaking);
            label.setTextColor(getColor(R.color.ink));
            label.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
            LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            labelParams.leftMargin = dp(8);
            row.addView(label, labelParams);

            // 管理者操作：只对"别人"显示移出（移自己要走退出，那是结束会议）
            if (iAmHost && !name.equals(myName)) {
                TextView remove = new TextView(this);
                remove.setText(getString(R.string.btn_remove));
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
            force.setText(getString(R.string.btn_force_release, holder()));
            force.setTextColor(getColor(R.color.brand));
            force.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11);
            force.setPadding(0, dp(6), 0, dp(6));
            force.setOnClickListener(v -> act("force-release"));
            membersList.addView(force);
        }
    }

    /** 当前持麦者（4.95：读字段，不再从状态文字里反解 —— 那会解出「麦克风空闲」这种"人名"）。 */
    private String holder() {
        return holderName == null ? "" : holderName;
    }

    /** 移出成员要二次确认：这是个不可撤销（对方视角）的动作。 */
    private void confirmRemove(final String name) {
        new android.app.AlertDialog.Builder(this)
                .setTitle(getString(R.string.remove_dialog_title, name))
                .setMessage(getString(R.string.remove_dialog_msg1)
                        + getString(R.string.remove_dialog_msg2))
                .setNegativeButton(getString(R.string.common_cancel), null)
                .setPositiveButton(getString(R.string.btn_remove), (dialog, which) -> doRemove(name))
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
                    String reason = ServerText.from(this, body, error);
                    Toast.makeText(this, getString(R.string.st_remove_failed, reason), Toast.LENGTH_LONG).show();
                    return;
                }
                addSystemEvent(getString(R.string.sys_removed, name));
                org.json.JSONArray members = body.optJSONArray("members");
                if (members != null) {
                    membersView.setText(getString(R.string.room_members_count, members.length()));
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
            Toast.makeText(this, getString(R.string.toast_no_invite), Toast.LENGTH_SHORT).show();
            return;
        }
        android.content.ClipboardManager clipboard =
                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText(getString(R.string.clip_invite_label), text));
        }
        Toast.makeText(this, getString(R.string.toast_invite_copied, text), Toast.LENGTH_SHORT).show();
    }

    /** 「人员与设备」抽屉：点右侧悬浮条开，再点一次/点关闭收。 */
    private void toggleDrawer() {
        boolean open = drawer.getVisibility() == View.VISIBLE;
        drawer.setVisibility(open ? View.GONE : View.VISIBLE);
        if (open) {
            stopDrawerRefresh();
            return;
        }
        loadRoomHeader();
        startDrawerRefresh();   // 打开期间实时刷新（4.55）
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
                // 5.06：每秒顺手看一眼"我会中是不是换了语言"（改一次就生效，不用重进房间）
                syncSpokenLanguage();
                ui.postDelayed(this, 1000);
            }
        });
    }

    /**
     * 会中换语言要**当场生效**（5.06）。
     *
     * <p>两件事必须一起做，少一件都会出问题：
     * <ol>
     *   <li><b>本地</b>：`hearLang` 换成新语言 —— 存量的按语言过滤/去重都看它；</li>
     *   <li><b>服务端</b>：用自己的邀请码重新 `POST /org/rooms/join {code, lang}`，
     *       把 `room_members.lang` 更新掉。不更新的话，大脑算出来的"听众语言集合"里
     *       没有这门语言 —— 它**一句都不会译**，而按语言扇出时这台设备也收不到。</li>
     * </ol>
     * 入会时已经登记过一次，所以"进房后的第一次"只同步本地、不重复打服务端。
     */
    private void syncSpokenLanguage() {
        final String want = getSharedPreferences("leion", MODE_PRIVATE).getString("speakLang", "");
        if (want == null || want.isEmpty() || want.equals(syncedSpeakLang)) return;
        final boolean changed = !syncedSpeakLang.isEmpty();
        syncedSpeakLang = want;
        hearLang = want;
        if (mic != null) mic.setLanguage(want);
        // 5.07：顶部那格「我说…」跟着换（它以前永远显示中文）
        updateModeTag();
        if (!changed || roomCode.isEmpty()) return;
        hintLine.setText(getString(R.string.st_lang_now, langLabelOf(want)));
        new Thread(() -> {
            try {
                client.orgJoinRoom(roomCode, want, null);
            } catch (Exception ignored) {
                // 网络不通就算了：下一次开麦上传时服务端还会用 &lang= 校正一次
            }
        }, "room-lang-sync").start();
    }

    private String langLabelOf(String lang) {
        if ("pt-BR".equals(lang)) return getString(R.string.rooms_speak_pt);
        if ("en-US".equals(lang)) return getString(R.string.rooms_speak_en);
        return getString(R.string.rooms_speak_zh);
    }

    /**
     * 顶部那一格「我说…」到底是什么（5.07）。
     *
     * <p>它原来只是布局里的缺省文案（中文），Java 侧拿到控件后**从没赋过值** ——
     * 选葡语、选英语都照旧显示「我说中文」。这类"静态文案冒充状态"的 bug 很难从日志发现，
     * 只有盯着界面看才会觉得不对（用户就是这么发现的）。
     *
     * <p>现在按**实际的两个选择**渲染：参会语言（我在会里说/读哪种）· 参会方式（面对面/远程）。
     * 参会方式在 5.04 才收集，所以老数据可能没有 —— 那就只显示语言，不硬编一个方式。
     */
    private void updateModeTag() {
        if (modeTag == null) return;
        SharedPreferences prefs = getSharedPreferences("leion", MODE_PRIVATE);
        String lang = prefs.getString("speakLang", "");
        String mode = prefs.getString("attendMode", "");
        String langText = langLabelOf(lang == null ? "" : lang);
        String modeText = "remote".equals(mode) ? getString(R.string.attend_mode_remote)
                : ("onsite".equals(mode) ? getString(R.string.attend_mode_onsite) : "");
        modeTag.setText(modeText.isEmpty() ? langText : langText + " · " + modeText);
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
            message = wasUploading ? getString(R.string.st_took_over_sys, who) : getString(R.string.st_took_over_sys_plain, who);
        } else {
            message = wasUploading ? getString(R.string.st_mic_released_sys) : "";
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
                    stopUpload(getString(R.string.st_not_holder));
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
                statusLine.setText(getString(R.string.st_old_server));
            }
        });
    }

    @Override
    public void onFrame(String speaker, String lang, String[] lines, String text,
                        String source, String sourceLang, boolean partial, String[] termsMissing,
                        String speakerName, String notice) {
        // 5.00：这里的 `lang` 就是"这一帧译成哪种语言"（relay 的帧字段），直接传给 applyFrame
        ui.post(() -> applyFrame(text, lines, source, partial, termsMissing, speakerName, lang, notice));
    }

    /**
     * 渲染一帧字幕。**长轮询与 WS 推送都走这里**（4.43），否则两条路各写一份，
     * 迟早出现"长轮询能显示、WS 显示不出来"这种只在一半设备上出现的分裂。
     *
     * @param speakerName 这一句**是谁说的**（4.95：服务端随帧给出；空串 = 未知）
     * @param lang        这一帧是**译成哪种语言**的（5.00：三语会议里同一句有两份帧，
     *                    只显示自己登记的那一份；空串 = 老服务端，照旧显示）
     */
    private void applyFrame(String text, String[] lines, String source, boolean partial,
                            String[] termsMissing, String speakerName, String lang, String notice) {
        String target = (text == null || text.isEmpty())
                ? (lines == null ? "" : String.join("\n", lines)) : text;
        String frameLang = lang == null ? "" : lang.trim();
        // 5.00：只显示自己语言那一份。判据是本机登记的说话语言（同时作为"读的语言"）。
        // 帧语言缺失（老服务端/无语言）时照旧显示 —— 宁可多显示，也不能吞掉字幕。
        if (!frameLang.isEmpty() && !hearLang.isEmpty() && !frameLang.equals(hearLang)) {
            return;
        }
        // 5.12：这一帧带了提示（例如"本场语言相同 · 无需翻译"）—— 写在提示行，
        // 让人知道"没译文"是设计如此，不是坏了。
        if (notice != null && !notice.isEmpty()) {
            hintLine.setText("same-language".equals(notice)
                    ? getString(R.string.st_same_language) : notice);
        }
        renderSegment(target == null ? "" : target, source == null ? "" : source, partial,
                speakerName == null ? "" : speakerName.trim(), frameLang);
        if (partial) {
            hintLine.setText(getString(R.string.st_generating));
        } else if (termsMissing != null && termsMissing.length > 0) {
            hintLine.setText(getString(R.string.st_terms_missing,
                    String.join(getString(R.string.list_separator), termsMissing)));
        } else if (notice == null || notice.isEmpty()) {
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
    private void renderSegment(String target, String source, boolean partial, String speakerName,
                               String lang) {
        if (target.isEmpty() && source.isEmpty()) return;
        if (emptyView.getVisibility() == View.VISIBLE) emptyView.setVisibility(View.GONE);

        // 4.95：**这一句是谁说的**。
        //
        // 原来写的是 `mine = … && holding` —— 用的是"我此刻是否持麦"，而不是"这句话是谁说的"。
        // 结果：没人在麦上时每张卡片的发言人都显示「麦克风空闲」，而且永远显示"对方"。
        // 现在按帧里带的 `speakerName` 判；服务端没给（老服务端）时退回"当前持麦者"，
        // 再退不回就显示「对方」——**绝不再把状态文字当成发言人名字**。
        String who = speakerName;
        if (who.isEmpty()) who = holderName;
        boolean mine = myName != null && !myName.isEmpty() && who.equals(myName);
        String whoLabel = who.isEmpty() ? getString(R.string.room_other) : who;

        // ── 同一段判定（4.53）────────────────────────────────────────
        // 一句话会来三帧：增量 / 定稿 / 校对修订。它们的**原文相同**，
        // 所以"原文相同"就是同一段；原文缺失时退化成"上一条还是增量态"也算同一段。
        // ⚠️ 5.00：键**必须带语言** —— 三语会议里同一句会来两份帧（葡语/英语），
        // 只按原文判会把第二份当成"同一段的定稿"直接覆盖第一份（另一份语言就没了）。
        String langKey = lang == null ? "" : lang;
        String key = source.isEmpty() ? null : (langKey.isEmpty() ? source : langKey + "|" + source);
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
            lastSegmentState.setText(partial ? getString(R.string.st_recognizing) : getString(R.string.st_done));
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
        avatar.setText(mine ? getString(R.string.room_me_my) : firstChar(whoLabel));
        avatar.setGravity(android.view.Gravity.CENTER);
        avatar.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
        avatar.setTextColor(getColor(R.color.brand));
        avatar.setBackgroundResource(R.drawable.bg_avatar);
        int dot = dp(24);
        head.addView(avatar, new LinearLayout.LayoutParams(dot, dot));

        TextView name = new TextView(this);
        name.setText(mine ? getString(R.string.room_me_my) : whoLabel);
        name.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
        name.setTextColor(getColor(R.color.ink_soft));
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nameParams.leftMargin = dp(8);
        head.addView(name, nameParams);

        TextView langTag = new TextView(this);
        langTag.setText(mine ? getString(R.string.room_i_said) : getString(R.string.room_other));
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
        state.setText(partial ? getString(R.string.st_recognizing) : getString(R.string.st_done));
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
        //
        // 5.12：**原文帧的译文是空的**（那种帧只给"读源语言的人"看自己那句话）。
        // 这时候不能留一行空白大字 —— 直接把这一行收起来，卡片就只剩原文。
        final TextView targetLine = new TextView(this);
        targetLine.setText(target);
        targetLine.setTextColor(getColor(R.color.ink));
        targetLine.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15);
        targetLine.setTypeface(targetLine.getTypeface(), android.graphics.Typeface.BOLD);
        targetLine.setLineSpacing(dp(4), 1f);
        targetLine.setVisibility(target.isEmpty() ? View.GONE : View.VISIBLE);
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

    /**
     * 「谁在说话」的**数据**来源（4.95）。
     *
     * <p>以前这里是"从 speakerBar 的文字里反向解析"：没人在麦上时那行是「麦克风空闲」，
     * 解析结果就成了一个叫「麦克风空闲」的发言人（用户看到的就是这个）。
     * 现在直接读 {@link #holderName}（由发言权状态写入），并且**只返回名字或空串**，
     * 状态文字一律不进这一层 —— 空串由调用方决定怎么显示。
     */
    private String speakerBarName() {
        return holderName == null ? "" : holderName;
    }

    private static String firstChar(String text) {
        return text == null || text.isEmpty() ? "?" : text.substring(0, 1);
    }

    /** dip → px（布局里能用 @dimen，代码里这两处间距就地换算，别到处塞 token）。 */
    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    /**
     * M3：把「原文显示」的状态同步到**已画出来的卡片**（开关本身由 Switch 负责）。
     *
     * <p>4.55 起底部是一个真正的 Switch（原型：原文后面跟一个可点开关），
     * 所以这个函数不再"翻转"，只按 `showSource` 同步外观与可见性。
     */
    private void syncSourceVisibility() {
        if (sourceSwitch != null) {
            syncingSwitch = true;
            sourceSwitch.setChecked(showSource);
            syncingSwitch = false;
        }
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
        ui.post(() -> statusLine.setText(getString(R.string.st_conn_error, message)));
    }
}