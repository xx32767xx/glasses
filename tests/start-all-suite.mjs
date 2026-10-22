/**
 * start-all-suite.mjs —— 「一键启动」脚本的验证
 * ============================================================================
 * 这个脚本自己不处理业务数据，所以可测的就是**它拼出来的命令对不对**、
 * 以及**它的前置检查会不会放行一个必然出错的场景**。
 *
 * 为什么值得测：命令行拼错、或者少了一个参数，表现都是"某个进程起来就退"，
 * 而用户看到的只是"手机没反应"。这类错误靠肉眼看脚本很容易漏。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { archiveSessionLogs, buildSteps, childEnv, flushLogStreams, main, parseArgs, portInUse, sessionStamp } from '../scripts/start-all.mjs'
import { defaultAudioIn, defaultBus, defaultInbox, VAR_DIR } from '../lib/paths.mjs'

const argsOf = step => step.args.join(' ')

export async function runStartAllSuite({ it, check, assert }) {
  // ── 1. 缺省拼出来的三条命令 ────────────────────────────────────────────────

  await it('缺省三个进程：转发 + 识别 + 大脑，顺序是数据流过的顺序', async () => {
    const steps = buildSteps(parseArgs([]))
    assert.deepEqual(steps.map(s => s.key), ['relay', 'asr', 'brain'])
    check('每个都有短标签（日志前缀要用）',
      steps.every(s => typeof s.tag === 'string' && s.tag !== ''), JSON.stringify(steps.map(s => s.tag)))
    check('每个都有颜色（混在一起时能分清是谁在说）',
      steps.every(s => typeof s.color === 'string' && s.color.startsWith('\x1b[')))
  })

  await it('转发进程带上数据目录与端口，且数据目录被解析成**绝对路径**', async () => {
    const relay = buildSteps(parseArgs(['--port', '9000', '--data-dir', 'var/x'])).find(s => s.key === 'relay')
    check('脚本指向 relay/lan-relay.mjs', relay.script.endsWith('lan-relay.mjs'), relay.script)
    check('带上 --port 9000', argsOf(relay).includes('--port 9000'), argsOf(relay))
    // 相对路径必须被解析成绝对路径再往外传：原样传下去会让插件的收件箱**静默读不到**
    // （继电器照写、屏幕上永远没字幕、一个错都不报 —— 真实踩过，见 docs/07）。
    const dataDir = relay.args[relay.args.indexOf('--data-dir') + 1]
    check('--data-dir 是绝对路径', /^[A-Za-z]:[\\/]/.test(dataDir) || dataDir.startsWith('/'), dataDir)
    check('解析后仍指向同一个位置（以 var/x 结尾）',
      dataDir.replace(/\\/g, '/').endsWith('var/x'), dataDir)
  })

  await it('--public：加固参数**必须真的传到**转发进程（否则是最坏的一种"以为配好了"）', async () => {
    // 服务器部署时，文档让用户跑 start-all；如果这里漏传 --public，
    // 强密钥/限流/音频上限一个都不生效，而启动画面照样正常 —— 查不出来。
    const plain = buildSteps(parseArgs([])).find(s => s.key === 'relay')
    check('平时不带 --public', !argsOf(plain).includes('--public'), argsOf(plain))

    const pub = buildSteps(parseArgs(['--public'])).find(s => s.key === 'relay')
    check('带了 --public', argsOf(pub).includes('--public'), argsOf(pub))
    check('同时显式绑 0.0.0.0（公网要能被外面连）',
      argsOf(pub).includes('--host 0.0.0.0'), argsOf(pub))
    check('原有参数没被挤掉',
      argsOf(pub).includes('--port') && argsOf(pub).includes('--data-dir'), argsOf(pub))
  })

  await it('识别进程：**不写 python | node 管道**，而用 --whisper-follow 让桥自己起子进程', async () => {
    const asr = buildSteps(parseArgs([])).find(s => s.key === 'asr')
    check('脚本指向 bridge/asr-bridge.mjs', asr.script.endsWith('asr-bridge.mjs'), asr.script)
    check('用了 --whisper-follow', argsOf(asr).includes('--whisper-follow'), argsOf(asr))
    check('收件箱与音频路径都传了', argsOf(asr).includes('--inbox') && argsOf(asr).includes('audio-in'),
      argsOf(asr))
    check('没有 --from（语种交给手机按按钮下发）', !argsOf(asr).includes('--from'), argsOf(asr))
  })

  await it('识别进程带上模型/设备/精度（缺省 cuda + float16，实测比 CPU 快一个数量级）', async () => {
    const asr = buildSteps(parseArgs([])).find(s => s.key === 'asr')
    check('--whisper-device cuda', argsOf(asr).includes('--whisper-device cuda'), argsOf(asr))
    check('--whisper-compute float16', argsOf(asr).includes('--whisper-compute float16'), argsOf(asr))
  })

  await it('模型缺省按设备自动选：GPU 用 large-v3、CPU 用 small', async () => {
    // 依据是中文基准（docs/04 §11）：small 18.9% / medium 7.4% / large-v3 3.9% 字错率。
    // 模型大小是准确率上**最大**的变量，所以 GPU 上直接上大的；
    // CPU 上 large-v3 慢到没法用，退回 small。
    const gpu = buildSteps(parseArgs([])).find(s => s.key === 'asr')
    check('GPU → large-v3', argsOf(gpu).includes('--whisper-model large-v3'), argsOf(gpu))
    const cpu = buildSteps(parseArgs(['--cpu'])).find(s => s.key === 'asr')
    check('CPU → small', argsOf(cpu).includes('--whisper-model small'), argsOf(cpu))
    const forced = buildSteps(parseArgs(['--whisper-model', 'medium'])).find(s => s.key === 'asr')
    check('显式指定优先', argsOf(forced).includes('--whisper-model medium'), argsOf(forced))
  })

  await it('--cpu 会同时把精度换成 int8（CPU 上 float16 更慢）', async () => {
    const asr = buildSteps(parseArgs(['--cpu'])).find(s => s.key === 'asr')
    check('设备是 cpu', argsOf(asr).includes('--whisper-device cpu'), argsOf(asr))
    check('精度是 int8', argsOf(asr).includes('--whisper-compute int8'), argsOf(asr))
  })

  await it('大脑带上显示预算与数据目录；--offline 透传', async () => {
    const brain = buildSteps(parseArgs(['--cols', '60', '--lines', '4'])).find(s => s.key === 'brain')
    check('脚本指向 harness-side.mjs', brain.script.endsWith('harness-side.mjs'), brain.script)
    check('--cols 60', argsOf(brain).includes('--cols 60'), argsOf(brain))
    check('--lines 4', argsOf(brain).includes('--lines 4'), argsOf(brain))
    check('缺省不带 --offline', !argsOf(brain).includes('--offline'), argsOf(brain))
    const offline = buildSteps(parseArgs(['--offline'])).find(s => s.key === 'brain')
    check('--offline 时带上', argsOf(offline).includes('--offline'), argsOf(offline))
  })

  await it('--no-transcriber 时只起两个（手输文字那条路不需要识别）', async () => {
    const steps = buildSteps(parseArgs(['--no-transcriber']))
    assert.deepEqual(steps.map(s => s.key), ['relay', 'brain'])
  })

  await it('--terms-rescue：实验开关必须真的传到大脑（缺省关，别"以为开了"）', async () => {
    // 热词临时修正（docs/15 §18）默认关；开了却漏传参数，表现就是
    // "改了配置、什么都没发生" —— 这条钉住"参数确实落到 brain 命令行"。
    const plain = buildSteps(parseArgs([])).find(s => s.key === 'brain')
    check('缺省不带 --terms-rescue', argsOf(plain).includes('--terms-rescue') === false, argsOf(plain))
    const on = buildSteps(parseArgs(['--terms-rescue'])).find(s => s.key === 'brain')
    check('带了 --terms-rescue 就传给大脑', argsOf(on).includes('--terms-rescue'), argsOf(on))
    check('原有参数没被挤掉', argsOf(on).includes('--data-dir') && argsOf(on).includes('--cols'), argsOf(on))
  })

  // ── 2. 参数校验：拼错了要立刻报错，而不是起一半 ─────────────────────────────

  await it('非法端口/行列数立刻报错', async () => {
    assert.throws(() => parseArgs(['--port', '0']), /port/)
    assert.throws(() => parseArgs(['--cols', 'abc']), /cols/)
    assert.throws(() => parseArgs(['--lines', '-1']), /lines/)
    assert.throws(() => parseArgs(['--nope']), /未知选项/)
  })

  await it('自定义路径时不覆盖（inbox/bus/audio 都能单独指定），并且都解析成绝对路径', async () => {
    const options = parseArgs(['--inbox', 'a.jsonl', '--bus', 'b.json', '--audio', 'c.pcm'])
    const absolute = value => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')
    const endsWith = (value, tail) => value.replace(/\\/g, '/').endsWith(tail)
    check('inbox 用了传入的', endsWith(options.inbox, 'a.jsonl'), options.inbox)
    check('bus 用了传入的', endsWith(options.bus, 'b.json'), options.bus)
    check('audio 用了传入的', endsWith(options.audio, 'c.pcm'), options.audio)
    check('三个都变成绝对路径了',
      absolute(options.inbox) && absolute(options.bus) && absolute(options.audio),
      JSON.stringify([options.inbox, options.bus, options.audio]))
  })

  await it('缺省路径来自 lib/paths.mjs（不是脚本里另写一份字面量）', async () => {
    // 相对 --data-dir 会被解析成绝对路径，所以拿"解析后的那个目录"去问 lib/paths.mjs，
    // 两边算出来的必须一致 —— 这样既验证了来源唯一，也验证了路径没被写歪。
    const options = parseArgs(['--data-dir', 'var/zzz'])
    check('inbox', options.inbox === defaultInbox(options.dataDir), options.inbox)
    check('bus', options.bus === defaultBus(options.dataDir), options.bus)
    check('audio', options.audio === defaultAudioIn(options.dataDir), options.audio)
    check('而且确实落在 var/zzz 下',
      options.inbox.replace(/\\/g, '/').includes('var/zzz/'), options.inbox)
  })

  // ── 3. 端口检查：这是"以为重启了其实还是旧进程"的头号来源 ───────────────────

  await it('端口被占用时能查出来（起之前就要拦住）', async () => {
    const { createServer } = await import('node:net')
    const blocker = createServer()
    await new Promise(resolve => blocker.listen(0, '0.0.0.0', resolve))
    const port = blocker.address().port
    try {
      check('占用中的端口 → true', await portInUse(port) === true, String(port))
    } finally {
      await new Promise(resolve => blocker.close(resolve))
    }
    check('释放后 → false', await portInUse(port) === false, String(port))
  })

  // ── 4. 文档里写的东西是真的 ────────────────────────────────────────────────

  await it('帮助文本把三个进程的职责说清楚了', async () => {
    const help = readFileSync(new URL('../scripts/start-all.mjs', import.meta.url), 'utf-8')
    check('提到转发', help.includes('收发室'), '缺"收发室"')
    check('提到识别', help.includes('耳朵'), '缺"耳朵"')
    check('提到大脑', help.includes('大脑'), '缺"大脑"')
    check('说明 Ctrl-C 会连孙进程一起收', help.includes('孙进程'), '缺"孙进程"')
  })

  // ── 5. 端口守卫为什么不能用 bind 探测 ──────────────────────────────────────
  // Windows 上 libuv 默认开 SO_REUSEADDR，bind 到别人正在监听的端口**也会成功**，
  // 于是"试着 listen 看会不会 EADDRINUSE"这种写法永远返回"空闲"，守卫形同虚设。
  // 这条钉住实现方式：必须是**连接探测**（能连上才算占用）。

  await it('端口探测用的是连接而不是 bind（Windows 上 bind 探测会失效）', async () => {
    const source = readFileSync(new URL('../scripts/start-all.mjs', import.meta.url), 'utf-8')
    check('导入了 net.connect', source.includes("import { connect } from 'node:net'"), '没导入 connect')
    check('没有再创建探测用的 server', !source.includes('const probe = createServer()'), '还留着 bind 探测')
    check('源码里写明了这个坑', source.includes('SO_REUSEADDR'), '缺 SO_REUSEADDR 的说明')
  })

  await it('起之前会清掉上次留下的手机音频（否则启动先冒一句旧字幕）', async () => {
    const source = readFileSync(new URL('../scripts/start-all.mjs', import.meta.url), 'utf-8')
    check('有清音频这段', source.includes('staleAudioSeconds'), '缺清理逻辑')
    check('说了为什么', source.includes('上次录的音频'), '缺原因说明')
  })

  // ── 6. 模型缓存环境变量（这次真实事故的根子）────────────────────────────────
  //
  // 用户自己跑脚本时没有 HF_HOME，于是识别进程从零把模型下到默认缓存。
  // 直连 HuggingFace 实测 3 分钟只下了 2.5MB → 识别进程四分钟没开始听，
  // 而终端上只有一句"加载模型…"。仓库里明明已缓存 466MB 的 small 却没用上。

  await it('缺省给子进程设好模型缓存与下载源（否则会重新下一个几百 MB 的模型）', async () => {
    const { env, notes } = childEnv({})
    check('设了 HF_HOME', typeof env.HF_HOME === 'string' && env.HF_HOME.includes('var'), env.HF_HOME)
    check('指向仓库里的 var/cache/hf', env.HF_HOME.includes('cache'), env.HF_HOME)
    check('设了 HF_ENDPOINT（直连基本下不动）', env.HF_ENDPOINT === 'https://hf-mirror.com', env.HF_ENDPOINT)
    check('把这几件事打印出来给人看（不然完全看不出它在下载）', notes.length === 3, String(notes.length))
  })

  // 编码事故：Windows 中文环境下 Python 往管道写的是 GBK，桥按 UTF-8 读，
  // 于是识别出的"你好"变成 3 个替换符写进收件箱，插件"判不出源语种"，一句字幕都出不来。
  // 而每一环看起来都正常（有声音、有输出、有行数）。
  await it('缺省给子进程设好 Python 的 UTF-8（否则识别结果会变乱码）', async () => {
    const { env, notes } = childEnv({})
    check('设了 PYTHONUTF8', env.PYTHONUTF8 === '1', String(env.PYTHONUTF8))
    check('设了 PYTHONIOENCODING', env.PYTHONIOENCODING === 'utf-8', String(env.PYTHONIOENCODING))
    check('横幅里说明了', notes.some(n => n.includes('UTF-8')), JSON.stringify(notes))
  })

  await it('用户自己设了环境变量就不覆盖（想直连/换缓存目录都行）', async () => {
    const { env, notes } = childEnv({
      HF_HOME: '/my/cache', HF_ENDPOINT: 'https://huggingface.co',
      PYTHONUTF8: '0', PYTHONIOENCODING: 'gbk',
    })
    check('HF_HOME 保持用户的值', env.HF_HOME === '/my/cache', env.HF_HOME)
    check('HF_ENDPOINT 保持用户的值', env.HF_ENDPOINT === 'https://huggingface.co', env.HF_ENDPOINT)
    check('编码也保持用户的（他想用 GBK 是他的事）', env.PYTHONIOENCODING === 'gbk', env.PYTHONIOENCODING)
    check('这种情况不再多嘴', notes.length === 0, String(notes.length))
  })

  await it('环境变量是**继承**的，不是替换（PATH 等必须还在）', async () => {
    const { env } = childEnv({ PATH: 'C:\\x', SOMETHING: 'y' })
    check('PATH 还在', env.PATH === 'C:\\x', String(env.PATH))
    check('别的变量也还在', env.SOMETHING === 'y', String(env.SOMETHING))
  })

  // ── 7. 真跑一遍启动路径（崩过一次，全部单测都测不到）──────────────────────
  //
  // 事故：横幅里用了 `envNotes`，而它在下面才初始化 → 一启动就
  // "Cannot access 'envNotes' before initialization"。而套件全绿 ——
  // 因为所有断言都在测纯函数（buildSteps / childEnv / portInUse），
  // 没人走 main() 这条路径。所以现在用 --dry-run 把这条路径也纳入测试：
  // 它跑完"探端口 → 拼命令 → 算环境变量 → 打印横幅"就返回，不起任何进程。

  // ⚠️ 这条测试必须自己控制环境变量，不能靠"跑测试的人碰巧没设 HF_HOME"。
  // 踩过：本机 shell 里设了 HF_HOME 时 childEnv() 就不会加那两行说明，
  // 于是"打印了模型缓存位置"这条断言失败 —— 同一份代码，换个环境跑结果不同。
  // 测试的输入必须由测试自己决定。
  //
  // 这个 helper 必须是 async 且 `await run()`：第一版写成同步的，
  // finally 在 main() **返回 Promise 的那一刻**就恢复了环境变量，
  // 而 main() 内部是稍后才读 process.env 的 —— 等于没清，测试照样失败。
  const ENV_KEYS = ['HF_HOME', 'HF_ENDPOINT', 'PYTHONUTF8', 'PYTHONIOENCODING']
  async function withoutEnv(keys, run) {
    const saved = {}
    for (const key of keys) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    try {
      return await run()
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  }

  await it('--dry-run 能走完整条启动路径而不崩（横幅那段曾被测不到）', async () => {
    const captured = []
    const original = process.stdout.write
    process.stdout.write = chunk => { captured.push(String(chunk)); return true }
    let code
    try {
      // 端口要挑在**临时端口范围之外**（Windows 是 49152–65535）。
      // 早先这里用 59999，而 relay 套件会用 port 0 让系统随机分配端口 ——
      // 那个随机端口可能正好落在 59999，于是这条测试时好时坏（实测过：同一份代码
      // 一次跑失败、紧跟着再跑就通过）。18788 在范围外，不会被别的测试抢到。
      code = await withoutEnv(ENV_KEYS, () => main(['--dry-run', '--quiet-logs', '--port', '18788']))
    } finally {
      process.stdout.write = original
    }
    const output = captured.join('')
    check('退出码 0', code === 0, String(code))
    check('打印了三个进程（转发/识别/大脑）',
      output.includes('转发') && output.includes('识别') && output.includes('大脑'), output.slice(0, 200))
    check('打印了模型缓存位置（上次事故就是这里用了未初始化变量）',
      output.includes('模型缓存'), output.slice(0, 400))
    check('打印了下载源', output.includes('下载源'), output.slice(0, 400))
    check('打印了临时修正的开关状态（缺省关）', output.includes('临时修正'), output.slice(0, 500))
    check('说明是 dry-run、没真的启动', output.includes('--dry-run'), output.slice(-120))
  })

  // ── 固定语种（单向模式）──────────────────────────────────────────────────
  //
  // 用户在"中文发言 → 译成巴葡"这种单向场景下要求显式指定语种，不要自动判定。
  // 实测依据（pt-coraa，20 条真实巴葡口语）：
  //   自动判定 → 语种 {pt:19, he:1}，词错率 13.3%，那条被认成希伯来语的**整句报废**
  //   固定 pt  → 语种 {pt:20}，词错率 12.2%
  // 所以这两个开关存在的意义是**消掉"整句报废"那一类**，不是普遍提升准确率。

  await it('固定语种：--from/--to 必须真的传到识别进程（否则单向模式是假的）', async () => {
    const asr = buildSteps(parseArgs(['--from', 'zh-CN', '--to', 'pt-BR'])).find(s => s.key === 'asr')
    check('带上 --from zh-CN', argsOf(asr).includes('--from zh-CN'), argsOf(asr))
    check('带上 --to pt-BR', argsOf(asr).includes('--to pt-BR'), argsOf(asr))
  })

  await it('固定语种：缺省**不固定**（自动判定仍是缺省行为，不能悄悄改掉）', async () => {
    const asr = buildSteps(parseArgs([])).find(s => s.key === 'asr')
    check('没有 --from', argsOf(asr).includes('--from') === false, argsOf(asr))
    check('没有 --to', argsOf(asr).includes('--to') === false, argsOf(asr))
  })

  await it('固定语种：非法语种与"同一个语种"都在入口就被拒（不让子进程起来才报）', async () => {
    // 起不来的表现只是"某个进程起来就退了"，真正的原因在几百行日志之后 ——
    // 所以在 parseArgs 就拦住。
    assert.throws(() => parseArgs(['--from', 'en-US']), /只能是 zh-CN 或 pt-BR/)
    assert.throws(() => parseArgs(['--to', 'ja']), /只能是 zh-CN 或 pt-BR/)
    assert.throws(() => parseArgs(['--from', 'zh-CN', '--to', 'zh-CN']), /不能是同一个语种/)
    check('合法的两个方向都通过',
      parseArgs(['--from', 'pt-BR', '--to', 'zh-CN']).from === 'pt-BR',
      'zh-CN→pt-BR 与 pt-BR→zh-CN 都该允许')
  })

  //
  // 为什么归档的时机是"进程结束"而不是"一次对话结束"：系统里没有可靠的
  // "对话结束"信号（暂停又继续、一直开着、手机断一下又连回来都会把边界猜错），
  // 而进程结束是唯一明确可观测的边界。详见 archiveSessionLogs 的注释。

  await it('归档：三份日志进同一个会话目录，启动头不算"有内容"', async () => {
    const { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } = await import('node:fs')
    const tmp = join(VAR_DIR, 'test', 'archive-suite')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    // relay 有真实内容；asr 只有启动头（这次运行里它什么都没干）；brain 有内容
    writeFileSync(join(tmp, 'relay.log'), '# 2026-01-01T00:00:00.000Z  node relay\n📺 字幕已更新\n', 'utf-8')
    writeFileSync(join(tmp, 'asr.log'), '# 2026-01-01T00:00:00.000Z  node asr\n', 'utf-8')
    writeFileSync(join(tmp, 'brain.log'), '# 2026-01-01T00:00:00.000Z  node brain\n🔍 确定错\n', 'utf-8')

    const result = archiveSessionLogs({ logsDir: tmp, keys: ['relay', 'asr', 'brain'], stamp: '20260101-000000' })
    check('归档了', result.archived === true, JSON.stringify(result))
    check('目录按会话时间戳', result.dir.endsWith(join('archive', '20260101-000000')), result.dir)
    check('有内容的两份都进去了', result.keys.sort().join(',') === 'brain,relay', result.keys.join(','))
    check('只有启动头的那份**不留空壳**', existsSync(join(result.dir, 'asr.log')) === false,
      'asr.log 不该被归档（它这次什么都没干）')
    check('内容原样保留', readFileSync(join(result.dir, 'relay.log'), 'utf-8').includes('字幕已更新'))
    check('活动日志已移走（下次运行是干净的一份）', existsSync(join(tmp, 'relay.log')) === false)
    rmSync(tmp, { recursive: true, force: true })
  })

  await it('归档：全是启动头（启动就失败）→ 一个目录都不建', async () => {
    const { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } = await import('node:fs')
    const tmp = join(VAR_DIR, 'test', 'archive-suite-empty')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    for (const key of ['relay', 'asr', 'brain']) {
      writeFileSync(join(tmp, `${key}.log`), `# 2026-01-01T00:00:00.000Z  node ${key}\n`, 'utf-8')
    }
    const result = archiveSessionLogs({ logsDir: tmp, keys: ['relay', 'asr', 'brain'], stamp: '20260101-000001' })
    check('没归档', result.archived === false, JSON.stringify(result))
    const archiveDir = join(tmp, 'archive')
    check('archive 目录没有被建出来（不留空壳）',
      existsSync(archiveDir) === false || readdirSync(archiveDir).length === 0,
      existsSync(archiveDir) ? readdirSync(archiveDir).join(',') : '不存在')
    check('活动日志留在原地（没被删掉）', existsSync(join(tmp, 'relay.log')) === true)
    rmSync(tmp, { recursive: true, force: true })
  })

  await it('归档：日志目录里什么都没有时不报错（不能因为收尾杂活让退出崩掉）', async () => {
    const { mkdirSync, rmSync } = await import('node:fs')
    const tmp = join(VAR_DIR, 'test', 'archive-suite-none')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const result = archiveSessionLogs({ logsDir: tmp, keys: ['relay'], stamp: '20260101-000002' })
    check('返回"没归档"而不是抛异常', result.archived === false, JSON.stringify(result))
    rmSync(tmp, { recursive: true, force: true })
  })

  await it('归档：同一秒的两次运行不会互相覆盖（撞名要加序号）', async () => {
    const { mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
    const tmp = join(VAR_DIR, 'test', 'archive-suite-collide')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const stamp = sessionStamp(new Date(2026, 0, 2, 3, 4, 5))
    check('时间戳格式是 YYYYMMDD-HHMMSS', /^\d{8}-\d{6}$/.test(stamp), stamp)
    check('值对得上', stamp === '20260102-030405', stamp)

    // 第一次
    writeFileSync(join(tmp, 'relay.log'), '# 头\n第一次的内容\n', 'utf-8')
    const first = archiveSessionLogs({ logsDir: tmp, keys: ['relay'], stamp })
    // 第二次：**同一个时间戳**（模拟同秒启动两次 / 上一次归档还在）
    writeFileSync(join(tmp, 'relay.log'), '# 头\n第二次的内容\n', 'utf-8')
    const second = archiveSessionLogs({ logsDir: tmp, keys: ['relay'], stamp })

    check('两次都归档了', first.archived === true && second.archived === true,
      `${JSON.stringify(first)} / ${JSON.stringify(second)}`)
    check('落在**不同**的目录里', first.dir !== second.dir, `${first.dir} vs ${second.dir}`)
    check('第二次带序号', second.dir.endsWith('-2'), second.dir)
    check('第一次的内容没被盖掉',
      readFileSync(join(first.dir, 'relay.log'), 'utf-8').includes('第一次的内容'),
      readFileSync(join(first.dir, 'relay.log'), 'utf-8'))
    check('第二次的内容也在',
      readFileSync(join(second.dir, 'relay.log'), 'utf-8').includes('第二次的内容'))
    rmSync(tmp, { recursive: true, force: true })
  })

  await it('归档：必须**等写盘完成**再移动文件，否则丢掉的是最后几行', async () => {
    // 这条测的是 `shutdown()` 用的那个顺序契约（`flushLogStreams` + `archiveSessionLogs`）：
    //   `stream.end()` 只是"不再写了"，缓冲里的数据是异步落盘的；
    //   不等 'finish' 就去改名，会读到**被截断的文件** ——
    //   而丢掉的正好是最后几行，也就是这次运行最该看的东西（最后一句字幕、最后的报错）。
    // 这里喂**真实 WriteStream** 进去，验的就是产线用的那两个函数本身。
    const { createWriteStream, mkdirSync, readFileSync, rmSync, statSync } = await import('node:fs')
    const tmp = join(VAR_DIR, 'test', 'archive-suite-flush')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const file = join(tmp, 'relay.log')

    const stream = createWriteStream(file, { flags: 'w' })
    // 写够多：createWriteStream 的 highWaterMark 是 16KB，
    // 写少了会一次就落盘、于是"不等写完"也照样能过 —— 那样测不出东西。
    const lines = []
    for (let i = 0; i < 500; i += 1) lines.push(`第 ${i} 行 ` + 'x'.repeat(80))
    stream.write('# 头\n')
    for (const line of lines) stream.write(line + '\n')
    await flushLogStreams({ relay: stream })

    const before = statSync(file).size
    const result = archiveSessionLogs({ logsDir: tmp, keys: ['relay'], stamp: '20260101-000003' })
    check('归档成功', result.archived === true, JSON.stringify(result))
    const body = readFileSync(join(result.dir, 'relay.log'), 'utf-8')
    check('最后一行还在（没被截断）', body.includes('第 499 行'), `长度 ${body.length} / 原文件 ${before} 字节`)
    check('启动头也在', body.startsWith('# 头'), body.slice(0, 20))
    // ⚠️ 要比**字节数**，不能比 `body.length`（那是 UTF-16 码元数）：
    //    这份日志里全是中文，一个字 3 字节，两者差得很远。
    //    （第一版就写成了 body.length，结果自己造了个假失败。）
    check('字节数与写盘后一致（一个字节都没丢）',
      Buffer.byteLength(body, 'utf-8') === before,
      `${Buffer.byteLength(body, 'utf-8')} vs ${before}`)
    rmSync(tmp, { recursive: true, force: true })
  })

  await it('--dry-run 不留下副作用（不写日志、不动音频）', async () => {
    const { existsSync, statSync } = await import('node:fs')
    const audioPath = join(VAR_DIR, 'live', 'audio-in.pcm')
    const before = existsSync(audioPath) ? statSync(audioPath).size : null
    const captured = []
    const original = process.stdout.write
    process.stdout.write = chunk => { captured.push(String(chunk)); return true }
    try {
      await withoutEnv(ENV_KEYS, () => main(['--dry-run', '--quiet-logs', '--port', '18788']))
    } finally {
      process.stdout.write = original
    }
    const after = existsSync(audioPath) ? statSync(audioPath).size : null
    check('音频文件大小没变（dry-run 不该清它）', before === after, `${before} → ${after}`)
  })
}
