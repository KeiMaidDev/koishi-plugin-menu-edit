/**
 * MenuService：Menu Edit Panel 唯一公开的自动化测试 seam。
 *
 * 服务端所有状态读取、Draft 保存、导入与 Private Menu / Command Panel 发布都经过这里；
 * Console RPC 只做鉴权和参数转换。状态按 Bot Instance（QQ AppID）隔离，写入走
 * `MenuStateStore.runExclusive`，revision 校验和写文件必须处在同一个互斥段内。
 */
import type { BotRegistry } from './bot-registry'
import { compareMenuItems, deriveScopeItems, deriveScopePanel, mergePanelItems, panelItemScopes, stripPanelItemScopes } from './command-panel'
import { normalizePanelConfiguration } from './configuration'
import { isRecord } from './guards'
import {
  MenuPlatformError,
  type MenuPlatform,
  type PlatformCommandPanel,
  type PlatformPrivateMenu,
} from './platform'
import { defaultSleep, PanelWriteThrottle } from './panel-throttle'
import type { MenuStateStore } from './state-store'
import { advanceDraft, createInitialState, recordedConfiguration } from './state'
import {
  deepClone,
  emptyCommandPanel,
  emptyPanelConfiguration,
  PANEL_SCOPE_LABELS,
  PANEL_SCOPES,
  type BotInstanceSummary,
  type CommandPanelCandidate,
  type CommandPanelConfiguration,
  type CommandPanelPublishInput,
  type CommandPanelPublishResult,
  type CommandPanelScopeCandidates,
  type CommandPanelScopePublishResult,
  type DiscardDraftInput,
  type DriftReport,
  type DraftMutationResult,
  type ImportCommandPanelFailure,
  type ImportCommandPanelInput,
  type ImportCommandPanelResult,
  type ImportPrivateMenuInput,
  type ImportPrivateMenuResult,
  type MenuState,
  type MenuItemDiff,
  type PublishedCommandPanel,
  type PanelConfiguration,
  type PanelScope,
  type PrivateMenuConfiguration,
  type PrivateMenuPublishInput,
  type PrivateMenuPublishResult,
  type RefreshPlatformFailure,
  type RefreshPlatformInput,
  type PrivateMenuDriftReport,
  type PublishedCommandPanels,
  type PublishedRevisions,
  type SaveDraftInput,
  type ScopeDriftReport,
  type WorkspaceSnapshot,
} from './types'
import { validateCommandPanel, validatePrivateMenu } from './validation'

export type MenuServiceErrorCode = 'unknown-bot'

export class MenuServiceError extends Error {
  constructor(
    public readonly code: MenuServiceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MenuServiceError'
  }
}

export interface MenuServiceOptions {
  registry: BotRegistry
  store: MenuStateStore
  /** QQ 平台边界；导入与发布需要，纯 Draft 用例可以不提供。 */
  platform?: MenuPlatform
  /** 注入时钟，便于测试断言 revision 与时间戳。 */
  now?: () => Date
  /** 注入 sleep，便于测试用假时钟快速断言指令面板 6500ms 节流。 */
  sleep?: (ms: number) => Promise<void>
}

/** 单次 Publish 里某个使用场景的写入计划。 */
interface ScopePlan {
  scope: PanelScope
  managed: PlatformCommandPanel | undefined
  derived: CommandPanelConfiguration
  /** 该场景需要删除的 all 面板（非受管面板，或空场景的全部面板）。 */
  deleteTargets: PlatformCommandPanel[]
}

export class MenuService {
  private readonly registry: BotRegistry
  private readonly store: MenuStateStore
  private readonly platform: MenuPlatform | null
  private readonly now: () => Date
  private readonly throttle: PanelWriteThrottle
  /** 每个 AppID 最近一次列给用户确认的待删除指令面板；防止单次请求跳过「先列出再确认」。 */
  private readonly cleanupListings = new Map<string, Partial<Record<PanelScope, string[]>>>()

  constructor(options: MenuServiceOptions) {
    this.registry = options.registry
    this.store = options.store
    this.platform = options.platform ?? null
    this.now = options.now ?? (() => new Date())
    this.throttle = new PanelWriteThrottle({
      now: () => this.now().getTime(),
      sleep: options.sleep ?? defaultSleep,
    })
  }

  /** 只返回 platform === 'qq' 的 Bot Instance，并按 AppID 去重。 */
  listBots(): BotInstanceSummary[] {
    return this.registry.list().map(bot => ({ ...bot }))
  }

