/**
 * android-order-suite.mjs —— 安卓侧的"编译能过、一跑就崩"静态检查
 * ============================================================================
 *
 * <p><b>为什么需要这个套件</b>：我对安卓代码的验证上限是"能编译"——
 * 我没有设备也没有模拟器，**跑不起来**。而有一类 bug 恰恰卡在这个缝里：
 * 编译完全通过，一打开 App 就崩。
 *
 * <p>真实踩到的那次（2026-10-12，用户报"一打开直接报空指针"）：
 * <pre>
 *   private void setupGlasses() {
 *       glassesView = new GlassesSubtitleView(this);
 *       glasses.setCameraPreviewBackground(...);   // ← 这里 glasses 还是 null
 *       ...
 *       glasses = new GlassesSdk(this, ...);        // ← 赋值在下面
 *   }
 * </pre>
 * 编译通过（字段类型对、方法存在），运行时 NPE，App 起不来。
 *
 * <p><b>能机械查出来的不变量</b>：一个字段如果在这个文件里只有一处
 * `field = new ...` 构造赋值，那么**第一次解引用 `field.` 必须出现在它之后**。
 * 文本顺序在这里等价于执行顺序（都在 onCreate 那条路上），所以这条检查是可靠的，
 * 而且几乎没有误报 —— 字段声明写成 `= null`，不会被当成构造赋值。
 *
 * <p>它覆盖不了所有"跑起来才知道"的问题（线程、生命周期、SDK 行为都不行），
 * 但它精确覆盖了**最廉价、最常见、也最丢脸**的那一类：顺序写错。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../lib/paths.mjs'

/** 文件 → 要检查的字段（这些字段都只有一处 `= new ...` 构造赋值）。 */
const TARGETS = [
  {
    file: join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay', 'MainActivity.java'),
    label: 'MainActivity',
    fields: ['glasses', 'glassesView', 'client', 'records', 'subtitles', 'pageHost', 'overlayHost'],
  },
]

/** 找出 `field = new ...` 的行号（第一处）。找不到返回 -1。 */
export function findConstructLine(lines, field) {
  const pattern = new RegExp(`^\\s*${field}\\s*=\\s*new\\s`)
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index + 1
  }
  return -1
}

/** 找出第一次解引用 `field.` 的行号（排除 `field = ` 自身与同名前缀字段）。 */
export function findFirstDerefLine(lines, field) {
  // `field.` 后面必须紧跟一个非标识符字符，避免把 glassesView 当成 glasses
  const pattern = new RegExp(`\\b${field}\\s*\\.\\s*[A-Za-z_]`)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // 跳过赋值左侧：`field = new X` 里的 `field` 后面不是点，本来就不会命中；
    // 但 `field = other.field` 这类要排除掉
    if (new RegExp(`^\\s*${field}\\s*=`).test(line)) continue
    if (pattern.test(line)) return index + 1
  }
  return -1
}

/**
 * 把注释与字符串/字符字面量的**内容**换成空格，保留换行与引号本身。
 *
 * <p>为什么必须做这一步：这个检查第一版跑出了两个误报 ——
 * ① 我在注释里写了 `glasses.setCameraPreviewBackground(...)` 解释那个 bug，
 *    检查把注释当成了真代码（**检查应该只看代码，不看散文**）；
 * ② `"http://…"` 里的 `//` 会被当成行注释，把那一行后面的内容整段吃掉。
 */
export function stripComments(source) {
  let out = ''
  let index = 0
  let inLine = false
  let inBlock = false
  let inString = false
  let inChar = false
  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch } else out += ' '
      index += 1
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; out += '  '; index += 2; continue }
      out += ch === '\n' ? ch : ' '
      index += 1
      continue
    }
    if (inString || inChar) {
      if (ch === '\\') { out += '  '; index += 2; continue }
      if (inString && ch === '"') { inString = false; out += '"'; index += 1; continue }
      if (inChar && ch === "'") { inChar = false; out += "'"; index += 1; continue }
      out += ch === '\n' ? ch : ' '
      index += 1
      continue
    }
    if (ch === '/' && next === '/') { inLine = true; out += '  '; index += 2; continue }
    if (ch === '/' && next === '*') { inBlock = true; out += '  '; index += 2; continue }
    if (ch === '"') { inString = true; out += ch; index += 1; continue }
    if (ch === "'") { inChar = true; out += ch; index += 1; continue }
    out += ch
    index += 1
  }
  return out
}

