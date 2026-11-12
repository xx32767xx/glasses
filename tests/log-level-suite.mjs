/**
 * log-level-suite.mjs —— 日志档位"四个进程必须认得同一份名单"（5.182b）
 * ============================================================================
 * 真实事故（2026-11-12 生产）：`--log-level quiet` 加了 quiet 档，但只加在
 * relay / 切句 / 大脑上，**漏了 start-multi 自己那份校验** —— 于是服务启动即抛错，
 * systemd 的 restart counter 一路涨到 7。
 *
 * 这类错的特点是"改的时候谁也不会去搜另外三个文件"。所以这里把它钉死：
 * 名单以 `lib/log-levels.mjs` 为唯一来源，**python 那侧（不能 import JS）由本测试交叉核对**。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LOG_LEVEL, LOG_LEVELS, LOG_RANK, assertLogLevel, isLogLevel, levelAtLeast } from '../lib/log-levels.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

export async function runLogLevelSuite({ it, check }) {
  console.log('\n日志档位（5.182b）：四个进程共用一份名单，加一档不许漏')

  await it('5.182b：唯一名单 + 比较逻辑', async () => {
    check('四档且从安静到吵',
      JSON.stringify(LOG_LEVELS) === JSON.stringify(['quiet', 'summary', 'detail', 'trace']),
      JSON.stringify(LOG_LEVELS))
    check('缺省档是 summary', DEFAULT_LOG_LEVEL === 'summary', DEFAULT_LOG_LEVEL)
    check('等级单调递增', LOG_RANK.quiet < LOG_RANK.summary
      && LOG_RANK.summary < LOG_RANK.detail && LOG_RANK.detail < LOG_RANK.trace,
      JSON.stringify(LOG_RANK))
    check('quiet 下只放行 warn 级别（不打 summary 行）',
      levelAtLeast('quiet', 'summary') === false && levelAtLeast('quiet', 'warn') === true,
      `summary→${levelAtLeast('quiet', 'summary')} warn→${levelAtLeast('quiet', 'warn')}`)
    check('summary 下放行 summary、不放行 detail',
      levelAtLeast('summary', 'summary') === true && levelAtLeast('summary', 'detail') === false)
    check('认得出合法档位', isLogLevel('quiet') && isLogLevel('trace') && isLogLevel('nope') === false)
    check('不合法档位**抛错**（不静默退回缺省）', (() => {
      try {
        assertLogLevel('nope')
        return false
      } catch (error) {
        return /只能是/.test(String(error.message))
      }
    })())
  })

  await it('5.182b：start-multi / relay 都认这四档（生产那条命令不会再启动即崩）', async () => {
    const multi = await import('../scripts/start-multi.mjs')
    const relay = await import('../relay/lan-relay.mjs')
    // ⚠️ 5.181 的事故就是把 asr-worker / harness-side 漏了：
    //   start-multi 传 quiet → 识别进程不认 → 「识别进程退出了」→ 整条链路停摆。
    // 所以这四个**都得**在名单里，一个都不能少。
    const worker = await import('../bridge/asr-worker.mjs')
    const brain = await import('../scripts/harness-side.mjs')
    const parsers = [
      ['start-multi', (argv) => multi.parseArgs(argv)],
      ['relay', (argv) => relay.parseArgs(argv)],
      ['asr-worker', (argv) => worker.parseArgs(argv)],
      ['harness-side', (argv) => brain.parseArgs(argv)],
    ]
    for (const [name, parse] of parsers) {
      for (const level of LOG_LEVELS) {
        const base = name === 'asr-worker'
          ? ['--queue-dir', 'var/q', '--log-level', level]
          : ['--data-dir', 'var/x', '--log-level', level]
        check(`${name} 接受 --log-level ${level}`, parse(base).logLevel === level,
          JSON.stringify(parse(base)))
      }
    }
    for (const [, parser] of parsers) {
      check('写错的档位仍然要报错（不是照单全收）', (() => {
        try {
          parser(['--data-dir', 'var/x', '--log-level', 'silen'])
          return false
        } catch (error) {
          return /log-level/.test(String(error.message))
        }
      })())
    }
  })

  // 这条是本事故的"防复发"：不要在某个文件里手写一份档位名单。
  // 规则：除了 lib/log-levels.mjs（唯一来源）与测试自己，任何地方出现"三档数组"都算错。
  await it('5.182b：全仓库扫一遍 —— 不许再有手写的三档名单', async () => {
    const { readdirSync } = await import('node:fs')
    const { join: joinPath } = await import('node:path')
    const offenders = []
    const walk = (dir) => {
      let names = []
      try {
        names = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of names) {
        const full = joinPath(dir, entry.name)
        if (entry.isDirectory()) {
          if (['node_modules', 'var', '.git', '.venv'].includes(entry.name)) continue
          walk(full)
          continue
        }
        if (/.(mjs|py)$/.test(entry.name) !== true) continue
        // 唯一来源与测试自己除外
        const rel = full.replace(/\\/g, '/').split('/').join('/')
        if (rel.includes('/lib/log-levels.mjs') || rel.includes('/tests/log-level-suite.mjs')) continue
        let text2 = ''
        try {
          text2 = readFileSync(full, 'utf-8')
        } catch {
          continue
        }
        // ⚠️ 四档写法 `["quiet", "summary", "detail", "trace"]` 里也含三档那串，
        // 所以这里必须用否定后顾把"前面紧跟着 quiet"的排除掉。
        const staleTs = /(?<!quiet', )'summary', 'detail', 'trace'/.test(text2)
        const stalePy = /(?<!quiet", )"summary", "detail", "trace"/.test(text2)
        const staleMsg = text2.includes('只能是 summary / detail / trace')
        if (staleTs || stalePy || staleMsg) {
          offenders.push(rel)
        }
      }
    }
    walk(ROOT)
    check('没有文件还在用手写的三档名单（漏一处就等于生产上启动即崩）',
      offenders.length === 0, offenders.join(' | '))
  })

  await it('5.182b：python 与大脑那边的名单与 JS 这份一致（不能 import，只能对账）', async () => {
    const python = readFileSync(join(ROOT, 'bridge', 'whisper_stream.py'), 'utf-8')
    const brain = readFileSync(join(ROOT, 'plugin', 'core.mjs'), 'utf-8')
    const wantPython = '_LOG_RANK = {"quiet": 0, "summary": 1, "detail": 2, "trace": 3}'
    const wantBrain = 'const LOG_RANK = { quiet: 0, summary: 1, detail: 2, trace: 3 }'
    check('python 的 _LOG_RANK 与 JS 名单一致', python.includes(wantPython), wantPython)
    check('大脑的 LOG_RANK 与 JS 名单一致', brain.includes(wantBrain), wantBrain)
    check('python 的命令行 choices 含这四档',
      /choices=\["quiet", "summary", "detail", "trace"\]/.test(python), '缺 quiet 之类的一档')
    // 生产那条命令实际长这样：逐个文件确认没有"三档"的旧写法残留
    for (const [name, text] of [['relay', readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')],
      ['start-multi', readFileSync(join(ROOT, 'scripts', 'start-multi.mjs'), 'utf-8')]]) {
      check(`${name} 里没有"只能是 summary / detail / trace"的旧校验`,
        text.includes('只能是 summary / detail / trace') === false, '还留着三档校验')
    }
  })
}
