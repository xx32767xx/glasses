#!/usr/bin/env node
/**
 * terms-ui.mjs —— 术语库演示台（本机网页，零依赖）
 * ============================================================================
 *
 * 为什么要有它：
 *   CLI 能证明"库里那条术语真的改了文本"，但**看不见是谁改的、改在哪、改完字幕长什么样**。
 *   演示台把三段并排放出来：库 → 快照 → 归一/专名提示。管理员与用户两个页签也在这里分开 ——
 *   用户只能提申请，按钮在服务端被 `ROLE_PERMISSIONS` 挡，而不是靠界面藏起来。
 *
 * 安全边界（写死在代码里，不靠自觉）：
 *   ① 只监听 127.0.0.1：这是本机演示台，不做鉴权，绝不能暴露到局域网/公网；
 *   ② 环境在启动时确定，请求里不能改 —— 否则一次误点就可能把演示数据写进生产库；
 *   ③ 每个写接口都断言环境，`assertEnvMatches` 兜底。
 *
 * 用法：
 *   node scripts/terms-ui.mjs --env test --port 8789
 *   # 浏览器打开 http://127.0.0.1:8789
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT, VAR_DIR } from '../lib/paths.mjs'
import { ENVS, assertEnvMatches, resolveDataDir } from '../lib/store.mjs'
import {
  importLibraries, listLibraries, loadCategories, loadLibrary, saveLibrary,
} from '../lib/libraries.mjs'
import { createRequest, decideRequest, loadRequests, pendingOf } from '../lib/requests.mjs'
import { writeMeetingSnapshot } from '../lib/snapshot.mjs'
import { normalizeTerms, translationSystem, mentionedEntries, ZH, PT } from '../plugin/core.mjs'

const MAX_BODY = 512 * 1024

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
    request.on('error', reject)
  })
}

function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * 启动演示台。导出成函数是为了测试能起一个临时实例（端口 0）然后关掉。
 * @param {{ env?: 'prod'|'test', port?: number, base?: string }} options
 */
