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
import { buildSteps, childEnv, main, parseArgs, portInUse } from '../scripts/start-all.mjs'
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

  await it('转发进程带上数据目录与端口', async () => {
    const relay = buildSteps(parseArgs(['--port', '9000', '--data-dir', 'var/x'])).find(s => s.key === 'relay')
    check('脚本指向 relay/lan-relay.mjs', relay.script.endsWith('lan-relay.mjs'), relay.script)
    check('带上 --port 9000', argsOf(relay).includes('--port 9000'), argsOf(relay))
    check('带上 --data-dir var/x', argsOf(relay).includes('--data-dir var/x'), argsOf(relay))
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
    check('--whisper-model small', argsOf(asr).includes('--whisper-model small'), argsOf(asr))
    check('--whisper-device cuda', argsOf(asr).includes('--whisper-device cuda'), argsOf(asr))
    check('--whisper-compute float16', argsOf(asr).includes('--whisper-compute float16'), argsOf(asr))
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

  // ── 2. 参数校验：拼错了要立刻报错，而不是起一半 ─────────────────────────────

  await it('非法端口/行列数立刻报错', async () => {
    assert.throws(() => parseArgs(['--port', '0']), /port/)
    assert.throws(() => parseArgs(['--cols', 'abc']), /cols/)
    assert.throws(() => parseArgs(['--lines', '-1']), /lines/)
    assert.throws(() => parseArgs(['--nope']), /未知选项/)
  })

  await it('自定义路径时不覆盖（inbox/bus/audio 都能单独指定）', async () => {
    const options = parseArgs(['--inbox', 'a.jsonl', '--bus', 'b.json', '--audio', 'c.pcm'])
    check('inbox 用了传入的', options.inbox === 'a.jsonl', options.inbox)
    check('bus 用了传入的', options.bus === 'b.json', options.bus)
    check('audio 用了传入的', options.audio === 'c.pcm', options.audio)
  })

  await it('缺省路径来自 lib/paths.mjs（不是脚本里另写一份字面量）', async () => {
    const options = parseArgs(['--data-dir', 'var/zzz'])
    check('inbox', options.inbox === defaultInbox('var/zzz'), options.inbox)
    check('bus', options.bus === defaultBus('var/zzz'), options.bus)
    check('audio', options.audio === defaultAudioIn('var/zzz'), options.audio)
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
      code = await main(['--dry-run', '--quiet-logs', '--port', '18788'])
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
    check('说明是 dry-run、没真的启动', output.includes('--dry-run'), output.slice(-120))
  })

  await it('--dry-run 不留下副作用（不写日志、不动音频）', async () => {
    const { existsSync, statSync } = await import('node:fs')
    const audioPath = join(VAR_DIR, 'live', 'audio-in.pcm')
    const before = existsSync(audioPath) ? statSync(audioPath).size : null
    const captured = []
    const original = process.stdout.write
    process.stdout.write = chunk => { captured.push(String(chunk)); return true }
    try {
      await main(['--dry-run', '--quiet-logs', '--port', '18788'])
    } finally {
      process.stdout.write = original
    }
    const after = existsSync(audioPath) ? statSync(audioPath).size : null
    check('音频文件大小没变（dry-run 不该清它）', before === after, `${before} → ${after}`)
  })
}
