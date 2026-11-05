#!/usr/bin/env node
/**
 * leion-clean.mjs —— 数据目录里谁在长、怎么安全地清（5.118）
 * ============================================================================
 *
 * 用户原话：「日志会不断积累 如何避免空间不足的问题？」
 *
 * 这台机器 `/` 只剩 20G（81% 已用），而这些**都只增不减**：
 *   audio/<房间>/<说话人>.pcm（relay 追加、从不清空）· asr-inbox-*.jsonl ·
 *   buses/*.json（散会后留着）· var/logs/*.log
 * 而 `var/cache/`（模型 6.7G）与 `var/asr-eval/`（评测数据）**绝不能删**。
 *
 * 逻辑在 `lib/disk-clean.mjs`（可被测试直接调用 —— 这个工具最怕"删多了"）；
 * 这里只负责打印与执行。
 *
 *   node scripts/leion-clean.mjs --data-dir /var/lib/leion/test                 # 只报告
 *   node scripts/leion-clean.mjs --data-dir /var/lib/leion/test --older-than 7 --clean
 *   node scripts/leion-clean.mjs --data-dir … --keep-logs --clean               # 日志不动
 */

import { applyPlan, collectPlan, diskSpace, humanMb, parseCleanArgs } from '../lib/disk-clean.mjs'

function main() {
  const parsed = parseCleanArgs(process.argv.slice(2))
  if (parsed.ok !== true) {
    console.error(parsed.error)
    console.error('用法：node scripts/leion-clean.mjs [--data-dir 目录] [--older-than 天数] '
      + '[--clean] [--keep-logs]')
    return 2
  }
  const args = parsed.args
  if (args.help) {
    console.log('用法：node scripts/leion-clean.mjs [--data-dir 目录] [--older-than 天数] '
      + '[--clean] [--keep-logs]')
    console.log('  不带 --clean 只报告（推荐先看一遍）；--older-than 缺省 3 天')
    console.log('  永远不碰：var/cache（模型）、var/asr-eval（评测数据）、数据库')
    return 0
  }

  const { cutoff, rows, plan, totalBytes } = collectPlan(args)
  console.log(`数据目录：${args.dataDir}`)
  console.log(`清理阈值：${args.olderThanDays} 天之前（${new Date(cutoff).toISOString()}）`)
  console.log(args.clean ? '模式：**真删**（--clean）' : '模式：只报告（加 --clean 才真删）')
  console.log('')
  for (const row of rows) {
    console.log(`  ${row.name}：${humanMb(row.bytes)} / ${row.files} 个文件`
      + (row.cleanable ? '' : '（**永不清理**）'))
  }
  const space = diskSpace(args.dataDir)
  if (space !== null) {
    console.log('')
    console.log(`  磁盘：剩 ${space.freeGb.toFixed(1)} GB / 共 ${space.totalGb.toFixed(1)} GB`
      + `（已用 ${space.usedPercent.toFixed(0)}%）`
      + (space.freeGb < 5 ? '  ⚠️ 低于 5 GB：建议立刻 --clean，并检查 audio/ 里的历史分轨' : ''))
  }

  console.log('')
  if (plan.length === 0) {
    console.log('没有超过阈值的可清文件 —— 不需要动手。')
    return 0
  }
  console.log('可以清掉的（按类别）:')
  for (const item of plan) {
    console.log(`  · ${item.name}：${item.files.length} 个文件，${humanMb(item.bytes)}`)
  }
  console.log(`  合计约 ${humanMb(totalBytes)}`)

  if (!args.clean) {
    console.log('')
    console.log('加 --clean 才真删。建议先确认上面的类别与数量，没有你要留着的东西再动手。')
    return 0
  }
  const { removed, failed } = applyPlan(plan)
  console.log('')
  console.log(`已删除 ${removed} 个文件`
    + (failed > 0 ? `，${failed} 个删不掉（可能正被识别进程占用，下次再试）` : ''))
  console.log('⚠️ 删的只有历史音频/日志/收件箱/旧总线；**模型、评测数据、数据库一个字没动**。')
  return 0
}

process.exit(main())