  /**
   * 读取某个 Bot Instance 的工作区快照。
   *
   * 首次访问只在内存里合成 revision 0 的空配置，不落盘；真正写入发生在第一次保存，
   * 避免只读的 GET 在数据目录里留下文件。
   */
  async loadWorkspace(appId: string): Promise<WorkspaceSnapshot> {
    const bot = this.requireBot(appId)
    const state = await this.store.runExclusive(appId, async () => {
      return (await this.store.read(appId)) ?? createInitialState(appId, this.now().toISOString())
    })
    return this.toSnapshot(bot, state)
  }

  /**
   * 刷新 Platform State 并对比 Published Revision（Drift 检测）。
   *
   * 只读平台，不写状态；平台读取按 Private Menu 与四个场景分别给出结果，
   * 读取失败归入该 surface 的 error 状态，不中断其他 surface 的读取。
   */
  async refreshPlatform(input: RefreshPlatformInput): Promise<DriftReport | RefreshPlatformFailure> {
    const bot = this.findBot(input.appId)
    if (!bot) return { ok: false, code: 'unknown-bot', message: `未找到应用 ID 为 ${input.appId} 的 QQ 应用实例。` }
    if (!bot.online) return { ok: false, code: 'bot-offline', message: `应用 ID ${input.appId} 的机器人当前不在线。` }
    if (!this.platform) return { ok: false, code: 'platform-error', message: 'QQ 平台能力不可用。' }

    const state = await this.store.runExclusive(input.appId, async () =>
      (await this.store.read(input.appId)) ?? createInitialState(input.appId, this.now().toISOString()))

    const privateMenuReport = await this.readPrivateMenuDrift(input.appId, state)
    const scopes: ScopeDriftReport[] = []
    for (const scope of PANEL_SCOPES) {
      scopes.push(await this.readScopeDrift(input.appId, scope, state))
    }
    return { privateMenu: privateMenuReport, scopes }
  }

  /** Private Menu Drift：读取平台后复用发布路径的同一个对比函数。 */
  private async readPrivateMenuDrift(appId: string, state: MenuState): Promise<PrivateMenuDriftReport> {
    let platform: PlatformPrivateMenu
    try {
      platform = await this.platform!.getPrivateMenu(appId)
    } catch (error) {
      return {
        surface: 'privateMenu',
        state: 'error',
        diffs: [],
        message: `平台私聊菜单读取失败：${errorMessage(error)}`,
      }
    }
    return privateMenuDriftReport(state.draft.privateMenu, platform, state.published.privateMenu)
  }

  /** 单个场景 Drift：读取平台后复用发布路径的同一个对比函数。 */
  private async readScopeDrift(appId: string, scope: PanelScope, state: MenuState): Promise<ScopeDriftReport> {
    let panels: PlatformCommandPanel[]
    try {
      panels = await this.platform!.listCommandPanels(appId, scope)
    } catch (error) {
      return {
        surface: 'commandPanel',
        scope,
        state: 'error',
        diffs: [],
        message: `${PANEL_SCOPE_LABELS[scope]} 场景面板读取失败：${errorMessage(error)}`,
      }
    }
    return scopeDriftReport(scope, panels, state.draft.commandPanel, state.published.commandPanels[scope])
  }

  /**
   * 保存 Draft。
   *
   * `expectedRevision` 与服务端当前 revision 不一致时返回 `revision-conflict` 且不写入；
   * 调用方用冲突结果里的 revision 重新提交即可实现「强制覆盖」。
   */
  async saveDraft(input: SaveDraftInput): Promise<DraftMutationResult> {
    this.requireBot(input.appId)
    const configuration = normalizePanelConfiguration(input.configuration)
    return this.mutateDraft(input.appId, input.expectedRevision, () => configuration)
  }

  /** Discard Draft：用已记录内容覆盖 Draft，同样带 revision 校验。 */
  async discardDraft(input: DiscardDraftInput): Promise<DraftMutationResult> {
    this.requireBot(input.appId)
    return this.mutateDraft(input.appId, input.expectedRevision, state => recordedConfiguration(state))
  }

