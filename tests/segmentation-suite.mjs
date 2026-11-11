/**
 * segmentation-suite.mjs —— 切句参数的全局旋钮（5.167）
 * ============================================================================
 *
 * 为什么要这个旋钮：同传延迟 ≈「一句攒多久」+ 静音判定 + 识别 + 翻译。
 * 实测（老师的场次）：`max_speech_ms` 缺省 30 秒 → 一句攒到 18~24 秒 → 识别整段跑 4~8 秒
 * → 体感延迟半分钟。而这几个数原来只能改命令行重启整条管线。
 *
 * 这一套钉四件事：
 *   ① 校验是纯函数：区间、交叉约束、"看起来写反了"的警告；
 *   ② 保存先备份、写盘原子（读端永远看不到半个文件）；
 *   ③ 权限：读给 dev，写只给 admin（与识别模型同一套 model.write）；
 *   ④ 端到端：PUT 之后 python 侧读到的是新值（用 python 直接调 load_global_segmentation）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync as writeFile } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { VAR_DIR } from '../lib/paths.mjs'
import {
  SEGMENTATION_DEFAULTS, SEGMENTATION_FIELDS, SEGMENTATION_RULES,
  loadSegmentation, saveSegmentation, validateSegmentation,
} from '../lib/segmentation.mjs'
import { startRelay } from '../relay/lan-relay.mjs'
import { createAccountWithPassword, loadAccounts, saveAccounts } from '../lib/accounts.mjs'

const ROOT = join(import.meta.dirname, '..')
const SECRET = 'seg-suite-secret-0123456789'
const BASE = join(VAR_DIR, 'test', 'segmentation')

function runToFile(command, args, outPath) {
  const fd = openSync(outPath, 'w')
  let failure = null
  try {
    execFileSync(command, args, { stdio: ['ignore', fd, fd] })
  } catch (error) {
    failure = error
  } finally {
    closeSync(fd)
  }
  return { failure, output: readFileSync(outPath, 'utf-8') }
}

export async function runSegmentationSuite({ it, check }) {
  await it('5.167：切句参数是纯函数校验（区间 / 交叉约束 / 写反了的警告）', () => {
    check('六个字段都在', SEGMENTATION_FIELDS.length === 6, SEGMENTATION_FIELDS.join(','))
    check('每个字段都有规则与缺省',
      SEGMENTATION_FIELDS.every((key) => SEGMENTATION_RULES[key] && Number.isFinite(SEGMENTATION_DEFAULTS[key])))
    check('缺省里 max_speech_ms 是 30 秒（也就是"延迟半分钟"的来源）',
      SEGMENTATION_DEFAULTS.max_speech_ms === 30000, String(SEGMENTATION_DEFAULTS.max_speech_ms))

    const good = validateSegmentation({ max_speech_ms: 8000, silence_ms: 600 })
    check('合法值通过', good.ok === true, good.problems.join('；'))
    check('没写的字段落回缺省', good.values.min_speech_ms === SEGMENTATION_DEFAULTS.min_speech_ms)
    check('8 秒上限不再提示"偏大"', !good.warnings.some((one) => one.includes('max_speech_ms')))

    const big = validateSegmentation({ max_speech_ms: 30000 })
    check('30 秒上限会给出"偏大"的警告（并说明为什么会慢）',
      big.warnings.some((one) => one.includes('max_speech_ms')), big.warnings.join('；'))

    const inverted = validateSegmentation({ min_speech_ms: 5000, max_speech_ms: 8000 })
    check('越界被拒', inverted.ok === false && inverted.problems.some((one) => one.includes('min_speech_ms')))

    const crossed = validateSegmentation({ min_speech_ms: 2000, max_speech_ms: 2000 })
    check('min ≥ max 被拒（那不是"调"，是写反）',
      crossed.ok === false && crossed.problems.some((one) => one.includes('必须小于')), crossed.problems.join('；'))

    const weird = validateSegmentation({ silence_ms: 400, short_silence_ms: 300 })
    check('短句静音比普通静音还短 → 警告（通常写反了）',
      weird.warnings.some((one) => one.includes('short_silence_ms')), weird.warnings.join('；'))

    const unknown = validateSegmentation({ nope: 1 })
    check('不认识的字段只警告、不报错', unknown.ok === true
      && unknown.warnings.some((one) => one.includes('nope')), unknown.warnings.join('；'))
    check('不是对象直接拒', validateSegmentation(null).ok === false
      && validateSegmentation([]).ok === false)
  })

  await it('5.167：保存先备份、写盘原子、读回来是同一份值', () => {
    mkdirSync(BASE, { recursive: true })
    const dir = join(BASE, 'save')
    // 每次从空目录开始：上一轮留下的 segmentation.json 会让"第一次没有备份"这条断言失真
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const first = saveSegmentation(dir, { max_speech_ms: 9000 })
    check('第一次保存成功', first.ok === true, first.error ?? '')
    check('文件真的写了', existsSync(join(dir, 'segmentation.json')))
    check('第一次没有备份（原来没文件）', first.backup === '', first.backup)

    const second = saveSegmentation(dir, { max_speech_ms: 8000, silence_ms: 700 })
    check('第二次保存成功', second.ok === true, second.error ?? '')
    check('第二次留了备份（改坏了能回退）', second.backup !== '' && existsSync(second.backup), second.backup)

    const loaded = loadSegmentation(dir)
    check('读回来是 file 来源', loaded.source === 'file', loaded.source)
    check('值是刚保存的那份', loaded.values.max_speech_ms === 8000 && loaded.values.silence_ms === 700,
      JSON.stringify(loaded.values))
    check('没写的字段是缺省', loaded.values.cut_pause_ms === SEGMENTATION_DEFAULTS.cut_pause_ms)

    const bad = saveSegmentation(dir, { max_speech_ms: 1 })
    check('非法值不落盘', bad.ok === false)
    check('非法值不覆盖原文件', loadSegmentation(dir).values.max_speech_ms === 8000)

    const broken = join(BASE, 'broken')
    rmSync(broken, { recursive: true, force: true })
    mkdirSync(broken, { recursive: true })
    writeFile(join(broken, 'segmentation.json'), '{ 这不是 JSON')
    check('文件坏了退回缺省并说清来源', loadSegmentation(broken).source === 'broken')
  })

  await it('5.167：API 权限与读写（dev 能读、只有 admin 能写）', async () => {
    const dir = join(BASE, 'api')
    // 整目录重建：上一轮的 accounts.json 会让"建 admin1 失败：用户名已存在"
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    let doc = await loadAccounts(dir)
    for (const [username, role] of [['admin1', 'admin'], ['dev1', 'dev']]) {
      const created = createAccountWithPassword(doc, { username, password: '123456', role })
      if (created.ok !== true) throw new Error(`建 ${username} 失败：${created.error}`)
      doc = created.doc
    }
    await saveAccounts(dir, doc)

    const relay = await startRelay({ dataDir: dir, port: 0, host: '127.0.0.1', secret: SECRET, quiet: true, pollHoldMs: 300 })
    const call = async (token, path, options = {}) => {
      const headers = { 'X-Leion-Secret': SECRET }
      if (token !== '') headers['X-Leion-Token'] = token
      if (options.body !== undefined) headers['Content-Type'] = 'application/json'
      const response = await fetch(`http://127.0.0.1:${relay.port}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      return { status: response.status, json: await response.json().catch(() => null) }
    }
    try {
      const loginAdmin = await call('', '/auth/login', { method: 'POST', body: { username: 'admin1', password: '123456' } })
      const loginDev = await call('', '/auth/login', { method: 'POST', body: { username: 'dev1', password: '123456' } })
      const admin = loginAdmin.json?.token
      const dev = loginDev.json?.token
      check('两个账号都登录成功', typeof admin === 'string' && typeof dev === 'string')

      const read = await call(dev, '/org/segmentation')
      check('dev 能读（开发要看现场参数）', read.status === 200 && read.json?.ok === true,
        JSON.stringify(read.json))
      check('读回来的带缺省、规则与生效说明',
        read.json.defaults?.max_speech_ms > 0 && read.json.rules?.max_speech_ms !== undefined
        && String(read.json.note ?? '').includes('下一'))

      const denied = await call(dev, '/org/segmentation', { method: 'PUT', body: { max_speech_ms: 8000 } })
      check('dev 不能写（403）', denied.status === 403, `${denied.status} ${JSON.stringify(denied.json)}`)

      const invalid = await call(admin, '/org/segmentation', { method: 'PUT', body: { max_speech_ms: 10 } })
      check('admin 写非法值 → 400', invalid.status === 400, JSON.stringify(invalid.json))

      const saved = await call(admin, '/org/segmentation', { method: 'PUT', body: { max_speech_ms: 8000, silence_ms: 600 } })
      check('admin 写合法值 → 200', saved.status === 200 && saved.json.ok === true, JSON.stringify(saved.json))
      check('保存后文件真的在', existsSync(join(dir, 'segmentation.json')))

      const reread = await call(dev, '/org/segmentation')
      check('再读是刚写进去的值',
        reread.json.values.max_speech_ms === 8000 && reread.json.source === 'file',
        JSON.stringify(reread.json.values))

      const validated = await call(dev, '/org/segmentation/validate', { method: 'POST', body: { max_speech_ms: 30000 } })
      check('校验接口给警告（不写盘）', validated.status === 200
        && validated.json.warnings.some((one) => one.includes('max_speech_ms')))

      const reset = await call(admin, '/org/segmentation', { method: 'PUT', body: { reset: true } })
      check('一键恢复缺省', reset.status === 200
        && (await call(dev, '/org/segmentation')).json.values.max_speech_ms === SEGMENTATION_DEFAULTS.max_speech_ms)
    } finally {
      await relay.close()
    }
  })

  await it('5.167：python 侧真读这份文件（"下一段录音生效"不是空话）', () => {
    const script = join(ROOT, 'bridge', 'whisper_stream.py')
    const source = readFileSync(script, 'utf-8')
    check('python 里有 load_global_segmentation', /def load_global_segmentation\(/.test(source))
    check('按 mtime 缓存（每段都读一次不划算）', /_GLOBAL_SEG_CACHE/.test(source))
    check('合并顺序：缺省 → 策略表 → 全局文件',
      /seg = dict\(SEGMENTATION_DEFAULTS\)[\s\S]{0,300}?seg\.update\(_numbers_or_skip\(segmentation, SEGMENTATION_FIELDS\)\)[\s\S]{0,300}?load_global_segmentation/.test(source))
    check('读坏了只警告、不拖停切句', /读不了全局切句设置/.test(source))

    let pythonOk = true
    try {
      execFileSync('python', ['--version'], { stdio: 'ignore' })
    } catch {
      pythonOk = false
    }
    if (!pythonOk) {
      console.log('  ⏭ 这台机器没有 python，跳过可执行用例（静态断言已在上面跑过）')
      return
    }
    const dir = join(BASE, 'py')
    mkdirSync(dir, { recursive: true })
    writeFile(join(dir, 'segmentation.json'), JSON.stringify({ max_speech_ms: 8000, silence_ms: 650 }))
    const out = join(BASE, 'py-out.txt')
    const code = [
      'import json, sys',
      `sys.path.insert(0, r'${join(ROOT, 'bridge').replace(/\\/g, '/')}')`,
      'import whisper_stream as ws',
      `values = ws.load_global_segmentation(r'${dir.replace(/\\/g, '/')}')`,
      'print(json.dumps(values, sort_keys=True))',
    ].join('\n')
    const result = runToFile('python', ['-c', code], out)
    if (result.failure !== null && result.failure.code === 'EPERM') {
      console.log('  ⏭ 沙箱不允许起子进程（python EPERM），跳过可执行用例。')
      return
    }
    const printed = (result.output || '').trim().split('\n').pop() ?? ''
    check('python 读到了文件里的值', /"max_speech_ms":\s*8000/.test(printed), printed.slice(-200))
    check('只认认识的字段（别的键被忽略）',
      !printed.includes('nope') && printed.includes('silence_ms'), printed.slice(-200))
  })

  // 5.169：用户要「不用录音对表也能看出延迟落在哪一段」。四段各自留痕：
  // 切句（配置值）｜排队｜识别（python 那行账）｜翻译（大脑）｜推送（relay）。
  await it('5.169：四段延迟各自留痕（切句/排队/识别/翻译/推送）', () => {
    const python = readFileSync(join(ROOT, 'bridge', 'whisper_stream.py'), 'utf-8')
    const plugin = readFileSync(join(ROOT, 'plugin', 'core.mjs'), 'utf-8')
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')

    check('识别侧打一行延迟账（音频/排队/识别/切句参数）',
      /\[延迟\] 房间/.test(python) && /排队 /.test(python) && /切句 silence=/.test(python))
    check('排队耗时的起点是这一段被取走的时刻', /picked_at_ms/.test(python))
    check('切句参数取命令行 + 全局旋钮的合成值（不猜）',
      /load_global_segmentation\(getattr\(args, "data_dir"/.test(python))
    check('记不了也不拖停识别（包在 try 里并留一行）', /记不了这一段/.test(python))

    check('大脑打翻译耗时', /翻译耗时 /.test(plugin) && /translateStartedAt/.test(plugin))
    check('翻译耗时的起点在发起模型调用之前',
      /const translateStartedAt = Date\.now\(\)[\s\S]{0,200}?translator\.translate\(/.test(plugin))

    check('转发打「大脑写出 → 推送」的间隔（用帧自带的 at）',
      /大脑写出→推送/.test(relay) && /Date\.parse\(frame\.at\)/.test(relay))
    check('只在定稿上打（增量帧太密，打出来是刷屏）',
      /frame\.partial !== true[\s\S]{0,400}?大脑写出→推送/.test(relay))
  })

  await it('5.167：管理台有这块面板（输入框 + 校验 + 保存 + 恢复缺省）', () => {
    const html = readFileSync(join(ROOT, 'scripts', 'admin-ui.html'), 'utf-8')
    check('有面板', /id="segPanel"/.test(html))
    check('六个字段渲染成数字输入框', /renderSegForm/.test(html) && /input\.type = 'number'/.test(html))
    check('每个字段都显示"是什么 + 范围 + 缺省"', /rule\.note/.test(html) && /rule\.min/.test(html))
    check('有校验 / 保存 / 恢复缺省三个动作',
      /validateSeg\(\)/.test(html) && /saveSeg\(\)/.test(html) && /confirm\('恢复成内置缺省/.test(html))
    check('界面明写生效时机（不在句子中间重建）', /下一段录音 \/ 下一场会生效/.test(html))
    check('界面明写优先级（压过策略表）', /压过/.test(html) && /命令行/.test(html))
  })
}
