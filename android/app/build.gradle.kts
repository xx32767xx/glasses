// app 模块：手机端 App + 眼镜 SDK 投屏
//
// ⚠️ 接 SDK 之后，"零依赖"这条守不住了，原因都是硬性的（见 docs/09-眼镜SDK接入.md）：
//   · 眼镜 SDK 的 AAR 引用了 460 次 androidx.* → gradle.properties 必须开 useAndroidX
//   · AAR 的 jni/ 只有 arm64-v8a → 必须限制 abiFilters，否则其他架构构建报错
//   · AAR 自己声明 minSdkVersion=24 → 我们正好是 24，不用动
plugins {
  id("com.android.application")
}

android {
  namespace = "com.leion.lanrelay"
  compileSdk = 34

  defaultConfig {
    applicationId = "com.leion.lanrelay"
    minSdk = 24
    targetSdk = 34
    versionCode = 26
    versionName = "0.3.12"

    // ⚠️ 必须只保留 arm64-v8a。眼镜 SDK 的 AAR 里**只有 arm64-v8a 的原生库**
    //    （libllvision_UVCCamera.so / liblcd.so / libllvision_usb100.so 等 22 个），
    //    不限制的话在 armeabi-v7a / x86 上会找不到对应 .so 而构建失败或运行时崩。
    ndk {
      abiFilters += listOf("arm64-v8a")
    }
  }

  buildTypes {
    release {
      // 验证阶段不做混淆，方便看堆栈
      // ⚠️ SDK 是第三方 AAR，开混淆要额外写 keep 规则（样例也是关的）
      isMinifyEnabled = false
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    buildConfig = false
  }
}

// ⚠️ 为什么需要这段 force：本机 Gradle 缓存里 `kotlin-stdlib:1.8.22` **只有 pom、没有 jar**
//    （框架目录在、构件缺失），而 Maven Central / dl.google.com 的 TLS 握手在本机被掐断
//    （和 HF 镜像那个自签名证书是同一类问题：本机有代理/杀软在做 SSL 检查），
//    所以联网也补不下来。缓存里 **1.9.20 是完整的**（4 个文件），把整族 kotlin-stdlib
//    提到 1.9.20 就能离线解析。
//
//    这是**环境绕过**，不是正确做法：换一台能联网的机器时应当删掉这段，
//    让 Gradle 正常解析 SDK 声明的版本。
configurations.all {
  resolutionStrategy {
    // Kotlin 运行时整族统一到 2.2.0 —— 缓存里这一版最完整（5 个文件），
    // 而 1.9.20 的 pom 会再要求 `kotlin-stdlib-common:1.9.20`（缓存里没有）。
    // 传进 2.x 是安全的：我们的代码是纯 Java，只用到 SDK AAR 依赖的极少数 kotlin 类型。
    force("org.jetbrains.kotlin:kotlin-stdlib:2.2.0")
    force("org.jetbrains.kotlin:kotlin-stdlib-common:2.2.0")
    force("org.jetbrains.kotlin:kotlin-stdlib-jdk7:1.9.20")
    force("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.9.20")
    force("androidx.activity:activity:1.9.0")
    force("androidx.core:core:1.13.0")
    // appcompat 的传递链会把 drawerlayout / customview 拉到 1.0.0，
    // 而缓存里 **1.1.1 / 1.1.0 才是完整的**（有 aar+pom）—— 提到这两版。
    force("androidx.drawerlayout:drawerlayout:1.1.1")
    force("androidx.customview:customview:1.1.0")
    // 同理：1.3.1 只有 pom/module、**没有 aar**；1.4.0 是完整的。
    force("androidx.profileinstaller:profileinstaller:1.4.0")
    force("androidx.lifecycle:lifecycle-common:2.6.2")
    force("androidx.lifecycle:lifecycle-runtime:2.6.2")
    force("androidx.lifecycle:lifecycle-viewmodel:2.6.2")
    force("androidx.lifecycle:lifecycle-viewmodel-savedstate:2.6.2")
    force("androidx.lifecycle:lifecycle-livedata-core:2.6.2")
    force("androidx.lifecycle:lifecycle-process:2.6.2")
    force("androidx.savedstate:savedstate:1.2.1")
    force("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
    force("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
  }
}

dependencies {
  // 眼镜 SDK（亮亮 Glass3 平台）。只需要 platform 那个：
  // core_ai（人脸识别 + OpenCV）我们不做视觉，不引入 ——
  // 顺带省掉它的 armeabi-v7a 库和 55 MB 人脸模型。
  //
  // 注意：这里用 implementation(files(...)) 而不是 flatDir 仓库，
  // 因为 AAR 的清单要被合并（它带了 USB 授权 Activity 和一堆 Service）。
  implementation(files("libs/platform-4.8.0.4-release.aar"))

  // AAR 的 classes.jar 直接引用了这些 AndroidX 包（grep 过，见 docs/09 第 5 节）。
  // glide **不需要** —— 样例注释说"合并清单依赖 Glide"，但实测 AAR 里 0 处引用 Glide。
  //
  // ⚠️ 版本刻意贴着**本机 Gradle 缓存里已有的**（离线也能构建）。
  //    换版本号之前先确认缓存里有，否则构建会去联网拉。
  implementation("androidx.appcompat:appcompat:1.6.1")
  implementation("androidx.core:core:1.13.0")
  implementation("androidx.fragment:fragment:1.5.4")
  implementation("androidx.localbroadcastmanager:localbroadcastmanager:1.0.0")
}
