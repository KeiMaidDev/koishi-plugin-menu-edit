import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createKoishiMenuPlatform, MenuPlatformError } from '../src/platform'

function ctxWith(internal: Record<string, unknown>, bot: Record<string, unknown> = {}) {
  return {
    bots: [{ platform: 'qq', isActive: true, config: { id: '100' }, internal, ...bot }],
  } as never
}

describe('createKoishiMenuPlatform：Command Panel 平台边界', () => {
  it('CONNECT / RECONNECT 状态不满足平台边界的在线门槛', async () => {
    const platform = createKoishiMenuPlatform(ctxWith({
      getMenu: async () => ({ menu: { items: [] } }),
    }, { status: 2 }))

    await assert.rejects(
      () => platform.getPrivateMenu('100'),
      (error: unknown) => error instanceof MenuPlatformError && error.code === 'bot-offline',
    )
  })

  it('createPanel 的 40030013 映射为 quantity-limit', async () => {
    const platform = createKoishiMenuPlatform(ctxWith({
      createPanel: async () => {
        throw { response: { data: { err_code: 40030013 } } }
      },
    }))
    await assert.rejects(
      () => platform.createCommandPanel('100', 'group', { items: [] }),
      (error: unknown) => error instanceof MenuPlatformError && error.code === 'quantity-limit',
    )
  })

  it('modifyPanel 的 40030006 映射为 panel-missing', async () => {
    const platform = createKoishiMenuPlatform(ctxWith({
      modifyPanel: async () => {
        throw { err: 40030006 }
      },
    }))
    await assert.rejects(
      () => platform.modifyCommandPanel('100', 'p1', { items: [] }),
      (error: unknown) => error instanceof MenuPlatformError && error.code === 'panel-missing',
    )
  })

  it('deletePanel 的 40030006 幂等返回，不抛错', async () => {
    const platform = createKoishiMenuPlatform(ctxWith({
      deletePanel: async () => {
        throw { code: 40030006 }
      },
    }))
    await platform.deleteCommandPanel('100', 'p1')
  })

  it('createPanel 按使用场景创建 target_type=all 面板', async () => {
    const calls: unknown[] = []
    const platform = createKoishiMenuPlatform(ctxWith({
      createPanel: async (data: unknown) => {
        calls.push(data)
        return { panel_id: 'new', version: 3 }
      },
    }))
    const created = await platform.createCommandPanel('100', 'c2c', { items: [] })
    assert.equal(created.panelId, 'new')
    assert.deepEqual(calls, [{ scope: 'c2c', target_type: 'all', panel: { items: [] } }])
  })

  it('按使用场景分页拉取面板并保留 remark / updatedAt / items', async () => {
    const pages = [
      {
        records: [{
          panel_id: 'p1',
          target_type: 'all',
          updated_at: '2026-10-10T00:00:00.000Z',
          panel: { remark: '旧面板', items: [{ name: '/a', desc: 'A', type: 'command', only_admin: false }] },
        }],
        next_cursor: 'c2',
        is_end: false,
      },
      {
        records: [{ panel_id: 'p2', target_type: 'specific', panel: { items: [] } }],
        next_cursor: '',
        is_end: true,
      },
    ]
    const queries: unknown[] = []
    let call = 0
    const platform = createKoishiMenuPlatform(ctxWith({
      getPanels: async (params: unknown) => {
        queries.push(params)
        return pages[call++]
      },
    }))

    const panels = await platform.listCommandPanels('100', 'group')
    assert.equal(call, 2)
    assert.deepEqual(queries[0], { scope: 'group', cursor: '', limit: 50 })
    assert.deepEqual(queries[1], { scope: 'group', cursor: 'c2', limit: 50 })
    assert.equal(panels.length, 2)
    assert.equal(panels[0].panelId, 'p1')
    assert.equal(panels[0].scope, 'group')
    assert.equal(panels[0].targetType, 'all')
    assert.equal(panels[0].remark, '旧面板')
    assert.equal(panels[0].updatedAt, '2026-10-10T00:00:00.000Z')
    assert.deepEqual(panels[0].panel.items, [{ name: '/a', desc: 'A', type: 'command', only_admin: false }])
    assert.equal(panels[1].targetType, 'specific')
  })
})
