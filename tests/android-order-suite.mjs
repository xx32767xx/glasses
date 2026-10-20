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

import { readFileSync } from 'node:fs'
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
}
