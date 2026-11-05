# 27 · HTTP 识别接口（给外部调用方）

> **一段音频 → 一句文字。** 目前支持 **葡语（pt-BR）** 与 **英语（en-US）**，中文（zh-CN）同样可用。
> 这是"**一句话**"用的接口，不是批量转写服务 —— 边界写在下面，先看一眼再接。

---

## 0. 三句话说明它是什么

1. 你 POST 一段音频（16 kHz / 单声道 / 16 bit PCM，或 WAV 容器），拿回这句话的文字；
2. 用的是**我们会议链路里同一个识别进程、同一份策略表** —— 所以返回结果与实时会议里的字幕**同源**，
   不会出现"接口说用的是 A、会议里跑的是 B"；
3. 识别进程是**串行**的：你的请求会和**正在进行的会议**共享同一个消费者，
   所以接口限了并发（4）和超时（默认 30 s）。

## 1. 端点

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/asr/models` | 看这台机器上三门语言各走哪个引擎/模型（**接入前先调一次**） |
| `POST` | `/asr/transcribe` | 送一段音频，拿回文字 |

两种都要求请求头带密钥：

```
X-Leion-Secret: <这台机器的共享密钥>
```

（也接受 `?secret=<密钥>` 便于在浏览器里试，但**正式调用请用请求头**。）

密钥向部署方要，不要写进代码库里。

## 2. `GET /asr/models` —— 先看它到底会用什么

```bash
curl -s "http://<host>:8789/asr/models" -H "X-Leion-Secret: $SECRET" | python -m json.tool
```

```json
{
  "ok": true,
  "endpoint": "POST /asr/transcribe",
  "languages": {
    "zh-CN": { "strategy": "zh-steady",   "engine": "whisper",  "model": "large-v3" },
    "pt-BR": { "strategy": "pt-funasr",   "engine": "funasr",   "model": "fun-asr-realtime" },
    "en-US": { "strategy": "en-parakeet", "engine": "parakeet", "model": "/opt/leion/models/parakeet-tdt-0.6b-v2" }
  },
  "limits": { "maxAudioBytes": 8388608, "maxSeconds": 120, "defaultTimeoutMs": 30000,
              "maxInFlight": 4, "formats": ["pcm16", "wav"], "languages": ["zh-CN", "pt-BR", "en-US"] },
  "note": "识别进程是串行的：调用会和正在进行的会议共享同一个消费者"
}
```

> `engine` 的含义：`whisper` = 本地 GPU 大模型；`parakeet` = 本地 CPU（英语，不占显存）；
> `funasr` = 阿里云 DashScope 实时接口（葡语，走公网）。
> **换模型是我们这边改表的事**，调用方不用管；你只按 `lang` 传就行。

## 3. `POST /asr/transcribe`

### 3.1 请求

`Content-Type: application/json`

| 字段 | 必填 | 说明 |
|---|---|---|
| `lang` | ✅ | `pt-BR` / `en-US` / `zh-CN` |
| `audioBase64` | ✅ | 音频字节的 base64。默认按 **16 k / 单声道 / 16 bit 裸 PCM** 解码 |
| `audioFormat` | — | `pcm16`（缺省）或 `wav`（带 44 字节头的容器，会自动剥头） |
| `timeoutMs` | — | 等待上限，缺省 30000，最大 120000 |

音频要求（**不满足会直接 400 并告诉你该怎么转**，不会"勉强识别"）：

- 采样率必须是 **16000 Hz**（不替你重采样：重采样写错的表现是"识别结果乱"，会被当成模型问题）；
- **单声道**、**16 bit**（PCM）；
- 建议 0.6–20 秒一段（**上限 120 秒**、8 MB）。长音频请**按句切好**再调。

转格式一条命令：

```bash
ffmpeg -i input.m4a -ar 16000 -ac 1 -sample_fmt s16 output.wav
# 或者直接出裸 PCM：
ffmpeg -i input.m4a -ar 16000 -ac 1 -f s16le output.pcm
```

### 3.2 响应（成功）

```json
{
  "ok": true,
  "text": "olá, isto é um teste",
  "lang": "pt-BR",
  "strategy": "pt-funasr",
  "model": "fun-asr-realtime",
  "audioSeconds": 1.0,
  "elapsedMs": 57,
  "empty": false
}
```

| 字段 | 说明 |
|---|---|
| `text` | 识别出的文字（**可能为空**，见下） |
| `lang` | 实际使用的语种（回声 `lang` 参数） |
| `strategy` / `model` | 这句走的是哪套策略/哪个模型 —— 便于你把结果和我们对账 |
| `audioSeconds` | 这段音频多长 |
| `elapsedMs` | 从收到请求到出结果用了多久 |
| `empty` | `true` = **认了但没认出来**（没人声 / 太轻）。这**不是失败**，HTTP 仍是 200 |

`empty: true` 时还会带 `reason`：

```json
{ "ok": true, "text": "", "empty": true,
  "reason": "the recognizer processed this segment but produced no text (no speech? too quiet?)" }
