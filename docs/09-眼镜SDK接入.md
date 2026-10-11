# 眼镜 SDK 接入规范（亮亮 Glass3 / Leion Pro）

> **这一页是开发规范，不只是说明。** 接眼镜端时按这里的做法来，别自己发明。
> 每条结论都标了依据（代码位置或实测），因为 SDK 的坑大多不在文档里 ——
> 官方 `document/` 只有英文和土耳其语，而且**PDF 字体是子集编码，抽不出文本**，
> 所以真正的权威是 `LeionProDemo_SDK/samplecode/` 里的代码。
>
> 相关：[`01-架构与方案.md`](01-架构与方案.md) 讲整条链路的分层，
> [`05-数据通路.md`](05-数据通路.md) 讲字幕帧的字段契约，
> [`../android/README.md`](../android/README.md) 讲手机端 App。

---

## 1. 一句话说清最关键的机制

> **眼镜不是"收文字"的，是"收画面"的。**
> SDK 没有推文字的 API，只有**投屏**：你把一个 Android `View` 交给 SDK，
> 它就**把你的 View 画到眼镜上**。所以"往眼镜显示字幕"= **做一个专给眼镜用的 View**。

这一条决定了后面所有做法 —— 也直接回答了方案最初那个问题
（「能否从我们自己的安卓 App 把一段文本推送到眼镜上显示」）：**能，但走的是投屏这条路。**

---

## 2. SDK 里有什么

`LeionProDemo_SDK/` 四个部分：

| 目录 | 内容 | 我们要不要 |
|---|---|---|
| `sdk/` | **两个 AAR** + 两个人脸模型 `.bin` | 只要 `platform` 那个 |
| `samplecode/` | 完整 Android 工程（Kotlin/Compose/Hilt/Room/Retrofit） | **当 API 字典读**，不照抄工程结构 |
| `apk/` | 编好的 Demo APK（**124 MB**） | 先装它验证硬件链路 |
| `document/` | README / 交付清单 / 发布说明（仅 en/tr；PDF 抽不出文本） | 参考 |

### 两个 AAR 的分工

| AAR | 内容 | 我们要不要 |
|---|---|---|
| **`platform-4.8.0.4-release.aar`**（22 MB） | USB 连接、**LCD 显示**、相机、按键、传感器、音频 | ✅ **要** |
| `core_ai-4.7.0-release.aar`（13.5 MB） | 人脸检测识别（`com.llvision.glass3.ai.*`）+ OpenCV | ❌ **不要** —— 我们不做视觉 |

> **排除 `core_ai` 是有实据的**：它的 `jni/` 里**同时有 `arm64-v8a` 和 `armeabi-v7a`**，
> 而样例的 `app/build.gradle.kts` 注释写着：
> 「产品路径仅 arm64；避免 core_ai AAR 打入 armeabi-v7a（**非 16KB 对齐**）」。
> 我们不要它，连这个 16 KB 对齐问题和 55 MB 人脸模型一起省掉。

### `platform` AAR 里的原生库（22 个，只有 arm64-v8a）

关键几个：`libllvision_UVCCamera.so`(8.6 MB)、`libllvision_decoder_support.so`(6.4 MB)、
`liblcd.so`、`libllvision_usb100.so`、`libllvision_audio.so`、`libkey.so`、`libsensor.so`。

它还在 `assets/` 里带了**各型号的固件**：`G26/G30/G40/G40A/R10` 的 `.img` 共约 34 MB。
**（这些是 SDK 预置的固件包，不要动。）**

### `platform` AAR 自带的组件（会合并进我们的清单）

- Activity：`ConnectDialogActivity`（**USB 授权弹窗**）、`SyncScreenActivity`、`AppSettingsDialogHolderActivity`
- Service：`LCDService`、`ScreenRecorder`（`foregroundServiceType="mediaProjection"`）、
  `SensorService`、`KeyService`、`GlassAudioService`、`GlassCameraService`、
  `UVCService`、`StdUVCCameraService`、`MultiScreenService`、`LLVisionPlatformService`
- `<uses-feature android:glEsVersion="0x00020000" android:required="true"/>` ← **要求 OpenGL ES 2.0**
- 声明了一堆权限（相机/存储/录音/悬浮窗/DEVICE_POWER…）—— 很多我们**用不到但要处理**

---

## 3. 显示 API：全部能力就这些

下面这段是**从 AAR 的字节码里 `javap` 出来的**，不是从样例"看"出来的。

> ⚠️ 为什么强调这个：我一开始是照着样例代码**推**签名的，结果四处全错，
> 而且错法很隐蔽（Kotlin 和 Java 的写法差异 + 继承关系 + 注解常量 vs 枚举）。
> 反射调用没有编译期校验，错了不崩、只是静默什么都不做。
> **凡是 反射 / SDK 调用，签名一律以 `javap` 为准。**

