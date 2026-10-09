import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  changeItemType,
  changeSubItemType,
  cloneAt,
  createItem,
  createSubItem,
  itemType,
  moveAt,
  normalizeConfiguration,
  removeAt,
  replaceAt,
  switchConfigOf,
} from '../client/private-menu'

describe('client：JSON 互转与未知字段保留', () => {
  it('JSON 往返后 normalizeConfiguration 保留未知字段', () => {
    const source = {
      privateMenu: {
        items: [{ name: '帮助', type: 'send_message', send_message: '/help', futureItemField: 1 }],
        futureTopField: { nested: true },
      },
      groupPanel: { remark: 'menu-edit', items: [], futurePanelField: 'x' },
      unknownTopLevel: 'keep-me',
    }

    const roundTripped = normalizeConfiguration(JSON.parse(JSON.stringify(source)))
    assert.deepEqual(roundTripped, source)
  })

  it('缺少 surface 或 items 时补默认值，不丢已有字段', () => {
    const normalized = normalizeConfiguration({ privateMenu: { future: 1 } })
    assert.deepEqual(normalized.privateMenu, { future: 1, items: [] })
    assert.deepEqual(normalized.groupPanel.items, [])
  })
})

describe('client：四类条目编辑助手', () => {
  it('四类条目都有对应默认字段', () => {
    assert.deepEqual(createItem('send_message'), { name: '', type: 'send_message', send_message: '' })
    assert.deepEqual(createItem('link'), { name: '', type: 'link', link: '' })
    assert.deepEqual(createItem('menu'), { name: '', type: 'menu', sub_menu_items: [] })
    assert.deepEqual(createItem('switch'), { name: '', type: 'switch', switch: { switch_id: '', default: false } })
  })

  it('四类条目都能新增、复制、删除、排序', () => {
    const types = ['send_message', 'link', 'menu', 'switch'] as const
    let items: unknown[] = []
    for (const type of types) items = [...items, createItem(type)]
    assert.deepEqual(items.map(itemType), [...types])

    // 复制第 1 项
    const copied = cloneAt(items, 0)
    assert.equal(copied.length, 5)
    assert.deepEqual(copied[1], copied[0])
    assert.notEqual(copied[0], copied[1])

    // 排序：把最后一项移到最前
    assert.deepEqual(moveAt(items, 3, 0).map(itemType), ['switch', 'send_message', 'link', 'menu'])

    // 删除与替换
    assert.equal(removeAt(items, 1).length, 3)
    const replaced = replaceAt(items, 1, createItem('switch'))
    assert.equal(itemType(replaced[1]), 'switch')
    assert.equal(itemType(items[1]), 'link')
  })

  it('切换一级类型会清掉旧类型字段，保留 name 与未知字段', () => {
    const next = changeItemType({ name: '节点', type: 'link', link: 'https://a', future: 1 }, 'switch')
    assert.equal(itemType(next), 'switch')
    assert.equal(next.name, '节点')
    assert.equal(next.future, 1)
    assert.equal('link' in next, false)
    assert.deepEqual(switchConfigOf(next), { switch_id: '', default: false })
  })

  it('子菜单项只接受 send_message / link', () => {
    assert.deepEqual(createSubItem('link'), { name: '', type: 'link', link: '' })
    assert.deepEqual(createSubItem('send_message'), { name: '', type: 'send_message', send_message: '' })

    const switched = changeSubItemType({ name: '子项', type: 'send_message', send_message: '/x', future: 1 }, 'link')
    assert.equal(itemType(switched), 'link')
    assert.equal(switched.name, '子项')
    assert.equal(switched.future, 1)
    assert.equal('send_message' in switched, false)
  })
})
