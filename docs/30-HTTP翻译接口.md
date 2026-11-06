# 30 · HTTP 翻译接口（给外部调用方）

> **一句文字 → 一种或两种译文。** 支持中文（`zh-CN`）、葡语（`pt-BR`）、英语（`en-US`）。
> 这是"**一句话**"用的接口，不是批量翻译服务 —— 边界先看一眼再接（§5）。
> 姊妹文档：[`27-HTTP识别接口.md`](27-HTTP识别接口.md)（一段音频 → 一句文字），形状与本文一致。

---

## 0. 三句话说明它是什么

1. 你 POST 一句文字（加源语种、目标语种），拿回译文；
2. 用的是**会议链路里同一个大脑**（同一份术语表、同一套校对与切行、同一个翻译后端）——
   所以返回结果与会议里的字幕**同源**，不会出现"接口说用的是 A、会议里跑的是 B"；
3. 那个大脑是**串行**的：你的请求会和**正在进行的会议**抢占同一个翻译进程，
   所以接口限了排队数（4）和超时（默认 30 s）。

## 1. 端点

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/translate/info` | 看这台机器支持哪些语种、限制是多少、**翻译进程起来没有**（接入前先调一次） |
| `POST` | `/translate` | 送一句文字，拿回译文 |

两种都要求请求头带密钥（与手机、与识别接口**同一个密钥**）：

```
X-Leion-Secret: <这台机器的共享密钥>
```

（也接受 `?secret=<密钥>` 便于在浏览器里试，但**正式调用请用请求头**。）
密钥向部署方要，不要写进代码库里。

## 2. `GET /translate/info` —— 先看它到底能不能用

```bash
curl -s "http://<host>:8789/translate/info" -H "X-Leion-Secret: $SECRET" | python -m json.tool
```

```json
{
  "ok": true,
  "endpoint": "POST /translate",
  "from": ["zh-CN", "pt-BR", "en-US"],
  "to":   ["zh-CN", "pt-BR", "en-US"],
  "limits": { "maxTextChars": 4000, "defaultTimeoutMs": 30000, "maxTimeoutMs": 120000,
              "maxInFlight": 4, "maxTargets": 2, "langs": ["zh-CN", "pt-BR", "en-US"] },
  "pipeline": {
    "inbox": "/var/lib/leion/test/api-translate/inbox.jsonl",
    "bus":   "/var/lib/leion/test/api-translate/bus.json",
    "running": true
  },
  "note": "one request = one sentence; the translator is serial, so calls are queued"
}
```

`pipeline.running: false` 表示**这台机器没在跑翻译进程**（部署方要用 `scripts/start-multi.mjs`
起管线；它默认会带一个「大脑·API」）。这时 `POST /translate` 会回 503。

## 3. `POST /translate`

### 3.1 请求

`Content-Type: application/json`

| 字段 | 必填 | 说明 |
|---|---|---|
| `text` | ✅ | 要翻译的那句话（字符串；≤ 4000 字符）。**一次一句**，长文请自己切 |
| `from` | ✅ | 源语种：`zh-CN` / `pt-BR` / `en-US`（必须显式给，我们**不猜**） |
| `to` | ✅ | 目标语种：一个字符串，或数组（最多两个 —— 三种语言里源语言占一种） |
| `timeoutMs` | — | 等待上限，缺省 30000，最大 120000 |

`to` 里可以包含源语种（有的调用方图省事把三种语言全传进来）：与 `from` 相同的那几个
**会被滤掉**，不会浪费一次模型调用；三个全传会被 400 拒（最多两个目标）。

### 3.2 响应（成功）

```json
{
  "ok": true,
  "translated": true,
  "from": "pt-BR",
  "to": ["zh-CN"],
  "text": "早上好，一切都好吗",
  "translations": { "zh-CN": "早上好，一切都好吗" },
  "elapsedMs": 812
}
```

| 字段 | 说明 |
|---|---|
| `text` | **主译文**（`to` 里的第一个）—— 只想要一份的调用方读这个字段就行 |
| `translations` | 每种目标语言一份：`{ "<lang>": "<译文>" }` |
| `translated` | `false` 表示**源=目标，没翻**（原样回文字），见下 |
| `elapsedMs` | 从收到请求到出结果用了多久（含排队等待） |

`to` 与 `from` 相同（或 `to` 里只有源语言）时：

```json
{ "ok": true, "translated": false, "from": "zh-CN", "to": ["zh-CN"],
  "text": "你好", "translations": { "zh-CN": "你好" }, "elapsedMs": 0,
  "note": "source and target are the same language: nothing to translate" }
```

> 这不是错误，也不花模型调用 —— 所以 HTTP 仍是 200。**不要**据此判断"接口坏了"。

### 3.3 响应（失败 / 部分成功）

| HTTP | `error` | 含义 / 怎么办 |
|---|---|---|
| 400 | 具体原因（**英文**） | 参数不对（缺字段 / 语种不支持 / 太长 / 超时值非法）。错误串会指名哪个字段 |
| 401 | `unauthorized` | 密钥不对或没带 |
| 429 | `too-many-requests` | 同时已有 4 个请求在跑；退避重试 |
| 503 | `translator-not-running` | 这台机器上**没在跑翻译进程**（`pipeline.running` 也是 false）；`hint` 里有下一步 |
| 504 | `translation-timeout` | 翻译进程没把这个请求处理完（没消费 / 模型报错）。`hint` 会区分这两种情况 |
| 504 | `partial-translation` | 要了两种语言，只回来一部分：`translations` 有回来的，`missing` 列出缺的 |

504 的两个 `hint` 是刻意分开的（"根本没人消费"和"收到了但没给译文"是两件不同的事）：

```json
{ "ok": false, "error": "translation-timeout", "missing": ["zh-CN"],
  "hint": "the translator received this sentence (it echoed the source) but produced no translation within 30000ms — look for the \"✗ 翻译失败\" line in the API brain log" }