  /**
   * 导入当前 Private Menu：读取平台内容后同时写入 Draft 与 Published Revision。
   */
  async importPrivateMenu(input: ImportPrivateMenuInput): Promise<ImportPrivateMenuResult> {
    const bot = this.findBot(input.appId)
    if (!bot) {
      return { ok: false, surface: 'privateMenu', code: 'unknown-bot', message: `未找到应用 ID 为 ${input.appId} 的 QQ 应用实例。` }
    }
    if (!bot.online) {
      return { ok: false, surface: 'privateMenu', code: 'bot-offline', message: `应用 ID ${input.appId} 的机器人当前不在线。` }
    }
    if (!this.platform) {
      return { ok: false, surface: 'privateMenu', code: 'platform-error', message: 'QQ 平台能力不可用。' }
    }

    let imported: PlatformPrivateMenu
    try {
      imported = await this.platform.getPrivateMenu(input.appId)
    } catch (error) {
      return { ok: false, surface: 'privateMenu', code: platformFailureCode(error), message: errorMessage(error) }
    }

    const now = this.now().toISOString()
    const revision = await this.store.runExclusive(input.appId, async () => {
      const state = await this.readOrCreate(input.appId)
      const importedConfiguration = {
        ...(state.importedConfiguration ?? emptyPanelConfiguration()),
        privateMenu: deepClone(imported.menu),
      }
      // 导入把平台当前内容同时写入 Draft 与 Published Revision（设计 §7.1）：
      // 这样 Discard 能恢复到平台内容，Drift 也有了「刚同步过」的基线。
      const next: MenuState = {
        ...state,
        revision: state.revision + 1,
        updatedAt: now,
        importedConfiguration,
        draft: { ...state.draft, privateMenu: deepClone(imported.menu) },
        published: {
          ...state.published,
          privateMenu: { menu: deepClone(imported.menu), version: imported.version, publishedAt: now },
        },
      }
      await this.store.write(input.appId, next)
      return next.revision
    })

    return { ok: true, surface: 'privateMenu', revision, importedAt: now, imported: deepClone(imported.menu) }
  }

  /**
   * Publish Private Menu：校验 Draft 后整体覆盖写入平台，成功则更新 Published Revision。
   *
   * 失败（revision 冲突、硬错误、平台错误）不写状态：Draft 与旧 Published Revision 原样保留。
   */
  async publishPrivateMenu(input: PrivateMenuPublishInput): Promise<PrivateMenuPublishResult> {
    const bot = this.findBot(input.appId)
    if (!bot) {
      return this.publishFailure('unknown-bot', `未找到应用 ID 为 ${input.appId} 的 QQ 应用实例。`)
    }
    if (!bot.online) {
      return this.publishFailure('bot-offline', `应用 ID ${input.appId} 的机器人当前不在线。`)
    }
    if (!this.platform) {
      return this.publishFailure('platform-error', 'QQ 平台能力不可用。')
    }

    return this.store.runExclusive(input.appId, async () => {
      const state = await this.readOrCreate(input.appId)
      if (state.revision !== input.expectedRevision) {
        return {
          ok: false as const,
          surface: 'privateMenu' as const,
          code: 'revision-conflict' as const,
          message: `版本冲突：服务端当前版本为 ${state.revision}。`,
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(state.published.privateMenu),
        }
      }

      const validation = validatePrivateMenu(state.draft.privateMenu)
      if (validation.errors.length) {
        return {
          ok: false as const,
          surface: 'privateMenu' as const,
          code: 'validation-failed' as const,
          message: `私聊菜单校验失败：${validation.errors.length} 个硬错误。`,
          errors: validation.errors,
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(state.published.privateMenu),
        }
      }

      // Publish 前读取 Platform State；存在 Drift 时必须由用户显式确认才允许覆盖。
      let platformMenu: PlatformPrivateMenu
      try {
        platformMenu = await this.platform!.getPrivateMenu(input.appId)
      } catch (error) {
        return {
          ok: false as const,
          surface: 'privateMenu' as const,
          code: platformFailureCode(error),
          message: `发布前读取平台私聊菜单失败：${errorMessage(error)}`,
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(state.published.privateMenu),
        }
      }

      const privateDrift = privateMenuDriftReport(state.draft.privateMenu, platformMenu, state.published.privateMenu)
      if (privateDrift.state === 'changed' && input.confirmDrift?.privateMenu !== true) {
        return {
          ok: false as const,
          surface: 'privateMenu' as const,
          code: 'drift-confirmation-required' as const,
          message: '平台私聊菜单与上次发布内容存在 Drift，请确认后继续发布。',
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(state.published.privateMenu),
          drift: { privateMenu: privateDrift, scopes: [] },
        }
      }

      let version: number | null
      try {
        const written = await this.platform!.setPrivateMenu(input.appId, deepClone(state.draft.privateMenu))
        version = written.version
      } catch (error) {
        return {
          ok: false as const,
          surface: 'privateMenu' as const,
          code: platformFailureCode(error),
          message: errorMessage(error),
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(state.published.privateMenu),
        }
      }

      const publishedAt = this.now().toISOString()
      const published = { menu: deepClone(state.draft.privateMenu), version, publishedAt }
      const next: MenuState = {
        ...state,
        revision: state.revision + 1,
        updatedAt: publishedAt,
        published: { ...state.published, privateMenu: published },
      }
      await this.store.write(input.appId, next)
      return { ok: true as const, surface: 'privateMenu' as const, published, revision: next.revision, warnings: validation.warnings }
    })
  }

