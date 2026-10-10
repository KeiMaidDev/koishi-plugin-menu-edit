import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { MenuPlatformError } from '../src/platform'
import type { PanelConfiguration } from '../src/types'
import { createHarness, type Harness } from './harness'

const harnesses: Harness[] = []

function harness(): Harness {
  const instance = createHarness()
  harnesses.push(instance)
  return instance
}

afterEach(() => {
  for (const instance of harnesses.splice(0)) instance.cleanup()
})

function configuration(overrides: Partial<PanelConfiguration> = {}): PanelConfiguration {
  return {
    privateMenu: { items: [] },
    commandPanel: { remark: 'menu-edit', items: [] },
    ...overrides,
  }
}

function commandItem(name: string, scopes: string[], extra: Record<string, unknown> = {}) {
  return { name, desc: '', type: 'command', only_admin: false, scopes, ...extra }
}

function commandPanel(items: unknown[], remark = 'menu-edit') {
  return { remark, items }
}

describe('Drift：刷新平台状态', () => {
  it('未发布时返回 unpublished，导入后相同内容返回 same', async () => {
    const instance = harness()
    const fresh = await instance.service.refreshPlatform({ appId: '100' })
    assert.ok('privateMenu' in fresh)
    if (!('privateMenu' in fresh)) return
    assert.equal(fresh.privateMenu.state, 'unpublished')
    assert.deepEqual(fresh.scopes.map(scope => scope.state), ['unpublished', 'unpublished', 'unpublished', 'unpublished'])

    const menu = { items: [{ name: '帮助', type: 'send_message', send_message: '/help' }] }
    instance.platform.seed('100', menu, 3)
    instance.platform.seedCommandPanel('100', 'p-g', 'group', commandPanel([commandItem('/g', ['group'])]), { version: 5 })
    await instance.service.importPrivateMenu({ appId: '100' })
    await instance.service.importCommandPanel({ appId: '100' })

    const same = await instance.service.refreshPlatform({ appId: '100' })
    assert.ok('privateMenu' in same)
    if (!('privateMenu' in same)) return
    assert.equal(same.privateMenu.state, 'same')
    assert.equal(same.scopes.find(scope => scope.scope === 'group')?.state, 'same')
  })

  it('平台被外部修改时按场景返回 changed 与差异摘要', async () => {
    const instance = harness()
    instance.platform.seed('100', { items: [{ name: '帮助', type: 'send_message', send_message: '/help' }] }, 3)
    instance.platform.seedCommandPanel('100', 'p-g', 'group', commandPanel([commandItem('/old', ['group'])]), { version: 5 })
    await instance.service.importPrivateMenu({ appId: '100' })
    await instance.service.importCommandPanel({ appId: '100' })

    // 外部写入者覆盖平台内容。
    instance.platform.seed('100', { items: [{ name: '外部', type: 'send_message', send_message: '/ext' }] }, 4)
    instance.platform.seedCommandPanel('100', 'p-g', 'group', commandPanel([commandItem('/external', ['group'])]), { version: 6 })

    const report = await instance.service.refreshPlatform({ appId: '100' })
    assert.ok('privateMenu' in report)
    if (!('privateMenu' in report)) return
    assert.equal(report.privateMenu.state, 'changed')
    // Draft 视角：平台多出的「外部」是待覆盖差异；Draft 的「帮助」平台没有，视为 added。
    assert.deepEqual(report.privateMenu.diffs.map(diff => diff.kind + ':' + diff.name), ['added:帮助', 'removed:外部'])
    const group = report.scopes.find(scope => scope.scope === 'group')
    assert.equal(group?.state, 'changed')
    assert.deepEqual(group?.diffs.map(diff => diff.kind + ':' + diff.name), ['added:/old', 'removed:/external'])

    // 键序不同但内容相同的平台返回不应产生假 Drift。
    instance.platform.seedCommandPanel('100', 'p-c2c', 'c2c', { remark: 'menu-edit', items: [{ type: 'command', only_admin: false, desc: '', name: '/same', scopes: [] }] }, { version: 9 })
    await instance.service.importCommandPanel({ appId: '100' })
    const stable = await instance.service.refreshPlatform({ appId: '100' })
    assert.ok('privateMenu' in stable)
    if (!('privateMenu' in stable)) return
    assert.equal(stable.scopes.find(scope => scope.scope === 'c2c')?.state, 'same')
  })

  it('受管面板被删除时返回 missing，平台读取失败时对应场景返回 error 且不影响其他场景', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-g', 'group', commandPanel([commandItem('/g', ['group'])]), { version: 5 })
    await instance.service.importCommandPanel({ appId: '100' })
    instance.platform.removeCommandPanel('100', 'p-g')

    const missing = await instance.service.refreshPlatform({ appId: '100' })
    assert.ok('privateMenu' in missing)
    if (!('privateMenu' in missing)) return
    assert.equal(missing.scopes.find(scope => scope.scope === 'group')?.state, 'missing')

    instance.platform.listPanelError = new MenuPlatformError('platform-error', '平台错误')
    const report = await instance.service.refreshPlatform({ appId: '100' })
    assert.ok('privateMenu' in report)
    if (!('privateMenu' in report)) return
    assert.equal(report.scopes.find(scope => scope.scope === 'group')?.state, 'error')
  })

  it('平台只改字段（同名同类型）时仍报告 changed，并照常要求 Drift 确认', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-g', 'group', commandPanel([commandItem('/g', ['group'], { desc: 'old' })]), { version: 5 })
    await instance.service.importCommandPanel({ appId: '100' })

    const revision = (await instance.service.loadWorkspace('100')).revision
    const saved = await instance.service.saveDraft({
      appId: '100',
      expectedRevision: revision,
      configuration: configuration({ commandPanel: commandPanel([commandItem('/g', ['group'], { desc: 'draft' })]) }),
    })
    assert.ok(saved.ok)
    if (!saved.ok) return

    // 外部写入者只改 desc：Draft 与平台的差异形状和 Draft 与 Published 的差异形状完全相同，
    // 旧的 (kind, name) 签名比较会误判为 same，从而既不提示也不要求确认。
    instance.platform.seedCommandPanel('100', 'p-g', 'group', commandPanel([commandItem('/g', ['group'], { desc: 'external' })]), { version: 6 })

    const report = await instance.service.refreshPlatform({ appId: '100' })
    assert.ok('privateMenu' in report)
    if (!('privateMenu' in report)) return
    const group = report.scopes.find(scope => scope.scope === 'group')
    assert.equal(group?.state, 'changed')
    assert.deepEqual(group?.diffs, [{ kind: 'modified', name: '/g' }])

    const blocked = await instance.service.publishCommandPanel({
      appId: '100',
      expectedRevision: saved.revision,
      confirmWarnings: true,
    })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.code, 'drift-confirmation-required')
    assert.equal(instance.platform.panelWrites.length, 0)
  })
})

