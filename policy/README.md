# 巴葡策略 —— 唯一来源

`br-pt.json` 是"巴西葡语口径"这件事的**唯一来源**。它被三处消费，全部由生成器派生：

```
policy/br-pt.json
   ├─► plugin/policy.generated.mjs    正式插件 import 它 → translationSystem() 生成提示词
   ├─► dynamic/leion-pro.host.js      内联成常量（沙箱里没有 import）
   └─► skills/leion-interpreter/SKILL.md   生成"术语表 + 口语特征 + 字幕纪律"那一节
```

改完跑 `node scripts/generate.mjs`，测试里的新鲜度门禁会拦住忘记生成的情况。

## 为什么要有这个文件

在这之前，"巴葡不是葡葡"这件事在代码里有两个不一致的表述：

| 在哪 | 长什么样 | 问题 |
|---|---|---|
| `plugin/core.mjs` 的 `translationSystem()` | 5 句原则 | 没有具体词表，模型只能自己猜 |
| `skills/…/SKILL.md` | 一张术语表 | 和上面那 5 句没有关系，会各自漂移；而且有两行是写坏的（"收银台"那行没有意义） |

后果是：**agent 走工具路径翻译时看到一张表，插件自动路径翻译时只看到一句原则**，两条路的质量不一样。

现在两边都从这份数据生成，不可能再漂移。

## 字段

| 字段 | 谁用 | 说明 |
|---|---|---|
| `variety` | 提示词 | 语种名。`fullName` 用于"译成巴葡"，`counterpart.name` 用于"译成中文" |
| `translationRules` | 提示词 | 翻译的硬性要求（编号后进提示词） |
| `terminology` | 提示词 + 技能文档 | 巴葡/葡葡对照词表。**只在"译成巴葡"时进提示词**（译成中文时用不上，白占上下文） |
| `speakingFeatures` | 技能文档 | 巴葡口语特征（você vs tu、a gente、estar+gerúndio…） |
| `subtitleDiscipline` | 技能文档 | 字幕长度纪律（数字不许丢、不许为塞进 3 行做摘要） |

`translationRules` 里那条"AR 屏幕只有 3 行，译文要简洁"是刻意写进提示词的：
屏幕小是硬约束，让模型自己知道比事后截断要好。

## 和"把模型搬到端侧"的关系

这一点很重要：**提示词是一种只在"大模型 + 云端"这个组合里有效的策略载体。**

如果将来翻译搬到端侧的小模型上，这段话它多半执行不了。到时候这份数据能换个用法：

- `terminology` → 解码时的**禁用词约束**（禁止生成 autocarro），或译后的**自动替换表**
- `translationRules` 里的数字/专名要求 → **后处理校验**（发现数字对不上就重译或标注）

所以数据化不只是"清理重复"，它是让这份策略资产**能跟着模型走**的前提。
