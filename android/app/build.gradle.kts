// app 模块：一个 Activity、零依赖、只用平台 API
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
    versionCode = 1
    versionName = "0.1.0"
  }

  // 不引入 AndroidX，所以不需要 jetifier
  buildTypes {
    release {
      // 验证阶段不做混淆，方便看堆栈
      isMinifyEnabled = false
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  // debug 包也直接能装，不做签名配置（用默认 debug key）
  buildFeatures {
    buildConfig = false
  }
}
