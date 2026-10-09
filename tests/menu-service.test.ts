import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { MenuServiceError } from '../src/menu-service'
import { MenuPlatformError } from '../src/platform'
import {
  emptyPanelConfiguration,
  type PanelConfiguration,
  type WorkspaceSnapshot,
} from '../src/types'
import { createHarness, makeState, type FakeBot, type Harness, type HarnessOptions } from './harness'

const harnesses: Harness[] = []

function harness(bots?: FakeBot[], options?: HarnessOptions): Harness {
  const instance = createHarness(bots, options)
  harnesses.push(instance)
  return instance
}

afterEach(() => {
  for (const instance of harnesses.splice(0)) instance.cleanup()
})

function configuration(overrides: Partial<PanelConfiguration> = {}): PanelConfiguration {
  return {
    privateMenu: { items: [] },
    groupPanel: { remark: 'menu-edit', items: [] },
    ...overrides,
  }
}

async function expectSaved(result: Awaited<ReturnType<Harness['service']['saveDraft']>>) {
  if (!result.ok) assert.fail(`期望保存成功，实际为 ${result.reason}`)
  return result
}

describe('MenuService：Bot Instance 列表', () => {
  it('只返回 platform === qq 的实例，按 AppID 区分并带名称、头像与在线状态', () => {
    const { service } = harness([
      { platform: 'qq', selfId: '100', config: { id: '100' }, isActive: true, user: { name: '一号机', avatar: 'https://example.com/100.png' } },
      // qqguild 子机器人不是独立的菜单目标
      { platform: 'qqguild', selfId: '100', config: { id: '100' }, isActive: true, user: { name: '频道机器人' } },
      { platform: 'qq', selfId: '200', config: { id: 200 }, isActive: false, user: null },
      { platform: 'discord', selfId: '300', config: { id: '300' }, isActive: true },
    ])

    assert.deepEqual(service.listBots(), [
      { appId: '100', name: '一号机', avatar: 'https://example.com/100.png', online: true },
      { appId: '200', name: '200', avatar: '', online: false },
    ])
  })

  it('拒绝访问未知的 AppID', async () => {
    const { service } = harness()
    await assert.rejects(
      () => service.loadWorkspace('999'),
      (error: unknown) => error instanceof MenuServiceError && error.code === 'unknown-bot',
    )
  })
})

describe('MenuService：Draft 保存与 revision', () => {
  it('首次保存递增 revision，重启后仍能读回同一份 Draft', async () => {
    const instance = harness()
    const initial = await instance.service.loadWorkspace('100')
    assert.equal(initial.revision, 0)

    const draft = configuration({
      privateMenu: { items: [{ name: '帮助', type: 'send_message', send_message: '/help' }] },
    })
    const saved = await expectSaved(await instance.service.saveDraft({
      appId: '100',
      expectedRevision: 0,
      configuration: draft,
    }))
    assert.equal(saved.revision, 1)

    const snapshot: WorkspaceSnapshot = await instance.restart().loadWorkspace('100')
    assert.equal(snapshot.revision, 1)
    assert.deepEqual(snapshot.draft, draft)
  })

  it('只读加载不落盘，首次保存才创建状态文件', async () => {
    const instance = harness()
    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, 0)
    assert.equal(await instance.store.read('100'), null)

    await expectSaved(await instance.service.saveDraft({
      appId: '100',
      expectedRevision: 0,
      configuration: configuration(),
    }))
    assert.equal((await instance.store.read('100'))?.revision, 1)
  })

  it('未知字段经过保存后原样保留', async () => {
    const { service } = harness()
    const draft = configuration({
      privateMenu: { items: [], futureFlag: true },
      groupPanel: { remark: 'menu-edit', items: [], futurePanelField: { nested: 1 } },
      unknownTopLevel: 'keep-me',
    })

    await expectSaved(await service.saveDraft({ appId: '100', expectedRevision: 0, configuration: draft }))
    const snapshot = await service.loadWorkspace('100')
    assert.deepEqual(snapshot.draft, draft)
  })

  it('过期 expected revision 返回 revision-conflict，且不覆盖已有内容', async () => {
    const { service } = harness()
    const first = configuration({ privateMenu: { items: [{ name: '第一版' }] } })
    const second = configuration({ privateMenu: { items: [{ name: '第二版' }] } })

    await expectSaved(await service.saveDraft({ appId: '100', expectedRevision: 0, configuration: first }))
    const conflict = await service.saveDraft({ appId: '100', expectedRevision: 0, configuration: second })

    assert.equal(conflict.ok, false)
    if (conflict.ok) return
    assert.equal(conflict.reason, 'revision-conflict')
    assert.equal(conflict.revision, 1)
    assert.deepEqual(conflict.draft, first)

    const snapshot = await service.loadWorkspace('100')
    assert.equal(snapshot.revision, 1)
    assert.deepEqual(snapshot.draft, first)
  })

  it('同一 AppID 的并发保存被串行化，只有一个请求能赢得 revision', async () => {
    const { service } = harness()
    const a = configuration({ privateMenu: { items: [{ name: 'A' }] } })
    const b = configuration({ privateMenu: { items: [{ name: 'B' }] } })

    const [resultA, resultB] = await Promise.all([
      service.saveDraft({ appId: '100', expectedRevision: 0, configuration: a }),
      service.saveDraft({ appId: '100', expectedRevision: 0, configuration: b }),
    ])

    assert.equal([resultA, resultB].filter(result => result.ok).length, 1)
    const failed = [resultA, resultB].find(result => !result.ok)
    assert.ok(failed && !failed.ok)
    if (!failed.ok) assert.equal(failed.revision, 1)

    const snapshot = await service.loadWorkspace('100')
    assert.equal(snapshot.revision, 1)
    assert.deepEqual(snapshot.draft, resultA.ok ? a : b)
  })
})

