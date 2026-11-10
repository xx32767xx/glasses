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

  await it('接线：只念定稿，说话时闭嘴，朗读时让出实时传声', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(room, 'utf-8')
    // 5.152：念译文**只有一个**触发点。原来 applyFrame 与 renderSegment 各有一处，
    // 两处条件同时满足时同一句会被念两遍（功能关着时没人发现）。
    check('入队只有一处（多一处就等于同一句念两遍）',
      (source.match(/ttsQueue\.offer\(/g) ?? []).length === 1)
    check('所有朗读都过 offerTts（不念自己 / 去重 / 空文本都在那里）',
      // 定义 1 处 + 调用 1 处（念译文）。5.159 把"念原文"那条调用删掉了：
      // 它和「听原声」是同一件事的两种说法，却给出相反行为。
      (source.match(/offerTts\(/g) ?? []).length === 2)
    check('念译文只念**主语言**那一份',
      /&& isPrimaryLang\(langKey\)\) \{\s*offerTts\(target/.test(source))
    check('不再有"念原文"那条路（与「听原声」重复且矛盾）',
      !/ttsMode == TTS_ORIGINAL/.test(source)
      && !/offerTts\(source, fromLang/.test(source))
    check('不念自己说的话（自己刚说完再被机器念一遍是噪音）', /who\.equals\(myName\)/.test(source))
    check('同一句去重（原文帧 + 各语言译文帧会先后到达）', /TTS_DEDUPE_MS/.test(source))
    check('没接耳机只提示一次（否则每句都把提示行刷一遍）', /ttsProblemShown/.test(source))
    check('要说话就先停朗读（否则自己的译文被自己录回去）',
      /private void startUpload\(MicrophoneListener|private void startUpload\(MicUploader\.Listener listener\) \{\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(ttsQueue != null\) ttsQueue\.stop\(\);/.test(source))
    // 5.158/5.159：用户要求"听译文的时候，说话人的原声不许传过来" —— 不是"念的那两秒暂停"，
    // 而是**在念的整个阶段都不放原声**（切到「听原声」才恢复）。
    check('在念的时候原声整体静音（而不是只在念的两秒）',
      /boolean mutedByTts = ttsMode == TTS_READ_TRANSLATION/.test(source)
      && /!speakingTranslation && !mutedByTts/.test(source))
    check('朗读只有两态（听原声 / 念译文），互斥且穷尽',
      /private static final int TTS_LISTEN_ORIGINAL = 0/.test(source)
      && /private static final int TTS_READ_TRANSLATION = 1/.test(source)
      && !/TTS_ORIGINAL/.test(source)
      && /ttsMode == TTS_READ_TRANSLATION && !target\.isEmpty\(\)/.test(source))
    check('切换档位要同时改队列开关与原声判定（否则切了声音不跟着变）',
      /private void setTtsMode\(int next\)[\s\S]{0,900}?ttsQueue\.setEnabled\(next == TTS_READ_TRANSLATION\)/.test(source)
      && /private void setTtsMode\(int next\)[\s\S]{0,1400}?applyListenState\(\)/.test(source))
    check('合成失败要把原因带进提示行、logcat 与服务器日志（"失败了却查不到"是不可接受的）',
      /client\.sendDiag\("tts-failed /.test(source) && /Log\.w\("LeionRoom", "🔈 合成失败：/.test(source))
    check('releaseAudio 也把朗读停掉', /releaseAudio[\s\S]{0,700}?ttsQueue\.stop\(\)/.test(source))
    check('离开房间释放朗读引擎', /onDestroy[\s\S]{0,400}?ttsQueue\?\.?|ttsQueue\.shutdown\(\)/.test(source)
      || /ttsQueue\.shutdown\(\)/.test(source))
    check('朗读默认在念译文（而不是默认静音）',
      /private int ttsMode = TTS_READ_TRANSLATION;/.test(source))
    check('档位来自偏好 ttsMode，且兼容两代旧偏好（ttsReadMode / ttsReadOriginal）',
      /PREF_TTS_MODE = "ttsMode"/.test(source)
      && /PREF_TTS_MODE_TRIPLE = "ttsReadMode"/.test(source)
      && /PREF_TTS_LEGACY_ORIGINAL = "ttsReadOriginal"/.test(source)
      && /getInt\(PREF_TTS_MODE, -1\)/.test(source))
    // 5.156：挪到**右侧悬浮条**（用户要求：原来挤在「退出」下面第二行，不好找）
    check('有「朗读」这一行（两态）', /R\.id\.roomTtsRow/.test(source))
    const layout = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout', 'page_room.xml'), 'utf-8')
    const infoBarStart = layout.indexOf('@+id/roomInfoBar')
    const bottomStart = layout.indexOf('@+id/roomUpload')
    const rowAt = layout.indexOf('@+id/roomTtsRow')
    check('这一行在右侧悬浮条里（不在底部那一行）',
      infoBarStart > 0 && rowAt > infoBarStart && rowAt < bottomStart,
      `infoBar=${infoBarStart} row=${rowAt} upload=${bottomStart}`)
    check('行上那颗小字显示当前档位（听原声 / 译文）',
      /@\+id\/roomTtsMode/.test(layout) && /R\.id\.roomTtsMode/.test(source)
      && /R\.string\.room_tts_translation : R\.string\.room_tts_listen/.test(source))
    // 5.161：**侧边栏只允许一个「朗读」标签**。
    // 用户实测报「两个朗读不知道干什么」—— 5.156 与 5.159 各加了一个标签（内容一模一样），
    // 于是侧边栏上出现两个重复入口。这属于「加功能时没看旁边」，所以用机器守着。
    check('侧边栏只允许一个「朗读」标签（不许重复入口）',
      (layout.match(/@string\/room_tts_read/g) ?? []).length === 1,
      `出现 ${(layout.match(/@string\/room_tts_read/g) ?? []).length} 次`)

    // 5.161：切到「听原声」时必须**强制重建**倾听状态。
    // 用户实测「切了听原声反而没声音」：applyListenState 是幂等的（状态没变就直接 return），
    // 而 listening / listenWanted 这两个标志可能与真实播放状态不同步 —— 于是它一直 return，
    // 播放器从来没被 start 过。切档位是用户明确表达「我现在要听原声」，就该把标志摆正再走一遍。
    check('切到听原声时把倾听意图与状态都摆正（否则幂等判断会把它挡掉）',
      /if \(next == TTS_LISTEN_ORIGINAL\) \{\s*\n\s*listenWanted = true;\s*\n\s*listening = false;/.test(source))
    check('播放状态每次真的变化都留一行日志（排查"没声音"要能分清是谁的问题）',
      /实时传声 " \+ \(shouldPlay \? "开" : "停"\)/.test(source))
    check('收到原声要计数（手机没收到 vs 收到没播，是两种完全不同的故障）',
      /audioChunks \+= 1/.test(source) && /收到音频但没在播/.test(source))

    check('切换档位就闭嘴（否则切了之后上一句还念完）',
      /private void setTtsMode\(int next\)[\s\S]{0,600}?ttsQueue\.stop\(\)/.test(source))
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
    check('37 条语言规则全通过（镜像/候选集合/归一化/钉正/AUTO）',
      /passed=37 failed=0/.test(report), report.trim().slice(-300))
  })

  await it('5.152：朗读打开（老师要求），总开关仍只有一处，三处入口要一致', async () => {
    const { readFileSync } = await import('node:fs')
    const gate = readFileSync(join(JAVA_SRC, 'TtsFeature.java'), 'utf-8')
    // 只有一个开关：翻回 true 时三处入口一起回来，不会出现"半开"（有开关但行为不一致）
    check('开关只有一处（TtsFeature.enabled()）', /public static boolean enabled\(\)/.test(gate))
    check('现在是**开**的（5.152 老师要求加播报）',
      /public static boolean enabled\(\)\s*\{\s*return true;\s*\}/.test(gate))
    check('5.38 关掉的那段历史写在类注释里（不是靠人记）',
      /先不使用/.test(gate) && /qwen3-tts-flash/.test(gate))

    // 5.145：设置页已删除（朗读配置没有第二个界面入口），不会出现"两处开关打架"
    check('设置页已不存在（朗读配置没有第二个入口）',
      !readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf-8')
        .includes('.SettingsActivity'))
    const roomSrc = readFileSync(room, 'utf-8')
    check('房间页按开关决定是否建队列',
      /if \(TtsFeature\.enabled\(\)\) \{\s*ttsQueue = new TtsQueue/.test(roomSrc))
    const interpSrc = readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')
    check('翻译官页同样按开关建队列、配置行也跟着出现',
      /if \(TtsFeature\.enabled\(\)\) \{\s*ttsQueue = new TtsQueue/.test(interpSrc)
      && /interpConfigTtsBlock/.test(interpSrc))
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
    // 5.146：配置页那块摘要白框已按用户要求删除；信息改由状态行写（interp_where* 仍在用）
    check('摘要信息还在（只是从白框挪到了状态行）',
      !/interpWhere/.test(interp) && /interp_where/.test(
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
        .test(readFileSync(join(JAVA_SRC, 'HomeActivity.java'), 'utf-8')))

    // 门禁范围：只挡"会写进数据"的两条。读字幕（/frame）与手输一句话（/say）
    // 不该因为版本号抖动把整场字幕断掉 —— 用户提的方案（只在登录界面拦）落地成这个窄化版。
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')
    check('门禁只管 /hello 与 /audio（写入路径）',
      /const GATED_ENDPOINTS = new Set\(\['\/hello', '\/audio'\]\)/.test(relay))
    check('/frame 与 /say 不再被版本门禁挡住',
      !/'\/frame'/.test(relay.match(/const GATED_ENDPOINTS[^\n]*/)?.[0] ?? "'/frame'")
      && !/'\/say'/.test(relay.match(/const GATED_ENDPOINTS[^\n]*/)?.[0] ?? "'/say'"))
  })

  await it('5.48：同一句的原文帧/增量帧/定稿帧必须并成一张卡（不再每帧一张）', async () => {
    const { readFileSync } = await import('node:fs')
    const interp = readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')
    const list = readFileSync(join(JAVA_SRC, 'SubtitleList.java'), 'utf-8')
    // 真实问题：一句话会来好几帧（原文帧 en-US 无译文、译文增量帧若干、译文定稿帧），
    // 翻译官页以前给**每一帧**算一个新 id（identityHashCode(lines)+hashCode(text)），
    // 于是同一句在屏幕上是两三张卡、互相闪烁 —— 用户看到的"定稿帧和增量帧一起发过来"。
    check('翻译官页改用与房间页同一个字幕列表（按原文归并）',
      /new SubtitleList\(/.test(interp) && /subtitles\.submit\(/.test(interp))
    check('不再用"每帧一个新 id"自己画卡片',
      !/identityHashCode\(lines\)/.test(interp)
      && !/private void renderCard\(/.test(interp) && !/List<String> cardIds/.test(interp))
    // 5.54：身份 = 原文 + 语言标签（一个人看两种译文时，两条不能互相覆盖）
    check('归并规则在 SubtitleList 里：原文相同（且同一语言）→ 同一条',
      /private Segment find\(String source, String langLabel\)/.test(list)
      && /source\.equals\(segment\.source\) && segment\.langLabel\.equals\(label\)/.test(list))
    check('原文为空的增量帧续写到上一条未定稿的**同语言**卡片上',
      /Segment last = segments\.get\(segments\.size\(\) - 1\)/.test(list)
      && /return last\.langLabel\.equals\(label\) \? last : null;/.test(list))
    check('语言标签有独立控件（两行译文才分得清）',
      /R\.id\.segLang/.test(list) && /segLang/.test(
        readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout', 'item_subtitle.xml'), 'utf-8')))
    check('时间标记按本场开始算（mm:ss），每场重置',
      /startedAt = System\.currentTimeMillis\(\)/.test(interp) && /%d:%02d/.test(interp))
  })

  await it('5.106：翻译官页三处实机问题（对方语言选项 / 同一句两张卡 / 多行看着歪）', async () => {
    const { readFileSync } = await import('node:fs')
    const backend = readFileSync(join(JAVA_SRC, 'RelayPipelineBackend.java'), 'utf-8')
    const client = readFileSync(join(JAVA_SRC, 'LanClient.java'), 'utf-8')
    const list = readFileSync(join(JAVA_SRC, 'SubtitleList.java'), 'utf-8')
    const layout = readFileSync(
      join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout', 'item_subtitle.xml'), 'utf-8')

    // ① 实机：读葡语/英语时对方的语言只有「简体中文」一个按钮可点
    //    规则在 InterpreterLang（有可执行用例），这里只钉"页面用的是那条规则、且没自己再砍一遍"
    check('对方语言的候选集合来自 InterpreterLang（页面不自己写死）',
      /partnerOptions\(lang\)/.test(
        readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')))

    // ② 实机：原文播一次、原文+译文又播一次（同一句两张卡，朗读也念两遍）
    //    两层都要有：服务端得知道"我只读这一门"，客户端还得按它拦一道 ——
    //    服务端在"那门语言还没出帧"时仍然会回单帧（原文帧），只靠服务端拦不住。
    check('开会话时把"我只读这一门"上报给服务器',
      /client\.setHearLangs\(readLang\)/.test(backend))
    check('客户端再按登记的语言拦一道（服务端时序上拦不住）',
      /private boolean wantsFrameLanguage/.test(client)
      && /!wantsFrameLanguage\(frameLang\)/.test(client))
    check('带 notice 的提示帧不拦（它不是字幕，拦了就没提示了）',
      /notice\.isEmpty\(\)\)\s*&&\s*!wantsFrameLanguage/.test(client))
    check('没登记收听语言时保持老行为（什么都收，不静默吞字幕）',
      /hearLangs == null \|\| hearLangs\.trim\(\)\.isEmpty\(\)\) return true/.test(client))

    // ③ 实机：译文太大 + 多行时行距/对齐乱、看着歪
    //    行距必须用**倍数**：固定 dp 的额外行距不跟字号缩放走，缩放后忽紧忽松。
    check('行距改成倍数（不再是 lineSpacingExtra 的固定 dp）',
      /lineSpacingMultiplier="1\.2"/.test(layout) && !/lineSpacingExtra=/.test(layout))
    check('语言标签/生成中挪到最上面那行（留在译文里，长句换行会让胶囊看着歪）',
      !/segTarget[\s\S]{0,600}?id="@\+id\/segLang"/.test(layout))
    check('拉丁译文字号比中文小一档（同样 22sp，拉丁文本看起来更大）',
      /BASE_TARGET_SP_LATIN = 20f/.test(list) && /targetBaseSp\(segment\.target\)/.test(list))
    check('译文那一行拿整卡宽度（不再和胶囊挤在一条横排里）',
      /id="@\+id\/segTarget"\s*\n\s*android:layout_width="match_parent"/.test(layout))
  })

  await it('5.49：网络抖动导致的翻译失败要重试（缺一句比慢一句糟）', async () => {
    const { readFileSync } = await import('node:fs')
    const core = readFileSync(join(ROOT, 'plugin', 'core.mjs'), 'utf-8')
    // 现场日志：`finish=error，TRANSPORT：DeepSeek API request to https://api.deepseek.com failed`
    // 这是**对外网络抖动**，一两秒后重发常常就成功；之前直接放弃 → 那一句只剩原文、没有译文。
    check('翻译失败有重试包装', /async function translateWithRetry\(llm, args\)/.test(core))
    check('重试次数有上限（600ms / 1500ms 两次，不是无限重试）',
      /const delays = \[600, 1500\]/.test(core) && /attempt < delays\.length/.test(core))
    check('已经吐了半截译文就不再重试（屏幕上不能出现两个版本）',
      /partial === '' && isTransientFailure/.test(core))
    check('只重试"可能自己会好"的失败（网络/限流/超时）',
      /TRANSPORT\|API request\|finish=error/.test(core))
    check('配置类失败不重试（没有 llm 服务、空译文）',
      /没有 llm 服务/.test(core) && /返回了空译文/.test(core))
    check('每次重试都打日志（不许悄悄重试到成功）', /↻ 翻译这次失败/.test(core))
  })

  await it('5.51 / 5.127：镜片显示 JSON（Rokid 只能显示，识别翻译仍是我们的）', async () => {
    const { readFileSync } = await import('node:fs')
    const builder = readFileSync(join(JAVA_SRC, 'CxrViewJson.java'), 'utf-8')
    // 纯逻辑：不许依赖 Android（否则没法在 CI 上跑）
    check('CxrViewJson 不 import android.*', /import\s+android\./.test(builder) === false)
    check('协议形状照着官方 Sample 来（LinearLayout 根 + TextView 子节点 + action=update 增量）',
      /quote\("LinearLayout"\)/.test(builder) && /quote\("TextView"\)/.test(builder)
      && /quote\("update"\)/.test(builder))
    check('只认字符串（尺寸带 sp、颜色 8 位 ARGB）',
      /DEFAULT_TEXT_SIZE = "[0-9]+sp"/.test(builder) && /DEFAULT_TEXT_COLOR = "#FF00[0-9A-Fa-f]{2}00"/.test(builder))
    check('这一版只投译文：根容器下只有一个文字节点（id 固定）',
      /TEXT_ID = "subtitle_text"/.test(builder) && /ROOT_ID = "leion_root"/.test(builder))
    check('颜色走绿通道（镜片是绿光单色屏，官方 Sample 也只给绿）',
      /绿通道/.test(builder))
    check('自己实现转义（不能用 org.json：desktop 下是 stub）',
      /public static String quote\(String raw\)/.test(builder)
      && /\\\\u%04x/.test(builder))
    // ⚠️ `'[' + '{'` 在 Java 里是 int 加法（拼命踩过一次：拼出 "214{…"，镜片上只是没字）
    check('拼 JSON 用字符串字面量而不是 char 相加（char+char 会变成 int）',
      /"[^"]*"\s*\n?\s*\+ '\{'/.test(builder) === false || /"\["\s*\n?\s*\+ '\{'/.test(builder))

    let javacOk = true
    try {
      execFileSync('javac', ['-version'], { stdio: 'ignore' })
    } catch (error) {
      javacOk = false
      if (error && error.code === 'EPERM') {
        console.log('  ⏭ 这个沙箱不允许 Node 起子进程（javac EPERM），跳过 CxrViewJsonCheck。')
        return
      }
    }
    if (!javacOk) {
      console.log('  ⏭ 这台机器没有 javac，跳过 CxrViewJsonCheck')
      return
    }
    const dir = join(VAR_DIR, 'test', 'cxr-view')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    execFileSync('javac', ['-encoding', 'UTF-8', '-d', dir,
      join(JAVA_SRC, 'CxrViewJson.java'), join(ROOT, 'tests', 'java', 'CxrViewJsonCheck.java')],
      { stdio: 'ignore' })
    const log = join(dir, 'check.log')
    const handle = openSync(log, 'w')
    try {
      execFileSync('java', ['-Dstdout.encoding=UTF-8', '-cp', dir, 'CxrViewJsonCheck'],
        { stdio: ['ignore', handle, handle] })
    } catch {
      // 断言失败会非零退出：报告已写进文件
    } finally {
      closeSync(handle)
    }
    const report = readFileSync(log, 'utf-8')
    check('23 条协议断言全通过（形状/id 一致/转义/紧凑单行/绿通道）',
      /passed=23 failed=0/.test(report), report.trim().slice(-300))

    // 5.140：两件事被用户实测报出来 —— 翻译官页的译文不上镜片 / 会议页侧边栏写死"手机屏"。
    //        根因同一个：**Rokid 投屏以前是每页各建一个实例**，离开投屏页会话就关，
    //        别的页面手里也没有它。所以这里钉四条：单例、投屏页不关会话、跨页推、状态如实。
    const rokidSrc = readFileSync(join(JAVA_SRC, 'RokidGlasses.java'), 'utf-8')
    const castSrc = readFileSync(join(JAVA_SRC, 'GlassesCastActivity.java'), 'utf-8')
    const interpSrc = readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')
    const roomSrc = readFileSync(join(JAVA_SRC, 'RoomActivity.java'), 'utf-8')
    check('Rokid 是应用级单例（shared() + 监听列表；投屏要跨页面活着）',
      /public static RokidGlasses shared\(Context/.test(rokidSrc)
        && /CopyOnWriteArrayList/.test(rokidSrc) && /addListener\(/.test(rokidSrc))
    check('投屏页 onDestroy 不关会话（否则离开这一页投屏就断）',
      !/onDestroy[\s\S]{0,600}rokid\.close\(\)/.test(castSrc))
    check('翻译官页把定稿译文推给眼镜（增量帧不推）',
      /pushIfCasting\(/.test(interpSrc) && /!partial && !translated\.isEmpty\(\)/.test(interpSrc))
    check('会议页侧边栏按真实投屏状态写设备（refreshCastState，不再写死手机屏）',
      /private void refreshCastState\(\)/.test(roomSrc)
        && /room_cast_rokid/.test(roomSrc) && /room_devices_rokid/.test(roomSrc))
  })

  await it('5.55：语言选择拆两行（我说一种 / 我想看多种），说话语言锁定在"我想看"里', async () => {
    const { readFileSync } = await import('node:fs')
    const create = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout',
      'page_create_room.xml'), 'utf-8')
    const joinLayout = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout',
      'page_join_room.xml'), 'utf-8')
    const createJava = readFileSync(join(JAVA_SRC, 'CreateRoomActivity.java'), 'utf-8')
    const joinJava = readFileSync(join(JAVA_SRC, 'JoinRoomActivity.java'), 'utf-8')
    const helper = readFileSync(join(JAVA_SRC, 'HearLangs.java'), 'utf-8')

    check('创建页有两组语言胶囊（我说 / 我想看）',
      ['createLangZh', 'createHearZh'].every((id) => create.includes(`@+id/${id}`)))
    check('入会页有两组语言胶囊', ['joinLangZh', 'joinHearZh'].every((id) => joinLayout.includes(`@+id/${id}`)))
    // 5.145：长说明段落已删（用户要求去掉解释性小字），标题仍在
    check('「我想看」用了自己的标题（三语资源）',
      /rooms_hear_title/.test(create) && /rooms_hear_title/.test(joinLayout))
    check('两页都能切换"我想看"', /toggleHearLang\(/.test(createJava) && /toggleHearLang\(/.test(joinJava))
    check('自己那门锁定（不可点，并给出提示）',
      /if \(lang\.equals\(speakLang\)\)/.test(createJava) && /rooms_hear_locked/.test(createJava)
      && /setClickable\(!locked\)/.test(createJava))
    check('换说话语言时把它并进"我想看"', /hearLangs\.add\(speakLang\)/.test(createJava))
    check('把选择随建房/入会请求一起上报',
      /HearLangs\.join\(hearLangs, speakLang\)/.test(createJava)
      && /HearLangs\.join\(hearLangs, speakLang\)/.test(joinJava))
    check('房间页轮询时带上"我要看哪几种语言"',
      /client\.setHearLangs\(/.test(readFileSync(join(JAVA_SRC, 'RoomActivity.java'), 'utf-8')))
    check('规则收在一个纯 Java 类里（不 import android，可跑测试）',
      /import\s+android\./.test(helper) === false && /public static List<String> normalize\(/.test(helper))

    let javacOk = true
    try {
      execFileSync('javac', ['-version'], { stdio: 'ignore' })
    } catch (error) {
      javacOk = false
      if (error && error.code === 'EPERM') {
        console.log('  ⏭ 这个沙箱不允许 Node 起子进程（javac EPERM），跳过 HearLangsCheck。')
        return
      }
    }
    if (!javacOk) {
      console.log('  ⏭ 这台机器没有 javac，跳过 HearLangsCheck')
      return
    }
    const dir = join(VAR_DIR, 'test', 'hear-langs')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    execFileSync('javac', ['-encoding', 'UTF-8', '-d', dir,
      join(JAVA_SRC, 'InterpreterLang.java'), join(JAVA_SRC, 'HearLangs.java'),
      join(ROOT, 'tests', 'java', 'HearLangsCheck.java')], { stdio: 'ignore' })
    const log = join(dir, 'check.log')
    const handle = openSync(log, 'w')
    try {
      execFileSync('java', ['-Dstdout.encoding=UTF-8', '-cp', dir, 'HearLangsCheck'],
        { stdio: ['ignore', handle, handle] })
    } catch {
      // 断言失败会非零退出：报告已写进文件
    } finally {
      closeSync(handle)
    }
    const report = readFileSync(log, 'utf-8')
    check('12 条语言规则全通过（强制含说话语言 / 归一化 / 顺序 / 空输入）',
      /passed=12 failed=0/.test(report), report.trim().slice(-300))
  })

  // 5.64：实机验收踩到的真 bug —— 侧车键写成 zh-CN、识别按 en-US 跑，切换永远不生效
  await it('会话语种（SessionLang）：侧车键必须与识别侧同一套标签', async () => {
    const { readFileSync } = await import('node:fs')
    const relay = readFileSync(join(JAVA_SRC, 'RelayPipelineBackend.java'), 'utf-8')
    const helper = readFileSync(join(JAVA_SRC, 'SessionLang.java'), 'utf-8')
    const activity = readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')

    check('语种判据收在纯 Java 类里（能离线跑）',
      /import\s+android\./.test(helper) === false && /public static String choose\(/.test(helper))
    check('start(lang) 给的语种优先于实例自带字段（三个通用实例可互换，不能信字段）',
      /sessionSpeakLang = SessionLang\.choose\(lang, speakLang\)/.test(relay))
    check('开会话时报的是算出来的语种，不是实例字段',
      /orgInterpreterStart\("同传翻译官", readLang, speakLang\(\)/.test(relay))
    check('路由器按"对方说的语言"挑后端（挑的是识别语种）',
      /router\.resolve\(partner\)/.test(activity))

    let javacOk = true
    try {
      execFileSync('javac', ['-version'], { stdio: 'ignore' })
    } catch (error) {
      javacOk = false
      if (error && error.code === 'EPERM') {
        console.log('  ⏭ 这个沙箱不允许 Node 起子进程（javac EPERM），跳过 SessionLangCheck。')
        return
      }
    }
    if (!javacOk) {
      console.log('  ⏭ 这台机器没有 javac，跳过 SessionLangCheck')
      return
    }
    const dir = join(VAR_DIR, 'test', 'session-lang')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    execFileSync('javac', ['-encoding', 'UTF-8', '-d', dir,
      join(JAVA_SRC, 'InterpreterAsrBackend.java'), join(JAVA_SRC, 'SessionLang.java'),
      join(ROOT, 'tests', 'java', 'SessionLangCheck.java')], { stdio: 'ignore' })
    const log = join(dir, 'check.log')
    const handle = openSync(log, 'w')
    try {
      execFileSync('java', ['-Dstdout.encoding=UTF-8', '-cp', dir, 'SessionLangCheck'],
        { stdio: ['ignore', handle, handle] })
    } catch {
      // 断言失败会非零退出：报告已写进文件
    } finally {
      closeSync(handle)
    }
    const sessionReport = readFileSync(log, 'utf-8')
    check('9 条语种判据全通过（start 优先 / 退回 / 归一化 / 都空不猜）',
      /passed=9 failed=0/.test(sessionReport), sessionReport.trim().slice(-300))
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
    // 5.43：右上角的后端小字按用户要求删了；5.146：配置页的摘要白框也删了 ——
    // 这条信息现在由**状态行**承担（interp_where* 仍在代码里），"说清"这件事不能一起消失。
    const interpJava = readFileSync(join(JAVA_SRC, 'InterpreterActivity.java'), 'utf-8')
    check('页面仍写明走哪条路（状态行 + 后端名走资源）',
      !/interpWhere/.test(layout) && /interp_where/.test(interpJava)
      && /interp_backend_relay/.test(readFileSync(
        join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf-8')))
    check('右上角的后端小字已按用户要求删除', !/interpBackend/.test(layout))
    check('状态行说清"目前是演示回放"', /尚未接入真实识别/.test(readFileSync(join(ROOT,
      'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf-8')))
    // 5.48：不再自己维护"同 id 原位更新"，这件事交给了房间页同一个 SubtitleList（按原文归并）
    check('字幕归并走 SubtitleList（同一句只占一张卡）',
      /new SubtitleList\(/.test(activity) && /subtitles\.submit\(/.test(activity))
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

  await it('服务器自建 TTS 的验证脚本（scripts/tts-doctor.py）', async () => {
    const Stdlib = new Set(['argparse', 'array', 'math', 'os', 'shutil', 'statistics',
      'sys', 'tempfile', 'time', 'wave', 'pathlib', '__future__'])
    const script = join(ROOT, 'scripts', 'tts-doctor.py')
    const source = readFileSync(script, 'utf-8')
    check('脚本在', source.length > 3000, String(source.length))
    // 顶层只许 import 标准库：否则服务器上少装一个包，连 --help 都跑不起来 ——
    // 而那正是"出问题时最需要它"的时刻。
    const head = source.split(/^def /m)[0]
    const thirdParty = [...head.matchAll(/^(?:from|import)\s+([\w.]+)/gm)]
      .map((match) => match[1].split('.')[0])
      .filter((name) => !Stdlib.has(name))
    check('顶层只 import 标准库（缺包时 --help 仍要能跑）', thirdParty.length === 0, thirdParty.join(','))
    check('不自己装包、不调外部命令（只报告，不动手）',
      !/subprocess|os\.system|check_call|pip\s+install\s+-[rq]/.test(source))
    check('说明里写明不接云端 API', /不接云端 API/.test(source))
    check('说明里写明 piper 不碰 torch、kokoro/coqui 会', /不碰 torch/.test(source))
    check('说明里写明 XTTS-v2 是 CPML 非商用', /CPML/.test(source) && /非商用/.test(source))
    check('三门语言的验证句都是内置的真会议句子', /SAMPLES = \{/.test(source)
      && /"pt-BR"/.test(source) && /"zh-CN"/.test(source) && /"en-US"/.test(source))
    check('巴葡默认音色是 faber-medium', /pt_BR-faber-medium/.test(source))

    let pythonOk = true
    try {
      execFileSync('python', ['--version'], { stdio: 'ignore' })
    } catch {
      pythonOk = false
      console.log('  ⏭ 这台机器没有 python，跳过可执行用例（静态断言已在上面跑过）')
    }
    if (!pythonOk) return

    // 沙箱里"管道捕获子进程输出"会被禁（EPERM），所以照本套件验 Java 的老办法：
    // 把 stdout/stderr 直接写进文件，再从文件里读 —— 只用文件描述符，不开管道。
    const scratch = join(VAR_DIR, 'tmp')
    mkdirSync(scratch, { recursive: true })
    const run = (args) => {
      const out = join(scratch, 'tts-doctor-out.txt')
      const fd = openSync(out, 'w')
      let failure = null
      try {
        execFileSync('python', args, { stdio: ['ignore', fd, fd] })
      } catch (error) {
        failure = error
      } finally {
        closeSync(fd)
      }
      if (failure && failure.code === 'EPERM') throw failure
      return readFileSync(out, 'utf-8')
    }

    let help
    try {
      help = run([script, '--help'])
    } catch (error) {
      if (error && error.code === 'EPERM') {
        console.log('  ⏭ 这个沙箱不允许 Node 起子进程（python EPERM），跳过可执行用例。')
        return
      }
      throw error
    }
    check('--help 跑得通，参数说清了（--engine / --lang / --voice / --selftest）',
      /--engine/.test(help) && /--lang/.test(help) && /--voice/.test(help) && /--selftest/.test(help),
      help.slice(0, 120))
    // 纯函数自检：不依赖任何引擎，CI 与"装包之前"都能跑
    const selftest = run([script, '--selftest'])
    check('纯函数自检全过', /passed=\d+ failed=0/.test(selftest), selftest.trim().slice(-200))
    const voices = run([script, '--list-voices', '--models-dir', join(scratch, 'no-such-dir')])
    check('列出巴葡音色', /pt_BR-faber-medium/.test(voices))
    check('缺文件时说清缺哪个（不是只说"加载失败"）', /缺：/.test(voices) && /\.onnx\.json/.test(voices))
    check('顺手教怎么下载（一条命令）', /download_voices/.test(voices))
  })
}
