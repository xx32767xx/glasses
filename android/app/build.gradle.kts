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
    // 显示那一块（字号固定值化、投屏样例、排版自检）到此收口，版本进 4.0，
    // 下一阶段的重点转到**准确率**。versionCode 从 29 起继续递增，
    // 不跟着 versionName 的位数走 —— 它只保证"每次都比上一个大"。
    // 4.1：把接真机那阵子的调试界面删掉（连接自检 / 真眼镜状态卡 / 诊断行），
    //      「排版自检」保留（它是排版校准工具，不是连接调试）。
    // 4.2：热词对照表阶段 1（设置 → 热词表：编辑 / 校验 / 上传 / 从电脑拉取）。
    //      这一版**只存取、不替换** —— 译文还没接它，见 docs/15 §11。
    // 4.3：设置页加「校对（第二遍）」开关（缺省开、可关）。
    // 4.4：热词表独立成底部第 4 栏（表格形式）、校对开关修好、连接进度修好。
    // 4.5：修"打开就闪退"（buildTermsPage 忘了被调用）+ showPage 判空；
    //      连接进度、校对开关两处修复也在这一版。
    // 4.6：热词表页按反馈改：单元格居中+换行、改完即可上传（实时同步）、
    //      去掉校验按钮改为自动校验（本地即时 + 电脑端防抖），补葡语列写中文的检查。
    // 4.7：账户（注册 / 登录 / token）。热词表只认 token，身份来自「设置 → 账户」，
    //      热词表页不再让用户填用户名（那等于自报身份、能改别人的表）。
    // 4.8：热词表页去掉重复的「未登录」；账户注册遇到旧版进程时直说（不再只报 not-found）。
    // 4.9：文案收紧（去掉括号里的解释、去掉口语腔、删掉冗余小字），界面只留必要信息。
    // 4.10：热词观测 —— 电脑发现"提到了名字但译文没写出规范写法"时，字幕下打一行小字
    //       （本场不改字幕，只提示"已记录"，下一场比对生效；docs/15 §17）。
    // 4.11~4.30：房间 / 发言权 / 术语库 / 账号 / 校对（详见 docs/21 §10）。
    // 4.31：401 统一提示（单会话踢下线时说人话，不再表现为"操作莫名失败"）。
    // 4.32：修 LanClient.java 被整文件写成 GBK 乱码（javac 报 9 个「未结束的字符串文字」）——
    //       以干净提交为基重建 + 重放 401 改动；并加一道源码完整性检查，见 docs/20 §12。
    // 4.33：房间页去掉重复的「术语库」按钮（选库在建房那一步）；修「莫名其妙掉登录」——
    //       authWhoAmI 原来返回 {code,json} 外壳，界面读 ok 永远 false，启动必回登录页，
    //       重登又按单会话踢掉另一台。现在拆包 + 区分「401 才清登录 / 连不上不踢」，见 docs/21 §4.33。
    // 4.34：修发言权互斥的客户端一侧 —— 被顶替（B 后开麦抢走）后 A 只在轮询里刷了文字、
    //       没停麦克风：界面显示发言人=B，音频却还在双路往识别流里灌。现在立刻停上传 +
    //       按钮回灰（蓝=在传/灰=空闲）+ Toast 提示；心跳被拒也立刻停。见 docs/21 §4.34。
    // 4.35：发言权改 WS 推送（/ws）：被顶替不再等 2 秒轮询，一推即到。服务端是手写的
    //       RFC6455（lib/ws-hub.mjs，仓库零依赖），客户端用缓存里的 Java-WebSocket 1.6.0；
    //       推送断了自动退回 2 秒轮询，心跳独立按 5 秒走。见 docs/21 §4.35。
    // 4.36：接上字幕保留期清理（P4）—— 超过 7 天的字幕每小时清一次、启动也清一次；
    //       保留天数可用 --utterance-retention-days 调。见 docs/21 §4.36。
    // 4.37：删掉 --from/--to —— 语种改成跟着每一句话走（手机上报 → 识别进程写进收件箱
    //       每一行的 from → 插件按行定方向）。见 docs/21 §4.37。
    // 4.38：音频文件不再无限增长 —— 超过 --audio-max-bytes（缺省 1 GB）就轮转成 .1
    //       再开新文件；计数跨重启有效。/status 报 audioMaxBytes 与 audioRotations。见 docs/21 §4.38。
    // 4.39：新入口补上「设置」与「隐私政策」两页（服务器/密钥/我说什么语言/校对开关/
    //       清空本机记录）；首页有入口，两个 Activity 不对外导出。见 docs/21 §4.39。
    // 4.40：修「点结束同传后弹 上传出错：thread interrupted」—— 主动停不算错，
    //       并且不再立刻 interrupt（那会丢掉最后半句），改成宽限 2 秒发完尾巴。见 docs/21 §4.40。
    // 4.41：建房后邀请码不再被选库框挡掉（长 Toast + 标题/正文都写码）；被别处登录顶下线时
    //       当场提示（SessionWatch 每 10 秒问一次 whoami，房间内轮询也判 401）。见 docs/21 §4.41。
    // 4.42：锁定态掉线不再永久占麦 —— 锁定租约 60 秒（普通 15 秒），GET /floor 顺手清扫并广播
    //       「XX 掉线，麦克风已释放」。见 docs/21 §4.42。
    // 4.43：字幕也走 WS 推送（与发言权同一条连接），/frame 长轮询保留兜底；
    //       两条通道共用 RoomActivity.applyFrame，不会各自渲染得不一样。见 docs/21 §4.43。
    // 4.44：修 4.41 带出来的选库框（setMessage 挤掉多选列表）；锁定按钮文案与权限一致；
    //       发起者退出 = 整场结束 → 服务端主动推 closed 并断开（轮询兜底判 410）。见 docs/21 §4.44。
    // 4.45：「被别处登录顶下线」改走推送 —— /ws?session=1 会话通道，服务端吊销旧 token 的那一刻
    //       就通知；SessionWatch 轮询保留，但推送在线时放宽到 60 秒。见 docs/21 §4.45。
    // 4.46：散会通知的兜底 —— 房间详情带 closed，房间页每 5 轮查一次；服务端能力标记缺失时
    //       在状态行直说「服务端版本较旧」。见 docs/21 §4.46。
    // 4.47：按原型视觉体系重做 5 个页面（蓝绿主色 / 白卡片 14dp / 主按钮渐变 315° /
    //       尺寸走 dimens token）；页面里不再有硬编码色值与裸 dp/sp。见 docs/21 §4.47。
    // 4.48：档 1 —— 旧版 App 冻结（作为翻译官 App 的参考实现）+ docs/23 集成契约
    //       + scripts/fake-frames.mjs（三条命令跑起假字幕）；首页旧版入口默认隐藏。见 docs/23。
    // 4.49：注册/登录页按原型重做（品牌圆 + 标语 + 三颗语言胶囊 + 邮箱/验证码同排 +
    //       协议勾选 + 全宽主按钮）；M4 门禁落地；出厂默认服务器地址可预填（密钥留空）。见 docs/21 §4.49。
    // 4.50：登录/注册改回显式切换（登录不显示邮箱与验证码）；修「同一台设备把自己踢下线」——
    //       注销没断会话推送 + 服务端只踢旧 token 的连接 + 客户端收到 kicked 先核实。见 docs/21 §4.50。
    // 4.51：修「点会议房间崩」——语言胶囊在布局里是 TextView，Activity 还在按 Button 取；
    //       顺手加一道 findViewById 类型一致性门禁（带反向自检）。见 docs/21 §4.51。
    // 4.52：房间页按原型重做 —— 顶部两行信息 / 中央字幕流（M1）/ 右侧三态悬浮条 /
    //       底部开麦胶囊（M3 原文开关 + 红色脉冲）；开麦与上传合成一个按钮。见 docs/21 §4.52。
    // 4.53：修字幕流重复（同一句三帧按「上一帧是增量」合并）；修顶部邀请码/主题不显示
    //       （房间详情在 client 之前拉、异常被吞）；成员按 username 读；调试文本不进状态行。见 docs/21 §4.53。
    // 4.54：M2 收尾 —— 移出成员接口（仅发起者，顺带释放他的麦）+ 抽屉里的管理者操作
    //       + 系统事件行（弱化居中，插在字幕流里）。见 docs/21 §4.54。
    // 4.55：用户实测三处 —— 人员/设备抽屉实时刷新（开着才轮询）；被移出的人立刻离场
    //       （WS 推 removed + 轮询兜底）；锁定按钮换成上锁/解锁图标、原文换成文字 + Switch。
    //       见 docs/21 §4.55。
    // 4.56：界面三语（中文 / 巴西葡语 / 英文）—— 会议室五页文案全部抽进 strings.xml，
    //       UiLang 管切换（登录页右上角 + 设置页）；登录页那条空状态栏不再挂着。见 docs/21 §4.56。
        versionCode = 85
        versionName = "4.56"

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

  // 发言权实时推送（4.35）：Android 没有内置 WebSocket 客户端，用 Java-WebSocket。
  // 服务端那半边是手写的（lib/ws-hub.mjs，Node 没有内置 WS 服务端，而仓库零依赖）。
  // 版本同样**贴着本机缓存**：1.6.0 的 jar+pom 都在，slf4j-api 1.7.30 也在 → 离线可构建。
  // ⚠️ 换成别的版本之前先在 ~/.gradle/caches 里确认有 jar，否则构建会卡在联网拉取。
  implementation("org.java-websocket:Java-WebSocket:1.6.0")
  implementation("org.slf4j:slf4j-api:1.7.30")
}
