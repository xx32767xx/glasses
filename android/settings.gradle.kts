// 只含一个 app 模块。刻意不引入任何 AndroidX / Kotlin 依赖：
// 依赖越少，离线构建越稳，也越容易看懂。
pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}
dependencyResolutionManagement {
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "LeionLanGlasses"
include(":app")
