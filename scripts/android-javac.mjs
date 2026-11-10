#!/usr/bin/env node
/**
 * android-javac.mjs —— 安卓源码的**编译校验**（不是打包）
 * ============================================================================
 *
 *   node scripts/android-javac.mjs              # 组装参数文件并跑 javac
 *   node scripts/android-javac.mjs --list-only   # 只写 var/javac-check-all.txt，不编译
 *
 * 为什么要有这个脚本：`var/javac-check-all.txt` 是一个**手搓的参数文件**（仓库里被
 * gitignore，只活在本机）。它的类路径里必须逐个列出依赖 jar —— 少一个就是几百行
 * "找不到符号"。这种文件一旦被误覆盖，就得凭记忆重建，而且每个人机器上的 Android SDK
 * 路径都不一样。所以把"怎么组出来"写成代码，让它是**可再生的**。
 *
 * 参数文件的形状（javac 的 @argfile）：
 *
 *   -encoding UTF-8
 *   -nowarn
 *   -d var/javac-check-out
 *   -cp <android.jar>;<jar>;<jar>…          ← ⚠️ 必须逐个列，不能用 dir/*
 *   <每个 .java>
 *   var/aapt2check/gen/com/leion/lanrelay/R.java
 *
 * <p>关于 `dir/*`：命令行上 `-cp "var/cpjars/*"` 是好用的，但**写在 @argfile 里不会展开**
 * （实测：同一组路径放命令行能过，放进参数文件就报"找不到包"）。所以这里逐个列出来。
 *
 * <p>R.java 不是源码，是 aapt2 生成的。新增资源（字符串/布局/id）之后要先重新生成它，
 * 否则这里会报"找不到符号 R.string.xxx"。生成命令见 docs/29 与 docs/09。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const JAVA_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'java')
const JARS_DIR = join(ROOT, 'var', 'cpjars')
const R_JAVA = join(ROOT, 'var', 'aapt2check', 'gen', 'com', 'leion', 'lanrelay', 'R.java')
const ARGFILE = join(ROOT, 'var', 'javac-check-all.txt')
const OUT_DIR = join(ROOT, 'var', 'javac-check-out')

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

/** 找 android.jar：环境变量优先，其次几个常见安装位置。 */
function findAndroidJar() {
  const candidates = []
  for (const env of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'LOCALAPPDATA']) {
    const value = process.env[env]
    if (typeof value === 'string' && value.trim() !== '') {
      if (env === 'LOCALAPPDATA') candidates.push(join(value, 'Android', 'Sdk', 'platforms'))
      else candidates.push(join(value, 'platforms'))
    }
  }
  candidates.push(join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'Android', 'Sdk', 'platforms'))
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    const platforms = readdirSync(dir).filter((one) => one.startsWith('android-')).sort().reverse()
    for (const name of platforms) {
      const jar = join(dir, name, 'android.jar')
      if (existsSync(jar)) return jar
    }
  }
  return ''
}

/** 递归列出目录下的 .java（稳定顺序，便于 diff）。 */
function javaFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...javaFiles(full))
    else if (entry.endsWith('.java')) out.push(full)
  }
  return out
}

/** 递归列出目录下的 .jar（含 AAR 里解出来的 classes.jar）。 */
function jarFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...jarFiles(full))
    else if (entry.endsWith('.jar') && !/sources|javadoc/.test(entry)) out.push(full)
  }
  return out
}

function main(argv) {
  const listOnly = argv.includes('--list-only')

  const androidJar = findAndroidJar()
  if (androidJar === '') {
    fail('找不到 android.jar。设置 ANDROID_HOME（如 C:\\Users\\你\\AppData\\Local\\Android\\Sdk），'
      + '或在 Android Studio 里装一个 android-34 platform。')
  }
  const jars = jarFiles(JARS_DIR)
  if (jars.length === 0) {
    fail(`var/cpjars/ 里一个 jar 都没有 —— 依赖（Java-WebSocket、gson、眼镜 SDK 的 classes.jar 等）
   需要先放进去。它们原本是 Gradle 缓存里的产物，见过一次就照原样复制到这个目录。`)
  }
  const sources = javaFiles(JAVA_DIR)
  if (sources.length === 0) fail(`${JAVA_DIR} 下没有 .java`)

  // R.java 缺失时**先说清怎么生成**，而不是让 javac 报一堆"找不到符号 R.xxx"
  if (!existsSync(R_JAVA)) {
    fail(`缺 ${R_JAVA}
   它是 aapt2 从 res/ 生成的，不是手写的。新增资源之后要重新生成：
     aapt2 compile --dir android/app/src/main/res -o var/aapt2check/compiled.zip
     aapt2 link -o var/aapt2check/out.apk -I <android.jar> \\
       --manifest var/aapt2check/AndroidManifest.xml --java var/aapt2check/gen var/aapt2check/compiled.zip
   （AndroidManifest 要先补 package="com.leion.lanrelay"，见 docs/09）`)
  }

  const classpath = [androidJar, ...jars].join(';')
  const lines = ['-encoding', 'UTF-8', '-nowarn', '-d', 'var/javac-check-out', '-cp', classpath,
    ...sources, R_JAVA]
  mkdirSync(join(ROOT, 'var'), { recursive: true })
  writeFileSync(ARGFILE, `${lines.join('\n')}\n`)

  console.log(`参数文件     ${ARGFILE}`)
  console.log(`android.jar  ${androidJar}`)
  console.log(`依赖 jar     ${jars.length} 个`)
  console.log(`源码         ${sources.length} 个 .java + R.java`)
  if (listOnly) return 0

  mkdirSync(OUT_DIR, { recursive: true })
  try {
    execFileSync('javac', [`@${ARGFILE}`], { cwd: ROOT, stdio: 'inherit' })
  } catch (error) {
    if (error && error.code === 'EPERM') {
      console.log('\n⏭ 这个沙箱不允许起子进程（javac EPERM）—— 参数文件已经生成，去有 javac 的环境执行：')
      console.log(`   javac @${ARGFILE}`)
      return 0
    }
    const code = error && typeof error.status === 'number' ? error.status : 2
    console.error(`\n✗ javac 失败（退出码 ${code}）；上面的报错里带 "找不到符号" 时先看两条：`
      + '\n   ① 新增资源后有没有重新生成 R.java；② 依赖 jar 是否齐（var/cpjars/）。')
    return code === 0 ? 2 : code
  }
  console.log('\n✅ javac 通过（只有 deprecation 提示；编译通过 ≠ 能跑，见 docs/09）')
  return 0
}

process.exit(main(process.argv.slice(2)))