  /**
   * 导入指令面板：按使用场景分页拉取 all 面板候选，零候选留空、单候选自动接管、
   * 多候选由用户为每个场景选择接管对象；被接管场景的条目按同名规则合并成一份列表。
   */
  async importCommandPanel(input: ImportCommandPanelInput): Promise<ImportCommandPanelResult> {
    const bot = this.findBot(input.appId)
    if (!bot) return importFailure('unknown-bot', `未找到应用 ID 为 ${input.appId} 的 QQ 应用实例。`)
    if (!bot.online) return importFailure('bot-offline', `应用 ID ${input.appId} 的机器人当前不在线。`)
    if (!this.platform) return importFailure('platform-error', 'QQ 平台能力不可用。')

    return this.store.runExclusive(input.appId, async () => {
      // 候选选择或平台读取失败时不应留下状态文件，因此这里只合成初始状态，不落盘。
      const state = (await this.store.read(input.appId)) ?? createInitialState(input.appId, this.now().toISOString())

      const candidatesByScope = new Map<PanelScope, PlatformCommandPanel[]>()
      const specificPanelsByScope: Partial<Record<PanelScope, CommandPanelCandidate[]>> = {}
      for (const scope of PANEL_SCOPES) {
        let panels: PlatformCommandPanel[]
        try {
          panels = await this.platform!.listCommandPanels(input.appId, scope)
        } catch (error) {
          return importFailure(commandPlatformFailureCode(error), errorMessage(error))
        }
        // specific 面板既不接管也不删除，只保留 all 面板作为候选并在导入结果里提示。
        const specific = panels.filter(panel => panel.targetType === 'specific')
        if (specific.length) specificPanelsByScope[scope] = specific.map(toCommandPanelCandidate)
        candidatesByScope.set(scope, panels.filter(panel => panel.targetType === 'all'))
      }

      const multiScopes = PANEL_SCOPES.filter(scope => (candidatesByScope.get(scope)?.length ?? 0) > 1)
      const missing = multiScopes.filter(scope => {
        const selected = input.selections?.[scope]
        return !selected || !(candidatesByScope.get(scope) ?? []).some(panel => panel.panelId === selected)
      })
      if (missing.length) {
        return importFailure(
          'selection-required',
          `发现 ${multiScopes.length} 个场景存在多个候选面板，请为每个场景选择唯一的接管对象。`,
          multiScopes.map(scope => scopeCandidates(scope, candidatesByScope.get(scope) ?? [])),
        )
      }

      const selection = new Map<PanelScope, PlatformCommandPanel>()
      for (const scope of PANEL_SCOPES) {
        const candidates = candidatesByScope.get(scope) ?? []
        if (!candidates.length) continue
        const chosenId = candidates.length === 1 ? candidates[0].panelId : input.selections![scope]!
        const chosen = candidates.find(panel => panel.panelId === chosenId)
        if (!chosen) {
          return importFailure(
            'panel-missing',
            `候选列表中不存在面板编号为 ${chosenId} 的指令面板。`,
            multiScopes.map(item => scopeCandidates(item, candidatesByScope.get(item) ?? [])),
          )
        }
        selection.set(scope, chosen)
      }

      const merged = mergePanelItems([...selection.entries()].map(([scope, panel]) => ({ scope, panel: panel.panel })))
      const commandPanel: CommandPanelConfiguration = {
        remark: typeof state.draft.commandPanel.remark === 'string' ? state.draft.commandPanel.remark : 'menu-edit',
        items: merged.items,
      }
      const scopeExtras: NonNullable<CommandPanelConfiguration['scopeExtras']> = {}
      for (const [scope, panel] of selection) {
        const extras: Record<string, unknown> = { ...panel.panel }
        delete extras.items
        delete extras.remark
        if (Object.keys(extras).length) scopeExtras[scope] = extras
      }
      if (Object.keys(scopeExtras).length) commandPanel.scopeExtras = scopeExtras

      const now = this.now().toISOString()
      const commandPanels: PublishedCommandPanels = {}
      const managedPanelIds: Partial<Record<PanelScope, string>> = {}
      for (const [scope, panel] of selection) {
        managedPanelIds[scope] = panel.panelId
        const otherAllPanelIds = (candidatesByScope.get(scope) ?? [])
          .filter(candidate => candidate.panelId !== panel.panelId)
          .map(candidate => candidate.panelId)
        commandPanels[scope] = {
          scope,
          panelId: panel.panelId,
          panel: deriveScopePanel(commandPanel, scope),
          version: panel.version,
          publishedAt: now,
          cleanup: { panelIds: otherAllPanelIds, updatedAt: otherAllPanelIds.length ? now : null },
        }
      }

      const importedConfiguration = {
        ...(state.importedConfiguration ?? emptyPanelConfiguration()),
        commandPanel: deepClone(commandPanel),
      }
      const next: MenuState = {
        ...state,
        revision: state.revision + 1,
        updatedAt: now,
        importedConfiguration,
        draft: { ...state.draft, commandPanel: deepClone(commandPanel) },
        published: { ...state.published, commandPanels },
      }
      await this.store.write(input.appId, next)

      return {
        ok: true,
        surface: 'commandPanel',
        revision: next.revision,
        importedAt: now,
        imported: deepClone(commandPanel),
        managedPanelIds,
        conflicts: merged.conflicts,
        specificPanels: specificPanelsByScope,
      }
    })
  }

