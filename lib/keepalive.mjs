/**
 * keepalive.mjs —— 只为把事件循环留住
 * ============================================================================
 * 这个组合里没有任何 HTTP 服务。收件箱轮询用的是 ctx.interval，本来就能留住进程；
 * 但如果它因为配置或依赖问题没起来，进程会**静默退出** —— 对使用者极其困惑
 * （"启动了但什么都没发生"）。所以再加一个不干活的长期定时器兜底。
 */

export const name = 'leion-keepalive'
export const inject = ['timer']

export function apply(ctx) {
  ctx.interval(() => {
    // 故意什么都不做：它存在的唯一意义是不让事件循环空掉。
  }, 30_000)
}
