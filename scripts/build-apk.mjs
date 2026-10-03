/**
 * build-apk.mjs —— 构建安卓 APK（省得你去翻 gradle 在哪）
 * ============================================================================
 *   node scripts/build-apk.mjs
 *
 * 按顺序找 gradle：环境变量 GRADLE_BIN → PATH 上的 gradle → ~/.gradle 里已下载的发行版。
 * 找不到就明确告诉你去用 Android Studio。
 *
 * 两个已知的坑（都在安卓 README 里写了）：
 *   · Gradle 要写工作区之外的 ~/.gradle 与 ~/.android/debug.keystore —— 在受限沙箱里
 *     会以「Could not initialize native services」失败，要在普通终端里跑；
 *   · 依赖没全在本地缓存时会联网下载（AGP 的传递依赖）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '')
const ANDROID_DIR = join(ROOT, 'android')
const APK = join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')

/** 在 ~/.gradle/wrapper/dists 里找已下载的 gradle 发行版。
 *  目录层级不固定（dists/<发行版>/<哈希>/gradle-8.6/bin/），所以递归找，不猜层数。 */
function findCachedGradle(maxDepth = 5) {
  const dists = join(homedir(), '.gradle', 'wrapper', 'dists')
  if (!existsSync(dists)) return null
  const exe = process.platform === 'win32' ? 'gradle.bat' : 'gradle'
  const walk = (dir, depth) => {
    if (depth > maxDepth) return null
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    // 先看这一层有没有 bin/gradle —— 命中就返回，不再往下钻
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === 'bin') {
        const candidate = join(dir, 'bin', exe)
        if (existsSync(candidate)) return candidate
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const found = walk(join(dir, entry.name), depth + 1)
      if (found !== null) return found
    }
    return null
  }
  return walk(dists, 0)
}

function resolveGradle() {
  if (process.env.GRADLE_BIN && existsSync(process.env.GRADLE_BIN)) return process.env.GRADLE_BIN
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['gradle'], { encoding: 'utf-8' })
  if (probe.status === 0 && probe.stdout.trim() !== '') return probe.stdout.trim().split('\n')[0].trim()
  return findCachedGradle()
}

if (!existsSync(ANDROID_DIR)) {
  console.error('[apk] 找不到 android/ 目录')
  process.exit(1)
}

const gradle = resolveGradle()
if (gradle === null) {
  console.error('[apk] 没找到 gradle。三个办法：')
  console.error('      1) 用 Android Studio 打开 android/ 目录，直接点 Run（最省事）')
  console.error('      2) 装一个 gradle 并放进 PATH')
  console.error('      3) 设环境变量 GRADLE_BIN 指向 gradle 可执行文件')
  console.error('      找过的地方：$GRADLE_BIN、PATH，以及 ' + join(homedir(), '.gradle', 'wrapper', 'dists'))
  process.exit(1)
}
console.log('[apk] 用 gradle：' + gradle)

// 注意：Windows 上直接 spawn 一个 .bat 需要 shell；而 shell + 参数数组的组合会触发
// Node 的 DEP0190 警告（参数只做拼接、不做转义），所以整条命令按一个字符串传。
const result = spawnSync(`"${gradle}" assembleDebug --console=plain`, {
  cwd: ANDROID_DIR,
  stdio: 'inherit',
  shell: true,
})

if (result.status !== 0) {
  console.error('\n[apk] 构建失败（退出码 ' + result.status + '）')
  console.error('      常见原因：')
  console.error('      · 「Could not initialize native services」→ 在受限沙箱里跑的，换普通终端')
  console.error('      · 依赖下载失败 → 检查网络')
  process.exit(result.status ?? 1)
}

if (!existsSync(APK)) {
  console.error('[apk] 构建报成功但没找到 APK：' + APK)
  process.exit(1)
}

const size = statSync(APK).size
console.log('')
console.log('─'.repeat(68))
console.log('  APK 已产出')
console.log('─'.repeat(68))
console.log('  ' + APK)
console.log(`  ${(size / 1024).toFixed(1)} KB`)
console.log('')
console.log('  装到手机（USB 连着且开了 USB 调试）：')
console.log('      adb install -r "' + APK + '"')
console.log('  或者把这个 apk 传到手机上点开安装')
console.log('─'.repeat(68))