```java
// ── 取客户端：注意 LCD 是 **int 常量**，不是枚举 ─────────────────────────────
// public interface IGlass3Device$Glass3DeviceClient extends java.lang.annotation.Annotation {
//     public static final int CAMERA; LCD; SENSOR; KEY; AI;
// }
// public IBaseClient getGlass3Client(int) throws GlassException;
int lcd = IGlass3Device.Glass3DeviceClient.LCD;          // int
ILCDClient lcdClient = (ILCDClient) sdk.getGlass3Client(lcd);

// ── 取 display：参数是 library.IGlassDevice ─────────────────────────────────
// public interface ILCDClient extends IBaseClient {
//     IGlassDisplay getGlassDisplay(com.llvision.glass3.library.IGlassDevice) throws BaseException;
// }
// 而 platform.IGlass3Device extends library.IGlassDevice  ← 是**父子关系**
//   传参没问题，但 getMethod 必须用声明类型 library.IGlassDevice
IGlassDisplay disp = lcdClient.getGlassDisplay(device);

// ── 投屏 ──────────────────────────────────────────────────────────────────
// public interface IGlassDisplay extends IDeviceAbility {
//     void createCaptureScreen(android.content.Context);                                  // 镜像整屏
//     void createCaptureScreen(android.content.Context, android.view.View);               // ★ 用这个
//     void createCaptureScreen(android.content.Context, Fragment, FragmentManager);
//     void createCaptureScreen(android.content.Context, android.view.View, int, int)
//             throws IllegalArgumentException;                                            // 显式宽高
//     void createCaptureScreen(android.content.Context, android.view.View, int, int, Drawable)
//             throws IllegalArgumentException;
//     void stopCaptureScreen();
// }
disp.createCaptureScreen(activity, myView);   // Activity 是 Context 的子类，能传
disp.stopCaptureScreen();

// ── 显示参数（注意：**没有 setPort**）──────────────────────────────────────
// boolean setSwitch(boolean);  boolean setLuminance(int);
// boolean setBackLightAuto(boolean);
// int setDisplayPortNumber(int port, int on);   // ← 双眼是这里，不是 setPort
// void setCameraPreviewOnLcdScreen(boolean);   // ← 相机预览铺底，默认是开的！见下
// LCDInfo getLCDInfo();                         // open/backLightAuto/level/displayMode
// 常量：LEFT_EYE_PORT / RIGHT_EYE_PORT / DOUBLE_EYE_PORT（实测 DOUBLE_EYE_PORT = 2）
//       LUM_LEVEL_0..3 / LUM_LEVEL_MAX
// int ResultCode.SUCCESS = 0;                   // setDisplayPortNumber 的返回比它
disp.setCameraPreviewOnLcdScreen(false);        // ← 必须调，否则眼镜上是"相机画面+字幕"
disp.setSwitch(true);                           // 开 LCD
disp.setDisplayPortNumber(IGlassDisplay.DOUBLE_EYE_PORT, 1);
```

### ⚠️ 相机预览默认是**开着**的 —— 它会在字幕下面铺一层摄像头画面

真机上看到的症状：字幕能显示了，但**整个画面是"摄像头看到的内容 + 我们的字幕"**。
原因是 LCD 默认把相机预览当作背景层。

样例里用到 `setCameraPreviewOnLcdScreen` 的三处（相机测试 / RTSP 推流 / AI 测试）
**全部传 `false`**，而且都在 `createCaptureScreen` **之前**调 —— 位置就是上面那段。

为什么我们一定要关：
- 眼镜是**透视**的，真实世界本来就直接看得见，再叠一层相机画面只会**重影**
  （相机在鼻梁中间，和人眼位置还有偏差）；
- 字幕是给"看着对方说"用的，画面里多一层相机取景框只会干扰。

### ⚠️ 一处我自己制造的错误推断（记下来当反面例子）

我在前面几个版本里写过"样例给投屏 View 设过 `setAspectRatio(8.0/5.0)`，
说明 SDK 对采集尺寸有预期"，并把它当成了"画布必须按比例设"的依据。

**这是错的。** `setAspectRatio` 是**样例自己的** `FaceBoxCameraTextureView` 类的
方法（用来定相机预览的比例），**不是 SDK 的 API** —— `IGlassDisplay` 上根本没有
`setAspectRatio`。我把它看成了 SDK 要求，于是推出了一个不存在的约束。

> 同一个毛病犯了两次（另一次是眼位，见第 10 节）：
> **看到样例里有一行调用，就假定它是 SDK 的规矩。**
> 判断之前先确认那个方法**到底属于谁** —— 用 `javap` 看 SDK 的接口有没有它。
> 样例里有一半代码是它自己的工具类。

**没有 `sendText` / `drawText` / `setText`。** 别再去找了。

### 我们踩过的四个签名坑（都在这里了）

| 我写错的 | 真的 | 真机表现 |
|---|---|---|
| `getGlass3Client(Glass3DeviceClient)` | `getGlass3Client(int)` | `getEnumConstants()` 返回 null → NPE，**卡在第①步** |
| `getGlassDisplay(platform.IGlass3Device)` | `getGlassDisplay(library.IGlassDevice)` | `NoSuchMethodException` |
| `createCaptureScreen(Activity, View)` | `createCaptureScreen(Context, View)` | `NoSuchMethodException` |
| `setPort(int, boolean)` | `setDisplayPortNumber(int, int)` | 静默失败（包在 try/catch 里，只留一行日志） |

第 1 条最容易被误判：报的是 `NullPointerException: Attempt to get length of null array`，
**看起来像数组越界，其实是在说"这个类不是枚举"**。`Glass3DeviceClient` 是 `@IntDef` 注解接口。

### 所以我们的字幕要这么做

