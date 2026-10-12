package com.leion.lanrelay;

import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.AudioRecordingConfiguration;

/**
 * AudioDevices —— 问安卓："现在**实际**在录的是哪个输入设备"
 * ============================================================================
 *
 * <p><b>为什么必须有这个</b>：我们让 SDK 从眼镜取音（{@code GlassAudioService}），
 * 但 SDK 内部到底选了哪个输入设备，**从我们这边是看不见的** ——
 * 它可能老老实实用 USB 音频设备（眼镜），也完全可能**悄悄退回手机内置麦克风**。
 *
 * <p>这两者在代码上无法区分：拿到的都是一串 PCM。而如果实际用的是手机麦克风，
 * 那么"眼镜收音更好"这个实验结论就是**假的** —— 你会以为测的是眼镜，
 * 其实测的是手机，还测出了个"提升"。
 *
 * <p>所以不能只靠"我调了 SDK 的接口"来推断。安卓提供了直接问的办法：
 * <ul>
 *   <li>{@link AudioManager#getActiveRecordingConfigurations()} —— 本 App 里
 *       **正在录音的**每一路，各自带 {@link AudioRecordingConfiguration#getAudioDevice()}；
 *       设备类型是 {@code TYPE_USB_DEVICE}/{@code TYPE_USB_HEADSET} 就是眼镜，
 *       是 {@code TYPE_BUILTIN_MIC} 就是手机。</li>
 *   <li>{@link AudioManager#getDevices(int)} —— 当前有哪些输入设备可用，
 *       用来确认眼镜有没有以 USB 音频设备的形式出现。</li>
 * </ul>
 *
 * <p>额外能发现的问题：如果 {@code getAudioDevice()} 返回 {@code null}，
 * 说明那一路录音**没有指定设备**、用的是系统默认 —— 这时要看 USB 有没有顶上去，
 * 不能想当然认为它是眼镜。这一条会明确标出来。
 */
public final class AudioDevices {

    private AudioDevices() {
    }

    /**
     * 本 App 里**正在录音**的输入设备。
     *
     * @return 一行说明；没有在录时也说清楚（"没有正在录音的设备"本身就是有用的信息）
     */
    public static String activeInputs(AudioManager manager) {
        if (manager == null) return "（拿不到 AudioManager）";
        try {
            java.util.List<AudioRecordingConfiguration> configs =
                    manager.getActiveRecordingConfigurations();
            if (configs == null || configs.isEmpty()) {
                return "没有正在录音的设备";
            }
            StringBuilder out = new StringBuilder();
            for (AudioRecordingConfiguration config : configs) {
                if (out.length() > 0) out.append(" · ");
                AudioDeviceInfo device = config.getAudioDevice();
                if (device == null) {
                    // 没指定设备 = 走系统默认。不能假定它是眼镜 —— 明确标出来。
                    out.append("未指定设备（走系统默认，未必是眼镜）");
                } else {
                    out.append(typeName(device.getType()))
                       .append("「").append(device.getProductName()).append("」");
                }
            }
            return out.toString();
        } catch (Throwable error) {
            return "读活跃录音设备失败：" + error.getClass().getSimpleName();
        }
    }

    /**
     * 判定"现在到底在用什么麦克风"，并给出人话结论。
     *
     * <p>这个函数的用处是**给实验把关**：只有它说"USB 设备"，
     * "眼镜收音更好"这个结论才立得住。
     */
    public static String verdict(AudioManager manager) {
        if (manager == null) return "";
        try {
            java.util.List<AudioRecordingConfiguration> configs =
                    manager.getActiveRecordingConfigurations();
            if (configs == null || configs.isEmpty()) return "未在录音";
            boolean sawUsb = false;
            boolean sawBuiltin = false;
            boolean sawUnknown = false;
            for (AudioRecordingConfiguration config : configs) {
                AudioDeviceInfo device = config.getAudioDevice();
                if (device == null) {
                    sawUnknown = true;
                    continue;
                }
                if (isUsb(device.getType())) sawUsb = true;
                else if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC) sawBuiltin = true;
                else sawUnknown = true;
            }
            if (sawUsb && !sawBuiltin) return "✓ 实际用的是眼镜（USB 音频设备）";
            if (sawBuiltin && !sawUsb) return "✗ 实际用的是**手机内置麦克风** —— 对比实验不成立";
            if (sawBuiltin && sawUsb) return "⚠ 同时存在手机与眼镜两路录音 —— 音频会混在一起";
            if (sawUnknown) return "? 有录音但设备未指定 —— 无法确认是眼镜";
            return "";
        } catch (Throwable error) {
            return "";
        }
    }

    /** 列出当前可用的 USB 输入设备（眼镜在系统里就是它）。 */
    public static String usbInputs(AudioManager manager) {
        if (manager == null) return "";
        try {
            AudioDeviceInfo[] devices = manager.getDevices(AudioManager.GET_DEVICES_INPUTS);
            if (devices == null) return "";
            StringBuilder out = new StringBuilder();
            for (AudioDeviceInfo device : devices) {
                if (!isUsb(device.getType())) continue;
                if (out.length() > 0) out.append(" · ");
                out.append(typeName(device.getType()))
                   .append("「").append(device.getProductName()).append("」");
            }
            return out.length() == 0 ? "没看到 USB 输入设备（眼镜没连？）" : out.toString();
        } catch (Throwable error) {
            return "";
        }
    }

    private static boolean isUsb(int type) {
        return type == AudioDeviceInfo.TYPE_USB_DEVICE
                || type == AudioDeviceInfo.TYPE_USB_HEADSET
                || type == AudioDeviceInfo.TYPE_USB_ACCESSORY;
    }

    private static String typeName(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_USB_DEVICE: return "USB 音频设备";
            case AudioDeviceInfo.TYPE_USB_HEADSET: return "USB 耳机";
            case AudioDeviceInfo.TYPE_USB_ACCESSORY: return "USB 配件";
            case AudioDeviceInfo.TYPE_BUILTIN_MIC: return "手机内置麦克风";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO: return "蓝牙耳机（SCO）";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "有线耳机麦克风";
            case AudioDeviceInfo.TYPE_TELEPHONY: return "通话麦克风";
            default: return "设备类型 " + type;
        }
    }
}
