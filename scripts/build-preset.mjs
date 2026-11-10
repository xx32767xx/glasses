#!/usr/bin/env node
/**
 * build-preset.mjs —— 打包时把**服务器地址与共享密钥**写进 APK（5.155）
 * ============================================================================
 *
 * 老师的要求：打包的时候把服务器链接和密钥一并打包，装上就能用，不用手填。
 * 这个脚本就是"那一件事"的唯一入口 —— 它写 `res/values/app_config.xml`，
 * 而 Android 侧只有 `ServerPreset` 读这份资源（不许在代码里散着写死地址）。
 *
 * 用法：
 *   # 打包前：把地址与密钥写进去
 *   node scripts/build-preset.mjs --host http://10-60-107-47:8788 --secret <relay-secret.txt 里的值>
 *
 *   # 看一眼现在打包的是什么（密钥打码，不会把整串打到终端历史里）
 *   node scripts/build-preset.mjs --show
 *
 *   # 打包完成后还原成空（**提交前一定要做**，见下）
 *   node scripts/build-preset.mjs --clear
 *
 * ⚠️ 安全（用户已知情并接受，这里只是把后果写清楚，免得下一个人惊讶）：
 *   · 密钥进 APK = 公开。apktool 反编译几分钟就能在 strings 里搜到；
 *     它能做的事是"往你的服务器推字幕、灌音频"，直到你换密钥为止。
 *   · 换密钥的办法：删掉 <data-dir>/relay-secret.txt 重启 relay，然后重新打包。
 *   · **账号 token 绝不打包** —— 那是身份，泄漏等于别人用你的账号。
 *
 * ⚠️ `app_config.xml` 是**被 git 跟踪的**文件（出厂默认值本来就是它）。
 *   写进去之后 `git status` 会显示修改 —— 那就是提醒你别把它提交掉。
 *   `--clear` 或者 `git checkout -- android/app/src/main/res/values/app_config.xml` 即可还原。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const DEFAULT_FILE = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'app_config.xml')

/** 服务端要求的最小密钥长度（见 relay：太短的密钥会打警告并拒绝公网部署的一部分能力）。 */
const MIN_SECRET = 16

const USAGE = `用法：
  node scripts/build-preset.mjs --host <url> --secret <密钥>     # 写进 APK
  node scripts/build-preset.mjs --show                           # 看现在打包的是什么（密钥打码）
  node scripts/build-preset.mjs --clear                          # 还原成空（提交前做）

  其它：--secret-file <路径>（从文件读密钥，如 relay-secret.txt）
        --file <路径>（改别的 app_config.xml，测试用）
        --dry-run（只说会写什么，不落盘）`

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  console.error(USAGE)
  process.exit(1)
}

function parse(argv) {
  const out = { host: '', secret: '', secretFile: '', file: DEFAULT_FILE,
    show: false, clear: false, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = argv[index + 1]
    switch (token) {
      case '--host': out.host = String(next ?? ''); index += 1; break
      case '--secret': out.secret = String(next ?? ''); index += 1; break
      case '--secret-file': out.secretFile = String(next ?? ''); index += 1; break
      case '--file': out.file = String(next ?? ''); index += 1; break
      case '--show': out.show = true; break
      case '--clear': out.clear = true; break
      case '--dry-run': out.dryRun = true; break
      case '--help': case '-h': console.log(USAGE); process.exit(0); break
      default: fail(`不认识的参数：${token}`)
    }
  }
  return out
}

/** 密钥打码：只说长度与末尾两位 —— 足够确认"是不是同一串"，又不落进终端历史。 */
export function maskSecret(secret) {
  const value = typeof secret === 'string' ? secret : ''
  if (value === '') return '（空）'
  if (value.length <= 4) return `*`.repeat(value.length)
  return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}（${value.length} 位）`
}

/** 地址规范化：去掉尾部斜杠；必须是 http(s):// —— 明文 http 是本项目的现状（docs/10 §4.3）。 */
export function normalizeHost(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return { ok: false, error: '地址不能为空（例如 http://10-60-107-47:8788）' }
  if (!/^https?:\/\//i.test(value)) {
    return { ok: false, error: `地址必须以 http:// 或 https:// 开头，收到 ${JSON.stringify(value)}` }
  }
  return { ok: true, host: value.replace(/\/+$/, '') }
}