```java
// 一个专给眼镜用的 View：黑底、白字、特大字号、只放译文
GlassesSubtitleView view = new GlassesSubtitleView(activity);
view.setSubtitle(translatedText);

// 投上去
display.createCaptureScreen(activity, view.getView());
```

**尺寸有两件事要注意：**

1. **画布必须有确定的宽高。** `createCaptureScreen` 只接收一个 View，
   SDK 会把它采样成画面。View 尺寸是 0×0 就没画面，尺寸和眼镜对不上就报
   「数据越界」（SDK 按设备分辨率分配缓冲，却从一块尺寸不符的 View 取像素）。
   ⚠️ 而且**不能用 `view.post()` 去设尺寸** —— 这个 View 从不 attach 到窗口，
   detached View 的 `post()` 要等 attach 才执行，也就是**永远不执行**。
   必须同步 `setLayoutParams` + `measure` + `layout`。

2. **实际分辨率从设备读**，别写死：
   ```java
   DeviceInfo info = device.getDeviceInfo();
   String w = info.getResolutionWidth();    // ⚠️ 返回的是 **String**，不是 int
   String h = info.getResolutionHeight();   //    按 int 读会静默拿到 0
   ```
   画布尺寸**等于眼镜分辨率**（见第 10 节「投屏画布的尺寸」）。
   ⚠️ 别被样例里那句 `setAspectRatio(8.0/5.0)` 误导 —— 那是它自己相机 View 的方法，
   不是 SDK 的要求。

---

## 4. 接入五步（照这个顺序写）

> ### ⚠️⚠️ 第 0 步（真机踩出来的，最容易漏）：先把权限要齐，再 init SDK
>
> **症状**：插上眼镜**完全不弹「允许访问眼镜吗」**，官方 App 会弹。
>
> **根因**：SDK 初始化是有**前置条件**的，不满足它根本走不到请求 USB 授权那一步。
> 官方样例把这件事写得很明白（`GlassMainViewModel.kt:48-50`）：
>
> > 「**权限与悬浮窗就绪后**，由界面调用以初始化 Glass SDK（仅调用一次）」
>
> 官方还有一道 `GlassPermissionFlow` 权限门禁，要求这几样**全给齐**才往下走：
>
> | 类型 | 具体 |
> |---|---|
> | 运行时权限 | `CAMERA`、`RECORD_AUDIO`、`READ_MEDIA_IMAGES/VIDEO/AUDIO`、`READ_MEDIA_VISUAL_USER_SELECTED`（Android 33/34 分档） |
> | 悬浮窗 | `Settings.canDrawOverlays()` 必须为 true（`SYSTEM_ALERT_WINDOW`） |
> | 前台服务 | `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_CAMERA`（第三方 UVC 相机服务要用） |
>
> **所以：不要为了"权限干净"把这些删掉。** CAMERA 不是"我们不做视觉就不用给" ——
> 它是 SDK 建立连接的前提。`WAKE_LOCK`、`FOREGROUND_SERVICE*` 同理。
>
> **但也不必做成官方那种"不给权限就不让用"的门禁**：手机端的同传功能
> （录音上传、字幕显示）和眼镜是两件事，不该因为眼镜没授权就把整个 App 拦住。
> 只请求眼镜需要的那几条，拿到才 `init()`；没拿到就在状态行里说清原因。

```java
// ① 初始化（在 Activity 里，越早越好）；要一个连接状态回调
LLVisionGlass3SDK.getInstance().init(applicationContext, connectionListener);

// ② 设备插上会回调（ConnectionStatusListener.onDeviceConnect）
@Override public void onDeviceConnect(IGlass3Device device) { ... }

// ③ 连接后**延迟 3 秒**再拉服务（样例 SERVICE_INIT_DELAY_MS = 3000L）
GlassServiceManager.initAllServices(context, device);
//   第三方 USB 设备走这条代替：
//   GlassServiceManager.startGlassAudioService(context);

// ④ 投屏（见上一节）

// ⑤ ★ 退出前必须清理，顺序不能反
GlassServiceManager.stopAllServices();
LLVisionGlass3SDK.getInstance().destroy();
```

### ⚠️⚠️ 第 ⑤ 步是高危项 —— 不做会把眼镜搞重启

`samplecode/.../data/glass/GlassSdkBridgeImpl.kt:72-79` 的官方注释原文：

> Android 15 / platform 4.8.0.2+：SDK 内部已改为「先关 USB / native，再解绑 Platform 服务」。
> **App 侧仍须在进程退出前主动调用本方法；不拔眼镜退出再进时否则可能残留脏 fd 导致整机重启。**
> 顺序上先 `GlassServiceManager.stopAllServices`，避免相机/音频等仍占用连接时直接 destroy。
> 幂等：`Activity.onDestroy` 与 `ViewModel.onCleared` 可能各调一次。

**规范**：
1. `destroy()` 必须在进程退出前调用 —— 挂在 `Activity.onDestroy` **和** `Application` 的退出路径上；
2. **必须先 `stopAllServices()` 再 `destroy()`**；
3. 实现要**幂等**（加一个 `destroyed` 标志），因为可能被调两次。

---

## 5. 工程配置要求

