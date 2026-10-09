/**
 * MenuState 的纯函数：初始化、已记录内容还原与 revision 递增。
 *
 * 这些规则被 saveDraft 与 discardDraft 共用，放在状态模型旁边，避免 MenuService
 * 里出现两份 read-modify-write 骨架。
 */
import {
  deepClone,
  emptyGroupPanel,
  emptyPanelConfiguration,
  emptyPrivateMenu,
  MENU_STATE_SCHEMA_VERSION,
  type MenuState,
  type PanelConfiguration,
} from './types'

export function createInitialState(appId: string, now: string): MenuState {
  return {
    schemaVersion: MENU_STATE_SCHEMA_VERSION,
    appId,
    revision: 0,
    updatedAt: now,
    importedConfiguration: null,
    draft: emptyPanelConfiguration(),
    published: { privateMenu: null, groupPanel: null },
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
    groupPanel: deepClone(state.published.groupPanel?.panel ?? fallback.groupPanel ?? emptyGroupPanel()),
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
