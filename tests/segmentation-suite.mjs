/**
 * segmentation-suite.mjs —— 切句参数：**只有一条链**，没有全局旋钮（5.167 → 5.192）
 * ============================================================================
 *
 * 5.167 曾经给切句参数加过一个"全局旋钮"（`<data-dir>/segmentation.json`，管理台可改）。
 * 5.192 **整层删掉**了，理由就是用户看着管理台问的那句话 —— 界面上永远挂着：
 *
 *     ⚠️ 全局旋钮正压着：silence_ms、min_speech_ms、max_speech_ms、…
 *
 * 那行字的意思等于"你按语种调的值没生效"。同一组参数有两个来源、而且优先级相反，
 * 是最容易把人带错的设计；而策略表本来就热读（改完下一段生效），
 * "现场应急调一下"在表里同样做得到。
 *
 * 所以这一套现在钉的是**删除之后必须成立的四件事**：
 *   ① 校验规则还在（服务端写表时仍然用它把关，规则只有一份）；
 *   ② API 不再偷偷生效：`/org/segmentation` 回 410，并把人指到「识别模型」；
 *   ③ **残留文件不再影响任何东西**（这条最重要：老机器上那个文件一定还在）；
 *   ④ 管理台：全局面板没了，每门语言那一行**直接写出当前生效值**。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeFileSync as writeFile } from 'node:fs'
import { join } from 'node:path'

import { VAR_DIR } from '../lib/paths.mjs'
import {
  SEGMENTATION_DEFAULTS, SEGMENTATION_FIELDS, SEGMENTATION_RULES,
  legacySegmentationFile, validateSegmentation,
} from '../lib/segmentation.mjs'
import { startRelay } from '../relay/lan-relay.mjs'
import { createAccountWithPassword, loadAccounts, saveAccounts } from '../lib/accounts.mjs'

const ROOT = join(import.meta.dirname, '..')
const SECRET = 'seg-suite-secret-0123456789'
const BASE = join(VAR_DIR, 'test', 'segmentation')

export async function runSegmentationSuite({ it, check }) {
  await it('5.192：校验规则还在（一份规则、一处来源），全局读写已经删掉', () => {
    check('六个字段都在', SEGMENTATION_FIELDS.length === 6, SEGMENTATION_FIELDS.join(','))
    check('每个字段都有规则与缺省',
      SEGMENTATION_FIELDS.every((key) => SEGMENTATION_RULES[key] && Number.isFinite(SEGMENTATION_DEFAULTS[key])))

    const good = validateSegmentation({ max_speech_ms: 8000, silence_ms: 600 })
    check('合法值通过', good.ok === true, good.problems.join('；'))
    check('没写的字段落回缺省', good.values.min_speech_ms === SEGMENTATION_DEFAULTS.min_speech_ms)

    const big = validateSegmentation({ max_speech_ms: 30000 })
    check('30 秒上限仍然给"偏大"的警告（它正是延迟的主要来源）',
      big.warnings.some((one) => one.includes('max_speech_ms')), big.warnings.join('；'))

    const crossed = validateSegmentation({ min_speech_ms: 2000, max_speech_ms: 2000 })
    check('min ≥ max 被拒（那不是"调"，是写反）',
      crossed.ok === false && crossed.problems.some((one) => one.includes('必须小于')),
      crossed.problems.join('；'))

    const weird = validateSegmentation({ silence_ms: 400, short_silence_ms: 300 })
    check('短句静音比普通静音还短 → 警告',
      weird.warnings.some((one) => one.includes('short_silence_ms')), weird.warnings.join('；'))

    // 关键：全局旋钮那两个函数**不该还导出** —— 留着就一定有人再调一次。
    const libSource = readFileSync(join(ROOT, 'lib', 'segmentation.mjs'), 'utf-8')
    const pySource = readFileSync(join(ROOT, 'bridge', 'whisper_stream.py'), 'utf-8')
    check('loadSegmentation / saveSegmentation 已经不在 lib 里',
      /export function loadSegmentation\(/.test(libSource) === false
      && /export function saveSegmentation\(/.test(libSource) === false, 'lib 里还有全局读写的导出')
    check('python 侧也不再读那份文件', /def load_global_segmentation\(/.test(pySource) === false)
    check('留下的是"废弃文件提示"，而且**不自动删**（里面可能有手调过的值）',
      /def legacy_segmentation_file\(/.test(pySource) && /def warn_legacy_segmentation\(/.test(pySource))
  })

  await it('5.192：残留的 segmentation.json 不再影响任何生效值（老机器上它一定还在）', async () => {
    const { handleOrg } = await import('../relay/org-api.mjs')
    const dir = join(BASE, 'legacy')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    // 故意写一份"会改变切句行为"的文件：如果还有任何一层在读它，下面的断言就会红。
    writeFile(join(dir, 'segmentation.json'), JSON.stringify({ silence_ms: 1500, max_speech_ms: 5000 }))

    check('能发现这份废弃文件（好让管理台提示"可以删"）',
      legacySegmentationFile(dir) === join(dir, 'segmentation.json'), legacySegmentationFile(dir))
    check('没有文件时返回空串', legacySegmentationFile(join(BASE, 'nope')) === '')

    const table = {
      default: { model: 'large-v3', segmentation: { silence_ms: 800, max_speech_ms: 8000 } },
      languages: { 'zh-CN': { strategy: 'default' } },
    }
    writeFile(join(dir, 'asr-models.json'), JSON.stringify(table))
    const read = await handleOrg({
      method: 'GET', path: '/org/asr/models', segments: ['org', 'asr', 'models'],
      body: null, user: 'admin@x', role: 'admin', root: dir, now: new Date(), log: () => {},
    })
    const zh = read.json?.segmentation?.['zh-CN']
    check('生效值来自策略表，**不是**那份残留文件',
      zh?.values?.silence_ms === 800 && zh?.values?.max_speech_ms === 8000, JSON.stringify(zh?.values))
    check('来源层里也不再有"全局旋钮"这一档',
      JSON.stringify(zh?.layers ?? {}).includes('全局旋钮') === false, JSON.stringify(zh?.layers))
    check('global 字段保留但永远是空的（老客户端不崩）',
      Array.isArray(zh?.global) && zh.global.length === 0, JSON.stringify(zh?.global))
    void table
  })

  await it('5.192：/org/segmentation 回 410 并指路（不再偷偷写文件）', async () => {
    const dir = join(BASE, 'api')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    let doc = await loadAccounts(dir)
    for (const [username, role] of [['admin1', 'admin'], ['dev1', 'dev']]) {
      const created = createAccountWithPassword(doc, { username, password: '123456', role })
      if (created.ok !== true) throw new Error('建 ' + username + ' 失败：' + created.error)
      doc = created.doc
    }
    await saveAccounts(dir, doc)

    const relay = await startRelay({
      dataDir: dir, port: 0, host: '127.0.0.1', secret: SECRET, quiet: true, pollHoldMs: 300,
    })
    const call = async (token, path, options = {}) => {
      const headers = { 'X-Leion-Secret': SECRET }
      if (token !== '') headers['X-Leion-Token'] = token
      if (options.body !== undefined) headers['Content-Type'] = 'application/json'
      const response = await fetch('http://127.0.0.1:' + relay.port + path, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      return { status: response.status, json: await response.json().catch(() => null) }
    }
    try {
      const loginAdmin = await call('', '/auth/login', {
        method: 'POST', body: { username: 'admin1', password: '123456' },
      })
      const admin = loginAdmin.json?.token
      check('admin 登录成功', typeof admin === 'string')

      for (const method of ['GET', 'PUT', 'POST']) {
        const path = method === 'POST' ? '/org/segmentation/validate' : '/org/segmentation'
        const response = await call(admin, path, {
          method, body: method === 'GET' ? undefined : { silence_ms: 600 },
        })
        check(method + ' ' + path + ' → 410（不是 404：要让人知道是"删了"，不是"挂了"）',
          response.status === 410, response.status + ' ' + JSON.stringify(response.json))
        check(method + ' ' + path + ' 的提示指向「识别模型」',
          String(response.json?.hint ?? '').includes('识别模型'), String(response.json?.hint ?? ''))
      }
      check('它不再偷偷写出 segmentation.json', existsSync(join(dir, 'segmentation.json')) === false)

      // 顺带确认：识别模型那条路仍然照常（删除只影响全局旋钮，不影响按语种调）
      const models = await call(admin, '/org/asr/models')
      check('识别模型的接口不受影响', models.status === 200 && models.json?.ok === true,
        JSON.stringify(models.json?.problems ?? ''))
    } finally {
      await relay.close()
    }
  })

  await it('5.192：管理台没有全局面板了，但**每门语言都显示当前生效值**', () => {
    const html = readFileSync(join(ROOT, 'scripts', 'admin-ui.html'), 'utf-8')
    check('全局旋钮那行警告彻底没了', /全局旋钮正压着/.test(html) === false)
    check('全局面板的表单与按钮都没了',
      /id="segForm"/.test(html) === false
      && /onclick="saveSeg\(\)"/.test(html) === false
      && /loadSeg\(\)/.test(html) === false)
    check('面板位置留了一句说明：指到「识别模型」、并说清"留空 = 继承"',
      /已并入「识别模型」/.test(html) && /留空 = 继承/.test(html))
    check('每门语言那一行直接写出**生效值**（用户要的"显示当前参数具体是多少"）',
      /生效：/.test(html) && /effective\[key\]/.test(html))
    check('输入框的悬停提示里也带着"现在生效 X"', /现在生效/.test(html))
  })

  // 5.171：用户实测"跑完长会 + 翻译官，磁盘满时只看到一句已达上限，不知道谁占的"。
  // 这一节钉住：占用按房间列出来、能单独删、删完立刻按磁盘重算（上限随之松开）。
  await it('5.171：音频占用按房间列出，且能单独删（删完立刻重算）', async () => {
    const { audioUsage, purgeAllAudio, purgeRoomAudio, safeRoomId } = await import('../lib/audio-usage.mjs')
    const relaySource = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')

    // ① 路径清洗与 relay 同一套规则（两边不一致就会出现"列出来的房间删不掉"）
    check('房间名清洗规则一致',
      /replace\(\/\[\^A-Za-z0-9_-\]\/g, '_'\)\.slice\(0, 64\)/.test(relaySource)
      && safeRoomId('room-a') === 'room-a'
      && safeRoomId('a/b c') === 'a_b_c')
    check('既认分轨目录也认老的单文件',
      /entry\.isDirectory\(\)/.test(readFileSync(join(ROOT, 'lib', 'audio-usage.mjs'), 'utf-8')))

    const dir = join(VAR_DIR, "test", "audio-usage")
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, "audio", "room-a"), { recursive: true })
    writeFileSync(join(dir, "audio", "room-a", "ana.pcm"), Buffer.alloc(1000))
    writeFileSync(join(dir, "audio", "room-a", "ana.pcm.lang"), "pt-BR")
    writeFileSync(join(dir, "audio", "room-a", "bo.pcm"), Buffer.alloc(500))
    writeFileSync(join(dir, "audio", "room-b.pcm"), Buffer.alloc(300))
    writeFileSync(join(dir, "audio-in.pcm"), Buffer.alloc(200))

    const usage = audioUsage(dir)
    check('总数 = 各房间 + 旧单文件', usage.totalBytes === 1000 + 5 + 500 + 300 + 200,
      String(usage.totalBytes))
    check('旧单文件单独一列（不塞进任何房间）', usage.legacyBytes === 200, String(usage.legacyBytes))
    check('房间按占用从大到小排',
      usage.rooms[0].roomId === 'room-a'
      && usage.rooms[0].bytes === 1505, JSON.stringify(usage.rooms.map((one) => one.roomId)))
    check('旁文件算进那个说话人的音轨（不冒出一个叫 ana.pcm.lang 的说话人）',
      usage.rooms[0].tracks.length === 2
      && usage.rooms[0].tracks[0].speaker === 'ana'
      && usage.rooms[0].tracks[0].bytes === 1005,
      JSON.stringify(usage.rooms[0].tracks))
    check('老的单文件也作为一个房间列出来',
      usage.rooms.some((one) => one.roomId === 'room-b' && one.bytes === 300))

    // 5.173：同一场会在磁盘上有两份（分轨 `audio/<房间>/` + 混流副本 `audio/<房间>.pcm`），
    // 早先被当成两场会列出来 —— 管理台上同一个邀请码出现两行、大小一模一样。
    const dupDir = join(VAR_DIR, "test", "audio-usage-dup")
    rmSync(dupDir, { recursive: true, force: true })
    mkdirSync(join(dupDir, "audio", "136015"), { recursive: true })
    writeFileSync(join(dupDir, "audio", "136015", "test11.pcm"), Buffer.alloc(600))
    writeFileSync(join(dupDir, "audio", "136015.pcm"), Buffer.alloc(600))
    const dup = audioUsage(dupDir)
    check('同一场会只有一行（不再是"两场会"）',
      dup.rooms.length === 1 && dup.rooms[0].roomId === '136015', JSON.stringify(dup.rooms))
    check('两份都算进这一行', dup.rooms[0].bytes === 1200, String(dup.rooms[0].bytes))
    check('混流副本作为一条音轨挂在同一行，且排在最后',
      dup.rooms[0].tracks.length === 2
      && dup.rooms[0].tracks[0].speaker === 'test11'
      && dup.rooms[0].tracks[1].speaker === '(混流副本)',
      JSON.stringify(dup.rooms[0].tracks))
    const dupPurged = purgeRoomAudio(dupDir, '136015')
    check('删一次两份一起删（不会剩一个删不掉的副本）',
      dupPurged.ok === true && dupPurged.freedBytes === 1200
      && audioUsage(dupDir).rooms.length === 0, JSON.stringify(dupPurged))
    rmSync(dupDir, { recursive: true, force: true })

    const purged = purgeRoomAudio(dir, 'room-a')
    check('删一场：成功并报出释放量', purged.ok === true && purged.freedBytes === 1505,
      JSON.stringify(purged))
    check('删完只剩另一场', audioUsage(dir).rooms.length === 1
      && audioUsage(dir).rooms[0].roomId === 'room-b'
)
    check('删不存在的房间要说清（不是静默成功）',
      purgeRoomAudio(dir, 'room-zzz').ok === false)

    const all = purgeAllAudio(dir)
    check('一次清光：房间与旧单文件都清掉', all.ok === true && audioUsage(dir).rooms.length === 0
      && audioUsage(dir).legacyBytes === 0, JSON.stringify(all))
    rmSync(dir, { recursive: true, force: true })

    // ② API + 管理台
    const api = readFileSync(join(ROOT, 'relay', 'org-api.mjs'), 'utf-8')
    check('API：读占用 + 删录音两个路由都在',
      /segments\[1\] === 'audio' && segments\[2\] === 'usage'/.test(api)
      && /segments\[1\] === 'audio' && segments\[2\] === 'purge'/.test(api))
    check('删录音要管理员权限（history.purge）', /allowed\(role, 'history.purge'\)/.test(api))
    check('删完让转发进程按磁盘重算（否则上限还挡着）', /onAudioPurged/.test(api)
      && /onAudioPurged/.test(relaySource))

    const html = readFileSync(join(ROOT, 'scripts', 'admin-ui.html'), 'utf-8')
    check('管理台有音频占用面板', /id="audioPanel"/.test(html))
    check('按房间列出占用与音轨', /humanMb\(room\.bytes\)/.test(html) && /one\.speaker/.test(html))
    check('每场会一个删除按钮 + 二次确认',
      /删掉这场录音/.test(html) && /confirm\(hint\)/.test(html))
    check('界面说清只腾磁盘、不动字幕与历史', /只腾磁盘/.test(html))

    // 5.172：管理员是拿**邀请码**去手机上找那场会的，不是内部房间 id
    check('API 把磁盘目录名翻成邀请码/房名（含已散会的会）',
      /roomLabels\(root\)/.test(api) && /code: label \? label\.code/.test(api)
      && /known: Boolean\(label\)/.test(api))
    check('表头写的是邀请码（不是"房间 id"）', /会议（邀请码）/.test(html))
    check('表格主行显示邀请码，id 只是次要信息',
      /<code style="font-size:16px;letter-spacing:1px">' \+ escHtml\(code\)/.test(html)
      && /（数据库里没有这场）/.test(html))
    check('房名/邀请码进 innerHTML 前要转义（房名是用户自己起的）',
      /function escHtml/.test(html) && /escHtml\(name\)/.test(html))
    check('删除确认里用的是邀请码（不是裸 id）', /purgeAudio\(room\.roomId, room\.bytes, roomLabel\(room\)\)/.test(html))
    check('界面说清"同场两份"为什么（不然会以为我算错了）', /同场两份说明/.test(html))
    check('有「清空全部录音」（旧单文件不在任何房间里，按房间删永远删不到它）',
      /purgeAudioAll\(\)/.test(html) && /body: \{ all: true \}/.test(html)
      && /清空全部录音/.test(html))
  })

  // 5.177：用户要「日志简单点」，并指定了做法：
  //   · 路线 A（把账塞进数据流）+ 每句一个句号（<邀请码>#<房间内序号>）；
  //   · 打印识别到的原文（前 40 字）+ 编号，便于追踪；
  //   · 成功路径降级、心跳按变化打、丢弃碎片汇总；
  //   · 默认 summary 档（每句一行摘要）。
  await it('5.177：每句一行摘要 —— 句号贯通 / 两行日志 / 档位缺省 summary', async () => {
    const python = readFileSync(join(ROOT, 'bridge', 'whisper_stream.py'), 'utf-8')
    const worker = readFileSync(join(ROOT, 'bridge', 'asr-worker.mjs'), 'utf-8')
    const core = readFileSync(join(ROOT, 'plugin', 'core.mjs'), 'utf-8')
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')
    const multi = readFileSync(join(ROOT, 'scripts', 'start-multi.mjs'), 'utf-8')

    // ① 句号：切句时分配，写进 meta → payload → 收件箱 → 帧
    check('切句时分配句号（<邀请码>#<序号>）', /def next_seq_id/.test(python)
      && /"seg": seg_no, "segId": seg_id/.test(python))
    check('邀请码由启动脚本传下去（切句进程拿不到数据库）',
      /--room-code/.test(python) && /'--room-code'/.test(multi))

    // ② 账跟着数据走：段长/排队/识别/等静音
    check('payload 带上四段耗时', /"segMs": seg_ms, "queueMs": queue_ms, "asrMs": asr_ms/.test(python)
      && /"silenceMs": silence_ms_now/.test(python))
    check('收件箱行透传（worker）',
      /cost: \{ seg: payload\.seg, segId: payload\.segId/.test(worker) && /silenceMs/.test(worker))
    check('大脑白名单放行并写进帧（cost）', /cost: \(\s*\(\) =>/.test(core)
      && /cost: Object\.assign\(\{\}, item\.cost \?\? \{\}, \{ trMs \}\)/.test(core))

    // ③ 两行日志：原文行（识别侧）+ 摘要行（转发侧）
    check('打印识别到的原文 + 编号（前 40 字）', /\[原文\] \{label\}/.test(python)
      && /preview\(text\)/.test(python))
    check('转发侧有"每句一行摘要"', /function logSummary/.test(relay) && /function renderSummary/.test(relay))
    check('摘要里 ⇒ 是"说完到手机"（含等静音）', /silenceMs \+ queueMs \+ asrMs \+ trMs \+ pushMs/.test(relay))

    // ④ 档位：缺省 summary；detail 才逐句打延迟账
    check('python 有 --log-level 且缺省 summary',
      /--log-level", default="summary"/.test(python) && /log_level_at_least/.test(python))
    check('relay 也有 --log-level 且缺省 summary',
      /logLevel: 'summary'/.test(relay) && /--log-level/.test(relay))

    // ⑤ 降级与汇总
    check('成功路径降级（字幕已更新/定稿帧/取字幕 不再是每句一行）',
      /logSummary\(frame, attribution\.roomId\)/.test(relay)
      && /logLevelAtLeast\('trace'\)/.test(relay))
    check('丢弃碎片汇总（首段立刻说，之后计数）', /drop_burst/.test(python) && /丢弃 \{burst\[/.test(python))
    check('译文行截到 40 字', /previewText\(result\.translation\)/.test(core))
    check('心跳按变化才打', /lastBeat/.test(multi))
  })

  // 5.169：用户要「不用录音对表也能看出延迟落在哪一段」。四段各自留痕：
  // 切句（配置值）｜排队｜识别（python 那行账）｜翻译（大脑）｜推送（relay）。
  await it('5.169：四段延迟各自留痕（切句/排队/识别/翻译/推送）', () => {
    const python = readFileSync(join(ROOT, 'bridge', 'whisper_stream.py'), 'utf-8')
    const plugin = readFileSync(join(ROOT, 'plugin', 'core.mjs'), 'utf-8')
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')

    // 5.177：这几项现在是 detail 档（摘要行已经带上同样的数），但实现必须还在
    check('识别侧仍保留一行延迟账（detail 档：音频/排队/识别/切句参数）',
      /\[延迟\] 房间/.test(python) && /排队 /.test(python) && /切句 silence=/.test(python))
    check('排队耗时的起点是这一段被取走的时刻', /picked_at_ms/.test(python))
    // 5.192：全局旋钮删除后，切句参数改取**这一段自己那份策略**里的值
    // （同一场会里不同语种可以有不同的 silence/max，猜命令行反而错）
    check('切句参数取这一段策略里的值，不再读全局文件',
      /profile_seg = profile\.get\("segmentation"\)/.test(python)
      && /load_global_segmentation/.test(python) === false)
    check('记不了也不拖停识别（包在 try 里并留一行）', /记不了这一段/.test(python))

    check('大脑打翻译耗时', /翻译耗时 /.test(plugin) && /translateStartedAt/.test(plugin))
    check('翻译耗时的起点在发起模型调用之前',
      /const translateStartedAt = Date\.now\(\)[\s\S]{0,200}?translator\.translate\(/.test(plugin))

    // 5.177：四段账并进「每句一行摘要」，所以这里改盯摘要那一行的实现
    check('转发打「每句一行摘要」（段/识/译/推 + ⇒）',
      /function logSummary/.test(relay) && /⇒/.test(relay) && /Date\.parse\(frame\.at\)/.test(relay))
    check('只在定稿上打（增量帧太密，打出来是刷屏；5.177 起由 logSummary 自己判）',
      /function logSummary[\s\S]{0,400}?frame\.partial === true\) return/.test(relay))
  })

  await it('5.192：管理台那块面板已经改成"说明"（不再有输入框与保存按钮）', () => {
    const html = readFileSync(join(ROOT, 'scripts', 'admin-ui.html'), 'utf-8')
    check('面板位置还在（但只是说明，指路到「识别模型」）',
      /id="segPanel"/.test(html) && /已并入「识别模型」/.test(html))
    check('输入框 / 校验 / 保存 / 恢复缺省这几个动作都删了',
      /renderSegForm/.test(html) === false
      && /validateSeg\(\)/.test(html) === false
      && /saveSeg\(\)/.test(html) === false
      && /恢复成内置缺省/.test(html) === false)
    check('说明里写清现在的顺序（内置缺省 → default → 策略 → 语言，命令行最强）',
      /内置缺省/.test(html) && /命令行/.test(html))
    check('说明里写清生效时机（留空 = 继承；每行末尾显示生效值）',
      /留空 = 继承/.test(html) && /生效/.test(html))
  })
}
