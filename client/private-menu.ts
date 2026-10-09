/**
 * 客户端侧的 Private Menu Item 助手。
 *
 * 平台数据里的 `items` 是 `unknown[]`：unknown/未来类型必须原样保留，结构化编辑器只在
 * 已知类型上增删字段，未知字段用展开赋值保留。
 *
 * 平台契约：顶层 MenuItem 的 switch 是 `{ switch_id, default }` 对象；子菜单项只允许
 * `send_message` / `link`。
 */
import {
  PRIVATE_MENU_ITEM_TYPES,
  PRIVATE_MENU_SUB_ITEM_TYPES,
  type PanelConfiguration,
  type PrivateMenuConfiguration,
} from '../src/types'
import { isRecord } from '../src/guards'

export type JsonRecord = Record<string, unknown>

export const MENU_ITEM_TYPES = PRIVATE_MENU_ITEM_TYPES
export type MenuItemType = (typeof MENU_ITEM_TYPES)[number]

export const SUB_MENU_ITEM_TYPES = PRIVATE_MENU_SUB_ITEM_TYPES
export type SubMenuItemType = (typeof SUB_MENU_ITEM_TYPES)[number]

const KNOWN_TYPE_FIELDS = ['send_message', 'link', 'switch', 'sub_menu_items']

export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

export function menuItems(menu: PrivateMenuConfiguration): unknown[] {
  return Array.isArray(menu.items) ? menu.items : []
}

export function itemName(item: unknown): string {
  const record = asRecord(item)
  return typeof record.name === 'string' ? record.name : ''
}

export function itemType(item: unknown): string {
  const record = asRecord(item)
  return typeof record.type === 'string' ? record.type : ''
}

export function subItems(item: unknown): unknown[] {
  const record = asRecord(item)
  return Array.isArray(record.sub_menu_items) ? record.sub_menu_items : []
}

/** 读取 switch 对象；缺省或结构非法时回退为空状态。 */
export function switchConfigOf(item: unknown): { switch_id: string; default: boolean } {
  const raw = asRecord(item).switch
  const record = isRecord(raw) ? raw : {}
  return {
    switch_id: typeof record.switch_id === 'string' ? record.switch_id : '',
    default: record.default === true,
  }
}

/** 只替换 switch 对象内部字段，保留其余未知字段。 */
export function patchSwitch(item: unknown, patch: { switch_id?: string; default?: boolean }): JsonRecord {
  return { ...asRecord(item), switch: { ...switchConfigOf(item), ...patch } }
}

export function createItem(type: MenuItemType): JsonRecord {
  const base: JsonRecord = { name: '', type }
  switch (type) {
    case 'send_message':
      return { ...base, send_message: '' }
    case 'link':
      return { ...base, link: '' }
    case 'switch':
      return { ...base, switch: { switch_id: '', default: false } }
    case 'menu':
      return { ...base, sub_menu_items: [] }
  }
}

export function createSubItem(type: SubMenuItemType = 'send_message'): JsonRecord {
  return type === 'link'
    ? { name: '', type, link: '' }
    : { name: '', type, send_message: '' }
}

/** 保留 name 与未知字段，替换已知类型字段，避免切换类型后残留旧字段。 */
export function changeItemType(item: unknown, type: MenuItemType): JsonRecord {
  const next: JsonRecord = { ...asRecord(item) }
  for (const field of KNOWN_TYPE_FIELDS) delete next[field]
  return { ...createItem(type), ...next, type }
}

/** 子菜单项切换类型，只允许 send_message / link。 */
export function changeSubItemType(item: unknown, type: SubMenuItemType): JsonRecord {
  const next: JsonRecord = { ...asRecord(item) }
  delete next.send_message
  delete next.link
  delete next.switch
  delete next.sub_menu_items
  return { ...createSubItem(type), ...next, type }
}

export function patchItem(item: unknown, patch: JsonRecord): JsonRecord {
  return { ...asRecord(item), ...patch }
}

export function replaceAt(items: unknown[], index: number, value: unknown): unknown[] {
  return items.map((item, current) => (current === index ? value : item))
}

export function removeAt(items: unknown[], index: number): unknown[] {
  return items.filter((_, current) => current !== index)
}

/** 把 from 位置的元素移动到 to 位置，其余保持原顺序。 */
export function moveAt(items: unknown[], from: number, to: number): unknown[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items.slice()
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export function cloneAt(items: unknown[], index: number): unknown[] {
  const clone = JSON.parse(JSON.stringify(items[index])) as unknown
  return [...items.slice(0, index + 1), clone, ...items.slice(index + 1)]
}

/**
 * 客户端轻量归一：保证 privateMenu / groupPanel 存在且 items 是数组，其余未知字段保留。
 * 与 service 端 normalizePanelConfiguration 的口径一致，只是失败时由调用方处理。
 */
export function normalizeConfiguration(value: unknown): PanelConfiguration {
  const record = isRecord(value) ? value : {}
  const privateMenu = isRecord(record.privateMenu) ? record.privateMenu : {}
  const groupPanel = isRecord(record.groupPanel) ? record.groupPanel : {}
  return {
    ...record,
    privateMenu: {
      ...privateMenu,
      items: Array.isArray(privateMenu.items) ? privateMenu.items : [],
    },
    groupPanel: {
      ...groupPanel,
      items: Array.isArray(groupPanel.items) ? groupPanel.items : [],
    },
  }
}
