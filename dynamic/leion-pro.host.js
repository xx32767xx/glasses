/**
 * leion-pro —— 亮亮视野 (LLVision) Leion Pro / GLXSS ME AR 眼镜 · Cordis 动态插件 Host 半
 * ⚠️ 本文件由 scripts/generate.mjs 从 plugin/core.mjs 与 policy/br-pt.json 生成，
 *    **请勿手改**。改逻辑 → plugin/core.mjs；改巴葡口径 → policy/br-pt.json；
 *    然后 node scripts/generate.mjs
 * ============================================================================
 *
 * 这是什么
 *   把「一台亮亮眼镜」做成 harness 认识的一个设备：注册一组模型工具，让 agent 可以把
 *   字幕推到眼镜上；并内置中↔巴西葡语双向翻译管线，让这套东西成为一个同传 app。
 *
 * 怎么用
 *   在 Web GUI 新建一个「创造模式」会话，把本文件的全部内容作为 `code.host` 传给
 *   cordis_define，再 cordis_run。详见 docs/02-创造模式加载指南.md。
 *
 * 沙箱约束（动态插件，不是普通源码插件）
 *   - 代码是 async 函数体，必须 `return` 一个插件对象；
 *   - 纯 JavaScript，不能写 TypeScript 类型标注；
 *   - 没有 require / fetch / setTimeout / process / Buffer；
 *   - 可用全局只有：ctx（受限）、harness、console、btoa/atob/TextEncoder/TextDecoder；
 *   - 外部能力一律走 Cordis 服务：ctx.get('llm') / ctx.get('fs') ...
 *
 * 下面是 policy/br-pt.json 的内联内容（巴葡策略唯一来源）
 * ============================================================================
 */

const POLICY = {
  "variety": {
    "code": "pt-BR",
    "name": "巴西葡萄牙语",
    "fullName": "巴西葡萄牙语（português do Brasil）",
    "counterpart": {
      "code": "zh-CN",
      "name": "简体中文"
    },
    "why": "用户要的是巴西葡语，不是葡萄牙本土葡语。这是硬约束，不是风格偏好。"
  },
  "translationRules": [
    "只输出译文本身。不要解释、不要加引号、不要标注语种、不要重复原文。",
    "数字、时间、金额、人名、公司名、产品名必须原样保留 —— 译错数字比译错语法严重得多。",
    "这是同传，保持与原文相同的语序节奏，不要合并、不要扩写。",
    "AR 屏幕只有 3 行，译文要简洁：可以省掉客套话和重复，但不许做摘要式改写（那会丢信息）。",
    "原文若有口误或语气词，按最合理的意图翻译。"
  ],
  "proofreadRules": [
    "你是中巴同传的**校对员**。用户会给你：这一句的原文（语音识别结果，可能有听错）、已经上屏的译文、以及上一句的原文与译文（可能没有）。",
    "只修**错误**，分三类：① 语音听错导致译文跑偏（用上下文推断说话人真正想说的意思）；② 巴葡用词或语序不地道（尤其别用葡葡的说法）；③ 数字、时间译错或漏译。",
    "**专有名词不由你负责**：人名、公司名、产品名的写法由后处理按用户对照表保证。不要改动、替换、音译或意译这些名词（写成别的写法也不行）；只有它在译文里彻底消失、而你确信原文点名了，才补回 —— 补也只用原文里的写法。",
    "**不要做无谓的改动**：译文已经正确、自然，就原样输出。不要润色、不要换同义词、不要调整语序偏好。",
    "只输出校对后的译文本身。不要解释、不要加引号、不要写「已修改」、不要输出原文。",
    "**不许比原译文更长**：屏幕只有 3 行，变长会把开头挤掉。可以更简洁，不可以扩写。",
    "拿不准就不改 —— 同传里把对的改错，比不改严重得多。"
  ],
  "ptBrRules": [
    "使用巴西葡语的自然口语表达；不要使用葡萄牙本土（欧洲葡语）的用词和语序。"
  ],
  "terminology": [
    {
      "zh": "公交车",
      "br": "ônibus",
      "ptpt": "autocarro"
    },
    {
      "zh": "地铁",
      "br": "metrô",
      "ptpt": "metro"
    },
    {
      "zh": "火车",
      "br": "trem",
      "ptpt": "comboio"
    },
    {
      "zh": "车票",
      "br": "passagem",
      "ptpt": "bilhete"
    },
    {
      "zh": "高速公路",
      "br": "rodovia",
      "ptpt": "autoestrada"
    },
    {
      "zh": "摩托车",
      "br": "moto",
      "ptpt": "mota"
    },
    {
      "zh": "手机",
      "br": "celular",
      "ptpt": "telemóvel"
    },
    {
      "zh": "冰箱",
      "br": "geladeira",
      "ptpt": "frigorífico"
    },
    {
      "zh": "果汁",
      "br": "suco",
      "ptpt": "sumo"
    },
    {
      "zh": "冰淇淋",
      "br": "sorvete",
      "ptpt": "gelado"
    },
    {
      "zh": "早餐",
      "br": "café da manhã",
      "ptpt": "pequeno-almoço"
    },
    {
      "zh": "团队",
      "br": "time",
      "ptpt": "equipa"
    },
    {
      "zh": "计划（动词）",
      "br": "planejar",
      "ptpt": "planear"
    },
    {
      "zh": "你",
      "br": "você",
      "ptpt": "tu"
    }
  ],
  "speakingFeatures": [
    "日常会话用 **você**，不用 tu（除非南部/特定地区）。",
    "复数第一人称常用 **a gente** 代替 nós：「我们去」→ *a gente vai*。",
    "进行时用 **estar + gerúndio**：「正在开会」→ *está tendo reunião*（葡葡用 a + infinitivo：*está a ter*）。",
    "属格用 **de**：「你的书」→ *o seu livro*，不用 *o livro de ti*。",
    "语序偏 SVO，口语常省略主语代词。"
  ],
  "subtitleDiscipline": [
    "**一条话一帧**：不要把一个长句拆成多次推送，也不要合并两句话。",
    "**宁可简洁**：译文超过约 90 个字符时，优先保留核心信息 + 数字，删掉客套话。",
    "**数字必须原样保留**：时间、金额、房间号、电话号码。译错数字比译错语法严重得多。",
    "**专有名词不翻译**：人名、公司名、产品名、地址路名保持原文（可加注音）。",
    "不要为了塞进 3 行而做二次摘要——**摘要会丢数字**，这是同传事故。"
  ],
  "properNouns": [
    {
      "zh": "亮亮视野",
      "approved": [
        "LLVision",
        "亮亮视野"
      ],
      "soundsLike": [
        "Liangliang",
        "Liang Liang"
      ],
      "sourceForms": [
        "亮亮视野",
        "LLVision",
        "Liangliang",
        "Liang Liang"
      ],
      "warnWhenApproved": true,
      "mustKeep": true,
      "why": "公司英文名是 LLVision。实测 Hunyuan-MT 与 Qwen2.5 都音译成 Liangliang Vision / Liang Liang Vision —— 对方看到这个写法认不出是哪家公司。warnWhenApproved：这个名气大到模型能自己想起来，所以它写对时也要提示一句（那是先验知识，不是从原文推的）。mustKeep：对方必须能认出是哪家公司，所以**整段丢掉**也要报。"
    },
    {
      "zh": "亮亮眼镜",
      "approved": [
        "Leion",
        "亮亮眼镜"
      ],
      "soundsLike": [],
      "sourceForms": [
        "亮亮眼镜",
        "Leion",
        "Leion Pro"
      ],
      "mustKeep": true,
      "why": "产品线名 Leion。sourceForms 里放「Leion Pro」是**真机实测逼出来的**：那句「…合作开发的这款 Leion Pro…」译成了 `Esses óculos que desenvolvemos…`，产品名整个消失，而旧判据一声不响 —— 因为第一关是「原文含 entry.zh」，而 entry.zh 是「亮亮眼镜」，原文写的是 Leion Pro，**这条 entry 压根没进入检查**。mustKeep：说话人专门点了型号，听的人却不知道是哪个产品。⚠️ soundsLike **故意留空**：原来这里跟着写了「Liangliang」，但那是**公司名**（亮亮视野）的音译，不是产品名的 —— 同一个错拼会被两条 entry 各判一次「新造」，一句话报两条同样的错。产品名要防的是**丢掉**，那条路走 mustKeep。"
    },
    {
      "zh": "高通",
      "approved": [
        "Qualcomm",
        "高通"
      ],
      "soundsLike": [
        "Gaotong",
        "Qualcom"
      ],
      "sourceForms": [
        "高通",
        "Qualcomm"
      ],
      "mustKeep": true,
      "why": "芯片厂商。实测各家都译对了（Qualcomm）—— 这是**正常翻译**，所以不设 warnWhenApproved：每次都报会变成噪音，而噪音会让人开始忽略警告。soundsLike 里的 Qualcom 是**少一个 m 的常见写法**（此时认可写法不成立，所以能命中）；Gaotong 是音译，留着防将来。"
    },
    {
      "zh": "安卓",
      "approved": [
        "Android",
        "安卓"
      ],
      "sourceForms": [
        "安卓",
        "Android"
      ],
      "mustKeep": true,
      "why": "操作系统名。实测各家都译对（Android 12）。留着防的是**整个丢掉**（只留版本号「12」的话，听的人不知道是什么系统的 12）。⚠️ soundsLike **故意留空**：曾想加「Androide」，但那是葡语里对 Android 的**正常写法**（不是错），加了就会假报 —— 这正是「宁可不报」要挡住的那类误报。"
    },
    {
      "zh": "GLXSS ME",
      "approved": [
        "GLXSS ME",
        "GLXSS"
      ],
      "sourceForms": [
        "GLXSS ME",
        "GLXSS"
      ],
      "mustKeep": true,
      "why": "并列型号（README：「目标型号：Leion Pro（并列 GLXSS ME）」）。⚠️ 它的 sourceForms **只认拉丁写法**，故意不含「亮亮眼镜」—— 否则一句话里提到产品线就会同时命中 Leion 和 GLXSS 两条 entry，而译文只能写一个，另一条必然假报「丢失」。soundsLike 留空：没有实测证据说模型会把它写成什么样，编几个变体就是在赌假报。"
    }
  ],
  "nounGenders": {
    "sala": "f",
    "reunião": "f",
    "reunioes": "f",
    "andar": "m",
    "quarto": "m",
    "auditório": "m",
    "auditorio": "m",
    "escritório": "m",
    "escritorio": "m",
    "casa": "f",
    "cidade": "f",
    "rua": "f",
    "avenida": "f",
    "porta": "f",
    "janela": "f",
    "mesa": "f",
    "cadeira": "f",
    "hora": "f",
    "tarde": "f",
    "manhã": "f",
    "manha": "f",
    "noite": "f",
    "semana": "f",
    "empresa": "f",
    "equipe": "f",
    "time": "m",
    "recepção": "f",
    "recepcao": "f",
    "fábrica": "f",
    "fabrica": "f",
    "feira": "f",
    "passagem": "f",
    "estação": "f",
    "estacao": "f",
    "parada": "f",
    "loja": "f",
    "conta": "f",
    "receita": "f",
    "taxa": "f",
    "meta": "f",
    "pessoa": "f",
    "gente": "f",
    "parte": "f",
    "legenda": "f",
    "legendas": "f",
    "tradução": "f",
    "traducao": "f",
    "versão": "f",
    "versao": "f",
    "função": "f",
    "funcao": "f",
    "linguagem": "f",
    "língua": "f",
    "lingua": "f",
    "gravação": "f",
    "gravacao": "f",
    "cadeia": "f",
    "exibição": "f",
    "exibicao": "f",
    "captação": "f",
    "captacao": "f",
    "latência": "f",
    "latencia": "f",
    "precisão": "f",
    "precisao": "f",
    "demonstração": "f",
    "demonstracao": "f",
    "colaboração": "f",
    "colaboracao": "f",
    "problema": "m",
    "sistema": "m",
    "plano": "m",
    "projeto": "m",
    "produto": "m",
    "preço": "m",
    "preco": "m",
    "desconto": "m",
    "contrato": "m",
    "orçamento": "m",
    "orcamento": "m",
    "mercado": "m",
    "crescimento": "m",
    "resultado": "m",
    "trabalho": "m",
    "tempo": "m",
    "lugar": "m",
    "local": "m",
    "hotel": "m",
    "aplicativo": "m",
    "celular": "m",
    "carregador": "m",
    "microfone": "m",
    "dispositivo": "m",
    "usuário": "m",
    "usuario": "m",
    "chip": "m",
    "plugin": "m",
    "idioma": "m",
    "parâmetro": "m",
    "parametro": "m",
    "texto": "m",
    "trem": "m",
    "ônibus": "m",
    "onibus": "m",
    "metrô": "m",
    "metro": "m",
    "suco": "m",
    "sorvete": "m",
    "café": "m",
    "cafe": "m",
    "almoço": "m",
    "almoco": "m",
    "ano": "m",
    "dia": "m",
    "trimestre": "m",
    "semestre": "m",
    "lado": "m",
    "jeito": "m",
    "coração": "m",
    "coracao": "m",
    "teste": "m",
    "erro": "m",
    "áudio": "m",
    "audio": "m",
    "vídeo": "m",
    "video": "m",
    "grupo": "m",
    "objetivo": "m",
    "atraso": "m",
    "ritmo": "m"
  },
  "lintNote": "properNouns / nounGenders 是**译文质检**的判据数据，见 lib/translation-lint.mjs 与 docs/08。质检**已经接进产线**（转发进程对每个定稿帧跑，只报不改），但**这两张表仍然不进提示词** —— nounGenders 要靠原文比对才判得出来，而产线那一层只看当前这一句。⚠️ 但 properNouns.approved 是另一回事：它和上面的术语表性质相同（都是「这个词必须这么写」），所以**「要不要把认可的英文名写进提示词」是一个还没做的决定** —— 目前模型不知道「亮亮视野 → LLVision」，只能靠先验知识猜或音译，这正是「专名新造」那类错的来源。没做的原因：改提示词等于改模型行为，会让 docs/08 那批横评数字失去可比性，得先量一版再上。"
}

// ============================================================================
// 下面是 plugin/core.mjs 的内联内容（业务逻辑唯一来源）
// ============================================================================

/**
 * leion-pro · 核心逻辑 —— 全项目唯一来源
 * ============================================================================
 *
 * 亮亮视野 (LLVision) Leion Pro / GLXSS ME AR 眼镜设备插件 + 中↔巴西葡语双向同传。
 *
 * 这个文件被两个包装目标共用，二者都不含业务逻辑：
 *   · ../plugin/index.mjs      正式插件（持久）：走 ctx.tools.register()，schema 用
 *                              schemas.generated.mjs 里由本文件 DSL 编译出的原始形式；
 *   · ../dynamic/leion-pro.host.js   动态插件（创造模式）：由 scripts/gen-dynamic.mjs
 *                              把本文件内联进去再包一层沙箱适配器生成。
 * 所以：**改逻辑只改这里**，然后 `node scripts/gen-dynamic.mjs`。
 *
 * 本文件必须保持零 import —— 动态插件沙箱里没有 require/import。
 *
 * 设计要点（改之前先读）
 *   1) transport seam：眼镜怎么收字幕是唯一会随真机变化的东西，被隔离成 createTransport()。
 *      真机接入时只换这一处，其余全部不动。
 *   2) 佩戴者视角：Leion Pro / GLXSS ME 戴在自己脸上，屏幕只给佩戴者看。所以同传主通道是
 *      「对方的语言 → 佩戴者的中文」；佩戴者自己说的话译成巴葡后属于「出站通道」
 *      （给对方的扬声器/第二块屏），眼镜上只做一行回显确认。
 *   3) AR 显示预算：显示区很小，必须先按显示宽度折行、再截到 N 行，否则长译文就是溢出。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 可调参数（正式插件经 cordis.yml 的 config 覆盖；动态插件改这里的字面量后重新 define）
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG_DEFAULTS = {
  /** 'mock' = 只打日志/内存（无真机时用）；'file' = 把当前字幕帧写成 JSON 给外部桥读 */
  transport: 'mock',
  /** transport === 'file' 时，字幕总线的绝对路径 */
  sinkPath: '',
  /** AR 显示预算：每行显示宽度（半角字符数，汉字算 2）与可见行数 */
  cols: 40,
  lines: 3,
  /** 流式翻译时部分字幕的最短刷新间隔（毫秒），防止逐字刷屏 */
  partialThrottleMs: 400,
  /** 翻译用的模型路由。留空 = 用第一个已注册 provider，并尝试自动发现模型 */
  providerId: '',
  modelId: '',
  maxTokens: 400,
  temperature: 0.2,
  /**
   * 翻译调用的推理强度。
   *
   * 缺省 'off' 是刻意的：翻译是「输入一句、输出一句」的确定性任务，不需要思考。
   * 而 DeepSeek 适配器缺省的推理强度是 high —— 实测下来思考 token 会把 maxTokens
   * 吃光，流以非 stop 结束，译文被丢弃（眼镜上什么都不剩，或者只剩碎片）。
   * 'off' 同时省延迟和费用。留空字符串表示完全不传这个字段（给不接受它的路由用；
   * 若路由拒绝该字段，插件会自动去掉它重试一次）。
   */
  reasoningEffort: 'off',

  /**
   * 翻译后端 —— 这一步是接缝，不是硬编码。
   *
   *   'harness-llm'  用 harness 的模型服务（ctx.llm）。现状，也是本项目的默认。
   *   'http'         POST 到任意翻译端点。**把模型搬到端侧（手机/眼镜）时用这一条**：
   *                  端侧只要暴露一个 HTTP 服务，插件配置一行就能接上，不用改代码。
   *   'none'         插件不做翻译：收件箱里的文字**就是最终字幕**，只做排版与推送。
   *                  翻译在别处完成后推进来，插件退化成纯显示通道。
   *
   * 有了这个开关，"翻译放在哪一层"变成配置，而不是重写。
   */
  translator: 'harness-llm',
  /** translator: 'http' 时的端点 URL（POST，收 {text,from,to}，回 {text} 或 {translation}）。 */
  translatorUrl: '',
  /** translator: 'http' 的超时（毫秒）。 */
  translatorTimeoutMs: 15000,

  /**
   * ASR 收件箱：外部语音识别程序把文本按行追加到这个文件，插件轮询它并自动出字幕。
   * 留空 = 关闭自动同传（此时仍可手动调 leion_translate，或用 leion_inbox 的 drain）。
   * 打开这一项，中↔巴葡同传就从「agent 调工具」变成「外部 ASR 一写就上屏」。
   */
  inboxPath: '',
  /** 轮询间隔（毫秒）。太小会空转，太大会加延迟；150–800 是合理区间。 */
  inboxPollMs: 700,
  /** 强制指定收件行的源语种（ASR 已知语种时有用）；留空 = 逐行自动判定。 */
  inboxFrom: '',
  /**
   * 手机侧运行时设置的落点（`{ "proofread": true/false }`），由 relay 的 `PUT /settings` 写。
   * 留空 = 不读（完全按 config 走）。读不到就忽略 —— 一个坏文件不该影响出字幕。
   */
  settingsPath: '',
  /**
   * 热词归一（docs/15 §7.1）的总开关。
   *
   * <p>`'on'`：译文里出现**已知变体**时换成规范写法；`'off'`：完全不动，
   * 行为与加这个功能之前**逐字一致**（docs/15 §11 要求的"可回滚闸"）。
   * 默认开：没有表时它什么也不做，所以"开着"与"没有这个功能"等价。
   */
  terms: 'on',
  /** 热词表文件（`{ tables: { user: { entries } } }`），由 relay 写入。留空 = 不读。 */
  termsPath: '',
  /** "当前会话用哪个用户"的文件（`{ user: 'wu' }`），由 relay 写入。 */
  termsActivePath: '',
  /** 替换事件的落盘位置（一行一条 JSON）。留空 = 只打控制台。 */
  termsLogPath: '',
  /**
   * "待入表"队列（B 方案，docs/15 §18）：临时修正成功时追一条记录到这里，
   * 由 relay 在**启动 / 每场开始时**合并进 `terms.json`（插件仍然**只读**正式表）。
   * 留空 = 不写队列（实验可关）。
   */
  termsPendingPath: '',
  /**
   * 热词观测（A 方案）：一句话里**提到了**表内名字、但译文里**没写出规范写法**时，
   * 自动记一笔（`watch` 事件 + 手机端小提示），**本场不改字幕**。
   *
   * <p>为什么要它：热词表只能"把已知变体改对"；如果模型写了一个**没登记过**的新变体，
   * 本场救不了（也不知道它写成了什么）。但我们可以**知道"这句话出问题了"**，
   * 而且记下来的原文+译文正好是离线候选发现的输入 —— 下一场表就补上了。
   *
   * <p>`'off'` 时行为与加这个功能之前逐字一致（可回滚）。
   */
  termsWatch: 'on',
  /**
   * 本句专名提示（docs/15 §18.9）：翻译时把"这句原文里出现的表内名字 + 规范写法"
   * 追加进系统提示词，让模型**初译就写对**，而不是等事后修正。
   *
   * <p>实测（44 句 A/B 对照，见 §18.9）：规范写法出现率 53/56 → **56/56**，
   * prompt 只多约 27 token，没有一句被写坏、没有数字丢失。
   * 对空表 / 原文没提名字的句子**不追加任何东西**（行为与以前逐字一致）。
   */
  termsHint: 'on',
  /**
   * 热词临时修正（方向一实验，**默认关**）：观测到"提到了名字、译文没写出规范写法"时，
   * 空闲时问一次模型"这个名字在这句里写成了什么"，只在**片段可验证**时把那一小段换成规范写法。
   *
   * <p>三条硬约束（用户定的，写在配置旁边免得以后忘了）：
   *   · **不把"校对/下一帧把它改回来"当撤销依据** —— 两个机制不一致只能说明冲突，
   *     不能证明谁正确；所以本功能不监听、不撤销，先落地的那个生效，后到的按"过期"丢弃；
   *   · **绑定字幕帧与版本号**：结果回来时必须还是**同一帧**（displaySeq 未变 + 帧对象未换），
   *     否则丢弃 —— 避免修错对象（"最后一句"本身一直在变）；
   *   · 用户已经读到的错误不可能被"修对"完全消除影响，只能少一条。
   *
   * <p>只替换**可验证的片段**：答案必须原样出现在译文里、长度/字数有上限、
   * 与规范写法共享足够多字符（看起来是同一个名字被写错，而不是被泛化成"这家公司"），
   * 且不夹带别的表内名字。任何一关不过 → 拒绝（宁可不改，也不改坏）。
   */
  termsRescue: 'off',
  /** 每场最多问几次（防"表配错 → 每句都问"）。 */
  termsRescueLimit: 20,
  /** 结果超过这个年龄就丢：屏幕早换页了。 */
  termsRescueMaxAgeMs: 8000,

  /**
   * 大模型校对（讯飞那种"两遍"）：第一遍**快速出译文并立刻上屏**，
   * 第二遍让模型回头检查这一句（听错 / 译错 / 巴葡口径），改了就**覆盖同一帧**。
   *
   *   'off'   关闭（缺省）。行为与加这个功能之前完全一样。
   *   'idle'  只在**没有别的事可做时**做校对（收件箱队列空了、没有翻译在跑）。
   *          选 'idle' 而不是"翻译完立刻校对"是刻意的：
   *          收件箱是**串行**处理的，如果校对占着这一句不放，下一句的初译就要等它，
   *          等于给每一句都额外加一次模型往返（实测初译 0.44~0.96 秒，再加一次就是翻倍）。
   *          放到空闲时做，观众看到初译的时间**一点不变**。
   *
   * 代价与代价的边界（都是刻意的）：
   *   · 校对结果**只在"屏幕上还是这一句"时才覆盖**。如果这期间已经出了下一句
   *     （哪怕是下一句的流式增量），校对结果直接丢弃 —— 否则屏幕会**倒退**回上一句。
   *   · 超过 proofreadMaxAgeMs 还没轮到的，也不再改了：观众早就读过、翻页了。
   *   · 一次只跑一个校对（proofreading 标志），不和翻译抢模型。
   *
   * ⚠️ **缺省值从 'off' 改成了 'idle'（默认开启）**，按用户要求：
   *   同传里最常见的硬错不是"译得不好"而是"听错了"，而校对是唯一能救回来的手段
   *   （docs/07 §5.3 有实测：初译把 Qualcomm 泛化成 "alta capacidade"，校对补回来）。
   *   代价要说清：**每句可能多一次模型调用**。所以：
   *     · 它是"空闲才跑"，不占关键路径；
   *     · 手机上有一个开关（设置 → 校对），关掉后这台设备就不再排校对；
   *     · 手机开关通过 `var/live/settings.json` 生效（见 refreshRuntimeSettings）——
   *       一份数据两处可改时，**以手机为准**（用户当场能摸到的那个更可信）。
   */
  proofread: 'idle',
  /** 校对结果超过这个年龄（毫秒）就丢弃 —— 屏幕早换页了，改了也没人看。 */
  proofreadMaxAgeMs: 8000,
  /** 待校对队列的上限。积压说明机器跟不上，多排也只会更晚、更没意义。 */
  proofreadMaxQueue: 2,
  /**
   * 这场会的**目标语言**（5.00）。
   *
   * <p>只有中/葡两种时"译成另一种"是唯一的，所以以前不需要这个配置。
   * 加了英语之后三种语言并存，"对面"不唯一 —— 目标必须由会议决定：
   *   房间（`rooms.target_lang`）→ 每场会的大脑 `--to <lang>` → 这里。
   * 空串 = 老行为（`opposite(源语言)`：中↔葡互译，英语兜底译成中文）。
   */
  targetLang: '',
  /**
   * 这场会的**听众语言侧车**（5.00）：relay 写的 `room-langs/<房间>.json`。
   *
   * <p>为什么用文件而不是配置：成员进出、改语言都可能发生在两句之间，而配置是启动时固定的
   * （改配置要重启大脑，就赶不上"有人刚进来"这件事）。同一套做法见 `audio/<房间>.lang`（4.37）
   * 与 `settings.json`（手机侧的校对开关）。
   *
   * <p>空串 = 不读文件，按老行为（`opposite(源语言)`）—— 老部署不受影响。
   */
  hearLangsPath: '',
}

