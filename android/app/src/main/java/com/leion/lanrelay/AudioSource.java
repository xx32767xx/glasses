package com.leion.lanrelay;

/**
 * AudioSource —— "从哪儿取音"这件事的抽象
 * ============================================================================
 * 有两条实现：
 * <ul>
 *   <li>{@link MicUploader}：**手机自己的麦克风**（{@code AudioRecord}）</li>
 *   <li>{@link GlassesMic}：**眼镜的麦克风**（眼镜在系统里是 USB 音频输入设备，
 *       经 SDK 的 {@code GlassAudioService} 拿 PCM）</li>
 * </ul>
 *
 * <p><b>为什么要这个抽象</b>：两者的取音方式完全不同（一个是安卓录音 API、
 * 一个是 SDK 的音频回调），但**下游完全一样** —— 攒块、传 HTTP、算电平、
 * 上报状态。界面只关心"有没有在录、采样率多少、语种是什么"，
 * 不该为两种音源各写一套接线。
 *
 * <p><b>为什么优先选眼镜</b>：眼镜戴在说话人脸上，离嘴十几厘米；
 * 手机往往在兜里或桌上，一两米开外。同样的模型和网络，信噪比差一大截，
 * 而识别准确率对信噪比极其敏感（见 {@code docs/04}）。
 */
public interface AudioSource {

    /**
     * 开始取音。
     * @return null 表示成功；否则是一条人类可读的失败原因（界面直接显示）
     */
    String start();

    /** 停止取音。会把最后不足一块的音频也发出去。 */
    void stop();

    boolean isRunning();

    /** 当前在听哪种语言（{@code pt-BR} / {@code zh-CN}）。录音中调用也安全。 */
    void setLanguage(String language);

    /** 实际用上的采样率（启动后才有意义）。**必须如实上报** —— 猜错会让识别全是乱码。 */
    int getSampleRate();

    /** 给界面显示的短名字，例如"眼镜麦克风"/"手机麦克风"。 */
    String name();
}