/**
 * 算出每一行**开始之前**的花括号深度。
 *
 * <p>这是本检查的关键：**文本顺序不等于执行顺序**。
 * 匿名类与 lambda 里的代码是**推迟执行**的，写在赋值前面完全没问题 ——
 * 第一版没考虑这点，于是把 `glassesView.setPageListener(...)` 里那句
 * `client.sendDiag(...)` 判成了"先用了再构造"（那是误报）。
 *
 * <p>所以只比较**和构造赋值同一层**的使用：同一层意味着同一条执行路径、
 * 不存在推迟。（代价：写在 `if` 里、又在赋值之前的使用查不出来 ——
 * 这一条如实写在下面的断言说明里，不假装它全覆盖。）
 */
export function annotateDepth(lines) {
  let depth = 0
  return lines.map(line => {
    const before = depth
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    return { before, after: depth }
  })
}

/**
 * 源码完整性：**乱码**与**被吃掉的引号**。
 *
 * <p>为什么必须有一条检查盯着这个（2026-10-27 真实事故）：
 * 4.31 那次提交把 `LanClient.java` 整个重写了一遍，写成的是
 * **"原文 UTF-8 字节按 GBK 解码"** 的结果 —— 中文全部变成 `鐧诲綍` 这类乱码，
 * 而且每段中文的**最后一个字的字节会把紧跟的引号一起吞掉**。
 * 于是 javac 报了一串「未结束的字符串文字」，9 个错、看起来像编码环境的问题，
 * 实际是**文件内容坏了**。（`git diff` 里那些 `-正确 / +乱码` 成对出现就是签名。）
 *
 * <p>三种症状分别对应三条判据，都能机械查：
 *   ① 含 `閫氫俊` 这类只在乱码里出现的字（正常中文几乎不会用到）；
 *   ② 严格 UTF-8 解码失败（说明文件根本不是 UTF-8 存的）；
 *   ③ 去掉注释与字符串内容后，**同一行里的引号必须成对**（Java 的字符串不能跨行）。
 *
 * <p>判据 ③ 只在代码行上成立，所以先过一遍 `stripComments`：
 * 注释与字面量的内容会被换成空格，散文里那些成对的引号 `<code>"我是谁"</code> 不会误报。
 * 判据 ② 同理只对代码文件生效 —— `docs/05-数据通路.md` 里就**故意**写着 `���`
 * 当作"收件箱被写坏了长什么样"的样例，文档不是代码，不该被这条判据管。
 *
 * <p>但文档**要举证乱码**的时候（`docs/20` 就贴了 4.31 事故的原文与乱码对照），
 * 判据 ① 会误报。所以留了一个**精确到行**的豁免：那一行写上 `mojibake-ok` 就跳过。
 * 故意只给行、不给文件 —— 整文件豁免等于把那一页的防线全撤了。
 */
export const MOJIBAKE_EVIDENCE_TAG = 'mojibake-ok'
export const MOJIBAKE_MARKERS = ['锛', '鐨', '鏄', '鍦', '浜', '鎴', '缁', '杩', '璇', '瑁', '璁', '闇'] // mojibake-ok：这一行列的就是乱码字本身