const DEVICE = {
  vendor: 'LLVision 亮亮视野',
  model: 'Leion Pro',
  aliases: ['GLXSS ME'],
  panel: '单目 AR 显示，供佩戴者阅读',
}

/**
 * 这一句要译成哪几种语言（5.00）。
 *
 * <p><b>为什么是"几种"</b>：三语会议里同一句要给不同语言的人看 —— 但只译**实际有人在读**的
 * 语言（`listenerLangs` 来自 relay 写的侧车，等于 `room_members.lang` 去重）。所以：
 * 两个听众同语言 → 只译一份；不同语言 → 译两份（最多两份，因为只有三种语言、源语言占一种）。
 *
 * <p><b>排除源语言</b>：不排除就会"译成同语言"，产出一份看着正常、其实毫无意义的假字幕。
 *
 * <p>优先级（与 {@link resolveTarget} 一致，只是从"一个"变成"一组"）：
 * 会议显式指定（`config.targetLang`，手机建房时选的覆盖值）→ 监听语言集合 → 兜底 opposite(源)。
 *
 * @param {string} from 源语言
 * @param {string} override 显式目标（空串 = 不覆盖）
 * @param {string[]} listenerLangs 听众登记的语言（可能为空）
 * @returns {{targets: string[], source: 'override'|'listeners'|'paired'|'none'}}
 */
function resolveTargets(from, override, listenerLangs) {
  const clean = (list) => {
    const seen = new Set()
    for (const item of Array.isArray(list) ? list : []) {
      const lang = String(item === undefined || item === null ? '' : item).trim()
      if (lang === '' || lang === from) continue        // 源语言永远不作为目标
      if (seen.has(lang)) continue                      // 去重：同语言只译一份
      seen.add(lang)
    }
    return [...seen]
  }
  if (typeof override === 'string' && override !== '') {
    const only = clean([override])
    return { targets: only, source: only.length === 0 ? 'none' : 'override' }
  }
  const heard = clean(listenerLangs)
  if (heard.length > 0) return { targets: heard, source: 'listeners' }
  // ⚠️ 关键：**登记了语言、但清完是空**（所有人读的都是源语言）→ 这一句不需要任何译文。
  //    如果这时回落到 opposite，就会给"没人需要的语言"白译一份 —— 既费钱又可能把
  //    一份多余的字幕推给不该看到它的人。
  const anyRegistered = (Array.isArray(listenerLangs) ? listenerLangs : [])
    .some(item => String(item === undefined || item === null ? '' : item).trim() !== '')
  if (anyRegistered) return { targets: [], source: 'listeners' }
  const guess = opposite(from)
  return { targets: guess === 'unknown' ? [] : [guess], source: guess === 'unknown' ? 'none' : 'paired' }
}

const ZH = 'zh-CN'
const PT = 'pt-BR'
/**
 * 5.00：英语（美式）。
 *
 * <p>中 / 英 / 葡三种里它是"第三种"：**既可以是源、也可以是目标**。
 * 加它之后"哪两种互译"不再唯一 —— 所以目标语言必须由**会议**给定
 * （`rooms.target_lang` → 大脑 `--to` → `config.targetLang`），见 {@link resolveTarget}。
 */
const EN = 'en-US'

/**
 * 这个路径看起来是不是绝对路径？
 *
 * 刻意不引 `node:path` —— core.mjs 是**零 import** 的（动态插件在沙箱里跑，
 * 拿不到 node 内置模块）。所以这里用最朴素的判断，覆盖三种真实写法：
 *   C:\... / C:/... / \\server\share\... / /usr/...
 */
function looksAbsolutePath(value) {
  const text = String(value)
  return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')
}

/** 一个片段一句话（同传里一条字幕就是一句话）。 */
const HISTORY_CAP = 200

/**
 * 校验配置。harness 的约定是「配置错误要响亮」：不合法的值在加载时就抛，不要留到运行期。
 */
function validateConfig(raw) {
  const config = Object.assign({}, CONFIG_DEFAULTS, raw === undefined || raw === null ? {} : raw)
  if (config.transport !== 'mock' && config.transport !== 'file') {
    throw new Error(`leion-pro: transport 只能是 'mock' 或 'file'，收到 ${JSON.stringify(config.transport)}`)
  }
  if (config.transport === 'file' && (typeof config.sinkPath !== 'string' || config.sinkPath === '')) {
    throw new Error("leion-pro: transport 'file' 需要 sinkPath 指向一个字幕总线文件的绝对路径")
  }
  for (const key of ['cols', 'lines']) {
    const value = config[key]
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`leion-pro: ${key} 必须是正整数，收到 ${JSON.stringify(value)}`)
    }
  }
  if (!Number.isFinite(config.partialThrottleMs) || config.partialThrottleMs < 0) {
    throw new Error(`leion-pro: partialThrottleMs 必须是非负数，收到 ${JSON.stringify(config.partialThrottleMs)}`)
  }
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    throw new Error(`leion-pro: temperature 必须在 0..2，收到 ${JSON.stringify(config.temperature)}`)
  }
  if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
    throw new Error(`leion-pro: maxTokens 必须是正整数，收到 ${JSON.stringify(config.maxTokens)}`)
  }
  if (!['', 'off', 'low', 'high', 'max'].includes(config.reasoningEffort)) {
    throw new Error(`leion-pro: reasoningEffort 只能是 '' / 'off' / 'low' / 'high' / 'max'，收到 ${JSON.stringify(config.reasoningEffort)}`)
  }
  if (!['harness-llm', 'http', 'none'].includes(config.translator)) {
    throw new Error(`leion-pro: translator 只能是 'harness-llm' / 'http' / 'none'，收到 ${JSON.stringify(config.translator)}`)
  }
  if (config.translator === 'http' && (typeof config.translatorUrl !== 'string' || config.translatorUrl === '')) {
    throw new Error("leion-pro: translator 'http' 需要 translatorUrl 指向翻译端点")
  }
  if (!Number.isInteger(config.translatorTimeoutMs) || config.translatorTimeoutMs <= 0) {
    throw new Error(`leion-pro: translatorTimeoutMs 必须是正整数，收到 ${JSON.stringify(config.translatorTimeoutMs)}`)
  }
  if (typeof config.inboxPath !== 'string') {
    throw new Error(`leion-pro: inboxPath 必须是字符串，收到 ${JSON.stringify(config.inboxPath)}`)
  }
  if (typeof config.settingsPath !== 'string') {
    throw new Error(`leion-pro: settingsPath 必须是字符串，收到 ${JSON.stringify(config.settingsPath)}`)
  }
  if (!['on', 'off'].includes(config.terms)) {
    throw new Error(`leion-pro: terms 只能是 'on' / 'off'，收到 ${JSON.stringify(config.terms)}`)
  }
  for (const key of ['termsPath', 'termsActivePath', 'termsLogPath', 'termsPendingPath']) {
    if (typeof config[key] !== 'string') {
      throw new Error(`leion-pro: ${key} 必须是字符串，收到 ${JSON.stringify(config[key])}`)
    }
  }
  if (!['on', 'off'].includes(config.termsWatch)) {
    throw new Error(`leion-pro: termsWatch 只能是 'on' / 'off'，收到 ${JSON.stringify(config.termsWatch)}`)
  }
  if (!['on', 'off'].includes(config.termsHint)) {
    throw new Error(`leion-pro: termsHint 只能是 'on' / 'off'，收到 ${JSON.stringify(config.termsHint)}`)
  }
  if (!['on', 'off'].includes(config.termsRescue)) {
    throw new Error(`leion-pro: termsRescue 只能是 'on' / 'off'，收到 ${JSON.stringify(config.termsRescue)}`)
  }
  if (!Number.isInteger(config.termsRescueLimit) || config.termsRescueLimit <= 0) {
    throw new Error(`leion-pro: termsRescueLimit 必须是正整数，收到 ${JSON.stringify(config.termsRescueLimit)}`)
  }
  if (!Number.isInteger(config.termsRescueMaxAgeMs) || config.termsRescueMaxAgeMs <= 0) {
    throw new Error(`leion-pro: termsRescueMaxAgeMs 必须是正整数，收到 ${JSON.stringify(config.termsRescueMaxAgeMs)}`)
  }
  if (config.inboxPath !== '') {
    if (!Number.isInteger(config.inboxPollMs) || config.inboxPollMs < 100) {
      throw new Error(`leion-pro: 配置了 inboxPath 时 inboxPollMs 必须是不小于 100 的整数，收到 ${JSON.stringify(config.inboxPollMs)}`)
    }
  }
  if (!['off', 'idle'].includes(config.proofread)) {
    throw new Error(`leion-pro: proofread 只能是 'off' / 'idle'，收到 ${JSON.stringify(config.proofread)}`)
  }
  if (!Number.isInteger(config.proofreadMaxAgeMs) || config.proofreadMaxAgeMs <= 0) {
    throw new Error(`leion-pro: proofreadMaxAgeMs 必须是正整数，收到 ${JSON.stringify(config.proofreadMaxAgeMs)}`)
  }
  if (!Number.isInteger(config.proofreadMaxQueue) || config.proofreadMaxQueue <= 0) {
    throw new Error(`leion-pro: proofreadMaxQueue 必须是正整数，收到 ${JSON.stringify(config.proofreadMaxQueue)}`)
  }
  if (config.inboxFrom !== '' && config.inboxFrom !== ZH && config.inboxFrom !== PT) {
    throw new Error(`leion-pro: inboxFrom 只能是 '' / '${ZH}' / '${PT}'，收到 ${JSON.stringify(config.inboxFrom)}`)
  }
  return config
}

// ─────────────────────────────────────────────────────────────────────────────
// 字幕排版
// ─────────────────────────────────────────────────────────────────────────────