describe('Drift：Publish 确认门禁', () => {
  it('Private Menu 存在 Drift 时返回 drift-confirmation-required，确认后写入平台', async () => {
    const instance = harness()
    instance.platform.seed('100', { items: [{ name: '帮助', type: 'send_message', send_message: '/help' }] }, 3)
    await instance.service.importPrivateMenu({ appId: '100' })
    instance.platform.seed('100', { items: [{ name: '外部', type: 'send_message', send_message: '/ext' }] }, 4)

    const revision = (await instance.service.loadWorkspace('100')).revision
    const draft = configuration({ privateMenu: { items: [{ name: '新', type: 'send_message', send_message: '/new' }] } })
    await instance.service.saveDraft({ appId: '100', expectedRevision: revision, configuration: draft })

    const blocked = await instance.service.publishPrivateMenu({ appId: '100', expectedRevision: revision + 1 })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.code, 'drift-confirmation-required')
    assert.ok(blocked.drift?.privateMenu.state === 'changed')
    assert.equal(instance.platform.setCalls.length, 0)

    const confirmed = await instance.service.publishPrivateMenu({
      appId: '100',
      expectedRevision: revision + 1,
      confirmDrift: { privateMenu: true },
    })
    assert.ok(confirmed.ok)
    assert.equal(instance.platform.setCalls.length, 1)
  })

  it('Command Panel 某场景 Drift 时按场景要求确认，其他场景不受影响', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-g', 'group', commandPanel([commandItem('/g', ['group'])]), { version: 5 })
    await instance.service.importCommandPanel({ appId: '100' })
    instance.platform.seedCommandPanel('100', 'p-g', 'group', commandPanel([commandItem('/external', ['group'])]), { version: 6 })

    const revision = (await instance.service.loadWorkspace('100')).revision
    const blocked = await instance.service.publishCommandPanel({ appId: '100', expectedRevision: revision, confirmWarnings: true })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.code, 'drift-confirmation-required')
    assert.deepEqual(blocked.drift?.scopes.filter(scope => scope.state === 'changed').map(scope => scope.scope), ['group'])
    assert.equal(instance.platform.panelWrites.length, 0)

    const confirmed = await instance.service.publishCommandPanel({
      appId: '100',
      expectedRevision: revision,
      confirmDrift: { scopes: { group: true } },
      confirmWarnings: true,
    })
    assert.ok(confirmed.ok)
    assert.ok(instance.platform.panelWrites.some(write => write.op === 'modify' && write.panelId === 'p-g'))
  })

  it('Publish 使用过期 expected revision（Draft 已被其他调用改写）时返回 revision-conflict，且不写平台', async () => {
    const instance = harness()
    instance.platform.seedCommandPanel('100', 'p-g', 'group', commandPanel([commandItem('/g', ['group'])]), { version: 5 })
    await instance.service.importCommandPanel({ appId: '100' })
    const revision = (await instance.service.loadWorkspace('100')).revision

    // 第一次发布成功后 revision 递增；携带旧 expected revision 的第二次发布必须失败，
    // 这就是「发布请求携带 expected revision、期间被改写则失败」的门禁。
    await instance.service.publishCommandPanel({ appId: '100', expectedRevision: revision, confirmWarnings: true })
    const stale = await instance.service.publishCommandPanel({
      appId: '100',
      expectedRevision: revision,
      confirmDrift: { scopes: { group: true } },
      confirmWarnings: true,
    })
    assert.equal(stale.ok, false)
    if (stale.ok) return
    assert.equal(stale.code, 'revision-conflict')
  })

  it('离线机器人刷新平台状态时返回整体 bot-offline，不读取平台', async () => {
    const instance = harness()
    const report = await instance.service.refreshPlatform({ appId: '200' })
    assert.ok(!('privateMenu' in report))
    if ('privateMenu' in report) return
    assert.equal(report.code, 'bot-offline')
  })
})
