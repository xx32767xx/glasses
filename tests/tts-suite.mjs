/**
 * tts-suite.mjs —— 译文朗读（TTS）这一层的门禁（5.30）
 * ============================================================================
 * 这一层的风险不在"能不能出声"，而在**出声的时机与场合**：
 *   · 会议里外放 = 隐私 + 自己回收自己的译文（自激循环）；
 *   · 攒了十几句还逐句念 = 用户听到的是半分钟前的话；
 *   · 关掉开关却还在念最后一句 = "我明明关了"。
 * 所以这里钉的是**策略**，不是音质。
 *
 * `TtsChunker` 是纯函数，直接编译执行（本仓库第一个可执行 Java 测试）；
 * 没有 JDK 的机器上那条用例会**明确打印跳过**，不静默算过。
 */

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'

const ROOT = join(import.meta.dirname, '..')
const JAVA_SRC = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')

export async function runTtsSuite({ it, check }) {
  const chunker = join(JAVA_SRC, 'TtsChunker.java')
  const checkSrc = join(ROOT, 'tests', 'java', 'TtsChunkerCheck.java')
  const speaker = join(JAVA_SRC, 'TtsSpeaker.java')
  const queue = join(JAVA_SRC, 'TtsQueue.java')
  const room = join(JAVA_SRC, 'RoomActivity.java')
  const settings = join(JAVA_SRC, 'SettingsActivity.java')

  await it('TtsChunker 是纯逻辑，规则靠**跑起来**验证（不是靠看）', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(chunker, 'utf-8')
    // 纯函数：不许依赖 Android（否则没法在 CI 上跑）
    check('不 import android.*', /import\s+android\./.test(source) === false,
      'TtsChunker 必须能在没有 Android SDK 的机器上编译执行')
    // 静态兜底：阈值与规则必须在（执行用例跑不了时，至少形状是钉住的）
    check('中文上限 80 字 / 西文 100 字', /MAX_CHARS_CJK = 80/.test(source)
      && /MAX_CHARS_OTHER = 100/.test(source))
    check('碎片合并阈值（中文 6 / 西文 14）', /MIN_CHARS_CJK = 6/.test(source)
      && /MIN_CHARS_OTHER = 14/.test(source))
    check('硬上限 8 块', /MAX_CHUNKS = 8/.test(source))
    check('认句末标点（中英文）', /\\u3002/.test(source) && /isLatinPeriod/.test(source))
    check('半角句点有小数/缩写的守卫', /Character\.isDigit\(text\.charAt\(next\)\)/.test(source))

    // 找 JDK：没有就明确跳过（不算通过）
    let javacOk = true
    try {
      execFileSync('javac', ['-version'], { stdio: 'ignore' })
    } catch (error) {
      javacOk = false
      if (error && error.code === 'EPERM') {
        console.log('  ⏭ 这个沙箱不允许 Node 起子进程（javac EPERM），跳过可执行用例。')
        console.log('    在普通终端里跑一次即可验证：node tests/tts-suite.mjs')
        return
      }
    }
    if (!javacOk) {
      console.log('  ⏭ 这台机器没有 javac，跳过可执行的 Java 用例（TtsChunkerCheck）')
      return
    }
    const out = join(VAR_DIR, 'test', 'tts-chunker')
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    execFileSync('javac', ['-encoding', 'UTF-8', '-d', out, chunker, checkSrc], { stdio: 'ignore' })
    // ⚠️ 不能用管道接输出：受限沙箱里 `spawn` + 管道会 EPERM。
    //    改成把 stdout/stderr 重定向到文件再读 —— 这条在普通终端与沙箱里都能跑。
    const logPath = join(out, 'check.log')
    const fd = openSync(logPath, 'w')
    try {
      execFileSync('java', ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
        '-cp', out, 'TtsChunkerCheck'], { stdio: ['ignore', fd, fd] })
    } catch {
      // 断言失败会以非零退出：报告已经写进文件，底下按内容判
    } finally {
      closeSync(fd)
    }
    const report = readFileSync(logPath, 'utf-8')
    check('切块规则全部通过（空输入/切句/装箱/合并/硬上限/小数点不切）',
      /passed=\d+ failed=0/.test(report) && /passed=17/.test(report), report.trim().slice(-200))
  })

  await it('TtsSpeaker：耳机/眼镜优先、禁外放、借了焦点要还', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(speaker, 'utf-8')
    // 只看代码，不看注释（注释里会提到"刻意不返回 TYPE_BUILTIN_SPEAKER"）
    const code = source.split('\n').filter((line) => {
      const t = line.trim()
      return t.startsWith('*') === false && t.startsWith('//') === false && t.startsWith('/*') === false
    }).join('\n')
    check('先合成到文件再播（否则设不了输出设备）',
      /synthesizeToFile\(/.test(code) && /setPreferredDevice\(/.test(code))
    check('只挑近耳输出：USB/有线/蓝牙', /TYPE_USB_HEADSET/.test(code)
      && /TYPE_WIRED_HEADPHONES/.test(code) && /TYPE_BLUETOOTH_A2DP/.test(code))
    check('**不返回**内置扬声器（会议里禁止外放）',
      /TYPE_BUILTIN_SPEAKER/.test(code) === false, '出现内置扬声器 = 可能外放')
    check('没有耳机时如实拒绝，并说清原因',
      /没有耳机或眼镜/.test(source))
    check('申请音频焦点后一定还回去（借了不还是幽灵 bug 的来源）',
      /abandonAudioFocusRequest/.test(code))
    check('stop() 幂等且能打断在播的那块', /public void stop\(\)/.test(code)
      && /playbackLatch/.test(code))
  })

  await it('TtsQueue：积压丢弃、过期不播、关掉立刻闭嘴', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(queue, 'utf-8')
    check('队列上限 3 句', /MAX_PENDING = 3/.test(source))
    check('超过 12 秒的译文不再念', /MAX_AGE_MS = 12_000L/.test(source))
    check('积压时丢**最旧**的（不是丢新的）', /while \(pending\.size\(\) >= MAX_PENDING\)/.test(source))
    check('过时判断在**出队时**做（排队时还算新，轮到时可能已经过时）',
      /long age = System\.currentTimeMillis\(\) - item\.at/.test(source))
    check('关掉开关立刻停并清空', /public void setEnabled\(boolean value\)[\s\S]{0,200}?stop\(\)/.test(source))
    check('用代次作废在途任务（否则"关了还在念最后一句"）',
      /generation \+= 1/.test(source) && /generation != recordedGeneration/.test(source))
  })

  await it('接线：只念定稿译文，说话时闭嘴，朗读时让出实时传声', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(room, 'utf-8')
    check('只对**定稿**帧入队（增量帧是半句，念出来很怪）',
      /if \(!partial && ttsQueue != null && !target\.isEmpty\(\)\)/.test(source))
    check('入队带语言（按目标语言选发音）', /ttsQueue\.offer\(target, frameLang/.test(source))
    check('要说话就先停朗读（否则自己的译文被自己录回去）',
      /private void startUpload\(MicrophoneListener|private void startUpload\(MicUploader\.Listener listener\) \{\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(ttsQueue != null\) ttsQueue\.stop\(\);/.test(source))
    check('朗读时**暂停对方原声**（方案 1 二选一）',
      /boolean shouldPlay = listenWanted && !holding && !speakingTranslation/.test(source))
    check('releaseAudio 也把朗读停掉', /releaseAudio[\s\S]{0,700}?ttsQueue\.stop\(\)/.test(source))
    check('离开房间释放朗读引擎', /onDestroy[\s\S]{0,400}?ttsQueue\?\.?|ttsQueue\.shutdown\(\)/.test(source)
      || /ttsQueue\.shutdown\(\)/.test(source))
    check('开关来自设置页（默认关）',
      /getBoolean\("ttsRead", false\)/.test(source))
    const settingsSource = readFileSync(settings, 'utf-8')
    check('设置页能改这个开关', /setAppTtsRead/.test(settingsSource)
      && /putBoolean\("ttsRead"/.test(settingsSource))
  })

  await it('按语言挑引擎（AsrRouter）：跑起来验，不靠看代码', async () => {
    const { readFileSync } = await import('node:fs')
    const backend = readFileSync(join(JAVA_SRC, 'InterpreterAsrBackend.java'), 'utf-8')
    const routerPath = join(JAVA_SRC, 'AsrRouter.java')
    const routerSrc = readFileSync(routerPath, 'utf-8')
    // 纯逻辑：不许依赖 Android（否则没法在 CI 上跑）
    check('AsrRouter 不 import android.*', /import\s+android\./.test(routerSrc) === false)
    check('接口里"语言"是一等公民：languages() / supports() / start(lang, …)',
      /String\[\] languages\(\)/.test(backend) && /default boolean supports\(String lang\)/.test(backend)
      && /void start\(String lang, Listener listener\)/.test(backend))
    check('通用后端（自判语种）只能兜底、不能抢专用后端的活',
      /if \(backend\.isUniversal\(\)\) continue;/.test(routerSrc))
    check('语言未知时也交给通用后端', /语言未知，交给通用后端自行判定/.test(routerSrc))
    check('找不到就**如实失败**（绝不拿别的语言硬顶）',
      /没有能识别 \" \+ lang \+ \" 的引擎/.test(routerSrc))

    let javacOk = true
    try {
      execFileSync('javac', ['-version'], { stdio: 'ignore' })
    } catch (error) {
      javacOk = false
      if (error && error.code === 'EPERM') {
        console.log('  ⏭ 这个沙箱不允许 Node 起子进程（javac EPERM），跳过可执行用例。')
        return
      }
    }
    if (!javacOk) {
      console.log('  ⏭ 这台机器没有 javac，跳过 AsrRouterCheck')
      return
    }
    const out = join(VAR_DIR, 'test', 'asr-router')
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    const src = join(ROOT, 'tests', 'java', 'AsrRouterCheck.java')
    execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
      join(JAVA_SRC, 'InterpreterAsrBackend.java'), routerPath, src], { stdio: 'ignore' })
    const logPath = join(out, 'check.log')
    const fd = openSync(logPath, 'w')
    try {
      execFileSync('java', ['-Dstdout.encoding=UTF-8', '-cp', out, 'AsrRouterCheck'],
        { stdio: ['ignore', fd, fd] })
    } catch {
      // 断言失败会非零退出：报告已写进文件
    } finally {
      closeSync(fd)
    }
    const report = readFileSync(logPath, 'utf-8')
    check('23 条路由规则全通过（精确/简写/兜底/未知/无引擎/describe/语言下传）',
      /passed=23 failed=0/.test(report), report.trim().slice(-200))
  })

  await it('翻译官的两种语言（InterpreterLang）：规则跑起来验，不靠看代码', async () => {
    const { readFileSync } = await import('node:fs')
    const langPath = join(JAVA_SRC, 'InterpreterLang.java')
    const source = readFileSync(langPath, 'utf-8')
    // 纯逻辑：不许依赖 Android（否则没法在 CI 上跑）
    check('InterpreterLang 不 import android.*', /import\s+android\./.test(source) === false)

    let javacOk = true
    try {
      execFileSync('javac', ['-version'], { stdio: 'ignore' })
    } catch (error) {
      javacOk = false
      if (error && error.code === 'EPERM') {
        console.log('  ⏭ 这个沙箱不允许 Node 起子进程（javac EPERM），跳过可执行用例。')
        return
      }
    }
    if (!javacOk) {
      console.log('  ⏭ 这台机器没有 javac，跳过 InterpreterLangCheck')
      return
    }
    const out = join(VAR_DIR, 'test', 'interp-lang')
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    execFileSync('javac', ['-encoding', 'UTF-8', '-d', out, langPath,
      join(ROOT, 'tests', 'java', 'InterpreterLangCheck.java')], { stdio: 'ignore' })
    const logPath = join(out, 'check.log')
    const fd = openSync(logPath, 'w')
    try {
      execFileSync('java', ['-Dstdout.encoding=UTF-8', '-cp', out, 'InterpreterLangCheck'],
        { stdio: ['ignore', fd, fd] })
    } catch {
      // 断言失败会非零退出：报告已写进文件
    } finally {
      closeSync(fd)
    }
    const report = readFileSync(logPath, 'utf-8')
    check('31 条语言规则全通过（镜像/候选集合/归一化/钉正/AUTO）',
      /passed=31 failed=0/.test(report), report.trim().slice(-300))
  })

  await it('5.38：播报整层先停用（用户定「先不使用」），三处入口必须一致', async () => {
    const { readFileSync } = await import('node:fs')
    const gate = readFileSync(join(JAVA_SRC, 'TtsFeature.java'), 'utf-8')
    // 只有一个开关：翻回 true 时三处入口一起回来，不会出现"半开"（有开关但行为不一致）
    check('开关只有一处（TtsFeature.enabled()）', /public static boolean enabled\(\)/.test(gate))
    check('现在是**关**的', /public static boolean enabled\(\)\s*\{\s*return false;\s*\}/.test(gate))
    check('关掉的理由写在类注释里（不是靠人记）',
      /先不使用/.test(gate) && /qwen3-tts-flash/.test(gate) && /合并冻结/.test(gate))

    const settingsSource = readFileSync(settings, 'utf-8')
    check('设置页整块隐藏（连标题一起，不留一个悬空的按钮）',
      /if \(!TtsFeature\.enabled\(\)\)/.test(settingsSource)
      && /setAppTtsBlock/.test(settingsSource) && /setVisibility\(View\.GONE\)/.test(settingsSource))
    const roomSrc = readFileSync(room, 'utf-8')
    check('房间页关着就不建队列（不走进任何播报路径）',
      /if \(TtsFeature\.enabled\(\)\) \{\s*ttsQueue = new TtsQueue/.test(roomSrc))
    const interpSrc = readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')
    check('翻译官页同样不建队列、隐藏配置里那一行',
      /if \(TtsFeature\.enabled\(\)\) \{\s*ttsQueue = new TtsQueue/.test(interpSrc)
      && /interpConfigTtsBlock/.test(interpSrc))
    check('关着时界面不提"朗读"（不暗示一个不存在的功能）',
      /R\.string\.interp_meta_plain/.test(interpSrc))
  })

  await it('5.39：语言 → 识别函数的路由表（JSON 控制，可执行验）', async () => {
    const { readFileSync } = await import('node:fs')
    const assets = join(ROOT, 'android', 'app', 'src', 'main', 'assets')
    const raw = readFileSync(join(assets, 'asr-routes.json'), 'utf-8')
    const table = JSON.parse(raw)

    // ① 表的形状：default / languages / backends 三块都要有，且每门语言都指向**登记过的**后端
    check('表里有 version / default / languages / backends',
      typeof table.version === 'number' && table.default && table.languages && table.backends,
      JSON.stringify(Object.keys(table)))
    check('default 写了 backend', typeof table.default.backend === 'string' && table.default.backend !== '')
    const langs = Object.keys(table.languages)
    check('三门语言都有一行（zh-CN / pt-BR / en-US）',
      ['zh-CN', 'pt-BR', 'en-US'].every((one) => langs.includes(one)), JSON.stringify(langs))
    const dangling = langs.filter((lang) => {
      const id = table.languages[lang] && table.languages[lang].backend
      return !table.backends[id]
    })
    check('每门语言指向的后端都在 backends 里登记过（写错名字会静默跑错引擎）',
      dangling.length === 0, dangling.join(','))

    // ② 后端清单要和代码对得上：available=true 的必须真有实现类，false 的必须写明"没实现"
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    for (const [id, spec] of Object.entries(table.backends)) {
      if (spec.available === true) {
        check(`后端 ${id} 声明的实现类存在（${spec.impl}）`,
          typeof spec.impl === 'string' && existsSync(join(javaDir, `${spec.impl}.java`)),
          String(spec.impl))
      } else {
        check(`后端 ${id} 没实现时 impl 为空且写了说明`,
          (spec.impl === null || spec.impl === undefined) && typeof spec.desc === 'string' && spec.desc !== '',
          JSON.stringify(spec))
      }
    }

    // ③ 判定逻辑跑起来验（纯 Java，不依赖 Android）
    let javacOk = true
    try {
      execFileSync('javac', ['-version'], { stdio: 'ignore' })
    } catch (error) {
      javacOk = false
      if (error && error.code === 'EPERM') {
        console.log('  ⏭ 这个沙箱不允许 Node 起子进程（javac EPERM），跳过 AsrRouteTableCheck。')
        return
      }
    }
    if (!javacOk) {
      console.log('  ⏭ 这台机器没有 javac，跳过 AsrRouteTableCheck')
      return
    }
    const out = join(VAR_DIR, 'test', 'asr-route')
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    execFileSync('javac', ['-encoding', 'UTF-8', '-d', out,
      join(JAVA_SRC, 'InterpreterLang.java'), join(JAVA_SRC, 'AsrRouteTable.java'),
      join(ROOT, 'tests', 'java', 'AsrRouteTableCheck.java')], { stdio: 'ignore' })
    const logPath = join(out, 'check.log')
    const fd = openSync(logPath, 'w')
    try {
      execFileSync('java', ['-Dstdout.encoding=UTF-8', '-cp', out, 'AsrRouteTableCheck'],
        { stdio: ['ignore', fd, fd] })
    } catch {
      // 断言失败会非零退出：报告已写进文件
    } finally {
      closeSync(fd)
    }
    const report = readFileSync(logPath, 'utf-8')
    check('26 条路由判定全通过（命中/缺行/未实现/写错名字/没 default）',
      /passed=26 failed=0/.test(report), report.trim().slice(-300))

    // ④ 界面必须把"不可用"说出来，不许静默换后端
    const activity = readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')
    check('页面用的是表判出来的结果（不是自己猜一个后端）',
      /AsrRouteTable\.resolve\(/.test(activity) && /routeProblems/.test(activity))
    check('不可用时把原因显示出来', /interp_where_unavailable/.test(activity))
    // 5.40：engine 现在**真的发给服务器**了（5.39 时还只是记录），所以这里验两件事：
    // ① 手机把"这一路想用哪个模型"塞进会话创建请求；② 界面说的是"模型请求"，不是"已生效"
    const lanClient = readFileSync(join(JAVA_SRC, 'LanClient.java'), 'utf-8')
    check('会话创建时把语种→模型报给服务器（asrModels）',
      /body\.put\("asrModels"/.test(lanClient) && /server-default/.test(lanClient))
    check('服务器没指定模型时不乱发（空 / server-default 一律不发）',
      /!"server-default"\.equals\(wanted\)/.test(lanClient))
    check('界面写的是「模型请求」（不是保证生效）',
      /interp_where_engine/.test(activity))
    const relaySrc = readFileSync(join(JAVA_SRC, 'RelayPipelineBackend.java'), 'utf-8')
    check('把服务器**实际收到**的模型请求打进日志（A/B 时唯一可信的依据）',
      /optJSONObject\("asrModels"\)/.test(relaySrc))
  })

  await it('5.43：翻译官页必须报 versionCode（否则"装的是最新版还被要求更新"）', async () => {
    const { readFileSync } = await import('node:fs')
    const interp = readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')
    const room = readFileSync(join(JAVA_SRC, 'RoomActivity.java'), 'utf-8')
    // 真实问题：服务端门禁认纯数字 versionCode，不带这个参数一律判"版本过旧"→ 426。
    // 房间页一直有这一行；翻译官页是后接的链路，漏了 → 用户装了 4.148 却被告知要升到 4.148。
    check('翻译官页创建客户端时上报 versionCode',
      /setAppVersionCode\(String\.valueOf\(UpdateGuard\.versionCode\(this\)\)\)/.test(interp))
    check('房间页也上报（两处口径一致，别再各写一份）',
      /setAppVersionCode\(String\.valueOf\(UpdateGuard\.versionCode\(this\)\)\)/.test(room))
    check('上报的是**数字** versionCode，不是 versionName（4.9 vs 4.127 的坑）',
      /UpdateGuard\.versionCode\(/.test(interp) && !/setAppVersionCode\(UpdateGuard\.versionName/.test(interp))
  })

  await it('翻译官页头部与「创建会议」一致（标题在左、返回胶囊在右、没有右上角小字）', async () => {
    const { readFileSync } = await import('node:fs')
    const layoutDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const interp = readFileSync(join(layoutDir, 'page_interpreter.xml'), 'utf-8')
    const create = readFileSync(join(layoutDir, 'page_create_room.xml'), 'utf-8')
    const backBlock = (xml) => (xml.match(/android:id="@\+id\/\w*[Bb]ack"[\s\S]{0,600}?\/>/) ?? [''])[0]
    const mine = backBlock(interp)
    check('返回是胶囊（tap_pill + common_back + touch_min 高度）',
      /tap_pill/.test(mine) && /common_back/.test(mine) && /touch_min/.test(mine), mine.slice(0, 120))
    check('与创建会议页同一形式（同一个 drawable、同一个文案键）',
      /tap_pill/.test(create) && /common_back/.test(create))
    check('右上角的后端小字已删除（徽标不占返回按钮的位置）', !/interpBackend/.test(interp))
    check('页面代码里也不再引用那个徽标', !/R\.id\.interpBackend/.test(
      readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')))
    // 删掉了徽标，但"这一路走的什么"仍要能看见 —— 配置块里的摘要那行不能一起删
    check('摘要行还在（删徽标 ≠ 让页面不再说走哪条路）',
      /interpWhere/.test(interp) && /interp_where/.test(
        readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')))
  })

  await it('5.47：版本号必须**每个请求**都带（不只房间页），门禁只挡真正会写坏了的两条', async () => {
    const { readFileSync } = await import('node:fs')
    const client = readFileSync(join(JAVA_SRC, 'LanClient.java'), 'utf-8')
    // 真实问题：门禁覆盖 /hello /audio /frame /say，而"带 app=" 是各处手拼的 ——
    // 翻译官页漏了 hello，于是/log 里出现"报了（什么都没报）"，装最新版还被要求更新。
    check('有一条统一的"补 app=" 逻辑（不再各处手拼）',
      /private String withApp\(String path\)/.test(client) && /withApp\(path\)/.test(client))
    check('三个请求出口都过它（request / requestWithCode / requestRaw）',
      (client.match(/new URL\(baseUrl \+ withApp\(path\)\)/g) ?? []).length === 3,
      String((client.match(/new URL\(baseUrl \+ withApp\(path\)\)/g) ?? []).length))
    check('没有版本号时原样返回（不让路径变成 app= 空串）', /if \(app\.isEmpty\(\)\) return path;/.test(client))
    check('已经有 app= 就不重复加', /if \(path\.contains\("app="\)\) return path;/.test(client))
    check('启动时设一次全局缺省（不依赖"某个页面记得调"）',
      /static void setDefaultAppVersionCode/.test(client)
      && /LanClient\.setDefaultAppVersionCode\(String\.valueOf\(UpdateGuard\.versionCode\(this\)\)\)/
        .test(readFileSync(join(JAVA_SRC, 'MainActivity.java'), 'utf-8')))

    // 门禁范围：只挡"会写进数据"的两条。读字幕（/frame）与手输一句话（/say）
    // 不该因为版本号抖动把整场字幕断掉 —— 用户提的方案（只在登录界面拦）落地成这个窄化版。
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')
    check('门禁只管 /hello 与 /audio（写入路径）',
      /const GATED_ENDPOINTS = new Set\(\['\/hello', '\/audio'\]\)/.test(relay))
    check('/frame 与 /say 不再被版本门禁挡住',
      !/'\/frame'/.test(relay.match(/const GATED_ENDPOINTS[^\n]*/)?.[0] ?? "'/frame'")
      && !/'\/say'/.test(relay.match(/const GATED_ENDPOINTS[^\n]*/)?.[0] ?? "'/say'"))
  })

  await it('错误码注册表：加码只改三处，漏一处自动红（不用改测试）', async () => {
    const { readFileSync } = await import('node:fs')
    const registryPath = join(JAVA_SRC, 'InterpreterErrorCodes.java')
    const registry = readFileSync(registryPath, 'utf-8')
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')

    // ① 从**注册表本身**读出所有码（不是写死清单）—— 所以以后加码，这条测试自动覆盖。
    //    只认"既声明了常量、又在 MESSAGES 里注册了"的码：注释里的示例写法不算。
    const constants = new Map([...registry.matchAll(/public static final String ([A-Z_]+) = "([a-z0-9-]+)"/g)]
      .map((m) => [m[1], m[2]]))
    const registered = [...registry.matchAll(/put\(([A-Z_]+), R\.string\.([a-z_0-9]+), (true|false)\)/g)]
      .map((m) => ({ constant: m[1], resource: m[2], retryable: m[3] === 'true' }))
    const codes = registered.map((one) => constants.get(one.constant)).filter((code) => code !== undefined)
    check('注册表里至少登记了识别/采集/朗读三类码', codes.length >= 8, `只找到 ${codes.length} 个`)
    check('每个 put(...) 用的常量都声明过码值',
      registered.every((one) => constants.has(one.constant)),
      registered.filter((one) => !constants.has(one.constant)).map((one) => one.constant).join(','))
    check('码的格式统一（小写 + 连字符）', codes.every((code) => /^[a-z][a-z0-9-]*$/.test(code)),
      codes.join(','))
    check('码与资源名一一对应（err_ + 连字符换下划线）',
      registered.every((one) => one.resource === `err_${String(constants.get(one.constant)).replace(/-/g, '_')}`),
      registered.filter((one) => one.resource !== `err_${String(constants.get(one.constant)).replace(/-/g, '_')}`)
        .map((one) => one.constant).join(','))

    // ② 每个码都要有 `err_<code>` 的三语文案（资源名 = err_ + 连字符换下划线）
    const resourceOf = (code) => `err_${code.replace(/-/g, '_')}`
    for (const dir of ['values', 'values-en', 'values-pt-rBR']) {
      const xml = readFileSync(join(resDir, dir, 'strings.xml'), 'utf-8')
      for (const code of codes) {
        check(`${resourceOf(code)} 在 ${dir} 里有`, new RegExp(`name="${resourceOf(code)}"`).test(xml),
          `码 ${code} 缺三语文案（加码时三套 strings.xml 都要加）`)
      }
    }

    // ③ 每个码都要在 MESSAGES 里注册（有文案但没映射 = 界面上永远看不到它）
    for (const code of codes) {
      check(`${code} 在 MESSAGES 里注册了文案`, new RegExp(`put\\([A-Z_]+, R\\.string\\.${resourceOf(code)}`).test(registry),
        `${code} 没有 put(...) 映射`)
    }

    // ④ 兜底链与"能不能重试"这两个语义必须存在
    check('有"未知码 → 人话 → 通用话"的兜底链',
      /if \(hint != null && !hint\.trim\(\)\.isEmpty\(\)\) return hint\.trim\(\)/.test(registry)
      && /err_generic/.test(registry))
    check('每个码都标了能不能自动重试', (registry.match(/put\([A-Z_]+, R\.string\.[a-z_]+, (true|false)\)/g) ?? []).length === codes.length,
      '有码没标 retryable')
    check('有诊断用的摘要（码 + 可重试/需人工）', /public static String diagnostic\(/.test(registry))

    // ⑤ 调用方必须按码翻译，而不是直接显示后端人话
    for (const file of ['InterpreterActivity.java', 'RoomActivity.java']) {
      const source = readFileSync(join(JAVA_SRC, file), 'utf-8')
      check(`${file} 用注册表翻错误码`, /InterpreterErrorCodes\.message\(/.test(source),
        '直接 setText(hint) 会让英文界面出现中文')
    }
    check('朗读失败也带着码（不是只有一句中文）',
      /TTS_ENGINE|TTS_FAILED/.test(readFileSync(join(JAVA_SRC, 'TtsSpeaker.java'), 'utf-8')))
  })

  await it('翻译官骨架：后端可换、明写"演示回放"、朗读复用同一套', async () => {
    const { readFileSync } = await import('node:fs')
    const backend = readFileSync(join(JAVA_SRC, 'InterpreterAsrBackend.java'), 'utf-8')
    const scripted = readFileSync(join(JAVA_SRC, 'ScriptedAsrBackend.java'), 'utf-8')
    const activity = readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')
    const home = readFileSync(join(JAVA_SRC, 'HomeActivity.java'), 'utf-8')
    const manifest = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf-8')
    const layout = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout',
      'page_interpreter.xml'), 'utf-8')

    // ① 接口就是"两种 ASR 都能接"的那层隔离
    check('后端接口只暴露 ready/partial/final/error 四类事件',
      /void onReady\(\)/.test(backend) && /void onPartial\(/.test(backend)
      && /void onFinal\(/.test(backend) && /void onError\(/.test(backend))
    check('接口说清"回调在后台线程、界面自己 post"', /回调都在后台线程/.test(backend))
    check('接口说清"允许随时丢音频"（阻塞采集比丢一句更糟）', /允许随时丢/.test(backend))
    // ② 回放后端：不假装识别
    check('回放后端忽略 PCM（不假装识别）', /sendAudio[\s\S]{0,200}?什么都不做/.test(scripted))
    check('回放后端有 partial 逐段生长（界面能真跑一次原位更新）',
      /target\.onPartial\(id, sentence\.substring/.test(scripted))
    check('三套剧本（中/葡/英）', /startsWith\("pt"\)/.test(scripted) && /startsWith\("en"\)/.test(scripted))

    // ③ 页面：明写"这一路走的什么"，不许"看着能用其实没接"
    // 5.43：用户要求删掉右上角的后端小字（位置留给返回胶囊），所以这条不再检查徽标，
    // 而是检查"这件事还有没有别处说清" —— 摘要行（interpWhere）+ 状态行文案。
    check('页面仍写明走哪条路（摘要行 + 后端名走资源）',
      /interpWhere/.test(layout) && /interp_backend_relay/.test(layout === null ? '' : readFileSync(
        join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf-8')))
    check('右上角的后端小字已按用户要求删除', !/interpBackend/.test(layout))
    check('状态行说清"目前是演示回放"', /尚未接入真实识别/.test(readFileSync(join(ROOT,
      'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf-8')))
    check('页面同 id 原位更新（同一句只占一张卡）', /cardIds\.indexOf\(id\)/.test(activity))
    check('退到后台就停（不偷偷占资源）', /protected void onStop\(\)[\s\S]{0,200}?stopInterpreting\(\)/.test(activity))

    // ④ 朗读复用房间那套（策略一致）
    check('用同一个 TtsQueue', /new TtsQueue\(new TtsSpeaker\(this\)\)/.test(activity))
    check('只念**定稿**（partial 不念）', /onFinal[\s\S]{0,300}?ttsQueue\.offer/.test(activity))
    check('开关同样来自设置页', /getBoolean\("ttsRead", false\)/.test(activity))

    // ⑤ 入口接上了
    check('首页卡片有真入口', /homeCardInterpreter\)\.setOnClickListener/.test(home))
    check('Manifest 里注册了页面', /\.InterpreterActivity/.test(manifest))
  })

  await it('三语文案齐全（朗读开关 + 正在朗读）', async () => {
    const { readFileSync } = await import('node:fs')
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    for (const dir of ['values', 'values-en', 'values-pt-rBR']) {
      const xml = readFileSync(join(resDir, dir, 'strings.xml'), 'utf-8')
      for (const key of ['set_tts_read', 'set_tts_read_hint', 'st_tts_on', 'st_tts_off', 'st_tts_speaking']) {
        check(`${key} 在 ${dir} 里有`, new RegExp(`name="${key}"`).test(xml))
      }
    }
  })
}