| 项 | 要求 | 依据 |
|---|---|---|
| `minSdk` | **≥ 24**（AAR 自己声明 `minSdkVersion="24"`） | AAR 清单 |
| `compileSdk` | 我们现有 34 可用；样例用 36 | — |
| `abiFilters` | **只 `arm64-v8a`** | AAR 只有 arm64 原生库；不限制会在别的架构上报错 |
| AndroidX | **必须开**（AAR 的 `classes.jar` 里有 460 处 `androidx.*` 引用） | 反编译核对 |
| 必须同行的依赖 | `appcompat` + `core`（**不需要 Glide**） | 见下面「依赖这件事的一个纠正」 |
| Java | 17 | 与我们现有一致 |
| `glEsVersion` | 2.0 required（AAR 声明，自动合并） | AAR 清单 |

### 权限的处理（重要 —— 这里有我踩过的坑）

AAR 清单会带进一堆我们**不需要**的权限，用 manifest 合并规则删掉。
**但删之前先看清哪些是 SDK 的前置条件。**

```xml
<!-- ✅ 该删的：上架审核会因为这些拒你，而且与眼镜无关 -->
<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" tools:node="remove" />
<uses-permission android:name="android.permission.MOUNT_UNMOUNT_FILESYSTEMS" tools:node="remove" />
<uses-permission android:name="android.permission.READ_PHONE_STATE" tools:node="remove" />
<uses-permission android:name="android.permission.READ_PHONE_NUMBERS" tools:node="remove" />
<uses-permission android:name="android.permission.DEVICE_POWER" tools:node="remove" />
<uses-permission android:name="android.permission.ACCESS_MEDIA_LOCATION" tools:node="remove" />
<!-- ACCESS_NETWORK_STATE / ACCESS_WIFI_STATE：我们用局域网直连，不需要 -->
```

> ### ⚠️⚠️ 不要删这几条 —— 它们是 SDK 的前置条件
>
> ```xml
> <!-- ❌ 我曾经"按最小权限原则"删掉了下面这些，理由是"眼镜用来显示字幕，不需要相机" -->
> <!--    真机结果：官方 App 会弹的「允许访问眼镜吗」我们一次都不弹，眼镜连不上。 -->
> CAMERA · READ_MEDIA_IMAGES / VIDEO / AUDIO · WRITE/READ_EXTERNAL_STORAGE
> SYSTEM_ALERT_WINDOW（悬浮窗）· WAKE_LOCK · FOREGROUND_SERVICE
> ```
>
> 官方 `glassRuntimePermissions()` 要的就是这些，而且**必须在 SDK init 之前拿到**
> （见第 4 节「第 0 步」）。`RECORD_AUDIO` 我们**本来就要**（手机当麦克风），也别删。
>
> **教训**：SDK 声明的权限是它的**运行前提**，不是我们能替它省的东西。
> "最小权限"这条原则在这里会让功能直接不可用。

