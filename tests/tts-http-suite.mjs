/**
 * tts-http-suite.mjs —— 「服务器合成语音」这条路（5.157）
 * ============================================================================
 *
 * 背景：手机自己**没有巴葡/英语的语音包**，所以那两门语言必须由服务器合成。
 * 两条链路都保留（用户要求：本地那条当备份、也用来对比），由一颗开关控制。
 *
 * 这一套钉四件事：
 *   ① `lib/tts-http.mjs` 的请求规整是纯函数（语言只认三门、长度有上限、不猜）；
 *   ② relay 的 `POST /tts` 真的会把内网合成服务的 wav **原样**转给手机，
 *      而"服务没起 / 报错 / 参数不对"要给不同的状态码 —— 手机据此说人话并弹窗；
 *   ③ 手机侧的路由规则：**中文恒本地**，葡语/英语按开关走服务器，关掉就全走本地；
 *   ④ `bridge/tts-server.py` 的纯函数自检（不装 piper 也能跑）。
 */

import { createServer } from 'node:http'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { VAR_DIR } from '../lib/paths.mjs'
import { normalizeTtsLang, normalizeTtsRequest, requestTts, TTS_HTTP_LIMITS } from '../lib/tts-http.mjs'
import { startRelay } from '../relay/lan-relay.mjs'

const ROOT = join(import.meta.dirname, '..')
const JAVA_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
const SECRET = 'tts-suite-secret-0123456789'

/** 一段 0.1 秒的静音 wav（44 字节头 + 2205 个 16-bit 采样），冒充合成结果。 */
function tinyWav() {
  const samples = 2205
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples * 2, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(22050, 24)
  header.writeUInt32LE(22050 * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples * 2, 40)
  return Buffer.concat([header, Buffer.alloc(samples * 2)])
}

/** 假的合成服务：行为由 `mode` 决定，便于一次测完四种回包。 */
function startFakeUpstream() {
  const state = { mode: 'ok', calls: [] }
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8')
      state.calls.push(body)
      if (state.mode === 'ok') {
        const wav = tinyWav()
        response.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': String(wav.length),
          'X-Leion-Tts-Synth-Ms': '42',
          'X-Leion-Tts-Voice': 'pt_BR-faber-medium',
        })
        response.end(wav)
        return
      }
      const payload = Buffer.from(JSON.stringify({ ok: false, error: state.mode }), 'utf-8')
      response.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) })
      response.end(payload)
    })
  })
  return { server, state, listen: () => new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  }) }
}