  /**
   * Publish 指令面板：校验 Draft 后按场景派生内容，逐场景改写/创建受管面板并清理其他 all 面板。
   *
   * 任意场景失败不阻断其他场景；清理失败时该场景标记 partial 并保留待删除 panel ID；
   * specific 面板既不接管也不删除。
   */
  async publishCommandPanel(input: CommandPanelPublishInput): Promise<CommandPanelPublishResult> {
    const bot = this.findBot(input.appId)
    if (!bot) return this.commandPublishFailure('unknown-bot', `未找到应用 ID 为 ${input.appId} 的 QQ 应用实例。`)
    if (!bot.online) return this.commandPublishFailure('bot-offline', `应用 ID ${input.appId} 的机器人当前不在线。`)
    if (!this.platform) return this.commandPublishFailure('platform-error', 'QQ 平台能力不可用。')

    return this.store.runExclusive(input.appId, async () => {
      const state = await this.readOrCreate(input.appId)
      const previous = state.published.commandPanels

      if (state.revision !== input.expectedRevision) {
        return {
          ok: false as const,
          surface: 'commandPanel' as const,
          code: 'revision-conflict' as const,
          message: `版本冲突：服务端当前版本为 ${state.revision}。`,
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(previous),
          candidates: [],
        }
      }

      const validation = validateCommandPanel(state.draft.commandPanel)
      if (validation.errors.length) {
        return {
          ok: false as const,
          surface: 'commandPanel' as const,
          code: 'validation-failed' as const,
          message: `指令面板校验失败：${validation.errors.length} 个硬错误。`,
          errors: validation.errors,
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(previous),
          candidates: [],
        }
      }

      // Publish 前逐场景读取 Platform State；读取失败按场景收敛为 failed，
      // 与父规格「允许部分成功」一致，不阻断其他场景。
      const platformPanelsByScope = new Map<PanelScope, PlatformCommandPanel[]>()
      const scopeDrifts: ScopeDriftReport[] = []
      const resultsByScope = new Map<PanelScope, CommandPanelScopePublishResult>()
      for (const scope of PANEL_SCOPES) {
        try {
          const panels = await this.platform!.listCommandPanels(input.appId, scope)
          platformPanelsByScope.set(scope, panels)
          scopeDrifts.push(scopeDriftReport(scope, panels, state.draft.commandPanel, previous[scope]))
        } catch (error) {
          resultsByScope.set(scope, {
            scope,
            status: 'failed',
            code: commandPlatformFailureCode(error) === 'quantity-limit' ? 'platform-error' : commandPlatformFailureCode(error),
            message: `发布前读取 ${PANEL_SCOPE_LABELS[scope]} 场景面板失败：${errorMessage(error)}`,
          })
        }
      }

      // missing（受管面板被外部删除）同样属于 Drift，必须确认后才覆盖。
      const changedScopes = scopeDrifts.filter(report => report.state === 'changed' || report.state === 'missing')
      const confirmedScopes = input.confirmDrift?.scopes ?? {}
      if (changedScopes.length > 0
        && !changedScopes.every(report => confirmedScopes[report.scope] === true)) {
        return {
          ok: false as const,
          surface: 'commandPanel' as const,
          code: 'drift-confirmation-required' as const,
          message: '平台面板与上次发布内容存在 Drift，请确认后继续发布。',
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(previous),
          candidates: [],
          drift: { privateMenu: { surface: 'privateMenu', state: 'unpublished', diffs: [] }, scopes: scopeDrifts },
        }
      }

      const plans: ScopePlan[] = []
      for (const scope of PANEL_SCOPES) {
        const panels = platformPanelsByScope.get(scope) ?? []
        const allPanels = panels.filter(panel => panel.targetType === 'all')
        const managedId = previous[scope]?.panelId
        const managed = allPanels.find(panel => panel.panelId === managedId)
        const derived = deriveScopePanel(state.draft.commandPanel, scope)
        const wantsPanel = derived.items.length > 0
        const deleteTargets = wantsPanel
          ? allPanels.filter(panel => panel.panelId !== managed?.panelId)
          : allPanels
        plans.push({ scope, managed, derived, deleteTargets })
      }

      const needConfirmation = plans.filter(plan => plan.deleteTargets.length > 0)
      const expected: Partial<Record<PanelScope, string[]>> = {}
      for (const plan of needConfirmation) expected[plan.scope] = plan.deleteTargets.map(panel => panel.panelId)
      const listed = this.cleanupListings.get(input.appId)
      const confirmedMatches = input.cleanupPanelIds !== undefined
        && listed !== undefined
        && sameScopeListing(listed, expected)
        && sameScopeListing(input.cleanupPanelIds, expected)
      if (needConfirmation.length > 0 && !confirmedMatches) {
        this.cleanupListings.set(input.appId, expected)
        return {
          ok: false as const,
          surface: 'commandPanel' as const,
          code: 'cleanup-confirmation-required' as const,
          message: `发布前需要确认删除 ${needConfirmation.reduce((sum, plan) => sum + plan.deleteTargets.length, 0)} 个其他指令面板。`,
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(previous),
          candidates: needConfirmation.map(plan => scopeCandidates(plan.scope, plan.deleteTargets)),
        }
      }

      this.cleanupListings.delete(input.appId)

      const nextCommandPanels: PublishedCommandPanels = deepClone(previous)
      let changed = false
      let performedPlatformSuccess = false

      for (const plan of plans) {
        const { scope } = plan
        let panelId = plan.managed?.panelId
        let version = plan.managed?.version ?? null

        if (plan.derived.items.length > 0) {
          try {
            if (plan.managed) {
              const written = await this.throttle.run(input.appId, () =>
                this.platform!.modifyCommandPanel(input.appId, plan.managed!.panelId, plan.derived))
              version = written.version
            } else {
              const created = await this.throttle.run(input.appId, () =>
                this.platform!.createCommandPanel(input.appId, scope, plan.derived))
              panelId = created.panelId
              version = created.version
            }
            performedPlatformSuccess = true
          } catch (error) {
            // 某个场景写入失败不阻断其他场景；该场景保留旧 Published Revision。
            resultsByScope.set(scope, {
              scope,
              status: 'failed',
              code: commandPlatformFailureCode(error),
              message: errorMessage(error),
            })
            continue
          }
        }

        const remaining = await this.deletePanels(input.appId, plan.deleteTargets.map(panel => panel.panelId))
        const publishedAt = this.now().toISOString()

        if (plan.derived.items.length === 0) {
          const hadEntry = nextCommandPanels[scope] !== undefined
          if (remaining.length > 0) {
            nextCommandPanels[scope] = {
              scope,
              panelId: plan.managed?.panelId ?? '',
              panel: emptyCommandPanel(),
              version,
              publishedAt,
              cleanup: { panelIds: remaining, updatedAt: publishedAt },
            }
            changed = true
          } else if (hadEntry) {
            delete nextCommandPanels[scope]
            changed = true
          }
          resultsByScope.set(scope, { scope, status: remaining.length > 0 ? 'partial' : 'success' })
          continue
        }

        nextCommandPanels[scope] = {
          scope,
          panelId: panelId!,
          panel: deepClone(plan.derived),
          version,
          publishedAt,
          cleanup: { panelIds: remaining, updatedAt: remaining.length ? publishedAt : null },
        }
        changed = true
        resultsByScope.set(scope, { scope, status: remaining.length > 0 ? 'partial' : 'success' })
      }

      const scopeResults = PANEL_SCOPES
        .map(scope => resultsByScope.get(scope))
        .filter((result): result is CommandPanelScopePublishResult => result !== undefined)
      const hasFailed = scopeResults.some(result => result.status === 'failed')

      // 有平台写入但本地状态没变的成功发布也递增 revision；纯失败则不写状态。
      const shouldPersist = changed || performedPlatformSuccess
      const nextRevision = shouldPersist ? state.revision + 1 : state.revision
      if (shouldPersist) {
        const updatedAt = this.now().toISOString()
        await this.store.write(input.appId, {
          ...state,
          revision: nextRevision,
          updatedAt,
          published: { ...state.published, commandPanels: nextCommandPanels },
        })
      }

      const pending = Object.values(nextCommandPanels).some(panel => panel && panel.cleanup.panelIds.length > 0)
      return {
        ok: true as const,
        surface: 'commandPanel' as const,
        status: hasFailed || pending ? 'partial' as const : 'published' as const,
        published: deepClone(nextCommandPanels),
        scopeResults,
        revision: nextRevision,
        warnings: validation.warnings,
      }
    })
  }

