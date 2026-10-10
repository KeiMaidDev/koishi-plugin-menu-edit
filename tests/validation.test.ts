import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  COMMAND_PANEL_MAX_ITEMS,
  PRIVATE_MENU_MAX_ITEMS,
  PRIVATE_MENU_MAX_SUB_ITEMS,
  type PrivateMenuConfiguration,
} from '../src/types'
import { displayWidth, validatePanelConfiguration, validatePrivateMenu } from '../src/validation'

function menu(items: unknown[]): PrivateMenuConfiguration {
  return { items }
}

function codes(configuration: PrivateMenuConfiguration, severity: 'error' | 'warning'): string[] {
  const result = validatePrivateMenu(configuration)
  const issues = severity === 'error' ? result.errors : result.warnings
  return issues.map(issue => issue.code)
}

function messageItem(name = '帮助'): unknown {
  return { name, type: 'send_message', send_message: '/help' }
}

function switchItem(name: string, switchId: string, def: boolean): unknown {
  return { name, type: 'switch', switch: { switch_id: switchId, default: def } }
}

describe('validation：数量限制', () => {
  it(`一级按钮允许 ${PRIVATE_MENU_MAX_ITEMS} 个，第 ${PRIVATE_MENU_MAX_ITEMS + 1} 个报硬错误`, () => {
    const items = Array.from({ length: PRIVATE_MENU_MAX_ITEMS }, (_, index) => messageItem(`项${index}`))
    assert.equal(codes(menu(items), 'error').includes('private-menu.items.max'), false)

    items.push({ name: '溢出', type: 'link', link: 'https://example.com' })
    assert.ok(codes(menu(items), 'error').includes('private-menu.items.max'))
  })

  it('四类条目都计入一级上限', () => {
    const items: unknown[] = [
      ...Array.from({ length: PRIVATE_MENU_MAX_ITEMS - 3 }, (_, index) => messageItem(`s${index}`)),
      { name: 'l', type: 'link', link: 'https://example.com' },
      { name: 'm', type: 'menu', sub_menu_items: [] },
      switchItem('w', 'w', false),
    ]
    assert.equal(items.length, PRIVATE_MENU_MAX_ITEMS)
    assert.equal(codes(menu(items), 'error').includes('private-menu.items.max'), false)

    items.push(messageItem('溢出'))
    assert.ok(codes(menu(items), 'error').includes('private-menu.items.max'))
  })

  it(`子菜单允许 ${PRIVATE_MENU_MAX_SUB_ITEMS} 项，超出报硬错误`, () => {
    const subItems = Array.from({ length: PRIVATE_MENU_MAX_SUB_ITEMS + 1 }, (_, index) => ({
      name: `子${index}`,
      type: 'send_message',
      send_message: '/x',
    }))
    assert.ok(codes(menu([{ name: '更多', type: 'menu', sub_menu_items: subItems }]), 'error').includes('private-menu.sub-items.max'))
  })

  it(`Command Panel 单个场景允许 ${COMMAND_PANEL_MAX_ITEMS} 项，超出该场景报硬错误`, () => {
    const allowed = Array.from({ length: COMMAND_PANEL_MAX_ITEMS }, (_, index) => ({ name: `/c${index}`, type: 'command', scopes: ['group'] }))
    const ok = validatePanelConfiguration({ privateMenu: { items: [] }, commandPanel: { items: allowed } })
    assert.equal(ok.errors.some(issue => issue.code === 'command-panel.scope.max'), false)

    const overflow = [...allowed, { name: '/overflow', type: 'command', scopes: ['group'] }]
    const result = validatePanelConfiguration({ privateMenu: { items: [] }, commandPanel: { items: overflow } })
    assert.ok(result.errors.some(issue => issue.code === 'command-panel.scope.max'))
  })
})

describe('validation：必填字段与类型', () => {
  it('send_message 缺少发送内容报硬错误', () => {
    assert.ok(codes(menu([{ name: '帮助', type: 'send_message' }]), 'error').includes('private-menu.item.send-message-required'))
  })

  it('link 缺少链接报硬错误，非 https 只报警告', () => {
    assert.ok(codes(menu([{ name: '官网', type: 'link' }]), 'error').includes('private-menu.item.link-required'))
    assert.ok(codes(menu([{ name: '官网', type: 'link', link: 'http://example.com' }]), 'warning').includes('private-menu.item.link-insecure'))
  })

  it('switch 缺少 switch 对象报硬错误', () => {
    assert.ok(codes(menu([{ name: '开关', type: 'switch' }]), 'error').includes('private-menu.item.switch-required'))
  })

  it('switch 对象的 switch_id 不能为空、default 必须是布尔值', () => {
    const bad = { name: '开关', type: 'switch', switch: { switch_id: '  ', default: 'yes' } }
    const list = codes(menu([bad]), 'error')
    assert.ok(list.includes('private-menu.item.switch-id-required'))
    assert.ok(list.includes('private-menu.item.switch-default-required'))

    assert.equal(codes(menu([switchItem('开关', 'sw', true)]), 'error').length, 0)
  })

  it('名称不能为空，未知一级类型报硬错误', () => {
    assert.ok(codes(menu([{ name: '  ', type: 'link', link: 'https://example.com' }]), 'error').includes('private-menu.item.name-required'))
    assert.ok(codes(menu([{ name: '未来', type: 'future_type' }]), 'error').includes('private-menu.item.type-invalid'))
  })

  it('子菜单只允许 send_message / link，且各自字段必填', () => {
    const withSwitchSub = menu([{ name: '更多', type: 'menu', sub_menu_items: [{ name: '开关', type: 'switch' }] }])
    assert.ok(codes(withSwitchSub, 'error').includes('private-menu.sub-item.type-invalid'))

    const withMenuSub = menu([{ name: '更多', type: 'menu', sub_menu_items: [{ name: '嵌套', type: 'menu' }] }])
    assert.ok(codes(withMenuSub, 'error').includes('private-menu.sub-item.type-invalid'))

    const missingFields = menu([{ name: '更多', type: 'menu', sub_menu_items: [{ name: 'a', type: 'send_message' }, { name: 'b', type: 'link' }] }])
    const errorList = codes(missingFields, 'error')
    assert.ok(errorList.includes('private-menu.sub-item.send-message-required'))
    assert.ok(errorList.includes('private-menu.sub-item.link-required'))
  })
})