> ### ⚠️⚠️ 更不要删 `FOREGROUND_SERVICE_*` —— 删了**必崩**
>
> 同上一条的同类错误，**第二次犯**。真机崩溃（Android 14 / targetSdk 34）：
>
> ```
> RuntimeException: Unable to start service
>   com.llvision.glxss.common.service.audio.GlassAudioService
> Caused by: SecurityException: Starting FGS with type microphone ...
>   requires permissions: allOf=true
>   [android.permission.FOREGROUND_SERVICE_MICROPHONE]
> ```
>
> 原因：**SDK 自己的服务在 AAR 里声明了 `foregroundServiceType`**。
> 合并后的清单里能看到三条，每条都要求**同名**的 `FOREGROUND_SERVICE_*` 权限：
>
> | foregroundServiceType | 服务类 | 需要的权限 |
> |---|---|---|
> | `microphone` | `com.llvision.glxss.common.service.audio.GlassAudioService` | `FOREGROUND_SERVICE_MICROPHONE` |
> | `camera` | `com.llvision.glxss.common.service.camera.GlassCameraService` | `FOREGROUND_SERVICE_CAMERA` |
> | `mediaProjection` | `com.llvision.glass3.core.lcd.ScreenRecorder` | `FOREGROUND_SERVICE_MEDIA_PROJECTION` |
>
> 我当时想的是"我们投的是自己构造的 View、不是录屏，所以不需要这两条"——
> 但这跟**我们**调不调用无关：SDK 的服务在它自己的生命周期里会起这些前台服务，
> 权限缺一个就是 `SecurityException` → 整个 App 崩。
>
> **规则：AAR 声明了 `foregroundServiceType`，就必须有配套的权限。**
> 这类"声明与权限成对出现"的东西不能单方面删一半 ——
> 删之前先去合并后的清单里看有没有对应的 `<service>` 声明：
>
> ```powershell
> Select-String -Path "android\app\build\intermediates\merged_manifest\debug\processDebugMainManifest\AndroidManifest.xml" `
>   -Pattern "foregroundServiceType"
> ```
>
> （`FOREGROUND_SERVICE_*` 都是普通权限，不会弹窗、不影响上架。）

> 规范：**每删一条权限都要在注释里写"为什么不需要"**。这份清单以后要交给老师/审核，
> 空着解释的权限删除记录等于没写。

---

## 6. SDK 附带的其他能力（现在用不上，但记着）

| 能力 | 类 | 用途 |
|---|---|---|
| **眼镜端音频输出** | `GlassNativeAudioEngine`、`PcmStream`、`Playback`、`ClipSpec`、`SourceSpec` | ⭐ 方案里"耳机 TTS 播报译文"的原生路径 |
| **眼镜按键** | `IKeyEventClient`、`IGlassKeyEvent` | 物理按键做"暂停 / 切语向" |
| **头部姿态** | `IGlassSensor`、`SensorHeadEvent`、`HeadGestureListener` | 点头/抬头手势 |
| 相机取帧 | `ICameraClient`、`IFrameCallback`(YUV) | 不用 |
| **副屏取帧** | `ICaptureDisplayFrameCallback` | 用来**确认眼镜上真的显示了什么**（调试用） |
| 推流 | RTSP / RTMP / UVC | 不用 |

---

## 7. 连接方式：USB，不是蓝牙

依据：`com.llvision.glass3.library.usb.USBMonitor`、`DeviceFilter`、`USBMonitor.isThirdPartyDevice`，
以及 `(device as? Glass3Device)?.usbDevice`。

**这条对架构有影响**：
- 眼镜 ↔ **手机**（USB），所以手机必须在链路里 —— 现在的 `手机 → 电脑 → 手机 → 眼镜`
  可以变成 `手机 → 电脑 → 手机 ⇢(USB) 眼镜`，最后一段是 USB
- 如果眼镜插在**电脑**上，那手机就不在显示链路里了 —— **这两种拓扑的代码不一样，要先定**

---

## 8. 没有硬件时能做到什么、做不到什么

| 能做 | 做不到 |
|---|---|
| 写代码、按 AAR 清单核对 API 名 | **编译**（AAR 在，但需要 Android SDK + Gradle 联网） |
| 核对权限、组件、原生库、abiFilters | 验证投屏真的出画面 |
| 装 Demo APK 看**别人的**实现效果 | 验证我们的代码在真机上的行为 |

**必须实机才能验的三件事**（写进待办）：
1. `createCaptureScreen` 是否需要用户授权、是否每次都问
2. 投屏的实际分辨率与长宽比（决定我们 View 的字号与行数）
3. 眼镜在投屏时的**帧率与延迟**是否够看字幕

---

## 9. 接入清单（照着打勾）

- [ ] `platform-4.8.0.4-release.aar` 放进 `app/libs/`（**不放 core_ai**）
- [ ] `abiFilters += "arm64-v8a"`
- [ ] 开 AndroidX；加 glide / glide-gifdecoder / appcompat / material
- [ ] manifest 删掉不需要的权限，**每条写理由**
- [ ] `init()` → `onDeviceConnect` → 延迟 3s → `initAllServices()`
- [ ] 做一个**专给眼镜的 View**（黑底白字、按眼镜长宽比、只放译文）
- [ ] `createCaptureScreen(activity, view)`，用 `setPort` 选双眼
- [ ] `onDestroy`：**先 `stopAllServices()` 再 `destroy()`**，且幂等
- [ ] 加一个"眼镜已连接/投屏中"的状态显示（不然出问题不知道卡在哪）
- [ ] 实机验证上面那三个"必须实机"的项

---

## 10. 这条线现在的状态（如实说）

| | 状态 |
|---|---|
| SDK 有没有 | ✅ 有（`LeionProDemo_SDK/`） |
| 用法搞清了吗 | ✅ 机制、API、依赖、坑都从代码里核对过 |
| 代码写了吗 | ✅ 写了：`android/` 里 `GlassesSdk.java`（反射桥接）+ `GlassesSubtitleView.java`（眼镜字幕 View）+ MainActivity 接线 |
| **编译过吗** | ✅ **过了**。`assembleDebug` 成功，APK 35.9 MB，含 23 个 arm64 原生库 |
| **插上真机了吗** | ✅ 插上了 —— USB 认到设备、SDK 初始化成功、设备数 1 |
| **投屏成功了吗** | ❌ **还没**。四轮实机排查，每轮都修掉了实测确认的问题；详见下面 |
| **反射签名对吗** | ✅ **对上了** —— 按 `javap` 逐个核对（第 3 节） |

### 已验证到的程度（有据可查）

```
APK 35.9 MB · 23 个 .so（含 liblcd.so / libllvision_usb100.so）
armeabi-v7a / x86 / x86_64 的库：0 个          ← abiFilters 生效
合并后的权限：INTERNET · RECORD_AUDIO · CAMERA · READ_MEDIA_*（4 条）
              · WRITE/READ_EXTERNAL_STORAGE · SYSTEM_ALERT_WINDOW
              · WAKE_LOCK · FOREGROUND_SERVICE(+CAMERA)
