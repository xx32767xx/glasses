#!/usr/bin/env node
/**
 * terms-admin.mjs —— 术语库 / 申请审批 / 会议快照的命令行入口
 * ============================================================================
 *
 * 为什么先做 CLI 而不是先做界面：
 *   服务端的每一个动作（建库、审批、出快照）都必须能在**没有安卓壳、没有网页**的情况下
 *   被验证一遍。界面只是这些动作的壳；先有壳而没有动作，等于把 bug 藏进 UI 里。
 *   等这套动作稳定了，管理端界面（管理员 / 用户两套）直接对着同一批函数写。
 *
 * 用法（一律先选环境，**生产与测试两套数据从不混用**）：
 *
 *   node scripts/terms-admin.mjs init            --env test
 *   node scripts/terms-admin.mjs admin           --env test --email boss@example.com
 *   node scripts/terms-admin.mjs dev             --env test --email dev1@example.com --days 7
 *   node scripts/terms-admin.mjs category        --env test --name 出口贸易
 *   node scripts/terms-admin.mjs import          --env test --file var/tmp/libs.json
 *   node scripts/terms-admin.mjs list            --env test
 *   node scripts/terms-admin.mjs request         --env test --type add --library lib-x \
 *        --zh 骁龙 8 Gen 3 --pt "Snapdragon 8 Gen 3" --reason 客户指定 --applicant alice@example.com
 *   node scripts/terms-admin.mjs pending         --env test
 *   node scripts/terms-admin.mjs approve         --env test --id req-... --by boss@example.com
 *   node scripts/terms-admin.mjs snapshot        --env test --meeting room-001 --libraries lib-a,lib-b
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { VAR_DIR } from '../lib/paths.mjs'
import { resolveDataDir, ENVS } from '../lib/store.mjs'
import {
  createAccountWithPassword, issueCode, listAccounts, loadAccounts, saveAccounts,
} from '../lib/accounts.mjs'
import {
  addCategory, emptyCategories, importLibraries, listLibraries, loadCategories,
  loadLibrary, saveCategories, saveLibrary,
} from '../lib/libraries.mjs'
import { createRequest, decideRequest, loadRequests, pendingOf, withdrawRequest } from '../lib/requests.mjs'
import { writeMeetingSnapshot } from '../lib/snapshot.mjs'

function parseArgs(argv) {
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--') !== true) {
      options._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
      continue
    }
    options[key] = next
    index += 1
  }
  return options
}

const USAGE = `用法：node scripts/terms-admin.mjs <命令> --env prod|test [--root <数据目录>] [选项]

命令：
  init        建目录（幂等）
  --root      直接用这个数据目录（服务器上形如 /opt/glasses-data）；
              不给则用 <仓库>/var/live 或 var/live-test，由 --env 决定
  admin       建管理员账户        --username --password [--email]
  code        发一个验证码（本地打印，不真发邮件）  --email
  login       用验证码登录（返回 token）            --email --code
  dev         建测试账号（默认 7 天过期）          --username --password [--email] [--days]
  accounts    列出账号（用户名/角色/状态/过期）
  category    建分类              --name
  import      批量导入库          --file <json 数组>
  list        列出库
  show        看单个库            --library <id>
  request     提交申请            --type add|update|delete --library --zh --pt --reason --applicant
  pending     列出待审申请
  approve     通过                --id --by [--note]
  reject      驳回                --id --by [--note]
  withdraw    撤回（申请人自己）  --id --applicant
  snapshot    生成会议术语快照    --meeting <id> --libraries a,b`

function envOf(options) {
  const env = typeof options.env === 'string' ? options.env : ''
  if (ENVS.includes(env) !== true) {
    throw new Error(`必须显式指定 --env prod 或 --env test（当前：${JSON.stringify(options.env ?? '')}）`)
  }
  return env
}

function rootOf(options) {
  const env = envOf(options)
  // --root：**直接用这个目录**。服务器上数据目录通常叫 /opt/glasses-data（不叫 live/live-test），
  // 用 --base 拼不出来；而"让运维为了跑一条 CLI 去改名目录"是没必要的折腾。
  if (typeof options.root === 'string' && options.root !== '') {
    return { env, root: resolve(options.root) }
  }
  const base = typeof options.base === 'string' ? options.base : VAR_DIR
  return { env, root: resolveDataDir(base, env) }
}

function need(options, key) {
  const value = options[key]
  if (typeof value !== 'string' || value === '') throw new Error(`缺少 --${key}`)
  return value
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const command = options._[0]
  if (command === undefined || command === 'help' || options.help === true) {
    console.log(USAGE)
    return 0
  }

  const { env, root } = rootOf(options)
  const stamp = () => new Date().toISOString()

  switch (command) {
    case 'init': {
      await mkdir(join(root, 'libraries'), { recursive: true })
      await mkdir(join(root, 'meetings'), { recursive: true })
      console.log(`已准备 ${env} 环境目录：${root}`)
      return 0
    }
    case 'admin': {
      // 管理员也是"人建的"，但**登录要用户名+密码**（docs/19），所以这里必须有密码。
      // 以前只收 --email，建出来的账号根本没法登录 —— 那是个死路，已修。
      const doc = await loadAccounts(root)
      const result = createAccountWithPassword(doc, {
        username: need(options, 'username'),
        password: need(options, 'password'),
        email: options.email,
        role: 'admin',
        note: '管理员（CLI 创建）',
        now: Date.now(),
      })
      if (result.ok !== true) throw new Error(result.error)
      await saveAccounts(root, result.doc)
      console.log(`管理员已建：${options.username}（环境 ${env}；用用户名+密码登录）`)
      return 0
    }
    case 'code': {
      const doc = await loadAccounts(root)
      const issued = issueCode(doc, need(options, 'email'))
      if (issued.ok !== true) throw new Error(issued.error)
      await saveAccounts(root, issued.doc)
      console.log(`验证码（本地打印，不真发邮件）：${issued.code}  10 分钟内有效`)
      return 0
    }
    case 'login': {
      const doc = await loadAccounts(root)
      const result = loginWithEmail(doc, need(options, 'email'), need(options, 'code'))
      if (result.ok !== true) throw new Error(result.error)
      await saveAccounts(root, result.doc)
      console.log(`登录成功${result.created ? '（新账户已创建）' : ''}：token=${result.token}`)
      return 0
    }
    case 'dev': {
      const doc = await loadAccounts(root)
      const days = typeof options.days === 'string' ? Number(options.days) : undefined
      const result = createAccountWithPassword(doc, {
        username: need(options, 'username'),
        password: need(options, 'password'),
        email: options.email,
        role: 'dev',
        note: '测试账号（CLI 创建）',
        expiresInDays: days,
        now: Date.now(),
      })
      if (result.ok !== true) throw new Error(result.error)
      await saveAccounts(root, result.doc)
      console.log(`测试账号已建：${options.username}（${days ?? 7} 天后过期，环境 ${env}；用用户名+密码登录）`)
      return 0
    }
    case 'accounts': {
      const doc = await loadAccounts(root)
      for (const item of listAccounts(doc)) {
        console.log(`${item.username.padEnd(12)} ${item.role.padEnd(6)} ${item.status.padEnd(9)} `
          + `${item.expiresAt ? '过期 ' + item.expiresAt.slice(0, 10) : '长期'}  ${item.email || '—'}`)
      }
      return 0
    }
    case 'category': {
      const doc = await loadCategories(root)
      const added = addCategory(doc.categories === undefined ? emptyCategories() : doc, need(options, 'name'), stamp())
      if (added.ok !== true) throw new Error(added.error)
      await saveCategories(root, added.doc)
      console.log(`${added.created ? '新建' : '已存在'}分类：${added.category.name}（${added.category.id}）`)
      return 0
    }
    case 'import': {
      const file = need(options, 'file')
      const items = JSON.parse(await readFile(file, 'utf-8'))
      const report = await importLibraries(root, items, { by: options.by ?? 'cli', now: stamp() })
      console.log(`导入完成：新建 ${report.report.created.length} 个、更新 ${report.report.updated.length} 个、被拒 ${report.report.rejected.length} 个`)
      for (const item of report.report.rejected) console.log(`  ✗ 第 ${item.index} 项（${item.name ?? '无名'}）：${item.error}`)
      return report.ok ? 0 : 1
    }
    case 'list': {
      const libraries = await listLibraries(root)
      if (libraries.length === 0) {
        console.log('（没有库）')
        return 0
      }
      for (const library of libraries) {
        console.log(`${library.id}  [prio ${library.priority}] ${library.name}  条目 ${library.entries.length}  分类 ${library.categoryId ?? '—'}`)
      }
      return 0
    }
    case 'show': {
      const library = await loadLibrary(root, need(options, 'library'))
      if (library === null) throw new Error('没有这个库')
      console.log(JSON.stringify(library, null, 2))
      return 0
    }
    case 'request': {
      const type = need(options, 'type')
      const result = await createRequest(root, {
        type,
        libraryId: need(options, 'library'),
        entry: type === 'delete' ? null : { zh: need(options, 'zh'), pt: need(options, 'pt') },
        targetKey: type === 'delete' ? need(options, 'zh') : null,
        reason: need(options, 'reason'),
        applicant: need(options, 'applicant'),
      }, { now: stamp() })
      if (result.ok !== true) throw new Error(result.error)
      console.log(`申请已提交：${result.id}（${result.type}）待管理员审批`)
      return 0
    }
    case 'pending': {
      const { items, badLines } = await loadRequests(root)
      const pending = pendingOf(items)
      if (pending.length === 0) {
        console.log('（没有待审申请）')
        return 0
      }
      for (const item of pending) {
        console.log(`${item.id}  ${item.type}  ${item.libraryId}  「${item.entry?.zh ?? item.targetKey}」→ ${item.entry?.pt ?? '（删除）'}  申请人 ${item.applicant}  理由：${item.reason}`)
      }
      if (badLines > 0) console.log(`（另有 ${badLines} 行坏数据被跳过）`)
      return 0
    }
    case 'approve':
    case 'reject': {
      const result = await decideRequest(root, need(options, 'id'), {
        decision: command === 'approve' ? 'approve' : 'reject',
        by: need(options, 'by'),
        note: options.note ?? '',
        now: stamp(),
      })
      if (result.ok !== true) throw new Error(result.error)
      console.log(`${command === 'approve' ? '已通过' : '已驳回'}：${result.id}（${result.status}）`
        + (result.library ? `；库 ${result.library.id} 现在 ${result.library.entries.length} 条` : ''))
      return 0
    }
    case 'withdraw': {
      const result = await withdrawRequest(root, need(options, 'id'), { applicant: need(options, 'applicant'), now: stamp() })
      if (result.ok !== true) throw new Error(result.error)
      console.log(`已撤回：${result.id}`)
      return 0
    }
    case 'snapshot': {
      const libraries = await listLibraries(root)
      const ids = need(options, 'libraries').split(',').map((item) => item.trim()).filter(Boolean)
      const snapshot = await writeMeetingSnapshot(root, need(options, 'meeting'), { libraryIds: ids, libraries, now: stamp() })
      console.log(`快照已生成：${snapshot.entries} 条`)
      console.log(`  插件 termsPath   = ${snapshot.termsPath}`)
      console.log(`  插件 activePath  = ${snapshot.activePath}`)
      if (snapshot.conflicts.length > 0) {
        console.log(`  ⚠ 有 ${snapshot.conflicts.length} 条跨库冲突未纳入快照：${snapshot.conflicts.map((item) => item.zh).join('、')}`)
      }
      return 0
    }
    case 'save-library': {
      const entries = JSON.parse(need(options, 'entries'))
      const result = await saveLibrary(root, {
        id: options.library, name: need(options, 'name'), categoryId: options.category ?? null,
        priority: typeof options.priority === 'string' ? Number(options.priority) : 0, entries,
      }, { by: options.by ?? 'cli', now: stamp() })
      if (result.ok !== true) throw new Error(result.error)
      console.log(`${result.created ? '新建' : '更新'}库：${result.library.id}（${result.library.entries.length} 条）`)
      return 0
    }
    default:
      throw new Error(`不认识的命令：${command}\n\n${USAGE}`)
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(`✗ ${error.message}`)
  process.exit(1)
})
