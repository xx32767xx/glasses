/**
 * org-api.mjs —— 术语库 / 会议选库 / 申请审批的 HTTP 接口层（纯函数）
 * ============================================================================
 *
 * 为什么写成纯函数而不直接塞进 relay：
 *   ① 权限判断必须能被**逐条测**（用户调管理员接口要 403），而塞进 relay 就只能在
 *      "起一个服务器再发请求"里测，慢且容易漏；
 *   ② 以后房间服务要复用同一批接口（同一套语义），不该被 relay 的启动方式绑死；
 *   ③ relay 只负责"把 token 解成 user + role，然后调这里"，职责边界清楚。
 *
 * 权限一律查 `ROLE_PERMISSIONS`（lib/accounts.mjs），**不在各处写 if (role === 'admin')**：
 * 界面隐藏按钮只是体验，真正的门在这里。
 *
 * 路径（都由 relay 转进来，relay 负责鉴权前解析 token）：
 *   GET  /org/asr/engines?lang=en-US        这一场可选的识别引擎（5.58，只读清单）
 *   GET  /org/libraries                     列出可见库
 *   GET  /org/libraries/<id>                单个库详情
 *   GET  /org/meeting/<id>/libraries        这一场选了哪些库
 *   PUT  /org/meeting/<id>/libraries        设置这一场选哪些库
 *   POST /org/meeting/<id>/snapshot         冻结快照（返回条目数与冲突）
 *   POST /org/requests                      提交申请
 *   GET  /org/requests/mine                 我的申请
 *   GET  /org/requests/pending              待审列表（管理员）
 *   POST /org/requests/<id>/decide          审批（管理员）
 */

import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { DEV_TTL_DAYS, allowed, createAccountWithPassword, listAccounts, loadAccounts, renewAccount, saveAccounts, setStatusByUsername, updateAccounts } from '../lib/accounts.mjs'
import { readJson, writeJsonAtomic } from '../lib/store.mjs'
import { listLibraries, loadLibrary, loadCategories, saveLibrary, importLibraries } from '../lib/libraries.mjs'
import { createRequest, decideRequest, hideRequest, loadRequests, pendingOf, visibleOfMine, withdrawRequest } from '../lib/requests.mjs'
import { writeMeetingSnapshot } from '../lib/snapshot.mjs'
import { closeRoomByAdmin, createInterpreterSession, createRoom, hideHistoryForUser, isRoomClosed, joinRoom, leaveRoom, listHistory, listHistoryForAdmin, listMembers, listRoomTranscript, listRooms, purgeHistory, removeMember, roomByCode, roomById, roomLibraries, setRoomLibraries } from '../lib/rooms.mjs'
import { FLOOR_LOCKED_LEASE_MS, FLOOR_LEASE_MS, floorState, forceReleaseFloor, heartbeatFloor, releaseFloor, setFloorLock, sweepExpiredFloor, takeFloor } from '../lib/floor.mjs'
import { publishMeetingTerms } from '../lib/meeting-terms.mjs'
import { appendUtterance } from '../lib/db.mjs'
import { ENGINE_LANGUAGES, listEngineOptions, loadStrategyTable } from '../lib/asr-engines.mjs'

/** 允许出现在"模型名"里的字符：尺寸名（large-v3）或本地目录路径都能表达，但不含空格/引号。 */
const ASR_MODEL_NAME = /^[A-Za-z0-9._/-]{1,120}$/

/** 允许出现在"引擎名"里的字符（5.58：手机可以指定 whisper 之外的引擎家族）。 */
const ASR_ENGINE_NAME = /^[a-z0-9_-]{1,32}$/

/**
 * 把手机上报的「哪门语言用哪个模型/引擎」落成房间侧车（5.40 / 5.58）。
 *
 * <p>侧车放在 `<数据目录>/asr-profiles/<房间>.json`，识别进程按 mtime 热读，
 * 所以**改完立刻生效**，而且只影响这一场 —— 这正是"拿着手机 A/B 换模型"要的性质。
 *
 * <p>四条刻意的克制：
 * <ul>
 *   <li>只接受 `zh-CN / pt-BR / en-US` 这几个语种标签，别的一律忽略并记录下来；</li>
 *   <li>模型名字符集收紧（{@link ASR_MODEL_NAME}）——它最终会被当成"模型尺寸名或目录"用；</li>
 *   <li>引擎名只能是 `[a-z0-9_-]`（{@link ASR_ENGINE_NAME}）——它会被当成注册表键用；</li>
 *   <li>写失败**不拦开会话**：侧车只是"希望用什么"，识别进程读不到就按服务器模型表走。
 *       但返回值里要说清收到了什么，让手机能把"服务器实际收到的请求"显示出来。</li>
 * </ul>
 *
 * <p>`byLang[lang]` 里可以只有 `model`、只有 `engine`，或两者都有：
 * Python 侧按"房间覆盖"**逐字段**叠加，没写的字段继续继承表里那一层。
 *
 * @returns {{applied: Object<string,{model?: string, engine?: string}>, ignored: string[], error?: string}}
 */
