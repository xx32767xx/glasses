#!/usr/bin/env node
// 把旧 JSON 导入 SQLite（P1）。默认演练，--apply 才写库。
// 真正的导入逻辑在 lib/db.mjs 的 importFromDataDir（有测试钉住条数一致性）。
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { importFromDataDir, openDb } from '../lib/db.mjs'

export function parseArgs(argv) {
  const options = { apply: false, dataDir: 'var/live', db: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--apply') { options.apply = true; continue }
    if (token === '--help' || token === '-h') { options.help = true; continue }
    if (token !== '--data-dir' && token !== '--db') throw new Error('unknown arg: ' + token)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(token + ' needs a value')
    index += 1
    if (token === '--data-dir') options.dataDir = value
    else options.db = value
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('usage: node scripts/migrate-sqlite.mjs --data-dir <dir> [--db <file>] [--apply]')
    return 0
  }
  const dataDir = resolve(options.dataDir)
  if (!existsSync(dataDir)) { console.error('data dir not found: ' + dataDir); return 1 }
  const dbFile = options.db ? resolve(options.db) : join(dataDir, 'leion.db')
  const dryRun = options.apply !== true
  const db = openDb(dryRun ? ':memory:' : dbFile)
  const report = importFromDataDir(db, dataDir)
  db.close()
  const summary = 'accounts ' + report.accounts + ' / libraries ' + report.libraries
    + ' / entries ' + report.entries + ' / requests ' + report.requests
  if (dryRun) {
    console.log('[dry-run] nothing written. ' + summary)
    console.log('to write: node scripts/migrate-sqlite.mjs --data-dir ' + dataDir + ' --apply')
  } else {
    console.log('[applied] -> ' + dbFile + '  ' + summary)
    console.log('JSON originals are untouched.')
  }
  if (report.skipped.length > 0) {
    console.log('skipped ' + report.skipped.length + ':')
    for (const item of report.skipped.slice(0, 10)) console.log('  - ' + item)
  }
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { process.exit(main()) } catch (error) { console.error('ERROR ' + error.message); process.exit(1) }
}