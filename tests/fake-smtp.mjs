/**
 * fake-smtp.mjs —— 测试用的**假 SMTP 服务器**（进程内，不 spawn 任何东西）
 * ============================================================================
 *
 * 为什么需要它：`lib/mail.mjs` 是自己写的 SMTP 客户端，而"发一封邮件"这件事
 * 没法用假对象验证 —— 真正容易错的地方全在**协议对话**里：
 *   · 多行响应（`250-...` 续行 vs `250 ...` 结束）；
 *   · AUTH PLAIN / LOGIN 的 base64 顺序；
 *   · DATA 段以 `\r\n.\r\n` 结束（点号转义）；
 *   · 中文标题必须 RFC 2047、正文 base64。
 * 所以这里起一个只认这些命令的 TCP 服务器，把客户端发来的**原始报文**收下来断言。
 *
 * 它刻意**不**实现 TLS/STARTTLS：加密通道的正确性不能靠假服务器证明，
 * 那部分只能靠真服务器冒烟（README 里写了怎么冒烟）。
 */

import { createServer } from 'node:net'

/**
 * @param {{ rejectRcpt?: boolean, greeting?: string, port?: number }} options
 *   `rejectRcpt`：让 RCPT TO 返回 550 —— 用来验证"发不出去要如实失败"
 */
export async function startFakeSmtp(options = {}) {
  const messages = []
  const commands = []
  const rejectRcpt = options.rejectRcpt === true

  const server = createServer((socket) => {
    let buffer = ''
    let inData = false
    let data = ''
    let rcpt = []

    const write = (line) => socket.write(line + '\r\n')

    write(options.greeting ?? '220 fake-smtp ready')

    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        if (inData === true) {
          // DATA 段以 "\r\n.\r\n" 结束（行首一个点）
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          data += buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          messages.push({ rcpt: [...rcpt], data, commands: [...commands] })
          rcpt = []
          data = ''
          write('250 2.0.0 queued as FAKE1')
          continue
        }
        const lineEnd = buffer.indexOf('\r\n')
        if (lineEnd < 0) return
        const line = buffer.slice(0, lineEnd)
        buffer = buffer.slice(lineEnd + 2)
        commands.push(line.startsWith('AUTH') ? 'AUTH ***' : line)
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO') === true) {
          // ★ 多行响应：客户端必须把三行都读完，只读一行就会错位
          socket.write('250-fake-smtp greets you\r\n')
          socket.write('250-SIZE 10240000\r\n')
          socket.write('250 AUTH PLAIN LOGIN\r\n')
          continue
        }
        if (upper.startsWith('HELO') === true) { write('250 fake-smtp'); continue }
        if (upper.startsWith('AUTH PLAIN') === true) { write('235 2.7.0 accepted'); continue }
        if (upper === 'AUTH LOGIN') {
          socket.write('334 VXNlcm5hbWU6\r\n')   // base64("Username:")
          continue
        }
        if (upper.startsWith('MAIL FROM') === true) { write('250 2.1.0 ok'); continue }
        if (upper.startsWith('RCPT TO') === true) {
          if (rejectRcpt === true) { write('550 5.1.1 no such user'); continue }
          rcpt.push(line.replace(/^RCPT TO:</i, '').replace(/>$/, ''))
          write('250 2.1.5 ok')
          continue
        }
        if (upper === 'DATA') { inData = true; data = ''; write('354 go ahead'); continue }
        if (upper === 'QUIT') { write('221 bye'); socket.end(); continue }
        if (upper === 'RSET') { write('250 ok'); continue }
        // AUTH LOGIN 之后的两行是 base64 用户名/密码
        if (/^[A-Za-z0-9+/=]+$/.test(line) === true && line.length > 0) {
          write('334 UGFzc3dvcmQ6')
          continue
        }
        write('250 ok')
      }
    })
    socket.on('error', () => { /* 客户端断开：测试结束时会发生 */ })
  })

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    port,
    messages,
    commands,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
