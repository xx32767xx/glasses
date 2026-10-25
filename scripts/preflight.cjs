#!/usr/bin/env node
/**
 * preflight.cjs —— 在跑任何 .mjs 之前先体检（**故意写成老语法**）
 *
 * 为什么不用 .mjs、也不用现代语法：
 *   项目里的 .mjs 用了 `??`、`?.`，Node 12 一加载就报
 *   `SyntaxError: Unexpected token '?'`，而且报错在**解析阶段**，
 *   文件里写任何"友好的提示"都没机会执行。
 *   所以这个文件只用 ES2015 以内的语法（const/let/箭头函数/模板串都不用），
 *   Node 4 以上都能跑；它自己就能用大白话告诉你"你的 Node 太旧"。
 *
 * 用法：
 *   node scripts/preflight.cjs              # 静态检查
 *   npm start                               # package.json 的 prestart 会自动先跑它
 *
 * 它查什么：
 *   ① Node 版本（项目要 ≥ 20；Ubuntu 22.04 用 apt 装的 nodejs 是 12.22，这是最常见的原因）
 *   ② python3 在不在（识别要靠它）
 *   ③ 数据目录能不能写
 *   ④ 端口有没有被占
 *   ⑤ 模型缓存里有没有 large-v3（没有的话第一次识别会先去下 2.9 GB，看起来像卡住）
 *
 * 只做检查，不改任何东西。有问题退出码非 0。
 */

'use strict'

var fs = require('fs')
var path = require('path')
var net = require('net')
var childProcess = require('child_process')

var problems = 0
var MIN_NODE_MAJOR = 20

function ok(label, detail) {
  console.log('  [OK]   ' + label + (detail ? '：' + detail : ''))
}

function bad(label, howToFix) {
  problems += 1
  console.log('  [FAIL] ' + label)
  if (howToFix) {
    for (var i = 0; i < howToFix.length; i++) {
      console.log('         ' + howToFix[i])
    }
  }
}

function warn(label, detail) {
  console.log('  [WARN] ' + label + (detail ? '：' + detail : ''))
}

// ── ① Node 版本 ─────────────────────────────────────────────────────────────
function checkNode() {
  console.log('① Node 版本')
  var major = parseInt(String(process.versions.node).split('.')[0], 10)
  if (isNaN(major) || major < MIN_NODE_MAJOR) {
    bad('当前 Node ' + process.versions.node + '，项目要 ≥ ' + MIN_NODE_MAJOR,
      ['否则一跑 .mjs 就报 SyntaxError: Unexpected token \'?\'（这是空值合并语法，Node 14 才有）',
        'Ubuntu 22.04 用 apt 装的 nodejs 是 12.22 —— 正是这个坑。装新版：',
        '  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -',
        '  sudo apt install -y nodejs',
        '装完 node -v 必须显示 v20.x 或更高（可能要 sudo apt purge nodejs 先卸掉旧的）'])
    return false
  }
  ok('Node ' + process.versions.node)
  return true
}

// ── ② python3 ──────────────────────────────────────────────────────────────
function firstLine(text) {
  return String(text || '').split('\n')[0].slice(0, 120)
}

function checkPython() {
  console.log('② python3（识别进程要用）')
  var result = null
  try {
    result = childProcess.spawnSync('python3', ['--version'], { encoding: 'utf8' })
  } catch (error) {
    result = { error: error }
  }
  if (result && result.error) {
    // 有些受限环境（沙箱/容器）不允许起子进程抓输出。那不是用户的问题，别误报成"没装 python3"。
    warn('查不了（' + (result.error.code || result.error.message) + '）', '这个环境不允许起子进程')
    return true
  }
  if (!result || result.status !== 0) {
    // 有些机器只有 python（没有 python3 这个别名）
    var fallback = null
    try {
      fallback = childProcess.spawnSync('python', ['--version'], { encoding: 'utf8' })
    } catch (error2) {
      fallback = { error: error2 }
    }
    if (fallback && !fallback.error && fallback.status === 0) {
      warn('没有 python3，但有 python', firstLine(fallback.stdout || fallback.stderr))
      warn('bridge/asr-bridge.mjs 起识别时用的就是 PATH 里的 python，所以能跑；但建议装 python3')
      return true
    }
    bad('找不到 python3', ['sudo apt install -y python3 python3-venv python3-pip',
      '识别进程 bridge/asr-bridge.mjs 靠 PATH 里的 python 起，装完再跑'])
    return false
  }
  var version = firstLine(result.stdout || result.stderr)
  ok(version)
  var pieces = version.replace('Python', '').trim().split('.')
  var major = parseInt(pieces[0], 10)
  var minor = parseInt(pieces[1], 10)
  if (major < 3 || (major === 3 && minor < 8)) {
    warn('Python 偏旧（' + version + '）：faster-whisper 一般要 3.8+，3.10/3.12 是验证过的')
  }
  return true
}