/** 单字符占几列：CJK 全角算 2，其余算 1。 */
function charCols(ch) {
  const code = ch.codePointAt(0)
  const wide
    = (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  return wide ? 2 : 1
}

/** 按显示宽度折行。 */
function wrapText(text, cols) {
  const out = []
  let line = ''
  let width = 0
  for (const ch of String(text)) {
    if (ch === '\n') {
      out.push(line)
      line = ''
      width = 0
      continue
    }
    const w = charCols(ch)
    if (width + w > cols) {
      out.push(line)
      line = ''
      width = 0
    }
    line += ch
    width += w
  }
  out.push(line)
  return out
}

/**
 * 折行后截取「最后 N 行」。
 * 同传是边说边读，读者永远在追最新那句话，所以留尾部而不是头部。
 */
function fitSubtitle(text, cols, lines) {
  const wrapped = wrapText(String(text === undefined ? '' : text).trim(), cols)
  return wrapped.length <= lines ? wrapped : wrapped.slice(wrapped.length - lines)
}

/** 把一帧字幕画成等宽框，便于在终端/工具卡片里肉眼核对排版。 */
function drawFrame(frame, cols) {
  const top = '┌' + '─'.repeat(cols) + '┐'
  const body = frame.lines.map(l => {
    const pad = cols - [...l].reduce((n, ch) => n + charCols(ch), 0)
    return '│' + l + ' '.repeat(pad > 0 ? pad : 0) + '│'
  })
  const bottom = '└' + '─'.repeat(cols) + '┘'
  return [top, ...body, bottom].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 语种判定（双向同传的语向自动路由）
// ─────────────────────────────────────────────────────────────────────────────

const PT_MARKERS = [
  'não', 'nao', 'você', 'voce', 'obrigado', 'obrigada', 'está', 'esta', 'estão', 'estao',
  'com', 'para', 'isso', 'muito', 'bom', 'dia', 'olá', 'ola', 'tudo', 'bem', 'aqui',
  'sim', 'desculpe', 'falar', 'pode', 'vamos', 'estou', 'também', 'tambem', 'depois',
  'reunião', 'reuniao', 'quando', 'onde', 'porque', 'então', 'entao', 'como', 'café', 'cafe',
]
const PT_DIACRITICS = 'ãõçáéêíóúâàü'

/**
 * 英语的"形状"标记（5.00）。
 *
 * <p>为什么要它：中/英/葡三种里，**英文与巴葡共用拉丁字母**，光看字符集分不开。
 * 所以用"高频功能词"当证据，并且要求 **≥2 个**才算 —— 一个词（比如 `no`、`a`）
 * 在葡语和英语里都可能出现，拿单个词判语种是"猜"，而猜错语种会让整句译错方向。
 *
 * <p>真正的语种来源仍是**每句话自带**（识别进程会给 `from`、手机上报 `lang`）；
 * 这里只是"没给 from 时"的兜底，所以宁可判 `${unknown}` 也不硬凑。
 */
const EN_MARKERS = [
  'the', 'and', 'you', 'your', 'we', 'are', 'is', 'was', 'were', 'this', 'that', 'these',
  'those', 'with', 'for', 'from', 'have', 'has', 'will', 'would', 'can', 'could', 'should',
  'not', 'but', 'there', 'what', 'when', 'where', 'because', 'about', 'meeting', 'today',
  'tomorrow', 'thanks', 'thank', 'hello', 'sorry', 'please', 'okay', 'yes', 'know', 'think',
]

/** 判定一段文本是中文 / 巴葡 / 英语；判不出来返回 'unknown'，让调用方决定，绝不猜。 */
function detectLang(text) {
  const s = String(text === undefined ? '' : text)
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s)) return ZH
  const lower = s.toLowerCase()
  const padded = ' ' + lower.replace(/[.,!?;:()"']/g, ' ').replace(/\s+/g, ' ') + ' '
  let hits = 0
  for (const marker of PT_MARKERS) {
    if (padded.includes(' ' + marker + ' ')) hits += 1
  }
  const diacritic = [...lower].some(ch => PT_DIACRITICS.includes(ch))
  if (hits >= 1 || diacritic) return PT
  // 5.00：巴葡证据一条都没有，才轮到英语 —— 且要**两个**以上功能词才算数。
  let englishHits = 0
  for (const marker of EN_MARKERS) {
    if (padded.includes(' ' + marker + ' ')) englishHits += 1
  }
  if (englishHits >= 2) return EN
  return 'unknown'
}

/**
 * 「另一种语言」的**兜底**推导（5.00 起它只是兜底）。
 *
 * <p>⚠️ 三种语言并存时，"对面"不唯一 —— 所以真正的目标语言应当由**会议**给定
 * （`rooms.target_lang` → 每场会的大脑 `--to` → `config.targetLang`）。
 * 这个函数只在"没给目标"的老链路上起作用：中↔葡互译，英语默认译成中文。
 */
function opposite(lang) {
  if (lang === ZH) return PT
  if (lang === PT) return ZH
  if (lang === EN) return ZH
  return 'unknown'
}

/**
 * 这一句该译成哪种语言（5.00）。
 *
 * <p>优先级：**这一句显式给了 to** → **会议配置的目标语言** → 兜底 opposite(源语言)。
 * 三个来源都拿不到才报错（宁可不译，也不要猜错方向 —— 译错方向时译文看起来完全正常）。
 *
 * @returns {{target: string, source: 'explicit'|'meeting'|'paired'|'none'}}
 */
function resolveTarget(from, argsTo, configTarget) {
  if (typeof argsTo === 'string' && argsTo !== '') return { target: argsTo, source: 'explicit' }
  if (typeof configTarget === 'string' && configTarget !== '') return { target: configTarget, source: 'meeting' }
  const guess = opposite(from)
  return { target: guess === 'unknown' ? '' : guess, source: guess === 'unknown' ? 'none' : 'paired' }
}

/**
 * 翻译用的 system 提示词 —— **由 policy 数据生成**，不在这里手写。
 *
 * 为什么数据化：巴葡口径（"不是葡葡"）是本项目最大的质量资产，而它以前散在两个地方 ——
 * 插件这里是 5 句原则、skills/leion-interpreter/SKILL.md 里是一张术语表，两者会漂移。
 * 现在唯一来源是 policy/br-pt.json；提示词与技能文档都从它生成。
 * 附带好处：将来翻译搬到端侧时，同一份数据能拿去做"禁用词约束"或"后处理替换表"，
 * 而不是靠一段小模型根本执行不了的提示词。
 *
 * @param policy 由 plugin/policy.generated.mjs（生成物）提供
 */
function translationSystem(policy, from, to, termsHint) {
  if (policy === undefined || policy === null) {
    throw new Error('translationSystem 需要 policy（见 policy/br-pt.json 与 plugin/policy.generated.mjs）')
  }
  const target = targetName(policy, to)
  const lines = [
    '你是资深的中巴同声传译译员，服务于现场口译场景。',
    '把用户给你的话翻译成' + target + '。',
    '硬性要求：',
  ]
  // 「用巴葡表达」这类规则只在**产出巴葡**时才成立：译成中文/英语时它毫无意义，
  // 甚至可能把模型往错的方向推。所以策略数据把它们分成通用的与巴葡专用的两组。
  const rules = to === PT
    ? policy.translationRules.concat(policy.ptBrRules)
    : (to === EN ? policy.translationRules.concat(EN_OUTPUT_RULES) : policy.translationRules)
  rules.forEach((rule, index) => {
    lines.push((index + 1) + '. ' + rule)
  })
  // 术语表只有"译成中文/巴葡"时用得上（表里就是这两侧）；译成英语时这些词用不上。
  if ((to === PT || to === ZH) && policy.terminology.length > 0) {
    if (to === PT) {
      lines.push('用词必须按巴葡（括号里是葡葡，不要用）：' + policy.terminology
        .map(entry => entry.br + '（不用 ' + entry.ptpt + '）')
        .join('、'))
    } else {
      lines.push('专名用中文规范写法：' + policy.terminology
        .map(entry => entry.zh)
        .join('、'))
    }
  }
  // 本句专名提示（docs/15 §18.9）：只列**这句原文里真的出现了**的表内名字。
  // 实测（44 句 A/B）：规范写法出现率 53/56 → 56/56，prompt 只多约 27 token，
  // 没有一句被写坏、没有数字丢失。它把"模型写泛称/音译变体"这一类直接压掉，
  // 比事后修正省一次模型调用。
  // ⚠️ 5.00：译成英语时没有"英语规范写法"这一侧（术语表只有中文/巴葡两栏），
  //    所以不注入 —— 硬塞中文名会让模型在英语译文里留下中文。
  if (Array.isArray(termsHint) && termsHint.length > 0 && to !== EN) {
    const pairs = termsHint.map(entry => (to === PT ? entry.zh : entry.pt)
      + ' → ' + (to === PT ? entry.pt : entry.zh))
    lines.push('本句原文出现了这些名字，译文必须保留下列写法（原文没出现的名字不要添加）：' + pairs.join('；'))
  }
  return lines.join('\n')
}

/**
 * 产出英语时的补充规则（5.00）。
 *
 * <p>为什么单独一组：`policy.translationRules` 是**通用**的（保真、数字、节奏），
 * 巴葡的"不要用葡葡词"那类规则对英语毫无意义；而英语有它自己的坑 ——
 * 最典型的是"中式英语"（逐字直译语序）和"翻译腔"（`I think that it is...` 层层套）。
 * 这三条只约束**形式**，不改忠实度标准。
 */
const EN_OUTPUT_RULES = [
  'Use natural spoken English (US). Do not translate word-by-word from the source word order.',
  'Keep names, products and numbers exactly as they are; do not localize or translate proper nouns that are given in Latin script.',
  'Output English only — never leave Chinese characters or Portuguese words in the translation.',
]

/** 目标语言的显示名（提示词里用）。三种语言的唯一来源，避免两处各写一份。 */
function targetName(policy, to) {
  if (to === EN) return '英语（English, US）'
  if (to === PT) return policy.variety.fullName
  if (to === ZH) return policy.variety.counterpart.name
  return String(to)
}

/**
 * 校对那一道的系统提示词。
 *
 * 和 translationSystem 分开写，是因为**两件事的目标不一样**：
 *   翻译：把这段话说成巴葡（可能出错）；
 *   校对：只找出**错**，别的地方一个字都别动。
 * 混在一个提示词里会让模型忍不住去"润色"—— 那会把已经正确的译文改坏，
 * 而同传里"改错"比"不改"严重得多（观众已经把上一版读进去了）。
 *
 * 规则本身也放在 policy/br-pt.json 里（口径是数据，不是代码）——
 * 老师要调口气、加术语，改那个文件就行。
 *
 * @param policy 由 plugin/policy.generated.mjs（生成物）提供
 */
function proofreadSystem(policy, from, to, entries) {
  if (policy === undefined || policy === null) {
    throw new Error('proofreadSystem 需要 policy（见 policy/br-pt.json 与 plugin/policy.generated.mjs）')
  }
  const target = targetName(policy, to)
  const lines = [
    '你在做**译文校对**：译文的目标语言是' + target + '。',
    '硬性要求：',
  ]
  const rules = policy.proofreadRules === undefined ? [] : policy.proofreadRules
  rules.forEach((rule, index) => lines.push((index + 1) + '. ' + rule))
  // 术语表也必须给校对看：否则它会把初译里正确的专名改成"直译"。
  // 实测反例：初译 Liangliang Vision → 校对改成 Brilha a visão，原文里的公司名整段丢失。
  const termList = Array.isArray(entries) ? entries : []
  if (termList.length > 0) {
    lines.push("术语表（以下写法是已确认的规范译名，必须原样保留：不改写、不直译、不省略）：")
    for (const entry of termList) {
      const zh = entry && entry.zh ? String(entry.zh) : ""
      const pt = entry && entry.pt ? String(entry.pt) : ""
      if (zh === "" || pt === "") continue
      // 5.00：目标语言不同，"该保留哪一侧"也不同（译成英语时没有英语那一栏，见下）
      lines.push("- " + zh + " → " + pt)
    }
    lines.push("初译里若出现表外的专名，按初译保留，不要自行发明新写法。")
  }
  if (to === PT && Array.isArray(policy.terminology) && policy.terminology.length > 0) {
    lines.push('用词必须按巴葡（括号里是葡葡，不要用）：' + policy.terminology
      .map(entry => entry.br + '（不用 ' + entry.ptpt + '）')
      .join('、'))
  }
  return lines.join('\n')
}

const CN_DIGITS = { '〇': 0, '零': 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 }
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 }
const CN_DIGIT_CLASS = '〇零一壹二两贰三叁四肆五伍六陆七柒八捌九玖十百千'
const LARGE_UNIT = { 亿: 1e8, 万: 1e4, 千: 1e3, 百万: 1e6 }

/** 葡语大单位词；出现它们说明这一版在用**词形**写数字（见 proofreadRegression）。 */
const PT_LARGE = { mil: 1000, milhão: 1e6, milhao: 1e6, milhões: 1e6, milhoes: 1e6, bilhão: 1e9, bilhao: 1e9, bilhões: 1e9, bilhoes: 1e9 }
/**
 * 葡语基数词（百位以内）。只用于 `largeWordFormNumbers` 把 `trezentos e noventa e oito mil`
 * 这类表达式里的数值算出来 —— **不用于报错**，所以表不全只会让判据更严格（漏报），不会误报。
 */
const PT_SMALL = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, 'três': 3, quatro: 4, cinco: 5,
  seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13,
  quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18,
  dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60,
  setenta: 70, oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200,
  trezentos: 300, quatrocentos: 400, quinhentos: 500, seiscentos: 600,
  setecentos: 700, oitocentos: 800, novecentos: 900,
}
/**
 * 序数词 → 数值。**显式表，别用下标算**（第一版用 `index % 11 + 1` 从数组下标推数值，
 * 下标 0..11 对应的是 1..10，`décimo`（第 10）被算成了 11）。
 */
const PT_ORDINAL_VALUES = {
  primeiro: 1, segundo: 2, terceiro: 3, quarto: 4, quinto: 5, sexto: 6,
  'sétimo': 7, setimo: 7, oitavo: 8, nono: 9, 'décimo': 10, decimo: 10,
}

/** 中文数字 → 数值（「十二」=12；单独一个「十」也是 10）。 */
function chineseNumber(text) {
  let total = 0
  let current = 0
  let seen = false
  for (const ch of String(text)) {
    if (CN_DIGITS[ch] !== undefined) {
      current = current * 10 + CN_DIGITS[ch]
      seen = true
    } else if (CN_UNITS[ch] !== undefined) {
      total += (current === 0 ? 1 : current) * CN_UNITS[ch]
      current = 0
      seen = true
    } else {
      return null
    }
  }
  return seen ? total + current : null
}

/**
 * 取出文本里的数字（数值集合）。**只做可靠的两种来源**：阿拉伯数字、中文数字。
 *
 * ⚠️ 刻意**不解析葡语的词形数字** —— 那不是"懒得做"，是试过之后发现不划算：
 *    作同一个数有无数种词形写法（`12º` / `décimo segundo` / `andar doze` /
 *    `três mil novecentos e oitenta`），解析器漏一种写法就会把它误判成"数字丢了"，
 *    而每次误判的代价是**一次已经花钱跑完的校对白费**。
 *    改用"看到词形迹象就放过"（见 proofreadRegression），简单且不会误报。
 */
function numbersIn(text) {
  const raw = String(text)
  const out = new Set()
  const read = value => {
    if (value >= 10 && value < 1e15) out.add(Math.round(value))
  }
  for (const match of raw.matchAll(/(\d+)(?:[.,](\d+))?\s*(亿|万|千|百万)?/g)) {
    const after = raw.slice(match.index + match[0].length)
    // ⚠️ `15h20` / `7:30` 是"几时几分"：**两个数都要收**（15 和 20）。
    //    曾经这里只收小时、把分钟丢掉，于是「`15h20` → `três e vinte da tarde`」
    //    被判成"修订把 20 弄丢了" —— 而那是**完全正常的换写法**（实测在真实数据的
    //    互配对照里抓到的假阳性）。同传里时间几乎总会被换一种写法，所以这条必须对。
    if (/^[hH:]/.test(after) === true) {
      read(Number(match[1]))
      const minutes = (/^[hH:](\d{1,2})/.exec(after) ?? [])[1]
      if (minutes !== undefined) read(Number(minutes))
      continue
    }
    const decimals = match[2] === undefined ? '' : '.' + match[2]
    let value = Number(match[1] + decimals) * (LARGE_UNIT[match[3]] ?? 1)
    // 阿拉伯数字后面跟词形单位也要乘：`270 milhões` = 270×10⁶
    const nextWord = (after.toLowerCase().match(/^\s*([a-zà-ÿ]+)/) ?? [])[1]
    if (nextWord !== undefined && PT_LARGE[nextWord] !== undefined) value *= PT_LARGE[nextWord]
    read(value)
  }
  const chinese = new RegExp('([' + CN_DIGIT_CLASS + ']{1,6})', 'g')
  for (const match of raw.matchAll(chinese)) {
    const value = chineseNumber(match[1])
    if (value !== null) read(value)
  }
  return out
}

/** 词边界匹配：`tu` 不能命中 faturamento/tudo，`metro` 不能命中 parâmetros（真踩过）。 */
function hasWord(haystack, needle) {
  const text = String(haystack).toLowerCase()
  const word = String(needle).toLowerCase()
  if (word === '') return false
  const isLetter = ch => ch !== undefined && /\p{L}/u.test(ch)
  let from = 0
  for (;;) {
    const at = text.indexOf(word, from)
    if (at < 0) return false
    if (isLetter(text[at - 1]) === false && isLetter(text[at + word.length]) === false) return true
    from = at + 1
  }
}

/**
 * 校对回归闸：这条"修正"有没有**把初译里本来对的东西弄坏**。
 *
 * 为什么需要它 —— 现有那道验收闸（`revisionProblem`）只量两件事（变长太多、折行超预算），
 * 都是**格式**，不看内容。于是"修订把 `12º andar` 删了"或"把 `ônibus` 换成 `autocarro`"
 * 这类**内容回归**会被放行，屏幕上原地改坏。
 *
 * ⚠️ **只在「中文 → 巴葡」方向上跑**。这不是优化，是正确性：
 *    判据比的是「原文的数 ↔ 译文的数」，只有**译成葡语**时两边才可比。
 *    反方向（葡语 → 中文）时译文本身就是中文，里面的汉字数字会被当成"数字"，
 *    于是初译里的「十二楼」被判成"修订把 12 弄丢了" —— **假阳性**。
 *    这个坑是真踩出来的：合同套件里"屏幕换页时丢弃过期校对"那条测试因此变红，
 *    诊断信息正是 `修订把初译里的数字弄丢了（12）`，而那句的语向是 pt-BR→zh-CN。
 *
 * ⚠️ **不增加任何延迟**：纯本地字符串计算，不调模型、不联网。
 *    一句译文的量级，微秒级 —— 相对"一次模型调用几百毫秒到几秒"可以忽略。
 *
 * ⚠️ 取舍一律偏向"宁可不报"：漏判只是少拦一次，
 *    而误拦会让一次已经花钱跑完的校对白费、用户看到的还是旧译文。
 *
 * @return 有问题返回原因字符串；没问题（含"方向不对，不适用"）返回 null。
 */
function proofreadRegression(source, draft, corrected, policy) {
  const text = String(source)
  const before = String(draft)
  const after = String(corrected)

  const hasHan = value => /\p{Script=Han}/u.test(String(value))
  if (hasHan(text) === false || hasHan(before) === true) return null

  // 数字回归：原文数字当**核对清单**，要求"初译里有、修订里没有"才算回归。
  //
  // ⚠️ 这一处我改了六版才对，把结论与理由留在这儿，别再走回头路。
  //
  // 最直觉的做法是"把修订里的词形数字**精确解析**出来，再跟清单做差集"。它要求解析器
  // 覆盖 `12º andar` / `décimo segundo andar` / `três mil novecentos e oitenta` /
  // `cada um três mil...` 全部写法，**漏一种写法就把它误判成"数字丢了"**，
  // 而每次误判的代价都是**一次已经花钱跑完的校对白费**。我确实把那台解析器写出来了，
  // 结果是每修一个假阳性就冒出下一个（`e` 被当边界、`mil` 的乘法结合、
  // 量词 `um` 被并进数字、序数词两词写法……）。
  //
  // ⚠️ 走到这一步的经验：**判据里凡是"解析自然语言"的部分都会持续出错。**
  //    所以现在**不做精确解析，只比大小**（见下面的 biggestSeen），
  //    并保留一个只认大单位的粗解析器用于"证明大数还在"。
  //
  // 结果是三件事的组合，缺一不可：
  //   ① 初译里没有的数不算清单（那是初译的错，不是"改坏"）；
  //   ② 修订里逐字还在的数 → 没问题；
  //   ③ **修订里还有一个 ≥ 这个数** 的值 → 认为它在用另一套写法（词形/单位换算），放过。
  //      "≥"而不是"整个放过"，是为了让**降级**拦得住：`Do 12º andar para o 6º andar`
  //      → `Do 6º andar` 里，修订只剩 6，没有 ≥12 的值，所以 12 的丢失照样报出来。
  //      （这里曾经写成 biggestSeen ≥ value 但取的是全句最大数，
  //        于是同句里另一个更大的数 802 会把 12 的丢失掩盖掉 —— 必须比同名量级才对。）
  const draftNumbers = numbersIn(before)
  const afterNumbers = numbersIn(after)
  // 修订里可能把数写成了词形（`3980` → `três mil novecentos e oitenta`、
  // `12` → `décimo segundo andar`）—— 单独解析一遍，用来"证明这个数还在"。
  const recoveredLarge = largeWordFormNumbers(after)
  // 修订里出现过的**最大数值**：只要它 ≥ 某个丢失的数，就说明修订在用另一套写法
  // 描述同一个量级（词形、单位换算），不能因为"字面数字对不上"就判丢失。
  //
  // ⚠️ 这一条是**"别误拦"的总保险**，替掉了前面好几版零散的护栏（小数值放过、
  //    大单位迹象放过……）。那些散判据每加一条就发现新的漏网情况，而这条只是比大小，
  //    **没有解析、也就没有解析 bug**。
  // ⚠️ 但它必须"按值比"而不是"整个放过"：第四版是"修订里有词形数字就整个跳过检查"，
  //    于是 `…sala 802 no 8º andar` → `…o oitavo andar` 里那个 802 丢了也没发现。
  // ⚠️ **楼层语境的序数词**也算"在用词形写数"（`décimo segundo andar` = 12 楼）。
  //    这里必须限定"后面紧挨着 andar / piso"，**不能把序数词无条件当数字迹象** ——
  //    葡语里 `segundo`（根据）、`primeiro`（首先）是极常见的普通词，
  //    无条件接受会让召回崩掉（实测 `Do 12º andar para o 6º andar` → `Do 6º andar`
  //    里"12 楼丢了"被放过，就是因为句中的普通词命中了序数词表）。
  const words = after.toLowerCase().split(/[^a-zà-ÿ]+/).filter(item => item !== '')
  const usesFloorOrdinal = words.some((word, index) => {
    if (PT_ORDINAL_VALUES[word] === undefined) return false
    const next = words[index + 1] ?? ''
    return next === 'andar' || next === 'piso'
  })
  const hasNumberWord = usesFloorOrdinal === true
    || words.some(word => PT_LARGE[word] !== undefined)
  // ⚠️ 时间要单独看：`下午三点二十` → `15h20` → `três e vinte da tarde` 是最常见的正常换写法，
  //    而 `15h20` 拆出来是 {15, 20}、`três e vinte` 只取得到 3 —— 分钟部分会被误判成"丢了 20"。
  //    （这是实测抓到的假阳性，而且会**成片触发**：同传里时间几乎总会被换一种写法。）
  //    判法：原文与修订**都**能被认出是"时间"时，就不因分钟数变化而判丢失。
  //    中文侧也要认（`下午三点二十`），否则 zh→pt 的原文这一半会漏掉。
  const clockLike = value => /(\d{1,2})\s*[h:]\s*\d{2}/.test(String(value)) === true
  const spelledTime = value => /\b(uma|duas|três|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte|trinta)\s+e\s+(dez|vinte|trinta|quarenta|cinquenta)\b/i.test(String(value)) === true
    || /(horas?|tarde|manhã|manha|noite|meio-dia)/i.test(String(value)) === true
  const chineseTime = value => /(上午|下午|晚上|中午|凌晨|早上|点钟|点半|点整)/.test(String(value)) === true
    || /[〇零一二两三四五六七八九十]{1,3}\s*点\s*[〇零一二两三四五六七八九十]{0,3}/.test(String(value)) === true
  const looksLikeTime = value => clockLike(value) || spelledTime(value) || chineseTime(value)
  const bothTimes = looksLikeTime(text) && looksLikeTime(after)
  const lost = [...numbersIn(text)].filter(value => {
    if (draftNumbers.has(value) === false) return false     // 初译本来就没译出来 → 不是"改坏"
    if (afterNumbers.has(value) === true) return false      // 修订里还在
    if (recoveredLarge.has(value) === true) return false    // 粗解析对上了（含大单位写法），还在
    if (bothTimes === true && value <= 60) return false     // 两边都是时间写法 → 分钟数变化不算丢失
    // ⚠️ **小数值（< 1000）遇上"在用词形写数"的迹象就放过。**
    //    理由：这个量级的词形写法会让上面那个粗解析**算出偏小的值**
    //    （`três mil novecentos e oitenta` 只能算到 3000、`décimo segundo` 只有单独处理才对上），
    //    所以"解析不出来"不能当"丢了"的证据。它覆盖楼层（`12` ↔ `décimo segundo`）、
    //    数量（`120` ↔ `cento e vinte`）、百分数这些真实场景。
    //    而 ≥100 的数（房间号 `802`、金额 `3980`、`398000`）**模型永远用阿拉伯数字写**，
    //    必须拿出精确证据（真出现那个数）才放行 —— 否则就是真丢了。
    //    阈值取 100 而不是 1000：**房间号是三位数**（802），
    //    取 1000 会把"802 丢了"也放过（实测踩到过）。
    if (hasNumberWord === true && value < 100) return false
    // ⚠️ 这里曾经还有一条"修订里存在 ≥ 它的值就放过"（比大小）。**删掉了**，因为它会掩盖真丢失：
    //    `…no 12º andar para a sala 802 no 8º andar` → `…para o quarto 802 no oitavo andar`
    //    里 12 楼真的丢了，但修订里有更大的 802，且 802 在初译里也存在 ——
    //    于是"比大小"那条直接放行，**真回归被掩盖**（实测抓到的）。
    //    现在的判据全部基于**证据**（那个值真的出现了 / 词形能对上 / 小数值+词形迹象），
    //    不做任何"看起来像"的推断。
    return true
  })
  if (lost.length > 0) {
    return '修订把初译里的数字弄丢了（' + lost.join('、') + '）—— 同传里丢数字比语法错严重得多'
  }

  // 口径回归：修订里冒出了欧洲葡语说法（提示词里明令禁止）。
  // 初译本来就有则不算回归 —— 这道闸管的是"别改坏"，不是"改好"。
  const terminology = policy === undefined || policy === null || Array.isArray(policy.terminology) === false
    ? []
    : policy.terminology
  for (const entry of terminology) {
    if (entry.ptpt === undefined || entry.ptpt === '') continue
    if (hasWord(before, entry.ptpt) === true) continue
    if (hasWord(after, entry.ptpt) === true) {
      return '修订里出现了欧洲葡语说法 ' + entry.ptpt + '（巴葡应为 ' + entry.br + '）'
    }
  }
  return null
}