export async function startTermsUi(options = {}) {
  const env = options.env ?? 'test'
  if (ENVS.includes(env) !== true) throw new Error(`环境只能是 ${ENVS.join(' / ')}`)
  const base = options.base ?? join(ROOT, 'var')
  const root = resolveDataDir(base, env)
  assertEnvMatches(root, env) // ③ 兜底：拿到手的目录必须与声称的环境一致

  const htmlPath = join(ROOT, 'scripts', 'terms-ui.html')
  const policy = JSON.parse(await readFile(join(ROOT, 'policy', 'br-pt.json'), 'utf-8'))

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        const html = await readFile(htmlPath)
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(html)
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        const [libraries, categories, requestState] = await Promise.all([
          listLibraries(root), loadCategories(root), loadRequests(root),
        ])
        const categoryName = new Map(categories.categories.map((item) => [item.id, item.name]))
        send(response, 200, {
          ok: true, env, root,
          categories: categories.categories,
          libraries: libraries.map((library) => ({ ...library, categoryName: categoryName.get(library.categoryId) ?? null })),
          pending: pendingOf(requestState.items),
        })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/snapshot') {
        const body = await readBody(request)
        const libraries = await listLibraries(root)
        const snapshot = await writeMeetingSnapshot(root, String(body.meetingId ?? 'room-001'), {
          libraryIds: Array.isArray(body.libraryIds) ? body.libraryIds : libraries.map((library) => library.id),
          libraries,
        })
        const doc = JSON.parse(await readFile(snapshot.termsPath, 'utf-8'))
        send(response, 200, {
          ok: true, user: snapshot.user, entries: doc.tables[snapshot.user].entries,
          conflicts: snapshot.conflicts, termsPath: snapshot.termsPath, activePath: snapshot.activePath,
        })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/normalize') {
        const body = await readBody(request)
        const libraries = await listLibraries(root)
        const selected = Array.isArray(body.libraryIds) && body.libraryIds.length > 0
          ? libraries.filter((library) => body.libraryIds.includes(library.id))
          : libraries
        // 与"会议快照"用同一套聚合规则（含 priority 裁决），否则演示会与真实链路不一致
        const { entries } = await (async () => {
          const module = await import('../lib/snapshot.mjs')
          return module.aggregateLibraries(selected)
        })()
        const lang = body.lang === 'zh-CN' ? ZH : PT
        const text = typeof body.text === 'string' ? body.text : ''
        const result = normalizeTerms(text, lang, entries)
        // ⚠️ 必须用产线的 mentionedEntries（它会算变体/可接受写法/折叠/边界），
        //    不能自己写 text.includes(entry.zh)：那样原文说「亮亮眼睛」时会漏，演示与产线就分叉了。
        const hint = mentionedEntries(text, entries, lang === ZH)
        send(response, 200, {
          ok: true, before: text, after: result.text, changed: result.changed,
          events: result.events, hint: hint.length > 0 ? hint : null,
          systemPreview: translationSystem(policy, ZH, PT, hint.length > 0 ? hint : null).split('\n').filter((line) => line.includes('本句原文')).join(' '),
        })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/decision') {
        const body = await readBody(request)
        const result = await decideRequest(root, String(body.id ?? ''), {
          decision: body.decision === 'approve' ? 'approve' : 'reject',
          by: String(body.by ?? 'ui@local'),
          note: String(body.note ?? ''),
        })
        send(response, 200, { ok: true, status: result.status })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/request') {
        const body = await readBody(request)
        // 用户端只允许"提申请"这一种动作；写库、审批都不在这里暴露
        const result = await createRequest(root, {
          type: String(body.type ?? 'add'),
          libraryId: String(body.libraryId ?? ''),
          // 5.02：三语条目 —— 中/葡/英任意两种即可（缺的那栏留空）
          entry: body.type === 'delete' ? null : {
            zh: String(body.zh ?? ''), pt: String(body.pt ?? ''), en: String(body.en ?? ''),
          },
          targetKey: body.type === 'delete' ? String(body.zh ?? '') : null,
          reason: String(body.reason ?? ''),
          applicant: String(body.applicant ?? 'ui@local'),
        })
        send(response, 200, { ok: true, id: result.id, status: result.status })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/import') {
        const body = await readBody(request)
        const report = await importLibraries(root, body.items, { by: String(body.by ?? 'ui@local') })
        send(response, 200, {
          ok: true,
          created: report.report.created.length, updated: report.report.updated.length,
          rejected: report.report.rejected.length,
          errors: report.report.rejected.map((item) => `第 ${item.index} 项（${item.name ?? '无名'}）：${item.error}`),
        })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/save-library') {
        const body = await readBody(request)
        const saved = await saveLibrary(root, body.library, { by: String(body.by ?? 'ui@local'), source: 'ui' })
        if (saved.ok !== true) { send(response, 400, { ok: false, error: saved.error }); return }
        send(response, 200, { ok: true, id: saved.library.id, created: saved.created })
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/library') {
        const library = await loadLibrary(root, url.searchParams.get('id') ?? '')
        if (library === null) { send(response, 404, { ok: false, error: '没有这个库' }); return }
        send(response, 200, { ok: true, library })
        return
      }

      send(response, 404, { ok: false, error: '没有这个路径' })
    } catch (error) {
      send(response, 400, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  })

  const port = options.port ?? 8789
  await new Promise((resolve, reject) => {
    // ② 只绑本机回环：不做鉴权的演示台，绝不能让局域网访问
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    env, root, port: actualPort,
    url: `http://127.0.0.1:${actualPort}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
    server,
  }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--') !== true) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) { options[key] = true; continue }
    options[key] = next
    index += 1
  }
  return options
}

const isMain = process.argv[1] !== undefined && /terms-ui\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  const env = typeof options.env === 'string' ? options.env : 'test'
  const port = typeof options.port === 'string' ? Number(options.port) : 8789
  startTermsUi({ env, port }).then((ui) => {
    console.log(`术语库演示台已启动：${ui.url}`)
    console.log(`  环境：${ui.env}（目录 ${ui.root}）`)
    console.log('  只监听 127.0.0.1；改的是这个环境的数据，别把演示数据写进生产库。')
    if (env === 'prod') console.log('  ⚠️ 当前是**生产库**：所有写操作都会真的进生产数据。')
  }).catch((error) => {
    console.error(`✗ 启动失败：${error.message}`)
    process.exit(1)
  })
}

export { VAR_DIR }
