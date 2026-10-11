/**
 * net-doctor-suite.mjs —— 网络体检脚本的断言
 * ============================================================================
 * 这个脚本的价值全在"判断得对不对"：它要在几种典型故障下给出**不同**的结论。
 * 所以这里逐个钉住那些判断，其中"防火墙规则解析"用的是**真实抓到的那两份规则文本**
 * （一台校园网里连不上的电脑上读出来的），不是编的样例。
 */

export async function runNetDoctorSuite({ it, check }) {
  const doctor = await import('../scripts/net-doctor.mjs')

  // ── 虚拟网卡的识别 ──────────────────────────────────────────────────────
  // 这条直接决定"手机上该填哪个地址"：填到 VMware 网卡上永远连不上。
  await it('虚拟网卡（VMware / 蓝牙 / 回环…）被排除在候选项之外', async () => {
    for (const name of ['VMware Network Adapter VMnet1', 'VirtualBox Host-Only Network',
      'Bluetooth 网络连接', 'Loopback Pseudo-Interface 1', 'ZeroTier One [xxx]']) {
      check(`「${name}」被判成虚拟`, doctor.isVirtual(name) === true)
    }
    for (const name of ['WLAN', '以太网', 'Wi-Fi', 'Ethernet']) {
      check(`「${name}」是真实网卡`, doctor.isVirtual(name) === false)
    }
  })

  // ── Tailscale 单独归一类（曾经被误判成"别填这个"）───────────────────────
  // 它也是虚拟网卡，但**恰恰是要填的那个**：校园网里手机和电脑不同网段、
  // 还不许互访时，这是唯一稳的路。之前它混在 VIRTUAL_HINTS 里被藏掉了。
  await it('Tailscale 不算"别填的虚拟网卡"，而是单独一类', async () => {
    check('按网卡名认出来', doctor.isTailscale('Tailscale') === true)
    check('按地址段也能认出来（100.64/10）',
      doctor.isTailscale('WLAN', '100.101.102.103') === true,
      String(doctor.inTailscaleRange('100.101.102.103')))
    check('它不是"虚拟网卡"', doctor.isVirtual('Tailscale', '100.101.102.103') === false)
    // 边界：100.63 与 100.128 都在 CGNAT 段之外
    check('100.63.x 不算', doctor.inTailscaleRange('100.63.0.1') === false)
    check('100.128.x 不算', doctor.inTailscaleRange('100.128.0.1') === false)
    check('普通内网地址不算', doctor.inTailscaleRange('10.136.1.1') === false)
  })

  await it('挑地址：有局域网就用局域网，没有才退到 Tailscale（并标明前置条件）', async () => {
    const lanOnly = doctor.pickPhoneAddress([
      { name: 'WLAN', address: '10.135.50.23', network: '10.135.0.0', bits: 16, virtual: false, tailscale: false },
    ])
    check('填局域网地址', lanOnly.address.address === '10.135.50.23')
    check('不是 Tailscale', lanOnly.tailscale === false)

    const both = doctor.pickPhoneAddress([
      { name: 'WLAN', address: '10.135.50.23', network: '10.135.0.0', bits: 16, virtual: false, tailscale: false },
      { name: 'Tailscale', address: '100.101.102.103', network: '100.64.0.0', bits: 10, virtual: false, tailscale: true },
    ])
    check('两个都有时先给局域网', both.address.address === '10.135.50.23')
    check('但要把 Tailscale 作为备选带出来', both.tailscaleCandidate !== null
      && both.tailscaleCandidate.address === '100.101.102.103', JSON.stringify(both.tailscaleCandidate))

    const onlyTailscale = doctor.pickPhoneAddress([
      { name: 'VMware Network Adapter VMnet8', address: '169.254.1.1', virtual: true, tailscale: false },
      { name: 'Tailscale', address: '100.101.102.103', network: '100.64.0.0', bits: 10, virtual: false, tailscale: true },
    ])
    check('只剩 Tailscale 时就用它（别返回 null）', onlyTailscale.address !== null
      && onlyTailscale.address.address === '100.101.102.103', JSON.stringify(onlyTailscale.address))
    check('并标明 tailscale=true（界面要提示手机也得开）', onlyTailscale.tailscale === true)
  })

  // ── 网段计算 ────────────────────────────────────────────────────────────
  await it('网段计算正确（判断手机和电脑是不是同一个网段）', async () => {
    check('255.255.255.0 掩码', doctor.network('192.168.1.108', '255.255.255.0') === '192.168.1.0',
      doctor.network('192.168.1.108', '255.255.255.0'))
    // 校园网常见 /16：掩码算错的话会让人以为"同网段没问题"，掩盖真问题
    check('/16 掩码（校园网常见）', doctor.network('10.136.119.146', '255.255.0.0') === '10.136.0.0',
      doctor.network('10.136.119.146', '255.255.0.0'))
    check('/12 掩码也能算（不是只按整字节切）',
      doctor.network('172.20.5.9', '255.240.0.0') === '172.16.0.0',
      doctor.network('172.20.5.9', '255.240.0.0'))
  })

  // ── 地址挑选 ────────────────────────────────────────────────────────────
  await it('多个网卡时：优先真实网卡，并如实说"有多个，要自己挑"', async () => {
    const onlyVirtual = doctor.pickPhoneAddress([
      { name: 'VMware Network Adapter VMnet8', address: '169.254.1.1', virtual: true },
    ])
    check('只剩虚拟网卡时不给地址（宁可不说，也不要给个填了必错的）',
      onlyVirtual.address === null, JSON.stringify(onlyVirtual))

    const twoReal = doctor.pickPhoneAddress([
      { name: 'WLAN', address: '10.136.119.146', network: '10.136.0.0', bits: 16, virtual: false },
      { name: '以太网', address: '10.137.1.2', network: '10.137.0.0', bits: 16, virtual: false },
    ])
    check('两个真实网卡时要提示"自己挑"', twoReal.multiple === true)
    check('但总要给出一个候选', twoReal.address !== null)
  })

  // ── 从真实网卡信息里挑地址 ──────────────────────────────────────────────
  await it('从 os.networkInterfaces() 的结果里挑出可用的 IPv4', async () => {
    const addresses = doctor.collectAddresses({
      'VMware Network Adapter VMnet1': [
        { family: 'IPv4', address: '169.254.145.119', netmask: '255.255.0.0', internal: false },
      ],
      'Loopback Pseudo-Interface 1': [
        { family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true },
      ],
      WLAN: [{ family: 'IPv4', address: '10.136.119.146', netmask: '255.255.0.0', internal: false }],
      'WLAN 4': [{ family: 'IPv6', address: 'fe80::1', netmask: 'ffff::', internal: false }],
    })
    check('只留下 1 个候选（回环、IPv6、APIPA 地址都剔掉）', addresses.length === 1,
      JSON.stringify(addresses))
    check('留下的正是 WLAN 那个', addresses[0].address === '10.136.119.146',
      JSON.stringify(addresses[0]))
    check('标了是真实网卡', addresses[0].virtual === false)
    check('算出了 /16 网段', addresses[0].network === '10.136.0.0' && addresses[0].bits === 16,
      JSON.stringify(addresses[0]))
  })

  // ── 防火墙规则解析（这份文本是真实抓到的）──────────────────────────────
  //
  // 那台电脑上只有两条 Node.js 入站规则：Domain/Any 与 Public/UDP。
  // 而转发进程是 **TCP** 8788 —— 所以只要网络不是 Domain，手机连进来就会被丢掉，
  // 表现就是"连接超时"。这个解析必须把这种情况判成"不行"。
  const REAL_RULES = `
Rule Name:                            Node.js JavaScript Runtime
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Domain
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             Any
Edge traversal:                       Yes
Action:                               Allow

Rule Name:                            Node.js JavaScript Runtime
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Public
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             UDP
LocalPort:                            Any
RemotePort:                           Any
Edge traversal:                       Defer to user
Action:                               Allow

Rule Name:                            Leion 同传 8788
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private,Public
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             TCP
LocalPort:                            8788
RemotePort:                           Any
Edge traversal:                       No
Action:                               Allow
`

  await it('防火墙判定：只有 Domain/Any + Public/UDP 时，判成"不行"', async () => {
    const withoutPortRule = REAL_RULES.split('Rule Name:                            Leion 同传 8788')[0]
    const verdict = doctor.judgeFirewall(withoutPortRule, 8788)
    check('认出了两条 Node.js 规则', verdict.nodeRules.length === 2,
      JSON.stringify(verdict.nodeRules))
    check('Domain/Any 不算数（换到非域网络就失效）', verdict.nodeAllowsTcp === false)
    check('整体判定为"不让连"', verdict.ok === false)
    check('规则里的协议与网段被如实带出来',
      verdict.nodeRules.some(r => r.protocol === 'UDP' && r.profiles === 'Public'),
      JSON.stringify(verdict.nodeRules))
  })

  await it('防火墙判定：有明确放行 TCP 8788 的规则时就判成"可以"', async () => {
    const verdict = doctor.judgeFirewall(REAL_RULES, 8788)
    check('认出了那条端口规则', verdict.portRule !== null, JSON.stringify(verdict.portRule))
    check('整体判定为"可以让手机连"', verdict.ok === true)
    check('带出了覆盖的网络类型', /Private/.test(verdict.portRule.profiles)
      && /Public/.test(verdict.portRule.profiles), verdict.portRule.profiles)
  })

  await it('防火墙判定：程序规则只要覆盖 TCP + Private/Public 就算数', async () => {
    const text = `
Rule Name:                            Node.js JavaScript Runtime
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private,Public
Protocol:                             Any
LocalPort:                            Any
Action:                               Allow
`
    const verdict = doctor.judgeFirewall(text, 8788)
    check('这种情况连"端口规则"都不需要', verdict.portRule === null)
    check('仍然判成可以让手机连（Protocol=Any 覆盖了 TCP）', verdict.ok === true,
      JSON.stringify(verdict))
  })

  await it('防火墙判定：停用的规则不算数（别被"已有规则"骗了）', async () => {
    const text = `
Rule Name:                            Leion 同传 8788
----------------------------------------------------------------------
Enabled:                              No
Direction:                            In
Profiles:                             Private,Public
Protocol:                             TCP
LocalPort:                            8788
Action:                               Allow
`
    const verdict = doctor.judgeFirewall(text, 8788)
    check('停用的端口规则不认', verdict.portRule === null)
    check('整体仍然判定为"不让连"', verdict.ok === false)
  })

  // ── 连接探测 ────────────────────────────────────────────────────────────
  await it('连接探测如实返回：没人听的端口是 false，而不是超时卡住', async () => {
    const free = await doctor.probe('127.0.0.1', 18789, 400)
    check('空闲端口返回 false', free === false)
    const refused = await doctor.probe('127.0.0.1', 1, 400)
    check('被拒绝的端口也返回 false（不抛异常）', refused === false)
  })

  // ── netstat 兜底：正在跑的转发进程是旧版本时靠它判断 ─────────────────────
  await it('netstat 兜底：能分辨"只是本机在听"和"真的有外来连接"', async () => {
    const onlyListening = `
  TCP    0.0.0.0:8788           0.0.0.0:0              LISTENING       9304
  TCP    127.0.0.1:8788         127.0.0.1:52100        ESTABLISHED     9304
`
    const first = doctor.countForeign(onlyListening, 8788)
    check('只有监听 + 本机自连时，外来连接数是 0（不会把回环算成手机）',
      first.foreign === 0 && first.listening === true, JSON.stringify(first))

    const withPhone = onlyListening
      + '\n  TCP    10.136.119.146:8788    10.136.88.21:49812     ESTABLISHED     9304\n'
    const second = doctor.countForeign(withPhone, 8788)
    check('从局域网地址连进来时算 1 条（这就是"手机连到了电脑"的证据）',
      second.foreign === 1, JSON.stringify(second))
  })
}