/**
 * 葡语**大单位表达式**里的数值（`trezentos e noventa e oito mil` → 398000）。
 *
 * 只认"大单位词"，因为只有这一档需要它：
 *   · `mil / milhão / bilhão` 后面跟着的数值一定是大数，而大数**不会被写成词**的假设
 *     正是第四版误判 398000 的原因 —— 模型确实会写 `trezentos e noventa e oito mil`。
 *   · 小数字（< 100）由"词形迹象 + 小数值"那条护栏覆盖，不需要在这里解析。
 *
 * ⚠️ 只在"证明某个大数还在"时用（往集合里加），不报错 —— 所以宁可多算几个也不漏算。
 * ⚠️ 数值算错也无妨：真正要证明的那个数（398000）一定会以某个中间形态出现
 *    （`mil` 处会算出 398000；即使累加次序不完美，目标值通常仍在集合里）。
 *    而**算不出来只会让判据更严格** —— 那是漏报，不是误报，可以接受。
 */
function largeWordFormNumbers(text) {
  const out = new Set()
  const words = String(text).toLowerCase().split(/[^a-zà-ÿ]+/).filter(item => item !== '')
  let run = 0
  let hasRun = false
  const read = () => {
    if (hasRun === true && run >= 10 && run < 1e15) out.add(Math.round(run))
    run = 0
    hasRun = false
  }
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const large = PT_LARGE[word]
    if (large !== undefined) {
      run = (run === 0 ? 1 : run) * large
      hasRun = true
      continue
    }
    const small = PT_SMALL[word]
    if (small !== undefined) {
      // ⚠️ 这里**绝不能 read()** —— 这是踩过的坑：
      //    `três mil trezentos e oitenta` 里，`trezentos` 若触发收尾，
      //    就把中间的 3000 当成结果吐出去（而真值是 3380），**真值反而不在集合里**。
      //    数词与大单位都只累积，收尾只发生在真边界（非数字词）与结尾。
      // 数字之间没有 `e` 连接就是两个数（`cada um três mil` = 各 1 + 三千），有 `e` 才是相加
      if (hasRun === true && words[index - 1] !== 'e') run = 0
      run += small
      hasRun = true
      continue
    }
    // `e` 是数字内部的连接词（`trezentos e noventa e oito mil`），不是边界
    if (word === 'e') continue
    read()
  }
  read()
  // ⚠️ 把收尾时手里的累积值也收进来。它是"改写成了词形"的证据，哪怕值不完全精确：
  //    `décimo segundo andar` → 累积到 12（真值就是 12）；
  //    `três mil novecentos e oitenta` → 只能算到 3000（真值 3980）——
  //    所以调用方那边还要配一条"< 1000 时只要有大单位迹象就放过"（见 proofreadRegression）。
  if (run > 0 && run < 1e15) out.add(Math.round(run))
  return out
}

/**
 * 校对结果的验收闸：这条"修正"到底能不能上屏？
 *
 * 为什么必须有：提示词里写了"不许比原译文更长"，但**模型不保证守规矩**。 而且这里还有一个更阴的失败方式 —— 读代码时发现的：
 * 离线演示用的例句表适配器（scripts/demo-phrasebook.mjs）对查不到的输入会回一句
 * 「（离线演示：例句表里没有这一句，原文为「…」）」。校对请求当然查不到，
 * 于是它会**被当成校对结果**，把一句本来正确的字幕覆盖成这句演示提示。
 * 这类"校对把对的改错"的代价比"不校对"高得多 —— 观众已经把上一版读进去了。
 *
 * 两条判据（都必要）：
 *   ① 变长太多 → 这不是校对，是别的东西（校对只该修错，不该扩写）；
 *   ② 折行后超出显示预算 → 会把开头挤掉（AR 只有 3 行，超出的部分是从**开头**被丢的）。
 *
 * @return 不可用时返回原因字符串；可用返回 null。
 */
function revisionProblem(draft, corrected, cols, lines) {
  const before = String(draft)
  const after = String(corrected)
  if (after.trim() === '') return '校对结果为空'
  const grew = after.length - before.length
  if (grew >= 12 && after.length > before.length * 1.5) {
    return '比原译文长太多（' + before.length + ' → ' + after.length + ' 字符），不像是在校对'
  }
  if (wrapText(after, cols).length > lines) {
    return '折行后有 ' + wrapText(after, cols).length + ' 行，超出 ' + lines + ' 行的显示预算'
  }
  return null
}

/**
 * 拼校对那一次的输入：这一句的原文 + 已上屏的译文 + 上一句的上下文。
 *
 * 为什么一定要把**原文**给它：同传里最常见的错误不是"译得不好"，而是
 * **听错了**（Whisper 在短片段上尤其容易错，例如把「这是一条测试语音」听成
 * 「这是一条」+「测试语音」两句）。只看译文是发现不了这类错的，
 * 必须拿原文对照，甚至要往前看一句才能推断说话人到底想说什么。
 */
function proofreadRequest(input) {
  const lines = []
  if (input.context !== undefined && input.context !== null) {
    lines.push('上一句原文：' + input.context.source)
    lines.push('上一句译文：' + input.context.translation)
  }
  lines.push('这一句原文：' + input.source)
  lines.push('已经上屏的译文：' + input.draft)
  lines.push('请输出校对后的译文（没有要改的就原样输出）：')
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 一次挂载 = 一个解释器实例
//
// 状态刻意放在实例里而不是模块级：正式插件可能被多个 agent preset 同时挂载
// （harness 里这是常态），模块级状态会让两条会话的字幕互相串。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * transport seam —— 唯一会随真机变化的一层。
 *
 *   mock —— 打到 host 日志 + 留在内存，无真机也能把整条链路跑通；
 *   file —— 把「当前字幕帧」原子写成一份 JSON，外部桥（Python/ADB/BLE 程序）轮询它
 *           再推给真机。这是接入真机最短的路：眼镜协议怎么变都不动插件。
 *
 * 接真机时在这里加一支：'adb'（走 ctx.get('shell')）、'ble'（走外部守护进程）……
 * 注意 ctx.web.fetch 只支持 GET（WebFetchRequest 只有 url 字段），不能当 POST 桥用。
 */
function createTransport(ctx, config) {
  if (config.transport === 'file') {
    return {
      kind: 'file',
      detail: config.sinkPath,
      async send(frame) {
        const fs = ctx.get('fs')
        if (fs === undefined) throw new Error('transport "file" 需要 fs 服务，但当前 ctx 里没有')
        const target = await fs.resolve(config.sinkPath)
        await fs.writeText(target, JSON.stringify(frame, null, 2) + '\n')
      },
    }
  }
  return {
    kind: 'mock',
    detail: '进程内 console + 内存（无真机模式）',
    async send(frame) {
      console.log('[leion-pro] ' + frame.speaker + '/' + frame.lang + ' → ' + frame.lines.join(' ⏎ '))
    },
  }
}

/**
 * 建一个解释器实例：持有 transport、翻译后端、字幕历史、计数，并暴露业务操作。
 * @param ctx 受限 ctx（只需要 get）
 * @param rawConfig 用户配置（会被 validateConfig 校验并填默认值）
 * @param deps 必须提供 { policy } —— 巴葡策略数据，见 policy/br-pt.json 与
 *             plugin/policy.generated.mjs（生成物）。两个包装目标各自把 policy 传进来：
 *             正式包 import 生成模块，动态包由生成器内联成常量。
 */
/** 折叠用的串，**长度必须不变**（否则所有偏移量都会错位）。 */
function foldForTerms(text) {
  let out = ''
  for (const char of String(text)) {
    const base = char.normalize('NFD')[0]
    const lowered = base.toLowerCase()
    out += lowered.length === 1 ? lowered : char
  }
  return out
}

/** 中文"危险邻居"：和两字名字拼起来会变成另一个词的字（从真实碰撞里来，必然不完整）。 */
const ZH_COMPOUND_NEIGHBORS = new Set('量路速频压温值铁率程通倍分条段'.split(''))

/** 只认汉字：标点/数字/拉丁字母都算天然边界。 */
function dangerousZhNeighbor(char) {
  if (char === undefined || char === '') return false
  if (/[\p{Script=Han}]/u.test(char) === false) return false
  return ZH_COMPOUND_NEIGHBORS.has(char)
}

function isWordChar(char) {
  if (char === undefined) return false
  return /[\p{L}\p{N}]/u.test(char)
}

function hanCountOf(text) {
  const found = String(text).match(/\p{Script=Han}/gu)
  return found === null ? 0 : found.length
}

/** 去空白后折叠 + 紧凑下标映射（让 `LeionPro` 与 `Leion Pro` 等价，同时能回到原文）。 */
function compactFold(text) {
  let compact = ''
  const map = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (/\s/.test(char)) continue
    compact += foldForTerms(char)
    map.push(index)
  }
  return { compact, map }
}

/** 把表编译成"同语种归一"用的两个索引。 */
function buildTermsIndex(entries) {
  const zh = []
  const pt = []
  for (const entry of entries || []) {
    for (const form of [entry.zh, ...(entry.variants || []), ...(entry.wrong || [])]) {
      if (typeof form === 'string' && form !== '') {
        zh.push({ entry, form, replacement: entry.zh, kind: 'zh' })
      }
    }
    for (const form of [entry.pt, ...(entry.approved || []), ...(entry.wrong || [])]) {
      if (typeof form === 'string' && form !== '') {
        pt.push({ entry, form, replacement: entry.pt, kind: 'pt' })
      }
    }
  }
  return { zh, pt }
}

/**
 * 对一段译文做归一（**纯函数**：给它文本、语种、表，它就返回结果）。
 *
 * <p>为什么单独抽出来并导出：契约测试要能直接断言"变体→规范写法"、
 * "幂等"、"空表不动"。走整条链路测不干净 —— 假 LLM 的译文是固定句型，
 * 里面根本没有变体可换（这一点我在写测试时踩到了）。
 *
 * @param {string} text
 * @param {string} lang
 * @param {object[]} entries
 * @returns {{ text: string, events: object[], changed: boolean }}
 */
function normalizeTerms(text, lang, entries) {
  const source = typeof text === 'string' ? text : ''
  if (source === '' || Array.isArray(entries) === false || entries.length === 0) {
    return { text: source, events: [], changed: false }
  }
  const isZh = String(lang).toLowerCase().startsWith('zh')
  const index = buildTermsIndex(entries)
  const candidates = isZh ? index.zh : index.pt
  const folded = foldForTerms(source)
  const compact = compactFold(source)

  const found = []
  for (const item of candidates) {
    const foldEnabled = item.entry.fold !== false
    const needle = foldEnabled
      ? (isZh ? foldForTerms(item.form) : foldForTerms(item.form).replace(/\s+/g, ''))
      : item.form
    const haystack = foldEnabled ? (isZh ? folded : compact.compact) : source
    if (needle.length === 0) continue
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at < 0) break
      from = at + 1
      const start = foldEnabled && isZh === false ? compact.map[at] : at
      const end = foldEnabled && isZh === false
        ? compact.map[at + needle.length - 1] + 1
        : at + needle.length
      if (start === undefined || end === undefined) continue
      if (isZh) {
        const mustCheck = hanCountOf(item.form) === 2 || item.entry.strictBoundary === true
        if (mustCheck) {
          const before = source.charAt(start - 1)
          const after = source.charAt(end)
          if (dangerousZhNeighbor(before) || dangerousZhNeighbor(after)) {
            found.push({ start, end, item, skipped: true })
            continue
          }
        }
      } else {
        if (start > 0 && isWordChar(source.charAt(start - 1))) continue
        if (end < source.length && isWordChar(source.charAt(end))) continue
      }
      found.push({ start, end, item, skipped: false })
    }
  }

  // 实体重叠：被更长匹配覆盖的短匹配一律丢弃（`Leion` 在 `Leion Pro` 里必须让位）
  const usable = found.filter(match => match.skipped !== true)
    .sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)))
  const picked = []
  let cursor = 0
  for (const match of usable) {
    if (match.start < cursor) continue
    picked.push(match)
    cursor = match.end
  }

  const events = []
  let out = ''
  let position = 0
  for (const match of picked) {
    const original = source.slice(match.start, match.end)
    const replacement = match.item.replacement
    out += source.slice(position, match.start)
    // 只有**逐字相同**才算"已经是规范写法"。仅大小写/重音/空格不同也属于变体 ——
    // must 的口径是"命中变体就必须输出规范写法"：`llvision` 必须变成 `LLVision`。
    // 折叠只负责"找得到"，不负责"不用改"。
    if (original === replacement) {
      out += original
      events.push({ event: 'hit', id: match.item.entry.id })
    } else {
      out += replacement
      events.push({ event: 'replace', id: match.item.entry.id, from: original, to: replacement })
    }
    position = match.end
  }
  out += source.slice(position)
  for (const match of found) {
    if (match.skipped === true) events.push({ event: 'boundary_skip', id: match.item.entry.id })
  }
  return { text: out, events, changed: out !== source }
}

/**
 * 在一段文本里"找得到"某个写法（与匹配器同一套折叠与边界规则）。
 *
 * <p>为什么不复用 `normalizeTerms`：它按键值找"要替换的变体"，而这里要回答的是
 * "这段文本里**有没有出现**这个写法（任意已知写法）"—— 关心的是存在性，不是替换。
 * 规则必须一致，否则会出现"归一认为没出现、观测认为出现了"这种自相矛盾的日志。
 */
/**
 * "这句原文里出现了哪些表内条目" —— **唯一实现**。
 *
 * <p>产线（`termsHintFor`）与演示台/评测脚本都必须用它。为什么不允许各自实现：
 * 判断"是否提及"要同时考虑**变体**（原文说「亮亮眼睛」、条目写「亮亮眼镜」）、
 * **可接受写法**（葡语侧 `approved`）、折叠（大小写/重音/空格）与边界（中文危险邻接）。
 * 自己写个 `text.includes(entry.zh)` 会漏掉前两条 —— 演示台给出"本句不会加提示"，
 * 而产线其实会加，这种分叉比直接报错更难发现。
 *
 * @param {string} text 原文
 * @param {object[]} entries 表内条目
 * @param {boolean} sourceZh 原文是中文（用 zh+variants）/ 否（用 pt+approved）
 * @returns {{zh: string, pt: string}[]} 命中的条目（顺序同入参）
 */
function mentionedEntries(text, entries, sourceZh) {
  const source = String(text === undefined || text === null ? '' : text)
  if (source === '' || Array.isArray(entries) !== true) return []
  const hint = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const forms = sourceZh === true
      ? [entry.zh, ...(entry.variants ?? [])]
      : [entry.pt, ...(entry.approved ?? [])]
    const mentioned = forms.some(form => typeof form === 'string' && form !== ''
      && mentionsForm(source, form, sourceZh === true, entry.fold !== false, entry.strictBoundary === true))
    if (mentioned) hint.push({ zh: entry.zh, pt: entry.pt })
  }
  return hint
}

function mentionsForm(text, form, isZh, foldEnabled, strictBoundary) {
  const folded = foldForTerms(text)
  const compact = compactFold(text)
  // 中文不折叠空格（中文名字里不会有空格），拉丁则连写也算同一个名字（与匹配器一致）
  const needle = foldEnabled
    ? (isZh ? foldForTerms(form) : foldForTerms(form).replace(/\s+/g, ''))
    : form
  const haystack = foldEnabled ? (isZh ? folded : compact.compact) : text
  if (needle === '') return false
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    from = at + 1
    const start = foldEnabled && isZh === false ? compact.map[at] : at
    const end = foldEnabled && isZh === false ? compact.map[at + needle.length - 1] + 1 : at + needle.length
    if (start === undefined || end === undefined) continue
    if (isZh) {
      const mustCheck = hanCountOf(form) === 2 || strictBoundary === true
      if (mustCheck) {
        if (dangerousZhNeighbor(text.charAt(start - 1)) || dangerousZhNeighbor(text.charAt(end))) continue
      }
    } else {
      if (start > 0 && isWordChar(text.charAt(start - 1))) continue
      if (end < text.length && isWordChar(text.charAt(end))) continue
    }
    return true
  }
}

/**
 * 热词观测（A 方案，docs/15 §17）：找出"源文提到了表内名字、译文里却没有规范写法"的条目。
 *
 * <p>纯字符串、零模型调用 —— 它**不判断**模型写得对不对，只判断"规范写法出现了没有"。
 * 所以它不知道模型写成了什么（那是离线候选发现干的事），但足够回答"这句话有没有问题"。
 *
 * @param {string} source 原文
 * @param {string} text 译文
 * @param {object[]} entries 已校验的条目
 * @param {string} from 源语种（zh-CN / pt-BR）
 * @param {string} to 目标语种
 * @returns {object[]} `[{ event: 'watch', id, zh, source, translation }]`
 */
function detectTermsMiss(source, text, entries, from, to) {
  const src = String(source === undefined || source === null ? '' : source)
  const tgt = String(text === undefined || text === null ? '' : text)
  if (src === '' || tgt === '' || Array.isArray(entries) !== true || entries.length === 0) return []
  const sourceZh = String(from).toLowerCase().startsWith('zh')
  const targetZh = String(to).toLowerCase().startsWith('zh')
  // 同语种（只会是异常配置）或方向不明 → 不做观测，宁缺勿错
  if (sourceZh === targetZh) return []
  const events = []
  for (const entry of entries) {
    const direction = entry.direction ?? 'auto'
    if (direction === 'zh-to-pt' && (sourceZh === false || targetZh === true)) continue
    if (direction === 'pt-to-zh' && (sourceZh === true || targetZh === false)) continue
    const foldEnabled = entry.fold !== false
    const forms = sourceZh
      ? [entry.zh, ...(entry.variants ?? [])]
      : [entry.pt, ...(entry.approved ?? [])]
    const canonical = targetZh ? entry.zh : entry.pt
    const mentioned = forms.some(form => typeof form === 'string' && form !== ''
      && mentionsForm(src, form, sourceZh, foldEnabled, entry.strictBoundary === true))
    if (mentioned === false) continue
    const canonicalPresent = mentionsForm(tgt, canonical, targetZh, foldEnabled, entry.strictBoundary === true)
    if (canonicalPresent) continue
    events.push({
      event: 'watch', id: entry.id, zh: entry.zh,
      source: src, translation: tgt,
    })
  }
  return events
}

/**
 * 4b 强制执行闸（纯函数）：**初稿里已经正确的规范写法，校对结果里不许消失**。
 *
 * <p>为什么需要它：`proofreadRules` 已经写明"专有名词不由你负责"，但实测模型**并不完全遵守**
 * ——它仍会把 `óculos LLVision` 改成 `óculos Leion`、或把名字换成别的写法。
 * 校对是**在归一之后**跑的，只有它有能力破坏归一/归一后的结果；
 * 所以这里加一道本地检查：任何表内条目的规范写法，只要在初稿里出现过、
 * 校对结果里却没有了 → 这次校对整条丢弃（屏幕保持初稿）。
 *
 * <p>注意：如果校对只是把*未登记变体*换成规范写法（方向是对的），初稿里**没有**规范写法，
 * 这道闸不拦；如果校对把规范写法换成**已登记**的变体，前面的 `applyTerms` 会先换回来，也不拦。
 *
 * @returns {string | null} 有问题返回原因，没问题返回 null
 */
function proofreadKeptNames(draft, corrected, entries, targetZh) {
  const before = String(draft === undefined || draft === null ? '' : draft)
  const after = String(corrected === undefined || corrected === null ? '' : corrected)
  if (before === '' || after === '') return null
  for (const entry of entries ?? []) {
    if (entry === null || typeof entry !== 'object') continue
    const canonical = targetZh ? entry.zh : entry.pt
    if (typeof canonical !== 'string' || canonical === '') continue
    const foldEnabled = entry.fold !== false
    const strict = entry.strictBoundary === true
    if (mentionsForm(before, canonical, targetZh, foldEnabled, strict) === false) continue
    if (mentionsForm(after, canonical, targetZh, foldEnabled, strict) === true) continue
    return '「' + canonical + '」在初稿里是正确的，校对结果里没有了'
  }
  return null
}

/**
 * 在文本里定位一个"片段"的**原始下标区间**（折叠 + 去空格，与匹配器同一套口径）。
 *
 * <p>为什么需要它：临时修正必须**只换那一小段**，不能像校对那样让模型重写整句
 * （重写整句 = 把"可能改坏一句"的风险又请回来）。所以先定位、再手工拼回。
 *
 * @returns {{ start: number, end: number } | null} `null` = 原文里找不到这个片段
 */
function locateTermSpan(text, needle) {
  const src = String(text)
  const foldedNeedle = foldForTerms(String(needle)).replace(/\s+/g, '')
  if (foldedNeedle === '') return null
  const compact = compactFold(src)
  const at = compact.compact.indexOf(foldedNeedle)
  if (at < 0) return null
  const start = compact.map[at]
  const end = compact.map[at + foldedNeedle.length - 1]
  if (start === undefined || end === undefined) return null
  return { start, end: end + 1 }
}

/**
 * 临时修正的**全部闸门**（纯函数）：给"草案、模型答案、规范写法、其它条目"，决定改不改。
 *
 * **激进版（实验分支，docs/15 §18）**：去掉了"与规范写法形状相似"这一道 ——
 * 译名/缩写类（`Liangliang Ótica` vs `Leion`）不再被拒，由模型判断"它写成了什么"。
 * 代价与护栏：片段必须**原样出现在译文里**、不夹带别的表名、长度受限、
 * 改完必须过格式验收；而且**只改最后一句**、过期丢弃 —— 不靠"形状像不像"兜底。
 *
 * @returns {{ ok: true, text: string, from: string, to: string } | { ok: false, reason: string }}
 */
