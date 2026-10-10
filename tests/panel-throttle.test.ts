import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PANEL_WRITE_INTERVAL_MS, PanelWriteThrottle } from '../src/panel-throttle'

function fakeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms: number) => {
      // 假 sleep 只推进时间，不真实等待，测试因此可以确定且快速。
      time += ms
    },
    time: () => time,
  }
}

describe('PanelWriteThrottle：Command Panel 写入节流', () => {
  it('同一 AppID 的并发写入按 6500ms 间隔串行，无法绕过', async () => {
    const clock = fakeClock()
    const throttle = new PanelWriteThrottle({ now: clock.now, sleep: clock.sleep })
    const starts: number[] = []

    await Promise.all([1, 2, 3].map(() => throttle.run('100', async () => {
      starts.push(clock.time())
    })))

    assert.deepEqual(starts, [0, PANEL_WRITE_INTERVAL_MS, PANEL_WRITE_INTERVAL_MS * 2])
  })

  it('不同 AppID 各自维护限频窗口，不互相等待', async () => {
    const clock = fakeClock()
    const throttle = new PanelWriteThrottle({ now: clock.now, sleep: clock.sleep })
    const starts: Record<string, number> = {}

    await Promise.all([
      throttle.run('100', async () => { starts.a = clock.time() }),
      throttle.run('200', async () => { starts.b = clock.time() }),
    ])

    assert.equal(starts.a, 0)
    assert.equal(starts.b, 0)
    assert.equal(clock.time(), 0)
  })

  it('写入本身耗时超过间隔时不再额外等待', async () => {
    const clock = fakeClock()
    const throttle = new PanelWriteThrottle({ now: clock.now, sleep: clock.sleep })
    const starts: number[] = []

    await throttle.run('100', async () => {
      starts.push(clock.time())
      await clock.sleep(PANEL_WRITE_INTERVAL_MS + 1000)
    })
    await throttle.run('100', async () => {
      starts.push(clock.time())
    })

    assert.deepEqual(starts, [0, PANEL_WRITE_INTERVAL_MS + 1000])
  })
})