```

> ⚠️ 这里**曾经写错并且真的踩了坑**：我一开始按"最小权限"的原则把 CAMERA 与
> 媒体读写权限从清单里 `tools:node="remove"` 掉了，理由是"眼镜是同传用的，不需要相机"。
> 实机结果是**官方 App 会弹的"允许访问眼镜吗"我们一次都不弹**，眼镜连不上。
> 官方 `glassRuntimePermissions()` 要的就是这些，而且**必须在 SDK init 之前拿到**。
> 教训：SDK 声明的权限是它的**前置条件**，不是我们能替它省的东西。

### 实机两次失败（都已定位，写在这里免得再犯）

**第一次：不弹 USB 授权框** → 上面那条权限删除造成的，已恢复。

**第二次：诊断行全绿，点「开始投屏」毫无反应** → 两个原因叠加：

1. **`onDeviceConnected(null)` 把已取到的设备清成了 `null`。**
   "眼镜先插着、再开 App"这条路上，`init()` 已经用 `getGlass3DeviceList()`
   取到设备并存进 `device`，紧接着补调的 `onDeviceConnected(null)` 又把它覆盖成 `null`。
   于是 `isConnected()` 变 false（但设备数仍显示 1，两个数字自相矛盾），
   点按钮直接落到"未连接"分支，**看起来就是没反应**。
   → 修法：`connectedDevice != null` 才覆盖。

2. **状态回调里自动重投屏 → 死循环。**
   `MainActivity` 的监听器原来写的是
   `if (connected && isConnected() && !isCasting()) cast(...)`。
   而投屏失败时 `reportWithStep` **也带着 `connected=true` 回调**，
   监听器又看到"没在投屏"就再投一次 —— 失败 → 回调 → 再投，无限循环，
   主线程被自己的 `post` 塞满。
   → 修法：只有 `connected` 从 false 变 true 那一次（`justConnected`）才自动投屏。

> 这两条都属于**反射桥接特有的坑**：没有编译期校验，错误不会崩，
> 只会静默地什么都不做。所以下面这个探测工具是必需品，不是可选项。

**顺手修掉的第三个：投屏抢在服务初始化之前。**
样例里连接之后要**等 3 秒**（`SERVICE_INIT_DELAY_MS`）才 `initAllServices`，
而界面是连上一瞬间就投屏的 —— 第 ② 步 `getGlassDisplay` 会在服务还没起来时拿到 null。
这个时序界面根本不知道，所以**收进 SDK 内部**：

```java
requestCast(view)   // 界面只说"我要投屏"
  → 服务已就绪？立刻投
  → 还没就绪？排队，等 startServices() 回来放行
  → 兜底：服务就绪回报超时（3s+2s）也强行试一次，不让人对着按钮干等
```

`startServices()` 的 `finally` 里**无论成败都置 ready** ——
只在成功时置的话，服务起失败就永远卡在"等服务就绪"，表现又变回"点了没反应"。

### ⚠️⚠️ 错误码 15 = `DEVICE_NEED_REPLUG`：闪退/强杀之后的眼镜脏态

这是**最容易被误判**的一条，值得单开一节。

`onError(int, String)` 的码表在 AAR 的 `com.llvision.glass3.platform.ErrorCode` 里
（注意它**不是** `ResultCode` —— `ResultCode` 全是负数，`ErrorCode` 是正数）：

```
1 NOT_PERMISSION_STORAGE   2 NOT_PERMISSION_AUDIO   3 NOT_PERMISSION_OVERLAY
4 NOT_PERMISSION_USB       5 SERVICE_OCCUPIED       6 SERVICE_NOT_BIND
7 CLIENT_NOT_FOUND         8..14 FIRMWARE_*
10 FIRMWARE_NO_DEVICE      15 DEVICE_NEED_REPLUG
```

官方样例的注释把 15 解释得很清楚：

> 杀进程后眼镜仍停留在已连接脏态：平台层为避免打崩内核 USB 主控已主动放弃自动复位，
> 回调 DEVICE_NEED_REPLUG。

也就是说：**进程被强杀（闪退 / force-stop / `adb install -r` 装新包）时，
眼镜会留在"以为自己还连着"的脏态，而且 SDK 故意不会自己修**。

后果是一整套看着像别的毛病的现象：

```
getGlass3DeviceList() → List(size=0)      ← 设备列表空了
device：null                               ← 连接状态没了
LCD 服务就绪：否
点击投屏 → 未连接
```

**唯一解法：把眼镜拔下来再插上。** 用户会本能地去反复重装、重启手机，
而正确动作只有拔插一次 —— 所以 App 必须把这句话直接说出来，
而不是显示"投屏失败"让人继续猜。

代码里的处理（`GlassesSdk.onSdkError`）：收到 15 就清干净本地状态
（device / display / casting / servicesReady / pendingCast）并明确提示拔插。

> 顺带说明为什么开发期特别容易撞上这条：**每次 `install -r` 装新包都会杀进程**，
> 所以改一版装一版的过程本身就在制造脏态。
> 调试期间装机之后先拔插一次眼镜，能省掉很多"明明改对了却没反应"的困惑。

### 投屏画布的尺寸：必须等于眼镜的分辨率

这是「数据越界」和这次闪退的共同根因。

SDK 的 LCD 传输**按设备分辨率分配缓冲**，再从投屏的 View 里取像素。
所以画布尺寸必须和眼镜一致。我前一版按**手机屏幕宽度**算：

```java
int width  = metrics.widthPixels;          // ❌ 1080（手机的）
int height = Math.round(width / ratio);    //    1440
```

比例虽然对（3:4），但像素比眼镜大了一倍多 → 缓冲装不下 →「数据越界」，严重时直接闪退。

现在（`GlassesSubtitleView.setDisplaySize`）：

| 情况 | 做法 |
|---|---|
| 读到真实分辨率 | LayoutParams 定为那个像素尺寸 + 自己 `measure`/`layout`，保证 `getWidth()` 不为 0 |
| **读不到** | 只用 `MATCH_PARENT`，**不自己 measure** —— 完全照官方样例（样例的 overlay 就是一个没有 LayoutParams 的 FrameLayout） |

读不到时**绝不去猜尺寸**：猜错就是「数据越界」，那比不投还糟。

字号也跟着改成**按画布尺寸算的 PX**：这个 View 的 density 是**手机**的，
继续用 SP 的话，34sp 在 density 2.75 的手机上 ≈ 93px，
而 480 宽的眼镜画布一行只放得下 5 个字。

### LayoutParams 的类型必须和父容器匹配（真机闪退）

**现象**：调节字号时 App 闪退，堆栈是

```
java.lang.ClassCastException: android.view.ViewGroup$LayoutParams
        cannot be cast to android.view.ViewGroup$MarginLayoutParams
    at android.view.ViewGroup.measureChildWithMargins(ViewGroup.java:7074)
    at android.widget.FrameLayout.onMeasure(FrameLayout.java:194)
    ...
    at android.view.ViewRootImpl.performTraversals