function planRescue({ draft, answer, canonical, entries, targetZh, cols, lines }) {
  const text = String(draft === undefined || draft === null ? '' : draft)
  const raw = String(answer === undefined || answer === null ? '' : answer).trim()
  const canon = String(canonical === undefined || canonical === null ? '' : canonical)
  if (text === '' || raw === '') return { ok: false, reason: '空输入' }
  if (foldForTerms(raw) === foldForTerms(canon)) return { ok: false, reason: '与规范写法相同' }
  const words = raw.split(/\s+/).filter(word => word !== '')
  if (words.length > 6 || raw.length > 40) return { ok: false, reason: '片段太长（可能是一整句）' }
  const span = locateTermSpan(text, raw)
  if (span === null) return { ok: false, reason: '片段没有原样出现在译文里' }
  // 激进版不再要求"与规范写法形状相似"——译名/缩写类也允许；靠下面两条兜底。
  // ② 不得夹带别的表内名字
  for (const other of entries) {
    if (other === null || typeof other !== 'object') continue
    if (other.pt === canon || other.zh === canon) continue
    const forms = targetZh
      ? [other.zh, ...(other.variants ?? [])]
      : [other.pt, ...(other.approved ?? [])]
    const hitOther = forms.some(form => typeof form === 'string' && form !== ''
      && mentionsForm(raw, form, targetZh, other.fold !== false, other.strictBoundary === true))
    if (hitOther) return { ok: false, reason: '片段里夹带了别的名字（串台）' }
  }
  const replaced = text.slice(0, span.start) + canon + text.slice(span.end)
  // ③ 格式验收：与校对共用同一道闸，避免"行数/列数放不下"的修正上屏
  if (typeof cols === 'number' && typeof lines === 'number') {
    const problem = revisionProblem(text, replaced, cols, lines)
    if (problem !== null) return { ok: false, reason: '格式验收不过：' + problem }
  }
  return {
    ok: true,
    text: replaced,
    from: text.slice(span.start, span.end),
    to: canon,
  }
}