// ── ③ 数据目录 ─────────────────────────────────────────────────────────────
function checkDataDir(dir) {
  console.log('③ 数据目录 ' + dir)
  try {
    fs.mkdirSync(dir, { recursive: true })
    var probe = path.join(dir, '.preflight-probe')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    ok('可写')
    return true
  } catch (error) {
    bad('写不进去：' + error.message, [
      'sudo mkdir -p ' + dir + ' && sudo chown $USER ' + dir,
      '（或者换一个 --data-dir）'])
    return false
  }
}

// ── ④ 端口 ────────────────────────────────────────────────────────────────
function checkPort(port) {
  return new Promise(function (resolve) {
    console.log('④ 端口 ' + port)
    var server = net.createServer()
    server.once('error', function (error) {
      if (error.code === 'EADDRINUSE') {
        bad('端口 ' + port + ' 已被占', [
          'ss -lntp | grep ' + port + '  看是谁',
          '旧进程没停干净：杀掉它，或者换一个 --port'])
      } else {
        bad('端口检查失败：' + error.message, [])
      }
      resolve(false)
    })
    server.once('listening', function () {
      server.close(function () {
        ok('空闲')
        resolve(true)
      })
    })
    server.listen(port, '0.0.0.0')
  })
}

// ── ⑤ 模型缓存 ─────────────────────────────────────────────────────────────
function checkModel(dest, model) {
  console.log('⑤ 模型缓存 ' + dest)
  var snapshotDir = path.join(dest, 'hub')
  var found = null
  try {
    var names = fs.readdirSync(snapshotDir)
    for (var i = 0; i < names.length; i++) {
      if (names[i].indexOf('faster-whisper-' + model) >= 0) {
        found = names[i]
        break
      }
    }
  } catch (error) {
    found = null
  }
  if (found) {
    ok('已有 ' + model + '（' + found + '）')
    return true
  }
  warn('没找到 ' + model, '第一次识别会去下载约 2.9 GB，看起来像卡住；先下：python3 scripts/fetch-model.py ' +
    model + ' --mirror')
  return true
}

function parseArgs(argv) {
  var options = { port: 8788, dataDir: 'var/live', model: 'large-v3',
    hfHome: process.env.HF_HOME || 'var/cache/hf' }
  for (var i = 0; i < argv.length; i++) {
    var key = argv[i]
    if (key === '--port') { options.port = Number(argv[++i]) }
    else if (key === '--data-dir') { options.dataDir = argv[++i] }
    else if (key === '--model') { options.model = argv[++i] }
    else if (key === '--hf-home') { options.hfHome = argv[++i] }
    else if (key === '-h' || key === '--help') {
      console.log('用法: node scripts/preflight.cjs [--port 8788] [--data-dir var/live]')
      console.log('      [--model large-v3] [--hf-home var/cache/hf]')
      process.exit(0)
    }
  }
  return options
}

async function main() {
  var options = parseArgs(process.argv.slice(2))
  console.log('亮亮眼镜 · 启动前体检（只检查，不改任何东西）')
  console.log('')
  var nodeOk = checkNode()
  checkPython()
  checkDataDir(options.dataDir)
  await checkPort(options.port)
  checkModel(options.hfHome, options.model)
  console.log('')
  if (!nodeOk) {
    console.log('先把 Node 版本搞对，再往下走 —— 后面的 .mjs 脚本都依赖它。')
    process.exit(2)
  }
  if (problems > 0) {
    console.log('有 ' + problems + ' 个问题要处理（见上面的 [FAIL]）。')
    process.exit(1)
  }
  console.log('体检通过，可以启动：node scripts/start-all.mjs …')
}

main()
