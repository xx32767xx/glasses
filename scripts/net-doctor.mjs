/**
 * net-doctor.mjs —— 手机连不上电脑时，按顺序把"卡在哪一环"问清楚
 * ============================================================================
 *   node scripts/net-doctor.mjs                # 体检
 *   node scripts/net-doctor.mjs --port 8788    # 换端口
 *
 * 为什么需要它：换一次网络（家里的 WiFi → 校园网 → 手机热点）就会踩同一批坑，
 * 而每次表现都是同一句话"连接超时"，看不出是哪一环。这个脚本把这四件事分开报：
 *
 *   ① 电脑现在的地址是什么、该往手机上填哪个   ← 换了网络地址就变了，填旧的必然超时
 *   ② 手机和电脑是不是同一个网段               ← 跨网段的话怎么改都连不上
 *   ③ 转发进程到底有没有在听那个端口           ← 没起来的话也不是网络问题
 *   ④ Windows 防火墙允不允许外部连进来         ← Public 网络默认阻止入站，校园网多是 Public
 *
 * 第 ④ 项要读系统的防火墙规则，需要管理员权限；读不到时会明确说"没读到"，
 * 不会假装检查过了。
 */

import { connect } from 'node:net'
import { execFile, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export function parseArgs(argv) {
  const options = { port: 8788, watch: false }
  const takesValue = new Set(['port'])
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help') { options.help = true; continue }
    if (token === '--watch') { options.watch = true; continue }
    if (!token.startsWith('--')) throw new Error(`看不懂的参数：${token}（用 --help 看用法）`)
    const key = token.slice(2)
    if (!takesValue.has(key)) throw new Error(`未知选项 --${key}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    index += 1
    options[key] = Number(value)
  }
  return options
}

/** 这些网卡连不上手机（虚拟网卡 / 蓝牙 / 回环），要从候选里剔掉。 */
const VIRTUAL_HINTS = ['vmware', 'virtualbox', 'hyper-v', 'vethernet', 'loopback',
  'bluetooth', 'tap', 'tun', 'zerotier', 'wsl', 'docker', 'npcap']

/**
 * Tailscale 单独归一类。
 *
 * <p>它虽然也是虚拟网卡，但**恰恰是可以填的那个** —— 而且校园网这种
 * "手机和电脑不在同一网段、设备之间还不许互访"的环境里，它常常是唯一稳的路。
 * 早先它混在 VIRTUAL_HINTS 里被标成"别填这个"，等于把最该试的地址藏起来了。
 */
const TAILSCALE_HINT = 'tailscale'

/** 100.64.0.0/10：Tailscale（以及运营商级 NAT）用的地址段。 */
export function inTailscaleRange(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4) return false
  const first = Number(parts[0])
  const second = Number(parts[1])
  return first === 100 && second >= 64 && second <= 127
}

/** 是不是 Tailscale 的地址（按网卡名或按地址段判断，两者任一命中都算）。 */
export function isTailscale(name, address = '') {
  if (String(name).toLowerCase().includes(TAILSCALE_HINT)) return true
  return inTailscaleRange(address)
}

export function isVirtual(name, address = '') {
  // Tailscale 不算"别填"这一类 —— 它由 isTailscale 单独表示
  if (isTailscale(name, address)) return false
  const lowered = String(name).toLowerCase()
  return VIRTUAL_HINTS.some(hint => lowered.includes(hint))
}

/** 把 IP + 掩码算出网段（用来判断"手机和电脑是不是一回事")。 */
export function network(ip, mask) {
  const toInt = value => value.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
  const value = (toInt(ip) & toInt(mask)) >>> 0
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

/** 收集本机所有可用的 IPv4（含是否虚拟、网段、掩码位数）。 */
export function collectAddresses(interfaces = networkInterfaces()) {
  const out = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue      // APIPA：没拿到 DHCP，不能用
      const mask = entry.netmask
      const bits = mask.split('.').reduce((acc, part) => acc + (Number(part).toString(2).split('1').length - 1), 0)
      const tailscale = isTailscale(name, entry.address)
      out.push({
        name,
        address: entry.address,
        netmask: mask,
        bits,
        network: network(entry.address, mask),
        virtual: isVirtual(name, entry.address),
        tailscale,
      })
    }
  }
  return out
}

/**
 * 连接探测。**不能用"试着 listen 一下"**：Windows 上 libuv 默认开 SO_REUSEADDR，
 * bind 到别人正在监听的端口也会成功，探测永远返回"空闲"（这个项目踩过）。
 */
export function probe(address, port, timeoutMs = 700) {
  return new Promise(resolve => {
    const socket = connect({ host: address, port })
    const done = ok => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 读 Windows 防火墙的入站规则，判断"外部能不能连进来"。
 *
 * 只看两件事（够用了）：
 *   · 有没有一条明确放行本端口的入站规则
 *   · 有没有一条放行 Node.js 的入站规则，且覆盖 TCP、覆盖 Private/Public
 * 校园网通常被判成 Public，而 Public 默认阻止入站 —— 这是"同一台电脑在家里能用、
 * 到学校就不行"的最常见原因。
 */
export function judgeFirewall(text, port) {
  // ⚠️ netsh 每条规则的排版是「先 Rule Name，再一行短横线，然后才是这条规则的字段」，
  //    所以**不能**按短横线切块再把块里的名字当成本块的规则名 —— 那样会整体错位一格，
  //    表现是"最后一条规则永远读不到"，而防火墙问题恰恰常常就出在那条上。
  //    正确做法是按 `Rule Name:` 切：
  const parts = String(text).split(/^(?=Rule Name:)/m)
  const verdict = { portRule: null, nodeRules: [], readable: true }

  for (const part of parts) {
    const name = ((part.match(/Rule Name:\s*(.+)/) ?? [])[1] ?? '').trim()
    if (name === '') continue
    const enabled = /Enabled:\s*Yes/.test(part)
    const inbound = /Direction:\s*In\b/.test(part)
    const allow = /Action:\s*Allow/.test(part)
    const profiles = ((part.match(/Profiles:\s*(.+)/) ?? [])[1] ?? '').trim()
    const protocol = ((part.match(/Protocol:\s*(.+)/) ?? [])[1] ?? '').trim()
    const localPort = ((part.match(/LocalPort:\s*(.+)/) ?? [])[1] ?? '').trim()
    const record = { name, enabled, inbound, allow, profiles, protocol, localPort }

    const usable = enabled && inbound && allow
    if (usable && localPort === String(port)) verdict.portRule = record
    if (/Node\.js|node\.exe/i.test(name)) verdict.nodeRules.push(record)
  }

  verdict.nodeAllowsTcp = verdict.nodeRules.some(rule =>
    rule.enabled && rule.inbound && rule.allow
    && (rule.protocol === 'Any' || rule.protocol === 'TCP')
    && /Private|Public/.test(rule.profiles))
  verdict.ok = verdict.portRule !== null || verdict.nodeAllowsTcp
  return verdict
}

/**
 * 跑一个外部命令并拿到它的输出。
 *
 * 先试普通的管道读取；在被限制的环境里（管道会被拦，spawn EPERM）改成
 * **重定向到文件再读** —— 不是管道，所以照样能拿到结果，而不是只能报一句"读不到"。
 */
export async function runCapture(command, args) {
  try {
    const { stdout } = await run(command, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch (error) {
    const dir = join(ROOT, 'var', 'cache', 'net-doctor')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'capture.txt')
    const handle = openSync(target, 'w')
    const result = spawnSync(command, args, { stdio: ['ignore', handle, handle], windowsHide: true })
    closeSync(handle)
    if (result.error) throw result.error
    return readFileSync(target, 'utf8')
  }
}

export async function readFirewall(port) {
  try {
    return { ok: true, verdict: judgeFirewall(await runCapture('netsh',
      ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in']), port) }
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) }
  }
}

/**
 * 数一数"有没有从别的机器连到本端口"。
 *
 * 为什么还要这一条：正在跑的转发进程可能是**旧版本**，它的 /status 里没有
 * connections 计数（这个字段是新加的）。这时候看 netstat 一样能判断：
 *   · 手机发来的 SYN 到了电脑 → netstat 里会出现一条非 LISTENING、来源不是 127.0.0.1 的连接
 *   · 什么都没有 → 包根本没到（防火墙挡了，或者校园网不允许设备互访）
 * 手机连不上时它自己什么都说不了，所以这个判断只能在电脑这边做。
 */
/** 从 netstat -an 的输出里数"外来连接"（纯函数，便于测试）。 */
export function countForeign(text, port) {
  const lines = String(text).split(/\r?\n/).filter(line => line.includes(':' + port))
  const foreign = lines.filter(line =>
    !/LISTENING/i.test(line) && !/127\.0\.0\.1:/.test(line) && !/\[::1\]:/.test(line))
  return { ok: true, listening: lines.some(line => /LISTENING/i.test(line)), foreign: foreign.length }
}

export async function foreignConnections(port) {
  try {
    return countForeign(await runCapture('netstat', ['-an']), port)
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) }
  }
}

/**
 * 该往手机上填的地址。
 *
 * 优先级：局域网真实网卡 → （没有局域网时才）Tailscale。
 * Tailscale 单独用 `tailscale` 标出来，因为它的**前置条件不一样**：
 * 手机上也必须开着 Tailscale 并且登录同一账号，否则填了也是超时。
 */
export function pickPhoneAddress(addresses) {
  const tailscale = addresses.filter(item => item.tailscale)
  const real = addresses.filter(item => !item.virtual && !item.tailscale)
  if (real.length === 1) {
    return { address: real[0], multiple: false, tailscale: false, tailscaleCandidate: tailscale[0] ?? null }
  }
  if (real.length > 1) {
    // 多个真实网卡（有线 + 无线同时连着）：不知道手机在哪一边，让用户自己挑
    return { address: real[0], multiple: true, candidates: real, tailscale: false,
      tailscaleCandidate: tailscale[0] ?? null }
  }
  // 一个可用的局域网地址都没有 —— 那就只能靠 Tailscale 了
  if (tailscale.length > 0) {
    return { address: tailscale[0], multiple: false, tailscale: true, tailscaleCandidate: tailscale[0] }
  }
  return { address: null, multiple: false, candidates: [], tailscale: false, tailscaleCandidate: null }
}

/**
 * --watch：盯着"有没有连进来"，用来分辨**包被挡在外面**还是**应用层的问题**。
 *
 * 用法：跑起来，然后在手机上点「连接」。
 *   · 计数 +1      → 网络路径是通的，问题在应用层（地址/端口/配对码）
 *   · 计数不动     → SYN 根本没到进程：防火墙挡了，或者校园网禁止设备互访
 *
 * 为什么必须由电脑本地来看：手机连不上时它自己什么都问不出来。
 */
async function watch(options) {
  const secretPath = join(ROOT, 'var', 'live', 'relay-secret.txt')
  let secret = ''
  try {
    secret = readFileSync(secretPath, 'utf8').trim()
  } catch {
    console.log(`读不到共享密钥（${secretPath}）—— 转发进程还没起来过？`)
    return
  }
  const url = `http://127.0.0.1:${options.port}/status?secret=${encodeURIComponent(secret)}`
  let baseline = null
  let previous = null
  let useStatusCounter = true
  console.log('')
  console.log(`盯着 ${options.port} 端口：**现在去手机上点「连接」**，看下面的计数会不会动。`)
  console.log('  动   → 网络路径是通的，问题在应用层（地址/端口/配对码）')
  console.log('  不动 → 包根本没到电脑：防火墙挡了，或校园网禁止设备互访')
  console.log('  （Ctrl-C 结束）')
  console.log('')
  for (;;) {
    if (useStatusCounter) {
      try {
        const response = await fetch(url)
        const status = await response.json()
        if (status.connections === undefined) {
          // 正在跑的转发进程是旧版本，没有这个计数 —— 改用 netstat 看
          useStatusCounter = false
          console.log('  （转发进程是旧版本，没有连接计数；改用 netstat 看外来连接）')
        } else {
          const connections = Number(status.connections)
          if (baseline === null) {
            baseline = connections
            console.log(`  起始：累计连接 ${connections}，当前在线 ${Number(status.sockets ?? 0)}`)
          } else if (connections !== previous) {
            console.log(`  ✓ 有连接进来了：累计 ${connections}（+${connections - baseline}）`
              + ` 最近一次 ${status.lastConnectionAt}`)
          }
          previous = connections
        }
      } catch (error) {
        console.log(`  取不到 /status：${String(error && error.message ? error.message : error)}`
          + '（转发进程没在跑？）')
      }
    } else {
      const seen = await foreignConnections(options.port)
      if (seen.ok) {
        if (previous === null) {
          console.log(`  起始：外来连接 ${seen.foreign} 条，${seen.listening ? '端口在监听' : '端口没在监听'}`)
        } else if (seen.foreign !== previous) {
          console.log(`  ✓ 看到 ${seen.foreign} 条外来连接 —— 手机确实连到电脑了`)
        }
        previous = seen.foreign
      } else {
        console.log(`  看不了 netstat：${seen.reason}`)
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('用法：node scripts/net-doctor.mjs [--port 8788] [--watch]')
    return
  }
  if (options.watch) {
    await watch(options)
    return
  }

  const port = options.port
  const addresses = collectAddresses()
  const picked = pickPhoneAddress(addresses)

  console.log('')
  console.log('─'.repeat(70))
  console.log('  手机连不上电脑？按这四步看')
  console.log('─'.repeat(70))

  // ① 地址
  console.log('')
  console.log('① 电脑现在的地址（换网络后会变！手机上填旧的必然超时）')
  if (addresses.length === 0) {
    console.log('   ✗ 没有任何可用的 IPv4 地址 —— 网线/WiFi 没连上，或者没拿到 DHCP')
  }
  for (const item of addresses) {
    const tag = item.tailscale
      ? '  ← Tailscale（手机也要开着 Tailscale）'
      : item.virtual ? '  ← 虚拟网卡，**别填这个**' : ''
    const star = (item.virtual || item.tailscale) ? '·' : '★'
    console.log(`   ${star} ${item.name}`)
    console.log(`       ${item.address} / ${item.bits}    网段 ${item.network}/${item.bits}${tag}`)
  }
  if (picked.address !== null) {
    console.log('')
    console.log(`   手机上填：http://${picked.address.address}:${port}`)
    if (picked.multiple) {
      console.log('   ⚠️ 有多个真实网卡：手机连的是哪个 WiFi，就填那一行的地址')
    }
    if (picked.tailscale) {
      console.log('   ⚠️ 这是 Tailscale 地址：**手机上必须也开着 Tailscale 并登录同一账号**')
    }
    // 有局域网地址但也有 Tailscale 时，把备选一并给出 —— 校园网里局域网那条多半不通
    if (!picked.tailscale && picked.tailscaleCandidate) {
      console.log(`   若上面这个连不上（校园网常见），改用 Tailscale：`
        + `http://${picked.tailscaleCandidate.address}:${port}`)
    }
  }

  // ② 网段
  console.log('')
  console.log('② 手机和电脑必须在同一个网段')
  if (picked.address !== null && picked.tailscale) {
    console.log('   ✓ 走 Tailscale 时**不需要**同网段 —— 这正是它存在的意义')
  } else {
    if (picked.address !== null) {
      console.log(`   电脑在：${picked.address.network}/${picked.address.bits}`)
    }
    console.log('   手机上看：设置 → WLAN → 当前网络 → IP 地址，然后和上面比')
    console.log('   前几段不一样的，怎么改都连不上（校园网常把 WiFi 和有线分在不同 VLAN）')
  }

  // ③ 转发进程
  console.log('')
  console.log(`③ 转发进程有没有在听 ${port} 端口`)
  const loopback = await probe('127.0.0.1', port)
  console.log(`   127.0.0.1:${port}  ${loopback ? '✓ 有人在听' : '✗ 没人听 —— 先起 node scripts/start-all.mjs'}`)
  if (picked.address !== null) {
    const viaLan = await probe(picked.address.address, port)
    console.log(`   ${picked.address.address}:${port}  ${viaLan ? '✓ 也通（说明监听绑定在 0.0.0.0 上，没问题）'
      : '✗ 本机都连不上自己 —— 进程可能只绑在回环上'}`)
  }

  // ④ 防火墙
  console.log('')
  console.log('④ Windows 防火墙允不允许手机连进来（校园网多半被判成 Public）')
  const firewall = await readFirewall(port)
  if (!firewall.ok) {
    console.log(`   ? 读不到防火墙规则（多半需要管理员权限）：${firewall.reason.split('\n')[0]}`)
    console.log('     以管理员身份开一个 PowerShell，重新跑一次这个脚本')
  } else {
    const verdict = firewall.verdict
    for (const rule of verdict.nodeRules) {
      console.log(`   · 已有规则「${rule.name}」：${rule.profiles} / ${rule.protocol}`
        + ` / ${rule.enabled ? '已启用' : '已停用'}`)
    }
    if (verdict.ok) {
      console.log(`   ✓ 有入站放行规则（${verdict.portRule === null ? 'Node.js 程序规则覆盖 TCP + Private/Public'
        : '明确放行了本端口'}）`)
    } else {
      console.log('   ✗ 没有覆盖 TCP + Private/Public 的入站放行规则')
      console.log('     → 手机连进来会被防火墙丢掉，表现就是"连接超时"')
      console.log('')
      console.log('   **以管理员身份**开一个 PowerShell，粘这一条（只放行这一个端口，不用关防火墙）：')
      console.log(`     netsh advfirewall firewall add rule name="Leion 同传 ${port}" `
        + `dir=in action=allow protocol=TCP localport=${port} profile=private,public`)
    }
  }

  console.log('')
  console.log('─'.repeat(70))
  console.log('  ①②③④ 都过了还是超时 → 大概率是**校园网禁止设备互访**（AP 隔离）')
  console.log('  这不是电脑或代码的问题，换一条路。按这个顺序试：')
  console.log('    1. 电脑开移动热点，手机连它（零依赖，不需要外网，立刻可用）')
  console.log('       电脑在热点里固定是 192.168.137.1，手机上就填这个')
  console.log('       前提：网卡支持"同时连 WiFi + 开热点"；不支持就给电脑插网线')
  console.log('    2. Tailscale（不受拓扑影响，但**国内校园网有额外前提**，见下）')
  console.log('       · 安装器是 WiX bundle，走 **WinHTTP** 去下 MSI，而 WinHTTP 默认直连')
  console.log('         （浏览器走的是系统代理，所以"浏览器能下、安装器不能下"）')
  console.log('         → 报 0x80072efd 时，用浏览器直接下这个 MSI 再双击装：')
  console.log('           https://pkgs.tailscale.com/stable/tailscale-setup-<版本>-amd64.msi')
  console.log('       · ⚠️ 装上也未必能用：守护进程是 LocalSystem 服务，**不用浏览器代理**，')
  console.log('         而 login/controlplane.tailscale.com 在国内常被 DNS 污染。')
  console.log('         先在浏览器打开 https://login.tailscale.com/ 验证能不能通；')
  console.log('         能通再设**系统级** HTTPS_PROXY 然后重启 Tailscale 服务。')
  console.log('    3. 手机开热点，电脑连手机热点')
  console.log('       代价：电脑只有一块网卡时，连了热点就掉原来的网（翻译 API 要用网）')
  console.log('    4. 有一台国内公网服务器的话：frp/nps 把本端口穿透出去，手机连服务器')
  console.log('       （最稳，而且和"harness 搬到服务器上"的最终架构是同一条路）')
  console.log('  ⚠️ "手机 USB 共享网络给电脑"在本项目里**用不了**：')
  console.log('     手机的 USB 口被眼镜占着（眼镜就是 USB 连手机的）。')
  console.log('─'.repeat(70))
  console.log('')
}

// 入口判断要用 pathToFileURL 比 —— 手写 `file://${argv[1]}` 在 Windows 上永远不相等
// （import.meta.url 是 file:///E:/…，三个斜杠），脚本会一声不响地什么都不做。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('net-doctor 出错：' + String(error && error.message ? error.message : error))
    process.exitCode = 1
  })
}