function render({ host, secret }) {
  // 注释是**故意留着**的：它就是下一个人打开这个文件时看到的全部上下文（含安全取舍）。
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  出厂默认配置（4.49 起）。改了这里，装完就不用再填地址与密钥。

  ⚠️ **不要手改这个文件**：用 \`node scripts/build-preset.mjs\` 写（写入 / 查看 / 还原三种用法见脚本头部）。
     代码里读它的地方只有一个（ServerPreset），取值优先级是
     「用户存过的偏好 → 这里的出厂值 → 空」。

  ⚠️ 关于「把服务器地址与密钥打包进 APK」（用户 2026-10-28 提、2026-11 老师要求实施）：
    · 服务器地址：可以打包。它不是口令；地址公开最坏的后果是「有人知道你的 IP」，
      而公网机器本来就会被扫端口扫到。
    · 共享密钥：**默认留空**。APK 能被反编译（apktool 几分钟），strings 一搜就出来；
      而密钥能做的事是「往你的服务器推字幕、灌音频」（/say、/audio），直到你换密钥为止。
      内部使用我们接受这个风险；对外发布时应当改成"每台设备一枚凭据"。
    · 账号 token：**绝不打包**。那是身份，泄漏等于别人用你的账号。

  换密钥的口诀：删掉 <data-dir>/relay-secret.txt 重启 relay，然后重新打包（手机端会跟着换）。

  ⚠️ XML 注释里不能出现连续两个连字符（markdown 表格的分隔行正是这么写的，
     曾经因为想演示它而真踩了一次），所以这份说明写成了条目式。
-->
<resources>
    <!-- 服务器地址（空串 = 不预填，让用户自己填）。由 scripts/build-preset.mjs 写入 -->
    <string name="default_server_url" translatable="false">${escapeXml(host)}</string>
    <!-- 共享密钥（默认空）。写进去就会随 APK 公开，见上面的说明 -->
    <string name="default_shared_secret" translatable="false">${escapeXml(secret)}</string>
</resources>
`
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 找出 XML 注释里出现的 `--`（**这个文件被它坑过一次**，所以要机器守，别靠人记）。
 *
 * <p>XML 规范不允许注释体里出现连续两个连字符（`<!-- 这样 -- 不行 -->`），
 * aapt2 / AGP 会在 `mergeDebugResources` 直接失败，报的还是 SAX 的原始堆栈：
 * `Resource and asset merger: 注释中不允许出现字符串 "--"`。
 *
 * <p>教训：写注释时顺手把命令行参数原样抄进去（`--host`）就会踩到 —— 而它只在**打包**时炸，
 * `node tests/run-all.mjs` 与 `javac` 都发现不了（那两步不解析 XML 注释）。
 *
 * @returns 命中的行号与内容（空数组 = 干净）
 */
export function commentDoubleHyphens(xml) {
  const hits = []
  const text = String(xml ?? '')
  const comment = /<!--([\s\S]*?)-->/g
  let match
  while ((match = comment.exec(text)) !== null) {
    const body = match[1]
    if (!body.includes('--')) continue
    const line = text.slice(0, match.index).split('\n').length
    hits.push({ line, body: body.trim().split('\n').find((one) => one.includes('--')) ?? '' })
  }
  return hits
}

/** 从文件里读出当前写着的值（--show 用）。 */
export function readPreset(xml) {
  const pick = (name) => {
    const match = new RegExp(`<string name="${name}"[^>]*>([\\s\\S]*?)</string>`).exec(xml)
    if (match === null) return ''
    return match[1].trim()
  }
  return { host: pick('default_server_url'), secret: pick('default_shared_secret') }
}

function main(argv) {
  const args = parse(argv)

  if (args.show) {
    let xml
    try {
      xml = readFileSync(args.file, 'utf-8')
    } catch (error) {
      fail(`读不了 ${args.file}：${error.message}`)
    }
    const preset = readPreset(xml)
    console.log(`文件         ${args.file}`)
    console.log(`服务器地址   ${preset.host === '' ? '（空：不预填）' : preset.host}`)
    console.log(`共享密钥     ${maskSecret(preset.secret)}`)
    console.log(preset.host !== '' && preset.secret !== ''
      ? '\n这个包里**内置了服务器**：装完直接登录就能用。'
      : '\n这个包里**没有**完整的内置服务器（缺地址或缺密钥）—— 用户要自己在「我的 → 服务器」里填。')
    return 0
  }

  if (args.clear) {
    writeFileSync(args.file, render({ host: '', secret: '' }))
    console.log(`✓ 已还原成空出厂值：${args.file}`)
    console.log('  现在可以放心提交了（这个文件是被 git 跟踪的）。')
    return 0
  }

  let secret = args.secret
  if (args.secretFile !== '') {
    try {
      secret = readFileSync(args.secretFile, 'utf-8').trim()
    } catch (error) {
      fail(`读不了 --secret-file 指向的文件：${error.message}`)
    }
  }
  if (args.host === '' && secret === '') fail('至少给 --host 或 --secret（或 --show / --clear）')

  let host = ''
  if (args.host !== '') {
    const normalized = normalizeHost(args.host)
    if (normalized.ok !== true) fail(normalized.error)
    host = normalized.host
  }
  if (secret !== '' && secret.length < MIN_SECRET) {
    fail(`密钥太短（${secret.length} 位，至少要 ${MIN_SECRET} 位）—— 是不是复制漏了？`)
  }
  if (/\s/.test(secret)) {
    fail('密钥里有空白字符 —— 多半是复制时带进了换行/空格（用 --secret-file 更稳）')
  }

  const xml = render({ host, secret })
  // 5.155b：写盘之前先自检 —— 注释里出现 `--` 会让 AGP 的 mergeResources 直接失败，
  // 而那个错（SAXParseException）看不出来是"注释里写了命令行参数"。
  const badComments = commentDoubleHyphens(xml)
  if (badComments.length > 0) {
    fail(`生成的 XML 注释里有连续两个连字符（XML 不允许，打包会失败）：`
      + `\n   第 ${badComments.map((one) => one.line).join(' / ')} 行：${badComments[0].body}`
      + '\n   改脚本里那段注释文字（别把命令行参数原样抄进注释）。')
  }
  console.log(`目标文件     ${args.file}`)
  console.log(`服务器地址   ${host === '' ? '（不写）' : host}`)
  console.log(`共享密钥     ${maskSecret(secret)}`)
  if (args.dryRun) {
    console.log('\n--dry-run：没有落盘。')
    return 0
  }
  writeFileSync(args.file, xml)
  console.log('\n✓ 已写入。接下来：')
  console.log('  ① 打包（APK 里会带上这两项，装完不用再填）')
  console.log('  ② 打包完成后 **还原**：node scripts/build-preset.mjs --clear')
  console.log('     （或 git checkout -- android/app/src/main/res/values/app_config.xml）')
  console.log('     ⚠️ 别把带密钥的版本提交上去 —— 那等于把密钥写进历史。')
  return 0
}

process.exit(main(process.argv.slice(2)))