function createInterpreter(ctx, rawConfig, deps) {
  const config = validateConfig(rawConfig)
  if (deps === undefined || deps === null || deps.policy === undefined) {
    throw new Error('leion-pro: 缺少 policy。它由 plugin/policy.generated.mjs 提供；'
      + '如果你刚改过 policy/br-pt.json，先跑 node scripts/generate.mjs')
  }
  const policy = deps.policy
  const transport = createTransport(ctx, config)
  const state = {
    frames: [],
    pushes: 0,
    partials: 0,
    errors: 0,
    restored: 0,
    lastError: null,
    lastFrame: null,
    /** 最近一帧「定稿」字幕：翻译失败时用它把眼睛上的碎片换掉。 */
    lastGoodFrame: null,
    translating: false,
    callSeq: 0,
    /**
     * 屏幕上"换过几次"的计数。**每一次 sendRaw（含流式增量、清屏）都 +1**。
     * 校对结果靠它判断"我要改的那句还在屏幕上吗"：
     * 期间只要有任何东西上过屏（哪怕只是下一句的增量），这个数就变了，
     * 校对结果就必须**丢弃** —— 否则屏幕会倒退回去显示上一句。
     */
    displaySeq: 0,
    /** 校对统计。字段名直说结果，便于在自检和日志里一眼看出"校对到底有没有在干活"。 */
    proofread: { enqueued: 0, settled: 0, fixed: 0, same: 0, rejected: 0, dropped: 0, failed: 0, lastNote: null },
    /** 热词归一（docs/15 §7.1）：用了几条表、替换/命中/边界跳过各几次。 */
    terms: {
      enabled: false, user: null, entries: 0, replace: 0, hit: 0, boundarySkip: 0, watch: 0, lastNote: null,
      /** 热词临时修正（方向一实验）：问了几次、改了几次、拒了几次、丢了几次。 */
      rescue: { asked: 0, applied: 0, rejected: 0, dropped: 0, failed: 0, lastNote: null },
    },
    /** 最近几句（原文+译文），给校对当上下文用。只留很少几条，避免把提示词撑大。 */
    recent: [],
  }

  /**
   * 待校对队列 + 是否正在校对。
   *
   * 为什么要有队列而不是"翻译完立刻校对"：收件箱是串行处理的（同传不能并发，
   * 否则字幕会互相穿插）。如果校对占着当前这一句不放，下一句的初译就得排队等它，
   * 等于给每一句都加了一次模型往返 —— 而实测初译本身只要 0.44~0.96 秒，
   * 加一次就翻倍。所以校对只在**空闲**（队列空、没有翻译在跑）时才动，
   * 观众看到初译的时间一点不变。
   */
  const proofreadQueue = []
  let proofreading = false
  /** 第一次因为"没有 llm 服务"失败后就不再重试，免得每句都刷一遍同样的错。 */
  let proofreadUnavailable = false

  function buildFrame(input) {
    const text = String(input.text === undefined ? '' : input.text)
    // `source` 是**原文**（ASR 识别出来的那句、或手输的文字），`text` 是给佩戴者看的那一侧。
    // 为什么两个都要给出去：手机端要按"原文在上、译文在下"成对显示，
    // 而**只有插件这一层同时知道这两样**（原文是它的输入，译文是它的产出）。
    // 缺省等于 text —— 这样 translator='none' 与 leion_display 这类没有"原文"概念的
    // 路径不用改，帧的结构也始终一致（下游不必分情况处理）。
    const source = String(input.source === undefined ? text : input.source)
    return {
      device: DEVICE.model,
      speaker: input.speaker === undefined ? 'them' : input.speaker,
      lang: input.lang === undefined ? 'unknown' : input.lang,
      text,
      source,
      sourceLang: input.sourceLang === undefined ? 'unknown' : input.sourceLang,
      /**
       * 这一帧是不是"还在生成中"的流式增量。
       *
       * 为什么要给出去：手机端要在**原位更新**同一个片段，并且给未定稿的那条打
       * 「生成中」标签。少了这个字段，手机分不清"这条还没译完"和"这条已经定稿"，
       * 只能靠猜 —— 而猜错的表现是：字幕永远挂着"生成中"，或者半句被当成定稿。
       */
      partial: input.partial === true,
      lines: fitSubtitle(text, config.cols, config.lines),
      // 热词观测（docs/15 §17）：本句"提到了表内名字但译文没写出规范写法"的条目。
      // 手机端据此在字幕下打一行小字（本场不改字幕，只是告诉用户"已记录"）。
      // 没有就**不放这个字段** —— 帧结构和加这个功能之前逐字一致。
      ...(Array.isArray(input.termsMiss) && input.termsMiss.length > 0
        ? { termsMiss: input.termsMiss }
        : {}),
      // 把显示预算也放进帧里：这样任何下游（真机桥、局域网转发、手机 App）
      // 都能从数据本身知道"眼镜有多大"，不必各自硬编码或各自配一份。
      cols: config.cols,
      lineBudget: config.lines,
      at: new Date().toISOString(),
    }
  }

  /** 只发送、不写入历史。清屏、自检探针这类「内部帧」不该污染佩戴者的双语记录。 */
  async function sendRaw(frame) {
    try {
      await transport.send(frame)
    } catch (error) {
      state.errors += 1
      state.lastError = String(error && error.message ? error.message : error)
      throw error
    }
    state.pushes += 1
    state.displaySeq += 1        // 屏幕变了：在途的校对结果就此作废（见 state.displaySeq 的说明）
    state.lastFrame = frame
    return frame
  }

  /** 发送并记入历史：真正给佩戴者看的**定稿**字幕走这条。 */
  async function pushFrame(frame) {
    await sendRaw(frame)
    state.lastGoodFrame = frame
    state.frames.push(frame)
    if (state.frames.length > HISTORY_CAP) state.frames.shift()
    return frame
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 热词归一（docs/15 阶段 3）：把译文里的"已知变体"换成用户写的规范写法
  //
  // 为什么这套实现**写在 core.mjs 里、而不是从 lib/ 引过来**：
  // 插件要被内联进动态插件的沙箱，那个沙箱**没有 import**（生成器只剥 `export `，
  // 一个字面 import 会在沙箱里炸）。所以这一层必须自包含。
  // 对应的单测与评测脚本仍然用 lib/terms-matcher.mjs —— 那是同一套规则的
  // "可测副本"，两边由 tests/terms-matcher-suite.mjs 与 contract-suite 同时盯着。
  //
  // ⚠️ 三条边界写死在这里：
  //   ① **不调用模型**：纯字符串；② **幂等**：一次扫描内替换完，再喂一遍不变；
  //   ③ **只做归一**：不做"缺失重译"（那是后续独立实验）。
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 对一段译文做归一（**实例内**的入口：带开关与已载入的表）。
   *
   * @param {string} text 译文
   * @param {string} lang 译文语种（`zh-CN` / `pt-BR`）：**在同一种语言内部**收敛写法
   */
  function applyTerms(text, lang) {
    if (config.terms !== 'on') {
      return { text: typeof text === 'string' ? text : '', events: [], changed: false }
    }
    return normalizeTerms(text, lang, termEntries)
  }

  /** 热词观测开关：归一总开关与观测开关**都为 on** 才做（docs/15 §17）。 */
  function watchEnabled() {
    return config.terms === 'on' && config.termsWatch === 'on'
  }

  /**
   * 本句专名提示（docs/15 §18.9）：找出"这句原文里真的出现了"的表内条目。
   *
   * <p>只列**本句出现**的名字 —— 不把整张表塞进提示词（那会稀释、浪费 token，
   * 还可能让模型乱补名字）。空表 / 本句没提名字时返回 null，提示词一个字都不加。
   *
   * <p>⚠️ 判断"提到"这件事只有这一份实现（下面 `mentionedEntries`）。演示台/评测脚本
   * 如果要展示"本句会不会加提示"，必须调它，不能自己写 `text.includes(entry.zh)` ——
   * 那样会漏掉**变体**（原文说「亮亮眼睛」、条目写「亮亮眼镜」，简化判断会漏），
   * 于是演示与产线给出不同结论，而这种分叉最难发现。
   */
  function termsHintFor(source, from) {
    if (config.terms !== 'on' || config.termsHint !== 'on') return null
    if (termEntries.length === 0) return null
    const text = String(source === undefined || source === null ? '' : source)
    if (text === '') return null
    const hint = mentionedEntries(text, termEntries, String(from).toLowerCase().startsWith('zh'))
    return hint.length === 0 ? null : hint
  }

  /**
   * 读热词表 / 会议术语。
   *
   * <p>**每句都会调用**（2026-10-24 改）。为什么不再"每场只读一次"：
   * "这一场用哪些库"现在是**手机开始同传时由 relay 发布**到固定路径的（docs/19），
   * 而大脑进程往往在"开始同传"之前就起来了 —— 只读一次的话，这一场永远用上一场的表，
   * 实测表现就是"取消勾选、重启之后旧词表还在生效"。
   *
   * <p>代价控制：读的是**一份冻结好的会议术语文件**（几 KB），每个句子读一次可忽略；
   * 而且用**内容指纹**比对，没变就不重新解析（避免每句都 JSON.parse）。
   * 这也保留了原来的好处：同一场里文件不变 → 行为稳定。
   */
  let termEntries = []
  let termsFingerprint = null

  async function refreshTerms() {
    if (config.terms !== 'on' || config.termsPath === '') return
    const fs = ctx.get('fs')
    if (fs === undefined) {
      state.terms.lastNote = '没有 fs 服务，热词表未加载'
      return
    }
    try {
      // 先看"当前会话用哪个用户"，再取那个用户的表
      let user = null
      if (config.termsActivePath !== '') {
        try {
          const activeTarget = await fs.resolve(config.termsActivePath)
          const activeInfo = await fs.stat(activeTarget)
          if (activeInfo !== undefined) {
            const parsed = JSON.parse(await fs.readText(activeTarget))
            if (parsed !== null && typeof parsed === 'object' && typeof parsed.user === 'string') {
              user = parsed.user
            }
          }
        } catch { /* 没有 active 文件就用 default */ }
      }
      const target = await fs.resolve(config.termsPath)
      const info = await fs.stat(target)
      if (info === undefined) {
        state.terms.lastNote = '没有热词表文件'
        return
      }
      const doc = JSON.parse(await fs.readText(target))
      const tables = doc !== null && typeof doc === 'object' && doc.tables !== null
        && typeof doc.tables === 'object' ? doc.tables : {}
      const chosen = user !== null && tables[user] !== undefined ? user : 'default'
      const table = tables[chosen]
      const entries = table !== null && table !== undefined && Array.isArray(table.entries) ? table.entries : []
      // 内容指纹：文件没变就不重复解析/刷日志（每句都会调这个函数）
      const fingerprint = chosen + '|' + entries.length + '|'
        + (table && typeof table.updatedAt === 'string' ? table.updatedAt : '')
      if (fingerprint === termsFingerprint) return
      termsFingerprint = fingerprint
      termEntries = entries
      state.terms.enabled = config.terms === 'on'
      state.terms.user = chosen
      state.terms.entries = entries.length
      console.log('[leion-pro] 热词表：' + entries.length + ' 条（user=' + chosen + '）')
    } catch (error) {
      // 读表失败**绝不能影响出字幕**：当作没有热词表
      state.terms.lastNote = '读热词表失败（已忽略）：'
        + String(error && error.message ? error.message : error)
      console.log('[leion-pro] 热词表：' + state.terms.lastNote)
    }
  }

  /** 把替换事件写一行日志（控制台 + 可选落盘）。失败一律忽略。 */
  const termsLogLines = []
  async function logTermsEvents(events, where) {
    if (!Array.isArray(events) || events.length === 0) return
    for (const event of events) {
      if (event.event === 'replace') {
        state.terms.replace += 1
        console.log('[leion-pro] ✎ 术语：' + event.from + ' → ' + event.to)
      } else if (event.event === 'hit') {
        state.terms.hit += 1
      } else if (event.event === 'boundary_skip') {
        state.terms.boundarySkip += 1
      } else if (event.event === 'watch') {
        // 热词观测：本句提到了名字、译文却没写出规范写法 → 记下来（不改字幕）。
        // 记的是**完整原文+译文**：离线候选发现要拿它们去问"写成了什么"。
        state.terms.watch += 1
        console.log('[leion-pro] ◌ 术语观测：' + event.zh + ' 未按对照写法出现（已记录）')
      }
      termsLogLines.push(JSON.stringify({
        t: new Date().toISOString(), where, ...event,
      }))
    }
    if (config.termsLogPath === '') return
    const fs = ctx.get('fs')
    if (fs === undefined) return
    try {
      // fs 服务只有 writeText（没有 append），所以整份重写；只保留最近 2000 行
      while (termsLogLines.length > 2000) termsLogLines.shift()
      const target = await fs.resolve(config.termsLogPath)
      await fs.writeText(target, termsLogLines.join('\n') + '\n')
    } catch {
      /* 日志写不进去就算了：它是可观测性，不是功能 */
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 大模型校对（第二遍）：把已经上屏的译文回头再检查一次
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 手机侧的运行时开关（`var/live/settings.json`，由 relay 的 `PUT /settings` 写入）。
   *
   * 为什么需要它：`config.proofread` 是**部署时**的配置，改它要重启 harness；
   * 而"这一场要不要校对"是用户当场就想改的事（费不费钱、快不快）。
   * 所以留一个文件接缝 —— 与收件箱/字幕总线同一套做法。
   *
   * 约定：
   *   · 文件不存在 / 读不到 / 格式不对 → **完全忽略**，按 config 来（不能让一个坏文件影响出字幕）；
   *   · 文件里有 `proofread` → **以它为准**（用户当场能摸到的那份更可信）；
   *   · 每场同传只读一次（第一次要排校对时），所以"改了下次生效"是天然的。
   */
  let runtimeProofread = null       // null = 还没读过 / 读不到
  let runtimeSettingsRead = false

  async function refreshRuntimeSettings() {
    if (runtimeSettingsRead) return
    runtimeSettingsRead = true
    const fs = ctx.get('fs')
    if (fs === undefined) return
    try {
      const target = await fs.resolve(config.settingsPath)
      const info = await fs.stat(target)
      if (info === undefined) return
      const text = await fs.readText(target)
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.proofread === 'boolean') {
        runtimeProofread = parsed.proofread
        console.log('[leion-pro] 校对：按手机侧设置 ' + (runtimeProofread ? '开启' : '关闭'))
      }
    } catch (error) {
      // 读设置失败**绝不能影响出字幕**：忽略即可
      console.log('[leion-pro] 校对：读 settings.json 失败（已忽略，按配置走）：'
        + String(error && error.message ? error.message : error))
    }
  }

  /**
   * 校对到底开没开（配置与手机侧开关合并后的**唯一判定**）。
   *
   * 为什么要有这么一个小函数：状态输出、自检说明、以及真正的排队判断
   * 都必须用同一套口径，否则会出现"状态说开着、其实没排队"这种最容易误导人的情况。
   */
  function proofreadWanted() {
    return runtimeProofread === null ? config.proofread === 'idle' : runtimeProofread
  }

  /** 有没有可用的模型服务。没有就别排队了 —— 排了也是每次都失败。 */
  function proofreadEnabled() {
    if (proofreadWanted() !== true || proofreadUnavailable) return false
    if (translator.kind === 'none') return false     // 纯显示通道：插件不碰模型
    const llm = ctx.get('llm')
    if (llm === undefined) {
      proofreadUnavailable = true
      state.proofread.lastNote = '没有 llm 服务，校对已自动关闭'
      console.log('[leion-pro] 校对：当前 ctx 里没有 llm 服务，自动关闭（翻译本身不受影响）')
      return false
    }
    return true
  }

  /**
   * 把一句刚上屏的译文排进校对队列。
   *
   * 记下 seq（当时的 displaySeq）是关键：等真正轮到校对时，要用它确认
   * "屏幕上还是这一句"。这就是"校对绝不覆盖更新的字幕"这条保证的实现方式。
   */
  function enqueueProofread(item) {
    if (!proofreadEnabled()) return false
    if (proofreadQueue.length >= config.proofreadMaxQueue) {
      // 积压了：丢掉最老的一条（它最不可能还在屏幕上）
      proofreadQueue.shift()
      state.proofread.dropped += 1
    }
    proofreadQueue.push(item)
    state.proofread.enqueued += 1
    return true
  }

  /**
   * 做一次校对。返回是否真的做了（调用方据此决定要不要继续让出时间片）。
   *
   * 只在**空闲**时被调用：收件箱队列空、没有翻译在跑、没有别的校对在跑。
   */
  async function runOneProofread() {
    if (proofreading || !proofreadEnabled()) return false
    const item = proofreadQueue.shift()
    if (item === undefined) return false

    // 太老了就不改了：屏幕上早换页了，改它既没人看、还白花一次调用。
    const age = Date.now() - item.at
    if (age > config.proofreadMaxAgeMs) {
      state.proofread.dropped += 1
      state.proofread.lastNote = '有一句等太久（' + Math.round(age) + 'ms），已放弃校对'
      return true
    }
    // 还没轮到就已经换屏幕了：直接丢弃，连模型都不用调（省一次调用）。
    if (state.displaySeq !== item.seq) {
      state.proofread.dropped += 1
      state.proofread.lastNote = '屏幕上已经不是这一句了，校对结果丢弃'
      return true
    }

    proofreading = true
    try {
      const llm = ctx.get('llm')
      const route = await resolveRoute(llm)
      if (route.ok !== true) {
        state.proofread.failed += 1
        state.proofread.lastNote = route.failure
        return true
      }
      state.callSeq += 1
      const messages = [{
        id: 'leion-p' + state.callSeq,
        role: 'user',
        content: [{ type: 'text', text: proofreadRequest(item) }],
        source: { kind: 'user' },
      }]
      // 刻意**不流式上屏**：校对要么整句替换，要么不动。
      // 边校边显只会让屏幕来回跳，反而更难读。
      const proofreadOptions = {
        provider: route.providerId,
        model: route.modelId,
        system: proofreadSystem(policy, item.from, item.to, state.terms.entries),
        messages,
        maxTokens: config.maxTokens,
        // 温度比翻译再低一点：校对要的是"稳定地判对错"，不是发挥。
        temperature: Math.min(config.temperature, 0.2),
      }
      // 与翻译同一套推理强度配置：不显式传的话，适配器默认 high 会拿思考 token 吃预算
      if (config.reasoningEffort !== '') proofreadOptions.reasoningEffort = config.reasoningEffort
      let result = await runStream(llm, proofreadOptions, undefined)
      if (result.ok !== true && config.reasoningEffort !== ''
        && /REASONING/i.test(String(result.failure))) {
        const retryOptions = { ...proofreadOptions }
        delete retryOptions.reasoningEffort
        result = await runStream(llm, retryOptions, undefined)
      }

      if (result.ok !== true) {
        state.proofread.failed += 1
        state.proofread.lastNote = '校对失败（已忽略，屏幕保持初译）：' + result.failure
        return true
      }
      state.proofread.settled += 1

      const correctedRaw = String(result.text).trim()
      // §14.6 的"最终裁决"：校对可能把我们归一好的写法又改回去，所以这里再过一遍。
      // 这不是重复劳动 —— 校对是**在归一之后**跑的，只有它有能力破坏归一结果。
      const renormalized = applyTerms(correctedRaw, item.to)
      await logTermsEvents(renormalized.events, 'proofread')
      const corrected = renormalized.text
      if (corrected === '' || corrected === item.draft) {
        state.proofread.same += 1       // 模型认为不用改 —— 这是正常且期望的结果
        return true
      }
      // 验收闸：这条"修正"值不值得上屏（见 revisionProblem 的说明）
      const problem = revisionProblem(item.draft, corrected, config.cols, config.lines)
      if (problem !== null) {
        state.proofread.rejected += 1
        state.proofread.lastNote = '校对结果没通过验收（保持初译）：' + problem
        console.log('[leion-pro] ✗ 校对结果不可用，已丢弃：' + problem)
        return true
      }
      // 回归闸：格式过关了，但内容有没有被改坏（丢数字 / 冒出葡葡说法）。
      // 两道闸分开是为了让日志说清"是格式不对还是内容改坏了" ——
      // 前者说明模型没守格式约定，后者说明它真的引入了错误，排查方向完全不同。
      // 只用 item.source（原文）与两版译文做本地比对，**不增加任何模型调用**。
      const regression = proofreadRegression(item.source, item.draft, corrected, policy)
      if (regression !== null) {
        state.proofread.rejected += 1
        state.proofread.lastNote = '校对把初译改坏了（保持初译）：' + regression
        console.log('[leion-pro] ✗ 校对结果改坏了内容，已丢弃：' + regression)
        return true
      }
      // ── 4b 强制执行闸（docs/15 §14.3 / §18.8）──────────────────────────
      // 校对提示词已经写明"专有名词不由你负责"，但**实测模型并不完全遵守**
      // （它仍会把 "óculos LLVision" 改成 "óculos Leion" 之类）。
      // 所以再加一道本地检查兜底：初稿里已经正确的规范写法，校对结果里不许消失 ——
      // 消失了说明它把名字改掉/删掉/换成别的写法了，这次校对结果**整条丢弃**。
      const nameProblem = proofreadKeptNames(
        item.draft, corrected, termEntries, String(item.to).toLowerCase().startsWith('zh'))
      if (nameProblem !== null) {
        state.proofread.rejected += 1
        state.proofread.lastNote = '校对动了专名（保持初译）：' + nameProblem
        console.log('[leion-pro] ✗ 校对动了专名，已丢弃：' + nameProblem)
        return true
      }
      // 最后一道闸：重新确认屏幕没变过（模型调用期间可能已经出了下一句）。
      if (state.displaySeq !== item.seq) {
        state.proofread.dropped += 1
        state.proofread.lastNote = '校对期间屏幕已换页，结果丢弃（不覆盖更新的字幕）'
        return true
      }

      // 热词观测（校对后重算）：校对可能把名字补对（那就不该再有提示），
      // 也可能把名字写坏。放在所有闸之后：只有真要上屏的那一版才值得提示。
      const correctedWatch = watchEnabled()
        ? detectTermsMiss(item.source, corrected, termEntries, item.from, item.to)
        : []
      await logTermsEvents(correctedWatch, 'proofread')

      const frame = buildFrame({ text: corrected, speaker: item.displaySpeaker, lang: item.to,
        // ⚠️ 必须带上**原文**。这是个真踩过的坑：这一行原本没传 source，于是修订帧的
        //    source 退化成译文本身，而手机端是**按原文认"这是同一条字幕"**的 ——
        //    结果"校对改正"到了屏幕上不是原地替换，而是**多出一行**
        //    （那一行的"原文"位置还会显示成译文）。它是合并两个分支时才暴露的：
        //    写校对那会儿，帧里还没有 source 这个字段。
        source: item.source, sourceLang: item.from,
        termsMiss: correctedWatch.map(event => ({ id: event.id, zh: event.zh })) })
      await sendRaw(frame)
      state.lastGoodFrame = frame
      // 历史里那一条要**替换**，不能追加 —— 否则双语历史会多出一条重复的话，
      // 而且"改过的那版"会留在记录里，看起来像说了两遍。
      const last = state.frames.length - 1
      if (last >= 0 && state.frames[last] === item.draftFrame) {
        state.frames[last] = frame
      } else {
        state.frames.push(frame)
        if (state.frames.length > HISTORY_CAP) state.frames.shift()
      }
      state.proofread.fixed += 1
      state.proofread.lastNote = '改了：' + item.draft + ' → ' + corrected
      console.log('[leion-pro] ✎ 校对改了：' + item.draft)
      console.log('[leion-pro]            → ' + corrected)
      return true
    } catch (error) {
      state.proofread.failed += 1
      state.proofread.lastNote = '校对抛异常（已忽略）：' + String(error && error.message ? error.message : error)
      return true
    } finally {
      proofreading = false
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 热词临时修正（方向一实验，docs/15 §18）
  //
  // 只在**观测到**"提到了名字、译文却没写出规范写法"之后才问模型：
  // "这个名字在这句里写成了什么？" —— 拿到片段后走 planRescue 的全部闸门，
  // 通过才把**那一小段**换成规范写法（不是让模型重写整句）。
  //
  // 三条约束（用户定的）：
  //   ① 不把"校对/下一帧把它改回来"当撤销依据：不监听、不撤销，先落地者生效，
  //      后到者按"过期"丢弃（displaySeq 变化 = 屏幕已经不是那一帧了，与"谁对"无关）；
  //   ② 绑定字幕帧与版本：结果回来时必须 displaySeq 未变 **且** lastFrame 还是当初那一帧；
  //   ③ 用户已经读到的错误无法完全消除影响 —— 只能把后续同一句的显示改对。
  // ───────────────────────────────────────────────────────────────────────────

  /** 热词临时修正的待办队列（只留最新一条：屏幕上的"最后一句"只有一条）。 */
  const rescueQueue = []
  let rescuing = false

  function rescueEnabled() {
    if (config.terms !== 'on' || config.termsWatch !== 'on' || config.termsRescue !== 'on') return false
    return state.terms.rescue.asked < config.termsRescueLimit
  }

  /** 把一句刚上屏的译文排进临时修正队列（只有观测到漏写时才会被调用）。 */
  function enqueueRescue(item) {
    if (rescueEnabled() === false) return false
    rescueQueue.length = 0          // 只有"最后一句"有意义，新的顶掉旧的
    rescueQueue.push(item)
    return true
  }

  /** 从模型回答里抽出片段（容忍引号/句号；NONE → null）。 */
  function parseRescueAnswer(raw) {
    let text = String(raw === undefined || raw === null ? '' : raw).trim()
    for (let pass = 0; pass < 4; pass += 1) {
      const before = text
      text = text
        .replace(/^['"“”`「『（(]+/, '')
        .replace(/[。.；;，,、!?！？]+$/, '')
        .replace(/['"“”`」』）)]+$/, '')
        .trim()
      if (text === before) break
    }
    if (text === '' || /^NONE$/i.test(text)) return null
    return text
  }

  /**
   * 把"这次学到的变体"追加到**待入表队列**（B 方案，docs/15 §18.2）。
   *
   * <p>插件**不写正式表**（那是 relay 的职责，避免和手机上传抢同一个文件）：
   * 只追加一行记录；relay 在启动 / 每场开始时把队列合并进 `terms.json`。
   * 追加方式只能"读全文 + 整体重写"（fs 服务没有 append），
   * 而 relay 合并前会先把文件**原子挪走**，所以并发时最多丢一条新增，不会写坏队列。
   */
  async function queuePendingLearn(entry, from, to) {
    if (config.termsPendingPath === '') return false
    const fs = ctx.get('fs')
    if (fs === undefined) return false
    try {
      const target = await fs.resolve(config.termsPendingPath)
      let old = ''
      try {
        old = await fs.readText(target)
      } catch {
        /* 第一次写：队列还不存在 */
      }
      const user = state.terms.user === null ? 'default' : state.terms.user
      // 去重：同一个（用户 + 中文名 + 候选变体）已经在队列里就不重复写。
      // 实测：同一句话反复说、或同一变体反复出现时，队列会一条条膨胀；
      // 而且合并时它们本来也会按"已登记"跳过，写了没意义。
      const alreadyQueued = old.split(/\r?\n/).some(line => {
        try {
          const record = JSON.parse(line)
          return record !== null && record.event === 'pending' && record.user === user
            && record.zh === entry.zh && record.candidate === from
        } catch {
          return false
        }
      })
      if (alreadyQueued) return false
      const line = JSON.stringify({
        t: new Date().toISOString(),
        event: 'pending',
        user,
        zh: entry.zh,
        candidate: from,
        canonical: to,
      })
      await fs.writeText(target, (old === '' ? '' : old.replace(/\n*$/, '\n')) + line + '\n')
      console.log('[leion-pro] + 待入表：' + entry.zh + ' ← ' + from)
      return true
    } catch (error) {
      state.terms.lastNote = '待入表写入失败（已忽略）：' + String(error && error.message ? error.message : error)
      return false
    }
  }

  /**
   * 做一次临时修正。返回是否真的做了（调用方据此决定要不要继续。
   *
   * 与 `runOneProofread` 一样只在**空闲**时调用；一次只做一个。
   */
  async function runOneRescue() {
    if (rescuing || rescueEnabled() === false) return false
    const item = rescueQueue.shift()
    if (item === undefined) return false
    // 太老 / 已经不是那一帧：直接丢（与"谁对"无关，纯粹是过期）
    if (Date.now() - item.at > config.termsRescueMaxAgeMs
      || state.displaySeq !== item.seq || state.lastFrame !== item.draftFrame) {
      state.terms.rescue.dropped += 1
      state.terms.rescue.lastNote = '结果回来时屏幕已不是那一句，丢弃'
      console.log('[leion-pro] – 术语修正丢弃（' + item.entry.zh + '）：屏幕已不是那一句')
      return true
    }

    rescuing = true
    try {
      const llm = ctx.get('llm')
      const route = await resolveRoute(llm)
      if (route.ok !== true) {
        state.terms.rescue.failed += 1
        state.terms.rescue.lastNote = route.failure
        console.log('[leion-pro] – 术语修正失败：' + route.failure)
        return true
      }
      state.callSeq += 1
      const targetZh = String(item.to).toLowerCase().startsWith('zh')
      const canonical = targetZh ? item.entry.zh : item.entry.pt
      const system = '你在做术语片段核对。只输出片段本身或 NONE，不要解释。'
      const prompt = [
        item.to && targetZh ? '下面是一句葡语和它的中文译文。' : '下面是一句中文和它的葡语译文。',
        '',
        '原文：' + item.source,
        '译文：' + item.draft,
        '要核对的名字：' + item.entry.zh + '（规范写法：' + canonical + '）',
        '',
        '请找出译文里实际写这个名字的那一段文字（原样抄写，含冠词也可以）。',
        '注意：译文里可能用的是**音译、意译、缩写或全称**，和规范写法长得完全不一样 ——',
        '只要那段文字**指的就是这个名字**（例如「亮亮眼镜」被写成 "óculos Liangliang"，',
        '真正指代它的片段是 "Liangliang"），就交出那一段。',
        '只输出那段文字本身：不要解释、不要引号、不要加"译文里写的是"之类的前缀；',
        '只有译文里**完全没有任何词指代它**、或只剩"这家公司/这些眼镜"这类纯泛称时，才回答 NONE。',
      ].join('\n')
      const messages = [{
        id: 'leion-r' + state.callSeq,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }]
      const streamOptions = {
        provider: route.providerId,
        model: route.modelId,
        system,
        messages,
        // 实测两连击：① 40 个 token 太小 → 撞上限；② 更大也不够，因为**没传推理强度**，
        //    DeepSeek 适配器默认 high，思考 token 直接把预算吃光（finish=max-tokens）。
        //    所以这里：显式传 reasoningEffort（与翻译同一套配置；默认 'off'）+ 给到 600。
        maxTokens: 600,
        temperature: 0,
      }
      if (config.reasoningEffort !== '') streamOptions.reasoningEffort = config.reasoningEffort
      let result = await runStream(llm, streamOptions, undefined)
      // 有的路由不接受显式推理强度（UNSUPPORTED_REASONING_EFFORT）：去掉它重试一次
      if (result.ok !== true && config.reasoningEffort !== ''
        && /REASONING/i.test(String(result.failure))) {
        const retryOptions = { ...streamOptions }
        delete retryOptions.reasoningEffort
        result = await runStream(llm, retryOptions, undefined)
      }
      if (result.ok !== true) {
        state.terms.rescue.failed += 1
        state.terms.rescue.lastNote = '临时修正失败（已忽略）：' + result.failure
        const partial = typeof result.partial === 'string' && result.partial !== ''
          ? '（已收到的开头：' + result.partial.slice(0, 30) + '…）'
          : ''
        console.log('[leion-pro] – 术语修正失败：' + result.failure + partial)
        return true
      }
      state.terms.rescue.asked += 1
      const answer = parseRescueAnswer(result.text)
      if (answer === null) {
        state.terms.rescue.rejected += 1
        state.terms.rescue.lastNote = '回答 NONE（没有可替换的片段）'
        console.log('[leion-pro] – 术语修正未采纳：模型回答 NONE（没有可替换的片段）')
        return true
      }
      const plan = planRescue({
        draft: item.draft,
        answer,
        canonical,
        entries: termEntries,
        targetZh,
        cols: config.cols,
        lines: config.lines,
      })
      if (plan.ok !== true) {
        state.terms.rescue.rejected += 1
        state.terms.rescue.lastNote = '临时修正被闸门拒绝：' + plan.reason
        // ⚠️ 拒绝必须**说出来**（这是实测反馈：拒绝时什么都不打，用户只看到
        //    "开了开关却什么都没发生"，会以为是开关没生效或代码坏了）。
        console.log('[leion-pro] – 术语修正未采纳（' + item.entry.zh + '）：' + plan.reason)
        return true
      }
      // 关键：模型调用回来后**再**确认一次屏幕（调用期间可能已经出了下一句）。
      if (state.displaySeq !== item.seq || state.lastFrame !== item.draftFrame) {
        state.terms.rescue.dropped += 1
        state.terms.rescue.lastNote = '修正期间屏幕已换页，丢弃（避免修错对象）'
        console.log('[leion-pro] – 术语修正丢弃（' + item.entry.zh + '）：修正期间屏幕已换页')
        return true
      }
      await logTermsEvents([{ event: 'rescue', id: item.entry.id, from: plan.from, to: plan.to }], 'final')
      const frame = buildFrame({
        text: plan.text, speaker: item.speaker, lang: item.to,
        source: item.source, sourceLang: item.from,
      })
      await sendRaw(frame)
      state.lastGoodFrame = frame
      const last = state.frames.length - 1
      if (last >= 0 && state.frames[last] === item.draftFrame) {
        state.frames[last] = frame
      } else {
        state.frames.push(frame)
        if (state.frames.length > HISTORY_CAP) state.frames.shift()
      }
      state.terms.rescue.applied += 1
      state.terms.rescue.lastNote = '改了：' + plan.from + ' → ' + plan.to
      console.log('[leion-pro] ✎ 术语修正：' + plan.from + ' → ' + plan.to)
      // B 方案：本场已改对；同时把"这次学到的变体"追加到待入表队列，
      // relay 在下一场开始前合并进正式表 —— 这样下一场不靠模型也知道怎么写。
      await queuePendingLearn(item.entry, plan.from, plan.to)
      return true
    } catch (error) {
      state.terms.rescue.failed += 1
      state.terms.rescue.lastNote = '临时修正抛异常（已忽略）：' + String(error && error.message ? error.message : error)
      return true
    } finally {
      rescuing = false
    }
  }

  /** 解析要用的 provider / model 路由，解析不出来时给出能照着做的报错。 */
  async function resolveRoute(llm) {
    const providers = llm.listProviders()
    if (!providers || providers.length === 0) {
      return { ok: false, failure: '当前没有任何已注册的 LLM provider，翻译无法进行' }
    }
    const providerId = config.providerId !== '' ? config.providerId : providers[0].id
    if (!providers.some(p => p.id === providerId)) {
      return {
        ok: false,
        failure: 'providerId="' + providerId + '" 不在已注册路由里：' + providers.map(p => p.id).join(', '),
      }
    }
    let modelId = config.modelId
    if (modelId === '') {
      try {
        const models = await llm.listModels(providerId)
        const first = models && models.length > 0 ? models[0] : undefined
        if (first !== undefined) modelId = first.id !== undefined ? first.id : first.model
      } catch (error) {
        return { ok: false, failure: '自动发现模型失败：' + String(error && error.message ? error.message : error) }
      }
    }
    if (modelId === undefined || modelId === '') {
      return { ok: false, failure: '拿不到模型 id。请把 config.modelId 显式写成你要用的模型名。' }
    }
    return { ok: true, providerId, modelId }
  }

  /**
   * 把 finish 分片的"原因"归一化成 { kind, failure }。
   *
   * ⚠️ 真实形状是**对象**，不是字符串（packages/llm/llm/src/types.ts 的 FinishReasonMap）：
   *     { kind: 'stop' } / { kind: 'tool-calls' } / { kind: 'max-tokens' }
   *     { kind: 'aborted' | 'error', failure: LlmFailure }
   * 而 failure 挂在 **reason 上**，不在 chunk 上。
   * 早期版本把它当字符串比对，于是每一句正确译文都被当成"流没正常结束"丢掉了。
   */
  function readFinish(reason, chunk) {
    if (reason === null || reason === undefined) return { kind: null, failure: null }
    // 宽容：万一某个适配器直接给字符串
    if (typeof reason === 'string') return { kind: reason, failure: chunk.failure ?? null }
    const failure = reason.failure ?? chunk.failure ?? null
    return { kind: typeof reason.kind === 'string' ? reason.kind : null, failure }
  }

  /** 把 LlmFailure 渲染成一行可读文本。 */
  function describeFailure(failure) {
    if (failure === null || failure === undefined) return ''
    if (typeof failure === 'string') return failure
    const code = failure.code === undefined || failure.code === null ? '' : String(failure.code)
    const message = failure.message === undefined || failure.message === null ? '' : String(failure.message)
    if (code !== '' && message !== '') return code + '：' + message
    return code !== '' ? code : message
  }

  /** 跑一次模型流（不含重试策略），把碎片拼成一句译文。 */
  async function runStream(llm, options, onDelta) {
    let assembled = ''
    let finishKind = null
    let finishFailure = null
    let lastEmit = 0

    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') {
        assembled += chunk.text
        if (onDelta !== undefined) {
          const now = Date.now()
          if (now - lastEmit >= config.partialThrottleMs) {
            lastEmit = now
            await onDelta(assembled.replace(/\s+$/, ''))
          }
        }
      } else if (chunk.type === 'finish') {
        const parsed = readFinish(chunk.reason, chunk)
        finishKind = parsed.kind
        finishFailure = parsed.failure
      }
    }

    const finalText = assembled.trim()
    // 没有 finish 分片时按 'stop' 处理 —— 与 harness 自己的 BlockAssembler 一致
    // （assembler.ts：`return this._finish ?? { kind: 'stop' }`）。
    if (finishKind === null) finishKind = 'stop'

    if (finishKind !== 'stop') {
      const detail = describeFailure(finishFailure)
      return {
        ok: false,
        failure: '模型流没有正常结束（finish=' + finishKind + (detail === '' ? '' : '，' + detail) + '），已丢弃可能不完整的译文',
        partial: finalText,
      }
    }
    if (finalText === '') return { ok: false, failure: '模型返回了空译文' }
    return { ok: true, text: finalText }
  }

  /**
   * 流式翻译一段话。
   * @param onDelta 每收到一段增量就回调（已按 partialThrottleMs 节流），用于「边说边显」。
   */
  async function streamTranslation(llm, text, from, to, onDelta, termsHint) {
    const route = await resolveRoute(llm)
    if (route.ok !== true) return { ok: false, failure: route.failure }

    state.callSeq += 1
    // 手搓 Message：沙箱里拿不到 @deepseek-ai/dsh-llm 的构造函数。
    // Message 是纯数据接口 { id, role, content, source }，MessageId 运行期就是字符串。
    const messages = [{
      id: 'leion-t' + state.callSeq,
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'user' },
    }]

    const base = {
      provider: route.providerId,
      model: route.modelId,
      system: translationSystem(policy, from, to, termsHint),
      messages,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    }

    const first = await runStream(llm, config.reasoningEffort === ''
      ? base
      : Object.assign({ reasoningEffort: config.reasoningEffort }, base), onDelta)

    // 有的路由不接受显式推理强度（会以 UNSUPPORTED_REASONING_EFFORT 失败）。
    // 那就去掉它重试一次 —— 重试不再逐段上屏，免得把增量推两遍。
    if (first.ok !== true && config.reasoningEffort !== '' && /REASONING/i.test(String(first.failure))) {
      const retry = await runStream(llm, base, undefined)
      if (retry.ok === true) return Object.assign({ retriedWithoutEffort: true }, retry)
      return retry
    }

    return first.ok === true
      ? Object.assign({ provider: route.providerId, model: route.modelId }, first)
      : first
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ASR 收件箱：让同传在没有 agent 介入的情况下自动跑
  //
  // 外部语音识别程序（厂商 App / 本地 Whisper / ASR 云）把文本按行追加到 inboxPath，
  // 插件用真实 timer 服务轮询它：每读到「以换行结束」的完整行就翻译并推字幕。
  // 只处理到最后一个换行为止 —— 半行不算，避免把写了一半的 JSON 当成一句话。
  // ───────────────────────────────────────────────────────────────────────────
  const inbox = {
    running: false,
    stopWatcher: null,
    consumed: 0,
    processed: 0,
    errors: 0,
    startedAt: null,
    lastLine: null,
    lastError: null,
  }
  const queue = []
  let pumping = false
  /** 由 api.translate 填充：收件箱要复用的就是那条翻译管线。 */
  let runTranslate = null

  /** 一行可以是纯文本，也可以是 {"text":...,"from":...,"to":...}。 */
  function parseInboxLine(raw) {
    const line = raw.trim()
    if (line === '') return null
    if (!line.startsWith('{')) return { text: line }
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new Error('不是合法 JSON：' + String(error && error.message ? error.message : error))
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.text !== 'string') {
      throw new Error('JSON 行必须包含字符串字段 text')
    }
    if (parsed.speaker !== undefined && parsed.speaker !== 'them' && parsed.speaker !== 'me') {
      throw new Error("speaker 只能是 'them' / 'me' 或省略")
    }
    return {
      text: parsed.text,
      from: typeof parsed.from === 'string' ? parsed.from : undefined,
      to: typeof parsed.to === 'string' ? parsed.to : undefined,
      // speaker 只有 translator: 'none'（纯显示通道）时才用得上：那种模式下
      // 插件不做语向判定，帧归属于谁必须由写入方告知。
      speaker: typeof parsed.speaker === 'string' ? parsed.speaker : undefined,
    }
  }

  /** 读一次收件箱，把已完整的行排进队列。 */
  async function readInbox() {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('收件箱需要 fs 服务，但当前 ctx 里没有')
    const target = await fs.resolve(config.inboxPath)
    const info = await fs.stat(target)
    if (info === undefined) return { added: 0, note: '收件箱文件还不存在（等外部 ASR 创建）' }
    const text = await fs.readText(target)
    // 文件被截断或轮转过：从头重新读，而不是永远卡在旧偏移上。
    if (text.length < inbox.consumed) inbox.consumed = 0
    const pending = text.slice(inbox.consumed)
    const lastBreak = pending.lastIndexOf('\n')
    if (lastBreak < 0) return { added: 0, note: '还没有以换行结束的完整行' }
    const complete = pending.slice(0, lastBreak + 1)
    inbox.consumed += complete.length

    let added = 0
    for (const raw of complete.split('\n')) {
      if (raw.trim() === '') continue
      try {
        const item = parseInboxLine(raw)
        if (item === null) continue
        // 配置里强制了源语种就补上（ASR 已知语种时能避免自动判定出错）。
        if (item.from === undefined && config.inboxFrom !== '') item.from = config.inboxFrom
        queue.push(item)
        added += 1
      } catch (error) {
        // 坏行只计数、不中断：一条写坏的 JSON 不该让整条同传停摆。
        inbox.errors += 1
        inbox.lastError = '解析失败：' + String(error && error.message ? error.message : error)
      }
    }
    return { added }
  }

  /**
   * 读"这个房间的听众各自读哪种语言"（5.00）。
   *
   * <p>由 relay 写在 `<data-dir>/room-langs/<房间>.json`（`{ langs: [...], byUser: {...} }`），
   * 内容等于 `room_members.lang` 去重。读不到就返回空数组 —— 那时按 `opposite(源语言)` 兜底，
   * 也就是**老行为**（中↔葡互译），不会因为"读不到文件"而突然不译。
   *
   * <p>为什么每次都读：成员进出、改语言都可能在两句之间发生，而这份文件的写入是
   * relay 在"变化时"才做的，读取代价只有一次 stat + 小 JSON 解析。
   */
  async function readListenerLangs() {
    if (config.hearLangsPath === '') return []
    try {
      const text = await fs.readText(config.hearLangsPath)
      const parsed = JSON.parse(text)
      return Array.isArray(parsed?.langs) ? parsed.langs.map(item => String(item)) : []
    } catch {
      // 文件还不存在（第一句）或写了一半：都当"没有登记"，走老行为
      return []
    }
  }

  /** 串行处理队列：同传不能并发，否则字幕会互相穿插。 */
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0) {
        const item = queue.shift()
        inbox.lastLine = item.text
        const args = { text: item.text }
        if (item.from !== undefined) args.from = item.from
        if (item.to !== undefined) args.to = item.to
        // ── 5.00：一句话可能要译成**几种**语言 ──────────────────────────────
        // 依据是"这个房间的听众各自读哪种语言"（relay 写的侧车，等于成员 lang 去重）。
        // 两个听众同语言 → 只译一份；不同语言 → 译两份（最多两份：三种语言、源语言占一种）。
        // 显式给了 to（工具调用 / 会议覆盖值）就只译那一种，行为与 4.100 一致。
        const targets = args.to !== undefined && args.to !== ''
          ? [args.to]
          : resolveTargets(item.from === undefined ? detectLang(item.text) : item.from,
            config.targetLang, await readListenerLangs()).targets
        if (targets.length === 0) {
          // 所有人读的都是源语言（或判不出方向）：**不译**。不产出任何帧，
          // 也不计错误 —— 这不是失败，是"这句话不需要翻译"。
          inbox.processed += 1
          console.log('[leion-pro] 跳过翻译（不需要任何译文）：' + item.text)
          continue
        }
        // 多个目标**并行**翻译：串行会让第二份语言多等一整次调用（字幕慢一倍）。
        // 顺序性由"每个目标只有一次调用"保证，不需要额外串行。
        const results = await Promise.all(targets.map((target, index) => {
          const one = { text: item.text, to: target }
          if (item.from !== undefined) one.from = item.from
          // 校对只对**主目标**（第一份）做：翻倍花钱只改个别字，而第二份语言通常只有一个人在看。
          if (index > 0) one.noProofread = true
          return runTranslate(one)
        }))
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]
          if (result.ok === true) {
            inbox.processed += 1
            // 自动同传这条路上没有人在看工具的返回值，所以把每一句打进日志 ——
            // 否则 transport 配成 'file' 时，整个 daemon 是完全静默的，出问题只能靠猜。
            console.log('[leion-pro] ' + result.from + '→' + result.to + '  ' + result.translation)
          } else {
            inbox.errors += 1
            inbox.lastError = result.failure
            // 失败必须说出来：静默的 daemon 是最难排查的东西。
            console.log('[leion-pro] ✗ 翻译失败（' + targets[index] + '）：' + result.failure)
            if (result.partial !== null && result.partial !== undefined && result.partial !== '') {
              console.log('[leion-pro]   半截译文（已丢弃）：' + result.partial)
            }
          }
        }
      }
    } catch (error) {
      inbox.errors += 1
      inbox.lastError = String(error && error.message ? error.message : error)
      console.log('[leion-pro] ✗ 处理收件箱时抛异常：' + inbox.lastError)
    } finally {
      pumping = false
    }
  }

  function startWatcher() {
    if (inbox.running) return
    if (config.inboxPath === '') {
      throw new Error("未配置 inboxPath，收件箱无法启动（在 cordis.yml 的 config 里设置，或改 CONFIG_OVERRIDE）")
    }
    // ⚠️ 相对路径**实测会静默失效**：继电器照样往文件里写，插件这边读不到，
    //    既不报错也不出字幕，看上去像"翻译坏了"。所以这里直接拒绝，
    //    并把话说到能照着改（由调用方 catch 后记进 lastError + 打日志）。
    if (!looksAbsolutePath(config.inboxPath)) {
      throw new Error('inboxPath 必须是**绝对路径**，收到 ' + JSON.stringify(config.inboxPath)
        + '。相对路径会让收件箱静默读不到（继电器在写、插件读不到、还不报错）—— '
        + '用绝对路径，或在启动脚本里把 --data-dir 解析成绝对路径（scripts/start-all.mjs 已经这么做了）')
    }
    inbox.stopWatcher = ctx.interval(() => {
      void (async () => {
        try {
          await readInbox()
        } catch (error) {
          inbox.errors += 1
          inbox.lastError = String(error && error.message ? error.message : error)
        }
        await pump()
        // ── 校对只在这里做（第二遍）──────────────────────────────────────────
        // 位置是刻意的：pump() 已经返回，说明队列空了、没有翻译在跑 ——
        // 也就是说**现在这段时间本来就是闲着等的**。
        // 放到这里，校对既不占"下一句的初译"，也不会和翻译抢模型。
        // 一次只做一个（proofreading 标志在 runOneProofread 里管）。
        if (queue.length === 0 && !state.translating) {
          await runOneProofread()
          // 临时修正与校对同一个空闲窗口：都不占"下一句的初译"。
          // 两者不会互相撤销 —— 先落地的那个生效，后到的按"过期"丢弃（docs/15 §18）。
          await runOneRescue()
        }
      })()
    }, config.inboxPollMs)
    inbox.running = true
    inbox.startedAt = new Date().toISOString()
  }

  function stopWatcher() {
    if (inbox.stopWatcher !== null) {
      inbox.stopWatcher()
      inbox.stopWatcher = null
    }
    inbox.running = false
  }

  const inboxApi = {
    status() {
      return {
        configured: config.inboxPath !== '',
        running: inbox.running,
        path: config.inboxPath,
        pollMs: config.inboxPollMs,
        forcedFrom: config.inboxFrom === '' ? null : config.inboxFrom,
        consumedChars: inbox.consumed,
        processed: inbox.processed,
        errors: inbox.errors,
        queued: queue.length,
        startedAt: inbox.startedAt,
        lastLine: inbox.lastLine,
        lastError: inbox.lastError,
        // 校对的运行状态（关着时是 null）：调用方一眼能看出"第二遍"有没有在跑、
        // 改了几次、丢了几次（丢 = 屏幕上已经换页，主动放弃覆盖）。
        proofread: proofreadWanted() === false
          ? null
          : Object.assign({ mode: config.proofread, runtime: runtimeProofread,
            pending: proofreadQueue.length, inFlight: proofreading }, state.proofread),
        terms: Object.assign({ mode: config.terms }, state.terms),
      }
    },
    start() {
      startWatcher()
      return this.status()
    },
    stop() {
      stopWatcher()
      return this.status()
    },
    /** 立刻读一次并把可用行处理完，不依赖轮询。 */
    async drain() {
      const read = await readInbox()
      await pump()
      return Object.assign(
        { read: read.added, note: read.note === undefined ? null : read.note },
        this.status(),
      )
    },
    /** 消费位置归零：下次从文件开头重读（演示时重放同一段很有用）。 */
    reset() {
      inbox.consumed = 0
      return this.status()
    },
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 翻译后端接缝
  //
  // 这是"翻译放在哪一层"的开关。三种实现都只要满足同一个契约：
  //     translate({ text, from, to, onDelta }) → { ok, text, failure?, ... }
  // 上层（收件箱 / 工具）完全不知道译文是谁产出的。
  //
  // 之所以要这个接缝：现在译文来自电脑上的 harness + 云端模型；将来可能搬到手机端
  // 甚至眼镜端。搬的时候只换这一个后端，上面的语向判定、排版、字幕纪律一行不动。
  // ───────────────────────────────────────────────────────────────────────────

  /** POST 到外部翻译端点。端侧模型只要暴露这样一个 http 服务就能接进来。 */
  async function translateViaHttp(args) {
    let timer = null
    try {
      if (typeof fetch !== 'function') {
        return { ok: false, failure: 'translator "http" 需要 fetch，但这个运行环境里没有' }
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      // 注意：动态插件沙箱里 setTimeout 是"调用即抛"的陷阱，所以整段都包在 try 里。
      if (controller !== null) {
        timer = setTimeout(() => controller.abort(), config.translatorTimeoutMs)
      }
      const response = await fetch(config.translatorUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: String(args.text), from: args.from, to: args.to }),
        ...(controller === null ? {} : { signal: controller.signal }),
      })
      const raw = await response.text()
      if (response.ok !== true) {
        return { ok: false, failure: 'HTTP 翻译端点返回 ' + response.status + '：' + raw.slice(0, 200) }
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { ok: false, failure: 'HTTP 翻译端点没返回 JSON：' + raw.slice(0, 200) }
      }
      const text = typeof parsed.text === 'string' ? parsed.text
        : typeof parsed.translation === 'string' ? parsed.translation
          : null
      if (text === null) {
        return { ok: false, failure: 'HTTP 翻译端点返回的 JSON 里既没有 text 也没有 translation：' + raw.slice(0, 200) }
      }
      const trimmed = text.trim()
      if (trimmed === '') return { ok: false, failure: 'HTTP 翻译端点返回了空译文' }
      return { ok: true, text: trimmed, provider: 'http', model: config.translatorUrl }
    } catch (error) {
      const aborted = error !== null && typeof error === 'object' && error.name === 'AbortError'
      return {
        ok: false,
        failure: aborted
          ? 'HTTP 翻译端点超时（' + config.translatorTimeoutMs + 'ms）'
          : 'HTTP 翻译端点失败：' + String(error && error.message ? error.message : error),
      }
    } finally {
      if (timer !== null) {
        try {
          clearTimeout(timer)
        } catch {
          // 沙箱里 clearTimeout 也是陷阱；这里没有别的办法，忽略即可
        }
      }
    }
  }

  const translator = (() => {
    if (config.translator === 'none') {
      return {
        kind: 'none',
        describe: () => '不翻译（收件箱里的文字就是最终字幕）',
        async translate(args) {
          // 直通：原文即字幕。语向不参与，因为压根没有翻译这一步。
          return { ok: true, skipped: true, text: String(args.text).trim() }
        },
      }
    }
    if (config.translator === 'http') {
      return {
        kind: 'http',
        describe: () => 'HTTP 翻译端点 ' + config.translatorUrl,
        async translate(args) {
          return await translateViaHttp(args)
        },
      }
    }
    return {
      kind: 'harness-llm',
      describe: () => 'harness 的模型服务（ctx.llm）',
      async translate(args) {
        const llm = ctx.get('llm')
        if (llm === undefined) {
          return {
            ok: false,
            failure: 'ctx 里没有 llm 服务。三个办法：把 config.translator 设成 '
              + "'http'（用外部翻译端点）或 'none'（本部署不做翻译，收件箱文字直接当字幕）；"
              + '或者用 leion_display 自己翻译后推送',
          }
        }
        return await streamTranslation(llm, args.text, args.from, args.to, args.onDelta,
          termsHintFor(args.text, args.from))
      },
    }
  })()

  const api = {
    config,
    device: DEVICE,
    transport,
    state,

    status() {
      return {
        device: DEVICE.model,
        vendor: DEVICE.vendor,
        aliases: DEVICE.aliases,
        panel: DEVICE.panel,
        transport: transport.kind,
        transportDetail: transport.detail,
        cols: config.cols,
        lines: config.lines,
        pushes: state.pushes,
        historyCount: state.frames.length,
        partials: state.partials,
        errors: state.errors,
        restored: state.restored,
        lastError: state.lastError,
        lastFrame: state.lastFrame,
      }
    },

    /** 直接推送一段已定稿文本（不翻译）。 */
    async display(args) {
      const frame = buildFrame(args)
      await pushFrame(frame)
      return {
        speaker: frame.speaker,
        lang: frame.lang,
        lines: frame.lines,
        pushedAt: frame.at,
        preview: drawFrame(frame, config.cols),
      }
    },

    /**
     * 双向同传主操作：判语向 → 翻译（走后端接缝）→ 排版 → 推送。
     *
     * translator 为 'none' 时走纯显示分支：不做语向判定、不调任何模型，
     * 收件箱里的文字就是最终字幕（翻译已在别处完成）。
     */
    async translate(args) {
      const source = String(args.text)

      if (translator.kind === 'none') {
        // 纯显示通道：谁说的话由调用方给出（缺省"对方"），语种按文字自动判定。
        const lang = args.from !== undefined && args.from !== '' ? args.from : detectLang(source)
        const frame = buildFrame({
          text: source,
          speaker: args.speaker === undefined || args.speaker === '' ? 'them' : args.speaker,
          lang: lang === 'unknown' ? 'unknown' : lang,
        })
        await pushFrame(frame)
        return {
          ok: true,
          translated: false,
          from: lang,
          to: lang,
          source,
          translation: source,
          displaySpeaker: frame.speaker,
          model: '(不翻译)',
          forced: false,
          preview: drawFrame(frame, config.cols),
          outbound: null,
        }
      }

      const from = args.from !== undefined && args.from !== '' ? args.from : detectLang(source)
      if (from === 'unknown') {
        return { ok: false, failure: '判不出源语种。请显式传 from（zh-CN / pt-BR / en-US）' }
      }
      // 5.00：三种语言并存时**不能靠"对面"猜目标**。优先级：
      //   这一句显式给的 to → 这场会配置的目标语言（config.targetLang，来自 rooms.target_lang）
      //   → 兜底 opposite(from)（老行为：中↔葡互译）
      const resolved = resolveTarget(from, args.to, config.targetLang)
      const to = resolved.target
      if (to === '') {
        return { ok: false, failure: '目标语种无法推导：请显式传 to，或给这场会配一个目标语言' }
      }
      if (to === from) {
        // 源和目标相同 = 这一句不需要翻译。如实拒绝，而不是"译"出一份同语言的假字幕。
        return { ok: false, failure: `源语种与目标语种相同（都是 ${from}），这一句不需要翻译` }
      }

      // 佩戴者读的那一帧：永远是译成佩戴者母语（中文）的那一侧。
      const wearerReadsTranslation = to === ZH
      const displaySpeaker = wearerReadsTranslation ? 'them' : 'me'

      // 先确保热词表已载入（每场只读一次）。放在这里而不是更早：
      // 它只依赖文件，读失败也只是"没有表"，不影响这次翻译。
      await refreshTerms()
      state.translating = true
      let partialsPushed = 0
      const result = await translator.translate({
        text: source,
        from,
        to,
        onDelta: async partial => {
          if (partial === '') return
          state.partials += 1
          partialsPushed += 1
        const frame = buildFrame({ text: partial, speaker: displaySpeaker, lang: to,
          source, sourceLang: from, partial: true })
        try {
          // 增量只上屏、不进双语历史：历史是「现场说过什么」的记录，
          // 把「正在成形」的碎片写进去会污染它。
          await sendRaw(frame)
        } catch (error) {
          state.lastError = String(error && error.message ? error.message : error)
        }
        },
      })
      state.translating = false

      if (result.ok !== true) {
        // 半截译文不能留在眼镜上。翻译失败时，把屏幕恢复成上一帧可用的字幕
        // （没有就清屏）—— 让佩戴者继续看到上一句，而不是一个碎片。
        if (partialsPushed > 0) {
          const fallback = state.lastGoodFrame !== null
            ? state.lastGoodFrame
            : buildFrame({ text: '', speaker: displaySpeaker, lang: to })
          try {
            await sendRaw(fallback)
            state.restored += 1
          } catch (error) {
            state.lastError = String(error && error.message ? error.message : error)
          }
        }
        return {
          ok: false,
          failure: result.failure,
          partial: result.partial === undefined ? null : result.partial,
          restoredDisplay: partialsPushed > 0,
        }
      }

      // ★ 热词归一：**译文出来后、上屏之前**做一次（docs/15 §7.1 / §14.6）
      //   零模型调用、纯字符串；没有表或开关关着时原样返回（行为逐字不变）。
      const normalized = applyTerms(result.text, to)
      await logTermsEvents(normalized.events, 'final')
      // ★ 热词观测（docs/15 §17）：提到了名字、译文却没写出规范写法 → 记一笔（不改字幕）。
      //   它回答的是"这句话有没有问题"，不回答"写成了什么"（那由离线候选发现去问模型）。
      const missed = watchEnabled()
        ? detectTermsMiss(source, normalized.text, termEntries, from, to)
        : []
      await logTermsEvents(missed, 'final')
      const finalFrame = buildFrame({ text: normalized.text, speaker: displaySpeaker, lang: to,
        source, sourceLang: from,
        termsMiss: missed.map(event => ({ id: event.id, zh: event.zh })) })
      await pushFrame(finalFrame)

      // ── 排进「校对」队列（第二遍）────────────────────────────────────────
      // 顺序有讲究：先取上一句当上下文，再把这一句记进 recent。
      // 上下文只在与本句**同向**时才给 —— 语向来回切时，上一句的译文是另一种语言，
      // 塞给模型只会把它带偏。
      const previous = state.recent.length > 0 ? state.recent[state.recent.length - 1] : null
      // 排进校对队列之前读一次手机侧开关与热词表（每场只读一次；读不到就按配置走）。
      // 放在这个位置而不是开头：翻译本身不该因为这个文件读失败而多等一拍。
      await refreshRuntimeSettings()
      await refreshTerms()
      // 5.00：第二份语言**不排校对** —— 校对会翻倍花钱而只改个别字，而第二份语言通常
      // 只有一个人在看；主目标那一份照旧校对（保留"回头改错"的能力）。
      if (args.noProofread !== true) enqueueProofread({
        source,
        from,
        to,
        draft: normalized.text,
        displaySpeaker,
        draftFrame: finalFrame,
        // 记下"此刻屏幕的版本号"：等真轮到时用它确认这一句还在屏幕上（见 state.displaySeq）
        seq: state.displaySeq,
        at: Date.now(),
        context: previous !== null && previous.to === to ? previous : null,
      })
      // ★ 热词临时修正（方向一实验，docs/15 §18）：只有**观测到漏写**时才排队；
      //   空闲时问一次"这个名字写成了什么"，通过闸门才把那一小段换成规范写法。
      if (missed.length > 0 && rescueEnabled()) {
        const entry = termEntries.find(candidate => candidate.id === missed[0].id)
        if (entry !== undefined) {
          enqueueRescue({
            source,
            from,
            to,
            draft: normalized.text,
            draftFrame: finalFrame,
            seq: state.displaySeq,
            at: Date.now(),
            speaker: displaySpeaker,
            entry,
          })
        }
      }
      state.recent.push({ source, translation: normalized.text, to })
      if (state.recent.length > 4) state.recent.shift()

      return {
        ok: true,
        from,
        to,
        source,
        translation: normalized.text,
        displaySpeaker,
        model: result.provider + '/' + result.model,
        forced: args.from !== undefined || args.to !== undefined,
        preview: drawFrame(finalFrame, config.cols),
        // 校对开着时把它的计数一并给出（拷贝一份：这是即时快照，不是活引用）。
        // 输出外壳是 additionalProperties: true，所以加字段不会破坏 schema 校验。
        proofread: proofreadWanted() === false ? null : Object.assign({}, state.proofread),
        // 热词归一：用了几条表、替换/命中/边界跳过各几次（手机端与日志都看它）
        terms: Object.assign({ mode: config.terms }, state.terms),
        terms: Object.assign({ mode: config.terms }, state.terms),
        outbound: to === PT
          ? {
            channel: 'counterpart',
            lang: PT,
            text: result.text,
            note: '这段是给对方听的，需要 TTS 或第二块屏；眼镜上只做了回显确认',
          }
          : null,
      }
    },

    history(args) {
      const limit = args.limit === undefined ? 10 : Math.max(1, Math.min(HISTORY_CAP, Number(args.limit)))
      return state.frames.slice(Math.max(0, state.frames.length - limit))
    },

    async clear() {
      const cleared = state.frames.length
      state.frames.length = 0
      // 清屏之后就没有「上一帧可用字幕」了，否则失败的翻译会把清屏前的旧句子还原回来。
      state.lastGoodFrame = null
      const blank = buildFrame({ text: '', speaker: 'them', lang: 'none' })
      await sendRaw(blank)
      return { clearedHistory: cleared }
    },

    /** 自检：四条链路各自的真实状态，一次说清「哪一段断了」。 */
    async selftest() {
      const notes = []
      const sample = 'Bom dia! 我们今天的会议改到下午三点，会议室在十二楼。'
      const lines = fitSubtitle(sample, config.cols, config.lines)
      const layout = lines.length <= config.lines
        && lines.every(l => [...l].reduce((n, ch) => n + charCols(ch), 0) <= config.cols)

      let transportOk = false
      const probe = buildFrame({ text: '自检 · autoteste', speaker: 'them', lang: PT })
      try {
        await sendRaw(probe)
        transportOk = true
      } catch (error) {
        notes.push('显示通道失败：' + String(error && error.message ? error.message : error))
      }

      const detect = detectLang('会议在下午三点') === ZH
        && detectLang('A reunião é às três da tarde') === PT

      // 翻译这一环按**后端接缝**分情况检查：三种后端各有各的"就绪"含义。
      let translateOk = false
      if (translator.kind === 'none') {
        // 纯显示通道：不需要任何模型，天然就绪 —— 如实报 OK 并说明本部署不做翻译。
        translateOk = true
        notes.push('本部署不翻译（translator=none）：收件箱里的文字直接当字幕显示')
      } else if (translator.kind === 'http') {
        if (typeof fetch !== 'function') {
          notes.push('translator=http 但当前环境没有 fetch')
        } else if (typeof config.translatorUrl !== 'string' || config.translatorUrl === '') {
          notes.push('translator=http 但没配 translatorUrl')
        } else {
          // 只报配置就绪，不做真实探测：多数端侧翻译端点只接受 POST，
          // 用 GET 去探反而会误报失败。真正的失败会在第一句话时暴露出来。
          translateOk = true
          notes.push('翻译后端：HTTP 端点 ' + config.translatorUrl + '（未探测，首句即验证）')
        }
      } else {
        const llm = ctx.get('llm')
        if (llm === undefined) {
          notes.push("ctx 里没有 llm 服务。如果翻译在别处做，把 config.translator 设成 'http' 或 'none'")
        } else {
          const route = await resolveRoute(llm)
          translateOk = route.ok === true
          if (route.ok === true) notes.push('翻译路由：' + route.providerId + '/' + route.modelId)
          else notes.push(route.failure)
        }
      }

      // 收件箱：未配置不算失败（报 null），配置了就真的去探一次。
      let inboxOk = null
      if (config.inboxPath !== '') {
        inboxOk = false
        const fs = ctx.get('fs')
        if (fs === undefined) {
          notes.push('收件箱需要 fs 服务，但当前 ctx 里没有')
        } else {
          try {
            const target = await fs.resolve(config.inboxPath)
            const info = await fs.stat(target)
            inboxOk = true
            notes.push('收件箱：' + config.inboxPath + '（'
              + (info === undefined ? '文件还不存在，等外部 ASR 创建' : '已就绪')
              + '），运行中 ' + (inbox.running ? '是' : '否')
              + '，已处理 ' + inbox.processed + ' 条，错误 ' + inbox.errors + ' 条')
          } catch (error) {
            notes.push('收件箱不可用：' + String(error && error.message ? error.message : error))
          }
        }
      }

      // 校对（第二遍）：只报状态，不作为自检成败的判据 ——
      // 它是个"锦上添花"的环节，坏了不该让整条链路报 FAIL。
      if (proofreadWanted() === false) {
        notes.push(config.proofread === 'off'
          ? '校对：关闭（config.proofread = off）'
          : '校对：已被手机侧设置关闭（settings.json 的 proofread=false）')
      } else if (proofreadUnavailable) {
        notes.push('校对：已自动关闭 —— ' + (state.proofread.lastNote || '没有可用的 llm 服务'))
      } else {
        const stats = state.proofread
        notes.push('校对：' + config.proofread + '（空闲时做）· 排队 ' + proofreadQueue.length
          + ' 句 · 已改 ' + stats.fixed + ' 句 · 判定无需改 ' + stats.same
          + ' 句 · 丢弃 ' + stats.dropped + ' 句 · 没通过验收 ' + stats.rejected
          + ' 句 · 失败 ' + stats.failed + ' 次'
          + (stats.lastNote === null ? '' : ' · 最近：' + stats.lastNote))
      }

      return {
        ok: layout && transportOk && detect && translateOk && inboxOk !== false,
        layout,
        transportOk,
        detect,
        translate: translateOk,
        inbox: inboxOk,
        proofread: proofreadWanted() === false
          ? null
          : Object.assign({ mode: config.proofread, runtime: runtimeProofread,
            pending: proofreadQueue.length, inFlight: proofreading,
            unavailable: proofreadUnavailable }, state.proofread),
        terms: Object.assign({ mode: config.terms }, state.terms),
        notes,
        preview: drawFrame(probe, config.cols),
      }
    },
  }

  // 收件箱复用同一条翻译管线；自动启动只在配置了 inboxPath 时发生。
  runTranslate = api.translate
  api.inbox = inboxApi
  if (config.inboxPath !== '') {
    try {
      startWatcher()
    } catch (error) {
      inbox.errors += 1
      inbox.lastError = String(error && error.message ? error.message : error)
      // 必须说出来：收件箱起不来的话整个同传是"静默不动"的（外部照样在写，
      // 屏幕上永远没字幕），只记 lastError 的话得到有人想起来去查工具才知道。
      console.log('[leion-pro] ✗ 收件箱没能启动：' + inbox.lastError)
    }
  }
  return api
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具规格（author-facing value schema DSL，与 harness 的 defineTool 一致）
//
// ⚠️ 这是 harness 的 **value schema DSL**，不是原始 JSON Schema。实测真实 defineTool：
//   - `required` 只能是每个属性上的 `required: true`，**写成数组会被拒**；
//     也不能写 `required: false`（要么 true，要么整个省略）；
//   - `object` 必须**显式**声明 `additionalProperties: true|false`；
//   - 可空字段（string|null、object|null）用 `oneOf` 表达；
//   - `array` 用 `items`，且 `items` 上不能写 `required`；
//   - 允许的 type：string / number / integer / boolean / null / array / object / json。
//
// 统一外壳：所有工具都至少返回 ok + transport，`additionalProperties: true` 让各工具自由
// 附加字段而不会被过紧的 schema 卡住（失败路径只返回 ok/transport/failure，因此除这两个
// 以外的字段一律不加 required）。
// ─────────────────────────────────────────────────────────────────────────────