describe('validation：警告', () => {
  it('同级重名、重复 switch_id、展示宽度超限都只报警告', () => {
    const result = validatePrivateMenu(menu([
      switchItem('重复', 'same', false),
      switchItem('重复', 'same', true),
      { name: '非常非常非常非常长的名称', type: 'send_message', send_message: '/x' },
    ]))
    const codesList = result.warnings.map(issue => issue.code)
    assert.ok(codesList.includes('private-menu.item.name-duplicate'))
    assert.ok(codesList.includes('private-menu.switch-id-duplicate'))
    assert.ok(codesList.includes('private-menu.item.name-too-wide'))
    assert.equal(result.errors.length, 0)
  })

  it('displayWidth 把中文按 2 计', () => {
    assert.equal(displayWidth('中文'), 4)
    assert.equal(displayWidth('abcd'), 4)
  })
})
describe('validation：警告类确认项', () => {
  it('Panel Item 描述为空产生警告；Private Menu 同级重名与重复 switch ID 已有警告', () => {
    const result = validatePanelConfiguration({
      privateMenu: { items: [] },
      commandPanel: { items: [{ name: '/a', type: 'command', scopes: ['group'] }] },
    })
    assert.ok(result.warnings.some(issue => issue.code === 'command-panel.item.desc-empty'))
    assert.equal(result.errors.length, 0)
  })
})

describe('validation：Command Panel 条目字段', () => {
  function command(items: unknown[]) {
    return validatePanelConfiguration({ privateMenu: { items: [] }, commandPanel: { items } })
  }

  it('未勾选使用场景报硬错误', () => {
    const result = command([{ name: '/a', type: 'command', scopes: [] }])
    assert.ok(result.errors.some(issue => issue.code === 'command-panel.item.scopes-required'))
  })

  it('command 名称缺少 / 与 link 非 https 都是硬错误', () => {
    const result = command([
      { name: 'help', desc: '帮助', type: 'command', only_admin: false, scopes: ['group'] },
      { name: '官网', desc: '打开官网', type: 'link', only_admin: true, scopes: ['group'] },
      { name: '文档', type: 'link', link: 'http://example.com', only_admin: false, scopes: ['c2c'] },
    ])
    assert.ok(result.errors.some(issue => issue.code === 'command-panel.item.command-prefix'))
    assert.ok(result.errors.some(issue => issue.code === 'command-panel.item.link-required'))
    assert.ok(result.errors.some(issue => issue.code === 'command-panel.item.link-insecure'))
  })

  it('only_admin 必须是布尔值，未知类型报硬错误', () => {
    const result = command([
      { name: '/a', type: 'command', only_admin: 'yes', scopes: ['group'] },
      { name: '/b', type: 'unknown', only_admin: false, scopes: ['group'] },
    ])
    assert.ok(result.errors.some(issue => issue.code === 'command-panel.item.only-admin-invalid'))
    assert.ok(result.errors.some(issue => issue.code === 'command-panel.item.type-invalid'))
  })

  it('名称与描述展示宽度超限报硬错误', () => {
    const result = command([
      { name: '/很长的指令名称', desc: '很长的描述'.repeat(8), type: 'command', only_admin: false, scopes: ['group'] },
    ])
    assert.ok(result.errors.some(issue => issue.code === 'command-panel.item.name-too-wide'))
    assert.ok(result.errors.some(issue => issue.code === 'command-panel.item.desc-too-wide'))
  })

  it('同名条目只在共同场景内报警告', () => {
    const result = command([
      { name: '/dup', type: 'command', scopes: ['group'] },
      { name: '/dup', type: 'command', scopes: ['c2c'] },
    ])
    assert.equal(result.warnings.some(issue => issue.code === 'command-panel.item.name-duplicate'), false)

    const sameScope = command([
      { name: '/dup', type: 'command', scopes: ['group'] },
      { name: '/dup', type: 'command', scopes: ['group', 'c2c'] },
    ])
    assert.ok(sameScope.warnings.some(issue => issue.code === 'command-panel.item.name-duplicate'))
  })
})
