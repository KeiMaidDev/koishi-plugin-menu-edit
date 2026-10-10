/**
 * MenuState 的纯函数：初始化、已记录内容还原与 revision 递增。
 *
 * 这些规则被 saveDraft 与 discardDraft 共用，放在状态模型旁边，避免 MenuService
 * 里出现两份 read-modify-write 骨架。
 */
import { mergePanelItems, type JsonRecord } from './command-panel'
import {
  deepClone,
  emptyCommandPanel,
  emptyPanelConfiguration,
  emptyPrivateMenu,
  MENU_STATE_SCHEMA_VERSION,
  PANEL_SCOPES,
  type CommandPanelConfiguration,
  type MenuState,
  type PanelConfiguration,
  type PanelScope,
  type PublishedCommandPanels,
} from './types'

export function createInitialState(appId: string, now: string): MenuState {
  return {
    schemaVersion: MENU_STATE_SCHEMA_VERSION,
    appId,
    revision: 0,
    updatedAt: now,
    importedConfiguration: null,
    draft: emptyPanelConfiguration(),
    published: { privateMenu: null, commandPanels: {} },
  }
}

/**
 * 从各场景 Published Revision 还原 Draft 的单一条目列表：重新给每个场景的条目补上
 * `scopes` 并按同名规则合并。没有任何已发布场景时返回 null。
 */
export function commandPanelFromPublished(published: PublishedCommandPanels): CommandPanelConfiguration | null {
  const sources = PANEL_SCOPES
    .map(scope => ({ scope, panel: published[scope]?.panel }))
    .filter((entry): entry is { scope: PanelScope; panel: CommandPanelConfiguration } => entry.panel !== undefined)
  if (!sources.length) return null

  const merged = mergePanelItems(sources)
  const scopeExtras: NonNullable<CommandPanelConfiguration['scopeExtras']> = {}
  for (const { scope, panel } of sources) {
    const extras: JsonRecord = { ...panel }
    delete extras.items
    delete extras.remark
    if (Object.keys(extras).length) scopeExtras[scope] = extras
  }
  const first = sources[0].panel
  return {
    remark: typeof first.remark === 'string' ? first.remark : 'menu-edit',
    items: merged.items,
    ...(Object.keys(scopeExtras).length ? { scopeExtras } : {}),
  }
}

/**
 * 已记录内容：每个 surface 优先取最近一次成功的 Published Revision，尚未发布过的
 * surface 回退到首次导入内容，两者都没有时回到空配置。
 */
export function recordedConfiguration(state: MenuState): PanelConfiguration {
  const fallback = state.importedConfiguration ?? emptyPanelConfiguration()
  return {
    ...deepClone(fallback),
    privateMenu: deepClone(state.published.privateMenu?.menu ?? fallback.privateMenu ?? emptyPrivateMenu()),
    commandPanel: deepClone(
      commandPanelFromPublished(state.published.commandPanels) ?? fallback.commandPanel ?? emptyCommandPanel(),
    ),
  }
}

/** 用新的 Draft 覆盖状态并递增 revision。 */
export function advanceDraft(state: MenuState, draft: PanelConfiguration, now: string): MenuState {
  return {
    ...state,
    revision: state.revision + 1,
    updatedAt: now,
    draft,
  }
}