describe('MenuService：Discard Draft', () => {
  it('恢复到导入后的初始 Panel Configuration，并递增 revision', async () => {
    const instance = harness()
    const initial = configuration({
      groupPanel: { remark: 'imported', items: [{ name: '/help', type: 'command' }] },
    })
    const dirty = configuration({ privateMenu: { items: [{ name: '草稿' }] } })
    await instance.store.write('100', makeState('100', {
      revision: 4,
      importedConfiguration: initial,
      draft: dirty,
    }))

    const result = await instance.service.discardDraft({ appId: '100', expectedRevision: 4 })
    if (!result.ok) assert.fail(`期望 Discard 成功，实际为 ${result.reason}`)
    assert.equal(result.revision, 5)

    const snapshot = await instance.service.loadWorkspace('100')
    assert.deepEqual(snapshot.draft, initial)
  })

  it('已发布的 surface 恢复 Published Revision，未发布的 surface 回退到初始导入内容', async () => {
    const instance = harness()
    const initial = configuration({
      groupPanel: { remark: 'imported', items: [{ name: '/imported', type: 'command' }] },
    })
    const publishedPrivateMenu = { items: [{ name: '已发布', type: 'send_message', send_message: '/published' }] }
    await instance.store.write('100', makeState('100', {
      revision: 7,
      importedConfiguration: initial,
      draft: configuration({ privateMenu: { items: [{ name: '本地草稿' }] } }),
      published: {
        privateMenu: {
          menu: publishedPrivateMenu,
          version: 12,
          publishedAt: '2026-10-10T01:00:00.000Z',
        },
        groupPanel: null,
      },
    }))

    const result = await instance.service.discardDraft({ appId: '100', expectedRevision: 7 })
    if (!result.ok) assert.fail(`期望 Discard 成功，实际为 ${result.reason}`)

    const snapshot = await instance.service.loadWorkspace('100')
    assert.deepEqual(snapshot.draft.privateMenu, publishedPrivateMenu)
    assert.deepEqual(snapshot.draft.groupPanel, initial.groupPanel)
  })

  it('既无 Published Revision 也无导入内容时回到空配置', async () => {
    const { service } = harness()
    await expectSaved(await service.saveDraft({
      appId: '100',
      expectedRevision: 0,
      configuration: configuration({ privateMenu: { items: [{ name: '草稿' }] } }),
    }))

    const result = await service.discardDraft({ appId: '100', expectedRevision: 1 })
    if (!result.ok) assert.fail(`期望 Discard 成功，实际为 ${result.reason}`)

    const snapshot = await service.loadWorkspace('100')
    assert.deepEqual(snapshot.draft, emptyPanelConfiguration())
  })
})

