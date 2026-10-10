/**
 * Command Panel 写入节流（QQ /v2/panels 连续写入至少间隔 6500ms）。
 *
 * 节流按 AppID 串行：并发的 import / publish / cleanup 都经过同一个队列，
 * 后一次写入必须等前一次写入起点满 interval，客户端无法通过并发请求绕过。
 * now / sleep 可注入，测试用假时钟即可确定性地断言间隔。
 */
export interface PanelWriteThrottleOptions {
  /** 连续两次写入起点的最小间隔，默认 6500ms。 */
  intervalMs?: number
  /** 毫秒时间源。 */
  now?: () => number
  /** 等待函数；测试注入假 sleep。 */
  sleep?: (ms: number) => Promise<void>
}

export const PANEL_WRITE_INTERVAL_MS = 6500

export function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class PanelWriteThrottle {
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly lastWriteAt = new Map<string, number>()

  constructor(options: PanelWriteThrottleOptions = {}) {
    this.intervalMs = options.intervalMs ?? PANEL_WRITE_INTERVAL_MS
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? defaultSleep
  }

  /** 在 AppID 的串行队列中执行一次平台写入，并保证与上一次写入的起点间隔。 */
  run<T>(appId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(appId) ?? Promise.resolve()
    const run = previous.then(async () => {
      const last = this.lastWriteAt.get(appId)
      if (last !== undefined) {
        const wait = last + this.intervalMs - this.now()
        if (wait > 0) await this.sleep(wait)
      }
      // 记录写入起点，而不是结束时间；长时间写入本身不会额外扩大窗口。
      this.lastWriteAt.set(appId, this.now())
      return task()
    })
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(appId, tail)
    void tail.then(() => {
      if (this.queues.get(appId) === tail) this.queues.delete(appId)
    })
    return run
  }
}
