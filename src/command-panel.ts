/**
 * 指令面板的场景派生与本地字段处理。
 *
 * Draft 只保留一份条目列表，每条 Panel Item 自带本地字段 `scopes`；这里提供读取
 * `scopes`、按场景过滤条目、派生发往平台的面板内容等纯函数。服务端发布与客户端
 * 预览共用同一套规则。
 */
import { isRecord } from './guards'
import {
  deepClone,
  PANEL_SCOPES,
  type CommandPanelConfiguration,
  type CommandPanelImportConflict,
  type MenuItemDiff,
  type PanelScope,
} from './types'

export type JsonRecord = Record<string, unknown>

export function asJsonRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

/** 读取条目上的本地 `scopes`；只保留合法场景并按固定顺序去重。 */
export function panelItemScopes(item: unknown): PanelScope[] {
  const raw = asJsonRecord(item).scopes
  if (!Array.isArray(raw)) return []
  const set = new Set<string>(raw.filter((value): value is string => typeof value === 'string'))
  return PANEL_SCOPES.filter(scope => set.has(scope))
}

/** 复制条目并剥掉本地 `scopes`，未知字段原样保留。 */
export function stripPanelItemScopes(item: unknown): JsonRecord {
  const record = { ...asJsonRecord(item) }
  delete record.scopes
  return record
}

/** 覆盖条目的本地 `scopes`，同时剥掉旧值。 */
export function withPanelItemScopes(item: unknown, scopes: readonly PanelScope[]): JsonRecord {
  return {
    ...stripPanelItemScopes(item),
    scopes: PANEL_SCOPES.filter(scope => scopes.includes(scope)),
  }
}

/** 条目是否勾选了指定场景。 */
export function panelItemBelongsTo(item: unknown, scope: PanelScope): boolean {
  return panelItemScopes(item).includes(scope)
}

/** 某场景的条目：按列表顺序过滤，并剥掉本地 `scopes`。 */
export function deriveScopeItems(panel: CommandPanelConfiguration, scope: PanelScope): JsonRecord[] {
  const items = Array.isArray(panel.items) ? panel.items : []
  return items.filter(item => panelItemBelongsTo(item, scope)).map(stripPanelItemScopes)
}

/** 四个场景各自的条目计数。 */
export function scopeItemCounts(panel: CommandPanelConfiguration): Record<PanelScope, number> {
  const counts = Object.fromEntries(PANEL_SCOPES.map(scope => [scope, 0])) as Record<PanelScope, number>
  const items = Array.isArray(panel.items) ? panel.items : []
  for (const item of items) {
    for (const scope of panelItemScopes(item)) counts[scope] += 1
  }
  return counts
}

/**
 * 某场景发往平台的面板内容：合并该场景保存的面板级未知字段，再派生该场景的条目。
 * `items` 的顺序等于条目列表过滤该场景后的顺序。
 */
export function deriveScopePanel(panel: CommandPanelConfiguration, scope: PanelScope): CommandPanelConfiguration {
  const record: JsonRecord = { ...panel }
  delete record.scopeExtras
  const extras = panel.scopeExtras && isRecord(panel.scopeExtras[scope]) ? panel.scopeExtras[scope] : {}
  return {
    ...record,
    ...deepClone(extras),
    items: deriveScopeItems(panel, scope),
  } as CommandPanelConfiguration
}

/**
 * 收集各场景面板里除 `items` / `remark` 之外的未知字段，供 Draft 的 `scopeExtras` 原样保留。
 * 导入与从 Published Revision 回填共用同一规则；没有任何未知字段时返回 undefined。
 */
export function collectScopeExtras(
  sources: { scope: PanelScope; panel: CommandPanelConfiguration }[],
): CommandPanelConfiguration['scopeExtras'] | undefined {
  const scopeExtras: NonNullable<CommandPanelConfiguration['scopeExtras']> = {}
  for (const { scope, panel } of sources) {
    const extras: JsonRecord = { ...panel }
    delete extras.items
    delete extras.remark
    if (Object.keys(extras).length) scopeExtras[scope] = extras
  }
  return Object.keys(scopeExtras).length ? scopeExtras : undefined
}

/**
 * 补回 `command` 条目名称的 `/` 前缀。
 *
 * QQ 平台会剥掉这个前缀：真实抓包里 menu-edit 以 `name: '/测试'` PUT 之后，平台
 * GET /v2/panels 返回的是 `name: '测试'`。menu-edit 内部与编辑器都按「`/名字`」存储，
 * 平台边界读取时补回来，否则导入出的 Draft 会直接带上 `command-prefix` 硬错误。
 */
export function normalizePanelItemCommandName(item: unknown): unknown {
  if (!isRecord(item) || item.type !== 'command') return item
  const name = item.name
  if (typeof name !== 'string' || !name || name.startsWith('/')) return item
  return { ...item, name: `/${name}` }
}

/**
 * 导入合并用的条目指纹：`name` 加 `desc` / `only_admin` / `link` 归一后的完全一致判定。
 * 同名但指纹不同的条目不会被合并。
 */
