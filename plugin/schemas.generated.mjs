/**
 * 自动生成 —— 请勿手改。
 * ============================================================================
 * 来源：plugin/core.mjs 里的 author-facing value schema DSL，
 *       经检出里真实的 @deepseek-ai/dsh-tools defineTool 编译后的原始形式。
 * 用途：正式插件（plugin/index.mjs）走 ctx.tools.register() 时需要的原始 JSON Schema。
 * 重新生成：node scripts/generate.mjs
 * 新鲜度门禁：tests/run-all.mjs
 */

export const TOOL_SCHEMAS = {
  "leion_status": {
    "description": "查看亮亮眼镜插件当前状态：设备型号、传输通道、显示预算、已推送帧数、最近一次错误。链路不通时先调这个。",
    "parameters": {
      "type": "object",
      "properties": {}
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "transport": {
          "type": "string"
        },
        "failure": {
          "type": "string"
        },
        "device": {
          "type": "string"
        },
        "vendor": {
          "type": "string"
        },
        "aliases": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "panel": {
          "type": "string"
        },
        "transportDetail": {
          "type": "string"
        },
        "cols": {
          "type": "number"
        },
        "lines": {
          "type": "number"
        },
        "pushes": {
          "type": "number"
        },
        "historyCount": {
          "type": "number"
        },
        "partials": {
          "type": "number"
        },
        "errors": {
          "type": "number"
        },
        "restored": {
          "type": "number"
        },
        "lastError": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "lastFrame": {
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": true
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "ok",
        "transport"
      ]
    }
  },
  "leion_display": {
    "description": "把一段已经定稿的文本排版后直接推到亮亮眼镜上显示（不翻译）。适合：测试链路、显示提醒/关键词、或由你自己完成翻译后只借用显示通道。",
    "parameters": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "description": "要显示的文本；插件会按显示宽度折行并保留最后几行"
        },
        "speaker": {
          "type": "string",
          "description": "这帧属于谁：'them' 对方说的（佩戴者要读的）| 'me' 佩戴者自己说的（回显）",
          "enum": [
            "them",
            "me"
          ]
        },
        "lang": {
          "type": "string",
          "description": "文本语种，如 zh-CN / pt-BR"
        }
      },
      "required": [
        "text"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "transport": {
          "type": "string"
        },
        "failure": {
          "type": "string"
        },
        "speaker": {
          "type": "string"
        },
        "lang": {
          "type": "string"
        },
        "lines": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "pushedAt": {
          "type": "string"
        },
        "preview": {
          "type": "string"
        }
      },
      "required": [
        "ok",
        "transport"
      ]
    }
  },
  "leion_translate": {
    "description": "中↔巴西葡语双向翻译，并把结果推到亮亮眼镜上。缺省自动判语向：中文→巴葡，巴葡→中文。佩戴者读的那一帧永远是「对方语言的译本」，佩戴者自己的话译成巴葡后作为出站内容返回（给对方的扬声器/第二块屏）。",
    "parameters": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string",
          "description": "原文。通常来自 ASR，也可以是直接键入的一句话"
        },
        "from": {
          "type": "string",
          "description": "源语种；缺省自动判定。'zh-CN' | 'pt-BR' | 'en-US'"
        },
        "to": {
          "type": "string",
          "description": "目标语种；缺省用这场会的目标语言（config.targetLang），再缺省取 from 的反向（中↔葡；英语兜底译成中文）"
        },
        "speaker": {
          "type": "string",
          "description": "这帧归属谁；只在 translator='none'（不翻译）时起作用",
          "enum": [
            "them",
            "me"
          ]
        }
      },
      "required": [
        "text"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "transport": {
          "type": "string"
        },
        "failure": {
          "type": "string"
        },
        "from": {
          "type": "string"
        },
        "to": {
          "type": "string"
        },
        "source": {
          "type": "string"
        },
        "translation": {
          "type": "string"
        },
        "displaySpeaker": {
          "type": "string"
        },
        "model": {
          "type": "string"
        },
        "forced": {
          "type": "boolean"
        },
        "translated": {
          "type": "boolean"
        },
        "preview": {
          "type": "string"
        },
        "partial": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "restoredDisplay": {
          "type": "boolean"
        },
        "outbound": {
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": true
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "ok",
        "transport"
      ]
    }
  },
  "leion_history": {
    "description": "回看最近推送到亮亮眼镜的字幕帧（双语对照的现场记录）。",
    "parameters": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "number",
          "description": "返回最近多少帧，缺省 10"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "transport": {
          "type": "string"
        },
        "failure": {
          "type": "string"
        },
        "count": {
          "type": "number"
        },
        "entries": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "required": [
        "ok",
        "transport"
      ]
    }
  },
  "leion_clear": {
    "description": "清空眼镜上的字幕，并清空本次会话的字幕历史。",
    "parameters": {
      "type": "object",
      "properties": {}
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "transport": {
          "type": "string"
        },
        "failure": {
          "type": "string"
        },
        "clearedHistory": {
          "type": "number"
        }
      },
      "required": [
        "ok",
        "transport"
      ]
    }
  },
  "leion_inbox": {
    "description": "控制 ASR 收件箱（自动同传的入口）：查看状态、启动/停止、立刻排空一次、或把消费位置归零重放。收件箱是一个按行追加的文本文件，外部语音识别程序往里写一行，插件就自动翻译并把字幕推到眼镜上——这是「不需要 agent 介入」的同传模式。",
    "parameters": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "description": "status 查看 | start 启动轮询 | stop 停止 | drain 立刻处理一次 | reset 消费位置归零重放",
          "enum": [
            "status",
            "start",
            "stop",
            "drain",
            "reset"
          ]
        }
      },
      "required": [
        "action"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "transport": {
          "type": "string"
        },
        "failure": {
          "type": "string"
        },
        "configured": {
          "type": "boolean"
        },
        "running": {
          "type": "boolean"
        },
        "path": {
          "type": "string"
        },
        "pollMs": {
          "type": "number"
        },
        "forcedFrom": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "consumedChars": {
          "type": "number"
        },
        "processed": {
          "type": "number"
        },
        "errors": {
          "type": "number"
        },
        "queued": {
          "type": "number"
        },
        "startedAt": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "lastLine": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "lastError": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "read": {
          "type": "number"
        },
        "note": {
          "oneOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "ok",
        "transport"
      ]
    }
  },
  "leion_selftest": {
    "description": "自检：确认排版、显示通道、语种判定、翻译路由四条链路各自的真实状态。演示或联调前先跑一次，能一次说清「哪一段断了」。",
    "parameters": {
      "type": "object",
      "properties": {}
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true,
      "properties": {
        "ok": {
          "type": "boolean"
        },
        "transport": {
          "type": "string"
        },
        "failure": {
          "type": "string"
        },
        "layout": {
          "type": "boolean"
        },
        "transportOk": {
          "type": "boolean"
        },
        "detect": {
          "type": "boolean"
        },
        "translate": {
          "type": "boolean"
        },
        "inbox": {
          "oneOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ]
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "preview": {
          "type": "string"
        }
      },
      "required": [
        "ok",
        "transport"
      ]
    }
  }
}
