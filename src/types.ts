/**
 * Menu Edit Panel 的共享数据模型。
 *
 * 这里是服务端、Console RPC 与客户端共同依赖的唯一契约来源；机器人菜单的
 * 编辑内容统一用 Panel Configuration 表示，并按 Bot Instance（QQ AppID）隔离。
 */

/** 状态文件的 schema 版本；读取到未知版本时拒绝静默覆盖。 */
export const MENU_STATE_SCHEMA_VERSION = 1

/** 页面机器人列表里展示的 Bot Instance 摘要。 */
export interface BotInstanceSummary {
  /** 隔离键，等于 `bot.config.id`（QQ AppID）。 */
  appId: string
  /** 昵称，缺省时回退为 AppID。 */
  name: string
  /** 头像 URL，可能为空字符串。 */
  avatar: string
  /** 当前是否在线。 */
  online: boolean
}

/** Private Menu 的 Panel Configuration 片段。 */
export interface PrivateMenuConfiguration {
  items: unknown[]
  [key: string]: unknown
}

/** Group Panel 的 Panel Configuration 片段。 */
export interface GroupPanelConfiguration {
  items: unknown[]
  remark?: string
  [key: string]: unknown
}

/**
 * Private Menu 与 Group Panel 的完整编辑内容。
 *
 * 允许携带当前版本不认识的字段，保存与发布时原样保留，避免静默破坏未来平台字段。
 */
export interface PanelConfiguration {
  privateMenu: PrivateMenuConfiguration
  groupPanel: GroupPanelConfiguration
  [key: string]: unknown
}

/** 已成功发布到平台的 Private Menu 快照。 */
export interface PublishedPrivateMenu {
  menu: PrivateMenuConfiguration
  version: number | null
  publishedAt: string
}

/** 已成功发布到平台的 Group Panel 快照，附待清理面板列表。 */
export interface PublishedGroupPanel {
  panelId: string
  panel: GroupPanelConfiguration
  version: number | null
  publishedAt: string
  cleanup: {
    panelIds: string[]
    updatedAt: string | null
  }
}

/** 两个 surface 各自的 Published Revision；未发布过则为 null。 */
export interface PublishedRevisions {
  privateMenu: PublishedPrivateMenu | null
  groupPanel: PublishedGroupPanel | null
}

/** 单个 AppID 的持久化状态。 */
export interface MenuState {
  schemaVersion: number
  appId: string
  /** Draft 的 revision；每次成功写入（保存或 Discard）递增。 */
  revision: number
  updatedAt: string
  /** 首次导入后的初始 Panel Configuration；尚未导入时为 null。 */
  importedConfiguration: PanelConfiguration | null
  /** 正在编辑、尚未发布的 Panel Configuration。 */
  draft: PanelConfiguration
  /** 两个 surface 最近一次成功发布的内容。 */
  published: PublishedRevisions
}

/** 页面加载某个 Bot Instance 时返回的完整工作区快照。 */
export interface WorkspaceSnapshot {
  bot: BotInstanceSummary
  revision: number
  updatedAt: string
  draft: PanelConfiguration
  importedConfiguration: PanelConfiguration | null
  published: PublishedRevisions
}

/** Draft 保存请求；必须携带客户端读取到的 expected revision。 */
export interface SaveDraftInput {
  appId: string
  expectedRevision: number
  configuration: PanelConfiguration
}

/** Discard Draft 请求；同样要求 expected revision，避免覆盖并发修改。 */
export interface DiscardDraftInput {
  appId: string
  expectedRevision: number
}

/** 写入成功的结果。 */
export interface DraftSaved {
  ok: true
  revision: number
  savedAt: string
}

/** revision 不匹配的结果；不写入任何内容，并回传服务端最新 Draft。 */
export interface DraftRevisionConflict {
  ok: false
  reason: 'revision-conflict'
  revision: number
  draft: PanelConfiguration
}

export type DraftMutationResult = DraftSaved | DraftRevisionConflict

export function emptyPrivateMenu(): PrivateMenuConfiguration {
  return { items: [] }
}

export function emptyGroupPanel(): GroupPanelConfiguration {
  return { remark: 'menu-edit', items: [] }
}

/** 首次打开某个 Bot Instance 时使用的空配置。 */
export function emptyPanelConfiguration(): PanelConfiguration {
  return {
    privateMenu: emptyPrivateMenu(),
    groupPanel: emptyGroupPanel(),
  }
}

/** 深拷贝，保证调用方拿到的快照与内部状态互不影响。 */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