  /** 删除一组面板，返回删除失败的 panel ID（保留在待清理列表）。 */
  private async deletePanels(appId: string, panelIds: string[]): Promise<string[]> {
    const remaining: string[] = []
    for (const panelId of panelIds) {
      try {
        await this.throttle.run(appId, () => this.platform!.deleteCommandPanel(appId, panelId))
      } catch {
        remaining.push(panelId)
      }
    }
    return remaining
  }

  /**
   * 所有 Draft 变更共用的 read-modify-write：读取、校验 revision、计算新 Draft、
   * 递增 revision 并写入，整段在一个 AppID 的互斥段内完成。
   */
  private mutateDraft(
    appId: string,
    expectedRevision: number,
    computeDraft: (state: MenuState) => PanelConfiguration,
  ): Promise<DraftMutationResult> {
    return this.store.runExclusive(appId, async () => {
      const state = await this.readOrCreate(appId)
      const conflict = this.conflictOf(state, expectedRevision)
      if (conflict) return conflict

      const next = advanceDraft(state, computeDraft(state), this.now().toISOString())
      await this.store.write(appId, next)
      return { ok: true, revision: next.revision, savedAt: next.updatedAt }
    })
  }

  private findBot(appId: string): BotInstanceSummary | undefined {
    return this.registry.list().find(item => item.appId === appId)
  }

