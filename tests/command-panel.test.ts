import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { deriveScopeItems, scopeItemCounts, stripPanelItemScopes } from '../src/command-panel'
import { PANEL_WRITE_INTERVAL_MS } from '../src/panel-throttle'
import { MenuPlatformError } from '../src/platform'
import {
  emptyPanelConfiguration,
  PANEL_SCOPES,
  type CommandPanelConfiguration,
  type PanelConfiguration,
  type PanelScope,
} from '../src/types'
import { createHarness, type FakeBot, type Harness, type HarnessOptions } from './harness'

const harnesses: Harness[] = []

function harness(bots?: FakeBot[], options?: HarnessOptions): Harness {
  const instance = createHarness(bots, options)
  harnesses.push(instance)
  return instance
}

afterEach(() => {
  for (const instance of harnesses.splice(0)) instance.cleanup()
})

function configuration(commandPanel: CommandPanelConfiguration): PanelConfiguration {
  return { privateMenu: { items: [] }, commandPanel }
}

function commandPanel(
  items: Record<string, unknown>[],
  remark = 'menu-edit',
): CommandPanelConfiguration {
  return { remark, items }
}

function commandItem(name: string, scopes: PanelScope[], extra: Record<string, unknown> = {}) {
  return { name, desc: '', type: 'command', only_admin: false, scopes, ...extra }
}

async function saveCommand(instance: Harness, expectedRevision: number, panel: CommandPanelConfiguration) {
  const result = await instance.service.saveDraft({
    appId: '100',
    expectedRevision,
    configuration: configuration(panel),
  })
  if (!result.ok) assert.fail(`期望保存成功，实际为 ${result.reason}`)
  return result.revision
}

/** 先发一次不带 cleanupPanelIds 的 Publish 取得候选列表，再用确认列表发第二次。 */
async function publishWithCleanup(
  instance: Harness,
  expectedRevision: number,
  cleanupPanelIds: Partial<Record<PanelScope, string[]>>,
) {
  const listed = await instance.service.publishCommandPanel({ appId: '100', expectedRevision })
  assert.equal(listed.ok, false)
  if (listed.ok) assert.fail('期望先返回 cleanup-confirmation-required')
  assert.equal(listed.code, 'cleanup-confirmation-required')
  return instance.service.publishCommandPanel({ appId: '100', expectedRevision, cleanupPanelIds })
}

