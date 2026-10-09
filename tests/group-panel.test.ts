import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { PANEL_WRITE_INTERVAL_MS } from '../src/panel-throttle'
import { MenuPlatformError } from '../src/platform'
import {
  emptyPanelConfiguration,
  GROUP_PANEL_MAX_ITEMS,
  type GroupPanelConfiguration,
  type PanelConfiguration,
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

function configuration(groupPanel: GroupPanelConfiguration): PanelConfiguration {
  return { privateMenu: { items: [] }, groupPanel }
}

function panelConfig(names: string[], remark = 'menu-edit'): GroupPanelConfiguration {
  return {
    remark,
    items: names.map((name, index) => ({
      name,
      desc: `描述 ${index}`,
      type: 'command',
      only_admin: index % 2 === 1,
    })),
  }
}

/** 先发一次不带 cleanupPanelIds 的 Publish 取得候选列表，再用确认列表发第二次。 */
async function publishWithCleanup(instance: Harness, expectedRevision: number, cleanupPanelIds: string[]) {
  const listed = await instance.service.publishGroupPanel({ appId: '100', expectedRevision })
  assert.equal(listed.ok, false)
  if (listed.ok) assert.fail('期望先返回 cleanup-confirmation-required')
  assert.equal(listed.code, 'cleanup-confirmation-required')
  return instance.service.publishGroupPanel({ appId: '100', expectedRevision, cleanupPanelIds })
}
async function saveGroup(instance: Harness, expectedRevision: number, groupPanel: GroupPanelConfiguration) {
  const result = await instance.service.saveDraft({
    appId: '100',
    expectedRevision,
    configuration: configuration(groupPanel),
  })
  if (!result.ok) assert.fail(`期望保存成功，实际为 ${result.reason}`)
  return result.revision
}

describe('MenuService：Group Panel 首次导入与接管', () => {
  it('零个候选时创建 group/all Managed Panel，并写入 Draft 与 Published Revision 基线', async () => {
    const instance = harness()
    const result = await instance.service.importGroupPanel({ appId: '100' })
    assert.ok(result.ok)
    if (!result.ok) return

    assert.equal(result.created, true)
    assert.equal(result.revision, 1)
    const panels = instance.platform.listOf('100')
    assert.equal(panels.length, 1)
    assert.equal(panels[0].targetType, 'all')
    assert.equal(panels[0].panelId, result.managedPanelId)

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, 1)
    assert.equal(snapshot.published.groupPanel?.panelId, result.managedPanelId)
    assert.equal(snapshot.published.groupPanel?.cleanup.panelIds.length, 0)
    assert.deepEqual(snapshot.draft.groupPanel, snapshot.importedConfiguration?.groupPanel)
  })

  it('一个候选时自动接管，不创建新面板并保留平台内容与版本', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/签到'], 'existing'), { version: 7 })

    const result = await instance.service.importGroupPanel({ appId: '100' })
    assert.ok(result.ok)
    if (!result.ok) return

    assert.equal(result.created, false)
    assert.equal(result.managedPanelId, 'p1')
    assert.deepEqual(result.imported.items, panelConfig(['/签到']).items)
    assert.equal(instance.platform.groupWrites.filter(write => write.op === 'create').length, 0)

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.published.groupPanel?.panelId, 'p1')
    assert.equal(snapshot.published.groupPanel?.version, 7)
    assert.deepEqual(snapshot.draft.groupPanel.items, panelConfig(['/签到']).items)
  })

  it('多个候选时返回 selection-required 与候选摘要，且不写状态；携带 panelId 后可接管', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/a']), { remark: 'a', updatedAt: '2026-10-09T00:00:00.000Z' })
    instance.platform.seedGroupPanel('100', 'p2', panelConfig(['/b'], 'b'), { remark: 'b', updatedAt: '2026-10-10T00:00:00.000Z' })

    const result = await instance.service.importGroupPanel({ appId: '100' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'selection-required')
    assert.equal(result.candidates.length, 2)
    assert.deepEqual(result.candidates.map(candidate => candidate.panelId).sort(), ['p1', 'p2'])
    const candidate = result.candidates.find(item => item.panelId === 'p1')
    assert.equal(candidate?.remark, 'a')
    assert.equal(candidate?.updatedAt, '2026-10-09T00:00:00.000Z')
    assert.equal(candidate?.itemCount, 1)
    assert.equal(candidate?.itemSummary, '/a')
    assert.equal(await instance.store.read('100'), null)

    const adopted = await instance.service.importGroupPanel({ appId: '100', panelId: 'p2' })
    assert.ok(adopted.ok)
    if (!adopted.ok) return
    assert.equal(adopted.managedPanelId, 'p2')
    assert.deepEqual(adopted.imported.items, panelConfig(['/b']).items)
  })

  it('选择不存在的 panelId 返回 panel-missing，不写状态', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/a']))
    instance.platform.seedGroupPanel('100', 'p2', panelConfig(['/b']))

    const result = await instance.service.importGroupPanel({ appId: '100', panelId: 'missing' })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'panel-missing')
    assert.equal(await instance.store.read('100'), null)
  })

  it('离线机器人与创建 quota 错误返回稳定错误码，不写状态', async () => {
    const offline = harness()
    const offlineResult = await offline.service.importGroupPanel({ appId: '200' })
    assert.equal(offlineResult.ok, false)
    if (!offlineResult.ok) assert.equal(offlineResult.code, 'bot-offline')
    assert.equal(await offline.store.read('200'), null)

    const quota = harness()
    quota.platform.createGroupError = new MenuPlatformError('quantity-limit', '条目数量超限')
    const quotaResult = await quota.service.importGroupPanel({ appId: '100' })
    assert.equal(quotaResult.ok, false)
    if (!quotaResult.ok) assert.equal(quotaResult.code, 'quantity-limit')
    assert.equal(await quota.store.read('100'), null)
  })
})