export async function runTtsHttpSuite({ it, check }) {
  await it('5.157：请求规整是纯函数（语言只认三门 / 长度有上限 / 不猜）', () => {
    check('zh / pt / en 都归一', normalizeTtsLang('zh-CN') === 'zh-CN'
      && normalizeTtsLang('pt_br') === 'pt-BR' && normalizeTtsLang('EN') === 'en-US')
    check('认不出来的语言给空串（绝不硬套一门）', normalizeTtsLang('de-DE') === ''
      && normalizeTtsLang('') === '' && normalizeTtsLang(undefined) === '')
    check('正常请求通过', normalizeTtsRequest({ text: 'Bom dia', lang: 'pt-BR' }).ok === true)
    check('空文本被拒', normalizeTtsRequest({ text: '   ', lang: 'pt-BR' }).ok === false)
    check('不是对象被拒', normalizeTtsRequest(null).ok === false
      && normalizeTtsRequest([]).ok === false)
    const long = normalizeTtsRequest({ text: 'a'.repeat(TTS_HTTP_LIMITS.maxChars + 1), lang: 'en-US' })
    check('超长文本被拒且说清这是"一句话"用的', long.ok === false && /一句话/.test(long.error),
      long.error)
    check('语言写错被拒且列出支持项',
      /pt-BR/.test(normalizeTtsRequest({ text: 'hi', lang: 'xx' }).error ?? ''))
    check('文本会被 trim', normalizeTtsRequest({ text: '  hi  ', lang: 'en-US' }).text === 'hi')
  })

  await it('5.157：relay 的 POST /tts 把内网 wav 原样给手机，坏情况给不同状态码', async () => {
    const upstream = startFakeUpstream()
    const upstreamPort = await upstream.listen()
    const relay = await startRelay({
      dataDir: join(VAR_DIR, 'test', 'tts-http'), port: 0, host: '127.0.0.1',
      secret: SECRET, quiet: true, pollHoldMs: 300,
      ttsUrl: `http://127.0.0.1:${upstreamPort}`,
    })
    const base = `http://127.0.0.1:${relay.port}`
    const post = (path, body, secret = SECRET) => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'X-Leion-Secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    try {
      const info = await (await fetch(`${base}/tts/info`, { headers: { 'X-Leion-Secret': SECRET } })).json()
      check('/tts/info 说明语言与上限', Array.isArray(info.langs) && info.langs.includes('pt-BR')
        && info.limits?.maxChars > 0, JSON.stringify(info))
      check('能力清单里有 tts-http（客户端据此判断走不走服务器）',
        (await (await fetch(`${base}/version`, { headers: { 'X-Leion-Secret': SECRET } })).json())
          .serverFeatures.includes('tts-http'))

      const ok = await post('/tts', { text: 'Bom dia a todos.', lang: 'pt-BR' })
      const audio = Buffer.from(await ok.arrayBuffer())
      check('合成成功回 200 + audio/wav', ok.status === 200
        && ok.headers.get('content-type') === 'audio/wav', ok.headers.get('content-type') ?? '')
      check('回的是**原始字节**（wav 头 RIFF 原样，没被包一层 JSON）',
        audio.subarray(0, 4).toString('ascii') === 'RIFF' && audio.length > 44, String(audio.length))
      check('把上游的音色与耗时透传成响应头（排障要看这些）',
        ok.headers.get('x-leion-tts-voice') === 'pt_BR-faber-medium'
        && ok.headers.get('x-leion-tts-synth-ms') === '42')
      check('上游收到的就是 {text, lang}',
        upstream.state.calls.length === 1
        && JSON.parse(upstream.state.calls[0]).lang === 'pt-BR',
        upstream.state.calls[0] ?? '')

      const unauthorized = await post('/tts', { text: 'oi', lang: 'pt-BR' }, 'wrong-secret-0000000000')
      check('密钥不对 → 401（不许把合成服务暴露给没密钥的人）', unauthorized.status === 401,
        String(unauthorized.status))

      const badLang = await post('/tts', { text: 'oi', lang: 'de-DE' })
      const badLangBody = await badLang.json()
      check('语言不认识 → 400 且说清支持哪三门',
        badLang.status === 400 && /pt-BR/.test(badLangBody.error ?? ''), JSON.stringify(badLangBody))

      const tooLong = await post('/tts', { text: 'x'.repeat(TTS_HTTP_LIMITS.maxChars + 5), lang: 'en-US' })
      check('超长 → 400（不是 500，也不是静静截断）', tooLong.status === 400, String(tooLong.status))

      // 上游挂了：手机要能分辨"这次没念成"，而不是等到超时
      upstream.state.mode = 'synth-failed'
      const failed = await post('/tts', { text: 'oi', lang: 'pt-BR' })
      const failedBody = await failed.json()
      check('上游合成报错 → 503 tts-unavailable（机器码，手机据此弹窗）',
        failed.status === 503 && failedBody.error === 'tts-unavailable', JSON.stringify(failedBody))

      // 上游根本没起：同样必须是 503（不是挂到超时、不是 500）
      await new Promise((resolve) => upstream.server.close(resolve))
      const down = await post('/tts', { text: 'oi', lang: 'pt-BR' })
      const downBody = await down.json()
      check('上游连不上 → 503 tts-unavailable 且带原因',
        down.status === 503 && downBody.error === 'tts-unavailable'
        && String(downBody.hint ?? '').length > 0, JSON.stringify(downBody))
    } finally {
      try { upstream.server.close() } catch { /* 已关 */ }
      await relay.close()
    }
  })

  await it('5.157：这台机器没配 TTS 时要说"没配"（不是超时）', async () => {
    const relay = await startRelay({
      dataDir: join(VAR_DIR, 'test', 'tts-http-nourl'), port: 0, host: '127.0.0.1',
      secret: SECRET, quiet: true, pollHoldMs: 300,
    })
    try {
      const response = await fetch(`http://127.0.0.1:${relay.port}/tts`, {
        method: 'POST',
        headers: { 'X-Leion-Secret': SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'oi', lang: 'pt-BR' }),
      })
      const body = await response.json()
      check('没有 --tts-url → 503 tts-unavailable，并说清怎么开',
        response.status === 503 && body.error === 'tts-unavailable'
        && /tts-server\.py|tts-url/.test(String(body.hint ?? '')), JSON.stringify(body))
    } finally {
      await relay.close()
    }
  })

  await it('5.157：手机侧路由规则（中文恒本地 / 葡英按开关 / 关掉全本地）', () => {
    const router = readFileSync(join(JAVA_DIR, 'TtsRouter.java'), 'utf-8')
    check('中文恒走本地（即使开了服务器）',
      /if \(code\.startsWith\("zh"\)\) return false;/.test(router))
    check('葡语/英语走服务器', /code\.startsWith\("pt"\) \|\| code\.startsWith\("en"\)/.test(router))
    check('关掉开关就全走本地', /public static boolean serverFor\(String lang, boolean useServer\) \{\s*\n\s*if \(!useServer\) return false;/.test(router))
    check('偏好键是公开常量（界面与合成器共用一个字符串）',
      /public static final String PREF_USE_SERVER = "ttsUseServer";/.test(router))

    const speaker = readFileSync(join(JAVA_DIR, 'TtsSpeaker.java'), 'utf-8')
    check('合成器按规则分流（不是写死一种后端）',
      /TtsRouter\.serverFor\(lang, wanted\)/.test(speaker))
    check('服务器那条路是 POST /tts 拿 wav',
      /"\/tts"/.test(speaker) && /audio\/wav|RIFF/.test(speaker) === false || /\/tts/.test(speaker))
    check('请求带密钥与 token（与其它接口同一套鉴权）',
      /setRequestProperty\("X-Leion-Secret", secret\)/.test(speaker)
      && /setRequestProperty\("X-Leion-Token", token\)/.test(speaker))
    check('服务器失败**不拿本地顶包**（否则用户以为服务器那条好了）',
      /InterpreterErrorCodes\.TTS_SERVER_FAILED/.test(speaker)
      && speaker.indexOf('synthesizeOnServer(') > 0)
    check('两条链路都还在（本地没被删）', /private File synthesize\(String chunk, String lang\)/.test(speaker))
    check('中文那条仍会先确认本机有语音包（缺包要报 tts-engine）',
      /ensureEngine\(lang\)/.test(speaker) && /TTS_ENGINE/.test(speaker))

    const room = readFileSync(join(JAVA_DIR, 'RoomActivity.java'), 'utf-8')
    check('服务器合成失败要弹窗（用户明确要求）',
      /TTS_SERVER_FAILED\.equals\(code\)/.test(room) && /AlertDialog\.Builder/.test(room))
    check('弹窗每场只弹一次（不然每句都弹）', /ttsServerWarned/.test(room))

    const me = readFileSync(join(JAVA_DIR, 'MeActivity.java'), 'utf-8')
    check('「我的」里有语音合成开关', /R\.id\.meTtsSwitch/.test(me) && /bindTtsEngine\(\)/.test(me))
    check('开关写的就是那个偏好键', /TtsRouter\.PREF_USE_SERVER/.test(me))

    for (const dir of ['values', 'values-en', 'values-pt-rBR']) {
      const xml = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', dir, 'strings.xml'), 'utf-8')
      check(`${dir} 有 err_tts_server_failed 与 me_tts_engine*`,
        /name="err_tts_server_failed"/.test(xml) && /name="me_tts_engine"/.test(xml)
        && /name="me_tts_engine_hint"/.test(xml))
    }
  })

  await it('5.157：bridge/tts-server.py 的纯函数自检能跑（不需要 piper）', () => {
    const script = join(ROOT, 'bridge', 'tts-server.py')
    const source = readFileSync(script, 'utf-8')
    check('脚本在', source.length > 5000, String(source.length))
    check('默认只绑本机（别把合成服务开到公网）', /default="127\.0\.0\.1"/.test(source))
    check('三门语言的默认音色都写了',
      /"zh-CN": "zh_CN-huayan-medium"/.test(source) && /"pt-BR": "pt_BR-faber-medium"/.test(source))
    check('只声明两个端点（healthz / tts）', /\/healthz/.test(source) && /"\/tts"/.test(source))

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
    const out = join(VAR_DIR, 'tmp', 'tts-server-selftest.txt')
    const fd = openSync(out, 'w')
    let failure = null
    try {
      execFileSync('python', [script, '--selftest'], { stdio: ['ignore', fd, fd] })
    } catch (error) {
      failure = error
    } finally {
      closeSync(fd)
    }
    if (failure !== null && failure.code === 'EPERM') {
      console.log('  ⏭ 这个沙箱不允许 Node 起子进程（python EPERM），跳过可执行用例。')
      return
    }
    const report = readFileSync(out, 'utf-8')
    check('纯函数自检全过', /passed=\d+ failed=0/.test(report), report.trim().slice(-200))
  })
}