  private requireBot(appId: string): BotInstanceSummary {
    const bot = this.findBot(appId)
    if (!bot) {
      throw new MenuServiceError('unknown-bot', `未找到应用 ID 为 ${appId} 的 QQ 应用实例。`)
    }
    return bot
  }

  private async readOrCreate(appId: string): Promise<MenuState> {
    const existing = await this.store.read(appId)
    if (existing) return existing
    const created = createInitialState(appId, this.now().toISOString())
    await this.store.write(appId, created)
    return created
  }

  private conflictOf(state: MenuState, expectedRevision: number): DraftMutationResult | null {
    if (state.revision === expectedRevision) return null
    return {
      ok: false,
      reason: 'revision-conflict',
      revision: state.revision,
      draft: deepClone(state.draft),
    }
  }

  private toSnapshot(bot: BotInstanceSummary, state: MenuState): WorkspaceSnapshot {
    return {
      bot: { ...bot },
      revision: state.revision,
      updatedAt: state.updatedAt,
      draft: deepClone(state.draft),
      importedConfiguration: state.importedConfiguration ? deepClone(state.importedConfiguration) : null,
      published: deepClone<PublishedRevisions>(state.published),
    }
  }

  /** 早于状态读取的失败：回传空的 revision / Draft 占位，UI 只需展示 message。 */
  private publishFailure(
    code: 'unknown-bot' | 'bot-offline' | 'platform-error',
    message: string,
  ): PrivateMenuPublishResult {
    return {
      ok: false,
      surface: 'privateMenu',
      code,
      message,
      errors: [],
      revision: 0,
      draft: emptyPanelConfiguration(),
      published: null,
    }
  }

