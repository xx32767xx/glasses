/**
 * app-preset-suite.mjs —— 「打包内置服务器地址与密钥」（5.155）
 * ============================================================================
 *
 * 老师的要求：打包时把服务器链接和密钥一起打进去，装完就能用。
 * 这条链路上有三处很容易出错，所以逐处钉住：
 *
 *   ① **只有一个入口**：代码里读出厂值的地方必须只有 {@code ServerPreset}。
 *      一旦某个页面自己 `getString(R.string.default_server_url)`，就会出现
 *      "首页用新地址、房间页还在旧地址"这种只有现场才发现的错。
 *   ② **优先级不能反**：用户存过的偏好优先于出厂值（否则现场换了服务器、
 *      重启一次又被打包值盖回去）。而且"只在空时写入"。
 *   ③ **仓库里不许带密钥**：`app_config.xml` 是 git 跟踪的文件，
 *      带密钥的版本提交上去等于把密钥写进历史。打包脚本写完之后必须 --clear。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { VAR_DIR } from '../lib/paths.mjs'

const ROOT = join(import.meta.dirname, '..')
const JAVA_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
const APP_CONFIG = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'app_config.xml')
const SCRIPT = join(ROOT, 'scripts', 'build-preset.mjs')

/** 用文件描述符接子进程输出（沙箱里管道捕获会 EPERM，照本仓库其它套件的老办法）。 */
function runToFile(args, outPath) {
  const fd = openSync(outPath, 'w')
  let failure = null
  try {
    execFileSync(process.execPath, args, { stdio: ['ignore', fd, fd] })
  } catch (error) {
    failure = error
  } finally {
    closeSync(fd)
  }
  return { failure, output: readFileSync(outPath, 'utf-8') }
}

/**
 * 取**已提交版本**的 app_config.xml。
 *
 * <p>为什么不是直接读工作区：打包流程就是"写进工作区 → 打包 → --clear"。
 * 工作区带密钥是**正常中间态**（用户知情、内部使用）；真正要拦的是
 * **把带密钥的版本提交上去** —— 那才叫写进历史。所以判据取 HEAD 里那份。
 *
 * <p>没有 git / 不是仓库时退回工作区，并在输出里说一句（不静默算过）。
 */
function committedConfig(outPath) {
  const fd = openSync(outPath, 'w')
  let failure = null
  try {
    execFileSync('git', ['-C', ROOT, 'show', 'HEAD:android/app/src/main/res/values/app_config.xml'],
      { stdio: ['ignore', fd, fd] })
  } catch (error) {
    failure = error
  } finally {
    closeSync(fd)
  }
  if (failure !== null) {
    console.log('  ⏭ 取不到 HEAD 里的 app_config.xml（没有 git？），退回看工作区')
    return readFileSync(APP_CONFIG, 'utf-8')
  }
  return readFileSync(outPath, 'utf-8')
}

