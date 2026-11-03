/** rooms-suite.mjs —— 房间与邀请码（P2a） */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUDIO_ROOM_TTL_MS, closeRoomByAdmin, createInterpreterSession, createRoom, interpreterPartnerLang, isRoomClosed, joinRoom, leaveRoom, listHistory, listMembers, listRooms, normalizeHearLangs, roomByCode, roomForFrame, roomLibraries, listRoomTranscript, resolveFrameRoom, setMemberHearLangs, setRoomLibraries, roomById, removeMember } from '../lib/rooms.mjs'
import { appendUtterance } from '../lib/db.mjs'
import { floorState, takeFloor } from '../lib/floor.mjs'

export async function runRoomsSuite({ it, check }) {
  const dir = mkdtempSync(join(tmpdir(), 'leion-rooms-'))

  await it('4.74：并发归属 —— 帧 roomId > 刚上传音频的房间 > 持麦者推断', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conc-'))
    try {
      const now = Date.now()
      const a = createRoom(dir, { name: '甲会', host: 'alice', now })
      const b = createRoom(dir, { name: '乙会', host: 'bob', now })
      // 两场会都有人持麦：没有线索时推不出来
      takeFloor(dir, { roomId: a.room.id, username: 'alice', now })
      takeFloor(dir, { roomId: b.room.id, username: 'bob', now })
      check('没有线索 → 不归属', resolveFrameRoom(dir, { now }).roomId === null)

      // ① 帧里带 roomId：最硬
      check('帧 roomId 优先',
        resolveFrameRoom(dir, { now, frameRoomId: b.room.id }).reason === 'frame-room-id')
      // ② 刚往甲会上传过音频（30 秒内）→ 归甲会
      const audio = resolveFrameRoom(dir, {
        now, audioRoomId: a.room.id, audioAt: now - 2000,
      })
      check('刚上传音频的房间优先于推断',
        audio.roomId === a.room.id && audio.reason === 'recent-audio-room', JSON.stringify(audio))
      // ③ 音频线索过期 → 回到推断（两场都在说 → 不归属）
      check('音频线索过期就不再用',
        resolveFrameRoom(dir, { now, audioRoomId: a.room.id, audioAt: now - AUDIO_ROOM_TTL_MS - 1 }).roomId === null)
      // ④ 音频房间已结束 → 也不能用
      leaveRoom(dir, { roomId: a.room.id, username: 'alice', now })
      // 甲会已结束：音频线索不能再指向它（退回推断，此时只剩乙会）
      const afterClose = resolveFrameRoom(dir, { now, audioRoomId: a.room.id, audioAt: now })
      check('已结束的房间不能被音频线索指认',
        afterClose.reason !== 'recent-audio-room' && afterClose.roomId === b.room.id,
        JSON.stringify(afterClose))
      // ⑤ 唯一持麦者时，speaker 对不上的兜底仍然有效
      check('只剩一场有人持麦 → 兜底归它',
        resolveFrameRoom(dir, { now, speaker: '' }).roomId === b.room.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('4.73：定稿帧落库 —— 归属靠持麦者推断，推不出来宁可不记', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'utt-'))
    try {
      const now = Date.now()
      const room = createRoom(dir, { name: '甲会', host: 'alice', now })
      const other = createRoom(dir, { name: '乙会', host: 'bob', now })
      // 没有任何人持麦 → 不记
      check('没人发言时归属不了', roomForFrame(dir, '').reason === 'no-active-floor')
      // alice 在甲会抢麦
      takeFloor(dir, { roomId: room.room.id, username: 'alice', now })
      check('speaker 是持麦者 → 就是那场会',
        roomForFrame(dir, 'alice').roomId === room.room.id, JSON.stringify(roomForFrame(dir, 'alice')))
      // 两场会都有人持麦，speaker 对不上 → 不猜
      takeFloor(dir, { roomId: other.room.id, username: 'bob', now })
      check('两场都在说、speaker 又对不上 → 不记', roomForFrame(dir, '').roomId === null)
      // 将来协议：帧里带 roomId 就不用推断（并发场景下也精确）
      check('帧带 roomId 时直接归它',
        roomForFrame(dir, '', room.room.id).roomId === room.room.id
        && roomForFrame(dir, '', room.room.id).reason === 'frame-room-id')
      check('帧带假 roomId 时当没带', roomForFrame(dir, '', 'room-fake').roomId === null)
      check('已结束的会不能被帧指定归属',
        roomForFrame(dir, '', 'room-closed-xyz').roomId === null)
      check('speaker 是某场的持麦者 → 仍能定位', roomForFrame(dir, 'bob').roomId === other.room.id)

      // 落库 + 读回
      const saved = appendUtterance(dir, {
        roomId: room.room.id, username: 'alice', srcLang: 'zh-CN',
        srcText: '我们先看交期', dstText: 'Vamos ver o prazo', now,
      })
      check('写进去了', saved.ok === true, String(saved.error))
      const transcript = listRoomTranscript(dir, { roomId: room.room.id, user: 'alice' })
      check('读得回来', transcript.ok === true && transcript.lines.length === 1, JSON.stringify(transcript.lines))
      check('原文与译文都存了',
        transcript.lines[0].srcText === '我们先看交期' && transcript.lines[0].dstText === 'Vamos ver o prazo',
        JSON.stringify(transcript.lines[0]))
      check('非参与者读不到',
        listRoomTranscript(dir, { roomId: room.room.id, user: 'carol' }).ok === false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('建房给 6 位邀请码；别人凭码加入；错码进不来', () => {
    const created = createRoom(dir, { name: '圣保罗洽谈', host: 'boss', code: '123456' })
    check('建房成功', created.ok === true, JSON.stringify(created))
    check('邀请码是 6 位', /^\d{6}$/.test(created.room.code), created.room.code)
    const joined = joinRoom(dir, { code: '123456', username: 'dev1' })
    check('凭码加入成功', joined.ok === true, JSON.stringify(joined))
    check('成员两人', joined.members.length === 2, JSON.stringify(joined.members))
    const bad = joinRoom(dir, { code: '000000', username: 'dev1' })
    check('错码被拒', bad.ok === false && /邀请码无效/.test(bad.error), JSON.stringify(bad))
    const again = joinRoom(dir, { code: '123456', username: 'dev1' })
    check('重复加入幂等（成员数不变）', again.ok === true && again.members.length === 2, JSON.stringify(again.members))
  })

  await it('默认码是 6 位数字且不重复', () => {
    const a = createRoom(dir, { name: 'A', host: 'boss' })
    const b = createRoom(dir, { name: 'B', host: 'boss' })
    check('A 码 6 位', /^\d{6}$/.test(a.room.code), a.room.code)
    check('B 码 6 位', /^\d{6}$/.test(b.room.code), b.room.code)
    check('两房码不同', a.room.code !== b.room.code, `${a.room.code} vs ${b.room.code}`)
    check('roomByCode 能反查', roomByCode(dir, b.room.code)?.id === b.room.id)
  })

  await it('房间术语库选择可保存可读回', () => {
    const room = createRoom(dir, { name: '术语房间', host: 'boss', code: '654321' }).room
    check('先为空', roomLibraries(dir, room.id).length === 0)
    const saved = setRoomLibraries(dir, room.id, ['lib-a', 'lib-b'])
    check('保存成功', saved.ok === true, JSON.stringify(saved))
    check('读回两条且有序', JSON.stringify(roomLibraries(dir, room.id)) === JSON.stringify(['lib-a', 'lib-b']),
      JSON.stringify(roomLibraries(dir, room.id)))
    setRoomLibraries(dir, room.id, ['lib-b'])
    check('整表替换（旧的被清掉）', JSON.stringify(roomLibraries(dir, room.id)) === JSON.stringify(['lib-b']))
  })

  await it('成员列表按加入时间排序', () => {
    const room = createRoom(dir, { name: '排序房间', host: 'boss', code: '111111' }).room
    joinRoom(dir, { room, username: 'first', now: '2026-10-26T00:00:00.000Z' })
    joinRoom(dir, { room, username: 'second', now: '2026-10-26T00:01:00.000Z' })
    const members = listMembers(dir, room.id).map((m) => m.username).filter((n) => n !== 'boss')
    check('顺序正确（建房者 boss 也在成员里，按时间排在最后）', members.join(',') === 'first,second', members.join(','))
  })

  await it('普通成员退出不影响房间；发起者退出 = 整场结束', () => {
    const room = createRoom(dir, { name: '退出测试', host: 'boss', code: '777777' }).room
    joinRoom(dir, { room, username: 'dev1' })
    const memberLeft = leaveRoom(dir, { room, username: 'dev1' })
    check('成员退出后房间仍开着', memberLeft.ok === true && memberLeft.closed === false, JSON.stringify(memberLeft))
    check('成员不再在列表里', listMembers(dir, room.id).every((m) => m.username !== 'dev1'))
    check('房间未关闭', isRoomClosed(dir, room.id) === false)

    const hostLeft = leaveRoom(dir, { room, username: 'boss' })
    check('发起者退出 → closed:true', hostLeft.ok === true && hostLeft.closed === true, JSON.stringify(hostLeft))
    check('房间标记为结束', isRoomClosed(dir, room.id) === true)
    const rejoin = joinRoom(dir, { code: '777777', username: 'dev1' })
    check('结束后凭码进不来', rejoin.ok === false, JSON.stringify(rejoin))
  })
  await it('移出成员：仅发起者、不能移自己、同时释放他的麦（4.54）', () => {
    const room = createRoom(dir, { name: '移出测试', host: 'boss', code: '999111' }).room
    joinRoom(dir, { code: '999111', username: 'dev1' })
    joinRoom(dir, { code: '999111', username: 'dev2' })
    takeFloor(dir, { roomId: room.id, username: 'dev1' })

    const byDev = removeMember(dir, { roomId: room.id, username: 'dev2', by: 'dev1' })
    check('非发起者不能移人', byDev.ok === false && /只有发起者/.test(byDev.error), JSON.stringify(byDev))

    const self = removeMember(dir, { roomId: room.id, username: 'boss', by: 'boss' })
    check('发起者不能移出自己', self.ok === false && /不能移出自己/.test(self.error), JSON.stringify(self))

    const ghost = removeMember(dir, { roomId: room.id, username: 'nobody', by: 'boss' })
    check('不在房间里的人 → 报错', ghost.ok === false && /不在这个房间/.test(ghost.error), JSON.stringify(ghost))

    const removed = removeMember(dir, { roomId: room.id, username: 'dev1', by: 'boss' })
    check('发起者可以移出成员', removed.ok === true, JSON.stringify(removed))
    check('成员列表少了一个', removed.members.length === 2 && !removed.members.some(m => m.username === 'dev1'),
      JSON.stringify(removed.members.map(m => m.username)))
    check('他占着的麦被释放了', removed.releasedFloor === true, JSON.stringify(removed))
    check('发言权确实空了', floorState(dir, room.id).holder === null)

    // 软移除：被移出的人再凭码进来还能加入（想"再也进不来"要另做黑名单）
    const rejoin = joinRoom(dir, { code: '999111', username: 'dev1' })
    check('被移出的人仍能重新加入（这是软移除）', rejoin.ok === true, JSON.stringify(rejoin))
  })

  await it('房间详情带 closed：散会后 byId 也说得清（4.46）', () => {
    const room = createRoom(dir, { name: '散会测试', host: 'boss', code: '888888' }).room
    const before = roomById(dir, room.id)
    check('新建时 closed=false', before !== null && before.closed === false, JSON.stringify(before))

    leaveRoom(dir, { roomId: room.id, username: 'boss' })
    const after = roomById(dir, room.id)
    check('发起者退出后 byId 仍找得到这场（但不该再让人进）',
      after !== null, JSON.stringify(after))
    check('closed=true（客户端据此把屋里的人请出去）',
      after.closed === true, JSON.stringify(after))
    check('按邀请码就找不到了（roomByCode 只认未结束的）',
      roomByCode(dir, '888888') === null, 'byCode 应返回 null')
  })

  await it('5.35：翻译官会话与会议**同表同结构**，只靠 kind 区分（显示层不用写两套）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'interp-'))
    try {
      const meeting = createRoom(dataDir, { name: '周会', host: 'alice', targetLang: 'pt-BR' })
      check('会议建成', meeting.ok === true, JSON.stringify(meeting))
      check('会议 kind=meeting', meeting.room.kind === 'meeting', String(meeting.room.kind))

      const session = createInterpreterSession(dataDir, {
        host: 'alice', name: '和巴西同事', lang: 'zh-CN', targetLang: 'pt-BR',
      })
      check('翻译官会话建成', session.ok === true, JSON.stringify(session))
      check('kind=interpreter', session.session.kind === 'interpreter', JSON.stringify(session.session))
      check('**不返回邀请码**（它不是可加入的房间）', session.session.code === undefined,
        JSON.stringify(session.session))

      // 两句转写写进**同一张 utterances 表**（会议那套 appendUtterance 原样复用）
      appendUtterance(dataDir, {
        roomId: session.session.id, username: 'alice', srcLang: 'pt-BR', dstLang: 'zh-CN',
        srcText: 'Bom dia', dstText: '早上好', startAt: Date.now(), isFinal: true,
      })
      appendUtterance(dataDir, {
        roomId: session.session.id, username: 'alice', srcLang: 'pt-BR', dstLang: 'zh-CN',
        srcText: 'Obrigado', dstText: '谢谢', startAt: Date.now(), isFinal: true,
      })

      // 历史列表：两种记录**同一条查询**，只有 kind 不同
      const history = listHistory(dataDir, { user: 'alice' })
      check('历史里两条都在', history.items.length === 2, String(history.items.length))
      const kinds = history.items.map((one) => one.kind).sort()
      check('类型分别是 interpreter / meeting',
        JSON.stringify(kinds) === JSON.stringify(['interpreter', 'meeting']), JSON.stringify(kinds))
      const interp = history.items.find((one) => one.kind === 'interpreter')
      check('翻译官那条也带六样信息（名称/人数/句数/语种/时长）',
        interp.name === '和巴西同事' && interp.members === 1 && interp.utterances === 2
        && Array.isArray(interp.langs) && interp.langs.includes('zh-CN')
        && typeof interp.durationSeconds === 'number',
        JSON.stringify(interp))

      // 详情/转写：同一套 listRoomTranscript（成员校验也复用）
      const transcript = listRoomTranscript(dataDir, { roomId: session.session.id, user: 'alice' })
      check('转写读得到（复用会议那套）', transcript.ok === true && transcript.lines.length === 2,
        JSON.stringify(transcript.ok === true ? transcript.lines.length : transcript.error))
      check('原文译文都在', transcript.lines[0].srcText === 'Bom dia'
        && transcript.lines[0].dstText === '早上好', JSON.stringify(transcript.lines[0]))

      // 但**不能**被当成会议：大厅与管理台/管线看门狗不该看到它
      const rooms = listRooms(dataDir)
      check('正在开的会议列表里**没有**翻译官会话',
        rooms.every((one) => one.id !== session.session.id), JSON.stringify(rooms.map((one) => one.id)))
      check('会议还在列表里', rooms.some((one) => one.id === meeting.room.id))
      const all = listRooms(dataDir, { includeInterpreter: true })
      check('需要时能看到全部（includeInterpreter）', all.some((one) => one.id === session.session.id))

      // 邀请码进不去（翻译官会话没有入会语义）
      check('随便一个码都进不了翻译官会话', roomByCode(dataDir, '000000') === null)
      check('roomById 能看到 kind', roomById(dataDir, session.session.id)?.kind === 'interpreter')

      // 结束会话复用 closeRoomByAdmin（closed_at 置上 → 历史里时长定格）
      const closed = closeRoomByAdmin(dataDir, { roomId: session.session.id, by: 'alice' })
      check('结束会话成功', closed.ok === true, JSON.stringify(closed))
      const after = listHistory(dataDir, { user: 'alice' }).items
        .find((one) => one.id === session.session.id)
      check('结束后不再是「进行中」', after.active === false, JSON.stringify(after))
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  await it('5.36：翻译官「对方的语言」由「我读的语言」唯一推出（服务端兜底与手机端逐字一致）', async () => {
    // 为什么钉这条：上传没带语种时，relay 要用它兜底。如果服务端算成"我读的语言"，
    // 葡语音频会被当中文解码 —— 不是"判不出语种"，而是**判错语种**，整句乱码再拿去翻。
    // 手机端 InterpreterActivity.partnerLang() 与这里必须是同一张表。
    check('读中文 → 对方说葡语', interpreterPartnerLang('zh-CN') === 'pt-BR',
      String(interpreterPartnerLang('zh-CN')))
    check('读葡语 → 对方说中文', interpreterPartnerLang('pt-BR') === 'zh-CN',
      String(interpreterPartnerLang('pt-BR')))
    check('读英语 → 对方说中文', interpreterPartnerLang('en-US') === 'zh-CN',
      String(interpreterPartnerLang('en-US')))
    check('不认识的输入**不硬猜**（空串 → 调用方走别的兜底）',
      interpreterPartnerLang('') === '' && interpreterPartnerLang('ja-JP') === '',
      JSON.stringify([interpreterPartnerLang(''), interpreterPartnerLang('ja-JP')]))
    check('镜像关系不会自指（对方语言永远不等于我读的语言）',
      ['zh-CN', 'pt-BR', 'en-US'].every((one) => interpreterPartnerLang(one) !== one))
  })

  await it('5.53：「我说一种」与「我想看多种」分开存，且强制包含自己说的语言', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hear-'))
    try {
      // 老师的场景：我说葡语，但英文和中文的译文都想看。
      const created = createRoom(dataDir, {
        name: '双向阅读', host: 'alice', lang: 'pt-BR', hearLangs: 'zh-CN,en-US',
      })
      check('会议建成', created.ok === true, JSON.stringify(created))
      const alice = listMembers(dataDir, created.room.id).find((one) => one.username === 'alice')
      check('他说的语言是葡语', alice.lang === 'pt-BR', String(alice.lang))
      check('他想看中文 + 英文（按固定顺序归一化）',
        JSON.stringify(alice.hearLangs) === JSON.stringify(['zh-CN', 'pt-BR', 'en-US']),
        JSON.stringify(alice.hearLangs))
      check('**强制包含自己说的语言**（不然别人说的话没人为他翻译）',
        alice.hearLangs.includes('pt-BR'), JSON.stringify(alice.hearLangs))

      // 老客户端（不传 hearLangs）→ 只有自己那门，行为与以前一致
      joinRoom(dataDir, { roomId: created.room.id, username: 'bob', lang: 'zh-CN' })
      const bob = listMembers(dataDir, created.room.id).find((one) => one.username === 'bob')
      check('不传就只登记自己那门（老行为不变）',
        JSON.stringify(bob.hearLangs) === JSON.stringify(['zh-CN']), JSON.stringify(bob.hearLangs))

      // 会中可以改"我想看哪些"
      const changed = setMemberHearLangs(dataDir, {
        roomId: created.room.id, username: 'bob', langs: 'en-US,zh-CN',
      })
      check('改读语言成功', changed.ok === true && changed.changed === true, JSON.stringify(changed))
      const bob2 = listMembers(dataDir, created.room.id).find((one) => one.username === 'bob')
      check('改完是中文 + 英文', JSON.stringify(bob2.hearLangs) === JSON.stringify(['zh-CN', 'en-US']),
        JSON.stringify(bob2.hearLangs))
      check('重复设置同一组不算变化（不会每轮都写盘）',
        setMemberHearLangs(dataDir, { roomId: created.room.id, username: 'bob', langs: 'zh-CN,en-US' })
          .changed === false)

      // 归一化：不认识的语言被丢掉、去重、顺序固定
      check('脏输入被清掉（xx 丢掉、重复去掉）',
        JSON.stringify(normalizeHearLangs('en-US,xx,en-US', 'zh-CN'))
        === JSON.stringify(['zh-CN', 'en-US']), JSON.stringify(normalizeHearLangs('en-US,xx,en-US', 'zh-CN')))
      check('空输入 + 有说话语言 → 只有说话语言',
        JSON.stringify(normalizeHearLangs('', 'en-US')) === JSON.stringify(['en-US']))
      check('说话语言与读语言都空 → 空数组（不硬塞一个）',
        JSON.stringify(normalizeHearLangs('', '')) === '[]')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  rmSync(dir, { recursive: true, force: true })
}