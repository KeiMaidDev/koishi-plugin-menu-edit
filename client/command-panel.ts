/**
 * 客户端侧的 Command Panel Item 助手。
 *
 * 平台数据里的 `items` 是 `unknown[]`：未知字段与未来类型必须原样保留，结构化编辑器
 * 只在已知类型上增删字段。每条条目的本地字段 `scopes` 记录生效的使用场景，发布前会被
 * 服务端剥掉。平台契约见 adapter-qq-crack `PanelItem`：
 * `{ name, desc?, type: 'command' | 'link', only_admin?, link? }`。
 */
import {
  COMMAND_PANEL_ITEM_TYPES,
  PANEL_SCOPES,
  PANEL_SCOPE_LABELS,
  type PanelScope,
} from '../src/types'
import { panelItemScopes, scopeItemCounts, withPanelItemScopes } from '../src/command-panel'
import { asRecord, type JsonRecord } from './private-menu'

export const PANEL_ITEM_TYPES = COMMAND_PANEL_ITEM_TYPES
export type PanelItemType = (typeof PANEL_ITEM_TYPES)[number]

export { panelItemScopes, scopeItemCounts } from '../src/command-panel'

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

export function panelScopeLabel(scope: PanelScope): string {
  return PANEL_SCOPE_LABELS[scope]
}

export function createPanelItem(type: PanelItemType, scopes: readonly PanelScope[] = []): JsonRecord {
  const base: JsonRecord = { name: '', desc: '', type, only_admin: false, scopes: [...scopes] }
  return type === 'link' ? { ...base, link: '' } : base
}

/** 保留 name / desc / only_admin / scopes 与未知字段，替换类型专属字段。 */
export function changePanelItemType(item: unknown, type: PanelItemType): JsonRecord {
  const next: JsonRecord = { ...asRecord(item) }
  delete next.link
  return { ...createPanelItem(type), ...next, type }
}

export function patchPanelItem(item: unknown, patch: JsonRecord): JsonRecord {
  return { ...asRecord(item), ...patch }
}

/** 切换某个使用场景的勾选；至少保留一个场景。 */
export function togglePanelItemScope(item: unknown, scope: PanelScope): JsonRecord {
  const current = panelItemScopes(item)
  const next = current.includes(scope)
    ? current.filter(candidate => candidate !== scope)
    : [...current, scope]
  if (!next.length) return { ...asRecord(item), scopes: current }
  return withPanelItemScopes(item, next)
}

/** 编辑器用指令名：`command` 去空白后缺 `/` 前缀时补上，空名回退「未命名」。 */
export function panelItemDisplayName(item: unknown): string {
  const name = panelItemName(item).trim()
  if (!name) return '未命名'
  if (panelItemType(item) === 'command' && !name.startsWith('/')) return `/${name}`
  return name
}

export interface PanelRowTrailing {
  kind: 'desc' | 'chevron'
  text: string
}

/** 预览行尾：`link` 显示进入箭头，`command` 显示灰色描述。 */
export function panelRowTrailing(item: unknown): PanelRowTrailing {
  return panelItemType(item) === 'link'
    ? { kind: 'chevron', text: '' }
    : { kind: 'desc', text: panelItemDesc(item) }
}