/** 统一输出 shell：ok / transport 必填，其余字段自由。 */
function outputSchema(properties) {
  return {
    type: 'object',
    additionalProperties: true,
    properties: Object.assign({
      ok: { type: 'boolean', required: true },
      transport: { type: 'string', required: true },
      failure: { type: 'string' },
    }, properties),
  }
}

/** 可空字段的 schema 速写。 */
function nullable(inner) {
  return { oneOf: [inner, { type: 'null' }] }
}

/**
 * 构建 6 个工具规格。
 * 每个规格形如 { name, description, parameters, outputSchemaDsl, execute, render }：
 *   · 动态适配器把 outputSchemaDsl 交给 harness.defineTool 就地编译；
 *   · 正式适配器用 schemas.generated.mjs 里预编译好的等价原始 schema；
 *   · render 两边共用同一个函数，所以展示层不可能漂移。
 */
function buildToolSpecs(rt) {
  const shell = transport => ({ ok: true, transport })

  return [
    {
      name: 'leion_status',
      description: '查看亮亮眼镜插件当前状态：设备型号、传输通道、显示预算、已推送帧数、最近一次错误。'
        + '链路不通时先调这个。',
      parameters: {},
      outputSchemaDsl: outputSchema({
        device: { type: 'string' },
        vendor: { type: 'string' },
        aliases: { type: 'array', items: { type: 'string' } },
        panel: { type: 'string' },
        transportDetail: { type: 'string' },
        cols: { type: 'number' },
        lines: { type: 'number' },
        pushes: { type: 'number' },
        historyCount: { type: 'number' },
        partials: { type: 'number' },
        errors: { type: 'number' },
        restored: { type: 'number' },
        lastError: nullable({ type: 'string' }),
        lastFrame: nullable({ type: 'object', additionalProperties: true }),
      }),
      async execute() {
        return Object.assign(shell(rt.transport.kind), rt.status())
      },
      render: (args, value) => [{
        type: 'text',
        text: [
          '设备：' + value.device + '（' + value.vendor + '）',
          '通道：' + value.transport + ' — ' + value.transportDetail,
          '显示预算：' + value.cols + ' 列 × ' + value.lines + ' 行',
          '已推送 ' + value.pushes + ' 帧，历史 ' + value.historyCount + ' 条，节流丢弃 ' + value.partials + ' 次增量',
          '错误 ' + value.errors + (value.lastError === null ? '' : '，最近：' + value.lastError)
            + (value.restored > 0 ? '（有 ' + value.restored + ' 次把碎片恢复成了上一帧）' : ''),
        ].join('\n'),
      }],
    },

    {
      name: 'leion_display',
      description: '把一段已经定稿的文本排版后直接推到亮亮眼镜上显示（不翻译）。'
        + '适合：测试链路、显示提醒/关键词、或由你自己完成翻译后只借用显示通道。',
      parameters: {
        text: { type: 'string', required: true, description: '要显示的文本；插件会按显示宽度折行并保留最后几行' },
        speaker: { type: 'string', description: "这帧属于谁：'them' 对方说的（佩戴者要读的）| 'me' 佩戴者自己说的（回显）", enum: ['them', 'me'] },
        lang: { type: 'string', description: '文本语种，如 zh-CN / pt-BR' },
      },
      outputSchemaDsl: outputSchema({
        speaker: { type: 'string' },
        lang: { type: 'string' },
        lines: { type: 'array', items: { type: 'string' } },
        pushedAt: { type: 'string' },
        preview: { type: 'string' },
      }),
      async execute(args) {
        try {
          return Object.assign(shell(rt.transport.kind), await rt.display(args))
        } catch (error) {
          return { ok: false, transport: rt.transport.kind, failure: String(error && error.message ? error.message : error) }
        }
      },
      render: (args, value) => value.ok === true
        ? [{ type: 'text', text: '已推到 ' + rt.device.model + '（' + value.speaker + ' / ' + value.lang + '）\n' + value.preview }]
        : [{ type: 'text', text: '推送失败：' + value.failure }],
    },

    {
      name: 'leion_translate',
      description: '中↔巴西葡语双向翻译，并把结果推到亮亮眼镜上。缺省自动判语向：'
        + '中文→巴葡，巴葡→中文。佩戴者读的那一帧永远是「对方语言的译本」，'
        + '佩戴者自己的话译成巴葡后作为出站内容返回（给对方的扬声器/第二块屏）。',
      parameters: {
        text: { type: 'string', required: true, description: '原文。通常来自 ASR，也可以是直接键入的一句话' },
        from: { type: 'string', description: "源语种；缺省自动判定。'zh-CN' | 'pt-BR' | 'en-US'" },
        to: { type: 'string', description: "目标语种；缺省用这场会的目标语言（config.targetLang），再缺省取 from 的反向（中↔葡；英语兜底译成中文）" },
        speaker: { type: 'string', description: "这帧归属谁；只在 translator='none'（不翻译）时起作用", enum: ['them', 'me'] },
      },
      outputSchemaDsl: outputSchema({
        from: { type: 'string' },
        to: { type: 'string' },
        source: { type: 'string' },
        translation: { type: 'string' },
        displaySpeaker: { type: 'string' },
        model: { type: 'string' },
        forced: { type: 'boolean' },
        translated: { type: 'boolean' },
        preview: { type: 'string' },
        partial: nullable({ type: 'string' }),
        restoredDisplay: { type: 'boolean' },
        outbound: nullable({ type: 'object', additionalProperties: true }),
      }),
      async execute(args) {
        const result = await rt.translate(args)
        return Object.assign({ transport: rt.transport.kind }, result)
      },
      render: (args, value) => value.ok !== true
        ? [{ type: 'text', text: '翻译未完成：' + value.failure }]
        : [{
          type: 'text',
          text: [
            value.from + ' → ' + value.to + '（' + value.model + '）',
            '原文：' + value.source,
            '译文：' + value.translation,
            '眼镜上（' + value.displaySpeaker + '）：',
            value.preview,
          ].join('\n'),
        }],
    },

    {
      name: 'leion_history',
      description: '回看最近推送到亮亮眼镜的字幕帧（双语对照的现场记录）。',
      parameters: {
        limit: { type: 'number', description: '返回最近多少帧，缺省 10' },
      },
      outputSchemaDsl: outputSchema({
        count: { type: 'number' },
        entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }),
      async execute(args) {
        const entries = rt.history(args)
        return Object.assign(shell(rt.transport.kind), { count: entries.length, entries })
      },
      render: (args, value) => [{
        type: 'text',
        text: value.count === 0
          ? '还没有任何字幕记录。'
          : value.entries.map(e => e.at + '  [' + e.speaker + '/' + e.lang + ']  ' + e.text).join('\n'),
      }],
    },

    {
      name: 'leion_clear',
      description: '清空眼镜上的字幕，并清空本次会话的字幕历史。',
      parameters: {},
      outputSchemaDsl: outputSchema({ clearedHistory: { type: 'number' } }),
      async execute() {
        try {
          return Object.assign(shell(rt.transport.kind), await rt.clear())
        } catch (error) {
          return { ok: false, transport: rt.transport.kind, failure: String(error && error.message ? error.message : error) }
        }
      },
      render: (args, value) => value.ok === true
        ? [{ type: 'text', text: '已清屏，同时清掉了 ' + value.clearedHistory + ' 条历史。' }]
        : [{ type: 'text', text: '清屏失败：' + value.failure }],
    },

    {
      name: 'leion_inbox',
      description: '控制 ASR 收件箱（自动同传的入口）：查看状态、启动/停止、立刻排空一次、'
        + '或把消费位置归零重放。收件箱是一个按行追加的文本文件，外部语音识别程序往里写一行，'
        + '插件就自动翻译并把字幕推到眼镜上——这是「不需要 agent 介入」的同传模式。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: "status 查看 | start 启动轮询 | stop 停止 | drain 立刻处理一次 | reset 消费位置归零重放",
          enum: ['status', 'start', 'stop', 'drain', 'reset'],
        },
      },
      outputSchemaDsl: outputSchema({
        configured: { type: 'boolean' },
        running: { type: 'boolean' },
        path: { type: 'string' },
        pollMs: { type: 'number' },
        forcedFrom: nullable({ type: 'string' }),
        consumedChars: { type: 'number' },
        processed: { type: 'number' },
        errors: { type: 'number' },
        queued: { type: 'number' },
        startedAt: nullable({ type: 'string' }),
        lastLine: nullable({ type: 'string' }),
        lastError: nullable({ type: 'string' }),
        read: { type: 'number' },
        note: nullable({ type: 'string' }),
      }),
      async execute(args) {
        try {
          const run = args.action === 'start' ? () => rt.inbox.start()
            : args.action === 'stop' ? () => rt.inbox.stop()
              : args.action === 'drain' ? () => rt.inbox.drain()
                : args.action === 'reset' ? () => rt.inbox.reset()
                  : () => rt.inbox.status()
          return Object.assign(shell(rt.transport.kind), await run())
        } catch (error) {
          return { ok: false, transport: rt.transport.kind, failure: String(error && error.message ? error.message : error) }
        }
      },
      render: (args, value) => value.ok !== true
        ? [{ type: 'text', text: '收件箱操作失败：' + value.failure }]
        : [{
          type: 'text',
          text: [
            '收件箱：' + (value.configured ? value.path : '（未配置 inboxPath，自动同传关闭）'),
            '运行中：' + (value.running ? '是' : '否') + '，轮询间隔 ' + value.pollMs + 'ms',
            '已处理 ' + value.processed + ' 条，解析/翻译错误 ' + value.errors + ' 条，队列中 ' + value.queued + ' 条',
            value.read === undefined ? '' : '本次读到 ' + value.read + ' 条新行',
            value.note === null || value.note === undefined ? '' : '说明：' + value.note,
            value.lastLine === null ? '' : '最近一条：' + value.lastLine,
            value.lastError === null ? '' : '最近错误：' + value.lastError,
          ].filter(l => l !== '').join('\n'),
        }],
    },

    {
      name: 'leion_selftest',
      description: '自检：确认排版、显示通道、语种判定、翻译路由四条链路各自的真实状态。'
        + '演示或联调前先跑一次，能一次说清「哪一段断了」。',
      parameters: {},
      outputSchemaDsl: outputSchema({
        layout: { type: 'boolean' },
        transportOk: { type: 'boolean' },
        detect: { type: 'boolean' },
        translate: { type: 'boolean' },
        inbox: nullable({ type: 'boolean' }),
        notes: { type: 'array', items: { type: 'string' } },
        preview: { type: 'string' },
      }),
      async execute() {
        // 注意 Object.assign 的顺序：selftest() 自己的 ok（四条链路的与）覆盖 shell 的 true，
        // 所以自检有红灯时工具会如实返回 ok:false。
        return Object.assign(shell(rt.transport.kind), await rt.selftest())
      },
      render: (args, value) => [{
        type: 'text',
        text: [
          value.ok ? '✅ 自检通过' : '⚠️ 自检有问题',
          '排版：' + (value.layout ? 'OK' : 'FAIL'),
          '显示通道：' + (value.transportOk ? 'OK' : 'FAIL'),
          '语种判定：' + (value.detect ? 'OK' : 'FAIL'),
          '翻译路由：' + (value.translate ? 'OK' : 'FAIL'),
          value.inbox === null ? '' : '收件箱：' + (value.inbox ? 'OK' : 'FAIL'),
          value.notes.length === 0 ? '' : '说明：' + value.notes.join(' / '),
          value.preview,
        ].filter(l => l !== '').join('\n'),
      }],
    },
  ]
}

