/**
 * Menu Edit Panel 的共享数据模型。
 *
 * 这里是服务端、Console RPC 与客户端共同依赖的唯一契约来源；机器人菜单的
 * 编辑内容统一用 Panel Configuration 表示，并按 Bot Instance（QQ AppID）隔离。
 */

/** 状态文件的 schema 版本；读取到未知版本时拒绝静默覆盖。 */
export const MENU_STATE_SCHEMA_VERSION = 2

/**
 * 指令面板的使用场景；与官方 `/v2/panels` 的 `scope` 取值一致。
 *
 * 顺序即发布顺序，也是导入合并时的处理顺序。
 */
export const PANEL_SCOPES = ['channel', 'dm', 'group', 'c2c'] as const
export type PanelScope = (typeof PANEL_SCOPES)[number]

/** 使用场景的页面文案。 */
export const PANEL_SCOPE_LABELS: Record<PanelScope, string> = {
  channel: 'QQ频道',
  dm: '频道私信',
  group: 'QQ群',
  c2c: '消息列表',
}

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

/**
 * 指令面板的 Panel Configuration 片段。
 *
 * Draft 里只保留一份 `items`；每条 Panel Item 自带本地字段 `scopes`，各场景面板内容
 * 在发布时按 `scopes` 过滤派生。`scopes` 不会发往平台。
 */
export interface CommandPanelConfiguration {
  items: unknown[]
  remark?: string
  /** 面板级未知字段，按场景保存；发布派生该场景面板时原样带出。 */
  scopeExtras?: Partial<Record<PanelScope, Record<string, unknown>>>
  [key: string]: unknown
}

/**
 * Private Menu 与 Command Panel 的完整编辑内容。
 *
 * 允许携带当前版本不认识的字段，保存与发布时原样保留，避免静默破坏未来平台字段。
 */
export interface PanelConfiguration {
  privateMenu: PrivateMenuConfiguration
  commandPanel: CommandPanelConfiguration
  [key: string]: unknown
}

/** 已成功发布到平台的 Private Menu 快照。 */
export interface PublishedPrivateMenu {
  menu: PrivateMenuConfiguration
  version: number | null
  publishedAt: string
}

/** 已成功发布到平台的单个使用场景面板快照，附待清理面板列表。 */
export interface PublishedCommandPanel {
  scope: PanelScope
  panelId: string
  /** 已写入平台的场景内容；条目上的本地字段 `scopes` 已剥掉。 */
  panel: CommandPanelConfiguration
  version: number | null
  publishedAt: string
  cleanup: {
    panelIds: string[]
    updatedAt: string | null
  }
}

/** 四个使用场景各自的 Published Revision；未接管的场景缺省。 */
export type PublishedCommandPanels = Partial<Record<PanelScope, PublishedCommandPanel>>

