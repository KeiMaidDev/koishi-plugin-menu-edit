import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  changePanelItemType,
  createPanelItem,
  defaultScopes,
  panelItemDesc,
  panelItemDisplayName,
  panelItemName,
  panelItemOnlyAdmin,
  panelItemScopes,
  panelItemType,
  panelRowTrailing,
  patchPanelItem,
  togglePanelItemScope,
} from '../client/command-panel'

describe('client：Command Panel Item 助手', () => {
  it('command 与 link 有对应默认字段与默认使用场景', () => {
    assert.deepEqual(createPanelItem('command'), { name: '', desc: '', type: 'command', only_admin: false, scopes: ['group'] })
    assert.deepEqual(createPanelItem('link'), { name: '', desc: '', type: 'link', only_admin: false, scopes: ['group'], link: '' })
  })

  it('切换类型清理旧类型字段，保留可共用字段与未知字段', () => {
    const link = patchPanelItem(createPanelItem('link'), {
      name: '/docs',
      desc: '文档',
      only_admin: true,
      link: 'https://example.com',
      futureField: 42,
    })
    assert.equal(panelItemType(link), 'link')
    assert.equal(panelItemName(link), '/docs')
    assert.equal(panelItemDesc(link), '文档')
    assert.equal(panelItemOnlyAdmin(link), true)

    const command = changePanelItemType(link, 'command')
    assert.equal(panelItemType(command), 'command')
    assert.equal(command.link, undefined)
    assert.equal(panelItemName(command), '/docs')
    assert.equal(panelItemDesc(command), '文档')
    assert.equal(panelItemOnlyAdmin(command), true)
    assert.equal(command.futureField, 42)
    assert.deepEqual(panelItemScopes(command), ['group'])
  })

  it('使用场景可多选、按固定顺序排列，且不允许多选到空', () => {
    const item = patchPanelItem(createPanelItem('command'), { scopes: ['c2c', 'channel'] })
    assert.deepEqual(panelItemScopes(item), ['channel', 'c2c'])

    const added = togglePanelItemScope(item, 'group')
    assert.deepEqual(panelItemScopes(added), ['channel', 'group', 'c2c'])

    const removed = togglePanelItemScope(added, 'group')
    assert.deepEqual(panelItemScopes(removed), ['channel', 'c2c'])

    const onlyOne = patchPanelItem(createPanelItem('command'), { scopes: ['group'] })
    assert.deepEqual(panelItemScopes(togglePanelItemScope(onlyOne, 'group')), ['group'])
  })

  it('新增条目默认落到第一个未满的场景，四场景都满时返回 null', () => {
    assert.deepEqual(defaultScopes([]), ['channel'])
    const full = Array.from({ length: 20 }, (_, index) => patchPanelItem(createPanelItem('command'), {
      name: `/c${index}`,
      scopes: ['channel', 'dm', 'group', 'c2c'],
    }))
    assert.equal(defaultScopes(full), null)
  })

  it('手机预览按类型展示：command 补全 / 前缀并显示描述，link 显示进入箭头', () => {
    assert.equal(panelItemDisplayName(createPanelItem('command')), '未命名')
    assert.equal(panelItemDisplayName(patchPanelItem(createPanelItem('command'), { name: ' 帮助 ' })), '/帮助')
    assert.equal(panelItemDisplayName(patchPanelItem(createPanelItem('command'), { name: '/帮助' })), '/帮助')
    assert.equal(panelItemDisplayName(patchPanelItem(createPanelItem('link'), { name: ' koishi.chat ' })), 'koishi.chat')

    assert.deepEqual(
      panelRowTrailing(patchPanelItem(createPanelItem('command'), { desc: '获取帮助' })),
      { kind: 'desc', text: '获取帮助' },
    )
    assert.deepEqual(
      panelRowTrailing(patchPanelItem(createPanelItem('link'), { desc: '忽略描述' })),
      { kind: 'chevron', text: '' },
    )
  })
})
