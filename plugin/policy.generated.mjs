/**
 * 自动生成 —— 请勿手改。
 * ============================================================================
 * 来源：policy/br-pt.json（巴葡策略的唯一来源）。
 * 用途：正式插件（plugin/index.mjs）把它作为 deps.policy 传给 createInterpreter，
 *       由 translationSystem() 生成提示词。
 * 重新生成：node scripts/generate.mjs
 * 新鲜度门禁：tests/run-all.mjs
 */

export const POLICY = {
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
  ]
}
