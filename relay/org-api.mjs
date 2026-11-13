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
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadStrategyTable, saveStrategyTable, validateStrategyTable } from '../lib/asr-engines.mjs'
import {
  SEGMENTATION_DEFAULTS, SEGMENTATION_FIELDS, SEGMENTATION_RULES, loadSegmentation, saveSegmentation,
  validateSegmentation,
} from '../lib/segmentation.mjs'
import { audioUsage, purgeAllAudio, purgeRoomAudio } from '../lib/audio-usage.mjs'
import { appendAudit, auditPath } from '../lib/room-strategy.mjs'

/** 仓库根（`config/asr-models.json` 这类示例文件在这儿）。 */
const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
import { DEV_TTL_DAYS, allowed, createAccountWithPassword, listAccounts, loadAccounts, renewAccount, saveAccounts, setStatusByUsername, updateAccounts } from '../lib/accounts.mjs'
import { readJson, writeJsonAtomic } from '../lib/store.mjs'
import { listLibraries, loadLibrary, loadCategories, saveLibrary, importLibraries } from '../lib/libraries.mjs'
import { createRequest, decideRequest, hideRequest, loadRequests, pendingOf, visibleOfMine, withdrawRequest } from '../lib/requests.mjs'
import { writeMeetingSnapshot } from '../lib/snapshot.mjs'
import { closeRoomByAdmin, createInterpreterSession, createRoom, hideHistoryForUser, isRoomClosed, joinRoom, leaveRoom, listHistory, listHistoryForAdmin, listMembers, listRoomTranscript, listRooms, purgeHistory, removeMember, roomByCode, roomById, roomLabels, roomLibraries, setRoomLibraries } from '../lib/rooms.mjs'
import { FLOOR_LOCKED_LEASE_MS, FLOOR_LEASE_MS, floorState, forceReleaseFloor, heartbeatFloor, releaseFloor, setFloorLock, sweepExpiredFloor, takeFloor } from '../lib/floor.mjs'
import { publishMeetingTerms } from '../lib/meeting-terms.mjs'
import { appendUtterance } from '../lib/db.mjs'

