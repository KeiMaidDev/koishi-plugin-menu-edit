/**
 * 客户端侧的 Group Panel Item 助手。
 *
 * 平台数据里的 `items` 是 `unknown[]`：未知字段与未来类型必须原样保留，结构化编辑器
 * 只在已知类型上增删字段。平台契约见 adapter-qq-crack `PanelItem`：
 * `{ name, desc?, type: 'command' | 'link', only_admin?, link? }`。
 */
import { GROUP_PANEL_ITEM_TYPES } from '../src/types'
import { asRecord, type JsonRecord } from './private-menu'

export const PANEL_ITEM_TYPES = GROUP_PANEL_ITEM_TYPES
export type PanelItemType = (typeof PANEL_ITEM_TYPES)[number]

const TYPE_LABELS: Record<string, string> = {
  command: '指令',
  link: '链接',
}


export function panelItemName(item: unknown): string {
  const value = asRecord(item).name
  return typeof value === 'string' ? value : ''
}

export function panelItemDesc(item: unknown): string {
  const value = asRecord(item).desc
  return typeof value === 'string' ? value : ''
}

export function panelItemType(item: unknown): string {
  const value = asRecord(item).type
  return typeof value === 'string' ? value : ''
}

export function panelItemLink(item: unknown): string {
  const value = asRecord(item).link
  return typeof value === 'string' ? value : ''
}

export function panelItemOnlyAdmin(item: unknown): boolean {
  return asRecord(item).only_admin === true
}

export function panelItemLabel(type: string): string {
  return TYPE_LABELS[type] ?? (type || '未知类型')
}

export function createPanelItem(type: PanelItemType): JsonRecord {
  const base: JsonRecord = { name: '', desc: '', type, only_admin: false }
  return type === 'link' ? { ...base, link: '' } : base
}

/** 保留 name / desc / only_admin 与未知字段，替换类型专属字段，避免切换后残留旧值。 */
export function changePanelItemType(item: unknown, type: PanelItemType): JsonRecord {
  const next: JsonRecord = { ...asRecord(item) }
  delete next.link
  return { ...createPanelItem(type), ...next, type }
}

export function patchPanelItem(item: unknown, patch: JsonRecord): JsonRecord {
  return { ...asRecord(item), ...patch }
}