describe('MenuService：Group Panel Publish', () => {
  it('没有已接管面板时创建新的 group/all Panel，并更新 Published Revision', async () => {
    const instance = harness()
    await saveGroup(instance, 0, panelConfig(['/help', '/sign']))

    const result = await instance.service.publishGroupPanel({ appId: '100', expectedRevision: 1 })
    assert.ok(result.ok)
    if (!result.ok) return

    assert.equal(result.status, 'published')
    assert.equal(instance.platform.groupWrites.filter(write => write.op === 'create').length, 1)
    const panels = instance.platform.listOf('100')
    assert.equal(panels.length, 1)
    assert.deepEqual(panels[0].panel.items, panelConfig(['/help', '/sign']).items)

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, 2)
    assert.equal(snapshot.published.groupPanel?.panelId, result.published.panelId)
    assert.deepEqual(snapshot.published.groupPanel?.panel, panelConfig(['/help', '/sign']))
  })

  it('优先修改已接管的 Managed Panel，而不是新建面板', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/old']))
    await instance.service.importGroupPanel({ appId: '100' })
    await saveGroup(instance, 1, panelConfig(['/new']))

    const result = await instance.service.publishGroupPanel({ appId: '100', expectedRevision: 2 })
    assert.ok(result.ok)
    if (!result.ok) return

    assert.equal(result.published.panelId, 'p1')
    assert.deepEqual(instance.platform.groupWrites.map(write => write.op), ['modify'])
    assert.deepEqual(instance.platform.listOf('100')[0].panel.items, panelConfig(['/new']).items)
  })

  it('已接管面板被外部删除时创建新的 group/all Panel', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/old']))
    await instance.service.importGroupPanel({ appId: '100' })
    await saveGroup(instance, 1, panelConfig(['/new']))
    instance.platform.removeGroupPanel('100', 'p1')

    const result = await instance.service.publishGroupPanel({ appId: '100', expectedRevision: 2 })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.notEqual(result.published.panelId, 'p1')
    assert.equal(instance.platform.listOf('100').length, 1)
    assert.equal(instance.platform.listOf('100')[0].panelId, result.published.panelId)
  })

  it('超过 20 项时返回 validation-failed 并阻止 Publish，Draft 保留', async () => {
    const instance = harness()
    const items = Array.from({ length: GROUP_PANEL_MAX_ITEMS + 1 }, (_, index) => `/${index}`)
    await saveGroup(instance, 0, panelConfig(items))

    const result = await instance.service.publishGroupPanel({ appId: '100', expectedRevision: 1 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'validation-failed')
    assert.ok(result.errors.some(issue => issue.code === 'group-panel.items.max'))
    assert.equal(instance.platform.groupWrites.length, 0)

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, 1)
    assert.equal(snapshot.draft.groupPanel.items.length, GROUP_PANEL_MAX_ITEMS + 1)
  })

  it('发布前列出其他 group Panel，未确认不得写入或删除', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/managed']))
    await instance.service.importGroupPanel({ appId: '100' })
    instance.platform.seedGroupPanel('100', 'p2', panelConfig(['/a'], '旧面板 A'), { updatedAt: '2026-10-08T00:00:00.000Z' })
    instance.platform.seedGroupPanel('100', 'p3', panelConfig(['/b', '/c'], '旧面板 B'))
    await saveGroup(instance, 1, panelConfig(['/new']))

    const blocked = await instance.service.publishGroupPanel({ appId: '100', expectedRevision: 2 })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.code, 'cleanup-confirmation-required')
    assert.deepEqual(blocked.candidates.map(candidate => candidate.panelId).sort(), ['p2', 'p3'])
    const p2 = blocked.candidates.find(candidate => candidate.panelId === 'p2')
    assert.equal(p2?.remark, '旧面板 A')
    assert.equal(p2?.updatedAt, '2026-10-08T00:00:00.000Z')
    assert.equal(p2?.itemCount, 1)
    assert.equal(p2?.itemSummary, '/a')
    assert.equal(instance.platform.groupWrites.length, 0)

    const stale = await instance.service.publishGroupPanel({
      appId: '100',
      expectedRevision: 2,
      cleanupPanelIds: ['p2', 'missing'],
    })
    assert.equal(stale.ok, false)
    if (!stale.ok) assert.equal(stale.code, 'cleanup-confirmation-required')
    assert.equal(instance.platform.groupWrites.length, 0)
  })

  it('首次请求即使直接携带匹配的 cleanupPanelIds，也必须先返回候选列表而不能删除', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/managed']))
    await instance.service.importGroupPanel({ appId: '100' })
    instance.platform.seedGroupPanel('100', 'p2', panelConfig(['/a']))
    await saveGroup(instance, 1, panelConfig(['/new']))

    const result = await instance.service.publishGroupPanel({
      appId: '100',
      expectedRevision: 2,
      cleanupPanelIds: ['p2'],
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'cleanup-confirmation-required')
    assert.deepEqual(result.candidates.map(candidate => candidate.panelId), ['p2'])
    assert.equal(instance.platform.groupWrites.length, 0)
    assert.deepEqual(instance.platform.listOf('100').map(panel => panel.panelId).sort(), ['p1', 'p2'])
  })
  it('确认后先写入 Managed Panel，再删除其他面板，最终只剩唯一 group/all Panel', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/managed']))
    await instance.service.importGroupPanel({ appId: '100' })
    instance.platform.seedGroupPanel('100', 'p2', panelConfig(['/a']))
    instance.platform.seedGroupPanel('100', 'p3', panelConfig(['/b']))
    await saveGroup(instance, 1, panelConfig(['/new']))

    const result = await publishWithCleanup(instance, 2, ['p2', 'p3'])
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.status, 'published')
    assert.deepEqual(instance.platform.groupWrites.map(write => write.op), ['modify', 'delete', 'delete'])
    assert.deepEqual(instance.platform.listOf('100').map(panel => panel.panelId), ['p1'])

    const snapshot = await instance.service.loadWorkspace('100')
    assert.deepEqual(snapshot.published.groupPanel?.cleanup.panelIds, [])
  })

  it('连续 Group Panel 写入间隔至少 6500ms', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/managed']))
    await instance.service.importGroupPanel({ appId: '100' })
    instance.platform.seedGroupPanel('100', 'p2', panelConfig(['/a']))
    instance.platform.seedGroupPanel('100', 'p3', panelConfig(['/b']))
    await saveGroup(instance, 1, panelConfig(['/new']))

    const result = await publishWithCleanup(instance, 2, ['p2', 'p3'])
    assert.ok(result.ok)

    const writes = instance.platform.groupWrites.filter(write => write.appId === '100')
    assert.deepEqual(writes.map(write => write.op), ['modify', 'delete', 'delete'])
    for (let index = 1; index < writes.length; index += 1) {
      assert.ok(
        writes[index].at - writes[index - 1].at >= PANEL_WRITE_INTERVAL_MS,
        `第 ${index + 1} 次写入与上一次间隔 ${writes[index].at - writes[index - 1].at}ms，应至少 ${PANEL_WRITE_INTERVAL_MS}ms`,
      )
    }
  })

  it('清理部分失败返回 partial，并持久化待清理 panel ID', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/managed']))
    await instance.service.importGroupPanel({ appId: '100' })
    instance.platform.seedGroupPanel('100', 'p2', panelConfig(['/a']))
    instance.platform.seedGroupPanel('100', 'p3', panelConfig(['/b']))
    await saveGroup(instance, 1, panelConfig(['/new']))
    instance.platform.deleteGroupErrors.set('p3', new MenuPlatformError('platform-error', '删除失败'))

    const result = await publishWithCleanup(instance, 2, ['p2', 'p3'])
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.published.cleanup.panelIds, ['p3'])
    assert.deepEqual(instance.platform.listOf('100').map(panel => panel.panelId).sort(), ['p1', 'p3'])

    const snapshot = await instance.service.loadWorkspace('100')
    assert.deepEqual(snapshot.published.groupPanel?.cleanup.panelIds, ['p3'])
    assert.equal(snapshot.published.groupPanel?.panelId, 'p1')
  })

  it('Managed Panel 写入遇到 40030013 时返回 quantity-limit，保留 Draft 与旧 Published Revision', async () => {
    const instance = harness()
    instance.platform.seedGroupPanel('100', 'p1', panelConfig(['/old']), { version: 5 })
    await instance.service.importGroupPanel({ appId: '100' })
    await saveGroup(instance, 1, panelConfig(['/new']))
    instance.platform.modifyGroupError = new MenuPlatformError('quantity-limit', '40030013')

    const result = await instance.service.publishGroupPanel({ appId: '100', expectedRevision: 2 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'quantity-limit')

    const snapshot = await instance.service.loadWorkspace('100')
    assert.equal(snapshot.revision, 2)
    assert.deepEqual(snapshot.draft.groupPanel.items, panelConfig(['/new']).items)
    assert.deepEqual(snapshot.published.groupPanel?.panel.items, panelConfig(['/old']).items)
    assert.equal(snapshot.published.groupPanel?.version, 5)
  })

  it('expected revision 不匹配时返回 revision-conflict，且不写平台', async () => {
    const instance = harness()
    await saveGroup(instance, 0, panelConfig(['/help']))

    const result = await instance.service.publishGroupPanel({ appId: '100', expectedRevision: 99 })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'revision-conflict')
    assert.equal(instance.platform.groupWrites.length, 0)
  })

  it('空 Draft 发布后保持空状态文件的 initial 结构，不额外创建多余面板', async () => {
    const instance = harness()
    const result = await instance.service.publishGroupPanel({ appId: '100', expectedRevision: 0 })
    assert.ok(result.ok)
    assert.equal(instance.platform.listOf('100').length, 1)
    assert.deepEqual(emptyPanelConfiguration().groupPanel.items, [])
  })
})
