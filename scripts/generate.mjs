/**
 * generate.mjs —— 从唯一逻辑源 plugin/core.mjs 派生两个产物的 CLI
 * ============================================================================
 *   node scripts/generate.mjs           写出两个产物
 *   node scripts/generate.mjs --check   只校验产物是否最新（新鲜度门禁）
 *
 * 生成逻辑在 lib/artifacts.mjs，测试也用同一份实现做门禁，所以不存在"生成器与门禁
 * 说法不一致"的可能。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { buildArtifacts } from '../lib/artifacts.mjs'

const artifacts = await buildArtifacts()

if (process.argv.includes('--check')) {
  const stale = artifacts.filter(a => !existsSync(a.path) || readFileSync(a.path, 'utf-8') !== a.content)
  if (stale.length > 0) {
    console.error('以下产物不是最新的（跑 node scripts/generate.mjs 重新生成）：')
    for (const a of stale) console.error('  · ' + a.label)
    process.exitCode = 1
  } else {
    console.log('产物都是最新的：' + artifacts.map(a => a.label).join('、'))
  }
} else {
  for (const a of artifacts) {
    writeFileSync(a.path, a.content)
    console.log(`已写出 ${a.label}（${a.content.length} 字符）`)
  }
}