/** Private Menu 与各场景指令面板最近一次成功发布的内容。 */
export interface PublishedRevisions {
  privateMenu: PublishedPrivateMenu | null
  commandPanels: PublishedCommandPanels
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
  /** Private Menu 与各场景面板最近一次成功发布的内容。 */
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

export function emptyCommandPanel(): CommandPanelConfiguration {
  return { remark: 'menu-edit', items: [] }
}

/** 首次打开某个 Bot Instance 时使用的空配置。 */
export function emptyPanelConfiguration(): PanelConfiguration {
  return {
    privateMenu: emptyPrivateMenu(),
    commandPanel: emptyCommandPanel(),
  }
}

/** 深拷贝，保证调用方拿到的快照与内部状态互不影响。 */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ---------------------------------------------------------------------------
// Private Menu 纵向链路（issue #3）：类型常量、校验结果、导入与发布结果。
// ---------------------------------------------------------------------------

/** Private Menu Item 的平台类型；unknown/未来类型保留在 JSON 中但校验报错。 */
export const PRIVATE_MENU_ITEM_TYPES = ['send_message', 'link', 'menu', 'switch'] as const
export type PrivateMenuItemType = (typeof PRIVATE_MENU_ITEM_TYPES)[number]

/** Private Menu 子菜单项的平台类型（adapter SubMenuItemType）。 */
export const PRIVATE_MENU_SUB_ITEM_TYPES = ['send_message', 'link'] as const
export type PrivateMenuSubItemType = (typeof PRIVATE_MENU_SUB_ITEM_TYPES)[number]

/** 平台 MenuItem.switch 的结构。 */
export interface PrivateMenuSwitch {
  switch_id: string
  default: boolean
}

/** Private Menu Strip 一级按钮上限；四类条目都计入。 */
export const PRIVATE_MENU_MAX_ITEMS = 10
/** 单个 menu 子菜单项上限。 */
export const PRIVATE_MENU_MAX_SUB_ITEMS = 5

export type ValidationSeverity = 'error' | 'warning'

/** 单条校验结果；结构化与 JSON 模式共用同一套稳定 code / path。 */
export interface ValidationIssue {
  severity: ValidationSeverity
  /** 稳定错误码，供 UI 与测试断言，不随文案变化。 */
  code: string
  /** 指向 Draft 内字段的路径，如 `privateMenu.items[0].link`。 */
  path: string
  message: string
}

export interface ValidationResult {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

/** Private Menu / 单个使用场景面板的条目差异摘要。 */
export interface MenuItemDiff {
  kind: 'added' | 'removed' | 'modified'
  name: string
}

/** Drift 状态：未发布过、平台一致、内容有差异、平台对象缺失或读取失败。 */
export type DriftState = 'unpublished' | 'same' | 'changed' | 'missing' | 'error'

/** Private Menu 的 Drift 读取结果。 */
export interface PrivateMenuDriftReport {
  surface: 'privateMenu'
  state: DriftState
  /** 仅 state === changed 时有内容；added / removed / modified 按 Draft 视角。 */
  diffs: MenuItemDiff[]
  /** 仅 state === error 时给出可展示信息。 */
  message?: string
}

/** 单个使用场景的 Drift 读取结果。 */
export interface ScopeDriftReport {
  surface: 'commandPanel'
  scope: PanelScope
  state: DriftState
  /** 仅 state === changed 时有内容；added / removed / modified 按 Draft 派生内容视角。 */
  diffs: MenuItemDiff[]
  /** 仅 state === error 时给出可展示信息。 */
  message?: string
}

/** 手动刷新平台状态后返回的完整 Drift 快照。 */
export interface DriftReport {
  privateMenu: PrivateMenuDriftReport
  scopes: ScopeDriftReport[]
}

/** 页面刷新 Platform State 的请求。 */
export interface RefreshPlatformInput {
  appId: string
}

/** 刷新平台状态失败（bot 缺失 / 离线 / 平台错误）。 */
export interface RefreshPlatformFailure {
  ok: false
  code: 'unknown-bot' | 'bot-offline' | 'platform-error'
  message: string
}

export type RefreshPlatformResult = DriftReport | RefreshPlatformFailure

/** 导入当前 Private Menu 的请求。 */
export interface ImportPrivateMenuInput {
  appId: string
}

export interface ImportPrivateMenuSuccess {
  ok: true
  surface: 'privateMenu'
  /** 导入写入后的新 revision。 */
  revision: number
  importedAt: string
  imported: PrivateMenuConfiguration
}

export interface ImportPrivateMenuFailure {
  ok: false
  surface: 'privateMenu'
  code: 'unknown-bot' | 'bot-offline' | 'platform-error'
  message: string
}

export type ImportPrivateMenuResult = ImportPrivateMenuSuccess | ImportPrivateMenuFailure

/** Publish 目前只发布 Private Menu；Command Panel 写入走独立入口。 */
export const PUBLISH_PRIVATE_MENU_SURFACE = 'privateMenu' as const

export interface PrivateMenuPublishInput {
  appId: string
  expectedRevision: number
  /** Drift 确认；存在 Drift 时必须显式确认才允许覆盖平台现状。 */
  confirmDrift?: PublishConfirmations
}

/** Publish 确认：键存在且为 true 表示用户已确认对应类别的差异。 */
export interface PublishConfirmations {
  privateMenu?: boolean
  scopes?: Partial<Record<PanelScope, boolean>>
}

export interface PrivateMenuPublishSuccess {
  ok: true
  surface: 'privateMenu'
  published: PublishedPrivateMenu
  /** 发布成功后的新 revision。 */
  revision: number
  warnings: ValidationIssue[]
}

export type PrivateMenuPublishFailureCode =
  | 'unknown-bot'
  | 'bot-offline'
  | 'revision-conflict'
  | 'validation-failed'
  | 'drift-confirmation-required'
  | 'platform-error'

export interface PrivateMenuPublishFailure {
  ok: false
  surface: 'privateMenu'
  code: PrivateMenuPublishFailureCode
  message: string
  errors: ValidationIssue[]
  /** 失败时回传服务端当前 revision 与 Draft，便于 UI 重载或强制覆盖。 */
  revision: number
  draft: PanelConfiguration
  published: PublishedPrivateMenu | null
  /** 仅 drift-confirmation-required 时携带完整 Drift 快照。 */
  drift?: DriftReport
}

export type PrivateMenuPublishResult = PrivateMenuPublishSuccess | PrivateMenuPublishFailure

// ---------------------------------------------------------------------------
// Command Panel 纵向链路（issue #8）：条目类型、场景候选、导入与发布结果。
// ---------------------------------------------------------------------------

/** Command Panel Item 的平台类型（adapter PanelItemType）。 */
export const COMMAND_PANEL_ITEM_TYPES = ['command', 'link'] as const
export type CommandPanelItemType = (typeof COMMAND_PANEL_ITEM_TYPES)[number]

/** 单个使用场景的面板条目上限。 */
export const COMMAND_PANEL_MAX_ITEMS = 20

/** 发布前展示给用户确认的某个场景的 all 面板摘要。 */
export interface CommandPanelCandidate {
  panelId: string
  remark: string
  updatedAt: string | null
  itemCount: number
  itemSummary: string
}

/** 按使用场景分组的候选面板。 */
export interface CommandPanelScopeCandidates {
  scope: PanelScope
  candidates: CommandPanelCandidate[]
}

/** 单个场景的发布结果；整体 partial 由这些结果聚合得出。 */
export type CommandPanelScopePublishStatus = 'success' | 'failed' | 'partial'

export interface CommandPanelScopePublishResult {
  scope: PanelScope
  status: CommandPanelScopePublishStatus
  /** 仅 failed 时给出稳定的平台错误码。 */
  code?: 'bot-offline' | 'platform-error' | 'unknown-bot' | 'quantity-limit'
  /** 仅 failed 时给出可展示的错误信息。 */
  message?: string
}

/** 导入指令面板的请求；多个候选的场景必须携带选中的 panelId。 */
export interface ImportCommandPanelInput {
  appId: string
  /** 场景 -> 选中的接管 panelId。 */
  selections?: Partial<Record<PanelScope, string>>
}

/** 导入时同名但字段不一致的条目冲突。 */
export interface CommandPanelImportConflict {
  name: string
  /** 冲突条目涉及的场景。 */
  scopes: PanelScope[]
  /** 参与冲突的字段变体数量。 */
  variants: number
}

export interface ImportCommandPanelSuccess {
  ok: true
  surface: 'commandPanel'
  /** 导入写入后的新 revision。 */
  revision: number
  importedAt: string
  imported: CommandPanelConfiguration
  /** 每个被接管场景对应的 Managed Panel ID；零候选的场景缺省。 */
  managedPanelIds: Partial<Record<PanelScope, string>>
  /** 本次发现并保留的同名冲突条目。 */
  conflicts: CommandPanelImportConflict[]
  /** 平台已有但不接管、不删除的 specific 面板，按场景用于导入提示。 */
  specificPanels: Partial<Record<PanelScope, CommandPanelCandidate[]>>
}

export type ImportCommandPanelFailureCode =
  | 'unknown-bot'
  | 'bot-offline'
  | 'platform-error'
  | 'quantity-limit'
  | 'selection-required'
  | 'panel-missing'

export interface ImportCommandPanelFailure {
  ok: false
  surface: 'commandPanel'
  code: ImportCommandPanelFailureCode
  message: string
  /** selection-required / panel-missing 时按场景列出候选，其余为空数组。 */
  candidates: CommandPanelScopeCandidates[]
}

export type ImportCommandPanelResult = ImportCommandPanelSuccess | ImportCommandPanelFailure

/** Publish 指令面板的请求；cleanupPanelIds 是用户已确认删除的场景面板。 */
export interface CommandPanelPublishInput {
  appId: string
  expectedRevision: number
  /** 场景 -> 用户已确认删除的 panelId。 */
  cleanupPanelIds?: Partial<Record<PanelScope, string[]>>
  /** Drift 确认；存在 Drift 时必须显式确认才允许写入。 */
  confirmDrift?: PublishConfirmations
}

export type CommandPanelPublishFailureCode =
  | 'unknown-bot'
  | 'bot-offline'
  | 'revision-conflict'
  | 'validation-failed'
  | 'drift-confirmation-required'
  | 'platform-error'
  | 'quantity-limit'
  | 'cleanup-confirmation-required'

export interface CommandPanelPublishSuccess {
  ok: true
  surface: 'commandPanel'
  /** published 表示全部场景成功；partial 表示有失败场景或待清理面板。 */
  status: 'published' | 'partial'
  published: PublishedCommandPanels
  /** 各使用场景的 success / failed / partial 结果。 */
  scopeResults: CommandPanelScopePublishResult[]
  /** 发布写入后的新 revision。 */
  revision: number
  warnings: ValidationIssue[]
}

export interface CommandPanelPublishFailure {
  ok: false
  surface: 'commandPanel'
  code: CommandPanelPublishFailureCode
  message: string
  errors: ValidationIssue[]
  /** 失败时回传服务端当前 revision 与 Draft，便于 UI 重载或强制覆盖。 */
  revision: number
  draft: PanelConfiguration
  published: PublishedCommandPanels
  /** cleanup-confirmation-required 时按场景列出待确认删除的面板，其余为空数组。 */
  candidates: CommandPanelScopeCandidates[]
  /** 仅 drift-confirmation-required 时携带完整 Drift 快照。 */
  drift?: DriftReport
}

export type CommandPanelPublishResult = CommandPanelPublishSuccess | CommandPanelPublishFailure
