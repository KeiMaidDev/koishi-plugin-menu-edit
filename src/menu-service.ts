/**
 * MenuService：Menu Edit Panel 唯一公开的自动化测试 seam。
 *
 * 服务端所有状态读取、Draft 保存、导入与 Private Menu 发布都经过这里；Console RPC
 * 只做鉴权和参数转换。状态按 Bot Instance（QQ AppID）隔离，写入走
 * `MenuStateStore.runExclusive`，revision 校验和写文件必须处在同一个互斥段内。
 */
import type { BotRegistry } from './bot-registry'
import { normalizePanelConfiguration } from './configuration'
import { isRecord } from './guards'
import { MenuPlatformError, type MenuPlatform, type PlatformGroupPanel, type PlatformPrivateMenu } from './platform'
import { defaultSleep, PanelWriteThrottle } from './panel-throttle'
import type { MenuStateStore } from './state-store'
import { advanceDraft, createInitialState, recordedConfiguration } from './state'
import {
  deepClone,
  emptyPanelConfiguration,
  type BotInstanceSummary,
  type DiscardDraftInput,
  type DraftMutationResult,
  type GroupPanelCandidate,
  type GroupPanelPublishInput,
  type GroupPanelPublishResult,
  type ImportGroupPanelFailure,
  type ImportGroupPanelInput,
  type ImportGroupPanelResult,
  type ImportPrivateMenuInput,
  type ImportPrivateMenuResult,
  type MenuState,
  type PanelConfiguration,
  type PrivateMenuPublishInput,
  type PrivateMenuPublishResult,
  type PublishedGroupPanel,
  type PublishedRevisions,
  type SaveDraftInput,
  type WorkspaceSnapshot,
} from './types'
import { validateGroupPanel, validatePrivateMenu } from './validation'

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
  /** 注入 sleep，便于测试用假时钟快速断言 Group Panel 6500ms 节流。 */
  sleep?: (ms: number) => Promise<void>
}