/** 打一行日志（调用方给了回调才打；没给就当没这回事）。 */
function logLine(log, text) {
  if (typeof log === 'function') log(text)
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
  // 5.66：调用方（relay）可以给一个日志回调 —— 走磁盘的纯函数也能在终端上说话。
  // 不给就静默（测试里不关心输出）。
  const log = typeof input.log === 'function' ? input.log : null
  // 路径上可能带 query（如 /org/history?limit=20）：切段之前先剔掉，否则它会变成一个路径段
  const segments = path.split('?')[0].split('/').filter(Boolean).map((item) => decodeURIComponent(item))

  if (user === null || user === undefined) return bad(401, '需要登录（缺少有效 token）')

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
    // ⚠️ 5.108：这里原来会把手机上报的 `asrModels` / `asrEngines` **落成房间侧车**
    // （`<数据目录>/asr-profiles/<房间>.json`），识别进程再按"房间覆盖"这一层读它。
    // 那一层已**整层删除**：
    //   · 手机端的模型选择在 5.69 就删了，界面上没有地方能产生这个值；
    //   · 于是它只可能带着**过期**内容（旧的 APK、旧的实验残留），却拥有**最高**优先级 ——
    //     实测踩过"服务器表改对了、字幕还是按旧模型跑"这种最难查的形态；
    //   · 现在"这场用什么模型"只有一个来源：服务器上的 `asr-models.json`
    //     （`scripts/asr-model-switch.mjs` 改它，热读生效）。
    // 手机就算还照老样子报上来，也**只是被记一行日志**，不产生任何效果。
    const asked = Object.entries(body.asrModels ?? {})
      .map(([lang, model]) => `${lang}→${String(model)}`)
      .join('、')
    const askedEngines = Object.entries(body.asrEngines ?? {})
      .map(([lang, engine]) => `${lang}@${String(engine)}`)
      .join('、')
    if (asked !== '' || askedEngines !== '') {
      logLine(log, `🎛 会话 ${created.session.id} 上报了模型请求（忽略）：`
        + [asked, askedEngines].filter(Boolean).join('、')
        + ' —— 5.108 起模型只由服务器表决定（scripts/asr-model-switch.mjs）')
    }
    return {
      status: 200,
      json: { ok: true, session: created.session },
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

  /**
   * 5.187：降噪四项（高通 + VAD）——**逐语种可读可写**，与切句参数同一套做法。
   *
   * <p>为什么做成"和切句参数一样"：现场的问题是"教室吵"和"偶尔冒出一句没人说过的话"，
   * 而这两个毛病在不同语种上轻重不同（中文最爱在段末编话）。所以配置必须能按语种分开，
   * 管理台要能看见"不填就继承到多少"，也能一眼看出是谁定的。
   *
   * <p>代价不同，缺省也就不同：高通是**线性滤波**（不剪时长、不改语音结构），所以缺省开 100；
   * VAD 会**剪掉不像人声的头尾**，短句上可能吃掉第一个音节，所以缺省关、要现场数据再开。
   */
  const NOISE_FIELDS = ['highpass_hz', 'vad', 'vad_max_ms', 'vad_threshold']
  const NOISE_DEFAULTS = { highpass_hz: 0, vad: false, vad_max_ms: 2000, vad_threshold: 0.5 }
  const NOISE_RULES = {
    highpass_hz: {
      label: '高通 (Hz)', min: 0, max: 2000, step: 10, type: 'number',
      note: '0 = 关；100 = 砍掉 100Hz 以下（空调/桌面震动）。线性滤波，不剪时长',
    },
    vad: {
      label: 'VAD 二次确认', type: 'switch',
      note: '会剪掉不像人声的头尾 —— 短句上可能吃字，所以缺省关',
    },
    vad_max_ms: {
      label: 'VAD 只跑短段 (ms)', min: 200, max: 30000, step: 100, type: 'number',
      note: '只给不超过这个长度的段做 VAD（幻听集中在短段，长段不做以省延迟）',
    },
    vad_threshold: {
      label: 'VAD 门槛', min: 0.05, max: 0.95, step: 0.05, type: 'number',
      note: '越大越严（更少幻听，但可能漏掉轻声）',
    },
  }

  /** 5.187：表里降噪四项的校验（与面板同一份规则）。@returns {string[]} 问题清单 */
  const noiseProblemOf = (where, layer) => {
    const problems = []
    if (layer === null || typeof layer !== 'object') return problems
    for (const key of NOISE_FIELDS) {
      if (!(key in layer)) continue
      const value = layer[key]
      const rule = NOISE_RULES[key]
      if (key === 'vad') {
        if (typeof value !== 'boolean') problems.push(`${where} 的 VAD 要写 true / false（现在是 ${JSON.stringify(value)}）`)
        continue
      }
      if (typeof value !== 'number' || Number.isFinite(value) !== true) {
        problems.push(`${where} 的 ${rule.label} 要是数字（现在是 ${JSON.stringify(value)}）`)
        continue
      }
      if (value < rule.min || value > rule.max) {
        problems.push(`${where} 的 ${rule.label} 超出 ${rule.min}~${rule.max}（现在是 ${value}）`)
      }
      if (key === 'highpass_hz' && value !== 0 && value < 20) {
        problems.push(`${where} 的高通设成 ${value}Hz 基本等于没开：要么写 0（关），要么 ≥20`)
      }
    }
    return problems
  }

  const collectNoiseProblems = (table) => {
    const problems = []
    if (table === null || typeof table !== 'object') return problems
    problems.push(...noiseProblemOf('default', table.default))
    for (const [name, layer] of Object.entries(table.strategies ?? {})) {
      problems.push(...noiseProblemOf(`策略 ${name}`, layer))
    }
    for (const [lang, layer] of Object.entries(table.languages ?? {})) {
      problems.push(...noiseProblemOf(`语言 ${lang}`, layer))
    }
    return problems
  }

  /** 5.187：某门语言**实际生效**的降噪四项，以及各自来自哪一层。 */
  const effectiveNoise = (table, lang) => {
    const values = { ...NOISE_DEFAULTS }
    const layers = {}
    const take = (layer, tag) => {
      if (layer === null || typeof layer !== 'object') return
      for (const key of NOISE_FIELDS) {
        if (!(key in layer)) continue
        const value = layer[key]
        if (key === 'vad') {
          if (typeof value !== 'boolean') continue
        } else if (typeof value !== 'number' || Number.isFinite(value) !== true) continue
        values[key] = value
        layers[key] = tag
      }
    }
    take(table?.default, 'default')
    const strategyName = typeof table?.languages?.[lang]?.strategy === 'string'
      ? table.languages[lang].strategy
      : 'default'
    if (strategyName !== 'default') take(table?.strategies?.[strategyName], `策略 ${strategyName}`)
    take(table?.languages?.[lang], `语言 ${lang}`)
    return { values, layers, strategy: strategyName }
  }

  /**
   * 5.185：每门语言**实际生效**的切句参数（以及它们各自从哪一层来）。
   *
   * <p>为什么要算这个：界面上要能显示"不填就是继承到 X"和"这一项正被全局旋钮压着"。
   * 优先级（与 whisper_stream.py 的 _new_segmenter 一致）：
   * 内置缺省 < default < strategies[名字] < languages[语种] < **全局 segmentation.json** < 命令行。
   *
   * @returns {{values: object, layers: object, global: string[]}} layers 记每个字段来自哪一层
   */
  /** 5.185：表里各语种切句参数的校验（与面板同一份规则）。@returns {string[]} 问题清单 */
  const collectSegmentationProblems = (table) => {
    const problems = []
    const langs = table && typeof table === 'object' && table.languages && typeof table.languages === 'object'
      ? table.languages
      : {}
    for (const [lang, layer] of Object.entries(langs)) {
      if (layer === null || typeof layer !== 'object') continue
      const seg = layer.segmentation
      if (seg === null || typeof seg !== 'object') continue
      const checked = validateSegmentation(seg)
      for (const one of checked.problems ?? []) problems.push(`${lang} 的切句参数：${one}`)
    }
    return problems
  }

  const effectiveSegmentation = (table, lang) => {
    const layers = {}
    const values = { ...SEGMENTATION_DEFAULTS }
    const take = (source, layer, tag) => {
      if (layer === null || typeof layer !== 'object') return
      const seg = layer.segmentation
      if (seg === null || typeof seg !== 'object') return
      for (const key of SEGMENTATION_FIELDS) {
        const value = seg[key]
        if (typeof value !== 'number' || Number.isFinite(value) !== true) continue
        values[key] = value
        layers[key] = tag
      }
      void source
    }
    take('default', table?.default, 'default')
    const strategyName = typeof table?.languages?.[lang]?.strategy === 'string'
      ? table.languages[lang].strategy
      : 'default'
    if (strategyName !== 'default') take('strategy', table?.strategies?.[strategyName], `策略 ${strategyName}`)
    take('language', table?.languages?.[lang], `语言 ${lang}`)
    // 全局旋钮（管理台「切句参数」面板）压过上面所有层
    // ⚠️ 只有**文件真的存在**（source==='file'）时才算全局覆盖：
    // loadSegmentation 在没有文件时会返回"内置缺省合并后的值"（source=defaults），
    // 照单全收就会把每门语言自己设的值冲成缺省 —— 第一版就这么错了。
    const loaded = loadSegmentation(root)
    const global = []
    const fromFile = loaded.source === 'file' && loaded.values && typeof loaded.values === 'object'
      ? loaded.values
      : {}
    for (const key of SEGMENTATION_FIELDS) {
      const value = fromFile[key]
      if (typeof value !== 'number' || Number.isFinite(value) !== true) continue
      values[key] = value
      layers[key] = '全局旋钮'
      global.push(key)
    }
    return { values, layers, global, strategy: strategyName }
  }

  // ── 识别策略表（5.148）：管理员改全局表；**只影响之后新建的会议** ─────────
  //
  // 为什么不给手机加接口：选择权收归管理员（设计见 docs/33）。手机端只在开发者模式下
  // **看**本场用了什么（房间详情里的 `strategy`），不参与选择。
  //
  // 写表为什么是 PUT 整张表而不是若干 PATCH：表里三层叠加的语义（default / strategies /
  // languages）用零散字段改容易改出"半新半旧"；管理页本来就拿着完整一份来改。
  // ── 5.171：音频占用（哪场会占了多少、能不能删）────────────────────────
  // 用户实测：跑完一场长会 + 一段翻译官，磁盘满时只看到一句「音频文件已达上限」，
  // 却不知道是谁占的。这里把占用按房间列出来，并能单独删掉某一场的录音。
  if (segments[1] === 'audio' && segments[2] === 'usage' && method === 'GET') {
    const usage = audioUsage(root)
    const limits = typeof input.audioLimits === 'function' ? input.audioLimits() : {}
    // 5.172：磁盘上的目录名是**内部房间 id**，管理员认不出是哪一场 —— 附上 6 位邀请码和房名。
    // 查不到就留空（那种目录多半是历史清理后残留的），界面会写明"数据库里没有这场"。
    const labels = roomLabels(root)
    const rooms = usage.rooms.map((one) => {
      const label = labels[one.roomId]
      return {
        ...one,
        code: label ? label.code : '',
        name: label ? label.name : '',
        kind: label ? label.kind : '',
        active: label ? label.active : null,
        known: Boolean(label),
      }
    })
    return {
      status: 200,
      json: {
        ok: true,
        totalBytes: usage.totalBytes,
        legacyBytes: usage.legacyBytes,
        rooms,
        limits,
        note: '删录音只腾磁盘，不动字幕与历史（那些在「会议历史」里）',
      },
    }
  }

  if (segments[1] === 'audio' && segments[2] === 'purge' && method === 'POST') {
    if (allowed(role, 'history.purge') !== true) return deny(role, 'history.purge')
    const all = body !== null && body !== undefined && body.all === true
    const roomId = String(body?.roomId ?? '').trim()
    if (all !== true && roomId === '') return bad(400, '要删哪一场？给 roomId，或用 {all:true} 清空全部录音')
    const result = all === true ? purgeAllAudio(root) : purgeRoomAudio(root, roomId)
    if (result.ok !== true) return bad(409, result.error)
    // 删完立刻让转发进程按磁盘重算「已收音频总量」—— 否则上限还会短时间挡着
    if (typeof input.onAudioPurged === 'function') input.onAudioPurged()
    logLine(input.log, `🗑 音频已清理：${all === true ? '全部' : roomId}，`
      + `释放 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB`)
    return {
      status: 200,
      json: {
        ok: true,
        all: all === true,
        roomId: all === true ? null : (result.roomId ?? roomId),
        freedBytes: result.freedBytes,
        failed: result.failed ?? [],
      },
    }
  }

  // ── 5.167：切句（分段）参数的全局旋钮 ────────────────────────────────
  // 为什么放管理台：同传延迟 ≈「一句攒多久」+ 识别 + 翻译，而「攒多久」全由这几个数决定。
  // 现场要调它却得改命令行重启整条管线，代价太大 —— 所以给管理员一个不用重启的旋钮。
  if (segments[1] === 'segmentation') {
    if (method === 'GET' && segments.length === 2) {
      const loaded = loadSegmentation(root)
      return {
        status: 200,
        json: {
          ok: true,
          values: loaded.values,
          source: loaded.source,
          defaults: { ...SEGMENTATION_DEFAULTS },
          rules: SEGMENTATION_RULES,
          path: loaded.path,
          note: '改完在**下一段录音 / 下一场会**生效（切句器是按音频流创建的，不在句子中间重建）',
        },
      }
    }
    if (method === 'POST' && segments[2] === 'validate') {
      const checked = validateSegmentation(body)
      return { status: 200, json: { ok: checked.ok, problems: checked.problems, warnings: checked.warnings, values: checked.values } }
    }
    if (method === 'PUT' && segments.length === 2) {
      if (allowed(role, 'model.write') !== true) return deny(role, 'model.write')
      // 支持 {reset:true} 一键回到缺省（现场调坏了要有退路）
      const payload = body !== null && body.reset === true ? { ...SEGMENTATION_DEFAULTS } : body
      const saved = saveSegmentation(root, payload, { now })
      if (saved.ok !== true) return bad(400, saved.error)
      return {
        status: 200,
        json: {
          ok: true,
          values: saved.values,
          path: saved.path,
          backup: saved.backup,
          warnings: saved.warnings,
          note: '已保存；下一段录音 / 下一场会生效',
        },
      }
    }
    return bad(405, '只支持 GET /org/segmentation、POST /org/segmentation/validate、PUT /org/segmentation')
  }

  if (segments[1] === 'asr' && segments[2] === 'models') {
    if (method === 'GET' && segments.length === 3) {
      if (allowed(role, 'model.read') !== true) return deny(role, 'model.read')
      const loaded = loadStrategyTable(root)
      // 没有表 / 表读坏了：**只说一句**（不要按三门语言各报一条"没写模型名"——
      // 那是把"根本还没有表"说成"三条策略都配错"，看的人会去改错地方）。
      if (loaded.table === null) {
        return {
          status: 200,
          json: {
            ok: true, table: {}, languages: {}, problems: [], warnings: [],
            note: loaded.problem
              ? `策略表读不了（${loaded.problem}）→ 现在用的是内置缺省（whisper / large-v3）`
              : '服务器上还没有策略表 → 现在用的是内置缺省（whisper / large-v3）；'
                + '点「初始化示例表」可以写入一份带全部候选策略的模板',
            source: { found: loaded.found, path: loaded.path, problem: loaded.problem },
            // 5.185：没有表也要给"现在实际生效的切句值"（界面占位符要用它）
            segmentation: Object.fromEntries(['zh-CN', 'en-US', 'pt-BR']
              .map((lang) => [lang, effectiveSegmentation({}, lang)])),
            segmentationRules: SEGMENTATION_RULES,
            segmentationDefaults: SEGMENTATION_DEFAULTS,
            // 5.187：降噪四项同理（没有表时就是"高通关、VAD 关"，界面照实显示）
            noise: Object.fromEntries(['zh-CN', 'en-US', 'pt-BR']
              .map((lang) => [lang, effectiveNoise({}, lang)])),
            noiseRules: NOISE_RULES,
            noiseDefaults: NOISE_DEFAULTS,
          },
        }
      }
      const report = validateStrategyTable(loaded.table, {})
      // 5.148：文件里中文像乱码时**明说**（Windows 上按 GBK 存过、或从别的机器拷坏了）——
      // 否则界面上只会看到"策略名/备注读不懂"，没人知道该重新生成那份表。
      const MOJIBAKE = ['锛', '鐨', '鏄', '鍦', '浜', '鎴', '缁', '杩', '璇', '瑁', '璁', '闇'] // mojibake-ok：这一行列的就是乱码字本身，不是文件坏了
      let rawTable = ''
      try { rawTable = readFileSync(loaded.path, 'utf-8') } catch { rawTable = '' }
      if (MOJIBAKE.some((marker) => rawTable.includes(marker))) {
        report.warnings.push('策略表里的中文像是乱码（文件可能被按 GBK 存过）→ 建议点「初始化示例表」重建一份')
      }
      // 5.185：界面要在"策略"行旁边显示每门语言**实际生效**的切句参数
      //（不填就是继承，界面要能显示继承到多少；被全局旋钮压住时也要标出来）。
      const segmentation = {}
      for (const lang of ['zh-CN', 'en-US', 'pt-BR']) {
        segmentation[lang] = effectiveSegmentation(loaded.table, lang)
      }
      // 5.187：每门语言实际生效的降噪四项（界面占位符与"谁定的"都用它）
      const noise = {}
      for (const lang of ['zh-CN', 'en-US', 'pt-BR']) {
        noise[lang] = effectiveNoise(loaded.table, lang)
      }
      return {
        status: 200,
        json: {
          ok: true,
          table: loaded.table,
          languages: report.languages,
          problems: report.problems,
          warnings: report.warnings,
          note: '',
          // 读不到/读坏了要说清楚：管理页据此提示"现在根本没表"
          source: { found: loaded.found, path: loaded.path, problem: loaded.problem },
          segmentation,
          segmentationRules: SEGMENTATION_RULES,
          segmentationDefaults: SEGMENTATION_DEFAULTS,
          noise,
          noiseRules: NOISE_RULES,
          noiseDefaults: NOISE_DEFAULTS,
        },
      }
    }
    if (method === 'POST' && segments[3] === 'seed' && segments.length === 4) {
      if (allowed(role, 'model.write') !== true) return deny(role, 'model.write')
      // 用仓库里的示例表（UTF-8、带全部候选策略）覆盖写成"当前表"。
      // 为什么需要它：换了机器之后数据目录里常常**没有** asr-models.json，
      // 管理页只能显示"没有表"，管理员连"en-parakeet-gpu"都选不到。
      let seed = null
      try {
        const raw = readFileSync(join(ROOT_DIR, 'config', 'asr-models.json'), 'utf-8')
        seed = JSON.parse(raw.replace(/^\uFEFF/, ''))
      } catch (error) {
        return bad(500, `读不到示例表 config/asr-models.json：${String(error?.message ?? error)}`)
      }
      const report = validateStrategyTable(seed, {})
      if (report.ok !== true) {
        return { status: 500, json: { ok: false, error: 'invalid-example', problems: report.problems } }
      }
      const saved = saveStrategyTable(root, seed)
      if (saved.ok !== true) return bad(500, `写表失败：${saved.error}`)
      appendAudit(root, {
        by: user, action: 'models.write', result: 'seed',
        before: null, after: seed.languages ?? null, backup: saved.backup,
      })
      logLine(log, `🎛 ${user} 用示例表初始化了识别策略表（只影响之后新建的会议；备份：${saved.backup || '无'}）`)
      return {
        status: 200,
        json: { ok: true, table: seed, languages: report.languages, warnings: report.warnings, backup: saved.backup },
      }
    }
    if (method === 'POST' && segments[3] === 'validate' && segments.length === 4) {
      if (allowed(role, 'model.read') !== true) return deny(role, 'model.read')
      const report = validateStrategyTable(body.table, {})
      const segProblems = collectSegmentationProblems(body.table)
      if (segProblems.length > 0) {
        return {
          status: 409,
          json: {
            ok: false, error: 'invalid-segmentation', problems: segProblems,
            hint: '切句参数越界，已拒绝保存（范围见「切句参数」面板每个字段后面的说明）',
          },
        }
      }
      // 5.187：降噪四项也校验（写了 "100" 字符串、写反了 true/false 这类，识别侧只会静默不生效）
      const noiseProblems = collectNoiseProblems(body.table)
      if (noiseProblems.length > 0) {
        return {
          status: 409,
          json: {
            ok: false, error: 'invalid-noise', problems: noiseProblems,
            hint: '降噪参数不合法，已拒绝保存（VAD 要写 true/false，高通要写数字，0 = 关）',
          },
        }
      }
      return { status: 200, json: { ok: true, ...report } }
    }
    if (method === 'PUT' && segments.length === 3) {
      if (allowed(role, 'model.write') !== true) return deny(role, 'model.write')
      const report = validateStrategyTable(body.table, {})
      // 5.185：切句参数也校验（与「切句参数」面板**同一份**规则）——
      // 越界就别写进表：写进去只会让切句侧每段都报错或静默失效。
      const segProblems = collectSegmentationProblems(body.table)
      if (segProblems.length > 0) {
        return {
          status: 409,
          json: {
            ok: false, error: 'invalid-segmentation', problems: segProblems,
            hint: '切句参数越界，已拒绝保存（范围见「切句参数」面板每个字段后面的说明）',
          },
        }
      }
      // 5.187：降噪四项同理 —— 写进表却让识别侧静默忽略，比直接拒绝糟得多
      const noiseProblems = collectNoiseProblems(body.table)
      if (noiseProblems.length > 0) {
        return {
          status: 409,
          json: {
            ok: false, error: 'invalid-noise', problems: noiseProblems,
            hint: '降噪参数不合法，已拒绝保存（VAD 要写 true/false，高通要写数字，0 = 关）',
          },
        }
      }
      if (report.ok !== true) {
        // 写进去就会坏的东西**不进库**：宁可让管理员改一行，也不要留一张跑不起来的表
        return {
          status: 409,
          json: {
            ok: false, error: 'invalid-table', problems: report.problems,
            hint: '表结构有问题，已拒绝保存（下面 problems 逐条列出是哪一处）',
          },
        }
      }
      const before = loadStrategyTable(root)
      const saved = saveStrategyTable(root, body.table)
      if (saved.ok !== true) return bad(500, `写表失败：${saved.error}`)
      appendAudit(root, {
        by: user, action: 'models.write', result: 'ok',
        before: before.table === null ? null : before.table.languages,
        after: body.table.languages ?? null,
        warnings: report.warnings,
        backup: saved.backup,
      })
      logLine(log, `🎛 ${user} 改了识别策略表（只影响之后新建的会议；备份：${saved.backup || '无'}）`)
      return {
        status: 200,
        json: {
          ok: true, table: body.table, languages: report.languages,
          warnings: report.warnings, backup: saved.backup,
        },
      }
    }
    if (method === 'GET' && segments[3] === 'history' && segments.length === 4) {
      if (allowed(role, 'model.read') !== true) return deny(role, 'model.read')
      const rawLimit = Number(new URLSearchParams(String(path).split('?')[1] ?? '').get('limit') ?? 20)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : 20
      let lines = []
      try {
        lines = readFileSync(auditPath(root), 'utf-8').trim().split('\n').filter(Boolean)
      } catch { lines = [] }
      const entries = lines
        .map((line) => { try { return JSON.parse(line) } catch { return null } })
        .filter((one) => one !== null && ['models.write', 'strategy.lock'].includes(one.action))
        .slice(-limit)
        .reverse()
      return { status: 200, json: { ok: true, entries } }
    }
    return bad(405, '只支持 GET /org/asr/models、POST /org/asr/models/validate、PUT /org/asr/models、GET /org/asr/models/history')
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
      // 5.148：这场会用哪套识别策略（房间冻结快照优先；没有快照回落全局表）。
      // 给开发模式面板看 —— 界面上"冻结的"与"当前表"要靠 source 分清，不能猜。
      const strategy = typeof input.strategyOf === 'function' ? input.strategyOf(room.id) : null
      return {
        status: 200,
        json: {
          ok: true, room, members: listMembers(root, room.id),
          libraryIds: roomLibraries(root, room.id), pipeline, strategy,
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
