/**
 * english-suite.mjs —— 中/英/葡三种语言的互译支持（5.00）
 * ============================================================================
 * 这一套守的是"**方向**"这件事，因为译错方向是本项目最危险的一类错误：
 * 译文看着完全正常、语法没问题，只是整场译成了另一种语言 —— 用户可能半小时后才发现。
 *
 * 三条边界：
 *   1. **目标语言必须能唯一确定**（三种语言时"对面那种"不唯一），
 *      优先级：这一句显式给的 to → 会议配置 → 兜底 opposite(源语言)；
 *   2. **语种判定绝不猜**：英文与巴葡共用拉丁字母，所以英文要求 ≥2 个功能词才算，
 *      否则返回 unknown（宁可拒绝，也不要猜错方向）；
 *   3. **源=目标时要明确拒绝**（"译成同一种语言"没有意义，产出的是假译文）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EN, PT, ZH, detectLang, opposite, resolveTarget, resolveTargets, translationSystem, proofreadSystem,
  targetName, EN_OUTPUT_RULES, CONFIG_DEFAULTS,
} from '../plugin/core.mjs'
import { createWsHub } from '../lib/ws-hub.mjs'
import { parseArgs as harnessParse } from '../scripts/harness-side.mjs'
import { parseArgs as multiParse, pipelineSteps } from '../scripts/start-multi.mjs'

const policy = JSON.parse(readFileSync(join(process.cwd(), 'policy', 'br-pt.json'), 'utf-8'))

export async function runEnglishSuite({ it, check, assert }) {
  await it('三种语言的常量与兜底方向', async () => {
    check('英语是 en-US', EN === 'en-US', EN)
    check('中→葡（老行为不变）', opposite(ZH) === PT, opposite(ZH))
    check('葡→中（老行为不变）', opposite(PT) === ZH, opposite(PT))
    check('英语兜底译成中文（没配目标时才走这条）', opposite(EN) === ZH, opposite(EN))
    check('不认识的语种返回 unknown（不猜）', opposite('de-DE') === 'unknown', opposite('de-DE'))
  })

  await it('目标语言的优先级：显式 > 会议配置 > 兜底', async () => {
    check('显式 to 最优先',
      resolveTarget(ZH, EN, PT).target === EN && resolveTarget(ZH, EN, PT).source === 'explicit',
      JSON.stringify(resolveTarget(ZH, EN, PT)))
    check('没给 to 就用会议配置',
      resolveTarget(ZH, '', EN).target === EN && resolveTarget(ZH, '', EN).source === 'meeting',
      JSON.stringify(resolveTarget(ZH, '', EN)))
    check('都没给才回落到"对面"（中↔葡）',
      resolveTarget(ZH, '', '').target === PT && resolveTarget(ZH, '', '').source === 'paired',
      JSON.stringify(resolveTarget(ZH, '', '')))
    check('三种都拿不到时给空（调用方必须明确失败，不许猜）',
      resolveTarget('de-DE', '', '').target === '', JSON.stringify(resolveTarget('de-DE', '', '')))
    check('会议配置为空串等于"没配"（旧 settings.json 就是空串）',
      resolveTarget(ZH, '', '').source === 'paired')
  })

  await it('语种判定：英文要够证据才认（绝不猜）', async () => {
    check('中文立刻认出', detectLang('我们下午三点开会') === ZH, detectLang('我们下午三点开会'))
    check('巴葡认出（有标记词）', detectLang('Vamos falar sobre a reunião') === PT,
      detectLang('Vamos falar sobre a reunião'))
    check('英文认出（两个以上功能词）', detectLang('We will have the meeting at three') === EN,
      detectLang('We will have the meeting at three'))
    // 关键负对照：单词 "no" 在葡语里也是 no —— 一个词不足以判语种
    check('单个词不判（"no" → unknown）', detectLang('no') === 'unknown', detectLang('no'))
    check('空文本 → unknown', detectLang('') === 'unknown', detectLang(''))
    check('中文优先于英文（混排时以汉字为准）',
      detectLang('我们明天 discuss the plan') === ZH, detectLang('我们明天 discuss the plan'))
  })

  await it('提示词：译成英语时不带巴葡口径、也不塞中文术语', async () => {
    const toEn = translationSystem(policy, ZH, EN, [{ zh: '亮亮眼镜', pt: 'Leion Pro' }])
    check('写明目标是英语', toEn.includes(targetName(policy, EN)), toEn.slice(0, 120))
    for (const rule of EN_OUTPUT_RULES) {
      check(`带英语输出规则：${rule.slice(0, 18)}…`, toEn.includes(rule), '缺规则')
    }
    check('**不带**巴葡专用规则（"用巴葡表达"那条译成英语时是错的）',
      policy.ptBrRules.every(rule => toEn.includes(rule) === false), '混进了巴葡规则')
    check('**不塞**中文术语提示（否则英语译文里会留中文名）',
      toEn.includes('亮亮眼镜') === false, '术语被塞进了英语提示词')
    const toPt = translationSystem(policy, ZH, PT, [{ zh: '亮亮眼镜', pt: 'Leion Pro' }])
    check('译成葡语时仍然带巴葡规则', policy.ptBrRules.some(rule => toPt.includes(rule)))
    check('译成葡语时仍然塞术语', toPt.includes('Leion Pro'), toPt.slice(-160))
    check('目标语言的名字：三种都对',
      targetName(policy, ZH).includes('中文') && targetName(policy, PT).includes('葡萄牙')
        && targetName(policy, EN).includes('English'),
      JSON.stringify([targetName(policy, ZH), targetName(policy, PT), targetName(policy, EN)]))
    const proofEn = proofreadSystem(policy, ZH, EN, [{ zh: '亮亮眼镜', pt: 'Leion Pro' }])
    check('校对提示词也认英语目标', proofEn.includes(targetName(policy, EN)), proofEn.slice(0, 120))
  })

  await it('插件配置里多了 targetLang（空串 = 老行为）', async () => {
    check('有这一项', typeof CONFIG_DEFAULTS.targetLang === 'string', typeof CONFIG_DEFAULTS.targetLang)
    check('缺省是空串（旧部署行为不变）', CONFIG_DEFAULTS.targetLang === '', CONFIG_DEFAULTS.targetLang)
  })

  await it('大脑认 --to（三种都接受，乱写立刻报错）', async () => {
    check('--to en-US', harnessParse(['--to', 'en-US']).targetLang === EN,
      harnessParse(['--to', 'en-US']).targetLang)
    check('--to pt-BR', harnessParse(['--to', 'pt-BR']).targetLang === PT)
    check('缺省空串', harnessParse([]).targetLang === '', harnessParse([]).targetLang)
    assert.throws(() => harnessParse(['--to', 'de-DE']), /--to/)
    assert.throws(() => harnessParse(['--to']), /--to/)
  })

  await it('start-multi：房间配了目标语言才给大脑传 --to', async () => {
    const options = multiParse(['--data-dir', 'var/x'])
    const withTarget = pipelineSteps(options, { id: 'room-en-aaaa', targetLang: EN })
      .find(step => step.role === 'brain')
    check('传了 --to en-US', withTarget.args.includes('--to')
      && withTarget.args[withTarget.args.indexOf('--to') + 1] === EN, withTarget.args.join(' '))
    const noTarget = pipelineSteps(options, { id: 'room-old-aaaa', targetLang: '' })
      .find(step => step.role === 'brain')
    check('没配就不传（旧房间行为不变）', noTarget.args.includes('--to') === false,
      noTarget.args.join(' '))
    // 服务端：LANGS 里有英语，房间记录带 targetLang
    const relay = readFileSync(join(process.cwd(), 'relay', 'lan-relay.mjs'), 'utf-8')
    check('relay 的 LANGS 有三种', /const LANGS = \['zh-CN', 'pt-BR', 'en-US'\]/.test(relay),
      '语种白名单没加英语')
    const api = readFileSync(join(process.cwd(), 'relay', 'org-api.mjs'), 'utf-8')
    check('建房接口收 targetLang 并校验', /targetLang 只能是 zh-CN \/ pt-BR \/ en-US/.test(api))
    const rooms = readFileSync(join(process.cwd(), 'lib', 'rooms.mjs'), 'utf-8')
    check('rooms 表带 target_lang（升级旧库自动补列）',
      readFileSync(join(process.cwd(), 'lib', 'db.mjs'), 'utf-8').includes("ALTER TABLE rooms ADD COLUMN target_lang"))
    check('房间投影里带 targetLang', /targetLang: String\(row\.target_lang/.test(rooms))
  })

  await it('客户端：三种说话语言；译成哪种语言**由听众语言自动决定**（5.03 / 5.04）', async () => {
    const resDir = join(process.cwd(), 'android', 'app', 'src', 'main', 'res')
    // 5.04：旧大厅拆成创建页 + 加入页，说话语言两页各一组
    const createXml = readFileSync(join(resDir, 'layout', 'page_create_room.xml'), 'utf-8')
    const joinXml = readFileSync(join(resDir, 'layout', 'page_join_room.xml'), 'utf-8')
    check('创建页说话语言有英语那颗', /@\+id\/createLangEn/.test(createXml))
    check('加入页说话语言有英语那颗', /@\+id\/joinLangEn/.test(joinXml))
    // 用户质疑过："我不是说了根据用户的选择自动翻译成对应结果吗" —— 建房页不该再要一次选择
    check('两页都没有「译成哪种语言」胶囊',
      !/roomsTarget/.test(createXml) && !/roomsTarget/.test(joinXml))
    const zh = readFileSync(join(resDir, 'values', 'strings.xml'), 'utf-8')
    check('三语文案都在', /rooms_speak_en/.test(zh) && /lang_en_short/.test(zh)
      && /attend_mode_remote/.test(zh))
    const settingsXml = readFileSync(join(resDir, 'layout', 'page_settings_app.xml'), 'utf-8')
    check('设置页也能选英语当说话语言', /@\+id\/setAppLangEn/.test(settingsXml))
    // 服务端仍然**支持**显式目标语言（管理员/CLI/以后的高级设置），但手机不传：
    // 不传就是"按房间里每种语言的听众各译一份"，这与 §5.01 的多语言分发是同一条路。
    const lanClient = readFileSync(join(process.cwd(), 'android', 'app', 'src', 'main', 'java',
      'com', 'leion', 'lanrelay', 'LanClient.java'), 'utf-8')
    check('LanClient 仍支持可选的目标语言参数（给管理端留的）',
      /orgCreateRoom\(String name, String lang, String targetLang, String mode\)/.test(lanClient))
    const roomsJava = readFileSync(join(process.cwd(), 'android', 'app', 'src', 'main', 'java',
      'com', 'leion', 'lanrelay', 'CreateRoomActivity.java'), 'utf-8')
    check('手机建房时不传目标语言（自动）',
      /orgCreateRoom\(topic, speakLang, "", attendMode\)/.test(roomsJava) && !/targetLang/.test(roomsJava))
  })

  await it('一句话译成**几种**：按听众语言去重（用户的架构）', async () => {
    // 两个听众同语言 → 只译一份；不同语言 → 译两份
    const same = resolveTargets(ZH, '', ['pt-BR', 'pt-BR'])
    check('同语言听众只译一份', same.targets.length === 1 && same.targets[0] === PT,
      JSON.stringify(same))
    const diff = resolveTargets(ZH, '', ['pt-BR', 'en-US'])
    check('不同语言听众译两份', diff.targets.length === 2, JSON.stringify(diff))
    check('两份里没有源语言（绝不译成源语言）',
      diff.targets.includes(ZH) === false, JSON.stringify(diff.targets))
    // 所有人读的都是源语言 → 这一句**不需要**任何译文（不是回落到 opposite 白译一份）
    const nobodyNeeds = resolveTargets(ZH, '', [ZH, ZH])
    check('听众全都读源语言 → 不译（targets 为空）',
      nobodyNeeds.targets.length === 0 && nobodyNeeds.source === 'listeners',
      JSON.stringify(nobodyNeeds))
    // 还没人登记 → 老行为
    const legacy = resolveTargets(ZH, '', [])
    check('没人登记时按老行为（中→葡）',
      legacy.targets.length === 1 && legacy.targets[0] === PT && legacy.source === 'paired',
      JSON.stringify(legacy))
    // 显式覆盖
    const override = resolveTargets(ZH, EN, ['pt-BR'])
    check('会议显式指定时只译那一种（覆盖听众集合）',
      override.targets.length === 1 && override.targets[0] === EN, JSON.stringify(override))
    check('显式=源语言 → 不译', resolveTargets(ZH, ZH, ['pt-BR']).targets.length === 0)
    check('三种语言全在时最多两份（源语言占一种）',
      resolveTargets(ZH, '', [ZH, PT, EN]).targets.length === 2,
      JSON.stringify(resolveTargets(ZH, '', [ZH, PT, EN]).targets))
  })

  await it('WS 按**语言**扇出（同语言的人不会收到别国语言的帧）', async () => {
    const hub = createWsHub({ debug: () => {} })
    check('hub 暴露了 applyRoomLangs / setHearLang',
      typeof hub.applyRoomLangs === 'function' && typeof hub.setHearLang === 'function')
    // 没有连接时安全返回 0
    check('没有连接时返回 0', hub.broadcastFrame({ type: 'frame' }, 'room-x', EN) === 0)
    const hubSource = readFileSync(join(process.cwd(), 'lib', 'ws-hub.mjs'), 'utf-8')
    check('按 conn.hearLang 过滤', /conn\.hearLang/.test(hubSource))
    check('没登记语言的连接照旧收（升级期不能吞字幕）',
      /listening === '' \|\| listening === wanted/.test(hubSource))
    check('relay 推帧时带上语言', /attribution\.roomId \?\? null, String\(frame\.lang \?\? ''\)\)/.test(
      readFileSync(join(process.cwd(), 'relay', 'lan-relay.mjs'), 'utf-8')))
  })

  await it('start-multi 把听众语言侧车路径交给大脑（否则大脑没法按语言各译一份）', async () => {
    const options = multiParse(['--data-dir', 'var/x'])
    const brain = pipelineSteps(options, { id: 'room-multi-aaaa', targetLang: '' })
      .find(step => step.role === 'brain')
    const index = brain.args.indexOf('--hear-langs')
    check('传了 --hear-langs', index >= 0, brain.args.join(' '))
    check('路径是 <data-dir>/room-langs/<房间>.json（与 relay 写的位置一致）',
      String(brain.args[index + 1]).replace(/\\/g, '/').endsWith('room-langs/room-multi-aaaa.json'),
      String(brain.args[index + 1]))
    const relaySource = readFileSync(join(process.cwd(), 'relay', 'lan-relay.mjs'), 'utf-8')
    check('relay 写的就是这个位置', /join\(options\.dataDir, 'room-langs'/.test(relaySource))
  })

  await it('客户端：只显示自己语言那一份，且去重键带语言', async () => {
    const room = readFileSync(join(process.cwd(), 'android', 'app', 'src', 'main', 'java',
      'com', 'leion', 'lanrelay', 'RoomActivity.java'), 'utf-8')
    check('有 hearLang 字段（读哪种语言）', /private String hearLang = ""/.test(room))
    check('帧语言与我的不同 → 直接不显示',
      /!frameLang\.isEmpty\(\) && !hearLang\.isEmpty\(\) && !frameLang\.equals\(hearLang\)/.test(room),
      '没有按语言过滤，三语会议里会同时看到两份译文')
    check('帧语言缺失时照旧显示（不吞字幕）',
      /frameLang\.isEmpty\(\)/.test(room) && /return;/.test(room))
    check('段落去重键带语言（否则第二份会覆盖第一份）',
      /langKey\.isEmpty\(\) \? source : langKey \+ "\|" \+ source/.test(room),
      '同一句的两种译文会互相覆盖')
    check('心跳/上传路径也把语言记下来', /hearLang = speak;/.test(room))
  })

  await it('识别端的候选语种必须覆盖三种语言（5.05：漏了 en = 英语被按中文解码）', async () => {
    const whisper = readFileSync(join(process.cwd(), 'bridge', 'whisper_stream.py'), 'utf-8')
    // 用户实测日志：「语种限定生效：全局最大是 en，限定到 ('zh','pt') 后取 zh」
    // 这句一出现，英语就被当成中文认了 —— 出来的中文字幕听着像话、其实全错。
    check('缺省候选集含英语',
      /--lang-candidates", default="zh,pt,en"/.test(whisper), '缺省里没有 en，英语方向必错')
    // 产线**不能**自己把候选集收窄：谁传了 --lang-candidates，谁就要为"漏语种"负责
    const multi = readFileSync(join(process.cwd(), 'scripts', 'start-multi.mjs'), 'utf-8')
    const worker = readFileSync(join(process.cwd(), 'bridge', 'asr-worker.mjs'), 'utf-8')
    check('start-multi 与 asr-worker 都不写死候选集（用缺省）',
      !/--lang-candidates/.test(multi) && !/--lang-candidates/.test(worker),
      '有人写死成 zh,pt 时，英语会静默失效')
    // 没有语种时必须说出来（原来这一段是静默的：段里 lang=null，日志上只有下游现象）
    check('切句端会报"没有语种可带"以及读的是哪个旁文件',
      /没有语种可带（/.test(whisper) && /lang_path = Path\(args\.follow\)\.with_suffix\('\.lang'\)/.test(whisper))
    check('有了语种也会报一行（从哪一段起生效）', /语种 = \{tag\}（Whisper 码/.test(whisper))
    // 转发端：旁文件写的是什么语种，必须在日志里查得到
    const relay = readFileSync(join(process.cwd(), 'relay', 'lan-relay.mjs'), 'utf-8')
    check('relay 在语种变化时打一行（旁文件写的内容可见）',
      /roomLangWritten/.test(relay) && /房间语种：\$\{audioRoom\} → \$\{lang\}/.test(relay))
  })

  await it('转写：同一句的多语言译文合成**一行**（带 dst_by_lang）', async () => {
    const dbSource = readFileSync(join(process.cwd(), 'lib', 'db.mjs'), 'utf-8')
    check('utterances 有 dst_by_lang 列（旧库自动补）',
      /ALTER TABLE utterances ADD COLUMN dst_by_lang/.test(dbSource))
    check('同源同说话人 60 秒内合并', /startAt - 60000/.test(dbSource) && /merged: true/.test(dbSource))
    const relaySource = readFileSync(join(process.cwd(), 'relay', 'lan-relay.mjs'), 'utf-8')
    check('relay 分清源语言与译文语言（frame.sourceLang / frame.lang）',
      /srcLang: String\(frame\.sourceLang \?\? ''\)/.test(relaySource)
        && /dstLang: String\(frame\.lang \?\? ''\)/.test(relaySource),
      '单语言时看不出错，三种语言时必须分清')
  })

  await it('历史/转写里的语种也显示成人话（en-US → 英语）', async () => {
    const detail = readFileSync(join(process.cwd(), 'android', 'app', 'src', 'main', 'java',
      'com', 'leion', 'lanrelay', 'HistoryDetailActivity.java'), 'utf-8')
    check('langLabel 认 en', /code\.startsWith\("en"\)/.test(detail)
      && /R\.string\.lang_en_short/.test(detail), '英语语种码会原样显示成 en-US')
  })
}