```

**原因**：`FrameLayout` 测量子 View 时走 `measureChildWithMargins`，
那里会把子 View 的 LayoutParams **强转成 `MarginLayoutParams`**。
而裸的 `ViewGroup.LayoutParams` **不是** `MarginLayoutParams` 的子类 —— 直接崩。

我写的是：

```java
root.setLayoutParams(new ViewGroup.LayoutParams(w, h));   // ❌ root 是 FrameLayout
root.setLayoutParams(new FrameLayout.LayoutParams(w, h)); // ✅ 它才是 MarginLayoutParams 的子类
```

**为什么"只在调字号时才崩"**：设置画布尺寸本来只在**投屏前**跑过一次，
那时这块 View 还没被 SDK 收进它的容器、不在任何布局遍历里，所以没事。
而调字号会**再跑一次** —— 这时 View 已经在 SDK 的容器里，
下一次窗口遍历就会去 measure 它 → 当场崩。

> **规则**：给自己造的 View 设 `LayoutParams` 时，**类型必须和父容器匹配**。
> 父容器是 `FrameLayout` 就用 `FrameLayout.LayoutParams`，
> `LinearLayout` 就用 `LinearLayout.LayoutParams`，别图省事用基类
> （基类在需要 margins 的父容器里一定崩）。

### 附带的一条教训：「抓不到堆栈」推不出「原生崩溃」

我一开始按"抓不到 Java 堆栈 = 原生崩溃"推断成**改被采样的 View 有数据竞争**，
于是加了"停投屏 → 等 400ms → 改 → 重投"（还配了 700ms 防抖），
让校准变得很难用（每按一下黑一秒），而**根本没修到点上**。

真相是上面那个 `ClassCastException` —— 它是普通 Java 异常，
`CrashLog` 本来就能抓到，只是我**没让用户先去拿那份堆栈**就动手改设计了。

> **"没有堆栈"只能推出"不是 Java 崩溃"，推不出"是什么"**。
> 先拿到证据，再改设计。

（这次之所以最终拿到了堆栈，是因为加了"面包屑"：动作开始前写文件、
回到后台时删掉 —— 下次启动发现文件还在就报"上次没走完：<动作>"。
即使没有堆栈，也至少知道死在哪个动作里。这个机制留下了。）

### 「投屏成功但眼镜上看不到东西」：LCD 开关与眼位

真机第五轮的现象：`createCaptureScreen` 返回成功、界面显示"眼镜投屏中"，
但**眼镜仍然停在固件自己的**"请在手机上进行操作"那一屏。
说明 LCD 根本没切到我们这条采集流上。

根因是**少了投屏前的准备步骤**。官方样例在这件事上是**间接**暴露的 ——
它的 `setPort()` 里写着：

```kotlin
if (!lcdOn) { g.setSwitch(true) }     // ← 先把 LCD 打开
g.setDisplayPortNumber(port, v)       // ← 再显式打开眼位
```

也就是说：**LCD 可能处于关闭态，而眼位是要显式打开的** ——
光调 `createCaptureScreen` 不够。

我犯的错是"观察性推断"：看到样例的 `startOverlayTransfer()` 里只调了
`createCaptureScreen`，就断定眼位默认是对的，于是把它去掉了。
但样例的 UI 是**分开的按钮**（"开始叠加投屏" 和 "左眼/右眼/双眼"），
用户会先点眼位再投屏 —— 在 ViewModel 层面当然看不到这个顺序。

> **教训**：样例里"某个函数没调某个 API"**不能推出**"那个 API 不需要调"，
> 因为样例的 UI 可能把步骤拆成按钮，由用户手动按顺序点。
> 判断"需不需要"要看**样例的状态机**，不能只看单个函数体。

所以 `cast()` 现在是五步，第 ③ 步专做这件事（`prepareDisplay`）：
`setSwitch(true)` + `setDisplayPortNumber(DOUBLE_EYE_PORT, 1)`，
两步都**不中止流程**（失败时可能只是部分可见，继续走比不投更有信息量）。

### 帧回调：唯一能证明"SDK 到底有没有出画面"的硬证据

排查"看不见"最难的地方是**分不清两种完全不同的故障**：

| 现象 | 真正的问题在哪 |
|---|---|
| SDK 根本没产出画面 | **手机侧** —— 采集没跑起来、View 尺寸不对 |
| 产出了画面但眼镜没显示 | **眼镜侧** —— LCD 没开、眼位没开 |

靠症状猜这两者是没法区分的。`ICaptureDisplayFrameCallback` 把它变成可测的：

```java
// public interface ICaptureDisplayFrameCallback {
//     void onFrameAvailable(byte[] data, int width, int height);
// }
```

挂了它以后有两组硬数据：

- **帧数**：0 帧 → 采集压根没跑（手机侧）；有帧 → 采集是活的。
- **首帧的非黑比例**：有帧但全黑 → View 没画出东西（尺寸 0×0 / 内容没渲染）；
  有帧且有内容 → 问题在眼镜侧（LCD / 眼位）。

诊断行会显示 `帧 N · W×H · 非黑 x%`。**只统计第一帧** ——
这个回调在传输线程上按帧率触发，逐帧扫像素会拖慢投屏本身。

同时读 `getLCDInfo()`：`open` 决定"能不能显示"，
`displayMode` 决定"显示的是哪一路"（0=同步 1=叠加 -1=已停），
投屏后模式没变成 1 就说明采集根本没接管。

### `probeApi()`：长按诊断行就能看见 SDK 的真实结构

反射调用唯一可靠的排查手段是**把真实结构打出来**。所以眼镜预览页的诊断行
**长按**会弹出一个探测结果，按 ①②③… 编号，**第一个 ✗ 就是卡住的位置**：

```
① ✓ SDK 单例 com.llvision.glass3.platform.LLVisionGlass3SDK@...
② ✓ getGlass3DeviceList() → List(size=1)
③ ✓ Glass3DeviceClient 常量：LCD CAMERA ...
④ ✓ LCD 客户端 com.llvision...XxxImpl
   getGlassDisplay 重载：
    getGlassDisplay(com.llvision.glass3.platform.IGlass3Device)
