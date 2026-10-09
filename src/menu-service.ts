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
import {
  emptyGroupPanel,
  emptyPanelConfiguration,
  emptyPrivateMenu,
  MENU_STATE_SCHEMA_VERSION,
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createInitialState(appId: string, now: string): MenuState {
  return {
    schemaVersion: MENU_STATE_SCHEMA_VERSION,
    appId,
    revision: 0,
    updatedAt: now,
    initial: null,
    draft: emptyPanelConfiguration(),
    published: { privateMenu: null, groupPanel: null },
  }
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
    return this.store.runExclusive(input.appId, async () => {
      const state = await this.readOrCreate(input.appId)
      const conflict = this.conflictOf(state, input.expectedRevision)
      if (conflict) return conflict

      const next: MenuState = {
        ...state,
        revision: state.revision + 1,
        updatedAt: this.now().toISOString(),
        draft: configuration,
      }
      await this.store.write(input.appId, next)
      return { ok: true, revision: next.revision, savedAt: next.updatedAt }
    })
  }

  /**
   * Discard Draft：用「已记录内容」覆盖 Draft。
   *
   * 已记录内容按 surface 取最近一次成功的 Published Revision；尚未发布过的 surface
   * 回退到首次导入内容，两者都没有时回到空配置。Discard 同样带 revision 校验。
   */
  async discardDraft(input: DiscardDraftInput): Promise<DraftMutationResult> {
    this.requireBot(input.appId)
    return this.store.runExclusive(input.appId, async () => {
      const state = await this.readOrCreate(input.appId)
      const conflict = this.conflictOf(state, input.expectedRevision)
      if (conflict) return conflict

      const next: MenuState = {
        ...state,
        revision: state.revision + 1,
        updatedAt: this.now().toISOString(),
        draft: this.recordedConfiguration(state),
      }
      await this.store.write(input.appId, next)
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
      draft: clone(state.draft),
    }
  }

  private recordedConfiguration(state: MenuState): PanelConfiguration {
    const fallback = state.initial ?? emptyPanelConfiguration()
    return {
      ...clone(fallback),
      privateMenu: clone(state.published.privateMenu?.menu ?? fallback.privateMenu ?? emptyPrivateMenu()),
      groupPanel: clone(state.published.groupPanel?.panel ?? fallback.groupPanel ?? emptyGroupPanel()),
    }
  }

  private toSnapshot(bot: BotInstanceSummary, state: MenuState): WorkspaceSnapshot {
    return {
      bot: { ...bot },
      revision: state.revision,
      updatedAt: state.updatedAt,
      draft: clone(state.draft),
      initial: state.initial ? clone(state.initial) : null,
      published: clone<PublishedRevisions>(state.published),
    }
  }
}