describe('MenuService：多 AppID 隔离', () => {
  it('两个 AppID 的 Draft、revision 与保存队列互不串扰', async () => {
    const { service } = harness()
    const draftA = configuration({ privateMenu: { items: [{ name: 'A' }] } })
    const draftB = configuration({ privateMenu: { items: [{ name: 'B' }] } })

    const [resultA, resultB] = await Promise.all([
      service.saveDraft({ appId: '100', expectedRevision: 0, configuration: draftA }),
      service.saveDraft({ appId: '200', expectedRevision: 0, configuration: draftB }),
    ])
    assert.ok(resultA.ok)
    assert.ok(resultB.ok)

    // 只改 100，不影响 200 的 revision 与内容
    const draftA2 = configuration({ privateMenu: { items: [{ name: 'A2' }] } })
    await expectSaved(await service.saveDraft({ appId: '100', expectedRevision: 1, configuration: draftA2 }))

    const snapshotA = await service.loadWorkspace('100')
    const snapshotB = await service.loadWorkspace('200')
    assert.equal(snapshotA.revision, 2)
    assert.equal(snapshotB.revision, 1)
    assert.deepEqual(snapshotA.draft, draftA2)
    assert.deepEqual(snapshotB.draft, draftB)

    // 用 100 的过期 revision 操作 200 不应产生影响
    const conflict = await service.saveDraft({ appId: '200', expectedRevision: 1, configuration: draftA2 })
    assert.ok(conflict.ok)
    assert.equal((await service.loadWorkspace('100')).revision, 2)
  })
})




describe('MenuService：导入 Private Menu', () => {
  it('导入成功后写入 Draft 与 importedConfiguration，并递增 revision', async () => {
    const instance = harness()
    instance.platform.seed('100', {
      items: [{ name: '帮助', type: 'send_message', send_message: '/help' }],
      futureField: { keep: true },
    }, 7)

    const result = await instance.service.importPrivateMenu({ appId: '100' })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.revision, 1)
    assert.equal(result.importedAt.length > 0, true)

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, 1)
    assert.deepEqual(snapshot.draft.privateMenu, {
      items: [{ name: '帮助', type: 'send_message', send_message: '/help' }],
      futureField: { keep: true },
    })
    assert.deepEqual(snapshot.importedConfiguration?.privateMenu, snapshot.draft.privateMenu)
    // 导入内容成为 Discard 的恢复点
    await expectSaved(await instance.service.saveDraft({
      appId: '100',
      expectedRevision: 1,
      configuration: configuration({ privateMenu: { items: [{ name: '草稿' }] } }),
    }))
    const discarded = await instance.service.discardDraft({ appId: '100', expectedRevision: 2 })
    assert.ok(discarded.ok)
    assert.deepEqual((await instance.service.loadWorkspace('100')).draft.privateMenu, snapshot.draft.privateMenu)
  })

  it('平台读取失败时返回错误，且不写入任何状态、不以空配置覆盖 Draft', async () => {
    const instance = harness()
    instance.platform.getError = new MenuPlatformError('platform-error', '读取失败')

    const result = await instance.service.importPrivateMenu({ appId: '100' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'platform-error')
    assert.equal(await instance.store.read('100'), null)
  })

  it('离线机器人返回 bot-offline，不读取平台也不写状态', async () => {
    const instance = harness()
    const result = await instance.service.importPrivateMenu({ appId: '200' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'bot-offline')
    assert.equal(instance.platform.setCalls.length, 0)
    assert.equal(await instance.store.read('200'), null)
  })

  it('两个 AppID 导入的平台内容互不串扰', async () => {
    const instance = harness([
      { platform: 'qq', selfId: '100', config: { id: '100' }, isActive: true, user: { name: '一号机' } },
      { platform: 'qq', selfId: '200', config: { id: '200' }, isActive: true, user: { name: '二号机' } },
    ])
    instance.platform.seed('100', { items: [{ name: 'A', type: 'send_message', send_message: '/a' }] })
    instance.platform.seed('200', { items: [{ name: 'B', type: 'send_message', send_message: '/b' }] })

    await instance.service.importPrivateMenu({ appId: '100' })
    await instance.service.importPrivateMenu({ appId: '200' })

    assert.deepEqual((await instance.service.loadWorkspace('100')).draft.privateMenu.items, [{ name: 'A', type: 'send_message', send_message: '/a' }])
    assert.deepEqual((await instance.service.loadWorkspace('200')).draft.privateMenu.items, [{ name: 'B', type: 'send_message', send_message: '/b' }])
  })
})