export function panelItemMergeKey(item: unknown): string {
  const record = asJsonRecord(item)
  return JSON.stringify({
    name: typeof record.name === 'string' ? record.name.trim() : '',
    desc: typeof record.desc === 'string' ? record.desc : '',
    only_admin: record.only_admin === true,
    link: typeof record.link === 'string' ? record.link : '',
  })
}

/** 条目指纹里参与比较的名称，用于冲突报告。 */
export function panelItemMergeName(item: unknown): string {
  const record = asJsonRecord(item)
  return typeof record.name === 'string' ? record.name.trim() : ''
}
export interface MergedPanelItems {
  items: JsonRecord[]
  conflicts: CommandPanelImportConflict[]
}

/**
 * 把各场景的条目合并成 Draft 的单一条目列表：`name` 且 `desc` / `only_admin` / `link`
 * 完全一致的条目合并为一条并把 `scopes` 取并集；同名但字段不一致的条目保留为多条并在
 * `conflicts` 里报告。空名条目不参与合并，按出现顺序保留。
 */
export function mergePanelItems(sources: { scope: PanelScope; panel: CommandPanelConfiguration }[]): MergedPanelItems {
  const merged: JsonRecord[] = []
  const byKey = new Map<string, JsonRecord>()
  const names = new Map<string, { variants: Set<string>; scopes: Set<PanelScope> }>()

  for (const { scope, panel } of sources) {
    const items = Array.isArray(panel.items) ? panel.items : []
    items.forEach((item, index) => {
      const name = panelItemMergeName(item)
      if (name) {
        const info = names.get(name) ?? { variants: new Set<string>(), scopes: new Set<PanelScope>() }
        info.variants.add(panelItemMergeKey(item))
        info.scopes.add(scope)
        names.set(name, info)
      }
      const key = name ? panelItemMergeKey(item) : `#empty:${scope}:${index}:${merged.length}`
      const existing = byKey.get(key)
      if (existing) {
        const scopes = new Set<PanelScope>([...panelItemScopes(existing), scope])
        Object.assign(existing, stripPanelItemScopes(item), {
          scopes: PANEL_SCOPES.filter(candidate => scopes.has(candidate)),
        })
      } else {
        const copy = withPanelItemScopes(item, [scope])
        byKey.set(key, copy)
        merged.push(copy)
      }
    })
  }

  const conflicts: CommandPanelImportConflict[] = []
  for (const [name, info] of names) {
    if (info.variants.size > 1) {
      conflicts.push({
        name,
        scopes: PANEL_SCOPES.filter(scope => info.scopes.has(scope)),
        variants: info.variants.size,
      })
    }
  }
  return { items: merged, conflicts }
}

/**
 * 条目名，空名条目不参与 Drift 对比。
 *
 * 平台侧未知条目类型也可能缺少 `name`，这里与导入合并规则保持同一口径。
 */
function driftItemName(item: unknown): string {
  const record = asJsonRecord(item)
  return typeof record.name === 'string' ? record.name.trim() : ''
}

/** 参与对比的已知字段；未知字段可能来自平台本身，不纳入摘要。 */
function driftSignature(item: unknown): string {
  const record = asJsonRecord(item)
  return JSON.stringify({
    name: driftItemName(item),
    desc: typeof record.desc === 'string' ? record.desc : '',
    type: typeof record.type === 'string' ? record.type : '',
    only_admin: record.only_admin === true,
    link: typeof record.link === 'string' ? record.link : '',
    switch: record.switch ?? null,
  })
}

/**
 * 对比 Draft 侧与平台侧条目列表，返回按 Draft 视角的差异摘要。
 *
 * - added：Draft 有而平台没有。
 * - removed：平台有而 Draft 没有。
 * - modified：同名但 `name` / `desc` / `type` / `only_admin` / `link` / `switch` 有差异。
 * - 排序固定为 added → removed → modified，name 升序，保证 UI 与测试结果稳定。
 */
export function compareMenuItems(
  draftItems: unknown[],
  platformItems: unknown[],
): MenuItemDiff[] {
  const platformByName = new Map<string, unknown>()
  for (const item of platformItems) {
    const name = driftItemName(item)
    if (name) platformByName.set(name, item)
  }

  const added: MenuItemDiff[] = []
  const modified: MenuItemDiff[] = []
  const draftNames = new Set<string>()
  for (const item of draftItems) {
    const name = driftItemName(item)
    if (!name || draftNames.has(name)) continue
    draftNames.add(name)
    const platformItem = platformByName.get(name)
    if (!platformItem) {
      added.push({ kind: 'added', name })
    } else if (driftSignature(item) !== driftSignature(platformItem)) {
      modified.push({ kind: 'modified', name })
    }
  }

  const removed: MenuItemDiff[] = []
  for (const item of platformItems) {
    const name = driftItemName(item)
    if (!name || draftNames.has(name) || removed.some(diff => diff.name === name)) continue
    removed.push({ kind: 'removed', name })
  }

  const byName = (a: MenuItemDiff, b: MenuItemDiff) => a.name.localeCompare(b.name)
  return [...added.sort(byName), ...removed.sort(byName), ...modified.sort(byName)]
}