export function writeAsrProfileSidecar(root, roomId, requested, engines = null, now = Date.now()) {
  const ignored = []
  if (requested !== undefined && requested !== null
    && (typeof requested !== 'object' || Array.isArray(requested))) {
    return { applied: {}, ignored, error: 'asrModels 必须是一个对象：{ "en-US": "large-v3" }' }
  }
  const engineOf = engines && typeof engines === 'object' && !Array.isArray(engines) ? engines : {}
  const byLang = {}
  for (const [rawLang, rawModel] of Object.entries(requested ?? {})) {
    const lang = String(rawLang).trim()
    const model = String(rawModel ?? '').trim()
    if (!['zh-CN', 'pt-BR', 'en-US'].includes(lang) || model === '') continue
    if (!ASR_MODEL_NAME.test(model)) {
      ignored.push(`${lang}=${model}`)
      continue
    }
    byLang[lang] = { model }
  }
  for (const [rawLang, rawEngine] of Object.entries(engineOf)) {
    const lang = String(rawLang).trim()
    const engine = String(rawEngine ?? '').trim().toLowerCase()
    if (!['zh-CN', 'pt-BR', 'en-US'].includes(lang) || engine === '') continue
    if (!ASR_ENGINE_NAME.test(engine)) {
      ignored.push(`${lang}@${engine}`)
      continue
    }
    byLang[lang] = { ...(byLang[lang] ?? {}), engine }
  }
  const applied = Object.fromEntries(Object.entries(byLang))
  if (Object.keys(applied).length === 0) return { applied, ignored }
  try {
    const dir = join(root, 'asr-profiles')
    mkdirSync(dir, { recursive: true })
    // 侧车结构：byLang（识别进程读这个）+ 谁在什么时候要求的（排障用）
    writeFileSync(join(dir, `${String(roomId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`),
      JSON.stringify({ roomId, byLang, at: now }, null, 2),
      'utf-8')
    return { applied, ignored }
  } catch (error) {
    return { applied: {}, ignored, error: String(error?.message ?? error) }
  }
}

export function selectionPath(root, meetingId) {
  // 会议 id 会被拼进路径，所以只允许安全字符（防目录穿越）
  const safe = String(meetingId).replace(/[^A-Za-z0-9_-]/g, '')
  if (safe === '' || safe !== String(meetingId)) {
    throw new Error('会议 id 只能包含字母、数字、下划线、连字符')
  }
  return join(root, 'meetings', safe, 'selection.json')
}

export async function loadSelection(root, meetingId) {
  const doc = await readJson(selectionPath(root, meetingId), null)
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { meetingId, libraryIds: [], selectedBy: null, updatedAt: null }
  }
  return {
    meetingId,
    libraryIds: Array.isArray(doc.libraryIds) ? doc.libraryIds : [],
    selectedBy: doc.selectedBy ?? null,
    updatedAt: doc.updatedAt ?? null,
  }
}

function bad(status, error) {
  if (error === undefined || error === null || error === '') error = `HTTP ${status}（服务端没有给出原因，看 relay 日志）`
  return { status, json: { ok: false, error } }
}

function deny(role, action) {
  // 除了给人看的中文原话，再给一组机器读的字段：客户端要能说清"哪个角色不能做什么"。
  // 只丢一句"没有权限"的话，用户和我们都没法判断是账号问题还是代码问题（4.63 踩过）。
  return {
    status: 403,
    json: {
      ok: false,
      error: `当前角色（${role ?? '未登录'}）不能做 ${action}`,
      code: 'forbidden',
      role: role ?? '',
      action,
    },
  }
}

/**
 * 处理一次请求。
 * @param {{ method: string, path: string, body?: object, user: string|null, role: string|null,
 *           root: string, now?: string }} input
 * @returns {Promise<{ status: number, json: object }>}
 */