⑤ ✓ getGlassDisplay(IGlass3Device) → com.llvision...YyyImpl
   createCaptureScreen 重载：
    createCaptureScreen(android.app.Activity, android.view.View)
⑥ ✓ createCaptureScreen(Activity, View) 存在
⑦ ✓ DOUBLE_EYE_PORT = 0
device：com.llvision...ZzzImpl
LCD 服务就绪：是
投屏步：③ createCaptureScreen
```

设计上的两个刻意选择：

- **不猜类名。** 第一版我硬编码 `ILCDClient` / `IGlassDisplay` 去 `Class.forName`，
  但反射要的是**精确签名**，猜类名毫无意义。现在改成先把对象真取出来，
  再打印它**运行时**的类名与方法签名。
- **只 `getMethod` 查找，不 `invoke`。** 探测不该改变状态 ——
  真的调用 `createCaptureScreen` 会**开始投屏**，那探测本身就变成了一次副作用。

`GlassesSdk` 里还留了一个 `step` 字段（`①取客户端 / ②getGlassDisplay / ③createCaptureScreen / ④已投屏`），
诊断行第二行会显示它，用来区分"根本没点到"和"点到了但卡在第几步"。

### 还没验证的（**第一次接真机必然要动这些**）

1. 投屏时**要不要用户授权**、会不会每次都问
2. 眼镜的**实际分辨率与长宽比** → 决定 `GlassesSubtitleView` 的字号（现在是按 20 列估的）
3. 投屏的**帧率与延迟**够不够看字幕
4. 反射调用的**签名对不对** —— 现在有 `probeApi()` 可以直接看，不用再猜

---

## 11. 构建与已知障碍（本机实测）

```powershell
# 本机 Gradle（缓存里已有 8.6）
& "$env:USERPROFILE\.gradle\wrapper\dists\gradle-8.6-bin\afr5mpiioh2wthjmwnkmdsd5w\gradle-8.6\bin\gradle.bat" assembleDebug --offline
# 或用仓库脚本（它会自己找 gradle）
node scripts/build-apk.mjs
```

**两个环境障碍，都不是代码问题**：

| 障碍 | 现象 | 绕法 |
|---|---|---|
| Gradle 要写 `~/.gradle` | 受限沙箱里报 `Could not initialize native services` | 在普通终端/放开权限跑（仓库 README 早有记录） |
| **Maven 仓库 TLS 握手被掐** | `Remote host terminated the handshake`（Maven Central 与 dl.google.com 都这样） | 与 HF 镜像那个自签名证书同源 —— 本机有代理/杀软在做 SSL 检查 |
| 本机缓存**零散不全** | 多个构件只有 `.pom` 没有 `.aar`（`kotlin-stdlib:1.8.22`、`profileinstaller:1.3.1`…） | `app/build.gradle.kts` 底部用 `resolutionStrategy.force` 压到缓存里完整的那版 |

> ⚠️ **那段 `force` 是环境绕过，不是正确做法。** 换一台能联网、缓存完整的机器时
> **应当整段删掉**，让 Gradle 正常解析 SDK 声明的版本。文件里也写在注释里了。

### 依赖这件事的一个纠正

样例的 `build.gradle.kts` 注释说「platform AAR 合并清单依赖 Glide（GIF 解码）」，
但**实测 AAR 的 `classes.jar` 里 0 处引用 Glide**，反而引用了 **460 次 `androidx.*`**：

```
androidx.appcompat.app / androidx.core.app / androidx.fragment.app
androidx.activity.OnBackPressedCallback / androidx.annotation.*
androidx.lifecycle.LifecycleOwner / androidx.localbroadcastmanager.content
```

所以真正要同行的是 **AndroidX**，不是 Glide。**以代码为准，别信注释。**