  /** Command Panel 早于状态读取的失败：回传空 revision / Draft 占位。 */
  private commandPublishFailure(
    code: 'unknown-bot' | 'bot-offline' | 'platform-error',
    message: string,
  ): CommandPanelPublishResult {
    return {
      ok: false,
      surface: 'commandPanel',
      code,
      message,
      errors: [],
      revision: 0,
      draft: emptyPanelConfiguration(),
      published: {},
      candidates: [],
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 把平台异常收敛为稳定发布/导入错误码；未知异常归为 platform-error。 */
function platformFailureCode(error: unknown): 'bot-offline' | 'platform-error' | 'unknown-bot' {
  if (error instanceof MenuPlatformError) {
    if (error.code === 'bot-offline') return 'bot-offline'
    if (error.code === 'bot-missing') return 'unknown-bot'
  }
  return 'platform-error'
}

/** 指令面板平台异常码；quantity-limit 对应 QQ 40030013。 */
function commandPlatformFailureCode(
  error: unknown,
): 'bot-offline' | 'platform-error' | 'unknown-bot' | 'quantity-limit' {
  if (error instanceof MenuPlatformError) {
    if (error.code === 'quantity-limit') return 'quantity-limit'
    if (error.code === 'bot-offline') return 'bot-offline'
    if (error.code === 'bot-missing') return 'unknown-bot'
  }
  return 'platform-error'
}

/** 把平台面板收敛成 UI 确认框使用的候选摘要。 */
function toCommandPanelCandidate(panel: PlatformCommandPanel): CommandPanelCandidate {
  const items = Array.isArray(panel.panel.items) ? panel.panel.items : []
  const names = items
    .map(item => (isRecord(item) && typeof item.name === 'string' ? item.name.trim() : ''))
    .filter(Boolean)
  const summary = names.length
    ? `${names.slice(0, 3).join('、')}${names.length > 3 ? ` 等 ${items.length} 项` : ''}`
    : '（无条目）'
  return {
    panelId: panel.panelId,
    remark: panel.remark,
    updatedAt: panel.updatedAt,
    itemCount: items.length,
    itemSummary: summary,
  }
}

function scopeCandidates(scope: PanelScope, panels: PlatformCommandPanel[]): CommandPanelScopeCandidates {
  return { scope, candidates: panels.map(toCommandPanelCandidate) }
}

/** 比较两份「场景 -> panel ID 列表」，忽略顺序。 */
function sameScopeListing(
  left: Partial<Record<PanelScope, string[]>>,
  right: Partial<Record<PanelScope, string[]>>,
): boolean {
  return PANEL_SCOPES.every(scope => sameStringSet(left[scope] ?? [], right[scope] ?? []))
}

/** 未知字段在对比时忽略，已知字段与数量一致视为同内容。 */
/** 键序无关的深比较；平台返回的对象字段顺序不稳定，不能用 JSON.stringify 比较。 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every(key => key in right && sameValue(left[key], right[key]))
  }
  return false
}

function samePanelItems(left: unknown[], right: unknown[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => sameValue(item, right[index]))
}

/** Private Menu Drift 计算；published 缺省时视为未发布过。 */
function privateMenuDriftReport(
  draft: PrivateMenuConfiguration,
  platform: PlatformPrivateMenu,
  published: PublishedRevisions['privateMenu'],
): PrivateMenuDriftReport {
  if (!published) return { surface: 'privateMenu', state: 'unpublished', diffs: [] }
  if (samePrivateMenu(platform.menu, published.menu)) {
    return { surface: 'privateMenu', state: 'same', diffs: [] }
  }
  const items = Array.isArray(draft.items) ? draft.items : []
  return {
    surface: 'privateMenu',
    state: 'changed',
    diffs: compareMenuItems(items, platform.menu.items),
  }
}

/** 单场景 Drift 计算；平台受管面板缺失视为 missing，读取结果仅用于状态展示。 */
function scopeDriftReport(
  scope: PanelScope,
  platformPanels: PlatformCommandPanel[],
  draftPanel: CommandPanelConfiguration,
  publishedPanel: PublishedCommandPanel | undefined,
): ScopeDriftReport {
  if (!publishedPanel) return { surface: 'commandPanel', scope, state: 'unpublished', diffs: [] }
  const platformPanel = platformPanels.find(
    panel => panel.targetType === 'all' && panel.panelId === publishedPanel.panelId)
  if (!platformPanel) return { surface: 'commandPanel', scope, state: 'missing', diffs: [] }

  const draftItems = deriveScopeItems(draftPanel, scope)
  if (samePanelItems(draftItems, platformPanel.panel.items)
    && samePanelItems(platformPanel.panel.items, publishedPanel.panel.items)) {
    return { surface: 'commandPanel', scope, state: 'same', diffs: [] }
  }

  const baseline = compareMenuItems(draftItems, publishedPanel.panel.items)
  const drift = compareMenuItems(draftItems, platformPanel.panel.items)
  const sameDiff = (a: MenuItemDiff, b: MenuItemDiff) => a.kind === b.kind && a.name === b.name
  const unchanged = baseline.length === drift.length && baseline.every((diff, index) => sameDiff(diff, drift[index]))
  return { surface: 'commandPanel', scope, state: unchanged ? 'same' : 'changed', diffs: drift }
}

function samePrivateMenu(left: PrivateMenuConfiguration, right: PrivateMenuConfiguration): boolean {
  const leftItems = Array.isArray(left.items) ? left.items : []
  const rightItems = Array.isArray(right.items) ? right.items : []
  if (!samePanelItems(leftItems, rightItems)) return false
  const leftExtra = { ...left, items: undefined }
  const rightExtra = { ...right, items: undefined }
  return sameValue(leftExtra, rightExtra)
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every(value => set.has(value))
}

function importFailure(
  code: ImportCommandPanelFailure['code'],
  message: string,
  candidates: CommandPanelScopeCandidates[] = [],
): ImportCommandPanelFailure {
  return { ok: false, surface: 'commandPanel', code, message, candidates }
}