describe('MenuService：Publish Private Menu', () => {
  it('整体覆盖写入平台，成功更新 Published Revision 并递增 revision', async () => {
    const instance = harness()
    const draft = configuration({
      privateMenu: { items: [{ name: '帮助', type: 'send_message', send_message: '/help' }] },
    })
    await expectSaved(await instance.service.saveDraft({ appId: '100', expectedRevision: 0, configuration: draft }))

    const result = await instance.service.publishPrivateMenu({ appId: '100', expectedRevision: 1 })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.revision, 2)
    assert.equal(result.published.version, 1)
    assert.deepEqual(instance.platform.setCalls, [{ appId: '100', menu: draft.privateMenu }])

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, 2)
    assert.deepEqual(snapshot.published.privateMenu?.menu, draft.privateMenu)
    assert.deepEqual(snapshot.draft.privateMenu, draft.privateMenu)
  })

  it('硬错误阻止发布，保留 Draft 与旧 Published Revision', async () => {
    const instance = harness()
    const items = Array.from({ length: 11 }, (_, index) => ({ name: `项${index}`, type: 'send_message', send_message: '/x' }))
    await expectSaved(await instance.service.saveDraft({
      appId: '100',
      expectedRevision: 0,
      configuration: configuration({ privateMenu: { items } }),
    }))

    const result = await instance.service.publishPrivateMenu({ appId: '100', expectedRevision: 1 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'validation-failed')
    assert.ok(result.errors.some(issue => issue.code === 'private-menu.items.max'))
    assert.equal(instance.platform.setCalls.length, 0)

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, 1)
    assert.deepEqual(snapshot.draft.privateMenu.items, items)
    assert.equal(snapshot.published.privateMenu, null)
  })

  it('平台写入失败时保留 Draft 与旧 Published Revision', async () => {
    const instance = harness()
    const oldMenu = { items: [{ name: '旧', type: 'send_message', send_message: '/old' }] }
    const draftMenu = { items: [{ name: '新', type: 'send_message', send_message: '/new' }] }
    await instance.store.write('100', makeState('100', {
      revision: 5,
      draft: configuration({ privateMenu: draftMenu }),
      published: {
        privateMenu: { menu: oldMenu, version: 9, publishedAt: '2026-10-10T00:00:00.000Z' },
        groupPanel: null,
      },
    }))
    instance.platform.setError = new MenuPlatformError('platform-error', '写入失败')

    const result = await instance.service.publishPrivateMenu({ appId: '100', expectedRevision: 5 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'platform-error')

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, 5)
    assert.deepEqual(snapshot.draft.privateMenu, draftMenu)
    assert.deepEqual(snapshot.published.privateMenu?.menu, oldMenu)
    assert.equal(snapshot.published.privateMenu?.version, 9)
  })

  it('expected revision 不匹配时返回 revision-conflict，且不写平台', async () => {
    const instance = harness()
    const result = await instance.service.publishPrivateMenu({ appId: '100', expectedRevision: 99 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'revision-conflict')
    assert.equal(instance.platform.setCalls.length, 0)
  })

  it('未知字段在 Publish 后原样带回平台', async () => {
    const instance = harness()
    const draft = configuration({
      privateMenu: {
        items: [{ name: '帮助', type: 'send_message', send_message: '/help', futureItemField: 42 }],
        futureTopField: { nested: true },
      },
      unknownTopLevel: 'keep-me',
    })
    await expectSaved(await instance.service.saveDraft({ appId: '100', expectedRevision: 0, configuration: draft }))
    const result = await instance.service.publishPrivateMenu({ appId: '100', expectedRevision: 1 })
    assert.ok(result.ok)
    assert.deepEqual(instance.platform.setCalls[0].menu, draft.privateMenu)
  })

  it('离线机器人返回 bot-offline，不写平台', async () => {
    const instance = harness()
    const result = await instance.service.publishPrivateMenu({ appId: '200', expectedRevision: 0 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'bot-offline')
    assert.equal(instance.platform.setCalls.length, 0)
  })
})


describe('MenuService：导入作为 Drift 基线', () => {
  it('导入成功后 Published Revision 记录平台当前内容与版本', async () => {
    const instance = harness()
    instance.platform.seed('100', { items: [{ name: '平台', type: 'send_message', send_message: '/x' }] }, 12)

    const result = await instance.service.importPrivateMenu({ appId: '100' })
    assert.ok(result.ok)

    const snapshot = await instance.service.loadWorkspace('100')
    assert.deepEqual(snapshot.published.privateMenu?.menu, { items: [{ name: '平台', type: 'send_message', send_message: '/x' }] })
    assert.equal(snapshot.published.privateMenu?.version, 12)
    assert.equal(snapshot.published.privateMenu?.publishedAt, result.ok ? result.importedAt : '')
  })
})
