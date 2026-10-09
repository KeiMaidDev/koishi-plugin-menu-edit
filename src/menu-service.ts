/**
 * MenuService：Menu Edit Panel 唯一公开的自动化测试 seam。
 *
 * 服务端所有状态读取、Draft 保存与 Discard 都经过这里；Console RPC 只做鉴权和参数转换。
 * 状态按 Bot Instance（QQ AppID）隔离，写入走 `MenuStateStore.runExclusive`，
 * revision 校验和写文件必须处在同一个互斥段内。
 */
import type { BotRegistry } from './bot-registry'
import { normalizePanelConfiguration } from './configuration'
import type { MenuStateStore } from './state-store'
import { advanceDraft, createInitialState, recordedConfiguration } from './state'
import {
  deepClone,
  type BotInstanceSummary,
  type DiscardDraftInput,
  type DraftMutationResult,
  type MenuState,
  type PanelConfiguration,
  type PublishedRevisions,
  type SaveDraftInput,
  type WorkspaceSnapshot,
} from './types'

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
  /** 注入时钟，便于测试断言 revision 与时间戳。 */
  now?: () => Date
}

export class MenuService {
  private readonly registry: BotRegistry
  private readonly store: MenuStateStore
  private readonly now: () => Date

  constructor(options: MenuServiceOptions) {
    this.registry = options.registry
    this.store = options.store
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

  private requireBot(appId: string): BotInstanceSummary {
    const bot = this.registry.list().find(item => item.appId === appId)
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
}
