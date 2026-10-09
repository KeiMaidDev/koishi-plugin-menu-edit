import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  changePanelItemType,
  createPanelItem,
  panelItemDesc,
  panelItemName,
  panelItemOnlyAdmin,
  panelItemType,
  patchPanelItem,
} from '../client/group-panel'

describe('client：Group Panel Item 助手', () => {
  it('command 与 link 有对应默认字段', () => {
    assert.deepEqual(createPanelItem('command'), { name: '', desc: '', type: 'command', only_admin: false })
    assert.deepEqual(createPanelItem('link'), { name: '', desc: '', type: 'link', only_admin: false, link: '' })
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
  })
})
