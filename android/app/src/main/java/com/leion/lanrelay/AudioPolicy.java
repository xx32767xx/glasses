package com.leion.lanrelay;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;

/**
 * AudioPolicy —— 「这一场到底能不能外放」（5.164）
 * ============================================================================
 *
 * <p>用户定的规矩，一句话：**面对面时不许外放；远程时允许外放。**
 *
 * <p>为什么这条要单独成类、还要能被测：它决定了"有没有声音"，而两种参会方式的正确答案是
 * **相反**的。写在两个页面里各判一次，必然出现"创建页按面对面处理、房间页按远程处理"
 * 这种只有现场才发现的错。
 *
 * <table>
 *   <tr><th>参会方式</th><th>合成音（念译文）</th><th>对方原声（实时传声）</th></tr>
 *   <tr><td>面对面（onsite / 未知）</td><td>只能进耳机/眼镜；没有就不放</td><td>只能进耳机/眼镜；没有就不放</td></tr>
 *   <tr><td>远程（remote）</td><td>允许外放</td><td>允许外放</td></tr>
 * </table>
 *
 * <p>面对面为什么连"念译文"也不许外放：外放的声音会被自己的麦克风录回去，
 * 识别出"译文的中文"再翻一遍 —— 自激循环；而且旁边就坐着对方，外放等于把译文念给他听。
 */
public final class AudioPolicy {

    /** 参会方式：面对面（缺省按最保守的那一边处理）。 */
    public static final String MODE_ONSITE = "onsite";
    /** 参会方式：远程（允许外放）。 */
    public static final String MODE_REMOTE = "remote";
    /** 偏好键（建会/入会页写，房间页读）。 */
    public static final String PREF_ATTEND_MODE = "attendMode";

    private AudioPolicy() {
    }

    /** 这一场是不是"远程"（只有明确的 "remote" 才算；空/未知一律按面对面处理）。 */
    public static boolean isRemote(String mode) {
        return MODE_REMOTE.equals(mode == null ? "" : mode.trim());
    }

    /** 从偏好读参会方式（房间页用）。 */
    public static String attendMode(Context context) {
        if (context == null) return "";
        try {
            SharedPreferences prefs = context.getSharedPreferences("leion", Context.MODE_PRIVATE);
            String value = prefs.getString(PREF_ATTEND_MODE, "");
            return value == null ? "" : value.trim();
        } catch (Exception error) {
            return "";
        }
    }

    /**
     * 允许外放吗（= 远程）。
     *
     * <p>⚠️ 注意语义：**"允许外放"不等于"一定外放"** —— 插了耳机时声音当然还是走耳机
     * （那是系统路由，不是我们决定的）。这里回答的是"没有耳机时能不能用喇叭"。
     */
    public static boolean allowsSpeaker(String mode) {
        return isRemote(mode);
    }

    /**
     * 这一次能不能出声音。
     *
     * @param mode      参会方式
     * @param hasNearEar 当前有没有近耳输出（耳机 / 蓝牙 / 眼镜 USB）
     */
    public static boolean allowsPlayback(String mode, boolean hasNearEar) {
        if (isRemote(mode)) return true;      // 远程：喇叭也行
        return hasNearEar;                    // 面对面：只认近耳设备
    }

    /**
     * 当前**有没有**近耳输出设备。
     *
     * <p>与 {@link TtsSpeaker#preferredOutput()} 同一套判据（USB 耳机 > 有线 > 蓝牙/助听），
     * 这里只回答"有没有"。抽出来是因为房间页（实时传声）和合成器（念译文）必须用同一条，
     * 否则会出现"合成音说不许外放、原声却在喇叭里响"这种自相矛盾。
     */
    public static boolean hasNearEar(AudioManager manager) {
        if (manager == null) return false;
        try {
            for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                switch (device.getType()) {
                    case AudioDeviceInfo.TYPE_USB_HEADSET:
                    case AudioDeviceInfo.TYPE_USB_DEVICE:
                    case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                    case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                    case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                    case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                    case AudioDeviceInfo.TYPE_BLE_HEADSET:
                    case AudioDeviceInfo.TYPE_HEARING_AID:
                        return true;
                    default:
                        break;
                }
            }
        } catch (Exception error) {
            // 查不到就当"没有"：面对面时宁可不出声，也不要在对方旁边放喇叭
            return false;
        }
        return false;
    }
}
