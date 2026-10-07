/**
 * fetch-coraa.mjs —— 下 CORAA（巴葡口语语料，含口音标注）
 * ============================================================================
 *
 *   node scripts/fetch-coraa.mjs --probe        # 诊断镜像与证书（先跑这个）
 *   node scripts/fetch-coraa.mjs --metadata     # 下元数据 CSV（约 77 MB，够看分布）
 *   node scripts/fetch-coraa.mjs --shards 6     # 抽 6 个分片（约 1.9 GB，含音频）
 *
 * 下完之后：
 *   python scripts/fetch-coraa-sample.py --list
 *   python scripts/fetch-coraa-sample.py --per-accent 20
 *   node scripts/test-asr.mjs --set pt-coraa --compare --by-accent
 *
 * ── 为什么选 CORAA ────────────────────────────────────────────────────────
 *
 * 方案第四节把「巴葡口音适配（圣保罗、里约、南部、东北部）」列为**核心指标**，
 * 而原先的 FLEURS 是**朗读**语料、没有口音标注 —— 测不了这个指标。
 * CORAA 是我们找到的、**带 `accent` 列**的巴葡语料，而且 74% 是自发口语：
 *
 *     口音分布（全量 402,456 条，从元数据统计）
 *       Recife            261,906（65.1%）  ← 东北部
 *       São Paulo (cap.)   46,482（11.5%）
 *       São Paulo (int.)   45,005（11.2%）
 *       Misc.              35,395（ 8.8%）  ← TEDx，口音混杂
 *       Minas Gerais       13,668（ 3.4%）
 *       另有 1,040 条 pt_pt（欧葡）—— **必须过滤掉，不能混进巴葡评测**
 *
 * ⚠️ **里约与南部不在这份语料里**。我搜过 CORAA 家族与相关上传（NURC-SP、
 *    CORAAL、NILC 的 NURC-SP 音频语料），都没有。所以"四个区全覆盖"这件事
 *    目前做不到，只能覆盖三个（圣保罗、东北部、米纳斯）。这一点要如实上报。
 *
 * ── ⚠️⚠️ 下载必须关掉 TLS 证书校验（这是实测出来的，不是图省事）──────────
 *
 *   1. `huggingface.co`（官方）在本机**不通**，只有 `hf-mirror.com` 通。
 *   2. 镜像对文件请求会 302 跳到 `cas-bridge.xethub.hf.co`（HF 的 Xet CDN）。
 *   3. 那个 CDN 的证书链里有**自签证书**：Python 报
 *      `SSLCertVerificationError: self-signed certificate in certificate chain`，
 *      `curl.exe` 连自己都拿不到凭据（沙箱里 schannel 被拒）。
 *   4. 所以只能用 Node 并设 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
 *
 *   **这个设置的含义要说清楚**：关掉校验之后，链路上任何人替换数据你都发现不了。
 *   自签证书的来源很可能是本机的杀软/代理在做 SSL 检查（企业环境常见）。
 *   该做的是**先弄清它是谁**，而不是长期靠关校验过日子。
 *   脚本对下到的文件做了**体积与 parquet 魔数校验**，但那挡不住精心构造的替换。
 *   如果这批数据要用在正式结论上，建议换一条可信网络再下一遍。
 *
 * ── 体积参考 ──────────────────────────────────────────────────────────────
 *   全量 136 个分片 ≈ 41.7 GB（按实测 313.6 MB/分片估）。
 *   评测**不需要全量** —— 抽 6 个分片就有上万条，够按口音分层抽样了。
 *   而且**不同分片来自不同子语料**，所以要覆盖多个地区就得多抽几个（见下）。
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

import { CORAA_CACHE_DIR, CORAA_SHARD_DIR } from '../lib/paths.mjs'

const MIRROR = 'https://hf-mirror.com'
const DATASET = 'Racoci/CORAA-v1.1'          // 音频在 parquet 里，CC-BY-NC-ND-4.0
const META_DATASET = 'gabrielrstan/CORAA-v1.1'  // 元数据 CSV 在这里（口音/风格/投票）

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const fetchJson = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (response.ok !== true) throw new Error('HTTP ' + response.status)
  return await response.json()
}

async function download(url, target, label) {
  if (existsSync(target) && statSync(target).size > 1024) {
    console.log(`  ⏭ 已有 ${label}（${(statSync(target).size / 1024 / 1024).toFixed(1)} MB）`)
    return target
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(600000) })
  if (response.ok !== true) throw new Error('HTTP ' + response.status + ' ' + url)
  const buffer = Buffer.from(await response.arrayBuffer())
  // 基本完整性检查：parquet 必须真以 PAR1 开头。
  // （镜像偶发会返回一个 HTML 错误页，不校验的话会写出一个"看起来下好了"的坏文件）
  if (target.endsWith('.parquet') && buffer.subarray(0, 4).toString() !== 'PAR1') {
    throw new Error(label + ' 不是 parquet（魔数不对，可能下到了错误页）')
  }
  writeFileSync(target, buffer)
  console.log(`  ✅ ${label}  ${(buffer.length / 1024 / 1024).toFixed(1)} MB`)
  return target
}

async function metadata() {
  mkdirSync(CORAA_CACHE_DIR, { recursive: true })
  console.log('下元数据（口音/风格/投票/文本，不含音频）：')
  for (const name of ['metadata_train_final.csv', 'metadata_dev_final.csv', 'metadata_test_final.csv']) {
    await download(`${MIRROR}/datasets/${META_DATASET}/resolve/main/${name}`,
      join(CORAA_CACHE_DIR, name), name)
  }
  console.log('')
  console.log('下一步：python scripts/fetch-coraa-sample.py --list')
}

async function shards(count) {
  mkdirSync(CORAA_SHARD_DIR, { recursive: true })
  const info = await fetchJson(`${MIRROR}/api/datasets/${DATASET}/parquet`)
  const plan = info.default
  console.log(`分片计划：dev ${plan.dev.length} / test ${plan.test.length} / train ${plan.train.length}`)

  // ⚠️ 抽样刻意**从 test + dev 里取**，不从 train 取。两个原因：
  //   ① 体积：train 有 127 个分片、全量约 41.7 GB，而 test+dev 只有 9 个；
  //   ② 口径：test/dev 是标准划分，拿它做评测不会和"训练过这个数据集的人"撞车。
  //
  // ⚠️ 但**不同分片来自不同子语料**，所以想覆盖多个地区就得多抽几个：
  //    实测第 1 个 test 分片里**全是 São Paulo (cap.)**（SP2010 子语料）。
  //    要 Recife（东北部）得继续往下抽。抽完脚本会告诉你还需要抽几个。
  const picks = [...plan.test, ...plan.dev].slice(0, count)
  if (picks.length === 0) throw new Error('镜像没给出 test/dev 分片')
  for (const [index, url] of picks.entries()) {
    const mirrorUrl = url.replace(/^https?:\/\/[^/]+/, MIRROR)
    await download(mirrorUrl, join(CORAA_SHARD_DIR, `shard-${index}.parquet`), `shard-${index}.parquet`)
  }
  console.log('')
  console.log(`共 ${picks.length} 个分片 → ${CORAA_SHARD_DIR}`)
  console.log('下一步：python scripts/fetch-coraa-sample.py --list')
  console.log('       （它会报出"这些分片里能抽到哪些口音、还缺哪些"）')
}

async function probe() {
  const url = `${MIRROR}/datasets/${DATASET}/resolve/main/data/dev-00000-of-00003.parquet`
  console.log('诊断镜像跳转与证书：')
  const manual = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
  const location = manual.headers.get('location') ?? '(无)'
  console.log('  1) ' + url)
  console.log('     → HTTP ' + manual.status + '  跳到：' + basename(location.split('?')[0]))
  console.log('     → 主机：' + (location.split('/')[2] ?? '(无)'))
  try {
    const followed = await fetch(url, { signal: AbortSignal.timeout(30000) })
    console.log('  2) 跟随跳转：HTTP ' + followed.status + '（证书校验已关闭）')
  } catch (error) {
    console.log('  2) 跟随跳转失败：' + error.message + ' | ' + (error.cause?.message ?? ''))
  }
  console.log('')
  console.log('  说明：第 2 步必须成功，否则下载做不了。证书是自签的（多为本机杀软/代理在做 SSL 检查）。')
}

const args = process.argv.slice(2)
if (args.includes('--probe')) await probe()
else if (args.includes('--metadata')) await metadata()
else if (args.includes('--shards')) {
  const at = args.indexOf('--shards')
  await shards(Number(args[at + 1] ?? 3))
} else {
  console.log('用法：')
  console.log('  node scripts/fetch-coraa.mjs --probe        # 诊断镜像与证书（先跑这个）')
  console.log('  node scripts/fetch-coraa.mjs --metadata    # 下元数据 CSV（约 77 MB）')
  console.log('  node scripts/fetch-coraa.mjs --shards 6    # 抽 6 个分片（约 1.9 GB）')
  console.log('')
  console.log('⚠️ 这个脚本会关掉 TLS 证书校验才能下载 —— 原因见文件头注释，别当成小事。')
}