export async function handleOrg(input) {
  const { method, root, user, role } = input
  const now = input.now ?? new Date().toISOString()
  const body = input.body ?? {}
  const path = String(input.path ?? '')
  // 路径上可能带 query（如 /org/history?limit=20）：切段之前先剔掉，否则它会变成一个路径段
  const segments = path.split('?')[0].split('/').filter(Boolean).map((item) => decodeURIComponent(item))

  if (user === null || user === undefined) return bad(401, '需要登录（缺少有效 token）')

  // ── 识别引擎清单（5.58：手机在 App 里选"这一场用哪个模型"）─────────────────
  //
  // 只读、只做展示：权威仍在 Python 侧。手机选中之后会把 engine+model **显式写进房间侧车**，
  // 而侧车在 Python 那边的优先级最高，所以"手机选的"一定压过"表里算出来的"。
  // 这一点很关键：清单算错顶多让某个选项名字不对，不会让识别悄悄跑成另一个模型。
  if (method === 'GET' && segments[0] === 'org' && segments[1] === 'asr'
    && segments[2] === 'engines') {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    const query = new URLSearchParams(String(input.path ?? '').split('?')[1] ?? '')
    const lang = (query.get('lang') ?? '').trim() || 'en-US'
    if (!ENGINE_LANGUAGES.includes(lang)) {
      return bad(400, `lang 只能是 ${ENGINE_LANGUAGES.join(' / ')}`)
    }
    const loaded = loadStrategyTable(root)
    const listed = listEngineOptions(loaded.table, lang)
    return {
      status: 200,
      json: {
        ok: true,
        lang: listed.lang,
        tableFound: listed.tableFound,
        tablePath: loaded.path,
        // 表写坏了要说出来（热改表写错逗号是常见手误），但**不拦**：列不出来就退化成一条"服务器默认"
        tableProblem: loaded.problem,
        current: listed.current,
        options: listed.options,
        // 因为 `langs` 不匹配而被跳过的策略名（纯英文模型出现在中文栏那种事，
        // 要能解释"为什么没看到"，而不是让人以为服务器没配）
        skippedByLang: listed.skippedByLang ?? [],
      },
    }
  }

  // ── 库列表 / 详情 ────────────────────────────────────────────────────────
  if (method === 'GET' && segments[0] === 'org' && segments[1] === 'libraries' && segments.length === 2) {
    if (allowed(role, 'library.read') !== true) return deny(role, 'library.read')
    const [libraries, categories] = await Promise.all([listLibraries(root), loadCategories(root)])
    const categoryName = new Map(categories.categories.map((item) => [item.id, item.name]))
    return {
      status: 200,
      json: {
        ok: true,
        libraries: libraries.map((library) => ({
          id: library.id, name: library.name, categoryId: library.categoryId ?? '',
          // 分类可能没有：这里统一给**空串**而不是 null。
          // 客户端（Android 的 optString）遇到 JSON null 会返回字符串 "null"，
          // 于是界面上出现"null · 8 条"——与其每个客户端各修一次，不如服务端不给 null。
          categoryName: categoryName.get(library.categoryId) ?? '',
          priority: library.priority, visibility: library.visibility,
          entries: (library.entries ?? []).length, updatedAt: library.updatedAt,
        })),
      },
    }
  }

  if (method === 'GET' && segments[1] === 'libraries' && segments.length === 3) {
    if (allowed(role, 'library.read') !== true) return deny(role, 'library.read')
    const library = await loadLibrary(root, segments[2])
    if (library === null) return bad(404, '没有这个库')
    return { status: 200, json: { ok: true, library } }
  }

  // ── 会议选库 ─────────────────────────────────────────────────────────────
  if (segments[1] === 'meeting' && segments[3] === 'libraries' && segments.length === 4) {
    const meetingId = segments[2]
    if (method === 'GET') {
      if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
      const selection = await loadSelection(root, meetingId)
      const libraries = await listLibraries(root)
      const picked = libraries.filter((library) => selection.libraryIds.includes(library.id))
      return {
        status: 200,
        json: {
          ok: true, ...selection,
          entries: picked.reduce((sum, library) => sum + (library.entries ?? []).length, 0),
        },
      }
    }
    if (method === 'PUT') {
      if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
      const wanted = Array.isArray(body.libraryIds) ? body.libraryIds.map((item) => String(item)) : null
      if (wanted === null) return bad(400, 'libraryIds 必须是数组（可以为空数组）')
      const libraries = await listLibraries(root)
      const unknown = wanted.filter((id) => libraries.every((library) => library.id !== id))
      if (unknown.length > 0) return bad(400, `有库不存在：${unknown.join(', ')}`)
      const doc = { meetingId, libraryIds: wanted, selectedBy: user, updatedAt: now }
      await writeJsonAtomic(selectionPath(root, meetingId), doc)
      return { status: 200, json: { ok: true, ...doc } }
    }
  }

  // ── 冻结快照 ─────────────────────────────────────────────────────────────
  if (method === 'POST' && segments[1] === 'meeting' && segments[3] === 'snapshot' && segments.length === 4) {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    const meetingId = segments[2]
    const selection = await loadSelection(root, meetingId)
    const libraryIds = Array.isArray(body.libraryIds) ? body.libraryIds.map(String) : selection.libraryIds
    const libraries = await listLibraries(root)
    const snapshot = await writeMeetingSnapshot(root, meetingId, { libraryIds, libraries, now })
    return {
      status: 200,
      json: {
        ok: true, meetingId, user: snapshot.user, entries: snapshot.entries,
        conflicts: snapshot.conflicts, termsPath: snapshot.termsPath, activePath: snapshot.activePath,
      },
    }
  }

  // ── 申请 ─────────────────────────────────────────────────────────────────
  // 一场会议的转写全文（4.72）：只给参伎者
  if (method === 'GET' && segments[1] === 'history' && segments[3] === 'transcript' && segments.length === 4) {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    const transcript = listRoomTranscript(root, { roomId: segments[2], user })
    if (transcript.ok !== true) return bad(403, transcript.error)
    return { status: 200, json: { ok: true, roomId: transcript.roomId, lines: transcript.lines } }
  }

  // 按账号删除一条历史（4.71）：只影响自己的列表，会议与字幕不动
  if (method === 'POST' && segments[1] === 'history' && segments[3] === 'delete' && segments.length === 4) {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    const hidden = hideHistoryForUser(root, { user, roomId: segments[2], now })
    if (hidden.ok !== true) return bad(400, hidden.error)
    return { status: 200, json: { ok: true, roomId: hidden.roomId } }
  }

  // ── 同传翻译官会话（5.35）─────────────────────────────────────────────────
  //
  // 与会议**同表同结构**，只靠 `rooms.kind = 'interpreter'` 区分（见 lib/db.mjs）。
  // 所以：开一场会话 = 建一条 rooms 行 + 一条成员行；写字幕 = 往 utterances 写；
  // 读转写/删历史/保留期清理**全部复用会议那套端点**，不新增显示代码。
  //
  // 为什么由手机上报每一句，而不是像会议那样由 relay 从总线抓：
  // 翻译官没有房间、没有总线、也没有那台跑 whisper 的管线 —— 文本在手机手上，
  // 它不报就没别人知道了。上报是**幂等追加**，重复不会造出两句。
  if (method === 'POST' && segments[1] === 'interpreter' && segments[2] === 'start') {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    const created = createInterpreterSession(root, {
      host: user,
      name: String(body.name ?? ''),
      lang: String(body.lang ?? ''),
      targetLang: String(body.targetLang ?? ''),
      mode: String(body.mode ?? ''),
      now,
    })
    if (created.ok !== true) return bad(400, created.error)
    // 5.40：手机可以在开会话时**指定某几门语言用哪个模型**（它自己那张 asr-routes.json 里写的）。
    // 落成房间里的一份侧车，识别进程按"房间覆盖 > 服务器模型表 > default"的顺序读它 ——
    // 这样"改 App 里的表 → 只影响这一场"和"改服务器上的表 → 影响全部"两种实验方式都能用。
    //
    // ⚠️ 只接受**语种标签 + 模型名**，模型名字符集收紧（写坏了只会在识别那边报"加载失败"，
    // 不会变成改文件路径之类的意外）。写不进去也**不拦开会话**：识别不上就不写侧车。
    const requested = writeAsrProfileSidecar(root, created.session.id, body.asrModels,
      body.asrEngines)
    return {
      status: 200,
      json: { ok: true, session: created.session, asrModels: requested },
    }
  }
  if (method === 'POST' && segments[1] === 'interpreter' && segments[3] === 'utterance'
    && segments.length === 5) {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    const sessionId = segments[2]
    const session = roomById(root, sessionId)
    if (session === null) return bad(404, '没有这场会话')
    if (session.kind !== 'interpreter') return bad(400, '这不是同传翻译官的会话')
    const saved = appendUtterance(root, {
      roomId: sessionId,
      username: user,
      srcLang: String(body.srcLang ?? ''),
      dstLang: String(body.dstLang ?? ''),
      srcText: String(body.srcText ?? ''),
      dstText: String(body.dstText ?? ''),
      startAt: Number.isFinite(Number(body.at)) ? Number(body.at) : now,
      isFinal: true,
    })
    if (saved.ok !== true) return bad(400, saved.error)
    return { status: 200, json: { ok: true, id: saved.id, merged: saved.merged === true } }
  }
  if (method === 'POST' && segments[1] === 'interpreter' && segments[3] === 'end'
    && segments.length === 4) {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    const closed = closeRoomByAdmin(root, { roomId: segments[2], by: user, now })
    if (closed.ok !== true) return bad(404, closed.error ?? '没有这场会话')
    return { status: 200, json: { ok: true, sessionId: segments[2] } }
  }

  // 历史记录（4.69）：我参加过的会议 + 字幕保存期（客户端顶部要写“记录保存 N 天”）。
  // ⚠️ 4.99：管理员那两条（/org/history/admin…）必须排在**这条之前** —— 否则
  // `/org/history/admin` 会被这条宽匹配接走（它只要求 meeting.configure，测试账号也能读），
  // 表现是"非管理员居然读到了整机清单"。测试里专门钉了这一点。
  if (method === 'GET' && segments[0] === 'org' && segments[1] === 'history' && segments[2] !== 'admin') {
    if (allowed(role, 'meeting.configure') !== true) return deny(role, 'meeting.configure')
    // handleOrg 拿到的是**路径串**（不是 URL 对象）：query 自己切，不能写 url.searchParams
    const queryAt = path.indexOf('?')
    const query = queryAt >= 0 ? new URLSearchParams(path.slice(queryAt + 1)) : new URLSearchParams()
    const limit = Number(query.get('limit') ?? 0) || 50
    const history = listHistory(root, { user, limit, now })
    return {
      status: 200,
      json: {
        ok: true,
        items: history.items,
        total: history.total,
        // 保留期由服务端定（start-all / relay 的 --utterance-retention-days），客户端不自己编一个
        // 保留期由服务端定（relay 的 --utterance-retention-days）；客户端不自己编一个
        retentionDays: Number(input.utteranceRetentionDays ?? 7),
      },
    }
  }

  // ── 4.99 管理员：会议历史数据的清单与清理 ────────────────────────────────
  //
  // 为什么需要：会议一多，`utterances` 表与 `audio/` 目录会一直长；测试环境的数据
  // 本来也没有保留价值。但"删哪些"必须**看得见**才敢删 —— 所以先给清单（每场会的
  // 转写条数、时间跨度、音频大小），再给三种清理范围，全部进管理员页。
  if (method === 'GET' && segments[1] === 'history' && segments[2] === 'admin') {
    if (allowed(role, 'history.purge') !== true) return deny(role, 'history.purge')
    const inventory = listHistoryForAdmin(root, { limit: 500 })
    // 音频体积按文件算（relay 的 roomAudioPath 是唯一规则，这里不重复拼路径）
    const items = inventory.items.map((one) => {
      let audioBytes = 0
      try {
        audioBytes = Number(input.audioBytesOf?.(one.id) ?? 0)
      } catch { audioBytes = 0 }
      return { ...one, audioBytes }
    })
    const totalAudioBytes = items.reduce((sum, one) => sum + one.audioBytes, 0)
    return {
      status: 200,
      json: {
        ok: true,
        items,
        totals: {
          ...inventory.totals,
          audioBytes: totalAudioBytes,
          // 整目录的音频（含已经结束、已经不在清单里的会议）
          audioDirBytes: Number(input.audioDirBytes?.() ?? 0),
        },
        retentionDays: Number(input.utteranceRetentionDays ?? 7),
      },
    }
  }

  if (method === 'POST' && segments[1] === 'history' && segments[3] === 'purge' && segments.length === 4) {
    if (allowed(role, 'history.purge') !== true) return deny(role, 'history.purge')
    const mode = String(body.mode ?? 'older-than')
    const result = purgeHistory(root, {
      mode,
      days: Number(body.days ?? 7),
      roomIds: Array.isArray(body.roomIds) ? body.roomIds : [],
      now,
    })
    if (result.ok !== true) return bad(400, result.error ?? '清理失败')
    // 文件（音频 / 字幕总线 / 收件箱）由 relay 那边删 —— 它才有那几个路径的规则
    let freedBytes = 0
    if (typeof input.purgeHistoryFiles === 'function') {
      try {
        freedBytes = Number(input.purgeHistoryFiles(result.roomIds) ?? 0)
      } catch (error) {
        // 数据库已清、文件没删干净只是占点空间 —— 不能因此给管理员报错
        // （他会以为"没删成功"反复点，每次都失败）。留一行日志即可。
        if (typeof input.debug === 'function') {
          input.debug(`清理文件失败（数据库已清）：${String(error?.message ?? error)}`)
        }
      }
    }
    return {
      status: 200,
      json: {
        ok: true,
        mode,
        deletedRooms: result.deletedRooms,
        deletedUtterances: result.deletedUtterances,
        freedBytes,
        skipped: result.skipped ?? [],
      },
    }
  }

  if (method === 'POST' && segments[1] === 'requests' && segments.length === 2) {
    if (allowed(role, 'request.create') !== true) return deny(role, 'request.create')
    const created = await createRequest(root, {
      type: body.type,
      libraryId: body.libraryId,
      // 5.02：三语术语 —— 中/葡/英任意两种即可（缺的那一栏留空，不假装有等价关系）。
      // 合法性由 lib/requests.mjs → validateTerms 统一判，这里只做转发。
      entry: body.type === 'delete' ? null : { zh: body.zh, pt: body.pt, en: body.en },
      targetKey: body.type === 'delete' ? body.zh : null,
      reason: body.reason,
      applicant: user, // ⚠️ 申请人是**服务端从 token 解出来的**，不信请求体里的 applicant
    }, { now })
    if (created.ok !== true) return bad(400, created.error)
    return { status: 200, json: { ok: true, id: created.id, status: created.status } }
  }

  if (method === 'GET' && segments[1] === 'requests' && segments[2] === 'mine') {
    const { items } = await loadRequests(root)
    // 4.64：自己删掉（hidden）的不再回到列表里
    const mine = visibleOfMine(items, user)
    return { status: 200, json: { ok: true, requests: mine } }
  }

  if (method === 'GET' && segments[1] === 'requests' && segments[2] === 'pending') {
    if (allowed(role, 'request.decide') !== true) return deny(role, 'request.decide')
    const { items, badLines } = await loadRequests(root)
    return { status: 200, json: { ok: true, requests: pendingOf(items), badLines } }
  }

  if (method === 'POST' && segments[1] === 'requests' && segments[3] === 'decide' && segments.length === 4) {
    if (allowed(role, 'request.decide') !== true) return deny(role, 'request.decide')
    const decided = await decideRequest(root, segments[2], {
      decision: body.decision === 'approve' ? 'approve' : 'reject',
      by: user, // 审批人同样来自 token
      note: typeof body.note === 'string' ? body.note : '',
      now,
    })
    if (decided.ok !== true) return bad(400, decided.error)
    return {
      status: 200,
      json: { ok: true, id: decided.id, status: decided.status,
        entries: decided.library ? decided.library.entries.length : null },
    }
  }

  // 4.64：把自己**已经有结论**的申请从列表里删掉（待审批的必须先撤回）
  if (method === 'POST' && segments[1] === 'requests' && segments[3] === 'delete' && segments.length === 4) {
    if (allowed(role, 'request.create') !== true) return deny(role, 'request.create')
    const hidden = await hideRequest(root, segments[2], { applicant: user, now })
    if (hidden.ok !== true) return bad(400, hidden.error)
    return { status: 200, json: { ok: true, id: hidden.id, status: hidden.status } }
  }

  if (method === 'POST' && segments[1] === 'requests' && segments[3] === 'withdraw' && segments.length === 4) {
    const withdrawn = await withdrawRequest(root, segments[2], { applicant: user, now })
    if (withdrawn.ok !== true) return bad(400, withdrawn.error)
    return { status: 200, json: { ok: true, id: withdrawn.id, status: withdrawn.status } }
  }

  // ── 管理员：直接改库 / 批量导入（界面上只在管理端出现，但门在服务端）────────
  if (method === 'PUT' && segments[1] === 'libraries' && segments.length === 3) {
    if (allowed(role, 'library.write') !== true) return deny(role, 'library.write')
    const saved = await saveLibrary(root, { ...body.library, id: segments[2] }, { by: user, now, source: 'api' })
    if (saved.ok !== true) return bad(400, saved.error)
    return { status: 200, json: { ok: true, id: saved.library.id, created: saved.created, entries: saved.library.entries.length } }
  }

  if (method === 'POST' && segments[1] === 'libraries' && segments[2] === 'import' && segments.length === 3) {
    if (allowed(role, 'library.write') !== true) return deny(role, 'library.write')
    const report = await importLibraries(root, body.items, { by: user, now })
    return {
      status: 200,
      json: {
        ok: true,
        created: report.report.created.length, updated: report.report.updated.length,
        rejected: report.report.rejected,
      },
    }
  }

  // ── 管理员：账号管理（docs/19：管理员可手动添加测试账号）───────────────────
  if (segments[1] === 'accounts' && segments.length === 2) {
    if (allowed(role, 'account.manage') !== true) return deny(role, 'account.manage')
    if (method === 'GET') {
      const doc = await loadAccounts(root)
      return { status: 200, json: { ok: true, accounts: listAccounts(doc) } }
    }
    if (method === 'POST') {
      // 5.21：读-改-写走串行队列（与手机端注册共用同一条队列），否则管理台建号
      // 与手机注册同时发生时，后写的整表重写会抹掉先写的那个账号。
      let created
      try {
        created = await updateAccounts(root, (doc) => createAccountWithPassword(doc, {
          username: body.username, password: body.password,
          email: body.email, role: body.role === undefined ? 'dev' : body.role,
          note: body.note, expiresInDays: body.expiresInDays,
        }))
      } catch (error) {
        return bad(409, String(error?.message ?? error))
      }
      if (created.ok !== true) return bad(400, created.error)
      return {
        status: 200,
        json: { ok: true, username: String(body.username), role: created.role },
      }
    }
  }

  // ── 管理员：账号的停用 / 恢复 / 续期（docs/19：测试账号默认 7 天过期）─────────
  // 路径形如 POST /org/accounts/<用户名>/status  {status}
  //          POST /org/accounts/<用户名>/renew   {days}
  // 按**用户名**而不是邮箱：管理员手动建的测试账号只有用户名+密码。
  if (segments[1] === 'accounts' && segments.length === 4 && method === 'POST') {
    if (allowed(role, 'account.manage') !== true) return deny(role, 'account.manage')
    const username = decodeURIComponent(segments[2])

    if (segments[3] === 'status') {
      const status = String(body.status ?? '')
      // 5.21：串行（同一份队列），别把它和别的账号写操作交错
      const result = await updateAccounts(root, (doc) => setStatusByUsername(doc, username, status))
      if (result.ok !== true) return bad(400, result.error)
      return { status: 200, json: { ok: true, username: result.username, status: result.status } }
    }

    if (segments[3] === 'renew') {
      const days = body.days === undefined ? DEV_TTL_DAYS : Number(body.days)
      const result = await updateAccounts(root, (doc) => renewAccount(doc, username, days))
      if (result.ok !== true) return bad(400, result.error)
      return { status: 200, json: { ok: true, username, expiresAt: result.expiresAt } }
    }

    return bad(404, `没有这个接口：${method} ${path}`)
  }

  // ── 房间（P2a）：建房 / 6 位邀请码加入 / 房间术语库（冻结快照）─────────────
  if (segments[1] === 'rooms' && segments.length === 2) {
    if (method === 'GET') {
      // 5.15：列表里也带"这一场有没有在翻译"（管理台要看"运行中的会议"）
      const pipelineOf = typeof input.pipelineOf === 'function' ? input.pipelineOf : () => null
      return {
        status: 200,
        json: { ok: true, rooms: listRooms(root).map((room) => ({ ...room, pipeline: pipelineOf(room.id) })) },
      }
    }
    if (method === 'POST') {
      const name = String(body.name ?? '').trim()
      if (name === '') return bad(400, '房间名不能为空')
      // 5.00：建房时可以指定**目标语言**（中/英/葡任意两种互译 —— 三种语言时"译成哪种"必须显式）。
    const targetLang = String(body.targetLang ?? '').trim()
    if (targetLang !== '' && !['zh-CN', 'pt-BR', 'en-US'].includes(targetLang)) {
      return bad(400, `targetLang 只能是 zh-CN / pt-BR / en-US 或省略，收到 ${JSON.stringify(targetLang)}`)
    }
      const created = createRoom(root, { name, host: user, targetLang, now })
      if (created.ok !== true) return bad(400, created.error)
      // 5.04：建房者的「参会方式」也一起记下（面对面 / 远程）；不合法就当没说
      joinRoom(root, { room: created.room, username: user, lang: body.lang, mode: body.mode,
        hearLangs: body.hearLangs, now })
      return { status: 200, json: { ok: true, room: created.room } }
    }
    return bad(405, '只支持 POST')
  }

  if (method === 'POST' && segments[1] === 'rooms' && segments[2] === 'join' && segments.length === 3) {
    const joined = joinRoom(root, { code: body.code, username: user, lang: body.lang,
      mode: body.mode, hearLangs: body.hearLangs, now })
    if (joined.ok !== true) return bad(400, joined.error)
    return { status: 200, json: { ok: true, room: joined.room, members: joined.members } }
  }

  if (method === 'POST' && segments[1] === 'rooms' && segments[2] === 'leave' && segments.length === 3) {
    const left = leaveRoom(root, { code: body.code ?? null, roomId: body.roomId ?? null, username: user, now })
    if (left.ok !== true) return bad(400, left.error)
    // 发起者退出 = 整场结束（原型规则）；其他人退出只是离开
    return { status: 200, json: { ok: true, closed: left.closed, roomId: left.roomId, members: left.members } }
  }


  // ── 成员管理：移出成员（发起者，或管理员 —— 5.16）────────────────────
  if (method === 'POST' && segments[1] === 'rooms' && segments[3] === 'members'
      && segments[4] === 'remove' && segments.length === 5) {
    const rawMember = decodeURIComponent(segments[2])
    const roomMember = roomById(root, rawMember) ?? roomByCode(root, rawMember)
    if (roomMember === null) return bad(404, `room not found: ${rawMember}`)
    // 发起者本人当然可以移出；管理员也可以（管理台的「踢人」）。两者都不满足就 403。
    const byAdmin = allowed(role, 'room.manage') === true
    if (byAdmin !== true && String(roomMember.host) !== user) {
      return deny(role, 'room.manage')
    }
    const removed = removeMember(root, { roomId: roomMember.id, username: String(body.user ?? ''), by: user, now, byAdmin })
    if (removed.ok !== true) return bad(409, removed.error)
    return {
      status: 200,
      json: { ok: true, members: removed.members, releasedFloor: removed.releasedFloor === true, removed: removed.username },
    }
  }

  // ── 5.16：管理员**结束一场会议**（管理台的房间级操作）────────────────────
  if (method === 'POST' && segments[1] === 'rooms' && segments[3] === 'close' && segments.length === 4) {
    if (allowed(role, 'room.manage') !== true) return deny(role, 'room.manage')
    const raw = decodeURIComponent(segments[2])
    const room = roomById(root, raw) ?? roomByCode(root, raw)
    if (room === null) return bad(404, `room not found: ${raw}`)
    const closed = closeRoomByAdmin(root, { roomId: room.id, by: user, now })
    if (closed.ok !== true) return bad(409, closed.error)
    return {
      status: 200,
      json: { ok: true, roomId: room.id, closed: true, alreadyClosed: closed.alreadyClosed === true },
    }
  }

  // ── 发言权互斥（P2b）────────────────────────────────────────────────
  if (segments[1] === 'rooms' && segments[3] === 'floor' && segments.length === 4) {
    const rawF = decodeURIComponent(segments[2])
    const roomF = roomById(root, rawF) ?? roomByCode(root, rawF)
    if (roomF === null) return bad(404, `room not found: ${rawF}`)
    // 已结束的会议：不再给状态、也不再接受开麦/锁定（4.44）。
    // 客户端拿到 closed:true 就该退出房间 —— 让它继续待在屋里是最糟的选择。
    if (isRoomClosed(root, roomF.id)) {
      return { status: 410, json: { ok: false, closed: true, roomId: roomF.id, error: '这个会议已经结束' } }
    }
    if (method === 'GET') {
      // 先清掉"锁着麦但人已经不在"的状态（4.42）：没人来抢时，这里就是唯一的清理点。
      // 清掉了就把原因带回给客户端，让界面能说一句"XX 掉线，麦克风已释放"。
      const swept = sweepExpiredFloor(root, roomF.id, Date.parse(now) || Date.now())
      // 清掉了就广播一次：让**所有人**都看到"麦克风已释放"，而不是只有正在轮询的这台
      if (swept.released !== null && typeof input.onFloorSwept === 'function') {
        input.onFloorSwept(roomF.id, swept)
      }
      return {
        status: 200,
        json: {
          ok: true,
          ...floorState(root, roomF.id),
          leaseMs: FLOOR_LEASE_MS,
          lockedLeaseMs: FLOOR_LOCKED_LEASE_MS,
          released: swept.released,
          releasedLocked: swept.locked,
        },
      }
    }
    if (method === 'POST') {
      const action = String(body.action ?? '')
      if (action === 'take') {
        const result = takeFloor(root, { roomId: roomF.id, username: user, now })
        if (result.ok !== true) return bad(409, result.error)
        return { status: 200, json: { ok: true, ...result.state, tookOver: result.tookOver ?? null, reason: result.reason ?? null, releasedLocked: result.releasedLocked === true } }
      }
      if (action === 'release') {
        const result = releaseFloor(root, { roomId: roomF.id, username: user, now })
        if (result.ok !== true) return bad(409, result.error)
        return { status: 200, json: { ok: true, ...result.state, released: result.released } }
      }
      if (action === 'lock' || action === 'unlock') {
        const result = setFloorLock(root, { roomId: roomF.id, username: user, host: roomF.host, locked: action === 'lock', now })
        if (result.ok !== true) return bad(409, result.error)
        return { status: 200, json: { ok: true, ...result.state } }
      }
      if (action === 'heartbeat') {
        const result = heartbeatFloor(root, { roomId: roomF.id, username: user, now })
        if (result.ok !== true) return bad(409, result.error)
        return { status: 200, json: { ok: true } }
      }
      if (action === 'force-release') {
        const result = forceReleaseFloor(root, { roomId: roomF.id, by: user, host: roomF.host, now })
        if (result.ok !== true) return bad(409, result.error)
        return { status: 200, json: { ok: true, ...result.state, released: result.released } }
      }
      return bad(400, `unknown action: ${action}`)
    }
  }
  if (segments[1] === 'rooms' && segments.length === 3) {
    const raw = decodeURIComponent(segments[2])
    const room = roomById(root, raw) ?? roomByCode(root, raw)
    if (room === null) return bad(404, `room not found: ${raw} (use room.id or 6-digit code)`)
    if (method === 'GET') {
      // 5.15：把"这一场有没有在翻译 / 为什么没跑"一并给客户端（`start-multi` 写的侧车）
      const pipeline = typeof input.pipelineOf === 'function' ? input.pipelineOf(room.id) : null
      return {
        status: 200,
        json: {
          ok: true, room, members: listMembers(root, room.id),
          libraryIds: roomLibraries(root, room.id), pipeline,
        },
      }
    }
  }
  if (method === 'POST' && segments[1] === 'rooms' && segments[3] === 'libraries' && segments.length === 4) {
    const rawId = decodeURIComponent(segments[2])
    const room = roomById(root, rawId) ?? roomByCode(root, rawId)
    if (room === null) return bad(404, `room not found: ${rawId} (use room.id or 6-digit code)`)
    const roomId = room.id
    const libraryIds = Array.isArray(body.libraryIds) ? body.libraryIds.map(String) : []
    const saved = setRoomLibraries(root, roomId, libraryIds)
    if (saved.ok !== true) return bad(400, saved.error)
    // 5.14：**按房间**发布会话术语（`meeting-terms/rooms/<房间>/`）——
    // 多场会并行时各用各的库，后发布的不会再覆盖前一场的。
    const published = await publishMeetingTerms(root, {
      roomId, libraryIds, owner: user, meetingId: roomId, now,
    })
    // publishMeetingTerms 不返回 ok 字段（返回 meetingId/entries/conflicts）——不要再按 ok 判断
    return { status: 200, json: { ok: true, roomId, libraryIds, entries: published.entries, meetingId: published.meetingId, conflicts: published.conflicts ?? [] } }
  }

  return bad(404, `没有这个接口：${method} ${path}`)
}
