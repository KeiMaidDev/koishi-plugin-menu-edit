import assert from 'node:assert/strict'
import { Context } from 'koishi'
import { describe, it } from 'node:test'
import * as menuEdit from '../src'

describe('插件入口', () => {
  it('没有 Console 服务时也能在 Koishi 中加载', async () => {
    const app = new Context()
    app.plugin(menuEdit)
    await app.start()
    try {
      assert.ok(app.registry.has(menuEdit), 'menu-edit 插件入口应处于加载状态')
    } finally {
      await app.stop()
    }
  })

  it('Console 服务可用时注册全部 RPC 与客户端入口', async () => {
    const captured: string[] = []
    let entries = 0
    const app = new Context()
    app.set('console', {
      addListener: (event: string) => captured.push(event),
      addEntry: () => {
        entries += 1
      },
    } as never)
    app.plugin(menuEdit)
    await app.start()
    try {
      assert.deepEqual(captured, [
        'menu-edit/bots',
        'menu-edit/workspace',
        'menu-edit/save-draft',
        'menu-edit/discard-draft',
        'menu-edit/refresh-platform',
        'menu-edit/import-private-menu',
        'menu-edit/publish-private-menu',
        'menu-edit/import-command-panel',
        'menu-edit/publish-command-panel',
      ])
      assert.equal(entries, 1)
    } finally {
      await app.stop()
    }
  })
})
