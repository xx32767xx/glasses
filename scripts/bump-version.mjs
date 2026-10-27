#!/usr/bin/env node
// bump-version.mjs —— 每次提交前把安卓版本号 +1，确保装到手机上的是最新构建。
//   node scripts/bump-version.mjs            # versionCode +1，versionName 次版本 +1（4.17 → 4.18）
//   node scripts/bump-version.mjs --dry-run  # 只打印将变成什么
//   node scripts/bump-version.mjs --major    # 主版本 +1（4.x → 5.0），次版本归零
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = join('android', 'app', 'build.gradle.kts')

export function bump(versionCode, versionName, major = false) {
  const nextCode = Number(versionCode) + 1
  const parts = String(versionName).split('.').map((n) => Number(n))
  const majorPart = Number.isFinite(parts[0]) ? parts[0] : 0
  const minorPart = Number.isFinite(parts[1]) ? parts[1] : 0
  const nextName = major ? `${majorPart + 1}.0` : `${majorPart}.${minorPart + 1}`
  return { versionCode: nextCode, versionName: nextName }
}

export function applyBump(text, options = {}) {
  const codeMatch = text.match(/versionCode = (\d+)/)
  const nameMatch = text.match(/versionName = "([^"]+)"/)
  if (!codeMatch || !nameMatch) throw new Error('build.gradle.kts 里找不到 versionCode/versionName')
  const next = bump(codeMatch[1], nameMatch[1], options.major === true)
  let out = text
    .replace(/versionCode = \d+/, `versionCode = ${next.versionCode}`)
    .replace(/versionName = "[^"]+"/, `versionName = "${next.versionName}"`)
  return { text: out, from: { versionCode: Number(codeMatch[1]), versionName: nameMatch[1] }, to: next }
}

if (process.argv[1] && process.argv[1].endsWith('bump-version.mjs')) {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry-run')
  const major = args.includes('--major')
  const original = readFileSync(FILE, 'utf-8')
  const result = applyBump(original, { major })
  console.log(`${result.from.versionName}(${result.from.versionCode}) → ${result.to.versionName}(${result.to.versionCode})`
    + (dry ? '  [dry-run，未写文件]' : ''))
  if (!dry) writeFileSync(FILE, result.text, 'utf-8')
}