/** 加载日志行，两个包装共用。 */
function loadedMessage(rt) {
  return '[leion-pro] 插件已加载 · ' + rt.device.model
    + ' · transport=' + rt.transport.kind
    + ' · 显示预算 ' + rt.config.cols + '×' + rt.config.lines
}


// ─────────────────────────────────────────────────────────────────────────────
// 动态插件沙箱适配器（由 scripts/generate.mjs 生成）
// ─────────────────────────────────────────────────────────────────────────────

// 动态包没有 config 通道：要改配置就改上面的 CONFIG_DEFAULTS，或改这里的覆盖对象，
// 然后重新 cordis_define。正式插件版本则通过 cordis.yml 的 config 传同样的字段。
const CONFIG_OVERRIDE = {}

return {
  name: 'leion-pro',
  inject: ['tools', 'timer'],

  apply(ctx) {
    const rt = createInterpreter(
      ctx,
      Object.assign({}, CONFIG_DEFAULTS, CONFIG_OVERRIDE),
      { policy: POLICY },
    )
    for (const spec of buildToolSpecs(rt)) {
      harness.registerTool(ctx, harness.defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: { schema: spec.outputSchemaDsl, render: spec.render },
        execute: spec.execute,
      }))
    }
    console.log(loadedMessage(rt))
  },
}
