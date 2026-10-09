/**
 * MenuService：Menu Edit Panel 唯一公开的自动化测试 seam。
 *
 * 服务端所有状态读取、Draft 保存、导入与 Private Menu 发布都经过这里；Console RPC
 * 只做鉴权和参数转换。状态按 Bot Instance（QQ AppID）隔离，写入走
 * `MenuStateStore.runExclusive`，revision 校验和写文件必须处在同一个互斥段内。
 */
import type { BotRegistry } from './bot-registry'
import { normalizePanelConfiguration } from './configuration'
import { MenuPlatformError, type MenuPlatform, type PlatformPrivateMenu } from './platform'
import type { MenuStateStore } from './state-store'
import { advanceDraft, createInitialState, recordedConfiguration } from './state'
import {
  deepClone,
  emptyPanelConfiguration,
  type BotInstanceSummary,
  type DiscardDraftInput,
  type DraftMutationResult,
  type ImportPrivateMenuInput,
  type ImportPrivateMenuResult,
  type MenuState,
  type PanelConfiguration,
  type PrivateMenuPublishInput,
  type PrivateMenuPublishResult,
  type PublishedRevisions,
  type SaveDraftInput,
  type WorkspaceSnapshot,
} from './types'
import { validatePrivateMenu } from './validation'

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
}

export class MenuService {
  private readonly registry: BotRegistry
  private readonly store: MenuStateStore
  private readonly platform: MenuPlatform | null
  private readonly now: () => Date

  constructor(options: MenuServiceOptions) {
    this.registry = options.registry
    this.store = options.store
    this.platform = options.platform ?? null
    this.now = options.now ?? (() => new Date())
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