export async function runAppPresetSuite({ it, check }) {
  await it('5.155：出厂服务器只有一个入口（ServerPreset），页面不许各读各的', () => {
    const preset = readFileSync(join(JAVA_DIR, 'ServerPreset.java'), 'utf-8')
    check('有 ServerPreset', /public final class ServerPreset/.test(preset))
    check('地址与密钥各有取值函数（prefs → 出厂值 → 空）',
      /public static String host\(Context context\)/.test(preset)
      && /public static String secret\(Context context\)/.test(preset))
    check('用户存过的优先（否则现场换服务器会被打包值盖回去）',
      /String stored = stored\(context, "host"\);\s*\n\s*return stored\.isEmpty\(\) \? packagedHost\(context\) : stored;/.test(preset))
    check('落进偏好时只在空时写（不覆盖用户改过的值）',
      /storedHost\.isEmpty\(\)/.test(preset) && /storedSecret\.isEmpty\(\)/.test(preset))
    check('真有内置值时才写（缺一个都不算"装完即用"）',
      /public static boolean packaged\(Context context\)/.test(preset))

    // 页面侧：只许通过 ServerPreset 取，不许再各自摸资源
    for (const name of ['HomeActivity', 'MeActivity', 'InterpreterActivity', 'RoomActivity']) {
      const source = readFileSync(join(JAVA_DIR, `${name}.java`), 'utf-8')
      check(`${name} 用 ServerPreset 取地址`, /ServerPreset\.(host|secret|seedInto)\(/.test(source))
      check(`${name} 自己不再读出厂值资源`,
        !/R\.string\.default_server_url/.test(source) && !/R\.string\.default_shared_secret/.test(source))
    }
    // 首页要在启动时把出厂值落进偏好 —— 房间页/历史页那些直接读偏好的地方靠它
    const home = readFileSync(join(JAVA_DIR, 'HomeActivity.java'), 'utf-8')
    check('首页启动时落一次（seedInto）', /ServerPreset\.seedInto\(this\)/.test(home))
  })

  await it('5.155：写进仓库的那份必须是"出厂空密钥"（本机打包时可以有意填上）', () => {
    const dir = join(VAR_DIR, 'tmp', 'app-preset')
    mkdirSync(dir, { recursive: true })
    const committed = committedConfig(join(dir, 'head-config.xml'))
    const working = readFileSync(APP_CONFIG, 'utf-8')
    check('工作区与已提交版本结构一致（都有这两项）',
      /name="default_server_url"/.test(working) && /name="default_shared_secret"/.test(working)
      && /name="default_server_url"/.test(committed) && /name="default_shared_secret"/.test(committed))

    // 核心判据：**已提交的**那份不许带密钥（带密钥的版本提交上去等于写进 git 历史）
    const secret = /<string name="default_shared_secret"[^>]*>([\s\S]*?)<\/string>/.exec(committed)
    check('已提交版本里的密钥是空的', secret !== null && secret[1].trim() === '',
      secret === null ? '找不到该项' : `实际是 ${secret[1].length} 位`)
    const host = /<string name="default_server_url"[^>]*>([\s\S]*?)<\/string>/.exec(committed)
    check('已提交版本里的地址是空串或 http(s) 开头',
      host !== null && (host[1].trim() === '' || /^https?:\/\//.test(host[1].trim())),
      host === null ? '找不到该项' : host[1].trim())

    // 工作区带密钥 = 打包中间态，允许；但要能说出来（否则下一个人以为是脏数据）
    const workingSecret = /<string name="default_shared_secret"[^>]*>([\s\S]*?)<\/string>/.exec(working)
    if (workingSecret !== null && workingSecret[1].trim() !== '') {
      console.log(`  ⚠️ 本工作区已写入打包密钥（${workingSecret[1].trim().length} 位，未提交）`
        + ' —— 打完包记得 node scripts/build-preset.mjs --clear')
    }
    check('注释里写清了"密钥会随 APK 公开"这件事',
      /反编译/.test(working) && /token/.test(working))
  })

  await it('5.155：打包脚本能写/能查/能还原（密钥打码，不整串外露）', () => {
    check('脚本在', existsSync(SCRIPT))
    const dir = join(VAR_DIR, 'tmp', 'app-preset')
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'app_config.xml')
    const logPath = join(dir, 'out.txt')

    // ① 写入：地址尾部斜杠被规范掉，密钥落进文件
    const write = runToFile([SCRIPT, '--file', target, '--host', 'http://10.60.107.47:8788/',
      '--secret', '0123456789abcdef0123456789abcdef'], logPath)
    check('写入成功', write.failure === null, String(write.failure?.message ?? ''))
    check('终端里密钥是打码的（不把整串打到日志/历史里）',
      !write.output.includes('0123456789abcdef0123456789abcdef')
      && /cdef（32 位）/.test(write.output), write.output.slice(0, 200))
    const written = readFileSync(target, 'utf-8')
    check('地址去掉了尾部斜杠',
      /default_server_url[^>]*>http:\/\/10\.60\.107\.47:8788</.test(written),
      /default_server_url[^>]*>([^<]*)</.exec(written)?.[1] ?? '')
    check('密钥进了文件', /default_shared_secret[^>]*>0123456789abcdef0123456789abcdef</.test(written))
    check('写完后提醒还原（否则会被提交）', /--clear/.test(write.output))

    // ② --show：重新读回来（这是运维要知道"这个包装的是哪台服务器"的唯一办法）
    const show = runToFile([SCRIPT, '--file', target, '--show'], logPath)
    check('--show 能读回地址', /10\.60\.107\.47:8788/.test(show.output), show.output.slice(0, 160))
    check('--show 里密钥仍然打码', !show.output.includes('0123456789abcdef0123456789abcdef'))

    // ③ --clear：还原成空（提交前必做）
    const clear = runToFile([SCRIPT, '--file', target, '--clear'], logPath)
    check('--clear 成功', clear.failure === null, String(clear.failure?.message ?? ''))
    const cleared = readFileSync(target, 'utf-8')
    check('还原后密钥为空', /default_shared_secret[^>]*>\s*</.test(cleared), cleared.slice(-200))

    // ④ 参数校验：错的东西不许静默写进去
    const badHost = runToFile([SCRIPT, '--file', target, '--host', '10.60.107.47:8788'], logPath)
    check('地址不带 http(s):// 要被拒', badHost.failure !== null
      && /http:\/\//.test(badHost.output), badHost.output.slice(0, 160))
    const shortSecret = runToFile([SCRIPT, '--file', target, '--secret', 'abc'], logPath)
    check('太短的密钥要被拒（多半是复制漏了）', shortSecret.failure !== null
      && /至少要 16 位/.test(shortSecret.output), shortSecret.output.slice(0, 160))
    const nothing = runToFile([SCRIPT, '--file', target], logPath)
    check('什么都不给要说清怎么用', nothing.failure !== null && /--host/.test(nothing.output))
    // 被拒之后文件不该被动过（上面两次失败调用不能留下半截内容）
    const afterFailures = readFileSync(target, 'utf-8')
    check('失败的调用不落盘', /default_shared_secret[^>]*>\s*</.test(afterFailures))
  })
}