```

## 4. 最小可用示例

### curl

```bash
export SECRET='<向部署方要>'
export HOST='http://117.50.180.93:8789'

curl -s "$HOST/translate/info" -H "X-Leion-Secret: $SECRET"

curl -s -X POST "$HOST/translate" \
     -H "X-Leion-Secret: $SECRET" -H 'content-type: application/json' \
     -d '{"text":"olá, tudo bem?","from":"pt-BR","to":"zh-CN"}'
```

### Python（带失败分类，建议照抄这段）

```python
import json, time, urllib.request

HOST, SECRET = "http://117.50.180.93:8789", "<密钥>"

def translate(text, src="pt-BR", dst="zh-CN", timeout_ms=30000):
    body = json.dumps({"text": text, "from": src, "to": dst,
                       "timeoutMs": timeout_ms}).encode()
    req = urllib.request.Request(
        f"{HOST}/translate", data=body,
        headers={"X-Leion-Secret": SECRET, "content-type": "application/json"})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_ms / 1000 + 10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {error.code} after {time.time()-started:.2f}s: {detail}")

result = translate("olá, tudo bem?")
if result["ok"] and result["translated"]:
    print(result["text"], "|", result["elapsedMs"], "ms")
else:
    print("没译成：", result.get("error"), result.get("hint"))
```

## 5. 能力边界（先说清，免得白试）

| 想做的事 | 现在行不行 |
|---|---|
| 一句话 → 译文（中/葡/英，最多两种目标） | ✅ 可以 |
| **流式**（边翻边出字） | ❌ 不支持。每次请求是一句完整的话，等翻完才返回 |
| **识别**（音频 → 文字） | ❌ 这个接口只做翻译，识别用 [`27`](27-HTTP识别接口.md) |
| 长文 / 段落（> 4000 字符或包含多句） | ❌ 请自己按句切；一句一次的质量最好（这也是会议链路的真实用法） |
| 指定术语表 / 风格 / 语气 | ❌ 用这台机器上**当前生效**的术语表（随会议切换），请求里不能临时指定 |
| 说话人 / 时间戳 | ❌ 不支持（字幕链路的元信息只对会议有意义） |
| 一次两种目标语言 | ✅ 可以；但**两种都会各花一次模型调用**（校对只对第一种做） |

## 6. 延迟与并发，怎么估

- **一句短文（≤ 80 字）**：实测一次模型往返 **0.4–1.5 s**（与会议里的一句话同量级）；
  `elapsedMs` 含排队等待，所以高峰期会比这大。
- **校对**：如果这台机器开了校对（手机设置里"校对"），初译先返回，校对在**空闲时**才做 ——
  它**不会**让本接口变慢，也不会把校对的版本再回给调用方（接口只返回初译那一份）。
- **并发**：翻译进程只有一个，接口侧最多同时 4 个。要压测或批量跑，先和我们说 —— 那会挤掉会议。
- **不要**把本接口放进"每句话一次"的高频循环里还并发：串行翻译意味着并发只会让每个请求都更慢。

## 7. 部署方需要知道的三件事

1. **谁在服务它**：`scripts/start-multi.mjs` 会多起一个 `大脑·API`（`scripts/harness-side.mjs`），
   它的收件箱与总线在 `<数据目录>/api-translate/`。与房间大脑是**同一段代码**，只是没有"房间"。
   - 不想开：`--no-api-translate`（这时接口回 503 并说清原因）；
   - 它挂了**不会**连累会议：`start-multi` 会退避重启它（最多 5 次），其余进程照常；
   - `start-all.mjs`（单场会那套）**不**起它 —— 那条路请用 `start-multi`，或自己
     `node scripts/harness-side.mjs --inbox <数据目录>/api-translate/inbox.jsonl --bus <数据目录>/api-translate/bus.json`。
2. **日志在哪**：`大脑·API` 的日志在 `var/logs/api-brain.log`（`--quiet-logs` 时不写文件，只在终端）。
   排查顺序与会议同一条：先看 `/translate/info` 的 `pipeline.running`，再看那行 `✗ 翻译失败`。
   另一个要知道的：收件箱是**追加**的（大脑按"已读偏移"往下取），所以一次运行里它随请求数
   缓慢增长（一句约 100 字节；启动时会被清空）。`scripts/leion-clean.mjs` 不管这个目录。
3. **它和会议的关系**：同一个模型、同一个术语表；术语表切换会影响它（这是"同一条翻译链路"的代价，
   也是它能给出与会议一致译文的**原因**）。

## 8. 变更与兼容

- 本接口从 **5.125** 起提供。字段**只增不改**；新增字段调用方可以忽略。
- 错误码是机器可读的部分（`translator-not-running` / `translation-timeout` / `partial-translation` /
  `too-many-requests` / `unauthorized`），人话是英文 `error`/`hint` —— 与 `/asr/*` 同一套约定。