describe('Command Panel：按场景派生', () => {
  it('四个场景各取 scopes 命中的条目，顺序等于列表顺序，并剥掉本地 scopes', () => {
    const panel = commandPanel([
      { name: '/all', scopes: [...PANEL_SCOPES], type: 'command' },
      { name: '/group', scopes: ['group'], type: 'command' },
      { name: '/c2c', scopes: ['c2c'], type: 'command' },
      { name: '/channel-dm', scopes: ['channel', 'dm'], type: 'command' },
    ])

    assert.deepEqual(deriveScopeItems(panel, 'group').map(item => item.name), ['/all', '/group'])
    assert.deepEqual(deriveScopeItems(panel, 'c2c').map(item => item.name), ['/all', '/c2c'])
    assert.deepEqual(deriveScopeItems(panel, 'channel').map(item => item.name), ['/all', '/channel-dm'])
    assert.deepEqual(deriveScopeItems(panel, 'dm').map(item => item.name), ['/all', '/channel-dm'])
    assert.equal('scopes' in deriveScopeItems(panel, 'group')[0], false)
    assert.equal('scopes' in stripPanelItemScopes({ name: '/x', scopes: ['group'], future: 1 }), false)
    assert.deepEqual(scopeItemCounts(panel), { channel: 2, dm: 2, group: 2, c2c: 2 })
  })
})
describe('MenuService：Command Panel 首次导入与接管', () => {
  it('零个候选时留空且不预创建面板，Draft 与 Published 都从空开始', async () => {
    const instance = harness()
    const result = await instance.service.importCommandPanel({ appId: '100' })
    assert.ok(result.ok)
    if (!result.ok) return

    assert.equal(result.revision, 1)
    assert.deepEqual(result.managedPanelIds, {})
    assert.equal(instance.platform.listOf('100').length, 0, '零候选不应创建面板')

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, 1)
    assert.deepEqual(snapshot.published.commandPanels, {})
    assert.deepEqual(snapshot.draft.commandPanel.items, [])
    assert.deepEqual(snapshot.draft.commandPanel, snapshot.importedConfiguration?.commandPanel)
  })

  it('单候选场景自动接管，保留平台版本与未知条目字段', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-group', 'group', commandPanel([
      { name: '/签到', scopes: [], type: 'command', futureField: 42 },
    ]), { version: 7 })

    const result = await instance.service.importCommandPanel({ appId: '100' })
    assert.ok(result.ok)
    if (!result.ok) return

    assert.deepEqual(result.managedPanelIds, { group: 'p-group' })
    assert.equal(instance.platform.panelWrites.length, 0, '自动接管不应写平台')

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.published.commandPanels.group?.panelId, 'p-group')
    assert.equal(snapshot.published.commandPanels.group?.version, 7)
    const imported = snapshot.draft.commandPanel.items[0] as Record<string, unknown>
    assert.deepEqual(imported.scopes, ['group'])
    assert.equal(imported.futureField, 42)
  })

  it('多个候选时返回 selection-required，携带选中 panelId 后按场景接管', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p1', 'group', commandPanel([commandItem('/a', [])]), { remark: 'a' })
    instance.platform.seedCommandPanel('100', 'p2', 'group', commandPanel([commandItem('/b', [])]), { remark: 'b' })
    instance.platform.seedCommandPanel('100', 'c1', 'channel', commandPanel([commandItem('/c', [])]))

    const first = await instance.service.importCommandPanel({ appId: '100' })
    assert.equal(first.ok, false)
    if (first.ok) return
    assert.equal(first.code, 'selection-required')
    assert.deepEqual(first.candidates.map(item => item.scope), ['group'])
    assert.deepEqual(first.candidates[0].candidates.map(item => item.panelId).sort(), ['p1', 'p2'])

    const second = await instance.service.importCommandPanel({ appId: '100', selections: { group: 'p2' } })
    assert.ok(second.ok)
    if (!second.ok) return
    assert.deepEqual(second.managedPanelIds, { channel: 'c1', group: 'p2' })
    const snapshot = await instance.service.loadWorkspace('100')
    assert.deepEqual(snapshot.published.commandPanels.group?.cleanup.panelIds, ['p1'])
  })

  it('跨场景同名且字段一致的条目合并为一条并把 scopes 取并集', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-group', 'group', commandPanel([
      { name: '/帮助', desc: '帮助', type: 'command', only_admin: false, futureGroup: 42 },
    ]))
    instance.platform.seedCommandPanel('100', 'p-c2c', 'c2c', commandPanel([
      { name: '/帮助', desc: '帮助', type: 'command', only_admin: false, futureC2c: 43 },
    ]))

    const result = await instance.service.importCommandPanel({ appId: '100' })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.deepEqual(result.conflicts, [])
    assert.equal(result.imported.items.length, 1)
    const imported = result.imported.items[0] as Record<string, unknown>
    assert.deepEqual(imported.scopes, ['group', 'c2c'])
    assert.equal(imported.futureGroup, 42)
    assert.equal(imported.futureC2c, 43)
  })

  it('同名但字段不一致时保留为多条并报告冲突', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-group', 'group', commandPanel([
      { name: '/帮助', desc: '群帮助', type: 'command', only_admin: false },
    ]))
    instance.platform.seedCommandPanel('100', 'p-c2c', 'c2c', commandPanel([
      { name: '/帮助', desc: '单聊帮助', type: 'command', only_admin: false },
    ]))

    const result = await instance.service.importCommandPanel({ appId: '100' })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.imported.items.length, 2)
    assert.deepEqual(result.conflicts.map(conflict => conflict.name), ['/帮助'])
    assert.deepEqual(result.conflicts[0].scopes, ['group', 'c2c'])
    assert.equal(result.conflicts[0].variants, 2)
  })

  it('specific 面板不作为候选，也不被接管', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-specific', 'group', commandPanel([commandItem('/spec', [])]), { targetType: 'specific' })

    const result = await instance.service.importCommandPanel({ appId: '100' })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.deepEqual(result.managedPanelIds, {})
    assert.equal(result.specificPanels.group?.[0].panelId, 'p-specific')
    assert.equal(instance.platform.listOf('100', 'group').length, 1)
  })
})
describe('MenuService：Command Panel 发布', () => {
  it('按场景派生内容：改写受管面板、删除其他 all 面板，specific 不被触碰', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-group', 'group', commandPanel([commandItem('/old', ['group'])]))
    await instance.service.importCommandPanel({ appId: '100' })
    instance.platform.seedCommandPanel('100', 'p-other', 'group', commandPanel([commandItem('/other', [])]))
    instance.platform.seedCommandPanel('100', 'c-other', 'channel', commandPanel([commandItem('/channel', [])]))
    instance.platform.seedCommandPanel('100', 'p-specific', 'group', commandPanel([commandItem('/spec', [])]), { targetType: 'specific' })

    const revision = await saveCommand(instance, 1, commandPanel([
      commandItem('/new', ['group'], { desc: '新' }),
    ]))

    const result = await publishWithCleanup(instance, revision, { group: ['p-other'], channel: ['c-other'] })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.status, 'published')

    assert.deepEqual(instance.platform.listOf('100', 'group').map(panel => panel.panelId).sort(), ['p-group', 'p-specific'])
    assert.equal(instance.platform.listOf('100', 'channel').length, 0)
    assert.equal(instance.platform.listOf('100', 'group').find(panel => panel.panelId === 'p-group')?.panel.items.length, 1)
    assert.deepEqual(result.published.group?.panelId, 'p-group')
    assert.deepEqual(result.published.group?.cleanup.panelIds, [])
    assert.equal(result.published.channel, undefined)
  })

  it('场景没有条目时删除该场景的受管面板并清空 cleanup', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-group', 'group', commandPanel([commandItem('/old', ['group'])]))
    await instance.service.importCommandPanel({ appId: '100' })

    const revision = await saveCommand(instance, 1, commandPanel([]))
    const result = await publishWithCleanup(instance, revision, { group: ['p-group'] })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(instance.platform.listOf('100', 'group').length, 0)
    assert.equal(result.published.group, undefined)
  })

  it('同一场景没有候选时创建 all 面板', async () => {
    const instance = harness()
    const revision = await saveCommand(instance, 0, commandPanel([commandItem('/created', ['c2c'])]))
    const result = await instance.service.publishCommandPanel({ appId: '100', expectedRevision: revision })
    assert.ok(result.ok)
    if (!result.ok) return

    const created = instance.platform.listOf('100', 'c2c')
    assert.equal(created.length, 1)
    assert.equal(created[0].targetType, 'all')
    assert.equal(result.published.c2c?.panelId, created[0].panelId)
  })

  it('清理部分失败返回 partial，并把待清理 panel ID 持久化到对应场景', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p1', 'group', commandPanel([commandItem('/managed', ['group'])]))
    instance.platform.seedCommandPanel('100', 'p2', 'group', commandPanel([commandItem('/a', [])]))
    instance.platform.seedCommandPanel('100', 'p3', 'group', commandPanel([commandItem('/b', [])]))
    await instance.service.importCommandPanel({ appId: '100', selections: { group: 'p1' } })
    const revision = await saveCommand(instance, 1, commandPanel([commandItem('/new', ['group'])]))
    instance.platform.deletePanelErrors.set('p3', new MenuPlatformError('platform-error', '删除失败'))

    const result = await publishWithCleanup(instance, revision, { group: ['p2', 'p3'] })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.published.group?.cleanup.panelIds, ['p3'])

    const snapshot = await instance.service.loadWorkspace('100')
    assert.deepEqual(snapshot.published.commandPanels.group?.cleanup.panelIds, ['p3'])
  })

  it('跨场景连续写入按 AppID 串行并保持至少 6500ms 间隔', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-group', 'group', commandPanel([commandItem('/g', ['group'])]))
    instance.platform.seedCommandPanel('100', 'p-c2c', 'c2c', commandPanel([commandItem('/c', ['c2c'])]))
    await instance.service.importCommandPanel({ appId: '100' })
    const revision = await saveCommand(instance, 1, commandPanel([
      commandItem('/g2', ['group']),
      commandItem('/c2', ['c2c']),
    ]))

    const result = await instance.service.publishCommandPanel({ appId: '100', expectedRevision: revision })
    assert.ok(result.ok)

    const writes = instance.platform.panelWrites.filter(write => write.appId === '100')
    assert.deepEqual(writes.map(write => write.op), ['modify', 'modify'])
    assert.ok(writes[1].at - writes[0].at >= PANEL_WRITE_INTERVAL_MS)
  })

  it('Managed Panel 写入遇到 40030013 时按场景返回 quantity-limit 并保留旧 Published Revision', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p1', 'group', commandPanel([commandItem('/old', ['group'])]), { version: 5 })
    await instance.service.importCommandPanel({ appId: '100' })
    const revision = await saveCommand(instance, 1, commandPanel([commandItem('/new', ['group'])]))
    instance.platform.modifyPanelError = new MenuPlatformError('quantity-limit', '40030013')

    const result = await instance.service.publishCommandPanel({ appId: '100', expectedRevision: revision })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.scopeResults.find(item => item.scope === 'group'), {
      scope: 'group',
      status: 'failed',
      code: 'quantity-limit',
      message: '40030013',
    })

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, revision)
    assert.deepEqual(snapshot.published.commandPanels.group?.panel.items.map(item => (item as Record<string, unknown>).name), ['/old'])
    assert.equal(snapshot.published.commandPanels.group?.version, 5)
  })

  it('单个场景写入失败不阻断其他场景，并按场景返回聚合结果', async () => {
    const instance = harness()
    const revision = await saveCommand(instance, 0, commandPanel([
      commandItem('/group', ['group']),
      commandItem('/c2c', ['c2c']),
    ]))
    instance.platform.createPanelErrors.set('c2c', new MenuPlatformError('platform-error', 'c2c failed'))

    const result = await instance.service.publishCommandPanel({ appId: '100', expectedRevision: revision })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.scopeResults, [
      { scope: 'channel', status: 'success' },
      { scope: 'dm', status: 'success' },
      { scope: 'group', status: 'success' },
      { scope: 'c2c', status: 'failed', code: 'platform-error', message: 'c2c failed' },
    ])
    assert.equal(instance.platform.listOf('100', 'group').length, 1)
    assert.equal(instance.platform.listOf('100', 'c2c').length, 0)
    assert.equal(result.revision, revision + 1)

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, revision + 1)
    assert.ok(snapshot.published.commandPanels.group)
    assert.equal(snapshot.published.commandPanels.c2c, undefined)
  })

  it('expected revision 不匹配时返回 revision-conflict，且不写平台', async () => {
    const instance = harness()
    await saveCommand(instance, 0, commandPanel([commandItem('/help', ['group'])]))
    const result = await instance.service.publishCommandPanel({ appId: '100', expectedRevision: 99 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'revision-conflict')
    assert.equal(instance.platform.panelWrites.length, 0)
  })

  it('空 Draft 发布不创建多余面板', async () => {
    const instance = harness()
    const result = await instance.service.publishCommandPanel({ appId: '100', expectedRevision: 0 })
    assert.ok(result.ok)
    assert.equal(instance.platform.listOf('100').length, 0)
    assert.deepEqual(emptyPanelConfiguration().commandPanel.items, [])
  })
})