export function sourceIntegrityProblems(text, { strict = true } = {}) {
  const problems = []
  if (strict && text.includes('\uFFFD')) {
    const line = text.split('\n').findIndex(l => l.includes('\uFFFD')) + 1
    problems.push(`第 ${String(line).padStart(3, ' ')} 行出现 � —— 文件不是合法 UTF-8（可能被按 GBK 存过）`)
  }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(MOJIBAKE_EVIDENCE_TAG)) continue   // 这一行是在举证乱码
    const markers = MOJIBAKE_MARKERS.filter(m => lines[index].includes(m))
    if (markers.length > 0) {
      problems.push(`第 ${String(index + 1).padStart(3, ' ')} 行含乱码 ${markers.join('')}：`
        + lines[index].trim().slice(0, 60))
    }
  }
  if (strict) {
    const codeLines = stripComments(text).split('\n')
    for (let index = 0; index < codeLines.length; index += 1) {
      const line = codeLines[index]
      if (line.includes('"""')) continue          // 文本块允许跨行，跳过
      if (!/"/.test(line)) continue
      const quotes = (line.match(/"/g) || []).length
      if (quotes % 2 === 1) {
        problems.push(`第 ${String(index + 1).padStart(3, ' ')} 行引号不成对（${quotes} 个）—— `
          + '字符串没闭合，javac 会报「未结束的字符串文字」')
      }
    }
  }
  return problems
}

/** 递归列出目录下的指定扩展名文件（跳过 build/ 之类生成目录）。 */
function collectSources(dir, extensions, found = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const name of entries) {
    if (name === 'build' || name === '.gradle' || name === 'node_modules') continue
    const full = join(dir, name)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (info.isDirectory()) collectSources(full, extensions, found)
    else if (extensions.some(ext => name.endsWith(ext))) found.push(full)
  }
  return found
}

export async function runAndroidOrderSuite({ it, check }) {
  for (const target of TARGETS) {
    const lines = stripComments(readFileSync(target.file, 'utf-8')).split(/\r?\n/)
    const depths = annotateDepth(lines)

    await it(`${target.label}：同层里字段必须**先构造、再使用**（编译能过但一打开就崩的那类）`, async () => {
      for (const field of target.fields) {
        const constructLine = findConstructLine(lines, field)
        if (constructLine < 0) {
          check(`${field}：跳过（找不到 '${field} = new …' 构造赋值）`, true, String(constructLine))
          continue
        }
        const constructDepth = depths[constructLine - 1].before
        const pattern = new RegExp(`\\b${field}\\s*\\.\\s*[A-Za-z_]`)
        const guardPattern = new RegExp(`\\b${field}\\s*!=\\s*null`)
        let violation = -1
        for (let index = 0; index < constructLine - 1; index += 1) {
          if (depths[index].before !== constructDepth) continue   // 更深 = 推迟/条件执行，不算
          if (new RegExp(`^\\s*${field}\\s*=`).test(lines[index])) continue
          const hit = pattern.exec(lines[index])
          if (hit === null) continue
          // 同一行前面已经有 null 守卫（`field != null && field.x()`）→ 安全，不算违规。
          // 这一条也是从误报里补的：online() 里那句
          // `return client != null && client.isRunning() ...` 被判成"先用了"，但它不会崩。
          const guard = guardPattern.exec(lines[index])
          if (guard !== null && guard.index < hit.index) continue
          violation = index + 1
          break
        }
        check(`${field}：同层没有"先用了再构造"`,
          violation < 0,
          violation < 0 ? '' : `**第 ${violation} 行用了它，而构造在第 ${constructLine} 行** —— `
            + `运行时必空指针。那一行是：${lines[violation - 1].trim()}`)
      }
    })
  }

  // ── 页面构建：buildXxxPage() 必须真的被调用 ──────────────────────────────
  //
  // 4.4 的一次真实闪退就是这条没守住：`buildTermsPage()` 写好了却**没有被调用**，
  // 于是 `termsPage` 是 null，`showPage()` 第一行 setVisibility 就空指针 ——
  // **打开 App 就闪退**，而编译毫无怨言（私有方法没人调用只是警告）。
  //
  // 这类错误机械可查：文件里每个 `private void build…Page()` 都必须至少被调用一次。
  const pageFile = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay', 'MainActivity.java')
  const pageSource = stripComments(readFileSync(pageFile, 'utf-8'))

  await it('每个 build…Page() 都必须被调用（写了不调用 = 打开就闪退）', () => {
    const declared = [...pageSource.matchAll(/private\s+void\s+(build\w*Page)\s*\(\s*\)/g)].map(m => m[1])
    check('至少找到了 build*Page 方法', declared.length > 0, declared.join(','))
    for (const name of declared) {
      const callPattern = new RegExp(`(^|[^.\\w])${name}\\s*\\(\\s*\\)`, 'm')
      // 去掉声明本身再找调用，避免"声明被当成调用"
      const withoutDeclaration = pageSource.replace(
        new RegExp(`private\\s+void\\s+${name}\\s*\\(\\s*\\)`, 'g'), '')
      check(`${name} 有被调用`, callPattern.test(withoutDeclaration),
        `${name} 声明了但没有任何调用点 —— 那个页面永远是 null`)
    }
  })

  await it('页面切换对"还没建出来的页面"免疫（不因缺页面而闪退）', () => {
    // showPage 里不能裸着 setVisibility：要么判空，要么走统一的 showOnly()
    const showPageBody = pageSource.slice(pageSource.indexOf('private void showPage(Page page)'))
    const body = showPageBody.slice(0, showPageBody.indexOf('\n    }', 200))
    const bare = body
      .split('\n')
      .filter(line => /\.setVisibility\s*\(/.test(line))
      .filter(line => !/showOnly\(|!=\s*null|==\s*null/.test(line))
    check('showPage 里没有裸 setVisibility', bare.length === 0, bare.join(' | '))
  })

  // 反向自检：把"用在前、构造在后"的假代码喂给检查函数，它必须报出来。
  // 没有这一条的话，上面那个断言可能永远为真而我们还以为它在守着。
  await it('顺序检查本身有效：故意写反的代码必须被判为不合格', async () => {
    const bad = [
      'private Foo foo = null;',
      'void setup() {',
      '  foo.doThing();',
      '  foo = new Foo();',
      '}',
    ]
    const construct = findConstructLine(bad, 'foo')
    const deref = findFirstDerefLine(bad, 'foo')
    check('抓到了「构造」那行', construct === 4, String(construct))
    check('抓到了「使用」那行', deref === 3, String(deref))
    check('判定为不合格（用在前）', deref < construct, `${deref} vs ${construct}`)

    const good = [
      'private Foo foo = null;',
      'void setup() {',
      '  foo = new Foo();',
      '  foo.doThing();',
      '}',
    ]
    check('正常代码判为合格',
      findFirstDerefLine(good, 'foo') > findConstructLine(good, 'foo'))
  })

  // 前缀字段不能被误判：glassesView 不能当成 glasses 的使用
  await it('同名前缀字段不误判（glassesView 不算 glasses 的解引用）', async () => {
    const lines = [
      'void setup() {',
      '  glassesView = new GlassesSubtitleView(this);',
      '  glassesView.setTuning(1f, 2, 3);',
      '  glasses = new GlassesSdk(this, null);',
      '  glasses.cast(v);',
      '}',
    ]
    check('glasses 的第一次解引用是第 5 行，不是第 3 行',
      findFirstDerefLine(lines, 'glasses') === 5,
      String(findFirstDerefLine(lines, 'glasses')))
  })

  // 注释里提到的方法调用**不算使用** —— 这条是从一次真实误报里补的：
  // 我在注释里写了 `glasses.setCameraPreviewBackground(...)` 解释那个 bug，
  // 检查把它当成真代码，于是"修好了"的代码仍被判不合格。
  await it('注释与字符串里的内容不算代码（两次真实误报的回归）', async () => {
    const stripped = stripComments([
      'void setup() {',
      '  // 曾经错写成：glasses.setCameraPreviewBackground(true)',
      '  String url = "http://127.0.0.1:8788/x";',
      '  glasses = new GlassesSdk(this, null);',
      '  glasses.cast(v);',
      '}',
    ].join('\n'))
    const lines = stripped.split('\n')
    check('行数没变（行号仍然可用）', lines.length === 6, String(lines.length))
    check('注释内容被清掉', lines[1].trim() === '', JSON.stringify(lines[1]))
    check('字符串内容也没了（但引号还在，结构没被破坏）',
      lines[2].includes('"') && !lines[2].includes('127.0.0.1'), lines[2])
    check('注释里的调用不再被当成使用', findFirstDerefLine(lines, 'glasses') === 5,
      String(findFirstDerefLine(lines, 'glasses')))
  })

  // lambda / 匿名类里的代码是**推迟执行**的，写在赋值前面完全没问题。
  // 第一版没考虑这点，把 setPageListener(...) 里那句 client.sendDiag(...) 判成了
  // "先用了再构造" —— 那是误报。所以按花括号深度比较。
  await it('推迟执行的代码不算"先用了再构造"（第二次误报的回归）', async () => {    const lines = stripComments([
      'void setup() {',
      '  view.setListener((a, b) -> {',
      '    client.sendDiag("x");',
      '  });',
      '  client = new LanClient(this, null);',
      '  client.start();',
      '}',
    ].join('\n')).split('\n')
    const depths = annotateDepth(lines)
    const constructLine = findConstructLine(lines, 'client')
    const constructDepth = depths[constructLine - 1].before
    check('lambda 里那句的深度更深（所以会被跳过）',
      depths[2].before > constructDepth, `${depths[2].before} vs ${constructDepth}`)
    check('同层那句仍然在同一深度（所以会被检查）',
      depths[5].before === constructDepth, `${depths[5].before} vs ${constructDepth}`)
  })

  // 有 null 守卫的用法不算违规 —— 第三次真实误报：
  // `return client != null && client.isRunning();` 被判成"先用了"，但它不会崩。
  await it('带 null 守卫的用法不算违规（第三次误报的回归）', async () => {
    const field = 'client'
    const line = '    return client != null && client.isRunning() && deviceName != null;'
    const hit = new RegExp(`\\b${field}\\s*\\.\\s*[A-Za-z_]`).exec(line)
    const guard = new RegExp(`\\b${field}\\s*!=\\s*null`).exec(line)
    check('认出了守卫在解引用之前', guard !== null && guard.index < hit.index,
      `guard=${guard && guard.index} deref=${hit && hit.index}`)

    const bad = '    client.sendDiag("x");'
    check('没有守卫的那种仍然会被抓',
      new RegExp(`\\b${field}\\s*!=\\s*null`).test(bad) === false, bad.trim())
  })

  // ── 源码完整性：乱码 / 非法 UTF-8 / 被吃掉的引号 ──────────────────────────

  // 反向自检先做：用真实的"UTF-8 字节按 GBK 解码"复现 4.31 那次事故。
  // 只断言"干净代码不报"是不够的 —— 那样检查可能永远为真而我们以为它在守着。
  await it('完整性检查本身有效：GBK 误读的代码必须被判坏（4.31 事故的回归）', () => {
    const corrupt = correct => new TextDecoder('gbk').decode(Buffer.from(correct, 'utf8'))
    const misread = corrupt('已送到电脑：')
    check('复现出来的确实是乱码（不是原文）', misread !== '已送到电脑：', misread)

    const mojibake = sourceIntegrityProblems(`listener.onStatus("${corrupt('连接失败：')}" + detail);`)
    check('报出乱码', mojibake.some(p => p.includes('含乱码')), mojibake.join('；'))

    // 事故里的第二个症状：最后一个汉字的字节把结尾引号吞掉 → 引号只剩一个
    const swallowed = sourceIntegrityProblems(`listener.onStatus("${misread} + detail);`)
    check('报出引号不成对', swallowed.some(p => p.includes('引号不成对')), swallowed.join('；'))

    const clean = 'listener.onStatus("连接失败：" + describe(error));'
    check('干净的一行都不报', sourceIntegrityProblems(clean).length === 0,
      sourceIntegrityProblems(clean).join('；'))

    // 散文里的成对引号（注释里的 `"我是谁"`）不该被当成代码
    const prose = '    /** 界面必须区分"连上了电脑"和"同传真的在工作"。 */'
    check('注释里的引号不误报', sourceIntegrityProblems(prose).length === 0,
      sourceIntegrityProblems(prose).join('；'))
  })

  await it('房间页没有术语库按钮（选库只在建房那一步，会中不可改）', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const roomXml = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout', 'page_room.xml'), 'utf-8')
    check('page_room.xml 里没有 roomLibraries 这个控件', !roomXml.includes('roomLibraries'),
      '房间页底部只留：开麦 / 开始同传 / 退出 / 锁定发言')

    const roomJava = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')
    check('RoomActivity 不再引用这个 id', !roomJava.includes('roomLibraries'), '还残留 findViewById')
    check('房间页不再能改本场术语库', !roomJava.includes('orgSetRoomLibraries'),
      '术语在进房那一刻就冻结了（docs/21：建房时选库 → 快照）')

    // 反向：不能一边删按钮、一边把唯一的选库入口也弄丢 —— 建房流程里必须还在
    const roomsJava = readFileSync(join(javaDir, 'RoomsActivity.java'), 'utf-8')
    check('建房那一步仍然提供选库', roomsJava.includes('showLibraryPicker') && roomsJava.includes('orgSetRoomLibraries'),
      '否则用户就没有任何地方能选库了')
  })

  await it('authWhoAmI 返回拆过包的正文（外壳会让"打开就判成没登录"，单会话下还顺带踢掉另一台）', () => {
    const source = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay',
      'LanClient.java'), 'utf-8')
    const at = source.indexOf('public JSONObject authWhoAmI()')
    check('找得到 authWhoAmI', at > 0, String(at))
    const snippet = source.slice(at, source.indexOf('\n    }', at))
    check('方法体里拆掉了 { code, json } 外壳', snippet.includes('optJSONObject("json")'),
      '直接 return requestWithCode(...) 时，界面读 optBoolean("ok") 永远是 false')
    check('把 HTTP 码带回来（界面要分清 401 与"连不上"）', snippet.includes('_status'),
      '401 才清登录态；网络不通不许踢')
  })

  await it('被顶替时必须自己停止上传（服务端只管裁决，它不知道我还在录音）', () => {
    const roomActivity = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion',
      'lanrelay', 'RoomActivity.java'), 'utf-8')
    const methodBody = (name) => {
      const at = roomActivity.indexOf(`private void ${name}(`)
      check(`找得到 ${name}()`, at > 0, String(at))
      return roomActivity.slice(at, roomActivity.indexOf('\n    }', at))
    }

    const lost = methodBody('onFloorLost')
    check('onFloorLost 会真的停上传（不是只改按钮文字）', lost.includes('stopUpload('), lost.slice(0, 80))

    const stop = methodBody('stopUpload')
    check('stopUpload 调用了 mic.stop()', stop.includes('mic.stop()'), '否则麦克风还在往识别流里灌音频')
    check('停完把按钮刷回空闲态', stop.includes('updateUploadButton()'))

    // 轮询里必须走到 onFloorLost：只刷 takingChanged 就是 4.33 那个故障
    check('轮询发现"已不是持麦者"会触发 onFloorLost',
      /takingChanged\(holder[\s\S]{0,600}onFloorLost\(holder\)/.test(roomActivity),
      '轮询不能只刷新文字')

    // 心跳失败是最快的那条路（2 秒轮询之前就能知道），也要停
    check('心跳被拒绝也立刻停',
      /heartbeat[\s\S]{0,600}stopUpload\(/.test(roomActivity), '服务端说"不是持麦者"时不能等下一轮')

    // 按钮要能一眼看出"在传/没传"：两态颜色不同，否则用户无法判断自己是否还在占麦
    const button = methodBody('updateUploadButton')
    check('上传与空闲用两种颜色', button.includes('0xFF1565C0') && button.includes('0xFF263238'),
      '蓝 = 正在上传，灰 = 空闲')
  })

  await it('发言权推送（/ws）接得对：轮询与推送共用一条应用路径，断了自动退回轮询', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const room = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')
    const socket = readFileSync(join(javaDir, 'FloorSocket.java'), 'utf-8')

    check('有 FloorSocket（WS 客户端）', socket.includes('extends WebSocketClient'), '没接 Java-WebSocket')
    check('推送通道在房间页被启动', /private void startFloorSocket\(/.test(room) && /startFloorSocket\(host, secret, token\)/.test(room),
      '没有连上去就等于没做')
    check('离开房间时断开（不能留下野连接）', /onDestroy[\s\S]{0,400}floorSocket\.stop\(\)/.test(room),
      'Activity 销毁要停掉它')

    // 关键：轮询与推送必须走同一条应用路径 —— 否则"推送很快但忘了停上传"这种不对称 bug 会重演（4.34）
    check('两处入口都走 applyFloorState',
      (room.match(/applyFloorState\(/g) || []).length >= 3,
      '轮询一处 + 推送一处 + 定义一处')
    check('applyFloorState 里带着"被顶替就停上传"的判断',
      /applyFloorState[\s\S]{0,400}onFloorLost\(/.test(room), '不能只有界面刷新')

    // 推送活着时轮询退成看门狗，但**必须还留一轮询**（WS 假死时它是唯一发现者）
    check('有"推送活着就放慢轮询"的分支', /wsOnline\s*\?\s*FLOOR_POLL_WATCHDOG_MS/.test(room),
      '没有它就没有兜底')
    check('看门狗间隔仍在租约之内', /FLOOR_POLL_WATCHDOG_MS\s*=\s*(\d+)L/.test(room)
      && Number(/FLOOR_POLL_WATCHDOG_MS\s*=\s*(\d+)L/.exec(room)[1]) < 15000, '必须小于服务端 15 秒租约')
    check('心跳有独立的定时器（不靠推送消息顺带续租）', /private void scheduleHeartbeatTick\(/.test(room),
      '推送稀少时租约会把麦判成掉线')

    const gradle = readFileSync(join(ROOT, 'android', 'app', 'build.gradle.kts'), 'utf-8')
    check('依赖里钉着 Java-WebSocket 1.6.0（本机缓存里有，离线可构建）',
      /implementation\("org\.java-websocket:Java-WebSocket:1\.6\.0"\)/.test(gradle), gradle.includes('Java-WebSocket'))
    check('slf4j-api 也在（Java-WebSocket 的编译期依赖）',
      /implementation\("org\.slf4j:slf4j-api:1\.7\.30"\)/.test(gradle))
  })

  await it('设置页与隐私页：接得对、写得全（A2）', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const layoutDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const settingsJava = readFileSync(join(javaDir, 'SettingsActivity.java'), 'utf-8')
    const privacyJava = readFileSync(join(javaDir, 'PrivacyActivity.java'), 'utf-8')
    const settingsXml = readFileSync(join(layoutDir, 'page_settings_app.xml'), 'utf-8')
    const privacyXml = readFileSync(join(layoutDir, 'page_privacy.xml'), 'utf-8')
    const homeXml = readFileSync(join(layoutDir, 'page_home.xml'), 'utf-8')
    const homeJava = readFileSync(join(javaDir, 'HomeActivity.java'), 'utf-8')
    const manifest = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf-8')

    // 1) 两个 Activity 都在清单里，且不对外导出
    for (const name of ['SettingsActivity', 'PrivacyActivity']) {
      check(`清单里注册了 ${name}`, new RegExp(`android:name="\\.${name}"`).test(manifest), name)
      check(`${name} 不对外导出`, new RegExp(`\\.${name}"[\\s\\S]{0,80}exported="false"`).test(manifest))
    }

    // 2) 首页能进得去（否则页面存在也白做）
    check('首页有设置按钮', homeXml.includes('@+id/homeSettings'), '没有入口')
    check('首页按钮真的打开设置页',
      /homeSettings[\s\S]{0,160}SettingsActivity\.class/.test(homeJava), homeJava.slice(0, 80))
    check('设置页能进隐私页',
      /setAppPrivacy[\s\S]{0,160}PrivacyActivity\.class/.test(settingsJava))

    // 3) 每个 R.id.* 在对应布局里都真实存在 —— 少一个就是构建期/运行期的空指针
    for (const [javaName, javaText, xmlName, xmlText] of [
      ['SettingsActivity', settingsJava, 'page_settings_app.xml', settingsXml],
      ['PrivacyActivity', privacyJava, 'page_privacy.xml', privacyXml],
    ]) {
      const used = [...javaText.matchAll(/R\.id\.(\w+)/g)].map(m => m[1])
      check(`${javaName} 用到了 id`, used.length > 0, javaName)
      for (const id of used) {
        check(`${javaName} 的 ${id} 在 ${xmlName} 里存在`,
          new RegExp(`@\\+id/${id}\\b`).test(xmlText), `缺 @+id/${id}`)
      }
    }

    // 4) 设置页要真的能改东西（不是摆设）
    check('能保存服务器地址', /putString\("host"/.test(settingsJava))
    check('能保存共享密钥', /putString\("secret"/.test(settingsJava))
    check('能切换"我说什么语言"', /putString\("speakLang"/.test(settingsJava))
    check('校对开关以电脑端为准（读 + 写都走接口）',
      /client\.settingsGet\(\)/.test(settingsJava) && /client\.settingsPutProofread\(/.test(settingsJava))
    check('能清空本机记录', /clearAll\(\)/.test(settingsJava))

    const records = readFileSync(join(javaDir, 'Records.java'), 'utf-8')
    check('Records.clearAll 真的把文件写空', /public int clearAll\(\)[\s\S]{0,400}write\(new ArrayList<>\(\)\)/.test(records),
      '只返回条数不写盘 = 按钮点了没反应')

    // 5) 隐私文案必须覆盖"这套系统真实做过的事"，不能是一句空话
    check('写了字幕保留期（7 天）', privacyXml.includes('7 天'))
    check('写了音频轮转上限（1 GB）', privacyXml.includes('1 GB'))
    check('写了本机记录上限（200 条）', privacyXml.includes('200 条'))
    check('写了公网明文的风险（TLS）', privacyXml.includes('明文') && privacyXml.includes('TLS'))
    check('写了不采集画面', privacyXml.includes('摄像头'))
  })

  await it('主动停止上传不许报错（"上传出错：thread interrupted" 的回归）', () => {
    // 用户点「结束同传」时 stop() 会 interrupt 录音线程，而那一刻线程很可能正卡在上传的网络
    // 调用里 —— 被打断抛出的异常消息就是 "thread interrupted"，被当成故障报成红字。
    const uploader = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion',
      'lanrelay', 'MicUploader.java'), 'utf-8')
    const methodBody = (name) => {
      const at = uploader.indexOf(name)
      check(`找得到 ${name}`, at > 0, name)
      return uploader.slice(at, uploader.indexOf('\n    }', at))
    }

    check('有"主动停"标志', /private volatile boolean stopping/.test(uploader),
      '没有它就没法区分"预期打断"和"真故障"')

    // stop() 必须是"先置标志、再（宽限后）打断"，而且不能一上来就 interrupt ——
    // interrupt 唯一的效果是打断正在上传的那一块，最后半句话就丢了。
    const stopAt = uploader.indexOf('public void stop()')
    const stopBody = uploader.slice(stopAt, uploader.indexOf('\n    }', stopAt))
    const flagAt = stopBody.indexOf('stopping = true')
    const joinAt = stopBody.indexOf('join(STOP_GRACE_MS)')
    const interruptAt = stopBody.indexOf('current.interrupt()')
    check('stop() 先置 stopping', flagAt >= 0, `flag@${flagAt}`)
    check('stop() 先给线程 2 秒把尾巴发完', joinAt > flagAt, `flag@${flagAt} join@${joinAt}`)
    check('打断只作为兜底（在宽限之后）', interruptAt > joinAt, `join@${joinAt} interrupt@${interruptAt}`)

    // 上传失败分支：主动停时静默退出，不报错
    check('上传失败分支会先看"是不是主动停"',
      /catch \(Exception error\)[\s\S]{0,200}if \(stopping\)[\s\S]{0,120}return false/.test(uploader),
      '否则用户点了结束仍会看到红字')

    // 录音循环的异常分支：只有"还在跑且不是主动停"才算故障
    check('录音循环的 catch 判 running && !stopping',
      /if \(running && !stopping\)/.test(uploader), '只用 running 判会把主动停也算成故障')

    // 关键：start() 必须复位，否则停过一次之后真错误就再也报不出来了
    const startAt = uploader.indexOf('public String start()')
    const startBody = uploader.slice(startAt, uploader.indexOf('\n    }', startAt))
    check('start() 里复位了 stopping', /stopping = false/.test(startBody),
      '不复位 = 停过一次之后所有真错误都被吞掉')
  })

  await it('建房后邀请码不会被选库框挡掉（4.41）', () => {
    const src = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion',
      'lanrelay', 'RoomsActivity.java'), 'utf-8')

    // 现象：建房成功立刻弹术语库对话框，页面上的邀请码被整个盖住，用户来不及抄。
    check('建房成功后先弹一条长 Toast 报邀请码（Toast 显示在对话框之上）',
      /Toast\.makeText\(this, "本场邀请码：" \+ code, Toast\.LENGTH_LONG\)/.test(src),
      '没有它，邀请码就被对话框盖住了')
    check('邀请码被传进选库框', /chooseLibsAfterCreate\(id, room\.optString\("name", name\), code\)/.test(src))
    check('选库框的标题里带着邀请码', /codeLine[^\n]*本场术语库/.test(src), '标题要能直接看到码')
    check('选库框的正文也重复一次邀请码', /setMessage\([^)]*code/.test(src), '正文再写一次，抄错的概率更低')
  })

  await it('被别处登录顶下线时要**当场提示**（4.41，用户报的"静默"）', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const watch = readFileSync(join(javaDir, 'SessionWatch.java'), 'utf-8')
    const client = readFileSync(join(javaDir, 'LanClient.java'), 'utf-8')
    const home = readFileSync(join(javaDir, 'HomeActivity.java'), 'utf-8')
    const rooms = readFileSync(join(javaDir, 'RoomsActivity.java'), 'utf-8')
    const room = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')

    check('有会话监听类', /class SessionWatch/.test(watch))
    check('监听调的是 checkSession', /client\.checkSession\(\)/.test(watch))
    check('只有 SessionExpiredException 才回调（网络失败不算掉登录）',
      /catch \(LanClient\.SessionExpiredException/.test(watch) && /catch \(Exception ignored\)/.test(watch))

    // 401 统一走 throwIfSessionExpired —— 它原先是没有调用点的死代码（B3）
    check('checkSession 用上了 throwIfSessionExpired', /throwIfSessionExpired\(wrapper\)/.test(client),
      '原来这两个类是死代码，现在必须真的被调用')

    check('首页登录后开始监听', /private void startSessionWatch\(\)/.test(home) && /sessionWatch\.start\(\)/.test(home))
    check('首页被踢时清 token 并回登录页',
      /sessionWatch[\s\S]{0,600}remove\("accountToken"\)[\s\S]{0,300}showLogin\(\)/.test(home))
    check('房间大厅也监听', /new SessionWatch\(client[\s\S]{0,500}sessionWatch\.start\(\)/.test(rooms))
    check('房间内轮询发现 401 就提示并退出',
      /optInt\("httpStatus", 0\) == 401[\s\S]{0,200}showKicked\(/.test(room), '房间里也不能静默')
    check('showKicked 清掉本地 token 并结束页面',
      /private void showKicked\(String hint\)[\s\S]{0,800}remove\("accountToken"\)[\s\S]{0,300}finish/.test(room))
  })

  await it('字幕两条通道共用一条渲染路径（4.43：长轮询 + WS 推送）', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const socket = readFileSync(join(javaDir, 'FloorSocket.java'), 'utf-8')
    const room = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')

    check('推送通道认得 type=frame', /"frame"\.equals\(type\)/.test(socket), socket.slice(0, 120))
    check('Listener 有 onFrame 回调', /void onFrame\(JSONObject message\)/.test(socket))

    // 关键不变量：长轮询与 WS 都必须走同一个 applyFrame，否则两条路迟早渲染得不一样
    check('有共用的 applyFrame', /private void applyFrame\(/.test(room))
    check('长轮询那条路也走 applyFrame', /public void onFrame\(String speaker[\s\S]{0,300}applyFrame\(/.test(room))
    check('WS 那条路也走 applyFrame', /public void onFrame\(final JSONObject message\)[\s\S]{0,1600}applyFrame\(/.test(room),
      'WS 收到帧后必须复用渲染，而不是各写一份')
    check('长轮询仍然保留（WS 断了要有兜底）', /request\("\/frame\?since=/.test(readFileSync(join(javaDir, 'LanClient.java'), 'utf-8')) ||
      /\/frame\?since=/.test(readFileSync(join(javaDir, 'LanClient.java'), 'utf-8')), '兜底不能删')
  })

  await it('仓库里的安卓源码与文档都是干净的 UTF-8（乱码会让 javac 报一串「未结束的字符串文字」）', () => {
    const targets = [
      ...collectSources(join(ROOT, 'android', 'app', 'src', 'main', 'java'), ['.java']),
      join(ROOT, 'android', 'app', 'build.gradle.kts'),
      join(ROOT, 'android', 'build.gradle.kts'),
      ...collectSources(join(ROOT, 'docs'), ['.md']),
    ]
    check('扫到了源文件', targets.length > 20, String(targets.length))

    for (const file of targets) {
      const text = readFileSync(file, 'utf-8')
      const problems = sourceIntegrityProblems(text, {
        strict: file.endsWith('.java') || file.endsWith('.kts'),
      })
      const label = file.slice(ROOT.length).replace(/\\/g, '/')
      check(`${label}`, problems.length === 0, problems.slice(0, 4).join('；'))
    }
  })
}