```

> 面向调用方的文案一律是**英文**（这个接口是给外部系统调的，不是中文 App）；机器可读的部分在 `error` 代码里。
>
> 为什么把 `empty` 和「失败」分开：**「这段音频里没人说话」** 与 **「接口/服务出问题了」** 是两件完全不同的事，
> 混成一个 500 会让调用方一直重试一段本来就没人声的音频。

### 3.3 响应（失败）

| HTTP | `error` | 含义 / 怎么办 |
|---|---|---|
| 400 | 具体原因（**英文**） | 参数不对。错误串会**直接说清哪一条**（语种/格式/采样率/声道/太长/太短），并给出该用的 ffmpeg 命令 |
| 401 | `unauthorized` | 密钥不对或没带 |
| 413 | 请求体过大 | 音频超过 8 MB；请切成句 |
| 429 | `too-many-requests` | 同时已有 4 个请求在跑；退避重试 |
| 503 | `recognizer-not-running` | 识别队列不存在 ⇒ 这台机器上**没在跑识别进程**（部署方要用 `start-multi` 起管线） |
| 504 | `recognizer-timeout` | 段一直没被取走：识别进程没在跑，或正被长会议段占着 |

503 / 504 都带 `hint`，里面有"下一步该做什么"。

## 4. 最小可用示例

### curl（顺便看耗时）

```bash
export SECRET='<向部署方要>'
export HOST='http://117.50.180.93:8789'      # 或内网地址

# ① 先看这一台会用什么
curl -s "$HOST/asr/models" -H "X-Leion-Secret: $SECRET"

# ② 葡语
B64=$(base64 -w0 fala-pt.wav)
curl -s -X POST "$HOST/asr/transcribe" \
     -H "X-Leion-Secret: $SECRET" -H 'content-type: application/json' \
     -d "{\"lang\":\"pt-BR\",\"audioFormat\":\"wav\",\"audioBase64\":\"$B64\"}"
```

### Python（带失败分类，建议照抄这段）

```python
import base64, json, time, urllib.request

HOST, SECRET = "http://117.50.180.93:8789", "<密钥>"

def transcribe(path, lang="pt-BR", timeout_ms=30000, fmt="wav"):
    audio = base64.b64encode(open(path, "rb").read()).decode()
    body = json.dumps({"lang": lang, "audioBase64": audio,
                       "audioFormat": fmt, "timeoutMs": timeout_ms}).encode()
    req = urllib.request.Request(
        f"{HOST}/asr/transcribe", data=body,
        headers={"X-Leion-Secret": SECRET, "content-type": "application/json"})
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_ms / 1000 + 10) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {error.code} after {time.time()-started:.2f}s: {detail}")

result = transcribe("fala-pt.wav")
if result["empty"]:
    print("没认出来：", result.get("reason"))
else:
    print(result["text"], "|", result["strategy"], "|", result["elapsedMs"], "ms")
```

## 5. 能力边界（先说清，免得白试）

| 想做的事 | 现在行不行 |
|---|---|
| 一句话 → 文字（葡/英/中） | ✅ 可以 |
| **流式**（边传边出字） | ❌ 不支持。每次请求是一段完整音频，等它认完才返回 |
| **翻译**（葡↔英↔中） | ❌ 这个接口只做识别；翻译在会议链路里（可另议） |
| **说话人分离 / 逐字时间戳** | ❌ 不支持 |
| 长音频（>2 分钟）批量转写 | ❌ 请自己按句切，或另提需求 |
| 44.1 kHz / 立体声 / mp3 | ❌ 直接 400（请先 ffmpeg 转 16k 单声道 16 bit） |

## 6. 延迟与并发，怎么估

- **英语（Parakeet，本地 CPU）**：约 0.2–0.3 s / 2 秒音频（实测 RTF ≈ 0.1）。
- **葡语（Fun-ASR，云端）**：约 0.4–1.4 s / 1–4 秒音频（实测 RTF ≈ 0.25–0.3，含关闭握手 0.35 s）。
- **中文（whisper large-v3，本地 GPU）**：约 0.5–3.4 s，取决于段长（实测 25 秒段 3.3 s）。
- 首次调用若模型是冷的，会多等一次加载（Parakeet ≈ 3 s，whisper 十几秒）；**模型热着时没有这一项**。
- **并发**：识别进程只有一个，接口侧最多同时 4 个。要压测或批量跑，先和我们说 —— 那会挤掉会议。

## 7. 接入前请和我们确认三件事

1. **你要哪几门语言**（现在 `pt-BR` / `en-US` 已就绪；`zh-CN` 也有）；
2. **量级**：一天多少次、是否集中在某几个时段（决定要不要给你单独起一份识别进程）；
3. **音频从哪来**（手机录？会议系统导出？）—— 采样率/声道/单声道混音的问题多半出在这一步。

## 8. 变更与兼容

- 本接口从 **5.117** 起提供。字段**只增不改**；新增字段调用方可以忽略。
- 识别模型由我们这边按语言统一决定（`<数据目录>/asr-models.json`，热改即生效）。
  如果你希望某段时间固定用某个模型，告诉我们，我们单独给一个策略名。
