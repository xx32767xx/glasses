# CxrlSample — CXR-L SDK Android Sample (v1.1)

A teaching sample for the **CXR-L SDK** (`com.rokid.cxr:client-l:1.1.2`). It walks you through the complete integration path — environment check → authorization → session creation → capability calls — in the exact order a real app would use.

> 中文摘要见文末 [中文说明](#中文说明)。

## What this project demonstrates

| Area | What you will see |
| --- | --- |
| Environment check | `isRokidAppInstalled` / `checkRokidAppCompatibility` three-branch handling |
| Authorization | `requestAuthorization` with `GlassPermission`, lambda callback + `onActivityResult` fallback |
| Session | `CxrSessionManager.create(config)` → `CxrSession.connect(token)`, five-state visualization |
| Capabilities | CustomView, CustomApp (bundled demo APK), audio stream, photo capture, device control, custom commands |
| Event logs | Lifecycle callbacks and capability events with token redaction |

**Architecture**: single Activity + Jetpack Navigation + MVVM. The session object is held by the Hub; feature pages fetch it on demand and register/unregister their callbacks on page enter/exit. No wrapper hides the SDK — buttons and cards label the actual SDK methods they call.

## Prerequisites

1. **Android Studio** with a JDK 17 toolchain (minSdk 28, targetSdk 34, Kotlin 1.9+, AGP 8.2+).
2. A **real phone** with a compatible **Rokid AI App** installed, and the **glasses connected inside Rokid AI App** (system Bluetooth pairing is not enough).
3. Network access to the Rokid Maven repository (see below).

## Build & run

```bash
# Public network (default)
./gradlew assembleDebug            # or: gradlew.bat assembleDebug

# Rokid corporate network
./gradlew assembleDebug -PcxrRepoEnv=internal
```

The environment is switched through `gradle.properties` (`cxrRepoEnv=external|internal`) + `exclusiveContent` in `settings.gradle.kts`; only the `com.rokid.cxr` group resolves from the Rokid repository. Then install `app/build/outputs/apk/debug/app-debug.apk` on the phone.

App flow: **install_companion → authorize → select_scene** (setup) → **hub** → feature pages + **event_log**.

## Project structure

```
app/src/main/java/com/rokid/cxr/sample/
├── MainActivity.kt              # Single Activity host
├── model/                       # Pure data + policies (no SDK calls)
│   ├── SessionLaunchRequest.kt  #     scene-selection result -> SessionConfig
│   ├── SessionConfigPolicy.kt   #     config validation rules
│   ├── CxrFeature.kt / CxrFeaturePolicy.kt / CxrScenePhase.kt
│   ├── CONSTANT.kt / SceneRoutes.kt / GlassAppAssets.kt
│   └── selfView/                #     CustomView JSON schema model (CN/EN) + validator
├── viewmodel/                   # One ViewModel per page; hub holds the session
│   ├── SetupViewModel.kt        #     environment check + authorization
│   ├── SessionHubViewModel.kt   #     create/connect/close + five-state + event log
│   └── Audio/Photo/DeviceControl/CustomCmd/CustomView ViewModels
├── ui/
│   ├── setup/SetupFlowScreen.kt #     install_companion -> authorize -> select_scene
│   ├── hub/HubScreen.kt         #     five-state panel + capability entries
│   ├── hub/EventLogPage.kt      #     callback log with token redaction
│   └── feature/                 #     AudioPage / PhotoPage / DeviceControlPage /
│                                #     CustomCmdPage / CustomViewPage
├── navigation/CxrNavGraph.kt    # two-level nav graph + route guards
└── util/                        # CapsFactory, TokenRedactor, SessionReasonMapping
```

Code comments are bilingual (English body with 中文对照); UI strings are bilingual (default English + zh-rCN).

## Page → SDK API map

| Page (route) | SDK API demonstrated | Doc chapter |
| --- | --- | --- |
| SetupFlowScreen (`install_companion`) | `CxrSessionManager.getInstance`, `isRokidAppInstalled`, `checkRokidAppCompatibility` | Android: SDK Integration |
| SetupFlowScreen (`authorize`) | `requestAuthorization(activity, permissions) {}`, `parseAuthorizationResult` | Android: Authentication |
| SetupFlowScreen (`select_scene`) | `SessionConfig` building (`CUSTOM_VIEW` viewData / `CUSTOM_APP` package+activity+APK) | Android: Connection and Session |
| HubScreen (`hub`) | `manager.create(config)`, `session.connect(token)`, five-state `stateFlow`, `close()` | Android: Connection and Session |
| CustomViewPage (`feature/custom_view`) | `customViewUpdate(updateJson)` | Android: Glasses Custom View |
| CustomCmdPage (`feature/cmd`) | `sendCustomCmd(cmd, Caps, stream)`, `onCustomCmdResult(channelKey, data)` | Android: Custom Commands |
| AudioPage (`feature/audio`) | `startAudioStream()` / `stopAudioStream()`, `IAudioCallback` | Android: Audio |
| PhotoPage (`feature/photo`) | `takePhoto(width, height, quality)`, `IImageCallback` | Android: Photo Capture |
| DeviceControlPage (`feature/device_control`) | `setGlassBrightness` / `setGlassVolume` (0..100), `queryGlassesInfo` | Android: Device Control |
| EventLogPage (`event_log`) | `ISessionLifecycleCbk` + capability callbacks, unified log format | Development Flow and State Machine |

## CUSTOM_APP with zero input

The repo bundles a glasses-side demo APK at `app/src/main/assets/glass_apps/demo_glass_app.apk` (package `com.rokid.cxr.custom.demo`). When you choose **CUSTOM_APP** in `select_scene`, the sample pre-fills the package name, activity, and APK path from the bundled file — you can create the session and press connect with zero manual input. Replace the APK with your own glasses-side app to test your business (see `glass_apps/README.txt`).

> The bundled demo is built with the **CXR-S SDK** (`com.rokid.cxr:cxr-service-bridge`) and subscribes to `rk_custom_client` / replies on `rk_custom_key`. For glasses-side development details, see the CXR-S SDK documentation and the "Keys and System Broadcasts" chapter of the CXR-L docs.

## Documentation correspondence

This sample accompanies the CXR-L v1.1.0 developer documentation (Chinese `CXR-L-CN/` and English `CXR-L-En/` trees):

- **Quick Start** — the 9-step minimal path is a condensed version of this app's setup flow.
- **Development Flow and State Machine** — the five states visualized in `HubScreen`.
- **Android feature chapters** — each capability chapter ends with an "Appendix: sample mapping" table pointing into this project.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Gradle cannot resolve `com.rokid.cxr` | `cxrRepoEnv` value (internal/external) matches your network; you are not behind a proxy blocking the repo |
| Authorization never returns | Rokid AI App version passes `checkRokidAppCompatibility`; glasses connected inside Rokid AI App |
| Session stuck in Starting | SDK ≥ 1.1.2 (first-connection fix `85bcce7`); see the docs' Version History |
| Custom command has no reply | Glasses app subscribed to the same channel key as `sendCustomCmd` |

---

## 中文说明

CxrlSample 是 **CXR-L SDK（`com.rokid.cxr:client-l:1.1.2`）的 Android 教学示例**，按真实业务接入顺序展示：环境检查 → 授权 → 选择场景（`CUSTOM_VIEW` / `CUSTOM_APP`）→ 建连 → 能力调用 → 事件日志。

- **结构**：单 Activity + Navigation + MVVM（`model` / `viewmodel` / `ui` 分层），Hub 持有会话，功能页按需取用并在进出页面时成对注册/注销回调；不封装 SDK，按钮直接标注所调用的 SDK 方法。
- **构建**：`./gradlew assembleDebug`（公网）；公司内网加 `-PcxrRepoEnv=internal`。应用包名 `com.rokid.cxr.sample`，minSdk 28 / targetSdk 34。
- **零输入 CUSTOM_APP**：内置眼镜端演示 APK（`assets/glass_apps/demo_glass_app.apk`，包名 `com.rokid.cxr.custom.demo`），选择 CUSTOM_APP 场景时自动预填包名/Activity/APK 路径。
- **注释**：英文主体 + 中文对照；UI 文案双语（默认英文 + zh-rCN）。
- **对应文档**：CXR-L v1.1.0 开发者文档的「快速开始」「开发流程与状态机」及 Android 各能力专章（专章附录的对照工程表指向本工程）。