export class MenuService {
  private readonly registry: BotRegistry
  private readonly store: MenuStateStore
  private readonly platform: MenuPlatform | null
  private readonly now: () => Date
  private readonly throttle: PanelWriteThrottle
  /** 每个 AppID 最近一次列给用户确认的待删除 panel ID；防止单次请求跳过「先列出再确认」。 */
  private readonly cleanupListings = new Map<string, string[]>()

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
    return this.mutateDraft(input.appId, input.expectedRevision, recordedConfiguration)
  }

  /**
   * 导入当前 Private Menu。
   *
   * 先读平台；读取失败直接返回错误且不写任何状态，避免用空配置静默覆盖 Draft。
   * 读取成功后写入 Draft、importedConfiguration 与 Published Revision 基线，并递增 revision。
   */
  async importPrivateMenu(input: ImportPrivateMenuInput): Promise<ImportPrivateMenuResult> {
    const bot = this.findBot(input.appId)
    if (!bot) {
      return { ok: false, surface: 'privateMenu', code: 'unknown-bot', message: `未找到 AppID 为 ${input.appId} 的 QQ Bot Instance。` }
    }
    if (!bot.online) {
      return { ok: false, surface: 'privateMenu', code: 'bot-offline', message: `AppID ${input.appId} 的机器人当前不在线。` }
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
      return this.publishFailure('unknown-bot', `未找到 AppID 为 ${input.appId} 的 QQ Bot Instance。`)
    }
    if (!bot.online) {
      return this.publishFailure('bot-offline', `AppID ${input.appId} 的机器人当前不在线。`)
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
          message: `revision 冲突：服务端当前为 revision ${state.revision}。`,
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
          message: `Private Menu 校验失败：${validation.errors.length} 个硬错误。`,
          errors: validation.errors,
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(state.published.privateMenu),
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
   * 导入当前 Group Panel，建立 Managed Panel 基线。
   *
   * 零个候选时创建 group/all Managed Panel 并采用当前 Draft 内容；一个候选时自动接管；
   * 多个候选且未指定 panelId 时返回 selection-required 与候选列表，由用户选择唯一对象。
   */
  async importGroupPanel(input: ImportGroupPanelInput): Promise<ImportGroupPanelResult> {
    const bot = this.findBot(input.appId)
    if (!bot) return importGroupFailure('unknown-bot', `未找到 AppID 为 ${input.appId} 的 QQ Bot Instance。`)
    if (!bot.online) return importGroupFailure('bot-offline', `AppID ${input.appId} 的机器人当前不在线。`)
    if (!this.platform) return importGroupFailure('platform-error', 'QQ 平台能力不可用。')

    return this.store.runExclusive(input.appId, async () => {
      // 候选选择或平台读取失败时不应留下状态文件，因此这里只合成初始状态，不落盘。
      const state = (await this.store.read(input.appId)) ?? createInitialState(input.appId, this.now().toISOString())

      let panels: PlatformGroupPanel[]
      try {
        panels = await this.platform!.listGroupPanels(input.appId)
      } catch (error) {
        return importGroupFailure(groupPlatformFailureCode(error), errorMessage(error))
      }

      const candidates = panels.filter(panel => panel.targetType === 'all')
      const now = this.now().toISOString()

      let target: PlatformGroupPanel
      let created = false
      let version: number | null = null

      if (candidates.length === 0) {
        try {
          const createdPanel = await this.throttle.run(input.appId, () =>
            this.platform!.createGroupPanel(input.appId, deepClone(state.draft.groupPanel)))
          target = {
            panelId: createdPanel.panelId,
            targetType: 'all',
            remark: typeof state.draft.groupPanel.remark === 'string' ? state.draft.groupPanel.remark : '',
            updatedAt: now,
            version: createdPanel.version,
            panel: deepClone(state.draft.groupPanel),
          }
          version = createdPanel.version
          created = true
        } catch (error) {
          return importGroupFailure(groupPlatformFailureCode(error), errorMessage(error))
        }
      } else if (input.panelId === undefined) {
        if (candidates.length > 1) {
          return importGroupFailure(
            'selection-required',
            `发现 ${candidates.length} 个 Group Panel 候选，请选择唯一的接管对象。`,
            candidates.map(toGroupPanelCandidate),
          )
        }
        target = candidates[0]
      } else {
        const selected = candidates.find(panel => panel.panelId === input.panelId)
        if (!selected) {
          return importGroupFailure(
            'panel-missing',
            `候选列表中不存在 panel ID 为 ${input.panelId} 的 Group Panel。`,
            candidates.map(toGroupPanelCandidate),
          )
        }
        target = selected
      }

      version = version ?? target.version
      const imported = deepClone(target.panel)
      const importedConfiguration = {
        ...(state.importedConfiguration ?? emptyPanelConfiguration()),
        groupPanel: deepClone(imported),
      }
      const published: PublishedGroupPanel = {
        panelId: target.panelId,
        panel: deepClone(imported),
        version,
        publishedAt: now,
        cleanup: { panelIds: [], updatedAt: null },
      }
      const next: MenuState = {
        ...state,
        revision: state.revision + 1,
        updatedAt: now,
        importedConfiguration,
        draft: { ...state.draft, groupPanel: deepClone(imported) },
        published: { ...state.published, groupPanel: published },
      }
      await this.store.write(input.appId, next)
      return {
        ok: true as const,
        surface: 'groupPanel' as const,
        revision: next.revision,
        importedAt: now,
        imported: deepClone(imported),
        managedPanelId: target.panelId,
        created,
      }
    })
  }

  /**
   * Publish Group Panel：优先修改已接管的 Managed Panel，不存在时创建新的 group/all Panel，
   * 写入成功后按用户确认的列表逐项删除其他 group Panel。
   *
   * 连续平台写入由 PanelWriteThrottle 统一节流（至少 6500ms），并发调用无法绕过。
   * Managed Panel 写入成功即更新 Published Revision；清理未全部完成时返回 partial 并持久化
   * 待清理 panel ID。校验失败、revision 冲突、40030013 与 Managed Panel 写入失败都保留
   * Draft 与旧 Published Revision。
   */
  async publishGroupPanel(input: GroupPanelPublishInput): Promise<GroupPanelPublishResult> {
    const bot = this.findBot(input.appId)
    if (!bot) return this.groupPanelPublishFailure('unknown-bot', `未找到 AppID 为 ${input.appId} 的 QQ Bot Instance。`)
    if (!bot.online) return this.groupPanelPublishFailure('bot-offline', `AppID ${input.appId} 的机器人当前不在线。`)
    if (!this.platform) return this.groupPanelPublishFailure('platform-error', 'QQ 平台能力不可用。')

    return this.store.runExclusive(input.appId, async () => {
      const state = await this.readOrCreate(input.appId)
      const previous = state.published.groupPanel

      if (state.revision !== input.expectedRevision) {
        return {
          ok: false as const,
          surface: 'groupPanel' as const,
          code: 'revision-conflict' as const,
          message: `revision 冲突：服务端当前为 revision ${state.revision}。`,
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(previous),
          candidates: [],
        }
      }

      const validation = validateGroupPanel(state.draft.groupPanel)
      if (validation.errors.length) {
        return {
          ok: false as const,
          surface: 'groupPanel' as const,
          code: 'validation-failed' as const,
          message: `Group Panel 校验失败：${validation.errors.length} 个硬错误。`,
          errors: validation.errors,
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(previous),
          candidates: [],
        }
      }

      let panels: PlatformGroupPanel[]
      try {
        panels = await this.platform!.listGroupPanels(input.appId)
      } catch (error) {
        return {
          ok: false as const,
          surface: 'groupPanel' as const,
          code: groupPlatformFailureCode(error),
          message: errorMessage(error),
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(previous),
          candidates: [],
        }
      }

      const managed = previous ? panels.find(panel => panel.panelId === previous.panelId) : undefined
      const others = panels.filter(panel => panel.panelId !== managed?.panelId)
      const otherIds = others.map(panel => panel.panelId)

      // 发布前必须先列出所有其他 group Panel，再由下一次请求确认；仅携带匹配 ID 的单次请求
      // 不能跳过这一往返。确认结果与平台现状不一致时重新列出。
      const listed = this.cleanupListings.get(input.appId)
      const confirmed = input.cleanupPanelIds
      const confirmedMatches = confirmed !== undefined
        && listed !== undefined
        && sameStringSet(listed, otherIds)
        && sameStringSet(confirmed, otherIds)
      if (!confirmedMatches && (otherIds.length > 0 || confirmed !== undefined)) {
        this.cleanupListings.set(input.appId, [...otherIds])
        return {
          ok: false as const,
          surface: 'groupPanel' as const,
          code: 'cleanup-confirmation-required' as const,
          message: `发布前需要确认删除 ${otherIds.length} 个其他 group Panel。`,
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(previous),
          candidates: others.map(toGroupPanelCandidate),
        }
      }

      this.cleanupListings.delete(input.appId)
      const draftPanel = deepClone(state.draft.groupPanel)
      let managedPanelId: string
      let version: number | null
      try {
        if (managed) {
          managedPanelId = managed.panelId
          const written = await this.throttle.run(input.appId, () =>
            this.platform!.modifyGroupPanel(input.appId, managed.panelId, draftPanel))
          version = written.version
        } else {
          const created = await this.throttle.run(input.appId, () =>
            this.platform!.createGroupPanel(input.appId, draftPanel))
          managedPanelId = created.panelId
          version = created.version
        }
      } catch (error) {
        return {
          ok: false as const,
          surface: 'groupPanel' as const,
          code: groupPlatformFailureCode(error),
          message: errorMessage(error),
          errors: [],
          revision: state.revision,
          draft: deepClone(state.draft),
          published: deepClone(previous),
          candidates: [],
        }
      }

      // Managed Panel 写入成功后先落盘 Published Revision 与待清理列表，再开始删除其他面板。
      const publishedAt = this.now().toISOString()
      const pendingIds = [...otherIds]
      const published: PublishedGroupPanel = {
        panelId: managedPanelId,
        panel: draftPanel,
        version,
        publishedAt,
        cleanup: { panelIds: [...pendingIds], updatedAt: pendingIds.length ? publishedAt : null },
      }
      const next: MenuState = {
        ...state,
        revision: state.revision + 1,
        updatedAt: publishedAt,
        published: { ...state.published, groupPanel: published },
      }
      await this.store.write(input.appId, next)

      const remaining = new Set(pendingIds)
      for (const panelId of pendingIds) {
        try {
          await this.throttle.run(input.appId, () => this.platform!.deleteGroupPanel(input.appId, panelId))
          remaining.delete(panelId)
        } catch {
          // 删除失败的面板与尚未尝试的面板都保留在待清理列表，稍后重试。
        }
      }

      const pending = pendingIds.filter(panelId => remaining.has(panelId))
      if (pending.length !== pendingIds.length) {
        const cleanupUpdatedAt = pending.length ? this.now().toISOString() : null
        published.cleanup = { panelIds: pending, updatedAt: cleanupUpdatedAt }
        next.updatedAt = cleanupUpdatedAt ?? published.publishedAt
        await this.store.write(input.appId, next)
      }

      return {
        ok: true as const,
        surface: 'groupPanel' as const,
        status: pending.length ? 'partial' as const : 'published' as const,
        published: deepClone(published),
        revision: next.revision,
        warnings: validation.warnings,
      }
    })
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
      throw new MenuServiceError('unknown-bot', `未找到 AppID 为 ${appId} 的 QQ Bot Instance。`)
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

  /** Group Panel 早于状态读取的失败：回传空 revision / Draft 占位。 */
  private groupPanelPublishFailure(
    code: 'unknown-bot' | 'bot-offline' | 'platform-error',
    message: string,
  ): GroupPanelPublishResult {
    return {
      ok: false,
      surface: 'groupPanel',
      code,
      message,
      errors: [],
      revision: 0,
      draft: emptyPanelConfiguration(),
      published: null,
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
/** 把平台 panel 收敛成 UI 确认框使用的候选摘要。 */
function toGroupPanelCandidate(panel: PlatformGroupPanel): GroupPanelCandidate {
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

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every(value => set.has(value))
}

function importGroupFailure(
  code: ImportGroupPanelFailure['code'],
  message: string,
  candidates: GroupPanelCandidate[] = [],
): ImportGroupPanelFailure {
  return { ok: false, surface: 'groupPanel', code, message, candidates }
}

/** Group Panel 平台异常码；quantity-limit 对应 QQ 40030013。 */
function groupPlatformFailureCode(
  error: unknown,
): 'bot-offline' | 'platform-error' | 'unknown-bot' | 'quantity-limit' {
  if (error instanceof MenuPlatformError) {
    if (error.code === 'quantity-limit') return 'quantity-limit'
    if (error.code === 'bot-offline') return 'bot-offline'
    if (error.code === 'bot-missing') return 'unknown-bot'
  }
  return 'platform-error'
}
