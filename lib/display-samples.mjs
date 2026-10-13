/**
 * display-samples.mjs —— 眼镜"投屏样例"用的校准句
 * ============================================================================
 *
 * 用途：在**不开同传**的情况下校准眼镜上的排版（字号、留白、翻页）。
 * 用户点一个句子 → 直接走真实投屏路径推给眼镜 → 戴着看效果 → 调字号。
 *
 * 为什么单独一个文件、而不是直接写进 strings.xml：
 * **这两句的来源是真实数据，来源必须跟着句子一起记下来。**
 * 如果只把文字抄进资源文件，"它是不是真的"这件事就丢了 ——
 * 而"这是真实译文还是我编的"恰恰是这类样例最要紧的信息。
 * （和 `docs/11-验证句集.md` 由 `scripts/test-phrases.mjs` 生成是同一个理由：
 * 句子只有一个来源，其余都是生成的。）
 *
 * ⚠️ 两个列表**互相独立，不是互译**：
 *   中文样例来自 `scripts/test-phrases.mjs` 的 PHRASES（项目自己的测试句集）；
 *   葡语样例来自 `var/logs/relay.log` 里真实的「定稿」帧（本流水线真实产出）。
 *   它们**不是同一句话的两种语言**，别把它们当对照翻译看 ——
 *   这里要校的是"字多大、一行几个字、要不要翻页"，与语义无关。
 *   之所以不硬凑成对照：日志里没记源句，硬配对就是编数据。
 *
 * 每档都取**短 / 中 / 长**三档，因为校准要看的是"翻页从多长开始"，
 * 而那正是长短差异才暴露出来的东西。长的两条**故意选会翻页的**。
 */

/** 中文样例：`from` 指向 PHRASES 里的条目编号（1 起），便于回到源头核对。 */
export const SAMPLE_ZH = [
  { label: '短',
    text: '请在设置里把语言切换成简体中文，然后重新开始录音。',
    from: 'scripts/test-phrases.mjs PHRASES #14（F 听错风险）' },
  { label: '中 · 中英混说',
    text: '我们和亮亮视野合作开发的这款 Leion Pro，用的是高通的芯片，系统版本是安卓十二。',
    from: 'scripts/test-phrases.mjs PHRASES #6（C 专有名词不翻译）' },
  { label: '长 · 会翻页',
    text: '我们的目标是在明年第一季度之前把这套同传系统的延迟压到两秒以内，同时把中文识别的字错率控制在百分之五以下，并且让佩戴者连续使用两小时之后仍然觉得字幕跟得上对话的节奏，因为如果一句话要等三四秒才出现，那用户就会干脆不用了。',
    from: 'scripts/test-phrases.mjs PHRASES #17（H 极长句）' },
]

/** 葡语样例：真实「定稿」帧原样抄录，`from` 记日志时间戳。 */
export const SAMPLE_PT = [
  { label: '短',
    text: 'A versão do sistema é Android 12.',
    from: 'var/logs/relay.log 真实定稿帧（第 17 帧）' },
  { label: '中',
    text: 'O ponto central desta nossa palestra é colocar o conteúdo traduzido direto no campo de visão de quem usa.',
    from: 'var/logs/relay.log 真实定稿帧' },
  { label: '长 · 会翻页',
    text: 'O núcleo deste nosso óculos é colocar a tradução direto no campo de visão de quem usa, assim a pessoa não precisa baixar a cabeça pra olhar o celular.',
    from: 'var/logs/relay.log 真实定稿帧（第 9 帧）' },
]

/** 两份样例合起来，给生成器与自检用。 */
export const DISPLAY_SAMPLES = { zh: SAMPLE_ZH, pt: SAMPLE_PT }
