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

    // 按钮要能一眼看出"在传/没传"：两态外观不同，否则用户无法判断自己是否还在占麦。
    // 4.47 起不再是写死的色值，而是两种 drawable（渐变=在传 / 白底描边=空闲）+ 文字色 token。
    // 4.52 起"开麦"与"上传"合成一个按钮：皮换成胶囊两态（红色=发言中 / 蓝绿=空闲）
    const button = methodBody('updateMicButton')
    check('发言中用红色胶囊皮', button.includes('R.drawable.btn_mic_live'))
    check('空闲用蓝绿胶囊皮', button.includes('R.drawable.btn_mic_idle'))
    check('白字（两种皮上都得能看清）', button.includes('R.color.on_brand'))
    check('发言中带呼吸动画', button.includes('R.anim.mic_pulse'))
    check('停止发言要清掉动画与文案', /clearAnimation\(\)/.test(button) && /R\.string\.room_mic_idle/.test(button))
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
    // 4.56：隐私页正文在 strings.xml 里了（布局只留 @string/priv_sN）
    const privacyText = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf-8')
    const homeXml = readFileSync(join(layoutDir, 'page_home.xml'), 'utf-8')
    const homeJava = readFileSync(join(javaDir, 'HomeActivity.java'), 'utf-8')
    const manifest = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf-8')

    // 1) 两个 Activity 都在清单里，且不对外导出
    for (const name of ['SettingsActivity', 'PrivacyActivity']) {
      check(`清单里注册了 ${name}`, new RegExp(`android:name="\\.${name}"`).test(manifest), name)
      check(`${name} 不对外导出`, new RegExp(`\\.${name}"[\\s\\S]{0,80}exported="false"`).test(manifest))
    }

    // 2) 首页能进得去（否则页面存在也白做）
    // 4.60：设置不再是一个按钮，而是底部导航的「我的」
    check('首页底部导航能进「我的」', homeXml.includes('@layout/inc_bottom_nav')
      && /homeNavMe[\s\S]{0,200}NavTabs\.ME|homeNavMe[\s\S]{0,200}MeActivity\.class/.test(homeJava), '没有入口')
    check('设置从「我的」里的翻译服务那行进',
      /meRowService[\s\S]{0,120}SettingsActivity\.class/.test(
        readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay', 'MeActivity.java'), 'utf-8')))
    check('首页底部导航打开「我的」页',
      /homeNavMe[\s\S]{0,200}(MeActivity\.class|NavTabs\.ME)/.test(homeJava), homeJava.slice(0, 80))
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
    // 4.56 起隐私页文案在 strings.xml（priv_s3），不在布局里
    check('写了字幕保留期（7 天）', /name="priv_s3">[^<]*7 天/.test(readFileSync(
      join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf-8'))
      || privacyXml.includes('@string/priv_s3'))
    check('写了音频轮转上限（1 GB）', privacyText.includes('1 GB'))
    check('写了本机记录上限（200 条）', privacyText.includes('200 条'))
    check('写了公网明文的风险（TLS）', privacyText.includes('明文') && privacyText.includes('TLS'))
    check('写了不采集画面', privacyText.includes('摄像头'))
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
      /Toast\.makeText\(this, getString\(R\.string\.toast_invite, code\), Toast\.LENGTH_LONG\)/.test(src),
      '没有它，邀请码就被对话框盖住了')
    check('邀请码被传进选库框', /chooseLibsAfterCreate\(id, room\.optString\("name", name\), code\)/.test(src))
    check('选库框的标题里带着邀请码',
      /codeLine \+ getString\(R\.string\.terms_dialog_title\)/.test(src), '标题要能直接看到码')
    // 4.44：**不能**再给这个对话框加 setMessage —— AppCompat 在同时设置了 message 与
    // multiChoiceItems 时会把列表挤掉，表现就是"框弹出来了但一个库都没有"（用户报过）。
    check('选库框没有 setMessage（否则列表会被挤掉）',
      /setTitle\(codeLine[\s\S]{0,200}?setMessage/.test(src) === false,
      '标题带码即可，正文会挤掉多选列表')
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

  await it('锁定按钮的文案要与"我能不能按"一致（4.44）', () => {
    // 用户报的：A（发起者）锁了麦，B 那边明明按不动，按钮却写着「解锁」。
    const room = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion',
      'lanrelay', 'RoomActivity.java'), 'utf-8')
    const body = room.slice(room.indexOf('private void takingChanged('), room.indexOf('\n    }', room.indexOf('private void takingChanged(')))

    // 4.55 起按钮上一律是图标，文案/无障碍描述仍要区分"我能不能按"
    check('持麦者解除的是自己的锁', body.includes('R.string.cd_unlock_speak'))
    check('不能按的人看到的是状态而不是动作', body.includes('R.string.cd_locked'),
      '既不是持麦者也不是发起者时，不该出现「解锁」这个动作')
    check('按不动就真的点不了', /lockButton\.setEnabled\(canLock\)/.test(body))
    check('按不动时视觉也弱化', /lockButton\.setAlpha\(canLock \? 1f : 0\.5f\)/.test(body))
    check('能不能按由 canLock 决定', /boolean canLock = holding \|\| \(anyHolder && iAmHost\)/.test(body))
  })

  await it('发起者退出后其余人立刻被请出房间（4.44）', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const room = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')
    const socket = readFileSync(join(javaDir, 'FloorSocket.java'), 'utf-8')

    check('推送通道认得 type=closed', /"closed"\.equals\(type\)/.test(socket))
    check('Listener 有 onRoomClosed', /void onRoomClosed\(String reason\)/.test(socket))
    check('房间页收到就退出', /private void leaveBecauseClosed\(String reason\)/.test(room))
    check('轮询也判 closed/410（WS 断了靠它兜底）',
      /optBoolean\("closed", false\)[\s\S]{0,120}optInt\("httpStatus", 0\) == 410|optInt\("httpStatus", 0\) == 410[\s\S]{0,160}leaveBecauseClosed/.test(room),
      '不能只靠 WS —— WS 断了人就留在空屋里')
  })

  await it('被顶下线走推送：会话通道 + 轮询兜底（4.45）', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const socket = readFileSync(join(javaDir, 'SessionSocket.java'), 'utf-8')
    const watch = readFileSync(join(javaDir, 'SessionWatch.java'), 'utf-8')
    const home = readFileSync(join(javaDir, 'HomeActivity.java'), 'utf-8')
    const rooms = readFileSync(join(javaDir, 'RoomsActivity.java'), 'utf-8')

    check('会话通道连的是 /ws?session=1', /\/ws\?session=1/.test(socket), '没有它就只能靠 10 秒轮询')
    check('认得 type=kicked', /"kicked"\.equals\(parsed\.optString\("type"/.test(socket))
    check('轮询间隔可调（推送活着时放慢）', /public void setIntervalMs\(long value\)/.test(watch))
    check('有"慢速间隔"常量（兜底不必跑那么勤）', /INTERVAL_SLOW_MS/.test(watch))

    for (const [name, src] of [['首页', home], ['大厅', rooms]]) {
      check(`${name}连了会话通道`, /new SessionSocket\([\s\S]{0,8000}sessionSocket\.start\(\)/.test(src), name)
      check(`${name}收到 kicked 会清 token 并退出`, /onKicked\(String reason\)[\s\S]{0,2400}remove\("accountToken"\)/.test(src), name)
      check(`${name}按推送是否在线调整轮询间隔`,
        /setIntervalMs\(online[\s\S]{0,120}INTERVAL_SLOW_MS/.test(src), name)
      check(`${name}销毁时断开推送`, /onDestroy\(\)[\s\S]{0,800}sessionSocket\.stop\(\)/.test(src), name)
    }
  })

  await it('视觉体系：新页面只走 token，不写死色值与裸尺寸（4.47）', () => {
    const layoutDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const pages = ['page_home', 'page_rooms', 'page_room', 'page_settings_app', 'page_privacy']

    for (const name of pages) {
      const xml = readFileSync(join(layoutDir, `${name}.xml`), 'utf-8')
      const hexes = xml.match(/"#[0-9A-Fa-f]{3,8}"/g) || []
      check(`${name} 没有硬编码色值`, hexes.length === 0, hexes.join(','))
      // 裸 dp/sp 只允许 0dp（layout_weight 的标准写法）
      const raws = (xml.match(/"([1-9][0-9]*(?:\.[0-9]+)?)(dp|sp)"/g) || [])
      check(`${name} 没有裸 dp/sp`, raws.length === 0, raws.join(','))
      check(`${name} 用了尺寸 token`, /@dimen\//.test(xml))
      check(`${name} 用了颜色 token`, /@color\//.test(xml))
    }

    // 主操作按钮必须是渐变那条（原型：主按钮渐变 #0E7490 → #0891B2，135°）
    const home = readFileSync(join(layoutDir, 'page_home.xml'), 'utf-8')
    check('首页主按钮用 tap_btn_primary', /homeLogin[\s\S]{0,400}tap_btn_primary/.test(home))
    const room = readFileSync(join(layoutDir, 'page_room.xml'), 'utf-8')
    // 4.52：房间页的主操作是**开麦胶囊**（原型：蓝绿胶囊），不再是"开始同传"
    check('房间页开麦用胶囊皮', /roomMic[\s\S]{0,300}btn_mic_idle/.test(room))

    // 原型色值必须真的落在 token 文件里
    const colors = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'colors.xml'), 'utf-8')
    for (const [token, value] of [
      ['brand', '#0E7490'], ['brand_dark', '#0B5C73'], ['brand_grad_end', '#0891B2'],
      ['page', '#F2F5F7'], ['surface', '#FFFFFF'], ['ink', '#16242F'],
      ['ink_soft', '#64748B'], ['line', '#E3E8EE'], ['accent', '#D97706'],
      ['screen', '#0A0F14'], ['screen_ink', '#4ADE80'],
    ]) {
      check(`@color/${token} = ${value}`, new RegExp(`name="${token}">${value}<`).test(colors), token)
    }

    // 尺寸 token：卡片 14 / 控件 12（原型），且是 dp/sp 而不是照抄 px
    const dimens = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'dimens.xml'), 'utf-8')
    check('卡片圆角 14dp', /name="radius_card">14dp</.test(dimens))
    check('控件圆角 12dp', /name="radius_control">12dp</.test(dimens))
    check('尺寸用 dp/sp ではなく px ではない', /<dimen [^>]*>\d+dp<\/dimen>/.test(dimens) && dimens.includes('sp</dimen>'))

    // 渐变角度：CSS 135° = Android 315°（照抄 135 会反过来）
    const btn = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'drawable', 'bg_btn_primary.xml'), 'utf-8')
    check('渐变角度写成 315（= CSS 135°）', /android:angle="315"/.test(btn), btn.slice(0, 120))
    check('渐变两端用 token', /brand_grad_start/.test(btn) && /brand_grad_end/.test(btn))
  })

  await it('旧版界面：入口默认隐藏、代码保留、且被标注为参考实现（4.48）', () => {
    const layoutDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const home = readFileSync(join(layoutDir, 'page_home.xml'), 'utf-8')
    const homeJava = readFileSync(join(javaDir, 'HomeActivity.java'), 'utf-8')
    const main = readFileSync(join(javaDir, 'MainActivity.java'), 'utf-8')

    // 入口隐藏：按钮还在（能一键放出来），但默认看不见
    const legacyBlock = home.slice(home.indexOf('@+id/homeLegacy'))
    check('旧版入口默认隐藏', /visibility="gone"/.test(legacyBlock.slice(0, 900)),
      '用户要求"暂时不再显示"')
    check('隐藏方式是一个属性，不用改 Java',
      /homeLegacy[\s\S]{0,1600}MainActivity\.class/.test(homeJava),
      'HomeActivity 的点击监听必须一直有效')

    // 冻结标注：不能悄悄变了语义，也不能被人当成"死代码"删掉
    check('MainActivity 头部标了冻结', /已冻结（4\.48/.test(main), '没有标注就会被当成死代码删掉')
    check('标注说清了它是参考实现', /参考实现/.test(main))
  })

  await it('集成契约文档：翻译官只需接入入口与登录态（2026-10-29 重写 v2）', () => {
    const doc = readFileSync(join(ROOT, 'docs', '23-集成契约.md'), 'utf-8')

    // ① 前提必须写清：对面已有完整流程，接入不改他们的管线
    check('写明了对面已有完整流程', /已经是一个完整流程/.test(doc))
    check('写明了不改他们的阿里云管线', /阿里云/.test(doc) && /不改/.test(doc))

    // ② 接入形态与入口约定（三种形态 + extras 字段表）
    check('给了三种接入形态', /形态 A: /.test(doc.replace('**形态 A:', '**形态 A: '))
      || (/三种接入形态/.test(doc) && /A\. 同一 App 内模块/.test(doc)
        && /B\. 独立 App/.test(doc) && /C\. 独立 App/.test(doc)))
    for (const key of ['host', 'secret', 'token', 'user', 'role', 'uiLang', 'speakLang']) {
      check(`交接的 extras 里有 ${key}`, doc.includes(key), key)
    }
    check('说清了为什么不让他们读我们的 prefs',
      doc.includes('SharedPreferences'), 'SharedPreferences')

    // ③ 历史记录默认不写（选项增强）—— 这是这一版最重要的变化
    check('历史记录降级为可选', /可选增强/.test(doc))
    check('写明了“不做这条也算接入完成”', /接入照样算完成/.test(doc))
    check('可选方案是一次提交整场（不逐句上报）',
      doc.includes('POST /org/history/interpreter') && /一次提交整场/.test(doc))

    // ④ 不许碰的端点清单
    check('写了不要碰的端点', /不要碰/.test(doc)
      && doc.includes('POST /audio') && doc.includes('GET /frame'))
    check('写了不参与发言权', /floor/.test(doc))

    // ⑤ 联调清单里必须有“没装/没接上不崩”与“返回后登录态还在”
    check('强调了拉不起来要兜住', /不是崩溃/.test(doc))
    check('强调了返回后登录态不变', /登录态还在/.test(doc))

    // ⑥ 待拍板与演进规则
    for (const needed of ['per-label', '待拍板', '只做加法']) {
      check(`契约里写了 ${needed}`, doc.includes(needed), needed)
    }
  })

  await it('注册/登录页按原型：居中单列 + 品牌图标 + 语言胶囊 + 协议勾选（4.49）', () => {
    const layoutDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const home = readFileSync(join(layoutDir, 'page_home.xml'), 'utf-8')
    const homeJava = readFileSync(join(javaDir, 'HomeActivity.java'), 'utf-8')

    for (const id of ['homeAgree', 'homeAgreeText', 'homeLangZh', 'homeLangPt', 'homeLangEn',
      'homeEmail', 'homeSendCode', 'homeCode', 'homeUser', 'homeLogin', 'homeServerToggle']) {
      check(`登录页有 ${id}`, new RegExp(`@\\+id/${id}\\b`).test(home), id)
    }

    // 品牌：两枚圆（中 / A）+ 产品名 + 标语
    check('品牌图标两枚圆', /bg_brand_circle"/.test(home) && /bg_brand_circle_alt"/.test(home))
    check('圆里是「中」与「A」', /text="@string\/brand_mark_zh"/.test(home) && /text="A"/.test(home))
    check('产品名', /@string\/app_brand/.test(home))
    check('品牌标语', /@string\/home_slogan/.test(home))

    // 语言胶囊：三颗「我的语言」= 界面语言（4.59 澄清），三种都能选
    //
    // ⚠️ 4.49 当时断言「English 必须禁用」，因为它当时管的是**说话语言**（服务端只做中↔巴葡）。
    // 现在它管的是界面文字，英文必须可选；而「说话」那一侧仍只有中文/巴葡两种。
    check('三颗语言胶囊', /homeLangZh/.test(home) && /homeLangEn/.test(home) && /homeLangPt/.test(home))
    const enBlock = home.slice(home.indexOf('@+id/homeLangEn'), home.indexOf('@+id/homeLangPt'))
    check('界面语言里 English 可选', !/android:enabled="false"/.test(enBlock)
      && /android:clickable="true"/.test(enBlock))
    const roomsXml = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout', 'page_rooms.xml'), 'utf-8')
    check('说话语言仍只有中文与巴葡两颗（服务端只做这两种）',
      /roomsLangZh/.test(roomsXml) && /roomsLangPt/.test(roomsXml) && !/roomsLangEn/.test(roomsXml))
    check('说话语言写进 speakLang（建会议时）', /putString\("speakLang"/.test(
      readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay', 'RoomsActivity.java'), 'utf-8')))

    // M4：不勾协议不许继续（注册/登录都要）
    check('协议勾选的门禁在 doLogin 最前面',
      /private void doLogin\(\)[\s\S]{0,400}agreeBox\.isChecked\(\)/.test(homeJava),
      '必须在任何网络请求之前拦住')
    check('点协议文字能打开隐私页', /homeAgreeText[\s\S]{0,200}PrivacyActivity\.class/.test(homeJava))

    // 登录 / 注册 是**开关**，不是"看用户填了没"（4.50）
    check('有 setRegisterMode 切换', /private void setRegisterMode\(boolean register\)/.test(homeJava))
    check('切换链接能来回切', /registerToggle\.setOnClickListener\(v -> setRegisterMode\(!registerMode\)\)/.test(homeJava))
    check('默认是登录态', /setRegisterMode\(false\)/.test(homeJava), '登录不需要邮箱')
    check('邮箱那一排跟着切', /emailRow\.setVisibility\(emailVisibility\)/.test(homeJava))
    check('验证码跟着切', /codeInput\.setVisibility\(emailVisibility\)/.test(homeJava))
    check('按钮文案跟着变',
      /loginButton\.setText\(getString\(register \? R\.string\.btn_register_login : R\.string\.btn_login\)\)/.test(homeJava))
    check('注册走 authRegisterEmail', /isRegister[\s\S]{0,200}authRegisterEmail/.test(homeJava))
    check('登录走 authLogin', /authLogin\(user, pass\)/.test(homeJava))
    check('判定用开关而不是字段内容', /final boolean isRegister = registerMode;/.test(homeJava))

    // 出厂默认配置：地址可预填、密钥默认空（安全取舍写进了资源文件注释）
    const cfg = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'app_config.xml'), 'utf-8')
    check('默认服务器地址可预填', /default_server_url/.test(cfg))
    check('默认密钥留空（不把口令写进仓库）',
      /<string name="default_shared_secret"><\/string>/.test(cfg), cfg.slice(0, 120))
    check('注释里说清了为什么密钥不打包', /反编译|apktool/.test(cfg))
    check('登录页会回落到出厂默认值', /R\.string\.default_server_url/.test(homeJava))
  })

  await it('同一台设备不许把自己踢下线（4.50）', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const home = readFileSync(join(javaDir, 'HomeActivity.java'), 'utf-8')
    const hub = readFileSync(join(ROOT, 'lib', 'ws-hub.mjs'), 'utf-8')
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')

    // ① 注销时必须断开会话推送：否则旧连接挂在服务端，下次登录会"通知别处登录"通知到自己
    const logoutAt = home.indexOf('private void logout()')
    const logoutBody = home.slice(logoutAt, home.indexOf('\n    }', logoutAt))
    check('注销会停掉 sessionWatch', /sessionWatch\.stop\(\)/.test(logoutBody))
    check('注销也会停掉会话推送（sessionSocket）', /sessionSocket\.stop\(\)/.test(logoutBody),
      '漏了它 = 下次登录时自己踢自己')

    // ② 服务端只踢"旧 token"的连接
    check('会话连接记下自己的 token 哈希', /tokenHash:/.test(hub))
    check('notifyKicked 接受 keepToken 并跳过它',
      /function notifyKicked\(user, reason = 'elsewhere-login', keepToken = null\)/.test(hub)
      && /conn\.tokenHash === keepHash\) return false/.test(hub),
    )
    check('登录成功时把新 token 一起传下去',
      /notifyKickedIfReplaced\(result\.username, result\.token\)/.test(relay))

    // ③ 客户端收到 kicked 先核实（陈旧连接不算被踢）
    check('onKicked 先 checkSession 再决定',
      /onKicked\(String reason\)[\s\S]{0,700}checkSession\(\)/.test(home),
      '只信推送、不核实，就会被陈旧连接骗回登录页')
    check('核实失败才回登录页', /reallyExpired[\s\S]{0,1200}showLogin\(\)/.test(home))
  })

  await it('findViewById 的类型必须和布局里的控件一致（4.51 崩过：TextView 当 Button 取）', () => {
    // 这类错**编译能过**（findViewById 泛型擦成 View 再强转），一进页面就 ClassCastException。
    // 4.47 把大厅的语言胶囊从 Button 改成 TextView，RoomsActivity 还在按 Button 取 —— 于是
    // 点「会议房间」直接崩。这条检查把"id 存在但类型不对"也纳入门禁。
    const layoutDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')

    /** id → 布局里的控件标签名 */
    const tagOfId = new Map()
    for (const file of readdirSync(layoutDir)) {
      if (!file.endsWith('.xml')) continue
      const xml = readFileSync(join(layoutDir, file), 'utf-8')
      for (const m of xml.matchAll(/<([A-Za-z.]+)([^>]*?)android:id="@\+id\/(\w+)"/g)) {
        tagOfId.set(m[3], { tag: m[1].split('.').pop(), file })
      }
    }
    check('扫到了布局里的 id', tagOfId.size > 20, String(tagOfId.size))

    /** View 是任何控件的父类，所以声明成 View 永远安全；其余要求标签名精确相符。 */
    const compatible = (declared, tag) => declared === tag || declared === 'View' || declared === 'Object'

    /** 在一段 Java 源码里找出"声明类型与布局标签不符"的地方。 */
    const scan = (src, tagMap) => {
      const problems = []
      const fieldTypes = new Map()
      for (const m of src.matchAll(/private\s+(?:static\s+)?(?:final\s+)?([A-Z][\w.]*)\s+(\w+)\s*;/g)) {
        fieldTypes.set(m[2], m[1].split('.').pop())
      }
      const localTypes = new Map()
      for (const m of src.matchAll(/\b([A-Z][\w.]*)\s+(\w+)\s*=\s*findViewById\(R\.id\.(\w+)\)/g)) {
        localTypes.set(`${m[2]}|${m[3]}`, m[1].split('.').pop())
      }
      for (const m of src.matchAll(/(\w+)\s*=\s*findViewById\(R\.id\.(\w+)\)/g)) {
        const [, variable, id] = m
        const declared = localTypes.get(`${variable}|${id}`) ?? fieldTypes.get(variable)
        const found = tagMap.get(id)
        if (declared === undefined || found === undefined) continue
        if (!compatible(declared, found.tag)) {
          problems.push(`${variable} 声明为 ${declared}，但布局里 #${id} 是 ${found.tag}`)
        }
      }
      for (const m of src.matchAll(/\(\s*([A-Z][\w.]*)\s*\)\s*findViewById\(R\.id\.(\w+)\)/g)) {
        const declared = m[1].split('.').pop()
        const found = tagMap.get(m[2])
        if (found === undefined) continue
        if (!compatible(declared, found.tag)) {
          problems.push(`强转成 ${declared}，但布局里 #${m[2]} 是 ${found.tag}`)
        }
      }
      return problems
    }

    // 反向自检：伪造"TextView 当 Button 取"，判据必须报出来（否则它可能永远是绿的）
    const fakeTags = new Map([['someLang', { tag: 'TextView', file: 'fake.xml' }]])
    const fakeProblems = scan('private Button zh;\n    zh = findViewById(R.id.someLang);', fakeTags)
    check('判据本身有效（伪造的错必须被抓到）', fakeProblems.length === 1, JSON.stringify(fakeProblems))
    check('声明成 View 的算安全', scan('private View v;\n    v = findViewById(R.id.someLang);', fakeTags).length === 0)

    const problems = []
    for (const file of readdirSync(javaDir)) {
      if (!file.endsWith('.java')) continue
      for (const one of scan(readFileSync(join(javaDir, file), 'utf-8'), tagOfId)) {
        problems.push(`${file}: ${one}`)
      }
    }
    check('所有 findViewById 的类型都与布局一致', problems.length === 0, problems.slice(0, 5).join('；'))
  })

  await it('房间页按原型：顶部两行 / 字幕流 / 右侧三态 / 底部三项 / 抽屉（4.52）', () => {
    const layoutDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const room = readFileSync(join(layoutDir, 'page_room.xml'), 'utf-8')
    const activity = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')

    // 顶部第一行：房间号 · 复制邀请 · 参与方式 · 角色
    for (const id of ['roomCode', 'roomCopy', 'roomModeTag', 'roomRoleTag']) {
      check(`顶部第一行有 ${id}`, new RegExp(`@\\+id/${id}\\b`).test(room), id)
    }
    // 顶部第二行：主题 · 人数 · 计时 · 退出
    for (const id of ['roomTitle', 'roomMembers', 'roomTimer', 'roomLeave']) {
      check(`顶部第二行有 ${id}`, new RegExp(`@\\+id/${id}\\b`).test(room), id)
    }
    check('复制邀请真的写剪贴板', /ClipboardManager/.test(activity) && /setPrimaryClip/.test(activity))
    check('计时每秒走一格', /ui\.postDelayed\(this, 1000\)/.test(activity))

    // 中央字幕流：可滚动容器 + 列表 + 空态
    check('字幕流是滚动容器', /@\+id\/roomSubtitleScroll/.test(room) && /ScrollView/.test(room))
    check('字幕列表容器', /@\+id\/roomSubtitles/.test(room))
    check('没有字幕时有空态提示', /@\+id\/roomEmpty/.test(room))

    // M1 的关键不变量：partial 帧**原位更新**，不许新起一条
    // 一句话会来三帧（增量 / 定稿 / 校对），必须按**原文**判同一段，三帧合成一张卡
    check('同一段按原文去重', /boolean sameSegment = lastSegmentView != null && \(/.test(activity)
      && /key\.equals\(lastSegmentKey\)/.test(activity),
      '只按 partial 判会让定稿帧新起一条 → 同一句叠三张、还留一张"识别中"')
    check('去重命中就原位更新文字与状态',
      /if \(sameSegment\)\s*\{[\s\S]{0,400}lastSegmentTarget\.setText/.test(activity))
    check('增量→定稿 用"上一帧是增量"兜住（原文是流式不完整的，不能只按原文判）',
      /lastWasPartial\s*\/\//.test(activity) || /and ①[\s\S]{0,400}lastWasPartial/.test(activity) || /\n\s*lastWasPartial\s*\n/.test(activity),
      '只按原文判会把「增量 + 定稿」拆成两条')
    check('新句追加后滚到底部', /scrollToBottom\(\)/.test(activity) && /fullScroll\(View\.FOCUS_DOWN\)/.test(activity))
    check('自己的发言换底色（浅主色+主色边框）', /bg_subtitle_self/.test(activity) && /bg_subtitle_self/.test(room) === false)
    check('每条字幕有头像/姓名/源语言/状态', /bg_avatar/.test(activity) && /识别中|已完成/.test(activity))
    check('字幕有上限，防止开两小时把内存吃掉', /MAX_SEGMENTS/.test(activity))

    // M3：原文显示开关
    check('底部有原文开关（Switch）', /@\+id\/roomSourceSwitch/.test(room) && /<Switch/.test(room))
    check('开关旁边写着「原文」', /text="@string\/room_source"/.test(room))
    check('切换会影响已画出来的卡片', /private void syncSourceVisibility\(\)[\s\S]{0,900}setVisibility/.test(activity))
    check('防止 setChecked 自己触发自己', /syncingSwitch/.test(activity))

    // 右侧竖向条：发言人 + 投屏/扩声/收音 三态，点开抽屉
    check('右侧条显示发言人', /@\+id\/roomSpeaker/.test(room))
    for (const id of ['roomCastState', 'roomAudioState', 'roomMicState']) {
      check(`右侧条有 ${id}`, new RegExp(`@\\+id/${id}\\b`).test(room), id)
    }
    check('外设没接入就直说"未接入"（不做假开关）',
      /audioState\.setText\(getString\(R\.string\.room_audio_none\)\)/.test(activity), '没有真实设备时不许假装可用')
    check('点右侧条开抽屉', /infoBar\.setOnClickListener\(v -> toggleDrawer\(\)\)/.test(activity))

    // 底部：开麦胶囊（红/蓝绿两态 + 呼吸）
    check('开麦是胶囊形', /btn_mic_idle/.test(room) && /btn_mic_live/.test(activity))
    const pulse = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'anim', 'mic_pulse.xml'), 'utf-8')
    check('发言中引用脉冲动画', /R\.anim\.mic_pulse/.test(activity))
    check('脉冲动画是真的循环（scale + alpha，infinite）',
      /<scale/.test(pulse) && /<alpha/.test(pulse) && /repeatCount="infinite"/.test(pulse))
    check('脉冲幅度克制（1.06 以内，别做心跳）', /toXScale="1\.0[0-6]"/.test(pulse), pulse.slice(0, 120))
    check('开麦同时管上传（原型只有一个开麦按钮）',
      /private void toggleMic\(\)[\s\S]{0,600}mic\.stop\(\)/.test(activity),
      '分开两个按钮会出现"开了麦却没上传"')

    // 抽屉：人员与设备
    check('有抽屉覆盖层', /@\+id\/roomDrawer\b/.test(room))
    check('抽屉列成员', /@\+id\/roomMembersList/.test(room) && /renderMembers/.test(activity))
    check('抽屉列设备状态', /@\+id\/roomDrawerDevices/.test(room)
      && /drawerDevices\.setText\(getString\(R\.string\.room_devices_detail\)\)/.test(activity)
      && readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'), 'utf-8')
        .includes('未接入'))
  })

  await it('房间页四个修复：顶部信息 / 成员形状 / 不显示调试文本（4.53）', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const activity = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')

    // ① 房间详情必须在 client 建好之后才拉，否则线程里 NPE 被静默吞掉
    // 抓 onCreate 这一段来判先后：loadRoomHeader(); 现在也在抽屉轮询里出现，
    // 全文件 indexOf 会被前面的那段抢先匹配到（4.55 曾因此误报）
    const onCreateBody = activity.slice(activity.indexOf('protected void onCreate('),
      activity.indexOf('private void takingChanged('))
    const clientAt = onCreateBody.indexOf('client = new LanClient(')
    const headerCallAt = onCreateBody.indexOf('loadRoomHeader();')
    check('loadRoomHeader 在 client 创建之后调用', headerCallAt > clientAt && clientAt >= 0,
      `client@${clientAt} header@${headerCallAt}`)
    check('loadRoomHeader 自己也挡住 client 还没建好的情况',
      /private void loadRoomHeader\(\) \{\s*\n\s*if \(client == null\) return;/.test(activity))
    check('顶部真的会写房间号与主题',
      /codeView\.setText\("#" \+ code\)/.test(activity) && /titleView\.setText\(name\)/.test(activity))
    check('角色按 host 判定（发起者/参与者）',
      /iAmHost = myName != null && myName\.equals\(host\)/.test(activity)
      && /roleTag\.setText\(iAmHost \? getString\(R\.string\.room_role_host\) : getString\(R\.string\.room_role_member\)\)/.test(activity))

    // ② 成员是对象数组 {username, lang, joinedAt}，不能按字符串取
    check('成员按 username 字段读', /optString\("username", ""\)/.test(activity),
      '按 optString(i) 取会拿到空串，抽屉里一个成员都没有')

    // ③ 调试性文本不许进状态行
    const socketState = activity.slice(activity.indexOf('public void onState(String message)'))
    check('推送状态只写 logcat，不写状态行',
      /Log\.i\("LeionRoom", "floor-socket: "/.test(activity)
      && !/onState\(String message\)\s*\{[\s\S]{0,120}statusLine\.setText/.test(activity),
      '「发言权推送已连上」这类字样不该给用户看')
    check('连上后状态行清空（不再显示"已连接 · 40×3"）', /statusLine\.setText\(""\)/.test(activity))
  })

  await it('M2 收尾：抽屉管理者操作 + 系统事件行（4.54）', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const activity = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')
    const client = readFileSync(join(javaDir, 'LanClient.java'), 'utf-8')
    const rooms = readFileSync(join(ROOT, 'lib', 'rooms.mjs'), 'utf-8')
    const api = readFileSync(join(ROOT, 'relay', 'org-api.mjs'), 'utf-8')

    // 服务端：移出成员（仅发起者）+ 顺手释放他的麦
    check('rooms.mjs 有 removeMember', /export function removeMember\(/.test(rooms))
    check('只有发起者能移人', /只有发起者可以移出成员/.test(rooms))
    check('移出时释放他的麦', /releasedFloor = true/.test(rooms))
    check('org-api 有移出成员路由', /segments\[4\] === 'remove'/.test(api))
    check('客户端有对应接口', /public JSONObject orgRemoveMember\(/.test(client))

    // 抽屉：管理者看得到"移出"，且不给自己显示
    check('成员行带移出按钮', /remove\.setText\(getString\(R\.string\.btn_remove\)\)/.test(activity))
    check('移出只对别人显示（自己要走退出）', /iAmHost && !name\.equals\(myName\)/.test(activity))
    check('移出要二次确认', /private void confirmRemove\(/.test(activity) && /AlertDialog/.test(activity))
    check('锁定中时发起者可解除他人锁定',
      /force-release/.test(activity) && /getString\(R\.string\.btn_force_release/.test(activity))

    // 系统事件行：弱化、居中、插进字幕流
    check('有 addSystemEvent', /private void addSystemEvent\(String text\)/.test(activity))
    check('事件行是弱化居中文字', /setGravity\(android\.view\.Gravity\.CENTER\)/.test(activity)
      && /R\.color\.ink_faint/.test(activity))
    check('会议开始写一条事件',
      /addSystemEvent\(getString\(R\.string\.sys_meeting_started\)\)/.test(activity))
    check('被顶替/掉线释放写进事件行', /addSystemEvent\(message\)/.test(activity))
    check('锁定/解锁写进事件行',
      /R\.string\.sys_lock_self|R\.string\.sys_lock_other/.test(activity) && /R\.string\.sys_unlocked/.test(activity))
  })

  await it('4.55：抽屉实时刷新 / 被移出即离场 / 锁定图标 / 原文开关', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const layoutDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const activity = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')
    const socket = readFileSync(join(javaDir, 'FloorSocket.java'), 'utf-8')
    const hub = readFileSync(join(ROOT, 'lib', 'ws-hub.mjs'), 'utf-8')
    const room = readFileSync(join(layoutDir, 'page_room.xml'), 'utf-8')

    // ① 抽屉实时刷新：只在抽屉开着时轮询
    check('抽屉打开时启动刷新', /private void startDrawerRefresh\(\)/.test(activity))
    check('抽屉关闭时停止刷新', /stopDrawerRefresh\(\)/.test(activity) && /ui\.removeCallbacks\(drawerTick\)/.test(activity))
    check('抽屉开着才刷新（关着不花流量）',
      /drawer\.getVisibility\(\) != View\.VISIBLE/.test(activity))

    // ② 被移出：服务端推送 + 轮询兜底
    check('服务端能对单个用户推 removed 并断连', /function removeUserFromRoom\(/.test(hub)
      && /type: 'removed'/.test(hub))
    check('客户端认得 removed', /"removed"\.equals\(type\)/.test(socket))
    check('房间页收到就离场', /private void leaveBecauseRemoved\(\)/.test(activity))
    check('轮询兜底：不在成员列表里也算被移出',
      /stillHere/.test(activity) && /if \(!stillHere\)/.test(activity))
    check('空成员数组不当成"我不在了"（防抖动误踢）',
      /members\.length\(\) > 0/.test(activity), '一次网络抖动不该把人踢出房间')

    // ③ 锁定按钮：图标两态
    check('锁定按钮是 ImageButton', /<ImageButton[\s\S]{0,200}@\+id\/roomLock/.test(room))
    check('图标随锁定态切换', /R\.drawable\.ic_unlock/.test(activity) && /R\.drawable\.ic_lock/.test(activity))
    check('图标只有"能按"时才换（不能解他人锁的人看到的是锁着的锁）',
      /boolean showUnlockIcon = isLocked && canLock/.test(activity))

    // ④ 原文开关：文字 + Switch
    check('原文是文字 + Switch', /@\+id\/roomSourceSwitch/.test(room) && /<Switch/.test(room))
    check('Switch 默认打开', /android:checked="true"/.test(room))
  })

  await it('4.56：界面三语（中文 / 巴葡 / 英文）', () => {
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const readRes = (p) => readFileSync(join(resDir, p), 'utf-8')
    const keysOf = (xml) => new Set([...xml.matchAll(/<string name="([A-Za-z0-9_]+)"/g)].map((m) => m[1]))

    const zh = keysOf(readRes(join('values', 'strings.xml')))
    const en = keysOf(readRes(join('values-en', 'strings.xml')))
    const pt = keysOf(readRes(join('values-pt-rBR', 'strings.xml')))

    // ① 英 / 巴葡键必须一一对应，且都在中文（默认资源）里
    const onlyEn = [...en].filter((k) => !pt.has(k))
    const onlyPt = [...pt].filter((k) => !en.has(k))
    check('英文与巴葡的键完全一致', onlyEn.length === 0 && onlyPt.length === 0,
      `en-only=${onlyEn.join(',')} pt-only=${onlyPt.join(',')}`)
    const missingZh = [...en].filter((k) => !zh.has(k))
    check('英文/巴葡用到的键在中文里都有', missingZh.length === 0, missingZh.join(','))

    // ② 会议室五页真正引用到的键，三份都得有（漏一个就是运行时崩溃或空白）
    const pages = ['page_home.xml', 'page_rooms.xml', 'page_room.xml', 'page_settings_app.xml', 'page_privacy.xml']
    const acts = ['HomeActivity.java', 'RoomsActivity.java', 'RoomActivity.java', 'SettingsActivity.java', 'PrivacyActivity.java']
    const refs = new Set()
    for (const f of pages) {
      for (const m of readFileSync(join(resDir, 'layout', f), 'utf-8').matchAll(/@string\/([A-Za-z0-9_]+)/g)) refs.add(m[1])
    }
    for (const f of acts) {
      for (const m of readFileSync(join(javaDir, f), 'utf-8').matchAll(/R\.string\.([A-Za-z0-9_]+)/g)) refs.add(m[1])
    }
    // 出厂默认值不在界面文案里（它们是配置，不是句子）
    for (const k of ['default_server_url', 'default_shared_secret']) refs.delete(k)
    const noZh = [...refs].filter((k) => !zh.has(k))
    const noEn = [...refs].filter((k) => !en.has(k))
    const noPt = [...refs].filter((k) => !pt.has(k))
    check('界面引用的键在中文里有', noZh.length === 0, noZh.join(','))
    check('界面引用的键在英文里有', noEn.length === 0, noEn.join(','))
    check('界面引用的键在巴葡里有', noPt.length === 0, noPt.join(','))

    // ③ 五页布局里不再有裸中文（所有文案都走 @string）
    const cjk = /[\u4e00-\u9fff]/
    const rawLayout = []
    for (const f of pages) {
      const body = readFileSync(join(resDir, 'layout', f), 'utf-8').replace(/<!--[\s\S]*?-->/g, '')
      for (const m of body.matchAll(/(?:android:(?:text|hint|contentDescription))="([^"]*)"/g)) {
        if (cjk.test(m[1])) rawLayout.push(`${f}:${m[1].slice(0, 12)}`)
      }
      for (const m of body.matchAll(/>([^<>]*[\u4e00-\u9fff][^<>]*)</g)) {
        if (!m[1].trim().startsWith('@')) rawLayout.push(`${f}:node:${m[1].trim().slice(0, 12)}`)
      }
    }
    check('五个页面的布局里没有裸中文', rawLayout.length === 0, rawLayout.slice(0, 6).join(' | '))

    // ④ 五个页面的 Java 里没有裸中文界面串（日志与 debugLine 除外）
    const rawJava = []
    for (const f of acts) {
      const lines = readFileSync(join(javaDir, f), 'utf-8').split('\n')
      let inBlock = false
      for (const line of lines) {
        const s = line.trim()
        if (inBlock) { if (s.includes('*/')) inBlock = false; continue }
        if (s.startsWith('/*')) { if (!s.includes('*/')) inBlock = true; continue }
        if (s.startsWith('//') || s.startsWith('*')) continue
        // 行内块注释先剥掉（`v -> { /* 已经在首页 */ }` 这种），再判中文
        const code = s.split('//')[0].replace(/\/\*[\s\S]*?\*\//g, '')
        if (!cjk.test(code)) continue
        if (/Log\.[iwevd]\(|debugLine\(/.test(code)) continue    // 诊断日志不进界面文案
        rawJava.push(`${f}:${code.slice(0, 24)}`)
      }
    }
    check('五页 Java 里没有裸中文界面串', rawJava.length === 0, rawJava.slice(0, 6).join(' | '))

    // ⑤ 机制：每个页面都要在 attachBaseContext 里换语言，否则只有先建的那页生效
    const uiLang = readFileSync(join(javaDir, 'UiLang.java'), 'utf-8')
    check('UiLang 认三种语言', /public static final String ZH = "zh"/.test(uiLang)
      && /public static final String PT = "pt-BR"/.test(uiLang)
      && /public static final String EN = "en"/.test(uiLang))
    check('没选过就跟随系统（不硬压成中文）', /if \(tag\.isEmpty\(\)\) return base;/.test(uiLang))
    check('回到前台发现语言变了会自己重建', /public static void trackShown\(/.test(uiLang)
      && /activity\.recreate\(\)/.test(uiLang))
    for (const f of acts) {
      const body = readFileSync(join(javaDir, f), 'utf-8')
      check(`${f} 在 attachBaseContext 里换语言`, /super\.attachBaseContext\(UiLang\.wrap\(base\)\)/.test(body))
      check(`${f} 回前台会自检语言`, /UiLang\.trackShown\(this\)/.test(body))
    }

    // ⑥ 选择器：登录页的「我的语言」 + 设置页各一组，语言名用它自己的语言写
    const home = readFileSync(join(resDir, 'layout', 'page_home.xml'), 'utf-8')
    const setPage = readFileSync(join(resDir, 'layout', 'page_settings_app.xml'), 'utf-8')
    check('登录页「我的语言」就是界面语言三选一',
      /@\+id\/homeLangZh/.test(home) && /@\+id\/homeLangEn/.test(home) && /@\+id\/homeLangPt/.test(home))
    check('登录页只有这一组选择器（不另外挂一排）', !/homeUiLang/.test(home))
    check('English 可选（它现在只影响界面）', !/android:enabled="false"/.test(home))
    check('设置页有界面语言三选一', /@\+id\/setAppUiLangZh/.test(setPage) && /@\+id\/setAppUiLangPt/.test(setPage)
      && /@\+id\/setAppUiLangEn/.test(setPage))
    check('语言名不翻译（Português / English 原样）',
      /@string\/lang_pt_native/.test(home) && /@string\/lang_en/.test(home)
      && /text="Português"/.test(setPage) && /@string\/lang_en/.test(setPage))
    check('Português 三种语言下写法一致', ['values', 'values-en', 'values-pt-rBR'].every((d) =>
      /name="lang_pt_native">Português</.test(readFileSync(join(resDir, d, 'strings.xml'), 'utf-8'))))
    check('界面语言与「我说话用什么语言」是两个开关', /ui_lang_hint/.test(setPage)
      && /rooms_my_lang_title/.test(setPage))
  })

  await it('4.59：「我的语言」是界面语言，说话语言在创建会议时选', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const layoutDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const home = readFileSync(join(javaDir, 'HomeActivity.java'), 'utf-8')
    const rooms = readFileSync(join(javaDir, 'RoomsActivity.java'), 'utf-8')
    const roomsXml = readFileSync(join(layoutDir, 'page_rooms.xml'), 'utf-8')
    const homeXml = readFileSync(join(layoutDir, 'page_home.xml'), 'utf-8')

    // 登录页：三颗胶囊 = 界面语言，点了就存 uiLang 并重建
    check('登录页三颗胶囊切的是界面语言',
      /langZhButton\.setOnClickListener\(v -> applyUiLang\(UiLang\.ZH\)\)/.test(home)
      && /langEnButton\.setOnClickListener\(v -> applyUiLang\(UiLang\.EN\)\)/.test(home)
      && /langPtButton\.setOnClickListener\(v -> applyUiLang\(UiLang\.PT\)\)/.test(home))
    check('登录页不再自己决定说话语言（那件事在建会议时选）',
      !/applySpeakLang/.test(home) && !/retrieveSpeakLang/.test(home) && !/"speakLang"/.test(home))
    check('登录页三颗胶囊的名字：中文 / English / Português',
      /@string\/lang_zh/.test(homeXml) && /@string\/lang_en/.test(homeXml)
      && /@string\/lang_pt_native/.test(homeXml))
    check('说明写清这只改界面文字', /@string\/home_my_lang_hint/.test(homeXml))

    // 房间列表（建会议）：这里才是说话/翻译方向
    check('建会议时选说话语言', /@\+id\/roomsLangZh/.test(roomsXml) && /@\+id\/roomsLangPt/.test(roomsXml)
      && /putString\("speakLang"/.test(rooms))
    check('房间列表说明写的是识别方向', /@string\/rooms_my_lang_hint/.test(roomsXml))
  })

  await it('4.56：登录页那行空状态栏不再挂着', () => {
    const layoutDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const home = readFileSync(join(layoutDir, 'page_home.xml'), 'utf-8')
    const activity = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay', 'HomeActivity.java'), 'utf-8')
    check('状态行默认隐藏', /@\+id\/homeStatus[\s\S]{0,900}android:visibility="gone"/.test(home))
    check('没话说时整块收起来（不是画一条空卡片）',
      /private void setStatus\(String msg\)[\s\S]{0,400}View\.GONE/.test(activity))
    check('注销后不再写「已注销」', !/setStatus\("已注销"\)/.test(activity) && /setStatus\(""\)/.test(activity))
  })

  await it('4.58：服务端返回的 error/hint 也走三语', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    const serverText = readFileSync(join(javaDir, 'ServerText.java'), 'utf-8')
    const cjk = /[\u4e00-\u9fff]/

    // ① 机制：三层查表 + 「非中文界面不许出现中文」的兜底
    check('服务端原话有整句映射表', /static \{\s*\n\s*\/\/ ── 账号与登录/.test(serverText)
      && /put\("用户名或密码不对", R\.string\.srv_auth_failed\)/.test(serverText))
    check('带变量的句子按前缀/后缀认（变量丢掉）',
      /prefix\("没有这个接口："/.test(serverText) && /suffix\(" 不在这个房间里"/.test(serverText))
    check('WS 推送的机器码也翻（host-left 不该出现在界面上）',
      /CODES\.put\("host-left"/.test(serverText) && /CODES\.put\("removed-by-host"/.test(serverText))
    check('hint 比 error 更具体，优先用 hint', /String hint = body\.optString\("hint"/.test(serverText))
    check('非中文界面不给用户看中文', /UiLang\.ZH\.equals\(UiLang\.effective\(ctx\)\)/.test(serverText)
      && /return ctx\.getString\(R\.string\.srv_unknown\)/.test(serverText))

    // ② 服务端源码里的中文错误串，必须条条有映射（或明确列进"不翻译"清单）
    // 4.64：补上 lib/requests.mjs —— 术语库申请的错误文案全在它里面，
    // 之前没扫到，于是那句"必须写申请理由"在英文界面上是中文。
    const srvFiles = ['relay/lan-relay.mjs', 'relay/org-api.mjs', 'lib/rooms.mjs',
      'lib/floor.mjs', 'lib/accounts.mjs', 'lib/ws-hub.mjs', 'lib/requests.mjs']
    const candidates = new Set()
    for (const f of srvFiles) {
      for (const line of readFileSync(join(ROOT, f), 'utf-8').split('\n')) {
        if (!/error|hint|bad\(|reason/.test(line)) continue
        // 内部日志（debug() / ⚠️ / [ws]）永远不会到客户端，不属于"要翻译的面向用户文案"
        if (line.includes('⚠️') || line.includes('[ws]') || /\bdebug\(/.test(line)) continue
        for (const m of line.matchAll(/'([^']*)'|`([^`]*)`|"([^"]*)"/g)) {
          const v = m[1] ?? m[2] ?? m[3] ?? ''
          if (cjk.test(v)) candidates.add(v)
        }
      }
    }
    // Java 源码里的转义要还原成服务端真实文本再比（例如 \"proofread\" 那对引号）
    const unesc = (s) => s.replace(/\\(.)/g, '$1')
    const exact = [...serverText.matchAll(/put\("((?:[^"\\]|\\.)*)"/g)].map((m) => unesc(m[1]))
    const pre = [...serverText.matchAll(/prefix\("((?:[^"\\]|\\.)*)"/g)].map((m) => unesc(m[1]))
    const suf = [...serverText.matchAll(/suffix\("((?:[^"\\]|\\.)*)"/g)].map((m) => unesc(m[1]))
    // 明确不翻译的：管理端接口、只有客户端发错类型/参数才会触发、以及 relay 内部 500 详情
    const IGNORE = [
      '用户名必须是字符串', '密码必须是字符串', '邮箱必须是字符串', '角色只能是',
      '状态只能是', '没有这个账户', '续期天数要在', '写账号失败：',
      'text 必须是非空字符串', 'from 只能是', 'rate 只能是', 'lang 只能是',
      'since 必须是非负数字', 'PCM 数据长度必须是偶数', '写收件箱失败：', '写音频失败：',
      'libraryIds 必须是数组',
      // 申请审批侧（只有管理员 / 服务端自己会触发，手机上碰不到）
      '决定只能是', '缺少审批人', '缺少申请人',
    ]
    const ignore = (raw) => IGNORE.some((i) => raw.startsWith(i))
    const matched = (raw) => exact.includes(raw) || pre.some((p) => raw.startsWith(p))
      || suf.some((s) => raw.endsWith(s))
    const unmapped = [...candidates].filter((raw) => !matched(raw) && !ignore(raw))
    check('服务端的中文错误串条条有映射', unmapped.length === 0, unmapped.join(' | '))

    // ③ 反向：映射表里的句子必须**还在**服务端源码里（服务端改了措辞就会在这里红，
    //    否则映射会悄悄失效、非中文用户又看到中文或通用说明）
    const allServer = srvFiles.map((f) => readFileSync(join(ROOT, f), 'utf-8')).join('\n')
    const stale = exact.filter((raw) => !allServer.includes(raw))
    check('映射表里的服务端原话仍然存在', stale.length === 0, stale.join(' | '))

    // ④ 每条映射用到的键，三份资源都得有
    const keys = new Set([...serverText.matchAll(/R\.string\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))
    const load = (f) => new Set([...readFileSync(join(resDir, f), 'utf-8')
      .matchAll(/<string name="([A-Za-z0-9_]+)"/g)].map((m) => m[1]))
    const zh = load(join('values', 'strings.xml'))
    const en = load(join('values-en', 'strings.xml'))
    const pt = load(join('values-pt-rBR', 'strings.xml'))
    const missing = [...keys].filter((k) => !zh.has(k) || !en.has(k) || !pt.has(k))
    check('映射用到的键三份资源都有', missing.length === 0, missing.join(','))

    // ⑤ 显示服务端文本的地方都必须过 ServerText（不许再把 optString("error") 直接甩给界面）
    const acts = ['HomeActivity.java', 'RoomsActivity.java', 'RoomActivity.java', 'SettingsActivity.java']
    const raw = acts.filter((f) => /optString\("(error|hint)"/.test(readFileSync(join(javaDir, f), 'utf-8')))
    check('四个页面不再直接显示服务端原文', raw.length === 0, raw.join(','))
    check('接到服务端文本的地方真的调了 ServerText', acts.every((f) =>
      /ServerText\.(of|from)\(/.test(readFileSync(join(javaDir, f), 'utf-8'))))
  })

  await it('4.60：主页面重构成三入口 + 已支持语言 + 底部导航', () => {
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const home = readFileSync(join(resDir, 'layout', 'page_home.xml'), 'utf-8')
    const java = readFileSync(join(javaDir, 'HomeActivity.java'), 'utf-8')

    // 顶部：问候 + 摘要 + 右侧语言入口
    check('顶部有问候语', /@\+id\/homeGreeting/.test(home))
    check('问候下面有摘要（语言 · 设备 · 在线）',
      /@\+id\/homeSummary/.test(home)
      && /UiLang\.nativeLabel\(UiLang\.effective\(this\)\)/.test(java)
      && /R\.string\.audio_source_phone/.test(java)
      && /R\.string\.state_online/.test(java))
    check('右侧有界面语言入口', /@\+id\/homeLangEntry/.test(home)
      && /langEntry\.setOnClickListener\(v -> showUiLangPicker\(\)\)/.test(java))
    check('语言入口是三选一，不是循环切换', /AlertDialog\.Builder\(this\)[\s\S]{0,300}setItems/.test(java))
    check('问候按时段给', /greet_morning/.test(java) && /greet_afternoon/.test(java) && /greet_evening/.test(java))

    // 第一行：创建 / 加入，同级（同样 weight、同样最小高度）
    const createAt = home.indexOf('@+id/homeCardCreate')
    const joinAt = home.indexOf('@+id/homeCardJoin')
    const interpAt = home.indexOf('@+id/homeCardInterpreter')
    check('创建在左、加入在右', createAt > 0 && joinAt > createAt && interpAt > joinAt)
    const createBlock = home.slice(createAt, joinAt)
    const joinBlock = home.slice(joinAt, interpAt)
    check('两张卡同级（weight=1 + 同最小高度）',
      /android:layout_weight="1"/.test(createBlock) && /android:layout_weight="1"/.test(joinBlock)
      && /card_task_min_height/.test(createBlock) && /card_task_min_height/.test(joinBlock))
    check('卡里都有名称与简短说明',
      /card_create_title/.test(createBlock) && /card_create_desc/.test(createBlock)
      && /card_join_title/.test(joinBlock) && /card_join_desc/.test(joinBlock))
    check('两张卡都带图标', /ic_card_create/.test(createBlock) && /ic_card_join/.test(joinBlock))
    check('创建/加入进房间列表的对应一半',
      /homeCardCreate\)\.setOnClickListener\(v -> openRooms\("create"\)\)/.test(java)
      && /homeCardJoin\)\.setOnClickListener\(v -> openRooms\("join"\)\)/.test(java))

    // 第二行：同传翻译官通栏、独立场景、还没做
    const interpBlock = home.slice(interpAt, home.indexOf('home_supported_title'))
    check('同传翻译官通栏', /android:layout_width="match_parent"/.test(interpBlock))
    check('同传翻译官有图标与说明',
      /ic_card_interpreter/.test(interpBlock) && /card_interp_title/.test(interpBlock)
      && /card_interp_desc/.test(interpBlock))
    check('它标了「即将上线」（不假装能用）', /card_interp_soon/.test(interpBlock))
    check('它没有点击监听（点了就该没反应）', !/homeCardInterpreter\)\.setOnClickListener/.test(java))

    // 已支持语言：中文 / 巴西葡萄牙语 / 扩展提示
    const supported = home.slice(home.indexOf('home_supported_title'), home.indexOf('@+id/homeLegacy'))
    check('已支持语言卡片有标题', /home_supported_title/.test(supported))
    check('标签列出中文与巴西葡萄牙语',
      /@string\/lang_zh/.test(supported) && /@string\/lang_pt_full/.test(supported))
    check('有语言扩展提示', /home_supported_more/.test(supported))

    // 底部三项一级导航
    const navXml = readFileSync(join(resDir, 'layout', 'inc_bottom_nav.xml'), 'utf-8')
    check('底部有三个导航项（公共片段）', /@\+id\/homeNavHome/.test(navXml)
      && /@\+id\/homeNavHistory/.test(navXml) && /@\+id\/homeNavMe/.test(navXml))
    check('导航文案是首页/历史/我的',
      /@string\/nav_home/.test(navXml) && /@string\/nav_history/.test(navXml)
      && /@string\/nav_me/.test(navXml))
    // 4.69：历史有页面了，这一项要能进去（之前是灰着的占位）
    check('历史导航能进历史页',
      /homeNavHistory\)\.setOnClickListener[\s\S]{0,160}(HistoryActivity\.class|NavTabs\.HISTORY)/.test(java))
    check('我的进「我的」页', /homeNavMe\)\.setOnClickListener[\s\S]{0,200}(MeActivity\.class|NavTabs\.ME)/.test(java))
    // 4.62：导航抽成公共片段，所以这里只验"include 在 ScrollView 之后"
    check('底部导航固定（不在 ScrollView 里）',
      home.indexOf('</ScrollView>') < home.indexOf('@layout/inc_bottom_nav'))
    check('导航片段自己不是 ScrollView 的子节点',
      /@layout\/inc_bottom_nav/.test(home) && !/ScrollView[\s\S]*@layout\/inc_bottom_nav[\s\S]*<\/ScrollView>/.test(home))
    check('导航只在登录后出现（片段里默认 gone，登录后才点亮）',
      /@\+id\/homeBottomNav[\s\S]{0,400}visibility="gone"/.test(navXml)
      && /NavTabs\.apply\(this, NavTabs\.HOME\)/.test(java)
      && /bottomNav\.setVisibility\(View\.GONE\)/.test(java))
    check('登录页抬头在进首页后收起（不能两套抬头）',
      /loginHeader\.setVisibility\(View\.GONE\)/.test(java))

    // 图标风格统一：卡片图标都是品牌色 tint
    const cardIcons = [...home.matchAll(/android:src="@drawable\/(ic_card_\w+)"[\s\S]{0,80}?android:tint="@color\/(\w+)"/g)]
    check('三张卡的图标都走品牌色', cardIcons.length === 3
      && cardIcons.every((m) => m[2] === 'brand'), JSON.stringify(cardIcons.map((m) => m[1])))

    // 只摆三个核心入口：不允许混进营销模块
    const cardIds = [...home.matchAll(/@\+id\/(homeCard\w+)/g)].map((m) => m[1])
    check('首页只有三张任务卡', cardIds.length === 3, cardIds.join(','))
  })

  await it('门禁：Java 里引用的每个 R.id 都真的存在于布局', () => {
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'layout')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const layoutIds = new Set()
    for (const f of readdirSync(resDir)) {
      if (!f.endsWith('.xml')) continue
      for (const m of readFileSync(join(resDir, f), 'utf-8').matchAll(/@\+id\/([A-Za-z0-9_]+)/g)) layoutIds.add(m[1])
    }
    const missing = []
    for (const f of readdirSync(javaDir)) {
      if (!f.endsWith('.java')) continue
      for (const m of readFileSync(join(javaDir, f), 'utf-8').matchAll(/R\.id\.([A-Za-z0-9_]+)/g)) {
        if (!layoutIds.has(m[1])) missing.push(`${f}:${m[1]}`)
      }
    }
    // 4.60 重构时删掉过 homeWho/homeCreate/homeSettings —— 这个断言就是为了那种情况
    check('没有指向不存在控件的 findViewById', missing.length === 0, missing.join(' | '))
  })

  await it('4.62：「我的」页面 + 术语库管理（只能提申请）', () => {
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const layout = (f) => readFileSync(join(resDir, 'layout', f), 'utf-8')
    const java = (f) => readFileSync(join(javaDir, f), 'utf-8')

    const me = layout('page_me.xml')
    const meJava = java('MeActivity.java')

    // ① 顶部标题 + 渐变个人卡片（头像 / 姓名 / 组织 / 版本）
    check('有页面标题「我的」', /@string\/nav_me/.test(me))
    check('个人卡片是蓝绿渐变', /@drawable\/bg_card_gradient/.test(me)
      && /brand_grad_start/.test(readFileSync(join(resDir, 'drawable', 'bg_card_gradient.xml'), 'utf-8'))
      && /brand_grad_end/.test(readFileSync(join(resDir, 'drawable', 'bg_card_gradient.xml'), 'utf-8')))
    check('卡片里有头像 / 姓名 / 组织 / 版本',
      ['meAvatar', 'meName', 'meOrg', 'meVersion'].every((id) => me.includes('@+id/' + id)))
    check('组织那行按角色写（没有就编一个组织名）',
      /me_org_role_admin/.test(meJava) && /me_org_role_user/.test(meJava))

    // ② 四行依次：设备 / 术语库 / 翻译服务 / 帮助，再退出登录
    const order = ['meRowDevice', 'meRowTerms', 'meRowService', 'meRowHelp', 'meLogout']
      .map((id) => me.indexOf('@+id/' + id))
    check('四行顺序符合设计', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])),
      JSON.stringify(order))
    check('我的设备：名称 + 能力摘要 + 连接状态',
      /me_device_summary/.test(meJava) && /android\.os\.Build\.MODEL/.test(meJava)
      && /@\+id\/meDeviceState/.test(me))
    check('连接状态用真实在线结果（不是假开关）',
      /state_online/.test(meJava) && /state_offline/.test(meJava)
      && /client\.authWhoAmI\(\)/.test(meJava))
    check('翻译服务显示有效期（读不到就说未知）',
      /me_service_expires/.test(meJava) && /me_service_unknown/.test(meJava))
    check('帮助与反馈有隐私政策入口',
      /me_help_body/.test(meJava) && /PrivacyActivity\.class/.test(meJava))
    check('退出登录要二次确认', /me_logout_confirm/.test(meJava))
    check('退出走服务端注销并清本地', /authLogout\(\)/.test(meJava)
      && /remove\("accountToken"\)/.test(meJava))

    // ③ 底部导航共用片段，且高亮当前页
    check('我的页面也带底部导航', /@layout\/inc_bottom_nav/.test(me))
    const nav = java('NavTabs.java')
    check('导航高亮只有一处实现', /public static void apply\(/.test(nav)
      && /NavTabs\.apply\(this, NavTabs\.ME\)/.test(meJava)
      && /NavTabs\.apply\(this, NavTabs\.HOME\)/.test(java('HomeActivity.java')))
    check('历史那项永远灰（还没做）',
      /style\(activity, R\.id\.homeNavHistoryIcon, R\.id\.homeNavHistoryLabel, active == HISTORY\)/.test(nav))

    // ④ 术语库管理：只能提申请，不许直接改库
    const terms = layout('page_terms_lib.xml')
    const termsJava = java('TermLibActivity.java')
    check('术语库页列出库与我的申请',
      /termsLibList/.test(terms) && /termsRequestList/.test(terms))
    check('用的是审批接口（提申请）', /orgCreateRequest\(/.test(termsJava))
    check('列出我的申请与撤回', /orgMyRequests\(\)/.test(termsJava)
      && /orgWithdrawRequest\(/.test(termsJava))
    check('三种申请类型都在', /terms_req_add/.test(termsJava) && /terms_req_update/.test(termsJava)
      && /terms_req_delete/.test(termsJava))
    check('删除只填中文、新增/修改要双语',
      /ptInput\.setVisibility\(needPt \? View\.VISIBLE : View\.GONE\)/.test(termsJava))
    check('申请人由服务端定（请求体里不放 applicant）',
      /不要放 applicant|不放进去/.test(termsJava) && !/body\.put\("applicant"/.test(termsJava))
    check('申请表单在独立的对话框布局里', /dialog_term_request/.test(termsJava))

    // ⑤ 注册进 manifest
    const manifest = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf-8')
    check('两个新页面都注册了', /\.MeActivity/.test(manifest) && /\.TermLibActivity/.test(manifest))

    // ⑥ 服务端 whoami 带上账号状态与到期时间（老服务端没有时客户端要能显示"未知"）
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')
    check('whoami 返回账号状态与到期时间', /status: typeof record\.status/.test(relay)
      && /expiresAt: typeof record\.expiresAt/.test(relay))
  })

  await it('4.63：提术语库申请被 403 的两件事（权限表 + 提示说不清）', () => {
    const root = (f) => readFileSync(join(ROOT, f), 'utf-8')
    const accounts = root('lib/accounts.mjs')
    const orgApi = root('relay/org-api.mjs')
    const serverText = root('android/app/src/main/java/com/leion/lanrelay/ServerText.java')
    const termsJava = root('android/app/src/main/java/com/leion/lanrelay/TermLibActivity.java')

    // ① 权限表：dev（测试账号）也要能提申请 —— 提申请没有破坏性，要管理员审批才写库
    check('request.create 允许 dev（测试账号）',
      /'request\.create': \['admin', 'user', 'dev'\]/.test(accounts),
      '漏掉 dev 的话，测试账号一提交就是 403')

    // ② 403 要能说清"谁不能做什么"：中文原话 + 机器可读字段
    check('deny 返回 code/role/action', /code: 'forbidden'/.test(orgApi)
      && /role: role \?\? ''/.test(orgApi) && /action,/.test(orgApi))

    // ③ 客户端两种服务端都能读懂：新服务端看 code，老服务端解析那句中文
    check('客户端认得结构化 403', /"forbidden"\.equals\(body\.optString\("code", ""\)\)/.test(serverText))
    check('客户端也解析老服务端的中文原话',
      /private static String forbiddenDetail/.test(serverText)
      && /startsWith\("当前角色（"\)/.test(serverText))
    check('解析出来的角色会显示给人看',
      /R\.string\.srv_role_cannot_role, role, action/.test(serverText))

    // ④ 没权限就别让人点：进页面先说清角色，按钮干脆不出现
    check('页面先问一次 whoami 拿角色',
      /client\.authWhoAmI\(\)/.test(termsJava) && /role = who\.optString\("role"/.test(termsJava))
    check('没权限时不画「申请修改」按钮',
      /if \(canCreateRequest\(\)\) \{[\s\S]{0,400}card\.addView\(apply\);/.test(termsJava))
    check('没权限时把角色写在提示里', /terms_forbidden_role/.test(termsJava))
    check('权限判定与服务端一致（admin/user/dev）',
      /"admin"\.equals\(role\) \|\| "user"\.equals\(role\) \|\| "dev"\.equals\(role\)/.test(termsJava))

    // ⑤ 三份资源都有这条提示
    for (const dir of ['values', 'values-en', 'values-pt-rBR']) {
      check(`terms_forbidden_role 在 ${dir} 里`,
        /name="terms_forbidden_role"/.test(readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'res', dir, 'strings.xml'), 'utf-8')))
    }
  })

  await it('4.64：已决定的申请可删除 + 三语下两张卡要对齐', () => {
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const terms = readFileSync(join(javaDir, 'TermLibActivity.java'), 'utf-8')
    const lanClient = readFileSync(join(javaDir, 'LanClient.java'), 'utf-8')
    const requests = readFileSync(join(ROOT, 'lib', 'requests.mjs'), 'utf-8')
    const store = readFileSync(join(ROOT, 'lib', 'requests-store.mjs'), 'utf-8')
    const db = readFileSync(join(ROOT, 'lib', 'db.mjs'), 'utf-8')

    // ① 删除：接口 / 客户端 / 只在非 pending 时出现 / 二次确认
    check('Api：删除自己已决定的申请', /orgDeleteRequest\(/.test(lanClient)
      && /\/org\/requests\/" \+ requestId \+ "\/delete"/.test(lanClient))
    check('服务端：hideRequest 只认自己的、且不许删 pending',
      /export async function hideRequest/.test(requests)
      && /只能删除自己的申请/.test(requests)
      && /item.status === 'pending'[\s\S]{0,120}待审批的申请请先撤回/.test(requests))
    check('隐藏不销毁审计：只打 hidden_at 标记',
      /UPDATE requests SET hidden_at = \?/.test(store) && /hidden_at  INTEGER/.test(db)
      && /ALTER TABLE requests ADD COLUMN hidden_at/.test(db))
    check('我的申请里过滤掉自己删掉的', /visibleOfMine\(items, user\)/.test(
      readFileSync(join(ROOT, 'relay', 'org-api.mjs'), 'utf-8')))
    check('界面：非 pending 才给「删除记录」', /if \(!"pending"\.equals\(status\)\) \{[\s\S]{0,600}terms_delete/.test(terms))
    check('删除有二次确认并说明只删记录', /confirmDelete\(/.test(terms) && /terms_delete_confirm/.test(terms))

    // ② 三语对齐：两张任务卡的说明锁 2 行（中文比英文短一行时最容易露馅）
    const home = readFileSync(join(resDir, 'layout', 'page_home.xml'), 'utf-8')
    // 按控件切块再看属性：minLines/maxLines 写在 android:text 之前，不能用"文本之后 N 个字符"取
    const textViews = [...home.matchAll(/<TextView[\s\S]*?\/>/g)].map((m) => m[0])
    const cardBlock = (name) => textViews.filter((block) => block.includes(`@string/card_${name}`))
    const descs = [...cardBlock('create_desc'), ...cardBlock('join_desc')]
    check('两张卡都有说明', descs.length === 2, String(descs.length))
    check('两张卡的说明都锁 2 行（minLines + maxLines）',
      descs.every((block) => /android:minLines="2"/.test(block) && /android:maxLines="2"/.test(block)))
    const titles = [...cardBlock('create_title'), ...cardBlock('join_title')]
    check('名称允许换行但不截断（maxLines=2）', titles.length === 2
      && titles.every((block) => /android:maxLines="2"/.test(block)))
    check('卡片还有最小高度兜底', /card_task_min_height/.test(home))
  })

  await it('4.69：历史记录页（卡片六样 + 类型标签只有两种）', () => {
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const layout = (f) => readFileSync(join(resDir, 'layout', f), 'utf-8')
    const java = (f) => readFileSync(join(javaDir, f), 'utf-8')

    const page = layout('page_history.xml')
    const item = layout('item_history.xml')
    const history = java('HistoryActivity.java')
    const detail = java('HistoryDetailActivity.java')

    // ① 顶部：页面标题 + 保存期限提示；列表 + 空态
    check('有标题', /@string\/nav_history/.test(page))
    check('有保存期限提示', /@\+id\/historyRetention/.test(page))
    check('列表与空态都在', /@\+id\/historyList/.test(page) && /@\+id\/historyEmpty/.test(page))
    check('底部保留三项导航', /@layout\/inc_bottom_nav/.test(page))
    check('保存期用服务端给的值，不写死', /retentionDays/.test(history)
      && /R\.string\.hist_retention/.test(history))

    // ② 卡片六样：名称 / 类型 / 时间 / 时长 / 人数 / 语言
    check('卡片有名称与类型标签',
      /@\+id\/itemName/.test(item) && /@\+id\/itemKind/.test(item))
    check('次要信息（时间·时长·人数）单独一行', /@\+id\/itemMeta/.test(item))
    check('语言方向单独一行', /@\+id\/itemLangs/.test(item))
    check('名称是加粗主色（首要信息）', /@\+id\/itemName[\s\S]{0,400}android:textStyle="bold"/.test(item))
    check('类型标签用品牌色胶囊', /@\+id\/itemKind[\s\S]{0,300}bg_chip_brand/.test(item))
    check('六样都真的填了',
      /formatDate\(/.test(history) && /formatDuration\(/.test(history)
      && /peopleLabel\(/.test(history) && /langsLabel\(/.test(history))
    check('人数 1 显示「仅自己」', /hist_only_me/.test(history))

    // ③ 类型标签只有两种含义，且不拿场景当类型
    check('类型只有会议/翻译官两个键', /hist_type_meeting/.test(history) && /hist_type_interpreter/.test(history))
    // 只看代码与文案，不看注释（注释里正解释"为什么不这么分"）
    const stripComments = (text) => text
      .replace(/<!--[\s\S]*?-->/g, '')            // XML 注释
      .replace(/\/\*[\s\S]*?\*\//g, '')       // Java 块注释
      .split('\n').map((line) => line.split('//')[0]).join('\n')
    const zhStrings = readFileSync(join(resDir, 'values', 'strings.xml'), 'utf-8')
    const typeLines = [...zhStrings.matchAll(/<string name="(hist_type_[a-z]+)">([^<]*)<\/string>/g)]
      .map((m) => `${m[1]}=${m[2]}`)
    check('类型标签文案里没有「面对面 / 远程」',
      !/面对面|远程/.test(typeLines.join('\n')), typeLines.join(','))
    check('代码里也没拿它当类型判断',
      !/面对面|远程/.test(stripComments(history)) && !/面对面|远程/.test(stripComments(item))
      && !/面对面|远程/.test(stripComments(page)))
    check('kind 未知时落到「同传会议」而不是空白',
      /"interpreter"\.equals\(kind\)\) return getString\(R\.string\.hist_type_interpreter\);\s*\n\s*return getString\(R\.string\.hist_type_meeting\);/.test(history))

    // ④ 卡片可点进详情（详情内容下一轮）
    check('卡片可点击进详情', /HistoryDetailActivity\.class/.test(history)
      && /putExtra\(HistoryDetailActivity\.EXTRA_JSON/.test(history))
    check('详情页按原型拆成三段（统计/转写/导出）',
      /statDuration/.test(layout('page_history_detail.xml'))
      && /transcript_title/.test(layout('page_history_detail.xml'))
      && /detailExport/.test(layout('page_history_detail.xml')))
    check('两页都注册进 manifest', /\.HistoryActivity/.test(readFileSync(
      join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf-8')))

    // ⑤ 导航：历史这一项现在会点亮，且首页/我的都能进
    check('历史页把「历史」点亮', /NavTabs\.apply\(this, NavTabs\.HISTORY\)/.test(history))
    const home = java('HomeActivity.java')
    const me = java('MeActivity.java')
    check('首页的历史导航进得去', /homeNavHistory\)\.setOnClickListener[\s\S]{0,160}(HistoryActivity\.class|NavTabs\.HISTORY)/.test(home))
    check('「我的」里的历史导航也进得去', /homeNavHistory\)\.setOnClickListener[\s\S]{0,160}(HistoryActivity\.class|NavTabs\.HISTORY)/.test(me))

    // ⑥ 服务端：只返回我参加过的 + 保留期由服务端给
    const rooms = readFileSync(join(ROOT, 'lib', 'rooms.mjs'), 'utf-8')
    check('只查我参加过的会', /JOIN room_members me ON me\.room_id = r\.id AND me\.username = \?/.test(rooms))
    check('人数按不同人算（不是"还在里面的人"）', /COUNT\(DISTINCT m\.username\)/.test(rooms))
    check('语言去重', /SELECT DISTINCT lang FROM room_members/.test(rooms))
  })

  await it('4.71：历史记录「按账号删除」+ 详情页（统计→转写→导出）', () => {
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const java = (f) => readFileSync(join(javaDir, f), 'utf-8')
    const layout = (f) => readFileSync(join(resDir, 'layout', f), 'utf-8')
    const history = java('HistoryActivity.java')
    const detail = java('HistoryDetailActivity.java')
    const lanClient = java('LanClient.java')
    const rooms = readFileSync(join(ROOT, 'lib', 'rooms.mjs'), 'utf-8')
    const orgApi = readFileSync(join(ROOT, 'relay', 'org-api.mjs'), 'utf-8')

    // ① 语义：删的是"我这个账号的列表"，服务端存一条按账号的隐藏记录
    check('服务端有按账号的隐藏表', /CREATE TABLE IF NOT EXISTS history_hidden/.test(
      readFileSync(join(ROOT, 'lib', 'db.mjs'), 'utf-8')))
    check('只删自己参加过的（防止往别人历史里塞过滤）',
      /SELECT 1 AS yes FROM room_members WHERE room_id = \? AND username = \?/.test(rooms))
    check('列表按"我自己"过滤掉已删的',
      /LEFT JOIN history_hidden h ON h\.room_id = r\.id AND h\.username = \?/.test(rooms))
    check('有删除路由', /segments\[3\] === 'delete'/.test(orgApi) && /hideHistoryForUser\(/.test(orgApi))
    check('客户端走服务端接口', /orgDeleteHistory\(/.test(lanClient)
      && /\/org\/history\/" \+ roomId \+ "\/delete"/.test(lanClient))
    check('客户端不再有"设备本地隐藏"的第二套实现',
      !/HistoryStore/.test(history) && !/HistoryStore/.test(detail))

    // ② 入口：列表长按 + 详情页按钮，且都走服务端
    check('长按删除', /setOnLongClickListener[\s\S]{0,200}confirmDelete/.test(history))
    check('列表删除调到服务端', /orgDeleteHistory\(roomId\)/.test(history))
    check('详情页也有删除按钮', /@\+id\/detailDelete/.test(layout('page_history_detail.xml'))
      && /orgDeleteHistory\(roomId\)/.test(detail))
    check('删前二次确认并说明只影响自己', /hist_delete_confirm/.test(history))

    // ③ 详情页结构（原型顺序：统计概览 → 转写全文 → 导出）
    const page = layout('page_history_detail.xml')
    const order = ['statDuration', 'statLangs', 'statSpeakers', 'transcript_title', 'detailExport']
      .map((key) => page.indexOf(key))
    check('顺序是 统计 → 转写 → 导出', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])),
      JSON.stringify(order))
    check('三列统计数值用主色', /@\+id\/statDuration[\s\S]{0,200}@color\/brand/.test(page))
    const noComment = (text) => text.replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((line) => line.split('//')[0]).join('\n')
    check('会议纪要相关整块没做（无摘要 / 无行动项 / 无责任人）',
      !/AI|摘要|行动项|责任人/.test(noComment(page))
      && !/AI|摘要|行动项|责任人/.test(noComment(detail)))

    // ④ 导出：只导出已有记录内容，且是真 docx
    const docx = java('HistoryDocx.java')
    check('docx 是手写 zip（不引第三方库）',
      /ZipOutputStream/.test(docx) && /\[Content_Types\]\.xml/.test(docx) && /word\/document\.xml/.test(docx))
    // docx 生成器里只能出现"记录本身"（注释里说明"不生成摘要"是可以的，所以先剥注释）
    const docxCode = docx.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((line) => line.split('//')[0]).join('\n')
    check('导出内容不含摘要/行动项', !/摘要|行动项/.test(docxCode), docxCode.slice(0, 80))
    check('通过 FileProvider 分享', /FileProvider\.getUriForFile/.test(detail)
      && /\.fileprovider/.test(readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf-8')))
  })

  await it('4.72：转写全文 = 多张字幕卡 + 固定高度框内滚动', () => {
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const page = readFileSync(join(resDir, 'layout', 'page_history_detail.xml'), 'utf-8')
    const card = readFileSync(join(resDir, 'layout', 'item_subtitle_card.xml'), 'utf-8')
    const detail = readFileSync(join(javaDir, 'HistoryDetailActivity.java'), 'utf-8')
    const helper = readFileSync(join(javaDir, 'SubtitleCard.java'), 'utf-8')
    const room = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')

    // ① 固定高度 + 内部滚动
    check('转写外框高度固定（不是 wrap_content）',
      /@\+id\/transcriptScroll[\s\S]{0,220}android:layout_height="@dimen\/transcript_box_height"/.test(page))
    check('外框是 ScrollView（内容自己上下滑）',
      /<ScrollView[\s\S]{0,200}@\+id\/transcriptScroll/.test(page))
    check('里面是竖排容器', /@\+id\/transcriptList[\s\S]{0,200}android:orientation="vertical"/.test(page))
    check('固定高度是个真尺寸（360dp 这档）',
      /name="transcript_box_height">\d+dp</.test(
        readFileSync(join(resDir, 'values', 'dimens.xml'), 'utf-8')))

    // ② 每条渲染成一张卡（不是一整段文字）
    check('逐条渲染成卡片', /SubtitleCard\.render\(list, one, mineName\)/.test(detail))
    check('没有转写时收起空框、只留一句说明',
      /private void showTranscriptEmpty\(\)[\s\S]{0,400}transcriptScroll[\s\S]{0,200}View\.GONE/.test(detail))

    // ③ 卡片格式与会议中的字幕一致：同一套 drawable / 字号 / 内边距
    // 布局里是默认底；“自己说的”换底色在 SubtitleCard 里做（与会议室一样）
    for (const token of ['bg_card', 'bg_avatar', 'bg_chip']) {
      check(`卡片用了会议同款 ${token}`, new RegExp(token).test(card), token)
    }
    check('卡片头/原文/译文的层级一致',
      /@\+id\/subAvatar/.test(card) && /@\+id\/subSpeaker/.test(card)
      && /@\+id\/subOriginal/.test(card) && /@\+id\/subTarget/.test(card))
    check('会议室那张卡也是同一套素材（视觉一致）',
      /bg_subtitle_self/.test(room) && /bg_avatar/.test(room) && /R\.string\.st_done/.test(room))
    check('卡片度量走同一批 token', /subtitle_card_padding/.test(card)
      && /subtitle_avatar_size/.test(card) && /subtitle_tag_text/.test(card))
    check('自己的发言换底色（与会议一致）',
      /card\.setBackgroundResource\(R\.drawable\.bg_subtitle_self\)/.test(helper))

    // ④ 服务端：按会议读转写，且只给参与者
    const rooms = readFileSync(join(ROOT, 'lib', 'rooms.mjs'), 'utf-8')
    const orgApi = readFileSync(join(ROOT, 'relay', 'org-api.mjs'), 'utf-8')
    check('有读转写的接口', /segments\[3\] === 'transcript'/.test(orgApi) && /listRoomTranscript\(/.test(orgApi))
    check('只查 is_final 的字幕、按时间正序', /is_final = 1 ORDER BY start_at/.test(rooms))
    check('非参与者读不到', /你没有参加过这场会议/.test(rooms))
  })

  await it('4.76：实时传声 —— 开麦的人说的话，别人能听到', () => {
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const java = (f) => readFileSync(join(javaDir, f), 'utf-8')
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')
    const hub = readFileSync(join(ROOT, 'lib', 'ws-hub.mjs'), 'utf-8')
    const player = java('RoomAudioPlayer.java')
    const room = java('RoomActivity.java')

    // ① 服务端：只发给"开了倾听"的同房间连接，且不走 JSON（音频是二进制）
    check('hub 有选择性转发', /function broadcastRoomAudio\(/.test(hub))
    check('只发给开了倾听的连接', /if \(conn\.listen !== true\) continue/.test(hub))
    check('按房间隔离', /const conns = rooms\.get\(room\.id\)/.test(hub))
    check('音频走二进制帧而不是 JSON', /function sendBinary\(/.test(hub) && /OP_BINARY/.test(hub))
    check('客户端能开关倾听', /type === 'listen'/.test(hub))
    check('relay 把上传的音频块也推给听众',
      /broadcastRoomAudio\(audioRoom, body, holderNow\)/.test(relay))

    // ② 客户端：AudioTrack 流式播放 + 抖动缓冲 + 丢旧块
    check('用 AudioTrack 流模式播放', /AudioTrack\.MODE_STREAM/.test(player))
    check('有抖动缓冲（队列）', /ArrayBlockingQueue/.test(player))
    check('队列满了丢最旧的（延迟优先）', /droppedChunks \+= 1/.test(player))
    check('二进制帧回调', /public void onMessage\(java\.nio\.ByteBuffer/.test(java('FloorSocket.java')))
    check('开启倾听就把开关发给服务端', /sendListen\(on\)/.test(java('FloorSocket.java')))
    check('房间页有「听声音」开关', /@\+id\/roomListen/.test(
      readFileSync(join(resDir, 'layout', 'page_room.xml'), 'utf-8')))
    check('拿麦时**暂停**播放（不是把开关永久关掉）', /applyListenState\(\);/.test(room))
    check('服务端兜底：持麦者的连接不收自己的声音',
      /exceptUser !== '' && String\(conn\.user\) === String\(exceptUser\)/.test(hub)
      && /broadcastRoomAudio\(audioRoom, body, holderNow\)/.test(relay))
    check('离开房间释放播放器', /audioPlayer\.stop\(\)/.test(room))
    check('提示戴耳机（回声的取舍写在界面里）', /room_listen_hint/.test(room))
  })

  // 4.91 修的是 4.76 里那个"说不清但一定遇到"的 bug：
  // 说完话之后倾听再也没打开（"你说完我说"的会议里，每人一开口就把自己的耳朵关掉），
  // 表现就是用户报的「会议中音频传不到另外一个人那里」。
  // 这几条钉住修复本身，以及"播放器坏了要留痕"（静默失败是最难查的一类）。
  await it('4.91：说完话要能自动听回来（listenWanted 与实际播放分开）', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const room = readFileSync(join(javaDir, 'RoomActivity.java'), 'utf-8')
    const socket = readFileSync(join(javaDir, 'FloorSocket.java'), 'utf-8')
    const player = readFileSync(join(javaDir, 'RoomAudioPlayer.java'), 'utf-8')
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')

    // ① 意图与状态分开，且拿麦/放麦都走同一个决定函数
    check('有"我想听"这个意图字段', /private boolean listenWanted/.test(room))
    check('缺省就想听（会议里听得到别人是预期行为，不该每次手点）',
      /private boolean listenWanted = true;/.test(room))
    check('有一个统一的决定函数', /private void applyListenState\(\)/.test(room))
    check('它按"想听而且此刻没在说话"决定', /boolean shouldPlay = listenWanted && !holding;/.test(room))
    check('幂等（状态没变就不重启播放器、不重发消息）', /if \(shouldPlay == listening\)/.test(room))
    check('旧写法（一开口就永久关掉倾听）必须消失',
      // ⚠️ 必须**先剥注释**再查：那条旧写法在修完的代码里还出现在一段"为什么改"的注释里，
      //    不剥注释就会把注释当成代码（这条断言自己先踩过一次）。
      /if \(holding && listening\) stopListening\(\)/
        .test(room.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
          .filter(line => line.trim().startsWith('//') === false).join('\n')) === false,
      '又回到"说完就听不到"的老 bug')
    check('发言权变化时调用它', /applyListenState\(\);[\s\S]{0,80}if \(!holding\) holdingSinceMs = 0L;/.test(room))

    // ② 重连后要重新订阅（服务端的 listen 挂在连接上，reconnect = 新连接）
    check('重连后重新发送订阅', /if \(online && listenWanted\)[\s\S]{0,200}sendListen\(true\)/.test(room))

    // ③ 采样率要跟着服务端走（16k 硬放 44.1k 会变调，听着像"卡"）
    check('服务端会告知采样率', /type: 'audio-meta'/.test(relay) && /broadcastFrame\(\{ type: 'audio-meta'/.test(relay))
    check('只在变化时发一帧', /roomRateAnswered\.get\(audioRoom\) !== rate/.test(relay))
    check('客户端能收这个通知', /audio-meta/.test(socket) && /onAudioRate/.test(socket))
    check('播放器据此重建 AudioTrack', /public void setSampleRate\(int rate\)/.test(player)
      && /AudioTrack\(AudioManager\.STREAM_MUSIC, sampleRate/.test(player))

    // ④ 播放器失败必须留痕（"没声音"最怕静默）
    check('播放器有 logcat 留痕', /Log\.w\(TAG/.test(player)
      && /import android\.util\.Log;/.test(player), 'logcat 标签没接上')
    check('失败原因能取出来', /public String lastError\(\)/.test(player))
    check('丢弃块数能取出来', /public long droppedChunks\(\)/.test(player))
    check('AudioTrack 创建失败不再静默 return', /AudioTrack 创建失败/.test(player))
  })

  // 4.93：底部导航"从右侧推入覆盖"的观感问题。
  // 三个页面原来是各自 startActivity，走的是 Activity 默认转场 = "打开下一层"，
  // 而底部导航是平级切换 —— 水平推移会让人以为在前进/后退（用户实测反馈）。
  await it('4.93：底部导航是平级切换 —— 淡入淡出，不用默认的"从右侧推入"', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const animDir = join(ROOT, 'android', 'app', 'src', 'main', 'res', 'anim')
    const nav = readFileSync(join(javaDir, 'NavTabs.java'), 'utf-8')
    const home = readFileSync(join(javaDir, 'HomeActivity.java'), 'utf-8')
    const me = readFileSync(join(javaDir, 'MeActivity.java'), 'utf-8')
    const history = readFileSync(join(javaDir, 'HistoryActivity.java'), 'utf-8')
    const fadeIn = readFileSync(join(animDir, 'nav_fade_in.xml'), 'utf-8')
    const fadeOut = readFileSync(join(animDir, 'nav_fade_out.xml'), 'utf-8')

    // ① 换页动画：只有 alpha，**不许有 translate**（有位移就又变回"推入"了）
    //    ⚠️ 先剥注释再查：这两个文件的注释里就写着"没有 translate"，不剥会把注释当代码。
    const stripXmlComments = (text) => text.replace(/<!--[\s\S]*?-->/g, '')
    const fadeInCode = stripXmlComments(fadeIn)
    const fadeOutCode = stripXmlComments(fadeOut)
    check('nav_fade_in 存在且是淡入', /<alpha/.test(fadeInCode) && /fromAlpha="0.0"/.test(fadeInCode), '缺 alpha')
    check('nav_fade_out 存在且是淡出', /<alpha/.test(fadeOutCode) && /toAlpha="0.0"/.test(fadeOutCode), '缺 alpha')
    check('**没有水平/垂直位移**',
      /<translate/.test(fadeInCode) === false && /<translate/.test(fadeOutCode) === false,
      '加了位移就又变成"推入"')
    check('时长够短（≤200ms，不让人觉得在等动画）',
      (fadeInCode.match(/duration="(\d+)"/) ?? [])[1] !== undefined
        && Number((fadeInCode.match(/duration="(\d+)"/) ?? [0, 999])[1]) <= 200,
      (fadeInCode.match(/duration="(\d+)"/) ?? [])[1])

    // ② 统一入口：三个页面都必须走 NavTabs.go，不许各写一份 startActivity
    for (const [label, source] of [['首页', home], ['我的', me], ['历史', history]]) {
      check(`${label}的导航项走 NavTabs.go`,
        /NavTabs\.go\(this, NavTabs\.(HOME|HISTORY|ME)\)/.test(source), '还在直接 startActivity')
    }
    check('切换时指定了交叉淡化转场',
      /overridePendingTransition\(R\.anim\.nav_fade_in, R\.anim\.nav_fade_out\)/.test(nav), '缺转场')
    check('返回键也走同一套淡化（同一件事不能两种动画）',
      /onBackPressed[\s\S]{0,200}nav_fade_in/.test(me) && /onBackPressed[\s\S]{0,200}nav_fade_in/.test(history),
      '返回键还是默认动画')

    // ③ 栈管理：别越叠越高；回首页要复用已有实例
    check('非首页之间切换会关掉当前页（栈里最多「首页 + 当前页」）',
      /if \(tab != HOME && from\.getClass\(\) != HomeActivity\.class\) \{\s*\n\s*from\.finish\(\);/.test(nav),
      '标签页会互相压着')
    check('切到标签页复用在栈里的实例（REORDER_TO_FRONT，不重建不重复拉数据）',
      /FLAG_ACTIVITY_REORDER_TO_FRONT \| Intent\.FLAG_ACTIVITY_SINGLE_TOP/.test(nav), '缺 REORDER_TO_FRONT')
    check('回首页用 CLEAR_TOP（不会叠出好几个首页）',
      /FLAG_ACTIVITY_CLEAR_TOP \| Intent\.FLAG_ACTIVITY_SINGLE_TOP/.test(nav), '缺 CLEAR_TOP')
    check('点当前这一页什么都不做（不重启自己）',
      /if \(from\.getClass\(\) == target\) return;/.test(nav), '缺自我点击短路')
  })

  await it('4.81：/frame 的 seq 不许被 info() 覆盖（否则死循环刷日志）', () => {
    const relay = readFileSync(join(ROOT, 'relay', 'lan-relay.mjs'), 'utf-8')
    const client = readFileSync(join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay', 'LanClient.java'), 'utf-8')

    // ① 服务端：info() 必须在前，我们算的 seq/frame/changed 在后（覆盖它）
    check('有专门的组装函数', /function framePayload\(/.test(relay))
    check('复位分支用 framePayload 且 info() 在前',
      /framePayload\(info\(\), \{\s*\n\s*ok: true,\s*\n\s*reset: true,/.test(relay))
    check('立即给帧分支同样如此', /framePayload\(info\(\), \{\s*\n\s*ok: true, changed: true, seq: curSeq/.test(relay))
    check('再也没有"先给 seq、再 ...info()"的写法',
      !/seq: curSeq,\s*\n\s*frame: curFrame,\s*\n\s*\.\.\.info\(\)/.test(relay))

    // ② 复位日志要限流（否则一秒几十行）
    check('复位日志限流', /resetLogAt/.test(relay) && /now - \(state\.resetLogAt \?\? 0\) > 3000/.test(relay))
    check('有死循环断路器', /resetBurst > 20/.test(relay))

    // ③ 客户端：拿到 reset 就无条件跟随
    check('客户端 reset 时无条件把 seq 拉回',
      /if \(response\.optBoolean\("reset", false\)\) \{\s*\n\s*\/\/[\s\S]{0,300}?seq = serverSeq;/.test(client))
  })

  await it('4.82：转写可筛选 —— 按发言人 / 按语言', () => {
    const javaDir = join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'leion', 'lanrelay')
    const resDir = join(ROOT, 'android', 'app', 'src', 'main', 'res')
    const detail = readFileSync(join(javaDir, 'HistoryDetailActivity.java'), 'utf-8')
    const zh = readFileSync(join(resDir, 'values', 'strings.xml'), 'utf-8')

    // ① 两个维度都在，且选项从真实数据里现算（不是写死的）
    check('按发言人筛选', /R\.string\.filter_speaker/.test(detail))
    check('按语言筛选', /R\.string\.filter_lang/.test(detail))
    check('选项来自实际出现过的值', /private java\.util\.List<String> distinct\(String key\)/.test(detail)
      && /distinct\("username"\)/.test(detail) && /distinct\("srcLang"\)/.test(detail))

    // ② 两个维度同时生效
    check('筛选条件同时生效', /private boolean matchesFilter\(org\.json\.JSONObject line\)/.test(detail)
      && /filterSpeaker\.equals\(line\.optString\("username"/.test(detail)
      && /filterLang\.equals\(line\.optString\("srcLang"/.test(detail))

    // ③ 不重新请求服务端（只是重画）
    check('筛选不重新拉数据', /renderTranscript\(allLines, currentMineName\(\)\)/.test(detail))

    // ④ 筛空了要说清是"没命中"，不是"没有转写"
    check('筛空有专门文案', /R\.string\.transcript_filtered_empty/.test(detail))
    const zhFiltered = (zh.match(/<string name="transcript_filtered_empty">([^<]*)</) ?? [])[1] ?? ''
    check('文案区分了两种空', zhFiltered.includes('筛选') && !zhFiltered.includes('还没有'), zhFiltered)

    // ⑤ 按钮上要能看出当前筛选了什么 + 能清除
    check('按钮显示当前筛选', /R\.string\.filter_active/.test(detail)
      && /renderFilterButton\(\)/.test(detail))
    check('有清除筛选', /R\.string\.filter_clear/.test(detail))
    check('筛选按钮不再是"没做"的提示',
      !/transcript_filter_soon/.test(detail))

    // ⑥ 语言码要显示成人话（zh-CN → 中文）
    check('语言码翻成人话', /private String langLabel\(String code\)/.test(detail)
      && /R\.string\.lang_zh_short/.test(detail))
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
